use std::sync::{
    Arc, Mutex, MutexGuard,
    atomic::{AtomicBool, Ordering},
};

use super::{
    audio::{AudioDeviceInventory, AudioDeviceSelection},
    contract::{AudioSourceSnapshot, Lifecycle, MvpSnapshot, SourceId, SourceStatus},
    export::{ExportResult, export_meeting, transcript_text},
    storage::{
        DurableFinal, FinalCandidate, MvpStorage, MvpStorageWriter, segment_from_durable,
        visible_window_start_sequence,
    },
};

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
    time::{Duration, Instant},
};

#[cfg(windows)]
use meetingrelay_model_worker_sherpa_native::{
    LOCKED_REALTIME_MAX_PCM16_BYTES, LockedSherpaLanguage, LockedSherpaRealtime,
    LockedSherpaRealtimeError, LockedSherpaRealtimePaths,
};

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
    storage: Option<MvpStorage>,
    storage_writer: Option<Arc<MvpStorageWriter>>,
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

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
enum RecognitionLanguage {
    English,
    Japanese,
    #[default]
    Chinese,
}

impl RecognitionLanguage {
    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "en" => Ok(Self::English),
            "ja" => Ok(Self::Japanese),
            "zh" => Ok(Self::Chinese),
            _ => Err("ASR_LANGUAGE_UNSUPPORTED".to_owned()),
        }
    }

    const fn code(self) -> &'static str {
        match self {
            Self::English => "en",
            Self::Japanese => "ja",
            Self::Chinese => "zh",
        }
    }

    fn model_label(self) -> String {
        format!("SenseVoice · {} · CPU · local", self.code())
    }

    #[cfg(windows)]
    const fn sherpa(self) -> LockedSherpaLanguage {
        match self {
            Self::English => LockedSherpaLanguage::English,
            Self::Japanese => LockedSherpaLanguage::Japanese,
            Self::Chinese => LockedSherpaLanguage::Chinese,
        }
    }
}

#[cfg(windows)]
fn history_open_blocked(inner: &ServiceInner, snapshot: &Mutex<MvpSnapshot>) -> bool {
    inner.session.is_some()
        || matches!(
            lock(snapshot).lifecycle,
            Lifecycle::Starting | Lifecycle::Recording | Lifecycle::Paused | Lifecycle::Stopping
        )
}

impl Default for MvpService {
    fn default() -> Self {
        Self::new_with_storage_result(MvpStorage::open_default())
    }
}

impl MvpService {
    fn new_with_storage_result(storage_result: Result<MvpStorage, String>) -> Self {
        let (storage, storage_writer, storage_error) = match storage_result {
            Ok(storage) => match MvpStorageWriter::start(storage.clone()) {
                Ok(writer) => (Some(storage), Some(Arc::new(writer)), None),
                Err(error) => (Some(storage), None, Some(error)),
            },
            Err(error) => (None, None, Some(error)),
        };
        let mut snapshot = MvpSnapshot::booting();
        if storage_error.is_none() {
            snapshot.durability_status = "ready".to_owned();
        } else {
            snapshot.durability_status = "error".to_owned();
            snapshot.error = storage_error.clone();
        }
        Self {
            snapshot: Arc::new(Mutex::new(snapshot)),
            storage,
            storage_writer,
            inner: Mutex::new(ServiceInner::default()),
            shutdown_started: AtomicBool::new(false),
        }
    }
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

    pub fn audio_devices(&self) -> Result<AudioDeviceInventory, String> {
        #[cfg(windows)]
        {
            AudioCapture::device_inventory().map_err(|error| public_audio_error(&error.to_string()))
        }
        #[cfg(not(windows))]
        {
            Err("MVP_WINDOWS_ONLY".to_owned())
        }
    }

    #[cfg(test)]
    pub fn start(&self, consent_accepted: bool) -> Result<MvpSnapshot, String> {
        self.start_with_devices_and_language(
            consent_accepted,
            AudioDeviceSelection::default(),
            "zh",
        )
    }

    pub fn start_with_devices_and_language(
        &self,
        consent_accepted: bool,
        selection: AudioDeviceSelection,
        language: &str,
    ) -> Result<MvpSnapshot, String> {
        if !consent_accepted {
            return Err("CONSENT_REQUIRED".to_owned());
        }
        let language = RecognitionLanguage::parse(language)?;

        #[cfg(windows)]
        {
            self.start_windows(selection, language)
        }
        #[cfg(not(windows))]
        {
            let _ = (selection, language);
            Err("MVP_WINDOWS_ONLY".to_owned())
        }
    }

    pub fn prepare_language(&self, language: &str) -> Result<MvpSnapshot, String> {
        let language = RecognitionLanguage::parse(language)?;
        #[cfg(windows)]
        {
            self.prepare_language_windows(language)
        }
        #[cfg(not(windows))]
        {
            let _ = language;
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

    pub fn pause(&self) -> Result<MvpSnapshot, String> {
        #[cfg(windows)]
        {
            self.pause_windows()
        }
        #[cfg(not(windows))]
        {
            Err("MVP_WINDOWS_ONLY".to_owned())
        }
    }

    pub fn resume(&self) -> Result<MvpSnapshot, String> {
        #[cfg(windows)]
        {
            self.resume_windows()
        }
        #[cfg(not(windows))]
        {
            Err("MVP_WINDOWS_ONLY".to_owned())
        }
    }

    pub fn open_recent(&self) -> Result<MvpSnapshot, String> {
        let inner = lock(&self.inner);
        #[cfg(windows)]
        if history_open_blocked(&inner, &self.snapshot) {
            return Err("SESSION_ACTIVE".to_owned());
        }
        let storage = self
            .storage
            .as_ref()
            .ok_or_else(|| "MVP_STORAGE_UNAVAILABLE".to_owned())?;
        let writer = self
            .storage_writer
            .as_ref()
            .ok_or_else(|| storage_error_from_snapshot(&self.snapshot))?;
        let recent = storage
            .recent_meeting()?
            .ok_or_else(|| "MVP_STORAGE_RECENT_EMPTY".to_owned())?;
        let result = self.apply_meeting_snapshot(writer.open_meeting(&recent.id)?);
        drop(inner);
        result
    }

    pub fn open_meeting(&self, meeting_id: &str) -> Result<MvpSnapshot, String> {
        let inner = lock(&self.inner);
        #[cfg(windows)]
        if history_open_blocked(&inner, &self.snapshot) {
            return Err("SESSION_ACTIVE".to_owned());
        }
        let writer = self
            .storage_writer
            .as_ref()
            .ok_or_else(|| storage_error_from_snapshot(&self.snapshot))?;
        let result = self.apply_meeting_snapshot(writer.open_meeting(meeting_id)?);
        drop(inner);
        result
    }

    pub fn export_meeting(
        &self,
        meeting_id: &str,
        target_dir: String,
    ) -> Result<ExportResult, String> {
        let storage = self
            .storage
            .as_ref()
            .ok_or_else(|| "MVP_STORAGE_UNAVAILABLE".to_owned())?;
        let writer = self
            .storage_writer
            .as_ref()
            .ok_or_else(|| storage_error_from_snapshot(&self.snapshot))?;
        export_meeting(storage, writer, meeting_id, target_dir)
    }

    pub fn transcript_text(&self, meeting_id: &str) -> Result<String, String> {
        let storage = self
            .storage
            .as_ref()
            .ok_or_else(|| "MVP_STORAGE_UNAVAILABLE".to_owned())?;
        transcript_text(storage, meeting_id)
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

    fn apply_meeting_snapshot(
        &self,
        meeting: super::storage::MeetingSnapshot,
    ) -> Result<MvpSnapshot, String> {
        let mut snapshot = lock(&self.snapshot);
        let total = meeting.finals.len();
        let mut finals = meeting
            .finals
            .iter()
            .map(segment_from_durable)
            .collect::<Vec<_>>();
        if finals.len() > super::contract::MAX_FINAL_SEGMENTS {
            let remove = finals.len() - super::contract::MAX_FINAL_SEGMENTS;
            finals.drain(..remove);
        }
        snapshot.meeting_id = Some(meeting.meeting.id.clone());
        snapshot.session_id = Some(meeting.meeting.id.clone());
        snapshot.latest_opened_meeting = Some(meeting.meeting.id);
        snapshot.finals = finals;
        snapshot.interim = None;
        snapshot.memory_only = false;
        snapshot.durability_status = meeting.meeting.state;
        snapshot.saved_final_count = total.to_string();
        snapshot.total_final_count = total.to_string();
        snapshot.last_saved_sequence = meeting
            .finals
            .last()
            .map(|final_segment| final_segment.sequence.to_string());
        snapshot.visible_final_window_start_sequence = visible_window_start_sequence(total);
        snapshot.error = meeting.meeting.completion_error;
        snapshot.enforce_bounds();
        Ok(snapshot.clone())
    }

    fn refresh_latest_opened_meeting(&self) -> Result<(), String> {
        let storage = self
            .storage
            .as_ref()
            .ok_or_else(|| "MVP_STORAGE_UNAVAILABLE".to_owned())?;
        let recent = storage.recent_meeting()?;
        let mut snapshot = lock(&self.snapshot);
        snapshot.latest_opened_meeting = recent.map(|meeting| meeting.id);
        Ok(())
    }

    #[cfg(windows)]
    fn prepare_inference_worker(
        &self,
        language: RecognitionLanguage,
    ) -> Result<InferenceWorker, String> {
        let paths = resolve_model_paths().inspect_err(|error| self.fail(error))?;
        InferenceWorker::prepare(
            Arc::clone(&self.snapshot),
            paths,
            self.storage_writer.clone(),
            language,
        )
        .inspect_err(|error| self.fail(error))
    }

    #[cfg(windows)]
    fn ensure_inference_worker(
        &self,
        inner: &mut ServiceInner,
        language: RecognitionLanguage,
    ) -> Result<(), String> {
        let replace = inner
            .inference
            .as_ref()
            .is_some_and(|worker| worker.is_finished() || worker.language != language);
        if replace {
            if let Some(worker) = inner.inference.take() {
                worker.shutdown_before(Instant::now() + MVP_SHUTDOWN_TIMEOUT)?;
            }
            let mut snapshot = lock(&self.snapshot);
            snapshot.model_ready = false;
            if snapshot.error.as_deref() == Some("ASR_WORKER_STOPPED") {
                snapshot.error = None;
            }
        }
        if inner.inference.is_none() {
            inner.inference = Some(self.prepare_inference_worker(language)?);
        }
        Ok(())
    }

    #[cfg(windows)]
    fn preflight_windows(&self) -> Result<MvpSnapshot, String> {
        let mut inner = lock(&self.inner);
        if inner.session.is_some() {
            return Ok(self.snapshot_locked(&inner));
        }
        if self.storage.is_none() || self.storage_writer.is_none() {
            let error = storage_error_from_snapshot(&self.snapshot);
            self.fail(&error);
            return Err(error);
        }

        {
            let mut snapshot = lock(&self.snapshot);
            snapshot.lifecycle = Lifecycle::Booting;
            snapshot.error = None;
        }
        if self.storage.is_some() {
            let writer = self.storage_writer.as_ref().expect("checked above");
            writer.recover_interrupted()?;
            self.refresh_latest_opened_meeting()?;
        }

        let devices = AudioCapture::preflight_default_devices().map_err(|error| {
            let code = public_audio_error(&error.to_string());
            self.fail(&code);
            code
        })?;

        let language = RecognitionLanguage::default();
        self.ensure_inference_worker(&mut inner, language)?;

        let mut snapshot = lock(&self.snapshot);
        snapshot.lifecycle = Lifecycle::Ready;
        snapshot.durability_status = "ready".to_owned();
        snapshot.model_ready = true;
        snapshot.model_label = language.model_label();
        snapshot.system = ready_source(SourceId::System, &devices.system_output);
        snapshot.microphone = ready_source(SourceId::Microphone, &devices.microphone);
        snapshot.error = None;
        Ok(public_snapshot(
            &mut snapshot,
            inner.inference.as_ref().map(|worker| &worker.submitter),
        ))
    }

    #[cfg(windows)]
    fn prepare_language_windows(
        &self,
        language: RecognitionLanguage,
    ) -> Result<MvpSnapshot, String> {
        let mut inner = lock(&self.inner);
        if inner.session.is_some() {
            return Err("SESSION_ALREADY_RUNNING".to_owned());
        }
        if lock(&self.snapshot).lifecycle != Lifecycle::Ready {
            return Err("MVP_NOT_READY".to_owned());
        }
        {
            let mut snapshot = lock(&self.snapshot);
            snapshot.model_ready = false;
            snapshot.model_label = format!("SenseVoice · {} · preparing", language.code());
            snapshot.error = None;
        }
        self.ensure_inference_worker(&mut inner, language)?;
        let mut snapshot = lock(&self.snapshot);
        snapshot.model_ready = true;
        snapshot.model_label = language.model_label();
        snapshot.error = None;
        Ok(public_snapshot(
            &mut snapshot,
            inner.inference.as_ref().map(|worker| &worker.submitter),
        ))
    }

    #[cfg(windows)]
    fn start_windows(
        &self,
        selection: AudioDeviceSelection,
        language: RecognitionLanguage,
    ) -> Result<MvpSnapshot, String> {
        let mut inner = lock(&self.inner);
        if inner.session.is_some() {
            return Err("SESSION_ALREADY_RUNNING".to_owned());
        }
        let writer = self
            .storage_writer
            .as_ref()
            .ok_or_else(|| storage_error_from_snapshot(&self.snapshot))?;
        if lock(&self.snapshot).lifecycle != Lifecycle::Ready {
            return Err("MVP_NOT_READY".to_owned());
        }
        self.ensure_inference_worker(&mut inner, language)?;
        let model_label = language.model_label();
        let meeting = writer.start_meeting(true, &model_label)?;

        if let Some(inference) = inner.inference.as_ref() {
            inference
                .submitter
                .shared
                .seed_durable_sequence(meeting.last_final_sequence);
        }

        {
            let mut snapshot = lock(&self.snapshot);
            snapshot.lifecycle = Lifecycle::Starting;
            snapshot.model_ready = true;
            snapshot.model_label = model_label;
            snapshot.error = None;
            snapshot.interim = None;
            snapshot.finals.clear();
            snapshot.meeting_id = Some(meeting.id.clone());
            snapshot.durability_status = "recording".to_owned();
            snapshot.saved_final_count = "0".to_owned();
            snapshot.total_final_count = "0".to_owned();
            snapshot.visible_final_window_start_sequence = "1".to_owned();
            snapshot.last_saved_sequence = None;
            snapshot.elapsed_ms = "0".to_owned();
            snapshot.system.frames = "0".to_owned();
            snapshot.microphone.frames = "0".to_owned();
        }

        let (capture, output) = AudioCapture::start(AudioCaptureOptions::default(), selection)
            .map_err(|error| {
                let _ = writer.interrupt_meeting(&meeting.id);
                let code = public_audio_error(&error.to_string());
                self.fail(&code);
                code
            })?;
        let session_id = meeting.id.clone();
        let submitter = inner
            .inference
            .as_ref()
            .expect("inference readiness was checked above")
            .submitter();
        let stop = Arc::new(AtomicBool::new(false));
        let pause_gate = Arc::new(PauseGate::default());
        let errors = Arc::new(RuntimeErrors::default());
        let metrics = output.metrics.clone();
        let preflight = output.preflight.clone();
        let coordinator = match spawn_coordinator(
            output,
            submitter,
            session_id.clone(),
            Arc::clone(&stop),
            Arc::clone(&pause_gate),
            Arc::clone(&errors),
        ) {
            Ok(coordinator) => coordinator,
            Err(error) => {
                drop(capture);
                let _ = writer.interrupt_meeting(&meeting.id);
                self.fail(&error);
                return Err(error);
            }
        };

        inner.session = Some(RunningSession {
            capture,
            coordinator: Some(coordinator),
            stop,
            pause_gate,
            metrics,
            errors,
            started: Instant::now(),
            meeting_id: meeting.id.clone(),
        });

        let mut snapshot = lock(&self.snapshot);
        snapshot.lifecycle = Lifecycle::Recording;
        snapshot.session_id = Some(session_id);
        snapshot.meeting_id = Some(meeting.id);
        snapshot.system = capturing_source(SourceId::System, &preflight.system_output);
        snapshot.microphone = capturing_source(SourceId::Microphone, &preflight.microphone);
        snapshot.error = None;
        Ok(public_snapshot(
            &mut snapshot,
            inner.inference.as_ref().map(|worker| &worker.submitter),
        ))
    }

    #[cfg(windows)]
    fn pause_windows(&self) -> Result<MvpSnapshot, String> {
        let deadline = Instant::now() + MVP_SHUTDOWN_TIMEOUT;
        let (pause_gate, submitter) = {
            let inner = lock(&self.inner);
            let Some(session) = inner.session.as_ref() else {
                return Err("SESSION_NOT_RUNNING".to_owned());
            };
            if lock(&self.snapshot).lifecycle == Lifecycle::Paused {
                return Ok(self.snapshot_locked(&inner));
            }
            (
                Arc::clone(&session.pause_gate),
                inner.inference.as_ref().map(InferenceWorker::submitter),
            )
        };

        let epoch = pause_gate.request_pause();
        if let Err(error) = pause_gate.wait_pause_ack_before(epoch, deadline) {
            set_public_error(&mut lock(&self.snapshot), &error);
            return Err(error);
        }
        if let Some(submitter) = submitter.as_ref()
            && let Err(error) = submitter.barrier_before(deadline)
        {
            let inner = lock(&self.inner);
            if inner.session.is_some() {
                apply_paused_snapshot(&mut lock(&self.snapshot), Some(&error));
            }
            return Err(error);
        }

        let inner = lock(&self.inner);
        let Some(session) = inner.session.as_ref() else {
            return Ok(self.snapshot_locked(&inner));
        };
        self.refresh_from_session(session, false);
        let mut snapshot = lock(&self.snapshot);
        apply_paused_snapshot(&mut snapshot, None);
        Ok(public_snapshot(
            &mut snapshot,
            inner.inference.as_ref().map(|worker| &worker.submitter),
        ))
    }

    #[cfg(windows)]
    fn resume_windows(&self) -> Result<MvpSnapshot, String> {
        let deadline = Instant::now() + MVP_SHUTDOWN_TIMEOUT;
        let pause_gate = {
            let inner = lock(&self.inner);
            let Some(session) = inner.session.as_ref() else {
                return Err("SESSION_NOT_RUNNING".to_owned());
            };
            if lock(&self.snapshot).lifecycle == Lifecycle::Recording {
                return Ok(self.snapshot_locked(&inner));
            }
            Arc::clone(&session.pause_gate)
        };
        let epoch = pause_gate.request_resume();
        if let Err(error) = pause_gate.wait_resume_ack_before(epoch, deadline) {
            set_public_error(&mut lock(&self.snapshot), &error);
            return Err(error);
        }

        let inner = lock(&self.inner);
        let Some(session) = inner.session.as_ref() else {
            return Ok(self.snapshot_locked(&inner));
        };
        self.refresh_from_session(session, false);
        let mut snapshot = lock(&self.snapshot);
        snapshot.lifecycle = Lifecycle::Recording;
        snapshot.durability_status = "recording".to_owned();
        snapshot.system.active = true;
        snapshot.microphone.active = true;
        if snapshot.system.error.is_none() {
            snapshot.system.status = SourceStatus::Capturing;
        }
        if snapshot.microphone.error.is_none() {
            snapshot.microphone.status = SourceStatus::Capturing;
        }
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
            lock(&self.snapshot).lifecycle = Lifecycle::Stopping;
            let submitter = inner.inference.as_ref().map(InferenceWorker::submitter);
            (session, submitter)
        };

        self.refresh_from_session(&session, true);
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
        let writer = self
            .storage_writer
            .as_ref()
            .ok_or_else(|| "MVP_STORAGE_UNAVAILABLE".to_owned())?;
        let meeting = finish_session_meeting(writer, &session.meeting_id, &session.errors)
            .inspect_err(|error| self.fail(error))?;
        let completion_error = meeting.completion_error.clone();

        let mut snapshot = lock(&self.snapshot);
        snapshot.lifecycle = Lifecycle::Ready;
        snapshot.durability_status = meeting.state;
        snapshot.system.active = false;
        snapshot.system.peak = 0.0;
        snapshot.system.status = SourceStatus::Ready;
        snapshot.microphone.active = false;
        snapshot.microphone.peak = 0.0;
        snapshot.microphone.status = SourceStatus::Ready;
        snapshot.queue_depth = 0;
        snapshot.error = None;
        if let Some(error) = take_runtime_error(&session.errors) {
            set_public_error(&mut snapshot, error);
        }
        if completion_error.is_some() {
            snapshot.error = completion_error;
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
        let active = !stopping && !session.pause_gate.is_paused();
        apply_source_stats(&mut snapshot.system, system, active);
        apply_source_stats(&mut snapshot.microphone, microphone, active);
        if stream_error {
            session.errors.mark_incomplete("AUDIO_STREAM_ERROR");
            set_public_error(&mut snapshot, "AUDIO_STREAM_ERROR");
        } else if system.dropped_packets > 0 || microphone.dropped_packets > 0 {
            session.errors.mark_incomplete("AUDIO_PACKETS_DROPPED");
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
    if snapshot
        .error
        .as_deref()
        .is_none_or(|current| public_error_priority(error) >= public_error_priority(current))
    {
        snapshot.error = Some(error.to_owned());
    }
}

#[cfg(windows)]
fn public_error_priority(code: &str) -> u8 {
    match code {
        "ASR_FINAL_OVERLOAD" => 3,
        "ASR_WORKER_STOPPED" => 2,
        _ => 1,
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn storage_error_from_snapshot(snapshot: &Mutex<MvpSnapshot>) -> String {
    lock(snapshot)
        .error
        .clone()
        .unwrap_or_else(|| "MVP_STORAGE_UNAVAILABLE".to_owned())
}

#[cfg(windows)]
fn finish_session_meeting(
    writer: &MvpStorageWriter,
    meeting_id: &str,
    errors: &RuntimeErrors,
) -> Result<super::storage::MeetingRecord, String> {
    match errors.completion_error().as_deref() {
        Some(error) => writer.incomplete_meeting(meeting_id, error),
        None => writer.complete_meeting(meeting_id),
    }
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
#[derive(Default)]
struct RuntimeErrors {
    priority: AtomicU8,
    completion_error: Mutex<Option<String>>,
}

#[cfg(windows)]
impl RuntimeErrors {
    fn mark_incomplete(&self, error: &str) {
        let mut current = lock(&self.completion_error);
        if current
            .as_deref()
            .is_none_or(|existing| public_error_priority(error) >= public_error_priority(existing))
        {
            *current = Some(error.to_owned());
        }
    }

    fn completion_error(&self) -> Option<String> {
        lock(&self.completion_error).clone()
    }
}

#[cfg(windows)]
fn record_runtime_error(errors: &RuntimeErrors, priority: u8) {
    errors.priority.fetch_max(priority, Ordering::AcqRel);
}

#[cfg(windows)]
fn take_runtime_error(errors: &RuntimeErrors) -> Option<&'static str> {
    match errors.priority.swap(0, Ordering::AcqRel) {
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
    pause_gate: Arc<PauseGate>,
    metrics: AudioCaptureMetrics,
    errors: Arc<RuntimeErrors>,
    started: Instant,
    meeting_id: String,
}

#[cfg(windows)]
#[derive(Default)]
struct PauseGate {
    paused: AtomicBool,
    pause_requested: AtomicU64,
    pause_acknowledged: AtomicU64,
    resume_requested: AtomicU64,
    resume_acknowledged: AtomicU64,
}

#[cfg(windows)]
impl PauseGate {
    fn request_pause(&self) -> u64 {
        self.paused.store(true, Ordering::Release);
        self.pause_requested.fetch_add(1, Ordering::AcqRel) + 1
    }

    fn request_resume(&self) -> u64 {
        self.resume_requested.fetch_add(1, Ordering::AcqRel) + 1
    }

    fn acknowledge_resume(&self, epoch: u64) {
        self.resume_acknowledged.fetch_max(epoch, Ordering::AcqRel);
        self.paused.store(false, Ordering::Release);
    }

    fn is_paused(&self) -> bool {
        self.paused.load(Ordering::Acquire)
    }

    fn pending_pause_epoch(&self) -> Option<u64> {
        let requested = self.pause_requested.load(Ordering::Acquire);
        (requested > self.pause_acknowledged.load(Ordering::Acquire)).then_some(requested)
    }

    fn pending_resume_epoch(&self) -> Option<u64> {
        let requested = self.resume_requested.load(Ordering::Acquire);
        (self.is_paused() && requested > self.resume_acknowledged.load(Ordering::Acquire))
            .then_some(requested)
    }

    fn acknowledge_pause(&self, epoch: u64) {
        self.pause_acknowledged.fetch_max(epoch, Ordering::AcqRel);
    }

    fn wait_pause_ack_before(&self, epoch: u64, deadline: Instant) -> Result<(), String> {
        while self.pause_acknowledged.load(Ordering::Acquire) < epoch {
            if Instant::now() >= deadline {
                return Err("MVP_PAUSE_TIMEOUT".to_owned());
            }
            thread::sleep(Duration::from_millis(2));
        }
        Ok(())
    }

    fn wait_resume_ack_before(&self, epoch: u64, deadline: Instant) -> Result<(), String> {
        while self.resume_acknowledged.load(Ordering::Acquire) < epoch {
            if Instant::now() >= deadline {
                return Err("MVP_RESUME_TIMEOUT".to_owned());
            }
            thread::sleep(Duration::from_millis(2));
        }
        Ok(())
    }
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
fn apply_paused_source(source: &mut AudioSourceSnapshot) {
    source.active = false;
    source.peak = 0.0;
    if source.error.is_none() {
        source.status = SourceStatus::Ready;
    }
}

#[cfg(windows)]
fn apply_paused_snapshot(snapshot: &mut MvpSnapshot, error: Option<&str>) {
    snapshot.lifecycle = Lifecycle::Paused;
    snapshot.durability_status = "paused".to_owned();
    apply_paused_source(&mut snapshot.system);
    apply_paused_source(&mut snapshot.microphone);
    if let Some(error) = error {
        set_public_error(snapshot, error);
    } else if snapshot.error.as_deref() != Some("ASR_FINAL_OVERLOAD") {
        snapshot.error = None;
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
        package_lock_path: canonical_env_or("MEETINGRELAY_PACKAGE_LOCK", root.join("Cargo.lock"))?,
    })
}

#[cfg(windows)]
fn canonical_env_or(name: &str, fallback: PathBuf) -> Result<PathBuf, String> {
    canonical_env_or_value(env::var_os(name), fallback)
}

#[cfg(windows)]
fn canonical_env_or_value(
    value: Option<std::ffi::OsString>,
    fallback: PathBuf,
) -> Result<PathBuf, String> {
    canonical_asset(value.map_or(fallback, PathBuf::from))
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
            if task.is_final {
                task.session_errors.mark_incomplete("ASR_WORKER_STOPPED");
            }
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
                    TrySendError::Full(task) => {
                        task.session_errors.mark_incomplete("ASR_FINAL_OVERLOAD");
                        Err("ASR_FINAL_OVERLOAD".to_owned())
                    }
                    TrySendError::Disconnected(task) => {
                        task.session_errors.mark_incomplete("ASR_WORKER_STOPPED");
                        Err("ASR_WORKER_STOPPED".to_owned())
                    }
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
    next_final_sequence: AtomicU64,
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

    fn next_durable_sequence_candidate(&self) -> u64 {
        self.next_final_sequence.load(Ordering::Acquire) + 1
    }

    fn advance_durable_sequence_after_ack(&self, sequence: u64) {
        self.next_final_sequence
            .fetch_max(sequence, Ordering::AcqRel);
    }

    fn seed_durable_sequence(&self, last_final_sequence: u64) {
        self.next_final_sequence
            .store(last_final_sequence, Ordering::Release);
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
#[derive(Clone)]
struct RecognizerProfile {
    paths: LockedSherpaRealtimePaths,
    language: RecognitionLanguage,
}

#[cfg(windows)]
struct InferenceWorker {
    submitter: InferenceSubmitter,
    join: Option<JoinHandle<()>>,
    language: RecognitionLanguage,
}

#[cfg(windows)]
impl InferenceWorker {
    fn prepare(
        snapshot: Arc<Mutex<MvpSnapshot>>,
        paths: LockedSherpaRealtimePaths,
        storage_writer: Option<Arc<MvpStorageWriter>>,
        language: RecognitionLanguage,
    ) -> Result<Self, String> {
        let (ready_sender, ready_receiver) = sync_channel(1);
        let (finals, final_receiver) = sync_channel(MAX_INFERENCE_QUEUE_DEPTH);
        let shared = Arc::new(InferenceShared::default());
        let worker_shared = Arc::clone(&shared);
        let profile = RecognizerProfile { paths, language };
        let worker_profile = profile.clone();
        let join = thread::Builder::new()
            .name("meetingrelay-asr".to_owned())
            .spawn(move || {
                let recognizer = LockedSherpaRealtime::prepare_local_mvp_with_language(
                    profile.paths.clone(),
                    profile.language.sherpa(),
                )
                .map_err(|error| error.to_string());
                let ready = recognizer.as_ref().map(|_| ()).map_err(Clone::clone);
                let _ = ready_sender.send(ready);
                if let Ok(mut recognizer) = recognizer {
                    inference_loop(
                        &mut recognizer,
                        worker_profile,
                        final_receiver,
                        worker_shared,
                        snapshot,
                        storage_writer,
                    );
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
            language,
        })
    }

    fn submitter(&self) -> InferenceSubmitter {
        self.submitter.clone()
    }

    fn queue_depth(&self) -> usize {
        self.submitter.queue_depth()
    }

    fn is_finished(&self) -> bool {
        self.join.as_ref().is_none_or(JoinHandle::is_finished)
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
    session_errors: Arc<RuntimeErrors>,
}

#[cfg(windows)]
fn inference_loop(
    recognizer: &mut LockedSherpaRealtime,
    profile: RecognizerProfile,
    finals: Receiver<InferenceTask>,
    shared: Arc<InferenceShared>,
    snapshot: Arc<Mutex<MvpSnapshot>>,
    storage_writer: Option<Arc<MvpStorageWriter>>,
) {
    loop {
        let scheduled = match finals.try_recv() {
            Ok(final_task) => Some((None, final_task)),
            Err(TryRecvError::Empty | TryRecvError::Disconnected) => shared
                .take_interim()
                .map(|(generation, task)| (Some(generation), task)),
        };
        if let Some((interim_generation, task)) = scheduled {
            process_inference_task(
                recognizer,
                &profile,
                &shared,
                &snapshot,
                storage_writer.as_deref(),
                interim_generation,
                task,
            );
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
fn transcribe_with_recovery(
    recognizer: &mut LockedSherpaRealtime,
    profile: &RecognizerProfile,
    task: &InferenceTask,
) -> Result<String, LockedSherpaRealtimeError> {
    let result = recognizer.transcribe_mono_16khz_pcm16(Arc::clone(&task.samples));
    let result = if result
        .as_ref()
        .err()
        .is_some_and(|error| should_retry_transcription(*error, task))
    {
        *recognizer = LockedSherpaRealtime::prepare_local_mvp_with_language(
            profile.paths.clone(),
            profile.language.sherpa(),
        )?;
        recognizer.transcribe_mono_16khz_pcm16(Arc::clone(&task.samples))
    } else {
        result
    };
    result.map(|result| result.original_transcript.as_str().trim().to_owned())
}

#[cfg(windows)]
fn should_retry_transcription(error: LockedSherpaRealtimeError, task: &InferenceTask) -> bool {
    is_recoverable_transcription_error(error) && is_replayable_inference_task(task)
}

#[cfg(windows)]
fn is_recoverable_transcription_error(error: LockedSherpaRealtimeError) -> bool {
    matches!(
        error,
        LockedSherpaRealtimeError::RecognitionUnavailable | LockedSherpaRealtimeError::NotPrepared
    )
}

#[cfg(windows)]
fn is_replayable_inference_task(task: &InferenceTask) -> bool {
    is_replayable_sample_count(task.samples.len())
}

#[cfg(windows)]
fn is_replayable_sample_count(sample_count: usize) -> bool {
    let Ok(samples) = u64::try_from(sample_count) else {
        return false;
    };
    samples != 0 && samples.saturating_mul(2) <= LOCKED_REALTIME_MAX_PCM16_BYTES
}

#[cfg(windows)]
fn process_inference_task(
    recognizer: &mut LockedSherpaRealtime,
    profile: &RecognizerProfile,
    shared: &InferenceShared,
    snapshot: &Mutex<MvpSnapshot>,
    storage_writer: Option<&MvpStorageWriter>,
    interim_generation: Option<u64>,
    task: InferenceTask,
) {
    let stale_task = interim_generation
        .is_some_and(|generation| !shared.interim_is_current(generation))
        || lock(snapshot).session_id.as_deref() != Some(task.session_id.as_str());
    if stale_task {
        if task.is_final {
            task.session_errors
                .mark_incomplete("ASR_FINAL_SESSION_MISMATCH");
        }
        return;
    }

    let result = transcribe_with_recovery(recognizer, profile, &task);
    let session_id = task.session_id.clone();
    let durable_final = match result {
        Ok(text) => {
            if !is_meaningful_transcript(&text) {
                return;
            }
            if task.is_final {
                let sequence = shared.next_durable_sequence_candidate();
                let Some(storage_writer) = storage_writer else {
                    task.session_errors
                        .mark_incomplete("MVP_STORAGE_UNAVAILABLE");
                    let _ = publish_if_current(
                        shared,
                        snapshot,
                        interim_generation,
                        &session_id,
                        |current| set_public_error(current, "MVP_STORAGE_UNAVAILABLE"),
                    );
                    return;
                };
                match storage_writer.commit_final(FinalCandidate {
                    meeting_id: task.session_id.clone(),
                    segment_id: task.segment_id.clone(),
                    sequence,
                    revision: task.revision,
                    text,
                    started_at_ms: task.started_at_ms.clone(),
                    ended_at_ms: task.ended_at_ms.clone(),
                }) {
                    Ok(ack) => {
                        shared.advance_durable_sequence_after_ack(ack.final_segment.sequence);
                        Some(Ok((ack.final_segment, ack.duplicate)))
                    }
                    Err(error) => {
                        task.session_errors.mark_incomplete(&error);
                        Some(Err(error))
                    }
                }
            } else {
                let segment = TranscriptSegment {
                    segment_id: task.segment_id.clone(),
                    sequence: "0".to_owned(),
                    revision: task.revision,
                    is_final: false,
                    saved: false,
                    text,
                    started_at_ms: task.started_at_ms.clone(),
                    ended_at_ms: None,
                    committed_at: None,
                    commit_id: None,
                };
                let _ = publish_if_current(
                    shared,
                    snapshot,
                    interim_generation,
                    &session_id,
                    move |current| {
                        current.interim = Some(segment);
                        shared.published_interim.store(
                            interim_generation.expect("interim tasks carry a generation"),
                            Ordering::Release,
                        );
                        if current.error.as_deref() != Some("ASR_FINAL_OVERLOAD") {
                            current.error = None;
                        }
                        current.enforce_bounds();
                    },
                );
                return;
            }
        }
        Err(error) if task.is_final => {
            let error = error.to_string();
            task.session_errors.mark_incomplete(&error);
            Some(Err(error))
        }
        Err(_) => None,
    };
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
            if let Some(result) = durable_final {
                apply_final_commit_result(current, result);
            }
        },
    );
}

#[cfg(windows)]
fn apply_final_commit_result(
    current: &mut MvpSnapshot,
    result: Result<(DurableFinal, bool), String>,
) {
    match result {
        Ok((final_segment, duplicate)) => {
            let total = usize::try_from(final_segment.sequence).unwrap_or(usize::MAX);
            if !duplicate
                && !current
                    .finals
                    .iter()
                    .any(|segment| segment.commit_id.as_deref() == Some(&final_segment.commit_id))
            {
                current.finals.push(segment_from_durable(&final_segment));
            }
            current.memory_only = false;
            current.durability_status = "recording".to_owned();
            current.saved_final_count = total.to_string();
            current.total_final_count = total.to_string();
            current.last_saved_sequence = Some(final_segment.sequence.to_string());
            current.visible_final_window_start_sequence = visible_window_start_sequence(total);
            if current.error.as_deref() != Some("ASR_FINAL_OVERLOAD") {
                current.error = None;
            }
            current.enforce_bounds();
        }
        Err(error) => set_public_error(current, &error),
    }
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
    pause_gate: Arc<PauseGate>,
    errors: Arc<RuntimeErrors>,
) -> Result<JoinHandle<()>, String> {
    thread::Builder::new()
        .name("meetingrelay-audio".to_owned())
        .spawn(move || coordinator_loop(output, submitter, session_id, stop, pause_gate, errors))
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
    pause_gate: Arc<PauseGate>,
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
        errors.mark_incomplete("AUDIO_DSP_CONFIGURATION");
        return;
    };
    let mut endpoint = EnergyEndpointSegmenter::new();
    let mut identity = SegmentIdentity::default();

    while !stop.load(Ordering::Acquire) {
        if let Some(epoch) = pause_gate.pending_pause_epoch() {
            finalize_pause_boundary(
                &mut system,
                &mut microphone,
                &mut endpoint,
                &mut identity,
                &submitter,
                &errors,
                &session_id,
            );
            pause_gate.acknowledge_pause(epoch);
        }
        if pause_gate.is_paused() {
            if let Some(epoch) = pause_gate.pending_resume_epoch() {
                discard_paused_packets(&packets);
                reset_resume_boundary(&mut system, &mut microphone, &mut endpoint, &mut identity);
                pause_gate.acknowledge_resume(epoch);
                continue;
            }
            match packets.recv_timeout(Duration::from_millis(20)) {
                Ok(_) | Err(RecvTimeoutError::Timeout) => continue,
                Err(RecvTimeoutError::Disconnected) => break,
            }
        }
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

    if !pause_gate.is_paused() {
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
}

#[cfg(windows)]
#[allow(clippy::too_many_arguments)]
fn finalize_pause_boundary(
    system: &mut SourcePipeline,
    microphone: &mut SourcePipeline,
    endpoint: &mut EnergyEndpointSegmenter,
    identity: &mut SegmentIdentity,
    submitter: &InferenceSubmitter,
    errors: &Arc<RuntimeErrors>,
    session_id: &str,
) {
    while let Some(block) = system.blocks.pop_front() {
        process_pair(
            Some(block),
            microphone.blocks.pop_front(),
            endpoint,
            identity,
            submitter,
            errors,
            session_id,
        );
    }
    while let Some(block) = microphone.blocks.pop_front() {
        process_pair(
            None,
            Some(block),
            endpoint,
            identity,
            submitter,
            errors,
            session_id,
        );
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
        endpoint,
        identity,
        submitter,
        errors,
        session_id,
    );
    if let Some(event) = endpoint.flush_stop() {
        submit_segment(event, identity, submitter, errors, session_id);
    }
}

#[cfg(windows)]
fn discard_paused_packets(packets: &Receiver<RawAudioPacket>) {
    while packets.try_recv().is_ok() {}
}

#[cfg(windows)]
fn reset_resume_boundary(
    system: &mut SourcePipeline,
    microphone: &mut SourcePipeline,
    endpoint: &mut EnergyEndpointSegmenter,
    identity: &mut SegmentIdentity,
) {
    system.reset_after_pause();
    microphone.reset_after_pause();
    endpoint.reset();
    identity.clear_active();
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

    fn reset_after_pause(&mut self) {
        self.resampler.reset();
        self.packetizer.reset();
        self.blocks.clear();
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
    errors: &Arc<RuntimeErrors>,
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
    errors: &Arc<RuntimeErrors>,
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
    errors: &Arc<RuntimeErrors>,
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

    fn clear_active(&mut self) {
        self.active = None;
    }
}

#[cfg(windows)]
fn submit_segment(
    event: SegmentEvent,
    identity: &mut SegmentIdentity,
    submitter: &InferenceSubmitter,
    errors: &Arc<RuntimeErrors>,
    session_id: &str,
) {
    let (segment, is_final) = match event {
        SegmentEvent::Interim(segment) => (segment, false),
        SegmentEvent::Final { segment, .. } => (segment, true),
    };
    let (segment_id, revision) = identity.metadata(is_final);
    let task = inference_task(
        session_id,
        segment_id,
        revision,
        is_final,
        segment,
        Arc::clone(errors),
    );
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
    session_errors: Arc<RuntimeErrors>,
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
        session_errors,
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
    use crate::mvp::{
        audio::AudioSampleFormat,
        dsp::{BLOCK_SAMPLES, SPEECH_START_BLOCKS},
    };

    #[cfg(windows)]
    fn temp_storage_writer(test_name: &str) -> (MvpStorage, MvpStorageWriter) {
        let root = std::env::temp_dir().join(format!(
            "meetingrelay-service-{test_name}-{}",
            crate::mvp::storage::now_ms_string()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let storage = MvpStorage::open_at(root.join("mvp.sqlite3")).unwrap();
        let writer = MvpStorageWriter::start(storage.clone()).unwrap();
        (storage, writer)
    }

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
            session_errors: Arc::new(RuntimeErrors::default()),
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

    #[cfg(windows)]
    fn test_running_session(meeting_id: &str) -> RunningSession {
        let capture = AudioCapture::stopped_for_test();
        let metrics = capture.metrics();
        RunningSession {
            capture,
            coordinator: None,
            stop: Arc::new(AtomicBool::new(false)),
            pause_gate: Arc::new(PauseGate::default()),
            metrics,
            errors: Arc::new(RuntimeErrors::default()),
            started: Instant::now(),
            meeting_id: meeting_id.to_owned(),
        }
    }

    #[test]
    fn default_service_is_private_local_durable_and_booting() {
        let snapshot = MvpService::default().snapshot();
        assert_eq!(snapshot.lifecycle, Lifecycle::Booting);
        assert!(snapshot.local_only);
        assert!(!snapshot.memory_only);
        assert_eq!(snapshot.system.frames, "0");
        assert_eq!(snapshot.microphone.frames, "0");
    }

    #[test]
    fn storage_initialization_failure_is_public_and_blocks_start() {
        let service =
            MvpService::new_with_storage_result(Err("MVP_STORAGE_TEST_OPEN_FAILED".to_owned()));
        let snapshot = service.snapshot();
        assert_eq!(snapshot.durability_status, "error");
        assert_eq!(
            snapshot.error.as_deref(),
            Some("MVP_STORAGE_TEST_OPEN_FAILED")
        );
        #[cfg(windows)]
        {
            assert_eq!(
                service.start(true),
                Err("MVP_STORAGE_TEST_OPEN_FAILED".to_owned())
            );
            assert_eq!(
                service.preflight(),
                Err("MVP_STORAGE_TEST_OPEN_FAILED".to_owned())
            );
        }
        #[cfg(not(windows))]
        {
            assert_eq!(service.start(true), Err("MVP_WINDOWS_ONLY".to_owned()));
        }
    }

    #[test]
    fn latest_opened_meeting_refreshes_from_storage_recent() {
        let root = std::env::temp_dir().join(format!(
            "meetingrelay-service-recent-{}",
            crate::mvp::storage::now_ms_string()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let storage = MvpStorage::open_at(root.join("mvp.sqlite3")).unwrap();
        let writer = MvpStorageWriter::start(storage.clone()).unwrap();
        let meeting = writer.start_meeting(true, "test model").unwrap();
        writer.complete_meeting(&meeting.id).unwrap();
        drop(writer);
        let service = MvpService::new_with_storage_result(Ok(storage));
        service.refresh_latest_opened_meeting().unwrap();
        assert_eq!(
            service.snapshot().latest_opened_meeting.as_deref(),
            Some(meeting.id.as_str())
        );
    }

    #[cfg(windows)]
    #[test]
    fn active_session_rejects_history_open_without_replacing_session_identity() {
        let (storage, writer) = temp_storage_writer("active-history-guard");
        let historical = writer.start_meeting(true, "test model").unwrap();
        writer.complete_meeting(&historical.id).unwrap();
        drop(writer);
        let service = MvpService::new_with_storage_result(Ok(storage));
        {
            let mut snapshot = lock(&service.snapshot);
            snapshot.lifecycle = Lifecycle::Recording;
            snapshot.meeting_id = Some("active-meeting".to_owned());
            snapshot.session_id = Some("active-meeting".to_owned());
            snapshot.durability_status = "recording".to_owned();
        }
        lock(&service.inner).session = Some(test_running_session("active-meeting"));

        assert_eq!(service.open_recent(), Err("SESSION_ACTIVE".to_owned()));
        assert_eq!(
            service.open_meeting(&historical.id),
            Err("SESSION_ACTIVE".to_owned())
        );
        {
            let snapshot = lock(&service.snapshot);
            assert_eq!(snapshot.meeting_id.as_deref(), Some("active-meeting"));
            assert_eq!(snapshot.session_id.as_deref(), Some("active-meeting"));
            assert_eq!(snapshot.lifecycle, Lifecycle::Recording);
        }

        lock(&service.inner).session = None;
        lock(&service.snapshot).lifecycle = Lifecycle::Stopping;
        assert_eq!(service.open_recent(), Err("SESSION_ACTIVE".to_owned()));
        assert_eq!(
            service.open_meeting(&historical.id),
            Err("SESSION_ACTIVE".to_owned())
        );
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
    fn pause_gate_uses_distinct_pause_and_resume_acknowledgements() {
        let gate = Arc::new(PauseGate::default());
        let pause_epoch = gate.request_pause();
        assert!(gate.is_paused());
        assert_eq!(gate.pending_pause_epoch(), Some(pause_epoch));

        gate.acknowledge_pause(pause_epoch);
        assert_eq!(
            gate.wait_pause_ack_before(pause_epoch, Instant::now() + Duration::from_millis(50)),
            Ok(())
        );
        assert_eq!(gate.pending_pause_epoch(), None);

        let resume_epoch = gate.request_resume();
        assert!(
            gate.is_paused(),
            "resume request must not open the gate before coordinator ack"
        );
        assert_eq!(gate.pending_resume_epoch(), Some(resume_epoch));

        gate.acknowledge_resume(resume_epoch);
        assert_eq!(
            gate.wait_resume_ack_before(resume_epoch, Instant::now() + Duration::from_millis(50)),
            Ok(())
        );
        assert_eq!(gate.pending_resume_epoch(), None);
        assert!(!gate.is_paused());
    }

    #[cfg(windows)]
    #[test]
    fn pause_barrier_failure_keeps_the_running_session_stoppable() {
        let mut snapshot = MvpSnapshot::booting();
        snapshot.lifecycle = Lifecycle::Recording;
        snapshot.durability_status = "recording".to_owned();
        snapshot.system.active = true;
        snapshot.microphone.active = true;

        apply_paused_snapshot(&mut snapshot, Some("ASR_WORKER_STOPPED"));

        assert_eq!(snapshot.lifecycle, Lifecycle::Paused);
        assert_eq!(snapshot.durability_status, "paused");
        assert!(!snapshot.system.active);
        assert!(!snapshot.microphone.active);
        assert_eq!(snapshot.error.as_deref(), Some("ASR_WORKER_STOPPED"));
    }

    #[cfg(windows)]
    #[test]
    fn resume_transition_discards_paused_backlog_and_resets_processing_boundary() {
        let (sender, receiver) = sync_channel(8);
        sender
            .send(RawAudioPacket {
                source: AudioSourceId::SystemOutput,
                sample_rate: TARGET_SAMPLE_RATE_HZ,
                channels: 1,
                samples: vec![0.5; 16],
            })
            .unwrap();
        sender
            .send(RawAudioPacket {
                source: AudioSourceId::Microphone,
                sample_rate: TARGET_SAMPLE_RATE_HZ,
                channels: 1,
                samples: vec![0.5; 16],
            })
            .unwrap();
        discard_paused_packets(&receiver);
        assert!(matches!(receiver.try_recv(), Err(TryRecvError::Empty)));

        let preflight = AudioDevicePreflight {
            source: AudioSourceId::SystemOutput,
            device_id: "test-device".to_owned(),
            name: "test device".to_owned(),
            sample_rate: TARGET_SAMPLE_RATE_HZ,
            channels: 1,
            sample_format: AudioSampleFormat::F32,
        };
        let mut system = SourcePipeline::new(&preflight).unwrap();
        let mut microphone = SourcePipeline::new(&AudioDevicePreflight {
            source: AudioSourceId::Microphone,
            ..preflight
        })
        .unwrap();
        system.push(RawAudioPacket {
            source: AudioSourceId::SystemOutput,
            sample_rate: TARGET_SAMPLE_RATE_HZ,
            channels: 1,
            samples: vec![0.5; 16],
        });
        microphone.push(RawAudioPacket {
            source: AudioSourceId::Microphone,
            sample_rate: TARGET_SAMPLE_RATE_HZ,
            channels: 1,
            samples: vec![0.5; 16],
        });

        let mut endpoint = EnergyEndpointSegmenter::new();
        for _ in 0..SPEECH_START_BLOCKS {
            let _ = endpoint.push_block(&[1.0; BLOCK_SAMPLES]);
        }
        assert!(endpoint.is_active());
        let mut identity = SegmentIdentity::default();
        let (_segment_id, _revision) = identity.metadata(false);
        assert!(identity.active.is_some());

        reset_resume_boundary(&mut system, &mut microphone, &mut endpoint, &mut identity);

        assert_eq!(system.packetizer.pending_samples(), 0);
        assert!(system.blocks.is_empty());
        assert_eq!(system.resampler.output_samples(), 0);
        assert_eq!(microphone.packetizer.pending_samples(), 0);
        assert!(microphone.blocks.is_empty());
        assert_eq!(microphone.resampler.output_samples(), 0);
        assert!(!endpoint.is_active());
        assert_eq!(endpoint.processed_samples(), 0);
        assert!(identity.active.is_none());
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
            sequence: "0".to_owned(),
            revision: 1,
            is_final: false,
            saved: false,
            text: "stale".to_owned(),
            started_at_ms: "0".to_owned(),
            ended_at_ms: None,
            committed_at: None,
            commit_id: None,
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
        let rejected = queued_task(1, true);
        let rejected_errors = Arc::clone(&rejected.session_errors);
        assert_eq!(
            submitter.submit(rejected),
            Err("ASR_FINAL_OVERLOAD".to_owned())
        );
        assert_eq!(
            rejected_errors.completion_error().as_deref(),
            Some("ASR_FINAL_OVERLOAD")
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
    fn transcription_retry_classifier_only_retries_recoverable_replayable_tasks() {
        let task = queued_task(1, false);
        assert!(should_retry_transcription(
            LockedSherpaRealtimeError::RecognitionUnavailable,
            &task
        ));
        assert!(should_retry_transcription(
            LockedSherpaRealtimeError::NotPrepared,
            &task
        ));
        assert!(!should_retry_transcription(
            LockedSherpaRealtimeError::EmptySegment,
            &task
        ));
        assert!(!should_retry_transcription(
            LockedSherpaRealtimeError::SegmentTooLarge,
            &task
        ));
        assert!(!should_retry_transcription(
            LockedSherpaRealtimeError::InvalidAudio,
            &task
        ));

        let empty = InferenceTask {
            samples: Arc::<[i16]>::from([]),
            ..queued_task(1, false)
        };
        assert!(!should_retry_transcription(
            LockedSherpaRealtimeError::RecognitionUnavailable,
            &empty
        ));
        assert!(!is_replayable_sample_count(0));
        assert!(is_replayable_sample_count(
            usize::try_from(LOCKED_REALTIME_MAX_PCM16_BYTES / 2).unwrap()
        ));
        assert!(!is_replayable_sample_count(
            usize::try_from(LOCKED_REALTIME_MAX_PCM16_BYTES / 2 + 1).unwrap()
        ));
    }

    #[cfg(windows)]
    #[test]
    fn canonical_env_or_value_prefers_canonical_override_and_falls_back() {
        let root = std::env::temp_dir().join(format!(
            "meetingrelay-service-env-{}",
            crate::mvp::storage::now_ms_string()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let fallback = root.join("Cargo.lock");
        let override_lock = root.join("package-lock.json");
        std::fs::write(&fallback, "fallback").unwrap();
        std::fs::write(&override_lock, "override").unwrap();

        assert_eq!(
            canonical_env_or_value(None, fallback.clone()).unwrap(),
            fallback.canonicalize().unwrap()
        );
        assert_eq!(
            canonical_env_or_value(Some(override_lock.clone().into_os_string()), fallback).unwrap(),
            override_lock.canonicalize().unwrap()
        );
    }

    #[cfg(windows)]
    #[test]
    fn final_overload_does_not_consume_durable_sequence() {
        let (submitter, _finals) = test_submitter();
        for _ in 0..MAX_INFERENCE_QUEUE_DEPTH {
            submitter.submit(queued_task(1, true)).unwrap();
        }
        let rejected = queued_task(1, true);
        let rejected_errors = Arc::clone(&rejected.session_errors);
        assert_eq!(
            submitter.submit(rejected),
            Err("ASR_FINAL_OVERLOAD".to_owned())
        );
        assert_eq!(
            rejected_errors.completion_error().as_deref(),
            Some("ASR_FINAL_OVERLOAD")
        );
        assert_eq!(
            submitter.shared.next_final_sequence.load(Ordering::Acquire),
            0
        );
    }

    #[cfg(windows)]
    #[test]
    fn final_overload_persists_an_incomplete_meeting_instead_of_completed() {
        let (storage, writer) = temp_storage_writer("overload-incomplete");
        let meeting = writer.start_meeting(true, "test model").unwrap();
        let errors = RuntimeErrors::default();
        errors.mark_incomplete("ASR_FINAL_OVERLOAD");

        let finished = finish_session_meeting(&writer, &meeting.id, &errors).unwrap();

        assert_eq!(finished.state, "interrupted");
        assert_eq!(
            finished.completion_error.as_deref(),
            Some("ASR_FINAL_OVERLOAD")
        );
        let reopened = storage.snapshot(&meeting.id).unwrap();
        assert_eq!(reopened.meeting.state, "interrupted");
        assert_eq!(
            reopened.meeting.completion_error.as_deref(),
            Some("ASR_FINAL_OVERLOAD")
        );
    }

    #[cfg(windows)]
    #[test]
    fn failed_durable_commit_does_not_advance_sequence_and_next_commit_can_reuse_it() {
        let (_storage, writer) = temp_storage_writer("sequence-retry");
        let meeting = writer.start_meeting(true, "test model").unwrap();
        let shared = InferenceShared::default();
        let failed_sequence = shared.next_durable_sequence_candidate();
        assert_eq!(
            writer
                .commit_final(FinalCandidate {
                    meeting_id: meeting.id.clone(),
                    segment_id: "segment-gap".to_owned(),
                    sequence: failed_sequence + 1,
                    revision: 1,
                    text: "gap".to_owned(),
                    started_at_ms: "0".to_owned(),
                    ended_at_ms: "1".to_owned(),
                })
                .unwrap_err(),
            "MVP_STORAGE_FINAL_SEQUENCE_GAP_OR_REORDER"
        );
        assert_eq!(shared.next_durable_sequence_candidate(), failed_sequence);
        let ack = writer
            .commit_final(FinalCandidate {
                meeting_id: meeting.id,
                segment_id: "segment-ok".to_owned(),
                sequence: failed_sequence,
                revision: 1,
                text: "ok".to_owned(),
                started_at_ms: "0".to_owned(),
                ended_at_ms: "1".to_owned(),
            })
            .unwrap();
        shared.advance_durable_sequence_after_ack(ack.final_segment.sequence);
        assert_eq!(ack.final_segment.sequence, failed_sequence);
        assert_eq!(
            shared.next_durable_sequence_candidate(),
            failed_sequence + 1
        );
    }

    #[cfg(windows)]
    #[test]
    fn new_meeting_seed_resets_durable_sequence_to_one() {
        let shared = InferenceShared::default();
        shared.advance_durable_sequence_after_ack(7);
        assert_eq!(shared.next_durable_sequence_candidate(), 8);
        shared.seed_durable_sequence(0);
        assert_eq!(shared.next_durable_sequence_candidate(), 1);
    }

    #[cfg(windows)]
    #[test]
    fn commit_failure_does_not_publish_saved_final() {
        let mut snapshot = MvpSnapshot::booting();
        snapshot.session_id = Some("meeting-test".to_owned());
        apply_final_commit_result(
            &mut snapshot,
            Err("MVP_STORAGE_FINAL_SEQUENCE_GAP_OR_REORDER".to_owned()),
        );
        assert!(snapshot.finals.is_empty());
        assert_eq!(
            snapshot.error.as_deref(),
            Some("MVP_STORAGE_FINAL_SEQUENCE_GAP_OR_REORDER")
        );
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
            language: RecognitionLanguage::Chinese,
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
#[test]
fn recognition_language_is_limited_to_chinese_japanese_and_english() {
    assert_eq!(
        RecognitionLanguage::parse("zh"),
        Ok(RecognitionLanguage::Chinese)
    );
    assert_eq!(
        RecognitionLanguage::parse("ja"),
        Ok(RecognitionLanguage::Japanese)
    );
    assert_eq!(
        RecognitionLanguage::parse("en"),
        Ok(RecognitionLanguage::English)
    );
    assert_eq!(
        RecognitionLanguage::parse("auto"),
        Err("ASR_LANGUAGE_UNSUPPORTED".to_owned())
    );
    assert_eq!(
        RecognitionLanguage::parse("ko"),
        Err("ASR_LANGUAGE_UNSUPPORTED".to_owned())
    );
}
