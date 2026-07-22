use meetingrelay_model_worker_whisper_native::linked_whisper_cpp_version;
use std::ffi::OsStr;

const FIXED_ARG: &str = "--meetingrelay-whisper-runtime-version-probe-v1";

fn main() {
    let mut args = std::env::args_os();
    let _program = args.next();
    match (args.next(), args.next()) {
        (Some(arg), None) if arg == OsStr::new(FIXED_ARG) => {
            let version = linked_whisper_cpp_version();
            if version.trim().is_empty()
                || !version.is_ascii()
                || version
                    .chars()
                    .any(|ch| ch.is_ascii_control() || ch.is_ascii_whitespace())
                || !version.chars().any(|ch| ch.is_ascii_digit())
                || version.len() > 64
            {
                eprintln!("WHISPER_RUNTIME_VERSION_PROBE_BAD_VERSION");
                std::process::exit(2);
            }
            println!(
                "meetingrelay-whisper-runtime-version-probe-v1 linked_whisper_cpp_version={} measurement_status=whisper-runtime-version-marker-path-observation-only execution_status=runtime-path-launched-fixed-version-marker-observed-no-model-no-transcription quality_gate_status=not-assessed formal_claims=none production_evidence=false public_distribution=false selection_authority=none fallback_authority=none loaded_image_attestation=false network_isolation_authority=none",
                version
            );
        }
        _ => {
            eprintln!(
                "usage: meetingrelay-whisper-runtime-version-probe {}",
                FIXED_ARG
            );
            std::process::exit(64);
        }
    }
}
