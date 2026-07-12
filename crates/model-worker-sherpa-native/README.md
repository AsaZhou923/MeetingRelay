# MeetingRelay sherpa-onnx native backend

This crate is the narrow native ASR adapter for the model-worker contract. It
keeps sherpa-onnx and its native FFI dependencies outside the transport-neutral
contract crate.

The default feature set is empty so deterministic unit tests can exercise the
adapter without loading native libraries. Production construction fails
immediately with an explicit configuration error unless `native-sherpa` is
enabled. With that feature enabled, `SHERPA_ONNX_LIB_DIR` must point at the
already materialized, pinned sherpa-onnx v1.13.4 shared-runtime `lib`
directory. Cargo's `links` override suppresses the upstream dependency build
script; MeetingRelay's build gate verifies and stages the sealed runtime, and
neither the adapter nor its build path downloads anything.

`Prepare` is the readiness boundary. Its first successful call hashes the
committed asset lock, workspace `Cargo.lock`, SenseVoice model, tokens, and all
seven files in the exact runtime inventory, then constructs the native
recognizer. Only after both verification and initialization succeed may the
session report `Prepared { ready: true }`. A later `Prepare` is idempotent and
does not rehash the 239 MB model or reconstruct the recognizer. `execute`
validates canonical PCM and performs inference only; it has no cold-start or
network path. Asset and initialization failures become sanitized
`PreparationFailed` outcomes (`SHERPA_ASSET_MISMATCH` or
`SHERPA_INIT_FAILED`).

Production configuration requires absolute model and tokens paths. At the start
of `Prepare`, both are canonicalized to stable absolute final targets and the
resolved paths replace the configured values used by native initialization. On
Windows, those targets are opened with read-only sharing before hashing. The
same file handles remain open through native initialization and for the backend
lifetime, so a writer, delete, path replacement, or CWD change cannot redirect
the bytes between verification and the native library reopening the paths. If
another writer is already present, `Prepare` fails closed. An initialization
failure deliberately drops the handles; a later recovery `Prepare` resolves,
reopens, and rehashes all assets. Only a successful `Prepare` enables the
no-rehash idempotent path.

The adapter also fail-closes descriptor drift for the locked candidate:
sherpa-onnx `1.13.4`, shared CPU runtime/ONNX Runtime `1.27.0`, SenseVoice
2024 INT8, and `LicenseRef-FunASR-Model-1.1-Internal-Evaluation`. The license
is accepted only for internal Phase-0 evaluation; distribution approval remains
pending.

Result provenance is bound to the bytes verified during `Prepare`: model,
asset-lock manifest, package lock, and the complete runtime-inventory digest.
Production configuration also pins the model and tokens hashes instead of
accepting caller-selected values. The canonical parameter digest covers mono
16 kHz input, feature dimension 80, CPU provider, one thread, debug disabled,
Chinese language, ITN, the 64 MiB input bound, SenseVoice model family, greedy
search, four active paths, zero blank penalty, and explicitly disabled
hotwords, rule FST/FAR, external LM, homophone replacement, model type,
modeling unit, BPE vocabulary, and TeleSpeech CTC paths.

## Explicit native smoke

The ignored integration smoke uses the official safe Rust API through a
`DirectWorkerSession`. It requires these environment variables:

- `MEETINGRELAY_SHERPA_MODEL`: SenseVoice ONNX model path
- `MEETINGRELAY_SHERPA_TOKENS`: matching tokens file path
- `MEETINGRELAY_SHERPA_WAV`: mono 16 kHz PCM16 WAV path
- `MEETINGRELAY_SHERPA_LOCK`: committed `assets.lock.json` path
- `SHERPA_ONNX_LIB_DIR`: exact seven-file shared-runtime `lib` directory

The smoke binds package provenance to the workspace `Cargo.lock`; it does not
accept a package-lock environment override.

Materialize the sealed archives and stage their DLLs beside Cargo's test
executables before running the smoke:

```powershell
$assets = ./tools/sherpa-native/materialize.ps1 `
  -CacheRoot target/sherpa-native `
  -AllowDownload
foreach ($line in $assets) {
  if ($line -match '^([A-Z0-9_]+)=(.*)$') {
    Set-Item -Path "Env:$($Matches[1])" -Value $Matches[2]
  }
}
./tools/sherpa-native/stage-runtime.ps1 `
  -LibDir $env:SHERPA_ONNX_LIB_DIR `
  -Configuration Debug
cargo test -p meetingrelay-model-worker-sherpa-native --features native-sherpa --test native_sherpa_smoke -- --ignored --exact native_sense_voice_smoke_returns_nonempty_final
```

The explicit copy places the pinned DLLs beside Cargo's integration-test
executable. This prevents Windows' system-directory search precedence from
selecting an incompatible inbox `onnxruntime.dll` before entries on `PATH`.

The smoke verifies the lock/model/tokens/WAV/runtime digests, asserts that
`Prepare` really reached Ready, inference completes with a non-empty final
result, and replaying the same flush does not invoke the backend again. It makes
no transcript accuracy,
language-detection, quality, latency, or throughput claim.

For CI-only loaded-module inspection, set both
`MEETINGRELAY_SHERPA_MODULE_PROBE_READY_FILE` and
`MEETINGRELAY_SHERPA_MODULE_PROBE_HOLD_MS`. After successful `Prepare`, the
smoke writes its decimal PID (without a newline) to the ready file and pauses
for 1–15000 ms. This lets an external PowerShell probe verify the loaded sherpa
and ONNX Runtime module paths and hashes. If the ready-file variable is absent,
the probe path has zero effect.
