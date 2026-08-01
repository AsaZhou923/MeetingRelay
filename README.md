<h1 align="center">MeetingRelay</h1>

<p align="center">
  <strong>English</strong> · <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  Local-first meeting transcription for Windows, powered by on-device Cohere Transcribe GPU or SenseVoice CPU ASR, durable SQLite storage, and optional OpenAI-compatible translation.
</p>

<p align="center">
  <a href="https://github.com/AsaZhou923/MeetingRelay/releases/latest"><img alt="Release" src="https://img.shields.io/github/v/release/AsaZhou923/MeetingRelay?display_name=tag"></a>
  <a href="https://github.com/AsaZhou923/MeetingRelay/actions/workflows/mvp.yml"><img alt="Personal MVP CI" src="https://github.com/AsaZhou923/MeetingRelay/actions/workflows/mvp.yml/badge.svg?branch=main"></a>
  <a href="LICENSE"><img alt="License: Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-blue.svg"></a>
  <img alt="Platform" src="https://img.shields.io/badge/platform-Windows%2010%2F11-0078D4?logo=windows">
  <img alt="Tauri" src="https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri&logoColor=white">
  <img alt="Rust" src="https://img.shields.io/badge/Rust-1.95-000000?logo=rust">
</p>

<p align="center">
  <a href="#features">Features</a> ·
  <a href="#quick-start">Quick Start</a> ·
  <a href="#openai-compatible-translation">Translation</a> ·
  <a href="#development-and-validation">Development</a> ·
  <a href="#current-limitations">Limitations</a>
</p>

MeetingRelay captures system playback and microphone input, performs real-time speech recognition locally, and marks final transcript segments as saved only after a successful SQLite commit. When bilingual notes are needed, it can connect to Ollama, LM Studio, or a third-party OpenAI-compatible service. Translation failures never delete, overwrite, or delay the original transcript.

> [!IMPORTANT]
> The `MeetingRelay.exe` published in the current Release is unsigned and does not include the Cohere or SenseVoice model runtimes. Follow the [Quick Start](#quick-start) instructions to prepare the local assets before first use.

## Features

- **Selectable local ASR** — uses Cohere Transcribe 2B with CUDA/BF16 for the high-quality GPU path, with pinned Sherpa / SenseVoice int8 available as the CPU path; audio and speech recognition stay on the machine.
- **Dual-source capture** — select Windows system output and microphone devices.
- **Chinese, Japanese, and English** — select one recognition language before each meeting; the choice is locked while recording.
- **Stable live transcript** — final rows are reconciled by stable keys instead of rebuilding the entire list on every poll.
- **Persistence first** — the original transcript is committed to SQLite/WAL before it is shown as saved or submitted for translation.
- **Optional AI translation** — supports local and third-party OpenAI-compatible Chat Completions services.
- **Failure isolation** — translation, network, or model failures do not affect committed originals.
- **Meeting recovery** — recover committed finals after an abnormal exit and reopen the most recent meeting.
- **Copy and export** — copy the complete transcript or export JSON, Markdown, and TXT.
- **Windows personal release** — generate a same-machine directory containing the EXE, model, runtime, lock files, and a relative-path launcher.

## How it works

```mermaid
flowchart LR
    SYS["System output"] --> CAP["Windows audio capture"]
    MIC["Microphone"] --> CAP
    CAP --> ASR["Local Cohere GPU or SenseVoice CPU ASR"]
    ASR --> DB["SQLite / WAL<br/>durable final"]
    DB --> UI["Stable live transcript"]
    DB --> TQ["Independent translation queue"]
    TQ --> LLM["OpenAI-compatible service"]
    LLM --> TR["Translation state and result"]
    DB --> OUT["Copy and export"]
    TR --> OUT
```

The ordering is always:

1. Local ASR produces a final segment.
2. The original text is committed to SQLite.
3. The UI marks the segment as saved.
4. If translation is enabled, the committed final is submitted asynchronously.
5. The translation is persisted independently as `completed`, `failed`, or `skipped`.

## Quick Start

### Requirements

- Windows 10 or Windows 11
- Node.js `24.13.0`
- pnpm `9.15.9`
- Rust `1.95.0` with `rustfmt` and `clippy`
- Visual Studio 2022 Build Tools with **Desktop development with C++**
- WebView2 Runtime
- Git for Windows

### Run from source

```powershell
git clone https://github.com/AsaZhou923/MeetingRelay.git
cd MeetingRelay

corepack enable
corepack prepare pnpm@9.15.9 --activate
pnpm install --frozen-lockfile

# First run: download and verify the pinned model and native runtime.
powershell -ExecutionPolicy Bypass -File tools/mvp/start.ps1 -AllowDownload
```

After the assets have been materialized, start without network downloads:

```powershell
powershell -ExecutionPolicy Bypass -File tools/mvp/start.ps1
```

Validate dependencies, assets, and the launch contract without opening the application:

```powershell
powershell -ExecutionPolicy Bypass -File tools/mvp/start.ps1 -DryRun
```

## Local ASR model

### Cohere Transcribe 2B GPU path

First accept the gated model terms and authenticate the Hugging Face CLI, then
create the isolated CUDA runtime:

```powershell
hf auth login
powershell -ExecutionPolicy Bypass -File tools/cohere-transcribe/setup.ps1
```

The setup script installs the pinned Python/CUDA dependencies under
`%LOCALAPPDATA%\MeetingRelay\runtimes\cohere-transcribe-03-2026` and downloads
the exact model revision into the Hugging Face cache. MeetingRelay verifies the
expected model file size before offering it in the selector; the persistent
worker verifies the full SHA-256 digest before loading it. Inference then runs
offline over a local pipe.

| Item | Value |
| --- | --- |
| Model | `CohereLabs/cohere-transcribe-03-2026` |
| Revision | `b1eacc2686a3d08ceaae5f24a88b1d519620bc09` |
| `model.safetensors` | 4,131,862,976 bytes |
| Model SHA-256 | `987bd3e141c7bfdb5a78f5db11397ee7737308357e6cc0a3f36a4979b158137a` |
| Runtime | PyTorch `2.10.0` + CUDA 12.8, Transformers `5.4.0`, BF16 |
| Recommended GPU memory | 8 GB or more |
| License | Apache-2.0; gated Hugging Face access is still required |

On the current RTX 5070 Ti Laptop GPU, a four-sample Japanese smoke benchmark
(three synthetic utterances and one FLEURS utterance) produced normalized CER
`0`, average RTF `0.029` (about 35× real time), peak VRAM `3.894 GiB`, and a
roughly `10.5 s` cold model load. This is integration evidence, not a
representative long-meeting quality benchmark.

Run the repeatable Windows Chinese/Japanese/English smoke through the same
worker protocol:

```powershell
powershell -ExecutionPolicy Bypass -File tools/cohere-transcribe/smoke.ps1
```

The final local run produced normalized CER `0` in all three languages, with
RTF `0.102`, `0.040`, and `0.029`. The report is written under
`target/mvp/acceptance/cohere-smoke/`. A real personal-release speaker-loopback
plus microphone test also committed four Chinese finals and completed without
repeated-pattern noise segments.

### SenseVoice CPU path

Use the repository script to download the pinned CPU model. It validates the
lock file, SHA-256 digest, and extracted output:

```powershell
powershell -ExecutionPolicy Bypass -File tools/sherpa-native/materialize.ps1 `
  -AssetSet Model `
  -AllowDownload
```

Current CPU model:

| Item | Value |
| --- | --- |
| Model | `sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17` |
| Compressed archive | approximately 163 MB |
| `model.int8.onnx` | approximately 239 MB |
| Archive SHA-256 | `7d1efa2138a65b0b488df37f8b89e3d91a60676e416f515b952358d83dfd347e` |
| Default directory | `target/sherpa-native/extracted/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17/` |

The [upstream model archive](https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2) can also be downloaded manually, but the repository script is recommended because it verifies and materializes the complete asset layout.

> [!NOTE]
> Models and native runtime libraries are not included in the public Release asset. Their use and redistribution remain subject to the respective upstream licenses.

## OpenAI-compatible translation

MeetingRelay does not bundle a translation model. It can use a local Ollama / LM Studio instance or a cloud-hosted or self-hosted OpenAI-compatible Chat Completions service.

### Built-in presets

| Service | Base URL |
| --- | --- |
| Ollama | `http://127.0.0.1:11434/v1` |
| LM Studio | `http://127.0.0.1:1234/v1` |
| OpenAI | `https://api.openai.com/v1` |
| DeepSeek | `https://api.deepseek.com` |
| OpenRouter | `https://openrouter.ai/api/v1` |
| xAI | `https://api.x.ai/v1` |
| Alibaba Cloud Model Studio / DashScope | `https://dashscope.aliyuncs.com/compatible-mode/v1` |

Choose **Other compatible service** to enter a custom Base URL, model ID, and API token.

### Configuration

1. Enable OpenAI-compatible translation.
2. Select a provider preset or enter a custom Base URL.
3. For Ollama or LM Studio, use **Refresh local models** to read the loopback
   `/v1/models` list and select an installed model. Manual model IDs remain
   available for other compatible services.
4. Enter the API token when the provider requires one. **Test connection** or starting a meeting stores it in Windows Credential Manager, not in ordinary preferences or SQLite.
5. Select the translation language for the meeting: Chinese, Japanese, or English.
6. Run **Test connection**. The probe sends only a fixed synthetic sentence, never meeting content.
7. Confirm the recording and third-party data disclosure before starting the meeting.

If the translation language is the same as the recognition language, MeetingRelay does not contact the provider and persists the segment as `skipped`.

Local profiles are restricted to loopback addresses. Provider testing verifies
that the selected model is present and then performs a real synthetic Chat
Completions probe. A local failure is reported explicitly and never triggers an
automatic cloud fallback.

### Structured summaries and Provider disclosure

Structured summaries use a separate Provider selector with no implicit
default. Local summaries remain on the selected loopback service. Starting or
retrying a LAN or Cloud summary displays the Provider, model, data flow, policy,
and possible cost, and requires confirmation before the complete durable
transcript is sent. The backend independently rejects missing Providers or
missing non-local acknowledgement.

Summary jobs persist the exact Profile/config versions, Provider class,
endpoint origin/hash, model, prompt/request schema, and disclosure version.
Chunks, results, search-index changes, and the final completed state publish in
one SQLite transaction, so incomplete summaries do not become searchable.

### Remote HTTP

HTTP is allowed directly for `localhost`, `127.0.0.1`, and `[::1]`. Non-loopback HTTP is rejected by default and is enabled only after the user explicitly selects **Allow insecure remote HTTP**.

> [!WARNING]
> Remote HTTP sends the API token and durable final transcript in plaintext. Traffic can be read or modified in transit. Acknowledging the risk records a user choice; it does not provide confidentiality or integrity. Prefer HTTPS.

API tokens are loaded into process memory only while needed and are persisted exclusively in Windows Credential Manager. They are never written to localStorage, SQLite, logs, or exports. Use **Remove from OS vault** in Provider management to delete a stored token. The non-secret remote HTTP acknowledgement may be stored locally as a preference.

## Downloads and releases

Latest formal release: [MeetingRelay v0.1.1](https://github.com/AsaZhou923/MeetingRelay/releases/latest)

| File | Size | SHA-256 |
| --- | ---: | --- |
| [`MeetingRelay.exe`](https://github.com/AsaZhou923/MeetingRelay/releases/download/v0.1.1/MeetingRelay.exe) | 14,357,504 bytes | `B2276B4EFBF974EFCFA5B7D4A09C9DAE9789D8052880DBB0BDEC45C4C178997C` |

Build a complete same-machine package:

```powershell
pnpm mvp:release:personal
powershell -ExecutionPolicy Bypass `
  -File target/mvp/personal-release/MeetingRelay.same-machine.ps1
```

Output:

```text
target/mvp/personal-release/
├── MeetingRelay.exe
├── MeetingRelay.same-machine.ps1
├── model/
├── runtime/
└── locks/
```

This is a package-local personal Windows build, not an MSI or NSIS installer.

## Data and security

- Audio capture, local ASR, the original SQLite transcript, and exports stay on the machine by default.
- Durable final text is sent to the selected provider only when translation is enabled.
- A summary sends the complete durable transcript only to an explicitly selected Provider; LAN and Cloud runs require a per-run privacy and cost acknowledgement.
- Original text is committed before any network translation request; a provider failure cannot invalidate the local record.
- API tokens are persisted only in Windows Credential Manager, can be removed from Provider management, and never appear in ordinary settings, SQLite, logs, copied transcripts, or exports.
- Base URLs reject embedded credentials, query strings, and fragments. Remote HTTP requires explicit acknowledgement.
- Data retention, training, billing, and regional policies for third-party services are controlled by the selected provider.
- Use the application only after meeting participants have consented to recording, transcription, and any required third-party data transfer.

Never commit `.env` files, API tokens, meeting databases, or real meeting exports.

## Development and validation

Frontend:

```powershell
pnpm --dir apps/desktop test
pnpm --dir apps/desktop typecheck
pnpm --dir apps/desktop build
```

Rust:

```powershell
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-targets --all-features
```

Launch and release contracts:

```powershell
powershell -ExecutionPolicy Bypass -File tools/mvp/start.test.ps1
pnpm mvp:release:personal:test
pnpm mvp:acceptance:test
```

CI is defined in [`.github/workflows/mvp.yml`](.github/workflows/mvp.yml). It runs on Windows Server 2022 and validates locked dependencies, the frontend, Rust formatting/Clippy/tests, pinned Sherpa assets, and the package-local Release build.

## Repository layout

```text
MeetingRelay/
├── apps/desktop/                         # Tauri 2 desktop application and frontend
├── crates/model-worker-sherpa-native/   # Product SenseVoice ASR backend
├── crates/model-worker-contract/        # Internal ASR interface types
├── tools/cohere-transcribe/             # Cohere CUDA runtime and persistent worker
├── tools/sherpa-native/                 # Pinned assets, validation, and runtime staging
├── tools/mvp/                           # Windows launch and release tooling
├── tools/distribution/                  # NSIS staging, SBOM, signing, and release gates
└── .github/workflows/mvp.yml            # Windows product CI
```

Earlier Phase 0, attestation, benchmark, candidate-engine, and experiment code is preserved on [`archive/full-repository-before-mvp-trim-2026-07-23`](https://github.com/AsaZhou923/MeetingRelay/tree/archive/full-repository-before-mvp-trim-2026-07-23).

## Current limitations

- The fail-closed ASR registry now offers Cohere Transcribe 2B as the
  high-quality GPU profile when its exact runtime and model are installed, plus
  Sherpa / SenseVoice as the selectable CPU fallback. It does not silently
  switch models after an inference failure.
- Cohere Transcribe is not a native streaming decoder. MeetingRelay feeds
  endpointed/partial PCM chunks to the persistent model worker, so the UI gets
  chunked live updates rather than token-level true streaming. The model path
  also does not provide word timestamps, diarization, or automatic language
  detection; MeetingRelay fixes the meeting language and owns the segment
  timeline.
- Cohere has passed the local CUDA/integration smoke described above, but
  representative same-material Chinese/Japanese/English, noisy-room, and
  long-meeting comparisons are still required before quantifying its quality
  advantage over SenseVoice.
- Mixed-language recognition is not supported. Each meeting uses one selected recognition language.
- OpenAI-compatible translation uses non-streaming requests per final segment. Manual segment/meeting retry and sanitized attempt provenance are included; token streaming, context windows, proxies, and custom headers/bodies are not.
- The 60-minute microphone path and an audible system-loopback short meeting have passed real-device validation. Device hot-plug behavior still requires validation.
- A short real Windows system-audio meeting has passed the full local-ASR → remote-translation → SQLite path with `gpt-5.4-mini`. The repository now includes a repeatable Windows acceptance evidence gate for 10–20 minute HTTPS meetings, cost/latency/quality reporting, two-hour dual-source loss/gap, and timeline p95/max thresholds. A real evidence run on representative hardware, a second clean Windows machine, and a signed installer have not been validated.
- The published `MeetingRelay.exe` is unsigned, and public assets do not include the model or Sherpa runtime. The repository can build an explicitly marked unsigned NSIS test installer; a formal installer remains blocked until asset redistribution is approved and an Authenticode certificate is supplied.
- Post-meeting speaker diarization is available when raw audio was explicitly captured. If raw audio is missing or unreadable, MeetingRelay reports speaker analysis as unavailable/failed and does not create a text-derived speaker version.

## Roadmap

- Validate ASR and translation quality with representative Chinese, Japanese, and English meetings.
- Validate audible system-output loopback and device hot-plug behavior.
- Evaluate streaming translation only if complete-result latency proves disruptive in real meetings.
- Validate system-only, microphone-only, both-source, raw-audio recovery, and disk-pressure behavior on representative Windows hardware.
- Approve the pinned model/runtime redistribution records, sign the NSIS installer and bundled Windows binaries, and complete the second clean-machine install/upgrade/uninstall test. Windows Credential Manager integration and a real credential round trip are complete.
- Complete same-material Chinese/Japanese/English and noisy long-meeting
  comparisons for Cohere versus SenseVoice, then add controlled distribution
  packaging and structured meeting/segment provenance.
- Validate the implemented Ollama / LM Studio model discovery and per-meeting
  selection on a real fully offline meeting, including network auditing and
  long-meeting resource measurements.

## Contributing

Issues and pull requests are welcome. For larger product or architecture changes, open an issue first and describe the use case, data boundary, and acceptance criteria.

Before submitting a change, run at least:

```powershell
pnpm --dir apps/desktop test
pnpm --dir apps/desktop typecheck
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-targets --all-features
```

Keep changes small and reviewable. Do not commit API tokens, real meeting content, model files, or local databases.

## License and distribution

MeetingRelay-authored source code is licensed under the [Apache License, Version 2.0](LICENSE). The project license does not replace or modify the licenses of third-party software, runtime components, or model assets.

The Cohere Transcribe model, SenseVoice model, Sherpa native runtime, and other third-party components remain subject to their respective upstream licenses and access terms. Cohere Transcribe is Apache-2.0 but gated on Hugging Face; its weights and Python/CUDA runtime are not bundled. `NOTICE.md`, `THIRD_PARTY_NOTICES.md`, SBOM generation, and a strict redistribution-approval gate are present, but the locked distribution statuses are still pending. The current formal GitHub Release therefore remains the unsigned EXE and does not bundle models or native runtimes.

## Acknowledgements

- [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)
- [SenseVoice](https://github.com/FunAudioLLM/SenseVoice)
- [Cohere Transcribe](https://huggingface.co/CohereLabs/cohere-transcribe-03-2026)
- [Tauri](https://tauri.app/)
- [Ollama](https://ollama.com/)
- [LM Studio](https://lmstudio.ai/)
