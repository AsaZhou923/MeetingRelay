# MeetingRelay

MeetingRelay is currently in **WP-0.4.3b sherpa native functional integration**. WP-0.3.1 through WP-0.3.7 completed the deterministic Phase 0 harness gates; WP-0.4.1 added the transport-neutral model-worker semantic contract; WP-0.4.2 added candidate artifact integrity and claim authority; and WP-0.4.3a established the non-cloneable, exactly-once backend action/outcome seam. WP-0.4.3b pins the official sherpa-onnx 1.13.4 shared Windows runtime and SenseVoice 2024 INT8 assets, adds an offline-by-default materializer, independently verifies canonical PCM SHA-256 at the adapter boundary, and runs a real functional inference smoke. This narrow smoke does not establish accuracy, quality, latency, throughput, candidate eligibility, distribution approval, or production readiness.

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
pnpm phase0:candidate-artifacts:test
pnpm phase0:candidate-artifacts:validate
pnpm phase0:sherpa-assets:test
pnpm phase0:sherpa-assets:validate
pnpm phase0:ledgers:test
pnpm phase0:ledgers:validate
pnpm phase0:provider:test
pnpm phase0:provider:validate
pnpm phase0:clock:test
pnpm phase0:clock:validate
pnpm phase0:resources:test
pnpm phase0:resources:validate
cargo test --package meetingrelay-model-worker-contract --all-targets --locked
cargo test --package meetingrelay-model-worker-sherpa-native --no-default-features --locked
pnpm tauri -- --version
```

The desktop commands delegate to `apps/desktop`. The Tauri command forwards additional arguments to that package's Tauri CLI script.

## Verification

Run the complete Phase 0 verification surface from the repository root:

```powershell
pnpm install --frozen-lockfile
pnpm phase0:fixtures:test
pnpm phase0:fixtures:validate
pnpm phase0:candidate-artifacts:test
pnpm phase0:candidate-artifacts:validate
pnpm phase0:sherpa-assets:test
pnpm phase0:sherpa-assets:validate
pnpm phase0:ledgers:test
pnpm phase0:ledgers:validate
pnpm phase0:provider:test
pnpm phase0:provider:validate
pnpm phase0:clock:test
pnpm phase0:clock:validate
pnpm phase0:resources:test
pnpm phase0:resources:validate
cargo test --package meetingrelay-model-worker-contract --all-targets --locked
cargo test --package meetingrelay-model-worker-sherpa-native --no-default-features --locked
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

Native-feature checks and the ignored real SenseVoice smoke require the sealed assets and pinned DLLs to be materialized and staged first. Follow [the sherpa asset instructions](tools/sherpa-native/README.md) and [the adapter smoke instructions](crates/model-worker-sherpa-native/README.md). The upstream build script's implicit network-download path is not an accepted project workflow.

IPC and ledger uint64/ns values use canonical unsigned decimal strings. The ledger validator runs two clean replays: `input-ledger.jsonl` and `decision-ledger.jsonl` must be byte-for-byte and SHA-256 identical; `observation-ledger.jsonl` intentionally preserves distinct run IDs and actual monotonic observations, so it is checked for canonical encoding, order, causation, source hashes, and join integrity instead of byte equality. Generated evidence stays under ignored `target/wp-0.3/ct-ledger-001/`.

The WP-0.4.2 artifact validator generates an ignored bundle under `target/wp-0.4/ct-candidate-artifact-001/`. A sealed input manifest hashes the candidate, fixture-set, `HW-REF`, run-plan, core/UI harness, release command, VAD/endpoint configuration, distinct warmup plan, contract assets, and license snapshot; a separately sealed evidence manifest references the input contract digest without creating a hash cycle. Validation rejects non-canonical JSON, unsafe or reparse-point paths, missing/zero/mismatched hashes, unresolved licenses, broken joins, private hardware identifiers, invalid cold/warm/soak bounds, inventory changes, and claims of eligibility, selection, production paint, SLO, or formal product performance. The JSON worker manifest is an artifact projection of the Rust `WorkerManifest`/`EngineDescriptor`; a regression test compares its exact field names with the Rust source, while Rust remains the only source of worker handshake and runtime semantics.

The same validator accepts structurally complete native, sidecar, and fallback candidate-run bundles, measured `HW-REF` records, multiple assets/licenses, and completed raw evidence. Those bundles must be validated with an independently pinned input-contract digest:

```powershell
node tools/phase0-harness/validate-candidate-artifact-contract.mjs --existing <bundle-root> <pinned-contract-sha256> <approved-license-sha256>...
```

The contract digest and every accepted license-text digest must come from an out-of-band approved run plan, legal record, or evidence ledger, not from the bundle being checked. Completed raw evidence still cannot declare a candidate eligible, selected, ranked, default, production-ready, or compliant with a formal `PERF-*`/SLO.

The provider harness performs two clean, byte-identical virtual-clock runs under ignored `target/wp-0.3/provider-harness/`. Version 1.0 intentionally accepts only the committed empty fault plan; any non-empty or unknown fault step fails before the first emission. Logical offsets are ordering inputs, not latency observations or performance evidence.

Clock calibration performs two actual `process.hrtime.bigint()` runs under ignored `target/wp-0.3/ct-clock-cal-001/`. Each run has its own `node.hrtime.<run_id>` domain and cannot be subtracted from another run. Runtime artifact byte equality is explicitly not required. `observed_resolution` and `observed_quantization` are descriptive values from this sample only; reference-clock error stays `null` because no independent reference clock exists.

The queue/resource harness writes two runs under ignored `target/wp-0.3/ct-resource-harness-001/`. Its fixed-capacity `Q-HARNESS-COALESCE` scenario uses a logical clock and must produce byte-identical queue artifacts. Mutually exclusive dequeue, drop, merge, cancel, and remaining-depth outcomes conserve every enqueued item; retry and full counters describe attempts only. Only an interim item identified as a `superseded_revision` may use the scripted drop/coalescing path. Actual resource snapshots use one `node.hrtime.<run_id>` domain per run and are validated for canonical encoding, capability/schema projection, observation-clock ordering, and checksums rather than cross-run byte equality. Per-core CPU arrays preserve each snapshot's order but do not claim stable core identity across samples. The harness does not use sleep, wall-clock time, or a network and does not establish production sampling cadence, resource limits, or product queue behavior.

Commit-specific completion requires the `Phase 0 Contract CI` workflow to be green on the pinned `windows-2022` runner. Local success alone is not release evidence. These checks validate the bootstrap/harness boundaries, worker contract, asset lock, minimal sherpa adapter, and one functional inference path. `CT-WORKER-CANDIDATE-001` remains pending: no model accuracy/quality, candidate eligibility/ranking/default selection, approved distribution, formal performance/SLO, production session/audio capture/ASR pipeline, translation, persistence, UI paint, or other product capability is claimed.
