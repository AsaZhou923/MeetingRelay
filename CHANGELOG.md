# MeetingRelay Update Log

This file records user-visible product changes, validation evidence, security-relevant
decisions, and known acceptance gaps.

## 2026-07-25 — R0–R4 delivery

### Status

- R1, R3, and R4 are complete.
- R2 implementation and automated validation are complete; its long-duration device
  measurements remain grouped with the outstanding R0 real-device acceptance work.
- R0 is partially complete. Real Windows audio capture, local ASR, durable SQLite
  storage, and OpenAI-compatible translation have passed. HTTPS, 10–20 minute
  translated meetings, and a fee report remain open.

### Added

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
