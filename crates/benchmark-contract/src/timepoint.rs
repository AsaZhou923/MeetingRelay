use core::fmt;

/// Stable trace vocabulary shared by Phase 0 evidence producers.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum TracePoint {
    CaptureIngress,
    InterimProjectionReceive,
    SpeechEnd,
    VadEndEvent,
    AsrFinalCandidate,
    PersistenceAccept,
    CommitAck,
    TranslationReady,
    TranslationFirstProjectionReceive,
    TranslationCompleteProjectionReceive,
    OriginalFinalPaint,
    TranslationFirstPaint,
    TranslationCompletePaint,
    RendererStub,
    LogTimestamp,
    QueueSample,
    ResourceSample,
}

impl TracePoint {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::CaptureIngress => "capture.ingress",
            Self::InterimProjectionReceive => "interim.projection.receive",
            Self::SpeechEnd => "speech.end",
            Self::VadEndEvent => "vad.end.event",
            Self::AsrFinalCandidate => "asr.final.candidate",
            Self::PersistenceAccept => "persistence.accept",
            Self::CommitAck => "commit.ack",
            Self::TranslationReady => "translation.ready",
            Self::TranslationFirstProjectionReceive => "translation.first.projection.receive",
            Self::TranslationCompleteProjectionReceive => "translation.complete.projection.receive",
            Self::OriginalFinalPaint => "original.final.paint",
            Self::TranslationFirstPaint => "translation.first.paint",
            Self::TranslationCompletePaint => "translation.complete.paint",
            Self::RendererStub => "renderer.stub",
            Self::LogTimestamp => "log.timestamp",
            Self::QueueSample => "queue.sample",
            Self::ResourceSample => "resource.sample",
        }
    }

    #[must_use]
    pub const fn endpoint_kind(self) -> EndpointKind {
        match self {
            Self::InterimProjectionReceive
            | Self::TranslationFirstProjectionReceive
            | Self::TranslationCompleteProjectionReceive => EndpointKind::ProjectionReceive,
            Self::OriginalFinalPaint
            | Self::TranslationFirstPaint
            | Self::TranslationCompletePaint => EndpointKind::UserVisiblePaint,
            Self::RendererStub | Self::LogTimestamp => EndpointKind::NonAuthoritative,
            Self::QueueSample | Self::ResourceSample => EndpointKind::DiagnosticSample,
            Self::CaptureIngress
            | Self::SpeechEnd
            | Self::VadEndEvent
            | Self::AsrFinalCandidate
            | Self::PersistenceAccept
            | Self::CommitAck
            | Self::TranslationReady => EndpointKind::PipelineBoundary,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum EndpointKind {
    PipelineBoundary,
    ProjectionReceive,
    UserVisiblePaint,
    NonAuthoritative,
    DiagnosticSample,
}

/// Stable identity used to join all observations for one segment without wall
/// clock ordering.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct SegmentJoinKey<'a> {
    trace_id: &'a str,
    meeting_id: &'a str,
    segment_id: &'a str,
    transcript_generation: u32,
    sequence: u64,
}

impl<'a> SegmentJoinKey<'a> {
    pub fn new(
        trace_id: &'a str,
        meeting_id: &'a str,
        segment_id: &'a str,
        transcript_generation: u32,
        sequence: u64,
    ) -> Result<Self, SegmentJoinKeyError> {
        if trace_id.is_empty() {
            return Err(SegmentJoinKeyError::EmptyTraceId);
        }
        if meeting_id.is_empty() {
            return Err(SegmentJoinKeyError::EmptyMeetingId);
        }
        if segment_id.is_empty() {
            return Err(SegmentJoinKeyError::EmptySegmentId);
        }

        Ok(Self {
            trace_id,
            meeting_id,
            segment_id,
            transcript_generation,
            sequence,
        })
    }

    #[must_use]
    pub const fn trace_id(self) -> &'a str {
        self.trace_id
    }

    #[must_use]
    pub const fn meeting_id(self) -> &'a str {
        self.meeting_id
    }

    #[must_use]
    pub const fn segment_id(self) -> &'a str {
        self.segment_id
    }

    #[must_use]
    pub const fn transcript_generation(self) -> u32 {
        self.transcript_generation
    }

    #[must_use]
    pub const fn sequence(self) -> u64 {
        self.sequence
    }
}

/// Canonical identity for one translation operation, including retry and
/// configuration generation so results cannot cross-join within a segment.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct TranslationJoinKey<'a> {
    segment: SegmentJoinKey<'a>,
    source_revision: u32,
    target_language: &'a str,
    provider_id: &'a str,
    config_version: u64,
    translation_generation: u32,
}

impl<'a> TranslationJoinKey<'a> {
    pub fn new(
        segment: SegmentJoinKey<'a>,
        source_revision: u32,
        target_language: &'a str,
        provider_id: &'a str,
        config_version: u64,
        translation_generation: u32,
    ) -> Result<Self, TranslationJoinKeyError> {
        if target_language.is_empty() {
            return Err(TranslationJoinKeyError::EmptyTargetLanguage);
        }
        if provider_id.is_empty() {
            return Err(TranslationJoinKeyError::EmptyProviderId);
        }

        Ok(Self {
            segment,
            source_revision,
            target_language,
            provider_id,
            config_version,
            translation_generation,
        })
    }

    #[must_use]
    pub const fn segment(self) -> SegmentJoinKey<'a> {
        self.segment
    }

    #[must_use]
    pub const fn source_revision(self) -> u32 {
        self.source_revision
    }

    #[must_use]
    pub const fn target_language(self) -> &'a str {
        self.target_language
    }

    #[must_use]
    pub const fn provider_id(self) -> &'a str {
        self.provider_id
    }

    #[must_use]
    pub const fn config_version(self) -> u64 {
        self.config_version
    }

    #[must_use]
    pub const fn translation_generation(self) -> u32 {
        self.translation_generation
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SegmentJoinKeyError {
    EmptyTraceId,
    EmptyMeetingId,
    EmptySegmentId,
}

impl fmt::Display for SegmentJoinKeyError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::EmptyTraceId => "trace_id must not be empty",
            Self::EmptyMeetingId => "meeting_id must not be empty",
            Self::EmptySegmentId => "segment_id must not be empty",
        })
    }
}

impl std::error::Error for SegmentJoinKeyError {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TranslationJoinKeyError {
    EmptyTargetLanguage,
    EmptyProviderId,
}

impl fmt::Display for TranslationJoinKeyError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::EmptyTargetLanguage => "target_language must not be empty",
            Self::EmptyProviderId => "provider_id must not be empty",
        })
    }
}

impl std::error::Error for TranslationJoinKeyError {}

#[cfg(test)]
mod tests {
    use super::{
        EndpointKind, SegmentJoinKey, SegmentJoinKeyError, TracePoint, TranslationJoinKey,
        TranslationJoinKeyError,
    };

    #[test]
    fn trace_names_and_endpoint_kinds_are_stable() {
        let cases = [
            (
                TracePoint::CaptureIngress,
                "capture.ingress",
                EndpointKind::PipelineBoundary,
            ),
            (
                TracePoint::InterimProjectionReceive,
                "interim.projection.receive",
                EndpointKind::ProjectionReceive,
            ),
            (
                TracePoint::SpeechEnd,
                "speech.end",
                EndpointKind::PipelineBoundary,
            ),
            (
                TracePoint::VadEndEvent,
                "vad.end.event",
                EndpointKind::PipelineBoundary,
            ),
            (
                TracePoint::AsrFinalCandidate,
                "asr.final.candidate",
                EndpointKind::PipelineBoundary,
            ),
            (
                TracePoint::PersistenceAccept,
                "persistence.accept",
                EndpointKind::PipelineBoundary,
            ),
            (
                TracePoint::CommitAck,
                "commit.ack",
                EndpointKind::PipelineBoundary,
            ),
            (
                TracePoint::TranslationReady,
                "translation.ready",
                EndpointKind::PipelineBoundary,
            ),
            (
                TracePoint::TranslationFirstProjectionReceive,
                "translation.first.projection.receive",
                EndpointKind::ProjectionReceive,
            ),
            (
                TracePoint::TranslationCompleteProjectionReceive,
                "translation.complete.projection.receive",
                EndpointKind::ProjectionReceive,
            ),
            (
                TracePoint::OriginalFinalPaint,
                "original.final.paint",
                EndpointKind::UserVisiblePaint,
            ),
            (
                TracePoint::TranslationFirstPaint,
                "translation.first.paint",
                EndpointKind::UserVisiblePaint,
            ),
            (
                TracePoint::TranslationCompletePaint,
                "translation.complete.paint",
                EndpointKind::UserVisiblePaint,
            ),
            (
                TracePoint::RendererStub,
                "renderer.stub",
                EndpointKind::NonAuthoritative,
            ),
            (
                TracePoint::LogTimestamp,
                "log.timestamp",
                EndpointKind::NonAuthoritative,
            ),
            (
                TracePoint::QueueSample,
                "queue.sample",
                EndpointKind::DiagnosticSample,
            ),
            (
                TracePoint::ResourceSample,
                "resource.sample",
                EndpointKind::DiagnosticSample,
            ),
        ];

        for (point, name, kind) in cases {
            assert_eq!(point.as_str(), name);
            assert_eq!(point.endpoint_kind(), kind);
        }
    }

    #[test]
    fn segment_join_key_rejects_missing_identity() {
        assert_eq!(
            SegmentJoinKey::new("", "meeting", "segment", 0, 1),
            Err(SegmentJoinKeyError::EmptyTraceId)
        );
        assert_eq!(
            SegmentJoinKey::new("trace", "", "segment", 0, 1),
            Err(SegmentJoinKeyError::EmptyMeetingId)
        );
        assert_eq!(
            SegmentJoinKey::new("trace", "meeting", "", 0, 1),
            Err(SegmentJoinKeyError::EmptySegmentId)
        );
    }

    #[test]
    fn translation_join_key_carries_retry_and_configuration_identity() {
        let segment =
            SegmentJoinKey::new("trace", "meeting", "segment", 2, 7).expect("segment identity");
        let key = TranslationJoinKey::new(segment, 3, "ja", "local-sherpa", 11, 4)
            .expect("translation identity");

        assert_eq!(key.segment(), segment);
        assert_eq!(key.source_revision(), 3);
        assert_eq!(key.target_language(), "ja");
        assert_eq!(key.provider_id(), "local-sherpa");
        assert_eq!(key.config_version(), 11);
        assert_eq!(key.translation_generation(), 4);
        assert_eq!(
            TranslationJoinKey::new(segment, 3, "", "provider", 11, 4),
            Err(TranslationJoinKeyError::EmptyTargetLanguage)
        );
        assert_eq!(
            TranslationJoinKey::new(segment, 3, "ja", "", 11, 4),
            Err(TranslationJoinKeyError::EmptyProviderId)
        );
    }
}
