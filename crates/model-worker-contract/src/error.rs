use core::fmt;

use crate::Capability;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ContractError {
    InvalidIdentifier,
    InvalidLanguageCode,
    InvalidSanitizedText,
    InvalidTranscriptText,
    InvalidSha256,
    InvalidProtocolVersion,
    ProtocolMismatch,
    UnsafeMinorVersion,
    PlatformMismatch,
    RoleMismatch,
    RolePurposeMismatch,
    ContractFixtureRequired,
    TransportRoleMismatch,
    WorkerIdMismatch,
    WorkerBuildDigestMismatch,
    ExecutableDigestMismatch,
    SchemaRegistryDigestMismatch,
    EngineIdentityMismatch,
    RuntimeDigestMismatch,
    PackageLockDigestMismatch,
    ModelDigestMismatch,
    ModelManifestDigestMismatch,
    ParameterDigestMismatch,
    ModelLicenseMismatch,
    ExecutionProviderMismatch,
    QuantizationMismatch,
    LanguageMismatch,
    LanguageListTooLarge,
    StreamingRequired,
    OfflineRequired,
    NetworkPolicyMismatch,
    SilentCloudFallbackForbidden,
    MissingCapability(Capability),
    InvalidWorkerLimits,
    NegotiatedLimitExceedsOffer,
    UnknownExecutionProvider,
    UnknownCapability,
    UnknownWorkerRole,
    UnsupportedOperatingSystem,
    UnsupportedArchitecture,
    UnknownTransportKind,
    TransportNotHandshaken,
    MissingRequestIdentity,
    UnexpectedRequestIdentity,
    DeliverySessionMismatch,
    InvalidMessageSequence,
    MessageSequenceOutOfOrder,
    ReplayWindowExpired,
    ReplayBatchPending,
    ClockDomainMismatch,
    ClockAdvanceWithPending,
    ClockRollback,
    PrepareManifestMismatch,
    MessageIdConflict,
    InvalidStableError,
    InvalidWorkerResponse,
    InvalidResourceEstimate,
    NotPrepared,
    AudioChunkTooLarge,
    MissingAudioPayload,
    MissingAudioPayloadDigest,
    InvalidAudioPayloadDigest,
    AudioPayloadTypeMismatch,
    AudioPayloadLengthMismatch,
    PendingAudioCreditExhausted,
    ControlMessageTooLarge,
    AudioMetadataTooLarge,
    CancellationBatchTooLarge,
    NoActiveJobs,
    CancellationRegistryFull,
    InvalidAudioChunk,
    InvalidMediaRange,
    NonIncreasingAudioSequence,
    NonContiguousAudioSequence,
    NonContiguousMediaRange,
    InvalidSourceRange,
    QueueFull,
    JobCapacityFull,
    RetiredJobKeyCapacityFull,
    ResponseQueueFull,
    JobNotTerminal,
    TerminalAlreadyEmitted,
    JobIdentityRetired,
    CancelScopeConflict,
    Cancelled,
    DeadlineExpired,
    InvalidConfidence,
    InvalidBackendAction,
    BackendActionInFlight,
    BackendOutcomeBindingMismatch,
    InvalidBackendOutcome,
    BackendFailure,
    ShutdownDraining,
    Shutdown,
    QueueInvariant,
}

impl fmt::Display for ContractError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MissingCapability(capability) => {
                write!(
                    formatter,
                    "required capability {} is missing",
                    capability.as_str()
                )
            }
            _ => formatter.write_str(match self {
                Self::InvalidIdentifier => "identifier is not valid contract ASCII",
                Self::InvalidLanguageCode => "language code is invalid",
                Self::InvalidSanitizedText => {
                    "sanitized detail must be bounded printable text without controls"
                }
                Self::InvalidTranscriptText => {
                    "transcript text must be non-empty and within its explicit byte bound"
                }
                Self::InvalidSha256 => "SHA-256 must be 64 lowercase hexadecimal characters",
                Self::InvalidProtocolVersion => "protocol version is not supported",
                Self::ProtocolMismatch => "worker protocol version differs",
                Self::UnsafeMinorVersion => {
                    "worker minor version requires unsupported semantic changes"
                }
                Self::PlatformMismatch => "worker platform differs",
                Self::RoleMismatch => "worker role differs",
                Self::RolePurposeMismatch => "worker role cannot serve the requested purpose",
                Self::ContractFixtureRequired => {
                    "deterministic fixture oracle requires contract-fixture purpose and role"
                }
                Self::TransportRoleMismatch => "worker role cannot use this process boundary",
                Self::WorkerIdMismatch => "worker identity differs",
                Self::WorkerBuildDigestMismatch => "worker build digest differs",
                Self::ExecutableDigestMismatch => "worker executable digest differs",
                Self::SchemaRegistryDigestMismatch => "schema registry digest differs",
                Self::EngineIdentityMismatch => "engine or runtime identity differs",
                Self::RuntimeDigestMismatch => "runtime digest differs",
                Self::PackageLockDigestMismatch => "package lock digest differs",
                Self::ModelDigestMismatch => "model digest differs",
                Self::ModelManifestDigestMismatch => "model manifest digest differs",
                Self::ParameterDigestMismatch => "parameter digest differs",
                Self::ModelLicenseMismatch => "model license identity differs",
                Self::ExecutionProviderMismatch => "execution provider differs",
                Self::QuantizationMismatch => "quantization identity differs",
                Self::LanguageMismatch => "language capability differs",
                Self::LanguageListTooLarge => {
                    "engine language capability list exceeds the fixed contract bound"
                }
                Self::StreamingRequired => "streaming capability is required",
                Self::OfflineRequired => "offline operation is required",
                Self::NetworkPolicyMismatch => "network policy differs",
                Self::SilentCloudFallbackForbidden => "silent cloud fallback is forbidden",
                Self::InvalidWorkerLimits => "worker limits are invalid",
                Self::NegotiatedLimitExceedsOffer => "negotiated worker limit exceeds the offer",
                Self::UnknownExecutionProvider => "execution provider is unknown",
                Self::UnknownCapability => "worker capability is unknown",
                Self::UnknownWorkerRole => "worker role is unknown",
                Self::UnsupportedOperatingSystem => "operating system is unsupported",
                Self::UnsupportedArchitecture => "architecture is unsupported",
                Self::UnknownTransportKind => "transport kind is unknown",
                Self::TransportNotHandshaken => "worker transport has not completed handshake",
                Self::MissingRequestIdentity => {
                    "worker request is missing its meeting, job, segment, or cancel identity"
                }
                Self::UnexpectedRequestIdentity => {
                    "worker request carries identity fields forbidden for this command target"
                }
                Self::DeliverySessionMismatch => {
                    "worker request belongs to a different delivery session"
                }
                Self::InvalidMessageSequence => "message sequence must start at one",
                Self::MessageSequenceOutOfOrder => {
                    "message sequence is not the next request or a retained replay"
                }
                Self::ReplayWindowExpired => {
                    "message sequence is older than the retained replay window"
                }
                Self::ReplayBatchPending => {
                    "prior restart or shutdown replay facts must be drained first"
                }
                Self::ClockDomainMismatch => "request deadline uses a different clock domain",
                Self::ClockAdvanceWithPending => {
                    "fake clock cannot advance while accepted commands are pending"
                }
                Self::ClockRollback => "fake monotonic clock cannot move backwards",
                Self::PrepareManifestMismatch => {
                    "prepare request differs from the handshaken model manifest"
                }
                Self::MessageIdConflict => {
                    "message identifier was already used for a different semantic request"
                }
                Self::InvalidStableError => "stable worker error is incomplete or ambiguous",
                Self::InvalidWorkerResponse => {
                    "worker response envelope and event provenance are inconsistent"
                }
                Self::InvalidResourceEstimate => {
                    "resource estimate status and measurements are inconsistent"
                }
                Self::NotPrepared => "worker is not prepared",
                Self::AudioChunkTooLarge => "audio chunk exceeds the negotiated limit",
                Self::MissingAudioPayload => "audio chunk is missing its owned PCM payload",
                Self::MissingAudioPayloadDigest => {
                    "audio chunk is missing its caller-provided payload digest"
                }
                Self::InvalidAudioPayloadDigest => {
                    "audio chunk payload digest cannot be the all-zero digest"
                }
                Self::AudioPayloadTypeMismatch => {
                    "audio payload representation differs from its declared sample format"
                }
                Self::AudioPayloadLengthMismatch => {
                    "audio payload length differs from its declared media range"
                }
                Self::PendingAudioCreditExhausted => {
                    "aggregate pending audio exceeds the negotiated credit"
                }
                Self::ControlMessageTooLarge => {
                    "semantic control envelope exceeds the negotiated limit"
                }
                Self::AudioMetadataTooLarge => "audio metadata count exceeds the negotiated limit",
                Self::CancellationBatchTooLarge => {
                    "meeting cancellation snapshot exceeds the negotiated batch limit"
                }
                Self::NoActiveJobs => "meeting cancellation target has no active jobs",
                Self::CancellationRegistryFull => {
                    "cancellation scope registry reached its negotiated limit"
                }
                Self::InvalidAudioChunk => "audio chunk is empty or malformed",
                Self::InvalidMediaRange => "audio media range is invalid",
                Self::NonIncreasingAudioSequence => "audio sequence must strictly increase",
                Self::NonContiguousAudioSequence => {
                    "audio sequence gap requires an explicit gap fact"
                }
                Self::NonContiguousMediaRange => {
                    "audio media range must continue from the prior accepted boundary"
                }
                Self::InvalidSourceRange => "audio source range or capture epoch is invalid",
                Self::QueueFull => "worker command queue has no remaining credit",
                Self::JobCapacityFull => "worker job tracking capacity is exhausted",
                Self::RetiredJobKeyCapacityFull => {
                    "retired job identity registry reached its negotiated limit"
                }
                Self::ResponseQueueFull => "worker response delivery queue has no remaining credit",
                Self::JobNotTerminal => "job terminal state cannot be acknowledged yet",
                Self::TerminalAlreadyEmitted => "segment already has a terminal result",
                Self::JobIdentityRetired => "job identity was retired and cannot be reused",
                Self::CancelScopeConflict => {
                    "a different cancel scope already owns this job cancellation"
                }
                Self::Cancelled => "worker operation was cancelled",
                Self::DeadlineExpired => "request deadline has expired",
                Self::InvalidConfidence => {
                    "fixed-point confidence exceeds one million parts per million"
                }
                Self::InvalidBackendAction => {
                    "backend action is empty or has inconsistent semantic identity"
                }
                Self::BackendActionInFlight => {
                    "a backend action is already in flight for this worker session"
                }
                Self::BackendOutcomeBindingMismatch => {
                    "backend outcome does not belong to the consumed backend action"
                }
                Self::InvalidBackendOutcome => {
                    "backend outcome conflicts with the negotiated engine contract"
                }
                Self::BackendFailure => "model backend reported a stable execution failure",
                Self::ShutdownDraining => {
                    "worker shutdown is draining replay facts; only replay polling is accepted"
                }
                Self::Shutdown => "worker is already shut down",
                Self::QueueInvariant => "in-memory transport queue invariant failed",
                Self::MissingCapability(_) => unreachable!(),
            }),
        }
    }
}

impl std::error::Error for ContractError {}

impl ContractError {
    /// Whether an already classified new request reserves its delivery sequence.
    /// Admission, envelope, deadline, lifecycle, and transport-credit failures do not.
    #[must_use]
    pub const fn consumes_message_sequence(self) -> bool {
        !matches!(
            self,
            Self::TransportNotHandshaken
                | Self::MissingRequestIdentity
                | Self::UnexpectedRequestIdentity
                | Self::DeliverySessionMismatch
                | Self::InvalidMessageSequence
                | Self::MessageSequenceOutOfOrder
                | Self::ReplayWindowExpired
                | Self::ReplayBatchPending
                | Self::MessageIdConflict
                | Self::ClockDomainMismatch
                | Self::ClockAdvanceWithPending
                | Self::ClockRollback
                | Self::DeadlineExpired
                | Self::MissingAudioPayload
                | Self::MissingAudioPayloadDigest
                | Self::InvalidAudioPayloadDigest
                | Self::AudioPayloadTypeMismatch
                | Self::AudioPayloadLengthMismatch
                | Self::ControlMessageTooLarge
                | Self::AudioMetadataTooLarge
                | Self::PendingAudioCreditExhausted
                | Self::QueueFull
                | Self::RetiredJobKeyCapacityFull
                | Self::ResponseQueueFull
                | Self::BackendActionInFlight
                | Self::ShutdownDraining
                | Self::Shutdown
        )
    }
}
