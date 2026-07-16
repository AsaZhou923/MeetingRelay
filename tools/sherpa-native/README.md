# sherpa-onnx offline asset lock

This directory is the executable asset boundary for `WP-0.4.3b`. It pins the official sherpa-onnx Rust/native runtime and the SenseVoice INT8 evaluation model without committing binaries or model weights.

The default materializer path is offline. Network access is possible only with the explicit `-AllowDownload` switch. That explicit path requires and verifies Windows' `System32\curl.exe` instead of resolving a PATH candidate, disables curlrc loading before every other option, restricts redirects and transfers to HTTPS, retries transient connection failures, and still checks every archive for its exact byte length and SHA-256 before extraction. Archive operations default to verified `System32\tar.exe`; callers may instead provide `-ArchiveTarPath` and `-ArchiveBzip2Path` together. An override is accepted only when both are regular non-reparse sibling Git-for-Windows tools and identify as GNU tar and bzip2, so the materializer never resolves an archive tool from PATH. CI walks upward from every PATH-visible `git.exe` until it finds the complete `usr\bin\tar.exe`/`bzip2.exe` installation, requires all candidates to resolve to one canonical Git root, and then derives the explicit pair because the hosted System32 tar can hang on bzip2 listing. Every archive subprocess temporarily removes `TAR_OPTIONS`, `BZIP2`, and `BZIP` and restores their exact process values afterward, preventing ambient option injection. Each archive is rechecked for exact size and SHA-256 before listing and again immediately before extraction. Separate path and verbose-type listings must agree; every entry must be a regular file or directory, while links, special entries, unsafe paths, duplicates, and files outside the sealed inventory fail closed. Existing symlinks, junctions, or other reparse points anywhere in a cache, source, temporary, extraction, or destination path chain are rejected before mutation and checked again afterward. The extracted file and directory set is then checked against the complete inventory; extra, missing, or modified entries fail closed.

```powershell
pnpm phase0:sherpa-assets:test
pnpm phase0:sherpa-assets:validate

# Reuse pre-provisioned archives without network access.
./tools/sherpa-native/materialize.ps1 `
  -CacheRoot target/sherpa-native `
  -ArchiveSourceRoot target/wp-0.4.3b/upstream

# Explicit acquisition path used by a clean CI runner.
$gitCommands = @(Get-Command git.exe -CommandType Application -All -ErrorAction Stop)
$resolvedGitRoots = foreach ($gitCommand in $gitCommands) {
  $directory = [IO.DirectoryInfo](Split-Path -Parent ([IO.Path]::GetFullPath($gitCommand.Source)))
  $resolvedGitRoot = $null
  while ($null -ne $directory) {
    if ((Test-Path -LiteralPath (Join-Path $directory.FullName 'usr\bin\tar.exe') -PathType Leaf) -and
        (Test-Path -LiteralPath (Join-Path $directory.FullName 'usr\bin\bzip2.exe') -PathType Leaf)) {
      $resolvedGitRoot = [IO.Path]::GetFullPath($directory.FullName)
      break
    }
    $directory = $directory.Parent
  }
  if ($null -eq $resolvedGitRoot) { throw "git.exe is not inside a complete Git for Windows installation" }
  $resolvedGitRoot
}
$gitRoots = @($resolvedGitRoots | Sort-Object -Unique)
if ($gitRoots.Count -ne 1) { throw "expected exactly one Git for Windows installation root" }
$gitRoot = $gitRoots[0]
./tools/sherpa-native/materialize.ps1 `
  -CacheRoot target/sherpa-native `
  -ArchiveTarPath (Join-Path $gitRoot 'usr\bin\tar.exe') `
  -ArchiveBzip2Path (Join-Path $gitRoot 'usr\bin\bzip2.exe') `
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

## Native exact-match quality smoke

`candidate-quality-smoke-reference.json` seals the upstream-documented `zh.wav` identity and transcript reference without carrying the WAV bytes. The audio fixture remains a read-in-place local-cache input: its redistribution status is `unresolved`, and it must not be committed, uploaded, or distributed. The runner rejects any fixture other than the exact 178,988-byte mono PCM S16LE, 16 kHz, 5.592-second WAV identified by SHA-256 `b77f1794fe374a0ba1ee1dc458bfaf9349496cbbfc32780c50ba3c5a7ad8e373`.

The smoke launches the existing locked Release candidate host in two fresh processes. Both conformance records must report one real backend execution and the exact canonical transcript identity: 38 UTF-8 bytes with SHA-256 `3dcf3d55f672e2d610a031580f924b47ddf147ff3d93f007b8386f9bef8cac58`. The byte length plus digest rejects BOM, newline, content, and normalization drift while keeping transcript content out of process output. Evidence is written through a create-new, sync, reread, strict-validate, hard-link-no-replace sequence.

This is an internal, upstream-documented single-fixture smoke reference, not independently licensed gold data and not a parameter-identical reproduction of the upstream example (MeetingRelay locks `language=zh`, while the cited upstream default is automatic language selection). Its evidence therefore fixes `quality_gate_status=not-assessed`, `formal_claims=none`, and `production_evidence=false`; it cannot establish product quality, performance, resource use, candidate selection/default, or parent work-package closeout.

```powershell
pnpm phase0:sherpa-candidate-quality-smoke:test

$evidencePath = [IO.Path]::GetFullPath('target/sherpa-native/native-candidate-quality-smoke-evidence.json')
pnpm phase0:sherpa-candidate-quality-smoke:run `
  $evidencePath `
  target/release/meetingrelay-sherpa-candidate-execution-host.exe `
  tools/sherpa-native/candidate-schema-registry.json `
  $env:MEETINGRELAY_SHERPA_MODEL `
  $env:MEETINGRELAY_SHERPA_TOKENS `
  $env:SHERPA_ONNX_LIB_DIR `
  tools/sherpa-native/assets.lock.json `
  Cargo.lock `
  $env:MEETINGRELAY_SHERPA_WAV
pnpm phase0:sherpa-candidate-quality-smoke:validate $evidencePath
```

## Measured-HW native contract-stage evidence

`native-candidate-measured-evidence.mjs` joins the measured candidate-input closeout, materialized sealed bundle, external measured-HW reference, locked `zh.wav`, and one actual Release native conformance execution. Its scope is deliberately limited to `native-contract-stage-only`: it records 12/12 conformance checks and exactly one backend execution, while fixing `formal_claims=none` and `production_evidence=false`. Quality, performance, resource use, publishability, ranking, selection/default, the parent candidate closeout, and the full calibration run all remain unassessed or not executed.

The programmatic runner requires three independent trust anchors: `expectedContractSha256`, `expectedHardwareReferenceSha256` plus `expectedHwRefId`, and `expectedOperatorFactsSha256`. The operator-facts digest is supplied externally; the runner does not infer it from the facts it receives. It is SHA-256 over MeetingRelay canonical JSON: recursively key-sorted, NFC-normalized string values, UTF-8 encoded, two-space indented, and terminated by exactly one LF (`\n`). All nine onsite facts are mandatory and must be measured values, never defaults, guesses, synthetic values, or placeholders:

- `ambientCelsius`
- `audioDeviceModel`
- `audioLogicalRole`
- `coolingMode`
- `gpuDeviceModel`
- `gpuVramBytes`
- `powerSource`
- `storageMedium`
- `storageVolume`

Use the exported API for a real run. There is intentionally no `--run` CLI because `candidatePlan` carries sealed in-memory material; callers must assemble and retain that typed plan explicitly. All filesystem paths below must be normalized absolute paths.

```js
import { runNativeCandidateMeasuredEvidence } from "./tools/sherpa-native/native-candidate-measured-evidence.mjs";

const result = await runNativeCandidateMeasuredEvidence({
  candidatePlan,
  expectedContractSha256,
  expectedHardwareReferenceSha256,
  expectedHwRefId,
  expectedOperatorFactsSha256,
  fixtureRegistryProjection,
  measuredHardwareReferencePath,
  operatorFacts: {
    ambientCelsius,
    audioDeviceModel,
    audioLogicalRole,
    coolingMode,
    gpuDeviceModel,
    gpuVramBytes,
    powerSource,
    storageMedium,
    storageVolume,
  },
  outputBundleRoot,
  outputEvidencePath,
  sourceRoots,
  wavPath,
});
```

The execution host is selected from the sealed worker material but runs from its `rust-target/release` directory, where the locked DLLs are staged. The first six arguments resolve from the materialized bundle (schema registry, model, tokens, runtime-library directory, model manifest, and package lock); the seventh is the separately sealed external `zh.wav`. The bundle's full run plan must remain `execution_status=planned` with `harness.command.argv=[]`. The calibration fixture named by that plan is not executed and is not claimed by this evidence.

Evidence publication is create-new and identity-gated; an existing or concurrently replaced output is never overwritten. Validate a persisted evidence file with the read-only CLI:

```powershell
pnpm phase0:sherpa-candidate-measured-evidence:test
pnpm phase0:sherpa-candidate-measured-evidence:validate <absolute-evidence-path>
```

CI runs only the synthetic contract test. It neither supplies the nine onsite facts nor emits actual measured-HW evidence, and therefore cannot close the onsite or parent work packages.

## Rights-aware multi-utterance corpus and quality foundation

`quality-corpus.mjs` accepts only an external, caller-supplied manifest SHA-256 plus local absolute, normalized, NFC, non-UNC/device-namespace, non-ADS corpus-root and manifest paths. Samples must already be in strict canonical ASCII `sample_id` order; the validator never silently sorts them. Every material path uses a bounded ASCII Windows-canonical grammar that rejects escape, empty segments, DOS device aliases, trailing dots, and case-fold collisions across WAV/reference/license/consent materials. Reference material must be nonempty strict UTF-8 NFC without BOM, NUL, CR, or LF. Corpus module load enforces the same exact Node/ICU/Unicode identity as the scorer before any NFC acceptance. Every ordered sample seals its canonical ID, opaque leakage-group ID, `zh`/`ja`/`en` language, scenario, fixed `tier-1`, and `dev`/`calibration`/`blind` split; raw WAV and decoded PCM identities; mono PCM S16LE 16 kHz format and exact sample duration; reference identity; allowed purpose, license/legal basis, retention, and consent state. A leakage group or audio identity may never cross splits; repeated reference text/hash remains legal because distinct recordings may share a transcript. Only `source_kind=synthetic` may use the exact `not-required-non-human` consent record. Human-consented and public-corpus inputs require a verified, unwithdrawn, in-scope, unexpired record. Missing, denied, expired, withdrawn, split-leaked, changed, escaping, or Node-visible symlink/junction inputs fail closed. Direct target reads bind and postflight the file identity and bytes; persistent ancestor/root inode binding plus arbitrary Windows reparse-tag/attribute enumeration remain real-run materializer gates. The caller's strict `validation_date` is included in the snapshot preimage, materialized result, and text-free metadata projection so rights decisions made on different dates cannot share an unexplained snapshot identity. That projection exposes counts and digests only—never transcripts, filesystem paths, URLs, consent bodies, or license bodies—but is not by itself authorization for public distribution.

`asr-error-rate.mjs` provides deterministic `zh`/`ja` CER and `en` WER with exact substitution/deletion/insertion counts. Foundation v1 accepts only `tier-1`; future best-effort languages require a new explicit profile/schema contract. `asr-scorer-profile.json` is the committed canonical scoring artifact: it freezes Node `24.13.0`, ICU `77.1`, Unicode `16.0`, NFC, project-owned ASCII case/fullwidth mappings, explicit whitespace and punctuation code points, unit costs, match-first tie-break order, bounds, metrics, and aggregation. Module load fails if the runtime identity differs. No locale lowercase, NFKC, runtime Unicode-property regex, float, or rounded rate participates. Every score exposes the profile SHA-256. The scorer unit contract distinguishes an empty-reference correct silence from a hallucination, but corpus v1 deliberately requires every reference material to be nonempty; an explicit silence-corpus discriminator remains a later contract decision. Every summary carries exact S/D/I/total/reference/hypothesis unit sums plus exact comparable-utterance minimum and maximum rates. Language×scenario macros are reported, and each language macro weights its nonempty scenario macros equally; exact BigInt fractions permit bounded multi-thousand-digit LCM denominators. There is no cross-language, cross-metric, or cross-tier aggregate. Aggregate validation requires the exact plaintext-free per-sample score rows and recomputes the entire aggregate, so a standalone forged summary is not accepted. Scores are descriptive only and cannot promote a quality threshold or claim.

`controlled-hypothesis-ledger.mjs` defines the separate controlled-data surface for exact multilingual hypotheses, including empty and non-NFC text. Entries are in contiguous `sequence` and strict ascending ASCII `sample_id` order, fixed to `attempt=1`, and joined by digests to sample/component/candidate/corpus/host/hardware/scorer/source identities. Its create-new ledger publication remains inside a caller-supplied direct controlled root. The publisher never path-unlinks staging: success retains the owned staging hard link, and an uncertain failure may retain create-new final/staging residue. Lifecycle cleanup is deliberately out of band and must re-establish ownership with a handle/file-ID-bound primitive before deletion. The text-free controlled-derived projection removes transcript content and retains only digests, counts, joins, and classifications. It is neither privacy-safe by implication nor approved for public distribution: short transcripts may be dictionary-guessed from hashes, and classifications may remain sensitive. The projection is returned to the caller but is not published as an independently sealed file by this foundation contract. The component evidence below does not ingest controlled hypothesis text, so scoring and component evidence are not yet joined into a real-run quality decision.

`native-candidate-component-evidence.mjs` supervises the Release per-sample Rust host through exactly 13 positional arguments: schema registry, model, tokens, runtime directory, asset lock, package lock, sample ID, language, WAV path, WAV byte count, WAV SHA-256, PCM SHA-256, and reference SHA-256. Every run path must be a local absolute, normalized, NFC, non-UNC/device-namespace, non-ADS path; the spawned executable string is exactly the resolved path whose bytes were hashed. The host must emit one canonical JSON line, execute the backend exactly once in a fresh process, join the sample/logical-candidate/quality-host/schema identities, and report canonical-decimal integer timings plus exact RTF numerator/denominator. Results preserve strict ascending `sample_id` order with contiguous `sequence` values starting at one and `attempt=1`. The baseline candidate execution host remains separately identified for measured-evidence audit; it is never confused with the new quality host. The supervisor independently double-reads both the quality-host executable and schema registry through direct regular-file handles, verifies their expected digests and file identities before every spawn and after every sample, and rechecks both before publication. Node cannot make the path lookup plus `CreateProcess` one atomic operation, so evidence explicitly retains `spawn-path-toctou-not-eliminated-by-node-supervisor` instead of claiming an adversarial launch race is fully eliminated. Current CPU/GPU/RAM/VRAM values are explicitly `null` with `status=unavailable` and a stable reason; they are never fabricated. The injected `candidateJoinLoader` is a trusted caller adapter whose returned shape and drift are checked after every sample; this foundation does not directly materialize or verify its underlying candidate/source/hardware artifacts. The validation-date-bound corpus is rematerialized after every sample. Publication binds the direct output-parent inode and stage snapshots across create, hard-link, persisted reads, and final validation; staging and target must be the same bigint file identity during those checks and every target read is stable and byte-exact. Parent or target replacement fails closed, and a valid competitor at the final name is preserved. The publisher never path-unlinks staging; every success retains an auditable create-new staging hard link, and failures may retain final/staging residue. Cleanup is an out-of-band lifecycle operation that must re-establish ownership with a handle/file-ID-bound primitive. The runner then performs another stable read and requires the persisted bytes, digest, and decoded record to equal the evidence it generated.

Persisted component evidence contains digests, classifications, integer timing strings, and unavailability state only. It cannot carry raw transcript, path, URL, device serial, consent content, or rights content; this text-free metadata is still not automatically cleared for public distribution. The native host intentionally returns only final-transcript digest/length; this component runner does not receive or join a controlled hypothesis-content ledger, so its native outputs do not enter the scorer and quality remains `not-assessed`. Evidence v1 hard-codes `formal_claims=none`, `production_evidence=false`, `quality_status=not-assessed`, `threshold_status=not-frozen`, parent `not-assessed`, and ranking/selection/default `not-authorized`; no validation or runner branch can promote them.

The CI contract is synthetic non-speech only and pins the scorer runtime to Node `24.13.0` / ICU `77.1` / Unicode `16.0`: tests construct temporary PCM pulse WAVs, synthetic references, and synthetic rights bytes. It performs no corpus/model download, creates no Actions cache or artifact for corpus data, invokes no real evidence run, and cannot claim model quality or performance. Fresh process per sample plus whole-corpus rematerialization is an isolation-first, small offline-corpus foundation with worst-case quadratic corpus I/O; it is not the production realtime or large-corpus throughput architecture.

```powershell
pnpm phase0:sherpa-quality-foundation:test
pnpm phase0:sherpa-quality-foundation:validate <absolute-evidence-path>
```

There is intentionally no `phase0:sherpa-quality-foundation:run` script. A future authorized caller must supply the external corpus trust anchor and a trusted candidate/measured-evidence join adapter programmatically, then add direct artifact joins before any real quality authority exists.
