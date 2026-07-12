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

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MonotonicDeadline {
    pub clock_domain_id: Identifier,
    pub deadline_ns: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RequestContext {
    pub delivery_session_epoch: Identifier,
    pub message_sequence: u64,
    pub message_id: Identifier,
    pub trace_id: Identifier,
    pub meeting_id: Option<Identifier>,
    pub job_id: Option<Identifier>,
    pub segment_id: Option<Identifier>,
    pub cancel_scope_id: Option<Identifier>,
    pub deadline: MonotonicDeadline,
}

impl RequestContext {
    pub(crate) fn validate_deadline(
        &self,
        now_ns: u64,
        clock_domain_id: &Identifier,
    ) -> Result<(), ContractError> {
        if &self.deadline.clock_domain_id != clock_domain_id {
            return Err(ContractError::ClockDomainMismatch);
        }
        if self.deadline.deadline_ns <= now_ns {
            return Err(ContractError::DeadlineExpired);
        }
        Ok(())
    }

    pub(crate) fn job_key(&self) -> Result<JobKey, ContractError> {
        Ok(JobKey {
            meeting_id: self
                .meeting_id
                .clone()
                .ok_or(ContractError::MissingRequestIdentity)?,
            job_id: self
                .job_id
                .clone()
                .ok_or(ContractError::MissingRequestIdentity)?,
            segment_id: self
                .segment_id
                .clone()
                .ok_or(ContractError::MissingRequestIdentity)?,
        })
    }

    fn has_no_target(&self) -> bool {
        self.meeting_id.is_none()
            && self.job_id.is_none()
            && self.segment_id.is_none()
            && self.cancel_scope_id.is_none()
    }

    fn job_target(&self) -> Result<JobKey, ContractError> {
        if self.cancel_scope_id.is_some() {
            return Err(ContractError::UnexpectedRequestIdentity);
        }
        self.job_key()
    }

    pub(crate) fn cancel_target(&self) -> Result<CancelTarget, ContractError> {
        self.cancel_scope_id
            .as_ref()
            .ok_or(ContractError::MissingRequestIdentity)?;
        match (&self.meeting_id, &self.job_id, &self.segment_id) {
            (Some(meeting_id), Some(job_id), Some(segment_id)) => Ok(CancelTarget::Job(JobKey {
                meeting_id: meeting_id.clone(),
                job_id: job_id.clone(),
                segment_id: segment_id.clone(),
            })),
            (Some(meeting_id), None, None) => Ok(CancelTarget::Meeting(meeting_id.clone())),
            (None, None, None) => Err(ContractError::MissingRequestIdentity),
            _ => Err(ContractError::UnexpectedRequestIdentity),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CancelTarget {
    Job(JobKey),
    Meeting(Identifier),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Cancellation {
    pub scope_id: Identifier,
    pub target: CancelTarget,
    pub reason: CancelReason,
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

impl AudioChunk {
    pub(crate) fn validate(
        &self,
        prior_sequence: Option<u64>,
        prior_media_end_sample: Option<u64>,
        max_audio_chunk_bytes: u64,
        max_capture_epochs_per_chunk: u32,
        max_source_ranges_per_chunk: u32,
    ) -> Result<(), ContractError> {
        self.validate_metadata_bounds(max_capture_epochs_per_chunk, max_source_ranges_per_chunk)?;
        if self.sequence == 0
            || self.payload_bytes == 0
            || self.timeline_rate == 0
            || self.format.sample_rate_hz != self.timeline_rate
            || !(1..=8).contains(&self.format.channels)
        {
            return Err(ContractError::InvalidAudioChunk);
        }
        if self.payload_bytes > max_audio_chunk_bytes {
            return Err(ContractError::AudioChunkTooLarge);
        }
        let payload_sha256 = self
            .payload_sha256
            .ok_or(ContractError::MissingAudioPayloadDigest)?;
        if payload_sha256.is_zero() {
            return Err(ContractError::InvalidAudioPayloadDigest);
        }
        let payload = self
            .payload
            .as_ref()
            .ok_or(ContractError::MissingAudioPayload)?;
        if payload.sample_format() != self.format.sample_format {
            return Err(ContractError::AudioPayloadTypeMismatch);
        }
        if payload.payload_bytes()? != self.payload_bytes {
            return Err(ContractError::AudioPayloadLengthMismatch);
        }
        if self.media_end_sample <= self.media_start_sample {
            return Err(ContractError::InvalidMediaRange);
        }
        match prior_sequence {
            None if self.sequence != 1 => return Err(ContractError::NonContiguousAudioSequence),
            Some(prior) if self.sequence <= prior => {
                return Err(ContractError::NonIncreasingAudioSequence);
            }
            Some(prior) if prior.checked_add(1) != Some(self.sequence) => {
                return Err(ContractError::NonContiguousAudioSequence);
            }
            _ => {}
        }
        if prior_media_end_sample.is_some_and(|prior_end| self.media_start_sample != prior_end) {
            return Err(ContractError::NonContiguousMediaRange);
        }

        let expected_payload_bytes = self
            .media_end_sample
            .checked_sub(self.media_start_sample)
            .and_then(|samples| samples.checked_mul(u64::from(self.format.channels)))
            .and_then(|samples| samples.checked_mul(self.format.sample_format.bytes_per_sample()))
            .ok_or(ContractError::InvalidAudioChunk)?;
        if expected_payload_bytes != self.payload_bytes {
            return Err(ContractError::InvalidAudioChunk);
        }

        if self.capture_epoch_ids.is_empty()
            || self
                .capture_epoch_ids
                .windows(2)
                .any(|pair| pair[0] >= pair[1])
            || self.source_ranges.is_empty()
        {
            return Err(ContractError::InvalidSourceRange);
        }
        let mut covered_epochs = vec![false; self.capture_epoch_ids.len()];
        for range in &self.source_ranges {
            let epoch_index = self
                .capture_epoch_ids
                .binary_search(&range.capture_epoch_id)
                .map_err(|_| ContractError::InvalidSourceRange)?;
            if range.device_end_sample <= range.device_start_sample
                || range.meeting_end_sample <= range.meeting_start_sample
                || range.meeting_start_sample < self.media_start_sample
                || range.meeting_end_sample > self.media_end_sample
                || range.sample_rate_hz == 0
            {
                return Err(ContractError::InvalidSourceRange);
            }
            covered_epochs[epoch_index] = true;
        }
        if covered_epochs.iter().any(|covered| !covered) {
            return Err(ContractError::InvalidSourceRange);
        }
        Ok(())
    }

    fn replay_snapshot(&self) -> Self {
        Self {
            sequence: self.sequence,
            media_start_sample: self.media_start_sample,
            media_end_sample: self.media_end_sample,
            timeline_rate: self.timeline_rate,
            format: self.format,
            capture_epoch_ids: self.capture_epoch_ids.clone(),
            source_ranges: self.source_ranges.clone(),
            payload_bytes: self.payload_bytes,
            payload_sha256: self.payload_sha256,
            payload: None,
        }
    }

    fn semantically_eq(&self, other: &Self) -> bool {
        self.sequence == other.sequence
            && self.media_start_sample == other.media_start_sample
            && self.media_end_sample == other.media_end_sample
            && self.timeline_rate == other.timeline_rate
            && self.format == other.format
            && self.capture_epoch_ids == other.capture_epoch_ids
            && self.source_ranges == other.source_ranges
            && self.payload_bytes == other.payload_bytes
            && self.payload_sha256 == other.payload_sha256
    }

    pub(crate) fn validate_metadata_bounds(
        &self,
        max_capture_epochs_per_chunk: u32,
        max_source_ranges_per_chunk: u32,
    ) -> Result<(), ContractError> {
        let capture_epoch_count = u32::try_from(self.capture_epoch_ids.len())
            .map_err(|_| ContractError::AudioMetadataTooLarge)?;
        let source_range_count = u32::try_from(self.source_ranges.len())
            .map_err(|_| ContractError::AudioMetadataTooLarge)?;
        if capture_epoch_count > max_capture_epochs_per_chunk
            || source_range_count > max_source_ranges_per_chunk
        {
            return Err(ContractError::AudioMetadataTooLarge);
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GapReason {
    CaptureDiscontinuity,
    DeviceSwitch,
    SourceUnavailable,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct AudioGap {
    pub sequence: u64,
    pub media_start_sample: u64,
    pub media_end_sample: u64,
    pub reason: GapReason,
}

impl AudioGap {
    pub(crate) fn validate(
        self,
        prior_sequence: Option<u64>,
        prior_media_end_sample: Option<u64>,
    ) -> Result<(), ContractError> {
        if self.media_end_sample <= self.media_start_sample {
            return Err(ContractError::InvalidMediaRange);
        }
        match prior_sequence {
            None if self.sequence != 1 => return Err(ContractError::NonContiguousAudioSequence),
            Some(prior) if self.sequence <= prior => {
                return Err(ContractError::NonIncreasingAudioSequence);
            }
            Some(prior) if prior.checked_add(1) != Some(self.sequence) => {
                return Err(ContractError::NonContiguousAudioSequence);
            }
            _ => {}
        }
        if prior_media_end_sample.is_some_and(|prior_end| self.media_start_sample != prior_end) {
            return Err(ContractError::NonContiguousMediaRange);
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PrepareRequest {
    pub model_manifest_sha256: Sha256Digest,
    pub execution_provider: ExecutionProvider,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CancelReason {
    UserRequested,
    MeetingEnded,
    DeadlineExceeded,
    Superseded,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ErrorCategory {
    Validation,
    State,
    Capacity,
    Audio,
    Provider,
    Storage,
    Security,
    Model,
    Compatibility,
    Cancelled,
    Internal,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ErrorSeverity {
    Warning,
    Error,
    Critical,
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum RecoveryAction {
    Retry,
    /// Discard the current worker instance/session and construct a fresh backend.
    ///
    /// This is intentionally stronger than [`WorkerCommand::Restart`], which
    /// resynchronizes the existing session and cannot clear backend poison.
    RestartWorker,
    ReprocessAudio,
    ChooseAnotherEngine,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StableWorkerErrorSpec {
    pub code: Identifier,
    pub category: ErrorCategory,
    pub severity: ErrorSeverity,
    pub retryable: bool,
    pub user_message_key: Identifier,
    pub recovery_actions: Vec<RecoveryAction>,
    pub correlation_id: Identifier,
    pub correlation_sequence: u64,
    pub meeting_id: Option<Identifier>,
    pub segment_id: Option<Identifier>,
    pub subsystem: Identifier,
    pub sanitized_detail: Option<SanitizedText>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StableWorkerError {
    code: Identifier,
    category: ErrorCategory,
    severity: ErrorSeverity,
    retryable: bool,
    user_message_key: Identifier,
    recovery_actions: Vec<RecoveryAction>,
    correlation_id: Identifier,
    correlation_sequence: u64,
    meeting_id: Option<Identifier>,
    segment_id: Option<Identifier>,
    subsystem: Identifier,
    sanitized_detail: Option<SanitizedText>,
}

impl StableWorkerError {
    pub fn try_from_spec(spec: StableWorkerErrorSpec) -> Result<Self, ContractError> {
        if spec.correlation_sequence == 0
            || (spec.segment_id.is_some() && spec.meeting_id.is_none())
            || spec.recovery_actions.is_empty()
            || spec
                .recovery_actions
                .windows(2)
                .any(|pair| pair[0] >= pair[1])
        {
            return Err(ContractError::InvalidStableError);
        }
        Ok(Self {
            code: spec.code,
            category: spec.category,
            severity: spec.severity,
            retryable: spec.retryable,
            user_message_key: spec.user_message_key,
            recovery_actions: spec.recovery_actions,
            correlation_id: spec.correlation_id,
            correlation_sequence: spec.correlation_sequence,
            meeting_id: spec.meeting_id,
            segment_id: spec.segment_id,
            subsystem: spec.subsystem,
            sanitized_detail: spec.sanitized_detail,
        })
    }

    #[must_use]
    pub fn code(&self) -> &Identifier {
        &self.code
    }

    #[must_use]
    pub const fn category(&self) -> ErrorCategory {
        self.category
    }

    #[must_use]
    pub const fn severity(&self) -> ErrorSeverity {
        self.severity
    }

    #[must_use]
    pub const fn retryable(&self) -> bool {
        self.retryable
    }

    #[must_use]
    pub fn user_message_key(&self) -> &Identifier {
        &self.user_message_key
    }

    #[must_use]
    pub fn recovery_actions(&self) -> &[RecoveryAction] {
        &self.recovery_actions
    }

    #[must_use]
    pub fn correlation_id(&self) -> &Identifier {
        &self.correlation_id
    }

    #[must_use]
    pub const fn correlation_sequence(&self) -> u64 {
        self.correlation_sequence
    }

    #[must_use]
    pub fn meeting_id(&self) -> Option<&Identifier> {
        self.meeting_id.as_ref()
    }

    #[must_use]
    pub fn segment_id(&self) -> Option<&Identifier> {
        self.segment_id.as_ref()
    }

    #[must_use]
    pub fn subsystem(&self) -> &Identifier {
        &self.subsystem
    }

    #[must_use]
    pub fn sanitized_detail(&self) -> Option<&SanitizedText> {
        self.sanitized_detail.as_ref()
    }
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

impl TranscriptResult {
    pub(crate) fn validate_against(
        &self,
        descriptor: &crate::EngineDescriptor,
        limits: crate::WorkerLimits,
    ) -> Result<(), ContractError> {
        let provenance = &self.provenance;
        if provenance.engine_id != descriptor.engine_id
            || provenance.engine_version != descriptor.engine_version
            || provenance.runtime_id != descriptor.runtime_id
            || provenance.runtime_version != descriptor.runtime_version
            || provenance.runtime_sha256 != descriptor.runtime_sha256
            || provenance.package_lock_sha256 != descriptor.package_lock_sha256
            || provenance.model_id != descriptor.model_id
            || provenance.model_sha256 != descriptor.model_sha256
            || provenance.model_manifest_sha256 != descriptor.model_manifest_sha256
            || provenance.parameter_sha256 != descriptor.parameter_sha256
            || provenance.execution_provider != descriptor.execution_provider
            || provenance.quantization != descriptor.quantization
            || descriptor
                .languages
                .binary_search(&self.normalized_language)
                .is_err()
        {
            return Err(ContractError::InvalidBackendOutcome);
        }
        if self.response_allocation_budget_bytes()? > limits.max_control_message_bytes {
            return Err(ContractError::ControlMessageTooLarge);
        }
        Ok(())
    }

    fn response_allocation_budget_bytes(&self) -> Result<u64, ContractError> {
        // Worst-case response-envelope identifiers, numeric fields, enum tags,
        // optional confidence, and fixed digest storage. Variable result fields
        // are then added exactly without claiming a wire encoding.
        let mut bytes = 1_024_u64;
        add_bytes(
            &mut bytes,
            u64::try_from(self.original_transcript.as_str().len())
                .map_err(|_| ContractError::ControlMessageTooLarge)?,
        )?;
        add_bytes(
            &mut bytes,
            u64::try_from(self.raw_language.as_str().len())
                .map_err(|_| ContractError::ControlMessageTooLarge)?,
        )?;
        add_bytes(
            &mut bytes,
            u64::try_from(self.normalized_language.as_str().len())
                .map_err(|_| ContractError::ControlMessageTooLarge)?,
        )?;
        for identifier in [
            &self.provenance.engine_id,
            &self.provenance.engine_version,
            &self.provenance.runtime_id,
            &self.provenance.runtime_version,
            &self.provenance.model_id,
            &self.provenance.quantization,
        ] {
            add_identifier_bytes(&mut bytes, identifier)?;
        }
        add_bytes(&mut bytes, 5 * 32)?;
        Ok(bytes)
    }
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

#[derive(Debug, Eq, PartialEq)]
struct BackendActionToken(u64);

#[derive(Debug, Eq, PartialEq)]
struct BackendAudioIdentity {
    sequence: u64,
    format: AudioFormat,
    payload_bytes: u64,
    payload_sha256: Sha256Digest,
}

#[derive(Debug, Eq, PartialEq)]
struct BackendBinding {
    token: BackendActionToken,
    delivery_session_epoch: Identifier,
    job: JobKey,
    message_id: Identifier,
    message_sequence: u64,
    audio: Vec<BackendAudioIdentity>,
}

impl BackendBinding {
    fn stamp_outcome(&self) -> Self {
        Self {
            token: BackendActionToken(self.token.0),
            delivery_session_epoch: self.delivery_session_epoch.clone(),
            job: self.job.clone(),
            message_id: self.message_id.clone(),
            message_sequence: self.message_sequence,
            audio: self
                .audio
                .iter()
                .map(|identity| BackendAudioIdentity {
                    sequence: identity.sequence,
                    format: identity.format,
                    payload_bytes: identity.payload_bytes,
                    payload_sha256: identity.payload_sha256,
                })
                .collect(),
        }
    }
}

pub struct BackendAction {
    binding: BackendBinding,
    audio_chunks: Vec<AudioChunk>,
}

impl BackendAction {
    pub(crate) fn new(
        token: u64,
        delivery_session_epoch: Identifier,
        job: JobKey,
        message_id: Identifier,
        message_sequence: u64,
        audio_chunks: Vec<AudioChunk>,
    ) -> Result<Self, ContractError> {
        if token == 0 || message_sequence == 0 || audio_chunks.is_empty() {
            return Err(ContractError::InvalidBackendAction);
        }
        let mut audio = Vec::with_capacity(audio_chunks.len());
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
            audio.push(BackendAudioIdentity {
                sequence: chunk.sequence,
                format: chunk.format,
                payload_bytes: chunk.payload_bytes,
                payload_sha256,
            });
        }
        Ok(Self {
            binding: BackendBinding {
                token: BackendActionToken(token),
                delivery_session_epoch,
                job,
                message_id,
                message_sequence,
                audio,
            },
            audio_chunks,
        })
    }

    #[must_use]
    pub fn job(&self) -> &JobKey {
        &self.binding.job
    }

    #[must_use]
    pub fn delivery_session_epoch(&self) -> &Identifier {
        &self.binding.delivery_session_epoch
    }

    #[must_use]
    pub fn message_id(&self) -> &Identifier {
        &self.binding.message_id
    }

    #[must_use]
    pub const fn message_sequence(&self) -> u64 {
        self.binding.message_sequence
    }

    #[must_use]
    pub fn audio_chunks(&self) -> &[AudioChunk] {
        &self.audio_chunks
    }

    #[must_use]
    pub fn completed(&self, result: TranscriptResult) -> BackendOutcome {
        BackendOutcome {
            binding: self.binding.stamp_outcome(),
            payload: BackendOutcomePayload::Completed(Box::new(result)),
        }
    }

    #[must_use]
    pub fn failed(&self, failure: BackendFailure) -> BackendOutcome {
        BackendOutcome {
            binding: self.binding.stamp_outcome(),
            payload: BackendOutcomePayload::Failed(failure),
        }
    }
}

impl fmt::Debug for BackendAction {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("BackendAction")
            .field(
                "delivery_session_epoch",
                &self.binding.delivery_session_epoch,
            )
            .field("job", &self.binding.job)
            .field("message_id", &self.binding.message_id)
            .field("message_sequence", &self.binding.message_sequence)
            .field("audio", &self.binding.audio)
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Eq, PartialEq)]
pub(crate) enum BackendOutcomePayload {
    Completed(Box<TranscriptResult>),
    Failed(BackendFailure),
}

pub struct BackendOutcome {
    binding: BackendBinding,
    payload: BackendOutcomePayload,
}

impl BackendOutcome {
    pub(crate) fn resolve(
        self,
        action: BackendAction,
    ) -> Result<BackendOutcomePayload, ContractError> {
        if self.binding != action.binding {
            return Err(ContractError::BackendOutcomeBindingMismatch);
        }
        Ok(self.payload)
    }
}

impl fmt::Debug for BackendOutcome {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("BackendOutcome")
            .field("payload", &self.payload)
            .finish_non_exhaustive()
    }
}

pub trait ModelBackend: Send {
    fn prepare(&mut self) -> Result<(), BackendFailure>;

    fn execute(&mut self, action: &BackendAction) -> BackendOutcome;
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum WorkerCommand {
    Describe,
    Prepare(PrepareRequest),
    AcceptAudio(AudioChunk),
    DeclareGap(AudioGap),
    PollEvents,
    FlushSegment,
    Cancel { reason: CancelReason },
    AcknowledgeTerminal,
    PollReplay,
    Restart,
    Health,
    Shutdown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NotCancellableReason {
    AlreadyFinal,
    AlreadyFailed,
    AlreadyCancelled,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ResourceEstimateStatus {
    UnavailableContractFixture,
    Available,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ResourceEstimate {
    resident_memory_bytes: Option<u64>,
    vram_bytes: Option<u64>,
    status: ResourceEstimateStatus,
}

impl ResourceEstimate {
    #[must_use]
    pub const fn unavailable_contract_fixture() -> Self {
        Self {
            resident_memory_bytes: None,
            vram_bytes: None,
            status: ResourceEstimateStatus::UnavailableContractFixture,
        }
    }

    pub fn available(
        resident_memory_bytes: Option<u64>,
        vram_bytes: Option<u64>,
    ) -> Result<Self, ContractError> {
        if resident_memory_bytes.is_some_and(|bytes| bytes == 0)
            || vram_bytes.is_some_and(|bytes| bytes == 0)
            || (resident_memory_bytes.is_none() && vram_bytes.is_none())
        {
            return Err(ContractError::InvalidResourceEstimate);
        }
        Ok(Self {
            resident_memory_bytes,
            vram_bytes,
            status: ResourceEstimateStatus::Available,
        })
    }

    #[must_use]
    pub const fn resident_memory_bytes(self) -> Option<u64> {
        self.resident_memory_bytes
    }

    #[must_use]
    pub const fn vram_bytes(self) -> Option<u64> {
        self.vram_bytes
    }

    #[must_use]
    pub const fn status(self) -> ResourceEstimateStatus {
        self.status
    }

    pub fn validate(self) -> Result<(), ContractError> {
        match self.status {
            ResourceEstimateStatus::UnavailableContractFixture
                if self.resident_memory_bytes.is_none() && self.vram_bytes.is_none() =>
            {
                Ok(())
            }
            ResourceEstimateStatus::Available
                if self.resident_memory_bytes.is_some_and(|bytes| bytes != 0)
                    || self.vram_bytes.is_some_and(|bytes| bytes != 0) =>
            {
                Ok(())
            }
            _ => Err(ContractError::InvalidResourceEstimate),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ReplayJobState {
    Active,
    Final,
    Failure,
    Cancelled { cancellation: Cancellation },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum WorkerEvent {
    Described {
        descriptor: crate::EngineDescriptor,
    },
    Prepared {
        ready: bool,
        execution_provider: ExecutionProvider,
        fallback_nodes: Vec<Identifier>,
        resource_estimate: ResourceEstimate,
    },
    PreparationFailed {
        error: StableWorkerError,
    },
    AudioAccepted {
        sequence: u64,
    },
    GapAccepted {
        sequence: u64,
        media_start_sample: u64,
        media_end_sample: u64,
        reason: GapReason,
    },
    Progress {
        progress_sequence: u64,
        last_audio_sequence: u64,
    },
    Final {
        segment_id: Identifier,
        last_audio_sequence: u64,
        result: TranscriptResult,
    },
    Failure {
        segment_id: Identifier,
        error: StableWorkerError,
    },
    CancelRequested {
        job: JobKey,
        cancel_scope_id: Identifier,
        reason: CancelReason,
        repeated: bool,
    },
    Cancelled {
        job: JobKey,
        cancel_scope_id: Identifier,
        reason: CancelReason,
        repeated: bool,
    },
    NotCancellable {
        job: JobKey,
        cancel_scope_id: Identifier,
        requested_reason: CancelReason,
        reason: NotCancellableReason,
        existing_cancellation: Option<Cancellation>,
    },
    TerminalAcknowledged {
        job: JobKey,
    },
    ReplayRequired {
        job: JobKey,
        state: ReplayJobState,
    },
    ReplayBatchStatus {
        remaining: u32,
    },
    Restarted {
        restart_count: u32,
    },
    Health {
        heartbeat_sequence: u64,
        last_progress_sequence: Option<u64>,
        queue_depth: u32,
        model_ready: bool,
        execution_provider: ExecutionProvider,
        restart_count: u32,
    },
    Heartbeat {
        sequence: u64,
    },
    ShutdownComplete,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkerRequest {
    pub context: RequestContext,
    pub command: WorkerCommand,
}

pub(crate) struct RequestValidation<'a> {
    pub now_ns: u64,
    pub clock_domain_id: &'a Identifier,
    pub delivery_session_epoch: &'a Identifier,
    pub limits: crate::WorkerLimits,
    pub expected_model_manifest_sha256: Sha256Digest,
    pub expected_execution_provider: ExecutionProvider,
    pub prior_sequence: Option<u64>,
    pub prior_media_end_sample: Option<u64>,
}

impl WorkerRequest {
    pub(crate) fn semantically_eq(&self, other: &Self) -> bool {
        self.context.delivery_session_epoch == other.context.delivery_session_epoch
            && self.context.message_sequence == other.context.message_sequence
            && self.context.message_id == other.context.message_id
            && self.context.meeting_id == other.context.meeting_id
            && self.context.job_id == other.context.job_id
            && self.context.segment_id == other.context.segment_id
            && self.context.cancel_scope_id == other.context.cancel_scope_id
            && self.context.deadline.clock_domain_id == other.context.deadline.clock_domain_id
            && match (&self.command, &other.command) {
                (WorkerCommand::AcceptAudio(left), WorkerCommand::AcceptAudio(right)) => {
                    left.semantically_eq(right)
                }
                _ => self.command == other.command,
            }
    }

    pub(crate) fn replay_snapshot(&self) -> Self {
        Self {
            context: self.context.clone(),
            command: match &self.command {
                WorkerCommand::AcceptAudio(chunk) => {
                    WorkerCommand::AcceptAudio(chunk.replay_snapshot())
                }
                command => command.clone(),
            },
        }
    }

    pub(crate) fn validate_static(
        &self,
        delivery_session_epoch: &Identifier,
        limits: crate::WorkerLimits,
    ) -> Result<(), ContractError> {
        if &self.context.delivery_session_epoch != delivery_session_epoch {
            return Err(ContractError::DeliverySessionMismatch);
        }
        if self.context.message_sequence == 0 || self.context.message_sequence == u64::MAX {
            return Err(ContractError::InvalidMessageSequence);
        }
        match &self.command {
            WorkerCommand::Describe
            | WorkerCommand::Prepare(_)
            | WorkerCommand::PollReplay
            | WorkerCommand::Restart
            | WorkerCommand::Health
            | WorkerCommand::Shutdown => {
                if !self.context.has_no_target() {
                    return Err(ContractError::UnexpectedRequestIdentity);
                }
            }
            WorkerCommand::AcceptAudio(chunk) => {
                self.context.job_target()?;
                chunk.validate_metadata_bounds(
                    limits.max_capture_epochs_per_chunk,
                    limits.max_source_ranges_per_chunk,
                )?;
            }
            WorkerCommand::DeclareGap(_)
            | WorkerCommand::PollEvents
            | WorkerCommand::FlushSegment
            | WorkerCommand::AcknowledgeTerminal => {
                self.context.job_target()?;
            }
            WorkerCommand::Cancel { .. } => {
                self.context.cancel_target()?;
            }
        }
        if self.codec_neutral_allocation_budget_bytes()? > limits.max_control_message_bytes {
            return Err(ContractError::ControlMessageTooLarge);
        }
        Ok(())
    }

    pub(crate) fn cancellation(&self) -> Result<Cancellation, ContractError> {
        let WorkerCommand::Cancel { reason } = self.command else {
            return Err(ContractError::UnexpectedRequestIdentity);
        };
        Ok(Cancellation {
            scope_id: self
                .context
                .cancel_scope_id
                .clone()
                .ok_or(ContractError::MissingRequestIdentity)?,
            target: self.context.cancel_target()?,
            reason,
        })
    }

    pub(crate) fn validate(&self, validation: &RequestValidation<'_>) -> Result<(), ContractError> {
        self.validate_static(validation.delivery_session_epoch, validation.limits)?;
        self.context
            .validate_deadline(validation.now_ns, validation.clock_domain_id)?;
        match &self.command {
            WorkerCommand::Describe
            | WorkerCommand::PollReplay
            | WorkerCommand::Restart
            | WorkerCommand::Health
            | WorkerCommand::Shutdown => Ok(()),
            WorkerCommand::Prepare(prepare) => {
                if prepare.model_manifest_sha256 != validation.expected_model_manifest_sha256
                    || prepare.execution_provider != validation.expected_execution_provider
                {
                    return Err(ContractError::PrepareManifestMismatch);
                }
                Ok(())
            }
            WorkerCommand::AcceptAudio(chunk) => chunk.validate(
                validation.prior_sequence,
                validation.prior_media_end_sample,
                validation.limits.max_audio_chunk_bytes,
                validation.limits.max_capture_epochs_per_chunk,
                validation.limits.max_source_ranges_per_chunk,
            ),
            WorkerCommand::DeclareGap(gap) => {
                gap.validate(validation.prior_sequence, validation.prior_media_end_sample)
            }
            WorkerCommand::PollEvents
            | WorkerCommand::FlushSegment
            | WorkerCommand::AcknowledgeTerminal
            | WorkerCommand::Cancel { .. } => Ok(()),
        }
    }

    /// Conservative codec-neutral allocation budget for semantic control metadata.
    ///
    /// This does not claim to be a wire-frame length. A future codec must still
    /// reject oversized frame lengths before allocating or decoding them.
    fn codec_neutral_allocation_budget_bytes(&self) -> Result<u64, ContractError> {
        let mut bytes = 64_u64;
        add_identifier_bytes(&mut bytes, &self.context.delivery_session_epoch)?;
        add_identifier_bytes(&mut bytes, &self.context.message_id)?;
        add_identifier_bytes(&mut bytes, &self.context.trace_id)?;
        add_optional_identifier_bytes(&mut bytes, self.context.meeting_id.as_ref())?;
        add_optional_identifier_bytes(&mut bytes, self.context.job_id.as_ref())?;
        add_optional_identifier_bytes(&mut bytes, self.context.segment_id.as_ref())?;
        add_optional_identifier_bytes(&mut bytes, self.context.cancel_scope_id.as_ref())?;
        add_identifier_bytes(&mut bytes, &self.context.deadline.clock_domain_id)?;
        match &self.command {
            WorkerCommand::Describe
            | WorkerCommand::Restart
            | WorkerCommand::Health
            | WorkerCommand::Shutdown
            | WorkerCommand::PollEvents
            | WorkerCommand::FlushSegment
            | WorkerCommand::AcknowledgeTerminal
            | WorkerCommand::PollReplay
            | WorkerCommand::Cancel { .. } => add_bytes(&mut bytes, 8)?,
            WorkerCommand::Prepare(_) => add_bytes(&mut bytes, 48)?,
            WorkerCommand::DeclareGap(_) => add_bytes(&mut bytes, 40)?,
            WorkerCommand::AcceptAudio(chunk) => {
                add_bytes(&mut bytes, 96)?;
                for epoch_id in &chunk.capture_epoch_ids {
                    add_identifier_bytes(&mut bytes, epoch_id)?;
                }
                for range in &chunk.source_ranges {
                    add_bytes(&mut bytes, 64)?;
                    add_identifier_bytes(&mut bytes, &range.capture_epoch_id)?;
                }
            }
        }
        Ok(bytes)
    }
}

fn add_optional_identifier_bytes(
    total: &mut u64,
    identifier: Option<&Identifier>,
) -> Result<(), ContractError> {
    if let Some(identifier) = identifier {
        add_identifier_bytes(total, identifier)?;
    }
    Ok(())
}

fn add_identifier_bytes(total: &mut u64, identifier: &Identifier) -> Result<(), ContractError> {
    let bytes = u64::try_from(identifier.as_str().len())
        .map_err(|_| ContractError::ControlMessageTooLarge)?;
    add_bytes(total, bytes)
}

fn add_bytes(total: &mut u64, bytes: u64) -> Result<(), ContractError> {
    *total = total
        .checked_add(bytes)
        .ok_or(ContractError::ControlMessageTooLarge)?;
    Ok(())
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkerResponseSpec {
    pub message_id: Identifier,
    pub correlation_id: Identifier,
    pub correlation_sequence: u64,
    pub trace_id: Identifier,
    pub meeting_id: Option<Identifier>,
    pub job_id: Option<Identifier>,
    pub segment_id: Option<Identifier>,
    pub event: WorkerEvent,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkerResponse {
    message_id: Identifier,
    correlation_id: Identifier,
    correlation_sequence: u64,
    trace_id: Identifier,
    meeting_id: Option<Identifier>,
    job_id: Option<Identifier>,
    segment_id: Option<Identifier>,
    event: WorkerEvent,
}

impl WorkerResponse {
    pub fn try_from_spec(
        request: &WorkerRequest,
        expected_descriptor: &crate::EngineDescriptor,
        spec: WorkerResponseSpec,
        limits: crate::WorkerLimits,
    ) -> Result<Self, ContractError> {
        let response = Self {
            message_id: spec.message_id,
            correlation_id: spec.correlation_id,
            correlation_sequence: spec.correlation_sequence,
            trace_id: spec.trace_id,
            meeting_id: spec.meeting_id,
            job_id: spec.job_id,
            segment_id: spec.segment_id,
            event: spec.event,
        };
        response.validate(request, expected_descriptor, limits)?;
        Ok(response)
    }

    pub fn for_request(
        message_id: Identifier,
        request: &WorkerRequest,
        expected_descriptor: &crate::EngineDescriptor,
        event: WorkerEvent,
        limits: crate::WorkerLimits,
    ) -> Result<Self, ContractError> {
        let context = &request.context;
        Self::try_from_spec(
            request,
            expected_descriptor,
            WorkerResponseSpec {
                message_id,
                correlation_id: context.message_id.clone(),
                correlation_sequence: context.message_sequence,
                trace_id: context.trace_id.clone(),
                meeting_id: context.meeting_id.clone(),
                job_id: context.job_id.clone(),
                segment_id: context.segment_id.clone(),
                event,
            },
            limits,
        )
    }

    pub fn validate(
        &self,
        request: &WorkerRequest,
        expected_descriptor: &crate::EngineDescriptor,
        limits: crate::WorkerLimits,
    ) -> Result<(), ContractError> {
        limits.validate()?;
        if expected_descriptor.validate().is_err()
            || self.correlation_sequence == 0
            || !self.has_valid_target_shape()
            || !self.envelope_matches(request)
        {
            return Err(ContractError::InvalidWorkerResponse);
        }

        if self.event_matches_request(request, expected_descriptor, limits) {
            Ok(())
        } else {
            Err(ContractError::InvalidWorkerResponse)
        }
    }

    #[must_use]
    pub fn message_id(&self) -> &Identifier {
        &self.message_id
    }

    #[must_use]
    pub fn correlation_id(&self) -> &Identifier {
        &self.correlation_id
    }

    #[must_use]
    pub const fn correlation_sequence(&self) -> u64 {
        self.correlation_sequence
    }

    #[must_use]
    pub fn trace_id(&self) -> &Identifier {
        &self.trace_id
    }

    #[must_use]
    pub fn meeting_id(&self) -> Option<&Identifier> {
        self.meeting_id.as_ref()
    }

    #[must_use]
    pub fn job_id(&self) -> Option<&Identifier> {
        self.job_id.as_ref()
    }

    #[must_use]
    pub fn segment_id(&self) -> Option<&Identifier> {
        self.segment_id.as_ref()
    }

    #[must_use]
    pub const fn event(&self) -> &WorkerEvent {
        &self.event
    }

    #[must_use]
    pub fn into_spec(self) -> WorkerResponseSpec {
        WorkerResponseSpec {
            message_id: self.message_id,
            correlation_id: self.correlation_id,
            correlation_sequence: self.correlation_sequence,
            trace_id: self.trace_id,
            meeting_id: self.meeting_id,
            job_id: self.job_id,
            segment_id: self.segment_id,
            event: self.event,
        }
    }

    fn envelope_matches(&self, request: &WorkerRequest) -> bool {
        self.correlation_id == request.context.message_id
            && self.correlation_sequence == request.context.message_sequence
            && self.trace_id == request.context.trace_id
            && self.meeting_id == request.context.meeting_id
            && self.job_id == request.context.job_id
            && self.segment_id == request.context.segment_id
    }

    fn event_matches_request(
        &self,
        request: &WorkerRequest,
        expected_descriptor: &crate::EngineDescriptor,
        limits: crate::WorkerLimits,
    ) -> bool {
        match (&request.command, &self.event) {
            (WorkerCommand::Describe, WorkerEvent::Described { descriptor }) => {
                self.has_no_target()
                    && descriptor == expected_descriptor
                    && descriptor.validate().is_ok()
            }
            (
                WorkerCommand::Prepare(prepare),
                WorkerEvent::Prepared {
                    ready,
                    execution_provider,
                    fallback_nodes,
                    resource_estimate,
                },
            ) => {
                self.has_no_target()
                    && *ready
                    && *execution_provider == prepare.execution_provider
                    && *execution_provider == expected_descriptor.execution_provider
                    && fallback_nodes.len() <= limits.max_fallback_nodes as usize
                    && !fallback_nodes.windows(2).any(|pair| pair[0] >= pair[1])
                    && resource_estimate.validate().is_ok()
            }
            (WorkerCommand::Prepare(_), WorkerEvent::PreparationFailed { error }) => {
                self.valid_preparation_failure(error)
            }
            (WorkerCommand::AcceptAudio(chunk), WorkerEvent::AudioAccepted { sequence }) => {
                self.has_job_target() && *sequence != 0 && *sequence == chunk.sequence
            }
            (
                WorkerCommand::DeclareGap(gap),
                WorkerEvent::GapAccepted {
                    sequence,
                    media_start_sample,
                    media_end_sample,
                    reason,
                },
            ) => {
                self.has_job_target()
                    && *sequence != 0
                    && *sequence == gap.sequence
                    && *media_start_sample == gap.media_start_sample
                    && *media_end_sample == gap.media_end_sample
                    && media_end_sample > media_start_sample
                    && *reason == gap.reason
            }
            (
                WorkerCommand::PollEvents,
                WorkerEvent::Progress {
                    progress_sequence,
                    last_audio_sequence,
                },
            ) => self.has_job_target() && *progress_sequence != 0 && *last_audio_sequence != 0,
            (
                WorkerCommand::FlushSegment,
                WorkerEvent::Final {
                    segment_id,
                    last_audio_sequence,
                    result,
                },
            ) => {
                self.has_job_target()
                    && *last_audio_sequence != 0
                    && self.segment_id.as_ref() == Some(segment_id)
                    && result.validate_against(expected_descriptor, limits).is_ok()
            }
            (WorkerCommand::FlushSegment, WorkerEvent::Failure { segment_id, error }) => {
                self.valid_failure(segment_id, error)
            }
            (
                WorkerCommand::Cancel { reason },
                WorkerEvent::CancelRequested {
                    job,
                    cancel_scope_id,
                    reason: event_reason,
                    ..
                }
                | WorkerEvent::Cancelled {
                    job,
                    cancel_scope_id,
                    reason: event_reason,
                    ..
                },
            ) => request.cancellation().is_ok_and(|cancellation| {
                cancellation.scope_id == *cancel_scope_id
                    && cancellation.reason == *reason
                    && *event_reason == *reason
                    && cancellation_targets_job(&cancellation, job)
            }),
            (
                WorkerCommand::Cancel { reason },
                WorkerEvent::NotCancellable {
                    job,
                    cancel_scope_id,
                    requested_reason,
                    reason: not_cancellable_reason,
                    existing_cancellation,
                },
            ) => request.cancellation().is_ok_and(|cancellation| {
                cancellation.scope_id == *cancel_scope_id
                    && cancellation.reason == *reason
                    && *requested_reason == *reason
                    && cancellation_targets_job(&cancellation, job)
                    && match (not_cancellable_reason, existing_cancellation) {
                        (NotCancellableReason::AlreadyCancelled, Some(existing_cancellation)) => {
                            existing_cancellation.scope_id != cancellation.scope_id
                                && cancellation_targets_job(existing_cancellation, job)
                        }
                        (
                            NotCancellableReason::AlreadyFinal
                            | NotCancellableReason::AlreadyFailed,
                            None,
                        ) => true,
                        _ => false,
                    }
            }),
            (WorkerCommand::AcknowledgeTerminal, WorkerEvent::TerminalAcknowledged { job }) => {
                self.has_job_target() && self.targets_exact_job(job)
            }
            (
                WorkerCommand::PollReplay | WorkerCommand::Restart | WorkerCommand::Shutdown,
                WorkerEvent::ReplayRequired { job, state },
            ) => {
                self.has_no_target()
                    && match state {
                        ReplayJobState::Cancelled { cancellation } => {
                            cancellation_targets_job(cancellation, job)
                        }
                        ReplayJobState::Active
                        | ReplayJobState::Final
                        | ReplayJobState::Failure => true,
                    }
            }
            (
                WorkerCommand::PollReplay | WorkerCommand::Restart | WorkerCommand::Shutdown,
                WorkerEvent::ReplayBatchStatus { remaining },
            ) => self.has_no_target() && *remaining != 0 && *remaining <= limits.max_tracked_jobs,
            (WorkerCommand::Restart, WorkerEvent::Restarted { restart_count }) => {
                self.has_no_target() && *restart_count != 0
            }
            (
                WorkerCommand::Health,
                WorkerEvent::Health {
                    last_progress_sequence,
                    queue_depth,
                    execution_provider,
                    ..
                },
            ) => {
                self.has_no_target()
                    && *queue_depth < limits.max_pending_commands
                    && last_progress_sequence.is_none_or(|sequence| sequence != 0)
                    && *execution_provider == expected_descriptor.execution_provider
            }
            (
                WorkerCommand::Shutdown | WorkerCommand::PollReplay,
                WorkerEvent::ShutdownComplete,
            ) => self.has_no_target(),
            (_, WorkerEvent::Heartbeat { .. }) => false,
            _ => false,
        }
    }

    fn valid_failure(&self, segment_id: &Identifier, error: &StableWorkerError) -> bool {
        self.has_job_target()
            && self.segment_id.as_ref() == Some(segment_id)
            && error.correlation_id() == &self.correlation_id
            && error.correlation_sequence() == self.correlation_sequence
            && error.meeting_id() == self.meeting_id.as_ref()
            && error.segment_id() == self.segment_id.as_ref()
    }

    fn valid_preparation_failure(&self, error: &StableWorkerError) -> bool {
        let recovery_matches_retryability = if error.retryable() {
            error.recovery_actions()
                == [
                    RecoveryAction::Retry,
                    RecoveryAction::RestartWorker,
                    RecoveryAction::ChooseAnotherEngine,
                ]
        } else {
            error.recovery_actions()
                == [
                    RecoveryAction::RestartWorker,
                    RecoveryAction::ChooseAnotherEngine,
                ]
        };
        self.has_no_target()
            && error.category() == ErrorCategory::Model
            && error.severity() == ErrorSeverity::Error
            && error.user_message_key().as_str() == "model.backend_failure"
            && error.subsystem().as_str() == "model-worker"
            && recovery_matches_retryability
            && error.correlation_id() == &self.correlation_id
            && error.correlation_sequence() == self.correlation_sequence
            && error.meeting_id().is_none()
            && error.segment_id().is_none()
    }

    fn has_valid_target_shape(&self) -> bool {
        matches!(
            (&self.meeting_id, &self.job_id, &self.segment_id),
            (None, None, None) | (Some(_), None, None) | (Some(_), Some(_), Some(_))
        )
    }

    fn has_no_target(&self) -> bool {
        self.meeting_id.is_none() && self.job_id.is_none() && self.segment_id.is_none()
    }

    fn has_job_target(&self) -> bool {
        self.meeting_id.is_some() && self.job_id.is_some() && self.segment_id.is_some()
    }

    fn targets_exact_job(&self, job: &JobKey) -> bool {
        self.meeting_id.as_ref() == Some(&job.meeting_id)
            && self.job_id.as_ref() == Some(&job.job_id)
            && self.segment_id.as_ref() == Some(&job.segment_id)
    }
}

fn cancellation_targets_job(cancellation: &Cancellation, job: &JobKey) -> bool {
    match &cancellation.target {
        CancelTarget::Job(target) => target == job,
        CancelTarget::Meeting(meeting_id) => meeting_id == &job.meeting_id,
    }
}
