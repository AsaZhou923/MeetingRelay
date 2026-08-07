use std::{
    collections::HashMap,
    fs::File,
    io::Write,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex, MutexGuard,
        atomic::{AtomicBool, Ordering},
    },
};

use super::{
    asr_models::{AsrModelProfile, resolve_asr_model, resolve_asr_model_from_label},
    audio::{AudioDeviceInventory, AudioDeviceSelection, AudioSourceMode},
    contract::{
        AudioSourceSnapshot, DiskHealthSnapshot, Lifecycle, MvpSnapshot, SourceId, SourceStatus,
    },
    export::{
        ExportOptions, ExportResult, ExportSummary, ExportSummarySection, export_meeting,
        export_meeting_with_options, transcript_text,
    },
    governance::{GovernanceFileTombstone, MeetingFileVault},
    raw_audio::{
        RawAudioConfig, RawAudioError, RawAudioManifest, RawAudioRetentionPolicy, RawAudioStore,
        read_mixed_window_16khz,
    },
    secret_store::{ProductionSecretStore, SecretStore, SecretStoreStatus},
    speaker::{
        SpeakerDiarizationResult, SpeakerMergeRequest, SpeakerRenameRequest, SpeakerUndoRequest,
        SpeakerVersionSnapshot, draft_from_raw_audio, merge_draft, rename_draft, undo_draft,
    },
    storage::{
        DurableFinal, FinalCandidate, MeetingLibraryItem, MeetingLibraryQuery, MvpStorage,
        MvpStorageWriter, ProviderProfileInput, ProviderProfileRecord, RecoveryActionKind,
        SegmentSearchQuery, SummaryChunkInput, SummaryCompletionInput, SummaryJobInput,
        SummaryJobRecord, SummaryProviderProvenance, SummaryResultInput, SummaryResultRecord,
        TranslationCandidate, TranslationCompletion, configured_data_root,
        data_root_has_environment_override, now_ms_string, save_configured_data_root,
        segment_from_durable, sha256_hex, visible_window_start_sequence,
    },
    summary::{
        MeetingSummary, SummaryConfig, SummaryOutcome, SummaryProgressSnapshot, SummaryRunRequest,
        SummarySegment, SummaryStage, run_summary,
    },
    translation::{
        LocalTranslationDiscovery, TranslationConfig, TranslationProbe, TranslationSubmitter,
        TranslationWorker, ValidatedTranslationConfig, discover_local_translation_models,
        discover_local_translation_models_before, test_translation, test_translation_before,
        translate_text, translation_error_retryable, validate_local_translation_base_url,
    },
};

pub(crate) const MVP_SHUTDOWN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(12);
const DISK_REQUIRED_BYTES: u64 = 512 * 1024 * 1024;
const DISK_WARNING_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const GOVERNANCE_RECOVERY_WINDOW_SECONDS: u64 = 24 * 60 * 60;
const SUMMARY_DISCLOSURE_VERSION: &str = "meetingrelay.summary.provider-disclosure.v1";
const PROVIDER_TEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
#[cfg(windows)]
const RECOVERY_WINDOW_SAMPLES: u64 = 8 * 16_000;
#[cfg(windows)]
const FINAL_QUEUE_BACKPRESSURE: Duration = Duration::from_millis(250);

#[cfg(windows)]
use std::{
    collections::VecDeque,
    env, fs,
    process::Command,
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
    cohere_asr::{self, CohereAsrConfig, CohereAsrError, CohereAsrSidecar},
    contract::{MAX_INFERENCE_QUEUE_DEPTH, TranscriptSegment},
    dsp::{
        AudioBlock, AudioSegment, BlockPacketizer, EnergyEndpointSegmenter, Mono16kResampler,
        SegmentEvent, TARGET_SAMPLE_RATE_HZ, mix_blocks,
    },
    raw_audio::{MeetingSampleRange, RawAudioGap, RawAudioMeetingWriter},
};

pub struct MvpService {
    snapshot: Arc<Mutex<MvpSnapshot>>,
    storage: Option<MvpStorage>,
    storage_writer: Option<Arc<MvpStorageWriter>>,
    translation: Mutex<Option<TranslationWorker>>,
    secret_store: Arc<dyn SecretStore>,
    summary_state: Arc<Mutex<SummaryJobSnapshot>>,
    summary_cancel: Arc<AtomicBool>,
    summary_active: Arc<AtomicBool>,
    retry_progress: Arc<Mutex<TranslationRetryProgressSnapshot>>,
    retry_cancel: Arc<AtomicBool>,
    live_text_mirrors: Arc<Mutex<HashMap<String, LiveTextMirror>>>,
    inner: Mutex<ServiceInner>,
    shutdown_started: AtomicBool,
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslationRetryProgressSnapshot {
    pub batch_id: Option<String>,
    pub status: String,
    pub total: usize,
    pub progress: usize,
    pub succeeded: usize,
    pub failed: usize,
    pub cancelled: usize,
    pub cost_risk_accepted: bool,
    pub message: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SegmentAudioLocation {
    pub available: bool,
    pub path: Option<String>,
    pub offset_ms: Option<String>,
    pub duration_ms: Option<String>,
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticBundleResult {
    pub path: String,
    pub byte_length: usize,
    pub sha256: String,
    pub redacted: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretStoreSnapshot {
    pub backend: String,
    pub available: bool,
    pub configured: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataDirectorySettingsSnapshot {
    pub active_data_dir: String,
    pub configured_data_dir: String,
    pub restart_required: bool,
    pub environment_override: bool,
    pub active_storage_available: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SummaryCitationSnapshot {
    pub segment_id: Option<String>,
    pub sequence: Option<String>,
    pub label: String,
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SummaryResultSnapshot {
    pub summary_id: String,
    pub version: u32,
    pub language: String,
    pub overview: String,
    pub actions: Vec<String>,
    pub decisions: Vec<String>,
    pub open_questions: Vec<String>,
    pub citations: Vec<SummaryCitationSnapshot>,
    pub created_at: String,
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SummaryJobSnapshot {
    pub job_id: String,
    pub meeting_id: String,
    pub status: String,
    pub version: u32,
    pub total_chunks: usize,
    pub completed_chunks: usize,
    pub can_cancel: bool,
    pub can_retry: bool,
    pub message: Option<String>,
    pub result: Option<SummaryResultSnapshot>,
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingListItemSnapshot {
    pub meeting_id: String,
    pub title: String,
    pub status: String,
    pub started_at: String,
    pub updated_at: String,
    pub duration_ms: String,
    pub language: String,
    pub saved_final_count: String,
    pub translation_failed_count: usize,
    pub summary_status: String,
    pub tags: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingListPageSnapshot {
    pub items: Vec<MeetingListItemSnapshot>,
    pub next_cursor: Option<String>,
    pub total: usize,
    pub page_size: usize,
    pub elapsed_ms: u128,
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingDetailSnapshot {
    pub meeting: MeetingListItemSnapshot,
    pub segments: Vec<super::contract::TranscriptSegment>,
    pub summary: Option<SummaryResultSnapshot>,
}

#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SegmentSearchHitSnapshot {
    pub meeting_id: String,
    pub meeting_title: String,
    pub segment_id: Option<String>,
    pub sequence: Option<String>,
    pub scope: String,
    pub snippet: String,
    pub score: f64,
}

#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SegmentSearchPageSnapshot {
    pub hits: Vec<SegmentSearchHitSnapshot>,
    pub next_cursor: Option<String>,
    pub total: usize,
    pub elapsed_ms: u128,
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderProfileSnapshot {
    pub profile_id: String,
    pub label: String,
    #[serde(rename = "class")]
    pub provider_class: String,
    pub base_url: String,
    pub model: String,
    pub policy_url: Option<String>,
    pub data_flow: String,
    pub config_version: u32,
    pub secret_state: String,
    pub last_test_status: String,
    pub last_test_at: Option<String>,
    pub last_error: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderProfileUpdate {
    pub profile_id: String,
    pub label: String,
    #[serde(rename = "class")]
    pub provider_class: String,
    pub base_url: String,
    pub model: String,
    pub policy_url: Option<String>,
    pub data_flow: String,
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeletePreviewEntrySnapshot {
    #[serde(rename = "type")]
    pub entry_type: String,
    pub path: Option<String>,
    pub byte_length: String,
    pub description: String,
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeletePreviewSnapshot {
    pub meeting_id: String,
    pub recovery_window_seconds: u64,
    pub include_raw: bool,
    pub include_derived: bool,
    pub entries: Vec<DeletePreviewEntrySnapshot>,
    pub will_delete_bytes: String,
    pub can_restore: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteResultSnapshot {
    pub meeting_id: String,
    pub deleted: bool,
    pub restored_until: Option<String>,
    pub entries_deleted: usize,
    pub bytes_deleted: String,
}

impl Default for SummaryJobSnapshot {
    fn default() -> Self {
        Self {
            job_id: "idle".to_owned(),
            meeting_id: "idle".to_owned(),
            status: "idle".to_owned(),
            version: 0,
            total_chunks: 0,
            completed_chunks: 0,
            can_cancel: false,
            can_retry: false,
            message: None,
            result: None,
        }
    }
}

impl Default for TranslationRetryProgressSnapshot {
    fn default() -> Self {
        Self {
            batch_id: None,
            status: "idle".to_owned(),
            total: 0,
            progress: 0,
            succeeded: 0,
            failed: 0,
            cancelled: 0,
            cost_risk_accepted: false,
            message: None,
        }
    }
}

#[derive(Default)]
struct ServiceInner {
    #[cfg(windows)]
    inference: Option<InferenceWorker>,
    #[cfg(windows)]
    session: Option<RunningSession>,
}

#[derive(Debug)]
struct LiveTextMirror {
    path: PathBuf,
    file: File,
}

impl LiveTextMirror {
    fn begin(directory: &Path, meeting_id: &str) -> Result<Self, String> {
        validate_live_text_directory(directory)?;
        let path = directory.join(format!("MeetingRelay-{meeting_id}.txt"));
        let file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|_| "LIVE_TEXT_MIRROR_BEGIN_FAILED".to_owned())?;
        Ok(Self { path, file })
    }

    fn append_final_original(&mut self, text: &str) -> Result<(), String> {
        self.file
            .write_all(text.as_bytes())
            .and_then(|_| self.file.write_all(b"\n"))
            .and_then(|_| self.file.flush())
            .map_err(|_| "LIVE_TEXT_MIRROR_WRITE_FAILED".to_owned())
    }

    fn cleanup_empty_file(self) {
        let Self { path, file } = self;
        drop(file);
        if std::fs::metadata(&path).is_ok_and(|metadata| metadata.len() == 0) {
            let _ = std::fs::remove_file(path);
        }
    }
}

fn validate_live_text_directory(directory: &Path) -> Result<(), String> {
    if !directory.is_absolute() {
        return Err("LIVE_TEXT_DIRECTORY_NOT_ABSOLUTE".to_owned());
    }
    std::fs::metadata(directory)
        .map_err(|_| "LIVE_TEXT_DIRECTORY_UNAVAILABLE".to_owned())
        .and_then(|metadata| {
            metadata
                .is_dir()
                .then_some(())
                .ok_or_else(|| "LIVE_TEXT_DIRECTORY_UNAVAILABLE".to_owned())
        })
}

fn append_live_text_final(
    mirrors: &Mutex<HashMap<String, LiveTextMirror>>,
    meeting_id: &str,
    text: &str,
) -> Option<String> {
    let mut mirrors = lock(mirrors);
    let mirror = mirrors.get_mut(meeting_id)?;
    match mirror.append_final_original(text) {
        Ok(()) => None,
        Err(error) => Some(disable_live_text_mirror_after_error(
            &mut mirrors,
            meeting_id,
            &error,
        )),
    }
}

fn disable_live_text_mirror_after_error(
    mirrors: &mut HashMap<String, LiveTextMirror>,
    meeting_id: &str,
    error: &str,
) -> String {
    mirrors.remove(meeting_id);
    error.to_owned()
}

fn cleanup_live_text_mirror_empty_file(
    mirrors: &Mutex<HashMap<String, LiveTextMirror>>,
    meeting_id: &str,
) {
    if let Some(mirror) = lock(mirrors).remove(meeting_id) {
        mirror.cleanup_empty_file();
    }
}

fn data_directory_settings_snapshot(
    active: PathBuf,
    active_storage_available: bool,
    configured: PathBuf,
) -> DataDirectorySettingsSnapshot {
    let active_data_dir = active.to_string_lossy().into_owned();
    let configured_data_dir = configured.to_string_lossy().into_owned();
    let configured_differs = if cfg!(windows) {
        !active_data_dir.eq_ignore_ascii_case(&configured_data_dir)
    } else {
        active_data_dir != configured_data_dir
    };
    DataDirectorySettingsSnapshot {
        active_data_dir,
        configured_data_dir,
        restart_required: !active_storage_available || configured_differs,
        environment_override: data_root_has_environment_override(),
        active_storage_available,
    }
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

    fn model_label(self, model: &AsrModelProfile) -> String {
        model.meeting_label(self.code())
    }

    fn from_model_label(model_label: &str) -> Self {
        if model_label.contains("· en ·") {
            Self::English
        } else if model_label.contains("· ja ·") {
            Self::Japanese
        } else {
            Self::Chinese
        }
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
        Self::new_with_dependencies(storage_result, Arc::new(ProductionSecretStore::new()))
    }

    fn new_with_dependencies(
        storage_result: Result<MvpStorage, String>,
        secret_store: Arc<dyn SecretStore>,
    ) -> Self {
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
        let snapshot = Arc::new(Mutex::new(snapshot));
        let translation = storage_writer.as_ref().and_then(|writer| {
            TranslationWorker::start(Arc::clone(&snapshot), Arc::clone(writer)).ok()
        });
        Self {
            snapshot,
            storage,
            storage_writer,
            translation: Mutex::new(translation),
            secret_store,
            summary_state: Arc::new(Mutex::new(SummaryJobSnapshot::default())),
            summary_cancel: Arc::new(AtomicBool::new(false)),
            summary_active: Arc::new(AtomicBool::new(false)),
            retry_progress: Arc::new(Mutex::new(TranslationRetryProgressSnapshot::default())),
            retry_cancel: Arc::new(AtomicBool::new(false)),
            live_text_mirrors: Arc::new(Mutex::new(HashMap::new())),
            inner: Mutex::new(ServiceInner::default()),
            shutdown_started: AtomicBool::new(false),
        }
    }

    pub fn data_directory_settings(&self) -> Result<DataDirectorySettingsSnapshot, String> {
        let configured = configured_data_root()?;
        let (active, active_storage_available) = match self.storage.as_ref() {
            Some(storage) => (storage.data_root()?, true),
            None => (configured.clone(), false),
        };
        Ok(data_directory_settings_snapshot(
            active,
            active_storage_available,
            configured,
        ))
    }

    pub fn save_data_directory(
        &self,
        data_directory: &str,
    ) -> Result<DataDirectorySettingsSnapshot, String> {
        if matches!(
            lock(&self.snapshot).lifecycle,
            Lifecycle::Starting | Lifecycle::Recording | Lifecycle::Paused | Lifecycle::Stopping
        ) {
            return Err("MVP_DATA_DIR_SESSION_ACTIVE".to_owned());
        }
        let current_configured = configured_data_root()?;
        let (active, active_storage_available) = match self.storage.as_ref() {
            Some(storage) => (storage.data_root()?, true),
            None => (current_configured, false),
        };
        let configured = save_configured_data_root(data_directory)?;
        Ok(data_directory_settings_snapshot(
            active,
            active_storage_available,
            configured,
        ))
    }

    pub fn secret_store_status(
        &self,
        provider_profile_id: Option<&str>,
    ) -> Result<SecretStoreSnapshot, String> {
        let available = matches!(
            self.secret_store
                .status()
                .map_err(|_| "SECRET_STORE_UNAVAILABLE".to_owned())?,
            SecretStoreStatus::Available
        );
        let configured = if let Some(profile_id) = provider_profile_id {
            let secret_id = provider_secret_id(profile_id)?;
            let mut secret = self
                .secret_store
                .get(&secret_id)
                .map_err(|_| "SECRET_STORE_READ_FAILED".to_owned())?;
            let configured = secret.is_some();
            if let Some(bytes) = secret.as_mut() {
                bytes.fill(0);
            }
            configured
        } else {
            false
        };
        Ok(SecretStoreSnapshot {
            backend: if cfg!(windows) {
                "windows-credential-manager".to_owned()
            } else {
                "unsupported".to_owned()
            },
            available,
            configured,
        })
    }

    pub fn set_provider_secret(
        &self,
        provider_profile_id: &str,
        secret: String,
    ) -> Result<SecretStoreSnapshot, String> {
        let secret_id = provider_secret_id(provider_profile_id)?;
        let mut secret = secret.into_bytes();
        let result = self
            .secret_store
            .set(&secret_id, &secret)
            .map_err(|_| "SECRET_STORE_WRITE_FAILED".to_owned());
        secret.fill(0);
        result?;
        self.secret_store_status(Some(provider_profile_id))
    }

    pub fn delete_provider_secret(
        &self,
        provider_profile_id: &str,
    ) -> Result<SecretStoreSnapshot, String> {
        let secret_id = provider_secret_id(provider_profile_id)?;
        self.secret_store
            .delete(&secret_id)
            .map_err(|_| "SECRET_STORE_DELETE_FAILED".to_owned())?;
        self.secret_store_status(Some(provider_profile_id))
    }

    pub fn test_provider(&self, provider_profile_id: &str) -> Result<TranslationProbe, String> {
        let storage = self
            .storage
            .as_ref()
            .ok_or_else(|| "MVP_STORAGE_UNAVAILABLE".to_owned())?;
        let profile = storage
            .provider_profile_latest(provider_profile_id)?
            .ok_or_else(|| "PROVIDER_PROFILE_NOT_FOUND".to_owned())?;
        let provider_test_deadline = std::time::Instant::now() + PROVIDER_TEST_TIMEOUT;
        if profile.provider_class == "local" {
            let base_url = profile.base_url.clone().unwrap_or_default();
            let discovery =
                discover_local_translation_models_before(&base_url, provider_test_deadline)
                    .inspect_err(|error| {
                        let _ = self.record_provider_test(&profile, "failed", Some(error));
                    })?;
            if !discovery
                .models
                .iter()
                .any(|model| model.id == profile.model)
            {
                let error = "LOCAL_TRANSLATION_MODEL_NOT_AVAILABLE".to_owned();
                let _ = self.record_provider_test(&profile, "failed", Some(&error));
                return Err(error);
            }
        }
        let config = TranslationConfig {
            enabled: true,
            base_url: profile.base_url.clone().unwrap_or_default(),
            model: profile.model.clone(),
            api_key: if profile.provider_class == "local" {
                None
            } else {
                self.provider_api_key(provider_profile_id)?
            },
            target_language: "zh".to_owned(),
            allow_insecure_http: profile.provider_class == "lan",
        };
        let result = if profile.provider_class == "local" {
            test_translation_before(&config, provider_test_deadline)
        } else {
            test_translation(&config)
        };
        match result {
            Ok(probe) => {
                self.record_provider_test(&profile, "passed", None)?;
                Ok(probe)
            }
            Err(error) => {
                let _ = self.record_provider_test(&profile, "failed", Some(&error));
                Err(error)
            }
        }
    }

    pub fn discover_local_translation_models(
        &self,
        base_url: &str,
    ) -> Result<LocalTranslationDiscovery, String> {
        discover_local_translation_models(base_url)
    }

    pub fn provider_profiles(&self) -> Result<Vec<ProviderProfileSnapshot>, String> {
        let storage = self
            .storage
            .as_ref()
            .ok_or_else(|| "MVP_STORAGE_UNAVAILABLE".to_owned())?;
        let mut profiles = storage.provider_profiles_latest()?;
        if profiles.is_empty() {
            self.seed_default_provider_profiles()?;
            profiles = storage.provider_profiles_latest()?;
        }
        profiles
            .into_iter()
            .map(|profile| {
                let secret_state = self.provider_secret_state(&profile)?;
                Ok(ProviderProfileSnapshot {
                    profile_id: profile.profile_id,
                    label: profile.label,
                    provider_class: profile.provider_class,
                    base_url: profile.base_url.unwrap_or_default(),
                    model: profile.model,
                    policy_url: profile.policy_url,
                    data_flow: profile.data_flow,
                    config_version: profile.config_version.max(1),
                    secret_state,
                    last_test_status: profile
                        .last_test_status
                        .unwrap_or_else(|| "untested".to_owned()),
                    last_test_at: profile.last_test_at,
                    last_error: profile.last_error,
                })
            })
            .collect()
    }

    pub fn save_provider_profile(
        &self,
        update: ProviderProfileUpdate,
    ) -> Result<ProviderProfileSnapshot, String> {
        let storage = self
            .storage
            .as_ref()
            .ok_or_else(|| "MVP_STORAGE_UNAVAILABLE".to_owned())?;
        let existing = storage
            .provider_profile_latest(&update.profile_id)?
            .ok_or_else(|| "PROVIDER_PROFILE_NOT_FOUND".to_owned())?;
        let endpoint_hash = if update.provider_class == "local" {
            sha256_hex(update.base_url.as_bytes())
        } else {
            TranslationConfig {
                enabled: true,
                base_url: update.base_url.clone(),
                model: update.model.clone(),
                api_key: None,
                target_language: "zh".to_owned(),
                allow_insecure_http: update.provider_class == "lan",
            }
            .validate_enabled()?
            .endpoint_hash
        };
        let secret_state = self.provider_secret_state(&existing)?;
        let writer = self
            .storage_writer
            .as_ref()
            .ok_or_else(|| storage_error_from_snapshot(&self.snapshot))?;
        let saved = writer.save_provider_profile(ProviderProfileInput {
            profile_id: Some(update.profile_id),
            label: update.label,
            provider_class: update.provider_class,
            base_url: Some(update.base_url),
            model: update.model,
            endpoint_hash,
            data_flow: update.data_flow,
            policy_url: update.policy_url,
            config_version: existing.config_version.saturating_add(1),
            secret_state: secret_state.clone(),
            last_test_at: None,
            last_test_status: None,
            last_error: None,
        })?;
        Ok(ProviderProfileSnapshot {
            profile_id: saved.profile_id,
            label: saved.label,
            provider_class: saved.provider_class,
            base_url: saved.base_url.unwrap_or_default(),
            model: saved.model,
            policy_url: saved.policy_url,
            data_flow: saved.data_flow,
            config_version: saved.config_version.max(1),
            secret_state,
            last_test_status: "untested".to_owned(),
            last_test_at: None,
            last_error: None,
        })
    }

    fn seed_default_provider_profiles(&self) -> Result<(), String> {
        let writer = self
            .storage_writer
            .as_ref()
            .ok_or_else(|| storage_error_from_snapshot(&self.snapshot))?;
        for input in default_provider_profiles() {
            writer.save_provider_profile(input)?;
        }
        Ok(())
    }

    fn provider_secret_state(&self, profile: &ProviderProfileRecord) -> Result<String, String> {
        if profile.provider_class == "local" {
            return Ok("not_required".to_owned());
        }
        if !matches!(self.secret_store.status(), Ok(SecretStoreStatus::Available)) {
            return Ok("unsupported".to_owned());
        }
        let secret_id = provider_secret_id(&profile.profile_id)?;
        let mut secret = self
            .secret_store
            .get(&secret_id)
            .map_err(|_| "SECRET_STORE_READ_FAILED".to_owned())?;
        let state = if secret.is_some() {
            "present"
        } else {
            "missing"
        };
        if let Some(bytes) = secret.as_mut() {
            bytes.fill(0);
        }
        Ok(state.to_owned())
    }

    fn record_provider_test(
        &self,
        profile: &ProviderProfileRecord,
        status: &str,
        error: Option<&str>,
    ) -> Result<(), String> {
        let writer = self
            .storage_writer
            .as_ref()
            .ok_or_else(|| storage_error_from_snapshot(&self.snapshot))?;
        writer.save_provider_profile(ProviderProfileInput {
            profile_id: Some(profile.profile_id.clone()),
            label: profile.label.clone(),
            provider_class: profile.provider_class.clone(),
            base_url: profile.base_url.clone(),
            model: profile.model.clone(),
            endpoint_hash: profile.endpoint_hash.clone(),
            data_flow: profile.data_flow.clone(),
            policy_url: profile.policy_url.clone(),
            config_version: profile.config_version,
            secret_state: profile.secret_state.clone(),
            last_test_at: Some(now_ms_string()),
            last_test_status: Some(status.to_owned()),
            last_error: error.map(bounded_provider_error),
        })?;
        Ok(())
    }

    pub fn list_meetings(
        &self,
        query: String,
        tags: Vec<String>,
        cursor: Option<String>,
        page_size: usize,
    ) -> Result<MeetingListPageSnapshot, String> {
        let storage = self
            .storage
            .as_ref()
            .ok_or_else(|| "MVP_STORAGE_UNAVAILABLE".to_owned())?;
        let page = storage.list_meetings(MeetingLibraryQuery {
            query,
            tags,
            cursor,
            page_size,
        })?;
        Ok(MeetingListPageSnapshot {
            items: page
                .items
                .into_iter()
                .map(meeting_list_item_snapshot)
                .collect(),
            next_cursor: page.next_cursor,
            total: page.total,
            page_size: page.page_size,
            elapsed_ms: page.elapsed_ms,
        })
    }

    pub fn search_segments(
        &self,
        text: Option<String>,
        scopes: Vec<String>,
        meeting_id: Option<String>,
        tag_ids: Vec<String>,
        limit: usize,
        cursor: Option<String>,
    ) -> Result<SegmentSearchPageSnapshot, String> {
        let started = std::time::Instant::now();
        let storage = self
            .storage
            .as_ref()
            .ok_or_else(|| "MVP_STORAGE_UNAVAILABLE".to_owned())?;
        let page = storage.search_segments(SegmentSearchQuery {
            text,
            scopes,
            meeting_id,
            tag_ids,
            limit,
            cursor,
        })?;
        let total = page.hits.len();
        let mut hits = Vec::with_capacity(total);
        for hit in page.hits {
            let title = storage
                .meeting_library_item(&hit.meeting_id)?
                .map(|item| item.title)
                .unwrap_or_else(|| hit.meeting_id.clone());
            let (segment_id, sequence) = resolve_search_identity(storage, &hit)?;
            hits.push(SegmentSearchHitSnapshot {
                meeting_id: hit.meeting_id,
                meeting_title: title,
                segment_id,
                sequence,
                score: match hit.scope.as_str() {
                    "original" => 1.0,
                    "translation" => 0.9,
                    "summary" => 0.8,
                    "speaker" => 0.7,
                    _ => 0.0,
                },
                scope: hit.scope,
                snippet: hit.text.chars().take(1_024).collect(),
            });
        }
        Ok(SegmentSearchPageSnapshot {
            hits,
            next_cursor: page.next_cursor,
            total,
            elapsed_ms: started.elapsed().as_millis(),
        })
    }

    pub fn meeting_detail(&self, meeting_id: &str) -> Result<MeetingDetailSnapshot, String> {
        let storage = self
            .storage
            .as_ref()
            .ok_or_else(|| "MVP_STORAGE_UNAVAILABLE".to_owned())?;
        let item = storage
            .meeting_library_item(meeting_id)?
            .ok_or_else(|| "MVP_STORAGE_MEETING_NOT_FOUND".to_owned())?;
        let snapshot = storage.snapshot(meeting_id)?;
        let summary = match storage.latest_summary_job_for_meeting(meeting_id)? {
            Some(job) if job.status == "completed" => {
                let records = storage.summary_results(&job.job_id)?;
                summary_result_from_records(storage, &job, &records)?
            }
            _ => None,
        };
        Ok(MeetingDetailSnapshot {
            meeting: meeting_list_item_snapshot(item),
            segments: snapshot.finals.iter().map(segment_from_durable).collect(),
            summary,
        })
    }

    pub fn update_meeting_tags(
        &self,
        meeting_id: &str,
        tags: Vec<String>,
    ) -> Result<MeetingDetailSnapshot, String> {
        let writer = self
            .storage_writer
            .as_ref()
            .ok_or_else(|| storage_error_from_snapshot(&self.snapshot))?;
        writer.replace_meeting_tags(meeting_id, tags)?;
        self.meeting_detail(meeting_id)
    }

    pub fn update_meeting_metadata(
        &self,
        meeting_id: &str,
        title: &str,
        language: &str,
    ) -> Result<MeetingDetailSnapshot, String> {
        let writer = self
            .storage_writer
            .as_ref()
            .ok_or_else(|| storage_error_from_snapshot(&self.snapshot))?;
        writer.update_meeting_metadata(meeting_id, title, language)?;
        self.meeting_detail(meeting_id)
    }

    pub fn tags(&self) -> Result<Vec<super::storage::TagRecord>, String> {
        self.storage
            .as_ref()
            .ok_or_else(|| "MVP_STORAGE_UNAVAILABLE".to_owned())?
            .tags()
    }

    pub fn create_tag(
        &self,
        name: &str,
        color: Option<&str>,
    ) -> Result<super::storage::TagRecord, String> {
        self.storage_writer
            .as_ref()
            .ok_or_else(|| storage_error_from_snapshot(&self.snapshot))?
            .create_tag(name, color)
    }

    pub fn delete_tag(&self, tag_id: &str) -> Result<(), String> {
        self.storage_writer
            .as_ref()
            .ok_or_else(|| storage_error_from_snapshot(&self.snapshot))?
            .delete_tag(tag_id)
    }

    pub fn assign_tag(&self, meeting_id: &str, tag_id: &str) -> Result<(), String> {
        self.storage_writer
            .as_ref()
            .ok_or_else(|| storage_error_from_snapshot(&self.snapshot))?
            .assign_tag(meeting_id, tag_id)
    }

    pub fn unassign_tag(&self, meeting_id: &str, tag_id: &str) -> Result<(), String> {
        self.storage_writer
            .as_ref()
            .ok_or_else(|| storage_error_from_snapshot(&self.snapshot))?
            .unassign_tag(meeting_id, tag_id)
    }

    pub fn provider_profile_history(
        &self,
        profile_id: &str,
    ) -> Result<Vec<ProviderProfileRecord>, String> {
        self.storage
            .as_ref()
            .ok_or_else(|| "MVP_STORAGE_UNAVAILABLE".to_owned())?
            .provider_profile_history(profile_id)
    }

    pub fn start_summary(
        &self,
        meeting_id: &str,
        provider_profile_id: Option<&str>,
        language: &str,
        summary_risk_accepted: bool,
    ) -> Result<SummaryJobSnapshot, String> {
        if language != "zh" {
            return Err("SUMMARY_LANGUAGE_UNSUPPORTED".to_owned());
        }
        self.start_summary_internal(meeting_id, provider_profile_id, None, summary_risk_accepted)
    }

    pub fn summary_status(&self, job_id: &str) -> Result<SummaryJobSnapshot, String> {
        let current = lock(&self.summary_state).clone();
        if current.job_id == job_id
            && (self.summary_active.load(Ordering::Acquire) || current.status != "queued")
        {
            return Ok(current);
        }
        let storage = self
            .storage
            .as_ref()
            .ok_or_else(|| "MVP_STORAGE_UNAVAILABLE".to_owned())?;
        let progress = storage
            .summary_progress(job_id)?
            .ok_or_else(|| "SUMMARY_JOB_NOT_FOUND".to_owned())?;
        let records = storage.summary_results(job_id)?;
        let result = if progress.job.status == "completed" {
            summary_result_from_records(storage, &progress.job, &records)?
        } else {
            None
        };
        Ok(summary_job_from_storage(
            progress.job,
            progress.chunk_count,
            result,
        ))
    }

    pub fn cancel_summary(&self, job_id: &str) -> Result<SummaryJobSnapshot, String> {
        let storage = self
            .storage
            .as_ref()
            .ok_or_else(|| "MVP_STORAGE_UNAVAILABLE".to_owned())?;
        let job = storage
            .summary_job(job_id)?
            .ok_or_else(|| "SUMMARY_JOB_NOT_FOUND".to_owned())?;
        if job.status != "pending" {
            return self.summary_status(job_id);
        }
        self.summary_cancel.store(true, Ordering::Release);
        let writer = self
            .storage_writer
            .as_ref()
            .ok_or_else(|| storage_error_from_snapshot(&self.snapshot))?;
        let cancelled = writer.cancel_summary_job(job_id)?;
        let mut state = lock(&self.summary_state);
        if state.job_id == job_id {
            state.status = "cancelled".to_owned();
            state.can_cancel = false;
            state.can_retry = true;
            state.message = Some("Summary cancelled".to_owned());
            state.result = None;
            return Ok(state.clone());
        }
        Ok(summary_job_from_storage(cancelled, 0, None))
    }

    pub fn retry_summary(
        &self,
        job_id: &str,
        provider_profile_id: &str,
        summary_risk_accepted: bool,
    ) -> Result<SummaryJobSnapshot, String> {
        let storage = self
            .storage
            .as_ref()
            .ok_or_else(|| "MVP_STORAGE_UNAVAILABLE".to_owned())?;
        let parent = storage
            .summary_job(job_id)?
            .ok_or_else(|| "SUMMARY_JOB_NOT_FOUND".to_owned())?;
        if parent.status == "pending" {
            return Err("SUMMARY_JOB_STILL_RUNNING".to_owned());
        }
        if parent.provider_profile_id.as_deref() != Some(provider_profile_id) {
            return Err("SUMMARY_RETRY_PROVIDER_MISMATCH".to_owned());
        }
        self.start_summary_internal(
            &parent.meeting_id,
            Some(provider_profile_id),
            Some(job_id),
            summary_risk_accepted,
        )
    }

    fn start_summary_internal(
        &self,
        meeting_id: &str,
        provider_profile_id: Option<&str>,
        parent_job_id: Option<&str>,
        summary_risk_accepted: bool,
    ) -> Result<SummaryJobSnapshot, String> {
        let storage = self
            .storage
            .as_ref()
            .ok_or_else(|| "MVP_STORAGE_UNAVAILABLE".to_owned())?;
        let writer = self
            .storage_writer
            .as_ref()
            .cloned()
            .ok_or_else(|| storage_error_from_snapshot(&self.snapshot))?;
        let meeting = storage.snapshot(meeting_id)?;
        if meeting.meeting.state == "recording" {
            return Err("SUMMARY_RECORDING_NOT_ALLOWED".to_owned());
        }
        if meeting.finals.is_empty() {
            return Err("SUMMARY_EMPTY_MEETING".to_owned());
        }
        let profile_id = provider_profile_id
            .filter(|profile_id| !profile_id.trim().is_empty())
            .ok_or_else(|| "SUMMARY_PROVIDER_REQUIRED".to_owned())?
            .to_owned();
        let profile = storage
            .provider_profile_latest(&profile_id)?
            .ok_or_else(|| "PROVIDER_PROFILE_NOT_FOUND".to_owned())?;
        if profile.provider_class != "local" && !summary_risk_accepted {
            return Err("SUMMARY_RISK_ACK_REQUIRED".to_owned());
        }
        if profile.provider_class == "local" {
            validate_local_translation_base_url(profile.base_url.as_deref().unwrap_or_default())?;
        }
        let provenance_profile_version = profile.version;
        let provenance_config_version = profile.config_version;
        let provenance_provider_class = profile.provider_class.clone();
        let provenance_endpoint_hash = profile.endpoint_hash.clone();
        let provenance_model = profile.model.clone();
        let config = SummaryConfig {
            enabled: true,
            provider: "openai-compatible".to_owned(),
            base_url: profile.base_url.clone().unwrap_or_default(),
            model: profile.model.clone(),
            api_key: if profile.provider_class == "local" {
                None
            } else {
                self.provider_api_key(&profile_id)?
            },
            allow_insecure_http: profile.provider_class == "lan",
            max_chunk_chars: None,
            max_retries: None,
        }
        .validate_enabled()?;
        let provenance = SummaryProviderProvenance {
            profile_version: provenance_profile_version,
            config_version: provenance_config_version,
            provider_class: provenance_provider_class.clone(),
            endpoint_origin: config.endpoint_origin.clone(),
            endpoint_hash: provenance_endpoint_hash,
            model: provenance_model,
            risk_accepted: summary_risk_accepted,
            disclosure_version: (provenance_provider_class != "local")
                .then(|| SUMMARY_DISCLOSURE_VERSION.to_owned()),
        };
        let request = SummaryRunRequest {
            meeting_id: meeting_id.to_owned(),
            segments: meeting
                .finals
                .iter()
                .map(|segment| SummarySegment {
                    meeting_id: meeting_id.to_owned(),
                    segment_id: segment.segment_id.clone(),
                    sequence: segment.sequence,
                    sample_start: segment.meeting_sample_start,
                    sample_end: segment.meeting_sample_end,
                    text: segment.text.clone(),
                })
                .collect(),
        };
        request.validate()?;
        self.summary_active
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| "SUMMARY_JOB_ALREADY_RUNNING".to_owned())?;
        self.summary_cancel.store(false, Ordering::Release);
        let job_input = SummaryJobInput {
            meeting_id: meeting_id.to_owned(),
            provider_profile_id: Some(profile_id),
            prompt_version: "meetingrelay.summary.prompt.v1".to_owned(),
            request_schema_version: "openai.chat.completions.v1".to_owned(),
        };
        let job = match parent_job_id {
            Some(parent) => writer.retry_summary_job_with_provenance(parent, job_input, provenance),
            None => writer.start_summary_job_with_provenance(job_input, provenance),
        }
        .inspect_err(|_| self.summary_active.store(false, Ordering::Release))?;
        let queued = summary_job_from_storage(job.clone(), 0, None);
        *lock(&self.summary_state) = queued.clone();

        let state = Arc::clone(&self.summary_state);
        let cancellation = Arc::clone(&self.summary_cancel);
        let active = Arc::clone(&self.summary_active);
        let thread_job = job.clone();
        let thread_writer = Arc::clone(&writer);
        let spawn = std::thread::Builder::new()
            .name(format!("meetingrelay-summary-{}", job.attempt))
            .spawn(move || {
                let progress_state = Arc::clone(&state);
                let progress_job_id = thread_job.job_id.clone();
                let source_segment_ids = request
                    .segments
                    .iter()
                    .map(|segment| segment.segment_id.clone())
                    .collect::<Vec<_>>();
                let outcome = run_summary(&config, request, &cancellation, move |progress| {
                    let mut current = lock(&progress_state);
                    if current.job_id == progress_job_id && current.status != "cancelled" {
                        apply_summary_progress(&mut current, &progress);
                    }
                });
                finish_summary_run(
                    &thread_writer,
                    &thread_job,
                    outcome,
                    &cancellation,
                    &state,
                    &source_segment_ids,
                );
                active.store(false, Ordering::Release);
            });
        if spawn.is_err() {
            self.summary_active.store(false, Ordering::Release);
            let _ = writer.fail_summary_job(&job.job_id, "SUMMARY_WORKER_START_FAILED", true);
            let mut state = lock(&self.summary_state);
            state.status = "failed".to_owned();
            state.can_cancel = false;
            state.can_retry = true;
            state.message = Some("SUMMARY_WORKER_START_FAILED".to_owned());
            return Err("SUMMARY_WORKER_START_FAILED".to_owned());
        }
        Ok(queued)
    }

    fn provider_api_key(&self, provider_profile_id: &str) -> Result<Option<String>, String> {
        let secret_id = provider_secret_id(provider_profile_id)?;
        let mut bytes = match self
            .secret_store
            .get(&secret_id)
            .map_err(|_| "SECRET_STORE_READ_FAILED".to_owned())?
        {
            Some(bytes) => bytes,
            None => return Ok(None),
        };
        let secret = String::from_utf8(bytes.clone())
            .map_err(|_| "SECRET_STORE_VALUE_INVALID".to_owned())?;
        bytes.fill(0);
        Ok(Some(secret))
    }

    fn resolve_translation_config(
        &self,
        mut requested: TranslationConfig,
        provider_profile_id: Option<&str>,
    ) -> Result<TranslationConfig, String> {
        requested.api_key = None;
        if !requested.enabled {
            return Ok(requested);
        }
        let provider_profile_id = provider_profile_id
            .ok_or_else(|| "TRANSLATION_PROVIDER_PROFILE_REQUIRED".to_owned())?;
        let storage = self
            .storage
            .as_ref()
            .ok_or_else(|| "MVP_STORAGE_UNAVAILABLE".to_owned())?;
        let profile = storage
            .provider_profile_latest(provider_profile_id)?
            .ok_or_else(|| "PROVIDER_PROFILE_NOT_FOUND".to_owned())?;
        if profile.provider_class == "local" {
            validate_local_translation_base_url(profile.base_url.as_deref().unwrap_or_default())?;
        }
        let config = TranslationConfig {
            enabled: true,
            base_url: profile.base_url.unwrap_or_default(),
            model: profile.model,
            api_key: if profile.provider_class == "local" {
                None
            } else {
                self.provider_api_key(provider_profile_id)?
            },
            target_language: requested.target_language,
            allow_insecure_http: profile.provider_class == "lan",
        };
        config.validate_enabled()?;
        Ok(config)
    }

    pub fn snapshot(&self) -> MvpSnapshot {
        let inner = lock(&self.inner);
        #[cfg(windows)]
        let mut snapshot = { self.snapshot_locked(&inner) };
        #[cfg(not(windows))]
        let mut snapshot = {
            let mut snapshot = lock(&self.snapshot).clone();
            snapshot.enforce_bounds();
            snapshot
        };
        snapshot.translation_queue_depth = lock(&self.translation)
            .as_ref()
            .map_or(0, TranslationWorker::queue_depth);
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
            None,
        )
    }

    #[cfg(test)]
    pub fn start_with_devices_and_language(
        &self,
        consent_accepted: bool,
        selection: AudioDeviceSelection,
        language: &str,
        translation: Option<TranslationConfig>,
    ) -> Result<MvpSnapshot, String> {
        self.start_with_devices_language_and_audio_mode(
            consent_accepted,
            selection,
            language,
            translation,
            None,
            AudioSourceMode::default(),
            false,
        )
    }

    #[cfg(test)]
    #[allow(clippy::too_many_arguments)]
    pub fn start_with_devices_language_and_audio_mode(
        &self,
        consent_accepted: bool,
        selection: AudioDeviceSelection,
        language: &str,
        translation: Option<TranslationConfig>,
        translation_provider_profile_id: Option<&str>,
        audio_source_mode: AudioSourceMode,
        raw_audio_enabled: bool,
    ) -> Result<MvpSnapshot, String> {
        self.start_with_devices_language_audio_mode_model_and_live_text(
            consent_accepted,
            selection,
            language,
            None,
            translation,
            translation_provider_profile_id,
            audio_source_mode,
            raw_audio_enabled,
            None,
        )
    }

    #[allow(clippy::too_many_arguments)]
    #[allow(dead_code)]
    pub fn start_with_devices_language_audio_mode_and_model(
        &self,
        consent_accepted: bool,
        selection: AudioDeviceSelection,
        language: &str,
        asr_model_id: Option<&str>,
        translation: Option<TranslationConfig>,
        translation_provider_profile_id: Option<&str>,
        audio_source_mode: AudioSourceMode,
        raw_audio_enabled: bool,
    ) -> Result<MvpSnapshot, String> {
        self.start_with_devices_language_audio_mode_model_and_live_text(
            consent_accepted,
            selection,
            language,
            asr_model_id,
            translation,
            translation_provider_profile_id,
            audio_source_mode,
            raw_audio_enabled,
            None,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn start_with_devices_language_audio_mode_model_and_live_text(
        &self,
        consent_accepted: bool,
        selection: AudioDeviceSelection,
        language: &str,
        asr_model_id: Option<&str>,
        translation: Option<TranslationConfig>,
        translation_provider_profile_id: Option<&str>,
        audio_source_mode: AudioSourceMode,
        raw_audio_enabled: bool,
        live_text_directory: Option<&str>,
    ) -> Result<MvpSnapshot, String> {
        if !consent_accepted {
            return Err("CONSENT_REQUIRED".to_owned());
        }
        let language = RecognitionLanguage::parse(language)?;
        let asr_model = resolve_asr_model(asr_model_id, language.code())?;
        let translation = self.resolve_translation_config(
            translation.unwrap_or_default(),
            translation_provider_profile_id,
        )?;

        #[cfg(windows)]
        {
            self.start_windows(
                selection,
                language,
                asr_model,
                translation,
                audio_source_mode,
                raw_audio_enabled,
                live_text_directory,
            )
        }
        #[cfg(not(windows))]
        {
            let _ = (
                selection,
                language,
                asr_model,
                translation,
                audio_source_mode,
                raw_audio_enabled,
                live_text_directory,
            );
            Err("MVP_WINDOWS_ONLY".to_owned())
        }
    }

    pub fn prepare_language_model(
        &self,
        language: &str,
        asr_model_id: Option<&str>,
    ) -> Result<MvpSnapshot, String> {
        let language = RecognitionLanguage::parse(language)?;
        let asr_model = resolve_asr_model(asr_model_id, language.code())?;
        #[cfg(windows)]
        {
            self.prepare_language_windows(language, asr_model)
        }
        #[cfg(not(windows))]
        {
            let _ = (language, asr_model);
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

    pub fn export_meeting_options(
        &self,
        meeting_id: &str,
        target_dir: String,
        mut options: ExportOptions,
    ) -> Result<ExportResult, String> {
        let storage = self
            .storage
            .as_ref()
            .ok_or_else(|| "MVP_STORAGE_UNAVAILABLE".to_owned())?;
        let writer = self
            .storage_writer
            .as_ref()
            .ok_or_else(|| storage_error_from_snapshot(&self.snapshot))?;
        let requested_summary_version = options.summary_version;
        options.summary = None;
        options.summary_version = None;
        if options.include_summary {
            let job = match requested_summary_version {
                Some(version) => Some(
                    storage
                        .summary_job_for_meeting_version(meeting_id, version)?
                        .ok_or_else(|| "SUMMARY_VERSION_NOT_FOUND".to_owned())?,
                ),
                None => storage.latest_summary_job_for_meeting(meeting_id)?,
            };
            if let Some(job) = job {
                if job.status != "completed" {
                    if requested_summary_version.is_some() {
                        return Err("SUMMARY_VERSION_NOT_COMPLETED".to_owned());
                    }
                } else {
                    let records = storage.summary_results(&job.job_id)?;
                    options.summary_version = Some(job.attempt.max(1));
                    options.summary = Some(ExportSummary {
                        version: options.summary_version,
                        sections: records
                            .into_iter()
                            .map(|record| ExportSummarySection {
                                kind: Some(record.section_kind),
                                heading: Some(record.heading),
                                text: record.text,
                                citation_segment_ids: record.citation_segment_ids,
                            })
                            .collect(),
                    });
                }
            }
        }
        export_meeting_with_options(storage, writer, meeting_id, target_dir, options)
    }

    pub fn transcript_text(&self, meeting_id: &str) -> Result<String, String> {
        let storage = self
            .storage
            .as_ref()
            .ok_or_else(|| "MVP_STORAGE_UNAVAILABLE".to_owned())?;
        transcript_text(storage, meeting_id)
    }

    pub fn diarize_speakers(&self, meeting_id: &str) -> Result<SpeakerDiarizationResult, String> {
        let storage = self
            .storage
            .as_ref()
            .ok_or_else(|| "MVP_STORAGE_UNAVAILABLE".to_owned())?;
        let writer = self
            .storage_writer
            .as_ref()
            .ok_or_else(|| storage_error_from_snapshot(&self.snapshot))?;
        let snapshot = storage.snapshot(meeting_id)?;
        if matches!(snapshot.meeting.state.as_str(), "recording" | "paused") {
            return Err("SPEAKER_MEETING_ACTIVE".to_owned());
        }
        let draft = match self.raw_audio_manifest(meeting_id) {
            Ok(Some(manifest)) => match draft_from_raw_audio(&manifest, &snapshot.finals) {
                Ok(Some(draft)) => draft,
                Ok(None) => {
                    return Ok(SpeakerDiarizationResult {
                        meeting_id: meeting_id.to_owned(),
                        version: None,
                        status: "skipped".to_owned(),
                        reason: Some("SPEAKER_NO_FINALS".to_owned()),
                    });
                }
                Err(error) => {
                    return Ok(SpeakerDiarizationResult {
                        meeting_id: meeting_id.to_owned(),
                        version: None,
                        status: "failed".to_owned(),
                        reason: Some(error),
                    });
                }
            },
            Ok(None) => {
                return Ok(SpeakerDiarizationResult {
                    meeting_id: meeting_id.to_owned(),
                    version: None,
                    status: "unavailable".to_owned(),
                    reason: Some("SPEAKER_RAW_AUDIO_REQUIRED".to_owned()),
                });
            }
            Err(error) => {
                return Ok(SpeakerDiarizationResult {
                    meeting_id: meeting_id.to_owned(),
                    version: None,
                    status: "failed".to_owned(),
                    reason: Some(error),
                });
            }
        };
        let version = writer.record_speaker_version(meeting_id, draft)?;
        Ok(SpeakerDiarizationResult {
            meeting_id: meeting_id.to_owned(),
            version: Some(version.version),
            status: "completed".to_owned(),
            reason: None,
        })
    }

    pub fn latest_speaker_version(
        &self,
        meeting_id: &str,
    ) -> Result<Option<SpeakerVersionSnapshot>, String> {
        let storage = self
            .storage
            .as_ref()
            .ok_or_else(|| "MVP_STORAGE_UNAVAILABLE".to_owned())?;
        storage.latest_speaker_version(meeting_id)
    }

    pub fn speaker_version(
        &self,
        meeting_id: &str,
        version: u32,
    ) -> Result<Option<SpeakerVersionSnapshot>, String> {
        let storage = self
            .storage
            .as_ref()
            .ok_or_else(|| "MVP_STORAGE_UNAVAILABLE".to_owned())?;
        storage.speaker_version(meeting_id, version)
    }

    pub fn rename_speaker(
        &self,
        request: SpeakerRenameRequest,
    ) -> Result<SpeakerVersionSnapshot, String> {
        let storage = self
            .storage
            .as_ref()
            .ok_or_else(|| "MVP_STORAGE_UNAVAILABLE".to_owned())?;
        let writer = self
            .storage_writer
            .as_ref()
            .ok_or_else(|| storage_error_from_snapshot(&self.snapshot))?;
        ensure_speaker_meeting_inactive(storage, &request.meeting_id)?;
        let current = storage
            .speaker_version(&request.meeting_id, request.base_version)?
            .ok_or_else(|| "SPEAKER_VERSION_NOT_FOUND".to_owned())?;
        let draft = rename_draft(&current, &request)?;
        writer.record_speaker_version(&request.meeting_id, draft)
    }

    pub fn merge_speakers(
        &self,
        request: SpeakerMergeRequest,
    ) -> Result<SpeakerVersionSnapshot, String> {
        let storage = self
            .storage
            .as_ref()
            .ok_or_else(|| "MVP_STORAGE_UNAVAILABLE".to_owned())?;
        let writer = self
            .storage_writer
            .as_ref()
            .ok_or_else(|| storage_error_from_snapshot(&self.snapshot))?;
        ensure_speaker_meeting_inactive(storage, &request.meeting_id)?;
        let current = storage
            .speaker_version(&request.meeting_id, request.base_version)?
            .ok_or_else(|| "SPEAKER_VERSION_NOT_FOUND".to_owned())?;
        let draft = merge_draft(&current, &request)?;
        writer.record_speaker_version(&request.meeting_id, draft)
    }

    pub fn undo_speaker_edit(
        &self,
        request: SpeakerUndoRequest,
    ) -> Result<SpeakerVersionSnapshot, String> {
        let storage = self
            .storage
            .as_ref()
            .ok_or_else(|| "MVP_STORAGE_UNAVAILABLE".to_owned())?;
        let writer = self
            .storage_writer
            .as_ref()
            .ok_or_else(|| storage_error_from_snapshot(&self.snapshot))?;
        ensure_speaker_meeting_inactive(storage, &request.meeting_id)?;
        let current = storage
            .speaker_version(&request.meeting_id, request.base_version)?
            .ok_or_else(|| "SPEAKER_VERSION_NOT_FOUND".to_owned())?;
        let parent_version = current
            .parent_version
            .ok_or_else(|| "SPEAKER_UNDO_NOT_AVAILABLE".to_owned())?;
        let parent = storage
            .speaker_version(&request.meeting_id, parent_version)?
            .ok_or_else(|| "SPEAKER_VERSION_NOT_FOUND".to_owned())?;
        let draft = undo_draft(&current, &parent, &request)?;
        writer.record_speaker_version(&request.meeting_id, draft)
    }

    fn raw_audio_manifest(&self, meeting_id: &str) -> Result<Option<RawAudioManifest>, String> {
        let storage = self
            .storage
            .as_ref()
            .ok_or_else(|| "MVP_STORAGE_UNAVAILABLE".to_owned())?;
        let data_root = storage
            .default_export_dir()
            .parent()
            .map(Path::to_path_buf)
            .ok_or_else(|| "MVP_STORAGE_ROOT_UNAVAILABLE".to_owned())?;
        RawAudioStore::new(RawAudioConfig {
            enabled: true,
            root_dir: data_root,
            quota_bytes: None,
            retention: RawAudioRetentionPolicy::NeverAutoDelete,
        })
        .load_manifest(meeting_id)
        .map_err(|error| match error {
            RawAudioError::InvalidMeetingId => "RAW_AUDIO_MANIFEST_INVALID".to_owned(),
            RawAudioError::InvalidPacket(_) => "RAW_AUDIO_MANIFEST_INVALID".to_owned(),
            RawAudioError::Json(_) => "RAW_AUDIO_MANIFEST_INVALID".to_owned(),
            RawAudioError::Io(_) => "RAW_AUDIO_MANIFEST_READ_FAILED".to_owned(),
            RawAudioError::SourceFormatChanged { .. } | RawAudioError::QuotaExceeded { .. } => {
                "RAW_AUDIO_MANIFEST_INVALID".to_owned()
            }
        })
    }

    pub fn retry_translation_segment(
        &self,
        meeting_id: &str,
        segment_id: &str,
        sequence: &str,
        source_language: &str,
        config: TranslationConfig,
        provider_profile_id: &str,
    ) -> Result<MvpSnapshot, String> {
        let config = self
            .resolve_translation_config(config, Some(provider_profile_id))?
            .validate_enabled()?;
        let sequence = sequence
            .parse::<u64>()
            .map_err(|_| "TRANSLATION_RETRY_SEGMENT_INVALID".to_owned())?;
        let storage = self
            .storage
            .as_ref()
            .ok_or_else(|| "MVP_STORAGE_UNAVAILABLE".to_owned())?;
        let writer = self
            .storage_writer
            .as_ref()
            .ok_or_else(|| storage_error_from_snapshot(&self.snapshot))?;
        let meeting = storage.snapshot(meeting_id)?;
        let final_segment = meeting
            .finals
            .iter()
            .find(|item| item.segment_id == segment_id && item.sequence == sequence)
            .cloned()
            .ok_or_else(|| "TRANSLATION_RETRY_SEGMENT_MISSING".to_owned())?;
        retry_one_translation(writer, &final_segment, source_language, &config)?;
        self.apply_meeting_snapshot(writer.open_meeting(meeting_id)?)
    }

    pub fn retry_failed_translations(
        &self,
        meeting_id: &str,
        source_language: &str,
        config: TranslationConfig,
        provider_profile_id: &str,
        cost_risk_accepted: bool,
    ) -> Result<TranslationRetryProgressSnapshot, String> {
        if lock(&self.retry_progress).status == "running" {
            return Err("TRANSLATION_RETRY_ALREADY_RUNNING".to_owned());
        }
        let config = self
            .resolve_translation_config(config, Some(provider_profile_id))?
            .validate_enabled()?;
        let storage = self
            .storage
            .as_ref()
            .ok_or_else(|| "MVP_STORAGE_UNAVAILABLE".to_owned())?
            .clone();
        let writer = Arc::clone(
            self.storage_writer
                .as_ref()
                .ok_or_else(|| storage_error_from_snapshot(&self.snapshot))?,
        );
        let plan = storage.failed_translation_retry_plan(meeting_id, cost_risk_accepted)?;
        let meeting = storage.snapshot(meeting_id)?;
        let mut finals = Vec::new();
        for item in plan
            .items
            .iter()
            .filter(|item| item.retryable && item.target_language == config.target_language)
        {
            if let Some(final_segment) = meeting.finals.iter().find(|final_segment| {
                final_segment.segment_id == item.segment_id
                    && final_segment.revision == item.source_revision
            }) {
                finals.push(final_segment.clone());
            }
        }
        if finals.is_empty() {
            return Err("TRANSLATION_RETRY_NOTHING_RETRYABLE".to_owned());
        }

        let batch_id = format!("retry-{}", super::storage::now_ms_string());
        let initial = TranslationRetryProgressSnapshot {
            batch_id: Some(batch_id),
            status: "running".to_owned(),
            total: finals.len(),
            progress: 0,
            succeeded: 0,
            failed: 0,
            cancelled: 0,
            cost_risk_accepted: true,
            message: (plan.non_retryable > 0).then(|| {
                format!(
                    "{} non-retryable failures were excluded",
                    plan.non_retryable
                )
            }),
        };
        *lock(&self.retry_progress) = initial.clone();
        self.retry_cancel.store(false, Ordering::Release);

        let progress = Arc::clone(&self.retry_progress);
        let cancelled = Arc::clone(&self.retry_cancel);
        let source_language = source_language.to_owned();
        let meeting_id = meeting_id.to_owned();
        let spawn = std::thread::Builder::new()
            .name("meetingrelay-translation-retry".to_owned())
            .spawn(move || {
                for (index, final_segment) in finals.iter().enumerate() {
                    if cancelled.load(Ordering::Acquire) {
                        let mut state = lock(&progress);
                        state.cancelled = state.total.saturating_sub(state.progress);
                        state.status = "cancelled".to_owned();
                        state.message = Some("Translation retry batch cancelled.".to_owned());
                        return;
                    }
                    let succeeded =
                        retry_one_translation(&writer, final_segment, &source_language, &config)
                            .is_ok();
                    let mut state = lock(&progress);
                    state.progress = index + 1;
                    if succeeded {
                        state.succeeded += 1;
                    } else {
                        state.failed += 1;
                    }
                }
                let mut state = lock(&progress);
                state.status = if state.succeeded == 0 && state.failed > 0 {
                    "failed".to_owned()
                } else {
                    "completed".to_owned()
                };
                state.message = Some(format!(
                    "Meeting {meeting_id}: {} succeeded, {} failed.",
                    state.succeeded, state.failed
                ));
            });
        if spawn.is_err() {
            let mut progress = lock(&self.retry_progress);
            progress.status = "failed".to_owned();
            progress.failed = progress.total;
            progress.progress = progress.total;
            progress.message = Some("TRANSLATION_RETRY_WORKER_START_FAILED".to_owned());
            return Err("TRANSLATION_RETRY_WORKER_START_FAILED".to_owned());
        }
        Ok(initial)
    }

    pub fn translation_retry_progress(&self) -> TranslationRetryProgressSnapshot {
        lock(&self.retry_progress).clone()
    }

    pub fn cancel_translation_batch(&self) -> TranslationRetryProgressSnapshot {
        self.retry_cancel.store(true, Ordering::Release);
        let mut progress = lock(&self.retry_progress);
        if progress.status == "running" {
            progress.message = Some("Translation retry cancellation requested.".to_owned());
        }
        progress.clone()
    }

    pub fn interrupted_meetings(
        &self,
    ) -> Result<Vec<super::storage::InterruptedMeetingRecord>, String> {
        self.storage
            .as_ref()
            .ok_or_else(|| "MVP_STORAGE_UNAVAILABLE".to_owned())?
            .interrupted_meetings()
    }

    pub fn recover_meeting(&self, meeting_id: &str) -> Result<MvpSnapshot, String> {
        self.apply_recovery_action(meeting_id, RecoveryActionKind::Recover)
    }

    pub fn finalize_interrupted(&self, meeting_id: &str) -> Result<MvpSnapshot, String> {
        self.apply_recovery_action(meeting_id, RecoveryActionKind::Finalize)
    }

    pub fn keep_interrupted(&self, meeting_id: &str) -> Result<MvpSnapshot, String> {
        self.apply_recovery_action(meeting_id, RecoveryActionKind::KeepInterrupted)
    }

    fn apply_recovery_action(
        &self,
        meeting_id: &str,
        action: RecoveryActionKind,
    ) -> Result<MvpSnapshot, String> {
        #[cfg(windows)]
        if history_open_blocked(&lock(&self.inner), &self.snapshot) {
            return Err("SESSION_ACTIVE".to_owned());
        }
        let writer = self
            .storage_writer
            .as_ref()
            .ok_or_else(|| storage_error_from_snapshot(&self.snapshot))?;
        let meeting = writer.open_meeting(meeting_id)?;
        let recovered_manifest = if action != RecoveryActionKind::KeepInterrupted {
            self.raw_audio_store(RawAudioRetentionPolicy::NeverAutoDelete)?
                .recover_interrupted_meeting(meeting_id)
                .map_err(|error| public_raw_audio_policy_error(&error))?
        } else {
            None
        };
        if action == RecoveryActionKind::Recover {
            self.apply_meeting_snapshot(meeting.clone())?;
            #[cfg(windows)]
            if let Some(manifest) = recovered_manifest.as_ref() {
                let last_sample = meeting
                    .finals
                    .last()
                    .map_or(0, |final_segment| final_segment.meeting_sample_end);
                let model_label = self
                    .storage
                    .as_ref()
                    .ok_or_else(|| "MVP_STORAGE_UNAVAILABLE".to_owned())?
                    .meeting_model_label(meeting_id)?;
                let language = RecognitionLanguage::from_model_label(&model_label);
                let asr_model = resolve_asr_model_from_label(&model_label, language.code())?;
                self.recover_raw_tail(meeting_id, manifest, last_sample, language, asr_model)?;
            }
        }
        writer.record_recovery_action(meeting_id, action)?;
        self.apply_meeting_snapshot(writer.open_meeting(meeting_id)?)
    }

    #[cfg(windows)]
    fn recover_raw_tail(
        &self,
        meeting_id: &str,
        manifest: &RawAudioManifest,
        last_saved_sample: u64,
        language: RecognitionLanguage,
        asr_model: AsrModelProfile,
    ) -> Result<(), String> {
        let tail_end = manifest
            .sources
            .iter()
            .map(|source| source.meeting_sample_end)
            .max()
            .unwrap_or(last_saved_sample);
        if tail_end <= last_saved_sample {
            return Ok(());
        }

        let submitter = {
            let mut inner = lock(&self.inner);
            self.ensure_inference_worker(&mut inner, language, &asr_model)?;
            let inference = inner
                .inference
                .as_ref()
                .ok_or_else(|| "ASR_WORKER_START_FAILED".to_owned())?;
            inference.submitter.shared.seed_durable_sequence(
                self.storage
                    .as_ref()
                    .ok_or_else(|| "MVP_STORAGE_UNAVAILABLE".to_owned())?
                    .snapshot(meeting_id)?
                    .meeting
                    .last_final_sequence,
            );
            inference.submitter()
        };
        let errors = Arc::new(RuntimeErrors::default());
        let mut endpoint = EnergyEndpointSegmenter::new();
        let mut packetizer = BlockPacketizer::new();
        let mut blocks = Vec::new();
        let mut window_start = last_saved_sample;

        while window_start < tail_end {
            let window_end = window_start
                .saturating_add(RECOVERY_WINDOW_SAMPLES)
                .min(tail_end);
            let samples = read_mixed_window_16khz(manifest, window_start, window_end)
                .map_err(|error| public_raw_audio_policy_error(&error))?;
            blocks.clear();
            packetizer.push(&samples, &mut blocks);
            for block in blocks.drain(..) {
                if let Some(event) = endpoint.push_block(&block) {
                    submit_recovery_event(
                        event,
                        last_saved_sample,
                        meeting_id,
                        &submitter,
                        &errors,
                    )?;
                }
            }
            window_start = window_end;
        }
        if let Some(block) = packetizer.flush_padded()
            && let Some(event) = endpoint.push_block(&block)
        {
            submit_recovery_event(event, last_saved_sample, meeting_id, &submitter, &errors)?;
        }
        if let Some(event) = endpoint.flush_stop() {
            submit_recovery_event(event, last_saved_sample, meeting_id, &submitter, &errors)?;
        }
        errors.completion_error().map_or(Ok(()), Err)
    }

    pub fn locate_segment_audio(
        &self,
        meeting_id: &str,
        segment_id: &str,
        sequence: &str,
    ) -> Result<SegmentAudioLocation, String> {
        let storage = self
            .storage
            .as_ref()
            .ok_or_else(|| "MVP_STORAGE_UNAVAILABLE".to_owned())?;
        let sequence = sequence
            .parse::<u64>()
            .map_err(|_| "MVP_AUDIO_LOCATION_SEGMENT_INVALID".to_owned())?;
        let meeting = storage.snapshot(meeting_id)?;
        let final_segment = meeting
            .finals
            .iter()
            .find(|item| item.segment_id == segment_id && item.sequence == sequence)
            .ok_or_else(|| "MVP_AUDIO_LOCATION_SEGMENT_MISSING".to_owned())?;
        let data_root = storage
            .default_export_dir()
            .parent()
            .map(Path::to_path_buf)
            .ok_or_else(|| "MVP_STORAGE_ROOT_UNAVAILABLE".to_owned())?;
        let manifest_path = data_root
            .join("derived")
            .join(meeting_id)
            .join("raw-audio-manifest.json");
        let bytes = match fs::read(&manifest_path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(SegmentAudioLocation {
                    available: false,
                    path: None,
                    offset_ms: None,
                    duration_ms: None,
                    reason: Some("RAW_AUDIO_DISABLED_OR_MISSING".to_owned()),
                });
            }
            Err(_) => return Err("RAW_AUDIO_MANIFEST_READ_FAILED".to_owned()),
        };
        let manifest: super::raw_audio::RawAudioManifest =
            serde_json::from_slice(&bytes).map_err(|_| "RAW_AUDIO_MANIFEST_INVALID".to_owned())?;
        let source = manifest
            .sources
            .iter()
            .find(|source| {
                final_segment.meeting_sample_start >= source.meeting_sample_start
                    && final_segment.meeting_sample_end <= source.meeting_sample_end
                    && source.path.is_file()
            })
            .or_else(|| manifest.sources.iter().find(|source| source.path.is_file()));
        let Some(source) = source else {
            return Ok(SegmentAudioLocation {
                available: false,
                path: None,
                offset_ms: None,
                duration_ms: None,
                reason: Some("RAW_AUDIO_SOURCE_MISSING".to_owned()),
            });
        };
        let offset_ms = final_segment.meeting_sample_start.saturating_mul(1_000) / 16_000;
        let duration_ms = final_segment
            .meeting_sample_end
            .saturating_sub(final_segment.meeting_sample_start)
            .saturating_mul(1_000)
            / 16_000;
        Ok(SegmentAudioLocation {
            available: true,
            path: Some(source.path.to_string_lossy().into_owned()),
            offset_ms: Some(offset_ms.to_string()),
            duration_ms: Some(duration_ms.max(1).to_string()),
            reason: None,
        })
    }

    pub fn create_diagnostic_bundle(&self) -> Result<DiagnosticBundleResult, String> {
        let storage = self
            .storage
            .as_ref()
            .ok_or_else(|| "MVP_STORAGE_UNAVAILABLE".to_owned())?;
        let snapshot = self.snapshot();
        let summary = lock(&self.summary_state).clone();
        let provider_versions = [
            "openai-compatible/meetingrelay.translation.config.v1",
            "openai-compatible/meetingrelay.summary.prompt.v1",
            "meetingrelay.document-export.v1",
        ];
        let mut recent_errors = snapshot.error.clone().into_iter().collect::<Vec<_>>();
        if matches!(summary.status.as_str(), "failed" | "cancelled")
            && let Some(message) = summary.message.as_deref()
        {
            recent_errors.push(message.to_owned());
        }
        let database_status = match storage.diagnostic_health() {
            Ok(status) => status,
            Err(error) => {
                recent_errors.push(error);
                "error".to_owned()
            }
        };
        let mut providers = Vec::new();
        match storage.provider_profiles_latest() {
            Ok(records) => {
                for profile in records {
                    let secret_state = match self.provider_secret_state(&profile) {
                        Ok(state) => state,
                        Err(error) => {
                            recent_errors.push(error);
                            "unavailable".to_owned()
                        }
                    };
                    if let Some(error) = profile.last_error.as_deref() {
                        recent_errors.push(error.to_owned());
                    }
                    providers.push(serde_json::json!({
                        "profileId": super::storage::sanitize_diagnostic_value(&profile.profile_id),
                        "class": super::storage::sanitize_diagnostic_value(&profile.provider_class),
                        "configVersion": profile.config_version,
                        "model": super::storage::sanitize_diagnostic_value(&profile.model),
                        "endpointHash": super::storage::sanitize_diagnostic_value(&profile.endpoint_hash),
                        "secretState": super::storage::sanitize_diagnostic_value(&secret_state),
                        "lastTestStatus": profile
                            .last_test_status
                            .as_deref()
                            .map(super::storage::sanitize_diagnostic_value),
                        "lastTestAt": profile
                            .last_test_at
                            .as_deref()
                            .map(super::storage::sanitize_diagnostic_value),
                        "lastError": profile
                            .last_error
                            .as_deref()
                            .map(super::storage::sanitize_diagnostic_value),
                    }));
                }
            }
            Err(error) => recent_errors.push(error),
        }
        recent_errors.sort();
        recent_errors.dedup();
        recent_errors.truncate(32);
        let sanitized_errors = recent_errors
            .iter()
            .map(|error| super::storage::sanitize_diagnostic_value(error))
            .collect::<Vec<_>>();
        let error_refs = sanitized_errors
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>();
        let diagnostic = super::storage::sanitized_diagnostic_bundle(
            Some(&snapshot.model_label),
            &provider_versions,
            super::storage::STORAGE_QUEUE_DEPTH,
            snapshot.translation_queue_depth,
            snapshot.disk.warning.as_deref(),
            &error_refs,
        );
        let secret_store_status = match self.secret_store.status() {
            Ok(SecretStoreStatus::Available) => "available",
            Ok(SecretStoreStatus::Unsupported) => "unsupported",
            Err(_) => "error",
        };
        let bytes = serde_json::to_vec_pretty(&serde_json::json!({
            "redacted": true,
            "generatedAt": super::storage::now_ms_string(),
            "diagnostic": diagnostic,
            "database": {
                "status": database_status,
                "schemaVersion": super::storage::MVP_SCHEMA_VERSION,
                "schemaChecksum": super::storage::MVP_SCHEMA_CHECKSUM,
                "readProbe": database_status == "ok",
            },
            "disk": {
                "status": super::storage::sanitize_diagnostic_value(&snapshot.disk.status),
                "freeBytes": snapshot.disk.free_bytes,
                "requiredBytes": snapshot.disk.required_bytes,
                "warning": snapshot
                    .disk
                    .warning
                    .as_deref()
                    .map(super::storage::sanitize_diagnostic_value),
            },
            "queues": {
                "storageCapacity": super::storage::STORAGE_QUEUE_DEPTH,
                "inferenceDepth": snapshot.queue_depth,
                "inferenceCapacity": super::contract::MAX_INFERENCE_QUEUE_DEPTH,
                "translationDepth": snapshot.translation_queue_depth,
                "summaryActive": self.summary_active.load(Ordering::Acquire),
                "summaryStatus": super::storage::sanitize_diagnostic_value(&summary.status),
            },
            "runtime": {
                "os": std::env::consts::OS,
                "architecture": std::env::consts::ARCH,
                "appVersion": env!("CARGO_PKG_VERSION"),
                "contractVersion": super::contract::MVP_CONTRACT_VERSION,
                "lifecycle": format!("{:?}", snapshot.lifecycle).to_ascii_lowercase(),
                "durabilityStatus": super::storage::sanitize_diagnostic_value(
                    &snapshot.durability_status
                ),
                "audioSourceMode": super::storage::sanitize_diagnostic_value(
                    &snapshot.audio_source_mode
                ),
                "localOnly": snapshot.local_only,
                "memoryOnly": snapshot.memory_only,
                "secretStore": {
                    "backend": if cfg!(windows) {
                        "windows-credential-manager"
                    } else {
                        "unsupported"
                    },
                    "status": secret_store_status,
                },
            },
            "model": {
                "ready": snapshot.model_ready,
                "label": super::storage::sanitize_diagnostic_value(&snapshot.model_label),
            },
            "providers": providers,
            "recentErrors": sanitized_errors,
        }))
        .map_err(|_| "MVP_DIAGNOSTIC_SERIALIZE_FAILED".to_owned())?;
        let lower = String::from_utf8_lossy(&bytes).to_ascii_lowercase();
        if ["authorization", "bearer ", "api_key", "apikey", "token="]
            .iter()
            .any(|marker| lower.contains(marker))
        {
            return Err("MVP_DIAGNOSTIC_REDACTION_FAILED".to_owned());
        }
        let directory = storage
            .default_export_dir()
            .parent()
            .map(|parent| parent.join("diagnostics"))
            .ok_or_else(|| "MVP_STORAGE_ROOT_UNAVAILABLE".to_owned())?;
        fs::create_dir_all(&directory).map_err(|_| "MVP_DIAGNOSTIC_DIRECTORY_FAILED".to_owned())?;
        let path = directory.join(format!(
            "meetingrelay-diagnostic-{}.json",
            super::storage::now_ms_string()
        ));
        let temporary = path.with_extension("json.tmp");
        let mut file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
            .map_err(|_| "MVP_DIAGNOSTIC_WRITE_FAILED".to_owned())?;
        file.write_all(&bytes)
            .and_then(|()| file.sync_all())
            .map_err(|_| "MVP_DIAGNOSTIC_WRITE_FAILED".to_owned())?;
        fs::rename(&temporary, &path).map_err(|_| "MVP_DIAGNOSTIC_WRITE_FAILED".to_owned())?;
        Ok(DiagnosticBundleResult {
            path: path.to_string_lossy().into_owned(),
            byte_length: bytes.len(),
            sha256: super::storage::sha256_hex(&bytes),
            redacted: true,
        })
    }

    pub fn raw_audio_delete_preview(
        &self,
        meeting_id: &str,
    ) -> Result<Option<super::raw_audio::RawAudioDeletePreview>, String> {
        self.raw_audio_store(RawAudioRetentionPolicy::NeverAutoDelete)?
            .delete_preview(meeting_id)
            .map_err(|error| public_raw_audio_policy_error(&error))
    }

    pub fn delete_raw_audio(
        &self,
        meeting_id: &str,
    ) -> Result<Option<super::raw_audio::RawAudioDeletePreview>, String> {
        self.raw_audio_store(RawAudioRetentionPolicy::NeverAutoDelete)?
            .delete_meeting(meeting_id)
            .map_err(|error| public_raw_audio_policy_error(&error))
    }

    pub fn raw_audio_retention_preview(
        &self,
        older_than_days: u32,
    ) -> Result<Vec<super::raw_audio::RawAudioDeletePreview>, String> {
        if !(1..=3_650).contains(&older_than_days) {
            return Err("RAW_AUDIO_RETENTION_INVALID".to_owned());
        }
        self.raw_audio_store(RawAudioRetentionPolicy::PreviewOnly {
            older_than: std::time::Duration::from_secs(u64::from(older_than_days) * 86_400),
        })?
        .retention_delete_preview(std::time::SystemTime::now())
        .map_err(|error| public_raw_audio_policy_error(&error))
    }

    pub fn delete_preview(
        &self,
        meeting_id: &str,
        include_raw: bool,
        include_derived: bool,
    ) -> Result<DeletePreviewSnapshot, String> {
        let storage = self
            .storage
            .as_ref()
            .ok_or_else(|| "MVP_STORAGE_UNAVAILABLE".to_owned())?;
        let metadata = storage.delete_preview(meeting_id)?;
        let files = self.file_vault()?.preview(meeting_id)?;
        let mut entries = Vec::new();
        let mut bytes = 0_u64;
        for file in files.entries {
            if (file.category == "raw" && !include_raw)
                || (file.category == "derived" && !include_derived)
            {
                continue;
            }
            bytes = bytes.saturating_add(file.byte_length);
            entries.push(DeletePreviewEntrySnapshot {
                entry_type: file.category.clone(),
                path: Some(file.path),
                byte_length: file.byte_length.to_string(),
                description: format!("{} meeting files", file.category),
            });
        }
        if metadata.export_count > 0 {
            entries.push(DeletePreviewEntrySnapshot {
                entry_type: "export".to_owned(),
                path: None,
                byte_length: "0".to_owned(),
                description: format!("{} export record(s)", metadata.export_count),
            });
        }
        if metadata.summary_job_count > 0 {
            entries.push(DeletePreviewEntrySnapshot {
                entry_type: "summary".to_owned(),
                path: None,
                byte_length: "0".to_owned(),
                description: format!("{} summary version(s)", metadata.summary_job_count),
            });
        }
        entries.push(DeletePreviewEntrySnapshot {
            entry_type: "metadata".to_owned(),
            path: None,
            byte_length: "0".to_owned(),
            description: format!(
                "{} final(s), {} translation(s)",
                metadata.final_count, metadata.translation_count
            ),
        });
        Ok(DeletePreviewSnapshot {
            meeting_id: meeting_id.to_owned(),
            recovery_window_seconds: GOVERNANCE_RECOVERY_WINDOW_SECONDS,
            include_raw,
            include_derived,
            entries,
            will_delete_bytes: bytes.to_string(),
            can_restore: true,
        })
    }

    pub fn delete_execute(
        &self,
        meeting_id: &str,
        recovery_window_seconds: u64,
        include_raw: bool,
        include_derived: bool,
    ) -> Result<DeleteResultSnapshot, String> {
        let writer = self
            .storage_writer
            .as_ref()
            .ok_or_else(|| storage_error_from_snapshot(&self.snapshot))?;
        self.delete_execute_with(
            meeting_id,
            recovery_window_seconds,
            include_raw,
            include_derived,
            |file_manifest_json| {
                writer
                    .soft_delete_meeting(meeting_id, file_manifest_json)
                    .map(|_| ())
            },
        )
    }

    fn delete_execute_with(
        &self,
        meeting_id: &str,
        recovery_window_seconds: u64,
        include_raw: bool,
        include_derived: bool,
        persist_delete: impl FnOnce(&str) -> Result<(), String>,
    ) -> Result<DeleteResultSnapshot, String> {
        if recovery_window_seconds != GOVERNANCE_RECOVERY_WINDOW_SECONDS {
            return Err("GOVERNANCE_RECOVERY_WINDOW_INVALID".to_owned());
        }
        let storage = self
            .storage
            .as_ref()
            .ok_or_else(|| "MVP_STORAGE_UNAVAILABLE".to_owned())?;
        let metadata = storage.delete_preview(meeting_id)?;
        let vault = self.file_vault()?;
        let file_tombstone = vault.stage_selected(meeting_id, include_raw, include_derived)?;
        let manifest = file_tombstone.manifest_json()?;
        if let Err(error) = persist_delete(&manifest) {
            return Err(vault.restore(&file_tombstone).err().unwrap_or(error));
        }
        let bytes = file_tombstone.entries.iter().fold(0_u64, |total, entry| {
            total.saturating_add(entry.byte_length)
        });
        let logical_entries = 1
            + usize::from(metadata.export_count > 0)
            + usize::from(metadata.summary_job_count > 0);
        Ok(DeleteResultSnapshot {
            meeting_id: meeting_id.to_owned(),
            deleted: true,
            restored_until: Some(file_tombstone.expires_at),
            entries_deleted: file_tombstone.entries.len() + logical_entries,
            bytes_deleted: bytes.to_string(),
        })
    }

    pub fn delete_restore(&self, meeting_id: &str) -> Result<DeleteResultSnapshot, String> {
        let storage = self
            .storage
            .as_ref()
            .ok_or_else(|| "MVP_STORAGE_UNAVAILABLE".to_owned())?;
        let tombstone = storage
            .tombstone_by_meeting(meeting_id)?
            .ok_or_else(|| "GOVERNANCE_TOMBSTONE_NOT_FOUND".to_owned())?;
        let file_tombstone =
            GovernanceFileTombstone::from_manifest_json(&tombstone.file_manifest_json)?;
        let entries_deleted = file_tombstone.entries.len();
        let bytes_deleted = file_tombstone.entries.iter().fold(0_u64, |total, entry| {
            total.saturating_add(entry.byte_length)
        });
        let vault = self.file_vault()?;
        vault.restore(&file_tombstone)?;
        let writer = self
            .storage_writer
            .as_ref()
            .ok_or_else(|| storage_error_from_snapshot(&self.snapshot))?;
        if let Err(error) = writer.restore_meeting(meeting_id) {
            return Err(vault.restage(&file_tombstone).err().unwrap_or(error));
        }
        Ok(DeleteResultSnapshot {
            meeting_id: meeting_id.to_owned(),
            deleted: false,
            restored_until: None,
            entries_deleted,
            bytes_deleted: bytes_deleted.to_string(),
        })
    }

    pub fn delete_purge(&self, meeting_id: &str) -> Result<DeleteResultSnapshot, String> {
        let storage = self
            .storage
            .as_ref()
            .ok_or_else(|| "MVP_STORAGE_UNAVAILABLE".to_owned())?;
        let tombstone = storage
            .tombstone_by_meeting(meeting_id)?
            .ok_or_else(|| "GOVERNANCE_TOMBSTONE_NOT_FOUND".to_owned())?;
        let file_tombstone =
            GovernanceFileTombstone::from_manifest_json(&tombstone.file_manifest_json)?;
        let bytes_deleted = file_tombstone.entries.iter().fold(0_u64, |total, entry| {
            total.saturating_add(entry.byte_length)
        });
        self.file_vault()?.purge(&file_tombstone)?;
        let writer = self
            .storage_writer
            .as_ref()
            .ok_or_else(|| storage_error_from_snapshot(&self.snapshot))?;
        writer.purge_meeting_metadata(meeting_id)?;
        Ok(DeleteResultSnapshot {
            meeting_id: meeting_id.to_owned(),
            deleted: true,
            restored_until: None,
            entries_deleted: file_tombstone.entries.len().saturating_add(1),
            bytes_deleted: bytes_deleted.to_string(),
        })
    }

    fn file_vault(&self) -> Result<MeetingFileVault, String> {
        let storage = self
            .storage
            .as_ref()
            .ok_or_else(|| "MVP_STORAGE_UNAVAILABLE".to_owned())?;
        let root = storage
            .default_export_dir()
            .parent()
            .map(Path::to_path_buf)
            .ok_or_else(|| "MVP_STORAGE_ROOT_UNAVAILABLE".to_owned())?;
        Ok(MeetingFileVault::new(root))
    }

    fn raw_audio_store(&self, retention: RawAudioRetentionPolicy) -> Result<RawAudioStore, String> {
        let storage = self
            .storage
            .as_ref()
            .ok_or_else(|| "MVP_STORAGE_UNAVAILABLE".to_owned())?;
        let root_dir = storage
            .default_export_dir()
            .parent()
            .map(Path::to_path_buf)
            .ok_or_else(|| "MVP_STORAGE_ROOT_UNAVAILABLE".to_owned())?;
        Ok(RawAudioStore::new(RawAudioConfig {
            enabled: false,
            root_dir,
            quota_bytes: Some(20 * 1024 * 1024 * 1024),
            retention,
        }))
    }

    pub fn shutdown_before(&self, deadline: std::time::Instant) -> Result<(), String> {
        if self.shutdown_started.swap(true, Ordering::AcqRel) {
            return Ok(());
        }

        self.summary_cancel.store(true, Ordering::Release);
        if self.summary_active.load(Ordering::Acquire) {
            let job_id = lock(&self.summary_state).job_id.clone();
            if let Some(writer) = self.storage_writer.as_ref() {
                let _ = writer.cancel_summary_job(&job_id);
            }
        }

        #[cfg(windows)]
        let runtime_error = self.shutdown_windows(deadline).err();
        #[cfg(not(windows))]
        let runtime_error: Option<String> = None;
        let translation_error = lock(&self.translation)
            .take()
            .and_then(|translation| translation.shutdown_before(deadline).err());
        runtime_error.or(translation_error).map_or(Ok(()), Err)
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
        asr_model: &AsrModelProfile,
    ) -> Result<InferenceWorker, String> {
        let profile = if asr_model.model_id == cohere_asr::MODEL_ID {
            RecognizerProfile::Cohere {
                config: CohereAsrConfig::resolve().map_err(|error| error.to_string())?,
                language,
            }
        } else if asr_model.model_id == meetingrelay_model_worker_sherpa_native::MODEL_ID {
            RecognizerProfile::Sherpa {
                paths: resolve_model_paths().inspect_err(|error| self.fail(error))?,
                language,
            }
        } else {
            return Err("ASR_MODEL_NOT_FOUND".to_owned());
        };
        let translation = lock(&self.translation)
            .as_ref()
            .map(TranslationWorker::submitter);
        InferenceWorker::prepare(
            Arc::clone(&self.snapshot),
            profile,
            self.storage_writer.clone(),
            translation,
            Arc::clone(&self.live_text_mirrors),
            language,
            asr_model.model_id.clone(),
        )
        .inspect_err(|error| self.fail(error))
    }

    #[cfg(windows)]
    fn ensure_inference_worker(
        &self,
        inner: &mut ServiceInner,
        language: RecognitionLanguage,
        asr_model: &AsrModelProfile,
    ) -> Result<(), String> {
        let replace = inner.inference.as_ref().is_some_and(|worker| {
            worker.is_finished()
                || worker.language != language
                || worker.model_id != asr_model.model_id
        });
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
            inner.inference = Some(self.prepare_inference_worker(language, asr_model)?);
        }
        Ok(())
    }

    #[cfg(windows)]
    fn preflight_windows(&self) -> Result<MvpSnapshot, String> {
        let inner = lock(&self.inner);
        if inner.session.is_some() {
            return Ok(self.snapshot_locked(&inner));
        }
        if self.storage.is_none() || self.storage_writer.is_none() {
            let error = storage_error_from_snapshot(&self.snapshot);
            self.fail(&error);
            return Err(error);
        }
        let disk = disk_health_for_storage(self.storage.as_ref().expect("checked above"));
        let disk_error = (disk.status == "critical").then(|| {
            disk.warning
                .clone()
                .unwrap_or_else(|| "MVP_DISK_CHECK_FAILED".to_owned())
        });

        {
            let mut snapshot = lock(&self.snapshot);
            snapshot.lifecycle = Lifecycle::Booting;
            snapshot.error = None;
            snapshot.disk = disk;
        }
        if let Some(error) = disk_error {
            self.fail(&error);
            return Err(error);
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

        let mut snapshot = lock(&self.snapshot);
        snapshot.lifecycle = Lifecycle::Ready;
        snapshot.durability_status = "ready".to_owned();
        // Model selection lives in the frontend preference. Preparing the Rust
        // default here made a cold start load SenseVoice and then immediately
        // tear it down when the saved/high-quality model was selected.
        snapshot.model_ready = false;
        snapshot.model_label = "等待准备所选识别模型".to_owned();
        snapshot.system = ready_source(SourceId::System, &devices.system_output);
        snapshot.microphone = ready_source(SourceId::Microphone, &devices.microphone);
        snapshot.error = None;
        Ok(public_snapshot(&mut snapshot, None))
    }

    #[cfg(windows)]
    fn prepare_language_windows(
        &self,
        language: RecognitionLanguage,
        asr_model: AsrModelProfile,
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
            snapshot.model_label = format!("{} · {} · preparing", asr_model.label, language.code());
            snapshot.error = None;
        }
        self.ensure_inference_worker(&mut inner, language, &asr_model)?;
        let mut snapshot = lock(&self.snapshot);
        snapshot.model_ready = true;
        snapshot.model_label = language.model_label(&asr_model);
        snapshot.error = None;
        Ok(public_snapshot(
            &mut snapshot,
            inner.inference.as_ref().map(|worker| &worker.submitter),
        ))
    }

    #[cfg(windows)]
    #[allow(clippy::too_many_arguments)]
    fn start_windows(
        &self,
        selection: AudioDeviceSelection,
        language: RecognitionLanguage,
        asr_model: AsrModelProfile,
        translation_config: TranslationConfig,
        audio_source_mode: AudioSourceMode,
        raw_audio_enabled: bool,
        live_text_directory: Option<&str>,
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
        let disk = disk_health_for_storage(
            self.storage
                .as_ref()
                .ok_or_else(|| "MVP_STORAGE_UNAVAILABLE".to_owned())?,
        );
        if disk.status == "critical" {
            let error = disk
                .warning
                .clone()
                .unwrap_or_else(|| "MVP_DISK_CHECK_FAILED".to_owned());
            lock(&self.snapshot).disk = disk;
            return Err(error);
        }
        lock(&self.snapshot).disk = disk;
        self.ensure_inference_worker(&mut inner, language, &asr_model)?;
        if translation_config.enabled && lock(&self.translation).is_none() {
            return Err("TRANSLATION_WORKER_UNAVAILABLE".to_owned());
        }
        let model_label = language.model_label(&asr_model);
        let meeting = writer.start_meeting_with_metadata(
            true,
            &model_label,
            &format!("Meeting {}", now_ms_string()),
            language.code(),
        )?;
        let raw_audio_writer = if raw_audio_enabled {
            let data_root = self
                .storage
                .as_ref()
                .and_then(|storage| storage.default_export_dir().parent().map(Path::to_path_buf))
                .ok_or_else(|| "MVP_STORAGE_ROOT_UNAVAILABLE".to_owned())?;
            let store = RawAudioStore::new(RawAudioConfig {
                enabled: true,
                root_dir: data_root,
                quota_bytes: Some(20 * 1024 * 1024 * 1024),
                retention: RawAudioRetentionPolicy::NeverAutoDelete,
            });
            match store.begin_meeting(&meeting.id) {
                Ok(raw_writer) => raw_writer,
                Err(error) => {
                    let _ = writer.interrupt_meeting(&meeting.id);
                    return Err(public_raw_audio_error(&error));
                }
            }
        } else {
            None
        };
        if let Some(translation) = lock(&self.translation).as_ref()
            && let Err(error) = translation.submitter().configure_session(
                &meeting.id,
                language.code(),
                &translation_config,
            )
        {
            let _ = writer.interrupt_meeting(&meeting.id);
            return Err(error);
        }
        if let Some(directory) = live_text_directory {
            match LiveTextMirror::begin(Path::new(directory), &meeting.id) {
                Ok(mirror) => {
                    lock(&self.live_text_mirrors).insert(meeting.id.clone(), mirror);
                }
                Err(error) => {
                    if let Some(translation) = lock(&self.translation).as_ref() {
                        translation.submitter().clear_session(&meeting.id);
                    }
                    let _ = writer.interrupt_meeting(&meeting.id);
                    return Err(error);
                }
            }
        }

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
            snapshot.audio_source_mode = audio_source_mode.as_str().to_owned();
            snapshot.raw_audio_enabled = raw_audio_enabled;
            snapshot.system.frames = "0".to_owned();
            snapshot.microphone.frames = "0".to_owned();
        }

        let (capture, output) = AudioCapture::start_with_mode(
            AudioCaptureOptions::default(),
            selection,
            audio_source_mode,
        )
        .map_err(|error| {
            cleanup_live_text_mirror_empty_file(&self.live_text_mirrors, &meeting.id);
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
        let coordinator = match spawn_coordinator(CoordinatorContext {
            output,
            submitter,
            session_id: session_id.clone(),
            stop: Arc::clone(&stop),
            pause_gate: Arc::clone(&pause_gate),
            errors: Arc::clone(&errors),
            audio_source_mode,
            raw_audio_writer,
        }) {
            Ok(coordinator) => coordinator,
            Err(error) => {
                cleanup_live_text_mirror_empty_file(&self.live_text_mirrors, &meeting.id);
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
            audio_source_mode,
            last_disk_check_ms: AtomicU64::new(0),
            started: Instant::now(),
            meeting_id: meeting.id.clone(),
        });

        let mut snapshot = lock(&self.snapshot);
        snapshot.lifecycle = Lifecycle::Recording;
        snapshot.session_id = Some(session_id);
        snapshot.meeting_id = Some(meeting.id);
        apply_mode_sources(
            &mut snapshot,
            audio_source_mode,
            &preflight.system_output,
            &preflight.microphone,
            true,
        );
        snapshot.error = None;
        Ok(public_snapshot(
            &mut snapshot,
            inner.inference.as_ref().map(|worker| &worker.submitter),
        ))
    }

    #[cfg(windows)]
    fn pause_windows(&self) -> Result<MvpSnapshot, String> {
        let deadline = Instant::now() + MVP_SHUTDOWN_TIMEOUT;
        let (pause_gate, submitter, audio_source_mode) = {
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
                session.audio_source_mode,
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
                apply_paused_snapshot_for_mode(
                    &mut lock(&self.snapshot),
                    audio_source_mode,
                    Some(&error),
                );
            }
            return Err(error);
        }

        let inner = lock(&self.inner);
        let Some(session) = inner.session.as_ref() else {
            return Ok(self.snapshot_locked(&inner));
        };
        self.refresh_from_session(session, false);
        let mut snapshot = lock(&self.snapshot);
        apply_paused_snapshot_for_mode(&mut snapshot, session.audio_source_mode, None);
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
        snapshot.system.active = session.audio_source_mode.captures_system();
        snapshot.microphone.active = session.audio_source_mode.captures_microphone();
        if session.audio_source_mode.captures_system() && snapshot.system.error.is_none() {
            snapshot.system.status = SourceStatus::Capturing;
        }
        if session.audio_source_mode.captures_microphone() && snapshot.microphone.error.is_none() {
            snapshot.microphone.status = SourceStatus::Capturing;
        }
        apply_disabled_sources(&mut snapshot, session.audio_source_mode);
        if !snapshot
            .error
            .as_deref()
            .is_some_and(should_preserve_public_commit_error)
        {
            snapshot.error = None;
        }
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
        if let Some(translation) = lock(&self.translation).as_ref() {
            translation.submitter().clear_session(&session.meeting_id);
        }
        lock(&self.live_text_mirrors).remove(&session.meeting_id);
        let writer = self
            .storage_writer
            .as_ref()
            .ok_or_else(|| "MVP_STORAGE_UNAVAILABLE".to_owned())?;
        let meeting = finish_session_meeting(writer, &session.meeting_id, &session.errors)
            .inspect_err(|error| self.fail(error))?;
        let completion_error = meeting.completion_error.clone();

        let mut snapshot = lock(&self.snapshot);
        let live_text_warning = snapshot
            .error
            .as_deref()
            .filter(|error| *error == "LIVE_TEXT_MIRROR_WRITE_FAILED")
            .map(str::to_owned);
        snapshot.lifecycle = Lifecycle::Ready;
        snapshot.durability_status = meeting.state;
        snapshot.system.active = false;
        snapshot.system.peak = 0.0;
        snapshot.microphone.active = false;
        snapshot.microphone.peak = 0.0;
        if snapshot.system.error.is_none() {
            snapshot.system.status = SourceStatus::Ready;
        }
        if snapshot.microphone.error.is_none() {
            snapshot.microphone.status = SourceStatus::Ready;
        }
        apply_disabled_sources(&mut snapshot, session.audio_source_mode);
        snapshot.queue_depth = 0;
        snapshot.error = None;
        if let Some(error) = take_runtime_error(&session.errors) {
            set_public_error(&mut snapshot, error);
        }
        if completion_error.is_some() {
            snapshot.error = completion_error;
        }
        if snapshot.error.is_none()
            && let Some(warning) = live_text_warning
        {
            set_public_error(&mut snapshot, &warning);
        }
        let mut public = public_snapshot(&mut snapshot, submitter.as_ref());
        public.translation_queue_depth = lock(&self.translation)
            .as_ref()
            .map_or(0, TranslationWorker::queue_depth);
        Ok(public)
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
        let system_enabled = session.audio_source_mode.captures_system();
        let microphone_enabled = session.audio_source_mode.captures_microphone();
        let stream_error = (system_enabled && system.stream_errors > 0)
            || (microphone_enabled && microphone.stream_errors > 0);
        let elapsed_ms = u64::try_from(session.started.elapsed().as_millis()).unwrap_or(u64::MAX);
        let last_disk_check_ms = session.last_disk_check_ms.load(Ordering::Acquire);
        let disk_update = if elapsed_ms.saturating_sub(last_disk_check_ms) >= 30_000
            && session
                .last_disk_check_ms
                .compare_exchange(
                    last_disk_check_ms,
                    elapsed_ms,
                    Ordering::AcqRel,
                    Ordering::Acquire,
                )
                .is_ok()
        {
            self.storage.as_ref().map(disk_health_for_storage)
        } else {
            None
        };
        if disk_update
            .as_ref()
            .is_some_and(|disk| disk.status == "critical")
        {
            session
                .errors
                .mark_incomplete("MVP_DISK_SPACE_INSUFFICIENT");
        }
        let mut snapshot = lock(&self.snapshot);
        snapshot.elapsed_ms = elapsed_ms.to_string();
        if let Some(disk) = disk_update {
            if disk.status == "critical" {
                set_public_error(
                    &mut snapshot,
                    disk.warning
                        .as_deref()
                        .unwrap_or("MVP_DISK_SPACE_INSUFFICIENT"),
                );
            }
            snapshot.disk = disk;
        }
        let active = !stopping && !session.pause_gate.is_paused();
        apply_source_stats(&mut snapshot.system, system, active && system_enabled);
        apply_source_stats(
            &mut snapshot.microphone,
            microphone,
            active && microphone_enabled,
        );
        apply_disabled_sources(&mut snapshot, session.audio_source_mode);
        if stream_error {
            session.errors.mark_incomplete("AUDIO_STREAM_ERROR");
            set_public_error(&mut snapshot, "AUDIO_STREAM_ERROR");
        } else if (system_enabled && system.dropped_packets > 0)
            || (microphone_enabled && microphone.dropped_packets > 0)
        {
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
        "RAW_AUDIO_WRITE_FAILED" => 4,
        "ASR_FINAL_OVERLOAD" => 3,
        "ASR_WORKER_STOPPED" => 2,
        _ => 1,
    }
}

fn retry_one_translation(
    writer: &MvpStorageWriter,
    final_segment: &DurableFinal,
    source_language: &str,
    config: &ValidatedTranslationConfig,
) -> Result<(), String> {
    for retry_index in 0..3_u64 {
        let attempt = writer.begin_translation(TranslationCandidate {
            meeting_id: final_segment.meeting_id.clone(),
            segment_id: final_segment.segment_id.clone(),
            source_revision: final_segment.revision,
            target_language: config.target_language.clone(),
            model: config.model.clone(),
            provider: "openai-compatible".to_owned(),
            config_version: "meetingrelay.translation.config.v1".to_owned(),
            endpoint_origin: Some(config.endpoint_origin.clone()),
            endpoint_hash: config.endpoint_hash.clone(),
            prompt_version: "meetingrelay.translation.prompt.v1".to_owned(),
            request_schema_version: "openai.chat.completions.v1".to_owned(),
        })?;
        let skipped = source_language == config.target_language;
        let result = if skipped {
            Ok(final_segment.text.clone())
        } else {
            translate_text(config, &final_segment.text, source_language)
        };
        let (translated_text, error_code, retryable) = match result {
            Ok(text) if !skipped => (Some(text), None, false),
            Ok(_) => (None, None, false),
            Err(error) => {
                let retryable = translation_error_retryable(&error);
                (None, Some(error), retryable)
            }
        };
        writer.finish_translation(TranslationCompletion {
            meeting_id: final_segment.meeting_id.clone(),
            segment_id: final_segment.segment_id.clone(),
            source_revision: final_segment.revision,
            target_language: config.target_language.clone(),
            attempt: attempt.attempt,
            translated_text,
            error_code: error_code.clone(),
            retryable,
            skipped_same_language: skipped,
        })?;
        let Some(error) = error_code else {
            return Ok(());
        };
        if !retryable || retry_index == 2 {
            return Err(error);
        }
        std::thread::sleep(std::time::Duration::from_millis(100 * (retry_index + 1)));
    }
    Err("TRANSLATION_RETRY_EXHAUSTED".to_owned())
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

fn ensure_speaker_meeting_inactive(storage: &MvpStorage, meeting_id: &str) -> Result<(), String> {
    let snapshot = storage.snapshot(meeting_id)?;
    if matches!(snapshot.meeting.state.as_str(), "recording" | "paused") {
        return Err("SPEAKER_MEETING_ACTIVE".to_owned());
    }
    Ok(())
}

fn provider_secret_id(provider_profile_id: &str) -> Result<String, String> {
    if provider_profile_id.is_empty()
        || provider_profile_id.len() > 128
        || !provider_profile_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err("PROVIDER_PROFILE_ID_INVALID".to_owned());
    }
    Ok(format!("MeetingRelay:provider:{provider_profile_id}"))
}

fn meeting_list_item_snapshot(item: MeetingLibraryItem) -> MeetingListItemSnapshot {
    MeetingListItemSnapshot {
        meeting_id: item.meeting_id,
        title: item.title,
        status: match item.state.as_str() {
            "recording" | "paused" | "completed" | "interrupted" | "error" => item.state,
            "starting" => "recording".to_owned(),
            _ => "ready".to_owned(),
        },
        started_at: item.started_at.clone(),
        updated_at: item.ended_at.unwrap_or(item.started_at),
        duration_ms: item.duration_ms.unwrap_or(0).to_string(),
        language: item.language,
        saved_final_count: item.final_count.to_string(),
        translation_failed_count: item.translation_failed_count,
        summary_status: match item.summary_status.as_str() {
            "pending" => "queued".to_owned(),
            "completed" | "failed" | "cancelled" => item.summary_status,
            _ => "idle".to_owned(),
        },
        tags: item.tags.into_iter().map(|tag| tag.name).collect(),
    }
}

fn resolve_search_identity(
    storage: &MvpStorage,
    hit: &super::storage::SegmentSearchHit,
) -> Result<(Option<String>, Option<String>), String> {
    if hit.scope != "summary" {
        return Ok((Some(hit.segment_id.clone()), Some(hit.sequence.to_string())));
    }
    let Some(identity) = hit.segment_id.strip_prefix("summary:") else {
        return Ok((None, None));
    };
    let Some((job_id, section_kind)) = identity.rsplit_once(':') else {
        return Ok((None, None));
    };
    let citation_segment_id = storage
        .summary_results(job_id)?
        .into_iter()
        .find(|record| {
            record.section_kind == section_kind && u64::from(record.section_index) == hit.sequence
        })
        .and_then(|record| record.citation_segment_ids.into_iter().next());
    let Some(segment_id) = citation_segment_id else {
        return Ok((None, None));
    };
    let sequence = storage
        .snapshot(&hit.meeting_id)?
        .finals
        .into_iter()
        .find(|segment| segment.segment_id == segment_id)
        .map(|segment| segment.sequence.to_string());
    Ok((Some(segment_id), sequence))
}

fn default_provider_profiles() -> [ProviderProfileInput; 3] {
    let local_url = "http://127.0.0.1:11434/v1";
    let lan_url = "http://127.0.0.1:11434/v1";
    let cloud_url = "https://api.openai.com/v1";
    [
        ProviderProfileInput {
            profile_id: Some("local-default".to_owned()),
            label: "Local · Ollama / LM Studio".to_owned(),
            provider_class: "local".to_owned(),
            base_url: Some(local_url.to_owned()),
            model: "qwen2.5:7b".to_owned(),
            endpoint_hash: sha256_hex(local_url.as_bytes()),
            data_flow:
                "Final transcript text is sent only to the selected loopback service; raw audio is not sent."
                    .to_owned(),
            policy_url: None,
            config_version: 1,
            secret_state: "not_required".to_owned(),
            last_test_at: None,
            last_test_status: None,
            last_error: None,
        },
        ProviderProfileInput {
            profile_id: Some("lan-openai-compatible".to_owned()),
            label: "LAN · OpenAI-compatible".to_owned(),
            provider_class: "lan".to_owned(),
            base_url: Some(lan_url.to_owned()),
            model: "qwen2.5".to_owned(),
            endpoint_hash: sha256_hex(lan_url.as_bytes()),
            data_flow: "Final transcript text is sent to the configured LAN endpoint; raw audio is not sent."
                .to_owned(),
            policy_url: None,
            config_version: 1,
            secret_state: "missing".to_owned(),
            last_test_at: None,
            last_test_status: None,
            last_error: None,
        },
        ProviderProfileInput {
            profile_id: Some("cloud-openai-compatible".to_owned()),
            label: "Cloud · OpenAI-compatible".to_owned(),
            provider_class: "cloud".to_owned(),
            base_url: Some(cloud_url.to_owned()),
            model: "gpt-4o-mini".to_owned(),
            endpoint_hash: sha256_hex(cloud_url.as_bytes()),
            data_flow:
                "Final transcript text is sent over HTTPS; raw audio remains on this device."
                    .to_owned(),
            policy_url: Some("https://openai.com/policies/privacy-policy/".to_owned()),
            config_version: 1,
            secret_state: "missing".to_owned(),
            last_test_at: None,
            last_test_status: None,
            last_error: None,
        },
    ]
}

fn bounded_provider_error(error: &str) -> String {
    let sanitized = error
        .chars()
        .filter(|character| !character.is_control())
        .take(512)
        .collect::<String>();
    if sanitized.is_empty() {
        "PROVIDER_TEST_FAILED".to_owned()
    } else {
        sanitized
    }
}

fn summary_job_from_storage(
    job: SummaryJobRecord,
    chunk_count: usize,
    result: Option<SummaryResultSnapshot>,
) -> SummaryJobSnapshot {
    let status = match job.status.as_str() {
        "pending" => "queued",
        "completed" => "completed",
        "failed" => "failed",
        "cancelled" => "cancelled",
        _ => "failed",
    }
    .to_owned();
    let can_retry = matches!(status.as_str(), "failed" | "cancelled");
    SummaryJobSnapshot {
        job_id: job.job_id,
        meeting_id: job.meeting_id,
        status,
        version: job.attempt.max(1),
        total_chunks: chunk_count,
        completed_chunks: chunk_count,
        can_cancel: job.status == "pending",
        can_retry,
        message: job.error_code,
        result,
    }
}

fn apply_summary_progress(current: &mut SummaryJobSnapshot, progress: &SummaryProgressSnapshot) {
    current.total_chunks = progress.total_chunks;
    current.completed_chunks = progress.completed_chunks;
    current.status = match progress.stage {
        SummaryStage::Validating | SummaryStage::Chunking | SummaryStage::SummarizingChunks => {
            "chunking"
        }
        SummaryStage::Combining | SummaryStage::ValidatingResult => "combining",
        SummaryStage::Completed => "completed",
        SummaryStage::Cancelled => "cancelled",
        SummaryStage::Failed => "failed",
    }
    .to_owned();
    current.can_cancel = matches!(current.status.as_str(), "queued" | "chunking" | "combining");
    current.can_retry = matches!(current.status.as_str(), "failed" | "cancelled");
}

fn finish_summary_run(
    writer: &MvpStorageWriter,
    job: &SummaryJobRecord,
    outcome: SummaryOutcome,
    cancellation: &AtomicBool,
    state: &Mutex<SummaryJobSnapshot>,
    source_segment_ids: &[String],
) {
    match outcome {
        SummaryOutcome::Completed(completion) if !cancellation.load(Ordering::Acquire) => {
            match build_summary_chunks(job, completion.progress.total_chunks, source_segment_ids)
                .map(|chunks| {
                    let (results, snapshot) = build_summary_results(job, &completion.result);
                    (chunks, results, snapshot)
                })
                .and_then(|(chunks, results, snapshot)| {
                    writer
                        .complete_summary_job(SummaryCompletionInput {
                            job_id: job.job_id.clone(),
                            chunks,
                            results,
                        })
                        .map(|_| snapshot)
                }) {
                Ok(result) => {
                    let mut current = lock(state);
                    current.status = "completed".to_owned();
                    current.completed_chunks = current.total_chunks;
                    current.can_cancel = false;
                    current.can_retry = false;
                    current.message = None;
                    current.result = Some(result);
                }
                Err(error) => {
                    let error_code = bounded_summary_error(&error);
                    let _ = writer.fail_summary_job(&job.job_id, &error_code, true);
                    set_summary_failed(state, &error_code, true);
                }
            }
        }
        SummaryOutcome::Completed(_) | SummaryOutcome::Cancelled(_) => {
            let _ = writer.cancel_summary_job(&job.job_id);
            let mut current = lock(state);
            current.status = "cancelled".to_owned();
            current.can_cancel = false;
            current.can_retry = true;
            current.message = Some("Summary cancelled".to_owned());
            current.result = None;
        }
        SummaryOutcome::Failed(failure) => {
            let error_code = bounded_summary_error(&failure.error_code);
            let _ = writer.fail_summary_job(&job.job_id, &error_code, failure.retryable);
            set_summary_failed(state, &error_code, failure.retryable);
        }
    }
}

fn build_summary_chunks(
    job: &SummaryJobRecord,
    total_chunks: usize,
    source_segment_ids: &[String],
) -> Result<Vec<SummaryChunkInput>, String> {
    if total_chunks == 0 {
        return Err("SUMMARY_CHUNK_COUNT_INVALID".to_owned());
    }
    let segment_count_per_chunk = source_segment_ids.len().div_ceil(total_chunks).max(1);
    let mut chunks = Vec::with_capacity(total_chunks);
    for chunk_index in 0..total_chunks {
        let start = chunk_index.saturating_mul(segment_count_per_chunk);
        let end = start
            .saturating_add(segment_count_per_chunk)
            .min(source_segment_ids.len());
        let ids = source_segment_ids
            .get(start..end)
            .unwrap_or_default()
            .iter()
            .take(256)
            .cloned()
            .collect();
        chunks.push(SummaryChunkInput {
            job_id: job.job_id.clone(),
            chunk_index: u32::try_from(chunk_index).unwrap_or(u32::MAX),
            source_segment_ids: ids,
            text: format!("completed chunk {} of {total_chunks}", chunk_index + 1),
        });
    }
    Ok(chunks)
}

fn build_summary_results(
    job: &SummaryJobRecord,
    summary: &MeetingSummary,
) -> (Vec<SummaryResultInput>, SummaryResultSnapshot) {
    let mut results = vec![SummaryResultInput {
        job_id: job.job_id.clone(),
        section_kind: "overview".to_owned(),
        section_index: 0,
        heading: "概览".to_owned(),
        text: summary.overview.clone(),
        citation_segment_ids: Vec::new(),
    }];
    for (index, action) in summary.action_items.iter().enumerate() {
        results.push(SummaryResultInput {
            job_id: job.job_id.clone(),
            section_kind: "action".to_owned(),
            section_index: u32::try_from(index).unwrap_or(u32::MAX),
            heading: "行动项".to_owned(),
            text: format_summary_action(action),
            citation_segment_ids: summary_citation_ids(&action.citation),
        });
    }
    for (index, decision) in summary.decisions.iter().enumerate() {
        results.push(SummaryResultInput {
            job_id: job.job_id.clone(),
            section_kind: "decision".to_owned(),
            section_index: u32::try_from(index).unwrap_or(u32::MAX),
            heading: "决定".to_owned(),
            text: decision.text.clone(),
            citation_segment_ids: summary_citation_ids(&decision.citation),
        });
    }
    for (index, question) in summary.open_questions.iter().enumerate() {
        results.push(SummaryResultInput {
            job_id: job.job_id.clone(),
            section_kind: "open_question".to_owned(),
            section_index: u32::try_from(index).unwrap_or(u32::MAX),
            heading: "待确认".to_owned(),
            text: question.text.clone(),
            citation_segment_ids: summary_citation_ids(&question.citation),
        });
    }
    (results, summary_result_from_summary(job, summary))
}

fn summary_result_from_summary(
    job: &SummaryJobRecord,
    summary: &MeetingSummary,
) -> SummaryResultSnapshot {
    let actions = summary
        .action_items
        .iter()
        .map(format_summary_action)
        .collect();
    let decisions = summary
        .decisions
        .iter()
        .map(|decision| decision.text.clone())
        .collect();
    let open_questions = summary
        .open_questions
        .iter()
        .map(|question| question.text.clone())
        .collect();
    let citations = summary
        .action_items
        .iter()
        .map(|action| (&action.citation, "行动项"))
        .chain(
            summary
                .decisions
                .iter()
                .map(|decision| (&decision.citation, "决定")),
        )
        .chain(
            summary
                .open_questions
                .iter()
                .map(|question| (&question.citation, "待确认")),
        )
        .enumerate()
        .map(|(index, (citation, label))| SummaryCitationSnapshot {
            segment_id: citation.segment_id.clone(),
            sequence: citation.sequence.map(|sequence| sequence.to_string()),
            label: if citation.unlinked {
                format!("{label} {} · 未链接", index + 1)
            } else {
                format!("{label} {}", index + 1)
            },
        })
        .collect();
    SummaryResultSnapshot {
        summary_id: job.job_id.clone(),
        version: job.attempt.max(1),
        language: "zh".to_owned(),
        overview: summary.overview.clone(),
        actions,
        decisions,
        open_questions,
        citations,
        created_at: now_ms_string(),
    }
}

fn summary_result_from_records(
    storage: &MvpStorage,
    job: &SummaryJobRecord,
    records: &[SummaryResultRecord],
) -> Result<Option<SummaryResultSnapshot>, String> {
    if records.is_empty() {
        return Ok(None);
    }
    let meeting = storage.snapshot(&job.meeting_id)?;
    let sequence_for = |segment_id: &str| {
        meeting
            .finals
            .iter()
            .find(|segment| segment.segment_id == segment_id)
            .map(|segment| segment.sequence.to_string())
    };
    let overview = records
        .iter()
        .find(|record| record.section_kind == "overview")
        .map(|record| record.text.clone())
        .unwrap_or_default();
    let actions = records
        .iter()
        .filter(|record| record.section_kind == "action")
        .map(|record| record.text.clone())
        .collect();
    let decisions = records
        .iter()
        .filter(|record| record.section_kind == "decision")
        .map(|record| record.text.clone())
        .collect();
    let open_questions = records
        .iter()
        .filter(|record| record.section_kind == "open_question")
        .map(|record| record.text.clone())
        .collect();
    let citations = records
        .iter()
        .filter(|record| record.section_kind != "overview")
        .enumerate()
        .flat_map(|(index, record)| {
            if record.citation_segment_ids.is_empty() {
                return vec![SummaryCitationSnapshot {
                    segment_id: None,
                    sequence: None,
                    label: format!("{} {} · 未链接", record.heading, index + 1),
                }];
            }
            record
                .citation_segment_ids
                .iter()
                .map(|segment_id| SummaryCitationSnapshot {
                    segment_id: Some(segment_id.clone()),
                    sequence: sequence_for(segment_id),
                    label: format!("{} {}", record.heading, index + 1),
                })
                .collect()
        })
        .collect();
    Ok(Some(SummaryResultSnapshot {
        summary_id: job.job_id.clone(),
        version: job.attempt.max(1),
        language: "zh".to_owned(),
        overview,
        actions,
        decisions,
        open_questions,
        citations,
        created_at: records
            .first()
            .map(|record| record.created_at.clone())
            .unwrap_or_else(|| job.requested_at.clone()),
    }))
}

fn format_summary_action(action: &super::summary::SummaryActionItem) -> String {
    let mut text = action.text.clone();
    let mut details = Vec::new();
    if let Some(owner) = action.owner.as_deref() {
        details.push(format!("负责人：{owner}"));
    }
    if let Some(due) = action.due.as_deref() {
        details.push(format!("截止：{due}"));
    }
    if !details.is_empty() {
        text.push('（');
        text.push_str(&details.join("；"));
        text.push('）');
    }
    text
}

fn summary_citation_ids(citation: &super::summary::SummaryCitation) -> Vec<String> {
    if citation.unlinked {
        Vec::new()
    } else {
        citation.segment_id.iter().cloned().collect()
    }
}

fn bounded_summary_error(error: &str) -> String {
    let sanitized = error
        .chars()
        .filter(|character| !character.is_control())
        .take(128)
        .collect::<String>();
    if sanitized.is_empty() {
        "SUMMARY_PERSIST_FAILED".to_owned()
    } else {
        sanitized
    }
}

fn set_summary_failed(state: &Mutex<SummaryJobSnapshot>, error_code: &str, retryable: bool) {
    let mut current = lock(state);
    current.status = "failed".to_owned();
    current.can_cancel = false;
    current.can_retry = retryable;
    current.message = Some(error_code.to_owned());
    current.result = None;
}

#[cfg(windows)]
fn disk_health_for_storage(storage: &MvpStorage) -> DiskHealthSnapshot {
    let data_dir = storage
        .default_export_dir()
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));
    if let Err(error) = writable_disk_probe(&data_dir) {
        return DiskHealthSnapshot {
            status: "critical".to_owned(),
            data_dir: data_dir.to_string_lossy().into_owned(),
            free_bytes: "0".to_owned(),
            required_bytes: DISK_REQUIRED_BYTES.to_string(),
            warning: Some(super::storage::disk_check_from_io_error(&error).code),
        };
    }
    let free_bytes = available_disk_bytes(&data_dir);
    match free_bytes {
        Some(free) if free < DISK_REQUIRED_BYTES => DiskHealthSnapshot {
            status: "critical".to_owned(),
            data_dir: data_dir.to_string_lossy().into_owned(),
            free_bytes: free.to_string(),
            required_bytes: DISK_REQUIRED_BYTES.to_string(),
            warning: Some("MVP_DISK_SPACE_INSUFFICIENT".to_owned()),
        },
        Some(free) if free < DISK_WARNING_BYTES => DiskHealthSnapshot {
            status: "warning".to_owned(),
            data_dir: data_dir.to_string_lossy().into_owned(),
            free_bytes: free.to_string(),
            required_bytes: DISK_REQUIRED_BYTES.to_string(),
            warning: Some("MVP_DISK_SPACE_LOW".to_owned()),
        },
        Some(free) => DiskHealthSnapshot {
            status: "ok".to_owned(),
            data_dir: data_dir.to_string_lossy().into_owned(),
            free_bytes: free.to_string(),
            required_bytes: DISK_REQUIRED_BYTES.to_string(),
            warning: None,
        },
        None => DiskHealthSnapshot {
            status: "warning".to_owned(),
            data_dir: data_dir.to_string_lossy().into_owned(),
            // The write-through probe succeeded, but the platform free-space
            // query was unavailable. Expose a conservative lower bound.
            free_bytes: DISK_REQUIRED_BYTES.to_string(),
            required_bytes: DISK_REQUIRED_BYTES.to_string(),
            warning: Some("MVP_DISK_SPACE_UNKNOWN".to_owned()),
        },
    }
}

#[cfg(windows)]
fn writable_disk_probe(data_dir: &Path) -> std::io::Result<()> {
    fs::create_dir_all(data_dir)?;
    let probe_path = data_dir.join(format!(
        ".meetingrelay-disk-probe-{}",
        super::storage::now_ms_string()
    ));
    let result = (|| {
        let mut file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&probe_path)?;
        file.write_all(&[0_u8; 4096])?;
        file.sync_all()
    })();
    let _ = fs::remove_file(&probe_path);
    result
}

#[cfg(windows)]
fn available_disk_bytes(data_dir: &Path) -> Option<u64> {
    let script = "& { param([string]$dataDir) $root=[IO.Path]::GetPathRoot($dataDir); if ([string]::IsNullOrWhiteSpace($root)) { exit 2 }; ([IO.DriveInfo]::new($root)).AvailableFreeSpace }";
    let mut command = Command::new("powershell.exe");
    command
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            script,
        ])
        .arg(data_dir);
    suppress_child_window(&mut command);

    let output = command.output().ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8(output.stdout).ok()?.trim().parse().ok()
}

#[cfg(windows)]
fn suppress_child_window(command: &mut Command) {
    use std::os::windows::process::CommandExt;

    command.creation_flags(CREATE_NO_WINDOW);
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
        4 => Some("RAW_AUDIO_WRITE_FAILED"),
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
    audio_source_mode: AudioSourceMode,
    last_disk_check_ms: AtomicU64,
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
fn disabled_source(id: SourceId) -> AudioSourceSnapshot {
    AudioSourceSnapshot {
        id,
        label: String::new(),
        ready: false,
        active: false,
        frames: "0".to_owned(),
        peak: 0.0,
        status: SourceStatus::Disabled,
        error: None,
    }
}

#[cfg(windows)]
fn apply_mode_sources(
    snapshot: &mut MvpSnapshot,
    mode: AudioSourceMode,
    system_output: &AudioDevicePreflight,
    microphone: &AudioDevicePreflight,
    active: bool,
) {
    snapshot.system = if mode.captures_system() {
        if active {
            capturing_source(SourceId::System, system_output)
        } else {
            ready_source(SourceId::System, system_output)
        }
    } else {
        disabled_source(SourceId::System)
    };
    snapshot.microphone = if mode.captures_microphone() {
        if active {
            capturing_source(SourceId::Microphone, microphone)
        } else {
            ready_source(SourceId::Microphone, microphone)
        }
    } else {
        disabled_source(SourceId::Microphone)
    };
}

#[cfg(windows)]
fn apply_disabled_sources(snapshot: &mut MvpSnapshot, mode: AudioSourceMode) {
    if !mode.captures_system() {
        snapshot.system = disabled_source(SourceId::System);
    }
    if !mode.captures_microphone() {
        snapshot.microphone = disabled_source(SourceId::Microphone);
    }
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

#[cfg(all(windows, test))]
fn apply_paused_snapshot(snapshot: &mut MvpSnapshot, error: Option<&str>) {
    apply_paused_snapshot_for_mode(snapshot, AudioSourceMode::Both, error);
}

#[cfg(windows)]
fn apply_paused_snapshot_for_mode(
    snapshot: &mut MvpSnapshot,
    mode: AudioSourceMode,
    error: Option<&str>,
) {
    snapshot.lifecycle = Lifecycle::Paused;
    snapshot.durability_status = "paused".to_owned();
    apply_paused_source(&mut snapshot.system);
    apply_paused_source(&mut snapshot.microphone);
    apply_disabled_sources(snapshot, mode);
    if let Some(error) = error {
        set_public_error(snapshot, error);
    } else if !snapshot
        .error
        .as_deref()
        .is_some_and(should_preserve_public_commit_error)
    {
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
fn public_raw_audio_error(error: &RawAudioError) -> String {
    match error {
        RawAudioError::QuotaExceeded { .. } => "RAW_AUDIO_QUOTA_EXCEEDED".to_owned(),
        RawAudioError::Io(io_error) if io_error.kind() == std::io::ErrorKind::StorageFull => {
            "RAW_AUDIO_DISK_FULL".to_owned()
        }
        RawAudioError::Io(_) => "RAW_AUDIO_WRITE_FAILED".to_owned(),
        RawAudioError::InvalidMeetingId
        | RawAudioError::InvalidPacket(_)
        | RawAudioError::SourceFormatChanged { .. }
        | RawAudioError::Json(_) => "RAW_AUDIO_CONFIG_INVALID".to_owned(),
    }
}

fn public_raw_audio_policy_error(error: &RawAudioError) -> String {
    match error {
        RawAudioError::InvalidMeetingId => "RAW_AUDIO_MEETING_ID_INVALID".to_owned(),
        RawAudioError::QuotaExceeded { .. } => "RAW_AUDIO_QUOTA_EXCEEDED".to_owned(),
        RawAudioError::Io(io_error) if io_error.kind() == std::io::ErrorKind::StorageFull => {
            "RAW_AUDIO_DISK_FULL".to_owned()
        }
        RawAudioError::Io(_) => "RAW_AUDIO_STORAGE_FAILED".to_owned(),
        RawAudioError::InvalidPacket(_)
        | RawAudioError::SourceFormatChanged { .. }
        | RawAudioError::Json(_) => "RAW_AUDIO_CONFIG_INVALID".to_owned(),
    }
}

#[cfg(windows)]
fn resolve_model_paths() -> Result<LockedSherpaRealtimePaths, String> {
    let workspace_candidate = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let workspace_root = workspace_candidate
        .canonicalize()
        .unwrap_or(workspace_candidate);
    let executable = env::current_exe().map_err(|_| "SHERPA_ASSET_MISSING".to_owned())?;
    let exe_dir = executable
        .parent()
        .ok_or_else(|| "SHERPA_ASSET_MISSING".to_owned())?
        .canonicalize()
        .map_err(|_| "SHERPA_ASSET_MISSING".to_owned())?;

    resolve_model_paths_from(&exe_dir, &workspace_root, ModelPathOverrides::from_env())
}

#[cfg(windows)]
#[derive(Default)]
struct ModelPathOverrides {
    model_path: Option<std::ffi::OsString>,
    tokens_path: Option<std::ffi::OsString>,
    runtime_lib_dir: Option<std::ffi::OsString>,
    asset_lock_path: Option<std::ffi::OsString>,
    package_lock_path: Option<std::ffi::OsString>,
}

#[cfg(windows)]
impl ModelPathOverrides {
    fn from_env() -> Self {
        Self {
            model_path: env::var_os("MEETINGRELAY_SHERPA_MODEL"),
            tokens_path: env::var_os("MEETINGRELAY_SHERPA_TOKENS"),
            runtime_lib_dir: env::var_os("SHERPA_ONNX_LIB_DIR"),
            asset_lock_path: env::var_os("MEETINGRELAY_SHERPA_LOCK"),
            package_lock_path: env::var_os("MEETINGRELAY_PACKAGE_LOCK"),
        }
    }
}

#[cfg(windows)]
fn resolve_model_paths_from(
    exe_dir: &Path,
    workspace_root: &Path,
    overrides: ModelPathOverrides,
) -> Result<LockedSherpaRealtimePaths, String> {
    let installed = installed_model_path_candidates(exe_dir);
    let installed_layout_present = model_path_candidates_have_any_entry(&installed);
    let running_from_workspace_target = exe_dir.starts_with(workspace_root.join("target"));
    let use_installed_layout = installed_layout_present || !running_from_workspace_target;
    let defaults = if use_installed_layout {
        let missing = missing_model_path_candidates(&installed, &overrides);
        if !missing.is_empty() {
            return Err(format!(
                "SHERPA_ASSET_MISSING installed_layout={}",
                missing.join(",")
            ));
        }
        installed
    } else {
        workspace_model_path_candidates(workspace_root)
    };

    Ok(LockedSherpaRealtimePaths {
        model_path: canonical_env_or_value(overrides.model_path, defaults.model_path)?,
        tokens_path: canonical_env_or_value(overrides.tokens_path, defaults.tokens_path)?,
        runtime_lib_dir: canonical_env_or_value(
            overrides.runtime_lib_dir,
            defaults.runtime_lib_dir,
        )?,
        asset_lock_path: canonical_env_or_value(
            overrides.asset_lock_path,
            defaults.asset_lock_path,
        )?,
        package_lock_path: canonical_env_or_value(
            overrides.package_lock_path,
            defaults.package_lock_path,
        )?,
    })
}

#[cfg(windows)]
fn model_path_candidates_have_any_entry(paths: &ModelPathCandidates) -> bool {
    paths.model_path.exists()
        || paths.tokens_path.exists()
        || paths.runtime_lib_dir.exists()
        || paths.asset_lock_path.exists()
        || paths.package_lock_path.exists()
}

#[cfg(windows)]
fn missing_model_path_candidates(
    paths: &ModelPathCandidates,
    overrides: &ModelPathOverrides,
) -> Vec<&'static str> {
    let mut missing = Vec::new();
    if overrides.model_path.is_none() && !paths.model_path.is_file() {
        missing.push("model");
    }
    if overrides.tokens_path.is_none() && !paths.tokens_path.is_file() {
        missing.push("tokens");
    }
    if overrides.runtime_lib_dir.is_none() && !paths.runtime_lib_dir.is_dir() {
        missing.push("runtime");
    }
    if overrides.asset_lock_path.is_none() && !paths.asset_lock_path.is_file() {
        missing.push("asset-lock");
    }
    if overrides.package_lock_path.is_none() && !paths.package_lock_path.is_file() {
        missing.push("package-lock");
    }
    missing
}

#[cfg(windows)]
struct ModelPathCandidates {
    model_path: PathBuf,
    tokens_path: PathBuf,
    runtime_lib_dir: PathBuf,
    asset_lock_path: PathBuf,
    package_lock_path: PathBuf,
}

#[cfg(windows)]
fn installed_model_path_candidates(exe_dir: &Path) -> ModelPathCandidates {
    ModelPathCandidates {
        model_path: exe_dir.join("model/model.int8.onnx"),
        tokens_path: exe_dir.join("model/tokens.txt"),
        runtime_lib_dir: exe_dir.join("runtime/lib"),
        asset_lock_path: exe_dir.join("locks/assets.lock.json"),
        package_lock_path: exe_dir.join("locks/Cargo.lock"),
    }
}

#[cfg(windows)]
fn workspace_model_path_candidates(workspace_root: &Path) -> ModelPathCandidates {
    let extracted = workspace_root.join("target/sherpa-native/extracted");
    let model_root = extracted.join("sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17");
    let runtime_root = extracted.join("sherpa-onnx-v1.13.4-win-x64-shared-MT-Release-lib/lib");

    ModelPathCandidates {
        model_path: model_root.join("model.int8.onnx"),
        tokens_path: model_root.join("tokens.txt"),
        runtime_lib_dir: runtime_root,
        asset_lock_path: workspace_root.join("tools/sherpa-native/assets.lock.json"),
        package_lock_path: workspace_root.join("Cargo.lock"),
    }
}

#[cfg(all(windows, test))]
fn canonical_model_path_candidates(
    paths: ModelPathCandidates,
) -> Result<ModelPathCandidates, String> {
    Ok(ModelPathCandidates {
        model_path: canonical_asset(paths.model_path)?,
        tokens_path: canonical_asset(paths.tokens_path)?,
        runtime_lib_dir: canonical_asset(paths.runtime_lib_dir)?,
        asset_lock_path: canonical_asset(paths.asset_lock_path)?,
        package_lock_path: canonical_asset(paths.package_lock_path)?,
    })
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
        let deadline = Instant::now() + FINAL_QUEUE_BACKPRESSURE;
        let mut pending_task = task;
        loop {
            match self.finals.try_send(pending_task) {
                Ok(()) => {
                    self.shared.latest_interim.fetch_add(1, Ordering::AcqRel);
                    let retired = match self.shared.interim.try_lock() {
                        Ok(mut interim) => interim.take().is_some(),
                        Err(TryLockError::Poisoned(poisoned)) => {
                            poisoned.into_inner().take().is_some()
                        }
                        Err(TryLockError::WouldBlock) => false,
                    };
                    if retired {
                        self.shared.pending.fetch_sub(1, Ordering::AcqRel);
                    }
                    self.worker_thread.unpark();
                    return Ok(());
                }
                Err(TrySendError::Full(task)) if Instant::now() < deadline => {
                    pending_task = task;
                    thread::sleep(Duration::from_millis(2));
                }
                Err(TrySendError::Full(task)) => {
                    self.shared.pending.fetch_sub(1, Ordering::AcqRel);
                    task.session_errors.mark_incomplete("ASR_FINAL_OVERLOAD");
                    return Err("ASR_FINAL_OVERLOAD".to_owned());
                }
                Err(TrySendError::Disconnected(task)) => {
                    self.shared.pending.fetch_sub(1, Ordering::AcqRel);
                    task.session_errors.mark_incomplete("ASR_WORKER_STOPPED");
                    return Err("ASR_WORKER_STOPPED".to_owned());
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
    published_interim_record: Mutex<Option<PublishedInterimTranscript>>,
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

    fn remember_published_interim(&self, interim: PublishedInterimTranscript) {
        *lock(&self.published_interim_record) = Some(interim);
    }

    fn published_interim_record(&self) -> Option<PublishedInterimTranscript> {
        lock(&self.published_interim_record).clone()
    }

    fn clear_published_interim(&self) {
        *lock(&self.published_interim_record) = None;
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct PublishedInterimTranscript {
    session_id: String,
    segment_id: String,
    revision: u32,
    text: String,
    meeting_sample_start: u64,
    meeting_sample_end: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct TranscriptCandidateBounds<'a> {
    session_id: &'a str,
    segment_id: &'a str,
    revision: u32,
    meeting_sample_start: u64,
    meeting_sample_end: u64,
}

fn meaningful_final_text_or_interim(
    final_candidate: TranscriptCandidateBounds<'_>,
    final_text: &str,
    published_interim: Option<&PublishedInterimTranscript>,
) -> Option<String> {
    if is_meaningful_transcript(final_text) {
        return Some(final_text.to_owned());
    }
    let interim = published_interim?;
    if interim_matches_final(final_candidate, interim) && is_meaningful_transcript(&interim.text) {
        Some(interim.text.clone())
    } else {
        None
    }
}

fn interim_matches_final(
    final_candidate: TranscriptCandidateBounds<'_>,
    interim: &PublishedInterimTranscript,
) -> bool {
    interim.session_id == final_candidate.session_id
        && interim.segment_id == final_candidate.segment_id
        && interim.revision < final_candidate.revision
        && interim.meeting_sample_start == final_candidate.meeting_sample_start
        && interim.meeting_sample_end <= final_candidate.meeting_sample_end
}

#[cfg(windows)]
#[derive(Clone)]
enum RecognizerProfile {
    Sherpa {
        paths: LockedSherpaRealtimePaths,
        language: RecognitionLanguage,
    },
    Cohere {
        config: CohereAsrConfig,
        language: RecognitionLanguage,
    },
}

#[cfg(windows)]
impl RecognizerProfile {
    const fn language(&self) -> RecognitionLanguage {
        match self {
            Self::Sherpa { language, .. } | Self::Cohere { language, .. } => *language,
        }
    }
}

#[cfg(windows)]
enum PreparedRecognizer {
    Sherpa(Box<LockedSherpaRealtime>),
    Cohere(CohereAsrSidecar),
}

#[cfg(windows)]
impl PreparedRecognizer {
    fn prepare(profile: &RecognizerProfile) -> Result<Self, RecognizerError> {
        match profile {
            RecognizerProfile::Sherpa { paths, language } => {
                LockedSherpaRealtime::prepare_local_mvp_with_language(
                    paths.clone(),
                    language.sherpa(),
                )
                .map(Box::new)
                .map(Self::Sherpa)
                .map_err(RecognizerError::Sherpa)
            }
            RecognizerProfile::Cohere { config, .. } => CohereAsrSidecar::prepare(config)
                .map(Self::Cohere)
                .map_err(RecognizerError::Cohere),
        }
    }

    fn transcribe(
        &mut self,
        samples: Arc<[i16]>,
        language: RecognitionLanguage,
    ) -> Result<String, RecognizerError> {
        match self {
            Self::Sherpa(recognizer) => recognizer
                .transcribe_mono_16khz_pcm16(samples)
                .map(|result| result.original_transcript.as_str().trim().to_owned())
                .map_err(RecognizerError::Sherpa),
            Self::Cohere(recognizer) => recognizer
                .transcribe_mono_16khz_pcm16(&samples, language.code())
                .map_err(RecognizerError::Cohere),
        }
    }

    fn release_runtime_before_restart(&mut self) {
        if let Self::Cohere(recognizer) = self {
            recognizer.shutdown();
        }
    }
}

#[cfg(windows)]
#[derive(Debug)]
enum RecognizerError {
    Sherpa(LockedSherpaRealtimeError),
    Cohere(CohereAsrError),
}

#[cfg(windows)]
impl RecognizerError {
    fn recoverable(&self) -> bool {
        match self {
            Self::Sherpa(error) => matches!(
                error,
                LockedSherpaRealtimeError::RecognitionUnavailable
                    | LockedSherpaRealtimeError::NotPrepared
            ),
            Self::Cohere(error) => error.recoverable(),
        }
    }
}

#[cfg(windows)]
impl std::fmt::Display for RecognizerError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Sherpa(error) => error.fmt(formatter),
            Self::Cohere(error) => error.fmt(formatter),
        }
    }
}

#[cfg(windows)]
struct InferenceWorker {
    submitter: InferenceSubmitter,
    join: Option<JoinHandle<()>>,
    language: RecognitionLanguage,
    model_id: String,
}

#[cfg(windows)]
impl InferenceWorker {
    fn prepare(
        snapshot: Arc<Mutex<MvpSnapshot>>,
        profile: RecognizerProfile,
        storage_writer: Option<Arc<MvpStorageWriter>>,
        translation: Option<TranslationSubmitter>,
        live_text_mirrors: Arc<Mutex<HashMap<String, LiveTextMirror>>>,
        language: RecognitionLanguage,
        model_id: String,
    ) -> Result<Self, String> {
        let (ready_sender, ready_receiver) = sync_channel(1);
        let (finals, final_receiver) = sync_channel(MAX_INFERENCE_QUEUE_DEPTH);
        let shared = Arc::new(InferenceShared::default());
        let worker_shared = Arc::clone(&shared);
        let worker_profile = profile.clone();
        let join = thread::Builder::new()
            .name("meetingrelay-asr".to_owned())
            .spawn(move || {
                let recognizer =
                    PreparedRecognizer::prepare(&profile).map_err(|error| error.to_string());
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
                        translation,
                        live_text_mirrors,
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
            model_id,
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
    meeting_sample_start: u64,
    meeting_sample_end: u64,
    samples: Arc<[i16]>,
    session_errors: Arc<RuntimeErrors>,
}

#[cfg(windows)]
#[allow(clippy::too_many_arguments)]
fn inference_loop(
    recognizer: &mut PreparedRecognizer,
    profile: RecognizerProfile,
    finals: Receiver<InferenceTask>,
    shared: Arc<InferenceShared>,
    snapshot: Arc<Mutex<MvpSnapshot>>,
    storage_writer: Option<Arc<MvpStorageWriter>>,
    translation: Option<TranslationSubmitter>,
    live_text_mirrors: Arc<Mutex<HashMap<String, LiveTextMirror>>>,
) {
    let sinks = InferenceSinks {
        storage_writer: storage_writer.as_deref(),
        translation: translation.as_ref(),
        live_text_mirrors: &live_text_mirrors,
    };
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
                sinks,
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
#[derive(Clone, Copy)]
struct InferenceSinks<'a> {
    storage_writer: Option<&'a MvpStorageWriter>,
    translation: Option<&'a TranslationSubmitter>,
    live_text_mirrors: &'a Mutex<HashMap<String, LiveTextMirror>>,
}

#[cfg(windows)]
fn transcribe_with_recovery(
    recognizer: &mut PreparedRecognizer,
    profile: &RecognizerProfile,
    task: &InferenceTask,
) -> Result<String, RecognizerError> {
    let result = recognizer.transcribe(Arc::clone(&task.samples), profile.language());
    if result
        .as_ref()
        .err()
        .is_some_and(|error| should_retry_transcription(error, task))
    {
        recognizer.release_runtime_before_restart();
        *recognizer = PreparedRecognizer::prepare(profile)?;
        recognizer.transcribe(Arc::clone(&task.samples), profile.language())
    } else {
        result
    }
}

#[cfg(windows)]
fn should_retry_transcription(error: &RecognizerError, task: &InferenceTask) -> bool {
    error.recoverable() && is_replayable_inference_task(task)
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
    recognizer: &mut PreparedRecognizer,
    profile: &RecognizerProfile,
    shared: &InferenceShared,
    snapshot: &Mutex<MvpSnapshot>,
    sinks: InferenceSinks<'_>,
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
        Ok(mut text) => {
            if task.is_final {
                let final_candidate = TranscriptCandidateBounds {
                    session_id: &task.session_id,
                    segment_id: &task.segment_id,
                    revision: task.revision,
                    meeting_sample_start: task.meeting_sample_start,
                    meeting_sample_end: task.meeting_sample_end,
                };
                let Some(commit_text) = meaningful_final_text_or_interim(
                    final_candidate,
                    &text,
                    shared.published_interim_record().as_ref(),
                ) else {
                    let _ = publish_if_current(
                        shared,
                        snapshot,
                        interim_generation,
                        &session_id,
                        |current| {
                            current.interim = None;
                            shared.clear_published_interim();
                            shared.published_interim.store(0, Ordering::Release);
                        },
                    );
                    return;
                };
                text = commit_text;
                let sequence = shared.next_durable_sequence_candidate();
                let Some(storage_writer) = sinks.storage_writer else {
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
                    meeting_sample_start: task.meeting_sample_start,
                    meeting_sample_end: task.meeting_sample_end,
                    timeline_revision: 1,
                }) {
                    Ok(ack) => {
                        shared.advance_durable_sequence_after_ack(ack.final_segment.sequence);
                        let mut final_segment = ack.final_segment;
                        let mirror_error = if ack.duplicate {
                            None
                        } else {
                            append_live_text_final(
                                sinks.live_text_mirrors,
                                &final_segment.meeting_id,
                                &final_segment.text,
                            )
                        };
                        if !ack.duplicate
                            && let Some(translation) = sinks.translation
                        {
                            translation.decorate_and_submit(&mut final_segment);
                        }
                        Some(Ok((final_segment, ack.duplicate, mirror_error)))
                    }
                    Err(error) => {
                        task.session_errors.mark_incomplete(&error);
                        Some(Err(error))
                    }
                }
            } else {
                if !is_meaningful_transcript(&text) {
                    return;
                }
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
                    meeting_sample_start: task.meeting_sample_start.to_string(),
                    meeting_sample_end: task.meeting_sample_end.to_string(),
                    timeline_revision: 1,
                    translation_status: "disabled".to_owned(),
                    translation_target: None,
                    translation_text: None,
                    translation_error: None,
                };
                let _ = publish_if_current(
                    shared,
                    snapshot,
                    interim_generation,
                    &session_id,
                    move |current| {
                        shared.remember_published_interim(PublishedInterimTranscript {
                            session_id: task.session_id.clone(),
                            segment_id: task.segment_id.clone(),
                            revision: task.revision,
                            text: segment.text.clone(),
                            meeting_sample_start: task.meeting_sample_start,
                            meeting_sample_end: task.meeting_sample_end,
                        });
                        current.interim = Some(segment);
                        shared.published_interim.store(
                            interim_generation.expect("interim tasks carry a generation"),
                            Ordering::Release,
                        );
                        if !current
                            .error
                            .as_deref()
                            .is_some_and(should_preserve_public_commit_error)
                        {
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
                shared.clear_published_interim();
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
    result: Result<(DurableFinal, bool, Option<String>), String>,
) {
    match result {
        Ok((final_segment, duplicate, mirror_error)) => {
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
            if let Some(error) = mirror_error {
                set_public_error(current, &error);
            } else if !current
                .error
                .as_deref()
                .is_some_and(should_preserve_public_commit_error)
            {
                current.error = None;
            }
            current.enforce_bounds();
        }
        Err(error) => set_public_error(current, &error),
    }
}

#[cfg(windows)]
fn should_preserve_public_commit_error(error: &str) -> bool {
    matches!(
        error,
        "ASR_FINAL_OVERLOAD" | "LIVE_TEXT_MIRROR_WRITE_FAILED"
    )
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
struct CoordinatorContext {
    output: AudioCaptureOutput,
    submitter: InferenceSubmitter,
    session_id: String,
    stop: Arc<AtomicBool>,
    pause_gate: Arc<PauseGate>,
    errors: Arc<RuntimeErrors>,
    audio_source_mode: AudioSourceMode,
    raw_audio_writer: Option<RawAudioMeetingWriter>,
}

#[cfg(windows)]
fn spawn_coordinator(context: CoordinatorContext) -> Result<JoinHandle<()>, String> {
    thread::Builder::new()
        .name("meetingrelay-audio".to_owned())
        .spawn(move || coordinator_loop(context))
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
fn coordinator_loop(context: CoordinatorContext) {
    let CoordinatorContext {
        output,
        submitter,
        session_id,
        stop,
        pause_gate,
        errors,
        audio_source_mode,
        mut raw_audio_writer,
    } = context;
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
    let mut raw_timeline = RawAudioTimeline::default();

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
                persist_raw_packet(&mut raw_audio_writer, &mut raw_timeline, &packet, &errors);
                route_packet(packet, audio_source_mode, &mut system, &mut microphone);
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
            persist_raw_packet(&mut raw_audio_writer, &mut raw_timeline, &packet, &errors);
            route_packet(packet, audio_source_mode, &mut system, &mut microphone);
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
    if let Some(writer) = raw_audio_writer
        && writer.finalize().is_err()
    {
        record_runtime_error(&errors, 4);
        errors.mark_incomplete("RAW_AUDIO_WRITE_FAILED");
    }
}

#[cfg(windows)]
#[derive(Default)]
struct RawAudioTimeline {
    system_end: Option<u64>,
    microphone_end: Option<u64>,
}

#[cfg(windows)]
impl RawAudioTimeline {
    fn previous_end(&self, source: AudioSourceId) -> Option<u64> {
        match source {
            AudioSourceId::SystemOutput => self.system_end,
            AudioSourceId::Microphone => self.microphone_end,
        }
    }

    fn set_end(&mut self, source: AudioSourceId, end: u64) {
        match source {
            AudioSourceId::SystemOutput => self.system_end = Some(end),
            AudioSourceId::Microphone => self.microphone_end = Some(end),
        }
    }
}

#[cfg(windows)]
fn persist_raw_packet(
    writer: &mut Option<RawAudioMeetingWriter>,
    timeline: &mut RawAudioTimeline,
    packet: &RawAudioPacket,
    errors: &RuntimeErrors,
) {
    let Some(active_writer) = writer.as_mut() else {
        return;
    };
    let source_end = packet
        .captured_frame_start
        .saturating_add(u64::try_from(packet.frame_count()).unwrap_or(u64::MAX));
    let start = source_frame_to_meeting_sample(packet.captured_frame_start, packet.sample_rate);
    let mut end = source_frame_to_meeting_sample_ceil(source_end, packet.sample_rate);
    if end <= start {
        end = start.saturating_add(1);
    }
    let gap = timeline
        .previous_end(packet.source)
        .filter(|previous| start > *previous)
        .map(|previous| RawAudioGap {
            start: previous,
            end: start,
            reason: "CAPTURE_GAP".to_owned(),
        });
    if active_writer
        .append_packet(packet, MeetingSampleRange::new(start, end), gap)
        .is_err()
    {
        record_runtime_error(errors, 4);
        errors.mark_incomplete("RAW_AUDIO_WRITE_FAILED");
        *writer = None;
        return;
    }
    timeline.set_end(packet.source, end);
}

#[cfg(windows)]
fn source_frame_to_meeting_sample(frame: u64, sample_rate: u32) -> u64 {
    frame.saturating_mul(u64::from(TARGET_SAMPLE_RATE_HZ)) / u64::from(sample_rate.max(1))
}

#[cfg(windows)]
fn source_frame_to_meeting_sample_ceil(frame: u64, sample_rate: u32) -> u64 {
    frame
        .saturating_mul(u64::from(TARGET_SAMPLE_RATE_HZ))
        .saturating_add(u64::from(sample_rate.max(1)).saturating_sub(1))
        / u64::from(sample_rate.max(1))
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
    mode: AudioSourceMode,
    system: &mut SourcePipeline,
    microphone: &mut SourcePipeline,
) {
    match packet.source {
        AudioSourceId::SystemOutput if mode.captures_system() => system.push(packet),
        AudioSourceId::Microphone if mode.captures_microphone() => microphone.push(packet),
        _ => {}
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
fn submit_recovery_event(
    event: SegmentEvent,
    timeline_offset: u64,
    meeting_id: &str,
    submitter: &InferenceSubmitter,
    errors: &Arc<RuntimeErrors>,
) -> Result<(), String> {
    let SegmentEvent::Final { mut segment, .. } = event else {
        return Ok(());
    };
    segment.started_at_sample = segment.started_at_sample.saturating_add(timeline_offset);
    segment.ended_at_sample = segment.ended_at_sample.saturating_add(timeline_offset);
    let segment_id = format!(
        "recovered-{}-{}",
        segment.started_at_sample, segment.ended_at_sample
    );
    submitter.submit(inference_task(
        meeting_id,
        segment_id,
        1,
        true,
        segment,
        Arc::clone(errors),
    ))?;
    submitter.barrier_before(Instant::now() + MVP_SHUTDOWN_TIMEOUT)
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
    let meeting_sample_start = segment.started_at_sample;
    let meeting_sample_end = segment.ended_at_sample;
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
        meeting_sample_start,
        meeting_sample_end,
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
    let characters = text
        .chars()
        .filter(|character| character.is_alphanumeric())
        .collect::<Vec<_>>();
    if characters.is_empty() {
        return false;
    }
    let max_pattern_len = 4.min(characters.len() / 3);
    !(1..=max_pattern_len).any(|pattern_len| {
        characters
            .iter()
            .enumerate()
            .all(|(index, character)| *character == characters[index % pattern_len])
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mvp::secret_store::MemorySecretStore;

    #[cfg(windows)]
    use crate::mvp::{
        audio::AudioSampleFormat,
        dsp::{BLOCK_SAMPLES, SPEECH_START_BLOCKS},
    };

    fn unique_temp_root(test_name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "meetingrelay-service-{test_name}-{}-{}",
            std::process::id(),
            crate::mvp::storage::now_ms_string()
        ))
    }

    #[test]
    fn live_text_directory_must_be_existing_absolute_directory() {
        let root = unique_temp_root("live-text-validation");
        assert_eq!(
            validate_live_text_directory(Path::new("relative-live-text")).unwrap_err(),
            "LIVE_TEXT_DIRECTORY_NOT_ABSOLUTE"
        );
        assert_eq!(
            validate_live_text_directory(&root).unwrap_err(),
            "LIVE_TEXT_DIRECTORY_UNAVAILABLE"
        );
        std::fs::create_dir_all(&root).unwrap();
        let file_path = root.join("not-a-directory");
        std::fs::write(&file_path, "x").unwrap();

        assert_eq!(
            validate_live_text_directory(&file_path).unwrap_err(),
            "LIVE_TEXT_DIRECTORY_UNAVAILABLE"
        );
        assert_eq!(validate_live_text_directory(&root), Ok(()));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn live_text_mirror_creates_non_overwriting_utf8_lf_file() {
        let root = unique_temp_root("live-text-create");
        std::fs::create_dir_all(&root).unwrap();
        let meeting_id = "meeting-live-text-create";
        let expected_path = root.join(format!("MeetingRelay-{meeting_id}.txt"));
        std::fs::write(&expected_path, "existing").unwrap();

        assert_eq!(
            LiveTextMirror::begin(&root, meeting_id).unwrap_err(),
            "LIVE_TEXT_MIRROR_BEGIN_FAILED"
        );
        assert_eq!(std::fs::read_to_string(&expected_path).unwrap(), "existing");

        let other_meeting = "meeting-live-text-other";
        let mut mirror = LiveTextMirror::begin(&root, other_meeting).unwrap();
        mirror.append_final_original("第一行").unwrap();
        mirror.append_final_original("second line").unwrap();
        drop(mirror);

        let other_path = root.join(format!("MeetingRelay-{other_meeting}.txt"));
        assert_eq!(
            std::fs::read_to_string(other_path).unwrap(),
            "第一行\nsecond line\n"
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn live_text_error_disables_future_mirror_writes_for_meeting() {
        let root = unique_temp_root("live-text-error-disable");
        std::fs::create_dir_all(&root).unwrap();
        let meeting_id = "meeting-live-text-error-disable";
        let mirror = LiveTextMirror::begin(&root, meeting_id).unwrap();
        let mirrors = Mutex::new(HashMap::from([(meeting_id.to_owned(), mirror)]));

        let mut locked = lock(&mirrors);
        assert_eq!(
            disable_live_text_mirror_after_error(
                &mut locked,
                meeting_id,
                "LIVE_TEXT_MIRROR_WRITE_FAILED"
            ),
            "LIVE_TEXT_MIRROR_WRITE_FAILED"
        );
        drop(locked);
        assert_eq!(
            append_live_text_final(&mirrors, meeting_id, "ignored"),
            None
        );
        assert!(!lock(&mirrors).contains_key(meeting_id));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn live_text_start_failure_cleanup_removes_only_empty_mirror_file() {
        let root = unique_temp_root("live-text-cleanup");
        std::fs::create_dir_all(&root).unwrap();
        let empty_meeting = "meeting-live-text-empty-cleanup";
        let empty_path = root.join(format!("MeetingRelay-{empty_meeting}.txt"));
        let empty_mirror = LiveTextMirror::begin(&root, empty_meeting).unwrap();
        let mirrors = Mutex::new(HashMap::from([(empty_meeting.to_owned(), empty_mirror)]));

        cleanup_live_text_mirror_empty_file(&mirrors, empty_meeting);

        assert!(!empty_path.exists());
        assert!(!lock(&mirrors).contains_key(empty_meeting));

        let nonempty_meeting = "meeting-live-text-nonempty-cleanup";
        let nonempty_path = root.join(format!("MeetingRelay-{nonempty_meeting}.txt"));
        let mut nonempty_mirror = LiveTextMirror::begin(&root, nonempty_meeting).unwrap();
        nonempty_mirror
            .append_final_original("already written")
            .unwrap();
        let mirrors = Mutex::new(HashMap::from([(
            nonempty_meeting.to_owned(),
            nonempty_mirror,
        )]));

        cleanup_live_text_mirror_empty_file(&mirrors, nonempty_meeting);

        assert_eq!(
            std::fs::read_to_string(&nonempty_path).unwrap(),
            "already written\n"
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    #[cfg(unix)]
    fn live_text_append_reports_first_failure_and_disables_meeting() {
        let meeting_id = "meeting-live-text-disable";
        let mirror = LiveTextMirror {
            path: PathBuf::from("/dev/full"),
            file: std::fs::OpenOptions::new()
                .write(true)
                .open("/dev/full")
                .unwrap(),
        };
        let mirrors = Mutex::new(HashMap::from([(meeting_id.to_owned(), mirror)]));

        assert_eq!(
            append_live_text_final(&mirrors, meeting_id, "will fail").as_deref(),
            Some("LIVE_TEXT_MIRROR_WRITE_FAILED")
        );
        assert_eq!(
            append_live_text_final(&mirrors, meeting_id, "ignored"),
            None
        );
        assert!(!lock(&mirrors).contains_key(meeting_id));
    }

    #[cfg(windows)]
    fn write_file(path: &Path, contents: &str) {
        std::fs::create_dir_all(path.parent().expect("file has parent")).unwrap();
        std::fs::write(path, contents).unwrap();
    }

    #[cfg(windows)]
    fn create_installed_model_layout(exe_dir: &Path) -> LockedSherpaRealtimePaths {
        let paths = installed_model_path_candidates(exe_dir);
        write_file(&paths.model_path, "installed model");
        write_file(&paths.tokens_path, "installed tokens");
        std::fs::create_dir_all(&paths.runtime_lib_dir).unwrap();
        write_file(&paths.asset_lock_path, "installed asset lock");
        write_file(&paths.package_lock_path, "installed cargo lock");
        locked_paths_from_candidates(canonical_model_path_candidates(paths).unwrap())
    }

    #[cfg(windows)]
    fn create_workspace_model_layout(workspace_root: &Path) -> LockedSherpaRealtimePaths {
        let paths = workspace_model_path_candidates(workspace_root);
        write_file(&paths.model_path, "workspace model");
        write_file(&paths.tokens_path, "workspace tokens");
        std::fs::create_dir_all(&paths.runtime_lib_dir).unwrap();
        write_file(&paths.asset_lock_path, "workspace asset lock");
        write_file(&paths.package_lock_path, "workspace cargo lock");
        locked_paths_from_candidates(canonical_model_path_candidates(paths).unwrap())
    }

    #[cfg(windows)]
    fn locked_paths_from_candidates(paths: ModelPathCandidates) -> LockedSherpaRealtimePaths {
        LockedSherpaRealtimePaths {
            model_path: paths.model_path,
            tokens_path: paths.tokens_path,
            runtime_lib_dir: paths.runtime_lib_dir,
            asset_lock_path: paths.asset_lock_path,
            package_lock_path: paths.package_lock_path,
        }
    }

    #[test]
    fn provider_secret_status_never_exposes_secret_bytes() {
        let root = std::env::temp_dir().join(format!(
            "meetingrelay-secret-service-{}",
            crate::mvp::storage::now_ms_string()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let storage = MvpStorage::open_at(root.join("mvp.sqlite3")).unwrap();
        let service =
            MvpService::new_with_dependencies(Ok(storage), Arc::new(MemorySecretStore::new()));

        assert!(
            !service
                .secret_store_status(Some("cloud-primary"))
                .unwrap()
                .configured
        );
        let status = service
            .set_provider_secret("cloud-primary", "integration-secret".to_owned())
            .unwrap();
        assert!(status.available);
        assert!(status.configured);
        assert!(
            !serde_json::to_string(&status)
                .unwrap()
                .contains("integration-secret")
        );
        assert_eq!(
            service
                .provider_api_key("cloud-primary")
                .unwrap()
                .as_deref(),
            Some("integration-secret")
        );
        assert!(
            !service
                .delete_provider_secret("cloud-primary")
                .unwrap()
                .configured
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn local_provider_reports_that_a_vault_secret_is_not_required() {
        let root = std::env::temp_dir().join(format!(
            "meetingrelay-local-provider-secret-state-{}",
            crate::mvp::storage::now_ms_string()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let storage = MvpStorage::open_at(root.join("mvp.sqlite3")).unwrap();
        let service =
            MvpService::new_with_dependencies(Ok(storage), Arc::new(MemorySecretStore::new()));

        let profiles = service.provider_profiles().unwrap();
        let local = profiles
            .iter()
            .find(|profile| profile.profile_id == "provider-local-default")
            .expect("seeded local provider");
        assert_eq!(local.provider_class, "local");
        assert_eq!(local.secret_state, "not_required");

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn local_translation_resolution_stays_on_the_selected_loopback_profile() {
        let root = std::env::temp_dir().join(format!(
            "meetingrelay-local-provider-resolution-{}",
            crate::mvp::storage::now_ms_string()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let storage = MvpStorage::open_at(root.join("mvp.sqlite3")).unwrap();
        let service =
            MvpService::new_with_dependencies(Ok(storage), Arc::new(MemorySecretStore::new()));
        service
            .save_provider_profile(ProviderProfileUpdate {
                profile_id: "provider-local-default".to_owned(),
                label: "Local".to_owned(),
                provider_class: "local".to_owned(),
                base_url: "http://127.0.0.1:11434/v1".to_owned(),
                model: "qwen2.5:7b".to_owned(),
                policy_url: None,
                data_flow: "Loopback only.".to_owned(),
            })
            .unwrap();
        let resolved = service
            .resolve_translation_config(
                TranslationConfig {
                    enabled: true,
                    base_url: "https://api.example.invalid/v1".to_owned(),
                    model: "cloud-model-must-not-win".to_owned(),
                    api_key: Some("caller-secret-must-not-win".to_owned()),
                    target_language: "ja".to_owned(),
                    allow_insecure_http: true,
                },
                Some("provider-local-default"),
            )
            .unwrap();
        let validated = resolved.validate_enabled().unwrap();
        assert_eq!(
            validated.endpoint,
            "http://127.0.0.1:11434/v1/chat/completions"
        );
        assert_eq!(validated.model, "qwen2.5:7b");
        assert!(validated.api_key.is_none());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn live_translation_resolves_profile_and_secret_store_as_source_of_truth() {
        let root = std::env::temp_dir().join(format!(
            "meetingrelay-translation-provider-service-{}",
            crate::mvp::storage::now_ms_string()
        ));
        std::fs::create_dir_all(&root).unwrap();
        {
            let storage = MvpStorage::open_at(root.join("mvp.sqlite3")).unwrap();
            let service =
                MvpService::new_with_dependencies(Ok(storage), Arc::new(MemorySecretStore::new()));
            service
                .save_provider_profile(ProviderProfileUpdate {
                    profile_id: "provider-cloud-default".to_owned(),
                    label: "Cloud".to_owned(),
                    provider_class: "cloud".to_owned(),
                    base_url: "https://api.example.test/v1".to_owned(),
                    model: "translation-model".to_owned(),
                    policy_url: None,
                    data_flow: "Final transcript text is sent to the provider.".to_owned(),
                })
                .unwrap();
            service
                .set_provider_secret(
                    "provider-cloud-default",
                    "credential-manager-secret".to_owned(),
                )
                .unwrap();

            let resolved = service
                .resolve_translation_config(
                    TranslationConfig {
                        enabled: true,
                        base_url: "https://caller-must-not-win.invalid".to_owned(),
                        model: "caller-must-not-win".to_owned(),
                        api_key: Some("caller-secret-must-not-win".to_owned()),
                        target_language: "ja".to_owned(),
                        allow_insecure_http: false,
                    },
                    Some("provider-cloud-default"),
                )
                .unwrap();
            assert_eq!(resolved.base_url, "https://api.example.test/v1");
            assert_eq!(resolved.model, "translation-model");
            assert_eq!(resolved.target_language, "ja");
            assert_eq!(
                resolved.api_key.as_deref(),
                Some("credential-manager-secret")
            );
            assert!(!resolved.allow_insecure_http);
        }
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    #[ignore = "requires explicitly supplied live provider credentials and sends one external translation request"]
    fn live_provider_service_path_uses_profile_secret_store_and_persists_provenance() {
        if !cfg!(windows) {
            eprintln!("skipped: production SecretStore live service path requires Windows");
            return;
        }

        let base_url = required_live_env("MEETINGRELAY_LIVE_TRANSLATION_BASE_URL");
        let model = required_live_env("MEETINGRELAY_LIVE_TRANSLATION_MODEL");
        let api_key = required_live_env("MEETINGRELAY_LIVE_TRANSLATION_API_KEY");
        let allow_insecure_http =
            std::env::var("MEETINGRELAY_LIVE_TRANSLATION_ALLOW_INSECURE_HTTP")
                .is_ok_and(|value| value.eq_ignore_ascii_case("true"));
        let provider_class = if allow_insecure_http { "lan" } else { "cloud" };
        let now = crate::mvp::storage::now_ms_string();
        let profile_id = format!("live-service-{now}-{}", std::process::id());
        let root = std::env::temp_dir().join(format!(
            "meetingrelay-live-provider-service-{now}-{}",
            std::process::id()
        ));
        let cleanup = LiveProviderCleanup::new(root.clone(), profile_id.clone());
        std::fs::create_dir_all(&root).expect("create live provider temp dir");

        {
            let storage_path = root.join("mvp.sqlite3");
            let storage = MvpStorage::open_at(&storage_path).expect("open live provider storage");
            let service = MvpService::new_with_dependencies(
                Ok(storage.clone()),
                Arc::new(ProductionSecretStore::new()),
            );
            let writer = service
                .storage_writer
                .as_ref()
                .expect("live provider storage writer");

            let initial_model = "caller-must-not-win";
            let initial_endpoint_hash = TranslationConfig {
                enabled: true,
                base_url: base_url.clone(),
                model: initial_model.to_owned(),
                api_key: None,
                target_language: "zh".to_owned(),
                allow_insecure_http,
            }
            .validate_enabled()
            .expect("validate initial live provider profile")
            .endpoint_hash;
            let first = writer
                .save_provider_profile(ProviderProfileInput {
                    profile_id: Some(profile_id.clone()),
                    label: "Live service test initial".to_owned(),
                    provider_class: provider_class.to_owned(),
                    base_url: Some(base_url.clone()),
                    model: initial_model.to_owned(),
                    endpoint_hash: initial_endpoint_hash,
                    data_flow:
                        "Live ignored test sends one final transcript to the configured provider."
                            .to_owned(),
                    policy_url: None,
                    config_version: 1,
                    secret_state: "missing".to_owned(),
                    last_test_at: None,
                    last_test_status: None,
                    last_error: None,
                })
                .expect("save first live provider profile version");
            assert_eq!(first.config_version, 1);

            let saved = service
                .save_provider_profile(ProviderProfileUpdate {
                    profile_id: profile_id.clone(),
                    label: "Live service test".to_owned(),
                    provider_class: provider_class.to_owned(),
                    base_url: base_url.clone(),
                    model: model.clone(),
                    policy_url: None,
                    data_flow:
                        "Live ignored test sends one final transcript to the configured provider."
                            .to_owned(),
                })
                .expect("save second live provider profile version");
            assert_eq!(saved.config_version, 2);
            assert_eq!(
                service
                    .provider_profile_history(&profile_id)
                    .expect("read live provider profile history")
                    .len(),
                2
            );

            let status = service
                .set_provider_secret(&profile_id, api_key)
                .expect("store live provider secret in production SecretStore");
            assert!(status.available);
            assert!(status.configured);
            let stored_key_matches = service
                .provider_api_key(&profile_id)
                .expect("read live provider secret from production SecretStore")
                .as_deref()
                .is_some_and(|stored| {
                    stored == required_live_env("MEETINGRELAY_LIVE_TRANSLATION_API_KEY")
                });
            assert!(
                stored_key_matches,
                "live provider secret did not round-trip through production SecretStore"
            );

            let meeting = writer
                .start_meeting_with_metadata(
                    true,
                    "live service test model",
                    "Live provider service test",
                    "en",
                )
                .expect("start live provider test meeting");
            let source_text =
                "Please translate this short MeetingRelay provider integration test sentence.";
            writer
                .commit_final(FinalCandidate {
                    meeting_id: meeting.id.clone(),
                    segment_id: "live-segment-1".to_owned(),
                    sequence: 1,
                    revision: 1,
                    text: source_text.to_owned(),
                    started_at_ms: "0".to_owned(),
                    ended_at_ms: "1000".to_owned(),
                    meeting_sample_start: 0,
                    meeting_sample_end: 16_000,
                    timeline_revision: 1,
                })
                .expect("commit live provider source final");
            writer
                .complete_meeting(&meeting.id)
                .expect("complete live provider test meeting");

            service
                .retry_translation_segment(
                    &meeting.id,
                    "live-segment-1",
                    "1",
                    "en",
                    TranslationConfig {
                        enabled: true,
                        base_url: "https://caller-must-not-win.invalid/v1".to_owned(),
                        model: "caller-must-not-win".to_owned(),
                        api_key: Some("caller-secret-must-not-win".to_owned()),
                        target_language: "zh".to_owned(),
                        allow_insecure_http: false,
                    },
                    &profile_id,
                )
                .expect("live provider translation through service profile path");

            let snapshot = storage
                .snapshot(&meeting.id)
                .expect("read live provider meeting snapshot");
            assert_eq!(snapshot.finals.len(), 1);
            let final_segment = &snapshot.finals[0];
            assert_eq!(final_segment.text, source_text);
            assert_eq!(final_segment.translation_status, "completed");
            assert_eq!(final_segment.translation_target.as_deref(), Some("zh"));
            let translated = final_segment
                .translation_text
                .as_deref()
                .expect("live provider translated text persisted");
            assert!(!translated.trim().is_empty());

            let attempt = read_live_translation_attempt(&storage_path, &meeting.id);
            assert_eq!(attempt.target_language, "zh");
            assert_eq!(attempt.provider, "openai-compatible");
            assert_eq!(attempt.config_version, "meetingrelay.translation.config.v1");
            assert_eq!(attempt.model, model);
            assert_eq!(attempt.prompt_version, "meetingrelay.translation.prompt.v1");
            assert_eq!(attempt.request_schema_version, "openai.chat.completions.v1");
            assert_eq!(attempt.status, "completed");
            assert!(attempt.error_code.is_none());
            assert!(attempt.completed_at.is_some());
            assert!(attempt.endpoint_origin.is_some());
            assert_eq!(attempt.endpoint_hash.len(), 64);

            println!(
                "live provider service path passed: model={}, target={}, profile_versions=2, attempt={}, endpoint_hash={}",
                attempt.model, attempt.target_language, attempt.attempt, attempt.endpoint_hash
            );
        }

        drop(cleanup);
    }

    #[derive(Debug)]
    struct LiveProviderAttempt {
        target_language: String,
        attempt: u32,
        provider: String,
        config_version: String,
        endpoint_origin: Option<String>,
        endpoint_hash: String,
        model: String,
        prompt_version: String,
        request_schema_version: String,
        status: String,
        error_code: Option<String>,
        completed_at: Option<String>,
    }

    struct LiveProviderCleanup {
        root: std::path::PathBuf,
        profile_id: String,
    }

    impl LiveProviderCleanup {
        fn new(root: std::path::PathBuf, profile_id: String) -> Self {
            Self { root, profile_id }
        }
    }

    impl Drop for LiveProviderCleanup {
        fn drop(&mut self) {
            if let Ok(secret_id) = provider_secret_id(&self.profile_id) {
                let _ = ProductionSecretStore::new().delete(&secret_id);
            }
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    fn required_live_env(name: &str) -> String {
        let value = std::env::var(name).unwrap_or_else(|_| panic!("{name} is required"));
        let trimmed = value.trim();
        assert!(!trimmed.is_empty(), "{name} must not be empty");
        trimmed.to_owned()
    }

    fn read_live_translation_attempt(
        storage_path: &std::path::Path,
        meeting_id: &str,
    ) -> LiveProviderAttempt {
        let connection =
            rusqlite::Connection::open(storage_path).expect("open live provider sqlite");
        connection
            .query_row(
                "SELECT target_language, attempt, provider, config_version, endpoint_origin,
                        endpoint_hash, model, prompt_version, request_schema_version, status,
                        error_code, completed_at
                 FROM mvp_translation_attempts
                 WHERE meeting_id=?1
                 ORDER BY attempt DESC
                 LIMIT 1",
                rusqlite::params![meeting_id],
                |row| {
                    Ok(LiveProviderAttempt {
                        target_language: row.get(0)?,
                        attempt: row.get(1)?,
                        provider: row.get(2)?,
                        config_version: row.get(3)?,
                        endpoint_origin: row.get(4)?,
                        endpoint_hash: row.get(5)?,
                        model: row.get(6)?,
                        prompt_version: row.get(7)?,
                        request_schema_version: row.get(8)?,
                        status: row.get(9)?,
                        error_code: row.get(10)?,
                        completed_at: row.get(11)?,
                    })
                },
            )
            .expect("read live provider translation attempt")
    }

    #[test]
    fn export_uses_the_requested_completed_summary_version() {
        let root = std::env::temp_dir().join(format!(
            "meetingrelay-summary-export-service-{}",
            crate::mvp::storage::now_ms_string()
        ));
        std::fs::create_dir_all(&root).unwrap();
        {
            let storage = MvpStorage::open_at(root.join("mvp.sqlite3")).unwrap();
            let service =
                MvpService::new_with_dependencies(Ok(storage), Arc::new(MemorySecretStore::new()));
            let writer = service.storage_writer.as_ref().unwrap();
            let meeting = writer.start_meeting(true, "test model").unwrap();
            writer
                .commit_final(FinalCandidate {
                    meeting_id: meeting.id.clone(),
                    segment_id: "segment-1".to_owned(),
                    sequence: 1,
                    revision: 1,
                    text: "source transcript".to_owned(),
                    started_at_ms: "0".to_owned(),
                    ended_at_ms: "1000".to_owned(),
                    meeting_sample_start: 0,
                    meeting_sample_end: 16_000,
                    timeline_revision: 1,
                })
                .unwrap();
            writer.complete_meeting(&meeting.id).unwrap();
            let first = writer
                .start_summary_job(SummaryJobInput {
                    meeting_id: meeting.id.clone(),
                    provider_profile_id: None,
                    prompt_version: "summary.prompt.v1".to_owned(),
                    request_schema_version: "summary.request.v1".to_owned(),
                })
                .unwrap();
            writer
                .append_summary_result(SummaryResultInput {
                    job_id: first.job_id.clone(),
                    section_kind: "overview".to_owned(),
                    section_index: 0,
                    heading: "概览".to_owned(),
                    text: "VERSION_ONE_MARKER".to_owned(),
                    citation_segment_ids: vec!["segment-1".to_owned()],
                })
                .unwrap();
            writer.finish_summary_job(&first.job_id).unwrap();
            let second = writer
                .retry_summary_job(
                    &first.job_id,
                    SummaryJobInput {
                        meeting_id: meeting.id.clone(),
                        provider_profile_id: None,
                        prompt_version: "summary.prompt.v1".to_owned(),
                        request_schema_version: "summary.request.v1".to_owned(),
                    },
                )
                .unwrap();
            writer
                .append_summary_result(SummaryResultInput {
                    job_id: second.job_id.clone(),
                    section_kind: "overview".to_owned(),
                    section_index: 0,
                    heading: "概览".to_owned(),
                    text: "VERSION_TWO_MARKER".to_owned(),
                    citation_segment_ids: vec!["segment-1".to_owned()],
                })
                .unwrap();
            writer.finish_summary_job(&second.job_id).unwrap();

            let result = service
                .export_meeting_options(
                    &meeting.id,
                    "summary-version-one".to_owned(),
                    ExportOptions {
                        formats: vec!["json".to_owned()],
                        include_original: false,
                        include_translation: false,
                        bilingual: false,
                        include_speaker: false,
                        include_summary: true,
                        include_timestamp: true,
                        summary_version: Some(1),
                        speaker_version: None,
                        summary: None,
                    },
                )
                .unwrap();
            let content = std::fs::read_to_string(&result.artifacts[0].path).unwrap();
            assert!(content.contains("VERSION_ONE_MARKER"));
            assert!(!content.contains("VERSION_TWO_MARKER"));
        }
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn summary_requires_explicit_provider_and_non_local_risk_acceptance() {
        let root = std::env::temp_dir().join(format!(
            "meetingrelay-summary-consent-service-{}",
            crate::mvp::storage::now_ms_string()
        ));
        std::fs::create_dir_all(&root).unwrap();
        {
            let storage = MvpStorage::open_at(root.join("mvp.sqlite3")).unwrap();
            let service =
                MvpService::new_with_dependencies(Ok(storage), Arc::new(MemorySecretStore::new()));
            let writer = service.storage_writer.as_ref().unwrap();
            let meeting = writer.start_meeting(true, "test model").unwrap();
            writer
                .commit_final(FinalCandidate {
                    meeting_id: meeting.id.clone(),
                    segment_id: "segment-1".to_owned(),
                    sequence: 1,
                    revision: 1,
                    text: "private transcript".to_owned(),
                    started_at_ms: "0".to_owned(),
                    ended_at_ms: "1000".to_owned(),
                    meeting_sample_start: 0,
                    meeting_sample_end: 16_000,
                    timeline_revision: 1,
                })
                .unwrap();
            writer.complete_meeting(&meeting.id).unwrap();

            assert_eq!(
                service
                    .start_summary(&meeting.id, None, "zh", false)
                    .unwrap_err(),
                "SUMMARY_PROVIDER_REQUIRED"
            );
            assert_eq!(
                service
                    .start_summary(&meeting.id, Some("provider-cloud-default"), "zh", false)
                    .unwrap_err(),
                "SUMMARY_RISK_ACK_REQUIRED"
            );
        }
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn diagnostic_bundle_contains_required_sections_without_sensitive_values() {
        let root = std::env::temp_dir().join(format!(
            "meetingrelay-diagnostic-service-{}",
            crate::mvp::storage::now_ms_string()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let path = {
            let storage = MvpStorage::open_at(root.join("mvp.sqlite3")).unwrap();
            let service =
                MvpService::new_with_dependencies(Ok(storage), Arc::new(MemorySecretStore::new()));
            service
                .set_provider_secret(
                    "provider-cloud-default",
                    "diagnostic-super-secret".to_owned(),
                )
                .unwrap();
            lock(&service.snapshot).error =
                Some("Authorization: Bearer diagnostic-super-secret".to_owned());

            let result = service.create_diagnostic_bundle().unwrap();
            assert!(result.redacted);
            let text = std::fs::read_to_string(&result.path).unwrap();
            assert!(!text.contains("diagnostic-super-secret"));
            assert!(!text.to_ascii_lowercase().contains("authorization"));
            assert!(!text.to_ascii_lowercase().contains("bearer "));
            let value = serde_json::from_str::<serde_json::Value>(&text).unwrap();
            for section in [
                "database",
                "disk",
                "queues",
                "runtime",
                "model",
                "providers",
                "recentErrors",
            ] {
                assert!(
                    value.get(section).is_some(),
                    "missing diagnostic section {section}"
                );
            }
            assert_eq!(value["database"]["status"], "ok");
            assert_eq!(value["database"]["readProbe"], true);
            assert_eq!(
                value["runtime"]["secretStore"]["backend"],
                if cfg!(windows) {
                    "windows-credential-manager"
                } else {
                    "unsupported"
                }
            );
            let providers = value["providers"].as_array().unwrap();
            assert_eq!(providers.len(), 3);
            assert!(
                providers
                    .iter()
                    .all(|provider| provider.get("baseUrl").is_none())
            );
            result.path
        };
        assert!(std::path::Path::new(&path).is_file());
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(windows)]
    #[test]
    fn disk_space_probe_uses_no_window_flag() {
        assert_eq!(CREATE_NO_WINDOW, 0x0800_0000);
    }

    #[cfg(windows)]
    #[test]
    fn available_disk_bytes_handles_data_dir_with_spaces() {
        let root = std::env::temp_dir().join(format!(
            "meetingrelay disk probe {}",
            crate::mvp::storage::now_ms_string()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let free_bytes = available_disk_bytes(&root);
        let _ = std::fs::remove_dir_all(&root);
        assert!(
            free_bytes.is_some_and(|bytes| bytes > 0),
            "disk free-space probe should work for data directories containing spaces"
        );
    }

    #[test]
    fn delete_preview_execute_restore_and_fault_rollback_match() {
        let root = std::env::temp_dir().join(format!(
            "meetingrelay-governance-service-{}",
            crate::mvp::storage::now_ms_string()
        ));
        std::fs::create_dir_all(&root).unwrap();
        {
            let storage = MvpStorage::open_at(root.join("mvp.sqlite3")).unwrap();
            let reader = storage.clone();
            let service =
                MvpService::new_with_dependencies(Ok(storage), Arc::new(MemorySecretStore::new()));
            let writer = service.storage_writer.as_ref().unwrap();

            let meeting = writer.start_meeting(true, "test model").unwrap();
            writer.complete_meeting(&meeting.id).unwrap();
            let raw = root.join("raw").join(&meeting.id);
            let derived = root.join("derived").join(&meeting.id);
            std::fs::create_dir_all(&raw).unwrap();
            std::fs::create_dir_all(&derived).unwrap();
            std::fs::write(raw.join("system.wav"), b"raw-bytes").unwrap();
            std::fs::write(derived.join("summary.json"), b"derived-bytes").unwrap();

            let preview = service.delete_preview(&meeting.id, false, true).unwrap();
            let deleted = service
                .delete_execute(
                    &meeting.id,
                    preview.recovery_window_seconds,
                    preview.include_raw,
                    preview.include_derived,
                )
                .unwrap();
            assert!(deleted.deleted);
            assert_eq!(deleted.entries_deleted, preview.entries.len());
            assert_eq!(deleted.bytes_deleted, preview.will_delete_bytes);
            assert!(raw.exists());
            assert!(!derived.exists());
            assert!(reader.meeting_library_item(&meeting.id).unwrap().is_none());

            let restored = service.delete_restore(&meeting.id).unwrap();
            assert!(!restored.deleted);
            assert_eq!(std::fs::read(raw.join("system.wav")).unwrap(), b"raw-bytes");
            assert_eq!(
                std::fs::read(derived.join("summary.json")).unwrap(),
                b"derived-bytes"
            );
            assert!(reader.meeting_library_item(&meeting.id).unwrap().is_some());

            let faulted = writer.start_meeting(true, "test model").unwrap();
            writer.complete_meeting(&faulted.id).unwrap();
            let faulted_raw = root.join("raw").join(&faulted.id);
            std::fs::create_dir_all(&faulted_raw).unwrap();
            std::fs::write(faulted_raw.join("system.wav"), b"must-survive").unwrap();
            assert_eq!(
                service
                    .delete_execute_with(
                        &faulted.id,
                        GOVERNANCE_RECOVERY_WINDOW_SECONDS,
                        true,
                        true,
                        |_| Err("MVP_STORAGE_FAULT_INJECTED".to_owned()),
                    )
                    .unwrap_err(),
                "MVP_STORAGE_FAULT_INJECTED"
            );
            assert_eq!(
                std::fs::read(faulted_raw.join("system.wav")).unwrap(),
                b"must-survive"
            );
            assert!(reader.snapshot(&faulted.id).is_ok());
        }
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(windows)]
    #[test]
    fn speaker_diarization_requires_completed_raw_audio_without_writing_fallback_version() {
        let (storage, writer) = temp_storage_writer("speaker-raw-required");
        let service = MvpService::new_with_dependencies(
            Ok(storage.clone()),
            Arc::new(MemorySecretStore::new()),
        );
        let meeting = writer.start_meeting(true, "test model").unwrap();
        writer
            .commit_final(crate::mvp::storage::FinalCandidate {
                meeting_id: meeting.id.clone(),
                segment_id: "segment-1".to_owned(),
                sequence: 1,
                revision: 1,
                text: "speaker source".to_owned(),
                started_at_ms: "0".to_owned(),
                ended_at_ms: "1000".to_owned(),
                meeting_sample_start: 0,
                meeting_sample_end: 16_000,
                timeline_revision: 1,
            })
            .unwrap();
        writer.complete_meeting(&meeting.id).unwrap();

        let result = service.diarize_speakers(&meeting.id).unwrap();
        assert_eq!(result.status, "unavailable");
        assert_eq!(result.version, None);
        assert_eq!(result.reason.as_deref(), Some("SPEAKER_RAW_AUDIO_REQUIRED"));
        assert!(
            storage
                .latest_speaker_version(&meeting.id)
                .unwrap()
                .is_none()
        );
    }

    #[cfg(windows)]
    #[test]
    fn speaker_diarization_rejects_active_meetings_before_raw_audio_access() {
        let (storage, writer) = temp_storage_writer("speaker-active");
        let service =
            MvpService::new_with_dependencies(Ok(storage), Arc::new(MemorySecretStore::new()));
        let meeting = writer.start_meeting(true, "test model").unwrap();

        assert_eq!(
            service.diarize_speakers(&meeting.id).unwrap_err(),
            "SPEAKER_MEETING_ACTIVE"
        );
    }

    #[cfg(windows)]
    #[test]
    fn speaker_manual_edits_allow_exact_retry_but_reject_stale_new_keys() {
        let root = std::env::temp_dir().join(format!(
            "meetingrelay-service-speaker-edit-{}",
            crate::mvp::storage::now_ms_string()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let storage = MvpStorage::open_at(root.join("mvp.sqlite3")).unwrap();
        let service = MvpService::new_with_dependencies(
            Ok(storage.clone()),
            Arc::new(MemorySecretStore::new()),
        );
        let writer = service.storage_writer.as_ref().unwrap();
        let meeting = writer.start_meeting(true, "test model").unwrap();
        for sequence in 1..=2 {
            writer
                .commit_final(crate::mvp::storage::FinalCandidate {
                    meeting_id: meeting.id.clone(),
                    segment_id: format!("segment-{sequence}"),
                    sequence,
                    revision: 1,
                    text: format!("speaker {sequence}"),
                    started_at_ms: "0".to_owned(),
                    ended_at_ms: "1000".to_owned(),
                    meeting_sample_start: sequence * 16_000,
                    meeting_sample_end: sequence * 16_000 + 16_000,
                    timeline_revision: 1,
                })
                .unwrap();
        }
        writer.complete_meeting(&meeting.id).unwrap();
        writer
            .record_speaker_version(
                &meeting.id,
                crate::mvp::speaker::SpeakerVersionDraft {
                    parent_version: None,
                    base_version: None,
                    algorithm: "test.speaker.v1".to_owned(),
                    identities: vec![
                        crate::mvp::speaker::SpeakerIdentity {
                            speaker_id: "spk-1".to_owned(),
                            display_name: "Speaker 1".to_owned(),
                        },
                        crate::mvp::speaker::SpeakerIdentity {
                            speaker_id: "spk-2".to_owned(),
                            display_name: "Speaker 2".to_owned(),
                        },
                    ],
                    assignments: vec![
                        crate::mvp::speaker::SpeakerSegmentAssignment {
                            segment_id: "segment-1".to_owned(),
                            sequence: 1,
                            source_revision: 1,
                            speaker_id: "spk-1".to_owned(),
                            confidence: 0.9,
                        },
                        crate::mvp::speaker::SpeakerSegmentAssignment {
                            segment_id: "segment-2".to_owned(),
                            sequence: 2,
                            source_revision: 1,
                            speaker_id: "spk-2".to_owned(),
                            confidence: 0.9,
                        },
                    ],
                    operation: "diarize".to_owned(),
                    idempotency_key: Some("initial".to_owned()),
                },
            )
            .unwrap();

        let rename_request = SpeakerRenameRequest {
            meeting_id: meeting.id.clone(),
            speaker_id: "spk-1".to_owned(),
            display_name: "Alice".to_owned(),
            base_version: 1,
            idempotency_key: "rename-exact".to_owned(),
        };
        assert_eq!(
            service
                .rename_speaker(rename_request.clone())
                .unwrap()
                .version,
            2
        );
        assert_eq!(service.rename_speaker(rename_request).unwrap().version, 2);

        let merge_request = SpeakerMergeRequest {
            meeting_id: meeting.id.clone(),
            from_speaker_id: "spk-2".to_owned(),
            into_speaker_id: "spk-1".to_owned(),
            display_name: Some("Alice".to_owned()),
            base_version: 2,
            idempotency_key: "merge-exact".to_owned(),
        };
        assert_eq!(
            service
                .merge_speakers(merge_request.clone())
                .unwrap()
                .version,
            3
        );
        assert_eq!(service.merge_speakers(merge_request).unwrap().version, 3);

        let undo_request = SpeakerUndoRequest {
            meeting_id: meeting.id.clone(),
            base_version: 3,
            idempotency_key: "undo-exact".to_owned(),
        };
        assert_eq!(
            service
                .undo_speaker_edit(undo_request.clone())
                .unwrap()
                .version,
            4
        );
        assert_eq!(service.undo_speaker_edit(undo_request).unwrap().version, 4);

        assert_eq!(
            service
                .rename_speaker(SpeakerRenameRequest {
                    meeting_id: meeting.id.clone(),
                    speaker_id: "spk-1".to_owned(),
                    display_name: "Stale".to_owned(),
                    base_version: 2,
                    idempotency_key: "rename-stale-new".to_owned(),
                })
                .unwrap_err(),
            "SPEAKER_BASE_VERSION_CONFLICT"
        );
        let _ = std::fs::remove_dir_all(root);
    }

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
            meeting_sample_start: 0,
            meeting_sample_end: 320,
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
            audio_source_mode: AudioSourceMode::Both,
            last_disk_check_ms: AtomicU64::new(0),
            started: Instant::now(),
            meeting_id: meeting_id.to_owned(),
        }
    }

    #[cfg(windows)]
    fn durable_final_for_test(sequence: u64, text: &str) -> DurableFinal {
        DurableFinal {
            meeting_id: "meeting-test".to_owned(),
            segment_id: format!("segment-{sequence}"),
            sequence,
            revision: 1,
            text: text.to_owned(),
            started_at_ms: "0".to_owned(),
            ended_at_ms: "20".to_owned(),
            content_sha256: sha256_hex(text.as_bytes()),
            committed_at: now_ms_string(),
            commit_id: format!("commit-{sequence}"),
            meeting_sample_start: 0,
            meeting_sample_end: 320,
            timeline_revision: 1,
            translation_status: "disabled".to_owned(),
            translation_target: None,
            translation_text: None,
            translation_error: None,
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
    fn unavailable_storage_exposes_restart_scoped_data_directory_recovery() {
        let configured = std::env::temp_dir().join("meetingrelay-unavailable-data-root");
        let settings =
            data_directory_settings_snapshot(configured.clone(), false, configured.clone());

        assert!(!settings.active_storage_available);
        assert!(settings.restart_required);
        assert_eq!(settings.active_data_dir, configured.to_string_lossy());
        assert_eq!(settings.configured_data_dir, configured.to_string_lossy());
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
    fn mode_source_snapshots_disable_unselected_sources() {
        let system = AudioDevicePreflight {
            source: AudioSourceId::SystemOutput,
            device_id: "system-device".to_owned(),
            name: "System Device".to_owned(),
            sample_rate: TARGET_SAMPLE_RATE_HZ,
            channels: 1,
            sample_format: AudioSampleFormat::F32,
        };
        let microphone = AudioDevicePreflight {
            source: AudioSourceId::Microphone,
            device_id: "microphone-device".to_owned(),
            name: "Microphone Device".to_owned(),
            sample_rate: TARGET_SAMPLE_RATE_HZ,
            channels: 1,
            sample_format: AudioSampleFormat::F32,
        };
        let mut snapshot = MvpSnapshot::booting();

        apply_mode_sources(
            &mut snapshot,
            AudioSourceMode::SystemOnly,
            &system,
            &microphone,
            true,
        );

        assert!(snapshot.system.ready);
        assert!(snapshot.system.active);
        assert_eq!(snapshot.system.status, SourceStatus::Capturing);
        assert!(!snapshot.microphone.ready);
        assert!(!snapshot.microphone.active);
        assert_eq!(snapshot.microphone.frames, "0");
        assert_eq!(snapshot.microphone.peak, 0.0);
        assert_eq!(snapshot.microphone.status, SourceStatus::Disabled);
        assert_eq!(snapshot.microphone.error, None);

        apply_mode_sources(
            &mut snapshot,
            AudioSourceMode::MicrophoneOnly,
            &system,
            &microphone,
            true,
        );

        assert!(!snapshot.system.ready);
        assert!(!snapshot.system.active);
        assert_eq!(snapshot.system.frames, "0");
        assert_eq!(snapshot.system.status, SourceStatus::Disabled);
        assert!(snapshot.microphone.ready);
        assert!(snapshot.microphone.active);
        assert_eq!(snapshot.microphone.status, SourceStatus::Capturing);
    }

    #[cfg(windows)]
    #[test]
    fn paused_and_resume_helpers_preserve_disabled_source_state() {
        let mut snapshot = MvpSnapshot::booting();
        snapshot.lifecycle = Lifecycle::Recording;
        snapshot.durability_status = "recording".to_owned();
        snapshot.system = AudioSourceSnapshot {
            id: SourceId::System,
            label: "System Device".to_owned(),
            ready: true,
            active: true,
            frames: "128".to_owned(),
            peak: 0.5,
            status: SourceStatus::Capturing,
            error: None,
        };
        snapshot.microphone = disabled_source(SourceId::Microphone);

        apply_paused_snapshot_for_mode(&mut snapshot, AudioSourceMode::SystemOnly, None);

        assert_eq!(snapshot.lifecycle, Lifecycle::Paused);
        assert!(!snapshot.system.active);
        assert_eq!(snapshot.system.status, SourceStatus::Ready);
        assert!(!snapshot.microphone.ready);
        assert!(!snapshot.microphone.active);
        assert_eq!(snapshot.microphone.frames, "0");
        assert_eq!(snapshot.microphone.status, SourceStatus::Disabled);

        apply_disabled_sources(&mut snapshot, AudioSourceMode::SystemOnly);

        assert_eq!(snapshot.microphone.frames, "0");
        assert_eq!(snapshot.microphone.peak, 0.0);
        assert_eq!(snapshot.microphone.status, SourceStatus::Disabled);
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
                captured_frame_start: 0,
                samples: vec![0.5; 16],
            })
            .unwrap();
        sender
            .send(RawAudioPacket {
                source: AudioSourceId::Microphone,
                sample_rate: TARGET_SAMPLE_RATE_HZ,
                channels: 1,
                captured_frame_start: 0,
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
            captured_frame_start: 0,
            samples: vec![0.5; 16],
        });
        microphone.push(RawAudioPacket {
            source: AudioSourceId::Microphone,
            sample_rate: TARGET_SAMPLE_RATE_HZ,
            channels: 1,
            captured_frame_start: 0,
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
            meeting_sample_start: "0".to_owned(),
            meeting_sample_end: "320".to_owned(),
            timeline_revision: 1,
            translation_status: "disabled".to_owned(),
            translation_target: None,
            translation_text: None,
            translation_error: None,
        });

        let returned = public_snapshot(&mut snapshot, Some(&submitter));
        assert!(returned.interim.is_none());
        assert!(snapshot.interim.is_none());
    }

    #[cfg(windows)]
    #[test]
    fn final_invalidation_scrubs_visible_interim_but_retains_matching_salvage_record() {
        let (submitter, _finals) = test_submitter();
        submitter
            .shared
            .published_interim
            .store(1, Ordering::Release);
        submitter.shared.latest_interim.store(2, Ordering::Release);
        submitter
            .shared
            .remember_published_interim(PublishedInterimTranscript {
                session_id: "session-test".to_owned(),
                segment_id: "segment-1".to_owned(),
                revision: 2,
                text: "今天我们讨论发布流程".to_owned(),
                meeting_sample_start: 1_600,
                meeting_sample_end: 32_000,
            });
        let mut snapshot = MvpSnapshot::booting();
        snapshot.session_id = Some("session-test".to_owned());
        snapshot.interim = Some(TranscriptSegment {
            segment_id: "segment-1".to_owned(),
            sequence: "0".to_owned(),
            revision: 2,
            is_final: false,
            saved: false,
            text: "今天我们讨论发布流程".to_owned(),
            started_at_ms: "100".to_owned(),
            ended_at_ms: None,
            committed_at: None,
            commit_id: None,
            meeting_sample_start: "1600".to_owned(),
            meeting_sample_end: "32000".to_owned(),
            timeline_revision: 1,
            translation_status: "disabled".to_owned(),
            translation_target: None,
            translation_text: None,
            translation_error: None,
        });

        let returned = public_snapshot(&mut snapshot, Some(&submitter));

        assert!(returned.interim.is_none());
        assert!(snapshot.interim.is_none());
        assert_eq!(
            submitter.shared.published_interim.load(Ordering::Acquire),
            0
        );
        let retained = submitter
            .shared
            .published_interim_record()
            .expect("scrubbed UI interim should remain available for final salvage");
        let matching_final = TranscriptCandidateBounds {
            session_id: "session-test",
            segment_id: "segment-1",
            revision: 3,
            meeting_sample_start: 1_600,
            meeting_sample_end: 64_000,
        };
        assert_eq!(
            meaningful_final_text_or_interim(matching_final, "。", Some(&retained)).as_deref(),
            Some("今天我们讨论发布流程")
        );
        let other_session = TranscriptCandidateBounds {
            session_id: "other-session",
            ..matching_final
        };
        let other_segment = TranscriptCandidateBounds {
            segment_id: "segment-2",
            ..matching_final
        };
        assert!(meaningful_final_text_or_interim(other_session, "。", Some(&retained)).is_none());
        assert!(meaningful_final_text_or_interim(other_segment, "。", Some(&retained)).is_none());
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
    fn final_queue_absorbs_a_transient_high_speech_rate_burst() {
        let (submitter, finals) = test_submitter();
        for revision in 1..=MAX_INFERENCE_QUEUE_DEPTH {
            submitter
                .submit(queued_task(u32::try_from(revision).unwrap(), true))
                .unwrap();
        }
        let drainer = thread::spawn(move || {
            thread::sleep(Duration::from_millis(20));
            let task = finals.recv().unwrap();
            thread::sleep(Duration::from_millis(50));
            task
        });

        let started = Instant::now();
        submitter.submit(queued_task(99, true)).unwrap();

        assert!(started.elapsed() < FINAL_QUEUE_BACKPRESSURE);
        assert!(drainer.join().unwrap().is_final);
    }

    #[cfg(windows)]
    #[test]
    fn transcription_retry_classifier_only_retries_recoverable_replayable_tasks() {
        let task = queued_task(1, false);
        assert!(should_retry_transcription(
            &RecognizerError::Sherpa(LockedSherpaRealtimeError::RecognitionUnavailable),
            &task
        ));
        assert!(should_retry_transcription(
            &RecognizerError::Sherpa(LockedSherpaRealtimeError::NotPrepared),
            &task
        ));
        assert!(!should_retry_transcription(
            &RecognizerError::Sherpa(LockedSherpaRealtimeError::EmptySegment),
            &task
        ));
        assert!(!should_retry_transcription(
            &RecognizerError::Sherpa(LockedSherpaRealtimeError::SegmentTooLarge),
            &task
        ));
        assert!(!should_retry_transcription(
            &RecognizerError::Sherpa(LockedSherpaRealtimeError::InvalidAudio),
            &task
        ));

        let empty = InferenceTask {
            samples: Arc::<[i16]>::from([]),
            ..queued_task(1, false)
        };
        assert!(!should_retry_transcription(
            &RecognizerError::Sherpa(LockedSherpaRealtimeError::RecognitionUnavailable),
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
    fn resolve_model_paths_prefers_complete_installed_layout_without_env_overrides() {
        let root = unique_temp_root("installed-layout");
        let exe_dir = root.join("app");
        let workspace_root = root.join("workspace");
        std::fs::create_dir_all(&exe_dir).unwrap();
        std::fs::create_dir_all(&workspace_root).unwrap();
        let installed = create_installed_model_layout(&exe_dir);
        let _workspace = create_workspace_model_layout(&workspace_root);

        let resolved = resolve_model_paths_from(
            &exe_dir.canonicalize().unwrap(),
            &workspace_root.canonicalize().unwrap(),
            ModelPathOverrides::default(),
        )
        .unwrap();

        assert_eq!(resolved, installed);
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(windows)]
    #[test]
    fn resolve_model_paths_uses_installed_layout_when_build_checkout_is_absent() {
        let root = unique_temp_root("installed-without-checkout");
        let exe_dir = root.join("app");
        let missing_workspace_root = root.join("removed-build-checkout");
        std::fs::create_dir_all(&exe_dir).unwrap();
        let installed = create_installed_model_layout(&exe_dir);

        let resolved = resolve_model_paths_from(
            &exe_dir.canonicalize().unwrap(),
            &missing_workspace_root,
            ModelPathOverrides::default(),
        )
        .unwrap();

        assert_eq!(resolved, installed);
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(windows)]
    #[test]
    fn resolve_model_paths_rejects_partial_installed_layout_without_workspace_fallback() {
        let root = unique_temp_root("partial-installed-layout");
        let exe_dir = root.join("app");
        let workspace_root = root.join("workspace");
        std::fs::create_dir_all(&exe_dir).unwrap();
        std::fs::create_dir_all(&workspace_root).unwrap();
        let partial = installed_model_path_candidates(&exe_dir);
        write_file(&partial.model_path, "installed model only");
        let _workspace = create_workspace_model_layout(&workspace_root);

        let error = resolve_model_paths_from(
            &exe_dir.canonicalize().unwrap(),
            &workspace_root.canonicalize().unwrap(),
            ModelPathOverrides::default(),
        )
        .unwrap_err();

        assert!(error.starts_with("SHERPA_ASSET_MISSING installed_layout="));
        assert!(error.contains("tokens"));
        assert!(error.contains("runtime"));
        assert!(error.contains("asset-lock"));
        assert!(error.contains("package-lock"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(windows)]
    #[test]
    fn resolve_model_paths_uses_workspace_only_for_target_dev_executables() {
        let root = unique_temp_root("workspace-dev-layout");
        let workspace_root = root.join("workspace");
        let exe_dir = workspace_root.join("target/debug");
        std::fs::create_dir_all(&exe_dir).unwrap();
        let workspace = create_workspace_model_layout(&workspace_root);

        let resolved = resolve_model_paths_from(
            &exe_dir.canonicalize().unwrap(),
            &workspace_root.canonicalize().unwrap(),
            ModelPathOverrides::default(),
        )
        .unwrap();

        assert_eq!(resolved, workspace);
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(windows)]
    #[test]
    fn resolve_model_paths_applies_explicit_overrides_to_selected_defaults() {
        let root = unique_temp_root("override-layout");
        let exe_dir = root.join("app");
        let workspace_root = root.join("workspace");
        std::fs::create_dir_all(&exe_dir).unwrap();
        std::fs::create_dir_all(&workspace_root).unwrap();
        let installed = create_installed_model_layout(&exe_dir);
        let override_model = root.join("override/model.int8.onnx");
        write_file(&override_model, "override model");

        let resolved = resolve_model_paths_from(
            &exe_dir.canonicalize().unwrap(),
            &workspace_root.canonicalize().unwrap(),
            ModelPathOverrides {
                model_path: Some(override_model.clone().into_os_string()),
                ..ModelPathOverrides::default()
            },
        )
        .unwrap();

        assert_eq!(resolved.model_path, override_model.canonicalize().unwrap());
        assert_eq!(resolved.tokens_path, installed.tokens_path);
        assert_eq!(resolved.runtime_lib_dir, installed.runtime_lib_dir);
        assert_eq!(resolved.asset_lock_path, installed.asset_lock_path);
        assert_eq!(resolved.package_lock_path, installed.package_lock_path);
        let _ = std::fs::remove_dir_all(root);
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
                    meeting_sample_start: 0,
                    meeting_sample_end: 16,
                    timeline_revision: 1,
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
                meeting_sample_start: 0,
                meeting_sample_end: 16,
                timeline_revision: 1,
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
    fn live_text_mirror_write_error_persists_after_later_final() {
        let mut snapshot = MvpSnapshot::booting();
        snapshot.error = Some("LIVE_TEXT_MIRROR_WRITE_FAILED".to_owned());

        apply_final_commit_result(
            &mut snapshot,
            Ok((durable_final_for_test(2, "later"), false, None)),
        );

        assert_eq!(
            snapshot.error.as_deref(),
            Some("LIVE_TEXT_MIRROR_WRITE_FAILED")
        );
        assert_eq!(snapshot.finals.len(), 1);
        assert_eq!(snapshot.saved_final_count, "2");
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
            model_id: crate::mvp::asr_models::DEFAULT_ASR_MODEL_ID.to_owned(),
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
        assert!(!is_meaningful_transcript("等等等等等等"));
        assert!(!is_meaningful_transcript("好好好"));
        assert!(!is_meaningful_transcript("测试测试测试"));
        assert!(is_meaningful_transcript("嗯。"));
        assert!(is_meaningful_transcript("I."));
        assert!(is_meaningful_transcript("哈哈"));
        assert!(is_meaningful_transcript("等等，我马上回来"));
        assert!(is_meaningful_transcript("可以。"));
        assert!(is_meaningful_transcript("OK"));
    }

    #[test]
    fn matching_published_interim_salvages_low_information_final_text() {
        let final_candidate = TranscriptCandidateBounds {
            session_id: "session-test",
            segment_id: "segment-1",
            revision: 3,
            meeting_sample_start: 1_600,
            meeting_sample_end: 64_000,
        };
        let interim = PublishedInterimTranscript {
            session_id: "session-test".to_owned(),
            segment_id: "segment-1".to_owned(),
            revision: 2,
            text: "今天我们讨论发布流程".to_owned(),
            meeting_sample_start: 1_600,
            meeting_sample_end: 32_000,
        };

        assert_eq!(
            meaningful_final_text_or_interim(final_candidate, "。", Some(&interim)).as_deref(),
            Some("今天我们讨论发布流程")
        );
    }

    #[test]
    fn meaningful_final_text_takes_priority_over_published_interim() {
        let final_candidate = TranscriptCandidateBounds {
            session_id: "session-test",
            segment_id: "segment-1",
            revision: 3,
            meeting_sample_start: 0,
            meeting_sample_end: 64_000,
        };
        let interim = PublishedInterimTranscript {
            session_id: "session-test".to_owned(),
            segment_id: "segment-1".to_owned(),
            revision: 2,
            text: "interim should not replace final".to_owned(),
            meeting_sample_start: 0,
            meeting_sample_end: 32_000,
        };

        assert_eq!(
            meaningful_final_text_or_interim(
                final_candidate,
                "final transcript wins",
                Some(&interim),
            )
            .as_deref(),
            Some("final transcript wins")
        );
    }

    #[test]
    fn asr_error_has_no_successful_final_text_to_salvage() {
        let final_candidate = TranscriptCandidateBounds {
            session_id: "session-test",
            segment_id: "segment-1",
            revision: 3,
            meeting_sample_start: 0,
            meeting_sample_end: 64_000,
        };
        let interim = PublishedInterimTranscript {
            session_id: "session-test".to_owned(),
            segment_id: "segment-1".to_owned(),
            revision: 2,
            text: "valid interim text".to_owned(),
            meeting_sample_start: 0,
            meeting_sample_end: 32_000,
        };
        let final_asr_result: Result<&str, ()> = Err(());

        assert!(
            final_asr_result
                .ok()
                .and_then(|text| meaningful_final_text_or_interim(
                    final_candidate,
                    text,
                    Some(&interim),
                ))
                .is_none()
        );
    }

    #[test]
    fn mismatched_or_out_of_range_interim_does_not_salvage_low_information_final() {
        let final_candidate = TranscriptCandidateBounds {
            session_id: "session-test",
            segment_id: "segment-1",
            revision: 3,
            meeting_sample_start: 1_600,
            meeting_sample_end: 64_000,
        };
        let mut interim = PublishedInterimTranscript {
            session_id: "session-test".to_owned(),
            segment_id: "segment-1".to_owned(),
            revision: 2,
            text: "valid interim text".to_owned(),
            meeting_sample_start: 1_600,
            meeting_sample_end: 32_000,
        };

        interim.session_id = "other-session".to_owned();
        assert!(meaningful_final_text_or_interim(final_candidate, "。", Some(&interim)).is_none());

        interim.session_id = "session-test".to_owned();
        interim.segment_id = "segment-2".to_owned();
        assert!(meaningful_final_text_or_interim(final_candidate, "。", Some(&interim)).is_none());

        interim.segment_id = "segment-1".to_owned();
        interim.revision = 3;
        assert!(meaningful_final_text_or_interim(final_candidate, "。", Some(&interim)).is_none());

        interim.revision = 2;
        interim.meeting_sample_start = 0;
        assert!(meaningful_final_text_or_interim(final_candidate, "。", Some(&interim)).is_none());

        interim.meeting_sample_start = 1_600;
        interim.meeting_sample_end = 64_001;
        assert!(meaningful_final_text_or_interim(final_candidate, "。", Some(&interim)).is_none());

        interim.meeting_sample_end = 32_000;
        interim.text = "等等等等等等".to_owned();
        assert!(meaningful_final_text_or_interim(final_candidate, "。", Some(&interim)).is_none());
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
