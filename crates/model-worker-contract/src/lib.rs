//! Transport-neutral model worker contract for MeetingRelay WP-0.4.
//!
//! Wire codecs, model SDKs, runtimes, and product features intentionally live
//! outside this crate.

mod engine;
mod error;
mod fake;
mod identity;
mod protocol;

pub use engine::{
    AudioChunk, AudioFormat, AudioGap, AudioSource, CancelReason, CancelTarget, Cancellation,
    ErrorCategory, ErrorSeverity, GapReason, JobKey, MonotonicDeadline, NotCancellableReason,
    PrepareRequest, RecoveryAction, ReplayJobState, RequestContext, ResourceEstimate,
    ResourceEstimateStatus, SampleFormat, SourceRange, StableWorkerError, StableWorkerErrorSpec,
    WorkerCommand, WorkerEvent, WorkerRequest, WorkerResponse, WorkerResponseSpec,
};
pub use error::ContractError;
pub use fake::{
    ConformanceTranscript, DEFAULT_FAKE_CLOCK_DOMAIN_ID, DirectFakeTransport, FakeClockControl,
    InMemoryQueuedTransport, WorkerEndpoint, run_deterministic_fixture_conformance,
    run_deterministic_fixture_conformance_with_clock,
};
pub use identity::{Identifier, LanguageCode, SanitizedText, Sha256Digest};
pub use protocol::{
    Architecture, Capability, CapabilitySet, ContractPurpose, EngineDescriptor, ExecutionProvider,
    HelloRequest, HelloResponse, MinorExtensionPolicy, NetworkPolicy, OperatingSystem, Platform,
    TransportKind, WORKER_PROTOCOL_NAME, WORKER_PROTOCOL_V1, WorkerLimits, WorkerManifest,
    WorkerProtocolVersion, WorkerRole,
};
