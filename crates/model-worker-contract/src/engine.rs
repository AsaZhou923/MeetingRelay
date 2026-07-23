use core::fmt;
use std::sync::Arc;

use crate::{
    ContractError, ExecutionProvider, Identifier, LanguageCode, SanitizedText, Sha256Digest,
};

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct JobKey {
    pub meeting_id: Identifier,
    pub job_id: Identifier,
    pub segment_id: Identifier,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AudioSource {
    System,
    Microphone,
    Mixed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SampleFormat {
    PcmS16Le,
    PcmF32Le,
}

impl SampleFormat {
    #[must_use]
    pub const fn bytes_per_sample(self) -> u64 {
        match self {
            Self::PcmS16Le => 2,
            Self::PcmF32Le => 4,
        }
    }
}

#[derive(Clone)]
pub enum AudioPayload {
    PcmS16Le(Arc<[i16]>),
    PcmF32Le(Arc<[f32]>),
}

impl AudioPayload {
    #[must_use]
    pub const fn sample_format(&self) -> SampleFormat {
        match self {
            Self::PcmS16Le(_) => SampleFormat::PcmS16Le,
            Self::PcmF32Le(_) => SampleFormat::PcmF32Le,
        }
    }

    #[must_use]
    pub fn sample_count(&self) -> usize {
        match self {
            Self::PcmS16Le(samples) => samples.len(),
            Self::PcmF32Le(samples) => samples.len(),
        }
    }

    pub fn payload_bytes(&self) -> Result<u64, ContractError> {
        u64::try_from(self.sample_count())
            .ok()
            .and_then(|samples| samples.checked_mul(self.sample_format().bytes_per_sample()))
            .ok_or(ContractError::AudioPayloadLengthMismatch)
    }

    #[must_use]
    pub fn pcm_s16_le(&self) -> Option<&[i16]> {
        match self {
            Self::PcmS16Le(samples) => Some(samples),
            Self::PcmF32Le(_) => None,
        }
    }

    #[must_use]
    pub fn pcm_f32_le(&self) -> Option<&[f32]> {
        match self {
            Self::PcmS16Le(_) => None,
            Self::PcmF32Le(samples) => Some(samples),
        }
    }
}

impl fmt::Debug for AudioPayload {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct(match self {
                Self::PcmS16Le(_) => "PcmS16Le",
                Self::PcmF32Le(_) => "PcmF32Le",
            })
            .field("sample_count", &self.sample_count())
            .finish_non_exhaustive()
    }
}

impl PartialEq for AudioPayload {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::PcmS16Le(left), Self::PcmS16Le(right)) => left == right,
            (Self::PcmF32Le(left), Self::PcmF32Le(right)) => {
                left.len() == right.len()
                    && left
                        .iter()
                        .zip(right.iter())
                        .all(|(left, right)| left.to_bits() == right.to_bits())
            }
            (Self::PcmS16Le(_), Self::PcmF32Le(_)) | (Self::PcmF32Le(_), Self::PcmS16Le(_)) => {
                false
            }
        }
    }
}

impl Eq for AudioPayload {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct AudioFormat {
    pub sample_rate_hz: u32,
    pub channels: u16,
    pub sample_format: SampleFormat,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SourceRange {
    pub audio_source: AudioSource,
    pub capture_epoch_id: Identifier,
    pub device_start_sample: u64,
    pub device_end_sample: u64,
    pub meeting_start_sample: u64,
    pub meeting_end_sample: u64,
    pub sample_rate_hz: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AudioChunk {
    pub sequence: u64,
    pub media_start_sample: u64,
    pub media_end_sample: u64,
    pub timeline_rate: u32,
    pub format: AudioFormat,
    pub capture_epoch_ids: Vec<Identifier>,
    pub source_ranges: Vec<SourceRange>,
    pub payload_bytes: u64,
    pub payload_sha256: Option<Sha256Digest>,
    pub payload: Option<AudioPayload>,
}

#[derive(Clone, Eq, PartialEq)]
pub struct TranscriptText(String);

impl TranscriptText {
    pub const MAX_BYTES: usize = 1_048_576;

    pub fn new(value: &str) -> Result<Self, ContractError> {
        if value.is_empty() || value.len() > Self::MAX_BYTES {
            return Err(ContractError::InvalidTranscriptText);
        }
        Ok(Self(value.to_owned()))
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for TranscriptText {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TranscriptText")
            .field("byte_len", &self.0.len())
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct FixedPointConfidence(u32);

impl FixedPointConfidence {
    pub const PARTS_PER_MILLION: u32 = 1_000_000;

    pub const fn from_parts_per_million(value: u32) -> Result<Self, ContractError> {
        if value <= Self::PARTS_PER_MILLION {
            Ok(Self(value))
        } else {
            Err(ContractError::InvalidConfidence)
        }
    }

    #[must_use]
    pub const fn parts_per_million(self) -> u32 {
        self.0
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TranscriptProvenance {
    pub engine_id: Identifier,
    pub engine_version: Identifier,
    pub runtime_id: Identifier,
    pub runtime_version: Identifier,
    pub runtime_sha256: Sha256Digest,
    pub package_lock_sha256: Sha256Digest,
    pub model_id: Identifier,
    pub model_sha256: Sha256Digest,
    pub model_manifest_sha256: Sha256Digest,
    pub parameter_sha256: Sha256Digest,
    pub execution_provider: ExecutionProvider,
    pub quantization: Identifier,
}

impl TranscriptProvenance {
    #[must_use]
    pub fn from_descriptor(descriptor: &crate::EngineDescriptor) -> Self {
        Self {
            engine_id: descriptor.engine_id.clone(),
            engine_version: descriptor.engine_version.clone(),
            runtime_id: descriptor.runtime_id.clone(),
            runtime_version: descriptor.runtime_version.clone(),
            runtime_sha256: descriptor.runtime_sha256,
            package_lock_sha256: descriptor.package_lock_sha256,
            model_id: descriptor.model_id.clone(),
            model_sha256: descriptor.model_sha256,
            model_manifest_sha256: descriptor.model_manifest_sha256,
            parameter_sha256: descriptor.parameter_sha256,
            execution_provider: descriptor.execution_provider,
            quantization: descriptor.quantization.clone(),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TranscriptResult {
    pub original_transcript: TranscriptText,
    pub raw_language: SanitizedText,
    pub normalized_language: LanguageCode,
    pub confidence: Option<FixedPointConfidence>,
    pub provenance: TranscriptProvenance,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BackendFailure {
    pub code: Identifier,
    pub retryable: bool,
    pub sanitized_detail: Option<SanitizedText>,
}

impl BackendFailure {
    #[must_use]
    pub const fn new(
        code: Identifier,
        retryable: bool,
        sanitized_detail: Option<SanitizedText>,
    ) -> Self {
        Self {
            code,
            retryable,
            sanitized_detail,
        }
    }
}

#[derive(Debug)]
pub struct BackendAction {
    job: Option<JobKey>,
    audio_chunks: Vec<AudioChunk>,
}

impl BackendAction {
    pub fn new(audio_chunks: Vec<AudioChunk>) -> Result<Self, ContractError> {
        if audio_chunks.is_empty() {
            return Err(ContractError::InvalidBackendAction);
        }
        for chunk in &audio_chunks {
            let payload_sha256 = chunk
                .payload_sha256
                .ok_or(ContractError::InvalidBackendAction)?;
            let payload = chunk
                .payload
                .as_ref()
                .ok_or(ContractError::InvalidBackendAction)?;
            if payload_sha256.is_zero()
                || payload.sample_format() != chunk.format.sample_format
                || payload.payload_bytes()? != chunk.payload_bytes
            {
                return Err(ContractError::InvalidBackendAction);
            }
        }
        Ok(Self {
            job: None,
            audio_chunks,
        })
    }

    pub fn with_job(job: JobKey, audio_chunks: Vec<AudioChunk>) -> Result<Self, ContractError> {
        let mut action = Self::new(audio_chunks)?;
        action.job = Some(job);
        Ok(action)
    }

    #[must_use]
    pub fn job(&self) -> Option<&JobKey> {
        self.job.as_ref()
    }

    #[must_use]
    pub fn audio_chunks(&self) -> &[AudioChunk] {
        &self.audio_chunks
    }

    #[must_use]
    pub fn completed(&self, result: TranscriptResult) -> BackendOutcome {
        BackendOutcome::Completed(Box::new(result))
    }

    #[must_use]
    pub fn failed(&self, failure: BackendFailure) -> BackendOutcome {
        BackendOutcome::Failed(failure)
    }
}

#[derive(Debug, Eq, PartialEq)]
pub enum BackendOutcome {
    Completed(Box<TranscriptResult>),
    Failed(BackendFailure),
}

pub trait ModelBackend: Send {
    fn prepare(&mut self) -> Result<(), BackendFailure>;

    fn execute(&mut self, action: &BackendAction) -> BackendOutcome;
}
