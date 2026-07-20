use std::ffi::OsString;
use std::io::{BufReader, Write};
use std::path::PathBuf;

use meetingrelay_model_worker_contract::LanguageCode;
use meetingrelay_model_worker_sherpa_native::{
    NativeCandidateQualityShardInput, run_locked_native_candidate_quality_shard,
};

fn main() {
    let original_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(|_| {}));
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(run));
    std::panic::set_hook(original_hook);
    let error = match outcome {
        Ok(Ok(())) => return,
        Ok(Err(code)) => code,
        Err(_) => "SHERPA_QUALITY_SHARD_HOST_PANIC",
    };
    eprintln!("{error}");
    std::process::exit(2);
}

fn run() -> Result<(), &'static str> {
    let arguments = parse_arguments(std::env::args_os().skip(1))?;
    if cfg!(debug_assertions) {
        return Err("SHERPA_QUALITY_SHARD_RELEASE_REQUIRED");
    }
    let [
        schema_registry_path,
        model_path,
        tokens_path,
        runtime_lib_dir,
        asset_lock_path,
        package_lock_path,
        language,
        max_samples,
        max_total_pcm_bytes,
    ] = arguments;
    let input = NativeCandidateQualityShardInput {
        schema_registry_path: PathBuf::from(schema_registry_path),
        model_path: PathBuf::from(model_path),
        tokens_path: PathBuf::from(tokens_path),
        runtime_lib_dir: PathBuf::from(runtime_lib_dir),
        asset_lock_path: PathBuf::from(asset_lock_path),
        package_lock_path: PathBuf::from(package_lock_path),
        language: parse_language(&language)?,
        max_samples: parse_canonical_u64(&max_samples)?,
        max_total_pcm_bytes: parse_canonical_u64(&max_total_pcm_bytes)?,
    };
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    run_locked_native_candidate_quality_shard(input, BufReader::new(stdin.lock()), stdout.lock())
        .map_err(|error| error.code())?;
    std::io::stdout()
        .lock()
        .flush()
        .map_err(|_| "SHERPA_QUALITY_SHARD_OUTPUT_UNAVAILABLE")
}

fn parse_arguments(
    arguments: impl Iterator<Item = OsString>,
) -> Result<[OsString; 9], &'static str> {
    let values: Vec<_> = arguments.collect();
    if values.len() != 9 || values.iter().any(|value| value.is_empty()) {
        return Err("SHERPA_QUALITY_SHARD_USAGE");
    }
    values.try_into().map_err(|_| "SHERPA_QUALITY_SHARD_USAGE")
}

fn parse_language(value: &OsString) -> Result<LanguageCode, &'static str> {
    let value = value.to_str().ok_or("SHERPA_QUALITY_SHARD_INVALID_INPUT")?;
    if !matches!(value, "zh" | "ja" | "en") {
        return Err("SHERPA_QUALITY_SHARD_INVALID_INPUT");
    }
    LanguageCode::new(value).map_err(|_| "SHERPA_QUALITY_SHARD_INVALID_INPUT")
}

fn parse_canonical_u64(value: &OsString) -> Result<u64, &'static str> {
    let value = value.to_str().ok_or("SHERPA_QUALITY_SHARD_INVALID_INPUT")?;
    let bytes = value.as_bytes();
    if bytes.is_empty()
        || !bytes.iter().all(u8::is_ascii_digit)
        || (bytes.len() > 1 && bytes[0] == b'0')
    {
        return Err("SHERPA_QUALITY_SHARD_INVALID_INPUT");
    }
    value
        .parse::<u64>()
        .map_err(|_| "SHERPA_QUALITY_SHARD_INVALID_INPUT")
}
