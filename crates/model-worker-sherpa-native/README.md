# MeetingRelay Sherpa backend

This crate is the only ASR engine kept on `main` for the personal desktop MVP.
It prepares a local sherpa-onnx SenseVoice runtime and exposes a small realtime
API to the Tauri app:

- `LockedSherpaRealtime::prepare_local_mvp(...)` verifies local model, token,
  runtime, asset-lock, and workspace lock-file inputs.
- `transcribe_mono_16khz_pcm16(...)` accepts bounded mono 16 kHz PCM16 segments
  and returns transcript text.

The archived Phase 0 candidate builders, sidecar runners, formal evidence, and
quality/attestation CLIs are intentionally not part of this crate on `main`.
They remain recoverable from the archive branch created before the MVP trim.

## Native smoke test

The ignored smoke test exercises the product path directly:

```powershell
$env:MEETINGRELAY_SHERPA_MODEL = "...\model.int8.onnx"
$env:MEETINGRELAY_SHERPA_TOKENS = "...\tokens.txt"
$env:MEETINGRELAY_SHERPA_LOCK = "...\assets.lock.json"
$env:SHERPA_ONNX_LIB_DIR = "...\runtime\lib"
$env:MEETINGRELAY_SHERPA_WAV = "...\smoke.wav"
cargo test -p meetingrelay-model-worker-sherpa-native --features native-sherpa --test native_sherpa_smoke -- --ignored --nocapture
```

The test proves the configured local model/runtime can produce non-empty text
from a real WAV fixture. It is not an accuracy benchmark or enterprise audit
artifact.
