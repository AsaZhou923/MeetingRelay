//! Raw audio persistence policy for MVP meeting capture.
//!
//! The module is intentionally side-effect free while disabled: callers can
//! construct the store and ask for a meeting writer without creating raw or
//! derived audio directories. Enabled writers persist one PCM16 WAV per meeting
//! source and a JSON manifest after explicit finalization.

use std::{
    collections::BTreeSet,
    fs::{self, File, OpenOptions},
    io::{self, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};

use crate::mvp::audio::{AudioSourceId, RawAudioPacket};
#[cfg(test)]
use crate::mvp::storage::sha256_hex;

const RAW_DIR: &str = "raw";
const DERIVED_DIR: &str = "derived";
const MANIFEST_FILE: &str = "raw-audio-manifest.json";
const WAV_HEADER_BYTES: u64 = 44;
const RECOVERY_SAMPLE_RATE_HZ: u64 = 16_000;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RawAudioConfig {
    pub enabled: bool,
    pub root_dir: PathBuf,
    pub quota_bytes: Option<u64>,
    pub retention: RawAudioRetentionPolicy,
}

impl Default for RawAudioConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            root_dir: PathBuf::new(),
            quota_bytes: None,
            retention: RawAudioRetentionPolicy::NeverAutoDelete,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RawAudioRetentionPolicy {
    NeverAutoDelete,
    PreviewOnly { older_than: Duration },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingSampleRange {
    pub start: u64,
    pub end: u64,
}

impl MeetingSampleRange {
    #[must_use]
    pub const fn new(start: u64, end: u64) -> Self {
        Self { start, end }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RawAudioGap {
    pub start: u64,
    pub end: u64,
    pub reason: String,
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RawAudioManifest {
    pub meeting_id: String,
    pub raw_dir: PathBuf,
    pub derived_dir: PathBuf,
    pub sources: Vec<RawAudioSourceManifest>,
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RawAudioSourceManifest {
    pub source: String,
    pub path: PathBuf,
    pub sample_rate: u32,
    pub channels: u16,
    pub meeting_sample_start: u64,
    pub meeting_sample_end: u64,
    pub frame_count: u64,
    pub byte_length: u64,
    pub sha256: String,
    pub gaps: Vec<RawAudioGap>,
}

/// Reads one absolute meeting-timeline window and mixes every available raw
/// source into an exact 16 kHz mono buffer. Gap ranges become silence, so the
/// returned sample index remains a stable meeting sample identity.
pub fn read_mixed_window_16khz(
    manifest: &RawAudioManifest,
    start: u64,
    end: u64,
) -> Result<Vec<f32>, RawAudioError> {
    if end <= start {
        return Err(RawAudioError::InvalidPacket(
            "recovery window end precedes start",
        ));
    }
    let sample_count = usize::try_from(end - start)
        .map_err(|_| RawAudioError::InvalidPacket("recovery window too large"))?;
    let mut sums = vec![0.0_f64; sample_count];
    let mut contributors = vec![0_u8; sample_count];

    for source in &manifest.sources {
        mix_source_window(source, start, end, &mut sums, &mut contributors)?;
    }

    Ok(sums
        .into_iter()
        .zip(contributors)
        .map(|(sum, count)| {
            if count == 0 {
                0.0
            } else {
                (sum / f64::from(count)).clamp(-1.0, 1.0) as f32
            }
        })
        .collect())
}

/// Reads at most `max_samples` deterministic samples from a meeting window
/// without allocating the full span when the target segment is large.
pub fn read_mixed_feature_window_16khz(
    manifest: &RawAudioManifest,
    start: u64,
    end: u64,
    max_samples: usize,
) -> Result<Vec<f32>, RawAudioError> {
    if max_samples == 0 {
        return Ok(Vec::new());
    }
    let span = end.checked_sub(start).ok_or(RawAudioError::InvalidPacket(
        "feature window end precedes start",
    ))?;
    if span <= u64::try_from(max_samples).unwrap_or(u64::MAX) {
        return read_mixed_window_16khz(manifest, start, end);
    }

    let chunk_size = 1024_u64.min(u64::try_from(max_samples).unwrap_or(u64::MAX));
    let chunk_count = u64::try_from(max_samples)
        .unwrap_or(u64::MAX)
        .saturating_add(chunk_size - 1)
        / chunk_size;
    let mut output = Vec::with_capacity(max_samples);
    for chunk_index in 0..chunk_count {
        let offset = if chunk_count <= 1 {
            0
        } else {
            chunk_index.saturating_mul(span.saturating_sub(chunk_size)) / (chunk_count - 1)
        };
        let chunk_start = start.saturating_add(offset).min(end);
        let chunk_end = chunk_start
            .saturating_add(chunk_size.min(end.saturating_sub(chunk_start)))
            .min(end);
        if chunk_end <= chunk_start {
            continue;
        }
        let chunk = read_mixed_window_16khz(manifest, chunk_start, chunk_end)?;
        let remaining = max_samples.saturating_sub(output.len());
        output.extend(chunk.into_iter().take(remaining));
        if output.len() >= max_samples {
            break;
        }
    }
    Ok(output)
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RawAudioDeletePreview {
    pub meeting_id: String,
    pub paths: Vec<PathBuf>,
    pub total_bytes: u64,
}

#[derive(Debug)]
pub enum RawAudioError {
    InvalidMeetingId,
    InvalidPacket(&'static str),
    SourceFormatChanged {
        source: String,
    },
    QuotaExceeded {
        quota_bytes: u64,
        current_bytes: u64,
        attempted_bytes: u64,
    },
    Io(io::Error),
    Json(serde_json::Error),
}

impl std::fmt::Display for RawAudioError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidMeetingId => formatter.write_str("invalid raw audio meeting id"),
            Self::InvalidPacket(reason) => write!(formatter, "invalid raw audio packet: {reason}"),
            Self::SourceFormatChanged { source } => {
                write!(formatter, "raw audio source format changed: {source}")
            }
            Self::QuotaExceeded {
                quota_bytes,
                current_bytes,
                attempted_bytes,
            } => write!(
                formatter,
                "raw audio quota exceeded: quota={quota_bytes} current={current_bytes} attempted={attempted_bytes}"
            ),
            Self::Io(error) => write!(formatter, "raw audio io error: {error}"),
            Self::Json(error) => write!(formatter, "raw audio manifest error: {error}"),
        }
    }
}

impl std::error::Error for RawAudioError {}

impl From<io::Error> for RawAudioError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<serde_json::Error> for RawAudioError {
    fn from(error: serde_json::Error) -> Self {
        Self::Json(error)
    }
}

#[derive(Clone, Debug)]
pub struct RawAudioStore {
    config: RawAudioConfig,
}

impl RawAudioStore {
    #[must_use]
    pub const fn new(config: RawAudioConfig) -> Self {
        Self { config }
    }

    #[must_use]
    pub fn raw_root(&self) -> PathBuf {
        self.config.root_dir.join(RAW_DIR)
    }

    #[must_use]
    pub fn derived_root(&self) -> PathBuf {
        self.config.root_dir.join(DERIVED_DIR)
    }

    pub fn begin_meeting(
        &self,
        meeting_id: impl Into<String>,
    ) -> Result<Option<RawAudioMeetingWriter>, RawAudioError> {
        if !self.config.enabled {
            return Ok(None);
        }

        let meeting_id = meeting_id.into();
        validate_id(&meeting_id)?;

        let raw_dir = self.raw_root().join(&meeting_id);
        let derived_dir = self.derived_root().join(&meeting_id);
        self.ensure_quota(WAV_HEADER_BYTES)?;
        fs::create_dir_all(&raw_dir)?;
        fs::create_dir_all(&derived_dir)?;

        Ok(Some(RawAudioMeetingWriter {
            store: self.clone(),
            meeting_id,
            raw_dir,
            derived_dir,
            sources: Vec::new(),
            finalized: false,
        }))
    }

    pub fn delete_preview(
        &self,
        meeting_id: &str,
    ) -> Result<Option<RawAudioDeletePreview>, RawAudioError> {
        validate_id(meeting_id)?;
        let paths = [
            self.raw_root().join(meeting_id),
            self.derived_root().join(meeting_id),
        ]
        .into_iter()
        .filter(|path| path.exists())
        .collect::<Vec<_>>();
        if paths.is_empty() {
            return Ok(None);
        }
        Ok(Some(RawAudioDeletePreview {
            meeting_id: meeting_id.to_owned(),
            total_bytes: paths.iter().try_fold(0_u64, |total, path| {
                Ok::<u64, RawAudioError>(total + path_size(path)?)
            })?,
            paths,
        }))
    }

    pub fn delete_meeting(
        &self,
        meeting_id: &str,
    ) -> Result<Option<RawAudioDeletePreview>, RawAudioError> {
        let preview = match self.delete_preview(meeting_id)? {
            Some(preview) => preview,
            None => return Ok(None),
        };
        for path in &preview.paths {
            match fs::symlink_metadata(path) {
                Ok(metadata) if metadata.is_dir() => fs::remove_dir_all(path)?,
                Ok(_) => fs::remove_file(path)?,
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }
        Ok(Some(preview))
    }

    pub fn retention_delete_preview(
        &self,
        now: SystemTime,
    ) -> Result<Vec<RawAudioDeletePreview>, RawAudioError> {
        let older_than = match self.config.retention {
            RawAudioRetentionPolicy::NeverAutoDelete => return Ok(Vec::new()),
            RawAudioRetentionPolicy::PreviewOnly { older_than } => older_than,
        };

        let mut meeting_ids = BTreeSet::new();
        collect_retention_candidates(&self.raw_root(), now, older_than, &mut meeting_ids)?;
        collect_retention_candidates(&self.derived_root(), now, older_than, &mut meeting_ids)?;

        meeting_ids
            .into_iter()
            .map(|meeting_id| {
                self.delete_preview(&meeting_id)?
                    .ok_or(RawAudioError::InvalidMeetingId)
            })
            .collect()
    }

    pub fn recover_interrupted_meeting(
        &self,
        meeting_id: &str,
    ) -> Result<Option<RawAudioManifest>, RawAudioError> {
        validate_id(meeting_id)?;
        let raw_dir = self.raw_root().join(meeting_id);
        if !raw_dir.is_dir() {
            return Ok(None);
        }
        let derived_dir = self.derived_root().join(meeting_id);
        fs::create_dir_all(&derived_dir)?;
        let mut sources = Vec::new();
        for source in [AudioSourceId::SystemOutput, AudioSourceId::Microphone] {
            let path = raw_dir.join(source_file_name(source));
            if path.is_file() {
                sources.push(recover_source_manifest(path, source)?);
            }
        }
        if sources.is_empty() {
            return Ok(None);
        }
        let manifest = RawAudioManifest {
            meeting_id: meeting_id.to_owned(),
            raw_dir,
            derived_dir: derived_dir.clone(),
            sources,
        };
        let bytes = serde_json::to_vec_pretty(&manifest)?;
        fs::write(derived_dir.join(MANIFEST_FILE), bytes)?;
        Ok(Some(manifest))
    }

    pub fn load_manifest(
        &self,
        meeting_id: &str,
    ) -> Result<Option<RawAudioManifest>, RawAudioError> {
        validate_id(meeting_id)?;
        let manifest_path = self.derived_root().join(meeting_id).join(MANIFEST_FILE);
        let bytes = match fs::read(&manifest_path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        let mut manifest: RawAudioManifest = serde_json::from_slice(&bytes)?;
        self.validate_manifest_paths_and_checksums(meeting_id, &mut manifest)?;
        Ok(Some(manifest))
    }

    fn validate_manifest_paths_and_checksums(
        &self,
        meeting_id: &str,
        manifest: &mut RawAudioManifest,
    ) -> Result<(), RawAudioError> {
        if manifest.meeting_id != meeting_id || manifest.sources.len() > 8 {
            return Err(RawAudioError::InvalidPacket("raw audio manifest invalid"));
        }
        let expected_raw_dir = self.raw_root().join(meeting_id);
        let expected_derived_dir = self.derived_root().join(meeting_id);
        let canonical_raw_dir = expected_raw_dir.canonicalize()?;
        let canonical_derived_dir = expected_derived_dir.canonicalize()?;
        if manifest.raw_dir.canonicalize()? != canonical_raw_dir
            || manifest.derived_dir.canonicalize()? != canonical_derived_dir
        {
            return Err(RawAudioError::InvalidPacket(
                "raw audio manifest root mismatch",
            ));
        }
        manifest.raw_dir = canonical_raw_dir.clone();
        manifest.derived_dir = canonical_derived_dir;
        for source in &mut manifest.sources {
            if source.gaps.len() > 10_000 {
                return Err(RawAudioError::InvalidPacket(
                    "raw audio manifest gap limit exceeded",
                ));
            }
            let link_metadata = fs::symlink_metadata(&source.path)?;
            if link_metadata.file_type().is_symlink() || !link_metadata.is_file() {
                return Err(RawAudioError::InvalidPacket(
                    "raw audio source path invalid",
                ));
            }
            if link_metadata.len() != source.byte_length {
                return Err(RawAudioError::InvalidPacket(
                    "raw audio source length mismatch",
                ));
            }
            let canonical_source = source.path.canonicalize()?;
            if !canonical_source.starts_with(&canonical_raw_dir) {
                return Err(RawAudioError::InvalidPacket(
                    "raw audio source path escapes raw dir",
                ));
            }
            if sha256_hex_file(&canonical_source)? != source.sha256 {
                return Err(RawAudioError::InvalidPacket(
                    "raw audio source checksum mismatch",
                ));
            }
            source.path = canonical_source;
        }
        Ok(())
    }

    fn ensure_quota(&self, attempted_bytes: u64) -> Result<(), RawAudioError> {
        let Some(quota_bytes) = self.config.quota_bytes else {
            return Ok(());
        };
        let current_bytes = if self.config.root_dir.exists() {
            path_size(&self.config.root_dir)?
        } else {
            0
        };
        if current_bytes.saturating_add(attempted_bytes) > quota_bytes {
            return Err(RawAudioError::QuotaExceeded {
                quota_bytes,
                current_bytes,
                attempted_bytes,
            });
        }
        Ok(())
    }
}

fn sha256_hex_file(path: &Path) -> Result<String, RawAudioError> {
    let mut file = File::open(path)?;
    let mut hasher = StreamingSha256::new();
    let mut buffer = [0_u8; 32 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hasher.finalize_hex())
}

struct StreamingSha256 {
    h: [u32; 8],
    total_len: u64,
    buffer: Vec<u8>,
}

impl StreamingSha256 {
    fn new() -> Self {
        Self {
            h: SHA256_H0,
            total_len: 0,
            buffer: Vec::with_capacity(64),
        }
    }

    fn update(&mut self, mut input: &[u8]) {
        self.total_len = self
            .total_len
            .saturating_add(u64::try_from(input.len()).unwrap_or(u64::MAX));
        if !self.buffer.is_empty() {
            let take = (64 - self.buffer.len()).min(input.len());
            self.buffer.extend_from_slice(&input[..take]);
            input = &input[take..];
            if self.buffer.len() == 64 {
                process_sha256_chunk(&mut self.h, &self.buffer);
                self.buffer.clear();
            }
        }
        while input.len() >= 64 {
            process_sha256_chunk(&mut self.h, &input[..64]);
            input = &input[64..];
        }
        if !input.is_empty() {
            self.buffer.extend_from_slice(input);
        }
    }

    fn finalize_hex(mut self) -> String {
        let bit_len = self.total_len.saturating_mul(8);
        self.buffer.push(0x80);
        if self.buffer.len() > 56 {
            while self.buffer.len() < 64 {
                self.buffer.push(0);
            }
            process_sha256_chunk(&mut self.h, &self.buffer);
            self.buffer.clear();
        }
        while self.buffer.len() < 56 {
            self.buffer.push(0);
        }
        self.buffer.extend_from_slice(&bit_len.to_be_bytes());
        process_sha256_chunk(&mut self.h, &self.buffer);

        let mut output = String::with_capacity(64);
        for word in self.h {
            for byte in word.to_be_bytes() {
                output.push(hex_nibble(byte >> 4));
                output.push(hex_nibble(byte & 0x0f));
            }
        }
        output
    }
}

const SHA256_H0: [u32; 8] = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];

const SHA256_K: [u32; 64] = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

fn process_sha256_chunk(h: &mut [u32; 8], chunk: &[u8]) {
    debug_assert_eq!(chunk.len(), 64);
    let mut w = [0_u32; 64];
    for (index, word) in w.iter_mut().take(16).enumerate() {
        let base = index * 4;
        *word = u32::from_be_bytes([
            chunk[base],
            chunk[base + 1],
            chunk[base + 2],
            chunk[base + 3],
        ]);
    }
    for index in 16..64 {
        let s0 =
            w[index - 15].rotate_right(7) ^ w[index - 15].rotate_right(18) ^ (w[index - 15] >> 3);
        let s1 =
            w[index - 2].rotate_right(17) ^ w[index - 2].rotate_right(19) ^ (w[index - 2] >> 10);
        w[index] = w[index - 16]
            .wrapping_add(s0)
            .wrapping_add(w[index - 7])
            .wrapping_add(s1);
    }
    let mut a = h[0];
    let mut b = h[1];
    let mut c = h[2];
    let mut d = h[3];
    let mut e = h[4];
    let mut f = h[5];
    let mut g = h[6];
    let mut hh = h[7];
    for index in 0..64 {
        let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
        let ch = (e & f) ^ ((!e) & g);
        let temp1 = hh
            .wrapping_add(s1)
            .wrapping_add(ch)
            .wrapping_add(SHA256_K[index])
            .wrapping_add(w[index]);
        let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
        let maj = (a & b) ^ (a & c) ^ (b & c);
        let temp2 = s0.wrapping_add(maj);
        hh = g;
        g = f;
        f = e;
        e = d.wrapping_add(temp1);
        d = c;
        c = b;
        b = a;
        a = temp1.wrapping_add(temp2);
    }
    h[0] = h[0].wrapping_add(a);
    h[1] = h[1].wrapping_add(b);
    h[2] = h[2].wrapping_add(c);
    h[3] = h[3].wrapping_add(d);
    h[4] = h[4].wrapping_add(e);
    h[5] = h[5].wrapping_add(f);
    h[6] = h[6].wrapping_add(g);
    h[7] = h[7].wrapping_add(hh);
}

fn hex_nibble(value: u8) -> char {
    match value {
        0..=9 => (b'0' + value) as char,
        _ => (b'a' + (value - 10)) as char,
    }
}

pub struct RawAudioMeetingWriter {
    store: RawAudioStore,
    meeting_id: String,
    raw_dir: PathBuf,
    derived_dir: PathBuf,
    sources: Vec<(AudioSourceId, SourceWriter)>,
    finalized: bool,
}

impl RawAudioMeetingWriter {
    pub fn append_packet(
        &mut self,
        packet: &RawAudioPacket,
        meeting_sample_range: MeetingSampleRange,
        gap: Option<RawAudioGap>,
    ) -> Result<(), RawAudioError> {
        validate_packet(packet, meeting_sample_range)?;
        let attempted_bytes = packet
            .frame_count()
            .checked_mul(usize::from(packet.channels))
            .and_then(|samples| samples.checked_mul(2))
            .and_then(|bytes| u64::try_from(bytes).ok())
            .ok_or(RawAudioError::InvalidPacket("packet too large"))?;
        self.store.ensure_quota(attempted_bytes)?;

        let source_index = self
            .sources
            .iter()
            .position(|(source, _)| *source == packet.source)
            .unwrap_or_else(|| {
                self.sources.push((
                    packet.source,
                    SourceWriter::new(self.raw_dir.join(source_file_name(packet.source))),
                ));
                self.sources.len() - 1
            });
        let source = &mut self.sources[source_index].1;
        source.append(packet, meeting_sample_range, gap)
    }

    pub fn finalize(mut self) -> Result<RawAudioManifest, RawAudioError> {
        self.finalized = true;
        let mut sources = Vec::with_capacity(self.sources.len());
        for (_, source) in std::mem::take(&mut self.sources) {
            sources.push(source.finalize()?);
        }
        let manifest = RawAudioManifest {
            meeting_id: self.meeting_id.clone(),
            raw_dir: self.raw_dir.clone(),
            derived_dir: self.derived_dir.clone(),
            sources,
        };
        let bytes = serde_json::to_vec_pretty(&manifest)?;
        self.store
            .ensure_quota(u64::try_from(bytes.len()).unwrap_or(u64::MAX))?;
        fs::write(self.derived_dir.join(MANIFEST_FILE), bytes)?;
        Ok(manifest)
    }
}

impl Drop for RawAudioMeetingWriter {
    fn drop(&mut self) {
        if self.finalized {
            return;
        }
        for (_, source) in &mut self.sources {
            let _ = source.rewrite_header();
        }
    }
}

struct SourceWriter {
    source: Option<AudioSourceId>,
    sample_rate: u32,
    channels: u16,
    meeting_sample_start: Option<u64>,
    meeting_sample_end: u64,
    frame_count: u64,
    data_bytes: u64,
    path: PathBuf,
    file: File,
    gaps: Vec<RawAudioGap>,
}

impl SourceWriter {
    fn new(path: PathBuf) -> Self {
        Self {
            source: None,
            sample_rate: 0,
            channels: 0,
            meeting_sample_start: None,
            meeting_sample_end: 0,
            frame_count: 0,
            data_bytes: 0,
            path,
            file: placeholder_file(),
            gaps: Vec::new(),
        }
    }

    fn append(
        &mut self,
        packet: &RawAudioPacket,
        meeting_sample_range: MeetingSampleRange,
        gap: Option<RawAudioGap>,
    ) -> Result<(), RawAudioError> {
        if self.source.is_none() {
            if let Some(parent) = self.path.parent() {
                fs::create_dir_all(parent)?;
            }
            let mut file = OpenOptions::new()
                .create(true)
                .truncate(true)
                .write(true)
                .read(true)
                .open(&self.path)?;
            write_wav_header(&mut file, packet.sample_rate, packet.channels, 0)?;
            self.file = file;
            self.source = Some(packet.source);
            self.sample_rate = packet.sample_rate;
            self.channels = packet.channels;
            self.meeting_sample_start = Some(meeting_sample_range.start);
        } else {
            if self.sample_rate != packet.sample_rate || self.channels != packet.channels {
                return Err(RawAudioError::SourceFormatChanged {
                    source: packet.source.to_string(),
                });
            }
            if meeting_sample_range.start < self.meeting_sample_end {
                return Err(RawAudioError::InvalidPacket(
                    "meeting sample range overlaps prior audio",
                ));
            }
            if meeting_sample_range.start > self.meeting_sample_end && gap.is_none() {
                self.gaps.push(RawAudioGap {
                    start: self.meeting_sample_end,
                    end: meeting_sample_range.start,
                    reason: "CAPTURE_GAP".to_owned(),
                });
            }
        }

        self.file.seek(SeekFrom::End(0))?;
        for sample in &packet.samples {
            self.file.write_all(&pcm16_bytes(*sample))?;
        }
        self.frame_count += u64::try_from(packet.frame_count()).unwrap_or(u64::MAX);
        self.data_bytes +=
            u64::try_from(packet.samples.len().saturating_mul(2)).unwrap_or(u64::MAX);
        self.meeting_sample_end = meeting_sample_range.end;
        if let Some(gap) = gap {
            self.gaps.push(gap);
        }
        Ok(())
    }

    fn finalize(mut self) -> Result<RawAudioSourceManifest, RawAudioError> {
        self.rewrite_header()?;
        self.file.flush()?;
        let byte_length = self.file.metadata()?.len();
        drop(self.file);
        let sha256 = sha256_hex_file(&self.path)?;
        Ok(RawAudioSourceManifest {
            source: self
                .source
                .ok_or(RawAudioError::InvalidPacket("empty source"))?
                .to_string(),
            path: self.path,
            sample_rate: self.sample_rate,
            channels: self.channels,
            meeting_sample_start: self.meeting_sample_start.unwrap_or(0),
            meeting_sample_end: self.meeting_sample_end,
            frame_count: self.frame_count,
            byte_length,
            sha256,
            gaps: self.gaps,
        })
    }

    fn rewrite_header(&mut self) -> Result<(), RawAudioError> {
        if self.source.is_none() {
            return Ok(());
        }
        self.file.seek(SeekFrom::Start(0))?;
        write_wav_header(
            &mut self.file,
            self.sample_rate,
            self.channels,
            self.data_bytes,
        )?;
        Ok(())
    }
}

fn placeholder_file() -> File {
    #[cfg(windows)]
    let path = Path::new("NUL");
    #[cfg(not(windows))]
    let path = Path::new("/dev/null");
    OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .expect("null device should be available")
}

fn validate_packet(
    packet: &RawAudioPacket,
    meeting_sample_range: MeetingSampleRange,
) -> Result<(), RawAudioError> {
    if packet.sample_rate == 0 {
        return Err(RawAudioError::InvalidPacket("sample rate must be non-zero"));
    }
    if packet.channels == 0 {
        return Err(RawAudioError::InvalidPacket("channels must be non-zero"));
    }
    if !packet
        .samples
        .len()
        .is_multiple_of(usize::from(packet.channels))
    {
        return Err(RawAudioError::InvalidPacket(
            "sample count must be divisible by channel count",
        ));
    }
    if meeting_sample_range.end <= meeting_sample_range.start {
        return Err(RawAudioError::InvalidPacket("range end precedes start"));
    }
    Ok(())
}

fn validate_id(value: &str) -> Result<(), RawAudioError> {
    if value.is_empty()
        || value.len() > 128
        || value == "."
        || value == ".."
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(RawAudioError::InvalidMeetingId);
    }
    Ok(())
}

fn source_file_name(source: AudioSourceId) -> &'static str {
    match source {
        AudioSourceId::SystemOutput => "system-output.wav",
        AudioSourceId::Microphone => "microphone.wav",
    }
}

fn recover_source_manifest(
    path: PathBuf,
    source: AudioSourceId,
) -> Result<RawAudioSourceManifest, RawAudioError> {
    let mut file = OpenOptions::new().read(true).write(true).open(&path)?;
    let mut header = [0_u8; WAV_HEADER_BYTES as usize];
    std::io::Read::read_exact(&mut file, &mut header)?;
    if &header[0..4] != b"RIFF" || &header[8..12] != b"WAVE" || &header[36..40] != b"data" {
        return Err(RawAudioError::InvalidPacket("invalid wav header"));
    }
    let channels = u16::from_le_bytes([header[22], header[23]]);
    let sample_rate = u32::from_le_bytes([header[24], header[25], header[26], header[27]]);
    if channels == 0 || sample_rate == 0 {
        return Err(RawAudioError::InvalidPacket("invalid wav format"));
    }
    let block_align = u64::from(channels) * 2;
    let file_length = file.metadata()?.len();
    let data_bytes = file_length
        .saturating_sub(WAV_HEADER_BYTES)
        .saturating_sub(file_length.saturating_sub(WAV_HEADER_BYTES) % block_align);
    file.set_len(WAV_HEADER_BYTES + data_bytes)?;
    file.seek(SeekFrom::Start(0))?;
    write_wav_header(&mut file, sample_rate, channels, data_bytes)?;
    file.flush()?;
    let byte_length = file.metadata()?.len();
    drop(file);
    let sha256 = sha256_hex_file(&path)?;
    let frame_count = data_bytes / block_align;
    let meeting_sample_end = frame_count
        .saturating_mul(16_000)
        .saturating_add(u64::from(sample_rate).saturating_sub(1))
        / u64::from(sample_rate);
    Ok(RawAudioSourceManifest {
        source: source.to_string(),
        path,
        sample_rate,
        channels,
        meeting_sample_start: 0,
        meeting_sample_end,
        frame_count,
        byte_length,
        sha256,
        gaps: Vec::new(),
    })
}

fn mix_source_window(
    source: &RawAudioSourceManifest,
    start: u64,
    end: u64,
    sums: &mut [f64],
    contributors: &mut [u8],
) -> Result<(), RawAudioError> {
    let overlap_start = start.max(source.meeting_sample_start);
    let overlap_end = end.min(source.meeting_sample_end);
    if overlap_end <= overlap_start || !source.path.is_file() {
        return Ok(());
    }

    let mut file = File::open(&source.path)?;
    let mut header = [0_u8; WAV_HEADER_BYTES as usize];
    file.read_exact(&mut header)?;
    let channels = u16::from_le_bytes([header[22], header[23]]);
    let sample_rate = u32::from_le_bytes([header[24], header[25], header[26], header[27]]);
    let audio_format = u16::from_le_bytes([header[20], header[21]]);
    let bits_per_sample = u16::from_le_bytes([header[34], header[35]]);
    if &header[0..4] != b"RIFF"
        || &header[8..12] != b"WAVE"
        || &header[36..40] != b"data"
        || audio_format != 1
        || bits_per_sample != 16
        || channels == 0
        || sample_rate == 0
        || channels != source.channels
        || sample_rate != source.sample_rate
    {
        return Err(RawAudioError::InvalidPacket(
            "unsupported recovery wav format",
        ));
    }

    let present_start = present_samples_before(source, overlap_start);
    let present_end = present_samples_before(source, overlap_end);
    if present_end <= present_start {
        return Ok(());
    }
    let rate = u64::from(sample_rate);
    let native_start = u64::try_from(
        u128::from(present_start).saturating_mul(u128::from(rate))
            / u128::from(RECOVERY_SAMPLE_RATE_HZ),
    )
    .unwrap_or(u64::MAX);
    let native_end = u64::try_from(
        u128::from(present_end)
            .saturating_mul(u128::from(rate))
            .saturating_add(u128::from(RECOVERY_SAMPLE_RATE_HZ - 1))
            / u128::from(RECOVERY_SAMPLE_RATE_HZ),
    )
    .unwrap_or(u64::MAX)
    .saturating_add(1)
    .min(source.frame_count);
    if native_end <= native_start {
        return Ok(());
    }

    let block_align = u64::from(channels) * 2;
    let read_bytes = native_end
        .saturating_sub(native_start)
        .checked_mul(block_align)
        .and_then(|value| usize::try_from(value).ok())
        .ok_or(RawAudioError::InvalidPacket(
            "recovery wav window too large",
        ))?;
    file.seek(SeekFrom::Start(
        WAV_HEADER_BYTES.saturating_add(native_start.saturating_mul(block_align)),
    ))?;
    let mut bytes = vec![0_u8; read_bytes];
    file.read_exact(&mut bytes)?;

    for meeting_sample in overlap_start..overlap_end {
        if source
            .gaps
            .iter()
            .any(|gap| meeting_sample >= gap.start && meeting_sample < gap.end)
        {
            continue;
        }
        let present_sample = present_samples_before(source, meeting_sample);
        let native_position = u128::from(present_sample).saturating_mul(u128::from(rate));
        let frame = u64::try_from(native_position / u128::from(RECOVERY_SAMPLE_RATE_HZ))
            .unwrap_or(u64::MAX);
        if frame < native_start || frame >= native_end {
            continue;
        }
        let fraction = (native_position % u128::from(RECOVERY_SAMPLE_RATE_HZ)) as f64
            / RECOVERY_SAMPLE_RATE_HZ as f64;
        let first = decode_mono_frame(&bytes, frame - native_start, channels);
        let second = if frame.saturating_add(1) < native_end {
            decode_mono_frame(&bytes, frame.saturating_add(1) - native_start, channels)
        } else {
            first
        };
        let sample = first + (second - first) * fraction;
        let output_index = usize::try_from(meeting_sample - start)
            .map_err(|_| RawAudioError::InvalidPacket("recovery sample index overflow"))?;
        sums[output_index] += sample;
        contributors[output_index] = contributors[output_index].saturating_add(1);
    }
    Ok(())
}

fn present_samples_before(source: &RawAudioSourceManifest, point: u64) -> u64 {
    let point = point.clamp(source.meeting_sample_start, source.meeting_sample_end);
    let elapsed = point.saturating_sub(source.meeting_sample_start);
    let missing = source.gaps.iter().fold(0_u64, |total, gap| {
        let gap_start = gap.start.max(source.meeting_sample_start);
        let gap_end = gap.end.min(point);
        total.saturating_add(gap_end.saturating_sub(gap_start).min(elapsed))
    });
    elapsed.saturating_sub(missing.min(elapsed))
}

fn decode_mono_frame(bytes: &[u8], relative_frame: u64, channels: u16) -> f64 {
    let Some(start) = relative_frame
        .checked_mul(u64::from(channels))
        .and_then(|value| value.checked_mul(2))
        .and_then(|value| usize::try_from(value).ok())
    else {
        return 0.0;
    };
    let mut sum = 0.0_f64;
    for channel in 0..usize::from(channels) {
        let offset = start.saturating_add(channel.saturating_mul(2));
        let Some(sample_bytes) = bytes.get(offset..offset.saturating_add(2)) else {
            return 0.0;
        };
        sum += f64::from(i16::from_le_bytes([sample_bytes[0], sample_bytes[1]])) / 32_768.0;
    }
    (sum / f64::from(channels)).clamp(-1.0, 1.0)
}

fn write_wav_header(
    writer: &mut File,
    sample_rate: u32,
    channels: u16,
    data_bytes: u64,
) -> Result<(), RawAudioError> {
    let data_size = u32::try_from(data_bytes)
        .map_err(|_| RawAudioError::InvalidPacket("wav data exceeds u32 size"))?;
    let riff_size = data_size
        .checked_add(36)
        .ok_or(RawAudioError::InvalidPacket("wav data exceeds riff size"))?;
    let byte_rate = sample_rate
        .checked_mul(u32::from(channels))
        .and_then(|value| value.checked_mul(2))
        .ok_or(RawAudioError::InvalidPacket("wav byte rate overflow"))?;
    let block_align = channels
        .checked_mul(2)
        .ok_or(RawAudioError::InvalidPacket("wav block align overflow"))?;

    writer.write_all(b"RIFF")?;
    writer.write_all(&riff_size.to_le_bytes())?;
    writer.write_all(b"WAVEfmt ")?;
    writer.write_all(&16_u32.to_le_bytes())?;
    writer.write_all(&1_u16.to_le_bytes())?;
    writer.write_all(&channels.to_le_bytes())?;
    writer.write_all(&sample_rate.to_le_bytes())?;
    writer.write_all(&byte_rate.to_le_bytes())?;
    writer.write_all(&block_align.to_le_bytes())?;
    writer.write_all(&16_u16.to_le_bytes())?;
    writer.write_all(b"data")?;
    writer.write_all(&data_size.to_le_bytes())?;
    Ok(())
}

fn pcm16_bytes(sample: f32) -> [u8; 2] {
    let clamped = if sample.is_nan() {
        0.0
    } else {
        sample.clamp(-1.0, 1.0)
    };
    let scaled = if clamped < 0.0 {
        clamped * 32768.0
    } else {
        clamped * 32767.0
    };
    (scaled.round() as i16).to_le_bytes()
}

fn collect_retention_candidates(
    root: &Path,
    now: SystemTime,
    older_than: Duration,
    output: &mut BTreeSet<String>,
) -> Result<(), RawAudioError> {
    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    for entry in entries {
        let entry = entry?;
        let file_name = entry.file_name().to_string_lossy().into_owned();
        if validate_id(&file_name).is_err() {
            continue;
        }
        let metadata = fs::symlink_metadata(entry.path())?;
        if !metadata.is_dir() {
            continue;
        }
        let Ok(modified) = metadata.modified() else {
            continue;
        };
        if now
            .duration_since(modified)
            .map(|age| age >= older_than)
            .unwrap_or(false)
        {
            output.insert(file_name);
        }
    }
    Ok(())
}

fn path_size(path: &Path) -> Result<u64, RawAudioError> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.is_file() {
        return Ok(metadata.len());
    }
    if !metadata.is_dir() {
        return Ok(0);
    }

    let mut total = 0_u64;
    for entry in fs::read_dir(path)? {
        total = total.saturating_add(path_size(&entry?.path())?);
    }
    Ok(total)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mvp::audio::AudioSourceId;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn default_off_writes_nothing() {
        let root = test_root("default-off");
        let store = RawAudioStore::new(RawAudioConfig {
            root_dir: root.clone(),
            ..RawAudioConfig::default()
        });

        assert!(store.begin_meeting("meeting-1").unwrap().is_none());
        assert!(!root.exists());
    }

    #[test]
    fn enabled_writes_two_sources_with_manifest_and_checksum_ranges() {
        let root = test_root("two-sources");
        let store = enabled_store(&root, None);
        let mut writer = store.begin_meeting("meeting-1").unwrap().unwrap();

        writer
            .append_packet(
                &packet(
                    AudioSourceId::SystemOutput,
                    48_000,
                    2,
                    &[0.0, 0.5, -0.5, 1.0],
                ),
                MeetingSampleRange::new(0, 2),
                None,
            )
            .unwrap();
        writer
            .append_packet(
                &packet(AudioSourceId::Microphone, 16_000, 1, &[0.25, -0.25, 0.0]),
                MeetingSampleRange::new(10, 13),
                None,
            )
            .unwrap();

        let manifest = writer.finalize().unwrap();
        assert_eq!(manifest.sources.len(), 2);
        let system = manifest
            .sources
            .iter()
            .find(|source| source.source == "system-output")
            .unwrap();
        assert_eq!(system.sample_rate, 48_000);
        assert_eq!(system.channels, 2);
        assert_eq!(system.meeting_sample_start, 0);
        assert_eq!(system.meeting_sample_end, 2);
        assert_eq!(system.frame_count, 2);
        assert_eq!(system.byte_length, WAV_HEADER_BYTES + 8);
        assert_eq!(system.sha256, sha256_hex(&fs::read(&system.path).unwrap()));
        assert!(is_wav(&fs::read(&system.path).unwrap()));

        let mic = manifest
            .sources
            .iter()
            .find(|source| source.source == "microphone")
            .unwrap();
        assert_eq!(mic.meeting_sample_start, 10);
        assert_eq!(mic.meeting_sample_end, 13);
        assert_eq!(mic.frame_count, 3);
        assert_eq!(mic.sha256, sha256_hex(&fs::read(&mic.path).unwrap()));
        assert!(
            store
                .derived_root()
                .join("meeting-1")
                .join(MANIFEST_FILE)
                .exists()
        );
    }

    #[test]
    fn gap_metadata_is_preserved() {
        let root = test_root("gap");
        let store = enabled_store(&root, None);
        let mut writer = store.begin_meeting("meeting-1").unwrap().unwrap();

        writer
            .append_packet(
                &packet(AudioSourceId::Microphone, 16_000, 1, &[0.0, 0.0]),
                MeetingSampleRange::new(20, 22),
                Some(RawAudioGap {
                    start: 18,
                    end: 20,
                    reason: "paused".to_owned(),
                }),
            )
            .unwrap();

        let manifest = writer.finalize().unwrap();
        assert_eq!(
            manifest.sources[0].gaps,
            vec![RawAudioGap {
                start: 18,
                end: 20,
                reason: "paused".to_owned(),
            }]
        );
    }

    #[test]
    fn recovery_window_mixes_sources_and_preserves_gap_silence() {
        let root = test_root("recovery-window");
        let store = enabled_store(&root, None);
        let mut writer = store.begin_meeting("meeting-1").unwrap().unwrap();
        writer
            .append_packet(
                &packet(AudioSourceId::SystemOutput, 16_000, 1, &[0.5; 160]),
                MeetingSampleRange::new(0, 160),
                None,
            )
            .unwrap();
        writer
            .append_packet(
                &packet(AudioSourceId::SystemOutput, 16_000, 1, &[0.5; 160]),
                MeetingSampleRange::new(320, 480),
                Some(RawAudioGap {
                    start: 160,
                    end: 320,
                    reason: "CAPTURE_GAP".to_owned(),
                }),
            )
            .unwrap();
        writer
            .append_packet(
                &packet(AudioSourceId::Microphone, 16_000, 1, &[-0.25; 480]),
                MeetingSampleRange::new(0, 480),
                None,
            )
            .unwrap();

        let manifest = writer.finalize().unwrap();
        let mixed = read_mixed_window_16khz(&manifest, 0, 480).unwrap();

        assert_eq!(mixed.len(), 480);
        assert!((mixed[80] - 0.125).abs() < 0.001);
        assert!((mixed[240] + 0.25).abs() < 0.001);
        assert!((mixed[400] - 0.125).abs() < 0.001);
    }

    #[test]
    fn feature_window_is_bounded_for_large_segments() {
        let root = test_root("feature-window");
        let store = enabled_store(&root, None);
        let mut writer = store.begin_meeting("meeting-1").unwrap().unwrap();
        writer
            .append_packet(
                &packet(AudioSourceId::Microphone, 16_000, 1, &vec![0.5; 32_000]),
                MeetingSampleRange::new(0, 32_000),
                None,
            )
            .unwrap();

        let manifest = writer.finalize().unwrap();
        let mixed = read_mixed_feature_window_16khz(&manifest, 0, 32_000, 1024).unwrap();

        assert_eq!(mixed.len(), 1024);
        assert!(mixed.iter().all(|sample| (*sample - 0.5).abs() < 0.001));
    }

    #[test]
    fn load_manifest_rejects_source_path_escape_and_checksum_mismatch() {
        let root = test_root("manifest-trust");
        let store = enabled_store(&root, None);
        let mut writer = store.begin_meeting("meeting-1").unwrap().unwrap();
        writer
            .append_packet(
                &packet(AudioSourceId::Microphone, 16_000, 1, &[0.25, -0.25]),
                MeetingSampleRange::new(0, 2),
                None,
            )
            .unwrap();

        let mut manifest = writer.finalize().unwrap();
        assert!(store.load_manifest("meeting-1").unwrap().is_some());

        let original_path = manifest.sources[0].path.clone();
        let original_bytes = fs::read(&original_path).unwrap();
        let outside_path = root.join("outside.wav");
        fs::write(&outside_path, &original_bytes).unwrap();
        manifest.sources[0].path = outside_path;
        fs::write(
            store.derived_root().join("meeting-1").join(MANIFEST_FILE),
            serde_json::to_vec_pretty(&manifest).unwrap(),
        )
        .unwrap();
        assert!(matches!(
            store.load_manifest("meeting-1"),
            Err(RawAudioError::InvalidPacket(_))
        ));

        manifest.sources[0].path = original_path;
        manifest.sources[0].sha256 = sha256_hex(b"tampered");
        fs::write(
            store.derived_root().join("meeting-1").join(MANIFEST_FILE),
            serde_json::to_vec_pretty(&manifest).unwrap(),
        )
        .unwrap();
        assert!(matches!(
            store.load_manifest("meeting-1"),
            Err(RawAudioError::InvalidPacket(_))
        ));
    }

    #[test]
    fn streaming_sha256_matches_known_vector_and_handles_sparse_large_file() {
        let mut hasher = StreamingSha256::new();
        hasher.update(b"a");
        hasher.update(b"bc");
        assert_eq!(
            hasher.finalize_hex(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );

        let root = test_root("streaming-sha");
        fs::create_dir_all(&root).unwrap();
        let path = root.join("sparse-large.wav");
        let file = File::create(&path).unwrap();
        file.set_len(64 * 1024 * 1024).unwrap();
        drop(file);
        let digest = sha256_hex_file(&path).unwrap();
        assert_eq!(digest.len(), 64);
        assert_eq!(digest, sha256_hex_file(&path).unwrap());
    }

    #[test]
    fn finalize_and_recovery_hash_sparse_audio_without_whole_file_buffers() {
        const SPARSE_BYTES: u64 = 8 * 1024 * 1024;

        let root = test_root("streaming-production-paths");
        fs::create_dir_all(&root).unwrap();
        let path = root.join("microphone.wav");
        let mut source = SourceWriter::new(path.clone());
        source
            .append(
                &packet(AudioSourceId::Microphone, 16_000, 1, &[0.25, -0.25]),
                MeetingSampleRange::new(0, 2),
                None,
            )
            .unwrap();
        source.file.set_len(SPARSE_BYTES).unwrap();

        let finalized = source.finalize().unwrap();
        assert_eq!(finalized.byte_length, SPARSE_BYTES);
        assert_eq!(finalized.sha256, sha256_hex_file(&path).unwrap());

        let recovered = recover_source_manifest(path.clone(), AudioSourceId::Microphone).unwrap();
        assert_eq!(recovered.byte_length, SPARSE_BYTES);
        assert_eq!(recovered.sha256, sha256_hex_file(&path).unwrap());
    }

    #[test]
    fn quota_failure_does_not_delete_existing_audio() {
        let root = test_root("quota");
        let store = enabled_store(&root, Some(WAV_HEADER_BYTES + 4));
        let mut writer = store.begin_meeting("meeting-1").unwrap().unwrap();
        writer
            .append_packet(
                &packet(AudioSourceId::Microphone, 16_000, 1, &[0.0, 0.0]),
                MeetingSampleRange::new(0, 2),
                None,
            )
            .unwrap();

        let result = writer.append_packet(
            &packet(AudioSourceId::Microphone, 16_000, 1, &[0.0]),
            MeetingSampleRange::new(2, 3),
            None,
        );

        assert!(matches!(result, Err(RawAudioError::QuotaExceeded { .. })));
        assert!(
            store
                .raw_root()
                .join("meeting-1")
                .join("microphone.wav")
                .exists()
        );
    }

    #[test]
    fn delete_preview_and_delete_are_idempotent() {
        let root = test_root("delete");
        let store = enabled_store(&root, None);
        let mut writer = store.begin_meeting("meeting-1").unwrap().unwrap();
        writer
            .append_packet(
                &packet(AudioSourceId::SystemOutput, 48_000, 1, &[0.0]),
                MeetingSampleRange::new(0, 1),
                None,
            )
            .unwrap();
        writer.finalize().unwrap();

        let preview = store.delete_preview("meeting-1").unwrap().unwrap();
        assert_eq!(preview.paths.len(), 2);
        assert!(preview.total_bytes > 0);

        assert!(store.delete_meeting("meeting-1").unwrap().is_some());
        assert!(store.delete_meeting("meeting-1").unwrap().is_none());
        assert!(store.delete_preview("meeting-1").unwrap().is_none());
    }

    #[test]
    fn traversal_ids_are_rejected() {
        let root = test_root("traversal");
        let store = enabled_store(&root, None);

        assert!(matches!(
            store.begin_meeting("../outside"),
            Err(RawAudioError::InvalidMeetingId)
        ));
        assert!(matches!(
            store.delete_preview(".."),
            Err(RawAudioError::InvalidMeetingId)
        ));
    }

    fn enabled_store(root: &Path, quota_bytes: Option<u64>) -> RawAudioStore {
        RawAudioStore::new(RawAudioConfig {
            enabled: true,
            root_dir: root.to_path_buf(),
            quota_bytes,
            retention: RawAudioRetentionPolicy::NeverAutoDelete,
        })
    }

    fn packet(
        source: AudioSourceId,
        sample_rate: u32,
        channels: u16,
        samples: &[f32],
    ) -> RawAudioPacket {
        RawAudioPacket {
            source,
            sample_rate,
            channels,
            captured_frame_start: 0,
            samples: samples.to_vec(),
        }
    }

    fn test_root(name: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("meetingrelay-raw-audio-{name}-{unique}"));
        let _ = fs::remove_dir_all(&root);
        root
    }

    fn is_wav(bytes: &[u8]) -> bool {
        bytes.len() >= usize::try_from(WAV_HEADER_BYTES).unwrap()
            && &bytes[0..4] == b"RIFF"
            && &bytes[8..12] == b"WAVE"
            && &bytes[36..40] == b"data"
    }
}
