use std::sync::{Arc, Mutex, MutexGuard};

use super::contract::{AudioSourceSnapshot, Lifecycle, MvpSnapshot, SourceId, SourceStatus};

#[cfg(windows)]
use std::{
    collections::VecDeque,
    env,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
        mpsc::{Receiver, RecvTimeoutError, SyncSender, TryRecvError, TrySendError, sync_channel},
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

#[cfg(windows)]
use meetingrelay_model_worker_sherpa_native::{LockedSherpaRealtime, LockedSherpaRealtimePaths};

#[cfg(windows)]
use super::{
    audio::{
        AudioCapture, AudioCaptureMetrics, AudioCaptureOptions, AudioCaptureOutput,
        AudioCaptureStatus, AudioCaptureStatusKind, AudioDevicePreflight, AudioSourceId,
        AudioSourceStats, RawAudioPacket,
    },
    contract::{MAX_INFERENCE_QUEUE_DEPTH, TranscriptSegment},
    dsp::{
        AudioBlock, AudioSegment, BlockPacketizer, EnergyEndpointSegmenter, Mono16kResampler,
        SegmentEvent, TARGET_SAMPLE_RATE_HZ, mix_blocks,
    },
};

pub struct MvpService {
    snapshot: Arc<Mutex<MvpSnapshot>>,
    inner: Mutex<ServiceInner>,
}

#[derive(Default)]
struct ServiceInner {
    #[cfg(windows)]
    inference: Option<InferenceWorker>,
    #[cfg(windows)]
    session: Option<RunningSession>,
}

impl Default for MvpService {
    fn default() -> Self {
        Self {
            snapshot: Arc::new(Mutex::new(MvpSnapshot::booting())),
            inner: Mutex::new(ServiceInner::default()),
        }
    }
}

impl MvpService {
    pub fn snapshot(&self) -> MvpSnapshot {
        let inner = lock(&self.inner);
        #[cfg(windows)]
        self.refresh_running_snapshot(&inner);
        let mut snapshot = lock(&self.snapshot).clone();
        snapshot.enforce_bounds();
        snapshot
    }

    pub fn preflight(&self) -> Result<MvpSnapshot, String> {
        #[cfg(windows)]
        {
            self.preflight_windows()
        }
        #[cfg(not(windows))]
        {
            let error = "MVP_WINDOWS_ONLY".to_owned();
            self.fail(&error);
            Err(error)
        }
    }

    pub fn start(&self, consent_accepted: bool) -> Result<MvpSnapshot, String> {
        if !consent_accepted {
            return Err("CONSENT_REQUIRED".to_owned());
        }

        #[cfg(windows)]
        {
            self.start_windows()
        }
        #[cfg(not(windows))]
        {
            Err("MVP_WINDOWS_ONLY".to_owned())
        }
    }

    pub fn stop(&self) -> Result<MvpSnapshot, String> {
        #[cfg(windows)]
        {
            self.stop_windows()
        }
        #[cfg(not(windows))]
        {
            Err("MVP_WINDOWS_ONLY".to_owned())
        }
    }

    fn fail(&self, error: &str) {
        let mut snapshot = lock(&self.snapshot);
        snapshot.lifecycle = Lifecycle::Error;
        snapshot.error = Some(error.to_owned());
    }

    #[cfg(windows)]
    fn preflight_windows(&self) -> Result<MvpSnapshot, String> {
        let mut inner = lock(&self.inner);
        if inner.session.is_some() {
            return Ok(self.snapshot_locked(&inner));
        }

        {
            let mut snapshot = lock(&self.snapshot);
            snapshot.lifecycle = Lifecycle::Booting;
            snapshot.error = None;
        }

        let devices = AudioCapture::preflight_default_devices().map_err(|error| {
            let code = public_audio_error(&error.to_string());
            self.fail(&code);
            code
        })?;

        if inner.inference.is_none() {
            let paths = resolve_model_paths().inspect_err(|error| self.fail(error))?;
            let worker = InferenceWorker::prepare(Arc::clone(&self.snapshot), paths)
                .inspect_err(|error| self.fail(error))?;
            inner.inference = Some(worker);
        }

        let mut snapshot = lock(&self.snapshot);
        snapshot.lifecycle = Lifecycle::Ready;
        snapshot.model_ready = true;
        snapshot.model_label = "SenseVoice · zh · CPU · local".to_owned();
        snapshot.system = ready_source(SourceId::System, &devices.system_output);
        snapshot.microphone = ready_source(SourceId::Microphone, &devices.microphone);
        snapshot.error = None;
        snapshot.enforce_bounds();
        Ok(snapshot.clone())
    }

    #[cfg(windows)]
    fn start_windows(&self) -> Result<MvpSnapshot, String> {
        let mut inner = lock(&self.inner);
        if inner.session.is_some() {
            return Err("SESSION_ALREADY_RUNNING".to_owned());
        }
        if inner.inference.is_none() || lock(&self.snapshot).lifecycle != Lifecycle::Ready {
            return Err("MVP_NOT_READY".to_owned());
        }

        {
            let mut snapshot = lock(&self.snapshot);
            snapshot.lifecycle = Lifecycle::Starting;
            snapshot.error = None;
            snapshot.interim = None;
            snapshot.finals.clear();
            snapshot.elapsed_ms = "0".to_owned();
            snapshot.system.frames = "0".to_owned();
            snapshot.microphone.frames = "0".to_owned();
        }

        let (capture, output) = AudioCapture::start_default(AudioCaptureOptions::default())
            .map_err(|error| {
                let code = public_audio_error(&error.to_string());
                self.fail(&code);
                code
            })?;
        let session_id = next_session_id();
        let submitter = inner
            .inference
            .as_ref()
            .expect("inference readiness was checked above")
            .submitter();
        let stop = Arc::new(AtomicBool::new(false));
        let metrics = output.metrics.clone();
        let preflight = output.preflight.clone();
        let coordinator = match spawn_coordinator(
            output,
            submitter,
            Arc::clone(&self.snapshot),
            session_id.clone(),
            Arc::clone(&stop),
        ) {
            Ok(coordinator) => coordinator,
            Err(error) => {
                drop(capture);
                self.fail(&error);
                return Err(error);
            }
        };

        inner.session = Some(RunningSession {
            capture,
            coordinator: Some(coordinator),
            stop,
            metrics,
            started: Instant::now(),
        });

        let mut snapshot = lock(&self.snapshot);
        snapshot.lifecycle = Lifecycle::Recording;
        snapshot.session_id = Some(session_id);
        snapshot.system = capturing_source(SourceId::System, &preflight.system_output);
        snapshot.microphone = capturing_source(SourceId::Microphone, &preflight.microphone);
        snapshot.error = None;
        Ok(snapshot.clone())
    }

    #[cfg(windows)]
    fn stop_windows(&self) -> Result<MvpSnapshot, String> {
        let (mut session, submitter) = {
            let mut inner = lock(&self.inner);
            let Some(session) = inner.session.take() else {
                return Ok(self.snapshot_locked(&inner));
            };
            let submitter = inner.inference.as_ref().map(InferenceWorker::submitter);
            (session, submitter)
        };

        self.refresh_from_session(&session, true);
        lock(&self.snapshot).lifecycle = Lifecycle::Stopping;
        session.capture.stop();
        session.stop.store(true, Ordering::Release);
        let deadline = Instant::now() + Duration::from_secs(12);

        if let Some(coordinator) = session.coordinator.take() {
            join_before(coordinator, deadline).inspect_err(|error| self.fail(error))?;
        }

        if let Some(submitter) = submitter {
            submitter
                .barrier(deadline.saturating_duration_since(Instant::now()))
                .inspect_err(|error| self.fail(error))?;
        }

        let mut snapshot = lock(&self.snapshot);
        snapshot.lifecycle = Lifecycle::Ready;
        snapshot.system.active = false;
        snapshot.system.peak = 0.0;
        snapshot.system.status = SourceStatus::Ready;
        snapshot.microphone.active = false;
        snapshot.microphone.peak = 0.0;
        snapshot.microphone.status = SourceStatus::Ready;
        snapshot.queue_depth = 0;
        snapshot.error = None;
        snapshot.enforce_bounds();
        Ok(snapshot.clone())
    }

    #[cfg(windows)]
    fn snapshot_locked(&self, inner: &ServiceInner) -> MvpSnapshot {
        self.refresh_running_snapshot(inner);
        let mut snapshot = lock(&self.snapshot).clone();
        snapshot.enforce_bounds();
        snapshot
    }

    #[cfg(windows)]
    fn refresh_running_snapshot(&self, inner: &ServiceInner) {
        if let Some(session) = inner.session.as_ref() {
            self.refresh_from_session(session, false);
        }
        if let Some(inference) = inner.inference.as_ref() {
            lock(&self.snapshot).queue_depth = inference.queue_depth();
        }
    }

    #[cfg(windows)]
    fn refresh_from_session(&self, session: &RunningSession, stopping: bool) {
        let system = session.metrics.snapshot(AudioSourceId::SystemOutput);
        let microphone = session.metrics.snapshot(AudioSourceId::Microphone);
        let mut snapshot = lock(&self.snapshot);
        snapshot.elapsed_ms = session.started.elapsed().as_millis().to_string();
        apply_source_stats(&mut snapshot.system, system, !stopping);
        apply_source_stats(&mut snapshot.microphone, microphone, !stopping);
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

#[cfg(windows)]
struct RunningSession {
    capture: AudioCapture,
    coordinator: Option<JoinHandle<()>>,
    stop: Arc<AtomicBool>,
    metrics: AudioCaptureMetrics,
    started: Instant,
}

#[cfg(windows)]
fn ready_source(id: SourceId, device: &AudioDevicePreflight) -> AudioSourceSnapshot {
    AudioSourceSnapshot {
        id,
        label: device.name.clone(),
        ready: true,
        active: false,
        frames: "0".to_owned(),
        peak: 0.0,
        status: SourceStatus::Ready,
        error: None,
    }
}

#[cfg(windows)]
fn capturing_source(id: SourceId, device: &AudioDevicePreflight) -> AudioSourceSnapshot {
    let mut source = ready_source(id, device);
    source.active = true;
    source.status = SourceStatus::Capturing;
    source
}

#[cfg(windows)]
fn apply_source_stats(source: &mut AudioSourceSnapshot, stats: AudioSourceStats, active: bool) {
    source.active = active;
    source.frames = stats.captured_frames.to_string();
    source.peak = if active {
        stats.peak.clamp(0.0, 1.0)
    } else {
        0.0
    };
    if stats.stream_errors > 0 {
        source.status = SourceStatus::Error;
        source.error = Some("AUDIO_STREAM_ERROR".to_owned());
    } else if stats.dropped_packets > 0 {
        source.status = SourceStatus::Degraded;
        source.error = Some(format!("AUDIO_PACKETS_DROPPED:{}", stats.dropped_packets));
    } else {
        source.status = if active {
            SourceStatus::Capturing
        } else {
            SourceStatus::Ready
        };
        source.error = None;
    }
}

#[cfg(windows)]
fn public_audio_error(detail: &str) -> String {
    let normalized = detail
        .chars()
        .filter(|character| !character.is_control())
        .take(180)
        .collect::<String>();
    format!("AUDIO_UNAVAILABLE:{normalized}")
}

#[cfg(windows)]
fn next_session_id() -> String {
    static SEQUENCE: AtomicU64 = AtomicU64::new(1);
    let epoch_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let sequence = SEQUENCE.fetch_add(1, Ordering::Relaxed);
    format!("local-{epoch_ms}-{sequence}")
}

#[cfg(windows)]
fn resolve_model_paths() -> Result<LockedSherpaRealtimePaths, String> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .map_err(|_| "MVP_WORKSPACE_ROOT_UNAVAILABLE".to_owned())?;
    let extracted = root.join("target/sherpa-native/extracted");
    let model_root = extracted.join("sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17");
    let runtime_root = extracted.join("sherpa-onnx-v1.13.4-win-x64-shared-MT-Release-lib/lib");

    Ok(LockedSherpaRealtimePaths {
        model_path: canonical_env_or(
            "MEETINGRELAY_SHERPA_MODEL",
            model_root.join("model.int8.onnx"),
        )?,
        tokens_path: canonical_env_or("MEETINGRELAY_SHERPA_TOKENS", model_root.join("tokens.txt"))?,
        runtime_lib_dir: canonical_env_or("SHERPA_ONNX_LIB_DIR", runtime_root)?,
        asset_lock_path: canonical_env_or(
            "MEETINGRELAY_SHERPA_LOCK",
            root.join("tools/sherpa-native/assets.lock.json"),
        )?,
        package_lock_path: canonical_asset(root.join("Cargo.lock"))?,
    })
}

#[cfg(windows)]
fn canonical_env_or(name: &str, fallback: PathBuf) -> Result<PathBuf, String> {
    canonical_asset(env::var_os(name).map_or(fallback, PathBuf::from))
}

#[cfg(windows)]
fn canonical_asset(path: PathBuf) -> Result<PathBuf, String> {
    path.canonicalize()
        .map_err(|_| "SHERPA_ASSET_MISSING".to_owned())
}

#[cfg(windows)]
#[derive(Clone)]
struct InferenceSubmitter {
    sender: SyncSender<InferenceCommand>,
    queue_depth: Arc<AtomicUsize>,
}

#[cfg(windows)]
impl InferenceSubmitter {
    fn submit(&self, task: InferenceTask) -> Result<(), String> {
        self.queue_depth.fetch_add(1, Ordering::AcqRel);
        let result = if task.is_final {
            self.sender
                .send(InferenceCommand::Recognize(task))
                .map_err(|_| "ASR_WORKER_STOPPED".to_owned())
        } else {
            self.sender
                .try_send(InferenceCommand::Recognize(task))
                .map_err(|error| match error {
                    TrySendError::Full(_) => "ASR_INTERIM_DROPPED".to_owned(),
                    TrySendError::Disconnected(_) => "ASR_WORKER_STOPPED".to_owned(),
                })
        };
        if result.is_err() {
            self.queue_depth.fetch_sub(1, Ordering::AcqRel);
        }
        result
    }

    fn barrier(&self, timeout: Duration) -> Result<(), String> {
        let deadline = Instant::now() + timeout;
        let (sender, receiver) = sync_channel(1);
        let mut command = InferenceCommand::Barrier(sender);
        loop {
            match self.sender.try_send(command) {
                Ok(()) => break,
                Err(TrySendError::Full(returned)) if Instant::now() < deadline => {
                    command = returned;
                    thread::sleep(Duration::from_millis(2));
                }
                Err(TrySendError::Full(_)) => return Err("ASR_STOP_TIMEOUT".to_owned()),
                Err(TrySendError::Disconnected(_)) => {
                    return Err("ASR_WORKER_STOPPED".to_owned());
                }
            }
        }
        receiver
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .map_err(|_| "ASR_STOP_TIMEOUT".to_owned())
    }
}

#[cfg(windows)]
struct InferenceWorker {
    submitter: InferenceSubmitter,
    join: Option<JoinHandle<()>>,
}

#[cfg(windows)]
impl InferenceWorker {
    fn prepare(
        snapshot: Arc<Mutex<MvpSnapshot>>,
        paths: LockedSherpaRealtimePaths,
    ) -> Result<Self, String> {
        let (sender, receiver) = sync_channel(MAX_INFERENCE_QUEUE_DEPTH);
        let (ready_sender, ready_receiver) = sync_channel(1);
        let queue_depth = Arc::new(AtomicUsize::new(0));
        let worker_queue_depth = Arc::clone(&queue_depth);
        let join = thread::Builder::new()
            .name("meetingrelay-asr".to_owned())
            .spawn(move || {
                let recognizer = LockedSherpaRealtime::prepare_local_mvp(paths)
                    .map_err(|error| error.to_string());
                let ready = recognizer.as_ref().map(|_| ()).map_err(Clone::clone);
                let _ = ready_sender.send(ready);
                if let Ok(mut recognizer) = recognizer {
                    inference_loop(&mut recognizer, receiver, snapshot, worker_queue_depth);
                }
            })
            .map_err(|_| "ASR_WORKER_START_FAILED".to_owned())?;

        ready_receiver
            .recv()
            .map_err(|_| "ASR_WORKER_START_FAILED".to_owned())??;
        Ok(Self {
            submitter: InferenceSubmitter {
                sender,
                queue_depth,
            },
            join: Some(join),
        })
    }

    fn submitter(&self) -> InferenceSubmitter {
        self.submitter.clone()
    }

    fn queue_depth(&self) -> usize {
        self.submitter
            .queue_depth
            .load(Ordering::Acquire)
            .min(MAX_INFERENCE_QUEUE_DEPTH)
    }
}

#[cfg(windows)]
impl Drop for InferenceWorker {
    fn drop(&mut self) {
        let _ = self.submitter.sender.send(InferenceCommand::Shutdown);
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
    }
}

#[cfg(windows)]
enum InferenceCommand {
    Recognize(InferenceTask),
    Barrier(SyncSender<()>),
    Shutdown,
}

#[cfg(windows)]
struct InferenceTask {
    session_id: String,
    segment_id: String,
    revision: u32,
    is_final: bool,
    started_at_ms: String,
    ended_at_ms: String,
    samples: Arc<[i16]>,
}

#[cfg(windows)]
fn inference_loop(
    recognizer: &mut LockedSherpaRealtime,
    receiver: Receiver<InferenceCommand>,
    snapshot: Arc<Mutex<MvpSnapshot>>,
    queue_depth: Arc<AtomicUsize>,
) {
    while let Ok(command) = receiver.recv() {
        match command {
            InferenceCommand::Recognize(task) => {
                queue_depth.fetch_sub(1, Ordering::AcqRel);
                let result = recognizer.transcribe_mono_16khz_pcm16(Arc::clone(&task.samples));
                let mut current = lock(&snapshot);
                if current.session_id.as_deref() != Some(task.session_id.as_str()) {
                    continue;
                }
                match result {
                    Ok(result) => {
                        let text = result.original_transcript.as_str().trim().to_owned();
                        if !is_meaningful_transcript(&text) {
                            if task.is_final {
                                current.interim = None;
                            }
                            continue;
                        }
                        let segment = TranscriptSegment {
                            segment_id: task.segment_id,
                            revision: task.revision,
                            is_final: task.is_final,
                            text,
                            started_at_ms: task.started_at_ms,
                            ended_at_ms: task.is_final.then_some(task.ended_at_ms),
                        };
                        if task.is_final {
                            current.interim = None;
                            current.finals.push(segment);
                        } else {
                            current.interim = Some(segment);
                        }
                        current.error = None;
                        current.enforce_bounds();
                    }
                    Err(error) => {
                        if task.is_final {
                            current.interim = None;
                            current.error = Some(error.to_string());
                        }
                    }
                }
            }
            InferenceCommand::Barrier(sender) => {
                let _ = sender.send(());
            }
            InferenceCommand::Shutdown => break,
        }
    }
}

#[cfg(windows)]
fn spawn_coordinator(
    output: AudioCaptureOutput,
    submitter: InferenceSubmitter,
    snapshot: Arc<Mutex<MvpSnapshot>>,
    session_id: String,
    stop: Arc<AtomicBool>,
) -> Result<JoinHandle<()>, String> {
    thread::Builder::new()
        .name("meetingrelay-audio".to_owned())
        .spawn(move || coordinator_loop(output, submitter, snapshot, session_id, stop))
        .map_err(|_| "AUDIO_COORDINATOR_START_FAILED".to_owned())
}

#[cfg(windows)]
fn join_before(coordinator: JoinHandle<()>, deadline: Instant) -> Result<(), String> {
    while !coordinator.is_finished() {
        if Instant::now() >= deadline {
            return Err("AUDIO_STOP_TIMEOUT".to_owned());
        }
        thread::sleep(Duration::from_millis(2));
    }
    coordinator
        .join()
        .map_err(|_| "AUDIO_COORDINATOR_PANIC".to_owned())
}

#[cfg(windows)]
fn coordinator_loop(
    output: AudioCaptureOutput,
    submitter: InferenceSubmitter,
    snapshot: Arc<Mutex<MvpSnapshot>>,
    session_id: String,
    stop: Arc<AtomicBool>,
) {
    let AudioCaptureOutput {
        packets,
        statuses,
        preflight,
        ..
    } = output;
    let system = SourcePipeline::new(&preflight.system_output);
    let microphone = SourcePipeline::new(&preflight.microphone);
    let (Ok(mut system), Ok(mut microphone)) = (system, microphone) else {
        lock(&snapshot).error = Some("AUDIO_DSP_CONFIGURATION".to_owned());
        return;
    };
    let mut endpoint = EnergyEndpointSegmenter::new();
    let mut identity = SegmentIdentity::default();

    while !stop.load(Ordering::Acquire) {
        drain_statuses(&statuses, &snapshot);
        let timed_out = match packets.recv_timeout(Duration::from_millis(20)) {
            Ok(packet) => {
                route_packet(packet, &mut system, &mut microphone);
                false
            }
            Err(RecvTimeoutError::Timeout) => true,
            Err(RecvTimeoutError::Disconnected) => break,
        };
        drain_mixed(
            &mut system.blocks,
            &mut microphone.blocks,
            timed_out,
            &mut endpoint,
            &mut identity,
            &submitter,
            &snapshot,
            &session_id,
        );
    }

    while let Ok(packet) = packets.try_recv() {
        route_packet(packet, &mut system, &mut microphone);
    }
    if let Some(block) = system.packetizer.flush_padded() {
        system.blocks.push_back(block);
    }
    if let Some(block) = microphone.packetizer.flush_padded() {
        microphone.blocks.push_back(block);
    }
    drain_all_mixed(
        &mut system.blocks,
        &mut microphone.blocks,
        &mut endpoint,
        &mut identity,
        &submitter,
        &snapshot,
        &session_id,
    );
    if let Some(event) = endpoint.flush_stop() {
        submit_segment(event, &mut identity, &submitter, &snapshot, &session_id);
    }
    drain_statuses(&statuses, &snapshot);
}

#[cfg(windows)]
struct SourcePipeline {
    sample_rate: u32,
    channels: usize,
    resampler: Mono16kResampler,
    packetizer: BlockPacketizer,
    blocks: VecDeque<AudioBlock>,
}

#[cfg(windows)]
impl SourcePipeline {
    fn new(device: &AudioDevicePreflight) -> Result<Self, String> {
        let channels = usize::from(device.channels);
        let resampler = Mono16kResampler::new(device.sample_rate, channels)
            .map_err(|_| "AUDIO_DSP_CONFIGURATION".to_owned())?;
        Ok(Self {
            sample_rate: device.sample_rate,
            channels,
            resampler,
            packetizer: BlockPacketizer::new(),
            blocks: VecDeque::new(),
        })
    }

    fn push(&mut self, packet: RawAudioPacket) {
        let channels = usize::from(packet.channels);
        if packet.sample_rate != self.sample_rate || channels != self.channels {
            if let Ok(replacement) = Mono16kResampler::new(packet.sample_rate, channels) {
                self.sample_rate = packet.sample_rate;
                self.channels = channels;
                self.resampler = replacement;
                self.packetizer.reset();
                self.blocks.clear();
            } else {
                return;
            }
        }
        let mut mono = Vec::with_capacity(packet.frame_count());
        self.resampler.push_interleaved(&packet.samples, &mut mono);
        if !mono.is_empty() {
            let mut blocks = Vec::new();
            self.packetizer.push(&mono, &mut blocks);
            self.blocks.extend(blocks);
        }
    }
}

#[cfg(windows)]
fn route_packet(
    packet: RawAudioPacket,
    system: &mut SourcePipeline,
    microphone: &mut SourcePipeline,
) {
    match packet.source {
        AudioSourceId::SystemOutput => system.push(packet),
        AudioSourceId::Microphone => microphone.push(packet),
    }
}

#[cfg(windows)]
#[allow(clippy::too_many_arguments)]
fn drain_mixed(
    system: &mut VecDeque<AudioBlock>,
    microphone: &mut VecDeque<AudioBlock>,
    timed_out: bool,
    endpoint: &mut EnergyEndpointSegmenter,
    identity: &mut SegmentIdentity,
    submitter: &InferenceSubmitter,
    snapshot: &Arc<Mutex<MvpSnapshot>>,
    session_id: &str,
) {
    const ALIGNMENT_BLOCKS: usize = 4;
    while !system.is_empty() && !microphone.is_empty() {
        process_pair(
            system.pop_front(),
            microphone.pop_front(),
            endpoint,
            identity,
            submitter,
            snapshot,
            session_id,
        );
    }
    while system.len() > ALIGNMENT_BLOCKS {
        process_pair(
            system.pop_front(),
            None,
            endpoint,
            identity,
            submitter,
            snapshot,
            session_id,
        );
    }
    while microphone.len() > ALIGNMENT_BLOCKS {
        process_pair(
            None,
            microphone.pop_front(),
            endpoint,
            identity,
            submitter,
            snapshot,
            session_id,
        );
    }
    if timed_out {
        if microphone.is_empty() {
            process_pair(
                system.pop_front(),
                None,
                endpoint,
                identity,
                submitter,
                snapshot,
                session_id,
            );
        } else if system.is_empty() {
            process_pair(
                None,
                microphone.pop_front(),
                endpoint,
                identity,
                submitter,
                snapshot,
                session_id,
            );
        }
    }
}

#[cfg(windows)]
#[allow(clippy::too_many_arguments)]
fn drain_all_mixed(
    system: &mut VecDeque<AudioBlock>,
    microphone: &mut VecDeque<AudioBlock>,
    endpoint: &mut EnergyEndpointSegmenter,
    identity: &mut SegmentIdentity,
    submitter: &InferenceSubmitter,
    snapshot: &Arc<Mutex<MvpSnapshot>>,
    session_id: &str,
) {
    while !system.is_empty() || !microphone.is_empty() {
        process_pair(
            system.pop_front(),
            microphone.pop_front(),
            endpoint,
            identity,
            submitter,
            snapshot,
            session_id,
        );
    }
}

#[cfg(windows)]
#[allow(clippy::too_many_arguments)]
fn process_pair(
    system: Option<AudioBlock>,
    microphone: Option<AudioBlock>,
    endpoint: &mut EnergyEndpointSegmenter,
    identity: &mut SegmentIdentity,
    submitter: &InferenceSubmitter,
    snapshot: &Arc<Mutex<MvpSnapshot>>,
    session_id: &str,
) {
    if system.is_none() && microphone.is_none() {
        return;
    }
    let mixed = mix_blocks(system.as_ref(), microphone.as_ref());
    if let Some(event) = endpoint.push_block(&mixed.samples) {
        submit_segment(event, identity, submitter, snapshot, session_id);
    }
}

#[cfg(windows)]
#[derive(Default)]
struct SegmentIdentity {
    next: u64,
    active: Option<(u64, u32)>,
}

#[cfg(windows)]
impl SegmentIdentity {
    fn metadata(&mut self, is_final: bool) -> (String, u32) {
        let (id, revision) = self.active.unwrap_or_else(|| {
            self.next = self.next.saturating_add(1);
            (self.next, 0)
        });
        let revision = revision.saturating_add(1);
        if is_final {
            self.active = None;
        } else {
            self.active = Some((id, revision));
        }
        (format!("segment-{id}"), revision)
    }
}

#[cfg(windows)]
fn submit_segment(
    event: SegmentEvent,
    identity: &mut SegmentIdentity,
    submitter: &InferenceSubmitter,
    snapshot: &Arc<Mutex<MvpSnapshot>>,
    session_id: &str,
) {
    let (segment, is_final) = match event {
        SegmentEvent::Interim(segment) => (segment, false),
        SegmentEvent::Final { segment, .. } => (segment, true),
    };
    let (segment_id, revision) = identity.metadata(is_final);
    let task = inference_task(session_id, segment_id, revision, is_final, segment);
    if let Err(error) = submitter.submit(task)
        && (is_final || error != "ASR_INTERIM_DROPPED")
    {
        lock(snapshot).error = Some(error);
    }
}

#[cfg(windows)]
fn inference_task(
    session_id: &str,
    segment_id: String,
    revision: u32,
    is_final: bool,
    segment: AudioSegment,
) -> InferenceTask {
    let started_at_ms = samples_to_ms(segment.started_at_sample).to_string();
    let ended_at_ms = samples_to_ms(segment.ended_at_sample).to_string();
    let samples = segment
        .samples
        .into_iter()
        .map(f32_to_pcm16)
        .collect::<Vec<_>>()
        .into();
    InferenceTask {
        session_id: session_id.to_owned(),
        segment_id,
        revision,
        is_final,
        started_at_ms,
        ended_at_ms,
        samples,
    }
}

#[cfg(windows)]
fn samples_to_ms(samples: u64) -> u64 {
    samples.saturating_mul(1_000) / u64::from(TARGET_SAMPLE_RATE_HZ)
}

#[cfg(windows)]
fn f32_to_pcm16(sample: f32) -> i16 {
    let sample = if sample.is_finite() { sample } else { 0.0 };
    (sample.clamp(-1.0, 1.0) * f32::from(i16::MAX)).round() as i16
}

fn is_meaningful_transcript(text: &str) -> bool {
    text.chars().any(char::is_alphanumeric)
}

#[cfg(windows)]
fn drain_statuses(statuses: &Receiver<AudioCaptureStatus>, snapshot: &Arc<Mutex<MvpSnapshot>>) {
    loop {
        match statuses.try_recv() {
            Ok(AudioCaptureStatus {
                source,
                kind: AudioCaptureStatusKind::StreamError { .. },
            }) => {
                let mut current = lock(snapshot);
                let source_snapshot = match source {
                    AudioSourceId::SystemOutput => &mut current.system,
                    AudioSourceId::Microphone => &mut current.microphone,
                };
                source_snapshot.status = SourceStatus::Error;
                source_snapshot.error = Some("AUDIO_STREAM_ERROR".to_owned());
                current.error = Some("AUDIO_STREAM_ERROR".to_owned());
            }
            Ok(_) => {}
            Err(TryRecvError::Empty | TryRecvError::Disconnected) => break,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_service_is_private_memory_only_and_booting() {
        let snapshot = MvpService::default().snapshot();
        assert_eq!(snapshot.lifecycle, Lifecycle::Booting);
        assert!(snapshot.local_only);
        assert!(snapshot.memory_only);
        assert_eq!(snapshot.system.frames, "0");
        assert_eq!(snapshot.microphone.frames, "0");
    }

    #[test]
    fn consent_rejection_cannot_start_capture_or_increment_frames() {
        let service = MvpService::default();
        assert_eq!(service.start(false), Err("CONSENT_REQUIRED".to_owned()));
        let snapshot = service.snapshot();
        assert_eq!(snapshot.system.frames, "0");
        assert_eq!(snapshot.microphone.frames, "0");
    }

    #[test]
    fn low_information_noise_transcripts_are_suppressed() {
        assert!(!is_meaningful_transcript("。"));
        assert!(is_meaningful_transcript("嗯。"));
        assert!(is_meaningful_transcript("I."));
        assert!(is_meaningful_transcript("可以。"));
        assert!(is_meaningful_transcript("OK"));
    }

    #[cfg(windows)]
    #[test]
    fn pcm_conversion_is_bounded_and_sanitizes_non_finite_values() {
        assert_eq!(f32_to_pcm16(1.5), i16::MAX);
        assert_eq!(f32_to_pcm16(-1.5), -i16::MAX);
        assert_eq!(f32_to_pcm16(f32::NAN), 0);
    }
}
