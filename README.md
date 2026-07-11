# MeetingRelay

MeetingRelay is currently in **WP-0.3 Phase 0 harness work**. WP-0.3.1 completed the evidence/trace eligibility contract; WP-0.3.2 added one consent-safe calibration fixture; WP-0.3.3 added deterministic ledgers; WP-0.3.4 adds a deterministic, virtual-clock provider stub for the committed script and empty fault plan. It does not use a network or real timer and does not contain or claim recording, ASR, translation, persistence, production UI behavior, a product provider, or formal `PERF-RT-*` evidence.

## Prerequisites

- Windows x64
- Rust 1.95 with the Windows MSVC target
- pnpm 9.15.9
- Microsoft C++ Build Tools with a compatible Windows SDK
- Microsoft Edge WebView2 Runtime

Use a Developer PowerShell or another shell where the MSVC toolchain is available.

## Workspace commands

```powershell
pnpm install
pnpm desktop:typecheck
pnpm desktop:dev
pnpm desktop:build
pnpm phase0:fixtures:test
pnpm phase0:fixtures:validate
pnpm phase0:ledgers:test
pnpm phase0:ledgers:validate
pnpm phase0:provider:test
pnpm phase0:provider:validate
pnpm tauri -- --version
```

The desktop commands delegate to `apps/desktop`. The Tauri command forwards additional arguments to that package's Tauri CLI script.

## Verification

Run the complete Phase 0 verification surface from the repository root:

```powershell
pnpm install --frozen-lockfile
pnpm phase0:fixtures:test
pnpm phase0:fixtures:validate
pnpm phase0:ledgers:test
pnpm phase0:ledgers:validate
pnpm phase0:provider:test
pnpm phase0:provider:validate
pnpm --dir apps/desktop test
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features --locked -- -D warnings
cargo check --workspace --all-targets --all-features --locked
cargo test --workspace --all-targets --all-features --locked
cargo test --workspace --release --all-targets --all-features --locked
pnpm desktop:typecheck
pnpm desktop:build
cargo build --package meetingrelay-desktop --release --locked
pnpm --dir apps/desktop tauri build --no-bundle
```

IPC and ledger uint64/ns values use canonical unsigned decimal strings. The ledger validator runs two clean replays: `input-ledger.jsonl` and `decision-ledger.jsonl` must be byte-for-byte and SHA-256 identical; `observation-ledger.jsonl` intentionally preserves distinct run IDs and actual monotonic observations, so it is checked for canonical encoding, order, causation, source hashes, and join integrity instead of byte equality. Generated evidence stays under ignored `target/wp-0.3/ct-ledger-001/`.

The provider harness performs two clean, byte-identical virtual-clock runs under ignored `target/wp-0.3/provider-harness/`. Version 1.0 intentionally accepts only the committed empty fault plan; any non-empty or unknown fault step fails before the first emission. Logical offsets are ordering inputs, not latency observations or performance evidence.

Commit-specific completion requires the `Phase 0 Contract CI` workflow to be green on the pinned `windows-2022` runner. Local success alone is not release evidence. These checks validate only the bootstrap and harness-contract boundaries and do not claim session, audio, ASR, translation, persistence, UI paint, or other product capability.
