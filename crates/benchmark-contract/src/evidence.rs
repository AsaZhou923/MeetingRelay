use core::fmt;

use crate::{EndpointKind, SegmentJoinKey, TracePoint, TranslationJoinKey};

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum EvidenceStage {
    Wp03HarnessSelfTest,
    Phase0Surface,
    Production,
}

impl EvidenceStage {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Wp03HarnessSelfTest => "wp0.3_harness_self_test",
            Self::Phase0Surface => "phase0_surface",
            Self::Production => "production",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum MetricId {
    PerfRt001,
    PerfRt002,
    PerfRt003,
    PerfRt004,
    PerfRt005,
}

impl MetricId {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::PerfRt001 => "PERF-RT-001",
            Self::PerfRt002 => "PERF-RT-002",
            Self::PerfRt003 => "PERF-RT-003",
            Self::PerfRt004 => "PERF-RT-004",
            Self::PerfRt005 => "PERF-RT-005",
        }
    }

    #[must_use]
    pub const fn required_endpoint(self) -> TracePoint {
        match self {
            Self::PerfRt001 => TracePoint::OriginalFinalPaint,
            Self::PerfRt002 => TracePoint::TranslationFirstProjectionReceive,
            Self::PerfRt003 => TracePoint::TranslationCompleteProjectionReceive,
            Self::PerfRt004 => TracePoint::TranslationFirstPaint,
            Self::PerfRt005 => TracePoint::TranslationCompletePaint,
        }
    }

    #[must_use]
    pub const fn required_start(self) -> TracePoint {
        match self {
            Self::PerfRt001 | Self::PerfRt004 | Self::PerfRt005 => TracePoint::SpeechEnd,
            Self::PerfRt002 | Self::PerfRt003 => TracePoint::TranslationReady,
        }
    }

    #[must_use]
    pub const fn requires_translation_join(self) -> bool {
        !matches!(self, Self::PerfRt001)
    }
}

/// One evidence assertion. WP-0.3 records unclaimed observations only; formal
/// metric and SLO fields remain absent until their production work package.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct EvidenceClaim<'a> {
    pub stage: EvidenceStage,
    pub start: TracePoint,
    pub endpoint: TracePoint,
    pub segment: Option<SegmentJoinKey<'a>>,
    pub translation: Option<TranslationJoinKey<'a>>,
    pub metric_id: Option<MetricId>,
    pub slo_claims: &'a [&'a str],
    pub candidate_id: Option<&'a str>,
    pub production_evidence: bool,
}

impl EvidenceClaim<'_> {
    pub fn validate(self) -> Result<(), EvidenceError> {
        if self.stage == EvidenceStage::Wp03HarnessSelfTest && self.candidate_id.is_some() {
            return Err(EvidenceError::CandidateForbiddenInHarnessSelfTest);
        }

        if self.stage != EvidenceStage::Production {
            if self.start.endpoint_kind() == EndpointKind::UserVisiblePaint
                || self.endpoint.endpoint_kind() == EndpointKind::UserVisiblePaint
            {
                return Err(EvidenceError::PaintObservationRequiresProduction);
            }
            if self.production_evidence {
                return Err(EvidenceError::ProductionEvidenceFlagRequiresProduction);
            }
            if self.metric_id.is_some() {
                return Err(EvidenceError::FormalMetricRequiresProduction);
            }
            if !self.slo_claims.is_empty() {
                return Err(EvidenceError::SloClaimRequiresProduction);
            }
            return Ok(());
        }

        if !self.slo_claims.is_empty() && self.metric_id.is_none() {
            return Err(EvidenceError::SloClaimRequiresMetric);
        }

        if self.production_evidence
            && (self.start.endpoint_kind() == EndpointKind::NonAuthoritative
                || self.endpoint.endpoint_kind() == EndpointKind::NonAuthoritative)
        {
            return Err(EvidenceError::NonAuthoritativeProductionEvidence);
        }

        if let Some(metric_id) = self.metric_id {
            if !self.production_evidence {
                return Err(EvidenceError::FormalMetricRequiresProductionEvidenceFlag);
            }
            let expected_start = metric_id.required_start();
            if self.start != expected_start {
                return Err(EvidenceError::MetricStartMismatch {
                    metric_id,
                    expected: expected_start,
                    actual: self.start,
                });
            }
            let expected_endpoint = metric_id.required_endpoint();
            if self.endpoint != expected_endpoint {
                return Err(EvidenceError::MetricEndpointMismatch {
                    metric_id,
                    expected: expected_endpoint,
                    actual: self.endpoint,
                });
            }
            let segment = self
                .segment
                .ok_or(EvidenceError::FormalMetricRequiresSegmentJoin)?;
            if metric_id.requires_translation_join() {
                let translation = self
                    .translation
                    .ok_or(EvidenceError::TranslationMetricRequiresTranslationJoin)?;
                if translation.segment() != segment {
                    return Err(EvidenceError::TranslationJoinSegmentMismatch);
                }
            }
        }

        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EvidenceError {
    CandidateForbiddenInHarnessSelfTest,
    PaintObservationRequiresProduction,
    ProductionEvidenceFlagRequiresProduction,
    FormalMetricRequiresProduction,
    SloClaimRequiresProduction,
    SloClaimRequiresMetric,
    NonAuthoritativeProductionEvidence,
    FormalMetricRequiresProductionEvidenceFlag,
    FormalMetricRequiresSegmentJoin,
    TranslationMetricRequiresTranslationJoin,
    TranslationJoinSegmentMismatch,
    MetricStartMismatch {
        metric_id: MetricId,
        expected: TracePoint,
        actual: TracePoint,
    },
    MetricEndpointMismatch {
        metric_id: MetricId,
        expected: TracePoint,
        actual: TracePoint,
    },
}

impl fmt::Display for EvidenceError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::CandidateForbiddenInHarnessSelfTest => {
                formatter.write_str("WP-0.3 harness self-test cannot name a candidate")
            }
            Self::PaintObservationRequiresProduction => {
                formatter.write_str("user-visible paint observations require production UI")
            }
            Self::ProductionEvidenceFlagRequiresProduction => {
                formatter.write_str("production evidence flag requires the production stage")
            }
            Self::FormalMetricRequiresProduction => {
                formatter.write_str("formal metric IDs require the production stage")
            }
            Self::SloClaimRequiresProduction => {
                formatter.write_str("SLO claims require the production stage")
            }
            Self::SloClaimRequiresMetric => {
                formatter.write_str("SLO claims require a formal metric ID")
            }
            Self::NonAuthoritativeProductionEvidence => formatter.write_str(
                "renderer stubs and log timestamps cannot be production evidence endpoints",
            ),
            Self::FormalMetricRequiresProductionEvidenceFlag => {
                formatter.write_str("formal metric claim must be marked as production evidence")
            }
            Self::FormalMetricRequiresSegmentJoin => {
                formatter.write_str("formal metric claim requires a segment join key")
            }
            Self::TranslationMetricRequiresTranslationJoin => {
                formatter.write_str("translation metric claim requires a translation join key")
            }
            Self::TranslationJoinSegmentMismatch => formatter
                .write_str("translation join key must contain the claimed segment join key"),
            Self::MetricStartMismatch {
                metric_id,
                expected,
                actual,
            } => write!(
                formatter,
                "{} requires start {}, not {}",
                metric_id.as_str(),
                expected.as_str(),
                actual.as_str()
            ),
            Self::MetricEndpointMismatch {
                metric_id,
                expected,
                actual,
            } => write!(
                formatter,
                "{} requires endpoint {}, not {}",
                metric_id.as_str(),
                expected.as_str(),
                actual.as_str()
            ),
        }
    }
}

impl std::error::Error for EvidenceError {}

#[cfg(test)]
mod tests {
    use super::{EvidenceClaim, EvidenceError, EvidenceStage, MetricId};
    use crate::{SegmentJoinKey, TracePoint, TranslationJoinKey};

    const NO_SLO_CLAIMS: &[&str] = &[];
    const PAINT_SLO_CLAIMS: &[&str] = &["p95<=2.25s"];

    fn segment() -> SegmentJoinKey<'static> {
        SegmentJoinKey::new(
            "trace_fixture_1",
            "meeting_fixture_1",
            "segment_fixture_1",
            0,
            1,
        )
        .expect("fixture join key is valid")
    }

    fn translation(segment: SegmentJoinKey<'static>) -> TranslationJoinKey<'static> {
        TranslationJoinKey::new(segment, 0, "ja", "fixture-provider", 1, 0)
            .expect("fixture translation join key is valid")
    }

    fn claim(
        stage: EvidenceStage,
        start: TracePoint,
        endpoint: TracePoint,
    ) -> EvidenceClaim<'static> {
        let segment = segment();
        EvidenceClaim {
            stage,
            start,
            endpoint,
            segment: Some(segment),
            translation: Some(translation(segment)),
            metric_id: None,
            slo_claims: NO_SLO_CLAIMS,
            candidate_id: None,
            production_evidence: false,
        }
    }

    // CT-HARNESS-001: harness observations remain unclaimed and non-production.
    #[test]
    fn wp03_accepts_only_unclaimed_non_paint_observations() {
        assert_eq!(
            claim(
                EvidenceStage::Wp03HarnessSelfTest,
                TracePoint::CaptureIngress,
                TracePoint::AsrFinalCandidate
            )
            .validate(),
            Ok(())
        );

        let mut metric_claim = claim(
            EvidenceStage::Wp03HarnessSelfTest,
            TracePoint::TranslationReady,
            TracePoint::TranslationFirstProjectionReceive,
        );
        metric_claim.metric_id = Some(MetricId::PerfRt002);
        assert_eq!(
            metric_claim.validate(),
            Err(EvidenceError::FormalMetricRequiresProduction)
        );

        let mut slo_claim = claim(
            EvidenceStage::Wp03HarnessSelfTest,
            TracePoint::TranslationReady,
            TracePoint::TranslationFirstProjectionReceive,
        );
        slo_claim.slo_claims = PAINT_SLO_CLAIMS;
        assert_eq!(
            slo_claim.validate(),
            Err(EvidenceError::SloClaimRequiresProduction)
        );
    }

    // CT-HARNESS-001: future paint points are registry-only before production.
    #[test]
    fn phase0_cannot_emit_future_paint_observations() {
        for stage in [
            EvidenceStage::Wp03HarnessSelfTest,
            EvidenceStage::Phase0Surface,
        ] {
            for paint in [
                TracePoint::OriginalFinalPaint,
                TracePoint::TranslationFirstPaint,
                TracePoint::TranslationCompletePaint,
            ] {
                assert_eq!(
                    claim(stage, TracePoint::SpeechEnd, paint).validate(),
                    Err(EvidenceError::PaintObservationRequiresProduction)
                );
            }
        }
    }

    // CT-HARNESS-001: projection, renderer, and log endpoints cannot masquerade
    // as the direct user-visible translation paint metrics.
    #[test]
    fn non_paint_endpoints_cannot_claim_perf_rt_004_or_005() {
        let cases = [(
            TracePoint::TranslationFirstProjectionReceive,
            MetricId::PerfRt004,
        )];

        for (endpoint, metric_id) in cases {
            let mut invalid = claim(EvidenceStage::Production, TracePoint::SpeechEnd, endpoint);
            invalid.metric_id = Some(metric_id);
            invalid.production_evidence = true;
            assert_eq!(
                invalid.validate(),
                Err(EvidenceError::MetricEndpointMismatch {
                    metric_id,
                    expected: metric_id.required_endpoint(),
                    actual: endpoint,
                })
            );
        }
    }

    #[test]
    fn all_formal_metrics_require_their_exact_start_endpoint_and_join() {
        let cases = [
            (
                MetricId::PerfRt001,
                TracePoint::SpeechEnd,
                TracePoint::OriginalFinalPaint,
            ),
            (
                MetricId::PerfRt002,
                TracePoint::TranslationReady,
                TracePoint::TranslationFirstProjectionReceive,
            ),
            (
                MetricId::PerfRt003,
                TracePoint::TranslationReady,
                TracePoint::TranslationCompleteProjectionReceive,
            ),
            (
                MetricId::PerfRt004,
                TracePoint::SpeechEnd,
                TracePoint::TranslationFirstPaint,
            ),
            (
                MetricId::PerfRt005,
                TracePoint::SpeechEnd,
                TracePoint::TranslationCompletePaint,
            ),
        ];

        for (metric_id, start, endpoint) in cases {
            assert_eq!(metric_id.required_start(), start);
            assert_eq!(metric_id.required_endpoint(), endpoint);
            let mut valid = claim(EvidenceStage::Production, start, endpoint);
            valid.metric_id = Some(metric_id);
            valid.slo_claims = PAINT_SLO_CLAIMS;
            valid.production_evidence = true;
            assert_eq!(valid.validate(), Ok(()));

            valid.start = TracePoint::CaptureIngress;
            assert_eq!(
                valid.validate(),
                Err(EvidenceError::MetricStartMismatch {
                    metric_id,
                    expected: start,
                    actual: TracePoint::CaptureIngress,
                })
            );
        }
    }

    #[test]
    fn exact_production_metric_join_types_are_required() {
        let mut valid = claim(
            EvidenceStage::Production,
            TracePoint::SpeechEnd,
            TracePoint::TranslationFirstPaint,
        );
        valid.metric_id = Some(MetricId::PerfRt004);
        valid.production_evidence = true;

        valid.segment = None;
        assert_eq!(
            valid.validate(),
            Err(EvidenceError::FormalMetricRequiresSegmentJoin)
        );

        valid.segment = Some(segment());
        valid.translation = None;
        assert_eq!(
            valid.validate(),
            Err(EvidenceError::TranslationMetricRequiresTranslationJoin)
        );

        let other_segment =
            SegmentJoinKey::new("other", "meeting", "segment", 0, 1).expect("other segment key");
        valid.translation = Some(translation(other_segment));
        assert_eq!(
            valid.validate(),
            Err(EvidenceError::TranslationJoinSegmentMismatch)
        );
    }

    #[test]
    fn wp03_rejects_candidate_and_production_labels() {
        let mut candidate = claim(
            EvidenceStage::Wp03HarnessSelfTest,
            TracePoint::CaptureIngress,
            TracePoint::AsrFinalCandidate,
        );
        candidate.candidate_id = Some("candidate-not-allowed");
        assert_eq!(
            candidate.validate(),
            Err(EvidenceError::CandidateForbiddenInHarnessSelfTest)
        );

        let mut production = claim(
            EvidenceStage::Wp03HarnessSelfTest,
            TracePoint::CaptureIngress,
            TracePoint::AsrFinalCandidate,
        );
        production.production_evidence = true;
        assert_eq!(
            production.validate(),
            Err(EvidenceError::ProductionEvidenceFlagRequiresProduction)
        );
    }

    #[test]
    fn renderer_and_log_endpoints_cannot_be_production_evidence() {
        for endpoint in [TracePoint::RendererStub, TracePoint::LogTimestamp] {
            let mut invalid = claim(
                EvidenceStage::Production,
                TracePoint::CaptureIngress,
                endpoint,
            );
            invalid.production_evidence = true;
            invalid.metric_id = Some(MetricId::PerfRt004);
            assert_eq!(
                invalid.validate(),
                Err(EvidenceError::NonAuthoritativeProductionEvidence)
            );
        }
    }
}
