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
