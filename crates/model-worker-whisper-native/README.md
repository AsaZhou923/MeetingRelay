# MeetingRelay WP-0.4.5a whisper-rs native link smoke

This crate is the narrow, independently verifiable first child of `WP-0.4.5`.
It proves only that the pinned Rust binding can compile, link the vendored
whisper.cpp source, and query its runtime version in an offline Cargo build.

The default feature set is empty and has an explicit test proving the native
link remains disabled. With `native-whisper`, the crate links `whisper-rs`
`0.16.0` / locked `whisper-rs-sys` `0.15.0` and calls
`get_whisper_version()`. A native build requires CMake, libclang (for
target-platform binding generation), and an MSVC C/C++ toolchain. CI resolves
and records those tools before entering Cargo's offline build phase.

The locked crate metadata declares `whisper-rs` and `whisper-rs-sys` under the
Unlicense, while the bundled whisper.cpp source carries MIT terms. This slice
does not include model weights and does not grant model-license or distribution
approval; those remain separate Phase 0 gates.

Run the two contracts with:

```powershell
cargo test -p meetingrelay-model-worker-whisper-native --no-default-features --offline --locked -- --nocapture
cargo test -p meetingrelay-model-worker-whisper-native --no-default-features --features native-whisper --offline --locked -- --nocapture
```

Authority ceiling:

- `measurement_status=whisper-native-link-smoke-only`
- `execution_status=binding-version-query-only-no-model-no-transcription`
- `formal_claims=none`
- `production_evidence=false`
- `selection_authority=none`

This child does not load a model, accept audio, transcribe, implement the
model-worker contract, measure quality, package model assets, or select a
fallback. Those remain pending in the parent `WP-0.4.5` and later children.

## WP-0.4.5b identity preflight

The repository also contains a separate Node stdlib-only fallback-candidate
identity preflight at `tools/whisper-native`. That slice hashes only
caller-provided bytes for `adapter-source`, `license`, `model`,
`model-manifest`, `package-lock`, `parameters`, and `runtime`.

Run it with:

```powershell
pnpm phase0:whisper-candidate-preflight:test
pnpm phase0:whisper-candidate-preflight:validate
```

Its authority ceiling is
`measurement_status=whisper-fallback-identity-preflight-only`,
`execution_status=not-executed-no-model-no-transcription`,
`quality_gate_status=not-assessed`, `formal_claims=none`,
`production_evidence=false`, `public_distribution=false`,
`selection_authority=none`, and `fallback_authority=none`. It does not launch
a runtime, load a model, accept audio, transcribe, measure quality, select or
rank a fallback, mark a default, or approve distribution/legal use.

## WP-0.4.5c runtime version probe

The crate now also exposes the default-off native binary
`meetingrelay-whisper-runtime-version-probe`, gated by `native-whisper`. It
accepts only `--meetingrelay-whisper-runtime-version-probe-v1`, calls
`linked_whisper_cpp_version()`, and prints one bounded marker for the Node
attestor in `tools/whisper-native/whisper-fallback-runtime-version-probe.mjs`.

Build and run the native probe only on a host with CMake, libclang, and MSVC:

```powershell
cargo build -p meetingrelay-model-worker-whisper-native --bin meetingrelay-whisper-runtime-version-probe --no-default-features --features native-whisper --offline --locked
target\debug\meetingrelay-whisper-runtime-version-probe.exe --meetingrelay-whisper-runtime-version-probe-v1
```

Its authority ceiling is
`measurement_status=whisper-runtime-version-marker-path-observation-only`,
`execution_status=runtime-path-launched-fixed-version-marker-observed-no-model-no-transcription`,
`launch_binding_status=preflight-prespawn-postflight-path-identity-observed-spawn-reopen-window-not-eliminated`,
`loaded_image_attestation=false`, `network_isolation_authority=none`,
`quality_gate_status=not-assessed`, `formal_claims=none`,
`production_evidence=false`, `public_distribution=false`,
`selection_authority=none`, and `fallback_authority=none`. It still does not
load a model, accept audio, transcribe, implement `ModelBackend`, measure
quality/performance, select/rank/default a fallback, or approve distribution.
The Node supervisor performs preflight, immediate pre-spawn, and postflight
path/file-identity checks, but its path-based `spawn` cannot eliminate the final
reopen window or attest the loaded image.

## WP-0.4.5d build-output runtime identity attestation

The repository also contains a CI-only Node attestor for the crate's dedicated
runtime probe binary:
`tools/whisper-native/whisper-fallback-ci-build-output-runtime-identity-attestation.mjs`.
Its real Windows CI mode performs one isolated Cargo release build at the exact
expected clean HEAD, selects the single Cargo JSON compiler-artifact executable
for `meetingrelay-whisper-runtime-version-probe`, hashes that build output,
places the same bytes into the WP-0.4.5b `runtime` role, and reuses the
WP-0.4.5c fixed-marker probe. The accepted join requires the 5c runtime SHA-256
to equal the selected build executable SHA-256.

The local unit harness is synthetic and does not require a native build:

```powershell
pnpm phase0:whisper-ci-build-output-runtime-identity:test
pnpm phase0:whisper-ci-build-output-runtime-identity:validate
```

Synthetic evidence carries `observation_scope=synthetic-injected-harness`; the
real Windows CI path carries
`observation_scope=windows-ci-clean-exact-head-build-output`.

This 5d surface is build-output runtime identity attestation only:
`measurement_status=whisper-ci-build-output-runtime-identity-attestation-only`,
`execution_status=ci-built-runtime-path-launched-fixed-version-marker-observed-no-model-no-transcription`,
`build_output_identity_attestation=true`,
`source_build_provenance_authority=none`,
`registry_source_byte_closure=false`,
`toolchain_provenance_authority=observed-tool-bytes-only`,
`loaded_image_attestation=false`, and
`network_isolation_authority=none`. It is not source-build provenance or
reproducible-build proof and grants no model/license selection or approval,
model load, audio, transcription, `ModelBackend`, quality/performance/resource,
fallback/ranking/default, legal/distribution, parent `WP-0.4.5`,
`CT-WORKER-CANDIDATE-001`, or Phase 1 authority.
