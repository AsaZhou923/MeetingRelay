use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use meetingrelay_model_worker_contract::{
    Architecture, AudioChunk, AudioFormat, AudioPayload, AudioSource, BackendAction,
    BackendFailure, BackendOutcome, CancelReason, CapabilitySet, ContractError, ContractPurpose,
    DirectFakeTransport, DirectWorkerSession, EngineDescriptor, ExecutionProvider,
    FixedPointConfidence, HelloRequest, Identifier, InMemoryQueuedTransport, JobKey, LanguageCode,
    ModelBackend, MonotonicDeadline, OperatingSystem, Platform, PrepareRequest,
    QueuedWorkerSession, RequestContext, SampleFormat, SanitizedText, Sha256Digest, SourceRange,
    TranscriptProvenance, TranscriptResult, TranscriptText, TransportKind, WORKER_PROTOCOL_V1,
    WorkerCommand, WorkerEndpoint, WorkerEvent, WorkerLimits, WorkerManifest, WorkerRequest,
    WorkerResponse, WorkerRole,
};

const CLOCK_DOMAIN: &str = "core-fixture-clock";

fn digest(byte: u8) -> Sha256Digest {
    Sha256Digest::from_bytes([byte; 32])
}

fn id(value: &str) -> Identifier {
    Identifier::new(value).expect("fixture identifier")
}

fn language(value: &str) -> LanguageCode {
    LanguageCode::new(value).expect("fixture language")
}

fn descriptor() -> EngineDescriptor {
    EngineDescriptor {
        engine_id: id("session-test-engine"),
        engine_version: id("1.0.0"),
        runtime_id: id("session-test-runtime"),
        runtime_version: id("1.0.0"),
        runtime_sha256: digest(1),
        package_lock_sha256: digest(2),
        model_id: id("session-test-model"),
        model_sha256: digest(3),
        model_manifest_sha256: digest(4),
        model_license_id: id("project-generated-fixture"),
        parameter_sha256: digest(5),
        execution_provider: ExecutionProvider::FixtureCpu,
        quantization: id("fixture-none"),
        languages: vec![language("en"), language("ja"), language("zh")],
        streaming: true,
        offline: true,
    }
}

fn manifest() -> WorkerManifest {
    WorkerManifest {
        worker_id: id("session-test-worker"),
        role: WorkerRole::ContractFixture,
        worker_build_sha256: digest(6),
        executable_sha256: digest(7),
        schema_registry_sha256: digest(8),
        descriptor: descriptor(),
    }
}

fn limits() -> WorkerLimits {
    WorkerLimits {
        max_control_message_bytes: 65_536,
        max_audio_chunk_bytes: 1_048_576,
        max_pending_audio_bytes: 4_194_304,
        max_capture_epochs_per_chunk: 8,
        max_source_ranges_per_chunk: 32,
        max_in_flight_jobs: 8,
        max_tracked_jobs: 64,
        max_retired_job_keys: 128,
        max_pending_commands: 8,
        max_pending_deliveries: 16,
        max_pending_progress_per_job: 8,
        max_fallback_nodes: 8,
        max_replay_events_per_batch: 8,
        max_cancel_jobs_per_batch: 4,
        max_cancellation_scopes: 64,
        max_replay_entries: 128,
        heartbeat_interval_ms: 1_000,
    }
}

fn one_remaining_delivery_slot_limits() -> WorkerLimits {
    let mut worker_limits = limits();
    worker_limits.max_pending_commands = 4;
    worker_limits.max_pending_deliveries = 3;
    worker_limits.max_replay_events_per_batch = 1;
    worker_limits.max_cancel_jobs_per_batch = 1;
    worker_limits
}

fn hello(worker_limits: WorkerLimits) -> HelloRequest {
    HelloRequest {
        protocol: WORKER_PROTOCOL_V1,
        platform: Platform {
            operating_system: OperatingSystem::Windows,
            architecture: Architecture::X86_64,
        },
        core_build_sha256: digest(9),
        purpose: ContractPurpose::ContractFixture,
        expected: manifest(),
        required_capabilities: CapabilitySet::required_v1(),
        offered_limits: worker_limits,
    }
}

fn job(suffix: &str) -> JobKey {
    JobKey {
        meeting_id: id("session-test-meeting"),
        job_id: id(&format!("job-{suffix}")),
        segment_id: id(&format!("segment-{suffix}")),
    }
}

fn request(message: &str, job: Option<&JobKey>, command: WorkerCommand) -> WorkerRequest {
    WorkerRequest {
        context: RequestContext {
            delivery_session_epoch: id("unstamped-session"),
            message_sequence: 0,
            message_id: id(message),
            trace_id: id("session-test-trace"),
            meeting_id: job.map(|key| key.meeting_id.clone()),
            job_id: job.map(|key| key.job_id.clone()),
            segment_id: job.map(|key| key.segment_id.clone()),
            cancel_scope_id: None,
            deadline: MonotonicDeadline {
                clock_domain_id: id(CLOCK_DOMAIN),
                deadline_ns: 10_000,
            },
        },
        command,
    }
}

fn cancel_request(message: &str, target: &JobKey) -> WorkerRequest {
    let mut request = request(
        message,
        Some(target),
        WorkerCommand::Cancel {
            reason: CancelReason::UserRequested,
        },
    );
    request.context.cancel_scope_id = Some(id(&format!("scope-{message}")));
    request
}

fn meeting_cancel_request(message: &str, meeting_id: &Identifier) -> WorkerRequest {
    let mut request = request(
        message,
        None,
        WorkerCommand::Cancel {
            reason: CancelReason::MeetingEnded,
        },
    );
    request.context.meeting_id = Some(meeting_id.clone());
    request.context.cancel_scope_id = Some(id(&format!("scope-{message}")));
    request
}

fn prepare_request(message: &str) -> WorkerRequest {
    request(
        message,
        None,
        WorkerCommand::Prepare(PrepareRequest {
            model_manifest_sha256: descriptor().model_manifest_sha256,
            execution_provider: ExecutionProvider::FixtureCpu,
        }),
    )
}

fn pcm_chunk_with(
    sequence: u64,
    media_start_sample: u64,
    payload_sha256: Sha256Digest,
    samples: Arc<[i16]>,
) -> AudioChunk {
    let capture_epoch_id = id("session-test-epoch");
    let media_end_sample = media_start_sample + 320;
    AudioChunk {
        sequence,
        media_start_sample,
        media_end_sample,
        timeline_rate: 16_000,
        format: AudioFormat {
            sample_rate_hz: 16_000,
            channels: 1,
            sample_format: SampleFormat::PcmS16Le,
        },
        capture_epoch_ids: vec![capture_epoch_id.clone()],
        source_ranges: vec![SourceRange {
            audio_source: AudioSource::System,
            capture_epoch_id,
            device_start_sample: media_start_sample,
            device_end_sample: media_end_sample,
            meeting_start_sample: media_start_sample,
            meeting_end_sample: media_end_sample,
            sample_rate_hz: 16_000,
        }],
        payload_bytes: 640,
        payload_sha256: Some(payload_sha256),
        payload: Some(AudioPayload::PcmS16Le(samples)),
    }
}

fn pcm_chunk(sequence: u64, media_start_sample: u64) -> AudioChunk {
    pcm_chunk_with(
        sequence,
        media_start_sample,
        digest(10),
        Arc::from([0_i16; 320]),
    )
}

fn transcript_result(normalized_language: &str) -> TranscriptResult {
    let descriptor = descriptor();
    TranscriptResult {
        original_transcript: TranscriptText::new("original backend transcript")
            .expect("fixture transcript"),
        raw_language: SanitizedText::new("English (United States)").expect("fixture raw language"),
        normalized_language: language(normalized_language),
        confidence: Some(
            FixedPointConfidence::from_parts_per_million(912_345).expect("fixed-point confidence"),
        ),
        provenance: TranscriptProvenance::from_descriptor(&descriptor),
    }
}

#[derive(Clone)]
enum PlannedOutcome {
    Completed(Box<TranscriptResult>),
    Failed(BackendFailure),
}

#[derive(Default)]
struct ProbeState {
    calls: usize,
    audio_sequences: Vec<Vec<u64>>,
    action_debug: Vec<String>,
    outcomes: VecDeque<PlannedOutcome>,
}

struct CountingBackend {
    state: Arc<Mutex<ProbeState>>,
    fallback: TranscriptResult,
}

impl CountingBackend {
    fn new(outcomes: impl IntoIterator<Item = PlannedOutcome>) -> (Self, Arc<Mutex<ProbeState>>) {
        let state = Arc::new(Mutex::new(ProbeState {
            outcomes: outcomes.into_iter().collect(),
            ..ProbeState::default()
        }));
        (
            Self {
                state: Arc::clone(&state),
                fallback: transcript_result("en"),
            },
            state,
        )
    }
}

impl ModelBackend for CountingBackend {
    fn execute(&mut self, action: &BackendAction) -> BackendOutcome {
        let outcome = {
            let mut state = self.state.lock().expect("probe lock");
            state.calls += 1;
            state.audio_sequences.push(
                action
                    .audio_chunks()
                    .iter()
                    .map(|chunk| chunk.sequence)
                    .collect(),
            );
            state.action_debug.push(format!("{action:?}"));
            state
                .outcomes
                .pop_front()
                .unwrap_or_else(|| PlannedOutcome::Completed(Box::new(self.fallback.clone())))
        };
        match outcome {
            PlannedOutcome::Completed(result) => action.completed(*result),
            PlannedOutcome::Failed(failure) => action.failed(failure),
        }
    }
}

struct StaleOutcomeBackend {
    calls: Arc<Mutex<usize>>,
    stale_first_outcome: Option<BackendOutcome>,
    result: TranscriptResult,
}

impl StaleOutcomeBackend {
    fn new() -> (Self, Arc<Mutex<usize>>) {
        let calls = Arc::new(Mutex::new(0));
        (
            Self {
                calls: Arc::clone(&calls),
                stale_first_outcome: None,
                result: transcript_result("en"),
            },
            calls,
        )
    }
}

impl ModelBackend for StaleOutcomeBackend {
    fn execute(&mut self, action: &BackendAction) -> BackendOutcome {
        let call = {
            let mut calls = self.calls.lock().expect("stale backend call lock");
            *calls += 1;
            *calls
        };
        match call {
            1 => {
                self.stale_first_outcome = Some(action.completed(self.result.clone()));
                action.completed(self.result.clone())
            }
            2 => self
                .stale_first_outcome
                .take()
                .expect("first action stamped a duplicate outcome"),
            _ => action.completed(self.result.clone()),
        }
    }
}

#[derive(Default)]
struct SharedStaleOutcomeState {
    calls: usize,
    stale_outcome: Option<BackendOutcome>,
}

struct SharedStaleOutcomeBackend {
    state: Arc<Mutex<SharedStaleOutcomeState>>,
    result: TranscriptResult,
}

impl SharedStaleOutcomeBackend {
    fn pair() -> (Self, Self, Arc<Mutex<SharedStaleOutcomeState>>) {
        let state = Arc::new(Mutex::new(SharedStaleOutcomeState::default()));
        (
            Self {
                state: Arc::clone(&state),
                result: transcript_result("en"),
            },
            Self {
                state: Arc::clone(&state),
                result: transcript_result("en"),
            },
            state,
        )
    }
}

impl ModelBackend for SharedStaleOutcomeBackend {
    fn execute(&mut self, action: &BackendAction) -> BackendOutcome {
        let mut state = self.state.lock().expect("shared stale backend lock");
        state.calls += 1;
        if let Some(stale) = state.stale_outcome.take() {
            return stale;
        }
        if state.calls == 1 {
            state.stale_outcome = Some(action.completed(self.result.clone()));
        }
        action.completed(self.result.clone())
    }
}

fn call_count(state: &Arc<Mutex<ProbeState>>) -> usize {
    state.lock().expect("probe lock").calls
}

struct Harness<E> {
    endpoint: E,
    session_epoch: Identifier,
    next_sequence: u64,
}

impl<E: WorkerEndpoint> Harness<E> {
    fn new(mut endpoint: E, worker_limits: WorkerLimits) -> Self {
        let response = endpoint.handshake(hello(worker_limits)).expect("handshake");
        Self {
            endpoint,
            session_epoch: response.delivery_session_epoch,
            next_sequence: 1,
        }
    }

    fn stamp(&self, mut request: WorkerRequest) -> WorkerRequest {
        request.context.delivery_session_epoch = self.session_epoch.clone();
        request.context.message_sequence = self.next_sequence;
        request
    }

    fn submit_exact(&mut self, request: WorkerRequest) -> Result<(), ContractError> {
        let consumes_next = request.context.message_sequence == self.next_sequence;
        let result = self.endpoint.submit(request);
        if consumes_next
            && (result.is_ok()
                || result
                    .as_ref()
                    .is_err_and(|error| error.consumes_message_sequence()))
        {
            self.next_sequence += 1;
        }
        result
    }

    fn submit(&mut self, request: WorkerRequest) -> Result<(), ContractError> {
        let request = self.stamp(request);
        self.submit_exact(request)
    }

    fn drain(&mut self) -> Result<Vec<WorkerResponse>, ContractError> {
        self.endpoint.drain()
    }

    fn exchange(&mut self, request: WorkerRequest) -> Result<Vec<WorkerResponse>, ContractError> {
        self.submit(request)?;
        self.drain()
    }
}

fn prime_audio<E: WorkerEndpoint>(harness: &mut Harness<E>, target: &JobKey) {
    harness
        .exchange(prepare_request("message-prepare"))
        .expect("prepare");
    harness
        .exchange(request(
            "message-audio",
            Some(target),
            WorkerCommand::AcceptAudio(pcm_chunk(1, 0)),
        ))
        .expect("accept audio");
}

fn direct_harness(
    worker_limits: WorkerLimits,
    outcomes: impl IntoIterator<Item = PlannedOutcome>,
) -> (Harness<DirectWorkerSession>, Arc<Mutex<ProbeState>>) {
    let (backend, state) = CountingBackend::new(outcomes);
    let endpoint =
        DirectWorkerSession::new(manifest(), worker_limits, backend).expect("direct constructor");
    (Harness::new(endpoint, worker_limits), state)
}

fn queued_harness(
    worker_limits: WorkerLimits,
    outcomes: impl IntoIterator<Item = PlannedOutcome>,
) -> (Harness<QueuedWorkerSession>, Arc<Mutex<ProbeState>>) {
    let (backend, state) = CountingBackend::new(outcomes);
    let endpoint =
        QueuedWorkerSession::new(manifest(), worker_limits, backend).expect("queued constructor");
    (Harness::new(endpoint, worker_limits), state)
}

fn only_event(responses: &[WorkerResponse]) -> &WorkerEvent {
    assert_eq!(responses.len(), 1);
    responses[0].event()
}

fn fill_two_delivery_slots<E: WorkerEndpoint>(harness: &mut Harness<E>, label: &str) {
    for suffix in 1..=2 {
        harness
            .submit(request(
                &format!("message-{label}-credit-fill-{suffix}"),
                None,
                WorkerCommand::Health,
            ))
            .expect("fill one delivery slot");
    }
}

fn assert_cancel_waits_for_two_delivery_slots<E: WorkerEndpoint>(
    mut harness: Harness<E>,
    state: Arc<Mutex<ProbeState>>,
    label: &str,
    meeting_scope: bool,
) {
    harness
        .exchange(prepare_request(&format!("message-{label}-prepare")))
        .expect("prepare");
    let target = job(label);
    let samples: Arc<[i16]> = Arc::from([41_i16; 320]);
    let weak = Arc::downgrade(&samples);
    harness
        .exchange(request(
            &format!("message-{label}-audio"),
            Some(&target),
            WorkerCommand::AcceptAudio(pcm_chunk_with(1, 0, digest(16), samples)),
        ))
        .expect("accept audio");
    fill_two_delivery_slots(&mut harness, label);
    let cancellation = if meeting_scope {
        meeting_cancel_request(&format!("message-{label}-cancel"), &target.meeting_id)
    } else {
        cancel_request(&format!("message-{label}-cancel"), &target)
    };
    let rejected_sequence = harness.next_sequence;

    assert_eq!(
        harness.submit(cancellation.clone()),
        Err(ContractError::ResponseQueueFull)
    );
    assert_eq!(harness.next_sequence, rejected_sequence);
    assert!(weak.upgrade().is_some());
    assert_eq!(call_count(&state), 0);

    assert_eq!(harness.drain().expect("drain credit fillers").len(), 2);
    let cancelled = harness
        .exchange(cancellation)
        .expect("retry cancel with two response slots");
    assert_eq!(cancelled.len(), 2);
    assert_eq!(cancelled[0].correlation_sequence(), rejected_sequence);
    assert!(matches!(
        cancelled[0].event(),
        WorkerEvent::CancelRequested { .. }
    ));
    assert!(matches!(
        cancelled[1].event(),
        WorkerEvent::Cancelled { .. }
    ));
    assert!(weak.upgrade().is_none());
    assert_eq!(call_count(&state), 0);
}

fn assert_restart_waits_for_two_delivery_slots<E: WorkerEndpoint>(
    mut harness: Harness<E>,
    state: Arc<Mutex<ProbeState>>,
    label: &str,
) {
    harness
        .exchange(prepare_request(&format!("message-{label}-prepare")))
        .expect("prepare");
    let target = job(label);
    let samples: Arc<[i16]> = Arc::from([43_i16; 320]);
    let weak = Arc::downgrade(&samples);
    harness
        .exchange(request(
            &format!("message-{label}-audio"),
            Some(&target),
            WorkerCommand::AcceptAudio(pcm_chunk_with(1, 0, digest(17), samples)),
        ))
        .expect("accept audio");
    fill_two_delivery_slots(&mut harness, label);
    let restart = request(
        &format!("message-{label}-restart"),
        None,
        WorkerCommand::Restart,
    );
    let rejected_sequence = harness.next_sequence;

    assert_eq!(
        harness.submit(restart.clone()),
        Err(ContractError::ResponseQueueFull)
    );
    assert_eq!(harness.next_sequence, rejected_sequence);
    assert!(weak.upgrade().is_some());
    assert_eq!(call_count(&state), 0);

    assert_eq!(harness.drain().expect("drain credit fillers").len(), 2);
    let restarted = harness
        .exchange(restart)
        .expect("retry restart with two response slots");
    assert_eq!(restarted.len(), 2);
    assert_eq!(restarted[0].correlation_sequence(), rejected_sequence);
    assert!(matches!(
        restarted[0].event(),
        WorkerEvent::ReplayRequired { job, .. } if job == &target
    ));
    assert!(matches!(
        restarted[1].event(),
        WorkerEvent::Restarted { restart_count: 1 }
    ));
    assert!(weak.upgrade().is_none());
    assert_eq!(call_count(&state), 0);
}

#[test]
fn queued_submit_defers_backend_until_drain_and_preserves_audio_order() {
    let (mut harness, state) = queued_harness(limits(), []);
    let target = job("queued-order");
    harness
        .exchange(prepare_request("message-order-prepare"))
        .expect("prepare");
    for (sequence, start) in [(1, 0), (2, 320)] {
        harness
            .exchange(request(
                &format!("message-order-audio-{sequence}"),
                Some(&target),
                WorkerCommand::AcceptAudio(pcm_chunk(sequence, start)),
            ))
            .expect("accept audio");
    }

    harness
        .submit(request(
            "message-order-flush",
            Some(&target),
            WorkerCommand::FlushSegment,
        ))
        .expect("queue flush");
    assert_eq!(call_count(&state), 0);

    let responses = harness.drain().expect("drain backend action");
    assert!(matches!(only_event(&responses), WorkerEvent::Final { .. }));
    let state = state.lock().expect("probe lock");
    assert_eq!(state.calls, 1);
    assert_eq!(state.audio_sequences, vec![vec![1, 2]]);
}

#[test]
fn direct_command_credit_rejection_does_not_execute_backend() {
    let mut worker_limits = limits();
    worker_limits.max_pending_commands = 1;
    let (mut harness, state) = direct_harness(worker_limits, []);
    let target = job("command-credit");
    prime_audio(&mut harness, &target);
    harness
        .submit(request(
            "message-command-credit-health",
            None,
            WorkerCommand::Health,
        ))
        .expect("fill command credit");

    assert_eq!(
        harness.submit(request(
            "message-command-credit-flush",
            Some(&target),
            WorkerCommand::FlushSegment,
        )),
        Err(ContractError::QueueFull)
    );
    assert_eq!(call_count(&state), 0);
}

#[test]
fn direct_delivery_credit_rejection_does_not_execute_backend() {
    let mut worker_limits = limits();
    worker_limits.max_pending_commands = 4;
    worker_limits.max_pending_deliveries = 3;
    worker_limits.max_replay_events_per_batch = 1;
    worker_limits.max_cancel_jobs_per_batch = 0;
    let (mut harness, state) = direct_harness(worker_limits, []);
    let target = job("delivery-credit");
    prime_audio(&mut harness, &target);
    for suffix in 1..=3 {
        harness
            .submit(request(
                &format!("message-delivery-credit-health-{suffix}"),
                None,
                WorkerCommand::Health,
            ))
            .expect("fill delivery credit");
    }

    assert_eq!(
        harness.submit(request(
            "message-delivery-credit-flush",
            Some(&target),
            WorkerCommand::FlushSegment,
        )),
        Err(ContractError::ResponseQueueFull)
    );
    assert_eq!(call_count(&state), 0);
}

#[test]
fn job_cancel_reserves_both_response_slots_before_mutating_state() {
    let worker_limits = one_remaining_delivery_slot_limits();
    let (direct, direct_state) = direct_harness(worker_limits, []);
    assert_cancel_waits_for_two_delivery_slots(direct, direct_state, "job-cancel-direct", false);

    let (queued, queued_state) = queued_harness(worker_limits, []);
    assert_cancel_waits_for_two_delivery_slots(queued, queued_state, "job-cancel-queued", false);
}

#[test]
fn meeting_cancel_reserves_both_response_slots_before_mutating_state() {
    let worker_limits = one_remaining_delivery_slot_limits();
    let (direct, direct_state) = direct_harness(worker_limits, []);
    assert_cancel_waits_for_two_delivery_slots(direct, direct_state, "meeting-cancel-direct", true);

    let (queued, queued_state) = queued_harness(worker_limits, []);
    assert_cancel_waits_for_two_delivery_slots(queued, queued_state, "meeting-cancel-queued", true);
}

#[test]
fn restart_reserves_replay_and_lifecycle_response_slots_before_mutation() {
    let worker_limits = one_remaining_delivery_slot_limits();
    let (direct, direct_state) = direct_harness(worker_limits, []);
    assert_restart_waits_for_two_delivery_slots(direct, direct_state, "restart-direct");

    let (queued, queued_state) = queued_harness(worker_limits, []);
    assert_restart_waits_for_two_delivery_slots(queued, queued_state, "restart-queued");
}

#[test]
fn pending_audio_credit_rejection_does_not_execute_backend() {
    let mut worker_limits = limits();
    worker_limits.max_audio_chunk_bytes = 640;
    worker_limits.max_pending_audio_bytes = 640;
    let (mut harness, state) = direct_harness(worker_limits, []);
    harness
        .exchange(prepare_request("message-audio-credit-prepare"))
        .expect("prepare");
    let first = job("audio-credit-first");
    harness
        .exchange(request(
            "message-audio-credit-first",
            Some(&first),
            WorkerCommand::AcceptAudio(pcm_chunk(1, 0)),
        ))
        .expect("first audio");

    assert_eq!(
        harness.exchange(request(
            "message-audio-credit-second",
            Some(&job("audio-credit-second")),
            WorkerCommand::AcceptAudio(pcm_chunk(1, 0)),
        )),
        Err(ContractError::PendingAudioCreditExhausted)
    );
    assert_eq!(call_count(&state), 0);
}

#[test]
fn same_caller_digest_coalesces_retry_without_retaining_raw_pcm_identity() {
    let (mut harness, state) = direct_harness(limits(), []);
    harness
        .exchange(prepare_request("message-digest-prepare"))
        .expect("prepare");
    let target = job("same-digest");
    let first = harness.stamp(request(
        "message-same-digest",
        Some(&target),
        WorkerCommand::AcceptAudio(pcm_chunk_with(1, 0, digest(11), Arc::from([1_i16; 320]))),
    ));
    let mut retry = first.clone();
    let WorkerCommand::AcceptAudio(chunk) = &mut retry.command else {
        unreachable!("audio request")
    };
    chunk.payload = Some(AudioPayload::PcmS16Le(Arc::from([2_i16; 320])));

    harness.submit_exact(first).expect("first admission");
    harness.submit_exact(retry).expect("same digest retry");
    assert_eq!(harness.drain().expect("single frozen delivery").len(), 1);
    assert_eq!(call_count(&state), 0);
}

#[test]
fn different_caller_digest_conflicts_for_the_same_delivery_identity() {
    let (mut harness, state) = direct_harness(limits(), []);
    harness
        .exchange(prepare_request("message-digest-conflict-prepare"))
        .expect("prepare");
    let target = job("different-digest");
    let first = harness.stamp(request(
        "message-different-digest",
        Some(&target),
        WorkerCommand::AcceptAudio(pcm_chunk_with(1, 0, digest(12), Arc::from([1_i16; 320]))),
    ));
    let mut conflict = first.clone();
    let WorkerCommand::AcceptAudio(chunk) = &mut conflict.command else {
        unreachable!("audio request")
    };
    chunk.payload_sha256 = Some(digest(13));

    harness.submit_exact(first).expect("first admission");
    assert_eq!(
        harness.submit_exact(conflict),
        Err(ContractError::MessageIdConflict)
    );
    assert_eq!(call_count(&state), 0);
}

fn assert_payload_rejected(mutate: impl FnOnce(&mut AudioChunk), expected: ContractError) {
    let (mut harness, state) = direct_harness(limits(), []);
    harness
        .exchange(prepare_request("message-invalid-payload-prepare"))
        .expect("prepare");
    let target = job("invalid-payload");
    let mut chunk = pcm_chunk(1, 0);
    mutate(&mut chunk);
    assert_eq!(
        harness.exchange(request(
            "message-invalid-payload",
            Some(&target),
            WorkerCommand::AcceptAudio(chunk),
        )),
        Err(expected)
    );
    assert_eq!(call_count(&state), 0);
}

#[test]
fn missing_pcm_payload_is_rejected_before_backend_side_effect() {
    assert_payload_rejected(
        |chunk| chunk.payload = None,
        ContractError::MissingAudioPayload,
    );
}

#[test]
fn missing_pcm_digest_is_rejected_before_backend_side_effect() {
    assert_payload_rejected(
        |chunk| chunk.payload_sha256 = None,
        ContractError::MissingAudioPayloadDigest,
    );
}

#[test]
fn zero_pcm_digest_is_rejected_before_backend_side_effect() {
    assert_payload_rejected(
        |chunk| chunk.payload_sha256 = Some(digest(0)),
        ContractError::InvalidAudioPayloadDigest,
    );
}

#[test]
fn pcm_type_mismatch_is_rejected_before_backend_side_effect() {
    assert_payload_rejected(
        |chunk| chunk.payload = Some(AudioPayload::PcmF32Le(Arc::from([0.0_f32; 160]))),
        ContractError::AudioPayloadTypeMismatch,
    );
}

#[test]
fn pcm_length_mismatch_is_rejected_before_backend_side_effect() {
    assert_payload_rejected(
        |chunk| chunk.payload = Some(AudioPayload::PcmS16Le(Arc::from([0_i16; 319]))),
        ContractError::AudioPayloadLengthMismatch,
    );
}

#[test]
fn completed_backend_outcome_and_replay_are_frozen_without_rerun() {
    let expected = transcript_result("en");
    let (mut harness, state) = queued_harness(
        limits(),
        [PlannedOutcome::Completed(Box::new(expected.clone()))],
    );
    let target = job("completed-replay");
    prime_audio(&mut harness, &target);
    let flush = harness.stamp(request(
        "message-completed-replay-flush",
        Some(&target),
        WorkerCommand::FlushSegment,
    ));
    harness
        .submit_exact(flush.clone())
        .expect("submit first flush");
    let first = harness.drain().expect("first terminal");
    assert!(matches!(
        only_event(&first),
        WorkerEvent::Final { result, .. } if result == &expected
    ));
    assert_eq!(call_count(&state), 1);

    harness.submit_exact(flush).expect("submit replay");
    let replay = harness.drain().expect("replay terminal");
    assert_eq!(replay, first);
    assert_eq!(call_count(&state), 1);
}

#[test]
fn backend_failure_and_replay_are_frozen_without_rerun() {
    let failure = BackendFailure::new(
        id("fixture-backend-error"),
        true,
        Some(SanitizedText::new("backend fixture failed").expect("failure detail")),
    );
    let (mut harness, state) = queued_harness(limits(), [PlannedOutcome::Failed(failure)]);
    let target = job("failure-replay");
    prime_audio(&mut harness, &target);
    let flush = harness.stamp(request(
        "message-failure-replay-flush",
        Some(&target),
        WorkerCommand::FlushSegment,
    ));
    harness
        .submit_exact(flush.clone())
        .expect("submit first flush");
    let first = harness.drain().expect("first failure");
    assert!(matches!(
        only_event(&first),
        WorkerEvent::Failure { error, .. }
            if error.code().as_str() == "fixture-backend-error"
                && error.retryable()
                && error.sanitized_detail().is_some_and(|detail| detail.as_str() == "backend fixture failed")
    ));
    assert_eq!(call_count(&state), 1);

    harness.submit_exact(flush).expect("submit replay");
    assert_eq!(harness.drain().expect("replay failure"), first);
    assert_eq!(call_count(&state), 1);
}

#[test]
fn invalid_backend_outcome_and_replay_are_frozen_without_rerun() {
    let (mut harness, state) = queued_harness(
        limits(),
        [PlannedOutcome::Completed(Box::new(transcript_result("ko")))],
    );
    let target = job("invalid-outcome-replay");
    prime_audio(&mut harness, &target);
    let flush = harness.stamp(request(
        "message-invalid-outcome-flush",
        Some(&target),
        WorkerCommand::FlushSegment,
    ));
    harness
        .submit_exact(flush.clone())
        .expect("submit first flush");
    let first = harness.drain().expect("first invalid outcome failure");
    assert!(matches!(
        only_event(&first),
        WorkerEvent::Failure { error, .. } if error.code().as_str() == "MODEL_INVALID_OUTCOME"
    ));
    assert_eq!(call_count(&state), 1);

    harness.submit_exact(flush).expect("submit replay");
    assert_eq!(harness.drain().expect("replay invalid outcome"), first);
    assert_eq!(call_count(&state), 1);
}

#[test]
fn oversized_transcript_becomes_frozen_invalid_outcome_without_backend_rerun() {
    let mut oversized = transcript_result("en");
    oversized.original_transcript =
        TranscriptText::new(&"x".repeat(65_536)).expect("bounded oversized transcript fixture");

    let target = job("oversized-transcript");
    let mut constructor_request = request(
        "message-oversized-constructor",
        Some(&target),
        WorkerCommand::FlushSegment,
    );
    constructor_request.context.delivery_session_epoch = id("constructor-session");
    constructor_request.context.message_sequence = 1;
    assert_eq!(
        WorkerResponse::for_request(
            id("message-oversized-constructor-response"),
            &constructor_request,
            &descriptor(),
            WorkerEvent::Final {
                segment_id: target.segment_id.clone(),
                last_audio_sequence: 1,
                result: oversized.clone(),
            },
            limits(),
        ),
        Err(ContractError::InvalidWorkerResponse)
    );

    let (mut harness, state) =
        queued_harness(limits(), [PlannedOutcome::Completed(Box::new(oversized))]);
    prime_audio(&mut harness, &target);
    let flush = harness.stamp(request(
        "message-oversized-transcript-flush",
        Some(&target),
        WorkerCommand::FlushSegment,
    ));
    harness
        .submit_exact(flush.clone())
        .expect("submit oversized result action");
    let first = harness.drain().expect("oversized result failure");
    assert!(matches!(
        only_event(&first),
        WorkerEvent::Failure { error, .. }
            if error.code().as_str() == "MODEL_INVALID_OUTCOME"
    ));
    assert_eq!(call_count(&state), 1);

    harness
        .submit_exact(flush)
        .expect("oversized failure replay admission");
    assert_eq!(harness.drain().expect("frozen oversized replay"), first);
    assert_eq!(call_count(&state), 1);
}

#[test]
fn duplicate_outcome_cannot_double_commit_or_cross_pair_and_session_recovers() {
    let (backend, calls) = StaleOutcomeBackend::new();
    let endpoint = QueuedWorkerSession::new(manifest(), limits(), backend)
        .expect("queued session constructor");
    let mut harness = Harness::new(endpoint, limits());
    harness
        .exchange(prepare_request("message-cross-pair-prepare"))
        .expect("prepare");

    let first_job = job("cross-pair-first");
    harness
        .exchange(request(
            "message-cross-pair-first-audio",
            Some(&first_job),
            WorkerCommand::AcceptAudio(pcm_chunk(1, 0)),
        ))
        .expect("first audio");
    let first = harness
        .exchange(request(
            "message-cross-pair-first-flush",
            Some(&first_job),
            WorkerCommand::FlushSegment,
        ))
        .expect("first action completes");
    assert!(matches!(only_event(&first), WorkerEvent::Final { .. }));
    assert_eq!(*calls.lock().expect("call lock"), 1);

    let second_job = job("cross-pair-second");
    harness
        .exchange(request(
            "message-cross-pair-second-audio",
            Some(&second_job),
            WorkerCommand::AcceptAudio(pcm_chunk(1, 0)),
        ))
        .expect("second audio");
    let second_flush = harness.stamp(request(
        "message-cross-pair-second-flush",
        Some(&second_job),
        WorkerCommand::FlushSegment,
    ));
    harness
        .submit_exact(second_flush.clone())
        .expect("second action admission");
    let invalid = harness.drain().expect("cross-paired outcome is consumed");
    assert!(matches!(
        only_event(&invalid),
        WorkerEvent::Failure { error, .. }
            if error.code().as_str() == "MODEL_INVALID_OUTCOME"
    ));
    assert!(
        !invalid
            .iter()
            .any(|response| matches!(response.event(), WorkerEvent::Final { .. }))
    );
    assert_eq!(*calls.lock().expect("call lock"), 2);

    harness
        .submit_exact(second_flush)
        .expect("invalid outcome replay admission");
    assert_eq!(harness.drain().expect("frozen invalid replay"), invalid);
    assert_eq!(*calls.lock().expect("call lock"), 2);

    let third_job = job("cross-pair-third");
    harness
        .exchange(request(
            "message-cross-pair-third-audio",
            Some(&third_job),
            WorkerCommand::AcceptAudio(pcm_chunk(1, 0)),
        ))
        .expect("third audio");
    let third = harness
        .exchange(request(
            "message-cross-pair-third-flush",
            Some(&third_job),
            WorkerCommand::FlushSegment,
        ))
        .expect("session recovers for third action");
    assert!(matches!(only_event(&third), WorkerEvent::Final { .. }));
    assert_eq!(*calls.lock().expect("call lock"), 3);
}

#[test]
fn stale_outcome_cannot_cross_delivery_sessions_with_identical_action_identity() {
    let (backend_a, backend_b, state) = SharedStaleOutcomeBackend::pair();
    let mut session_a = Harness::new(
        QueuedWorkerSession::new(manifest(), limits(), backend_a).expect("session A constructor"),
        limits(),
    );
    let mut session_b = Harness::new(
        QueuedWorkerSession::new(manifest(), limits(), backend_b).expect("session B constructor"),
        limits(),
    );
    assert_ne!(session_a.session_epoch, session_b.session_epoch);

    let target = job("cross-session-identical");
    prime_audio(&mut session_a, &target);
    let final_a = session_a
        .exchange(request(
            "message-cross-session-flush",
            Some(&target),
            WorkerCommand::FlushSegment,
        ))
        .expect("session A final");
    assert!(matches!(only_event(&final_a), WorkerEvent::Final { .. }));

    prime_audio(&mut session_b, &target);
    let flush_b = session_b.stamp(request(
        "message-cross-session-flush",
        Some(&target),
        WorkerCommand::FlushSegment,
    ));
    session_b
        .submit_exact(flush_b.clone())
        .expect("session B stale outcome admission");
    let invalid_b = session_b.drain().expect("session B stable invalid failure");
    assert!(matches!(
        only_event(&invalid_b),
        WorkerEvent::Failure { error, .. }
            if error.code().as_str() == "MODEL_INVALID_OUTCOME"
    ));
    assert_eq!(state.lock().expect("shared stale backend lock").calls, 2);

    session_b
        .submit_exact(flush_b)
        .expect("session B frozen replay admission");
    assert_eq!(
        session_b.drain().expect("session B frozen replay"),
        invalid_b
    );
    assert_eq!(state.lock().expect("shared stale backend lock").calls, 2);

    let recovery = job("cross-session-recovery");
    session_b
        .exchange(request(
            "message-cross-session-recovery-audio",
            Some(&recovery),
            WorkerCommand::AcceptAudio(pcm_chunk(1, 0)),
        ))
        .expect("session B recovery audio");
    let recovered = session_b
        .exchange(request(
            "message-cross-session-recovery-flush",
            Some(&recovery),
            WorkerCommand::FlushSegment,
        ))
        .expect("session B recovery final");
    assert!(matches!(only_event(&recovered), WorkerEvent::Final { .. }));
    assert_eq!(state.lock().expect("shared stale backend lock").calls, 3);
}

#[test]
fn queued_backend_action_blocks_cancel_restart_and_shutdown_until_drain() {
    for command in [
        cancel_request("barrier-cancel", &job("barrier")),
        request("barrier-restart", None, WorkerCommand::Restart),
        request("barrier-shutdown", None, WorkerCommand::Shutdown),
    ] {
        let (mut harness, state) = queued_harness(limits(), []);
        let target = job("barrier");
        prime_audio(&mut harness, &target);
        harness
            .submit(request(
                "message-barrier-flush",
                Some(&target),
                WorkerCommand::FlushSegment,
            ))
            .expect("submit backend action");
        assert_eq!(
            harness.submit(command),
            Err(ContractError::BackendActionInFlight)
        );
        assert_eq!(call_count(&state), 0);
        harness.drain().expect("complete backend action");
        assert_eq!(call_count(&state), 1);
    }
}

#[test]
fn queued_unresolved_action_blocks_ack_audio_and_replay_then_recovers_for_next_job() {
    let (mut harness, state) = queued_harness(limits(), []);
    let active = job("expanded-barrier-active");
    prime_audio(&mut harness, &active);
    harness
        .submit(request(
            "message-expanded-barrier-flush",
            Some(&active),
            WorkerCommand::FlushSegment,
        ))
        .expect("submit backend action");

    let next = job("expanded-barrier-next");
    for blocked in [
        request(
            "message-expanded-barrier-ack",
            Some(&active),
            WorkerCommand::AcknowledgeTerminal,
        ),
        request(
            "message-expanded-barrier-audio",
            Some(&next),
            WorkerCommand::AcceptAudio(pcm_chunk(1, 0)),
        ),
        request(
            "message-expanded-barrier-replay",
            None,
            WorkerCommand::PollReplay,
        ),
    ] {
        assert_eq!(
            harness.submit(blocked),
            Err(ContractError::BackendActionInFlight)
        );
        assert_eq!(call_count(&state), 0);
    }

    harness.drain().expect("resolve first action");
    assert_eq!(call_count(&state), 1);
    harness
        .exchange(request(
            "message-expanded-barrier-next-audio",
            Some(&next),
            WorkerCommand::AcceptAudio(pcm_chunk(1, 0)),
        ))
        .expect("next job audio after drain");
    let terminal = harness
        .exchange(request(
            "message-expanded-barrier-next-flush",
            Some(&next),
            WorkerCommand::FlushSegment,
        ))
        .expect("next job completes after drain");
    assert!(matches!(only_event(&terminal), WorkerEvent::Final { .. }));
    assert_eq!(call_count(&state), 2);
}

#[test]
fn queued_cancel_before_flush_releases_pcm_without_backend_execution() {
    let (mut harness, state) = queued_harness(limits(), []);
    harness
        .exchange(prepare_request("message-cancel-release-prepare"))
        .expect("prepare");
    let target = job("cancel-release");
    let samples: Arc<[i16]> = Arc::from([23_i16; 320]);
    let weak = Arc::downgrade(&samples);
    harness
        .exchange(request(
            "message-cancel-release-audio",
            Some(&target),
            WorkerCommand::AcceptAudio(pcm_chunk_with(1, 0, digest(14), samples)),
        ))
        .expect("accept audio");
    assert!(weak.upgrade().is_some());

    harness
        .exchange(cancel_request("message-cancel-release", &target))
        .expect("cancel active job");
    assert!(weak.upgrade().is_none());
    assert_eq!(call_count(&state), 0);
}

#[test]
fn pcm_arc_is_released_after_backend_completion_and_not_retained_by_replay() {
    let (mut harness, state) = queued_harness(limits(), []);
    harness
        .exchange(prepare_request("message-arc-release-prepare"))
        .expect("prepare");
    let target = job("arc-release");
    let samples: Arc<[i16]> = Arc::from([31_i16; 320]);
    let weak = Arc::downgrade(&samples);
    harness
        .exchange(request(
            "message-arc-release-audio",
            Some(&target),
            WorkerCommand::AcceptAudio(pcm_chunk_with(1, 0, digest(15), samples)),
        ))
        .expect("accept audio");
    assert!(weak.upgrade().is_some());

    harness
        .submit(request(
            "message-arc-release-flush",
            Some(&target),
            WorkerCommand::FlushSegment,
        ))
        .expect("submit flush");
    assert!(weak.upgrade().is_some());
    harness.drain().expect("complete backend action");
    assert!(weak.upgrade().is_none());
    assert_eq!(call_count(&state), 1);
    assert!(
        state
            .lock()
            .expect("probe lock")
            .action_debug
            .iter()
            .all(|debug| !debug.contains("31"))
    );
}

#[test]
fn audio_payload_debug_output_redacts_pcm_samples() {
    let payload = AudioPayload::PcmS16Le(Arc::from([32_767_i16, -32_768_i16]));
    let debug = format!("{payload:?}");
    assert!(debug.contains("sample_count"));
    assert!(!debug.contains("32767"));
    assert!(!debug.contains("-32768"));
}

#[test]
fn fixed_point_confidence_rejects_values_above_one_million() {
    assert_eq!(
        FixedPointConfidence::from_parts_per_million(1_000_001),
        Err(ContractError::InvalidConfidence)
    );
}

#[test]
fn production_named_sessions_accept_non_clone_backend_and_preserve_transport_shape() {
    let (backend, _) = CountingBackend::new([]);
    let mut direct =
        DirectWorkerSession::new(manifest(), limits(), backend).expect("direct constructor");
    assert_eq!(
        direct
            .handshake(hello(limits()))
            .expect("handshake")
            .transport,
        TransportKind::InProcess
    );

    let (backend, _) = CountingBackend::new([]);
    let mut queued =
        QueuedWorkerSession::new(manifest(), limits(), backend).expect("queued constructor");
    assert_eq!(
        queued
            .handshake(hello(limits()))
            .expect("handshake")
            .transport,
        TransportKind::IsolatedProcess
    );
}

#[test]
fn deterministic_fake_wrappers_reject_candidate_identity_and_non_fixture_purpose() {
    let mut candidate = manifest();
    candidate.role = WorkerRole::NativeCandidate;
    assert!(matches!(
        DirectFakeTransport::new(candidate.clone(), limits()),
        Err(ContractError::ContractFixtureRequired)
    ));
    assert!(matches!(
        InMemoryQueuedTransport::new(candidate, limits()),
        Err(ContractError::ContractFixtureRequired)
    ));

    let mut wrong_purpose = hello(limits());
    wrong_purpose.purpose = ContractPurpose::ProductShellCandidate;
    let mut direct = DirectFakeTransport::new(manifest(), limits()).expect("fixture constructor");
    assert_eq!(
        direct.handshake(wrong_purpose.clone()),
        Err(ContractError::ContractFixtureRequired)
    );
    let mut queued =
        InMemoryQueuedTransport::new(manifest(), limits()).expect("fixture constructor");
    assert_eq!(
        queued.handshake(wrong_purpose),
        Err(ContractError::ContractFixtureRequired)
    );
}

#[test]
fn deterministic_fake_wrappers_accept_only_contract_fixture_handshakes() {
    let mut direct = DirectFakeTransport::new(manifest(), limits()).expect("fixture constructor");
    assert_eq!(
        direct
            .handshake(hello(limits()))
            .expect("fixture handshake")
            .role,
        WorkerRole::ContractFixture
    );

    let mut queued =
        InMemoryQueuedTransport::new(manifest(), limits()).expect("fixture constructor");
    assert_eq!(
        queued
            .handshake(hello(limits()))
            .expect("fixture handshake")
            .role,
        WorkerRole::ContractFixture
    );
}
