# Cohere Transcribe GPU worker

MeetingRelay uses a persistent local Python sidecar for
`CohereLabs/cohere-transcribe-03-2026`. Audio is sent as framed PCM16 over
anonymous process pipes; it is not uploaded by MeetingRelay.

The runtime is intentionally external to the Git repository because CUDA
PyTorch and the gated model are several gigabytes. Run `setup.ps1` after
accepting the model terms on Hugging Face:

```powershell
powershell -ExecutionPolicy Bypass -File tools/cohere-transcribe/setup.ps1
```

The default environment is created under
`%LOCALAPPDATA%\MeetingRelay\runtimes\cohere-transcribe-03-2026`, together with
a copy of the locked worker entry point. Override the interpreter with
`MEETINGRELAY_COHERE_PYTHON` and the worker with
`MEETINGRELAY_COHERE_WORKER`. A non-default verified snapshot directory can be
supplied with `MEETINGRELAY_COHERE_MODEL_DIR`.

The worker is offline at inference time. It requires the locked snapshot and
verifies `model.safetensors` before loading it on CUDA.

Run the repeatable Windows three-language smoke after setup:

```powershell
powershell -ExecutionPolicy Bypass -File tools/cohere-transcribe/smoke.ps1
```

The smoke uses the installed Microsoft Chinese, Japanese, and English desktop
voices to create consent-safe 16 kHz PCM16 fixtures, sends them through the same
persistent worker protocol used by MeetingRelay, and writes CER/RTF evidence
under `target/mvp/acceptance/cohere-smoke/`.
