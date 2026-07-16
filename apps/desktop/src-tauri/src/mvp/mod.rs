#[allow(dead_code)]
pub mod audio;
pub mod contract;
#[allow(dead_code)]
pub mod dsp;
mod service;

pub use service::MvpService;

use contract::MvpSnapshot;

#[tauri::command(async)]
pub fn mvp_preflight(service: tauri::State<'_, MvpService>) -> Result<MvpSnapshot, String> {
    service.preflight()
}

#[tauri::command(async)]
pub fn mvp_start(
    service: tauri::State<'_, MvpService>,
    consent_accepted: bool,
) -> Result<MvpSnapshot, String> {
    service.start(consent_accepted)
}

#[tauri::command(async)]
pub fn mvp_stop(service: tauri::State<'_, MvpService>) -> Result<MvpSnapshot, String> {
    service.stop()
}

#[tauri::command]
pub fn mvp_snapshot(service: tauri::State<'_, MvpService>) -> MvpSnapshot {
    service.snapshot()
}
