# sherpa-onnx offline asset lock

This directory is the executable asset boundary for `WP-0.4.3b`. It pins the official sherpa-onnx Rust/native runtime and the SenseVoice INT8 evaluation model without committing binaries or model weights.

The default materializer path is offline. Network access is possible only with the explicit `-AllowDownload` switch. That explicit path requires and verifies Windows' `System32\curl.exe` instead of resolving a PATH candidate, disables curlrc loading before every other option, restricts redirects and transfers to HTTPS, retries transient connection failures, and still checks every archive for its exact byte length and SHA-256 before extraction. Archive listing and extraction likewise use the verified `System32\tar.exe`, never a PATH-selected Git/MSYS tool. Before extraction, verbose `tar` metadata must identify every entry as a regular file or directory; links, special entries, unsafe paths, duplicates, and files outside the sealed inventory fail closed. Existing symlinks, junctions, or other reparse points anywhere in a cache, source, temporary, extraction, or destination path chain are rejected before mutation and checked again afterward. The extracted file and directory set is then checked against the complete inventory; extra, missing, or modified entries fail closed.

```powershell
pnpm phase0:sherpa-assets:test
pnpm phase0:sherpa-assets:validate

# Reuse pre-provisioned archives without network access.
./tools/sherpa-native/materialize.ps1 `
  -CacheRoot target/sherpa-native `
  -ArchiveSourceRoot target/wp-0.4.3b/upstream

# Explicit acquisition path used by a clean CI runner.
./tools/sherpa-native/materialize.ps1 `
  -CacheRoot target/sherpa-native `
  -AllowDownload
```

On Windows, native DLL resolution must not depend on a machine-wide ONNX Runtime. Before running native test binaries, stage the four sealed DLLs beside the Debug/Release executables and their `deps` directories:

```powershell
./tools/sherpa-native/stage-runtime.ps1 `
  -LibDir target/sherpa-native/extracted/sherpa-onnx-v1.13.4-win-x64-shared-MT-Release-lib/lib `
  -Configuration All
```

`stage-runtime.ps1` accepts only the exact seven-file locked library directory, rejects every destination that equals, contains, or sits below that source directory before mutation, re-hashes the source immediately before every copy, and atomically replaces only ordinary non-reparse destination files. `-DestinationRoot <target-subdirectory>` stages into a controlled executable directory for smoke tests. Run `path-hardening.test.ps1` after materialization to exercise source and destination junction rejection plus hard-link archive rejection.

Cargo's target-specific `links = "sherpa-onnx"` override in `.cargo/config.toml` suppresses the upstream `sherpa-onnx-sys` convenience build script and its implicit downloader. The project build script verifies all seven runtime files, copies them into its current `OUT_DIR`, verifies that sealed copy again, and links/stages only from that immutable-per-build location. After `cargo fetch --locked`, native checks must use both `CARGO_NET_OFFLINE=true` and `--offline`.

The runtime inventory's canonical compact JSON digest is `0682618f660a2a9f2278d99decb77624253aadde60e8199a9b07813b8d843317`. The complete parameter material is also locked, not inferred from sherpa defaults:

```json
{"blank_penalty":0,"bpe_vocab":null,"channels":1,"debug":false,"decoding_method":"greedy_search","feature_dim":80,"homophone_lexicon":null,"homophone_rule_fsts":null,"hotwords_file":null,"hotwords_score":0,"language":"zh","lm_model":null,"lm_scale":1,"max_active_paths":4,"max_input_bytes":67108864,"model_family":"sense_voice","model_type":null,"modeling_unit":null,"num_threads":1,"provider":"cpu","rule_fars":null,"rule_fsts":null,"sample_rate_hz":16000,"telespeech_ctc":null,"use_itn":true}
```

Its SHA-256 is `0ac8669e387262648fcf05fd301a9ba798bb2822e56ec952f1e17d6c692f802e`. `audit-pe-dependencies.ps1` verifies the exact import sets of the four runtime DLLs with `dumpbin`, confines smoke imports to locked runtime or explicit Windows system allowlists, and rechecks the staged DLL identities.

The sealed current SenseVoice license identity is `LicenseRef-FunASR-Model-1.1-Internal-Evaluation`. Legal/Product review is accepted only for internal evaluation; distribution status remains `pending`. This lock authorizes internal Phase 0 functional evaluation only. It does not authorize model redistribution or any quality/performance claim.
