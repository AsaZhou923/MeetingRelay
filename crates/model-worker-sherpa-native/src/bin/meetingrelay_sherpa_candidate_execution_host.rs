use std::io::Write;
use std::path::PathBuf;

use meetingrelay_model_worker_sherpa_native::{
    NativeCandidateExecutionInput, run_locked_native_candidate_conformance,
};

fn main() {
    let original_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(|_| {}));
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(run));
    std::panic::set_hook(original_hook);
    let error = match outcome {
        Ok(Ok(())) => return,
        Ok(Err(code)) => code,
        Err(_) => "SHERPA_CONFORMANCE_HOST_PANIC",
    };
    eprintln!("{error}");
    std::process::exit(2);
}

fn run() -> Result<(), &'static str> {
    let paths = parse_arguments(std::env::args_os().skip(1))?;
    if cfg!(debug_assertions) {
        return Err("SHERPA_CONFORMANCE_RELEASE_REQUIRED");
    }
    let executable_path = current_regular_executable()?;
    let [
        schema_registry_path,
        model_path,
        tokens_path,
        runtime_lib_dir,
        asset_lock_path,
        package_lock_path,
        wav_path,
    ] = paths;
    let record = run_locked_native_candidate_conformance(NativeCandidateExecutionInput {
        executable_path,
        schema_registry_path,
        model_path,
        tokens_path,
        runtime_lib_dir,
        asset_lock_path,
        package_lock_path,
        wav_path,
    })
    .map_err(|error| error.code())?;
    std::io::stdout()
        .lock()
        .write_all(&record)
        .map_err(|_| "SHERPA_CONFORMANCE_OUTPUT_UNAVAILABLE")
}

fn parse_arguments(
    arguments: impl Iterator<Item = std::ffi::OsString>,
) -> Result<[PathBuf; 7], &'static str> {
    let values: Vec<_> = arguments.collect();
    if values.len() != 7 || values.iter().any(|value| value.is_empty()) {
        return Err("SHERPA_CONFORMANCE_USAGE");
    }
    let paths: Vec<_> = values.into_iter().map(PathBuf::from).collect();
    paths.try_into().map_err(|_| "SHERPA_CONFORMANCE_USAGE")
}

fn current_regular_executable() -> Result<PathBuf, &'static str> {
    let executable =
        std::env::current_exe().map_err(|_| "SHERPA_CONFORMANCE_EXECUTABLE_UNAVAILABLE")?;
    let metadata = std::fs::symlink_metadata(&executable)
        .map_err(|_| "SHERPA_CONFORMANCE_EXECUTABLE_UNAVAILABLE")?;
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        return Err("SHERPA_CONFORMANCE_EXECUTABLE_NOT_REGULAR");
    }
    Ok(executable)
}
