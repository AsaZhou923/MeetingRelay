# MeetingRelay

MeetingRelay is currently closing **MVP-FT-003 local durable transcript, restart recovery, strong-kill recovery, and JSON/Markdown/TXT export**. MVP-FT-001 and MVP-FT-002 are Done/Passed. MVP-FT-003 is implemented and has passed the local acceptance surface, including Release Tauri target-machine smoke. This README does not independently serve as remote Done evidence; use the external project task list for the exact source SHA and remote CI record.

The current MVP durable contract is `meetingrelay.mvp.durable.v1`. SQLite/WAL is the only transaction truth for saved meetings; interim text remains memory-only; final transcript segments appear as saved only after the storage commit is acknowledged. The desktop app can reopen the latest meeting after normal restart, recover already committed final segments exactly once after process kill, and export JSON, Markdown, and TXT from one consistent snapshot.

This status is intentionally scoped. It does not close the full V1 storage/API migration, WP-1.1, WP-1.4, WP-1.7, Phase 1 formal gates, raw-audio persistence, pause/resume, backup/corruption reconstruction, live export, translation, speaker attribution, summary, search, full meeting library, retention/delete, DOCX/PDF, or formal long-duration performance gates.

## Current MVP evidence

- FT001/FT002: Done/Passed in the project task list.
- FT003 local Rust gate: `230 passed / 1 ignored`.
- FT003 frontend gate: `12 passed`.
- Release Tauri smoke: verified loopback + microphone capture, normal restart, strong-kill recovery with exact-once committed finals, reopen recent meeting, and actual JSON/Markdown/TXT file open.
- Exact source SHA and remote CI evidence are recorded in the external project task list.

## Prerequisites

- Windows x64
- Rust 1.95 with the Windows MSVC target
- Node.js 24
- pnpm 9.15.9
- Microsoft C++ Build Tools with a compatible Windows SDK
- Microsoft Edge WebView2 Runtime

Use a Developer PowerShell or another shell where the MSVC toolchain is available.

## Workspace commands

Run from the repository root unless a command says otherwise.

```powershell
pnpm install --frozen-lockfile
pnpm desktop:typecheck
pnpm desktop:build
pnpm --dir apps/desktop test
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features --locked -- -D warnings
cargo check --workspace --all-targets --all-features --locked
cargo test --workspace --all-targets --all-features --locked
pnpm --dir apps/desktop run tauri:build:ci
powershell -ExecutionPolicy Bypass -File tools/mvp/start.ps1 -DryRun
```

Use the MVP launcher for local smoke runs with cached, lock-verified Sherpa assets:

```powershell
powershell -ExecutionPolicy Bypass -File tools/mvp/start.ps1
```

The desktop commands delegate to `apps/desktop`. The MVP launcher verifies the existing Sherpa lock, materializes sealed assets, stages locked runtime DLLs, builds/checks the frontend, and runs Tauri in development mode. Downloads are disabled by default; use `-AllowDownload` only when intentionally acquiring missing locked archives or pnpm store content.

## Verification

For MVP-FT-003, the acceptance surface is:

```powershell
pnpm install --frozen-lockfile
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features --locked -- -D warnings
cargo check --workspace --all-targets --all-features --locked
cargo test --workspace --all-targets --all-features --locked
pnpm --dir apps/desktop test
pnpm desktop:typecheck
pnpm desktop:build
pnpm --dir apps/desktop run tauri:build:ci
powershell -ExecutionPolicy Bypass -File tools/mvp/start.ps1 -DryRun
```

Then run the Release app on the target Windows machine and verify:

- consent is required before capture;
- system loopback and microphone both produce frames;
- committed final segments are visible only after SQLite/WAL commit acknowledgment;
- normal restart can reopen the latest meeting;
- force-kill after a saved final recovers the committed final exactly once;
- JSON, Markdown, and TXT exports open as real UTF-8/LF files and contain the same meeting/snapshot/final order.

Run the historical Phase 0 verification surface when changing candidate-model, materializer, contract, ledger, or provenance code:

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
pnpm phase0:sherpa-candidate-conformance:test
pnpm phase0:ledgers:test
pnpm phase0:ledgers:validate
pnpm phase0:provider:test
pnpm phase0:provider:validate
pnpm phase0:clock:test
pnpm phase0:clock:validate
pnpm phase0:resources:test
pnpm phase0:resources:validate
pnpm phase0:funasr-sidecar-preflight:test
pnpm phase0:funasr-sidecar-preflight:validate
pnpm phase0:funasr-sidecar-python-launch:test
pnpm phase0:funasr-sidecar-python-launch:validate
pnpm phase0:funasr-sidecar-venv-materialization:test
pnpm phase0:funasr-sidecar-venv-materialization:validate
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
pnpm --dir apps/desktop run tauri:build:ci
```

Native-feature checks and the ignored real SenseVoice smoke require the sealed assets and pinned DLLs to be materialized and staged first. Follow [the sherpa asset instructions](tools/sherpa-native/README.md) and [the adapter smoke instructions](crates/model-worker-sherpa-native/README.md). The upstream build script's implicit network-download path is not an accepted project workflow.

IPC and ledger uint64/ns values use canonical unsigned decimal strings. The ledger validator runs two clean replays: `input-ledger.jsonl` and `decision-ledger.jsonl` must be byte-for-byte and SHA-256 identical; `observation-ledger.jsonl` intentionally preserves distinct run IDs and actual monotonic observations, so it is checked for canonical encoding, order, causation, source hashes, and join integrity instead of byte equality. Generated evidence stays under ignored `target/wp-0.3/ct-ledger-001/`.

The WP-0.4.2 artifact validator generates an ignored bundle under `target/wp-0.4/ct-candidate-artifact-001/`. A sealed input manifest hashes the candidate, fixture-set, `HW-REF`, run-plan, core/UI harness, release command, VAD/endpoint configuration, distinct warmup plan, contract assets, and license snapshot; a separately sealed evidence manifest references the input contract digest without creating a hash cycle. Validation rejects non-canonical JSON, unsafe or reparse-point paths, missing/zero/mismatched hashes, unresolved licenses, broken joins, private hardware identifiers, invalid cold/warm/soak bounds, inventory changes, and claims of eligibility, selection, production paint, SLO, or formal product performance. The JSON worker manifest is an artifact projection of the Rust `WorkerManifest`/`EngineDescriptor`; a regression test compares its exact field names with the Rust source, while Rust remains the only source of worker handshake and runtime semantics.

Historical contract-fixture candidate manifests remain schema `1.0`. Candidate-input manifests use schema `1.1`, and every license record preserves both its review scope and upstream review-source status. Internal-evaluation review accepts only `accepted-for-internal-evaluation` or conservative `unlicensed` source states and cannot authorize accepted distribution; the generic distribution scope uses the normalized `pending|accepted|rejected` review states and retains the independent approved-license digest gate. The descriptor's `model_license_id` binds the model artifact only: the project-generated aggregate model manifest may use another resolved license record, while every artifact still requires a unique role/path/ID and a sealed digest/license join. These fields record review inputs; they do not create license text or grant redistribution rights.

Release `meetingrelay-sherpa-candidate-host.exe` provenance reports the executable digest and its canonical decimal `executableSizeBytes` from the already collected file metadata; the CLI renders the same value as `executable_size_bytes`. That binary remains provenance-only and must not import the sherpa runtime.

The separate Release `meetingrelay-sherpa-candidate-execution-host.exe` is the executable material used by candidate-input plans. The Node conformance runner preflights the locked executable, schema, model, tokens, source runtime inventory, all four runtime DLLs staged beside the executable, asset lock, package lock, and WAV; launches the host with a bounded timeout/output and a `PATH` restricted to the executable directory plus System32; validates its canonical record against independently recomputed executable/schema digests; and repeats the input and staged-DLL checks after exit. The host and CI probe independently bind the actually loaded sherpa/ONNX module paths and hashes to those locked executable-directory files. Inside the host, the native candidate still negotiates `InProcess` through `DirectWorkerSession`; the outer child process only contains and supervises crashes and is not model-worker IPC or a sidecar. The record proves one real locked inference plus the enumerated lifecycle, flow-control, stable-failure, loaded-runtime identity, and Rust-panic checks, while fixing `formal_claims=none`, `production_evidence=false`, and resource/performance/quality as unmeasured. It contains only a transcript digest and byte count, not transcript text, paths, timings, run IDs, ranking, selection, default, publishability, or production conclusions. Native access violations and process abort isolation remain untested.

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

### FunASR sidecar wire foundation

WP-0.4.4a defines only the mock FunASR sidecar wire/fault foundation. It does not run Python, FunASR, a downloaded model, real audio, a network service, quality thresholds, ranking, default selection, publication, heartbeat/progress, restart scheduling, source/build attestation, Job Object containment, or grandchild-process containment.

The binary frame format is `MRSW` magic bytes, version `1`, a 13-byte prelude, a big-endian `u32` canonical JSON header length, and a big-endian `u32` payload length. Headers are UTF-8 canonical JSON lines ending in exactly one LF; BOM, CR, NUL, non-UTF-8, empty headers, headers over 65,536 bytes, and payloads over 1,048,576 bytes are rejected. The Rust foundation in `crates/model-worker-contract/src/sidecar_wire.rs` preserves the same byte framing and stable `SIDECAR_WIRE_*` error codes for future native transports.

The mock state sequence is fixed at five request/response pairs:

1. `hello` -> `hello_ok`
2. `prepare` -> `prepared`
3. `audio` -> `audio_ok`
4. `flush` -> `flushed`
5. `shutdown` -> `shutdown_ok`

The wire transcript digest uses the domain-separated preimage `meetingrelay.sidecar-wire.transcript.v1\n` once, then the ordered full encoded frames prefixed by `H` for core-to-worker frames and `W` for worker-to-core frames. The public evidence authority is intentionally narrow: `kind=meetingrelay-funasr-sidecar-wire-foundation-v1`, `measurement_status=wire-fault-foundation-only`, `execution_status=mock-sidecar-only`, `quality_gate_status=not-assessed`, `formal_claims=none`, `production_evidence=false`, and `public_distribution=false`. The supervisor records only direct child process close under bounded cleanup.

Run the foundation checks from the repository root:

```powershell
pnpm phase0:funasr-sidecar-wire:test
pnpm phase0:funasr-sidecar-wire:validate
```

### FunASR sidecar candidate preflight

WP-0.4.4b adds only a sidecar-candidate byte-identity preflight. It consumes a caller-supplied canonical JSON manifest and exactly one file for each role under one absolute local controlled root: `runtime`, `package-lock`, `model`, `model-manifest`, `parameters`, `sidecar-source`, and `license`. The validator rejects unsafe or non-NFC relative paths, duplicate or unordered roles, duplicate logical IDs, case-insensitive duplicate paths, empty files, files over 8 GiB, total expected input over 16 GiB, digest or size drift, symlinks/junctions/special files where Node can observe them, noncanonical JSON, unknown fields, and authority overclaims. Candidate files are hashed by streaming from already-open handles with fixed-size chunks; the bounded manifest file is read only after regular-file and identity checks.

The public evidence is intentionally path-free and text-free. It binds the schema-file SHA-256, validator-source SHA-256, canonical input-manifest SHA-256, per-role file SHA-256/size, and a deterministic candidate descriptor/aggregate digest. Its authority is fixed to `measurement_status=identity-preflight-only`, `execution_status=not-executed`, `quality_gate_status=not-assessed`, `formal_claims=none`, `production_evidence=false`, `public_distribution=false`, and `selection_authority=none`. Runtime packaging remains opaque and unselected; license bytes are not distribution approval.

Run the offline synthetic checks from the repository root:

```powershell
pnpm phase0:funasr-sidecar-preflight:test
pnpm phase0:funasr-sidecar-preflight:validate
```

To preflight real caller-provided bytes without executing them:

```powershell
node tools/funasr-sidecar/sidecar-candidate-preflight.mjs --preflight <controlled-root> <canonical-input-manifest.json>
```

This command does not launch Python, import FunASR, load a model, process audio, access the network, download files, select a package form, rank candidates, mark a default, or grant public distribution authority.

### FunASR sidecar Python-compatible launch probe

WP-0.4.4c adds only a real process launch probe for the runtime file already bound by the WP-0.4.4b canonical manifest. The production CLI is:

```powershell
node tools/funasr-sidecar/sidecar-python-launch.mjs --launch `
  <controlled-root> `
  <canonical-4b-input-manifest.json> `
  <absolute-python-executable> `
  <expected-candidate-aggregate-sha256>
```

The launcher re-runs `preflightCandidate`, requires the expected candidate aggregate to match exactly, re-reads the canonical manifest and checks its SHA-256 against the preflight evidence, locates the exact `runtime` relative path, and requires the explicit absolute executable to resolve to that file. It records runtime logical ID hash, size, and hash before and after launch; validates the controlled-root identity before and after launch; rejects unsafe paths, symlinks, junctions, and special files where observable; and starts the direct child with `shell=false`, `windowsHide=true`, `detached=false`, cwd set to the controlled root, minimal environment, bounded stdin/stdout/stderr, timeout, and bounded direct-child cleanup.

The only child arguments are the fixed Python-compatible probe contract: `-I -S -B -c <fixed probe source>`. The fixed source imports only Python stdlib `sys`, `struct`, and `json`, reads exactly one MRSW `hello` request, and emits exactly one canonical `hello_ok` response. This proves only that the caller-provided 4b-bound executable accepted the fixed Python isolation flags and completed the hello probe. A compatible executable can emulate that CLI, so the evidence does not prove CPython provenance, loaded-image identity, base DLLs, stdlib, site-packages, runtime packaging closure, materialization closure, or product distribution suitability.

Public evidence is path-free and text-free and fixes `measurement_status=python-launch-probe-only`, `execution_status=interpreter-launched-no-funasr`, `quality_gate_status=not-assessed`, `formal_claims=none`, `production_evidence=false`, `public_distribution=false`, `selection_authority=none`, and `packaging_authority=none`. It binds the schema SHA-256, launcher source SHA-256, 4b schema/source/evidence SHA-256, candidate aggregate, runtime role identity, fixed probe SHA-256, imported wire foundation source SHA-256, one-frame transcript SHA-256, fixed-argument/process contract, and direct-child close.

The independent validator creates a temporary venv under the controlled root only as a fixture and prints a strict evidence marker:

```powershell
node tools/funasr-sidecar/sidecar-python-launch.mjs --run-synthetic
```

The venv fixture exists so Windows CI performs an actual positive Python-compatible process launch without a skip. It is test-fixture-only and is not a product packaging choice. Fault coverage uses deterministic injected child processes and does not broaden the production CLI. Pending work remains: FunASR import, model load, audio processing, network access, download, heartbeat/progress/restart, Job Object or grandchild containment, quality/performance/ranking/selection/default/distribution authority, parent closeout, and Phase 1 completion.

### FunASR sidecar source attestation

WP-0.4.4d adds only source-attestation evidence for the `sidecar-source` file already bound by the WP-0.4.4b canonical manifest. The production CLI is:

```powershell
node tools/funasr-sidecar/sidecar-source-attestation.mjs --attest `
  <controlled-root> `
  <canonical-4b-input-manifest.json> `
  <absolute-python-executable> `
  <expected-candidate-aggregate-sha256>
```

The attestor re-runs the 4b preflight and exact aggregate check, binds the manifest `sidecar-source` size/hash to the fixed MeetingRelay reference file bytes read by the validator from `tools/funasr-sidecar/python/meetingrelay_funasr_sidecar.py`, enforces a strict source envelope, and sends only bounded candidate bytes to a fixed isolated auditor. The auditor runs as `-I -S -B -c <fixed auditor>`, parses with `ast.parse`, compiles with `compile`, and does not import, execute, eval, py_compile, compileall, runpy, importlib-load, or otherwise run the candidate source.

Public evidence fixes `measurement_status=source-attestation-only`, `execution_status=source-parse-compile-only-no-import`, `source_binding_scope=fixed-file-byte-match-only`, `git_provenance_authority=none`, `cpython_provenance_authority=none`, `packaging_authority=none`, `quality_gate_status=not-assessed`, `formal_claims=none`, `production_evidence=false`, `public_distribution=false`, and `selection_authority=none`. It is path-free and text-free, and binds only digests/sizes for the attestor, schema, shared boundary, fixed auditor, fixed reference source, 4b evidence, candidate aggregate, runtime identity, and stable parse/compile counts.

The independent validator creates a temporary venv under the controlled root only as a fixture and prints a strict evidence marker:

```powershell
node tools/funasr-sidecar/sidecar-source-attestation.mjs --run-synthetic
```

This is fixed-file-byte-match-only evidence, not Git provenance, CPython provenance, packaging authority, quality assessment, production evidence, or public distribution approval.

### FunASR sidecar package-lock attestation

WP-0.4.4e interprets the `package-lock` bytes already bound by the WP-0.4.4b candidate aggregate and verifies the byte identity of every referenced wheel under the same controlled root. The production CLI is:

```powershell
node tools/funasr-sidecar/sidecar-package-lock-attestation.mjs --attest `
  <controlled-root> `
  <canonical-4b-input-manifest.json> `
  <expected-candidate-aggregate-sha256>
```

The lock is strict canonical UTF-8/NFC/LF JSON and fixes Windows AMD64 CPython 3.12 targeting, exact root pins, a closed dependency graph, wheel-only/offline materialization policy, resolver and expected-environment declarations, and bounded artifact identities. Referenced wheels are opened without following symlinks or junctions, rejected when hard-linked, and hashed with bounded streaming plus root/file postflight checks. Wheel filename distribution/version/tags must match the lock and be compatible with `cp312`/`win_amd64` or a universal Python 3 wheel. Declared audit origins are limited to the official PyPI artifact host and, for wheels, the official PyTorch artifact host; these URLs are provenance declarations, not network retrieval instructions.

Public evidence fixes `measurement_status=package-lock-attestation-only`, `execution_status=lock-contract-and-wheel-byte-identity-only-no-install-no-import`, `packaging_authority=lock-contract-only`, and `source_build_authority=environment_materialization_authority=cpython_provenance_authority=package_metadata_authority=license_authority=import_authority=none`. It is path-free and text-free. METADATA, RECORD, license, import-map, resolver-report, expected-environment-report, source-archive, and build-attestation hashes remain declarations whose target bytes are not opened by this slice.

The independent validator uses synthetic files only to exercise the contract and prints a strict evidence marker:

```powershell
node tools/funasr-sidecar/sidecar-package-lock-attestation.mjs --run-synthetic
```

Synthetic fixture bytes do not prove valid wheel structure, an installed environment, CPython provenance, FunASR import/model/audio/network execution, source-build provenance, package approval, quality, selection, production readiness, or distribution authority.

### FunASR sidecar venv materialization attestation

WP-0.4.4f starts from the WP-0.4.4b-bound runtime and WP-0.4.4e-bound package-lock/wheelhouse. The production CLI is:

```powershell
node tools/funasr-sidecar/sidecar-venv-materialization-attestation.mjs --attest `
  <controlled-root> `
  <canonical-4b-input-manifest.json> `
  <absolute-venv-python> `
  <expected-candidate-aggregate-sha256>
```

The caller-supplied venv Python must be the exact `runtime` role path already bound by the 4b manifest, with matching bytes and stable file identity before and after materialization. It must self-report CPython 3.12 on 64-bit Windows AMD64 with the `win-amd64` platform, but this slice does not create the interpreter or prove its origin, signature, or CPython provenance. It installs the locked wheelhouse into that existing venv using pip with `--no-index`, `--find-links`, `--only-binary :all:`, `--no-deps`, `--require-hashes`, `--isolated`, `--require-virtualenv`, `--no-compile`, controlled cwd, and root-local temp directories. The attestor verifies bootstrap-only pre-state, resolver pip version against the lock declaration, `pip check`, a canonical path-free `pip inspect` projection against the lock's expected environment report declaration, the installed distribution set, installed `METADATA`, installed `RECORD`, and RECORD-listed file hashes/sizes/path boundaries. RECORD entries outside `site-packages`, including console-script or alternate data-scheme paths, fail closed in this scoped slice and require a later allowlisted extension before real target closure.

Public evidence fixes `measurement_status=controlled-wheelhouse-and-venv-materialized-only`, `execution_status=offline-install-pip-check-inspect-no-funasr-import`, `packaging_authority=controlled-wheelhouse-and-offline-venv-only`, `environment_materialization_authority=offline-venv-materialized`, and `package_metadata_authority=installed-dist-info-record-verified-only`. It keeps `source_build_authority=license_authority=cpython_provenance_authority=import_authority=none`, `quality_gate_status=not-assessed`, `formal_claims=none`, `production_evidence=false`, `public_distribution=false`, and `selection_authority=none`. The evidence is path-free and text-free.

The independent validator creates a synthetic 4b-bound venv fixture and 77 tiny valid wheels only to exercise the offline materialization mechanism:

```powershell
node tools/funasr-sidecar/sidecar-venv-materialization-attestation.mjs --run-synthetic
```

Those CI wheels contain no real FunASR/PyTorch code and do not prove an actual FunASR environment, package quality, import behavior, model load, audio processing, OS-level network isolation, source-build replay, license approval, production readiness, selection, default status, or distribution authority.

### FunASR sidecar artifact-pack attestation

WP-0.4.4g starts from the WP-0.4.4b candidate aggregate and WP-0.4.4e package-lock/wheel byte identity, then verifies a private canonical artifact-pack manifest under the same controlled root. The production CLI is:

```powershell
node tools/funasr-sidecar/sidecar-artifact-pack-attestation.mjs --attest `
  <controlled-root> `
  <canonical-4b-input-manifest.json> `
  <canonical-artifact-pack-manifest.json> `
  <expected-candidate-aggregate-sha256>
```

The artifact-pack manifest binds target bytes for 77 license file sets, five source archives, five canonical build-record JSON files, a resolver report, an expected-environment projection, and a top-level import map for the fixed Windows AMD64 CPython 3.12 `cp312/win_amd64` CPU-baseline contract. Every referenced artifact must be a regular non-symlink, non-hardlink file inside the controlled root, with unique case-insensitive paths, stable identity before/after hashing, and exact size/SHA-256 matches against package-lock declarations. Build records must internally bind the locked source archive, wheel hash, package identity, and target, but builds are not replayed.

Public evidence fixes `measurement_status=artifact-pack-target-byte-attestation-only`, `execution_status=artifact-target-bytes-verified-no-install-no-import`, `packaging_authority=artifact-pack-byte-identity-only`, `source_build_authority=source-archive-and-build-record-target-bytes-bound-only`, `license_authority=license-set-target-bytes-verified-not-legal-approval`, `resolver_report_authority=target-record-bytes-bound-only`, `environment_report_authority=expected-projection-target-bytes-bound-only`, and `import_map_authority=target-bytes-bound-no-import`. It keeps `package_metadata_authority=environment_materialization_authority=cpython_provenance_authority=import_authority=none`, `quality_gate_status=not-assessed`, `formal_claims=none`, `production_evidence=false`, `public_distribution=false`, and `selection_authority=none`.

The independent validator creates a synthetic artifact-pack fixture without venv installation:

```powershell
node tools/funasr-sidecar/sidecar-artifact-pack-attestation.mjs --run-synthetic
```

Those fixture bytes exercise artifact-pack binding only. They do not prove real FunASR/PyTorch source provenance, build replay, legal license approval, CPython provenance, installed metadata, environment materialization, FunASR import, model load, audio processing, quality/performance, production readiness, selection, default status, or distribution authority.

### FunASR sidecar install-scheme RECORD attestation

WP-0.4.4h starts from the WP-0.4.4g artifact-pack byte closure and a caller-supplied existing venv, then verifies direct wheel-spread installed RECORD entries and allowlisted install-scheme files under the bound runtime scheme. The production CLI is:

```powershell
node tools/funasr-sidecar/sidecar-install-scheme-record-attestation.mjs --attest `
  <controlled-root> `
  <canonical-4b-input-manifest.json> `
  <canonical-artifact-pack-manifest.json> `
  <absolute-venv-python> `
  <expected-candidate-aggregate-sha256>
```

This slice is intentionally a synthetic direct wheel-spread contract for RECORD closure. It may exercise purelib/platlib deduplication plus constrained `scripts` and `data` scheme records, but it does not grant authority for generated launchers, real artifact-pack contents, real package approval, FunASR import, model load, audio processing, network isolation, source-build replay, legal approval, quality, selection, default status, production readiness, or public distribution.

Public evidence fixes `measurement_status=controlled-wheelhouse-install-scheme-record-closure-only`, `execution_status=offline-install-pip-check-inspect-record-closure-no-funasr-import`, `packaging_authority=artifact-pack-and-install-scheme-byte-closure-only`, `package_metadata_authority=installed-dist-info-record-and-allowlisted-scheme-files-verified-only`, `environment_materialization_authority=offline-venv-materialized`, and `install_scheme_authority=bound-runtime-sysconfig-observed-only`. It preserves the WP-0.4.4g target-byte authority strings for source, license, resolver report, expected environment report, and import map, and keeps `cpython_provenance_authority=import_authority=none`, `quality_gate_status=not-assessed`, `formal_claims=none`, `production_evidence=false`, `public_distribution=false`, and `selection_authority=none`. The public evidence is path-free and text-free.

The independent validator creates a synthetic direct wheel-spread fixture only:

```powershell
node tools/funasr-sidecar/sidecar-install-scheme-record-attestation.mjs --run-synthetic
```

Those fixture bytes exercise install-scheme RECORD path resolution and hash/size closure only. They do not prove generated launcher behavior, a real artifact pack, a real FunASR environment, import behavior, model load, audio processing, OS-level network isolation, source-build replay, legal approval, package quality, product readiness, selection, default status, or distribution authority.

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
