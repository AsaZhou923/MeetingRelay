# MeetingRelay

MeetingRelay is currently in **WP-0.4.3f candidate-input preparation**. WP-0.4.3a through WP-0.4.3f3a2b are Done/Passed; f3a1 source `122b1d930188fcc773d1086a0f7c4a5c63adb7e4` supplies the deterministic 28-material/26-entry sealed bundle plan without granting trust, f3a2a source `2e02db4a6721fd3dc85c68f044e3080adc38c56c` supplies the externally pinned Windows materializer core, and f3a2b source `95e91317142b1475f6d79eec13851ab95f9f70ff` hardens that core with a native destination no-replace publish operation, deterministic hostile-writer checkpoints, identity-swap rejection, and conservative cleanup reporting. The f3b foundation adds measured-HW input closeout without executing the candidate/model or creating evidence. These slices do not claim quality/performance, rank or select a candidate, approve distribution, or grant production authority. The parent WP-0.4.3 and `CT-WORKER-CANDIDATE-001` remain open.

## Prerequisites

- Windows x64
- Rust 1.95 with the Windows MSVC target
- Node.js 24
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
pnpm phase0:hw-ref:test
pnpm phase0:sherpa-assets:test
pnpm phase0:sherpa-assets:validate
pnpm phase0:sherpa-candidate-plan:test
pnpm phase0:sherpa-candidate-bundle-plan:test
pnpm phase0:sherpa-candidate-measured-closeout:test
pnpm phase0:sherpa-candidate-materializer:test
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
pnpm phase0:hw-ref:test
pnpm phase0:sherpa-assets:test
pnpm phase0:sherpa-assets:validate
pnpm phase0:sherpa-candidate-plan:test
pnpm phase0:sherpa-candidate-bundle-plan:test
pnpm phase0:sherpa-candidate-measured-closeout:test
pnpm phase0:sherpa-candidate-materializer:test
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

Historical contract-fixture candidate manifests remain schema `1.0`. Candidate-input manifests use schema `1.1`, and every license record preserves both its review scope and upstream review-source status. Internal-evaluation review accepts only `accepted-for-internal-evaluation` or conservative `unlicensed` source states and cannot authorize accepted distribution; the generic distribution scope uses the normalized `pending|accepted|rejected` review states and retains the independent approved-license digest gate. The descriptor's `model_license_id` binds the model artifact only: the project-generated aggregate model manifest may use another resolved license record, while every artifact still requires a unique role/path/ID and a sealed digest/license join. These fields record review inputs; they do not create license text or grant redistribution rights.

Release candidate-host provenance reports the executable digest and its canonical decimal `executableSizeBytes` from the already collected file metadata; the CLI renders the same value as `executable_size_bytes`. This remains build provenance only, not model execution, performance, or quality evidence.

The candidate-input materializer requires a non-zero contract digest supplied independently from the plan; it never promotes the plan's `proposedContractSha256` into trust. On a same-volume Windows local filesystem, destination publication uses a fixed UTF-16LE encoded, non-interactive system-PowerShell command whose only state-changing operation is `.NET Directory.Move`; the underlying native directory move is one namespace-atomic no-replace operation, so a regular file, file link, junction, directory link, empty directory, or nonempty directory raced into the destination is preserved rather than overwritten. The process uses the exact `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`, disables shell lookup and profiles, supplies source/destination through a sanitized process environment, and requires an exact success token with empty stderr.

The materializer rejects UNC/network-share path syntax and requires actual local-filesystem roots. Source files are streamed from opened handles, hashed during the write, and checked against both the opened handle and current path. Generated target parents are direct-path checked and identity-recorded when created; the output parent, owned temporary root, and recorded target parents are rechecked around two pre-publish input validations. After the native move, the destination identity and contents are validated again before `input-valid` can be returned. Deterministic test-only checkpoints cover source-before-open, source-post-read, parent, nested-parent, temporary-root, post-validation content, destination-competitor, post-move content, and cleanup identity swaps. Cleanup performs two identity passes and refuses recursive removal when either pass is uncertain, reporting `cleanupCompleted=false`. These protections are fail-closed path revalidations, not a handle-bound transaction: a final path-reopen window remains after every last check, including the last cleanup check before recursive removal. Publication is not crash-durable, cross-volume, cross-platform, or a transaction against an administrator able to mutate process/runtime state.

The f3b measured closeout boundary reads only a canonical collector output below the ignored `target/` tree (the documented location is `target/wp-0.4/hw-ref/`) and pins the repository collector source by path, version, SHA-256, byte size, and copied material. Its schema `1.1` plan contains exactly 29 materials and 27 sealed entries: 18 copied sources and 11 generated documents. The measured HW document replaces the fixture HW in the run contract, while the run plan joins its `hw_ref_id`, cooling mode, and power plan. Materialization still requires a non-zero `expectedContractSha256` supplied separately from the proposed plan and can return only `input-valid` / `input-only` with `formalClaims=none` and `productionEvidence=false`.

The closeout surface is the programmatic `proposeMeasuredSherpaCandidateInputCloseout` and `materializeMeasuredSherpaCandidateInputCloseout` API. It deliberately does not define a shell CLI or a serialized `Buffer` plan format; the measured-HW collector CLI captures the canonical source document, while trusted application code retains the typed plan and supplies the separately approved contract digest.

The collector digest binds the document's declared collector source identity and format source; it is not cryptographic attestation that the collector ran, nor evidence that a model or benchmark ran. A real f3b closeout still requires the operator to provide all nine observed fields explicitly: ambient temperature, audio device model, audio logical role, cooling mode, GPU device model, GPU VRAM bytes, power source, storage medium, and storage volume. Synthetic CI fixtures test the plumbing only and cannot close the real measured-HW work package or create execution, quality, performance, eligibility, ranking, selection, default, or production authority.

The same validator accepts structurally complete native, sidecar, and fallback candidate-run bundles, measured `HW-REF` records, multiple assets/licenses, and completed raw evidence. Those bundles must be validated with an independently pinned input-contract digest:

```powershell
node tools/phase0-harness/validate-candidate-artifact-contract.mjs --existing <bundle-root> <pinned-contract-sha256> <approved-license-sha256>...
```

The contract digest and every accepted license-text digest must come from an out-of-band approved run plan, legal record, or evidence ledger, not from the bundle being checked. Completed raw evidence still cannot declare a candidate eligible, selected, ranked, default, production-ready, or compliant with a formal `PERF-*`/SLO.

### Collector-only measured HW-REF

WP-0.4.3f1 adds a Windows-native, privacy-whitelisted collector foundation. Before running it, independently measure or verify every operator fact; do not substitute guesses or values copied from a plumbing smoke. The output parent must already exist below this repository's ignored `target/` tree:

```powershell
New-Item -ItemType Directory -Force target/wp-0.4/hw-ref | Out-Null
node tools/phase0-harness/hw-ref-collector.mjs `
  --ambient-celsius "<operator-measured canonical decimal>" `
  --audio-device-model "<exact unique benchmark MEDIA device model>" `
  --audio-logical-role "<operator-verified benchmark role>" `
  --cooling-mode "<operator-observed cooling mode>" `
  --gpu-device-model "<exact unique reference GPU model>" `
  --gpu-vram-bytes "<operator-verified canonical uint64 bytes>" `
  --hw-ref-id "hw-ref-<run-id>" `
  --output "target/wp-0.4/hw-ref/hw-ref.json" `
  --power-source "ac" `
  --storage-medium "ssd" `
  --storage-volume "E"
```

`--storage-volume` is one drive letter without a colon, `--storage-medium` is an operator-verified `ssd|hdd|emmc|other` class, and `--power-source` is exactly `ac` or `battery`. Ambient temperature, cooling mode, audio device/role, reference GPU VRAM, power source, and storage medium are operator-attested capture inputs; do not run the persisted collector until each value has been independently observed or verified. GPU execution-provider capability is deliberately emitted as an empty list and is bound later by the run plan, not inferred by this hardware collector. The selected GPU's VRAM is explicit because `Win32_VideoController.AdapterRAM` is only 32 bits and cannot represent modern dedicated VRAM exactly. Audio and GPU model selections must each match exactly one enumerated device, and the selected storage volume must associate with exactly one physical disk whose linked driver record reports `IsSigned=true`; internal device identifiers are never emitted. The collector assumes a trusted local operator, genuine Windows installation, and genuine `SystemRoot`; it is not an execution proof against a malicious parent process or local administrator.

Only the canonical built-in base aliases `balanced`, `high-performance`, `ultimate-performance`, and `power-saver` are accepted; custom base schemes fail closed. `power.plan` is stored as `<base-alias>@<sha256>`. The digest uses length-framed canonical LF/NFC text from both an explicit base-scheme `powercfg /Q <guid>` query and the effective no-argument `powercfg /Q` query, so overlays and modified built-in settings change the identity without exposing a GUID or friendly name. Active GUID plus both query surfaces are read before/after and any drift aborts capture. The f1 document itself remains unsealed/unjoined; a later slice must bind this exact value into the same-condition run contract.

The runnable collector is one self-contained source file: its streaming SHA-256 covers argument policy, canonical encoding, privacy/semantic validation, embedded PowerShell collection, and the CLI itself. The CLI emits canonical NFC JSON, refuses output outside `target/`, reserves the output with an exclusive `wx` handle before collection, rejects reparse-point ancestors, and never overwrites an existing file. Its stdout summary is `validationPhase=collector-only` and `sealed=false`; those fields are deliberately not inserted into the exact HW-REF schema. The HW-REF document is measured/captured with claims fixed to none, but it remains unsealed and unjoined. This command does not build a candidate-input bundle, execute a candidate or model, create run evidence, or support quality, performance, eligibility, ranking, default, publishability, hardware-recommendation, PERF, SLO, or product claims. A plumbing smoke that uses synthetic operator annotations must not persist a HW-REF document and is not measured evidence.

On a failed write, the collector keeps its reservation handle open while it performs two direct-path and file-identity checks before removing its own partial output. The final identity-check-to-`unlink` interval is still a path-based race window: cleanup is not a handle-bound delete and does not claim safety against any concurrent namespace writer able to replace that path during the interval. If identity or cleanup cannot be established, the command fails without reporting the output as persisted.

The provider harness performs two clean, byte-identical virtual-clock runs under ignored `target/wp-0.3/provider-harness/`. Version 1.0 intentionally accepts only the committed empty fault plan; any non-empty or unknown fault step fails before the first emission. Logical offsets are ordering inputs, not latency observations or performance evidence.

Clock calibration performs two actual `process.hrtime.bigint()` runs under ignored `target/wp-0.3/ct-clock-cal-001/`. Each run has its own `node.hrtime.<run_id>` domain and cannot be subtracted from another run. Runtime artifact byte equality is explicitly not required. `observed_resolution` and `observed_quantization` are descriptive values from this sample only; reference-clock error stays `null` because no independent reference clock exists.

The queue/resource harness writes two runs under ignored `target/wp-0.3/ct-resource-harness-001/`. Its fixed-capacity `Q-HARNESS-COALESCE` scenario uses a logical clock and must produce byte-identical queue artifacts. Mutually exclusive dequeue, drop, merge, cancel, and remaining-depth outcomes conserve every enqueued item; retry and full counters describe attempts only. Only an interim item identified as a `superseded_revision` may use the scripted drop/coalescing path. Actual resource snapshots use one `node.hrtime.<run_id>` domain per run and are validated for canonical encoding, capability/schema projection, observation-clock ordering, and checksums rather than cross-run byte equality. Per-core CPU arrays preserve each snapshot's order but do not claim stable core identity across samples. The harness does not use sleep, wall-clock time, or a network and does not establish production sampling cadence, resource limits, or product queue behavior.

Commit-specific completion requires the `Phase 0 Contract CI` workflow to be green on the pinned `windows-2022` runner. Local success alone is not release evidence. These checks validate the bootstrap/harness boundaries, worker contract, asset lock, minimal sherpa adapter, and one functional inference path. `CT-WORKER-CANDIDATE-001` remains pending: no model accuracy/quality, candidate eligibility/ranking/default selection, approved distribution, formal performance/SLO, production session/audio capture/ASR pipeline, translation, persistence, UI paint, or other product capability is claimed.
