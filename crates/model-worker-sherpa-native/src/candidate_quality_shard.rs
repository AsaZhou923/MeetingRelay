use std::fmt::{self, Write as _};
use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::time::Instant;

use meetingrelay_model_worker_contract::{
    AudioChunk, AudioFormat, AudioPayload, AudioSource, Identifier, LanguageCode, ModelBackend,
    SampleFormat, Sha256Digest, SourceRange, WorkerManifest,
};
use sha2::{Digest, Sha256};

use crate::candidate_execution::validate_loaded_runtime_identity;
use crate::candidate_quality_sample::{
    CHANNELS, MAX_TRANSCRIPT_UTF8_BYTES, MAX_WAV_BYTES, MIN_WAV_BYTES,
    NativeCandidateQualitySampleError, NativeCandidateQualitySampleIdentity, PCM_BYTES_PER_SAMPLE,
    ResolvedNativeCandidateQualitySampleInput, SAMPLE_RATE_HZ, VerifiedQualityWav,
    canonical_sample_identity_sha256, current_regular_executable, locked_config,
    read_verified_quality_wav, validate_regular_non_reparse_file, write_canonical_json_string,
};
use crate::{
    LOCKED_ASSET_LOCK_SHA256_HEX, LOCKED_CANDIDATE_ID, LOCKED_MODEL_SHA256_HEX,
    LOCKED_PACKAGE_LOCK_SHA256_HEX, LOCKED_RUNTIME_BUNDLE_SHA256_HEX, LOCKED_TOKENS_SHA256_HEX,
    SherpaNativeBackend, locked_schema_registry_sha256, locked_worker_manifest, sha256_file,
};

const MAX_SHARD_SAMPLES: u64 = 128;
const MAX_STDIN_LINE_BYTES: usize = 8_192;
const MAX_SHARD_TOTAL_PCM_BYTES: u64 = MAX_WAV_BYTES * MAX_SHARD_SAMPLES;
const ZERO_SHA256_HEX: &str = "0000000000000000000000000000000000000000000000000000000000000000";

#[derive(Clone)]
pub struct NativeCandidateQualityShardInput {
    pub schema_registry_path: PathBuf,
    pub model_path: PathBuf,
    pub tokens_path: PathBuf,
    pub runtime_lib_dir: PathBuf,
    pub asset_lock_path: PathBuf,
    pub package_lock_path: PathBuf,
    pub language: LanguageCode,
    pub max_samples: u64,
    pub max_total_pcm_bytes: u64,
}

#[derive(Clone)]
struct ResolvedNativeCandidateQualityShardInput {
    executable_path: PathBuf,
    schema_registry_path: PathBuf,
    model_path: PathBuf,
    tokens_path: PathBuf,
    runtime_lib_dir: PathBuf,
    asset_lock_path: PathBuf,
    package_lock_path: PathBuf,
    language: LanguageCode,
    max_samples: u64,
    max_total_pcm_bytes: u64,
}

impl NativeCandidateQualityShardInput {
    fn resolve(
        self,
    ) -> Result<ResolvedNativeCandidateQualityShardInput, NativeCandidateQualityShardError> {
        Ok(ResolvedNativeCandidateQualityShardInput {
            executable_path: current_regular_executable()?,
            schema_registry_path: self.schema_registry_path,
            model_path: self.model_path,
            tokens_path: self.tokens_path,
            runtime_lib_dir: self.runtime_lib_dir,
            asset_lock_path: self.asset_lock_path,
            package_lock_path: self.package_lock_path,
            language: self.language,
            max_samples: self.max_samples,
            max_total_pcm_bytes: self.max_total_pcm_bytes,
        })
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NativeCandidateQualityShardError {
    Usage,
    InvalidInput,
    AssetUnavailable,
    AssetMismatch,
    Configuration,
    Preparation,
    Execution,
    Observation,
    Provenance,
}

impl NativeCandidateQualityShardError {
    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            Self::Usage => "SHERPA_QUALITY_SHARD_USAGE",
            Self::InvalidInput => "SHERPA_QUALITY_SHARD_INVALID_INPUT",
            Self::AssetUnavailable => "SHERPA_QUALITY_SHARD_ASSET_UNAVAILABLE",
            Self::AssetMismatch => "SHERPA_QUALITY_SHARD_ASSET_MISMATCH",
            Self::Configuration => "SHERPA_QUALITY_SHARD_CONFIGURATION",
            Self::Preparation => "SHERPA_QUALITY_SHARD_PREPARATION",
            Self::Execution => "SHERPA_QUALITY_SHARD_EXECUTION",
            Self::Observation => "SHERPA_QUALITY_SHARD_OBSERVATION",
            Self::Provenance => "SHERPA_QUALITY_SHARD_PROVENANCE",
        }
    }
}

impl fmt::Display for NativeCandidateQualityShardError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code())
    }
}

impl std::error::Error for NativeCandidateQualityShardError {}

impl From<NativeCandidateQualitySampleError> for NativeCandidateQualityShardError {
    fn from(value: NativeCandidateQualitySampleError) -> Self {
        match value {
            NativeCandidateQualitySampleError::InvalidInput
            | NativeCandidateQualitySampleError::FreshProcessRequired => Self::InvalidInput,
            NativeCandidateQualitySampleError::AssetUnavailable => Self::AssetUnavailable,
            NativeCandidateQualitySampleError::AssetMismatch => Self::AssetMismatch,
            NativeCandidateQualitySampleError::Configuration => Self::Configuration,
            NativeCandidateQualitySampleError::Preparation => Self::Preparation,
            NativeCandidateQualitySampleError::Execution => Self::Execution,
            NativeCandidateQualitySampleError::Observation => Self::Observation,
            NativeCandidateQualitySampleError::Provenance => Self::Provenance,
        }
    }
}

pub fn run_locked_native_candidate_quality_shard<R, W>(
    input: NativeCandidateQualityShardInput,
    reader: R,
    writer: W,
) -> Result<(), NativeCandidateQualityShardError>
where
    R: BufRead,
    W: Write,
{
    if cfg!(debug_assertions) {
        return Err(NativeCandidateQualityShardError::Configuration);
    }
    let input = input.resolve()?;
    run_quality_shard_with_backend_factory(input, reader, writer, |config, executable_path| {
        let inner = SherpaNativeBackend::new_quality_sample(config)
            .map_err(|_| NativeCandidateQualityShardError::Configuration)?;
        Ok(Box::new(NativeShardBackend {
            executable_path,
            inner,
        }))
    })
}

trait CandidateQualityShardBackend {
    fn prepare(&mut self) -> Result<(), NativeCandidateQualityShardError>;

    fn validate_runtime_identity(&self) -> Result<(), NativeCandidateQualityShardError>;

    fn execute(
        &mut self,
        samples: &[i16],
        pcm_sha256: Sha256Digest,
    ) -> Result<ShardTranscriptIdentity, NativeCandidateQualityShardError>;
}

struct NativeShardBackend {
    executable_path: PathBuf,
    inner: SherpaNativeBackend,
}

impl CandidateQualityShardBackend for NativeShardBackend {
    fn prepare(&mut self) -> Result<(), NativeCandidateQualityShardError> {
        self.inner
            .prepare()
            .map_err(|_| NativeCandidateQualityShardError::Preparation)
    }

    fn validate_runtime_identity(&self) -> Result<(), NativeCandidateQualityShardError> {
        validate_loaded_runtime_identity(&self.executable_path)
            .map_err(|_| NativeCandidateQualityShardError::Provenance)
    }

    fn execute(
        &mut self,
        samples: &[i16],
        pcm_sha256: Sha256Digest,
    ) -> Result<ShardTranscriptIdentity, NativeCandidateQualityShardError> {
        let chunk = quality_audio_chunk(samples, pcm_sha256)?;
        let text = self
            .inner
            .recognize_quality_sample_text(&[chunk])
            .map_err(|_| NativeCandidateQualityShardError::Execution)?;
        Ok(ShardTranscriptIdentity::from_text(text))
    }
}

fn quality_audio_chunk(
    samples: &[i16],
    pcm_sha256: Sha256Digest,
) -> Result<AudioChunk, NativeCandidateQualityShardError> {
    let sample_count =
        u64::try_from(samples.len()).map_err(|_| NativeCandidateQualityShardError::InvalidInput)?;
    let payload_bytes = sample_count
        .checked_mul(PCM_BYTES_PER_SAMPLE)
        .ok_or(NativeCandidateQualityShardError::InvalidInput)?;
    let capture_epoch_id = Identifier::new("candidate-quality-shard-capture-epoch")
        .map_err(|_| NativeCandidateQualityShardError::Configuration)?;
    Ok(AudioChunk {
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
        payload: Some(AudioPayload::PcmS16Le(samples.into())),
    })
}

fn run_quality_shard_with_backend_factory<R, W, F>(
    input: ResolvedNativeCandidateQualityShardInput,
    mut reader: R,
    mut writer: W,
    backend_factory: F,
) -> Result<(), NativeCandidateQualityShardError>
where
    R: BufRead,
    W: Write,
    F: FnOnce(
        crate::SherpaNativeConfig,
        PathBuf,
    )
        -> Result<Box<dyn CandidateQualityShardBackend>, NativeCandidateQualityShardError>,
{
    validate_shard_input(&input)?;
    validate_regular_non_reparse_file(&input.executable_path)?;
    let executable_sha256 = sha256_file(&input.executable_path)
        .map_err(|_| NativeCandidateQualityShardError::AssetUnavailable)?;
    let schema_registry_sha256 = locked_schema_registry_sha256(&input.schema_registry_path)
        .map_err(|_| NativeCandidateQualityShardError::Provenance)?;
    let manifest = locked_worker_manifest(executable_sha256, schema_registry_sha256)
        .map_err(|_| NativeCandidateQualityShardError::Provenance)?;
    let config = locked_config(&ResolvedNativeCandidateQualitySampleInput {
        executable_path: input.executable_path.clone(),
        schema_registry_path: input.schema_registry_path.clone(),
        model_path: input.model_path.clone(),
        tokens_path: input.tokens_path.clone(),
        runtime_lib_dir: input.runtime_lib_dir.clone(),
        asset_lock_path: input.asset_lock_path.clone(),
        package_lock_path: input.package_lock_path.clone(),
        wav_path: input.executable_path.clone(),
        sample: NativeCandidateQualitySampleIdentity {
            sample_id: Identifier::new("candidate-quality-shard-prepare")
                .map_err(|_| NativeCandidateQualityShardError::Configuration)?,
            language: input.language.clone(),
            expected_wav_size_bytes: MIN_WAV_BYTES,
            expected_wav_sha256: Sha256Digest::from_lower_hex(
                "1111111111111111111111111111111111111111111111111111111111111111",
            )
            .map_err(|_| NativeCandidateQualityShardError::Configuration)?,
            expected_pcm_sha256: Sha256Digest::from_lower_hex(
                "2222222222222222222222222222222222222222222222222222222222222222",
            )
            .map_err(|_| NativeCandidateQualityShardError::Configuration)?,
            reference_sha256: Sha256Digest::from_lower_hex(
                "3333333333333333333333333333333333333333333333333333333333333333",
            )
            .map_err(|_| NativeCandidateQualityShardError::Configuration)?,
        },
    })?;
    let parameter_sha256 = config.descriptor.parameter_sha256;
    let mut backend = backend_factory(config, input.executable_path.clone())?;
    let shard_started = Instant::now();
    let prepare_started_ns = elapsed_ns(shard_started)?;
    let prepare_started = Instant::now();
    backend.prepare()?;
    let prepare_elapsed_ns = nanos(prepare_started)?;
    let prepare_finished_ns = elapsed_ns(shard_started)?;
    backend.validate_runtime_identity()?;

    let mut processed = 0_u64;
    let mut total_pcm_bytes = 0_u64;
    let mut expected_sequence = 1_u64;
    let mut line = String::new();
    loop {
        line.clear();
        let bytes = reader
            .read_line(&mut line)
            .map_err(|_| NativeCandidateQualityShardError::InvalidInput)?;
        if bytes == 0 {
            break;
        }
        if bytes > MAX_STDIN_LINE_BYTES || !line.ends_with('\n') {
            return Err(NativeCandidateQualityShardError::InvalidInput);
        }
        if line.ends_with("\r\n") {
            return Err(NativeCandidateQualityShardError::InvalidInput);
        }
        let raw_line = line.trim_end_matches('\n');
        let request = parse_request(raw_line)?;
        if request.sequence != expected_sequence
            || request.language != input.language
            || processed >= input.max_samples
        {
            write_error_response(
                &mut writer,
                &request,
                NativeCandidateQualityShardError::InvalidInput,
            )?;
            return Err(NativeCandidateQualityShardError::InvalidInput);
        }
        let sample_input = ResolvedNativeCandidateQualitySampleInput {
            executable_path: input.executable_path.clone(),
            schema_registry_path: input.schema_registry_path.clone(),
            model_path: input.model_path.clone(),
            tokens_path: input.tokens_path.clone(),
            runtime_lib_dir: input.runtime_lib_dir.clone(),
            asset_lock_path: input.asset_lock_path.clone(),
            package_lock_path: input.package_lock_path.clone(),
            wav_path: request.wav_path.clone(),
            sample: request.sample.clone(),
        };
        let verified = match read_verified_quality_wav(&sample_input) {
            Ok(verified) => verified,
            Err(error) => {
                let shard_error = NativeCandidateQualityShardError::from(error);
                write_error_response(&mut writer, &request, shard_error)?;
                return Err(shard_error);
            }
        };
        total_pcm_bytes = total_pcm_bytes
            .checked_add(verified.pcm_bytes)
            .ok_or(NativeCandidateQualityShardError::InvalidInput)?;
        if total_pcm_bytes > input.max_total_pcm_bytes {
            write_error_response(
                &mut writer,
                &request,
                NativeCandidateQualityShardError::InvalidInput,
            )?;
            return Err(NativeCandidateQualityShardError::InvalidInput);
        }
        let execute_started_ns = elapsed_ns(shard_started)?;
        let execute_started = Instant::now();
        let transcript =
            match backend.execute(&verified.samples, request.sample.expected_pcm_sha256) {
                Ok(transcript) => transcript,
                Err(error) => {
                    write_error_response(&mut writer, &request, error)?;
                    return Err(error);
                }
            };
        let execute_elapsed_ns = nanos(execute_started)?;
        let execute_finished_ns = elapsed_ns(shard_started)?;
        backend.validate_runtime_identity()?;
        let resource = ResourceObservation::current();
        let response = match encode_response(ShardResponse {
            request: &request,
            manifest: &manifest,
            wav: &verified,
            transcript: &transcript,
            resource: &resource,
            parameter_sha256,
            prepare_elapsed_ns,
            prepare_started_ns,
            prepare_finished_ns,
            execute_elapsed_ns,
            execute_started_ns,
            execute_finished_ns,
            shard_sample_index: processed + 1,
            shard_max_samples: input.max_samples,
            shard_total_pcm_bytes: total_pcm_bytes,
        }) {
            Ok(response) => response,
            Err(error) => {
                write_error_response(&mut writer, &request, error)?;
                return Err(error);
            }
        };
        writer
            .write_all(&response)
            .map_err(|_| NativeCandidateQualityShardError::Observation)?;
        writer
            .flush()
            .map_err(|_| NativeCandidateQualityShardError::Observation)?;
        processed += 1;
        expected_sequence += 1;
    }
    Ok(())
}

fn validate_shard_input(
    input: &ResolvedNativeCandidateQualityShardInput,
) -> Result<(), NativeCandidateQualityShardError> {
    let paths = [
        &input.executable_path,
        &input.schema_registry_path,
        &input.model_path,
        &input.tokens_path,
        &input.runtime_lib_dir,
        &input.asset_lock_path,
        &input.package_lock_path,
    ];
    if paths.iter().any(|path| !path.is_absolute())
        || !matches!(input.language.as_str(), "zh" | "ja" | "en")
        || input.max_samples == 0
        || input.max_samples > MAX_SHARD_SAMPLES
        || input.max_total_pcm_bytes == 0
        || input.max_total_pcm_bytes > MAX_SHARD_TOTAL_PCM_BYTES
    {
        return Err(NativeCandidateQualityShardError::InvalidInput);
    }
    Ok(())
}

#[derive(Clone, Eq, PartialEq)]
enum RequestClassification {
    Sample,
    Canary,
}

impl RequestClassification {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Sample => "sample",
            Self::Canary => "canary",
        }
    }

    const fn scored(&self) -> bool {
        matches!(self, Self::Sample)
    }
}

#[derive(Clone)]
struct ShardRequest {
    sequence: u64,
    sample: NativeCandidateQualitySampleIdentity,
    classification: RequestClassification,
    canary_identity_sha256_hex: String,
    language: LanguageCode,
    wav_path: PathBuf,
}

fn parse_request(value: &str) -> Result<ShardRequest, NativeCandidateQualityShardError> {
    let mut parser = StrictParser::new(value);
    parser.expect("{\"schema_version\":\"1.0\",\"sequence\":")?;
    let sequence = parser.u64()?;
    parser.expect(",\"sample_id\":")?;
    let sample_id = Identifier::new(&parser.string()?)
        .map_err(|_| NativeCandidateQualityShardError::InvalidInput)?;
    parser.expect(",\"classification\":")?;
    let classification = match parser.string()?.as_str() {
        "sample" => RequestClassification::Sample,
        "canary" => RequestClassification::Canary,
        _ => return Err(NativeCandidateQualityShardError::InvalidInput),
    };
    parser.expect(",\"canary_identity_sha256\":")?;
    let canary_identity_sha256_hex = parser.string()?;
    validate_canary_identity(&classification, &canary_identity_sha256_hex)?;
    parser.expect(",\"language\":")?;
    let language_text = parser.string()?;
    if !matches!(language_text.as_str(), "zh" | "ja" | "en") {
        return Err(NativeCandidateQualityShardError::InvalidInput);
    }
    let language = LanguageCode::new(&language_text)
        .map_err(|_| NativeCandidateQualityShardError::InvalidInput)?;
    parser.expect(",\"wav_path\":")?;
    let wav_path = PathBuf::from(parser.string()?);
    parser.expect(",\"wav_size_bytes\":")?;
    let wav_size_bytes = parse_canonical_u64_string(&parser.string()?)?;
    parser.expect(",\"wav_sha256\":")?;
    let wav_sha256 = parse_nonzero_digest(&parser.string()?)?;
    parser.expect(",\"pcm_sha256\":")?;
    let pcm_sha256 = parse_nonzero_digest(&parser.string()?)?;
    parser.expect(",\"reference_sha256\":")?;
    let reference_sha256 = parse_nonzero_digest(&parser.string()?)?;
    parser.expect("}")?;
    parser.finish()?;
    if !wav_path.is_absolute() || !(MIN_WAV_BYTES..=MAX_WAV_BYTES).contains(&wav_size_bytes) {
        return Err(NativeCandidateQualityShardError::InvalidInput);
    }
    Ok(ShardRequest {
        sequence,
        sample: NativeCandidateQualitySampleIdentity {
            sample_id,
            language: language.clone(),
            expected_wav_size_bytes: wav_size_bytes,
            expected_wav_sha256: wav_sha256,
            expected_pcm_sha256: pcm_sha256,
            reference_sha256,
        },
        classification,
        canary_identity_sha256_hex,
        language,
        wav_path,
    })
}

fn validate_canary_identity(
    classification: &RequestClassification,
    value: &str,
) -> Result<(), NativeCandidateQualityShardError> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
    {
        return Err(NativeCandidateQualityShardError::InvalidInput);
    }
    match classification {
        RequestClassification::Sample if value == ZERO_SHA256_HEX => Ok(()),
        RequestClassification::Canary if value != ZERO_SHA256_HEX => Ok(()),
        _ => Err(NativeCandidateQualityShardError::InvalidInput),
    }
}

fn parse_nonzero_digest(value: &str) -> Result<Sha256Digest, NativeCandidateQualityShardError> {
    let digest = Sha256Digest::from_lower_hex(value)
        .map_err(|_| NativeCandidateQualityShardError::InvalidInput)?;
    if digest.is_zero() {
        return Err(NativeCandidateQualityShardError::InvalidInput);
    }
    Ok(digest)
}

fn parse_canonical_u64_string(value: &str) -> Result<u64, NativeCandidateQualityShardError> {
    let bytes = value.as_bytes();
    if bytes.is_empty()
        || !bytes.iter().all(u8::is_ascii_digit)
        || (bytes.len() > 1 && bytes[0] == b'0')
    {
        return Err(NativeCandidateQualityShardError::InvalidInput);
    }
    value
        .parse::<u64>()
        .map_err(|_| NativeCandidateQualityShardError::InvalidInput)
}

struct StrictParser<'a> {
    value: &'a str,
    offset: usize,
}

impl<'a> StrictParser<'a> {
    const fn new(value: &'a str) -> Self {
        Self { value, offset: 0 }
    }

    fn expect(&mut self, expected: &str) -> Result<(), NativeCandidateQualityShardError> {
        if self.value[self.offset..].starts_with(expected) {
            self.offset += expected.len();
            Ok(())
        } else {
            Err(NativeCandidateQualityShardError::InvalidInput)
        }
    }

    fn finish(&self) -> Result<(), NativeCandidateQualityShardError> {
        if self.offset == self.value.len() {
            Ok(())
        } else {
            Err(NativeCandidateQualityShardError::InvalidInput)
        }
    }

    fn u64(&mut self) -> Result<u64, NativeCandidateQualityShardError> {
        let start = self.offset;
        while self
            .value
            .as_bytes()
            .get(self.offset)
            .is_some_and(u8::is_ascii_digit)
        {
            self.offset += 1;
        }
        let token = &self.value[start..self.offset];
        if token.is_empty() || (token.len() > 1 && token.starts_with('0')) {
            return Err(NativeCandidateQualityShardError::InvalidInput);
        }
        token
            .parse::<u64>()
            .map_err(|_| NativeCandidateQualityShardError::InvalidInput)
    }

    fn string(&mut self) -> Result<String, NativeCandidateQualityShardError> {
        self.expect("\"")?;
        let mut output = String::new();
        while self.offset < self.value.len() {
            let byte = self.value.as_bytes()[self.offset];
            self.offset += 1;
            match byte {
                b'"' => return Ok(output),
                b'\\' => self.escape(&mut output)?,
                0..=0x1f => return Err(NativeCandidateQualityShardError::InvalidInput),
                _ => {
                    let remaining = &self.value[self.offset - 1..];
                    let character = remaining
                        .chars()
                        .next()
                        .ok_or(NativeCandidateQualityShardError::InvalidInput)?;
                    self.offset += character.len_utf8() - 1;
                    output.push(character);
                }
            }
        }
        Err(NativeCandidateQualityShardError::InvalidInput)
    }

    fn escape(&mut self, output: &mut String) -> Result<(), NativeCandidateQualityShardError> {
        let escape = *self
            .value
            .as_bytes()
            .get(self.offset)
            .ok_or(NativeCandidateQualityShardError::InvalidInput)?;
        self.offset += 1;
        match escape {
            b'"' => output.push('"'),
            b'\\' => output.push('\\'),
            b'/' => output.push('/'),
            b'b' => output.push('\u{08}'),
            b'f' => output.push('\u{0c}'),
            b'n' => output.push('\n'),
            b'r' => output.push('\r'),
            b't' => output.push('\t'),
            b'u' => {
                let hex = self
                    .value
                    .get(self.offset..self.offset + 4)
                    .ok_or(NativeCandidateQualityShardError::InvalidInput)?;
                if !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                    return Err(NativeCandidateQualityShardError::InvalidInput);
                }
                let value = u32::from_str_radix(hex, 16)
                    .map_err(|_| NativeCandidateQualityShardError::InvalidInput)?;
                self.offset += 4;
                if (0xd800..=0xdfff).contains(&value) || value == 0 {
                    return Err(NativeCandidateQualityShardError::InvalidInput);
                }
                output.push(
                    char::from_u32(value).ok_or(NativeCandidateQualityShardError::InvalidInput)?,
                );
            }
            _ => return Err(NativeCandidateQualityShardError::InvalidInput),
        }
        Ok(())
    }
}

struct ShardTranscriptIdentity {
    final_transcript: String,
    sha256: Sha256Digest,
    utf8_bytes: usize,
    has_nul: bool,
}

impl ShardTranscriptIdentity {
    fn from_text(text: String) -> Self {
        let bytes = text.as_bytes();
        let sha256 = Sha256Digest::from_bytes(Sha256::digest(bytes).into());
        let utf8_bytes = bytes.len();
        let has_nul = bytes.contains(&0);
        Self {
            final_transcript: text,
            sha256,
            utf8_bytes,
            has_nul,
        }
    }

    fn validate(&self) -> Result<&str, NativeCandidateQualityShardError> {
        let transcript = self.final_transcript.as_bytes();
        let text = std::str::from_utf8(transcript)
            .map_err(|_| NativeCandidateQualityShardError::Observation)?;
        let actual_sha256 = Sha256Digest::from_bytes(Sha256::digest(transcript).into());
        if self.has_nul
            || self.utf8_bytes != transcript.len()
            || self.sha256 != actual_sha256
            || transcript.len() > MAX_TRANSCRIPT_UTF8_BYTES
            || self.sha256.is_zero()
        {
            return Err(NativeCandidateQualityShardError::Observation);
        }
        Ok(text)
    }
}

struct ResourceObservation {
    cpu_time_ns: Option<u64>,
    peak_working_set_bytes: Option<u64>,
}

impl ResourceObservation {
    fn current() -> Self {
        platform_resource_observation()
    }

    fn status(&self) -> &'static str {
        if self.cpu_time_ns.is_some() || self.peak_working_set_bytes.is_some() {
            "observed"
        } else {
            "unavailable"
        }
    }

    fn reason(&self) -> &'static str {
        if self.status() == "observed" {
            "observed"
        } else {
            "SHERPA_QUALITY_SHARD_RESOURCE_SAMPLING_UNAVAILABLE"
        }
    }
}

fn platform_resource_observation() -> ResourceObservation {
    ResourceObservation {
        cpu_time_ns: None,
        peak_working_set_bytes: None,
    }
}

struct ShardResponse<'a> {
    request: &'a ShardRequest,
    manifest: &'a WorkerManifest,
    wav: &'a VerifiedQualityWav,
    transcript: &'a ShardTranscriptIdentity,
    resource: &'a ResourceObservation,
    parameter_sha256: Sha256Digest,
    prepare_elapsed_ns: u64,
    prepare_started_ns: u64,
    prepare_finished_ns: u64,
    execute_elapsed_ns: u64,
    execute_started_ns: u64,
    execute_finished_ns: u64,
    shard_sample_index: u64,
    shard_max_samples: u64,
    shard_total_pcm_bytes: u64,
}

fn encode_response(input: ShardResponse<'_>) -> Result<Vec<u8>, NativeCandidateQualityShardError> {
    let transcript = input.transcript.validate()?;
    let mut output = String::with_capacity(2_048);
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
        input.parameter_sha256.to_lower_hex(),
        LOCKED_RUNTIME_BUNDLE_SHA256_HEX,
        LOCKED_TOKENS_SHA256_HEX,
    )
    .map_err(|_| NativeCandidateQualityShardError::Observation)?;
    write!(
        &mut output,
        concat!(
            "\"execution\":{{\"backend_execute_calls\":1,",
            "\"execute_elapsed_ns\":\"{}\",\"execute_finished_monotonic_ns\":\"{}\",",
            "\"execute_started_monotonic_ns\":\"{}\",",
            "\"final_transcript\":"
        ),
        input.execute_elapsed_ns, input.execute_finished_ns, input.execute_started_ns,
    )
    .map_err(|_| NativeCandidateQualityShardError::Observation)?;
    write_canonical_json_string(&mut output, transcript)
        .map_err(NativeCandidateQualityShardError::from)?;
    write!(
        &mut output,
        concat!(
            ",\"final_transcript_sha256\":\"{}\",\"final_transcript_utf8_bytes\":\"{}\",",
            "\"fresh_os_process_per_shard\":true,",
            "\"fresh_recognizer_stream_per_request\":true,",
            "\"prepare_elapsed_ns\":\"{}\",\"prepare_finished_monotonic_ns\":\"{}\",",
            "\"prepare_started_monotonic_ns\":\"{}\",\"request_sequence\":{},",
            "\"runtime_identity_post_status\":\"verified\",",
            "\"runtime_identity_pre_status\":\"verified\",\"shard_prepare_calls\":1}},",
            "\"host\":{{\"executable_sha256\":\"{}\",",
            "\"schema_registry_sha256\":\"{}\"}},",
            "\"kind\":\"meetingrelay-native-candidate-quality-shard-response-v1\",",
            "\"resources\":{{\"cpu_time_ns\":"
        ),
        input.transcript.sha256.to_lower_hex(),
        input.transcript.utf8_bytes,
        input.prepare_elapsed_ns,
        input.prepare_finished_ns,
        input.prepare_started_ns,
        input.request.sequence,
        input.manifest.executable_sha256.to_lower_hex(),
        input.manifest.schema_registry_sha256.to_lower_hex(),
    )
    .map_err(|_| NativeCandidateQualityShardError::Observation)?;
    write_optional_u64(&mut output, input.resource.cpu_time_ns)?;
    output.push_str(",\"gpu_time_ns\":null,\"peak_ram_bytes\":");
    write_optional_u64(&mut output, input.resource.peak_working_set_bytes)?;
    write!(
        &mut output,
        concat!(
            ",\"peak_vram_bytes\":null,\"reason\":\"{}\",\"status\":\"{}\"}},",
            "\"rtf\":{{\"denominator_audio_ns\":\"{}\",\"numerator_execute_ns\":\"{}\"}},",
            "\"sample\":{{\"canary_identity_sha256\":\"{}\",\"channels\":{},",
            "\"classification\":\"{}\",\"language\":\"{}\",\"pcm_bytes\":\"{}\",",
            "\"pcm_sample_count\":\"{}\",\"pcm_sha256\":\"{}\",",
            "\"reference_sha256\":\"{}\",\"sample_id\":\"{}\",",
            "\"sample_identity_sha256\":\"{}\",\"sample_rate_hz\":{},\"scored\":{},",
            "\"wav_sha256\":\"{}\",\"wav_size_bytes\":\"{}\"}},",
            "\"schema_version\":\"1.0\",",
            "\"shard\":{{\"max_samples\":\"{}\",\"sample_index\":\"{}\",",
            "\"total_pcm_bytes\":\"{}\"}}}}\n"
        ),
        input.resource.reason(),
        input.resource.status(),
        input.wav.audio_duration_ns,
        input.execute_elapsed_ns,
        input.request.canary_identity_sha256_hex,
        CHANNELS,
        input.request.classification.as_str(),
        input.request.sample.language.as_str(),
        input.wav.pcm_bytes,
        input.wav.sample_count,
        input.request.sample.expected_pcm_sha256.to_lower_hex(),
        input.request.sample.reference_sha256.to_lower_hex(),
        input.request.sample.sample_id.as_str(),
        canonical_sample_identity_sha256(&input.request.sample).to_lower_hex(),
        SAMPLE_RATE_HZ,
        input.request.classification.scored(),
        input.request.sample.expected_wav_sha256.to_lower_hex(),
        input.request.sample.expected_wav_size_bytes,
        input.shard_max_samples,
        input.shard_sample_index,
        input.shard_total_pcm_bytes,
    )
    .map_err(|_| NativeCandidateQualityShardError::Observation)?;
    Ok(output.into_bytes())
}

fn write_optional_u64(
    output: &mut String,
    value: Option<u64>,
) -> Result<(), NativeCandidateQualityShardError> {
    match value {
        Some(value) => write!(output, "\"{value}\""),
        None => {
            output.push_str("null");
            Ok(())
        }
    }
    .map_err(|_| NativeCandidateQualityShardError::Observation)
}

fn write_error_response<W: Write>(
    writer: &mut W,
    request: &ShardRequest,
    error: NativeCandidateQualityShardError,
) -> Result<(), NativeCandidateQualityShardError> {
    let mut output = String::new();
    write!(
        &mut output,
        "{{\"error\":{{\"code\":\"{}\",\"request_sequence\":{},\"sample_id\":",
        error.code(),
        request.sequence,
    )
    .map_err(|_| NativeCandidateQualityShardError::Observation)?;
    write_canonical_json_string(&mut output, request.sample.sample_id.as_str())
        .map_err(NativeCandidateQualityShardError::from)?;
    writeln!(
        &mut output,
        ",\"classification\":\"{}\"}},\"kind\":\"meetingrelay-native-candidate-quality-shard-error-v1\",\"schema_version\":\"1.0\"}}",
        request.classification.as_str()
    )
    .map_err(|_| NativeCandidateQualityShardError::Observation)?;
    writer
        .write_all(output.as_bytes())
        .map_err(|_| NativeCandidateQualityShardError::Observation)?;
    writer
        .flush()
        .map_err(|_| NativeCandidateQualityShardError::Observation)
}

fn nanos(started: Instant) -> Result<u64, NativeCandidateQualityShardError> {
    u64::try_from(started.elapsed().as_nanos())
        .map_err(|_| NativeCandidateQualityShardError::Observation)
}

fn elapsed_ns(started: Instant) -> Result<u64, NativeCandidateQualityShardError> {
    nanos(started)
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::fs;
    use std::io::Cursor;
    use std::path::PathBuf;
    use std::rc::Rc;
    use std::time::{SystemTime, UNIX_EPOCH};

    use meetingrelay_model_worker_contract::{LanguageCode, Sha256Digest};

    use super::*;
    use crate::LOCKED_SCHEMA_REGISTRY_BYTES;
    use crate::candidate_quality_sample::NANOS_PER_SAMPLE;

    const A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const C: &str = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    const D: &str = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
    const E: &str = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

    #[test]
    fn shard_prepares_once_executes_each_request_and_marks_canary_unscored() {
        let fixture = Fixture::new("valid-shard");
        let calls = Rc::new(RefCell::new(FakeCalls::default()));
        let observed_calls = Rc::clone(&calls);
        let stdin = format!(
            "{}\n{}\n",
            fixture.request_json(1, "quality-sample-001", "sample", ZERO_SHA256_HEX),
            fixture.request_json(2, "quality-canary-001", "canary", A),
        );
        let mut stdout = Vec::new();

        run_quality_shard_with_backend_factory(
            fixture.shard_input(8, 1024),
            Cursor::new(stdin),
            &mut stdout,
            move |_, _| Ok(Box::new(FakeBackend::new(observed_calls))),
        )
        .expect("valid shard succeeds");

        let calls = calls.borrow();
        assert_eq!(calls.prepare, 1);
        assert_eq!(calls.execute, 2);
        assert_eq!(calls.runtime_identity, 3);
        assert_eq!(calls.last_sample_counts, vec![4, 4]);
        drop(calls);
        let output = String::from_utf8(stdout).expect("output UTF-8");
        assert_eq!(output.matches('\n').count(), 2);
        assert!(
            output.contains("\"kind\":\"meetingrelay-native-candidate-quality-shard-response-v1\"")
        );
        assert!(output.contains("\"classification\":\"sample\""));
        assert!(output.contains("\"classification\":\"canary\""));
        assert!(output.contains("\"scored\":true"));
        assert!(output.contains("\"scored\":false"));
        assert!(output.contains("\"shard_prepare_calls\":1"));
        assert!(output.contains("\"fresh_os_process_per_shard\":true"));
        assert!(output.contains("\"fresh_recognizer_stream_per_request\":true"));
        assert!(output.contains("\"final_transcript\":\"private transcript 1\""));
        assert!(output.contains("\"final_transcript\":\"private transcript 2\""));
    }

    #[test]
    fn deterministic_canonical_record_keeps_exact_field_order() {
        let sample = ShardRequest {
            sequence: 7,
            sample: NativeCandidateQualitySampleIdentity {
                sample_id: Identifier::new("quality-record-001").expect("valid id"),
                language: LanguageCode::new("ja").expect("valid language"),
                expected_wav_size_bytes: 52,
                expected_wav_sha256: digest(A),
                expected_pcm_sha256: digest(B),
                reference_sha256: digest(C),
            },
            classification: RequestClassification::Canary,
            canary_identity_sha256_hex: D.to_owned(),
            language: LanguageCode::new("ja").expect("valid language"),
            wav_path: PathBuf::from("E:\\sample.wav"),
        };
        let manifest = locked_worker_manifest(digest(D), digest(E)).expect("valid manifest");
        let transcript = ShardTranscriptIdentity::from_text("private transcript".to_owned());
        let record = encode_response(ShardResponse {
            request: &sample,
            manifest: &manifest,
            wav: &VerifiedQualityWav {
                samples: vec![1, 2, 3, 4],
                pcm_bytes: 8,
                sample_count: 4,
                audio_duration_ns: 4 * NANOS_PER_SAMPLE,
            },
            transcript: &transcript,
            resource: &ResourceObservation {
                cpu_time_ns: Some(100),
                peak_working_set_bytes: Some(200),
            },
            parameter_sha256: digest(
                "946af178a84c720f928d08ed084fe37625a57447b2ad8e8dc5d36034ea319bf5",
            ),
            prepare_elapsed_ns: 11,
            prepare_started_ns: 1,
            prepare_finished_ns: 12,
            execute_elapsed_ns: 13,
            execute_started_ns: 20,
            execute_finished_ns: 33,
            shard_sample_index: 3,
            shard_max_samples: 8,
            shard_total_pcm_bytes: 24,
        })
        .expect("encode response");

        assert_eq!(
            String::from_utf8(record).expect("record UTF-8"),
            concat!(
                "{\"authority\":{\"formal_claims\":\"none\",\"production_evidence\":false},",
                "\"candidate\":{\"asset_lock_sha256\":\"e22adeea2dde27cab1c40fa116b665ef111b7c1b8cf24f7b7a1900a23e263181\",",
                "\"candidate_id\":\"sherpa-native-sensevoice-int8-2024-07-17-win-x64-cpu\",",
                "\"model_sha256\":\"c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51\",",
                "\"package_lock_sha256\":\"3510ddfa99e3eabd022954fa71c23515abaa6a0411d8555844efe49d64b29acf\",",
                "\"parameter_sha256\":\"946af178a84c720f928d08ed084fe37625a57447b2ad8e8dc5d36034ea319bf5\",",
                "\"runtime_bundle_sha256\":\"0682618f660a2a9f2278d99decb77624253aadde60e8199a9b07813b8d843317\",",
                "\"tokens_sha256\":\"f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc\"},",
                "\"execution\":{\"backend_execute_calls\":1,\"execute_elapsed_ns\":\"13\",",
                "\"execute_finished_monotonic_ns\":\"33\",\"execute_started_monotonic_ns\":\"20\",",
                "\"final_transcript\":\"private transcript\",",
                "\"final_transcript_sha256\":\"3b03a4e528fd010c997c47ee71295a7066d035e2d125cdf1ee642655d9074df3\",",
                "\"final_transcript_utf8_bytes\":\"18\",\"fresh_os_process_per_shard\":true,",
                "\"fresh_recognizer_stream_per_request\":true,\"prepare_elapsed_ns\":\"11\",",
                "\"prepare_finished_monotonic_ns\":\"12\",\"prepare_started_monotonic_ns\":\"1\",",
                "\"request_sequence\":7,\"runtime_identity_post_status\":\"verified\",",
                "\"runtime_identity_pre_status\":\"verified\",\"shard_prepare_calls\":1},",
                "\"host\":{\"executable_sha256\":\"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd\",",
                "\"schema_registry_sha256\":\"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee\"},",
                "\"kind\":\"meetingrelay-native-candidate-quality-shard-response-v1\",",
                "\"resources\":{\"cpu_time_ns\":\"100\",\"gpu_time_ns\":null,",
                "\"peak_ram_bytes\":\"200\",\"peak_vram_bytes\":null,",
                "\"reason\":\"observed\",\"status\":\"observed\"},",
                "\"rtf\":{\"denominator_audio_ns\":\"250000\",\"numerator_execute_ns\":\"13\"},",
                "\"sample\":{\"canary_identity_sha256\":\"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd\",",
                "\"channels\":1,\"classification\":\"canary\",\"language\":\"ja\",\"pcm_bytes\":\"8\",",
                "\"pcm_sample_count\":\"4\",\"pcm_sha256\":\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\",",
                "\"reference_sha256\":\"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc\",",
                "\"sample_id\":\"quality-record-001\",",
                "\"sample_identity_sha256\":\"75993bf72c29f3a122aeb7cebe22a940a9c9f418b3277fc2ff05e422a55fa230\",",
                "\"sample_rate_hz\":16000,\"scored\":false,",
                "\"wav_sha256\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",",
                "\"wav_size_bytes\":\"52\"},\"schema_version\":\"1.0\",",
                "\"shard\":{\"max_samples\":\"8\",\"sample_index\":\"3\",\"total_pcm_bytes\":\"24\"}}\n"
            )
        );
    }

    #[test]
    fn success_private_pipe_escapes_plaintext_and_binds_digest_and_count() {
        let sample = ShardRequest {
            sequence: 1,
            sample: NativeCandidateQualitySampleIdentity {
                sample_id: Identifier::new("quality-record-escape").expect("valid id"),
                language: LanguageCode::new("zh").expect("valid language"),
                expected_wav_size_bytes: 52,
                expected_wav_sha256: digest(A),
                expected_pcm_sha256: digest(B),
                reference_sha256: digest(C),
            },
            classification: RequestClassification::Sample,
            canary_identity_sha256_hex: ZERO_SHA256_HEX.to_owned(),
            language: LanguageCode::new("zh").expect("valid language"),
            wav_path: PathBuf::from("E:\\sample.wav"),
        };
        let manifest = locked_worker_manifest(digest(D), digest(E)).expect("valid manifest");
        let transcript_text = "中文 \"quoted\" \\path\nnext\t\u{01}";
        let transcript = ShardTranscriptIdentity::from_text(transcript_text.to_owned());
        let expected_sha256 =
            Sha256Digest::from_bytes(Sha256::digest(transcript_text.as_bytes()).into());
        let record = encode_response(ShardResponse {
            request: &sample,
            manifest: &manifest,
            wav: &VerifiedQualityWav {
                samples: vec![1, 2, 3, 4],
                pcm_bytes: 8,
                sample_count: 4,
                audio_duration_ns: 4 * NANOS_PER_SAMPLE,
            },
            transcript: &transcript,
            resource: &ResourceObservation {
                cpu_time_ns: None,
                peak_working_set_bytes: None,
            },
            parameter_sha256: digest(
                "0ac8669e387262648fcf05fd301a9ba798bb2822e56ec952f1e17d6c692f802e",
            ),
            prepare_elapsed_ns: 1,
            prepare_started_ns: 0,
            prepare_finished_ns: 1,
            execute_elapsed_ns: 2,
            execute_started_ns: 1,
            execute_finished_ns: 3,
            shard_sample_index: 1,
            shard_max_samples: 8,
            shard_total_pcm_bytes: 8,
        })
        .expect("encode escaped transcript response");
        let output = String::from_utf8(record).expect("record UTF-8");

        assert!(
            output
                .contains("\"final_transcript\":\"中文 \\\"quoted\\\" \\\\path\\nnext\\t\\u0001\"")
        );
        assert!(output.contains(&format!(
            "\"final_transcript_sha256\":\"{}\"",
            expected_sha256.to_lower_hex()
        )));
        assert!(output.contains(&format!(
            "\"final_transcript_utf8_bytes\":\"{}\"",
            transcript_text.len()
        )));
        assert_eq!(output.matches('\n').count(), 1);
    }

    #[test]
    fn strict_order_bounds_and_language_drift_fail_closed_without_plaintext() {
        let fixture = Fixture::new("bad-order");
        let stdin = format!(
            "{}\n",
            fixture.request_json(2, "private-transcript-sentinel", "sample", ZERO_SHA256_HEX)
        );
        let mut stdout = Vec::new();
        let error = run_quality_shard_with_backend_factory(
            fixture.shard_input(8, 1024),
            Cursor::new(stdin),
            &mut stdout,
            |_, _| Ok(Box::new(FakeBackend::new(Rc::default()))),
        )
        .expect_err("sequence drift fails");

        assert_eq!(error, NativeCandidateQualityShardError::InvalidInput);
        let output = String::from_utf8(stdout).expect("error UTF-8");
        assert!(
            output.contains("\"kind\":\"meetingrelay-native-candidate-quality-shard-error-v1\"")
        );
        assert!(output.contains("\"request_sequence\":2"));
        assert!(!output.contains("private transcript"));
    }

    #[test]
    fn strict_parser_rejects_surrogate_nul_bad_canary_and_whitespace() {
        let fixture = Fixture::new("parser");
        for line in [
            format!(
                " {}",
                fixture.request_json(1, "quality-sample-001", "sample", ZERO_SHA256_HEX)
            ),
            fixture.request_json(1, "quality-sample-001", "sample", A),
            fixture.request_json(1, "quality-sample-001", "canary", ZERO_SHA256_HEX),
            fixture
                .request_json(1, "quality-sample-001", "sample", ZERO_SHA256_HEX)
                .replace("quality-sample-001", "\\u0000"),
            fixture
                .request_json(1, "quality-sample-001", "sample", ZERO_SHA256_HEX)
                .replace("quality-sample-001", "\\ud800"),
        ] {
            assert_eq!(
                parse_request(&line).map(|_| ()),
                Err(NativeCandidateQualityShardError::InvalidInput)
            );
        }
    }

    #[test]
    fn pcm_total_bound_fails_after_a_canonical_error_response() {
        let fixture = Fixture::new("pcm-bound");
        let stdin = format!(
            "{}\n",
            fixture.request_json(1, "quality-sample-001", "sample", ZERO_SHA256_HEX)
        );
        let mut stdout = Vec::new();
        let error = run_quality_shard_with_backend_factory(
            fixture.shard_input(8, 2),
            Cursor::new(stdin),
            &mut stdout,
            |_, _| Ok(Box::new(FakeBackend::new(Rc::default()))),
        )
        .expect_err("PCM total bound fails");

        assert_eq!(error, NativeCandidateQualityShardError::InvalidInput);
        let output = String::from_utf8(stdout).expect("error UTF-8");
        assert!(output.contains("\"code\":\"SHERPA_QUALITY_SHARD_INVALID_INPUT\""));
        assert_eq!(output.matches('\n').count(), 1);
    }

    #[test]
    fn invalid_transcript_observation_fails_closed_without_plaintext() {
        for (label, transcript) in [
            ("nul-transcript", "secret\0sentinel".to_owned()),
            (
                "oversize-transcript",
                "s".repeat(MAX_TRANSCRIPT_UTF8_BYTES + 1),
            ),
        ] {
            let fixture = Fixture::new(label);
            let stdin = format!(
                "{}\n",
                fixture.request_json(1, "quality-sample-001", "sample", ZERO_SHA256_HEX)
            );
            let mut stdout = Vec::new();
            let error = run_quality_shard_with_backend_factory(
                fixture.shard_input(8, 1024),
                Cursor::new(stdin),
                &mut stdout,
                move |_, _| Ok(Box::new(TranscriptBackend { transcript })),
            )
            .expect_err("invalid transcript fails");

            assert_eq!(error, NativeCandidateQualityShardError::Observation);
            let output = String::from_utf8(stdout).expect("error UTF-8");
            assert!(output.contains("\"code\":\"SHERPA_QUALITY_SHARD_OBSERVATION\""));
            assert!(!output.contains("secret"));
            assert!(!output.contains("sentinel"));
            assert_eq!(output.matches('\n').count(), 1);
        }
    }

    #[derive(Default)]
    struct FakeCalls {
        prepare: usize,
        execute: usize,
        runtime_identity: usize,
        last_sample_counts: Vec<usize>,
    }

    struct FakeBackend {
        calls: Rc<RefCell<FakeCalls>>,
    }

    impl FakeBackend {
        fn new(calls: Rc<RefCell<FakeCalls>>) -> Self {
            Self { calls }
        }
    }

    impl CandidateQualityShardBackend for FakeBackend {
        fn prepare(&mut self) -> Result<(), NativeCandidateQualityShardError> {
            self.calls.borrow_mut().prepare += 1;
            Ok(())
        }

        fn validate_runtime_identity(&self) -> Result<(), NativeCandidateQualityShardError> {
            self.calls.borrow_mut().runtime_identity += 1;
            Ok(())
        }

        fn execute(
            &mut self,
            samples: &[i16],
            _pcm_sha256: Sha256Digest,
        ) -> Result<ShardTranscriptIdentity, NativeCandidateQualityShardError> {
            let mut calls = self.calls.borrow_mut();
            calls.execute += 1;
            calls.last_sample_counts.push(samples.len());
            Ok(ShardTranscriptIdentity::from_text(format!(
                "private transcript {}",
                calls.execute
            )))
        }
    }

    struct TranscriptBackend {
        transcript: String,
    }

    impl CandidateQualityShardBackend for TranscriptBackend {
        fn prepare(&mut self) -> Result<(), NativeCandidateQualityShardError> {
            Ok(())
        }

        fn validate_runtime_identity(&self) -> Result<(), NativeCandidateQualityShardError> {
            Ok(())
        }

        fn execute(
            &mut self,
            _samples: &[i16],
            _pcm_sha256: Sha256Digest,
        ) -> Result<ShardTranscriptIdentity, NativeCandidateQualityShardError> {
            Ok(ShardTranscriptIdentity::from_text(self.transcript.clone()))
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
            let executable_path = root.join("quality-shard-host.exe");
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

        fn shard_input(
            &self,
            max_samples: u64,
            max_total_pcm_bytes: u64,
        ) -> ResolvedNativeCandidateQualityShardInput {
            ResolvedNativeCandidateQualityShardInput {
                executable_path: self.executable_path.clone(),
                schema_registry_path: self.schema_registry_path.clone(),
                model_path: self.root.join("model.int8.onnx"),
                tokens_path: self.root.join("tokens.txt"),
                runtime_lib_dir: self.root.join("runtime"),
                asset_lock_path: self.root.join("assets.lock.json"),
                package_lock_path: self.root.join("Cargo.lock"),
                language: LanguageCode::new("zh").expect("valid language"),
                max_samples,
                max_total_pcm_bytes,
            }
        }

        fn request_json(
            &self,
            sequence: u64,
            sample_id: &str,
            classification: &str,
            canary_identity_sha256: &str,
        ) -> String {
            format!(
                concat!(
                    "{{\"schema_version\":\"1.0\",\"sequence\":{},",
                    "\"sample_id\":\"{}\",\"classification\":\"{}\",",
                    "\"canary_identity_sha256\":\"{}\",\"language\":\"zh\",",
                    "\"wav_path\":{},\"wav_size_bytes\":\"{}\",",
                    "\"wav_sha256\":\"{}\",\"pcm_sha256\":\"{}\",",
                    "\"reference_sha256\":\"{}\"}}"
                ),
                sequence,
                sample_id,
                classification,
                canary_identity_sha256,
                json_string(&self.wav_path.display().to_string()),
                self.wav_size_bytes,
                self.wav_sha256.to_lower_hex(),
                self.pcm_sha256.to_lower_hex(),
                C,
            )
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn json_string(value: &str) -> String {
        let mut output = String::new();
        write_canonical_json_string(&mut output, value).expect("encode JSON string");
        output
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

    fn unique_test_directory(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock follows Unix epoch")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "meetingrelay-quality-shard-{label}-{}-{nonce}",
            std::process::id()
        ))
    }
}
