use std::fmt;
use std::path::PathBuf;
use std::sync::Arc;

use meetingrelay_model_worker_contract::{
    AudioChunk, AudioFormat, AudioPayload, AudioSource, ExecutionProvider, Identifier,
    LanguageCode, SampleFormat, Sha256Digest, SourceRange, TranscriptResult,
};
use sha2::{Digest, Sha256};

use super::{
    AdapterFailure, LOCKED_PARAMETER_SHA256_HEX, LOCKED_TOKENS_SHA256_HEX, REQUIRED_CHANNELS,
    REQUIRED_SAMPLE_RATE_HZ, SherpaConfigError, SherpaNativeBackend, SherpaNativeConfig,
    locked_digest, locked_engine_descriptor,
};

#[cfg(feature = "native-sherpa")]
use super::sha256_file;

/// Sample rate accepted by [`LockedSherpaRealtime::transcribe_mono_16khz_pcm16`].
pub const LOCKED_REALTIME_SAMPLE_RATE_HZ: u32 = REQUIRED_SAMPLE_RATE_HZ;

/// Maximum PCM16 payload admitted by the locked native candidate.
pub const LOCKED_REALTIME_MAX_PCM16_BYTES: u64 = 64 * 1024 * 1024;

/// Local paths to the five sealed inputs required by the locked candidate.
///
/// Callers supply locations only. All expected digests, the language, the CPU
/// provider, and inference parameters remain fixed by the committed candidate.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LockedSherpaRealtimePaths {
    pub model_path: PathBuf,
    pub tokens_path: PathBuf,
    pub runtime_lib_dir: PathBuf,
    pub asset_lock_path: PathBuf,
    pub package_lock_path: PathBuf,
}

/// Stable, path-free failure categories for an application boundary such as Tauri.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LockedSherpaRealtimeError {
    InvalidAssetPaths,
    NativeFeatureDisabled,
    Configuration,
    AssetMismatch,
    Initialization,
    NotPrepared,
    EmptySegment,
    SegmentTooLarge,
    InvalidAudio,
    RecognitionUnavailable,
    EmptyTranscript,
}

impl LockedSherpaRealtimeError {
    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            Self::InvalidAssetPaths => "SHERPA_REALTIME_INVALID_ASSET_PATHS",
            Self::NativeFeatureDisabled => "SHERPA_REALTIME_NATIVE_FEATURE_DISABLED",
            Self::Configuration => "SHERPA_REALTIME_CONFIGURATION",
            Self::AssetMismatch => "SHERPA_REALTIME_ASSET_MISMATCH",
            Self::Initialization => "SHERPA_REALTIME_INITIALIZATION",
            Self::NotPrepared => "SHERPA_REALTIME_NOT_PREPARED",
            Self::EmptySegment => "SHERPA_REALTIME_EMPTY_SEGMENT",
            Self::SegmentTooLarge => "SHERPA_REALTIME_SEGMENT_TOO_LARGE",
            Self::InvalidAudio => "SHERPA_REALTIME_INVALID_AUDIO",
            Self::RecognitionUnavailable => "SHERPA_REALTIME_RECOGNITION_UNAVAILABLE",
            Self::EmptyTranscript => "SHERPA_REALTIME_EMPTY_TRANSCRIPT",
        }
    }
}

impl fmt::Display for LockedSherpaRealtimeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code())
    }
}

impl std::error::Error for LockedSherpaRealtimeError {}

/// Prepared native recognizer that can transcribe many bounded PCM16 segments.
///
/// Construction verifies the sealed assets and initializes sherpa-onnx once.
/// Segment calls reuse that recognizer and never perform hidden preparation.
pub struct LockedSherpaRealtime {
    backend: SherpaNativeBackend,
    max_input_bytes: u64,
}

impl LockedSherpaRealtime {
    /// Verifies and prepares the locked zh/CPU candidate once.
    pub fn prepare(paths: LockedSherpaRealtimePaths) -> Result<Self, LockedSherpaRealtimeError> {
        let config = locked_zh_cpu_config(&paths)?;
        let backend = SherpaNativeBackend::new(config).map_err(map_config_error)?;
        Self::prepare_backend(backend)
    }

    /// Prepares the same sealed model/runtime for the desktop MVP while binding
    /// provenance to the workspace's current package lock.
    ///
    /// This deliberately does not claim formal-candidate identity: adding the
    /// desktop audio dependency changes `Cargo.lock`, while the already-attested
    /// candidate remains frozen. Model, tokens, asset-lock, runtime inventory,
    /// language, provider, and inference parameters remain verified and fixed.
    #[cfg(feature = "native-sherpa")]
    pub fn prepare_local_mvp(
        paths: LockedSherpaRealtimePaths,
    ) -> Result<Self, LockedSherpaRealtimeError> {
        let mut config = locked_zh_cpu_config(&paths)?;
        let package_lock_sha256 = sha256_file(&paths.package_lock_path)
            .map_err(|_| LockedSherpaRealtimeError::AssetMismatch)?;
        config.expected_package_lock_sha256 = package_lock_sha256;
        config.descriptor.package_lock_sha256 = package_lock_sha256;
        config
            .validate()
            .map_err(|_| LockedSherpaRealtimeError::Configuration)?;
        let backend = SherpaNativeBackend::new_local_mvp(config).map_err(map_config_error)?;
        Self::prepare_backend(backend)
    }

    #[cfg(not(feature = "native-sherpa"))]
    pub fn prepare_local_mvp(
        paths: LockedSherpaRealtimePaths,
    ) -> Result<Self, LockedSherpaRealtimeError> {
        let _ = paths;
        Err(LockedSherpaRealtimeError::NativeFeatureDisabled)
    }

    /// Transcribes one independent mono 16 kHz PCM16 segment.
    ///
    /// `samples` is shared so capture code can hand ownership to the recognizer
    /// without an adapter-level PCM copy. Calls require mutable access because
    /// the native offline recognizer is intentionally used serially.
    pub fn transcribe_mono_16khz_pcm16(
        &mut self,
        samples: Arc<[i16]>,
    ) -> Result<TranscriptResult, LockedSherpaRealtimeError> {
        let payload_bytes = pcm16_payload_bytes(samples.len())?;
        if payload_bytes == 0 {
            return Err(LockedSherpaRealtimeError::EmptySegment);
        }
        if payload_bytes > self.max_input_bytes {
            return Err(LockedSherpaRealtimeError::SegmentTooLarge);
        }

        let chunk = pcm16_chunk(samples, payload_bytes)?;
        self.backend.process(&[chunk]).map_err(map_adapter_failure)
    }

    fn prepare_backend(
        mut backend: SherpaNativeBackend,
    ) -> Result<Self, LockedSherpaRealtimeError> {
        let max_input_bytes = backend.config.max_input_bytes;
        backend.prepare_recognizer().map_err(map_adapter_failure)?;
        Ok(Self {
            backend,
            max_input_bytes,
        })
    }

    #[cfg(test)]
    pub(super) fn from_test_backend(
        backend: SherpaNativeBackend,
    ) -> Result<Self, LockedSherpaRealtimeError> {
        Self::prepare_backend(backend)
    }
}

pub(super) fn locked_zh_cpu_config(
    paths: &LockedSherpaRealtimePaths,
) -> Result<SherpaNativeConfig, LockedSherpaRealtimeError> {
    let asset_paths = [
        &paths.model_path,
        &paths.tokens_path,
        &paths.runtime_lib_dir,
        &paths.asset_lock_path,
        &paths.package_lock_path,
    ];
    if asset_paths
        .iter()
        .any(|path| path.as_os_str().is_empty() || !path.is_absolute())
    {
        return Err(LockedSherpaRealtimeError::InvalidAssetPaths);
    }

    let descriptor = locked_engine_descriptor();
    let config = SherpaNativeConfig {
        expected_model_sha256: descriptor.model_sha256,
        expected_tokens_sha256: locked_digest(LOCKED_TOKENS_SHA256_HEX),
        expected_runtime_sha256: descriptor.runtime_sha256,
        expected_asset_lock_sha256: descriptor.model_manifest_sha256,
        expected_package_lock_sha256: descriptor.package_lock_sha256,
        descriptor,
        model_path: paths.model_path.clone(),
        tokens_path: paths.tokens_path.clone(),
        runtime_lib_dir: paths.runtime_lib_dir.clone(),
        asset_lock_path: paths.asset_lock_path.clone(),
        package_lock_path: paths.package_lock_path.clone(),
        normalized_language: LanguageCode::new("zh")
            .map_err(|_| LockedSherpaRealtimeError::Configuration)?,
        execution_provider: ExecutionProvider::Cpu,
        num_threads: 1,
        use_itn: true,
        max_input_bytes: LOCKED_REALTIME_MAX_PCM16_BYTES,
    };
    if config.descriptor.parameter_sha256 != locked_digest(LOCKED_PARAMETER_SHA256_HEX) {
        return Err(LockedSherpaRealtimeError::Configuration);
    }
    config
        .validate()
        .map_err(|_| LockedSherpaRealtimeError::Configuration)?;
    Ok(config)
}

fn pcm16_payload_bytes(sample_count: usize) -> Result<u64, LockedSherpaRealtimeError> {
    u64::try_from(sample_count)
        .ok()
        .and_then(|count| count.checked_mul(SampleFormat::PcmS16Le.bytes_per_sample()))
        .ok_or(LockedSherpaRealtimeError::SegmentTooLarge)
}

fn pcm16_chunk(
    samples: Arc<[i16]>,
    payload_bytes: u64,
) -> Result<AudioChunk, LockedSherpaRealtimeError> {
    let sample_count =
        u64::try_from(samples.len()).map_err(|_| LockedSherpaRealtimeError::SegmentTooLarge)?;
    let capture_epoch_id = Identifier::new("sherpa-realtime-local-pcm16")
        .map_err(|_| LockedSherpaRealtimeError::Configuration)?;
    let mut hasher = Sha256::new();
    for sample in samples.iter() {
        hasher.update(sample.to_le_bytes());
    }
    let payload_sha256 = Sha256Digest::from_bytes(hasher.finalize().into());

    Ok(AudioChunk {
        sequence: 1,
        media_start_sample: 0,
        media_end_sample: sample_count,
        timeline_rate: LOCKED_REALTIME_SAMPLE_RATE_HZ,
        format: AudioFormat {
            sample_rate_hz: LOCKED_REALTIME_SAMPLE_RATE_HZ,
            channels: REQUIRED_CHANNELS,
            sample_format: SampleFormat::PcmS16Le,
        },
        capture_epoch_ids: vec![capture_epoch_id.clone()],
        source_ranges: vec![SourceRange {
            audio_source: AudioSource::Mixed,
            capture_epoch_id,
            device_start_sample: 0,
            device_end_sample: sample_count,
            meeting_start_sample: 0,
            meeting_end_sample: sample_count,
            sample_rate_hz: LOCKED_REALTIME_SAMPLE_RATE_HZ,
        }],
        payload_bytes,
        payload_sha256: Some(payload_sha256),
        payload: Some(AudioPayload::PcmS16Le(samples)),
    })
}

const fn map_config_error(error: SherpaConfigError) -> LockedSherpaRealtimeError {
    match error {
        SherpaConfigError::NativeFeatureDisabled => {
            LockedSherpaRealtimeError::NativeFeatureDisabled
        }
        SherpaConfigError::EmptyAssetPath => LockedSherpaRealtimeError::InvalidAssetPaths,
        _ => LockedSherpaRealtimeError::Configuration,
    }
}

const fn map_adapter_failure(error: AdapterFailure) -> LockedSherpaRealtimeError {
    match error {
        AdapterFailure::AssetMismatch => LockedSherpaRealtimeError::AssetMismatch,
        AdapterFailure::NotPrepared => LockedSherpaRealtimeError::NotPrepared,
        AdapterFailure::UnsupportedAudio => LockedSherpaRealtimeError::InvalidAudio,
        AdapterFailure::InputTooLarge => LockedSherpaRealtimeError::SegmentTooLarge,
        AdapterFailure::InitFailed => LockedSherpaRealtimeError::Initialization,
        AdapterFailure::ResultUnavailable => LockedSherpaRealtimeError::RecognitionUnavailable,
        AdapterFailure::EmptyResult => LockedSherpaRealtimeError::EmptyTranscript,
    }
}
