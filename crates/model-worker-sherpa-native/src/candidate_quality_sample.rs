use std::fmt::{self, Write as _};
use std::fs::{self, File, OpenOptions};
use std::io::Read;
#[cfg(unix)]
use std::os::unix::fs::MetadataExt as UnixMetadataExt;
#[cfg(windows)]
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

use meetingrelay_model_worker_contract::{
    AudioChunk, AudioFormat, AudioPayload, AudioSource, ExecutionProvider, Identifier,
    LanguageCode, ModelBackend, SampleFormat, Sha256Digest, SourceRange, WorkerManifest,
};
use sha2::{Digest, Sha256};

use crate::candidate_execution::validate_loaded_runtime_identity;
use crate::{
    LOCKED_ASSET_LOCK_SHA256_HEX, LOCKED_CANDIDATE_ID, LOCKED_MODEL_SHA256_HEX,
    LOCKED_PACKAGE_LOCK_SHA256_HEX, LOCKED_RUNTIME_BUNDLE_SHA256_HEX, LOCKED_TOKENS_SHA256_HEX,
    SherpaNativeBackend, SherpaNativeConfig, locked_engine_descriptor,
    locked_schema_registry_sha256, locked_worker_manifest, sha256_file,
};

const SAMPLE_RATE_HZ: u32 = 16_000;
const CHANNELS: u16 = 1;
const PCM_BYTES_PER_SAMPLE: u64 = 2;
const NANOS_PER_SAMPLE: u64 = 62_500;
const MIN_WAV_BYTES: u64 = 44;
const MAX_WAV_BYTES: u64 = 64 * 1024 * 1024;
const MAX_TRANSCRIPT_UTF8_BYTES: usize = 16_384;
const MAX_RECORD_BYTES: usize = 4_096 + (MAX_TRANSCRIPT_UTF8_BYTES * 6);
const RESOURCE_UNAVAILABLE_REASON: &str = "SHERPA_QUALITY_RESOURCE_SAMPLING_UNAVAILABLE";
static QUALITY_SAMPLE_STARTED: AtomicBool = AtomicBool::new(false);

/// Externally locked identity for one quality fixture without reference text.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativeCandidateQualitySampleIdentity {
    pub sample_id: Identifier,
    pub language: LanguageCode,
    pub expected_wav_size_bytes: u64,
    pub expected_wav_sha256: Sha256Digest,
    pub expected_pcm_sha256: Sha256Digest,
    pub reference_sha256: Sha256Digest,
}

/// Exact candidate paths and one canonical quality-sample identity.
#[derive(Clone)]
pub struct NativeCandidateQualitySampleInput {
    pub schema_registry_path: PathBuf,
    pub model_path: PathBuf,
    pub tokens_path: PathBuf,
    pub runtime_lib_dir: PathBuf,
    pub asset_lock_path: PathBuf,
    pub package_lock_path: PathBuf,
    pub wav_path: PathBuf,
    pub sample: NativeCandidateQualitySampleIdentity,
}

#[derive(Clone)]
struct ResolvedNativeCandidateQualitySampleInput {
    executable_path: PathBuf,
    schema_registry_path: PathBuf,
    model_path: PathBuf,
    tokens_path: PathBuf,
    runtime_lib_dir: PathBuf,
    asset_lock_path: PathBuf,
    package_lock_path: PathBuf,
    wav_path: PathBuf,
    sample: NativeCandidateQualitySampleIdentity,
}

impl NativeCandidateQualitySampleInput {
    fn resolve(
        self,
    ) -> Result<ResolvedNativeCandidateQualitySampleInput, NativeCandidateQualitySampleError> {
        Ok(ResolvedNativeCandidateQualitySampleInput {
            executable_path: current_regular_executable()?,
            schema_registry_path: self.schema_registry_path,
            model_path: self.model_path,
            tokens_path: self.tokens_path,
            runtime_lib_dir: self.runtime_lib_dir,
            asset_lock_path: self.asset_lock_path,
            package_lock_path: self.package_lock_path,
            wav_path: self.wav_path,
            sample: self.sample,
        })
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NativeCandidateQualitySampleError {
    InvalidInput,
    FreshProcessRequired,
    AssetUnavailable,
    AssetMismatch,
    Configuration,
    Preparation,
    Execution,
    Observation,
    Provenance,
}

impl NativeCandidateQualitySampleError {
    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            Self::InvalidInput => "SHERPA_QUALITY_INVALID_INPUT",
            Self::FreshProcessRequired => "SHERPA_QUALITY_FRESH_PROCESS_REQUIRED",
            Self::AssetUnavailable => "SHERPA_QUALITY_ASSET_UNAVAILABLE",
            Self::AssetMismatch => "SHERPA_QUALITY_ASSET_MISMATCH",
            Self::Configuration => "SHERPA_QUALITY_CONFIGURATION",
            Self::Preparation => "SHERPA_QUALITY_PREPARATION",
            Self::Execution => "SHERPA_QUALITY_EXECUTION",
            Self::Observation => "SHERPA_QUALITY_OBSERVATION",
            Self::Provenance => "SHERPA_QUALITY_PROVENANCE",
        }
    }
}

impl fmt::Display for NativeCandidateQualitySampleError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code())
    }
}

impl std::error::Error for NativeCandidateQualitySampleError {}

/// Measures exactly one locked sample in the current fresh host process.
///
/// Sample bytes and every caller-supplied identity field are verified before
/// native construction, preparation, or execution. The returned canonical
/// line is a private pipe record containing the original transcript alongside
/// stable identifiers, hashes, counts, integer timings, null resource
/// observations, and fixed status codes.
pub fn run_locked_native_candidate_quality_sample(
    input: NativeCandidateQualitySampleInput,
) -> Result<Vec<u8>, NativeCandidateQualitySampleError> {
    if cfg!(debug_assertions) {
        return Err(NativeCandidateQualitySampleError::Configuration);
    }
    let input = input.resolve()?;
    if QUALITY_SAMPLE_STARTED
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Err(NativeCandidateQualitySampleError::FreshProcessRequired);
    }
    let executable_path = input.executable_path.clone();
    run_quality_sample_with_backend_factory(input, move |config| {
        let inner = SherpaNativeBackend::new_quality_sample(config)
            .map_err(|_| NativeCandidateQualitySampleError::Configuration)?;
        Ok(Box::new(NativeQualityBackend {
            executable_path,
            inner,
        }))
    })
}

trait CandidateQualityBackend: Send {
    fn prepare(&mut self) -> Result<(), NativeCandidateQualitySampleError>;

    fn validate_runtime_identity(&self) -> Result<(), NativeCandidateQualitySampleError>;

    fn execute(
        &mut self,
        samples: &[i16],
        pcm_sha256: Sha256Digest,
    ) -> Result<QualityTranscriptIdentity, NativeCandidateQualitySampleError>;
}

struct NativeQualityBackend {
    executable_path: PathBuf,
    inner: SherpaNativeBackend,
}

impl CandidateQualityBackend for NativeQualityBackend {
    fn prepare(&mut self) -> Result<(), NativeCandidateQualitySampleError> {
        self.inner
            .prepare()
            .map_err(|_| NativeCandidateQualitySampleError::Preparation)
    }

    fn validate_runtime_identity(&self) -> Result<(), NativeCandidateQualitySampleError> {
        validate_loaded_runtime_identity(&self.executable_path)
            .map_err(|_| NativeCandidateQualitySampleError::Provenance)
    }

    fn execute(
        &mut self,
        samples: &[i16],
        pcm_sha256: Sha256Digest,
    ) -> Result<QualityTranscriptIdentity, NativeCandidateQualitySampleError> {
        let sample_count = u64::try_from(samples.len())
            .map_err(|_| NativeCandidateQualitySampleError::InvalidInput)?;
        let payload_bytes = sample_count
            .checked_mul(PCM_BYTES_PER_SAMPLE)
            .ok_or(NativeCandidateQualitySampleError::InvalidInput)?;
        let capture_epoch_id = Identifier::new("candidate-quality-capture-epoch")
            .map_err(|_| NativeCandidateQualitySampleError::Configuration)?;
        let chunk = AudioChunk {
            sequence: 1,
            media_start_sample: 0,
            media_end_sample: sample_count,
            timeline_rate: SAMPLE_RATE_HZ,
            format: AudioFormat {
                sample_rate_hz: SAMPLE_RATE_HZ,
                channels: CHANNELS,
                sample_format: SampleFormat::PcmS16Le,
            },
            capture_epoch_ids: vec![capture_epoch_id.clone()],
            source_ranges: vec![SourceRange {
                audio_source: AudioSource::System,
                capture_epoch_id,
                device_start_sample: 0,
                device_end_sample: sample_count,
                meeting_start_sample: 0,
                meeting_end_sample: sample_count,
                sample_rate_hz: SAMPLE_RATE_HZ,
            }],
            payload_bytes,
            payload_sha256: Some(pcm_sha256),
            payload: Some(AudioPayload::PcmS16Le(Arc::from(samples))),
        };
        let text = self
            .inner
            .recognize_quality_sample_text(&[chunk])
            .map_err(|_| NativeCandidateQualitySampleError::Execution)?;
        Ok(QualityTranscriptIdentity::from_text(text))
    }
}

#[derive(Clone)]
struct QualityTranscriptIdentity {
    final_transcript: String,
    sha256: Sha256Digest,
    utf8_bytes: usize,
}

impl QualityTranscriptIdentity {
    fn from_text(final_transcript: String) -> Self {
        let transcript = final_transcript.as_bytes();
        Self {
            sha256: Sha256Digest::from_bytes(Sha256::digest(transcript).into()),
            utf8_bytes: transcript.len(),
            final_transcript,
        }
    }

    fn validate(&self) -> Result<&str, NativeCandidateQualitySampleError> {
        let transcript = self.final_transcript.as_bytes();
        let text = std::str::from_utf8(transcript)
            .map_err(|_| NativeCandidateQualitySampleError::Observation)?;
        let actual_sha256 = Sha256Digest::from_bytes(Sha256::digest(transcript).into());
        if transcript.contains(&0)
            || transcript.len() > MAX_TRANSCRIPT_UTF8_BYTES
            || self.utf8_bytes != transcript.len()
            || self.sha256 != actual_sha256
            || self.sha256.is_zero()
        {
            return Err(NativeCandidateQualitySampleError::Observation);
        }
        Ok(text)
    }
}

struct VerifiedQualityWav {
    samples: Vec<i16>,
    pcm_bytes: u64,
    sample_count: u64,
    audio_duration_ns: u64,
}

struct QualityMeasurement {
    execute_elapsed_ns: u64,
    prepare_elapsed_ns: u64,
    transcript: QualityTranscriptIdentity,
}

fn run_quality_sample_with_backend_factory<F>(
    input: ResolvedNativeCandidateQualitySampleInput,
    backend_factory: F,
) -> Result<Vec<u8>, NativeCandidateQualitySampleError>
where
    F: FnOnce(
        SherpaNativeConfig,
    ) -> Result<Box<dyn CandidateQualityBackend>, NativeCandidateQualitySampleError>,
{
    validate_input(&input)?;
    validate_regular_non_reparse_file(&input.executable_path)?;
    let executable_sha256 = sha256_file(&input.executable_path)
        .map_err(|_| NativeCandidateQualitySampleError::AssetUnavailable)?;
    let schema_registry_sha256 = locked_schema_registry_sha256(&input.schema_registry_path)
        .map_err(|_| NativeCandidateQualitySampleError::Provenance)?;
    let manifest = locked_worker_manifest(executable_sha256, schema_registry_sha256)
        .map_err(|_| NativeCandidateQualitySampleError::Provenance)?;
    let verified = read_verified_quality_wav(&input)?;
    let config = locked_config(&input)?;
    let parameter_sha256 = config.descriptor.parameter_sha256;
    let mut backend = backend_factory(config)?;

    let prepare_started = Instant::now();
    backend.prepare()?;
    let prepare_elapsed_ns = u64::try_from(prepare_started.elapsed().as_nanos())
        .map_err(|_| NativeCandidateQualitySampleError::Observation)?;
    backend.validate_runtime_identity()?;

    let execute_started = Instant::now();
    let transcript = backend.execute(&verified.samples, input.sample.expected_pcm_sha256)?;
    let execute_elapsed_ns = u64::try_from(execute_started.elapsed().as_nanos())
        .map_err(|_| NativeCandidateQualitySampleError::Observation)?;
    backend.validate_runtime_identity()?;
    encode_record(
        &input.sample,
        &manifest,
        &verified,
        parameter_sha256,
        QualityMeasurement {
            execute_elapsed_ns,
            prepare_elapsed_ns,
            transcript,
        },
    )
}

fn validate_input(
    input: &ResolvedNativeCandidateQualitySampleInput,
) -> Result<(), NativeCandidateQualitySampleError> {
    let paths = [
        &input.executable_path,
        &input.schema_registry_path,
        &input.model_path,
        &input.tokens_path,
        &input.runtime_lib_dir,
        &input.asset_lock_path,
        &input.package_lock_path,
        &input.wav_path,
    ];
    if paths.iter().any(|path| !path.is_absolute())
        || !(MIN_WAV_BYTES..=MAX_WAV_BYTES).contains(&input.sample.expected_wav_size_bytes)
        || input.sample.expected_wav_sha256.is_zero()
        || input.sample.expected_pcm_sha256.is_zero()
        || input.sample.reference_sha256.is_zero()
        || !matches!(input.sample.language.as_str(), "zh" | "ja" | "en")
    {
        return Err(NativeCandidateQualitySampleError::InvalidInput);
    }
    Ok(())
}

fn locked_config(
    input: &ResolvedNativeCandidateQualitySampleInput,
) -> Result<SherpaNativeConfig, NativeCandidateQualitySampleError> {
    let descriptor = locked_engine_descriptor();
    let mut config = SherpaNativeConfig {
        descriptor,
        model_path: input.model_path.clone(),
        expected_model_sha256: locked_digest(LOCKED_MODEL_SHA256_HEX)?,
        tokens_path: input.tokens_path.clone(),
        expected_tokens_sha256: locked_digest(LOCKED_TOKENS_SHA256_HEX)?,
        runtime_lib_dir: input.runtime_lib_dir.clone(),
        expected_runtime_sha256: locked_digest(LOCKED_RUNTIME_BUNDLE_SHA256_HEX)?,
        asset_lock_path: input.asset_lock_path.clone(),
        expected_asset_lock_sha256: locked_digest(LOCKED_ASSET_LOCK_SHA256_HEX)?,
        package_lock_path: input.package_lock_path.clone(),
        expected_package_lock_sha256: locked_digest(LOCKED_PACKAGE_LOCK_SHA256_HEX)?,
        normalized_language: input.sample.language.clone(),
        execution_provider: ExecutionProvider::Cpu,
        num_threads: 1,
        use_itn: true,
        max_input_bytes: MAX_WAV_BYTES,
    };
    config.descriptor.languages = vec![input.sample.language.clone()];
    config.descriptor.parameter_sha256 = config.parameter_sha256();
    config
        .validate()
        .map_err(|_| NativeCandidateQualitySampleError::Configuration)?;
    Ok(config)
}

fn read_verified_quality_wav(
    input: &ResolvedNativeCandidateQualitySampleInput,
) -> Result<VerifiedQualityWav, NativeCandidateQualitySampleError> {
    reject_reparse_ancestors(&input.wav_path)?;
    let metadata = fs::symlink_metadata(&input.wav_path)
        .map_err(|_| NativeCandidateQualitySampleError::AssetUnavailable)?;
    if !is_regular_non_reparse_file(&metadata)
        || metadata.len() != input.sample.expected_wav_size_bytes
    {
        return Err(NativeCandidateQualitySampleError::AssetMismatch);
    }
    let mut file = open_sealed_read(&input.wav_path)
        .map_err(|_| NativeCandidateQualitySampleError::AssetUnavailable)?;
    let opened_metadata = file
        .metadata()
        .map_err(|_| NativeCandidateQualitySampleError::AssetUnavailable)?;
    if !opened_metadata.is_file()
        || opened_metadata.len() != input.sample.expected_wav_size_bytes
        || !same_file_identity(&metadata, &opened_metadata)
    {
        return Err(NativeCandidateQualitySampleError::AssetMismatch);
    }
    let capacity = usize::try_from(input.sample.expected_wav_size_bytes)
        .map_err(|_| NativeCandidateQualitySampleError::InvalidInput)?;
    let read_limit = input
        .sample
        .expected_wav_size_bytes
        .checked_add(1)
        .ok_or(NativeCandidateQualitySampleError::InvalidInput)?;
    let mut bytes = Vec::with_capacity(capacity);
    file.by_ref()
        .take(read_limit)
        .read_to_end(&mut bytes)
        .map_err(|_| NativeCandidateQualitySampleError::AssetUnavailable)?;
    let opened_after = file
        .metadata()
        .map_err(|_| NativeCandidateQualitySampleError::AssetUnavailable)?;
    let path_after = fs::symlink_metadata(&input.wav_path)
        .map_err(|_| NativeCandidateQualitySampleError::AssetUnavailable)?;
    if bytes.len() != capacity
        || opened_after.len() != input.sample.expected_wav_size_bytes
        || path_after.len() != input.sample.expected_wav_size_bytes
        || !is_regular_non_reparse_file(&path_after)
        || !same_file_identity(&metadata, &opened_after)
        || !same_file_identity(&metadata, &path_after)
    {
        return Err(NativeCandidateQualitySampleError::AssetMismatch);
    }
    let wav_sha256 = Sha256Digest::from_bytes(Sha256::digest(&bytes).into());
    if wav_sha256 != input.sample.expected_wav_sha256 {
        return Err(NativeCandidateQualitySampleError::AssetMismatch);
    }
    let pcm = parse_mono_pcm16_wav(&bytes)?;
    let pcm_sha256 = Sha256Digest::from_bytes(Sha256::digest(pcm).into());
    if pcm_sha256 != input.sample.expected_pcm_sha256 {
        return Err(NativeCandidateQualitySampleError::AssetMismatch);
    }
    let sample_count = u64::try_from(pcm.len() / 2)
        .map_err(|_| NativeCandidateQualitySampleError::InvalidInput)?;
    let pcm_bytes = sample_count
        .checked_mul(PCM_BYTES_PER_SAMPLE)
        .ok_or(NativeCandidateQualitySampleError::InvalidInput)?;
    let audio_duration_ns = sample_count
        .checked_mul(NANOS_PER_SAMPLE)
        .ok_or(NativeCandidateQualitySampleError::InvalidInput)?;
    let samples = pcm
        .chunks_exact(2)
        .map(|pair| i16::from_le_bytes([pair[0], pair[1]]))
        .collect();
    Ok(VerifiedQualityWav {
        samples,
        pcm_bytes,
        sample_count,
        audio_duration_ns,
    })
}

fn parse_mono_pcm16_wav(bytes: &[u8]) -> Result<&[u8], NativeCandidateQualitySampleError> {
    if bytes.len() < MIN_WAV_BYTES as usize
        || &bytes[0..4] != b"RIFF"
        || &bytes[8..12] != b"WAVE"
        || usize::try_from(read_u32(bytes, 4)?)
            .ok()
            .and_then(|size| size.checked_add(8))
            != Some(bytes.len())
    {
        return Err(NativeCandidateQualitySampleError::AssetMismatch);
    }
    let mut offset = 12_usize;
    let mut format = None;
    let mut data = None;
    while offset < bytes.len() {
        let header_end = offset
            .checked_add(8)
            .ok_or(NativeCandidateQualitySampleError::AssetMismatch)?;
        if header_end > bytes.len() {
            return Err(NativeCandidateQualitySampleError::AssetMismatch);
        }
        let size = usize::try_from(read_u32(bytes, offset + 4)?)
            .map_err(|_| NativeCandidateQualitySampleError::AssetMismatch)?;
        let end = header_end
            .checked_add(size)
            .ok_or(NativeCandidateQualitySampleError::AssetMismatch)?;
        let padded_end = end
            .checked_add(size & 1)
            .ok_or(NativeCandidateQualitySampleError::AssetMismatch)?;
        if padded_end > bytes.len() {
            return Err(NativeCandidateQualitySampleError::AssetMismatch);
        }
        match &bytes[offset..offset + 4] {
            b"fmt " if format.is_none() && size >= 16 => {
                format = Some((
                    read_u16(bytes, header_end)?,
                    read_u16(bytes, header_end + 2)?,
                    read_u32(bytes, header_end + 4)?,
                    read_u32(bytes, header_end + 8)?,
                    read_u16(bytes, header_end + 12)?,
                    read_u16(bytes, header_end + 14)?,
                ));
            }
            b"data" if data.is_none() => data = Some(&bytes[header_end..end]),
            b"fmt " | b"data" => {
                return Err(NativeCandidateQualitySampleError::AssetMismatch);
            }
            _ => {}
        }
        offset = padded_end;
    }
    if format != Some((1, CHANNELS, SAMPLE_RATE_HZ, 32_000, 2, 16)) {
        return Err(NativeCandidateQualitySampleError::AssetMismatch);
    }
    let pcm = data.ok_or(NativeCandidateQualitySampleError::AssetMismatch)?;
    if pcm.is_empty() || pcm.len() % 2 != 0 {
        return Err(NativeCandidateQualitySampleError::AssetMismatch);
    }
    Ok(pcm)
}

fn read_u16(bytes: &[u8], offset: usize) -> Result<u16, NativeCandidateQualitySampleError> {
    let value = bytes
        .get(offset..offset.saturating_add(2))
        .filter(|value| value.len() == 2)
        .ok_or(NativeCandidateQualitySampleError::AssetMismatch)?;
    Ok(u16::from_le_bytes([value[0], value[1]]))
}

fn read_u32(bytes: &[u8], offset: usize) -> Result<u32, NativeCandidateQualitySampleError> {
    let value = bytes
        .get(offset..offset.saturating_add(4))
        .filter(|value| value.len() == 4)
        .ok_or(NativeCandidateQualitySampleError::AssetMismatch)?;
    Ok(u32::from_le_bytes([value[0], value[1], value[2], value[3]]))
}

fn canonical_sample_identity_sha256(sample: &NativeCandidateQualitySampleIdentity) -> Sha256Digest {
    let material = format!(
        concat!(
            "{{\"language\":\"{}\",\"pcm_sha256\":\"{}\",",
            "\"reference_sha256\":\"{}\",",
            "\"sample_id\":\"{}\",\"wav_sha256\":\"{}\",",
            "\"wav_size_bytes\":{}}}"
        ),
        sample.language.as_str(),
        sample.expected_pcm_sha256.to_lower_hex(),
        sample.reference_sha256.to_lower_hex(),
        sample.sample_id.as_str(),
        sample.expected_wav_sha256.to_lower_hex(),
        sample.expected_wav_size_bytes,
    );
    Sha256Digest::from_bytes(Sha256::digest(material.as_bytes()).into())
}

fn encode_record(
    sample: &NativeCandidateQualitySampleIdentity,
    manifest: &WorkerManifest,
    wav: &VerifiedQualityWav,
    parameter_sha256: Sha256Digest,
    measurement: QualityMeasurement,
) -> Result<Vec<u8>, NativeCandidateQualitySampleError> {
    let transcript = measurement.transcript.validate()?;
    let mut output = String::with_capacity(2_048 + transcript.len());
    output.push_str("{\"authority\":{\"formal_claims\":\"none\",\"production_evidence\":false},");
    write!(
        &mut output,
        concat!(
            "\"candidate\":{{\"asset_lock_sha256\":\"{}\",",
            "\"candidate_id\":\"{}\",\"model_sha256\":\"{}\",",
            "\"package_lock_sha256\":\"{}\",",
            "\"parameter_sha256\":\"{}\",\"runtime_bundle_sha256\":\"{}\",",
            "\"tokens_sha256\":\"{}\"}},"
        ),
        LOCKED_ASSET_LOCK_SHA256_HEX,
        LOCKED_CANDIDATE_ID,
        LOCKED_MODEL_SHA256_HEX,
        LOCKED_PACKAGE_LOCK_SHA256_HEX,
        parameter_sha256.to_lower_hex(),
        LOCKED_RUNTIME_BUNDLE_SHA256_HEX,
        LOCKED_TOKENS_SHA256_HEX,
    )
    .map_err(|_| NativeCandidateQualitySampleError::Observation)?;
    write!(
        &mut output,
        concat!(
            "\"execution\":{{\"backend_execute_calls\":1,\"execute_elapsed_ns\":\"{}\",",
            "\"final_transcript\":"
        ),
        measurement.execute_elapsed_ns,
    )
    .map_err(|_| NativeCandidateQualitySampleError::Observation)?;
    write_canonical_json_string(&mut output, transcript)?;
    write!(
        &mut output,
        concat!(
            ",\"final_transcript_sha256\":\"{}\",\"final_transcript_utf8_bytes\":\"{}\",",
            "\"fresh_process_per_sample\":true,\"prepare_elapsed_ns\":\"{}\"}},",
            "\"host\":{{\"executable_sha256\":\"{}\",",
            "\"schema_registry_sha256\":\"{}\"}},",
            "\"kind\":\"meetingrelay-native-candidate-quality-sample-v1\",",
            "\"resources\":{{\"cpu_time_ns\":null,\"gpu_time_ns\":null,",
            "\"peak_ram_bytes\":null,\"peak_vram_bytes\":null,",
            "\"reason\":\"{}\",\"status\":\"unavailable\"}},",
            "\"rtf\":{{\"denominator_audio_ns\":\"{}\",\"numerator_execute_ns\":\"{}\"}},"
        ),
        measurement.transcript.sha256.to_lower_hex(),
        measurement.transcript.utf8_bytes,
        measurement.prepare_elapsed_ns,
        manifest.executable_sha256.to_lower_hex(),
        manifest.schema_registry_sha256.to_lower_hex(),
        RESOURCE_UNAVAILABLE_REASON,
        wav.audio_duration_ns,
        measurement.execute_elapsed_ns,
    )
    .map_err(|_| NativeCandidateQualitySampleError::Observation)?;
    write!(
        &mut output,
        concat!(
            "\"sample\":{{\"channels\":{},\"language\":\"{}\",\"pcm_bytes\":\"{}\",",
            "\"pcm_sample_count\":\"{}\",\"pcm_sha256\":\"{}\",",
            "\"reference_sha256\":\"{}\",",
            "\"sample_id\":\"{}\",\"sample_identity_sha256\":\"{}\",",
            "\"sample_rate_hz\":{},\"wav_sha256\":\"{}\",\"wav_size_bytes\":\"{}\"}},",
            "\"schema_version\":\"1.0\"}}\n"
        ),
        CHANNELS,
        sample.language.as_str(),
        wav.pcm_bytes,
        wav.sample_count,
        sample.expected_pcm_sha256.to_lower_hex(),
        sample.reference_sha256.to_lower_hex(),
        sample.sample_id.as_str(),
        canonical_sample_identity_sha256(sample).to_lower_hex(),
        SAMPLE_RATE_HZ,
        sample.expected_wav_sha256.to_lower_hex(),
        sample.expected_wav_size_bytes,
    )
    .map_err(|_| NativeCandidateQualitySampleError::Observation)?;
    if output.len() > MAX_RECORD_BYTES {
        return Err(NativeCandidateQualitySampleError::Observation);
    }
    Ok(output.into_bytes())
}

fn write_canonical_json_string(
    output: &mut String,
    value: &str,
) -> Result<(), NativeCandidateQualitySampleError> {
    output.push('"');
    for character in value.chars() {
        match character {
            '"' => output.push_str("\\\""),
            '\\' => output.push_str("\\\\"),
            '\u{08}' => output.push_str("\\b"),
            '\t' => output.push_str("\\t"),
            '\n' => output.push_str("\\n"),
            '\u{0c}' => output.push_str("\\f"),
            '\r' => output.push_str("\\r"),
            '\u{00}'..='\u{1f}' => write!(output, "\\u{:04x}", u32::from(character))
                .map_err(|_| NativeCandidateQualitySampleError::Observation)?,
            _ => output.push(character),
        }
    }
    output.push('"');
    Ok(())
}

fn locked_digest(value: &str) -> Result<Sha256Digest, NativeCandidateQualitySampleError> {
    Sha256Digest::from_lower_hex(value)
        .map_err(|_| NativeCandidateQualitySampleError::Configuration)
}

fn current_regular_executable() -> Result<PathBuf, NativeCandidateQualitySampleError> {
    let executable =
        std::env::current_exe().map_err(|_| NativeCandidateQualitySampleError::Provenance)?;
    reject_reparse_ancestors(&executable)?;
    let metadata = fs::symlink_metadata(&executable)
        .map_err(|_| NativeCandidateQualitySampleError::Provenance)?;
    if !is_regular_non_reparse_file(&metadata) {
        return Err(NativeCandidateQualitySampleError::Provenance);
    }
    Ok(executable)
}

fn validate_regular_non_reparse_file(path: &Path) -> Result<(), NativeCandidateQualitySampleError> {
    reject_reparse_ancestors(path)?;
    let metadata = fs::symlink_metadata(path)
        .map_err(|_| NativeCandidateQualitySampleError::AssetUnavailable)?;
    if !is_regular_non_reparse_file(&metadata) {
        return Err(NativeCandidateQualitySampleError::AssetMismatch);
    }
    Ok(())
}

fn reject_reparse_ancestors(path: &Path) -> Result<(), NativeCandidateQualitySampleError> {
    for component in path.ancestors() {
        let metadata = fs::symlink_metadata(component)
            .map_err(|_| NativeCandidateQualitySampleError::AssetUnavailable)?;
        if metadata.file_type().is_symlink() || is_windows_reparse_point(&metadata) {
            return Err(NativeCandidateQualitySampleError::AssetMismatch);
        }
    }
    Ok(())
}

fn is_regular_non_reparse_file(metadata: &fs::Metadata) -> bool {
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        return false;
    }
    #[cfg(windows)]
    {
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return false;
        }
    }
    true
}

#[cfg(windows)]
fn is_windows_reparse_point(metadata: &fs::Metadata) -> bool {
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
const fn is_windows_reparse_point(_metadata: &fs::Metadata) -> bool {
    false
}

#[cfg(windows)]
fn same_file_identity(left: &fs::Metadata, right: &fs::Metadata) -> bool {
    // Stable std does not expose Windows file IDs. The opened handle denies
    // write/delete sharing, so this immutable metadata join plus the raw-byte
    // digest binds the path snapshot until the verified PCM is in memory.
    left.file_attributes() == right.file_attributes()
        && left.creation_time() == right.creation_time()
        && left.last_write_time() == right.last_write_time()
        && left.file_size() == right.file_size()
}

#[cfg(unix)]
fn same_file_identity(left: &fs::Metadata, right: &fs::Metadata) -> bool {
    left.dev() == right.dev() && left.ino() == right.ino()
}

#[cfg(not(any(windows, unix)))]
fn same_file_identity(_left: &fs::Metadata, _right: &fs::Metadata) -> bool {
    false
}

#[cfg(windows)]
fn open_sealed_read(path: &Path) -> std::io::Result<File> {
    const FILE_SHARE_READ: u32 = 0x0000_0001;
    OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ)
        .open(path)
}

#[cfg(not(windows))]
fn open_sealed_read(path: &Path) -> std::io::Result<File> {
    OpenOptions::new().read(true).open(path)
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    use meetingrelay_model_worker_contract::{Identifier, LanguageCode, Sha256Digest};
    use sha2::{Digest, Sha256};

    use super::*;
    use crate::LOCKED_SCHEMA_REGISTRY_BYTES;

    const REFERENCE_SHA256: &str =
        "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    const A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const C: &str = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    const D: &str = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
    const E: &str = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    const F: &str = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

    #[test]
    fn valid_sample_prepares_once_executes_once_and_emits_private_transcript_record() {
        let fixture = Fixture::new("valid");
        let prepare_calls = Arc::new(AtomicUsize::new(0));
        let execute_calls = Arc::new(AtomicUsize::new(0));
        let runtime_identity_calls = Arc::new(AtomicUsize::new(0));
        let backend_prepare_calls = Arc::clone(&prepare_calls);
        let backend_execute_calls = Arc::clone(&execute_calls);
        let backend_runtime_identity_calls = Arc::clone(&runtime_identity_calls);

        let record = run_quality_sample_with_backend_factory(fixture.input(), move |_| {
            Ok(Box::new(FakeBackend {
                prepare_calls: backend_prepare_calls,
                execute_calls: backend_execute_calls,
                runtime_identity_calls: backend_runtime_identity_calls,
            }))
        })
        .expect("quality sample succeeds");

        assert_eq!(prepare_calls.load(Ordering::Relaxed), 1);
        assert_eq!(execute_calls.load(Ordering::Relaxed), 1);
        assert_eq!(runtime_identity_calls.load(Ordering::Relaxed), 2);
        let json = String::from_utf8(record).expect("record is UTF-8");
        assert!(json.ends_with('\n'));
        assert_eq!(json.matches('\n').count(), 1);
        assert!(json.contains("\"backend_execute_calls\":1"));
        assert!(json.contains("\"fresh_process_per_sample\":true"));
        assert!(json.contains("\"denominator_audio_ns\":\"250000\""));
        assert!(json.contains("\"reference_sha256\":\"eeeeeeee"));
        assert!(json.contains("\"cpu_time_ns\":null"));
        assert!(json.contains("\"reason\":\"SHERPA_QUALITY_RESOURCE_SAMPLING_UNAVAILABLE\""));
        assert!(json.contains("\"final_transcript\":\"fixture transcript must remain secret\""));
        for forbidden in [
            fixture.root.to_string_lossy().as_ref(),
            "\"path\"",
            "\"transcript\"",
        ] {
            assert!(!json.contains(forbidden), "record leaked {forbidden}");
        }
    }

    #[test]
    fn runtime_identity_must_close_after_prepare_and_after_execute() {
        for (fail_on_check, expected_execute_calls) in [(1, 0), (2, 1)] {
            let fixture = Fixture::new(&format!("runtime-identity-{fail_on_check}"));
            let prepare_calls = Arc::new(AtomicUsize::new(0));
            let execute_calls = Arc::new(AtomicUsize::new(0));
            let identity_calls = Arc::new(AtomicUsize::new(0));
            let backend_prepare_calls = Arc::clone(&prepare_calls);
            let backend_execute_calls = Arc::clone(&execute_calls);
            let backend_identity_calls = Arc::clone(&identity_calls);

            let result = run_quality_sample_with_backend_factory(fixture.input(), move |_| {
                Ok(Box::new(RuntimeIdentityFailingBackend {
                    execute_calls: backend_execute_calls,
                    fail_on_check,
                    identity_calls: backend_identity_calls,
                    prepare_calls: backend_prepare_calls,
                }))
            });

            assert_eq!(result, Err(NativeCandidateQualitySampleError::Provenance));
            assert_eq!(prepare_calls.load(Ordering::Relaxed), 1);
            assert_eq!(
                execute_calls.load(Ordering::Relaxed),
                expected_execute_calls
            );
            assert_eq!(identity_calls.load(Ordering::Relaxed), fail_on_check);
        }
    }

    #[test]
    fn mutated_wav_fails_before_backend_construction_or_execution() {
        let fixture = Fixture::new("mutated");
        let input = fixture.input();
        let mut bytes = fs::read(&fixture.wav_path).expect("read WAV");
        let last = bytes.last_mut().expect("nonempty WAV");
        *last ^= 0x01;
        fs::write(&fixture.wav_path, bytes).expect("mutate WAV");
        let factory_calls = Arc::new(AtomicUsize::new(0));
        let observed_factory_calls = Arc::clone(&factory_calls);

        let result = run_quality_sample_with_backend_factory(input, move |_| {
            observed_factory_calls.fetch_add(1, Ordering::Relaxed);
            Ok(Box::new(FakeBackend::default()))
        });

        assert_eq!(
            result,
            Err(NativeCandidateQualitySampleError::AssetMismatch)
        );
        assert_eq!(factory_calls.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn pcm_digest_mismatch_fails_before_backend_construction_or_execution() {
        let fixture = Fixture::new("pcm-mismatch");
        let mut input = fixture.input();
        input.sample.expected_pcm_sha256 = digest(REFERENCE_SHA256);
        let factory_calls = Arc::new(AtomicUsize::new(0));
        let observed_factory_calls = Arc::clone(&factory_calls);

        let result = run_quality_sample_with_backend_factory(input, move |_| {
            observed_factory_calls.fetch_add(1, Ordering::Relaxed);
            Ok(Box::new(FakeBackend::default()))
        });

        assert_eq!(
            result,
            Err(NativeCandidateQualitySampleError::AssetMismatch)
        );
        assert_eq!(factory_calls.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn canonical_sample_identity_hash_is_stable() {
        let fixture = Fixture::new("identity");
        let verified = read_verified_quality_wav(&fixture.input()).expect("verify WAV");
        assert_eq!(
            canonical_sample_identity_sha256(&fixture.input().sample).to_lower_hex(),
            "ffa033c744806ea061aa418705b97ee06afa332e22bacd98bc1f1243c4f182f3"
        );
        assert_eq!(verified.sample_count, 4);
        assert_eq!(verified.pcm_bytes, 8);
        assert_eq!(verified.audio_duration_ns, 250_000);
    }

    #[test]
    fn every_quality_language_uses_the_locked_parameter_digest() {
        for language in ["en", "ja", "zh"] {
            let fixture = Fixture::new(language);
            let mut input = fixture.input();
            input.sample.language = LanguageCode::new(language).expect("supported language");
            let record = run_quality_sample_with_backend_factory(input, move |config| {
                assert_eq!(config.normalized_language.as_str(), language);
                assert_eq!(
                    config.parameter_sha256().to_lower_hex(),
                    match language {
                        "en" => "f411caf1efd92b18b953c3bfd0bf6a4eb49d18068554ce9e70d8a493d325065d",
                        "ja" => "946af178a84c720f928d08ed084fe37625a57447b2ad8e8dc5d36034ea319bf5",
                        "zh" => "0ac8669e387262648fcf05fd301a9ba798bb2822e56ec952f1e17d6c692f802e",
                        _ => unreachable!(),
                    }
                );
                Ok(Box::new(FakeBackend::default()))
            })
            .expect("supported quality language succeeds");
            let json = String::from_utf8(record).expect("record is UTF-8");
            assert!(json.contains(&format!("\"language\":\"{language}\"")));
        }
    }

    #[test]
    fn unsupported_language_fails_before_backend_construction() {
        let fixture = Fixture::new("unsupported-language");
        let mut input = fixture.input();
        input.sample.language = LanguageCode::new("fr").expect("structurally valid language");
        let factory_calls = Arc::new(AtomicUsize::new(0));
        let observed_factory_calls = Arc::clone(&factory_calls);

        let result = run_quality_sample_with_backend_factory(input, move |_| {
            observed_factory_calls.fetch_add(1, Ordering::Relaxed);
            Ok(Box::new(FakeBackend::default()))
        });

        assert_eq!(result, Err(NativeCandidateQualitySampleError::InvalidInput));
        assert_eq!(factory_calls.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn empty_hypothesis_is_recorded_as_a_valid_zero_byte_observation() {
        let fixture = Fixture::new("empty-hypothesis");
        let record = run_quality_sample_with_backend_factory(fixture.input(), |_| {
            Ok(Box::new(EmptyBackend))
        })
        .expect("empty hypothesis remains a valid measurement");
        let json = String::from_utf8(record).expect("record is UTF-8");
        assert!(json.contains("\"final_transcript\":\"\""));
        assert!(json.contains(
            "\"final_transcript_sha256\":\"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\""
        ));
        assert!(json.contains("\"final_transcript_utf8_bytes\":\"0\""));
    }

    #[test]
    fn cjk_and_escaped_characters_are_preserved_in_canonical_json() {
        let fixture = Fixture::new("cjk-escaped");
        let transcript = "日本語 中文 \"quoted\" \\path\nnext\t\u{01}".to_owned();
        let expected_sha256 =
            Sha256Digest::from_bytes(Sha256::digest(transcript.as_bytes()).into());
        let expected_utf8_bytes = transcript.len();
        let record =
            run_with_transcript(&fixture, QualityTranscriptIdentity::from_text(transcript))
                .expect("valid multilingual transcript succeeds");
        let json = String::from_utf8(record).expect("record is UTF-8");

        assert!(json.contains(
            "\"final_transcript\":\"日本語 中文 \\\"quoted\\\" \\\\path\\nnext\\t\\u0001\""
        ));
        assert!(json.contains(&format!(
            "\"final_transcript_sha256\":\"{}\"",
            expected_sha256.to_lower_hex()
        )));
        assert!(json.contains(&format!(
            "\"final_transcript_utf8_bytes\":\"{expected_utf8_bytes}\""
        )));
        assert_eq!(json.matches('\n').count(), 1);
    }

    #[test]
    fn transcript_at_exact_utf8_limit_is_accepted() {
        let fixture = Fixture::new("transcript-exact-limit");
        let transcript = "a".repeat(MAX_TRANSCRIPT_UTF8_BYTES);
        let record =
            run_with_transcript(&fixture, QualityTranscriptIdentity::from_text(transcript))
                .expect("exact 16 KiB transcript succeeds");
        let json = String::from_utf8(record).expect("record is UTF-8");

        assert!(json.contains("\"final_transcript_utf8_bytes\":\"16384\""));
        assert!(json.len() > MAX_TRANSCRIPT_UTF8_BYTES);
    }

    #[test]
    fn nul_and_over_limit_transcripts_fail_with_text_free_error() {
        for (label, transcript) in [
            ("transcript-nul", "secret\0sentinel".to_owned()),
            (
                "transcript-over-limit",
                "s".repeat(MAX_TRANSCRIPT_UTF8_BYTES + 1),
            ),
        ] {
            let fixture = Fixture::new(label);
            let error =
                run_with_transcript(&fixture, QualityTranscriptIdentity::from_text(transcript))
                    .expect_err("invalid transcript must not emit a record");

            assert_eq!(error, NativeCandidateQualitySampleError::Observation);
            assert_eq!(error.to_string(), "SHERPA_QUALITY_OBSERVATION");
            assert!(!error.to_string().contains("secret"));
            assert!(!format!("{error:?}").contains("secret"));
        }
    }

    #[test]
    fn transcript_digest_and_count_must_match_original_bytes() {
        let count_fixture = Fixture::new("transcript-count-mismatch");
        let mut count_mismatch = QualityTranscriptIdentity::from_text("count sentinel".to_owned());
        count_mismatch.utf8_bytes += 1;
        let count_error = run_with_transcript(&count_fixture, count_mismatch)
            .expect_err("count mismatch must not emit a record");

        let digest_fixture = Fixture::new("transcript-digest-mismatch");
        let mut digest_mismatch =
            QualityTranscriptIdentity::from_text("digest sentinel".to_owned());
        digest_mismatch.sha256 = digest(F);
        let digest_error = run_with_transcript(&digest_fixture, digest_mismatch)
            .expect_err("digest mismatch must not emit a record");

        for error in [count_error, digest_error] {
            assert_eq!(error, NativeCandidateQualitySampleError::Observation);
            assert_eq!(error.to_string(), "SHERPA_QUALITY_OBSERVATION");
            assert!(!error.to_string().contains("sentinel"));
        }
    }

    #[test]
    fn canonical_record_has_exact_order_and_decimal_string_boundaries() {
        let sample = NativeCandidateQualitySampleIdentity {
            sample_id: Identifier::new("quality-record-001").expect("valid sample id"),
            language: LanguageCode::new("ja").expect("valid language"),
            expected_wav_size_bytes: 44,
            expected_wav_sha256: digest(A),
            expected_pcm_sha256: digest(B),
            reference_sha256: digest(C),
        };
        let manifest = locked_worker_manifest(digest(D), digest(E)).expect("valid manifest");
        let record = encode_record(
            &sample,
            &manifest,
            &VerifiedQualityWav {
                samples: vec![1, 2, 3, 4],
                pcm_bytes: 8,
                sample_count: 4,
                audio_duration_ns: 250_000,
            },
            digest("946af178a84c720f928d08ed084fe37625a57447b2ad8e8dc5d36034ea319bf5"),
            QualityMeasurement {
                execute_elapsed_ns: 13,
                prepare_elapsed_ns: 11,
                transcript: QualityTranscriptIdentity::from_text("fixture".to_owned()),
            },
        )
        .expect("encode canonical record");

        assert_eq!(
            String::from_utf8(record).expect("record is UTF-8"),
            concat!(
                "{\"authority\":{\"formal_claims\":\"none\",\"production_evidence\":false},",
                "\"candidate\":{\"asset_lock_sha256\":\"e22adeea2dde27cab1c40fa116b665ef111b7c1b8cf24f7b7a1900a23e263181\",",
                "\"candidate_id\":\"sherpa-native-sensevoice-int8-2024-07-17-win-x64-cpu\",",
                "\"model_sha256\":\"c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51\",",
                "\"package_lock_sha256\":\"02efd2bae11eb162ed59526ac3ddadd73b8537ac4c98423b38cf3eed1208989d\",",
                "\"parameter_sha256\":\"946af178a84c720f928d08ed084fe37625a57447b2ad8e8dc5d36034ea319bf5\",",
                "\"runtime_bundle_sha256\":\"0682618f660a2a9f2278d99decb77624253aadde60e8199a9b07813b8d843317\",",
                "\"tokens_sha256\":\"f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc\"},",
                "\"execution\":{\"backend_execute_calls\":1,\"execute_elapsed_ns\":\"13\",",
                "\"final_transcript\":\"fixture\",",
                "\"final_transcript_sha256\":\"f16d05ec6b29248d2c61adb1e9263f78e4f7bace1b955014a2d17872cfe4064d\",",
                "\"final_transcript_utf8_bytes\":\"7\",\"fresh_process_per_sample\":true,",
                "\"prepare_elapsed_ns\":\"11\"},",
                "\"host\":{\"executable_sha256\":\"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd\",",
                "\"schema_registry_sha256\":\"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee\"},",
                "\"kind\":\"meetingrelay-native-candidate-quality-sample-v1\",",
                "\"resources\":{\"cpu_time_ns\":null,\"gpu_time_ns\":null,",
                "\"peak_ram_bytes\":null,\"peak_vram_bytes\":null,",
                "\"reason\":\"SHERPA_QUALITY_RESOURCE_SAMPLING_UNAVAILABLE\",\"status\":\"unavailable\"},",
                "\"rtf\":{\"denominator_audio_ns\":\"250000\",\"numerator_execute_ns\":\"13\"},",
                "\"sample\":{\"channels\":1,\"language\":\"ja\",\"pcm_bytes\":\"8\",",
                "\"pcm_sample_count\":\"4\",\"pcm_sha256\":\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\",",
                "\"reference_sha256\":\"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc\",",
                "\"sample_id\":\"quality-record-001\",",
                "\"sample_identity_sha256\":\"ba5d1a49debb42b77c6244738c02198f6260915a9833cebe7d78cc5c68237f3b\",",
                "\"sample_rate_hz\":16000,",
                "\"wav_sha256\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",",
                "\"wav_size_bytes\":\"44\"},\"schema_version\":\"1.0\"}\n"
            )
        );
    }

    #[test]
    fn reparse_or_symlinked_wav_ancestor_is_rejected() {
        let fixture = Fixture::new("reparse-ancestor");
        let real = fixture.root.join("real");
        let linked = fixture.root.join("linked");
        fs::create_dir(&real).expect("create real fixture directory");
        fs::copy(&fixture.wav_path, real.join("sample.wav")).expect("copy WAV under real path");
        create_directory_link(&real, &linked);
        let mut input = fixture.input();
        input.wav_path = linked.join("sample.wav");

        assert_eq!(
            read_verified_quality_wav(&input).map(|_| ()),
            Err(NativeCandidateQualitySampleError::AssetMismatch)
        );
        fs::remove_dir(&linked).expect("remove directory symlink");
    }

    #[derive(Default)]
    struct FakeBackend {
        prepare_calls: Arc<AtomicUsize>,
        execute_calls: Arc<AtomicUsize>,
        runtime_identity_calls: Arc<AtomicUsize>,
    }

    impl CandidateQualityBackend for FakeBackend {
        fn prepare(&mut self) -> Result<(), NativeCandidateQualitySampleError> {
            self.prepare_calls.fetch_add(1, Ordering::Relaxed);
            Ok(())
        }

        fn validate_runtime_identity(&self) -> Result<(), NativeCandidateQualitySampleError> {
            self.runtime_identity_calls.fetch_add(1, Ordering::Relaxed);
            Ok(())
        }

        fn execute(
            &mut self,
            _samples: &[i16],
            _pcm_sha256: Sha256Digest,
        ) -> Result<QualityTranscriptIdentity, NativeCandidateQualitySampleError> {
            self.execute_calls.fetch_add(1, Ordering::Relaxed);
            Ok(QualityTranscriptIdentity::from_text(
                "fixture transcript must remain secret".to_owned(),
            ))
        }
    }

    struct TranscriptBackend {
        transcript: Option<QualityTranscriptIdentity>,
    }

    impl CandidateQualityBackend for TranscriptBackend {
        fn prepare(&mut self) -> Result<(), NativeCandidateQualitySampleError> {
            Ok(())
        }

        fn validate_runtime_identity(&self) -> Result<(), NativeCandidateQualitySampleError> {
            Ok(())
        }

        fn execute(
            &mut self,
            _samples: &[i16],
            _pcm_sha256: Sha256Digest,
        ) -> Result<QualityTranscriptIdentity, NativeCandidateQualitySampleError> {
            self.transcript
                .take()
                .ok_or(NativeCandidateQualitySampleError::Execution)
        }
    }

    struct EmptyBackend;

    impl CandidateQualityBackend for EmptyBackend {
        fn prepare(&mut self) -> Result<(), NativeCandidateQualitySampleError> {
            Ok(())
        }

        fn validate_runtime_identity(&self) -> Result<(), NativeCandidateQualitySampleError> {
            Ok(())
        }

        fn execute(
            &mut self,
            _samples: &[i16],
            _pcm_sha256: Sha256Digest,
        ) -> Result<QualityTranscriptIdentity, NativeCandidateQualitySampleError> {
            Ok(QualityTranscriptIdentity::from_text(String::new()))
        }
    }

    struct RuntimeIdentityFailingBackend {
        execute_calls: Arc<AtomicUsize>,
        fail_on_check: usize,
        identity_calls: Arc<AtomicUsize>,
        prepare_calls: Arc<AtomicUsize>,
    }

    impl CandidateQualityBackend for RuntimeIdentityFailingBackend {
        fn prepare(&mut self) -> Result<(), NativeCandidateQualitySampleError> {
            self.prepare_calls.fetch_add(1, Ordering::Relaxed);
            Ok(())
        }

        fn validate_runtime_identity(&self) -> Result<(), NativeCandidateQualitySampleError> {
            let call = self.identity_calls.fetch_add(1, Ordering::Relaxed) + 1;
            if call == self.fail_on_check {
                Err(NativeCandidateQualitySampleError::Provenance)
            } else {
                Ok(())
            }
        }

        fn execute(
            &mut self,
            _samples: &[i16],
            _pcm_sha256: Sha256Digest,
        ) -> Result<QualityTranscriptIdentity, NativeCandidateQualitySampleError> {
            self.execute_calls.fetch_add(1, Ordering::Relaxed);
            Ok(QualityTranscriptIdentity::from_text(
                "must not produce an evidence record after runtime drift".to_owned(),
            ))
        }
    }

    struct Fixture {
        root: PathBuf,
        executable_path: PathBuf,
        schema_registry_path: PathBuf,
        wav_path: PathBuf,
        wav_sha256: Sha256Digest,
        pcm_sha256: Sha256Digest,
        wav_size_bytes: u64,
    }

    impl Fixture {
        fn new(label: &str) -> Self {
            let root = unique_test_directory(label);
            fs::create_dir_all(&root).expect("create fixture directory");
            let executable_path = root.join("quality-host.exe");
            let schema_registry_path = root.join("schema-registry.json");
            let wav_path = root.join("sample.wav");
            fs::write(&executable_path, b"fixture executable").expect("write executable");
            fs::write(&schema_registry_path, LOCKED_SCHEMA_REGISTRY_BYTES)
                .expect("write schema registry");
            let pcm = [1_i16, -2, 3, -4];
            let wav = mono_pcm16_wav(&pcm);
            fs::write(&wav_path, &wav).expect("write WAV");
            let pcm_bytes: Vec<_> = pcm.iter().flat_map(|sample| sample.to_le_bytes()).collect();
            Self {
                root,
                executable_path,
                schema_registry_path,
                wav_path,
                wav_sha256: Sha256Digest::from_bytes(Sha256::digest(&wav).into()),
                pcm_sha256: Sha256Digest::from_bytes(Sha256::digest(&pcm_bytes).into()),
                wav_size_bytes: u64::try_from(wav.len()).expect("WAV length fits u64"),
            }
        }

        fn input(&self) -> ResolvedNativeCandidateQualitySampleInput {
            ResolvedNativeCandidateQualitySampleInput {
                executable_path: self.executable_path.clone(),
                schema_registry_path: self.schema_registry_path.clone(),
                model_path: self.root.join("model.int8.onnx"),
                tokens_path: self.root.join("tokens.txt"),
                runtime_lib_dir: self.root.join("runtime"),
                asset_lock_path: self.root.join("assets.lock.json"),
                package_lock_path: self.root.join("Cargo.lock"),
                wav_path: self.wav_path.clone(),
                sample: NativeCandidateQualitySampleIdentity {
                    sample_id: Identifier::new("quality-fixture-001").expect("valid sample id"),
                    language: LanguageCode::new("zh").expect("valid fixture language"),
                    expected_wav_size_bytes: self.wav_size_bytes,
                    expected_wav_sha256: self.wav_sha256,
                    expected_pcm_sha256: self.pcm_sha256,
                    reference_sha256: digest(REFERENCE_SHA256),
                },
            }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn mono_pcm16_wav(samples: &[i16]) -> Vec<u8> {
        let data_size = u32::try_from(samples.len() * 2).expect("small fixture");
        let mut bytes = Vec::with_capacity(44 + samples.len() * 2);
        bytes.extend_from_slice(b"RIFF");
        bytes.extend_from_slice(&(36 + data_size).to_le_bytes());
        bytes.extend_from_slice(b"WAVEfmt ");
        bytes.extend_from_slice(&16_u32.to_le_bytes());
        bytes.extend_from_slice(&1_u16.to_le_bytes());
        bytes.extend_from_slice(&1_u16.to_le_bytes());
        bytes.extend_from_slice(&16_000_u32.to_le_bytes());
        bytes.extend_from_slice(&32_000_u32.to_le_bytes());
        bytes.extend_from_slice(&2_u16.to_le_bytes());
        bytes.extend_from_slice(&16_u16.to_le_bytes());
        bytes.extend_from_slice(b"data");
        bytes.extend_from_slice(&data_size.to_le_bytes());
        for sample in samples {
            bytes.extend_from_slice(&sample.to_le_bytes());
        }
        bytes
    }

    fn digest(value: &str) -> Sha256Digest {
        Sha256Digest::from_lower_hex(value).expect("fixture digest is valid")
    }

    fn run_with_transcript(
        fixture: &Fixture,
        transcript: QualityTranscriptIdentity,
    ) -> Result<Vec<u8>, NativeCandidateQualitySampleError> {
        run_quality_sample_with_backend_factory(fixture.input(), |_| {
            Ok(Box::new(TranscriptBackend {
                transcript: Some(transcript),
            }))
        })
    }

    fn unique_test_directory(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock follows Unix epoch")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "meetingrelay-quality-{label}-{}-{nonce}",
            std::process::id()
        ))
    }

    #[cfg(windows)]
    fn create_directory_link(original: &PathBuf, link: &PathBuf) {
        let output = std::process::Command::new("cmd.exe")
            .args(["/d", "/c", "mklink", "/J"])
            .arg(link)
            .arg(original)
            .output()
            .expect("run mklink for quality WAV reparse fixture");
        assert!(output.status.success(), "mklink /J must succeed in CI");
    }

    #[cfg(unix)]
    fn create_directory_link(original: &PathBuf, link: &PathBuf) {
        std::os::unix::fs::symlink(original, link).expect("create quality WAV directory symlink");
    }
}
