use std::sync::{
    Arc, Mutex, MutexGuard,
    atomic::{AtomicBool, Ordering},
};

use super::contract::{AudioSourceSnapshot, Lifecycle, MvpSnapshot, SourceId, SourceStatus};

pub(crate) const MVP_SHUTDOWN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(12);

#[cfg(windows)]
use std::{
    collections::VecDeque,
    env,
    path::{Path, PathBuf},
    sync::{
        TryLockError,
        atomic::{AtomicU8, AtomicU64, AtomicUsize},
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
        AudioDevicePreflight, AudioSourceId, AudioSourceStats, RawAudioPacket,
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
    shutdown_started: AtomicBool,
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
            shutdown_started: AtomicBool::new(false),
        }
    }
}

impl MvpService {
    pub fn snapshot(&self) -> MvpSnapshot {
        let inner = lock(&self.inner);
        #[cfg(windows)]
        {
            self.snapshot_locked(&inner)
        }
        #[cfg(not(windows))]
        {
            let mut snapshot = lock(&self.snapshot).clone();
            snapshot.enforce_bounds();
            snapshot
        }
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

    pub fn shutdown_before(&self, deadline: std::time::Instant) -> Result<(), String> {
        if self.shutdown_started.swap(true, Ordering::AcqRel) {
            return Ok(());
        }

        #[cfg(windows)]
        {
            self.shutdown_windows(deadline)
        }
        #[cfg(not(windows))]
        {
            let _ = deadline;
            Ok(())
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
        Ok(public_snapshot(
            &mut snapshot,
            inner.inference.as_ref().map(|worker| &worker.submitter),
        ))
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
        let errors = Arc::new(RuntimeErrors::default());
        let metrics = output.metrics.clone();
        let preflight = output.preflight.clone();
        let coordinator = match spawn_coordinator(
            output,
            submitter,
            session_id.clone(),
            Arc::clone(&stop),
            Arc::clone(&errors),
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
            errors,
            started: Instant::now(),
        });

        let mut snapshot = lock(&self.snapshot);
        snapshot.lifecycle = Lifecycle::Recording;
        snapshot.session_id = Some(session_id);
        snapshot.system = capturing_source(SourceId::System, &preflight.system_output);
        snapshot.microphone = capturing_source(SourceId::Microphone, &preflight.microphone);
        snapshot.error = None;
        Ok(public_snapshot(
            &mut snapshot,
            inner.inference.as_ref().map(|worker| &worker.submitter),
        ))
    }

    #[cfg(windows)]
    fn stop_windows(&self) -> Result<MvpSnapshot, String> {
        self.stop_windows_before(Instant::now() + MVP_SHUTDOWN_TIMEOUT)
    }

    #[cfg(windows)]
    fn stop_windows_before(&self, deadline: Instant) -> Result<MvpSnapshot, String> {
        let (mut session, submitter) = {
            let mut inner = lock_before(&self.inner, deadline)?;
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

        if let Some(coordinator) = session.coordinator.take() {
            join_before(coordinator, deadline).inspect_err(|error| self.fail(error))?;
        }

        if let Some(submitter) = submitter.as_ref() {
            submitter
                .barrier_before(deadline)
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
        if snapshot.error.as_deref() != Some("ASR_FINAL_OVERLOAD") {
            snapshot.error = None;
        }
        if let Some(error) = take_runtime_error(&session.errors) {
            set_public_error(&mut snapshot, error);
        }
        Ok(public_snapshot(&mut snapshot, submitter.as_ref()))
    }

    #[cfg(windows)]
    fn shutdown_windows(&self, deadline: Instant) -> Result<(), String> {
        let stop_error = self.stop_windows_before(deadline).err();
        let inference_error = match lock_before(&self.inner, deadline) {
            Ok(mut inner) => inner
                .inference
                .take()
                .and_then(|worker| worker.shutdown_before(deadline).err()),
            Err(error) => Some(error),
        };

        stop_error.or(inference_error).map_or(Ok(()), Err)
    }

    #[cfg(windows)]
    fn snapshot_locked(&self, inner: &ServiceInner) -> MvpSnapshot {
        if let Some(session) = inner.session.as_ref() {
            self.refresh_from_session(session, false);
        }
        let mut snapshot = lock(&self.snapshot);
        let submitter = inner.inference.as_ref().map(|inference| {
            snapshot.queue_depth = inference.queue_depth();
            &inference.submitter
        });
        public_snapshot(&mut snapshot, submitter)
    }

    #[cfg(windows)]
    fn refresh_from_session(&self, session: &RunningSession, stopping: bool) {
        let system = session.metrics.snapshot(AudioSourceId::SystemOutput);
        let microphone = session.metrics.snapshot(AudioSourceId::Microphone);
        let stream_error = system.stream_errors > 0 || microphone.stream_errors > 0;
        let mut snapshot = lock(&self.snapshot);
        snapshot.elapsed_ms = session.started.elapsed().as_millis().to_string();
        apply_source_stats(&mut snapshot.system, system, !stopping);
        apply_source_stats(&mut snapshot.microphone, microphone, !stopping);
        if stream_error {
            set_public_error(&mut snapshot, "AUDIO_STREAM_ERROR");
        }
        if let Some(error) = take_runtime_error(&session.errors) {
            set_public_error(&mut snapshot, error);
        }
    }
}

#[cfg(windows)]
fn public_snapshot(
    snapshot: &mut MvpSnapshot,
    submitter: Option<&InferenceSubmitter>,
) -> MvpSnapshot {
    if let Some(submitter) = submitter {
        submitter.shared.scrub_stale_interim(snapshot);
    }
    snapshot.enforce_bounds();
    snapshot.clone()
}

#[cfg(windows)]
fn set_public_error(snapshot: &mut MvpSnapshot, error: &str) {
    let priority = |code| match code {
        "ASR_FINAL_OVERLOAD" => 3,
        "ASR_WORKER_STOPPED" => 2,
        _ => 1,
    };
    if snapshot
        .error
        .as_deref()
        .is_none_or(|current| priority(error) >= priority(current))
    {
        snapshot.error = Some(error.to_owned());
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

#[cfg(windows)]
fn lock_before<'a, T>(mutex: &'a Mutex<T>, deadline: Instant) -> Result<MutexGuard<'a, T>, String> {
    loop {
        match mutex.try_lock() {
            Ok(guard) => return Ok(guard),
            Err(TryLockError::Poisoned(poisoned)) => return Ok(poisoned.into_inner()),
            Err(TryLockError::WouldBlock) if Instant::now() < deadline => {
                thread::sleep(Duration::from_millis(2));
            }
            Err(TryLockError::WouldBlock) => return Err("MVP_SHUTDOWN_TIMEOUT".to_owned()),
        }
    }
}

#[cfg(windows)]
type RuntimeErrors = AtomicU8;

#[cfg(windows)]
fn record_runtime_error(errors: &RuntimeErrors, priority: u8) {
    errors.fetch_max(priority, Ordering::AcqRel);
}

#[cfg(windows)]
fn take_runtime_error(errors: &RuntimeErrors) -> Option<&'static str> {
    match errors.swap(0, Ordering::AcqRel) {
        1 => Some("AUDIO_DSP_CONFIGURATION"),
        2 => Some("ASR_WORKER_STOPPED"),
        3 => Some("ASR_FINAL_OVERLOAD"),
        _ => None,
    }
}

#[cfg(windows)]
struct RunningSession {
    capture: AudioCapture,
    coordinator: Option<JoinHandle<()>>,
    stop: Arc<AtomicBool>,
    metrics: AudioCaptureMetrics,
    errors: Arc<RuntimeErrors>,
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
    finals: SyncSender<InferenceTask>,
    shared: Arc<InferenceShared>,
    worker_thread: thread::Thread,
}

#[cfg(windows)]
impl InferenceSubmitter {
    fn submit(&self, task: InferenceTask) -> Result<(), String> {
        if self.shared.shutdown.load(Ordering::Acquire) {
            return Err("ASR_WORKER_STOPPED".to_owned());
        }
        if task.is_final {
            self.submit_final(task)
        } else {
            self.submit_interim(task)
        }
    }

    fn barrier_before(&self, deadline: Instant) -> Result<(), String> {
        while self.shared.pending.load(Ordering::Acquire) != 0 {
            if Instant::now() >= deadline {
                return Err("ASR_STOP_TIMEOUT".to_owned());
            }
            thread::sleep(Duration::from_millis(2));
        }
        Ok(())
    }

    fn queue_depth(&self) -> usize {
        self.shared
            .pending
            .load(Ordering::Acquire)
            .min(MAX_INFERENCE_QUEUE_DEPTH)
    }

    fn request_shutdown(&self) {
        self.shared.shutdown.store(true, Ordering::Release);
        self.worker_thread.unpark();
    }

    fn submit_final(&self, task: InferenceTask) -> Result<(), String> {
        self.shared.pending.fetch_add(1, Ordering::AcqRel);
        match self.finals.try_send(task) {
            Ok(()) => {
                self.shared.latest_interim.fetch_add(1, Ordering::AcqRel);
                let retired = match self.shared.interim.try_lock() {
                    Ok(mut interim) => interim.take().is_some(),
                    Err(TryLockError::Poisoned(poisoned)) => poisoned.into_inner().take().is_some(),
                    Err(TryLockError::WouldBlock) => false,
                };
                if retired {
                    self.shared.pending.fetch_sub(1, Ordering::AcqRel);
                }
                self.worker_thread.unpark();
                Ok(())
            }
            Err(error) => {
                self.shared.pending.fetch_sub(1, Ordering::AcqRel);
                match error {
                    TrySendError::Full(_) => Err("ASR_FINAL_OVERLOAD".to_owned()),
                    TrySendError::Disconnected(_) => Err("ASR_WORKER_STOPPED".to_owned()),
                }
            }
        }
    }

    fn submit_interim(&self, task: InferenceTask) -> Result<(), String> {
        let generation = self.shared.latest_interim.fetch_add(1, Ordering::AcqRel) + 1;
        let mut interim = match self.shared.interim.try_lock() {
            Ok(interim) => interim,
            Err(TryLockError::Poisoned(poisoned)) => poisoned.into_inner(),
            Err(TryLockError::WouldBlock) => return Err("ASR_INTERIM_DROPPED".to_owned()),
        };
        if interim.is_none() {
            self.shared.pending.fetch_add(1, Ordering::AcqRel);
        }
        *interim = Some((generation, task));
        drop(interim);
        self.worker_thread.unpark();
        Ok(())
    }
}

#[cfg(windows)]
#[derive(Default)]
struct InferenceShared {
    interim: Mutex<Option<(u64, InferenceTask)>>,
    pending: AtomicUsize,
    latest_interim: AtomicU64,
    published_interim: AtomicU64,
    shutdown: AtomicBool,
}

#[cfg(windows)]
impl InferenceShared {
    fn take_interim(&self) -> Option<(u64, InferenceTask)> {
        lock(&self.interim).take()
    }

    fn interim_is_current(&self, generation: u64) -> bool {
        self.latest_interim.load(Ordering::Acquire) == generation
    }

    fn finish_task(&self) {
        self.pending.fetch_sub(1, Ordering::AcqRel);
    }

    fn scrub_stale_interim(&self, snapshot: &mut MvpSnapshot) {
        let published = self.published_interim.load(Ordering::Acquire);
        if published != 0 && published != self.latest_interim.load(Ordering::Acquire) {
            snapshot.interim = None;
            self.published_interim.store(0, Ordering::Release);
        }
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
        let (ready_sender, ready_receiver) = sync_channel(1);
        let (finals, final_receiver) = sync_channel(MAX_INFERENCE_QUEUE_DEPTH);
        let shared = Arc::new(InferenceShared::default());
        let worker_shared = Arc::clone(&shared);
        let join = thread::Builder::new()
            .name("meetingrelay-asr".to_owned())
            .spawn(move || {
                let recognizer = LockedSherpaRealtime::prepare_local_mvp(paths)
                    .map_err(|error| error.to_string());
                let ready = recognizer.as_ref().map(|_| ()).map_err(Clone::clone);
                let _ = ready_sender.send(ready);
                if let Ok(mut recognizer) = recognizer {
                    inference_loop(&mut recognizer, final_receiver, worker_shared, snapshot);
                }
            })
            .map_err(|_| "ASR_WORKER_START_FAILED".to_owned())?;
        let worker_thread = join.thread().clone();

        ready_receiver
            .recv()
            .map_err(|_| "ASR_WORKER_START_FAILED".to_owned())??;
        Ok(Self {
            submitter: InferenceSubmitter {
                finals,
                shared,
                worker_thread,
            },
            join: Some(join),
        })
    }

    fn submitter(&self) -> InferenceSubmitter {
        self.submitter.clone()
    }

    fn queue_depth(&self) -> usize {
        self.submitter.queue_depth()
    }

    fn shutdown_before(mut self, deadline: Instant) -> Result<(), String> {
        self.submitter.request_shutdown();
        let Some(join) = self.join.take() else {
            return Ok(());
        };
        join_before(join, deadline)
    }
}

#[cfg(windows)]
impl Drop for InferenceWorker {
    fn drop(&mut self) {
        self.submitter.request_shutdown();
        // A JoinHandle detaches on drop. Application close uses
        // `shutdown_before` for a bounded join; Drop itself must never block.
        let _ = self.join.take();
    }
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
    finals: Receiver<InferenceTask>,
    shared: Arc<InferenceShared>,
    snapshot: Arc<Mutex<MvpSnapshot>>,
) {
    loop {
        let scheduled = match finals.try_recv() {
            Ok(final_task) => Some((None, final_task)),
            Err(TryRecvError::Empty | TryRecvError::Disconnected) => shared
                .take_interim()
                .map(|(generation, task)| (Some(generation), task)),
        };
        if let Some((interim_generation, task)) = scheduled {
            process_inference_task(recognizer, &shared, &snapshot, interim_generation, task);
            shared.finish_task();
            continue;
        }
        if shared.shutdown.load(Ordering::Acquire) && shared.pending.load(Ordering::Acquire) == 0 {
            break;
        }
        thread::park_timeout(Duration::from_millis(20));
    }
}

#[cfg(windows)]
fn process_inference_task(
    recognizer: &mut LockedSherpaRealtime,
    shared: &InferenceShared,
    snapshot: &Mutex<MvpSnapshot>,
    interim_generation: Option<u64>,
    task: InferenceTask,
) {
    if interim_generation.is_some_and(|generation| !shared.interim_is_current(generation))
        || lock(snapshot).session_id.as_deref() != Some(task.session_id.as_str())
    {
        return;
    }

    let result = recognizer.transcribe_mono_16khz_pcm16(Arc::clone(&task.samples));
    let session_id = task.session_id.clone();
    let _ = publish_if_current(
        shared,
        snapshot,
        interim_generation,
        &session_id,
        move |current| {
            if task.is_final {
                current.interim = None;
                shared.published_interim.store(0, Ordering::Release);
            }
            match result {
                Ok(result) => {
                    let text = result.original_transcript.as_str().trim().to_owned();
                    if !is_meaningful_transcript(&text) {
                        return;
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
                        current.finals.push(segment);
                    } else {
                        current.interim = Some(segment);
                        shared.published_interim.store(
                            interim_generation.expect("interim tasks carry a generation"),
                            Ordering::Release,
                        );
                    }
                    if current.error.as_deref() != Some("ASR_FINAL_OVERLOAD") {
                        current.error = None;
                    }
                    current.enforce_bounds();
                }
                Err(error) if task.is_final => set_public_error(current, &error.to_string()),
                Err(_) => {}
            }
        },
    );
}

#[cfg(windows)]
fn publish_if_current(
    shared: &InferenceShared,
    snapshot: &Mutex<MvpSnapshot>,
    interim_generation: Option<u64>,
    session_id: &str,
    publish: impl FnOnce(&mut MvpSnapshot),
) -> bool {
    let mut current = lock(snapshot);
    let _interim_gate = if let Some(generation) = interim_generation {
        let gate = lock(&shared.interim);
        if !shared.interim_is_current(generation) {
            return false;
        }
        Some(gate)
    } else {
        None
    };
    if current.session_id.as_deref() != Some(session_id) {
        return false;
    }
    publish(&mut current);
    if interim_generation.is_some_and(|generation| !shared.interim_is_current(generation)) {
        current.interim = None;
        shared.published_interim.store(0, Ordering::Release);
        return false;
    }
    true
}

#[cfg(windows)]
fn spawn_coordinator(
    output: AudioCaptureOutput,
    submitter: InferenceSubmitter,
    session_id: String,
    stop: Arc<AtomicBool>,
    errors: Arc<RuntimeErrors>,
) -> Result<JoinHandle<()>, String> {
    thread::Builder::new()
        .name("meetingrelay-audio".to_owned())
        .spawn(move || coordinator_loop(output, submitter, session_id, stop, errors))
        .map_err(|_| "AUDIO_COORDINATOR_START_FAILED".to_owned())
}

#[cfg(windows)]
fn join_before(handle: JoinHandle<()>, deadline: Instant) -> Result<(), String> {
    while !handle.is_finished() {
        if Instant::now() >= deadline {
            return Err("MVP_SHUTDOWN_TIMEOUT".to_owned());
        }
        thread::sleep(Duration::from_millis(2));
    }
    handle.join().map_err(|_| "MVP_WORKER_PANIC".to_owned())
}

#[cfg(windows)]
fn coordinator_loop(
    output: AudioCaptureOutput,
    submitter: InferenceSubmitter,
    session_id: String,
    stop: Arc<AtomicBool>,
    errors: Arc<RuntimeErrors>,
) {
    let AudioCaptureOutput {
        packets,
        statuses: _statuses,
        preflight,
        ..
    } = output;
    let system = SourcePipeline::new(&preflight.system_output);
    let microphone = SourcePipeline::new(&preflight.microphone);
    let (Ok(mut system), Ok(mut microphone)) = (system, microphone) else {
        record_runtime_error(&errors, 1);
        return;
    };
    let mut endpoint = EnergyEndpointSegmenter::new();
    let mut identity = SegmentIdentity::default();

    while !stop.load(Ordering::Acquire) {
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
            &errors,
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
        &errors,
        &session_id,
    );
    if let Some(event) = endpoint.flush_stop() {
        submit_segment(event, &mut identity, &submitter, &errors, &session_id);
    }
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
    errors: &RuntimeErrors,
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
            errors,
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
            errors,
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
            errors,
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
                errors,
                session_id,
            );
        } else if system.is_empty() {
            process_pair(
                None,
                microphone.pop_front(),
                endpoint,
                identity,
                submitter,
                errors,
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
    errors: &RuntimeErrors,
    session_id: &str,
) {
    while !system.is_empty() || !microphone.is_empty() {
        process_pair(
            system.pop_front(),
            microphone.pop_front(),
            endpoint,
            identity,
            submitter,
            errors,
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
    errors: &RuntimeErrors,
    session_id: &str,
) {
    if system.is_none() && microphone.is_none() {
        return;
    }
    let mixed = mix_blocks(system.as_ref(), microphone.as_ref());
    if let Some(event) = endpoint.push_block(&mixed.samples) {
        submit_segment(event, identity, submitter, errors, session_id);
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
    errors: &RuntimeErrors,
    session_id: &str,
) {
    let (segment, is_final) = match event {
        SegmentEvent::Interim(segment) => (segment, false),
        SegmentEvent::Final { segment, .. } => (segment, true),
    };
    let (segment_id, revision) = identity.metadata(is_final);
    let task = inference_task(session_id, segment_id, revision, is_final, segment);
    if let Err(error) = submitter.submit(task) {
        match error.as_str() {
            "ASR_FINAL_OVERLOAD" => record_runtime_error(errors, 3),
            "ASR_INTERIM_DROPPED" => {}
            _ => record_runtime_error(errors, 2),
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    fn queued_task(revision: u32, is_final: bool) -> InferenceTask {
        InferenceTask {
            session_id: "session-test".to_owned(),
            segment_id: "segment-test".to_owned(),
            revision,
            is_final,
            started_at_ms: "0".to_owned(),
            ended_at_ms: "20".to_owned(),
            samples: vec![0_i16].into(),
        }
    }

    #[cfg(windows)]
    fn test_submitter() -> (InferenceSubmitter, Receiver<InferenceTask>) {
        let (finals, receiver) = sync_channel(MAX_INFERENCE_QUEUE_DEPTH);
        (
            InferenceSubmitter {
                finals,
                shared: Arc::new(InferenceShared::default()),
                worker_thread: thread::current(),
            },
            receiver,
        )
    }

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
    fn service_shutdown_is_idempotent_and_deadline_bounded() {
        let service = MvpService::default();
        let deadline = Instant::now() + MVP_SHUTDOWN_TIMEOUT;
        assert_eq!(service.shutdown_before(deadline), Ok(()));
        assert_eq!(service.shutdown_before(deadline), Ok(()));

        #[cfg(windows)]
        {
            let _inner = lock(&service.inner);
            let started = Instant::now();
            assert_eq!(
                lock_before(&service.inner, started).err().as_deref(),
                Some("MVP_SHUTDOWN_TIMEOUT")
            );
            assert!(started.elapsed() < Duration::from_millis(50));
        }
    }

    #[cfg(windows)]
    #[test]
    fn inference_submission_is_latest_wins_and_final_priority() {
        let (submitter, finals) = test_submitter();
        submitter.submit(queued_task(1, false)).unwrap();
        submitter.submit(queued_task(2, false)).unwrap();
        let (generation, interim_task) = submitter.shared.take_interim().unwrap();
        assert!(!interim_task.is_final);
        assert_eq!(interim_task.revision, 2);
        assert!(submitter.shared.interim_is_current(generation));
        submitter.submit(queued_task(3, false)).unwrap();
        assert!(!submitter.shared.interim_is_current(generation));
        submitter.shared.finish_task();

        submitter.submit(queued_task(4, true)).unwrap();
        assert!(submitter.shared.take_interim().is_none());
        let final_task = finals.try_recv().unwrap();
        assert!(final_task.is_final);
        assert_eq!(final_task.revision, 4);
        submitter.shared.finish_task();
        assert_eq!(submitter.barrier_before(Instant::now()), Ok(()));
    }

    #[cfg(windows)]
    #[test]
    fn newer_generation_while_publication_waits_cannot_commit() {
        let (submitter, _finals) = test_submitter();
        submitter.submit(queued_task(1, false)).unwrap();
        let (generation, _task) = submitter.shared.take_interim().unwrap();
        let snapshot = Arc::new(Mutex::new(MvpSnapshot::booting()));
        let mut snapshot_guard = lock(&snapshot);
        snapshot_guard.session_id = Some("session-test".to_owned());
        let latch = Arc::new(std::sync::Barrier::new(2));
        let worker_latch = Arc::clone(&latch);
        let worker_shared = Arc::clone(&submitter.shared);
        let worker_snapshot = Arc::clone(&snapshot);
        let worker = thread::spawn(move || {
            worker_latch.wait();
            publish_if_current(
                &worker_shared,
                &worker_snapshot,
                Some(generation),
                "session-test",
                |current| current.error = Some("STALE_PUBLICATION".to_owned()),
            )
        });

        latch.wait();
        submitter.submit(queued_task(2, false)).unwrap();
        drop(snapshot_guard);
        assert!(!worker.join().unwrap());
        assert_ne!(lock(&snapshot).error.as_deref(), Some("STALE_PUBLICATION"));
        submitter.shared.finish_task();
        let _ = submitter.shared.take_interim();
        submitter.shared.finish_task();
    }

    #[cfg(windows)]
    #[test]
    fn every_public_snapshot_boundary_scrubs_a_stale_interim() {
        let (submitter, _finals) = test_submitter();
        submitter
            .shared
            .published_interim
            .store(1, Ordering::Release);
        submitter.shared.latest_interim.store(2, Ordering::Release);
        let mut snapshot = MvpSnapshot::booting();
        snapshot.interim = Some(TranscriptSegment {
            segment_id: "segment-stale".to_owned(),
            revision: 1,
            is_final: false,
            text: "stale".to_owned(),
            started_at_ms: "0".to_owned(),
            ended_at_ms: None,
        });

        let returned = public_snapshot(&mut snapshot, Some(&submitter));
        assert!(returned.interim.is_none());
        assert!(snapshot.interim.is_none());
    }

    #[cfg(windows)]
    #[test]
    fn final_queue_only_rejects_capacity_and_ignores_interim_contention() {
        let (submitter, _finals) = test_submitter();
        for _ in 0..MAX_INFERENCE_QUEUE_DEPTH {
            submitter.submit(queued_task(1, true)).unwrap();
        }
        assert_eq!(
            submitter.submit(queued_task(1, true)),
            Err("ASR_FINAL_OVERLOAD".to_owned())
        );

        let (contended, finals) = test_submitter();
        let _interim = lock(&contended.shared.interim);
        let started = Instant::now();
        contended.submit(queued_task(1, true)).unwrap();
        assert!(started.elapsed() < Duration::from_millis(50));
        assert!(finals.try_recv().unwrap().is_final);
        contended.shared.finish_task();

        let errors = RuntimeErrors::default();
        record_runtime_error(&errors, 2);
        record_runtime_error(&errors, 3);
        let mut snapshot = MvpSnapshot::booting();
        set_public_error(&mut snapshot, take_runtime_error(&errors).unwrap());
        set_public_error(&mut snapshot, "AUDIO_STREAM_ERROR");
        assert_eq!(snapshot.error.as_deref(), Some("ASR_FINAL_OVERLOAD"));
    }

    #[cfg(windows)]
    #[test]
    fn inference_worker_drop_requests_shutdown_without_joining() {
        let shared = Arc::new(InferenceShared::default());
        let worker_shared = Arc::clone(&shared);
        let (done_sender, done_receiver) = sync_channel(1);
        let join = thread::spawn(move || {
            while !worker_shared.shutdown.load(Ordering::Acquire) {
                thread::park();
            }
            thread::sleep(Duration::from_millis(150));
            let _ = done_sender.send(());
        });
        let worker_thread = join.thread().clone();
        let (finals, _receiver) = sync_channel(MAX_INFERENCE_QUEUE_DEPTH);
        let worker = InferenceWorker {
            submitter: InferenceSubmitter {
                finals,
                shared,
                worker_thread,
            },
            join: Some(join),
        };

        let started = Instant::now();
        drop(worker);
        assert!(started.elapsed() < Duration::from_millis(50));
        done_receiver
            .recv_timeout(Duration::from_secs(1))
            .expect("detached worker should observe shutdown");
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
