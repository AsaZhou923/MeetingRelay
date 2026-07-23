//! Lightweight local ASR backend contract for MeetingRelay.
//!
//! Model SDKs, runtimes, and product UI features intentionally live outside
//! this crate.

mod engine;
mod error;
mod identity;
mod protocol;

pub use engine::{
    AudioChunk, AudioFormat, AudioPayload, AudioSource, BackendAction, BackendFailure,
    BackendOutcome, FixedPointConfidence, JobKey, ModelBackend, SampleFormat, SourceRange,
    TranscriptProvenance, TranscriptResult, TranscriptText,
};
pub use error::ContractError;
pub use identity::{Identifier, LanguageCode, SanitizedText, Sha256Digest};
pub use protocol::{EngineDescriptor, ExecutionProvider};
