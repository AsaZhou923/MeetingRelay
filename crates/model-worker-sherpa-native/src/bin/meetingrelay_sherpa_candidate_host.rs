use std::io::Write;
use std::path::PathBuf;

use meetingrelay_model_worker_sherpa_native::{
    WorkerProvenanceError, locked_schema_registry_sha256,
    locked_worker_manifest_projection_json_bytes, sha256_file,
};

fn main() {
    if let Err(code) = run() {
        eprintln!("{code}");
        std::process::exit(2);
    }
}

fn run() -> Result<(), &'static str> {
    let schema_registry = parse_schema_registry_argument(std::env::args_os().skip(1))?;
    if cfg!(debug_assertions) {
        return Err("SHERPA_PROVENANCE_RELEASE_REQUIRED");
    }
    let executable = current_regular_executable()?;
    let executable_sha256 =
        sha256_file(&executable).map_err(|_| "SHERPA_PROVENANCE_EXECUTABLE_UNAVAILABLE")?;
    let schema_registry_sha256 =
        locked_schema_registry_sha256(&schema_registry).map_err(WorkerProvenanceError::code)?;
    let projection =
        locked_worker_manifest_projection_json_bytes(executable_sha256, schema_registry_sha256)
            .map_err(WorkerProvenanceError::code)?;
    std::io::stdout()
        .lock()
        .write_all(&projection)
        .map_err(|_| "SHERPA_PROVENANCE_OUTPUT_UNAVAILABLE")
}

fn parse_schema_registry_argument(
    mut arguments: impl Iterator<Item = std::ffi::OsString>,
) -> Result<PathBuf, &'static str> {
    let schema_registry = arguments.next().ok_or("SHERPA_PROVENANCE_USAGE")?;
    if arguments.next().is_some() || schema_registry.is_empty() {
        return Err("SHERPA_PROVENANCE_USAGE");
    }
    Ok(PathBuf::from(schema_registry))
}

fn current_regular_executable() -> Result<PathBuf, &'static str> {
    let executable =
        std::env::current_exe().map_err(|_| "SHERPA_PROVENANCE_EXECUTABLE_UNAVAILABLE")?;
    let metadata = std::fs::symlink_metadata(&executable)
        .map_err(|_| "SHERPA_PROVENANCE_EXECUTABLE_UNAVAILABLE")?;
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        return Err("SHERPA_PROVENANCE_EXECUTABLE_NOT_REGULAR");
    }
    Ok(executable)
}
