pub mod asr_models;
#[allow(dead_code)]
pub mod audio;
#[cfg(windows)]
mod cohere_asr;
pub mod contract;
pub mod document_export;
#[allow(dead_code)]
pub mod dsp;
pub mod export;
pub mod governance;
pub(crate) mod overlay;
pub mod raw_audio;
pub mod secret_store;
mod service;
pub mod speaker;
pub mod storage;
pub mod summary;
pub mod translation;

pub(crate) use overlay::CAPTION_OVERLAY_LABEL;
pub(crate) use service::MVP_SHUTDOWN_TIMEOUT;
pub use service::MvpService;

use asr_models::AsrModelProfile;
use audio::{AudioDeviceInventory, AudioDeviceSelection, AudioSourceMode};
use contract::MvpSnapshot;
use export::ExportResult;
use speaker::{
    SpeakerDiarizationResult, SpeakerMergeRequest, SpeakerRenameRequest, SpeakerUndoRequest,
    SpeakerVersionSnapshot,
};
use translation::{LocalTranslationDiscovery, TranslationConfig, TranslationProbe};

#[tauri::command(async)]
pub fn mvp_preflight(service: tauri::State<'_, MvpService>) -> Result<MvpSnapshot, String> {
    service.preflight()
}

#[tauri::command(async)]
pub fn mvp_audio_devices(
    service: tauri::State<'_, MvpService>,
) -> Result<AudioDeviceInventory, String> {
    service.audio_devices()
}

#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
pub fn mvp_start(
    service: tauri::State<'_, MvpService>,
    consent_accepted: bool,
    system_output_device_id: Option<String>,
    microphone_device_id: Option<String>,
    language: Option<String>,
    asr_model_id: Option<String>,
    source_mode: Option<AudioSourceMode>,
    raw_audio_enabled: Option<bool>,
    translation: Option<TranslationConfig>,
    translation_provider_profile_id: Option<String>,
) -> Result<MvpSnapshot, String> {
    service.start_with_devices_language_audio_mode_and_model(
        consent_accepted,
        AudioDeviceSelection {
            system_output_device_id,
            microphone_device_id,
        },
        language.as_deref().unwrap_or("zh"),
        asr_model_id.as_deref(),
        translation,
        translation_provider_profile_id.as_deref(),
        source_mode.unwrap_or_default(),
        raw_audio_enabled.unwrap_or(false),
    )
}

#[tauri::command]
pub fn mvp_asr_models() -> Vec<AsrModelProfile> {
    asr_models::asr_model_profiles()
}

#[tauri::command(async)]
pub fn mvp_prepare_language(
    service: tauri::State<'_, MvpService>,
    language: String,
    asr_model_id: Option<String>,
) -> Result<MvpSnapshot, String> {
    service.prepare_language_model(&language, asr_model_id.as_deref())
}

#[tauri::command(async)]
pub fn mvp_discover_local_translation_models(
    service: tauri::State<'_, MvpService>,
    base_url: String,
) -> Result<LocalTranslationDiscovery, String> {
    service.discover_local_translation_models(&base_url)
}

#[tauri::command]
pub fn mvp_secret_store_status(
    service: tauri::State<'_, MvpService>,
    provider_profile_id: Option<String>,
) -> Result<service::SecretStoreSnapshot, String> {
    service.secret_store_status(provider_profile_id.as_deref())
}

#[tauri::command]
pub fn mvp_provider_profiles(
    service: tauri::State<'_, MvpService>,
) -> Result<Vec<service::ProviderProfileSnapshot>, String> {
    service.provider_profiles()
}

#[tauri::command]
pub fn mvp_provider_profile_history(
    service: tauri::State<'_, MvpService>,
    profile_id: String,
) -> Result<Vec<storage::ProviderProfileRecord>, String> {
    service.provider_profile_history(&profile_id)
}

#[tauri::command(async)]
pub fn mvp_save_provider_profile(
    service: tauri::State<'_, MvpService>,
    profile: service::ProviderProfileUpdate,
) -> Result<service::ProviderProfileSnapshot, String> {
    service.save_provider_profile(profile)
}

#[tauri::command(async)]
pub fn mvp_set_provider_secret(
    service: tauri::State<'_, MvpService>,
    profile_id: String,
    secret: String,
) -> Result<service::SecretStoreSnapshot, String> {
    service.set_provider_secret(&profile_id, secret)
}

#[tauri::command(async)]
pub fn mvp_delete_provider_secret(
    service: tauri::State<'_, MvpService>,
    profile_id: String,
) -> Result<service::SecretStoreSnapshot, String> {
    service.delete_provider_secret(&profile_id)
}

#[tauri::command(async)]
pub fn mvp_test_provider(
    service: tauri::State<'_, MvpService>,
    profile_id: String,
) -> Result<TranslationProbe, String> {
    service.test_provider(&profile_id)
}

#[tauri::command(async)]
pub fn mvp_stop(service: tauri::State<'_, MvpService>) -> Result<MvpSnapshot, String> {
    service.stop()
}

#[tauri::command(async)]
pub fn mvp_pause(service: tauri::State<'_, MvpService>) -> Result<MvpSnapshot, String> {
    service.pause()
}

#[tauri::command(async)]
pub fn mvp_resume(service: tauri::State<'_, MvpService>) -> Result<MvpSnapshot, String> {
    service.resume()
}

#[tauri::command]
pub fn mvp_snapshot(service: tauri::State<'_, MvpService>) -> MvpSnapshot {
    service.snapshot()
}

#[tauri::command(async)]
pub fn mvp_open_recent(service: tauri::State<'_, MvpService>) -> Result<MvpSnapshot, String> {
    service.open_recent()
}

#[tauri::command(async)]
pub fn mvp_open_meeting(
    service: tauri::State<'_, MvpService>,
    meeting_id: String,
) -> Result<MvpSnapshot, String> {
    service.open_meeting(&meeting_id)
}

#[tauri::command]
pub fn mvp_list_meetings(
    service: tauri::State<'_, MvpService>,
    query: String,
    tags: Vec<String>,
    cursor: Option<String>,
    page_size: usize,
) -> Result<service::MeetingListPageSnapshot, String> {
    service.list_meetings(query, tags, cursor, page_size)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn mvp_search_segments(
    service: tauri::State<'_, MvpService>,
    text: Option<String>,
    scopes: Vec<String>,
    meeting_id: Option<String>,
    tag_ids: Vec<String>,
    limit: usize,
    cursor: Option<String>,
) -> Result<service::SegmentSearchPageSnapshot, String> {
    service.search_segments(text, scopes, meeting_id, tag_ids, limit, cursor)
}

#[tauri::command]
pub fn mvp_meeting_detail(
    service: tauri::State<'_, MvpService>,
    meeting_id: String,
) -> Result<service::MeetingDetailSnapshot, String> {
    service.meeting_detail(&meeting_id)
}

#[tauri::command(async)]
pub fn mvp_update_meeting_tags(
    service: tauri::State<'_, MvpService>,
    meeting_id: String,
    tags: Vec<String>,
) -> Result<service::MeetingDetailSnapshot, String> {
    service.update_meeting_tags(&meeting_id, tags)
}

#[tauri::command(async)]
pub fn mvp_update_meeting_metadata(
    service: tauri::State<'_, MvpService>,
    meeting_id: String,
    title: String,
    language: String,
) -> Result<service::MeetingDetailSnapshot, String> {
    service.update_meeting_metadata(&meeting_id, &title, &language)
}

#[tauri::command]
pub fn mvp_tags(service: tauri::State<'_, MvpService>) -> Result<Vec<storage::TagRecord>, String> {
    service.tags()
}

#[tauri::command(async)]
pub fn mvp_create_tag(
    service: tauri::State<'_, MvpService>,
    name: String,
    color: Option<String>,
) -> Result<storage::TagRecord, String> {
    service.create_tag(&name, color.as_deref())
}

#[tauri::command(async)]
pub fn mvp_delete_tag(service: tauri::State<'_, MvpService>, tag_id: String) -> Result<(), String> {
    service.delete_tag(&tag_id)
}

#[tauri::command(async)]
pub fn mvp_assign_tag(
    service: tauri::State<'_, MvpService>,
    meeting_id: String,
    tag_id: String,
) -> Result<(), String> {
    service.assign_tag(&meeting_id, &tag_id)
}

#[tauri::command(async)]
pub fn mvp_unassign_tag(
    service: tauri::State<'_, MvpService>,
    meeting_id: String,
    tag_id: String,
) -> Result<(), String> {
    service.unassign_tag(&meeting_id, &tag_id)
}

#[tauri::command(async)]
pub fn mvp_export_meeting(
    service: tauri::State<'_, MvpService>,
    meeting_id: String,
    target_dir: String,
) -> Result<ExportResult, String> {
    service.export_meeting(&meeting_id, target_dir)
}

#[tauri::command(async)]
pub fn mvp_export_meeting_options(
    service: tauri::State<'_, MvpService>,
    meeting_id: String,
    target_dir: String,
    options: export::ExportOptions,
) -> Result<ExportResult, String> {
    service.export_meeting_options(&meeting_id, target_dir, options)
}

#[tauri::command]
pub fn mvp_transcript_text(
    service: tauri::State<'_, MvpService>,
    meeting_id: String,
) -> Result<String, String> {
    service.transcript_text(&meeting_id)
}

#[tauri::command(async)]
pub fn mvp_speaker_diarize(
    service: tauri::State<'_, MvpService>,
    meeting_id: String,
) -> Result<SpeakerDiarizationResult, String> {
    service.diarize_speakers(&meeting_id)
}

#[tauri::command]
pub fn mvp_speaker_latest(
    service: tauri::State<'_, MvpService>,
    meeting_id: String,
) -> Result<Option<SpeakerVersionSnapshot>, String> {
    service.latest_speaker_version(&meeting_id)
}

#[tauri::command]
pub fn mvp_speaker_version(
    service: tauri::State<'_, MvpService>,
    meeting_id: String,
    version: u32,
) -> Result<Option<SpeakerVersionSnapshot>, String> {
    service.speaker_version(&meeting_id, version)
}

#[tauri::command(async)]
pub fn mvp_speaker_rename(
    service: tauri::State<'_, MvpService>,
    request: SpeakerRenameRequest,
) -> Result<SpeakerVersionSnapshot, String> {
    service.rename_speaker(request)
}

#[tauri::command(async)]
pub fn mvp_speaker_merge(
    service: tauri::State<'_, MvpService>,
    request: SpeakerMergeRequest,
) -> Result<SpeakerVersionSnapshot, String> {
    service.merge_speakers(request)
}

#[tauri::command(async)]
pub fn mvp_speaker_undo(
    service: tauri::State<'_, MvpService>,
    request: SpeakerUndoRequest,
) -> Result<SpeakerVersionSnapshot, String> {
    service.undo_speaker_edit(request)
}

#[tauri::command(async)]
pub fn mvp_retry_translation_segment(
    service: tauri::State<'_, MvpService>,
    meeting_id: String,
    segment_id: String,
    sequence: String,
    source_language: String,
    translation: TranslationConfig,
    provider_profile_id: String,
) -> Result<MvpSnapshot, String> {
    service.retry_translation_segment(
        &meeting_id,
        &segment_id,
        &sequence,
        &source_language,
        translation,
        &provider_profile_id,
    )
}

#[tauri::command(async)]
pub fn mvp_retry_failed_translations(
    service: tauri::State<'_, MvpService>,
    meeting_id: String,
    source_language: String,
    translation: TranslationConfig,
    provider_profile_id: String,
    cost_risk_accepted: bool,
) -> Result<service::TranslationRetryProgressSnapshot, String> {
    service.retry_failed_translations(
        &meeting_id,
        &source_language,
        translation,
        &provider_profile_id,
        cost_risk_accepted,
    )
}

#[tauri::command]
pub fn mvp_translation_retry_progress(
    service: tauri::State<'_, MvpService>,
) -> service::TranslationRetryProgressSnapshot {
    service.translation_retry_progress()
}

#[tauri::command]
pub fn mvp_cancel_translation_batch(
    service: tauri::State<'_, MvpService>,
) -> service::TranslationRetryProgressSnapshot {
    service.cancel_translation_batch()
}

#[tauri::command(async)]
pub fn mvp_summary_start(
    service: tauri::State<'_, MvpService>,
    meeting_id: String,
    provider_profile_id: String,
    language: String,
    summary_risk_accepted: bool,
) -> Result<service::SummaryJobSnapshot, String> {
    service.start_summary(
        &meeting_id,
        Some(&provider_profile_id),
        &language,
        summary_risk_accepted,
    )
}

#[tauri::command]
pub fn mvp_summary_status(
    service: tauri::State<'_, MvpService>,
    job_id: String,
) -> Result<service::SummaryJobSnapshot, String> {
    service.summary_status(&job_id)
}

#[tauri::command(async)]
pub fn mvp_summary_cancel(
    service: tauri::State<'_, MvpService>,
    job_id: String,
) -> Result<service::SummaryJobSnapshot, String> {
    service.cancel_summary(&job_id)
}

#[tauri::command(async)]
pub fn mvp_summary_retry(
    service: tauri::State<'_, MvpService>,
    job_id: String,
    provider_profile_id: String,
    summary_risk_accepted: bool,
) -> Result<service::SummaryJobSnapshot, String> {
    service.retry_summary(&job_id, &provider_profile_id, summary_risk_accepted)
}

#[tauri::command]
pub fn mvp_interrupted_meetings(
    service: tauri::State<'_, MvpService>,
) -> Result<Vec<storage::InterruptedMeetingRecord>, String> {
    service.interrupted_meetings()
}

#[tauri::command(async)]
pub fn mvp_recover_meeting(
    service: tauri::State<'_, MvpService>,
    meeting_id: String,
) -> Result<MvpSnapshot, String> {
    service.recover_meeting(&meeting_id)
}

#[tauri::command(async)]
pub fn mvp_finalize_interrupted(
    service: tauri::State<'_, MvpService>,
    meeting_id: String,
) -> Result<MvpSnapshot, String> {
    service.finalize_interrupted(&meeting_id)
}

#[tauri::command(async)]
pub fn mvp_keep_interrupted(
    service: tauri::State<'_, MvpService>,
    meeting_id: String,
) -> Result<MvpSnapshot, String> {
    service.keep_interrupted(&meeting_id)
}

#[tauri::command]
pub fn mvp_locate_segment_audio(
    service: tauri::State<'_, MvpService>,
    meeting_id: String,
    segment_id: String,
    sequence: String,
) -> Result<service::SegmentAudioLocation, String> {
    service.locate_segment_audio(&meeting_id, &segment_id, &sequence)
}

#[tauri::command(async)]
pub fn mvp_create_diagnostic_bundle(
    service: tauri::State<'_, MvpService>,
) -> Result<service::DiagnosticBundleResult, String> {
    service.create_diagnostic_bundle()
}

#[tauri::command]
pub fn mvp_raw_audio_delete_preview(
    service: tauri::State<'_, MvpService>,
    meeting_id: String,
) -> Result<Option<raw_audio::RawAudioDeletePreview>, String> {
    service.raw_audio_delete_preview(&meeting_id)
}

#[tauri::command(async)]
pub fn mvp_delete_raw_audio(
    service: tauri::State<'_, MvpService>,
    meeting_id: String,
) -> Result<Option<raw_audio::RawAudioDeletePreview>, String> {
    service.delete_raw_audio(&meeting_id)
}

#[tauri::command]
pub fn mvp_delete_preview(
    service: tauri::State<'_, MvpService>,
    meeting_id: String,
    include_raw: bool,
    include_derived: bool,
) -> Result<service::DeletePreviewSnapshot, String> {
    service.delete_preview(&meeting_id, include_raw, include_derived)
}

#[tauri::command(async)]
pub fn mvp_delete_execute(
    service: tauri::State<'_, MvpService>,
    meeting_id: String,
    recovery_window_seconds: u64,
    include_raw: bool,
    include_derived: bool,
) -> Result<service::DeleteResultSnapshot, String> {
    service.delete_execute(
        &meeting_id,
        recovery_window_seconds,
        include_raw,
        include_derived,
    )
}

#[tauri::command(async)]
pub fn mvp_delete_restore(
    service: tauri::State<'_, MvpService>,
    meeting_id: String,
) -> Result<service::DeleteResultSnapshot, String> {
    service.delete_restore(&meeting_id)
}

#[tauri::command(async)]
pub fn mvp_delete_purge(
    service: tauri::State<'_, MvpService>,
    meeting_id: String,
) -> Result<service::DeleteResultSnapshot, String> {
    service.delete_purge(&meeting_id)
}

#[tauri::command]
pub fn mvp_raw_audio_retention_preview(
    service: tauri::State<'_, MvpService>,
    older_than_days: u32,
) -> Result<Vec<raw_audio::RawAudioDeletePreview>, String> {
    service.raw_audio_retention_preview(older_than_days)
}
