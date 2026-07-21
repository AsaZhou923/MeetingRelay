//! Transport-neutral model worker contract for MeetingRelay WP-0.4.
//!
//! Wire codecs, model SDKs, runtimes, and product features intentionally live
//! outside this crate.

mod candidate_conformance;
mod engine;
mod error;
mod fake;
mod identity;
mod protocol;
mod sidecar_wire;

pub use candidate_conformance::{
    CandidateConformanceError, NativeCandidateSemanticObservation,
    run_native_candidate_semantic_conformance,
};
pub use engine::{
    AudioChunk, AudioFormat, AudioGap, AudioPayload, AudioSource, BackendAction, BackendFailure,
    BackendOutcome, CancelReason, CancelTarget, Cancellation, ErrorCategory, ErrorSeverity,
    FixedPointConfidence, GapReason, JobKey, ModelBackend, MonotonicDeadline, NotCancellableReason,
    PrepareRequest, RecoveryAction, ReplayJobState, RequestContext, ResourceEstimate,
    ResourceEstimateStatus, SampleFormat, SourceRange, StableWorkerError, StableWorkerErrorSpec,
    TranscriptProvenance, TranscriptResult, TranscriptText, WorkerCommand, WorkerEvent,
    WorkerRequest, WorkerResponse, WorkerResponseSpec,
};
pub use error::ContractError;
pub use fake::{
    ConformanceTranscript, DEFAULT_FAKE_CLOCK_DOMAIN_ID, DirectFakeTransport, DirectWorkerSession,
    FakeClockControl, InMemoryQueuedTransport, QueuedWorkerSession, WorkerEndpoint,
    run_deterministic_fixture_conformance, run_deterministic_fixture_conformance_with_clock,
};
pub use identity::{Identifier, LanguageCode, SanitizedText, Sha256Digest};
pub use protocol::{
    Architecture, Capability, CapabilitySet, ContractPurpose, EngineDescriptor, ExecutionProvider,
    HelloRequest, HelloResponse, MinorExtensionPolicy, NetworkPolicy, OperatingSystem, Platform,
    TransportKind, WORKER_PROTOCOL_NAME, WORKER_PROTOCOL_V1, WorkerLimits, WorkerManifest,
    WorkerProtocolVersion, WorkerRole,
};
pub use sidecar_wire::{
    SIDECAR_WIRE_MAGIC, SIDECAR_WIRE_MAX_HEADER_LEN, SIDECAR_WIRE_PRELUDE_LEN,
    SIDECAR_WIRE_VERSION, SidecarWireDirection, SidecarWireError, SidecarWireFrame,
    build_sidecar_wire_transcript_preimage, decode_sidecar_wire_frame, encode_sidecar_wire_frame,
};
