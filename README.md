# MeetingRelay

MeetingRelay is currently in **WP-0.2 benchmark-only bootstrap**. This workspace establishes the Windows x64, Tauri 2, Rust, and pnpm build boundary needed by later validation work. It does not contain or claim any product features: recording, ASR, translation, persistence, and production UI behavior remain out of scope for this work package.

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
pnpm tauri -- --version
```

The desktop commands delegate to `apps/desktop`. The Tauri command forwards additional arguments to that package's Tauri CLI script.

## Verification

Run the complete WP-0.2 verification surface from the repository root:

```powershell
pnpm install --frozen-lockfile
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

IPC uint64/ns values use canonical unsigned decimal strings, and frontend contract tests plus the Tauri mock IPC test cover the shared command-name contract.

Commit-specific completion requires the `WP-0.2 Bootstrap CI` workflow to be green on the pinned `windows-2022` runner. Local success alone is not release evidence. These checks validate only the benchmark bootstrap boundary and do not claim session, audio, ASR, translation, persistence, or other product capability.
