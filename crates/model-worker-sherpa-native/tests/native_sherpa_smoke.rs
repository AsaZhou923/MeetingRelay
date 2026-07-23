#![cfg(feature = "native-sherpa")]

use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use meetingrelay_model_worker_contract::Sha256Digest;
use meetingrelay_model_worker_sherpa_native::{
    LOCKED_ASSET_LOCK_SHA256_HEX, LOCKED_MODEL_SHA256_HEX, LOCKED_TOKENS_SHA256_HEX,
    LockedSherpaLanguage, LockedSherpaRealtime, LockedSherpaRealtimePaths, sha256_file,
};

const SAMPLE_RATE_HZ: u32 = 16_000;
const SMOKE_WAV_SHA256: &str = "b77f1794fe374a0ba1ee1dc458bfaf9349496cbbfc32780c50ba3c5a7ad8e373";

#[test]
#[ignore = "requires explicitly provisioned sherpa runtime, SenseVoice model, tokens, and WAV"]
fn native_sense_voice_smoke_returns_nonempty_final() {
    let model_path = required_path("MEETINGRELAY_SHERPA_MODEL");
    let tokens_path = required_path("MEETINGRELAY_SHERPA_TOKENS");
    let wav_path = required_path("MEETINGRELAY_SHERPA_WAV");
    let asset_lock_path = required_path("MEETINGRELAY_SHERPA_LOCK");
    let runtime_lib_dir = required_path("SHERPA_ONNX_LIB_DIR");
    let package_lock_path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../Cargo.lock");

    assert_locked_file(&model_path, LOCKED_MODEL_SHA256_HEX, "model");
    assert_locked_file(&tokens_path, LOCKED_TOKENS_SHA256_HEX, "tokens");
    assert_locked_file(&asset_lock_path, LOCKED_ASSET_LOCK_SHA256_HEX, "asset lock");
    assert_locked_file(&wav_path, SMOKE_WAV_SHA256, "smoke WAV");

    let samples = read_mono_pcm16_wav(&wav_path);
    let mut recognizer = LockedSherpaRealtime::prepare_local_mvp(LockedSherpaRealtimePaths {
        model_path,
        tokens_path,
        runtime_lib_dir,
        asset_lock_path,
        package_lock_path,
    })
    .expect("prepare locked local Sherpa recognizer");

    let result = recognizer
        .transcribe_mono_16khz_pcm16(Arc::from(samples))
        .expect("transcribe smoke WAV");
    let transcript_bytes = result.original_transcript.as_str().trim().len();
    assert!(
        transcript_bytes > 0,
        "native smoke transcript must be nonempty"
    );
    eprintln!("SHERPA_SMOKE_NONEMPTY_TRANSCRIPT_BYTES={transcript_bytes}");
}

#[test]
#[ignore = "requires explicitly provisioned sherpa runtime, SenseVoice model, tokens, and lock"]
fn native_sense_voice_prepares_all_selectable_language_profiles() {
    let paths = LockedSherpaRealtimePaths {
        model_path: required_path("MEETINGRELAY_SHERPA_MODEL"),
        tokens_path: required_path("MEETINGRELAY_SHERPA_TOKENS"),
        runtime_lib_dir: required_path("SHERPA_ONNX_LIB_DIR"),
        asset_lock_path: required_path("MEETINGRELAY_SHERPA_LOCK"),
        package_lock_path: Path::new(env!("CARGO_MANIFEST_DIR")).join("../../Cargo.lock"),
    };

    for language in [
        LockedSherpaLanguage::Chinese,
        LockedSherpaLanguage::Japanese,
        LockedSherpaLanguage::English,
    ] {
        LockedSherpaRealtime::prepare_local_mvp_with_language(paths.clone(), language)
            .expect("prepare selectable language profile");
    }
}

fn assert_locked_file(path: &Path, expected: &str, label: &str) {
    let expected = digest_from_hex(expected);
    let actual = sha256_file(path).unwrap_or_else(|_| panic!("hash locked {label}"));
    assert_eq!(actual, expected, "{label} differs from the committed lock");
}

fn digest_from_hex(value: &str) -> Sha256Digest {
    Sha256Digest::from_lower_hex(value).expect("locked SHA-256 is valid")
}

fn required_path(name: &str) -> PathBuf {
    PathBuf::from(env::var_os(name).unwrap_or_else(|| panic!("{name} must be set")))
}

fn read_mono_pcm16_wav(path: &Path) -> Vec<i16> {
    let bytes = fs::read(path).unwrap_or_else(|_| panic!("read WAV {}", path.display()));
    assert!(
        bytes.len() >= 44,
        "WAV fixture must contain a RIFF header and data"
    );
    assert_eq!(&bytes[0..4], b"RIFF");
    assert_eq!(&bytes[8..12], b"WAVE");
    let mut cursor = 12;
    let mut format: Option<(u16, u16, u32, u16)> = None;
    let mut data: Option<&[u8]> = None;
    while cursor + 8 <= bytes.len() {
        let chunk_id = &bytes[cursor..cursor + 4];
        let chunk_size = u32::from_le_bytes(
            bytes[cursor + 4..cursor + 8]
                .try_into()
                .expect("chunk size slice has four bytes"),
        ) as usize;
        cursor += 8;
        assert!(
            cursor + chunk_size <= bytes.len(),
            "WAV chunk extends beyond file"
        );
        let chunk = &bytes[cursor..cursor + chunk_size];
        match chunk_id {
            b"fmt " => {
                assert!(chunk.len() >= 16, "fmt chunk must be PCM-sized");
                let audio_format = u16::from_le_bytes(chunk[0..2].try_into().expect("format"));
                let channels = u16::from_le_bytes(chunk[2..4].try_into().expect("channels"));
                let sample_rate = u32::from_le_bytes(chunk[4..8].try_into().expect("rate"));
                let bits_per_sample = u16::from_le_bytes(chunk[14..16].try_into().expect("bits"));
                format = Some((audio_format, channels, sample_rate, bits_per_sample));
            }
            b"data" => data = Some(chunk),
            _ => {}
        }
        cursor += chunk_size + (chunk_size % 2);
    }
    let (audio_format, channels, sample_rate, bits_per_sample) = format.expect("WAV fmt chunk");
    assert_eq!(audio_format, 1, "WAV must be PCM");
    assert_eq!(channels, 1, "WAV must be mono");
    assert_eq!(sample_rate, SAMPLE_RATE_HZ, "WAV must be 16 kHz");
    assert_eq!(bits_per_sample, 16, "WAV must be PCM16");
    let data = data.expect("WAV data chunk");
    assert_eq!(data.len() % 2, 0, "PCM16 data length must be even");
    data.chunks_exact(2)
        .map(|sample| i16::from_le_bytes(sample.try_into().expect("sample")))
        .collect()
}
