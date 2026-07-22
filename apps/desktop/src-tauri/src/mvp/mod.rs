#[allow(dead_code)]
pub mod audio;
pub mod contract;
#[allow(dead_code)]
pub mod dsp;
pub mod export;
mod service;
pub mod storage;

pub(crate) use service::MVP_SHUTDOWN_TIMEOUT;
pub use service::MvpService;

use audio::{AudioDeviceInventory, AudioDeviceSelection};
use contract::MvpSnapshot;
use export::ExportResult;

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
pub fn mvp_start(
    service: tauri::State<'_, MvpService>,
    consent_accepted: bool,
    system_output_device_id: Option<String>,
    microphone_device_id: Option<String>,
) -> Result<MvpSnapshot, String> {
    service.start_with_devices(
        consent_accepted,
        AudioDeviceSelection {
            system_output_device_id,
            microphone_device_id,
        },
    )
}

#[tauri::command(async)]
pub fn mvp_stop(service: tauri::State<'_, MvpService>) -> Result<MvpSnapshot, String> {
    service.stop()
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

#[tauri::command(async)]
pub fn mvp_export_meeting(
    service: tauri::State<'_, MvpService>,
    meeting_id: String,
    target_dir: String,
) -> Result<ExportResult, String> {
    service.export_meeting(&meeting_id, target_dir)
}
