use std::ffi::OsString;
use std::io::Write;
use std::path::PathBuf;

use meetingrelay_model_worker_contract::{Identifier, LanguageCode, Sha256Digest};
use meetingrelay_model_worker_sherpa_native::{
    NativeCandidateQualitySampleIdentity, NativeCandidateQualitySampleInput,
    run_locked_native_candidate_quality_sample,
};

fn main() {
    let original_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(|_| {}));
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(run));
    std::panic::set_hook(original_hook);
    let error = match outcome {
        Ok(Ok(())) => return,
        Ok(Err(code)) => code,
        Err(_) => "SHERPA_QUALITY_HOST_PANIC",
    };
    eprintln!("{error}");
    std::process::exit(2);
}

fn run() -> Result<(), &'static str> {
    let arguments = parse_arguments(std::env::args_os().skip(1))?;
    if cfg!(debug_assertions) {
        return Err("SHERPA_QUALITY_RELEASE_REQUIRED");
    }
    let [
        schema_registry_path,
        model_path,
        tokens_path,
        runtime_lib_dir,
        asset_lock_path,
        package_lock_path,
        sample_id,
        language,
        wav_path,
        wav_size_bytes,
        wav_sha256,
        pcm_sha256,
        reference_sha256,
    ] = arguments;
    let sample = NativeCandidateQualitySampleIdentity {
        sample_id: parse_identifier(&sample_id)?,
        language: parse_language(&language)?,
        expected_wav_size_bytes: parse_canonical_u64(&wav_size_bytes)?,
        expected_wav_sha256: parse_digest(&wav_sha256)?,
        expected_pcm_sha256: parse_digest(&pcm_sha256)?,
        reference_sha256: parse_digest(&reference_sha256)?,
    };
    let record = run_locked_native_candidate_quality_sample(NativeCandidateQualitySampleInput {
        schema_registry_path: PathBuf::from(schema_registry_path),
        model_path: PathBuf::from(model_path),
        tokens_path: PathBuf::from(tokens_path),
        runtime_lib_dir: PathBuf::from(runtime_lib_dir),
        asset_lock_path: PathBuf::from(asset_lock_path),
        package_lock_path: PathBuf::from(package_lock_path),
        wav_path: PathBuf::from(wav_path),
        sample,
    })
    .map_err(|error| error.code())?;
    std::io::stdout()
        .lock()
        .write_all(&record)
        .map_err(|_| "SHERPA_QUALITY_OUTPUT_UNAVAILABLE")
}

fn parse_arguments(
    arguments: impl Iterator<Item = OsString>,
) -> Result<[OsString; 13], &'static str> {
    let values: Vec<_> = arguments.collect();
    if values.len() != 13 || values.iter().any(|value| value.is_empty()) {
        return Err("SHERPA_QUALITY_USAGE");
    }
    values.try_into().map_err(|_| "SHERPA_QUALITY_USAGE")
}

fn parse_language(value: &OsString) -> Result<LanguageCode, &'static str> {
    let value = value.to_str().ok_or("SHERPA_QUALITY_INVALID_INPUT")?;
    if !matches!(value, "zh" | "ja" | "en") {
        return Err("SHERPA_QUALITY_INVALID_INPUT");
    }
    LanguageCode::new(value).map_err(|_| "SHERPA_QUALITY_INVALID_INPUT")
}

fn parse_identifier(value: &OsString) -> Result<Identifier, &'static str> {
    let value = value.to_str().ok_or("SHERPA_QUALITY_INVALID_INPUT")?;
    Identifier::new(value).map_err(|_| "SHERPA_QUALITY_INVALID_INPUT")
}

fn parse_digest(value: &OsString) -> Result<Sha256Digest, &'static str> {
    let value = value.to_str().ok_or("SHERPA_QUALITY_INVALID_INPUT")?;
    let digest = Sha256Digest::from_lower_hex(value).map_err(|_| "SHERPA_QUALITY_INVALID_INPUT")?;
    if digest.is_zero() {
        return Err("SHERPA_QUALITY_INVALID_INPUT");
    }
    Ok(digest)
}

fn parse_canonical_u64(value: &OsString) -> Result<u64, &'static str> {
    let value = value.to_str().ok_or("SHERPA_QUALITY_INVALID_INPUT")?;
    let bytes = value.as_bytes();
    if bytes.is_empty()
        || !bytes.iter().all(u8::is_ascii_digit)
        || (bytes.len() > 1 && bytes[0] == b'0')
    {
        return Err("SHERPA_QUALITY_INVALID_INPUT");
    }
    value
        .parse::<u64>()
        .map_err(|_| "SHERPA_QUALITY_INVALID_INPUT")
}
