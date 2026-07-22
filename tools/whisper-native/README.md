# WP-0.4.5b whisper fallback candidate preflight

This tool is an identity preflight only. It consumes caller-supplied bytes under
one absolute local controlled root and emits path-free, text-free public
evidence for exactly seven roles:

- `adapter-source`
- `license`
- `model`
- `model-manifest`
- `package-lock`
- `parameters`
- `runtime`

The roles are byte identity only. The validator does not launch the runtime,
load a model, accept audio, transcribe, rank candidates, choose a default, or
grant model-license/public-distribution approval.

Run the synthetic contract:

```powershell
pnpm phase0:whisper-candidate-preflight:test
pnpm phase0:whisper-candidate-preflight:validate
```

Preflight caller-provided bytes:

```powershell
node tools/whisper-native/whisper-fallback-candidate-preflight.mjs --preflight `
  <absolute-controlled-root> `
  <canonical-input-manifest.json>
```

Authority ceiling:

- `measurement_status=whisper-fallback-identity-preflight-only`
- `execution_status=not-executed-no-model-no-transcription`
- `quality_gate_status=not-assessed`
- `formal_claims=none`
- `production_evidence=false`
- `public_distribution=false`
- `selection_authority=none`
- `fallback_authority=none`

Parent `WP-0.4.5`, fallback selection, model loading, transcription,
quality/performance evaluation, ranking/default choice, distribution, and legal
approval remain pending.

## WP-0.4.5c whisper fallback runtime version probe

This tool observes the WP-0.4.5b `runtime` role path identity around a bounded
direct path-based launch of the dedicated native probe binary
`meetingrelay-whisper-runtime-version-probe`. The binary accepts only the fixed
argument `--meetingrelay-whisper-runtime-version-probe-v1` and prints exactly
one bounded version-query marker from the already linked whisper.cpp API.

Run the synthetic harness:

```powershell
pnpm phase0:whisper-runtime-version-probe:test
pnpm phase0:whisper-runtime-version-probe:validate
```

Run against a caller-provided runtime path that matches the 5b manifest:

```powershell
node tools/whisper-native/whisper-fallback-runtime-version-probe.mjs --probe `
  <absolute-controlled-root> `
  <canonical-input-manifest.json> `
  <absolute-runtime-probe-executable> `
  <expected-candidate-aggregate-sha256>
```

Authority ceiling:

- `measurement_status=whisper-runtime-version-marker-path-observation-only`
- `execution_status=runtime-path-launched-fixed-version-marker-observed-no-model-no-transcription`
- `launch_binding_status=preflight-prespawn-postflight-path-identity-observed-spawn-reopen-window-not-eliminated`
- `loaded_image_attestation=false`
- `network_isolation_authority=none`
- `quality_gate_status=not-assessed`
- `formal_claims=none`
- `production_evidence=false`
- `public_distribution=false`
- `selection_authority=none`
- `fallback_authority=none`

This slice re-runs the 5b identity preflight; checks the executable path against
the manifest `runtime` role with bounded streaming hash, size, and stable file
identity; repeats the check immediately before a direct child path launch with a
minimal environment and bounded output; and re-checks identities after exit.
Node path-based process creation still reopens the executable path, so the final
spawn window is not eliminated and the loaded image is not attested. The CLI
forwards no proxy environment but does not enforce operating-system network
isolation. Public evidence is path-free and text-free and stores only digests
for the stdout marker and linked version.

It still does not select, download, load, validate, benchmark, rank, default, or
distribute any Whisper model; it does not process audio or produce
transcription.
