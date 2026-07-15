use core::fmt;

use crate::{
    AudioChunk, AudioGap, CancelReason, CancelTarget, CapabilitySet, ContractError,
    ContractPurpose, ExecutionProvider, HelloRequest, Identifier, JobKey, MonotonicDeadline,
    PrepareRequest, ReplayJobState, RequestContext, ResourceEstimateStatus, TranscriptResult,
    TransportKind, WorkerCommand, WorkerEndpoint, WorkerEvent, WorkerRequest, WorkerResponse,
    WorkerRole,
};

/// Assertive semantic observation produced by a real native-candidate endpoint.
///
/// This is supporting conformance data only. It deliberately contains no timing,
/// resource, quality, ranking, eligibility, default, or production conclusion.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativeCandidateSemanticObservation {
    pub final_result: TranscriptResult,
    pub final_transcript_utf8_bytes: usize,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CandidateConformanceError {
    Contract(ContractError),
    InvalidInput,
    UnexpectedObservation,
}

impl fmt::Display for CandidateConformanceError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Contract(_) => "candidate endpoint violated the model-worker contract",
            Self::InvalidInput => "candidate conformance input is invalid",
            Self::UnexpectedObservation => "candidate endpoint returned an unexpected observation",
        })
    }
}

impl std::error::Error for CandidateConformanceError {}

impl From<ContractError> for CandidateConformanceError {
    fn from(value: ContractError) -> Self {
        Self::Contract(value)
    }
}

/// Runs the assertive native-candidate semantic suite against one endpoint.
///
/// A native candidate is required by the protocol to negotiate
/// [`TransportKind::InProcess`]. A caller may launch the containing executable
/// as a child process for crash containment, but that outer process boundary is
/// not model-worker IPC and does not change the negotiated transport.
pub fn run_native_candidate_semantic_conformance<E: WorkerEndpoint>(
    endpoint: &mut E,
    hello: HelloRequest,
    clock_domain_id: Identifier,
    first_audio: AudioChunk,
    gap: AudioGap,
    second_audio: AudioChunk,
) -> Result<NativeCandidateSemanticObservation, CandidateConformanceError> {
    if hello.purpose != ContractPurpose::ProductShellCandidate
        || hello.expected.role != WorkerRole::NativeCandidate
        || hello.required_capabilities != CapabilitySet::required_v1()
        || hello.offered_limits.max_pending_commands != 2
        || first_audio.sequence != 1
        || gap.sequence != 2
        || second_audio.sequence != 3
        || gap.media_start_sample != first_audio.media_end_sample
        || second_audio.media_start_sample != gap.media_end_sample
    {
        return Err(CandidateConformanceError::InvalidInput);
    }

    let expected_manifest = hello.expected.clone();
    let response = endpoint.handshake(hello.clone())?;
    hello.validate_response(&response)?;
    if response.transport != TransportKind::InProcess
        || response.role != WorkerRole::NativeCandidate
        || response.descriptor != expected_manifest.descriptor
    {
        return Err(CandidateConformanceError::UnexpectedObservation);
    }
    let mut requests = RequestCursor::new(response.delivery_session_epoch, clock_domain_id);

    let first_describe = requests.global(WorkerCommand::Describe)?;
    endpoint.submit(first_describe)?;
    requests.commit()?;
    let second_describe = requests.global(WorkerCommand::Describe)?;
    endpoint.submit(second_describe)?;
    requests.commit()?;
    let blocked_describe = requests.global(WorkerCommand::Describe)?;
    if endpoint.submit(blocked_describe.clone()) != Err(ContractError::QueueFull) {
        return Err(CandidateConformanceError::UnexpectedObservation);
    }
    let described = endpoint.drain()?;
    if described.len() != 2
        || described.iter().any(|response| {
            !matches!(
                response.event(),
                WorkerEvent::Described { descriptor } if descriptor == &expected_manifest.descriptor
            )
        })
    {
        return Err(CandidateConformanceError::UnexpectedObservation);
    }
    endpoint.submit(blocked_describe)?;
    requests.commit()?;
    if !matches!(
        only_event(&endpoint.drain()?)?,
        WorkerEvent::Described { descriptor } if descriptor == &expected_manifest.descriptor
    ) {
        return Err(CandidateConformanceError::UnexpectedObservation);
    }

    assert_prepared(
        exchange_committed(
            endpoint,
            &mut requests,
            RequestTarget::Global,
            WorkerCommand::Prepare(PrepareRequest {
                model_manifest_sha256: expected_manifest.descriptor.model_manifest_sha256,
                execution_provider: expected_manifest.descriptor.execution_provider,
            }),
        )?,
        expected_manifest.descriptor.execution_provider,
    )?;

    let mut oversized = first_audio.clone();
    oversized.payload_bytes = response
        .accepted_limits
        .max_audio_chunk_bytes
        .checked_add(1)
        .ok_or(CandidateConformanceError::InvalidInput)?;
    let oversized_request = requests.job(&job("bounded"), WorkerCommand::AcceptAudio(oversized))?;
    if endpoint.exchange(oversized_request) != Err(ContractError::AudioChunkTooLarge) {
        return Err(CandidateConformanceError::UnexpectedObservation);
    }
    requests.commit()?;

    let final_job = job("final");
    assert_event(
        &exchange_committed(
            endpoint,
            &mut requests,
            RequestTarget::Job(&final_job),
            WorkerCommand::AcceptAudio(first_audio),
        )?,
        |event| matches!(event, WorkerEvent::AudioAccepted { sequence: 1 }),
    )?;
    let expected_gap = gap;
    assert_event(
        &exchange_committed(
            endpoint,
            &mut requests,
            RequestTarget::Job(&final_job),
            WorkerCommand::DeclareGap(expected_gap),
        )?,
        |event| {
            matches!(
                event,
                WorkerEvent::GapAccepted {
                    sequence,
                    media_start_sample,
                    media_end_sample,
                    reason,
                } if *sequence == expected_gap.sequence
                    && *media_start_sample == expected_gap.media_start_sample
                    && *media_end_sample == expected_gap.media_end_sample
                    && *reason == expected_gap.reason
            )
        },
    )?;
    assert_event(
        &exchange_committed(
            endpoint,
            &mut requests,
            RequestTarget::Job(&final_job),
            WorkerCommand::AcceptAudio(second_audio),
        )?,
        |event| matches!(event, WorkerEvent::AudioAccepted { sequence: 3 }),
    )?;

    if endpoint.heartbeat()? != (WorkerEvent::Heartbeat { sequence: 1 }) {
        return Err(CandidateConformanceError::UnexpectedObservation);
    }
    let mut progress = Vec::with_capacity(4);
    for _ in 0..4 {
        let responses = exchange_committed(
            endpoint,
            &mut requests,
            RequestTarget::Job(&final_job),
            WorkerCommand::PollEvents,
        )?;
        let WorkerEvent::Progress {
            progress_sequence,
            last_audio_sequence,
        } = only_event(&responses)?
        else {
            return Err(CandidateConformanceError::UnexpectedObservation);
        };
        progress.push((*progress_sequence, *last_audio_sequence));
    }
    if progress != [(1, 1), (2, 1), (3, 3), (4, 3)]
        || !exchange_committed(
            endpoint,
            &mut requests,
            RequestTarget::Job(&final_job),
            WorkerCommand::PollEvents,
        )?
        .is_empty()
    {
        return Err(CandidateConformanceError::UnexpectedObservation);
    }

    let flush = requests.job(&final_job, WorkerCommand::FlushSegment)?;
    let final_responses = endpoint.exchange(flush.clone())?;
    requests.commit()?;
    let WorkerEvent::Final {
        segment_id,
        last_audio_sequence,
        result,
    } = only_event(&final_responses)?
    else {
        return Err(CandidateConformanceError::UnexpectedObservation);
    };
    if segment_id != &final_job.segment_id
        || *last_audio_sequence != 3
        || result.provenance
            != crate::TranscriptProvenance::from_descriptor(&expected_manifest.descriptor)
    {
        return Err(CandidateConformanceError::UnexpectedObservation);
    }
    let final_result = result.clone();
    let final_transcript_utf8_bytes = final_result.original_transcript.as_str().len();
    if final_transcript_utf8_bytes == 0 || endpoint.exchange(flush)? != final_responses {
        return Err(CandidateConformanceError::UnexpectedObservation);
    }

    let cancelled_job = job("cancelled");
    assert_event(
        &exchange_committed(
            endpoint,
            &mut requests,
            RequestTarget::Job(&cancelled_job),
            WorkerCommand::DeclareGap(AudioGap {
                sequence: 1,
                media_start_sample: 0,
                media_end_sample: 320,
                reason: crate::GapReason::SourceUnavailable,
            }),
        )?,
        |event| matches!(event, WorkerEvent::GapAccepted { sequence: 1, .. }),
    )?;
    let cancel_scope = Identifier::new("candidate-conformance-cancel-scope")?;
    let cancel_responses = exchange_committed(
        endpoint,
        &mut requests,
        RequestTarget::CancelJob(&cancelled_job, cancel_scope.as_str()),
        WorkerCommand::Cancel {
            reason: CancelReason::UserRequested,
        },
    )?;
    let [requested, cancelled] = cancel_responses.as_slice() else {
        return Err(CandidateConformanceError::UnexpectedObservation);
    };
    if !matches!(
        requested.event(),
        WorkerEvent::CancelRequested {
            job,
            cancel_scope_id,
            reason: CancelReason::UserRequested,
            repeated: false,
        } if job == &cancelled_job && cancel_scope_id == &cancel_scope
    ) || !matches!(
        cancelled.event(),
        WorkerEvent::Cancelled {
            job,
            cancel_scope_id,
            reason: CancelReason::UserRequested,
            repeated: false,
        } if job == &cancelled_job && cancel_scope_id == &cancel_scope
    ) {
        return Err(CandidateConformanceError::UnexpectedObservation);
    }

    let active_job = job("restart-active");
    exchange_committed(
        endpoint,
        &mut requests,
        RequestTarget::Job(&active_job),
        WorkerCommand::DeclareGap(AudioGap {
            sequence: 1,
            media_start_sample: 0,
            media_end_sample: 320,
            reason: crate::GapReason::CaptureDiscontinuity,
        }),
    )?;
    let restart = exchange_committed(
        endpoint,
        &mut requests,
        RequestTarget::Global,
        WorkerCommand::Restart,
    )?;
    if restart.len() != 4
        || count_events(&restart, |event| {
            matches!(
                event,
                WorkerEvent::ReplayRequired {
                    job,
                    state: ReplayJobState::Active,
                } if job == &active_job
            )
        }) != 1
        || count_events(&restart, |event| {
            matches!(
                event,
                WorkerEvent::ReplayRequired {
                    job,
                    state: ReplayJobState::Final,
                } if job == &final_job
            )
        }) != 1
        || count_events(&restart, |event| {
            matches!(
                event,
                WorkerEvent::ReplayRequired {
                    job,
                    state: ReplayJobState::Cancelled { cancellation },
                } if job == &cancelled_job
                    && cancellation.scope_id == cancel_scope
                    && cancellation.target == CancelTarget::Job(cancelled_job.clone())
                    && cancellation.reason == CancelReason::UserRequested
            )
        }) != 1
        || count_events(&restart, |event| {
            matches!(event, WorkerEvent::Restarted { restart_count: 1 })
        }) != 1
    {
        return Err(CandidateConformanceError::UnexpectedObservation);
    }
    assert_prepared(
        exchange_committed(
            endpoint,
            &mut requests,
            RequestTarget::Global,
            WorkerCommand::Prepare(PrepareRequest {
                model_manifest_sha256: expected_manifest.descriptor.model_manifest_sha256,
                execution_provider: expected_manifest.descriptor.execution_provider,
            }),
        )?,
        expected_manifest.descriptor.execution_provider,
    )?;

    Ok(NativeCandidateSemanticObservation {
        final_result,
        final_transcript_utf8_bytes,
    })
}

fn assert_prepared(
    responses: Vec<WorkerResponse>,
    expected_execution_provider: ExecutionProvider,
) -> Result<(), CandidateConformanceError> {
    let WorkerEvent::Prepared {
        ready: true,
        execution_provider,
        fallback_nodes,
        resource_estimate,
    } = only_event(&responses)?
    else {
        return Err(CandidateConformanceError::UnexpectedObservation);
    };
    if *execution_provider != expected_execution_provider
        || !fallback_nodes.is_empty()
        || resource_estimate.status() != ResourceEstimateStatus::UnavailableContractFixture
        || resource_estimate.resident_memory_bytes().is_some()
        || resource_estimate.vram_bytes().is_some()
    {
        return Err(CandidateConformanceError::UnexpectedObservation);
    }
    Ok(())
}

fn assert_event(
    responses: &[WorkerResponse],
    predicate: impl FnOnce(&WorkerEvent) -> bool,
) -> Result<(), CandidateConformanceError> {
    if predicate(only_event(responses)?) {
        Ok(())
    } else {
        Err(CandidateConformanceError::UnexpectedObservation)
    }
}

fn only_event(responses: &[WorkerResponse]) -> Result<&WorkerEvent, CandidateConformanceError> {
    let [response] = responses else {
        return Err(CandidateConformanceError::UnexpectedObservation);
    };
    Ok(response.event())
}

fn count_events(responses: &[WorkerResponse], predicate: impl Fn(&WorkerEvent) -> bool) -> usize {
    responses
        .iter()
        .filter(|response| predicate(response.event()))
        .count()
}

fn exchange_committed<E: WorkerEndpoint>(
    endpoint: &mut E,
    requests: &mut RequestCursor,
    target: RequestTarget<'_>,
    command: WorkerCommand,
) -> Result<Vec<WorkerResponse>, CandidateConformanceError> {
    let request = match target {
        RequestTarget::Global => requests.global(command)?,
        RequestTarget::Job(job) => requests.job(job, command)?,
        RequestTarget::CancelJob(job, scope) => requests.cancel_job(job, scope, command)?,
    };
    let responses = endpoint.exchange(request)?;
    requests.commit()?;
    Ok(responses)
}

enum RequestTarget<'a> {
    Global,
    Job(&'a JobKey),
    CancelJob(&'a JobKey, &'a str),
}

struct RequestCursor {
    delivery_session_epoch: Identifier,
    clock_domain_id: Identifier,
    next_sequence: u64,
}

impl RequestCursor {
    const TRACE_ID: &'static str = "candidate-conformance-trace";

    const fn new(delivery_session_epoch: Identifier, clock_domain_id: Identifier) -> Self {
        Self {
            delivery_session_epoch,
            clock_domain_id,
            next_sequence: 1,
        }
    }

    fn global(&self, command: WorkerCommand) -> Result<WorkerRequest, ContractError> {
        self.build(None, None, command)
    }

    fn job(&self, job: &JobKey, command: WorkerCommand) -> Result<WorkerRequest, ContractError> {
        self.build(Some(job), None, command)
    }

    fn cancel_job(
        &self,
        job: &JobKey,
        cancel_scope: &str,
        command: WorkerCommand,
    ) -> Result<WorkerRequest, ContractError> {
        self.build(Some(job), Some(Identifier::new(cancel_scope)?), command)
    }

    fn build(
        &self,
        job: Option<&JobKey>,
        cancel_scope_id: Option<Identifier>,
        command: WorkerCommand,
    ) -> Result<WorkerRequest, ContractError> {
        Ok(WorkerRequest {
            context: RequestContext {
                delivery_session_epoch: self.delivery_session_epoch.clone(),
                message_sequence: self.next_sequence,
                message_id: Identifier::new(&format!(
                    "candidate-conformance-message-{}",
                    self.next_sequence
                ))?,
                trace_id: Identifier::new(Self::TRACE_ID)?,
                meeting_id: job.map(|key| key.meeting_id.clone()),
                job_id: job.map(|key| key.job_id.clone()),
                segment_id: job.map(|key| key.segment_id.clone()),
                cancel_scope_id,
                deadline: MonotonicDeadline {
                    clock_domain_id: self.clock_domain_id.clone(),
                    deadline_ns: 10_000,
                },
            },
            command,
        })
    }

    fn commit(&mut self) -> Result<(), CandidateConformanceError> {
        self.next_sequence = self
            .next_sequence
            .checked_add(1)
            .ok_or(CandidateConformanceError::InvalidInput)?;
        Ok(())
    }
}

fn job(label: &str) -> JobKey {
    JobKey {
        meeting_id: Identifier::new("candidate-conformance-meeting")
            .expect("constant meeting identifier is valid"),
        job_id: Identifier::new(&format!("candidate-conformance-job-{label}"))
            .expect("bounded label forms a valid job identifier"),
        segment_id: Identifier::new(&format!("candidate-conformance-segment-{label}"))
            .expect("bounded label forms a valid segment identifier"),
    }
}
