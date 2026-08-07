# MeetingRelay Update Log

This file records user-visible product changes, validation evidence, security-relevant
decisions, and known acceptance gaps.

## Unreleased

## 2026-08-07 — v0.1.4 Faster live captions and compact overlay

- Reduced chunked-ASR latency from a two-second interim cadence and eight-second
  continuous-speech final boundary to one second and four seconds respectively,
  while retaining the 650 ms silence endpoint. A meaningful interim that was
  already published may now use the existing SQLite-first final path only when
  the matching final ASR call succeeds with low-information text; ASR errors or
  mismatched session, segment, revision, or sample bounds never use the fallback.
- Expanded the caption overlay into an oldest-to-newest three-line recency stack,
  with the current line emphasized and translation-only status rules shared with
  the main UI. Added a close control that hides rather than destroys the native
  window, immediate main-window visibility synchronization, a 250 ms visible
  polling cadence, and responsive latest-line preservation down to 320×120.
- Added regression coverage for endpoint timing, interim/final salvage boundaries,
  translation-only privacy, minimal Tauri event/window permissions, hide-only
  close behavior, and compact overlay dimensions. Local validation passed with
  66 frontend tests, TypeScript/Vite production build, 228 Rust tests (7
  environment-dependent tests ignored), fmt, strict Clippy, launcher, release,
  acceptance contracts, and 90 distribution assertions. The exact PR candidate
  and post-merge `main` Windows CI runs also passed. Representative fast/
  overlapping-speech and packaged native-window acceptance remain pending.
- Kept primary data-directory settings available before storage preflight. If a
  saved root cannot be opened on launch, the Settings UI now identifies the
  unavailable root and can validate and save a replacement without requiring
  the active SQLite storage to exist; the replacement is applied after restart.
- Aligned the caption overlay's native Tauri minimum width with its documented
  and CSS-tested 320 px compact layout instead of stopping resize at 480 px.
- Frozen `v0.1.4` Windows executable candidate from final merged source:
  14,710,784 bytes, ProductVersion/FileVersion `0.1.4`, SHA-256
  `59912C834FA414B762AB0A95E44F402D7EDD2F4BD1C526409F0049F2C55A25FF`.
  The public EXE remains unsigned and excludes model/runtime assets.

## 2026-08-06 — v0.1.3 Data location, burst resilience, and caption overlay controls

- Added a user-configurable primary data directory in Settings. MeetingRelay
  validates and creates the absolute directory, probes write access, saves the
  choice outside the active data root, and applies it after restart. Existing
  data is not moved automatically, and `MEETINGRELAY_MVP_DATA_DIR` remains the
  explicit environment override.
- Deferred ASR worker preparation until the saved model choice is known. Startup
  no longer prepares the default Sherpa model and then immediately replaces it
  with a different selected model.
- Increased the audio packet queue from 32 to 128 and the final-inference queue
  from 8 to 32, shortened the minimum accepted speech block from 200 ms to 120
  ms, and added a bounded 250 ms final-queue retry. This reduces dropped short or
  bursty utterances while preserving bounded memory and fail-closed overload
  behavior.
- Simplified the caption overlay to a persistent `实时字幕` surface. It prefers
  the current interim text and otherwise keeps the newest final, shows no
  waiting/debug revision/timeline text, supports persisted A-/A+ font sizing,
  and exposes native drag and southeast resize controls.
- Added frontend and Rust regression coverage for data-directory validation,
  queue bounds and burst absorption, short-speech acceptance, overlay fallback,
  font-size limits, and the narrowed Tauri window permissions. Validation passed
  with 64 frontend tests, TypeScript/Vite production build, and 222 Rust tests
  (7 environment-dependent tests ignored by design), plus fmt and strict Clippy.
  Real Windows
  high-rate speech and native drag/resize acceptance remain to be run on the
  packaged desktop application.
- Frozen `v0.1.3` Windows executable candidate: 14,681,088 bytes,
  ProductVersion/FileVersion `0.1.3`, SHA-256
  `40751DAAC18A233DE7ED7C140A569A8712D2066C03C60AAD679935AE2B67EBE2`.
  The public EXE remains unsigned and excludes model/runtime assets.

## 2026-08-05 — v0.1.2 Remembered settings and optional live text mirror

- Added a persistent live-transcript display choice between original plus
  translation and translation only. The main transcript, fixed latest-line dock,
  and caption overlay share the same rule; pending, failed, skipped, and disabled
  translations show an explicit status instead of leaking the original text or
  leaving a blank row.
- Kept translation opt-in and remembered the last non-secret meeting settings:
  recognition language, audio-source mode, display mode, live-TXT choice and
  directory, translation enabled state, target language, Provider Profile, model,
  and remote-HTTP acknowledgement. Provider Base URL/model remain in the existing
  versioned SQLite Profile; API tokens remain exclusively in Windows Credential
  Manager and are not written to localStorage or SQLite.
- Added an optional per-meeting UTF-8/LF TXT mirror. It is off by default, requires
  an existing absolute directory, creates `MeetingRelay-{meeting_id}.txt` without
  overwriting an existing file, and appends only non-duplicate final originals
  after the SQLite commit acknowledgement. A mirror failure disables only the
  external writer and leaves the durable meeting record intact.
- Added actionable path/write errors and regression coverage for preference
  parsing, secret exclusion, all translation-only states, IPC compatibility,
  directory validation, non-overwrite behavior, commit ordering, and mirror
  failure isolation.
- Validation passed with 56 frontend tests, a TypeScript/Vite production build,
  199 Rust tests (5 additional environment-dependent tests ignored by design),
  `cargo fmt --check`, and Clippy with warnings denied. A real Windows meeting
  writing to representative local/network-controlled directories remains an
  environment acceptance item.
- Frozen `v0.1.2` Windows executable candidate: 14,639,104 bytes, ProductVersion
  `0.1.2`, SHA-256
  `C21716304E3BEC7ADD78E970F22DF8B79FDF9DBD5777074A448770CEFC859233`.
  The public EXE remains unsigned and excludes the model and Sherpa runtime.

## 2026-08-04 — Meeting workflow usability remediation

- Reorganized the desktop UI into three task-focused views: Live Meeting,
  Meeting Records, and Settings. The live view now keeps consent and session
  controls in the first screen while moving provider, storage, history,
  summary, export, and governance tools out of the transcript workspace.
- Standardized the main Windows UI on a Chinese-first vocabulary and one visual
  system, with larger supporting text, clearer disabled/focus states, responsive
  desktop layouts, and internal stage/queue terminology removed from normal use.
- Made Start respond immediately with a stable pending state and `aria-busy`,
  while rejecting duplicate clicks until the first start attempt completes.
- Added an independent transcript scroller, explicit follow-latest state, an
  unseen-item counter with a Return to Latest action, and a fixed latest/current
  line area that does not disturb a user reading earlier transcript rows.
- Corrected the follow-up layout regressions in Meeting Records and Settings:
  secondary cards now keep their intrinsic height, use page-level scrolling,
  and no longer clip their controls. The live workspace now owns the remaining
  window height, keeps transcript history in a bounded scroller, and labels the
  fixed bottom dock as the latest sentence.
- Kept Provider test results in dedicated state so profile refreshes no longer
  erase success or failure feedback. Profile and secret mutations now invalidate
  stale results explicitly instead of presenting an old probe as current.
- Gave Provider probes a shared 15-second budget and distinct timeout errors,
  while preserving the longer production translation timeout. Local discovery
  and completion probes now consume the same deadline.
- Suppressed non-interactive Windows PowerShell windows for Credential Manager
  and disk-space checks, removing the known source of repeated console flashes.
- Added pure frontend state coverage for start guards, Provider result
  persistence, transcript following, and latest-sentence selection. Validation
  passed with 52 frontend
  tests, TypeScript/Vite production build, 214 Rust tests (5 ignored by design),
  and all 10 personal-release contract assertions.
- Generated and window-smoke-tested a package-local personal build at
  14,605,312 bytes with SHA-256
  `D72E5245E46DFF65BC181E2AF41003050FD8026E3904338F262AA331182E5CA0`.
- Cold/warm start p50/p95, real local/LAN/cloud Provider matrices, high-DPI
  coverage, and long-meeting transcript pressure remain explicit environment
  acceptance work.

## 2026-08-01 — Privacy and durability remediation

- Made summary Provider selection explicit and independent from Provider
  management state. LAN and Cloud summaries now require a per-run disclosure
  that names the Provider, model, data flow, policy, and possible cost before
  the full durable transcript can leave the device.
- Enforced the same boundary in Rust IPC: missing Providers fail with
  `SUMMARY_PROVIDER_REQUIRED`, non-local runs without acknowledgement fail with
  `SUMMARY_RISK_ACK_REQUIRED`, and retries must use the original Provider.
- Upgraded SQLite to schema v8 and persisted summary Profile/config versions,
  Provider class, endpoint origin/hash, model, acknowledgement state, and
  disclosure version.
- Made summary completion atomic. Chunks, structured results, search-index
  effects, and the final `completed` state now commit in one transaction; a
  failed batch publishes nothing.
- Made translation submission outcomes durable before queue publication.
  Queue-full and stopped-worker failures survive reload, while same-language
  segments are persisted as `skipped` without entering the Provider queue.
- Removed the obsolete raw-config `mvp_test_translation` IPC path so provider
  tests continue to resolve endpoints and credentials through versioned
  Profiles and Windows Credential Manager.
- Enforced the caption overlay's read-only boundary with Tauri application
  command permissions. The overlay is allowed to call only `mvp_snapshot`.
- Revalidated 41 frontend tests, TypeScript/Vite production build, 187 Rust
  tests (5 explicitly ignored), strict locked/offline Clippy, launcher/release/
  acceptance/distribution contracts, and the production dependency audit.
- `cargo-audit`, live ignored CUDA/Provider tests, real-device long meetings,
  real Ollama/LM Studio meetings, and signed clean-machine installer acceptance
  remain explicit environment or release-evidence gaps.

## 2026-07-29 — Cohere Transcribe GPU ASR

- Added Cohere Transcribe 2B as the high-quality Windows GPU profile, using a
  persistent local Python/CUDA worker with framed PCM16 transport. The model is
  loaded once in BF16 and remains resident across segment requests.
- Pinned the gated Hugging Face model revision, size, SHA-256, Apache-2.0
  identity, PyTorch/CUDA runtime, and Transformers version. Startup is
  fail-closed when the runtime, worker, CUDA device, or exact model asset is
  missing or invalid; the worker verifies the full model hash before loading.
- Connected the existing ASR selector and inference queue to the Cohere backend.
  Sherpa / SenseVoice remains available as the CPU option, and MeetingRelay
  never silently changes models after a failure.
- Verified the Rust-to-Python CUDA sidecar in a live ignored integration test.
  A four-sample Japanese smoke benchmark on an RTX 5070 Ti Laptop GPU produced
  normalized CER `0`, average RTF `0.029` (about 35× real time), peak VRAM
  `3.894 GiB`, and a roughly `10.5 s` cold load.
- Added a repeatable Windows Chinese/Japanese/English GPU smoke harness. The
  final run produced normalized CER `0` for all three languages, RTF `0.102`,
  `0.040`, and `0.029`, and a `11.0 s` cold load on the same GPU.
- Ran the package-local personal release against the real default Windows
  speaker loopback and microphone. Two synthetic Chinese passages produced four
  committed finals, the meeting closed as `completed`, and SQLite contained no
  repeated-pattern noise segments.
- Fixed two product regressions found by that real release test: full Cohere
  provenance labels now fit the bounded frontend contract, and short repeated
  silence/noise hallucinations are rejected without suppressing normal short
  utterances. The worker also uses a tighter duration-based generation cap.
- Revalidated 39 frontend tests, TypeScript/Vite production build, strict Rust
  formatting and Clippy, 202 Rust tests (7 explicitly ignored), the Windows
  launcher/release/acceptance/distribution contracts, the two-test native
  SenseVoice smoke, and the live Cohere CUDA sidecar test.
- Cohere currently receives endpointed/partial audio chunks rather than using
  native token streaming. Representative same-material Chinese/Japanese/English,
  noisy-room, and long-meeting quality comparisons remain pending.
- Ollama and LM Studio were both unreachable on loopback during this validation,
  so R8's real offline local-translation meeting E2E remains open; discovery,
  model selection, Chat Completions, persistence, and no-silent-cloud-fallback
  continue to be covered by the local HTTP integration suite.

## 2026-07-28 — R7/R8 Development Baseline

- Added a bounded ASR model registry with the sealed SenseVoice baseline,
  capability/resource/license metadata, pre-meeting selection, restart
  preference, model-and-language worker identity, and fail-closed selection
  errors. Meeting identity now includes the engine, runtime, model revision,
  full model SHA-256, and quantization.
- Added loopback OpenAI-compatible model discovery for Ollama and LM Studio via
  `/v1/models`, including UI refresh/selection with a manual model-ID fallback.
- Replaced the Local Provider's synthetic success shortcut with real model
  availability validation followed by a Chat Completions probe. Local profiles
  cannot be overridden by caller-supplied cloud configuration and never
  silently fall back to Cloud.
- R7 remains in progress: a second license-approved, benchmark-verified model,
  controlled materialization, and structured meeting/segment provenance are
  still required. R8 still requires a real offline Ollama/LM Studio meeting E2E,
  network audit, and long-meeting quality/resource measurements.

## 2026-07-27 — v0.1.1 Maintenance Release

- Published a maintenance release of the current Windows V1 engineering
  baseline with coherent `0.1.1` metadata across Cargo, Tauri, and both npm
  packages.
- Added the planned R7/R8 directions to the public roadmap: benchmark-gated
  selection of a demonstrably higher-quality ASR model, and first-class local
  Ollama / LM Studio translation-model selection with no silent cloud fallback.
  These capabilities were roadmap items in v0.1.1; the first implementation
  baseline is recorded in the 2026-07-28 entry above.
- Release artifact: 14,357,504 bytes, SHA-256
  `B2276B4EFBF974EFCFA5B7D4A09C9DAE9789D8052880DBB0BDEC45C4C178997C`.
- Windows distribution and package-local personal release contracts passed
  before freezing the upload candidate. The complete GitHub Actions release
  baseline must pass before the tag is published.
- The public asset remains unsigned and intentionally excludes the SenseVoice
  model and Sherpa runtime. The signed NSIS path remains gated by redistribution
  approval, an Authenticode certificate, and clean-machine acceptance.

## 2026-07-26 — v0.1.0 GitHub Release

- Published the Windows V1 engineering release as an unsigned x64
  `MeetingRelay.exe`.
- The release includes the completed R1–R6 implementation: durable translation
  workflows, raw-audio recovery and governance, meeting search and export,
  provider profiles and Windows Credential Manager secrets, structured summaries,
  speaker diarization/editing, the caption overlay, accessibility gates, and
  Windows distribution engineering.
- Release artifact: 14,356,992 bytes, SHA-256
  `FD5DD25B45C2A46E87E09074402634B99F61305F6E2953C8901D64C0C6338F28`.
- GitHub Actions `Personal MVP CI` passed on the release baseline, including
  frontend validation, Rust format/Clippy/tests, locked ASR asset materialization,
  Windows acceptance/distribution contracts, and the package-local personal
  release build.
- The public asset remains unsigned and intentionally excludes the SenseVoice
  model and Sherpa runtime. A signed NSIS installer is still gated by
  redistribution approval, an Authenticode certificate, and clean-machine
  acceptance.

## 2026-07-26 — R5 delivery and R6 Windows distribution engineering

### Status

- R5 development is complete: post-meeting speaker diarization and versioned
  speaker editing/export, the read-only caption overlay, and automated
  accessibility gates are implemented.
- R6 distribution engineering is complete for local unsigned validation. A signed
  NSIS release remains blocked by pending SenseVoice/Sherpa redistribution
  approval, the absence of a code-signing certificate, and the unavailable
  second clean Windows 10/11 acceptance machine.
- R0/R2 real-device acceptance remains open for HTTPS 10–20 minute meetings,
  fee evidence, a two-hour dual-source soak, and timeline accuracy measurements.

### Added

- Deterministic post-meeting diarization over persisted raw audio with separate
  speaker identities and source metadata.
- Versioned speaker rename, merge, and undo operations; exact retry is
  idempotent and stale edits fail closed.
- Explicit current/older speaker-version export in JSON, Markdown, TXT, DOCX,
  and PDF, including valid speaker-only output in every format.
- A static, read-only Tauri caption-overlay window that consumes the same
  sequence/revision snapshot as the main window and pauses snapshot IPC while
  hidden.
- Keyboard-first focus/skip-link behavior, semantic labels, reduced-motion
  support, non-color status cues, and responsive 200%-equivalent layouts.
- Three original consent-safe 10–12 minute representative scripts for
  `zh-CN→ja-JP`, `ja-JP→zh-CN`, and `en-US→zh-CN`, with a manifest, counts, and
  SHA-256 hashes.
- Windows NSIS/current-user distribution tooling for version `0.1.0`, including
  locked resource staging, NOTICE/third-party notices, CycloneDX SBOM, signing
  hooks, downgrade rejection, data-retention hooks, and uninstall policy.

### Hardened and fixed

- Bounded speaker work to 10,000 assignments, five minutes per segment,
  twelve hours per meeting span, eight sources, and 10,000 gaps; acoustic
  features now use fixed-size windows.
- Reused the latest speaker version when the diarization digest is unchanged,
  preventing duplicate version growth.
- Revalidated raw-audio manifest roots, descendants, symlink/reparse points,
  declared lengths, and hashes before diarization.
- Replaced whole-file raw-audio hashing in manifest load, finalization, and
  recovery with a fixed 32 KiB streaming implementation.
- Fixed stale speaker labels in full-text search and aligned the frontend and
  backend speaker-assignment limit.
- Prevented a hidden overlay from continuing `mvp_snapshot` polling.
- Prevented partial installed layouts from silently falling back to a source
  checkout.
- Rejected distribution cleanup/path traversal outside approved workspace
  roots, stale installer mixing, and sealed-runtime sidecar pollution.
- Made unsigned dry runs non-destructive and isolated test artifacts from real
  distribution output.
- Made nested Windows PowerShell validation independent of inherited PowerShell
  7 module paths: SHA-256 uses a streaming .NET helper, and distribution package
  entries sanitize `PSModulePath` before launching `powershell.exe`.

### Validation

- Rust workspace: 193 passed, 6 ignored with all targets/features, offline and
  locked; formatting and Clippy with warnings denied passed.
- Frontend: 36 tests passed; TypeScript typecheck and production Vite build
  passed.
- Windows acceptance contracts: 17 assertions plus 4 live-provider-wrapper
  assertions.
- Windows distribution contract: 90 assertions.
- Windows launcher contract: 8 assertions; personal release contract:
  10 assertions.
- Browser/native accessibility checks covered first-focus skip navigation,
  keyboard activation, 200%-equivalent no-overflow layout, reduced motion,
  non-color states, and the Windows UI Automation trees for the main and
  overlay windows.

### Real Provider validation

- Read `OPENAI_API_KEY` and `OPENAI_API_BASE_URL` from
  `E:\Project Code\PicSpeak\.env` only into the test process and used exactly
  `gpt-5.4-mini`.
- The live authenticated smoke, bidirectional matrix, and production
  SecretStore/provenance service tests passed 3/3 after the final changes.
- Temporary live-test credentials were removed; the matching Windows
  Credential Manager residue count was verified as zero.
- The configured endpoint remains HTTP-only and was used under the user's
  explicit acknowledgement. It does not satisfy the formal HTTPS R0 gate.

### Remaining external acceptance

- Run at least two 10–20 minute language-pair meetings against an HTTPS provider
  and capture complete quality, latency, failure, and fee evidence.
- Run the two-hour dual-source hardware soak and the real-device timeline
  benchmark.
- Complete physical Narrator/high-DPI coverage and second-machine clean
  install/upgrade/uninstall acceptance.
- Approve redistribution licenses and provide a signing certificate before
  producing a signed installer release.

## 2026-07-25 — R0–R4 delivery

### Status

- R1, R3, and R4 are complete.
- R2 implementation and automated validation are complete; its long-duration device
  measurements remain grouped with the outstanding R0 real-device acceptance work.
- R0 is partially complete. Real Windows audio capture, local ASR, durable SQLite
  storage, and OpenAI-compatible translation have passed. HTTPS, 10–20 minute
  translated meetings, and a fee report remain open.

### Added

- Repeatable Windows acceptance evidence tooling for the remaining R0/R2 gates:
  HTTPS 10-20 minute provider meetings, cost/latency/quality evidence,
  two-hour dual-source audio loss/gap thresholds, and timeline p95/max checks.
- Translation provenance with endpoint hashing, model, prompt/config versions,
  attempt history, latency, and explicit completion/failure state.
- Single-segment and meeting-wide translation retry, progress reporting,
  cancellation, and preservation of the original final transcript.
- Opt-in raw-audio persistence with checksums and sample ranges, a unified audio
  timeline, system/microphone/dual-source modes, and interrupted-meeting recovery.
- Meeting library pagination, transcript/translation/summary/speaker search, tags,
  accurate segment navigation, and durable detail views.
- Data-governance workflows for retention, deletion preview, recoverable deletion,
  and restore.
- Local/LAN/Cloud provider profiles with versioned configuration, data-flow and
  policy metadata, provider testing, and explicit secret state.
- Windows Credential Manager-backed provider secrets, including UI controls to save
  and remove credentials without placing them in ordinary settings or SQLite.
- Versioned structured Chinese summaries with chunk/combine processing,
  cancellation, retry, and citations back to source segments.
- Selectable JSON, Markdown, TXT, DOCX, and PDF exports with original,
  translation, bilingual, speaker, summary, and timestamp content options.

### Changed

- The desktop UI now exposes R1–R4 operational state, recovery actions, meeting
  library, provider management, governance, summaries, and export controls.
- Local providers use the canonical `not_required` secret state end to end; remote
  providers distinguish `missing`, `present`, and `unsupported`.
- Provider token documentation consistently states that persisted secrets live only
  in Windows Credential Manager.
- Disk-space checks now bind data-directory paths safely, including paths containing
  spaces.

### Fixed

- Fixed Windows disk-space detection incorrectly falling back to the 512 MB reserve;
  the final desktop verification reported 45.2 GB available with no
  `MVP_DISK_SPACE_UNKNOWN` warning.
- Fixed the backend local-provider state incorrectly reporting a stored secret.
- Fixed the frontend provider parser rejecting the backend `not_required` state and
  causing the provider registry to become unavailable.
- Disabled provider secret save/remove actions for local providers and disabled
  removal when no credential exists.
- Removed an invalid translation-queue placeholder and aligned privacy/vault copy
  across the UI and README.

### Real-world validation

- Used the requested `gpt-5.4-mini` model against the configured
  OpenAI-compatible provider.
- Authenticated smoke request passed in 3047 ms.
- `ja→zh`: 5/5 requests passed, p50 1061 ms, p95/max 1849 ms.
- `zh→en`: 5/5 requests passed, p50 1613 ms, p95/max 1960 ms.
- The production secret-store/service path passed with a temporary versioned
  provider profile, real translation request, SQLite attempt/provenance evidence,
  and automatic test-secret cleanup.
- A real desktop meeting completed the audio → local ASR → remote translation →
  SQLite path with 273,120 captured system frames. The final Chinese transcript
  `开放时间早上9点至下午5点。` was persisted with the English translation
  `Open from 9:00 a.m. to 5:00 p.m.`.
- Final desktop inspection confirmed a working provider registry, Local
  `secret not_required`, LAN `secret missing`, a disabled removal action when no
  secret exists, and correct disk-space reporting.

### Automated validation

- Rust: 151 passed, 4 ignored with all targets and features.
- Rust formatting and Clippy with warnings denied passed.
- Frontend: 31 tests passed.
- TypeScript typecheck and production Vite build passed.
- Windows launcher contract: 8 assertions passed.
- Personal release contract: 10 assertions passed.
- Windows acceptance evidence contract validates a passing fixture and rejects
  remote HTTP, audio gap, and timeline regression fixtures.
- DOCX rendering was inspected through Microsoft Word and PDF rendering through
  Poppler with Chinese, Japanese, English, and long-text content.

### Security and cleanup

- Provider tokens are never written to localStorage, ordinary preferences, SQLite,
  logs, diagnostics, transcripts, or exports.
- Real-test credentials were removed from Windows Credential Manager after
  validation; the exact credential target was verified absent.
- The clipboard, test processes, and temporary launcher artifacts were cleared.
- The real-test remote endpoint was HTTP only and was used after explicit user
  acknowledgement. HTTPS remains the required final acceptance target.

### Known acceptance gaps

- Run at least two language-pair meetings for 10–20 minutes against an HTTPS
  provider and record complete latency, failure, and fee evidence.
- Complete the English representative-material long-meeting pass.
- Measure two-hour dual-source audio loss below 0.1% with no continuous gap over
  250 ms.
- Measure segment timeline error at p95 ≤ 250 ms and max ≤ 500 ms on real-device
  benchmark material.
