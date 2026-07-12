use std::collections::HashMap;
use std::sync::Arc;

use meetingrelay_model_worker_contract::{
    Architecture, AudioChunk, AudioFormat, AudioGap, AudioPayload, AudioSource, CancelReason,
    CancelTarget, Cancellation, Capability, CapabilitySet, ContractError, ContractPurpose,
    DEFAULT_FAKE_CLOCK_DOMAIN_ID, DirectFakeTransport, EngineDescriptor, ErrorCategory,
    ErrorSeverity, ExecutionProvider, FakeClockControl, FixedPointConfidence, GapReason,
    HelloRequest, HelloResponse, Identifier, InMemoryQueuedTransport, JobKey, LanguageCode,
    MinorExtensionPolicy, MonotonicDeadline, NetworkPolicy, NotCancellableReason, OperatingSystem,
    Platform, PrepareRequest, RecoveryAction, ReplayJobState, RequestContext, ResourceEstimate,
    ResourceEstimateStatus, SampleFormat, SanitizedText, Sha256Digest, SourceRange,
    StableWorkerError, StableWorkerErrorSpec, TranscriptProvenance, TranscriptResult,
    TranscriptText, TransportKind, WORKER_PROTOCOL_V1, WorkerCommand, WorkerEndpoint, WorkerEvent,
    WorkerLimits, WorkerManifest, WorkerProtocolVersion, WorkerRequest, WorkerResponse, WorkerRole,
    run_deterministic_fixture_conformance,
};

fn digest(byte: u8) -> Sha256Digest {
    Sha256Digest::from_bytes([byte; 32])
}

fn id(value: &str) -> Identifier {
    Identifier::new(value).expect("fixture identifier")
}

fn language(value: &str) -> LanguageCode {
    LanguageCode::new(value).expect("fixture language")
}

fn platform() -> Platform {
    Platform {
        operating_system: OperatingSystem::Windows,
        architecture: Architecture::X86_64,
    }
}

fn limits() -> WorkerLimits {
    WorkerLimits {
        max_control_message_bytes: 65_536,
        max_audio_chunk_bytes: 1_048_576,
        max_pending_audio_bytes: 4_194_304,
        max_capture_epochs_per_chunk: 8,
        max_source_ranges_per_chunk: 32,
        max_in_flight_jobs: 4,
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

fn descriptor() -> EngineDescriptor {
    EngineDescriptor {
        engine_id: id("contract-fake-engine"),
        engine_version: id("1.0.0"),
        runtime_id: id("meetingrelay-contract-fixture"),
        runtime_version: id("1.0.0"),
        runtime_sha256: digest(1),
        package_lock_sha256: digest(2),
        model_id: id("contract-fake-model"),
        model_sha256: digest(3),
        model_manifest_sha256: digest(7),
        model_license_id: id("project-generated-fixture"),
        parameter_sha256: digest(4),
        execution_provider: ExecutionProvider::FixtureCpu,
        quantization: id("fixture-none"),
        languages: vec![language("en"), language("ja"), language("zh")],
        streaming: true,
        offline: true,
    }
}

fn manifest() -> WorkerManifest {
    WorkerManifest {
        worker_id: id("contract-fake-worker"),
        role: WorkerRole::ContractFixture,
        worker_build_sha256: digest(8),
        executable_sha256: digest(5),
        schema_registry_sha256: digest(6),
        descriptor: descriptor(),
    }
}

fn transcript_result() -> TranscriptResult {
    let descriptor = descriptor();
    TranscriptResult {
        original_transcript: TranscriptText::new("fixture transcript").expect("fixture transcript"),
        raw_language: SanitizedText::new("English").expect("fixture raw language"),
        normalized_language: language("en"),
        confidence: Some(
            FixedPointConfidence::from_parts_per_million(875_000)
                .expect("fixture fixed-point confidence"),
        ),
        provenance: TranscriptProvenance {
            engine_id: descriptor.engine_id,
            engine_version: descriptor.engine_version,
            runtime_id: descriptor.runtime_id,
            runtime_version: descriptor.runtime_version,
            runtime_sha256: descriptor.runtime_sha256,
            package_lock_sha256: descriptor.package_lock_sha256,
            model_id: descriptor.model_id,
            model_sha256: descriptor.model_sha256,
            model_manifest_sha256: descriptor.model_manifest_sha256,
            parameter_sha256: descriptor.parameter_sha256,
            execution_provider: descriptor.execution_provider,
            quantization: descriptor.quantization,
        },
    }
}

fn hello_request() -> HelloRequest {
    HelloRequest {
        protocol: WORKER_PROTOCOL_V1,
        platform: platform(),
        core_build_sha256: digest(9),
        purpose: ContractPurpose::ContractFixture,
        expected: manifest(),
        required_capabilities: CapabilitySet::required_v1(),
        offered_limits: limits(),
    }
}

fn hello_response(transport: TransportKind) -> HelloResponse {
    let manifest = manifest();
    HelloResponse {
        protocol: WORKER_PROTOCOL_V1,
        minimum_core_minor: 0,
        minor_extension_policy: MinorExtensionPolicy::Exact,
        platform: platform(),
        worker_id: manifest.worker_id,
        role: manifest.role,
        worker_build_sha256: manifest.worker_build_sha256,
        executable_sha256: manifest.executable_sha256,
        schema_registry_sha256: manifest.schema_registry_sha256,
        delivery_session_epoch: id("validation-delivery-session"),
        descriptor: manifest.descriptor,
        capabilities: CapabilitySet::required_v1(),
        accepted_limits: limits(),
        transport,
        network_policy: NetworkPolicy::OfflineOnly,
        silent_cloud_fallback: false,
    }
}

fn job(suffix: &str) -> JobKey {
    JobKey {
        meeting_id: id("meeting-fixture"),
        job_id: id(&format!("job-{suffix}")),
        segment_id: id(&format!("segment-{suffix}")),
    }
}

fn job_in_meeting(meeting: &str, suffix: &str) -> JobKey {
    JobKey {
        meeting_id: id(meeting),
        job_id: id(&format!("job-{suffix}")),
        segment_id: id(&format!("segment-{suffix}")),
    }
}

fn context(
    message: &str,
    job: Option<&JobKey>,
    cancel_scope: Option<&str>,
    clock_domain: &str,
    deadline_ns: u64,
) -> RequestContext {
    RequestContext {
        delivery_session_epoch: id("unstamped-delivery-session"),
        message_sequence: 0,
        message_id: id(message),
        trace_id: id("trace-fixture"),
        meeting_id: job.map(|key| key.meeting_id.clone()),
        job_id: job.map(|key| key.job_id.clone()),
        segment_id: job.map(|key| key.segment_id.clone()),
        cancel_scope_id: cancel_scope.map(id),
        deadline: MonotonicDeadline {
            clock_domain_id: id(clock_domain),
            deadline_ns,
        },
    }
}

fn request(
    message: &str,
    job: Option<&JobKey>,
    cancel_scope: Option<&str>,
    command: WorkerCommand,
) -> WorkerRequest {
    WorkerRequest {
        context: context(
            message,
            job,
            cancel_scope,
            DEFAULT_FAKE_CLOCK_DOMAIN_ID,
            10_000,
        ),
        command,
    }
}

fn prepare(message: &str) -> WorkerRequest {
    request(
        message,
        None,
        None,
        WorkerCommand::Prepare(PrepareRequest {
            model_manifest_sha256: descriptor().model_manifest_sha256,
            execution_provider: descriptor().execution_provider,
        }),
    )
}

fn meeting_cancel_request(
    message: &str,
    meeting_id: &Identifier,
    cancel_scope: &str,
    reason: CancelReason,
) -> WorkerRequest {
    let mut request = request(
        message,
        None,
        Some(cancel_scope),
        WorkerCommand::Cancel { reason },
    );
    request.context.meeting_id = Some(meeting_id.clone());
    request
}

fn chunk(sequence: u64, media_start_sample: u64) -> AudioChunk {
    let capture_epoch_id = id("epoch-fixture");
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
        payload_sha256: Some(digest(10)),
        payload: Some(AudioPayload::PcmS16Le(Arc::from([0_i16; 320]))),
    }
}

trait TestEndpoint: WorkerEndpoint + FakeClockControl {}

impl<T: WorkerEndpoint + FakeClockControl> TestEndpoint for T {}

struct AvailableEstimateEndpoint<E> {
    inner: E,
    estimate: ResourceEstimate,
    limits: WorkerLimits,
    expected_descriptor: EngineDescriptor,
    requests: HashMap<u64, WorkerRequest>,
}

impl<E: WorkerEndpoint> AvailableEstimateEndpoint<E> {
    fn new(
        inner: E,
        estimate: ResourceEstimate,
        limits: WorkerLimits,
        expected_descriptor: EngineDescriptor,
    ) -> Self {
        Self {
            inner,
            estimate,
            limits,
            expected_descriptor,
            requests: HashMap::new(),
        }
    }

    fn apply_estimate(
        &self,
        responses: Vec<WorkerResponse>,
    ) -> Result<Vec<WorkerResponse>, ContractError> {
        responses
            .into_iter()
            .map(|response| {
                let request = self
                    .requests
                    .get(&response.correlation_sequence())
                    .ok_or(ContractError::QueueInvariant)?;
                let mut spec = response.into_spec();
                if let WorkerEvent::Prepared {
                    resource_estimate, ..
                } = &mut spec.event
                {
                    *resource_estimate = self.estimate;
                }
                WorkerResponse::try_from_spec(request, &self.expected_descriptor, spec, self.limits)
            })
            .collect()
    }
}

impl<E: WorkerEndpoint> WorkerEndpoint for AvailableEstimateEndpoint<E> {
    fn handshake(&mut self, request: HelloRequest) -> Result<HelloResponse, ContractError> {
        self.inner.handshake(request)
    }

    fn submit(&mut self, request: WorkerRequest) -> Result<(), ContractError> {
        let sequence = request.context.message_sequence;
        let retained_request = request.clone();
        self.inner.submit(request)?;
        self.requests.entry(sequence).or_insert(retained_request);
        Ok(())
    }

    fn drain(&mut self) -> Result<Vec<WorkerResponse>, ContractError> {
        let responses = self.inner.drain()?;
        self.apply_estimate(responses)
    }

    fn heartbeat(&mut self) -> Result<WorkerEvent, ContractError> {
        self.inner.heartbeat()
    }
}

struct TestLane {
    endpoint: Box<dyn TestEndpoint>,
    session_epoch: Identifier,
    next_sequence: u64,
}

impl TestLane {
    fn new(mut endpoint: Box<dyn TestEndpoint>, hello: HelloRequest, label: &str) -> Self {
        let response = endpoint.handshake(hello).expect(label);
        Self {
            endpoint,
            session_epoch: response.delivery_session_epoch,
            next_sequence: 1,
        }
    }

    fn stamp(&self, mut request: WorkerRequest) -> WorkerRequest {
        if request.context.message_sequence == 0 {
            request.context.delivery_session_epoch = self.session_epoch.clone();
            request.context.message_sequence = self.next_sequence;
        }
        request
    }

    fn exchange(&mut self, request: WorkerRequest) -> Result<Vec<WorkerResponse>, ContractError> {
        let request = self.stamp(request);
        let consumes_next = request.context.message_sequence == self.next_sequence;
        let result = self.endpoint.exchange(request);
        if consumes_next && request_consumed(&result, true) {
            self.next_sequence += 1;
        }
        result
    }

    fn submit(&mut self, request: WorkerRequest) -> Result<(), ContractError> {
        let request = self.stamp(request);
        let consumes_next = request.context.message_sequence == self.next_sequence;
        let result = self.endpoint.submit(request);
        if consumes_next && request_consumed(&result, false) {
            self.next_sequence += 1;
        }
        result
    }

    fn drain(&mut self) -> Result<Vec<WorkerResponse>, ContractError> {
        self.endpoint.drain()
    }

    fn heartbeat(&mut self) -> Result<WorkerEvent, ContractError> {
        self.endpoint.heartbeat()
    }

    fn set_now_ns(&mut self, now_ns: u64) -> Result<(), ContractError> {
        self.endpoint.set_now_ns(now_ns)
    }
}

fn request_consumed<T>(result: &Result<T, ContractError>, _exchange: bool) -> bool {
    match result {
        Ok(_) => true,
        Err(error) => error.consumes_message_sequence(),
    }
}

fn handshaken_lanes() -> Vec<TestLane> {
    handshaken_lanes_with_limits(limits())
}

fn handshaken_lanes_with_limits(worker_limits: WorkerLimits) -> Vec<TestLane> {
    let mut hello = hello_request();
    hello.offered_limits = worker_limits;
    vec![
        TestLane::new(
            Box::new(
                DirectFakeTransport::new(manifest(), worker_limits).expect("direct constructor"),
            ),
            hello.clone(),
            "direct handshake",
        ),
        TestLane::new(
            Box::new(
                InMemoryQueuedTransport::new(manifest(), worker_limits)
                    .expect("queued constructor"),
            ),
            hello,
            "queued handshake",
        ),
    ]
}

fn only_event(responses: &[WorkerResponse]) -> &WorkerEvent {
    assert_eq!(responses.len(), 1);
    responses[0].event()
}

fn with_delivery(
    mut request: WorkerRequest,
    session_epoch: &Identifier,
    sequence: u64,
) -> WorkerRequest {
    request.context.delivery_session_epoch = session_epoch.clone();
    request.context.message_sequence = sequence;
    request
}

fn populate_replay_matrix(lane: &mut TestLane, prefix: &str) -> (JobKey, JobKey, JobKey, JobKey) {
    lane.exchange(prepare(&format!("message-{prefix}-prepare")))
        .expect("prepare succeeds");
    let final_job = job(&format!("{prefix}-final"));
    lane.exchange(request(
        &format!("message-{prefix}-final-audio"),
        Some(&final_job),
        None,
        WorkerCommand::AcceptAudio(chunk(1, 0)),
    ))
    .expect("final job audio accepted");
    lane.exchange(request(
        &format!("message-{prefix}-final-flush"),
        Some(&final_job),
        None,
        WorkerCommand::FlushSegment,
    ))
    .expect("final job completed");

    let failed_job = job(&format!("{prefix}-failure"));
    lane.exchange(request(
        &format!("message-{prefix}-failure"),
        Some(&failed_job),
        None,
        WorkerCommand::FlushSegment,
    ))
    .expect("failure job completed");

    let cancelled_job = job(&format!("{prefix}-cancelled"));
    lane.exchange(request(
        &format!("message-{prefix}-cancelled-audio"),
        Some(&cancelled_job),
        None,
        WorkerCommand::AcceptAudio(chunk(1, 0)),
    ))
    .expect("cancelled job audio accepted");
    lane.exchange(request(
        &format!("message-{prefix}-cancelled"),
        Some(&cancelled_job),
        Some(&format!("cancel-{prefix}")),
        WorkerCommand::Cancel {
            reason: CancelReason::MeetingEnded,
        },
    ))
    .expect("cancelled job completed");

    let active_job = job(&format!("{prefix}-active"));
    lane.exchange(request(
        &format!("message-{prefix}-active-audio"),
        Some(&active_job),
        None,
        WorkerCommand::AcceptAudio(chunk(1, 0)),
    ))
    .expect("active job audio accepted");
    (final_job, failed_job, cancelled_job, active_job)
}

fn assert_replay_state(
    responses: &[WorkerResponse],
    expected_job: &JobKey,
    state: &ReplayJobState,
) {
    assert!(responses.iter().any(|response| {
        matches!(
            response.event(),
            WorkerEvent::ReplayRequired {
                job,
                state: actual_state,
            } if job == expected_job && actual_state == state
        )
    }));
}

fn replay_facts(responses: &[WorkerResponse]) -> Vec<(JobKey, ReplayJobState)> {
    responses
        .iter()
        .filter_map(|response| match response.event() {
            WorkerEvent::ReplayRequired { job, state } => Some((job.clone(), state.clone())),
            _ => None,
        })
        .collect()
}

fn replay_remaining(responses: &[WorkerResponse]) -> Vec<u32> {
    responses
        .iter()
        .filter_map(|response| match response.event() {
            WorkerEvent::ReplayBatchStatus { remaining } => Some(*remaining),
            _ => None,
        })
        .collect()
}

#[test]
fn complete_windows_x64_handshake_is_exercised_by_both_transport_shapes() {
    let mut direct = DirectFakeTransport::new(manifest(), limits()).expect("direct constructor");
    let direct_hello = direct.handshake(hello_request()).expect("direct handshake");
    assert_eq!(direct_hello.transport, TransportKind::InProcess);

    let mut queued =
        InMemoryQueuedTransport::new(manifest(), limits()).expect("queued constructor");
    let queued_hello = queued.handshake(hello_request()).expect("queued handshake");
    assert_eq!(queued_hello.transport, TransportKind::IsolatedProcess);
    assert_eq!(direct_hello.descriptor, queued_hello.descriptor);
}

#[test]
fn delivery_epochs_are_unique_and_sequence_admission_fails_closed_without_side_effects() {
    let mut first = DirectFakeTransport::new(manifest(), limits()).expect("first constructor");
    let first_hello = first.handshake(hello_request()).expect("first handshake");
    let repeated_hello = first
        .handshake(hello_request())
        .expect("same endpoint handshake");
    assert_eq!(
        first_hello.delivery_session_epoch,
        repeated_hello.delivery_session_epoch
    );

    let mut second = DirectFakeTransport::new(manifest(), limits()).expect("second constructor");
    let second_hello = second.handshake(hello_request()).expect("second handshake");
    assert_ne!(
        first_hello.delivery_session_epoch,
        second_hello.delivery_session_epoch
    );

    let cross_session = with_delivery(
        request("message-cross-session", None, None, WorkerCommand::Describe),
        &first_hello.delivery_session_epoch,
        1,
    );
    assert_eq!(
        second.exchange(cross_session),
        Err(ContractError::DeliverySessionMismatch)
    );
    second
        .exchange(with_delivery(
            request(
                "message-second-sequence-1",
                None,
                None,
                WorkerCommand::Describe,
            ),
            &second_hello.delivery_session_epoch,
            1,
        ))
        .expect("cross-session rejection did not consume sequence one");

    first
        .exchange(with_delivery(
            request(
                "message-first-sequence-1",
                None,
                None,
                WorkerCommand::Describe,
            ),
            &first_hello.delivery_session_epoch,
            1,
        ))
        .expect("first sequence succeeds");
    assert_eq!(
        first.exchange(with_delivery(
            request(
                "message-first-sequence-3",
                None,
                None,
                WorkerCommand::Describe
            ),
            &first_hello.delivery_session_epoch,
            3,
        )),
        Err(ContractError::MessageSequenceOutOfOrder)
    );
    assert_eq!(
        first.exchange(with_delivery(
            request(
                "message-first-sequence-max",
                None,
                None,
                WorkerCommand::Describe
            ),
            &first_hello.delivery_session_epoch,
            u64::MAX,
        )),
        Err(ContractError::InvalidMessageSequence)
    );
    first
        .exchange(with_delivery(
            request(
                "message-first-sequence-2",
                None,
                None,
                WorkerCommand::Describe,
            ),
            &first_hello.delivery_session_epoch,
            2,
        ))
        .expect("gap and max-sequence rejection left sequence two available");
}

#[test]
fn zero_message_sequence_reaches_the_endpoint_and_fails_closed_without_side_effects() {
    for mut lane in handshaken_lanes() {
        let mut zero_sequence = prepare("message-zero-sequence-prepare");
        zero_sequence.context.delivery_session_epoch = lane.session_epoch.clone();
        assert_eq!(zero_sequence.context.message_sequence, 0);
        assert_eq!(
            lane.endpoint.exchange(zero_sequence),
            Err(ContractError::InvalidMessageSequence)
        );

        let health = lane
            .exchange(request(
                "message-after-zero-sequence",
                None,
                None,
                WorkerCommand::Health,
            ))
            .expect("zero sequence neither consumed sequence one nor prepared the worker");
        assert_eq!(health.len(), 1);
        assert_eq!(health[0].correlation_sequence(), 1);
        assert!(matches!(
            health[0].event(),
            WorkerEvent::Health {
                queue_depth: 0,
                model_ready: false,
                ..
            }
        ));
    }
}

#[test]
fn handshake_fails_closed_and_minor_compatibility_is_explicit() {
    let request = hello_request();

    let mut wrong_major = hello_response(TransportKind::InProcess);
    wrong_major.protocol = WorkerProtocolVersion { major: 2, minor: 0 };
    assert_eq!(
        request.validate_response(&wrong_major),
        Err(ContractError::ProtocolMismatch)
    );

    let mut optional_minor = hello_response(TransportKind::InProcess);
    optional_minor.protocol = WorkerProtocolVersion { major: 1, minor: 1 };
    optional_minor.minimum_core_minor = 0;
    optional_minor.minor_extension_policy = MinorExtensionPolicy::OptionalOnly;
    assert_eq!(request.validate_response(&optional_minor), Ok(()));

    let mut unsafe_minor = optional_minor.clone();
    unsafe_minor.minimum_core_minor = 1;
    assert_eq!(
        request.validate_response(&unsafe_minor),
        Err(ContractError::UnsafeMinorVersion)
    );
    unsafe_minor.minimum_core_minor = 0;
    unsafe_minor.minor_extension_policy = MinorExtensionPolicy::RequiresSemanticSupport;
    assert_eq!(
        request.validate_response(&unsafe_minor),
        Err(ContractError::UnsafeMinorVersion)
    );

    let mut wrong_platform = hello_response(TransportKind::InProcess);
    wrong_platform.platform.architecture = Architecture::Arm64;
    assert_eq!(
        request.validate_response(&wrong_platform),
        Err(ContractError::PlatformMismatch)
    );

    let mut wrong_model = hello_response(TransportKind::InProcess);
    wrong_model.descriptor.model_sha256 = digest(99);
    assert_eq!(
        request.validate_response(&wrong_model),
        Err(ContractError::ModelDigestMismatch)
    );

    let mut oversized = hello_response(TransportKind::InProcess);
    oversized.accepted_limits.max_audio_chunk_bytes += 1;
    assert_eq!(
        request.validate_response(&oversized),
        Err(ContractError::NegotiatedLimitExceedsOffer)
    );

    let mut slow_heartbeat = hello_response(TransportKind::InProcess);
    slow_heartbeat.accepted_limits.heartbeat_interval_ms += 1;
    assert_eq!(
        request.validate_response(&slow_heartbeat),
        Err(ContractError::NegotiatedLimitExceedsOffer)
    );
    let mut excessive_fallbacks = hello_response(TransportKind::InProcess);
    excessive_fallbacks.accepted_limits.max_fallback_nodes += 1;
    assert_eq!(
        request.validate_response(&excessive_fallbacks),
        Err(ContractError::NegotiatedLimitExceedsOffer)
    );
    let mut excessive_retired_keys = hello_response(TransportKind::InProcess);
    excessive_retired_keys.accepted_limits.max_retired_job_keys += 1;
    assert_eq!(
        request.validate_response(&excessive_retired_keys),
        Err(ContractError::NegotiatedLimitExceedsOffer)
    );

    let mut incomplete = hello_response(TransportKind::InProcess);
    incomplete.capabilities = incomplete.capabilities.without(Capability::Cancel);
    assert_eq!(
        request.validate_response(&incomplete),
        Err(ContractError::MissingCapability(Capability::Cancel))
    );
}

#[test]
fn oracle_and_product_process_boundaries_are_disjoint() {
    let mut request = hello_request();
    request.purpose = ContractPurpose::ProductShellCandidate;
    request.expected.role = WorkerRole::Oracle;
    assert_eq!(request.validate(), Err(ContractError::RolePurposeMismatch));

    request.expected.role = WorkerRole::NativeCandidate;
    let mut response = hello_response(TransportKind::IsolatedProcess);
    response.role = WorkerRole::NativeCandidate;
    assert_eq!(
        request.validate_response(&response),
        Err(ContractError::TransportRoleMismatch)
    );
}

#[test]
fn deterministic_fixture_oracle_rejects_non_fixture_purpose_or_role_before_handshake() {
    let mut candidate_manifest = manifest();
    candidate_manifest.role = WorkerRole::NativeCandidate;
    assert!(matches!(
        DirectFakeTransport::new(candidate_manifest, limits()),
        Err(ContractError::ContractFixtureRequired)
    ));

    let mut wrong_purpose = hello_request();
    wrong_purpose.purpose = ContractPurpose::OracleOnly;
    assert_eq!(
        run_deterministic_fixture_conformance(
            DirectFakeTransport::new(manifest(), limits()).expect("fixture endpoint constructor"),
            wrong_purpose,
        ),
        Err(ContractError::ContractFixtureRequired)
    );

    let mut wrong_role = hello_request();
    wrong_role.expected.role = WorkerRole::Oracle;
    assert_eq!(
        run_deterministic_fixture_conformance(
            DirectFakeTransport::new(manifest(), limits()).expect("fixture endpoint constructor"),
            wrong_role,
        ),
        Err(ContractError::ContractFixtureRequired)
    );
}

#[test]
fn protocol_vocabulary_and_digest_sentinels_fail_closed() {
    assert_eq!(Identifier::new(""), Err(ContractError::InvalidIdentifier));
    assert_eq!(
        Identifier::new("contains space"),
        Err(ContractError::InvalidIdentifier)
    );
    assert_eq!(
        LanguageCode::new("EN-us"),
        Err(ContractError::InvalidLanguageCode)
    );
    assert_eq!(
        LanguageCode::new("en--us"),
        Err(ContractError::InvalidLanguageCode)
    );
    assert_eq!(
        ExecutionProvider::try_from("python"),
        Err(ContractError::UnknownExecutionProvider)
    );
    assert_eq!(
        Capability::try_from("trust_remote_code"),
        Err(ContractError::UnknownCapability)
    );
    assert_eq!(
        WorkerRole::try_from("pyqt-product-shell"),
        Err(ContractError::UnknownWorkerRole)
    );
    assert_eq!(
        OperatingSystem::try_from("linux"),
        Err(ContractError::UnsupportedOperatingSystem)
    );
    assert_eq!(
        Architecture::try_from("x86"),
        Err(ContractError::UnsupportedArchitecture)
    );
    assert_eq!(
        TransportKind::try_from("tcp"),
        Err(ContractError::UnknownTransportKind)
    );
    assert_eq!(
        Sha256Digest::from_lower_hex(&"A".repeat(64)),
        Err(ContractError::InvalidSha256)
    );

    let mut zero_build = hello_request();
    zero_build.core_build_sha256 = Sha256Digest::from_bytes([0; 32]);
    assert_eq!(zero_build.validate(), Err(ContractError::InvalidSha256));

    let mut no_replay_credit = limits();
    no_replay_credit.max_replay_entries = 0;
    assert_eq!(
        no_replay_credit.validate(),
        Err(ContractError::InvalidWorkerLimits)
    );

    let mut no_fallback_bound = limits();
    no_fallback_bound.max_fallback_nodes = 0;
    assert_eq!(
        no_fallback_bound.validate(),
        Err(ContractError::InvalidWorkerLimits)
    );

    let mut undersized_retired_keys = limits();
    undersized_retired_keys.max_retired_job_keys = undersized_retired_keys.max_tracked_jobs - 1;
    assert_eq!(
        undersized_retired_keys.validate(),
        Err(ContractError::InvalidWorkerLimits)
    );

    let mut undersized_delivery = limits();
    undersized_delivery.max_pending_deliveries =
        undersized_delivery.max_replay_events_per_batch + 1;
    assert_eq!(
        undersized_delivery.validate(),
        Err(ContractError::InvalidWorkerLimits)
    );
    let mut invalid_manifest = manifest();
    invalid_manifest.worker_build_sha256 = Sha256Digest::from_bytes([0; 32]);
    assert!(matches!(
        DirectFakeTransport::new(invalid_manifest, limits()),
        Err(ContractError::InvalidSha256)
    ));

    let mut too_many_languages = manifest();
    too_many_languages.descriptor.languages = (0..=EngineDescriptor::MAX_LANGUAGES)
        .map(|index| language(&format!("x{index:02}")))
        .collect();
    assert!(matches!(
        DirectFakeTransport::new(too_many_languages, limits()),
        Err(ContractError::LanguageListTooLarge)
    ));
}

#[test]
fn resource_and_stable_error_invariants_are_constructor_enforced() {
    let detail = SanitizedText::new("provider fallback: GPU unavailable — CPU selected")
        .expect("bounded printable Unicode detail");
    assert!(detail.as_str().contains("GPU unavailable"));
    assert_eq!(
        SanitizedText::new("line one\nline two"),
        Err(ContractError::InvalidSanitizedText)
    );
    assert_eq!(
        SanitizedText::new(&"x".repeat(SanitizedText::MAX_BYTES + 1)),
        Err(ContractError::InvalidSanitizedText)
    );
    let unavailable = ResourceEstimate::unavailable_contract_fixture();
    assert_eq!(
        unavailable.status(),
        ResourceEstimateStatus::UnavailableContractFixture
    );
    assert_eq!(unavailable.resident_memory_bytes(), None);
    assert_eq!(unavailable.vram_bytes(), None);
    assert_eq!(
        ResourceEstimate::available(None, None),
        Err(ContractError::InvalidResourceEstimate)
    );
    assert_eq!(
        ResourceEstimate::available(Some(0), None),
        Err(ContractError::InvalidResourceEstimate)
    );
    let available = ResourceEstimate::available(Some(4_096), Some(2_048))
        .expect("measured resources are a valid available estimate");
    assert_eq!(available.status(), ResourceEstimateStatus::Available);
    assert_eq!(available.resident_memory_bytes(), Some(4_096));
    assert_eq!(available.vram_bytes(), Some(2_048));

    let stable_spec = |recovery_actions| StableWorkerErrorSpec {
        code: id("MODEL_FIXTURE_ERROR"),
        category: ErrorCategory::Model,
        severity: ErrorSeverity::Error,
        retryable: true,
        user_message_key: id("model.fixture_error"),
        recovery_actions,
        correlation_id: id("message-stable-error"),
        correlation_sequence: 1,
        meeting_id: Some(id("meeting-stable-error")),
        segment_id: Some(id("segment-stable-error")),
        subsystem: id("model-worker"),
        sanitized_detail: None,
    };
    assert_eq!(
        StableWorkerError::try_from_spec(stable_spec(Vec::new())),
        Err(ContractError::InvalidStableError)
    );
    assert_eq!(
        StableWorkerError::try_from_spec(stable_spec(vec![
            RecoveryAction::RestartWorker,
            RecoveryAction::Retry,
        ])),
        Err(ContractError::InvalidStableError)
    );
    let mut orphan_segment = stable_spec(vec![RecoveryAction::Retry]);
    orphan_segment.meeting_id = None;
    assert_eq!(
        StableWorkerError::try_from_spec(orphan_segment),
        Err(ContractError::InvalidStableError)
    );
    let mut valid_spec = stable_spec(vec![RecoveryAction::Retry]);
    valid_spec.sanitized_detail = Some(detail);
    let stable = StableWorkerError::try_from_spec(valid_spec)
        .expect("ordered non-empty recovery policy is valid");
    assert_eq!(stable.code(), &id("MODEL_FIXTURE_ERROR"));
    assert_eq!(stable.category(), ErrorCategory::Model);
    assert_eq!(stable.recovery_actions(), [RecoveryAction::Retry]);
    assert!(stable.sanitized_detail().is_some());
}

#[test]
fn worker_response_constructor_enforces_failure_cancel_and_fallback_provenance() {
    let expected_descriptor = descriptor();
    let failure_job = JobKey {
        meeting_id: id("meeting-response-validation"),
        job_id: id("job-response-validation"),
        segment_id: id("segment-response-validation"),
    };
    let mut failure_context = context(
        "message-response-validation",
        Some(&failure_job),
        None,
        DEFAULT_FAKE_CLOCK_DOMAIN_ID,
        10_000,
    );
    failure_context.message_sequence = 1;
    let failure_request = WorkerRequest {
        context: failure_context,
        command: WorkerCommand::FlushSegment,
    };
    let failure_error = StableWorkerError::try_from_spec(StableWorkerErrorSpec {
        code: id("MODEL_RESPONSE_VALIDATION"),
        category: ErrorCategory::Model,
        severity: ErrorSeverity::Error,
        retryable: true,
        user_message_key: id("model.response_validation"),
        recovery_actions: vec![RecoveryAction::Retry],
        correlation_id: failure_request.context.message_id.clone(),
        correlation_sequence: failure_request.context.message_sequence,
        meeting_id: failure_request.context.meeting_id.clone(),
        segment_id: failure_request.context.segment_id.clone(),
        subsystem: id("model-worker"),
        sanitized_detail: None,
    })
    .expect("stable failure provenance");
    let valid_failure = WorkerResponse::for_request(
        id("worker-response-validation"),
        &failure_request,
        &expected_descriptor,
        WorkerEvent::Failure {
            segment_id: failure_job.segment_id.clone(),
            error: failure_error.clone(),
        },
        limits(),
    )
    .expect("matching outer and stable failure provenance");
    valid_failure
        .validate(&failure_request, &expected_descriptor, limits())
        .expect("public validator accepts the constructor output");

    let valid_outer = valid_failure.into_spec();
    let assert_mismatched_outer = |spec| {
        assert_eq!(
            WorkerResponse::try_from_spec(&failure_request, &expected_descriptor, spec, limits(),),
            Err(ContractError::InvalidWorkerResponse)
        );
    };
    let mut mismatch = valid_outer.clone();
    mismatch.correlation_id = id("message-wrong-outer-correlation");
    assert_mismatched_outer(mismatch);
    let mut mismatch = valid_outer.clone();
    mismatch.correlation_sequence += 1;
    assert_mismatched_outer(mismatch);
    let mut mismatch = valid_outer.clone();
    mismatch.trace_id = id("trace-wrong-outer");
    assert_mismatched_outer(mismatch);
    let mut mismatch = valid_outer.clone();
    mismatch.meeting_id = Some(id("meeting-wrong-outer"));
    assert_mismatched_outer(mismatch);
    let mut mismatch = valid_outer.clone();
    mismatch.job_id = Some(id("job-wrong-outer"));
    assert_mismatched_outer(mismatch);
    let mut mismatch = valid_outer;
    mismatch.segment_id = Some(id("segment-wrong-outer"));
    assert_mismatched_outer(mismatch);
    let mismatched_error_spec = StableWorkerErrorSpec {
        code: id("MODEL_RESPONSE_VALIDATION"),
        category: ErrorCategory::Model,
        severity: ErrorSeverity::Error,
        retryable: true,
        user_message_key: id("model.response_validation"),
        recovery_actions: vec![RecoveryAction::Retry],
        correlation_id: id("message-wrong-correlation"),
        correlation_sequence: 1,
        meeting_id: Some(failure_job.meeting_id.clone()),
        segment_id: Some(failure_job.segment_id.clone()),
        subsystem: id("model-worker"),
        sanitized_detail: None,
    };
    let mismatched_error = StableWorkerError::try_from_spec(mismatched_error_spec.clone())
        .expect("internally valid but response-mismatched error");
    assert_eq!(
        WorkerResponse::for_request(
            id("worker-response-mismatched-failure"),
            &failure_request,
            &expected_descriptor,
            WorkerEvent::Failure {
                segment_id: failure_job.segment_id.clone(),
                error: mismatched_error,
            },
            limits(),
        ),
        Err(ContractError::InvalidWorkerResponse)
    );
    let meeting_id = id("meeting-response-cancel");
    let cancel_job = job_in_meeting(meeting_id.as_str(), "response-cancel");
    let mut meeting_context = context(
        "message-response-cancel",
        None,
        Some("scope-response-cancel"),
        DEFAULT_FAKE_CLOCK_DOMAIN_ID,
        10_000,
    );
    meeting_context.message_sequence = 2;
    meeting_context.meeting_id = Some(meeting_id.clone());
    let meeting_request = WorkerRequest {
        context: meeting_context,
        command: WorkerCommand::Cancel {
            reason: CancelReason::MeetingEnded,
        },
    };
    WorkerResponse::for_request(
        id("worker-response-valid-meeting-cancel"),
        &meeting_request,
        &expected_descriptor,
        WorkerEvent::Cancelled {
            job: cancel_job.clone(),
            cancel_scope_id: id("scope-response-cancel"),
            reason: CancelReason::MeetingEnded,
            repeated: false,
        },
        limits(),
    )
    .expect("meeting target covers the cancelled job");
    assert_eq!(
        WorkerResponse::for_request(
            id("worker-response-wrong-meeting-cancel"),
            &meeting_request,
            &expected_descriptor,
            WorkerEvent::Cancelled {
                job: job_in_meeting("meeting-response-other", "response-cancel"),
                cancel_scope_id: id("scope-response-cancel"),
                reason: CancelReason::MeetingEnded,
                repeated: false,
            },
            limits(),
        ),
        Err(ContractError::InvalidWorkerResponse)
    );

    let mut global_context = context(
        "message-response-prepared",
        None,
        None,
        DEFAULT_FAKE_CLOCK_DOMAIN_ID,
        10_000,
    );
    global_context.message_sequence = 3;
    let prepare_request = WorkerRequest {
        context: global_context.clone(),
        command: WorkerCommand::Prepare(PrepareRequest {
            model_manifest_sha256: descriptor().model_manifest_sha256,
            execution_provider: ExecutionProvider::FixtureCpu,
        }),
    };
    let too_many_fallback_nodes = (0..=limits().max_fallback_nodes)
        .map(|index| id(&format!("fallback-node-{index}")))
        .collect();
    assert_eq!(
        WorkerResponse::for_request(
            id("worker-response-fallback-overflow"),
            &prepare_request,
            &expected_descriptor,
            WorkerEvent::Prepared {
                ready: true,
                execution_provider: ExecutionProvider::FixtureCpu,
                fallback_nodes: too_many_fallback_nodes,
                resource_estimate: ResourceEstimate::unavailable_contract_fixture(),
            },
            limits(),
        ),
        Err(ContractError::InvalidWorkerResponse)
    );

    global_context.message_sequence = 4;
    let replay_request = WorkerRequest {
        context: global_context,
        command: WorkerCommand::PollReplay,
    };
    assert_eq!(
        WorkerResponse::for_request(
            id("worker-response-replay-wrong-cancel-target"),
            &replay_request,
            &expected_descriptor,
            WorkerEvent::ReplayRequired {
                job: cancel_job,
                state: ReplayJobState::Cancelled {
                    cancellation: Cancellation {
                        scope_id: id("scope-response-cancel"),
                        target: CancelTarget::Meeting(id("meeting-response-other")),
                        reason: CancelReason::MeetingEnded,
                    },
                },
            },
            limits(),
        ),
        Err(ContractError::InvalidWorkerResponse)
    );
}

#[test]
fn worker_response_command_event_matrix_and_numeric_domains_fail_closed() {
    let expected_descriptor = descriptor();
    let worker_limits = limits();
    let sequenced = |mut request: WorkerRequest| {
        request.context.message_sequence = 1;
        request
    };
    let assert_invalid = |request: &WorkerRequest, event: WorkerEvent| {
        assert_eq!(
            WorkerResponse::for_request(
                id("worker-invalid-matrix-response"),
                request,
                &expected_descriptor,
                event,
                worker_limits,
            ),
            Err(ContractError::InvalidWorkerResponse)
        );
    };

    let describe_request = sequenced(request(
        "message-matrix-describe",
        None,
        None,
        WorkerCommand::Describe,
    ));
    let mut drifted_descriptor = expected_descriptor.clone();
    drifted_descriptor.engine_version = id("2.0.0");
    assert_invalid(
        &describe_request,
        WorkerEvent::Described {
            descriptor: drifted_descriptor,
        },
    );
    let mut invalid_descriptor = expected_descriptor.clone();
    invalid_descriptor.streaming = false;
    assert_invalid(
        &describe_request,
        WorkerEvent::Described {
            descriptor: invalid_descriptor,
        },
    );
    assert_invalid(&describe_request, WorkerEvent::Heartbeat { sequence: 1 });
    assert_invalid(
        &describe_request,
        WorkerEvent::Health {
            heartbeat_sequence: 0,
            last_progress_sequence: None,
            queue_depth: 0,
            model_ready: false,
            execution_provider: ExecutionProvider::FixtureCpu,
            restart_count: 0,
        },
    );

    let prepare_request = sequenced(prepare("message-matrix-prepare"));
    assert_invalid(
        &prepare_request,
        WorkerEvent::Prepared {
            ready: false,
            execution_provider: ExecutionProvider::FixtureCpu,
            fallback_nodes: Vec::new(),
            resource_estimate: ResourceEstimate::unavailable_contract_fixture(),
        },
    );
    assert_invalid(
        &prepare_request,
        WorkerEvent::Prepared {
            ready: true,
            execution_provider: ExecutionProvider::Cpu,
            fallback_nodes: Vec::new(),
            resource_estimate: ResourceEstimate::unavailable_contract_fixture(),
        },
    );
    assert_invalid(
        &prepare_request,
        WorkerEvent::Prepared {
            ready: true,
            execution_provider: ExecutionProvider::FixtureCpu,
            fallback_nodes: vec![id("fallback-b"), id("fallback-a")],
            resource_estimate: ResourceEstimate::unavailable_contract_fixture(),
        },
    );
    let preparation_error = |retryable, recovery_actions, meeting_id| {
        StableWorkerError::try_from_spec(StableWorkerErrorSpec {
            code: id("MODEL_PREPARATION_FAILED"),
            category: ErrorCategory::Model,
            severity: ErrorSeverity::Error,
            retryable,
            user_message_key: id("model.backend_failure"),
            recovery_actions,
            correlation_id: prepare_request.context.message_id.clone(),
            correlation_sequence: prepare_request.context.message_sequence,
            meeting_id,
            segment_id: None,
            subsystem: id("model-worker"),
            sanitized_detail: None,
        })
        .expect("well-shaped preparation error fixture")
    };
    assert_invalid(
        &prepare_request,
        WorkerEvent::PreparationFailed {
            error: preparation_error(
                true,
                vec![
                    RecoveryAction::RestartWorker,
                    RecoveryAction::ChooseAnotherEngine,
                ],
                None,
            ),
        },
    );
    assert_invalid(
        &prepare_request,
        WorkerEvent::PreparationFailed {
            error: preparation_error(
                false,
                vec![
                    RecoveryAction::RestartWorker,
                    RecoveryAction::ChooseAnotherEngine,
                ],
                Some(id("unexpected-preparation-meeting")),
            ),
        },
    );

    let target = job("matrix-values");
    let audio_request = sequenced(request(
        "message-matrix-audio",
        Some(&target),
        None,
        WorkerCommand::AcceptAudio(chunk(1, 0)),
    ));
    assert_invalid(&audio_request, WorkerEvent::AudioAccepted { sequence: 2 });
    assert_invalid(&audio_request, WorkerEvent::AudioAccepted { sequence: 0 });

    let gap = AudioGap {
        sequence: 1,
        media_start_sample: 0,
        media_end_sample: 320,
        reason: GapReason::DeviceSwitch,
    };
    let gap_request = sequenced(request(
        "message-matrix-gap",
        Some(&target),
        None,
        WorkerCommand::DeclareGap(gap),
    ));
    assert_invalid(
        &gap_request,
        WorkerEvent::GapAccepted {
            sequence: 1,
            media_start_sample: 0,
            media_end_sample: 321,
            reason: GapReason::DeviceSwitch,
        },
    );
    assert_invalid(
        &gap_request,
        WorkerEvent::GapAccepted {
            sequence: 1,
            media_start_sample: 0,
            media_end_sample: 0,
            reason: GapReason::DeviceSwitch,
        },
    );
    assert_invalid(
        &gap_request,
        WorkerEvent::GapAccepted {
            sequence: 1,
            media_start_sample: 0,
            media_end_sample: 320,
            reason: GapReason::SourceUnavailable,
        },
    );

    let poll_request = sequenced(request(
        "message-matrix-progress",
        Some(&target),
        None,
        WorkerCommand::PollEvents,
    ));
    assert_invalid(
        &poll_request,
        WorkerEvent::Progress {
            progress_sequence: 0,
            last_audio_sequence: 1,
        },
    );
    assert_invalid(
        &poll_request,
        WorkerEvent::Progress {
            progress_sequence: 1,
            last_audio_sequence: 0,
        },
    );

    let flush_request = sequenced(request(
        "message-matrix-final",
        Some(&target),
        None,
        WorkerCommand::FlushSegment,
    ));
    assert_invalid(
        &flush_request,
        WorkerEvent::Final {
            segment_id: target.segment_id.clone(),
            last_audio_sequence: 0,
            result: transcript_result(),
        },
    );

    let cancel_request = sequenced(request(
        "message-matrix-cancel",
        Some(&target),
        Some("scope-matrix-cancel"),
        WorkerCommand::Cancel {
            reason: CancelReason::MeetingEnded,
        },
    ));
    assert_invalid(
        &cancel_request,
        WorkerEvent::CancelRequested {
            job: target.clone(),
            cancel_scope_id: id("scope-wrong-cancel"),
            reason: CancelReason::MeetingEnded,
            repeated: false,
        },
    );
    assert_invalid(
        &cancel_request,
        WorkerEvent::Cancelled {
            job: target.clone(),
            cancel_scope_id: id("scope-matrix-cancel"),
            reason: CancelReason::UserRequested,
            repeated: false,
        },
    );
    assert_invalid(
        &cancel_request,
        WorkerEvent::NotCancellable {
            job: target.clone(),
            cancel_scope_id: id("scope-matrix-cancel"),
            requested_reason: CancelReason::MeetingEnded,
            reason: NotCancellableReason::AlreadyFinal,
            existing_cancellation: Some(Cancellation {
                scope_id: id("scope-existing-cancel"),
                target: CancelTarget::Job(target.clone()),
                reason: CancelReason::UserRequested,
            }),
        },
    );
    assert_invalid(
        &cancel_request,
        WorkerEvent::NotCancellable {
            job: target.clone(),
            cancel_scope_id: id("scope-matrix-cancel"),
            requested_reason: CancelReason::MeetingEnded,
            reason: NotCancellableReason::AlreadyCancelled,
            existing_cancellation: None,
        },
    );
    assert_invalid(
        &cancel_request,
        WorkerEvent::NotCancellable {
            job: target.clone(),
            cancel_scope_id: id("scope-matrix-cancel"),
            requested_reason: CancelReason::MeetingEnded,
            reason: NotCancellableReason::AlreadyCancelled,
            existing_cancellation: Some(Cancellation {
                scope_id: id("scope-existing-cancel"),
                target: CancelTarget::Meeting(id("meeting-wrong-cancel-target")),
                reason: CancelReason::UserRequested,
            }),
        },
    );

    let acknowledge_request = sequenced(request(
        "message-matrix-ack",
        Some(&target),
        None,
        WorkerCommand::AcknowledgeTerminal,
    ));
    assert_invalid(
        &acknowledge_request,
        WorkerEvent::TerminalAcknowledged {
            job: job("matrix-wrong-ack"),
        },
    );

    let replay_request = sequenced(request(
        "message-matrix-replay",
        None,
        None,
        WorkerCommand::PollReplay,
    ));
    assert_invalid(
        &replay_request,
        WorkerEvent::ReplayBatchStatus { remaining: 0 },
    );
    assert_invalid(
        &replay_request,
        WorkerEvent::ReplayBatchStatus {
            remaining: worker_limits.max_tracked_jobs + 1,
        },
    );
    assert_invalid(
        &replay_request,
        WorkerEvent::ReplayBatchStatus {
            remaining: u32::MAX,
        },
    );

    let restart_request = sequenced(request(
        "message-matrix-restart",
        None,
        None,
        WorkerCommand::Restart,
    ));
    assert_invalid(
        &restart_request,
        WorkerEvent::Restarted { restart_count: 0 },
    );
    assert_invalid(&restart_request, WorkerEvent::ShutdownComplete);

    let health_request = sequenced(request(
        "message-matrix-health",
        None,
        None,
        WorkerCommand::Health,
    ));
    assert_invalid(
        &health_request,
        WorkerEvent::Health {
            heartbeat_sequence: 0,
            last_progress_sequence: None,
            queue_depth: worker_limits.max_pending_commands,
            model_ready: false,
            execution_provider: ExecutionProvider::FixtureCpu,
            restart_count: 0,
        },
    );
    assert_invalid(
        &health_request,
        WorkerEvent::Health {
            heartbeat_sequence: 0,
            last_progress_sequence: Some(0),
            queue_depth: 0,
            model_ready: false,
            execution_provider: ExecutionProvider::FixtureCpu,
            restart_count: 0,
        },
    );
    assert_invalid(
        &health_request,
        WorkerEvent::Health {
            heartbeat_sequence: 0,
            last_progress_sequence: None,
            queue_depth: 0,
            model_ready: false,
            execution_provider: ExecutionProvider::Cpu,
            restart_count: 0,
        },
    );
}

#[test]
fn semantic_envelope_deadline_audio_provenance_and_sequence_run_on_both_lanes() {
    for mut lane in handshaken_lanes() {
        let segment = job("audio");
        assert_eq!(
            lane.exchange(request(
                "message-before-prepare",
                Some(&segment),
                None,
                WorkerCommand::AcceptAudio(chunk(1, 0)),
            )),
            Err(ContractError::NotPrepared)
        );

        let mut missing_identity = request(
            "message-missing-identity",
            None,
            None,
            WorkerCommand::AcceptAudio(chunk(1, 0)),
        );
        missing_identity.context.meeting_id = Some(id("meeting-fixture"));
        assert_eq!(
            lane.exchange(missing_identity),
            Err(ContractError::MissingRequestIdentity)
        );

        let mut wrong_clock = prepare("message-wrong-clock");
        wrong_clock.context.deadline.clock_domain_id = id("other-clock");
        assert_eq!(
            lane.exchange(wrong_clock),
            Err(ContractError::ClockDomainMismatch)
        );

        let mut expired = prepare("message-expired");
        expired.context.deadline.deadline_ns = 100;
        assert_eq!(lane.exchange(expired), Err(ContractError::DeadlineExpired));

        lane.exchange(prepare("message-prepare"))
            .expect("prepare succeeds");

        let mut too_large = chunk(1, 0);
        too_large.payload_bytes = limits().max_audio_chunk_bytes + 1;
        assert_eq!(
            lane.exchange(request(
                "message-too-large",
                Some(&segment),
                None,
                WorkerCommand::AcceptAudio(too_large),
            )),
            Err(ContractError::AudioChunkTooLarge)
        );

        let mut invalid_source = chunk(1, 0);
        invalid_source.source_ranges[0].capture_epoch_id = id("unknown-epoch");
        assert_eq!(
            lane.exchange(request(
                "message-invalid-source",
                Some(&segment),
                None,
                WorkerCommand::AcceptAudio(invalid_source),
            )),
            Err(ContractError::InvalidSourceRange)
        );

        lane.exchange(request(
            "message-audio-1",
            Some(&segment),
            None,
            WorkerCommand::AcceptAudio(chunk(1, 0)),
        ))
        .expect("first audio succeeds");
        assert_eq!(
            lane.exchange(request(
                "message-audio-duplicate",
                Some(&segment),
                None,
                WorkerCommand::AcceptAudio(chunk(1, 320)),
            )),
            Err(ContractError::NonIncreasingAudioSequence)
        );

        assert_eq!(
            lane.exchange(request(
                "message-audio-gap-without-fact",
                Some(&segment),
                None,
                WorkerCommand::AcceptAudio(chunk(3, 320)),
            )),
            Err(ContractError::NonContiguousAudioSequence)
        );
        assert_eq!(
            lane.exchange(request(
                "message-audio-overlap",
                Some(&segment),
                None,
                WorkerCommand::AcceptAudio(chunk(2, 0)),
            )),
            Err(ContractError::NonContiguousMediaRange)
        );

        let mut extra_epoch = chunk(2, 320);
        extra_epoch.capture_epoch_ids.push(id("unused-epoch"));
        extra_epoch.capture_epoch_ids.sort();
        assert_eq!(
            lane.exchange(request(
                "message-audio-unused-epoch",
                Some(&segment),
                None,
                WorkerCommand::AcceptAudio(extra_epoch),
            )),
            Err(ContractError::InvalidSourceRange)
        );

        let gap_response = lane
            .exchange(request(
                "message-explicit-gap",
                Some(&segment),
                None,
                WorkerCommand::DeclareGap(AudioGap {
                    sequence: 2,
                    media_start_sample: 320,
                    media_end_sample: 640,
                    reason: GapReason::CaptureDiscontinuity,
                }),
            ))
            .expect("explicit gap succeeds");
        assert!(matches!(
            only_event(&gap_response),
            WorkerEvent::GapAccepted {
                sequence: 2,
                media_start_sample: 320,
                media_end_sample: 640,
                reason: GapReason::CaptureDiscontinuity,
            }
        ));
        lane.exchange(request(
            "message-audio-after-gap",
            Some(&segment),
            None,
            WorkerCommand::AcceptAudio(chunk(3, 640)),
        ))
        .expect("audio after explicit gap succeeds");
    }
}

#[test]
fn exact_request_targets_reject_global_job_and_partial_cancel_identity() {
    for mut lane in handshaken_lanes() {
        let target = job("target-shape");
        let global_with_job = request(
            "message-global-with-job",
            Some(&target),
            None,
            WorkerCommand::Describe,
        );
        assert_eq!(
            lane.exchange(global_with_job),
            Err(ContractError::UnexpectedRequestIdentity)
        );
        lane.exchange(prepare("message-target-prepare"))
            .expect("static envelope rejection did not consume sequence");

        assert_eq!(
            lane.exchange(request(
                "message-job-with-cancel-ref",
                Some(&target),
                Some("unexpected-cancel-ref"),
                WorkerCommand::PollEvents,
            )),
            Err(ContractError::UnexpectedRequestIdentity)
        );
        lane.exchange(request(
            "message-target-audio",
            Some(&target),
            None,
            WorkerCommand::AcceptAudio(chunk(1, 0)),
        ))
        .expect("job target remains available after rejected envelope");

        let mut missing_cancel_target = request(
            "message-cancel-missing-target",
            None,
            Some("cancel-missing-target"),
            WorkerCommand::Cancel {
                reason: CancelReason::UserRequested,
            },
        );
        missing_cancel_target.context.meeting_id = None;
        assert_eq!(
            lane.exchange(missing_cancel_target),
            Err(ContractError::MissingRequestIdentity)
        );

        let mut partial_cancel = request(
            "message-cancel-partial-target",
            None,
            Some("cancel-partial-target"),
            WorkerCommand::Cancel {
                reason: CancelReason::UserRequested,
            },
        );
        partial_cancel.context.meeting_id = Some(target.meeting_id.clone());
        partial_cancel.context.job_id = Some(target.job_id.clone());
        assert_eq!(
            lane.exchange(partial_cancel),
            Err(ContractError::UnexpectedRequestIdentity)
        );
    }
}

#[test]
fn codec_neutral_control_and_audio_metadata_budgets_reject_before_admission() {
    let mut metadata_limits = limits();
    metadata_limits.max_capture_epochs_per_chunk = 1;
    metadata_limits.max_source_ranges_per_chunk = 1;
    for mut lane in handshaken_lanes_with_limits(metadata_limits) {
        lane.exchange(prepare("message-metadata-prepare"))
            .expect("prepare succeeds");
        let target = job("metadata-bound");
        let mut oversized = chunk(1, 0);
        oversized.capture_epoch_ids.push(id("epoch-z"));
        oversized.capture_epoch_ids.sort();
        assert_eq!(
            lane.exchange(request(
                "message-metadata-oversized",
                Some(&target),
                None,
                WorkerCommand::AcceptAudio(oversized),
            )),
            Err(ContractError::AudioMetadataTooLarge)
        );

        let mut oversized_ranges = chunk(1, 0);
        let mut latter_half = oversized_ranges.source_ranges[0].clone();
        oversized_ranges.source_ranges[0].device_end_sample = 160;
        oversized_ranges.source_ranges[0].meeting_end_sample = 160;
        latter_half.device_start_sample = 160;
        latter_half.meeting_start_sample = 160;
        oversized_ranges.source_ranges.push(latter_half);
        assert_eq!(
            oversized_ranges.source_ranges.len(),
            metadata_limits.max_source_ranges_per_chunk as usize + 1
        );
        assert_eq!(
            lane.exchange(request(
                "message-source-ranges-oversized",
                Some(&target),
                None,
                WorkerCommand::AcceptAudio(oversized_ranges),
            )),
            Err(ContractError::AudioMetadataTooLarge)
        );

        lane.exchange(request(
            "message-metadata-valid",
            Some(&target),
            None,
            WorkerCommand::AcceptAudio(chunk(1, 0)),
        ))
        .expect("metadata rejection did not reserve sequence or mutate job state");
    }

    let mut control_limits = limits();
    control_limits.max_control_message_bytes = 256;
    for mut lane in handshaken_lanes_with_limits(control_limits) {
        lane.exchange(prepare("message-control-prepare"))
            .expect("prepare fits the conservative control budget");
        assert_eq!(
            lane.exchange(request(
                "message-control-oversized",
                Some(&job("control-bound")),
                None,
                WorkerCommand::AcceptAudio(chunk(1, 0)),
            )),
            Err(ContractError::ControlMessageTooLarge)
        );
        lane.exchange(request(
            "message-control-valid",
            None,
            None,
            WorkerCommand::Describe,
        ))
        .expect("control-budget rejection did not reserve sequence");
    }
}

#[test]
fn stream_gaps_do_not_become_audio_and_progress_keeps_accept_time_snapshots() {
    for mut lane in handshaken_lanes() {
        lane.exchange(prepare("message-stream-prepare"))
            .expect("prepare succeeds");

        let empty = job("empty-flush");
        let empty_flush = lane
            .exchange(request(
                "message-empty-flush",
                Some(&empty),
                None,
                WorkerCommand::FlushSegment,
            ))
            .expect("empty flush is an explicit failure");
        assert!(matches!(
            only_event(&empty_flush),
            WorkerEvent::Failure { .. }
        ));

        let gap_only = job("gap-only");
        lane.exchange(request(
            "message-gap-only",
            Some(&gap_only),
            None,
            WorkerCommand::DeclareGap(AudioGap {
                sequence: 1,
                media_start_sample: 0,
                media_end_sample: 320,
                reason: GapReason::SourceUnavailable,
            }),
        ))
        .expect("gap fact is accepted");
        let gap_only_flush = lane
            .exchange(request(
                "message-gap-only-flush",
                Some(&gap_only),
                None,
                WorkerCommand::FlushSegment,
            ))
            .expect("gap-only flush is an explicit failure");
        assert!(matches!(
            only_event(&gap_only_flush),
            WorkerEvent::Failure { .. }
        ));

        let audio_then_gap = job("audio-gap");
        lane.exchange(request(
            "message-audio-gap-audio",
            Some(&audio_then_gap),
            None,
            WorkerCommand::AcceptAudio(chunk(1, 0)),
        ))
        .expect("real audio is accepted");
        lane.exchange(request(
            "message-audio-gap-gap",
            Some(&audio_then_gap),
            None,
            WorkerCommand::DeclareGap(AudioGap {
                sequence: 2,
                media_start_sample: 320,
                media_end_sample: 640,
                reason: GapReason::CaptureDiscontinuity,
            }),
        ))
        .expect("gap advances only the stream cursor");
        for expected_progress_sequence in [1, 2] {
            let progress = lane
                .exchange(request(
                    &format!("message-audio-gap-progress-{expected_progress_sequence}"),
                    Some(&audio_then_gap),
                    None,
                    WorkerCommand::PollEvents,
                ))
                .expect("queued progress is delivered");
            assert_eq!(
                only_event(&progress),
                &WorkerEvent::Progress {
                    progress_sequence: expected_progress_sequence,
                    last_audio_sequence: 1,
                }
            );
        }
        let audio_gap_final = lane
            .exchange(request(
                "message-audio-gap-flush",
                Some(&audio_then_gap),
                None,
                WorkerCommand::FlushSegment,
            ))
            .expect("real audio followed by a gap can finalize");
        assert!(matches!(
            only_event(&audio_gap_final),
            WorkerEvent::Final {
                last_audio_sequence: 1,
                ..
            }
        ));

        let two_audio = job("two-audio");
        lane.exchange(request(
            "message-two-audio-1",
            Some(&two_audio),
            None,
            WorkerCommand::AcceptAudio(chunk(1, 0)),
        ))
        .expect("first audio accepted");
        lane.exchange(request(
            "message-two-audio-2",
            Some(&two_audio),
            None,
            WorkerCommand::AcceptAudio(chunk(2, 320)),
        ))
        .expect("second audio accepted");
        for (expected_progress_sequence, expected_audio_sequence) in
            [(3, 1), (4, 1), (5, 2), (6, 2)]
        {
            let progress = lane
                .exchange(request(
                    &format!("message-two-audio-progress-{expected_progress_sequence}"),
                    Some(&two_audio),
                    None,
                    WorkerCommand::PollEvents,
                ))
                .expect("progress snapshot is delivered");
            assert_eq!(
                only_event(&progress),
                &WorkerEvent::Progress {
                    progress_sequence: expected_progress_sequence,
                    last_audio_sequence: expected_audio_sequence,
                }
            );
        }
    }
}

#[test]
fn burst_audio_coalesces_ephemeral_progress_to_the_negotiated_latest_window() {
    let mut progress_limits = limits();
    progress_limits.max_pending_progress_per_job = 3;
    for mut lane in handshaken_lanes_with_limits(progress_limits) {
        lane.exchange(prepare("message-progress-cap-prepare"))
            .expect("prepare succeeds");
        let target = job("progress-cap");
        for sequence in 1..=5 {
            lane.exchange(request(
                &format!("message-progress-cap-audio-{sequence}"),
                Some(&target),
                None,
                WorkerCommand::AcceptAudio(chunk(sequence, (sequence - 1) * 320)),
            ))
            .expect("burst audio remains admissible");
        }

        for (progress_sequence, last_audio_sequence) in [(8, 4), (9, 5), (10, 5)] {
            let progress = lane
                .exchange(request(
                    &format!("message-progress-cap-poll-{progress_sequence}"),
                    Some(&target),
                    None,
                    WorkerCommand::PollEvents,
                ))
                .expect("bounded progress drains");
            assert_eq!(
                only_event(&progress),
                &WorkerEvent::Progress {
                    progress_sequence,
                    last_audio_sequence,
                }
            );
        }
        assert!(
            lane.exchange(request(
                "message-progress-cap-empty",
                Some(&target),
                None,
                WorkerCommand::PollEvents,
            ))
            .expect("empty bounded progress poll")
            .is_empty()
        );
        assert!(matches!(
            only_event(
                &lane
                    .exchange(request(
                        "message-progress-cap-final",
                        Some(&target),
                        None,
                        WorkerCommand::FlushSegment,
                    ))
                    .expect("latest audio finalizes")
            ),
            WorkerEvent::Final {
                last_audio_sequence: 5,
                ..
            }
        ));
    }
}

#[test]
fn audio_gap_audio_stream_reports_post_gap_sequence_three_and_finalizes_real_audio() {
    for mut lane in handshaken_lanes() {
        lane.exchange(prepare("message-post-gap-prepare"))
            .expect("prepare succeeds");
        let target = job("post-gap-audio");
        lane.exchange(request(
            "message-post-gap-audio-1",
            Some(&target),
            None,
            WorkerCommand::AcceptAudio(chunk(1, 0)),
        ))
        .expect("first audio accepted");
        lane.exchange(request(
            "message-post-gap-gap-2",
            Some(&target),
            None,
            WorkerCommand::DeclareGap(AudioGap {
                sequence: 2,
                media_start_sample: 320,
                media_end_sample: 640,
                reason: GapReason::CaptureDiscontinuity,
            }),
        ))
        .expect("gap accepted");
        let post_gap = lane
            .exchange(request(
                "message-post-gap-audio-3",
                Some(&target),
                None,
                WorkerCommand::AcceptAudio(chunk(3, 640)),
            ))
            .expect("post-gap audio accepted");
        assert_eq!(
            only_event(&post_gap),
            &WorkerEvent::AudioAccepted { sequence: 3 }
        );
        for (progress_sequence, last_audio_sequence) in [(1, 1), (2, 1), (3, 3), (4, 3)] {
            let progress = lane
                .exchange(request(
                    &format!("message-post-gap-progress-{progress_sequence}"),
                    Some(&target),
                    None,
                    WorkerCommand::PollEvents,
                ))
                .expect("progress snapshot drains");
            assert_eq!(
                only_event(&progress),
                &WorkerEvent::Progress {
                    progress_sequence,
                    last_audio_sequence,
                }
            );
        }
        assert!(matches!(
            only_event(
                &lane
                    .exchange(request(
                        "message-post-gap-final",
                        Some(&target),
                        None,
                        WorkerCommand::FlushSegment,
                    ))
                    .expect("post-gap audio finalizes")
            ),
            WorkerEvent::Final {
                last_audio_sequence: 3,
                ..
            }
        ));
    }
}

#[test]
fn terminal_state_is_scoped_per_segment_and_failure_is_stable() {
    for mut lane in handshaken_lanes() {
        lane.exchange(prepare("message-prepare"))
            .expect("prepare succeeds");
        for suffix in ["a", "b"] {
            let segment = job(suffix);
            lane.exchange(request(
                &format!("message-audio-{suffix}"),
                Some(&segment),
                None,
                WorkerCommand::AcceptAudio(chunk(1, 0)),
            ))
            .expect("audio succeeds");
            let final_response = lane
                .exchange(request(
                    &format!("message-flush-{suffix}"),
                    Some(&segment),
                    None,
                    WorkerCommand::FlushSegment,
                ))
                .expect("flush succeeds");
            assert!(matches!(
                only_event(&final_response),
                WorkerEvent::Final { .. }
            ));
        }

        let failed_segment = job("failure");
        let failure_response = lane
            .exchange(request(
                "message-failure",
                Some(&failed_segment),
                None,
                WorkerCommand::FlushSegment,
            ))
            .expect("explicit failure succeeds");
        match only_event(&failure_response) {
            WorkerEvent::Failure { error, .. } => {
                assert_eq!(error.category(), ErrorCategory::Audio);
                assert_eq!(error.severity(), ErrorSeverity::Error);
                assert!(error.retryable());
                assert_eq!(error.user_message_key(), &id("model.no_audio"));
                assert_eq!(error.recovery_actions(), [RecoveryAction::ReprocessAudio]);
                assert_eq!(error.correlation_id(), &id("message-failure"));
                assert_eq!(
                    error.correlation_sequence(),
                    failure_response[0].correlation_sequence()
                );
                assert_eq!(error.meeting_id(), Some(&id("meeting-fixture")));
                assert_eq!(error.segment_id(), Some(&failed_segment.segment_id));
                assert!(error.sanitized_detail().is_none());
            }
            event => panic!("expected stable failure, got {event:?}"),
        }
        let not_cancellable_failure = lane
            .exchange(request(
                "message-cancel-failure",
                Some(&failed_segment),
                Some("cancel-after-failure"),
                WorkerCommand::Cancel {
                    reason: CancelReason::Superseded,
                },
            ))
            .expect("failure is an explicit not-cancellable terminal");
        assert!(matches!(
            only_event(&not_cancellable_failure),
            WorkerEvent::NotCancellable {
                reason: NotCancellableReason::AlreadyFailed,
                ..
            }
        ));
        assert_eq!(
            lane.exchange(request(
                "message-failure-repeat",
                Some(&failed_segment),
                None,
                WorkerCommand::FlushSegment,
            )),
            Err(ContractError::TerminalAlreadyEmitted)
        );
    }
}

#[test]
fn cancel_reaches_terminal_is_idempotent_and_does_not_poison_another_segment() {
    for mut lane in handshaken_lanes() {
        lane.exchange(prepare("message-prepare"))
            .expect("prepare succeeds");
        let cancelled = job("cancelled");
        lane.exchange(request(
            "message-cancel-audio",
            Some(&cancelled),
            None,
            WorkerCommand::AcceptAudio(chunk(1, 0)),
        ))
        .expect("audio succeeds");

        let first = lane
            .exchange(request(
                "message-cancel-first",
                Some(&cancelled),
                Some("cancel-scope-a"),
                WorkerCommand::Cancel {
                    reason: CancelReason::UserRequested,
                },
            ))
            .expect("cancel succeeds");
        assert!(matches!(
            first[0].event(),
            WorkerEvent::CancelRequested {
                repeated: false,
                ..
            }
        ));
        assert!(matches!(
            first[1].event(),
            WorkerEvent::Cancelled {
                repeated: false,
                ..
            }
        ));

        let repeated = lane
            .exchange(request(
                "message-cancel-repeat",
                Some(&cancelled),
                Some("cancel-scope-a"),
                WorkerCommand::Cancel {
                    reason: CancelReason::UserRequested,
                },
            ))
            .expect("repeat succeeds");
        assert!(matches!(
            repeated[1].event(),
            WorkerEvent::Cancelled { repeated: true, .. }
        ));
        assert_eq!(
            lane.exchange(request(
                "message-cancel-reason-conflict",
                Some(&cancelled),
                Some("cancel-scope-a"),
                WorkerCommand::Cancel {
                    reason: CancelReason::MeetingEnded,
                },
            )),
            Err(ContractError::CancelScopeConflict)
        );
        let already_cancelled = lane
            .exchange(request(
                "message-cancel-conflict",
                Some(&cancelled),
                Some("cancel-scope-b"),
                WorkerCommand::Cancel {
                    reason: CancelReason::UserRequested,
                },
            ))
            .expect("a new cancel scope observes the cancelled terminal");
        assert!(matches!(
            only_event(&already_cancelled),
            WorkerEvent::NotCancellable {
                reason: NotCancellableReason::AlreadyCancelled,
                ..
            }
        ));
        assert_eq!(
            lane.exchange(request(
                "message-flush-cancelled",
                Some(&cancelled),
                None,
                WorkerCommand::FlushSegment,
            )),
            Err(ContractError::Cancelled)
        );

        let healthy = job("healthy");
        lane.exchange(request(
            "message-healthy-audio",
            Some(&healthy),
            None,
            WorkerCommand::AcceptAudio(chunk(1, 0)),
        ))
        .expect("other segment audio succeeds");
        lane.exchange(request(
            "message-healthy-final",
            Some(&healthy),
            None,
            WorkerCommand::FlushSegment,
        ))
        .expect("other segment final succeeds");
        let not_cancellable = lane
            .exchange(request(
                "message-cancel-final",
                Some(&healthy),
                Some("cancel-after-final"),
                WorkerCommand::Cancel {
                    reason: CancelReason::MeetingEnded,
                },
            ))
            .expect("not-cancellable is an explicit event");
        assert_eq!(
            only_event(&not_cancellable),
            &WorkerEvent::NotCancellable {
                job: healthy,
                cancel_scope_id: id("cancel-after-final"),
                requested_reason: CancelReason::MeetingEnded,
                reason: NotCancellableReason::AlreadyFinal,
                existing_cancellation: None,
            }
        );
    }
}

#[test]
fn meeting_cancel_is_sorted_atomic_scoped_and_preserves_original_provenance() {
    for mut lane in handshaken_lanes() {
        lane.exchange(prepare("message-meeting-cancel-prepare"))
            .expect("prepare succeeds");
        let meeting_id = id("meeting-cancel-target");
        let first = job_in_meeting(meeting_id.as_str(), "meeting-cancel-a");
        let second = job_in_meeting(meeting_id.as_str(), "meeting-cancel-b");
        let other = job_in_meeting("meeting-not-cancelled", "meeting-cancel-other");
        for (suffix, target) in [("a", &first), ("b", &second), ("other", &other)] {
            lane.exchange(request(
                &format!("message-meeting-cancel-audio-{suffix}"),
                Some(target),
                None,
                WorkerCommand::AcceptAudio(chunk(1, 0)),
            ))
            .expect("active job admitted");
        }

        let cancellation_request = lane.stamp(meeting_cancel_request(
            "message-meeting-cancel",
            &meeting_id,
            "cancel-meeting-scope",
            CancelReason::MeetingEnded,
        ));
        let cancellation = lane
            .exchange(cancellation_request.clone())
            .expect("meeting cancellation succeeds atomically");
        assert_eq!(cancellation.len(), 4);
        for (pair, expected_job) in cancellation.chunks_exact(2).zip([&first, &second]) {
            assert!(matches!(
                pair[0].event(),
                WorkerEvent::CancelRequested {
                    job,
                    repeated: false,
                    ..
                } if job == expected_job
            ));
            assert!(matches!(
                pair[1].event(),
                WorkerEvent::Cancelled {
                    job,
                    repeated: false,
                    ..
                } if job == expected_job
            ));
            assert_eq!(pair[0].meeting_id(), Some(&meeting_id));
            assert!(pair[0].job_id().is_none());
            assert!(pair[0].segment_id().is_none());
        }

        let mut delivery_retry = cancellation_request;
        delivery_retry.context.deadline.deadline_ns += 1;
        let delivery_retry = lane
            .exchange(delivery_retry)
            .expect("same delivery identity replays the original outcome");
        assert_eq!(delivery_retry, cancellation);

        let repeated = lane
            .exchange(meeting_cancel_request(
                "message-meeting-cancel-repeat",
                &meeting_id,
                "cancel-meeting-scope",
                CancelReason::MeetingEnded,
            ))
            .expect("same scope and cancellation replays exact facts");
        assert_eq!(repeated.len(), 4);
        for (pair, expected_job) in repeated.chunks_exact(2).zip([&first, &second]) {
            assert_eq!(
                pair[0].event(),
                &WorkerEvent::CancelRequested {
                    job: expected_job.clone(),
                    cancel_scope_id: id("cancel-meeting-scope"),
                    reason: CancelReason::MeetingEnded,
                    repeated: true,
                }
            );
            assert_eq!(
                pair[1].event(),
                &WorkerEvent::Cancelled {
                    job: expected_job.clone(),
                    cancel_scope_id: id("cancel-meeting-scope"),
                    reason: CancelReason::MeetingEnded,
                    repeated: true,
                }
            );
            for response in pair {
                assert_eq!(response.meeting_id(), Some(&meeting_id));
                assert!(response.job_id().is_none());
                assert!(response.segment_id().is_none());
                assert_eq!(
                    response.correlation_id().as_str(),
                    "message-meeting-cancel-repeat"
                );
            }
        }

        assert_eq!(
            lane.exchange(meeting_cancel_request(
                "message-meeting-cancel-reason-conflict",
                &meeting_id,
                "cancel-meeting-scope",
                CancelReason::Superseded,
            )),
            Err(ContractError::CancelScopeConflict)
        );
        assert_eq!(
            lane.exchange(meeting_cancel_request(
                "message-meeting-cancel-target-conflict",
                &other.meeting_id,
                "cancel-meeting-scope",
                CancelReason::MeetingEnded,
            )),
            Err(ContractError::CancelScopeConflict)
        );

        lane.exchange(request(
            "message-other-meeting-audio-2",
            Some(&other),
            None,
            WorkerCommand::AcceptAudio(chunk(2, 320)),
        ))
        .expect("scope conflicts did not partially cancel another meeting");
        lane.exchange(request(
            "message-other-meeting-final",
            Some(&other),
            None,
            WorkerCommand::FlushSegment,
        ))
        .expect("other meeting remains healthy");

        let observed = lane
            .exchange(request(
                "message-observe-existing-cancel",
                Some(&first),
                Some("new-cancel-scope"),
                WorkerCommand::Cancel {
                    reason: CancelReason::UserRequested,
                },
            ))
            .expect("already-cancelled provenance is explicit");
        assert!(matches!(
            only_event(&observed),
            WorkerEvent::NotCancellable {
                reason: NotCancellableReason::AlreadyCancelled,
                existing_cancellation: Some(Cancellation {
                    scope_id,
                    target: CancelTarget::Meeting(target_meeting),
                    reason: CancelReason::MeetingEnded,
                }),
                ..
            } if scope_id.as_str() == "cancel-meeting-scope" && target_meeting == &meeting_id
        ));

        let replay = lane
            .exchange(request(
                "message-meeting-cancel-restart",
                None,
                None,
                WorkerCommand::Restart,
            ))
            .expect("restart exposes terminal provenance");
        let expected_cancellation = Cancellation {
            scope_id: id("cancel-meeting-scope"),
            target: CancelTarget::Meeting(meeting_id.clone()),
            reason: CancelReason::MeetingEnded,
        };
        for cancelled_job in [&first, &second] {
            assert_replay_state(
                &replay,
                cancelled_job,
                &ReplayJobState::Cancelled {
                    cancellation: expected_cancellation.clone(),
                },
            );
        }
    }
}

#[test]
fn meeting_cancel_without_active_jobs_is_stable_explicit_and_does_not_leak_scope_capacity() {
    let mut scoped_limits = limits();
    scoped_limits.max_cancellation_scopes = 1;
    for mut lane in handshaken_lanes_with_limits(scoped_limits) {
        lane.exchange(prepare("message-no-active-prepare"))
            .expect("prepare succeeds");

        let empty_meeting = id("meeting-empty-cancel");
        let empty_request = lane.stamp(meeting_cancel_request(
            "message-empty-meeting-cancel",
            &empty_meeting,
            "scope-empty-meeting",
            CancelReason::MeetingEnded,
        ));
        assert_eq!(
            lane.exchange(empty_request.clone()),
            Err(ContractError::NoActiveJobs)
        );
        let mut empty_delivery_retry = empty_request;
        empty_delivery_retry.context.deadline.deadline_ns += 1;
        assert_eq!(
            lane.exchange(empty_delivery_retry),
            Err(ContractError::NoActiveJobs),
            "same delivery replays the stable failure"
        );
        assert_eq!(
            lane.exchange(meeting_cancel_request(
                "message-empty-meeting-business-retry",
                &empty_meeting,
                "scope-empty-meeting",
                CancelReason::MeetingEnded,
            )),
            Err(ContractError::NoActiveJobs),
            "business retry never becomes a silent empty success"
        );

        let terminal = job_in_meeting("meeting-all-terminal", "all-terminal");
        lane.exchange(request(
            "message-all-terminal-audio",
            Some(&terminal),
            None,
            WorkerCommand::AcceptAudio(chunk(1, 0)),
        ))
        .expect("terminal target audio accepted");
        lane.exchange(request(
            "message-all-terminal-final",
            Some(&terminal),
            None,
            WorkerCommand::FlushSegment,
        ))
        .expect("terminal target finalized");
        assert_eq!(
            lane.exchange(meeting_cancel_request(
                "message-all-terminal-cancel",
                &terminal.meeting_id,
                "scope-all-terminal",
                CancelReason::MeetingEnded,
            )),
            Err(ContractError::NoActiveJobs)
        );

        let active = job_in_meeting("meeting-live-after-empty", "live-after-empty");
        lane.exchange(request(
            "message-live-after-empty-audio",
            Some(&active),
            None,
            WorkerCommand::AcceptAudio(chunk(1, 0)),
        ))
        .expect("active target admitted");
        let cancelled = lane
            .exchange(request(
                "message-live-after-empty-cancel",
                Some(&active),
                Some("scope-live-after-empty"),
                WorkerCommand::Cancel {
                    reason: CancelReason::UserRequested,
                },
            ))
            .expect("failed meeting cancellations did not consume scope capacity");
        assert_eq!(cancelled.len(), 2);
    }
}

#[test]
fn oversized_meeting_cancel_snapshot_fails_atomically_without_reserving_scope() {
    let mut batch_limits = limits();
    batch_limits.max_in_flight_jobs = 3;
    batch_limits.max_cancel_jobs_per_batch = 2;
    for mut lane in handshaken_lanes_with_limits(batch_limits) {
        lane.exchange(prepare("message-cancel-batch-prepare"))
            .expect("prepare succeeds");
        let meeting_id = id("meeting-cancel-batch-overflow");
        let jobs = [
            job_in_meeting(meeting_id.as_str(), "batch-a"),
            job_in_meeting(meeting_id.as_str(), "batch-b"),
            job_in_meeting(meeting_id.as_str(), "batch-c"),
        ];
        for (index, target) in jobs.iter().enumerate() {
            lane.exchange(request(
                &format!("message-cancel-batch-audio-{index}"),
                Some(target),
                None,
                WorkerCommand::AcceptAudio(chunk(1, 0)),
            ))
            .expect("active batch member admitted");
        }

        let oversized = lane.stamp(meeting_cancel_request(
            "message-cancel-batch-overflow",
            &meeting_id,
            "scope-cancel-batch-overflow",
            CancelReason::MeetingEnded,
        ));
        assert_eq!(
            lane.exchange(oversized.clone()),
            Err(ContractError::CancellationBatchTooLarge)
        );
        assert_eq!(
            lane.exchange(oversized),
            Err(ContractError::CancellationBatchTooLarge),
            "same delivery retains the original batch failure"
        );
        for (index, target) in jobs.iter().enumerate() {
            lane.exchange(request(
                &format!("message-cancel-batch-audio-2-{index}"),
                Some(target),
                None,
                WorkerCommand::AcceptAudio(chunk(2, 320)),
            ))
            .expect("oversized snapshot did not partially cancel any job");
        }
        let one_job = lane
            .exchange(request(
                "message-cancel-batch-scope-reuse",
                Some(&jobs[0]),
                Some("scope-cancel-batch-overflow"),
                WorkerCommand::Cancel {
                    reason: CancelReason::MeetingEnded,
                },
            ))
            .expect("oversized snapshot did not reserve the cancellation scope");
        assert_eq!(one_job.len(), 2);
    }
}

#[test]
fn meeting_scope_partial_ack_prunes_business_repeat_but_preserves_delivery_replay() {
    for mut lane in handshaken_lanes() {
        lane.exchange(prepare("message-partial-ack-prepare"))
            .expect("prepare succeeds");
        let meeting_id = id("meeting-partial-ack");
        let first = job_in_meeting(meeting_id.as_str(), "partial-a");
        let second = job_in_meeting(meeting_id.as_str(), "partial-b");
        for (suffix, target) in [("a", &first), ("b", &second)] {
            lane.exchange(request(
                &format!("message-partial-ack-audio-{suffix}"),
                Some(target),
                None,
                WorkerCommand::AcceptAudio(chunk(1, 0)),
            ))
            .expect("active cancellation target admitted");
        }

        let cancellation_request = lane.stamp(meeting_cancel_request(
            "message-partial-ack-cancel",
            &meeting_id,
            "scope-partial-ack",
            CancelReason::MeetingEnded,
        ));
        let original = lane
            .exchange(cancellation_request.clone())
            .expect("meeting cancellation succeeds");
        assert_eq!(original.len(), 4);
        lane.exchange(request(
            "message-partial-ack-first-terminal",
            Some(&first),
            None,
            WorkerCommand::AcknowledgeTerminal,
        ))
        .expect("first terminal acknowledged");

        assert_eq!(
            lane.exchange(cancellation_request),
            Ok(original),
            "delivery replay remains the exact frozen original outcome"
        );
        let business_repeat = lane
            .exchange(meeting_cancel_request(
                "message-partial-ack-business-repeat",
                &meeting_id,
                "scope-partial-ack",
                CancelReason::MeetingEnded,
            ))
            .expect("business repeat returns only still-retained jobs");
        assert_eq!(business_repeat.len(), 2);
        assert_eq!(
            business_repeat[0].event(),
            &WorkerEvent::CancelRequested {
                job: second.clone(),
                cancel_scope_id: id("scope-partial-ack"),
                reason: CancelReason::MeetingEnded,
                repeated: true,
            }
        );
        assert_eq!(
            business_repeat[1].event(),
            &WorkerEvent::Cancelled {
                job: second,
                cancel_scope_id: id("scope-partial-ack"),
                reason: CancelReason::MeetingEnded,
                repeated: true,
            }
        );
    }
}

#[test]
fn cancellation_scope_registry_is_bounded_and_terminal_ack_releases_referenced_scope() {
    let mut scoped_limits = limits();
    scoped_limits.max_cancellation_scopes = 2;
    for mut lane in handshaken_lanes_with_limits(scoped_limits) {
        lane.exchange(prepare("message-scope-cap-prepare"))
            .expect("prepare succeeds");
        let jobs = [job("scope-cap-a"), job("scope-cap-b"), job("scope-cap-c")];
        for (index, target) in jobs.iter().enumerate() {
            lane.exchange(request(
                &format!("message-scope-cap-audio-{index}"),
                Some(target),
                None,
                WorkerCommand::AcceptAudio(chunk(1, 0)),
            ))
            .expect("audio accepted");
            lane.exchange(request(
                &format!("message-scope-cap-final-{index}"),
                Some(target),
                None,
                WorkerCommand::FlushSegment,
            ))
            .expect("terminal final created");
        }
        for (scope, target) in [("scope-cap-1", &jobs[0]), ("scope-cap-2", &jobs[1])] {
            lane.exchange(request(
                &format!("message-{scope}"),
                Some(target),
                Some(scope),
                WorkerCommand::Cancel {
                    reason: CancelReason::UserRequested,
                },
            ))
            .expect("not-cancellable outcome still reserves global scope identity");
        }
        assert_eq!(
            lane.exchange(request(
                "message-scope-cap-full",
                Some(&jobs[2]),
                Some("scope-cap-3"),
                WorkerCommand::Cancel {
                    reason: CancelReason::UserRequested,
                },
            )),
            Err(ContractError::CancellationRegistryFull)
        );
        lane.exchange(request(
            "message-scope-cap-ack",
            Some(&jobs[0]),
            None,
            WorkerCommand::AcknowledgeTerminal,
        ))
        .expect("terminal acknowledgement releases its scope record");
        lane.exchange(request(
            "message-scope-cap-restored",
            Some(&jobs[2]),
            Some("scope-cap-3"),
            WorkerCommand::Cancel {
                reason: CancelReason::UserRequested,
            },
        ))
        .expect("released scope capacity admits a new outcome");
    }
}

#[test]
fn heartbeat_progress_health_and_restart_are_independent_and_replay_safe() {
    for mut lane in handshaken_lanes() {
        lane.exchange(prepare("message-prepare"))
            .expect("prepare succeeds");
        let segment = job("progress");
        lane.exchange(request(
            "message-progress-audio",
            Some(&segment),
            None,
            WorkerCommand::AcceptAudio(chunk(1, 0)),
        ))
        .expect("audio succeeds");
        assert_eq!(lane.heartbeat(), Ok(WorkerEvent::Heartbeat { sequence: 1 }));

        let progress_one = lane
            .exchange(request(
                "message-progress-1",
                Some(&segment),
                None,
                WorkerCommand::PollEvents,
            ))
            .expect("progress one");
        let progress_two = lane
            .exchange(request(
                "message-progress-2",
                Some(&segment),
                None,
                WorkerCommand::PollEvents,
            ))
            .expect("progress two");
        assert_eq!(
            only_event(&progress_one),
            &WorkerEvent::Progress {
                progress_sequence: 1,
                last_audio_sequence: 1,
            }
        );
        assert_eq!(
            only_event(&progress_two),
            &WorkerEvent::Progress {
                progress_sequence: 2,
                last_audio_sequence: 1,
            }
        );

        let no_fake_progress = lane
            .exchange(request(
                "message-progress-empty",
                Some(&segment),
                None,
                WorkerCommand::PollEvents,
            ))
            .expect("empty poll succeeds");
        assert!(no_fake_progress.is_empty());
        let health_before_restart = lane
            .exchange(request(
                "message-health-before-restart",
                None,
                None,
                WorkerCommand::Health,
            ))
            .expect("health succeeds");
        assert!(matches!(
            only_event(&health_before_restart),
            WorkerEvent::Health {
                heartbeat_sequence: 1,
                last_progress_sequence: Some(2),
                queue_depth: 0,
                model_ready: true,
                execution_provider: ExecutionProvider::FixtureCpu,
                restart_count: 0,
            }
        ));

        let restart = lane
            .exchange(request(
                "message-restart",
                None,
                None,
                WorkerCommand::Restart,
            ))
            .expect("restart succeeds");
        assert!(
            restart
                .iter()
                .any(|response| matches!(response.event(), WorkerEvent::ReplayRequired { .. }))
        );
        assert!(restart.iter().any(|response| matches!(
            response.event(),
            WorkerEvent::Restarted { restart_count: 1 }
        )));
        assert_eq!(
            lane.exchange(request(
                "message-after-restart-audio",
                Some(&segment),
                None,
                WorkerCommand::AcceptAudio(chunk(1, 0)),
            )),
            Err(ContractError::NotPrepared)
        );
        lane.exchange(prepare("message-reprepare"))
            .expect("prepare after restart");
        let health = lane
            .exchange(request("message-health", None, None, WorkerCommand::Health))
            .expect("health succeeds");
        assert!(matches!(
            only_event(&health),
            WorkerEvent::Health {
                heartbeat_sequence: 1,
                last_progress_sequence: None,
                queue_depth: 0,
                model_ready: true,
                execution_provider: ExecutionProvider::FixtureCpu,
                restart_count: 1,
            }
        ));
    }
}

#[test]
fn restart_replays_every_unacknowledged_outcome_until_terminal_acknowledgement() {
    for mut lane in handshaken_lanes() {
        let (final_job, failed_job, cancelled_job, active_job) =
            populate_replay_matrix(&mut lane, "restart-matrix");
        let first_restart = lane
            .exchange(request(
                "message-restart-matrix-first",
                None,
                None,
                WorkerCommand::Restart,
            ))
            .expect("first restart succeeds");
        assert_eq!(first_restart.len(), 5);
        assert_replay_state(&first_restart, &active_job, &ReplayJobState::Active);
        assert_replay_state(&first_restart, &final_job, &ReplayJobState::Final);
        assert_replay_state(&first_restart, &failed_job, &ReplayJobState::Failure);
        assert_replay_state(
            &first_restart,
            &cancelled_job,
            &ReplayJobState::Cancelled {
                cancellation: Cancellation {
                    scope_id: id("cancel-restart-matrix"),
                    target: CancelTarget::Job(cancelled_job.clone()),
                    reason: CancelReason::MeetingEnded,
                },
            },
        );
        assert!(matches!(
            first_restart.last().map(WorkerResponse::event),
            Some(WorkerEvent::Restarted { restart_count: 1 })
        ));

        let second_restart = lane
            .exchange(request(
                "message-restart-matrix-second",
                None,
                None,
                WorkerCommand::Restart,
            ))
            .expect("second restart succeeds");
        assert_eq!(second_restart.len(), 5);
        assert_replay_state(&second_restart, &active_job, &ReplayJobState::Active);
        assert_replay_state(&second_restart, &final_job, &ReplayJobState::Final);
        assert_replay_state(&second_restart, &failed_job, &ReplayJobState::Failure);
        assert_replay_state(
            &second_restart,
            &cancelled_job,
            &ReplayJobState::Cancelled {
                cancellation: Cancellation {
                    scope_id: id("cancel-restart-matrix"),
                    target: CancelTarget::Job(cancelled_job.clone()),
                    reason: CancelReason::MeetingEnded,
                },
            },
        );

        for (suffix, terminal_job) in [
            ("final", &final_job),
            ("failure", &failed_job),
            ("cancelled", &cancelled_job),
        ] {
            let acknowledged = lane
                .exchange(request(
                    &format!("message-restart-matrix-ack-{suffix}"),
                    Some(terminal_job),
                    None,
                    WorkerCommand::AcknowledgeTerminal,
                ))
                .expect("terminal remains acknowledgement-addressable after restart");
            assert!(matches!(
                only_event(&acknowledged),
                WorkerEvent::TerminalAcknowledged { job } if job == terminal_job
            ));
        }
        assert_eq!(
            lane.exchange(request(
                "message-restart-matrix-active-ack",
                Some(&active_job),
                None,
                WorkerCommand::AcknowledgeTerminal,
            )),
            Err(ContractError::JobNotTerminal)
        );

        let after_ack = lane
            .exchange(request(
                "message-restart-matrix-after-ack",
                None,
                None,
                WorkerCommand::Restart,
            ))
            .expect("restart after acknowledgements succeeds");
        assert_eq!(after_ack.len(), 2);
        assert_replay_state(&after_ack, &active_job, &ReplayJobState::Active);
        assert!(matches!(
            after_ack.last().map(WorkerResponse::event),
            Some(WorkerEvent::Restarted { restart_count: 3 })
        ));
    }
}

#[test]
fn shutdown_replays_active_final_failure_and_cancelled_jobs() {
    for mut lane in handshaken_lanes() {
        let (final_job, failed_job, cancelled_job, active_job) =
            populate_replay_matrix(&mut lane, "shutdown-matrix");
        let shutdown = lane
            .exchange(request(
                "message-shutdown-matrix",
                None,
                None,
                WorkerCommand::Shutdown,
            ))
            .expect("shutdown succeeds");
        assert_eq!(shutdown.len(), 5);
        assert_replay_state(&shutdown, &active_job, &ReplayJobState::Active);
        assert_replay_state(&shutdown, &final_job, &ReplayJobState::Final);
        assert_replay_state(&shutdown, &failed_job, &ReplayJobState::Failure);
        assert_replay_state(
            &shutdown,
            &cancelled_job,
            &ReplayJobState::Cancelled {
                cancellation: Cancellation {
                    scope_id: id("cancel-shutdown-matrix"),
                    target: CancelTarget::Job(cancelled_job.clone()),
                    reason: CancelReason::MeetingEnded,
                },
            },
        );
        assert_eq!(
            shutdown.last().map(WorkerResponse::event),
            Some(&WorkerEvent::ShutdownComplete)
        );
    }
}

#[test]
fn restart_and_shutdown_replay_facts_are_paginated_to_the_negotiated_batch_cap() {
    let mut replay_limits = limits();
    replay_limits.max_replay_events_per_batch = 2;
    for shutdown_mode in [false, true] {
        for mut lane in handshaken_lanes_with_limits(replay_limits) {
            let prefix = if shutdown_mode {
                "paged-shutdown"
            } else {
                "paged-restart"
            };
            let (final_job, failed_job, cancelled_job, active_job) =
                populate_replay_matrix(&mut lane, prefix);
            let extra = job(&format!("{prefix}-extra-failure"));
            lane.exchange(request(
                &format!("message-{prefix}-extra-failure"),
                Some(&extra),
                None,
                WorkerCommand::FlushSegment,
            ))
            .expect("fifth tracked job admitted");

            let lifecycle_command = if shutdown_mode {
                WorkerCommand::Shutdown
            } else {
                WorkerCommand::Restart
            };
            let lifecycle_request = lane.stamp(request(
                &format!("message-{prefix}-lifecycle"),
                None,
                None,
                lifecycle_command.clone(),
            ));
            let first_page = lane
                .exchange(lifecycle_request.clone())
                .expect("lifecycle starts replay pagination");
            assert_eq!(
                first_page
                    .iter()
                    .filter(|response| {
                        matches!(response.event(), WorkerEvent::ReplayRequired { .. })
                    })
                    .count(),
                2
            );
            assert_eq!(replay_remaining(&first_page), vec![3]);

            if shutdown_mode {
                assert!(
                    !first_page
                        .iter()
                        .any(|response| matches!(response.event(), WorkerEvent::ShutdownComplete))
                );
                assert_eq!(
                    lane.exchange(lifecycle_request),
                    Ok(first_page.clone()),
                    "same delivery replay remains available while shutdown drains"
                );
                assert_eq!(
                    lane.exchange(request(
                        &format!("message-{prefix}-blocked-while-draining"),
                        None,
                        None,
                        WorkerCommand::Describe,
                    )),
                    Err(ContractError::ShutdownDraining)
                );
            } else {
                assert_eq!(
                    lane.exchange(request(
                        &format!("message-{prefix}-overlapping-restart"),
                        None,
                        None,
                        WorkerCommand::Restart,
                    )),
                    Err(ContractError::ReplayBatchPending)
                );
            }

            let second_page = lane
                .exchange(request(
                    &format!("message-{prefix}-poll-2"),
                    None,
                    None,
                    WorkerCommand::PollReplay,
                ))
                .expect("second replay page");
            assert_eq!(
                second_page
                    .iter()
                    .filter(|response| {
                        matches!(response.event(), WorkerEvent::ReplayRequired { .. })
                    })
                    .count(),
                2
            );
            assert_eq!(replay_remaining(&second_page), vec![1]);
            if shutdown_mode {
                assert!(
                    !second_page
                        .iter()
                        .any(|response| matches!(response.event(), WorkerEvent::ShutdownComplete))
                );
            }
            let final_page = lane
                .exchange(request(
                    &format!("message-{prefix}-poll-final"),
                    None,
                    None,
                    WorkerCommand::PollReplay,
                ))
                .expect("final replay page");
            assert_eq!(
                final_page
                    .iter()
                    .filter(|response| {
                        matches!(response.event(), WorkerEvent::ReplayRequired { .. })
                    })
                    .count(),
                1
            );
            assert!(replay_remaining(&final_page).is_empty());
            if shutdown_mode {
                assert!(matches!(
                    final_page.last().map(WorkerResponse::event),
                    Some(WorkerEvent::ShutdownComplete)
                ));
            } else {
                assert!(
                    !final_page
                        .iter()
                        .any(|response| matches!(response.event(), WorkerEvent::ShutdownComplete))
                );
            }

            let mut merged_facts = replay_facts(&first_page);
            merged_facts.extend(replay_facts(&second_page));
            merged_facts.extend(replay_facts(&final_page));
            assert_eq!(merged_facts.len(), 5);
            assert!(merged_facts.windows(2).all(|pair| pair[0].0 < pair[1].0));
            let mut expected_facts = vec![
                (final_job, ReplayJobState::Final),
                (failed_job, ReplayJobState::Failure),
                (
                    cancelled_job.clone(),
                    ReplayJobState::Cancelled {
                        cancellation: Cancellation {
                            scope_id: id(&format!("cancel-{prefix}")),
                            target: CancelTarget::Job(cancelled_job),
                            reason: CancelReason::MeetingEnded,
                        },
                    },
                ),
                (active_job, ReplayJobState::Active),
                (extra, ReplayJobState::Failure),
            ];
            expected_facts.sort_by(|left, right| left.0.cmp(&right.0));
            assert_eq!(merged_facts, expected_facts);
            assert!(
                lane.exchange(request(
                    &format!("message-{prefix}-poll-empty"),
                    None,
                    None,
                    WorkerCommand::PollReplay,
                ))
                .expect("empty replay page")
                .is_empty()
            );

            if shutdown_mode {
                assert_eq!(
                    lane.exchange(request(
                        &format!("message-{prefix}-after-shutdown"),
                        None,
                        None,
                        WorkerCommand::Describe,
                    )),
                    Err(ContractError::Shutdown)
                );
            } else {
                assert!(first_page.iter().any(|response| matches!(
                    response.event(),
                    WorkerEvent::Restarted { restart_count: 1 }
                )));
            }
        }
    }
}

#[test]
fn both_transport_shapes_have_bounded_command_credit_and_drain_restores_it() {
    let mut small_limits = limits();
    small_limits.max_pending_commands = 2;
    let mut direct = TestLane::new(
        Box::new(DirectFakeTransport::new(manifest(), small_limits).expect("direct constructor")),
        hello_request(),
        "handshake",
    );
    direct
        .submit(request(
            "message-direct-1",
            None,
            None,
            WorkerCommand::Describe,
        ))
        .expect("first credit");
    direct
        .submit(request(
            "message-direct-2",
            None,
            None,
            WorkerCommand::Describe,
        ))
        .expect("second credit");
    assert_eq!(
        direct.submit(request(
            "message-direct-3",
            None,
            None,
            WorkerCommand::Describe,
        )),
        Err(ContractError::QueueFull)
    );
    assert_eq!(direct.drain().expect("drain").len(), 2);

    let mut queued = TestLane::new(
        Box::new(
            InMemoryQueuedTransport::new(manifest(), small_limits).expect("queued constructor"),
        ),
        hello_request(),
        "handshake",
    );

    queued
        .submit(request(
            "message-queued-1",
            None,
            None,
            WorkerCommand::Describe,
        ))
        .expect("first credit");
    queued
        .submit(request(
            "message-queued-2",
            None,
            None,
            WorkerCommand::Describe,
        ))
        .expect("second credit");
    assert_eq!(
        queued.submit(request(
            "message-queued-3",
            None,
            None,
            WorkerCommand::Describe,
        )),
        Err(ContractError::QueueFull)
    );
    assert_eq!(queued.drain().expect("drain").len(), 2);
    queued
        .submit(request(
            "message-queued-4",
            None,
            None,
            WorkerCommand::Describe,
        ))
        .expect("credit restored");
}

#[test]
fn pending_duplicates_coalesce_before_credit_and_multi_submit_drains_once_in_order() {
    let mut batch_limits = limits();
    batch_limits.max_in_flight_jobs = 1;
    batch_limits.max_cancel_jobs_per_batch = 1;
    batch_limits.max_pending_commands = 2;
    batch_limits.max_pending_deliveries = 4;
    batch_limits.max_replay_events_per_batch = 2;
    batch_limits.max_replay_entries = 4;
    for mut lane in handshaken_lanes_with_limits(batch_limits) {
        let first = lane.stamp(request(
            "message-batch-1",
            None,
            None,
            WorkerCommand::Describe,
        ));
        lane.submit(first.clone()).expect("first command reserved");
        lane.submit(first.clone())
            .expect("same pending delivery coalesces");
        let mut conflict = first.clone();
        conflict.command = WorkerCommand::Health;
        assert_eq!(lane.submit(conflict), Err(ContractError::MessageIdConflict));

        let second = lane.stamp(request(
            "message-batch-2",
            None,
            None,
            WorkerCommand::Health,
        ));
        lane.submit(second).expect("second command reserved");
        assert_eq!(
            lane.submit(request(
                "message-batch-3",
                None,
                None,
                WorkerCommand::Describe,
            )),
            Err(ContractError::QueueFull)
        );
        lane.submit(first)
            .expect("queue-full cannot mask a known pending replay");

        let drained = lane.drain().expect("one drain completes the batch");
        assert_eq!(drained.len(), 2);
        assert_eq!(drained[0].correlation_sequence(), 1);
        assert_eq!(drained[1].correlation_sequence(), 2);
        assert_ne!(drained[0].message_id(), drained[1].message_id());
        assert!(matches!(drained[0].event(), WorkerEvent::Described { .. }));
        assert!(matches!(
            drained[1].event(),
            WorkerEvent::Health {
                queue_depth: 1,
                model_ready: false,
                ..
            }
        ));

        lane.submit(request(
            "message-batch-3",
            None,
            None,
            WorkerCommand::Describe,
        ))
        .expect("queue-full did not consume sequence three");
        assert_eq!(lane.drain().expect("final drain").len(), 1);
    }
}

#[test]
fn trace_changes_do_not_change_delivery_identity_or_thaw_the_original_response_trace() {
    for mut lane in handshaken_lanes() {
        let mut original = lane.stamp(request(
            "message-trace-neutral-delivery",
            None,
            None,
            WorkerCommand::Describe,
        ));
        original.context.trace_id = id("trace-first-admission");
        lane.submit(original.clone())
            .expect("original delivery admitted");

        let mut pending_retry = original.clone();
        pending_retry.context.trace_id = id("trace-pending-retry");
        lane.submit(pending_retry)
            .expect("trace-only pending retry coalesces");
        let first = lane.drain().expect("coalesced delivery drains once");
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].trace_id(), &id("trace-first-admission"));
        assert_eq!(
            first[0].correlation_id(),
            &id("message-trace-neutral-delivery")
        );
        assert_eq!(first[0].correlation_sequence(), 1);

        let mut completed_retry = original;
        completed_retry.context.trace_id = id("trace-completed-retry");
        assert_eq!(
            lane.exchange(completed_retry),
            Ok(first),
            "completed replay preserves the first frozen response envelope"
        );
        lane.exchange(request(
            "message-after-trace-neutral-replay",
            None,
            None,
            WorkerCommand::Describe,
        ))
        .expect("trace-only retries did not consume another sequence");
    }
}

#[test]
fn completed_replay_deliveries_are_bounded_without_masking_pending_identity() {
    let mut delivery_limits = limits();
    delivery_limits.max_in_flight_jobs = 1;
    delivery_limits.max_cancel_jobs_per_batch = 1;
    delivery_limits.max_pending_commands = 4;
    delivery_limits.max_pending_deliveries = 3;
    delivery_limits.max_replay_events_per_batch = 1;
    delivery_limits.max_replay_entries = 4;
    for mut lane in handshaken_lanes_with_limits(delivery_limits) {
        let mut retained = Vec::new();
        for sequence in 1..=4 {
            let request = lane.stamp(request(
                &format!("message-retained-{sequence}"),
                None,
                None,
                WorkerCommand::Describe,
            ));
            lane.exchange(request.clone())
                .expect("completed response retained");
            retained.push(request);
        }

        for request in retained.iter().take(3) {
            lane.submit(request.clone())
                .expect("completed replay reserves one delivery unit");
        }
        assert_eq!(
            lane.submit(retained[3].clone()),
            Err(ContractError::ResponseQueueFull)
        );
        lane.submit(retained[0].clone())
            .expect("same pending replay coalesces even when response queue is full");
        let mut conflict = retained[0].clone();
        conflict.command = WorkerCommand::Health;
        assert_eq!(lane.submit(conflict), Err(ContractError::MessageIdConflict));
        assert_eq!(lane.drain().expect("bounded replays drain").len(), 3);
        lane.submit(retained[3].clone())
            .expect("delivery credit is restored after drain");
        assert_eq!(lane.drain().expect("last replay drains").len(), 1);
        lane.exchange(request(
            "message-retained-next",
            None,
            None,
            WorkerCommand::Describe,
        ))
        .expect("ResponseQueueFull did not consume the next new sequence");
    }
}

#[test]
fn response_queue_full_rolls_back_next_new_sequence_worker_state_and_delivery_atomically() {
    let mut delivery_limits = limits();
    delivery_limits.max_in_flight_jobs = 1;
    delivery_limits.max_cancel_jobs_per_batch = 1;
    delivery_limits.max_pending_deliveries = 3;
    delivery_limits.max_replay_events_per_batch = 1;
    for mut lane in handshaken_lanes_with_limits(delivery_limits) {
        let raw_retained_requests = [
            request(
                "message-capacity-retained-describe",
                None,
                None,
                WorkerCommand::Describe,
            ),
            prepare("message-capacity-retained-prepare"),
            request(
                "message-capacity-retained-health",
                None,
                None,
                WorkerCommand::Health,
            ),
        ];
        let mut retained_requests = Vec::new();
        let mut retained_responses = Vec::new();
        for raw in raw_retained_requests {
            let retained = lane.stamp(raw);
            retained_responses.extend(
                lane.exchange(retained.clone())
                    .expect("retained single-response command succeeds"),
            );
            retained_requests.push(retained);
        }
        assert_eq!(retained_responses.len(), 3);

        for retained in &retained_requests {
            lane.submit(retained.clone())
                .expect("retained replay fills one delivery unit");
        }
        let target = job("response-capacity-rollback");
        assert_eq!(
            lane.submit(request(
                "message-response-capacity-rejected-audio",
                Some(&target),
                None,
                WorkerCommand::AcceptAudio(chunk(1, 0)),
            )),
            Err(ContractError::ResponseQueueFull)
        );

        assert_eq!(
            lane.drain()
                .expect("only the retained replay deliveries drain"),
            retained_responses
        );
        let replacement = lane
            .exchange(request(
                "message-response-capacity-sequence-replacement",
                None,
                None,
                WorkerCommand::Describe,
            ))
            .expect("rejected next-new command did not reserve its delivery sequence");
        assert_eq!(replacement[0].correlation_sequence(), 4);

        let accepted_audio = lane
            .exchange(request(
                "message-response-capacity-audio-after-rollback",
                Some(&target),
                None,
                WorkerCommand::AcceptAudio(chunk(1, 0)),
            ))
            .expect("projected audio mutation was not committed on response-capacity failure");
        assert_eq!(accepted_audio[0].correlation_sequence(), 5);
        assert_eq!(
            accepted_audio[0].event(),
            &WorkerEvent::AudioAccepted { sequence: 1 }
        );
    }
}

#[test]
fn queued_submit_projects_pending_state_and_failed_reservation_never_partially_commits() {
    let mut queued = TestLane::new(
        Box::new(InMemoryQueuedTransport::new(manifest(), limits()).expect("queued constructor")),
        hello_request(),
        "handshake",
    );
    queued
        .exchange(prepare("message-prepare"))
        .expect("prepare succeeds");
    let segment = job("queued-atomic");
    let first_audio = queued.stamp(request(
        "message-queued-audio-1",
        Some(&segment),
        None,
        WorkerCommand::AcceptAudio(chunk(1, 0)),
    ));
    queued
        .submit(first_audio.clone())
        .expect("first request reserved");
    let mut pending_conflict = first_audio;
    pending_conflict.command = WorkerCommand::FlushSegment;
    assert_eq!(
        queued.submit(pending_conflict),
        Err(ContractError::MessageIdConflict)
    );
    assert_eq!(
        queued.submit(request(
            "message-queued-audio-duplicate",
            Some(&segment),
            None,
            WorkerCommand::AcceptAudio(chunk(1, 320)),
        )),
        Err(ContractError::NonIncreasingAudioSequence)
    );
    let drained = queued.drain().expect("valid accepted batch drains");
    assert_eq!(drained.len(), 1);
    assert!(matches!(
        drained[0].event(),
        WorkerEvent::AudioAccepted { sequence: 1 }
    ));
    queued
        .exchange(request(
            "message-queued-final",
            Some(&segment),
            None,
            WorkerCommand::FlushSegment,
        ))
        .expect("state committed exactly once");
}

#[test]
fn message_id_replay_is_bounded_and_preserves_success_and_error_outcomes() {
    let mut replay_limits = limits();
    replay_limits.max_replay_entries = 4;
    replay_limits.max_pending_commands = 2;
    replay_limits.max_pending_deliveries = 4;
    replay_limits.max_replay_events_per_batch = 2;
    replay_limits.max_in_flight_jobs = 1;
    replay_limits.max_cancel_jobs_per_batch = 1;
    let mut replay_hello = hello_request();
    replay_hello.offered_limits = replay_limits;

    let mut lanes = vec![
        TestLane::new(
            Box::new(
                DirectFakeTransport::new(manifest(), replay_limits).expect("direct constructor"),
            ),
            replay_hello.clone(),
            "handshake",
        ),
        TestLane::new(
            Box::new(
                InMemoryQueuedTransport::new(manifest(), replay_limits)
                    .expect("queued constructor"),
            ),
            replay_hello,
            "handshake",
        ),
    ];
    for lane in &mut lanes {
        let first_request = lane.stamp(request(
            "message-replay-1",
            None,
            None,
            WorkerCommand::Describe,
        ));
        let first = lane
            .exchange(first_request.clone())
            .expect("first response succeeds");
        let mut same_semantics = first_request.clone();
        same_semantics.context.deadline.deadline_ns += 1;
        assert_eq!(
            lane.exchange(same_semantics),
            Ok(first),
            "deadline renewal does not change semantic request identity"
        );
        let second_request = lane.stamp(request(
            "message-replay-2",
            None,
            None,
            WorkerCommand::Describe,
        ));
        lane.exchange(second_request.clone())
            .expect("second replay slot");
        let third_request = lane.stamp(request(
            "message-replay-3",
            None,
            None,
            WorkerCommand::Describe,
        ));
        lane.exchange(third_request.clone())
            .expect("third request evicts the oldest replay entry");
        for sequence in [4, 5] {
            lane.exchange(request(
                &format!("message-replay-{sequence}"),
                None,
                None,
                WorkerCommand::Describe,
            ))
            .expect("advance bounded replay window");
        }

        let mut reused_after_eviction = first_request;
        reused_after_eviction.command = WorkerCommand::Health;
        assert_eq!(
            lane.exchange(reused_after_eviction),
            Err(ContractError::ReplayWindowExpired)
        );
        lane.exchange(second_request)
            .expect("inclusive replay floor retains the oldest in-window sequence");
        let mut conflict = third_request;
        conflict.command = WorkerCommand::Health;
        assert_eq!(
            lane.exchange(conflict),
            Err(ContractError::MessageIdConflict)
        );

        lane.exchange(prepare("message-replay-prepare"))
            .expect("prepare succeeds");
        let active = job("replay-error");
        lane.exchange(request(
            "message-replay-audio",
            Some(&active),
            None,
            WorkerCommand::AcceptAudio(chunk(1, 0)),
        ))
        .expect("active job admitted");
        let active_ack = lane.stamp(request(
            "message-replay-active-ack",
            Some(&active),
            None,
            WorkerCommand::AcknowledgeTerminal,
        ));
        assert_eq!(
            lane.exchange(active_ack.clone()),
            Err(ContractError::JobNotTerminal)
        );
        lane.exchange(request(
            "message-replay-final",
            Some(&active),
            None,
            WorkerCommand::FlushSegment,
        ))
        .expect("job becomes terminal");
        let mut active_ack_retry = active_ack;
        active_ack_retry.context.deadline.deadline_ns += 1;
        assert_eq!(
            lane.exchange(active_ack_retry.clone()),
            Err(ContractError::JobNotTerminal),
            "same message retains its original rejected outcome after state changes"
        );
        for suffix in 10..=13 {
            lane.exchange(request(
                &format!("message-replay-advance-{suffix}"),
                None,
                None,
                WorkerCommand::Describe,
            ))
            .expect("advance replay floor");
        }
        assert_eq!(
            lane.exchange(active_ack_retry),
            Err(ContractError::ReplayWindowExpired),
            "evicted error outcomes are never re-evaluated against newer state"
        );
        let terminal_ack = lane.stamp(request(
            "message-replay-terminal-ack",
            Some(&active),
            None,
            WorkerCommand::AcknowledgeTerminal,
        ));
        lane.exchange(terminal_ack.clone())
            .expect("current terminal acknowledgement succeeds");
        let replacement = job("replay-error-replacement");
        lane.exchange(request(
            "message-replay-recreate-terminal",
            Some(&replacement),
            None,
            WorkerCommand::FlushSegment,
        ))
        .expect("a new job identity creates a distinct terminal generation");
        for suffix in 16..=19 {
            lane.exchange(request(
                &format!("message-replay-side-effect-advance-{suffix}"),
                None,
                None,
                WorkerCommand::Describe,
            ))
            .expect("expire old terminal acknowledgement");
        }
        assert_eq!(
            lane.exchange(terminal_ack),
            Err(ContractError::ReplayWindowExpired),
            "expired side-effecting acknowledgements cannot affect another job identity"
        );
        lane.exchange(request(
            "message-replay-current-terminal-ack",
            Some(&replacement),
            None,
            WorkerCommand::AcknowledgeTerminal,
        ))
        .expect("new terminal was not removed by expired replay");
    }
}

#[test]
fn terminal_acknowledgement_releases_bounded_tombstones() {
    let mut bounded = limits();
    bounded.max_in_flight_jobs = 2;
    bounded.max_tracked_jobs = 2;
    let mut lane = TestLane::new(
        Box::new(DirectFakeTransport::new(manifest(), bounded).expect("constructor")),
        hello_request(),
        "handshake",
    );
    lane.exchange(prepare("message-prepare"))
        .expect("prepare succeeds");

    let first = job("tracked-a");
    let second = job("tracked-b");
    let third = job("tracked-c");
    for (message, key) in [("message-fail-a", &first), ("message-fail-b", &second)] {
        lane.exchange(request(
            message,
            Some(key),
            None,
            WorkerCommand::FlushSegment,
        ))
        .expect("terminal failure is tracked");
    }
    assert_eq!(
        lane.exchange(request(
            "message-capacity-before-ack",
            Some(&third),
            None,
            WorkerCommand::FlushSegment,
        )),
        Err(ContractError::JobCapacityFull)
    );
    let acknowledged = lane
        .exchange(request(
            "message-terminal-ack",
            Some(&first),
            None,
            WorkerCommand::AcknowledgeTerminal,
        ))
        .expect("terminal acknowledgement succeeds");
    assert!(matches!(
        only_event(&acknowledged),
        WorkerEvent::TerminalAcknowledged { job } if job == &first
    ));
    lane.exchange(request(
        "message-capacity-after-ack",
        Some(&third),
        None,
        WorkerCommand::FlushSegment,
    ))
    .expect("released tombstone restores tracked capacity");

    let active = job("tracked-active");
    lane.exchange(request(
        "message-terminal-ack-release-second",
        Some(&second),
        None,
        WorkerCommand::AcknowledgeTerminal,
    ))
    .expect("second tombstone released");
    lane.exchange(request(
        "message-active-audio",
        Some(&active),
        None,
        WorkerCommand::AcceptAudio(chunk(1, 0)),
    ))
    .expect("active job admitted");
    assert_eq!(
        lane.exchange(request(
            "message-active-ack-rejected",
            Some(&active),
            None,
            WorkerCommand::AcknowledgeTerminal,
        )),
        Err(ContractError::JobNotTerminal)
    );
}

#[test]
fn retired_job_identity_survives_restart_and_rejects_exact_key_reuse() {
    for mut lane in handshaken_lanes() {
        lane.exchange(prepare("message-retired-key-prepare"))
            .expect("prepare succeeds");
        let retired = job("retired-key");
        lane.exchange(request(
            "message-retired-key-audio",
            Some(&retired),
            None,
            WorkerCommand::AcceptAudio(chunk(1, 0)),
        ))
        .expect("retired candidate audio accepted");
        lane.exchange(request(
            "message-retired-key-final",
            Some(&retired),
            None,
            WorkerCommand::FlushSegment,
        ))
        .expect("retired candidate finalized");
        lane.exchange(request(
            "message-retired-key-ack",
            Some(&retired),
            None,
            WorkerCommand::AcknowledgeTerminal,
        ))
        .expect("terminal acknowledgement retires the complete key");

        assert_eq!(
            lane.exchange(request(
                "message-retired-key-reuse-before-restart",
                Some(&retired),
                None,
                WorkerCommand::AcceptAudio(chunk(1, 0)),
            )),
            Err(ContractError::JobIdentityRetired)
        );
        lane.exchange(request(
            "message-retired-key-restart",
            None,
            None,
            WorkerCommand::Restart,
        ))
        .expect("restart succeeds");
        lane.exchange(prepare("message-retired-key-prepare-after-restart"))
            .expect("prepare after restart succeeds");
        assert_eq!(
            lane.exchange(request(
                "message-retired-key-reuse-after-restart",
                Some(&retired),
                None,
                WorkerCommand::FlushSegment,
            )),
            Err(ContractError::JobIdentityRetired),
            "restart never clears retired job identities"
        );

        let distinct = job("retired-key-distinct-job-id");
        lane.exchange(request(
            "message-retired-key-distinct-job",
            Some(&distinct),
            None,
            WorkerCommand::AcceptAudio(chunk(1, 0)),
        ))
        .expect("a distinct complete JobKey remains admissible");
    }
}

#[test]
fn retired_registry_capacity_failure_keeps_terminal_and_delivery_sequence_uncommitted() {
    let mut retired_limits = limits();
    retired_limits.max_in_flight_jobs = 1;
    retired_limits.max_tracked_jobs = 1;
    retired_limits.max_retired_job_keys = 1;
    for mut lane in handshaken_lanes_with_limits(retired_limits) {
        lane.exchange(prepare("message-retired-capacity-prepare"))
            .expect("prepare succeeds");
        let first = job("retired-capacity-first");
        lane.exchange(request(
            "message-retired-capacity-first-failure",
            Some(&first),
            None,
            WorkerCommand::FlushSegment,
        ))
        .expect("first terminal tracked");
        lane.exchange(request(
            "message-retired-capacity-first-ack",
            Some(&first),
            None,
            WorkerCommand::AcknowledgeTerminal,
        ))
        .expect("first key fills retired capacity");

        let second = job("retired-capacity-second");
        lane.exchange(request(
            "message-retired-capacity-second-failure",
            Some(&second),
            None,
            WorkerCommand::FlushSegment,
        ))
        .expect("second terminal tracked after the first tombstone was removed");
        let blocked_sequence = lane.next_sequence;
        let blocked_ack = lane.stamp(request(
            "message-retired-capacity-second-ack",
            Some(&second),
            None,
            WorkerCommand::AcknowledgeTerminal,
        ));
        assert_eq!(
            lane.exchange(blocked_ack.clone()),
            Err(ContractError::RetiredJobKeyCapacityFull)
        );
        assert_eq!(
            lane.exchange(blocked_ack),
            Err(ContractError::RetiredJobKeyCapacityFull)
        );
        assert_eq!(lane.next_sequence, blocked_sequence);

        let replacement = lane
            .exchange(request(
                "message-retired-capacity-sequence-replacement",
                None,
                None,
                WorkerCommand::Health,
            ))
            .expect("capacity failure did not write the delivery ledger");
        assert_eq!(replacement[0].correlation_sequence(), blocked_sequence);
        assert_eq!(
            lane.exchange(request(
                "message-retired-capacity-terminal-still-present",
                Some(&second),
                None,
                WorkerCommand::FlushSegment,
            )),
            Err(ContractError::TerminalAlreadyEmitted),
            "capacity failure did not remove the terminal job"
        );
    }
}

#[test]
fn deadline_clock_domain_shutdown_and_heartbeat_fail_closed() {
    for mut lane in handshaken_lanes() {
        lane.set_now_ns(500)
            .expect("clock advances without pending work");
        assert_eq!(lane.set_now_ns(499), Err(ContractError::ClockRollback));
        lane.set_now_ns(500)
            .expect("equal monotonic time is allowed");
        let mut wrong_domain = request("message-wrong-domain", None, None, WorkerCommand::Shutdown);
        wrong_domain.context.deadline.clock_domain_id = id("other-clock");
        assert_eq!(
            lane.exchange(wrong_domain),
            Err(ContractError::ClockDomainMismatch)
        );

        let mut expired = request(
            "message-expired-shutdown",
            None,
            None,
            WorkerCommand::Shutdown,
        );
        expired.context.deadline.deadline_ns = 500;
        assert_eq!(lane.exchange(expired), Err(ContractError::DeadlineExpired));

        lane.exchange(prepare("message-shutdown-prepare"))
            .expect("prepare succeeds");
        let active = job("shutdown-active");
        lane.exchange(request(
            "message-shutdown-audio",
            Some(&active),
            None,
            WorkerCommand::AcceptAudio(chunk(1, 0)),
        ))
        .expect("active work accepted");
        let shutdown = lane
            .exchange(request(
                "message-shutdown",
                None,
                None,
                WorkerCommand::Shutdown,
            ))
            .expect("shutdown succeeds");
        assert_eq!(shutdown.len(), 2);
        assert!(matches!(
            shutdown[0].event(),
            WorkerEvent::ReplayRequired { job, .. } if job == &active
        ));
        assert_eq!(shutdown[1].event(), &WorkerEvent::ShutdownComplete);
        assert_eq!(lane.heartbeat(), Err(ContractError::Shutdown));
        assert_eq!(
            lane.exchange(request(
                "message-after-shutdown",
                None,
                None,
                WorkerCommand::Describe,
            )),
            Err(ContractError::Shutdown)
        );
    }
}

#[test]
fn queued_pending_command_blocks_clock_advance_without_losing_delivery_or_cursor() {
    let mut lane = TestLane::new(
        Box::new(InMemoryQueuedTransport::new(manifest(), limits()).expect("queued constructor")),
        hello_request(),
        "queued handshake",
    );
    lane.submit(request(
        "message-clock-pending-1",
        None,
        None,
        WorkerCommand::Describe,
    ))
    .expect("pending command admitted");
    assert_eq!(
        lane.set_now_ns(500),
        Err(ContractError::ClockAdvanceWithPending)
    );
    let drained = lane.drain().expect("pending command remains intact");
    assert_eq!(drained.len(), 1);
    assert_eq!(drained[0].correlation_sequence(), 1);
    lane.set_now_ns(500).expect("clock advances after drain");
    lane.exchange(request(
        "message-clock-pending-2",
        None,
        None,
        WorkerCommand::Describe,
    ))
    .expect("sequence two remains healthy");
}

#[test]
fn projected_lifecycle_non_consuming_errors_leave_the_same_sequence_available() {
    let mut lifecycle_limits = limits();
    lifecycle_limits.max_replay_events_per_batch = 1;
    for shutdown_mode in [false, true] {
        for mut lane in handshaken_lanes_with_limits(lifecycle_limits) {
            let prefix = if shutdown_mode {
                "pending-shutdown-admission"
            } else {
                "pending-restart-admission"
            };
            lane.exchange(prepare(&format!("message-{prefix}-prepare")))
                .expect("prepare succeeds");
            for suffix in ["a", "b"] {
                let target = job(&format!("{prefix}-{suffix}"));
                lane.exchange(request(
                    &format!("message-{prefix}-audio-{suffix}"),
                    Some(&target),
                    None,
                    WorkerCommand::AcceptAudio(chunk(1, 0)),
                ))
                .expect("active replay target admitted");
            }

            lane.submit(request(
                &format!("message-{prefix}-lifecycle"),
                None,
                None,
                if shutdown_mode {
                    WorkerCommand::Shutdown
                } else {
                    WorkerCommand::Restart
                },
            ))
            .expect("paged lifecycle command admitted");
            let reusable_sequence = lane.next_sequence;
            let rejected = lane.submit(request(
                &format!("message-{prefix}-rejected"),
                None,
                None,
                if shutdown_mode {
                    WorkerCommand::Describe
                } else {
                    WorkerCommand::Restart
                },
            ));
            assert_eq!(
                rejected,
                Err(if shutdown_mode {
                    ContractError::ShutdownDraining
                } else {
                    ContractError::ReplayBatchPending
                })
            );
            assert_eq!(lane.next_sequence, reusable_sequence);

            let poll = lane.stamp(request(
                &format!("message-{prefix}-poll"),
                None,
                None,
                WorkerCommand::PollReplay,
            ));
            assert_eq!(poll.context.message_sequence, reusable_sequence);
            lane.submit(poll)
                .expect("non-consuming lifecycle error did not reserve the sequence");
            let drained = lane
                .drain()
                .expect("lifecycle and legal same-sequence replacement drain atomically");
            assert_eq!(replay_facts(&drained).len(), 2);
            assert_eq!(replay_remaining(&drained), vec![1]);
            if shutdown_mode {
                assert!(matches!(
                    drained.last().map(WorkerResponse::event),
                    Some(WorkerEvent::ShutdownComplete)
                ));
            } else {
                assert!(drained.iter().any(|response| matches!(
                    response.event(),
                    WorkerEvent::Restarted { restart_count: 1 }
                )));
                lane.exchange(prepare(&format!("message-{prefix}-prepare-after-drain")))
                    .expect("queued restart state committed exactly once");
            }
        }
    }
}

#[test]
fn pending_health_uses_an_admission_snapshot_while_heartbeat_remains_independent() {
    let mut transcripts = Vec::new();
    for mut lane in handshaken_lanes() {
        lane.submit(request(
            "message-health-before-independent-heartbeat",
            None,
            None,
            WorkerCommand::Health,
        ))
        .expect("health snapshot admitted");
        let heartbeat = lane
            .heartbeat()
            .expect("out-of-band heartbeat remains available while health is pending");
        assert_eq!(heartbeat, WorkerEvent::Heartbeat { sequence: 1 });

        let drained = lane
            .drain()
            .expect("pending health drains from its admission snapshot");
        assert_eq!(drained.len(), 1);
        assert_eq!(drained[0].correlation_sequence(), 1);
        assert!(matches!(
            drained[0].event(),
            WorkerEvent::Health {
                heartbeat_sequence: 0,
                queue_depth: 0,
                ..
            }
        ));
        assert!(
            lane.drain()
                .expect("drain clears the pending queue")
                .is_empty()
        );

        let after = lane
            .exchange(request(
                "message-health-after-independent-heartbeat",
                None,
                None,
                WorkerCommand::Health,
            ))
            .expect("next delivery sequence and worker state remain healthy");
        assert_eq!(after[0].correlation_sequence(), 2);
        assert!(matches!(
            after[0].event(),
            WorkerEvent::Health {
                heartbeat_sequence: 1,
                queue_depth: 0,
                ..
            }
        ));
        transcripts.push((heartbeat, drained, after));
    }
    assert_eq!(transcripts[0], transcripts[1]);
}

#[test]
fn direct_and_queued_transports_pass_the_same_assertive_conformance_suite() {
    let mut conformance_limits = limits();
    conformance_limits.max_in_flight_jobs = 1;
    conformance_limits.max_tracked_jobs = 1;
    let mut conformance_hello = hello_request();
    conformance_hello.offered_limits = conformance_limits;
    let direct = run_deterministic_fixture_conformance(
        DirectFakeTransport::new(manifest(), conformance_limits).expect("direct constructor"),
        conformance_hello.clone(),
    )
    .expect("direct conformance");
    let queued = run_deterministic_fixture_conformance(
        InMemoryQueuedTransport::new(manifest(), conformance_limits).expect("queued constructor"),
        conformance_hello,
    )
    .expect("queued conformance");

    assert_eq!(direct, queued);
    assert_eq!(
        direct
            .responses
            .iter()
            .filter(|response| matches!(response.event(), WorkerEvent::Final { .. }))
            .count(),
        2
    );
    assert!(
        direct
            .responses
            .iter()
            .any(|response| matches!(response.event(), WorkerEvent::Failure { .. }))
    );
    assert!(
        direct
            .responses
            .iter()
            .any(|response| matches!(response.event(), WorkerEvent::ReplayRequired { .. }))
    );
}

#[test]
fn deterministic_fixture_oracle_accepts_the_negotiated_non_fixture_execution_provider() {
    let mut cpu_manifest = manifest();
    cpu_manifest.descriptor.execution_provider = ExecutionProvider::Cpu;
    let mut cpu_hello = hello_request();
    cpu_hello.expected = cpu_manifest.clone();
    let cpu_descriptor = cpu_manifest.descriptor.clone();
    let worker_limits = limits();
    let estimate = ResourceEstimate::available(Some(8_192), Some(4_096))
        .expect("available fixture resource estimate");
    let transcript = run_deterministic_fixture_conformance(
        AvailableEstimateEndpoint::new(
            DirectFakeTransport::new(cpu_manifest, worker_limits).expect("cpu fake constructor"),
            estimate,
            worker_limits,
            cpu_descriptor,
        ),
        cpu_hello,
    )
    .expect("oracle compares the negotiated provider instead of hardcoding FixtureCpu");
    let prepared_estimates: Vec<_> = transcript
        .responses
        .iter()
        .filter_map(|response| match response.event() {
            WorkerEvent::Prepared {
                resource_estimate, ..
            } => Some(*resource_estimate),
            _ => None,
        })
        .collect();
    assert_eq!(prepared_estimates, vec![estimate, estimate]);
}
