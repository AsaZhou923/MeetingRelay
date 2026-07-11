use meetingrelay_benchmark_contract::{CONTRACT_VERSION, Observation};
use serde::Serialize;

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

fn with_bootstrap_handler<R: tauri::Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder.invoke_handler(tauri::generate_handler![bootstrap_probe])
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
}
