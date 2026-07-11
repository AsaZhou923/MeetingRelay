use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};

use crate::engine::RequestValidation;
use crate::{
    Architecture, AudioChunk, AudioFormat, AudioGap, AudioSource, CancelReason, CancelTarget,
    Cancellation, CapabilitySet, ContractError, ContractPurpose, ErrorCategory, ErrorSeverity,
    HelloRequest, HelloResponse, Identifier, JobKey, MinorExtensionPolicy, MonotonicDeadline,
    NetworkPolicy, NotCancellableReason, OperatingSystem, Platform, PrepareRequest, RecoveryAction,
    ReplayJobState, RequestContext, ResourceEstimate, SampleFormat, SourceRange, StableWorkerError,
    StableWorkerErrorSpec, TransportKind, WORKER_PROTOCOL_V1, WorkerCommand, WorkerEvent,
    WorkerLimits, WorkerManifest, WorkerRequest, WorkerResponse, WorkerRole,
};

pub const DEFAULT_FAKE_CLOCK_DOMAIN_ID: &str = "core-fixture-clock";
const DELIVERY_SESSION_EPOCH_PREFIX: &str = "fixture-delivery-session";
static NEXT_DELIVERY_SESSION_EPOCH: AtomicU64 = AtomicU64::new(1);
const DEFAULT_NOW_NS: u64 = 100;
const DEFAULT_DEADLINE_NS: u64 = 10_000;

pub trait WorkerEndpoint {
    fn handshake(&mut self, request: HelloRequest) -> Result<HelloResponse, ContractError>;
    fn submit(&mut self, request: WorkerRequest) -> Result<(), ContractError>;
    fn drain(&mut self) -> Result<Vec<WorkerResponse>, ContractError>;
    fn heartbeat(&mut self) -> Result<WorkerEvent, ContractError>;

    fn exchange(&mut self, request: WorkerRequest) -> Result<Vec<WorkerResponse>, ContractError> {
        self.submit(request)?;
        self.drain()
    }
}

pub trait FakeClockControl {
    fn set_now_ns(&mut self, now_ns: u64) -> Result<(), ContractError>;
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum JobTerminal {
    Final,
    Failure,
    Cancelled { cancellation: Cancellation },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ShutdownState {
    Running,
    Draining,
    Complete,
}

#[derive(Clone, Debug, Default)]
struct JobState {
    last_stream_sequence: Option<u64>,
    last_real_audio_sequence: Option<u64>,
    last_media_end_sample: Option<u64>,
    last_progress_sequence: Option<u64>,
    pending_progress: VecDeque<PendingProgress>,
    terminal: Option<JobTerminal>,
}

impl JobState {
    fn replay_state(&self) -> ReplayJobState {
        match &self.terminal {
            None => ReplayJobState::Active,
            Some(JobTerminal::Final) => ReplayJobState::Final,
            Some(JobTerminal::Failure) => ReplayJobState::Failure,
            Some(JobTerminal::Cancelled { cancellation }) => ReplayJobState::Cancelled {
                cancellation: cancellation.clone(),
            },
        }
    }
}

#[derive(Clone, Copy, Debug)]
struct PendingProgress {
    progress_sequence: u64,
    last_audio_sequence: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct CancellationRecord {
    target: CancelTarget,
    reason: CancelReason,
    jobs: Vec<JobKey>,
    events: Vec<WorkerEvent>,
}

#[derive(Clone, Debug)]
struct ReplayEntry {
    request: WorkerRequest,
    outcome: Result<Vec<WorkerResponse>, ContractError>,
}

#[derive(Clone, Debug)]
struct DeliveryLedger {
    session_epoch: Identifier,
    capacity: usize,
    next_sequence: u64,
    replay_floor: u64,
    entries: HashMap<u64, ReplayEntry>,
    order: VecDeque<u64>,
}

enum Admission {
    New,
    Replay(Result<Vec<WorkerResponse>, ContractError>),
}

impl DeliveryLedger {
    fn new(session_epoch: Identifier, capacity: usize) -> Self {
        Self {
            session_epoch,
            capacity,
            next_sequence: 1,
            replay_floor: 1,
            entries: HashMap::with_capacity(capacity),
            order: VecDeque::with_capacity(capacity),
        }
    }

    fn inspect(
        &self,
        request: &WorkerRequest,
        limits: WorkerLimits,
    ) -> Result<Admission, ContractError> {
        request.validate_static(&self.session_epoch, limits)?;
        let sequence = request.context.message_sequence;
        if sequence < self.replay_floor {
            return Err(ContractError::ReplayWindowExpired);
        }
        if sequence < self.next_sequence {
            if let Some(replay) = self.entries.get(&sequence) {
                if replay.request.semantically_eq(request) {
                    return Ok(Admission::Replay(replay.outcome.clone()));
                }
                return Err(ContractError::MessageIdConflict);
            }
            return Err(ContractError::MessageSequenceOutOfOrder);
        }
        if sequence > self.next_sequence {
            return Err(ContractError::MessageSequenceOutOfOrder);
        }
        Ok(Admission::New)
    }

    fn record(
        &mut self,
        request: WorkerRequest,
        outcome: Result<Vec<WorkerResponse>, ContractError>,
    ) -> Result<(), ContractError> {
        let sequence = request.context.message_sequence;
        if sequence != self.next_sequence {
            return Err(ContractError::QueueInvariant);
        }
        self.next_sequence = self
            .next_sequence
            .checked_add(1)
            .ok_or(ContractError::QueueInvariant)?;
        self.order.push_back(sequence);
        self.entries
            .insert(sequence, ReplayEntry { request, outcome });
        while self.order.len() > self.capacity {
            let expired = self
                .order
                .pop_front()
                .ok_or(ContractError::QueueInvariant)?;
            self.entries.remove(&expired);
            self.replay_floor = expired
                .checked_add(1)
                .ok_or(ContractError::QueueInvariant)?;
        }
        Ok(())
    }
}

#[derive(Clone, Debug)]
struct FakeWorker {
    manifest: WorkerManifest,
    limits: WorkerLimits,
    clock_domain_id: Identifier,
    delivery_session_epoch: Identifier,
    now_ns: u64,
    prepared: bool,
    jobs: HashMap<JobKey, JobState>,
    retired_job_keys: HashSet<JobKey>,
    cancellations: HashMap<Identifier, CancellationRecord>,
    pending_replay: VecDeque<(JobKey, ReplayJobState)>,
    heartbeat_sequence: u64,
    progress_sequence: u64,
    restart_count: u32,
    response_sequence: u64,
    shutdown_state: ShutdownState,
}

impl FakeWorker {
    fn new(
        manifest: WorkerManifest,
        limits: WorkerLimits,
        delivery_session_epoch: Identifier,
    ) -> Result<Self, ContractError> {
        manifest.validate()?;
        limits.validate()?;
        Ok(Self {
            manifest,
            limits,
            clock_domain_id: Identifier::new(DEFAULT_FAKE_CLOCK_DOMAIN_ID)?,
            delivery_session_epoch,
            now_ns: DEFAULT_NOW_NS,
            prepared: false,
            jobs: HashMap::new(),
            retired_job_keys: HashSet::with_capacity(limits.max_retired_job_keys as usize),
            cancellations: HashMap::new(),
            pending_replay: VecDeque::new(),
            heartbeat_sequence: 0,
            progress_sequence: 0,
            restart_count: 0,
            response_sequence: 0,
            shutdown_state: ShutdownState::Running,
        })
    }

    fn preflight(&self, request: &WorkerRequest) -> Result<(), ContractError> {
        if !matches!(request.command, WorkerCommand::PollReplay) {
            match self.shutdown_state {
                ShutdownState::Running => {}
                ShutdownState::Draining => return Err(ContractError::ShutdownDraining),
                ShutdownState::Complete => return Err(ContractError::Shutdown),
            }
        }
        let prior_sequence = request
            .context
            .job_key()
            .ok()
            .and_then(|key| self.jobs.get(&key))
            .and_then(|state| state.last_stream_sequence);
        let prior_media_end_sample = request
            .context
            .job_key()
            .ok()
            .and_then(|key| self.jobs.get(&key))
            .and_then(|state| state.last_media_end_sample);
        request.validate(&RequestValidation {
            now_ns: self.now_ns,
            clock_domain_id: &self.clock_domain_id,
            delivery_session_epoch: &self.delivery_session_epoch,
            limits: self.limits,
            expected_model_manifest_sha256: self.manifest.descriptor.model_manifest_sha256,
            expected_execution_provider: self.manifest.descriptor.execution_provider,
            prior_sequence,
            prior_media_end_sample,
        })?;
        if request
            .context
            .job_key()
            .is_ok_and(|job| self.retired_job_keys.contains(&job))
        {
            return Err(ContractError::JobIdentityRetired);
        }
        Ok(())
    }

    fn process(
        &mut self,
        request: WorkerRequest,
        queue_depth: u32,
    ) -> Result<Vec<WorkerResponse>, ContractError> {
        self.preflight(&request)?;
        let cancellation = if matches!(&request.command, WorkerCommand::Cancel { .. }) {
            Some(request.cancellation()?)
        } else {
            None
        };
        let context = &request.context;
        let events = match &request.command {
            WorkerCommand::Describe => vec![WorkerEvent::Described {
                descriptor: self.manifest.descriptor.clone(),
            }],
            WorkerCommand::Prepare(prepare) => self.prepare(*prepare),
            WorkerCommand::AcceptAudio(chunk) => self.accept_audio(context, chunk)?,
            WorkerCommand::DeclareGap(gap) => self.declare_gap(context, *gap)?,
            WorkerCommand::PollEvents => self.poll_events(context)?,
            WorkerCommand::FlushSegment => self.flush_segment(context)?,
            WorkerCommand::Cancel { .. } => {
                self.cancel(cancellation.ok_or(ContractError::QueueInvariant)?)?
            }
            WorkerCommand::AcknowledgeTerminal => self.acknowledge_terminal(context)?,
            WorkerCommand::PollReplay => self.poll_replay()?,
            WorkerCommand::Restart => self.restart()?,
            WorkerCommand::Health => vec![WorkerEvent::Health {
                heartbeat_sequence: self.heartbeat_sequence,
                last_progress_sequence: self
                    .jobs
                    .values()
                    .filter_map(|state| state.last_progress_sequence)
                    .max(),
                queue_depth,
                model_ready: self.prepared,
                execution_provider: self.manifest.descriptor.execution_provider,
                restart_count: self.restart_count,
            }],
            WorkerCommand::Shutdown => self.shutdown()?,
        };
        self.wrap_events(&request, events)
    }

    fn prepare(&mut self, _prepare: PrepareRequest) -> Vec<WorkerEvent> {
        self.prepared = true;
        vec![WorkerEvent::Prepared {
            ready: true,
            execution_provider: self.manifest.descriptor.execution_provider,
            fallback_nodes: Vec::new(),
            resource_estimate: ResourceEstimate::unavailable_contract_fixture(),
        }]
    }

    fn accept_audio(
        &mut self,
        context: &RequestContext,
        chunk: &AudioChunk,
    ) -> Result<Vec<WorkerEvent>, ContractError> {
        if !self.prepared {
            return Err(ContractError::NotPrepared);
        }
        let key = context.job_key()?;
        self.ensure_job_capacity(&key)?;
        let prior_state = self.jobs.get(&key);
        match prior_state.and_then(|state| state.terminal.as_ref()) {
            Some(JobTerminal::Cancelled { .. }) => return Err(ContractError::Cancelled),
            Some(JobTerminal::Final | JobTerminal::Failure) => {
                return Err(ContractError::TerminalAlreadyEmitted);
            }
            None => {}
        }
        chunk.validate(
            prior_state.and_then(|state| state.last_stream_sequence),
            prior_state.and_then(|state| state.last_media_end_sample),
            self.limits.max_audio_chunk_bytes,
            self.limits.max_capture_epochs_per_chunk,
            self.limits.max_source_ranges_per_chunk,
        )?;
        let first_progress = self
            .progress_sequence
            .checked_add(1)
            .ok_or(ContractError::QueueInvariant)?;
        let second_progress = first_progress
            .checked_add(1)
            .ok_or(ContractError::QueueInvariant)?;
        self.progress_sequence = second_progress;
        let state = self.jobs.entry(key).or_default();
        state.last_stream_sequence = Some(chunk.sequence);
        state.last_real_audio_sequence = Some(chunk.sequence);
        state.last_media_end_sample = Some(chunk.media_end_sample);
        for progress_sequence in [first_progress, second_progress] {
            while state.pending_progress.len() >= self.limits.max_pending_progress_per_job as usize
            {
                state.pending_progress.pop_front();
            }
            state.pending_progress.push_back(PendingProgress {
                progress_sequence,
                last_audio_sequence: chunk.sequence,
            });
        }
        Ok(vec![WorkerEvent::AudioAccepted {
            sequence: chunk.sequence,
        }])
    }

    fn poll_events(&mut self, context: &RequestContext) -> Result<Vec<WorkerEvent>, ContractError> {
        if !self.prepared {
            return Err(ContractError::NotPrepared);
        }
        let key = context.job_key()?;
        let state = self
            .jobs
            .get_mut(&key)
            .ok_or(ContractError::MissingRequestIdentity)?;
        if state.terminal.is_some() {
            return Err(ContractError::TerminalAlreadyEmitted);
        }
        let Some(progress) = state.pending_progress.pop_front() else {
            return Ok(Vec::new());
        };
        state.last_progress_sequence = Some(progress.progress_sequence);
        Ok(vec![WorkerEvent::Progress {
            progress_sequence: progress.progress_sequence,
            last_audio_sequence: progress.last_audio_sequence,
        }])
    }

    fn declare_gap(
        &mut self,
        context: &RequestContext,
        gap: AudioGap,
    ) -> Result<Vec<WorkerEvent>, ContractError> {
        if !self.prepared {
            return Err(ContractError::NotPrepared);
        }
        let key = context.job_key()?;
        self.ensure_job_capacity(&key)?;
        let prior_state = self.jobs.get(&key);
        match prior_state.and_then(|state| state.terminal.as_ref()) {
            Some(JobTerminal::Cancelled { .. }) => return Err(ContractError::Cancelled),
            Some(JobTerminal::Final | JobTerminal::Failure) => {
                return Err(ContractError::TerminalAlreadyEmitted);
            }
            None => {}
        }
        gap.validate(
            prior_state.and_then(|state| state.last_stream_sequence),
            prior_state.and_then(|state| state.last_media_end_sample),
        )?;
        let state = self.jobs.entry(key).or_default();
        state.last_stream_sequence = Some(gap.sequence);
        state.last_media_end_sample = Some(gap.media_end_sample);
        Ok(vec![WorkerEvent::GapAccepted {
            sequence: gap.sequence,
            media_start_sample: gap.media_start_sample,
            media_end_sample: gap.media_end_sample,
            reason: gap.reason,
        }])
    }

    fn flush_segment(
        &mut self,
        context: &RequestContext,
    ) -> Result<Vec<WorkerEvent>, ContractError> {
        if !self.prepared {
            return Err(ContractError::NotPrepared);
        }
        let key = context.job_key()?;
        self.ensure_job_capacity(&key)?;
        let state = self.jobs.entry(key.clone()).or_default();
        match &state.terminal {
            Some(JobTerminal::Cancelled { .. }) => return Err(ContractError::Cancelled),
            Some(JobTerminal::Final | JobTerminal::Failure) => {
                return Err(ContractError::TerminalAlreadyEmitted);
            }
            None => {}
        }

        if let Some(last_audio_sequence) = state.last_real_audio_sequence {
            state.pending_progress.clear();
            state.terminal = Some(JobTerminal::Final);
            return Ok(vec![WorkerEvent::Final {
                segment_id: key.segment_id,
                last_audio_sequence,
            }]);
        }

        let error = StableWorkerError::try_from_spec(StableWorkerErrorSpec {
            code: Identifier::new("MODEL_NO_AUDIO")?,
            category: ErrorCategory::Audio,
            severity: ErrorSeverity::Error,
            retryable: true,
            user_message_key: Identifier::new("model.no_audio")?,
            recovery_actions: vec![RecoveryAction::ReprocessAudio],
            correlation_id: context.message_id.clone(),
            correlation_sequence: context.message_sequence,
            meeting_id: context.meeting_id.clone(),
            segment_id: context.segment_id.clone(),
            subsystem: Identifier::new("model-worker")?,
            sanitized_detail: None,
        })?;
        state.terminal = Some(JobTerminal::Failure);
        Ok(vec![WorkerEvent::Failure {
            segment_id: key.segment_id,
            error,
        }])
    }

    fn cancel(&mut self, cancellation: Cancellation) -> Result<Vec<WorkerEvent>, ContractError> {
        if !self.prepared {
            return Err(ContractError::NotPrepared);
        }
        let Cancellation {
            scope_id: cancel_scope_id,
            target,
            reason,
        } = cancellation;
        if let Some(existing) = self.cancellations.get(&cancel_scope_id) {
            if existing.target != target || existing.reason != reason {
                return Err(ContractError::CancelScopeConflict);
            }
            let mut repeated_events = existing.events.clone();
            for event in &mut repeated_events {
                match event {
                    WorkerEvent::CancelRequested { repeated, .. }
                    | WorkerEvent::Cancelled { repeated, .. } => *repeated = true,
                    _ => {}
                }
            }
            return Ok(repeated_events);
        }
        if self.cancellations.len() >= self.limits.max_cancellation_scopes as usize {
            return Err(ContractError::CancellationRegistryFull);
        }

        let jobs = match &target {
            CancelTarget::Job(job) => {
                self.ensure_job_capacity(job)?;
                vec![job.clone()]
            }
            CancelTarget::Meeting(meeting_id) => {
                let mut jobs: Vec<_> = self
                    .jobs
                    .iter()
                    .filter(|(job, state)| {
                        &job.meeting_id == meeting_id && state.terminal.is_none()
                    })
                    .map(|(job, _)| job.clone())
                    .collect();
                jobs.sort();
                if jobs.len() > self.limits.max_cancel_jobs_per_batch as usize {
                    return Err(ContractError::CancellationBatchTooLarge);
                }
                if jobs.is_empty() {
                    return Err(ContractError::NoActiveJobs);
                }
                jobs
            }
        };

        let mut projected = self.clone();
        let mut events = Vec::with_capacity(jobs.len().saturating_mul(2));
        let cancellation = Cancellation {
            scope_id: cancel_scope_id.clone(),
            target: target.clone(),
            reason,
        };
        for job in &jobs {
            events.extend(projected.cancel_job(job.clone(), &cancellation, false)?);
        }
        projected.cancellations.insert(
            cancel_scope_id,
            CancellationRecord {
                target,
                reason,
                jobs,
                events: events.clone(),
            },
        );
        *self = projected;
        Ok(events)
    }

    fn cancel_job(
        &mut self,
        job: JobKey,
        cancellation: &Cancellation,
        repeated: bool,
    ) -> Result<Vec<WorkerEvent>, ContractError> {
        let cancel_scope_id = cancellation.scope_id.clone();
        let reason = cancellation.reason;
        let state = self.jobs.entry(job.clone()).or_default();
        match &state.terminal {
            Some(JobTerminal::Final) => Ok(vec![WorkerEvent::NotCancellable {
                job,
                cancel_scope_id,
                requested_reason: reason,
                reason: NotCancellableReason::AlreadyFinal,
                existing_cancellation: None,
            }]),
            Some(JobTerminal::Failure) => Ok(vec![WorkerEvent::NotCancellable {
                job,
                cancel_scope_id,
                requested_reason: reason,
                reason: NotCancellableReason::AlreadyFailed,
                existing_cancellation: None,
            }]),
            Some(JobTerminal::Cancelled {
                cancellation: existing,
            }) => {
                if existing.scope_id != cancel_scope_id {
                    return Ok(vec![WorkerEvent::NotCancellable {
                        job,
                        cancel_scope_id,
                        requested_reason: reason,
                        reason: NotCancellableReason::AlreadyCancelled,
                        existing_cancellation: Some(existing.clone()),
                    }]);
                }
                Ok(vec![
                    WorkerEvent::CancelRequested {
                        job: job.clone(),
                        cancel_scope_id: cancel_scope_id.clone(),
                        reason,
                        repeated,
                    },
                    WorkerEvent::Cancelled {
                        job,
                        cancel_scope_id,
                        reason,
                        repeated,
                    },
                ])
            }
            None => {
                state.pending_progress.clear();
                state.terminal = Some(JobTerminal::Cancelled {
                    cancellation: cancellation.clone(),
                });
                Ok(vec![
                    WorkerEvent::CancelRequested {
                        job: job.clone(),
                        cancel_scope_id: cancel_scope_id.clone(),
                        reason,
                        repeated,
                    },
                    WorkerEvent::Cancelled {
                        job,
                        cancel_scope_id,
                        reason,
                        repeated,
                    },
                ])
            }
        }
    }

    fn restart(&mut self) -> Result<Vec<WorkerEvent>, ContractError> {
        if !self.pending_replay.is_empty() {
            return Err(ContractError::ReplayBatchPending);
        }
        let next_restart_count = self
            .restart_count
            .checked_add(1)
            .ok_or(ContractError::QueueInvariant)?;
        self.pending_replay = self.replay_snapshot();
        for state in self.jobs.values_mut() {
            if state.terminal.is_none() {
                *state = JobState::default();
            } else {
                state.pending_progress.clear();
            }
        }
        self.prepared = false;
        self.restart_count = next_restart_count;
        let mut events = self.poll_replay()?;
        events.push(WorkerEvent::Restarted {
            restart_count: self.restart_count,
        });
        Ok(events)
    }

    fn acknowledge_terminal(
        &mut self,
        context: &RequestContext,
    ) -> Result<Vec<WorkerEvent>, ContractError> {
        let key = context.job_key()?;
        let state = self
            .jobs
            .get(&key)
            .ok_or(ContractError::MissingRequestIdentity)?;
        if state.terminal.is_none() {
            return Err(ContractError::JobNotTerminal);
        }
        if self.retired_job_keys.len() >= self.limits.max_retired_job_keys as usize {
            return Err(ContractError::RetiredJobKeyCapacityFull);
        }
        if !self.retired_job_keys.insert(key.clone()) || self.jobs.remove(&key).is_none() {
            return Err(ContractError::QueueInvariant);
        }
        self.cancellations.retain(|_, record| {
            record.jobs.retain(|job| self.jobs.contains_key(job));
            record.events.retain(|event| match event {
                WorkerEvent::CancelRequested { job, .. }
                | WorkerEvent::Cancelled { job, .. }
                | WorkerEvent::NotCancellable { job, .. } => self.jobs.contains_key(job),
                _ => true,
            });
            !record.jobs.is_empty()
        });
        Ok(vec![WorkerEvent::TerminalAcknowledged { job: key }])
    }

    fn shutdown(&mut self) -> Result<Vec<WorkerEvent>, ContractError> {
        if !self.pending_replay.is_empty() {
            return Err(ContractError::ReplayBatchPending);
        }
        self.pending_replay = self.replay_snapshot();
        self.prepared = false;
        self.shutdown_state = ShutdownState::Draining;
        self.poll_replay()
    }

    fn replay_snapshot(&self) -> VecDeque<(JobKey, ReplayJobState)> {
        let mut replay_jobs: Vec<_> = self
            .jobs
            .iter()
            .map(|(job, state)| (job.clone(), state.replay_state()))
            .collect();
        replay_jobs.sort_by(|left, right| left.0.cmp(&right.0));
        replay_jobs.into()
    }

    fn poll_replay(&mut self) -> Result<Vec<WorkerEvent>, ContractError> {
        let batch_len = self
            .pending_replay
            .len()
            .min(self.limits.max_replay_events_per_batch as usize);
        let mut events = Vec::with_capacity(batch_len.saturating_add(1));
        for _ in 0..batch_len {
            let (job, state) = self
                .pending_replay
                .pop_front()
                .ok_or(ContractError::QueueInvariant)?;
            events.push(WorkerEvent::ReplayRequired { job, state });
        }
        if !self.pending_replay.is_empty() {
            events.push(WorkerEvent::ReplayBatchStatus {
                remaining: u32::try_from(self.pending_replay.len())
                    .map_err(|_| ContractError::QueueInvariant)?,
            });
        } else if self.shutdown_state == ShutdownState::Draining {
            self.shutdown_state = ShutdownState::Complete;
            events.push(WorkerEvent::ShutdownComplete);
        }
        Ok(events)
    }

    fn ensure_job_capacity(&self, key: &JobKey) -> Result<(), ContractError> {
        if self.retired_job_keys.contains(key) {
            return Err(ContractError::JobIdentityRetired);
        }
        if self.jobs.contains_key(key) {
            return Ok(());
        }
        if self.jobs.len() >= self.limits.max_tracked_jobs as usize {
            return Err(ContractError::JobCapacityFull);
        }
        let active_jobs = self
            .jobs
            .values()
            .filter(|state| state.terminal.is_none())
            .count();
        if active_jobs >= self.limits.max_in_flight_jobs as usize {
            return Err(ContractError::JobCapacityFull);
        }
        Ok(())
    }

    fn wrap_events(
        &mut self,
        request: &WorkerRequest,
        events: Vec<WorkerEvent>,
    ) -> Result<Vec<WorkerResponse>, ContractError> {
        events
            .into_iter()
            .map(|event| {
                self.response_sequence = self
                    .response_sequence
                    .checked_add(1)
                    .ok_or(ContractError::QueueInvariant)?;
                WorkerResponse::for_request(
                    Identifier::new(&format!("worker-event-{}", self.response_sequence))?,
                    request,
                    &self.manifest.descriptor,
                    event,
                    self.limits,
                )
            })
            .collect()
    }

    fn heartbeat(&mut self) -> Result<WorkerEvent, ContractError> {
        if self.shutdown_state == ShutdownState::Complete {
            return Err(ContractError::Shutdown);
        }
        self.heartbeat_sequence = self
            .heartbeat_sequence
            .checked_add(1)
            .ok_or(ContractError::QueueInvariant)?;
        Ok(WorkerEvent::Heartbeat {
            sequence: self.heartbeat_sequence,
        })
    }

    fn set_now_ns(&mut self, now_ns: u64) -> Result<(), ContractError> {
        if now_ns < self.now_ns {
            return Err(ContractError::ClockRollback);
        }
        self.now_ns = now_ns;
        Ok(())
    }
}

#[derive(Clone, Debug)]
struct EndpointCore {
    worker: FakeWorker,
    delivery: DeliveryLedger,
    handshaken: bool,
}

impl EndpointCore {
    fn new(manifest: WorkerManifest, limits: WorkerLimits) -> Result<Self, ContractError> {
        let epoch_nonce = NEXT_DELIVERY_SESSION_EPOCH.fetch_add(1, Ordering::Relaxed);
        let session_epoch =
            Identifier::new(&format!("{DELIVERY_SESSION_EPOCH_PREFIX}-{epoch_nonce}"))?;
        Ok(Self {
            worker: FakeWorker::new(manifest, limits, session_epoch.clone())?,
            delivery: DeliveryLedger::new(session_epoch, limits.max_replay_entries as usize),
            handshaken: false,
        })
    }

    fn handshake(
        &mut self,
        request: HelloRequest,
        transport: TransportKind,
    ) -> Result<HelloResponse, ContractError> {
        let response = HelloResponse {
            protocol: WORKER_PROTOCOL_V1,
            minimum_core_minor: WORKER_PROTOCOL_V1.minor,
            minor_extension_policy: MinorExtensionPolicy::Exact,
            platform: Platform {
                operating_system: OperatingSystem::Windows,
                architecture: Architecture::X86_64,
            },
            worker_id: self.worker.manifest.worker_id.clone(),
            role: self.worker.manifest.role,
            worker_build_sha256: self.worker.manifest.worker_build_sha256,
            executable_sha256: self.worker.manifest.executable_sha256,
            schema_registry_sha256: self.worker.manifest.schema_registry_sha256,
            delivery_session_epoch: self.delivery.session_epoch.clone(),
            descriptor: self.worker.manifest.descriptor.clone(),
            capabilities: CapabilitySet::required_v1(),
            accepted_limits: self.worker.limits,
            transport,
            network_policy: NetworkPolicy::OfflineOnly,
            silent_cloud_fallback: false,
        };
        request.validate_response(&response)?;
        self.handshaken = true;
        Ok(response)
    }

    fn require_handshake(&self) -> Result<(), ContractError> {
        if self.handshaken {
            Ok(())
        } else {
            Err(ContractError::TransportNotHandshaken)
        }
    }

    fn inspect(&self, request: &WorkerRequest) -> Result<Admission, ContractError> {
        self.delivery.inspect(request, self.worker.limits)
    }

    fn require_live_deadline(&self, request: &WorkerRequest) -> Result<(), ContractError> {
        if request.context.deadline.clock_domain_id != self.worker.clock_domain_id {
            return Err(ContractError::ClockDomainMismatch);
        }
        if request.context.deadline.deadline_ns <= self.worker.now_ns {
            return Err(ContractError::DeadlineExpired);
        }
        Ok(())
    }

    fn require_admissible_state(&self, request: &WorkerRequest) -> Result<(), ContractError> {
        if !matches!(request.command, WorkerCommand::PollReplay) {
            match self.worker.shutdown_state {
                ShutdownState::Running => {}
                ShutdownState::Draining => return Err(ContractError::ShutdownDraining),
                ShutdownState::Complete => return Err(ContractError::Shutdown),
            }
        }
        if !self.worker.pending_replay.is_empty()
            && matches!(
                request.command,
                WorkerCommand::Restart | WorkerCommand::Shutdown
            )
        {
            return Err(ContractError::ReplayBatchPending);
        }
        Ok(())
    }

    fn record(
        &mut self,
        request: WorkerRequest,
        outcome: Result<Vec<WorkerResponse>, ContractError>,
    ) -> Result<(), ContractError> {
        self.delivery.record(request, outcome)
    }
}

#[derive(Clone, Debug)]
struct PendingDelivery {
    request: WorkerRequest,
    outcome: Result<Vec<WorkerResponse>, ContractError>,
    replay: bool,
    queue_depth_at_admission: u32,
}

impl PendingDelivery {
    const fn sequence(&self) -> u64 {
        self.request.context.message_sequence
    }
}

fn delivery_units(outcome: &Result<Vec<WorkerResponse>, ContractError>) -> usize {
    outcome
        .as_ref()
        .map_or(0, |responses| responses.len().max(1))
}

#[derive(Clone, Debug)]
pub struct DirectFakeTransport {
    core: EndpointCore,
    pending: VecDeque<PendingDelivery>,
    new_command_count: usize,
    pending_delivery_units: usize,
    command_capacity: usize,
    delivery_capacity: usize,
}

impl DirectFakeTransport {
    pub fn new(manifest: WorkerManifest, limits: WorkerLimits) -> Result<Self, ContractError> {
        let command_capacity = limits.max_pending_commands as usize;
        let delivery_capacity = limits.max_pending_deliveries as usize;
        Ok(Self {
            core: EndpointCore::new(manifest, limits)?,
            pending: VecDeque::with_capacity(delivery_capacity),
            new_command_count: 0,
            pending_delivery_units: 0,
            command_capacity,
            delivery_capacity,
        })
    }
}

impl WorkerEndpoint for DirectFakeTransport {
    fn handshake(&mut self, request: HelloRequest) -> Result<HelloResponse, ContractError> {
        self.core.handshake(request, TransportKind::InProcess)
    }

    fn submit(&mut self, request: WorkerRequest) -> Result<(), ContractError> {
        self.core.require_handshake()?;
        request.validate_static(&self.core.delivery.session_epoch, self.core.worker.limits)?;
        if let Some(pending) = self
            .pending
            .iter()
            .find(|pending| pending.sequence() == request.context.message_sequence)
        {
            if pending.request.semantically_eq(&request) {
                return pending.outcome.clone().map(|_| ());
            }
            return Err(ContractError::MessageIdConflict);
        }
        match self.core.inspect(&request)? {
            Admission::Replay(outcome) => {
                outcome.as_ref().map_err(|error| *error)?;
                let units = delivery_units(&outcome);
                if self.pending_delivery_units.saturating_add(units) > self.delivery_capacity {
                    return Err(ContractError::ResponseQueueFull);
                }
                self.pending.push_back(PendingDelivery {
                    request,
                    outcome,
                    replay: true,
                    queue_depth_at_admission: 0,
                });
                self.pending_delivery_units += units;
                Ok(())
            }
            Admission::New => {
                self.core.require_admissible_state(&request)?;
                self.core.require_live_deadline(&request)?;
                if self.new_command_count >= self.command_capacity {
                    return Err(ContractError::QueueFull);
                }
                let mut projected_worker = self.core.worker.clone();
                let queue_depth_at_admission = u32::try_from(self.new_command_count)
                    .map_err(|_| ContractError::QueueInvariant)?;
                let outcome = projected_worker.process(request.clone(), queue_depth_at_admission);
                if let Err(error) = outcome
                    && !error.consumes_message_sequence()
                {
                    return Err(error);
                }
                let units = delivery_units(&outcome);
                if self.pending_delivery_units.saturating_add(units) > self.delivery_capacity {
                    return Err(ContractError::ResponseQueueFull);
                }
                self.core.record(request.clone(), outcome.clone())?;
                outcome.as_ref().map_err(|error| *error)?;
                self.core.worker = projected_worker;
                self.pending.push_back(PendingDelivery {
                    request,
                    outcome,
                    replay: false,
                    queue_depth_at_admission,
                });
                self.new_command_count += 1;
                self.pending_delivery_units += units;
                Ok(())
            }
        }
    }

    fn drain(&mut self) -> Result<Vec<WorkerResponse>, ContractError> {
        self.core.require_handshake()?;
        let mut responses = Vec::new();
        for pending in self.pending.drain(..) {
            responses.extend(pending.outcome?);
        }
        self.new_command_count = 0;
        self.pending_delivery_units = 0;
        Ok(responses)
    }

    fn heartbeat(&mut self) -> Result<WorkerEvent, ContractError> {
        self.core.require_handshake()?;
        self.core.worker.heartbeat()
    }
}

impl FakeClockControl for DirectFakeTransport {
    fn set_now_ns(&mut self, now_ns: u64) -> Result<(), ContractError> {
        if !self.pending.is_empty() {
            return Err(ContractError::ClockAdvanceWithPending);
        }
        self.core.worker.set_now_ns(now_ns)
    }
}

#[derive(Clone, Debug)]
pub struct InMemoryQueuedTransport {
    core: EndpointCore,
    pending: VecDeque<PendingDelivery>,
    new_command_count: usize,
    pending_delivery_units: usize,
    command_capacity: usize,
    delivery_capacity: usize,
}

impl InMemoryQueuedTransport {
    pub fn new(manifest: WorkerManifest, limits: WorkerLimits) -> Result<Self, ContractError> {
        let command_capacity = limits.max_pending_commands as usize;
        let delivery_capacity = limits.max_pending_deliveries as usize;
        Ok(Self {
            core: EndpointCore::new(manifest, limits)?,
            pending: VecDeque::with_capacity(delivery_capacity),
            new_command_count: 0,
            pending_delivery_units: 0,
            command_capacity,
            delivery_capacity,
        })
    }
}

impl WorkerEndpoint for InMemoryQueuedTransport {
    fn handshake(&mut self, request: HelloRequest) -> Result<HelloResponse, ContractError> {
        self.core.handshake(request, TransportKind::IsolatedProcess)
    }

    fn submit(&mut self, request: WorkerRequest) -> Result<(), ContractError> {
        self.core.require_handshake()?;
        request.validate_static(&self.core.delivery.session_epoch, self.core.worker.limits)?;
        if let Some(pending) = self
            .pending
            .iter()
            .find(|pending| pending.sequence() == request.context.message_sequence)
        {
            if pending.request.semantically_eq(&request) {
                return pending.outcome.clone().map(|_| ());
            }
            return Err(ContractError::MessageIdConflict);
        }
        match self.core.inspect(&request)? {
            Admission::Replay(outcome) => {
                outcome.as_ref().map_err(|error| *error)?;
                let units = delivery_units(&outcome);
                if self.pending_delivery_units.saturating_add(units) > self.delivery_capacity {
                    return Err(ContractError::ResponseQueueFull);
                }
                self.pending.push_back(PendingDelivery {
                    request,
                    outcome,
                    replay: true,
                    queue_depth_at_admission: 0,
                });
                self.pending_delivery_units += units;
                Ok(())
            }
            Admission::New => {
                self.core.require_admissible_state(&request)?;
                self.core.require_live_deadline(&request)?;
                if self.new_command_count >= self.command_capacity {
                    return Err(ContractError::QueueFull);
                }
                let mut projected_worker = self.core.worker.clone();
                for pending in self.pending.iter().filter(|pending| !pending.replay) {
                    projected_worker
                        .process(pending.request.clone(), pending.queue_depth_at_admission)?;
                }
                let queue_depth_at_admission = u32::try_from(self.new_command_count)
                    .map_err(|_| ContractError::QueueInvariant)?;
                let outcome = projected_worker.process(request.clone(), queue_depth_at_admission);
                if let Err(error) = outcome
                    && !error.consumes_message_sequence()
                {
                    return Err(error);
                }
                let units = delivery_units(&outcome);
                if self.pending_delivery_units.saturating_add(units) > self.delivery_capacity {
                    return Err(ContractError::ResponseQueueFull);
                }
                self.core.record(request.clone(), outcome.clone())?;
                outcome.as_ref().map_err(|error| *error)?;
                self.pending.push_back(PendingDelivery {
                    request,
                    outcome,
                    replay: false,
                    queue_depth_at_admission,
                });
                self.new_command_count += 1;
                self.pending_delivery_units += units;
                Ok(())
            }
        }
    }

    fn drain(&mut self) -> Result<Vec<WorkerResponse>, ContractError> {
        self.core.require_handshake()?;
        let mut projected_worker = self.core.worker.clone();
        let mut responses = Vec::new();
        for pending in &self.pending {
            if pending.replay {
                responses.extend(pending.outcome.clone()?);
                continue;
            }
            let live_heartbeat_sequence = projected_worker.heartbeat_sequence;
            if matches!(pending.request.command, WorkerCommand::Health) {
                projected_worker.heartbeat_sequence = pending
                    .outcome
                    .as_ref()
                    .ok()
                    .and_then(|responses| responses.first())
                    .and_then(|response| match response.event() {
                        WorkerEvent::Health {
                            heartbeat_sequence, ..
                        } => Some(*heartbeat_sequence),
                        _ => None,
                    })
                    .ok_or(ContractError::QueueInvariant)?;
            }
            let actual =
                projected_worker.process(pending.request.clone(), pending.queue_depth_at_admission);
            projected_worker.heartbeat_sequence = live_heartbeat_sequence;
            if actual != pending.outcome {
                return Err(ContractError::QueueInvariant);
            }
            responses.extend(actual?);
        }
        self.core.worker = projected_worker;
        self.pending.clear();
        self.new_command_count = 0;
        self.pending_delivery_units = 0;
        Ok(responses)
    }

    fn heartbeat(&mut self) -> Result<WorkerEvent, ContractError> {
        self.core.require_handshake()?;
        self.core.worker.heartbeat()
    }
}

impl FakeClockControl for InMemoryQueuedTransport {
    fn set_now_ns(&mut self, now_ns: u64) -> Result<(), ContractError> {
        if !self.pending.is_empty() {
            return Err(ContractError::ClockAdvanceWithPending);
        }
        self.core.worker.set_now_ns(now_ns)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConformanceTranscript {
    pub responses: Vec<WorkerResponse>,
    pub heartbeats: Vec<WorkerEvent>,
}

/// Runs the deterministic fake-worker oracle used by WP-0.4.1.
///
/// This intentionally checks fixture-specific event order and fake semantics. It
/// is not the future candidate invariant suite: real candidates may report any
/// negotiated execution provider and any validated resource estimate while
/// preserving the transport-neutral protocol invariants.
pub fn run_deterministic_fixture_conformance(
    endpoint: impl WorkerEndpoint,
    hello: HelloRequest,
) -> Result<ConformanceTranscript, ContractError> {
    run_deterministic_fixture_conformance_with_clock(
        endpoint,
        hello,
        Identifier::new(DEFAULT_FAKE_CLOCK_DOMAIN_ID)?,
        DEFAULT_DEADLINE_NS,
    )
}

/// Deterministic fixture oracle with an explicit caller-owned monotonic clock domain.
pub fn run_deterministic_fixture_conformance_with_clock(
    mut endpoint: impl WorkerEndpoint,
    hello: HelloRequest,
    clock_domain_id: Identifier,
    deadline_ns: u64,
) -> Result<ConformanceTranscript, ContractError> {
    if hello.purpose != ContractPurpose::ContractFixture
        || hello.expected.role != WorkerRole::ContractFixture
    {
        return Err(ContractError::ContractFixtureRequired);
    }
    let hello_response = endpoint.handshake(hello.clone())?;
    let mut responses = Vec::new();
    let mut requests = ConformanceRequestBuilder {
        message_sequence: 0,
        delivery_session_epoch: hello_response.delivery_session_epoch,
        clock_domain_id,
        deadline_ns,
    };

    let describe = requests.build(None, None, WorkerCommand::Describe)?;
    endpoint.submit(describe.clone())?;
    endpoint.submit(describe.clone())?;
    let mut pending_conflict = describe;
    pending_conflict.command = WorkerCommand::Health;
    if endpoint.submit(pending_conflict) != Err(ContractError::MessageIdConflict) {
        return Err(ContractError::QueueInvariant);
    }
    endpoint.submit(requests.build(
        None,
        None,
        WorkerCommand::Prepare(PrepareRequest {
            model_manifest_sha256: hello.expected.descriptor.model_manifest_sha256,
            execution_provider: hello.expected.descriptor.execution_provider,
        }),
    )?)?;
    responses.extend(endpoint.drain()?);

    let segment_a = job("a")?;
    responses.extend(endpoint.exchange(requests.build(
        Some(&segment_a),
        None,
        WorkerCommand::AcceptAudio(audio_chunk(1, 0)?),
    )?)?);
    let active_acknowledgement_a =
        requests.build(Some(&segment_a), None, WorkerCommand::AcknowledgeTerminal)?;
    if endpoint.exchange(active_acknowledgement_a.clone()) != Err(ContractError::JobNotTerminal) {
        return Err(ContractError::QueueInvariant);
    }
    responses.extend(endpoint.exchange(requests.build(
        Some(&segment_a),
        None,
        WorkerCommand::PollEvents,
    )?)?);
    responses.extend(endpoint.exchange(requests.build(
        Some(&segment_a),
        None,
        WorkerCommand::FlushSegment,
    )?)?);
    let mut active_acknowledgement_retry_a = active_acknowledgement_a;
    active_acknowledgement_retry_a.context.deadline.deadline_ns = active_acknowledgement_retry_a
        .context
        .deadline
        .deadline_ns
        .checked_add(1)
        .ok_or(ContractError::QueueInvariant)?;
    if endpoint.exchange(active_acknowledgement_retry_a) != Err(ContractError::JobNotTerminal) {
        return Err(ContractError::QueueInvariant);
    }
    responses.extend(endpoint.exchange(requests.build(
        Some(&segment_a),
        Some("cancel-after-final-a"),
        WorkerCommand::Cancel {
            reason: CancelReason::MeetingEnded,
        },
    )?)?);
    let acknowledge_a =
        requests.build(Some(&segment_a), None, WorkerCommand::AcknowledgeTerminal)?;
    let acknowledged_a = endpoint.exchange(acknowledge_a.clone())?;
    responses.extend(acknowledged_a.clone());
    let mut retry_a = acknowledge_a.clone();
    retry_a.context.deadline.deadline_ns = retry_a
        .context
        .deadline
        .deadline_ns
        .checked_add(1)
        .ok_or(ContractError::QueueInvariant)?;
    if endpoint.exchange(retry_a)? != acknowledged_a {
        return Err(ContractError::QueueInvariant);
    }
    let mut conflicting_a = acknowledge_a;
    conflicting_a.command = WorkerCommand::PollEvents;
    if endpoint.exchange(conflicting_a) != Err(ContractError::MessageIdConflict) {
        return Err(ContractError::QueueInvariant);
    }

    let segment_b = job("b")?;
    responses.extend(endpoint.exchange(requests.build(
        Some(&segment_b),
        None,
        WorkerCommand::AcceptAudio(audio_chunk(1, 0)?),
    )?)?);
    responses.extend(endpoint.exchange(requests.build(
        Some(&segment_b),
        Some("cancel-b"),
        WorkerCommand::Cancel {
            reason: CancelReason::UserRequested,
        },
    )?)?);
    responses.extend(endpoint.exchange(requests.build(
        Some(&segment_b),
        Some("cancel-b"),
        WorkerCommand::Cancel {
            reason: CancelReason::UserRequested,
        },
    )?)?);
    responses.extend(endpoint.exchange(requests.build(
        Some(&segment_b),
        Some("cancel-after-cancelled-b"),
        WorkerCommand::Cancel {
            reason: CancelReason::MeetingEnded,
        },
    )?)?);
    responses.extend(endpoint.exchange(requests.build(
        Some(&segment_b),
        None,
        WorkerCommand::AcknowledgeTerminal,
    )?)?);

    let segment_c = job("c")?;
    responses.extend(endpoint.exchange(requests.build(
        Some(&segment_c),
        None,
        WorkerCommand::AcceptAudio(audio_chunk(1, 0)?),
    )?)?);
    responses.extend(endpoint.exchange(requests.build(
        Some(&segment_c),
        None,
        WorkerCommand::FlushSegment,
    )?)?);
    responses.extend(endpoint.exchange(requests.build(
        Some(&segment_c),
        None,
        WorkerCommand::AcknowledgeTerminal,
    )?)?);

    let segment_d = job("d")?;
    responses.extend(endpoint.exchange(requests.build(
        Some(&segment_d),
        None,
        WorkerCommand::FlushSegment,
    )?)?);
    responses.extend(endpoint.exchange(requests.build(
        Some(&segment_d),
        Some("cancel-after-failure-d"),
        WorkerCommand::Cancel {
            reason: CancelReason::Superseded,
        },
    )?)?);
    responses.extend(endpoint.exchange(requests.build(
        Some(&segment_d),
        None,
        WorkerCommand::AcknowledgeTerminal,
    )?)?);

    let segment_e = job("e")?;
    responses.extend(endpoint.exchange(requests.build(
        Some(&segment_e),
        None,
        WorkerCommand::AcceptAudio(audio_chunk(1, 0)?),
    )?)?);
    responses.extend(endpoint.exchange(requests.build(None, None, WorkerCommand::Restart)?)?);
    responses.extend(endpoint.exchange(requests.build(
        None,
        None,
        WorkerCommand::Prepare(PrepareRequest {
            model_manifest_sha256: hello.expected.descriptor.model_manifest_sha256,
            execution_provider: hello.expected.descriptor.execution_provider,
        }),
    )?)?);
    responses.extend(endpoint.exchange(requests.build(
        Some(&segment_e),
        Some("cancel-after-restart-e"),
        WorkerCommand::Cancel {
            reason: CancelReason::MeetingEnded,
        },
    )?)?);
    responses.extend(endpoint.exchange(requests.build(
        Some(&segment_e),
        None,
        WorkerCommand::AcknowledgeTerminal,
    )?)?);

    let heartbeats = vec![endpoint.heartbeat()?];
    responses.extend(endpoint.exchange(requests.build(None, None, WorkerCommand::Health)?)?);
    responses.extend(endpoint.exchange(requests.build(None, None, WorkerCommand::Shutdown)?)?);

    validate_conformance_transcript(&responses, &heartbeats, &hello.expected.descriptor)?;
    Ok(ConformanceTranscript {
        responses,
        heartbeats,
    })
}

struct ConformanceRequestBuilder {
    message_sequence: u64,
    delivery_session_epoch: Identifier,
    clock_domain_id: Identifier,
    deadline_ns: u64,
}

impl ConformanceRequestBuilder {
    fn build(
        &mut self,
        job: Option<&JobKey>,
        cancel_scope_id: Option<&str>,
        command: WorkerCommand,
    ) -> Result<WorkerRequest, ContractError> {
        request(
            &mut self.message_sequence,
            &self.delivery_session_epoch,
            &self.clock_domain_id,
            self.deadline_ns,
            job,
            cancel_scope_id,
            command,
        )
    }
}

fn validate_conformance_transcript(
    responses: &[WorkerResponse],
    heartbeats: &[WorkerEvent],
    expected_descriptor: &crate::EngineDescriptor,
) -> Result<(), ContractError> {
    const EXPECTED_KINDS: [&str; 29] = [
        "described",
        "prepared",
        "audio-accepted",
        "progress",
        "final",
        "not-cancellable",
        "terminal-acknowledged",
        "audio-accepted",
        "cancel-requested",
        "cancelled",
        "cancel-requested",
        "cancelled",
        "not-cancellable",
        "terminal-acknowledged",
        "audio-accepted",
        "final",
        "terminal-acknowledged",
        "failure",
        "not-cancellable",
        "terminal-acknowledged",
        "audio-accepted",
        "replay-required",
        "restarted",
        "prepared",
        "cancel-requested",
        "cancelled",
        "terminal-acknowledged",
        "health",
        "shutdown",
    ];
    const EXPECTED_CORRELATIONS: [&str; 29] = [
        "message-1",
        "message-2",
        "message-3",
        "message-5",
        "message-6",
        "message-7",
        "message-8",
        "message-9",
        "message-10",
        "message-10",
        "message-11",
        "message-11",
        "message-12",
        "message-13",
        "message-14",
        "message-15",
        "message-16",
        "message-17",
        "message-18",
        "message-19",
        "message-20",
        "message-21",
        "message-21",
        "message-22",
        "message-23",
        "message-23",
        "message-24",
        "message-25",
        "message-26",
    ];
    const EXPECTED_SEQUENCES: [u64; 29] = [
        1, 2, 3, 5, 6, 7, 8, 9, 10, 10, 11, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 21, 22, 23,
        23, 24, 25, 26,
    ];
    const EXPECTED_JOB_SUFFIXES: [Option<&str>; 29] = [
        None,
        None,
        Some("a"),
        Some("a"),
        Some("a"),
        Some("a"),
        Some("a"),
        Some("b"),
        Some("b"),
        Some("b"),
        Some("b"),
        Some("b"),
        Some("b"),
        Some("b"),
        Some("c"),
        Some("c"),
        Some("c"),
        Some("d"),
        Some("d"),
        Some("d"),
        Some("e"),
        None,
        None,
        None,
        Some("e"),
        Some("e"),
        Some("e"),
        None,
        None,
    ];
    if responses.len() != EXPECTED_KINDS.len()
        || heartbeats != [WorkerEvent::Heartbeat { sequence: 1 }]
    {
        return Err(ContractError::QueueInvariant);
    }

    let mut response_ids = HashSet::with_capacity(responses.len());
    for (index, response) in responses.iter().enumerate() {
        if response.message_id().as_str().is_empty()
            || !response_ids.insert(response.message_id().clone())
            || response.correlation_id().as_str() != EXPECTED_CORRELATIONS[index]
            || response.correlation_sequence() != EXPECTED_SEQUENCES[index]
            || response.trace_id().as_str() != "trace-contract-fixture"
            || event_kind(response.event()) != EXPECTED_KINDS[index]
        {
            return Err(ContractError::QueueInvariant);
        }
        match EXPECTED_JOB_SUFFIXES[index] {
            Some(suffix)
                if response.meeting_id().map(Identifier::as_str)
                    == Some("meeting-contract-fixture")
                    && response.job_id().map(Identifier::as_str)
                        == Some(format!("job-{suffix}").as_str())
                    && response.segment_id().map(Identifier::as_str)
                        == Some(format!("segment-{suffix}").as_str()) => {}
            Some(_) => return Err(ContractError::QueueInvariant),
            None if response.meeting_id().is_none()
                && response.job_id().is_none()
                && response.segment_id().is_none() => {}
            None => return Err(ContractError::QueueInvariant),
        }
    }

    if !matches!(
        responses[0].event(),
        WorkerEvent::Described { descriptor } if descriptor == expected_descriptor
    ) || !matches!(
        responses[1].event(),
        WorkerEvent::Prepared {
            ready: true,
            execution_provider,
            fallback_nodes,
            resource_estimate,
        } if fallback_nodes.is_empty()
            && *execution_provider == expected_descriptor.execution_provider
            && resource_estimate.validate().is_ok()
    ) || !matches!(
        responses[2].event(),
        WorkerEvent::AudioAccepted { sequence: 1 }
    ) || !matches!(
        responses[3].event(),
        WorkerEvent::Progress {
            progress_sequence: 1,
            last_audio_sequence: 1,
        }
    ) || !matches!(
        responses[4].event(),
        WorkerEvent::Final { segment_id, last_audio_sequence: 1 }
            if segment_id.as_str() == "segment-a"
    ) || !matches!(
        responses[5].event(),
        WorkerEvent::NotCancellable {
            reason: NotCancellableReason::AlreadyFinal,
            ..
        }
    ) || !matches!(
        responses[6].event(),
        WorkerEvent::TerminalAcknowledged { job } if job.segment_id.as_str() == "segment-a"
    ) || !matches!(
        responses[7].event(),
        WorkerEvent::AudioAccepted { sequence: 1 }
    ) || !matches!(
        responses[10].event(),
        WorkerEvent::CancelRequested {
            cancel_scope_id,
            reason: CancelReason::UserRequested,
            repeated: true,
            ..
        } if cancel_scope_id.as_str() == "cancel-b"
    ) || !matches!(
        responses[8].event(),
        WorkerEvent::CancelRequested {
            cancel_scope_id,
            reason: CancelReason::UserRequested,
            repeated: false,
            ..
        } if cancel_scope_id.as_str() == "cancel-b"
    ) || !matches!(
        responses[9].event(),
        WorkerEvent::Cancelled {
            cancel_scope_id,
            reason: CancelReason::UserRequested,
            repeated: false,
            ..
        } if cancel_scope_id.as_str() == "cancel-b"
    ) || !matches!(
        responses[11].event(),
        WorkerEvent::Cancelled {
            cancel_scope_id,
            reason: CancelReason::UserRequested,
            repeated: true,
            ..
        } if cancel_scope_id.as_str() == "cancel-b"
    ) || !matches!(
        responses[12].event(),
        WorkerEvent::NotCancellable {
            reason: NotCancellableReason::AlreadyCancelled,
            ..
        }
    ) || !matches!(
        responses[13].event(),
        WorkerEvent::TerminalAcknowledged { job } if job.segment_id.as_str() == "segment-b"
    ) || !matches!(
        responses[14].event(),
        WorkerEvent::AudioAccepted { sequence: 1 }
    ) || !matches!(
        responses[15].event(),
        WorkerEvent::Final { segment_id, last_audio_sequence: 1 }
            if segment_id.as_str() == "segment-c"
    ) || !matches!(
        responses[16].event(),
        WorkerEvent::TerminalAcknowledged { job } if job.segment_id.as_str() == "segment-c"
    ) || !matches!(
        responses[17].event(),
        WorkerEvent::Failure { segment_id, error }
            if segment_id.as_str() == "segment-d"
                && error.code().as_str() == "MODEL_NO_AUDIO"
                && error.correlation_id().as_str() == "message-17"
                && error.correlation_sequence() == 17
    ) || !matches!(
        responses[18].event(),
        WorkerEvent::NotCancellable {
            reason: NotCancellableReason::AlreadyFailed,
            ..
        }
    ) || !matches!(
        responses[19].event(),
        WorkerEvent::TerminalAcknowledged { job } if job.segment_id.as_str() == "segment-d"
    ) || !matches!(
        responses[20].event(),
        WorkerEvent::AudioAccepted { sequence: 1 }
    ) || !matches!(
        responses[21].event(),
        WorkerEvent::ReplayRequired {
            job,
            state: ReplayJobState::Active,
        } if job.segment_id.as_str() == "segment-e"
    ) || !matches!(
        responses[22].event(),
        WorkerEvent::Restarted { restart_count: 1 }
    ) || !matches!(
        responses[23].event(),
        WorkerEvent::Prepared {
            ready: true,
            execution_provider,
            fallback_nodes,
            resource_estimate,
        } if fallback_nodes.is_empty()
            && *execution_provider == expected_descriptor.execution_provider
            && resource_estimate.validate().is_ok()
    ) || !matches!(
        responses[24].event(),
        WorkerEvent::CancelRequested {
            repeated: false,
            ..
        }
    ) || !matches!(
        responses[25].event(),
        WorkerEvent::Cancelled {
            repeated: false,
            ..
        }
    ) || !matches!(
        responses[26].event(),
        WorkerEvent::TerminalAcknowledged { job } if job.segment_id.as_str() == "segment-e"
    ) || !matches!(
        responses[27].event(),
        WorkerEvent::Health {
            heartbeat_sequence: 1,
            last_progress_sequence: None,
            queue_depth: 0,
            model_ready: true,
            restart_count: 1,
            ..
        }
    ) || !matches!(responses[28].event(), WorkerEvent::ShutdownComplete)
    {
        return Err(ContractError::QueueInvariant);
    }
    Ok(())
}

const fn event_kind(event: &WorkerEvent) -> &'static str {
    match event {
        WorkerEvent::Described { .. } => "described",
        WorkerEvent::Prepared { .. } => "prepared",
        WorkerEvent::AudioAccepted { .. } => "audio-accepted",
        WorkerEvent::GapAccepted { .. } => "gap-accepted",
        WorkerEvent::Progress { .. } => "progress",
        WorkerEvent::Final { .. } => "final",
        WorkerEvent::Failure { .. } => "failure",
        WorkerEvent::CancelRequested { .. } => "cancel-requested",
        WorkerEvent::Cancelled { .. } => "cancelled",
        WorkerEvent::NotCancellable { .. } => "not-cancellable",
        WorkerEvent::TerminalAcknowledged { .. } => "terminal-acknowledged",
        WorkerEvent::ReplayRequired { .. } => "replay-required",
        WorkerEvent::ReplayBatchStatus { .. } => "replay-batch-status",
        WorkerEvent::Restarted { .. } => "restarted",
        WorkerEvent::Health { .. } => "health",
        WorkerEvent::Heartbeat { .. } => "heartbeat",
        WorkerEvent::ShutdownComplete => "shutdown",
    }
}

fn job(suffix: &str) -> Result<JobKey, ContractError> {
    Ok(JobKey {
        meeting_id: Identifier::new("meeting-contract-fixture")?,
        job_id: Identifier::new(&format!("job-{suffix}"))?,
        segment_id: Identifier::new(&format!("segment-{suffix}"))?,
    })
}

fn request(
    message_sequence: &mut u64,
    delivery_session_epoch: &Identifier,
    clock_domain_id: &Identifier,
    deadline_ns: u64,
    job: Option<&JobKey>,
    cancel_scope_id: Option<&str>,
    command: WorkerCommand,
) -> Result<WorkerRequest, ContractError> {
    *message_sequence = message_sequence
        .checked_add(1)
        .ok_or(ContractError::QueueInvariant)?;
    Ok(WorkerRequest {
        context: RequestContext {
            delivery_session_epoch: delivery_session_epoch.clone(),
            message_sequence: *message_sequence,
            message_id: Identifier::new(&format!("message-{message_sequence}"))?,
            trace_id: Identifier::new("trace-contract-fixture")?,
            meeting_id: job.map(|key| key.meeting_id.clone()),
            job_id: job.map(|key| key.job_id.clone()),
            segment_id: job.map(|key| key.segment_id.clone()),
            cancel_scope_id: cancel_scope_id.map(Identifier::new).transpose()?,
            deadline: MonotonicDeadline {
                clock_domain_id: clock_domain_id.clone(),
                deadline_ns,
            },
        },
        command,
    })
}

fn audio_chunk(sequence: u64, media_start_sample: u64) -> Result<AudioChunk, ContractError> {
    let capture_epoch_id = Identifier::new("epoch-contract-fixture")?;
    let media_end_sample = media_start_sample + 320;
    Ok(AudioChunk {
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
    })
}
