//! Pure, deterministic timing primitives for the Phase 0 benchmark harness.
//!
//! This crate intentionally contains no capture, session, model, or product code.

mod decimal;
mod evidence;
mod timepoint;

pub use decimal::{CanonicalU64, ParseCanonicalU64Error};
pub use evidence::{EvidenceClaim, EvidenceError, EvidenceStage, MetricId};
pub use timepoint::{
    EndpointKind, SegmentJoinKey, SegmentJoinKeyError, TracePoint, TranslationJoinKey,
    TranslationJoinKeyError,
};

/// Version of the bootstrap benchmark contract exposed by the desktop shell.
pub const CONTRACT_VERSION: &str = "meetingrelay.phase0.bootstrap.v1";

/// Monotonic timestamps for one benchmark-only pipeline observation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Observation {
    pub input_ready_ns: u64,
    pub worker_ready_ns: u64,
    pub output_ready_ns: u64,
}

/// Deterministic stage durations derived from an [`Observation`].
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct StageDurations {
    pub worker_ns: u64,
    pub output_ns: u64,
    pub end_to_end_ns: u64,
}

impl Observation {
    /// Returns `None` when timestamps are not monotonic.
    #[must_use]
    pub const fn stage_durations(self) -> Option<StageDurations> {
        let Some(worker_ns) = self.worker_ready_ns.checked_sub(self.input_ready_ns) else {
            return None;
        };
        let Some(output_ns) = self.output_ready_ns.checked_sub(self.worker_ready_ns) else {
            return None;
        };
        let Some(end_to_end_ns) = self.output_ready_ns.checked_sub(self.input_ready_ns) else {
            return None;
        };

        Some(StageDurations {
            worker_ns,
            output_ns,
            end_to_end_ns,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::{Observation, StageDurations};

    #[test]
    fn fixed_observation_produces_exact_repeatable_durations() {
        let observation = Observation {
            input_ready_ns: 10_000,
            worker_ready_ns: 34_000,
            output_ready_ns: 55_000,
        };
        let expected = Some(StageDurations {
            worker_ns: 24_000,
            output_ns: 21_000,
            end_to_end_ns: 45_000,
        });

        assert_eq!(observation.stage_durations(), expected);
        assert_eq!(observation.stage_durations(), expected);
    }

    #[test]
    fn non_monotonic_observation_is_rejected() {
        let observation = Observation {
            input_ready_ns: 20,
            worker_ready_ns: 19,
            output_ready_ns: 30,
        };

        assert_eq!(observation.stage_durations(), None);
    }
}
