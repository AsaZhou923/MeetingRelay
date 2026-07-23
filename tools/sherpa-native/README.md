# Sherpa native assets

This directory only contains the product asset path for the personal MVP:

- `assets.lock.json` and `assets.lock.sha256` pin the local Sherpa / SenseVoice model, tokens, smoke WAV, runtime archive, and license snapshots.
- `validate-lock.mjs` checks the lock shape, file hashes, license snapshots, and pinned Cargo lock hash.
- `materialize.ps1` downloads or validates the locked assets under `target/sherpa-native`.
- `stage-runtime.ps1` stages the locked runtime DLLs for local development and personal release builds.
- `licenses/` contains the license snapshots referenced by the lock.

Archived candidate evaluation, formal evidence, attestation, quality corpus, PE audit, and runner scheduling tools are not part of the personal MVP main branch. They are preserved in `archive/full-repository-before-mvp-trim-2026-07-23`.
