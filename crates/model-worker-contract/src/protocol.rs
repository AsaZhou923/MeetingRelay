use crate::{ContractError, Identifier, LanguageCode, Sha256Digest};

pub const WORKER_PROTOCOL_NAME: &str = "meetingrelay.model-worker";
pub const WORKER_PROTOCOL_V1: WorkerProtocolVersion = WorkerProtocolVersion { major: 1, minor: 0 };

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct WorkerProtocolVersion {
    pub major: u16,
    pub minor: u16,
}

impl WorkerProtocolVersion {
    fn validate_core_offer(self) -> Result<(), ContractError> {
        if self == WORKER_PROTOCOL_V1 {
            Ok(())
        } else {
            Err(ContractError::InvalidProtocolVersion)
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MinorExtensionPolicy {
    Exact,
    OptionalOnly,
    RequiresSemanticSupport,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OperatingSystem {
    Windows,
}

impl TryFrom<&str> for OperatingSystem {
    type Error = ContractError;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        match value {
            "win32" => Ok(Self::Windows),
            _ => Err(ContractError::UnsupportedOperatingSystem),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Architecture {
    X86_64,
    Arm64,
}

impl TryFrom<&str> for Architecture {
    type Error = ContractError;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        match value {
            "x64" => Ok(Self::X86_64),
            "arm64" => Ok(Self::Arm64),
            _ => Err(ContractError::UnsupportedArchitecture),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Platform {
    pub operating_system: OperatingSystem,
    pub architecture: Architecture,
}

impl Platform {
    pub fn validate(self) -> Result<(), ContractError> {
        if self.operating_system == OperatingSystem::Windows
            && self.architecture == Architecture::X86_64
        {
            Ok(())
        } else {
            Err(ContractError::PlatformMismatch)
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WorkerRole {
    NativeCandidate,
    SidecarCandidate,
    FallbackCandidate,
    Oracle,
    ContractFixture,
}

impl TryFrom<&str> for WorkerRole {
    type Error = ContractError;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        match value {
            "native-candidate" => Ok(Self::NativeCandidate),
            "sidecar-candidate" => Ok(Self::SidecarCandidate),
            "fallback-candidate" => Ok(Self::FallbackCandidate),
            "oracle-only" => Ok(Self::Oracle),
            "contract-fixture" => Ok(Self::ContractFixture),
            _ => Err(ContractError::UnknownWorkerRole),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ContractPurpose {
    ProductShellCandidate,
    OracleOnly,
    ContractFixture,
}

impl ContractPurpose {
    const fn accepts(self, role: WorkerRole) -> bool {
        match self {
            Self::ProductShellCandidate => matches!(
                role,
                WorkerRole::NativeCandidate
                    | WorkerRole::SidecarCandidate
                    | WorkerRole::FallbackCandidate
            ),
            Self::OracleOnly => matches!(role, WorkerRole::Oracle),
            Self::ContractFixture => matches!(role, WorkerRole::ContractFixture),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TransportKind {
    InProcess,
    IsolatedProcess,
}

impl TryFrom<&str> for TransportKind {
    type Error = ContractError;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        match value {
            "in-process" => Ok(Self::InProcess),
            "isolated-process" => Ok(Self::IsolatedProcess),
            _ => Err(ContractError::UnknownTransportKind),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NetworkPolicy {
    OfflineOnly,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ExecutionProvider {
    FixtureCpu,
    Cpu,
    Cuda,
    DirectMl,
    OpenVino,
}

impl TryFrom<&str> for ExecutionProvider {
    type Error = ContractError;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        match value {
            "fixture-cpu" => Ok(Self::FixtureCpu),
            "cpu" => Ok(Self::Cpu),
            "cuda" => Ok(Self::Cuda),
            "directml" => Ok(Self::DirectMl),
            "openvino" => Ok(Self::OpenVino),
            _ => Err(ContractError::UnknownExecutionProvider),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
#[repr(u8)]
pub enum Capability {
    Describe,
    Prepare,
    AcceptAudio,
    PollEvents,
    FlushSegment,
    Cancel,
    Health,
    Shutdown,
    Restart,
    Heartbeat,
    Progress,
    Offline,
    NoSilentCloudFallback,
    AcknowledgeTerminal,
    MessageIdIdempotency,
    PollReplay,
}

impl Capability {
    const REQUIRED_V1: [Self; 16] = [
        Self::Describe,
        Self::Prepare,
        Self::AcceptAudio,
        Self::PollEvents,
        Self::FlushSegment,
        Self::Cancel,
        Self::Health,
        Self::Shutdown,
        Self::Restart,
        Self::Heartbeat,
        Self::Progress,
        Self::Offline,
        Self::NoSilentCloudFallback,
        Self::AcknowledgeTerminal,
        Self::MessageIdIdempotency,
        Self::PollReplay,
    ];

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Describe => "describe",
            Self::Prepare => "prepare",
            Self::AcceptAudio => "accept_audio",
            Self::PollEvents => "poll_events",
            Self::FlushSegment => "flush_segment",
            Self::Cancel => "cancel",
            Self::Health => "health",
            Self::Shutdown => "shutdown",
            Self::Restart => "restart",
            Self::Heartbeat => "heartbeat",
            Self::Progress => "progress",
            Self::Offline => "offline",
            Self::NoSilentCloudFallback => "no_silent_cloud_fallback",
            Self::AcknowledgeTerminal => "acknowledge_terminal",
            Self::MessageIdIdempotency => "message_id_idempotency",
            Self::PollReplay => "poll_replay",
        }
    }

    const fn bit(self) -> u16 {
        1_u16 << (self as u8)
    }
}

impl TryFrom<&str> for Capability {
    type Error = ContractError;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        match value {
            "describe" => Ok(Self::Describe),
            "prepare" => Ok(Self::Prepare),
            "accept_audio" => Ok(Self::AcceptAudio),
            "poll_events" => Ok(Self::PollEvents),
            "flush_segment" => Ok(Self::FlushSegment),
            "cancel" => Ok(Self::Cancel),
            "health" => Ok(Self::Health),
            "shutdown" => Ok(Self::Shutdown),
            "restart" => Ok(Self::Restart),
            "heartbeat" => Ok(Self::Heartbeat),
            "progress" => Ok(Self::Progress),
            "offline" => Ok(Self::Offline),
            "no_silent_cloud_fallback" => Ok(Self::NoSilentCloudFallback),
            "acknowledge_terminal" => Ok(Self::AcknowledgeTerminal),
            "message_id_idempotency" => Ok(Self::MessageIdIdempotency),
            "poll_replay" => Ok(Self::PollReplay),
            _ => Err(ContractError::UnknownCapability),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CapabilitySet(u16);

impl CapabilitySet {
    #[must_use]
    pub fn required_v1() -> Self {
        Self(
            Capability::REQUIRED_V1
                .iter()
                .fold(0_u16, |bits, capability| bits | capability.bit()),
        )
    }

    #[must_use]
    pub const fn contains(self, capability: Capability) -> bool {
        self.0 & capability.bit() != 0
    }

    #[must_use]
    pub const fn without(self, capability: Capability) -> Self {
        Self(self.0 & !capability.bit())
    }

    fn require(self, required: Self) -> Result<(), ContractError> {
        for capability in Capability::REQUIRED_V1 {
            if required.contains(capability) && !self.contains(capability) {
                return Err(ContractError::MissingCapability(capability));
            }
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct WorkerLimits {
    pub max_control_message_bytes: u64,
    pub max_audio_chunk_bytes: u64,
    pub max_capture_epochs_per_chunk: u32,
    pub max_source_ranges_per_chunk: u32,
    pub max_in_flight_jobs: u32,
    pub max_tracked_jobs: u32,
    pub max_retired_job_keys: u32,
    pub max_pending_commands: u32,
    pub max_pending_deliveries: u32,
    pub max_pending_progress_per_job: u32,
    pub max_fallback_nodes: u32,
    pub max_replay_events_per_batch: u32,
    pub max_cancel_jobs_per_batch: u32,
    pub max_cancellation_scopes: u32,
    pub max_replay_entries: u32,
    pub heartbeat_interval_ms: u64,
}

impl WorkerLimits {
    pub const MAX_CONTROL_MESSAGE_BYTES: u64 = 1_048_576;
    pub const MAX_AUDIO_CHUNK_BYTES: u64 = 4_194_304;
    pub const MAX_CAPTURE_EPOCHS_PER_CHUNK: u32 = 256;
    pub const MAX_SOURCE_RANGES_PER_CHUNK: u32 = 4_096;
    pub const MAX_IN_FLIGHT_JOBS: u32 = 1_024;
    pub const MAX_TRACKED_JOBS: u32 = 16_384;
    pub const MAX_RETIRED_JOB_KEYS: u32 = 65_536;
    pub const MAX_PENDING_COMMANDS: u32 = 4_096;
    pub const MAX_PENDING_DELIVERIES: u32 = 4_096;
    pub const MAX_PENDING_PROGRESS_PER_JOB: u32 = 4_096;
    pub const MAX_FALLBACK_NODES: u32 = 256;
    pub const MAX_REPLAY_EVENTS_PER_BATCH: u32 = 1_024;
    pub const MAX_CANCEL_JOBS_PER_BATCH: u32 = 1_024;
    pub const MAX_CANCELLATION_SCOPES: u32 = 16_384;
    pub const MAX_REPLAY_ENTRIES: u32 = 65_536;
    pub const MIN_HEARTBEAT_INTERVAL_MS: u64 = 50;
    pub const MAX_HEARTBEAT_INTERVAL_MS: u64 = 60_000;

    pub fn validate(self) -> Result<(), ContractError> {
        let replay_delivery_requirement = self
            .max_replay_events_per_batch
            .checked_add(2)
            .ok_or(ContractError::InvalidWorkerLimits)?;
        if self.max_control_message_bytes == 0
            || self.max_control_message_bytes > Self::MAX_CONTROL_MESSAGE_BYTES
            || self.max_audio_chunk_bytes == 0
            || self.max_audio_chunk_bytes > Self::MAX_AUDIO_CHUNK_BYTES
            || self.max_capture_epochs_per_chunk == 0
            || self.max_capture_epochs_per_chunk > Self::MAX_CAPTURE_EPOCHS_PER_CHUNK
            || self.max_source_ranges_per_chunk < self.max_capture_epochs_per_chunk
            || self.max_source_ranges_per_chunk > Self::MAX_SOURCE_RANGES_PER_CHUNK
            || self.max_in_flight_jobs == 0
            || self.max_in_flight_jobs > Self::MAX_IN_FLIGHT_JOBS
            || self.max_tracked_jobs < self.max_in_flight_jobs
            || self.max_tracked_jobs > Self::MAX_TRACKED_JOBS
            || self.max_retired_job_keys == 0
            || self.max_retired_job_keys > Self::MAX_RETIRED_JOB_KEYS
            || self.max_retired_job_keys < self.max_tracked_jobs
            || self.max_pending_commands == 0
            || self.max_pending_commands > Self::MAX_PENDING_COMMANDS
            || self.max_pending_deliveries == 0
            || self.max_pending_deliveries > Self::MAX_PENDING_DELIVERIES
            || self.max_pending_deliveries < self.max_cancel_jobs_per_batch.saturating_mul(2)
            || self.max_pending_deliveries < replay_delivery_requirement
            || self.max_pending_progress_per_job == 0
            || self.max_pending_progress_per_job > Self::MAX_PENDING_PROGRESS_PER_JOB
            || self.max_fallback_nodes == 0
            || self.max_fallback_nodes > Self::MAX_FALLBACK_NODES
            || self.max_replay_events_per_batch == 0
            || self.max_replay_events_per_batch > Self::MAX_REPLAY_EVENTS_PER_BATCH
            || self.max_cancel_jobs_per_batch > Self::MAX_CANCEL_JOBS_PER_BATCH
            || self.max_cancellation_scopes == 0
            || self.max_cancellation_scopes > Self::MAX_CANCELLATION_SCOPES
            || self.max_replay_entries == 0
            || self.max_replay_entries > Self::MAX_REPLAY_ENTRIES
            || self.max_replay_entries < self.max_pending_commands
            || self.max_replay_entries < self.max_pending_deliveries
            || !(Self::MIN_HEARTBEAT_INTERVAL_MS..=Self::MAX_HEARTBEAT_INTERVAL_MS)
                .contains(&self.heartbeat_interval_ms)
        {
            return Err(ContractError::InvalidWorkerLimits);
        }
        Ok(())
    }

    const fn fits_within(self, offered: Self) -> bool {
        self.max_control_message_bytes <= offered.max_control_message_bytes
            && self.max_audio_chunk_bytes <= offered.max_audio_chunk_bytes
            && self.max_capture_epochs_per_chunk <= offered.max_capture_epochs_per_chunk
            && self.max_source_ranges_per_chunk <= offered.max_source_ranges_per_chunk
            && self.max_in_flight_jobs <= offered.max_in_flight_jobs
            && self.max_tracked_jobs <= offered.max_tracked_jobs
            && self.max_retired_job_keys <= offered.max_retired_job_keys
            && self.max_pending_commands <= offered.max_pending_commands
            && self.max_pending_deliveries <= offered.max_pending_deliveries
            && self.max_pending_progress_per_job <= offered.max_pending_progress_per_job
            && self.max_fallback_nodes <= offered.max_fallback_nodes
            && self.max_replay_events_per_batch <= offered.max_replay_events_per_batch
            && self.max_cancel_jobs_per_batch <= offered.max_cancel_jobs_per_batch
            && self.max_cancellation_scopes <= offered.max_cancellation_scopes
            && self.max_replay_entries <= offered.max_replay_entries
            && self.heartbeat_interval_ms <= offered.heartbeat_interval_ms
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EngineDescriptor {
    pub engine_id: Identifier,
    pub engine_version: Identifier,
    pub runtime_id: Identifier,
    pub runtime_version: Identifier,
    pub runtime_sha256: Sha256Digest,
    pub package_lock_sha256: Sha256Digest,
    pub model_id: Identifier,
    pub model_sha256: Sha256Digest,
    pub model_manifest_sha256: Sha256Digest,
    pub model_license_id: Identifier,
    pub parameter_sha256: Sha256Digest,
    pub execution_provider: ExecutionProvider,
    pub quantization: Identifier,
    pub languages: Vec<LanguageCode>,
    pub streaming: bool,
    pub offline: bool,
}

impl EngineDescriptor {
    pub const MAX_LANGUAGES: usize = 64;

    pub(crate) fn validate(&self) -> Result<(), ContractError> {
        if self.runtime_sha256.is_zero()
            || self.package_lock_sha256.is_zero()
            || self.model_sha256.is_zero()
            || self.model_manifest_sha256.is_zero()
            || self.parameter_sha256.is_zero()
        {
            return Err(ContractError::InvalidSha256);
        }
        if self.languages.len() > Self::MAX_LANGUAGES {
            return Err(ContractError::LanguageListTooLarge);
        }
        if self.languages.is_empty()
            || self
                .languages
                .windows(2)
                .any(|pair| pair[0].as_str() >= pair[1].as_str())
        {
            return Err(ContractError::LanguageMismatch);
        }
        if !self.streaming {
            return Err(ContractError::StreamingRequired);
        }
        if !self.offline {
            return Err(ContractError::OfflineRequired);
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkerManifest {
    pub worker_id: Identifier,
    pub role: WorkerRole,
    pub worker_build_sha256: Sha256Digest,
    pub executable_sha256: Sha256Digest,
    pub schema_registry_sha256: Sha256Digest,
    pub descriptor: EngineDescriptor,
}

impl WorkerManifest {
    pub(crate) fn validate(&self) -> Result<(), ContractError> {
        if self.worker_build_sha256.is_zero()
            || self.executable_sha256.is_zero()
            || self.schema_registry_sha256.is_zero()
        {
            return Err(ContractError::InvalidSha256);
        }
        self.descriptor.validate()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HelloRequest {
    pub protocol: WorkerProtocolVersion,
    pub platform: Platform,
    pub core_build_sha256: Sha256Digest,
    pub purpose: ContractPurpose,
    pub expected: WorkerManifest,
    pub required_capabilities: CapabilitySet,
    pub offered_limits: WorkerLimits,
}

impl HelloRequest {
    pub fn validate(&self) -> Result<(), ContractError> {
        self.protocol.validate_core_offer()?;
        self.platform.validate()?;
        if self.core_build_sha256.is_zero() {
            return Err(ContractError::InvalidSha256);
        }
        self.expected.validate()?;
        self.offered_limits.validate()?;
        if !self.purpose.accepts(self.expected.role) {
            return Err(ContractError::RolePurposeMismatch);
        }
        self.required_capabilities
            .require(CapabilitySet::required_v1())
    }

    pub fn validate_response(&self, response: &HelloResponse) -> Result<(), ContractError> {
        self.validate()?;
        if response.protocol.major != self.protocol.major {
            return Err(ContractError::ProtocolMismatch);
        }
        if response.protocol.minor != self.protocol.minor
            && !(response.protocol.minor > self.protocol.minor
                && response.minimum_core_minor <= self.protocol.minor
                && response.minor_extension_policy == MinorExtensionPolicy::OptionalOnly)
        {
            return Err(ContractError::UnsafeMinorVersion);
        }
        response.validate()?;
        if response.platform != self.platform {
            return Err(ContractError::PlatformMismatch);
        }
        if response.worker_id != self.expected.worker_id {
            return Err(ContractError::WorkerIdMismatch);
        }
        if response.role != self.expected.role {
            return Err(ContractError::RoleMismatch);
        }
        if !transport_matches_role(response.transport, response.role) {
            return Err(ContractError::TransportRoleMismatch);
        }
        if response.worker_build_sha256 != self.expected.worker_build_sha256 {
            return Err(ContractError::WorkerBuildDigestMismatch);
        }
        if response.executable_sha256 != self.expected.executable_sha256 {
            return Err(ContractError::ExecutableDigestMismatch);
        }
        if response.schema_registry_sha256 != self.expected.schema_registry_sha256 {
            return Err(ContractError::SchemaRegistryDigestMismatch);
        }
        validate_descriptor(&self.expected.descriptor, &response.descriptor)?;
        response.capabilities.require(self.required_capabilities)?;
        if !response.accepted_limits.fits_within(self.offered_limits) {
            return Err(ContractError::NegotiatedLimitExceedsOffer);
        }
        if response.network_policy != NetworkPolicy::OfflineOnly {
            return Err(ContractError::NetworkPolicyMismatch);
        }
        if response.silent_cloud_fallback {
            return Err(ContractError::SilentCloudFallbackForbidden);
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HelloResponse {
    pub protocol: WorkerProtocolVersion,
    pub minimum_core_minor: u16,
    pub minor_extension_policy: MinorExtensionPolicy,
    pub platform: Platform,
    pub worker_id: Identifier,
    pub role: WorkerRole,
    pub worker_build_sha256: Sha256Digest,
    pub executable_sha256: Sha256Digest,
    pub schema_registry_sha256: Sha256Digest,
    pub delivery_session_epoch: Identifier,
    pub descriptor: EngineDescriptor,
    pub capabilities: CapabilitySet,
    pub accepted_limits: WorkerLimits,
    pub transport: TransportKind,
    pub network_policy: NetworkPolicy,
    pub silent_cloud_fallback: bool,
}

impl HelloResponse {
    fn validate(&self) -> Result<(), ContractError> {
        if self.protocol.major != WORKER_PROTOCOL_V1.major
            || self.minimum_core_minor > self.protocol.minor
            || (self.protocol.minor == WORKER_PROTOCOL_V1.minor
                && self.minor_extension_policy != MinorExtensionPolicy::Exact)
        {
            return Err(ContractError::InvalidProtocolVersion);
        }
        self.platform.validate()?;
        if self.worker_build_sha256.is_zero()
            || self.executable_sha256.is_zero()
            || self.schema_registry_sha256.is_zero()
        {
            return Err(ContractError::InvalidSha256);
        }
        self.descriptor.validate()?;
        self.accepted_limits.validate()?;
        if self.network_policy != NetworkPolicy::OfflineOnly {
            return Err(ContractError::NetworkPolicyMismatch);
        }
        if self.silent_cloud_fallback {
            return Err(ContractError::SilentCloudFallbackForbidden);
        }
        Ok(())
    }
}

fn validate_descriptor(
    expected: &EngineDescriptor,
    actual: &EngineDescriptor,
) -> Result<(), ContractError> {
    if actual.engine_id != expected.engine_id
        || actual.engine_version != expected.engine_version
        || actual.runtime_id != expected.runtime_id
        || actual.runtime_version != expected.runtime_version
        || actual.model_id != expected.model_id
    {
        return Err(ContractError::EngineIdentityMismatch);
    }
    if actual.runtime_sha256 != expected.runtime_sha256 {
        return Err(ContractError::RuntimeDigestMismatch);
    }
    if actual.package_lock_sha256 != expected.package_lock_sha256 {
        return Err(ContractError::PackageLockDigestMismatch);
    }
    if actual.model_sha256 != expected.model_sha256 {
        return Err(ContractError::ModelDigestMismatch);
    }
    if actual.model_manifest_sha256 != expected.model_manifest_sha256 {
        return Err(ContractError::ModelManifestDigestMismatch);
    }
    if actual.parameter_sha256 != expected.parameter_sha256 {
        return Err(ContractError::ParameterDigestMismatch);
    }
    if actual.model_license_id != expected.model_license_id {
        return Err(ContractError::ModelLicenseMismatch);
    }
    if actual.execution_provider != expected.execution_provider {
        return Err(ContractError::ExecutionProviderMismatch);
    }
    if actual.quantization != expected.quantization {
        return Err(ContractError::QuantizationMismatch);
    }
    if actual.languages != expected.languages {
        return Err(ContractError::LanguageMismatch);
    }
    if !actual.streaming {
        return Err(ContractError::StreamingRequired);
    }
    if !actual.offline {
        return Err(ContractError::OfflineRequired);
    }
    Ok(())
}

const fn transport_matches_role(transport: TransportKind, role: WorkerRole) -> bool {
    match role {
        WorkerRole::NativeCandidate => matches!(transport, TransportKind::InProcess),
        WorkerRole::SidecarCandidate | WorkerRole::Oracle => {
            matches!(transport, TransportKind::IsolatedProcess)
        }
        WorkerRole::FallbackCandidate | WorkerRole::ContractFixture => true,
    }
}
