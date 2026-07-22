use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::Instant,
};

use meetingrelay_benchmark_contract::{CONTRACT_VERSION, Observation};
use serde::Serialize;
use tauri::Manager;

mod mvp;

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapProbe {
    pub contract_version: String,
    pub worker_ns: String,
    pub output_ns: String,
    pub end_to_end_ns: String,
}

#[tauri::command]
fn bootstrap_probe() -> BootstrapProbe {
    let durations = Observation {
        input_ready_ns: 10_000,
        worker_ready_ns: 34_000,
        output_ready_ns: 55_000,
    }
    .stage_durations()
    .expect("the fixed bootstrap observation must be monotonic");

    BootstrapProbe {
        contract_version: CONTRACT_VERSION.to_owned(),
        worker_ns: durations.worker_ns.to_string(),
        output_ns: durations.output_ns.to_string(),
        end_to_end_ns: durations.end_to_end_ns.to_string(),
    }
}

fn spawn_or_exit(name: &str, task: impl FnOnce() + Send + 'static) {
    let _ = thread::Builder::new()
        .name(name.to_owned())
        .spawn(task)
        .unwrap_or_else(|_| std::process::exit(1));
}

fn with_bootstrap_handler<R: tauri::Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    let close_started = Arc::new(AtomicBool::new(false));
    builder
        .manage(mvp::MvpService::default())
        .on_window_event(move |window, event| {
            let tauri::WindowEvent::CloseRequested { api, .. } = event else {
                return;
            };
            api.prevent_close();
            if close_started.swap(true, Ordering::AcqRel) {
                return;
            }

            let deadline = Instant::now() + mvp::MVP_SHUTDOWN_TIMEOUT;
            let _ = window.hide();
            let app = window.app_handle().clone();
            spawn_or_exit("meetingrelay-shutdown-watchdog", move || {
                // `app.exit` only requests event-loop exit. Keep this fallback armed
                // until process termination; the absolute deadline wins any race.
                thread::sleep(deadline.saturating_duration_since(Instant::now()));
                std::process::exit(1);
            });
            spawn_or_exit("meetingrelay-shutdown", move || {
                let exit_code = i32::from(
                    app.state::<mvp::MvpService>()
                        .shutdown_before(deadline)
                        .is_err(),
                );
                app.exit(exit_code);
            });
        })
        .invoke_handler(tauri::generate_handler![
            bootstrap_probe,
            mvp::mvp_preflight,
            mvp::mvp_audio_devices,
            mvp::mvp_start,
            mvp::mvp_stop,
            mvp::mvp_pause,
            mvp::mvp_resume,
            mvp::mvp_snapshot,
            mvp::mvp_open_recent,
            mvp::mvp_open_meeting,
            mvp::mvp_export_meeting,
            mvp::mvp_transcript_text
        ])
}

pub fn run() {
    with_bootstrap_handler(tauri::Builder::default())
        .run(tauri::generate_context!())
        .expect("failed to run the MeetingRelay Phase 0 bootstrap shell");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bootstrap_probe_returns_the_fixed_contract_observation() {
        assert_eq!(
            bootstrap_probe(),
            BootstrapProbe {
                contract_version: CONTRACT_VERSION.to_owned(),
                worker_ns: "24000".to_owned(),
                output_ns: "21000".to_owned(),
                end_to_end_ns: "45000".to_owned(),
            }
        );
    }

    #[test]
    fn bootstrap_probe_round_trips_through_tauri_ipc() {
        let command = include_str!("../../src/bootstrap-command.txt").trim();
        assert_eq!(command, stringify!(bootstrap_probe));

        let app = with_bootstrap_handler(tauri::test::mock_builder())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("failed to build mock Tauri app");
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("failed to build mock webview window");

        let response = tauri::test::get_ipc_response(
            &webview,
            tauri::webview::InvokeRequest {
                cmd: command.to_owned(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: if cfg!(any(windows, target_os = "android")) {
                    "http://tauri.localhost"
                } else {
                    "tauri://localhost"
                }
                .parse()
                .expect("mock invoke URL must be valid"),
                body: tauri::ipc::InvokeBody::default(),
                headers: Default::default(),
                invoke_key: tauri::test::INVOKE_KEY.to_owned(),
            },
        )
        .expect("bootstrap probe IPC request failed");

        match response {
            tauri::ipc::InvokeResponseBody::Json(body) => assert_eq!(
                body,
                r#"{"contractVersion":"meetingrelay.phase0.bootstrap.v1","workerNs":"24000","outputNs":"21000","endToEndNs":"45000"}"#
            ),
            tauri::ipc::InvokeResponseBody::Raw(_) => {
                panic!("bootstrap probe returned a raw IPC body")
            }
        }
    }

    #[test]
    fn mvp_snapshot_round_trips_through_tauri_ipc() {
        let app = with_bootstrap_handler(tauri::test::mock_builder())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("failed to build mock Tauri app");
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("failed to build mock webview window");

        let response = tauri::test::get_ipc_response(
            &webview,
            tauri::webview::InvokeRequest {
                cmd: "mvp_snapshot".to_owned(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: "http://tauri.localhost"
                    .parse()
                    .expect("mock invoke URL must be valid"),
                body: tauri::ipc::InvokeBody::default(),
                headers: Default::default(),
                invoke_key: tauri::test::INVOKE_KEY.to_owned(),
            },
        )
        .expect("MVP snapshot IPC request failed");

        let tauri::ipc::InvokeResponseBody::Json(body) = response else {
            panic!("MVP snapshot returned a raw IPC body");
        };
        assert!(body.contains(r#""contractVersion":"meetingrelay.mvp.durable.v1""#));
        assert!(body.contains(r#""lifecycle":"booting""#));
        assert!(body.contains(r#""localOnly":true,"memoryOnly":false"#));
    }

    #[test]
    fn mvp_start_ipc_rejects_missing_consent_before_capture() {
        let app = with_bootstrap_handler(tauri::test::mock_builder())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("failed to build mock Tauri app");
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("failed to build mock webview window");

        let error = tauri::test::get_ipc_response(
            &webview,
            tauri::webview::InvokeRequest {
                cmd: "mvp_start".to_owned(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: "http://tauri.localhost"
                    .parse()
                    .expect("mock invoke URL must be valid"),
                body: tauri::ipc::InvokeBody::Json(
                    r#"{"consentAccepted":false}"#
                        .parse()
                        .expect("MVP start body must be valid JSON"),
                ),
                headers: Default::default(),
                invoke_key: tauri::test::INVOKE_KEY.to_owned(),
            },
        )
        .expect_err("missing consent must be rejected");

        assert!(error.to_string().contains("CONSENT_REQUIRED"));
    }

    #[test]
    fn mvp_start_ipc_accepts_explicit_device_arguments_without_opening_them_first() {
        let app = with_bootstrap_handler(tauri::test::mock_builder())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("failed to build mock Tauri app");
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("failed to build mock webview window");

        let error = tauri::test::get_ipc_response(
            &webview,
            tauri::webview::InvokeRequest {
                cmd: "mvp_start".to_owned(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: "http://tauri.localhost"
                    .parse()
                    .expect("mock invoke URL must be valid"),
                body: tauri::ipc::InvokeBody::Json(
                    r#"{"consentAccepted":false,"systemOutputDeviceId":"wasapi:system","microphoneDeviceId":"wasapi:microphone"}"#
                        .parse()
                        .expect("MVP start body must be valid JSON"),
                ),
                headers: Default::default(),
                invoke_key: tauri::test::INVOKE_KEY.to_owned(),
            },
        )
        .expect_err("missing consent must be rejected before device access");

        assert!(error.to_string().contains("CONSENT_REQUIRED"));
    }

    #[test]
    fn mvp_pause_and_resume_ipc_are_registered() {
        let app = with_bootstrap_handler(tauri::test::mock_builder())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("failed to build mock Tauri app");
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("failed to build mock webview window");

        for command in ["mvp_pause", "mvp_resume"] {
            let error = tauri::test::get_ipc_response(
                &webview,
                tauri::webview::InvokeRequest {
                    cmd: command.to_owned(),
                    callback: tauri::ipc::CallbackFn(0),
                    error: tauri::ipc::CallbackFn(1),
                    url: "http://tauri.localhost"
                        .parse()
                        .expect("mock invoke URL must be valid"),
                    body: tauri::ipc::InvokeBody::default(),
                    headers: Default::default(),
                    invoke_key: tauri::test::INVOKE_KEY.to_owned(),
                },
            )
            .expect_err("pause/resume require an active Windows session");

            let error = error.to_string();
            assert!(
                error.contains("MVP_WINDOWS_ONLY") || error.contains("SESSION_NOT_RUNNING"),
                "{command} returned unexpected error: {error}"
            );
        }
    }
}
