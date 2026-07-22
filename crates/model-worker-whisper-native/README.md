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
