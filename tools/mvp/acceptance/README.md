# Windows acceptance evidence tools

This directory contains the repeatable gate for the remaining R0/R2 Windows
acceptance evidence. It does not fake real-device evidence; it validates an
evidence JSON produced from a real HTTPS provider run, a two-hour dual-source
audio soak, and a representative timeline benchmark.

## Automated gate

```powershell
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass `
  -File tools/mvp/acceptance/Measure-WindowsAcceptance.ps1 `
  -EvidencePath target/mvp/acceptance/windows-evidence.json `
  -ReportPath target/mvp/acceptance/windows-acceptance-report.json
```

Pass criteria:

- at least two distinct language-pair meetings, each 10-20 minutes, using an
  HTTPS provider;
- each qualifying meeting has zero provider failures, latency samples, cost
  evidence, and `qualityScore >= 0.8`;
- dual-source audio soak is at least two hours;
- per-source loss is `missingSamples / expectedSamples <= 0.001`;
- no continuous audio gap exceeds `sampleRateHz * 0.250`;
- timeline point error uses the greater start/end absolute error in ms, with
  p95 `<= 250 ms` and max `<= 500 ms`.

## Live provider matrix helper

```powershell
$env:MEETINGRELAY_LIVE_TRANSLATION_BASE_URL = "https://api.example.com/v1"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass `
  -File tools/mvp/acceptance/Run-LiveProviderMatrix.ps1 `
  -Model provider-model `
  -SampleCount 20
```

Set both `MEETINGRELAY_LIVE_TRANSLATION_BASE_URL` and
`MEETINGRELAY_LIVE_TRANSLATION_API_KEY` in the process environment before
running the helper. Neither value is accepted as a command-line argument or
included in validation errors. The helper refuses non-HTTPS URLs and runs the
existing ignored Rust live matrix test for `ja->zh` and `zh->en`. Keep logs under
`target/mvp/acceptance/` so tokens and real meeting material are not committed.

## R0 synthetic material pack

`materials/manifest.json` describes three consent-safe, synthetic meeting
scripts for representative live playback:

| Evidence ID | Source | Recommended direction | File |
| --- | --- | --- | --- |
| `r0-material-zh-cn-ops-sync-001` | Simplified Chinese | `zh-CN->ja-JP` | `materials/r0-zh-cn-ops-sync-001.md` |
| `r0-material-ja-jp-ops-sync-001` | Japanese | `ja-JP->zh-CN` | `materials/r0-ja-jp-ops-sync-001.md` |
| `r0-material-en-us-ops-sync-001` | English | `en-US->zh-CN` | `materials/r0-en-us-ops-sync-001.md` |

Use these files when real meetings are not explicitly authorized for evidence.
Each script starts with a synthetic and consent-safe notice. Before live
playback or reading, state that the material is synthetic, confirm that
recording, transcription, and translation evaluation are allowed, and record the
manifest evidence ID in the run notes.

For live reading, assign the speaker roles to three or four readers and keep a
natural business-meeting pace. Natural pauses are fine, but do not intentionally
add silence longer than ten seconds unless the run is specifically testing
silence recovery.

Regenerate or verify the manifest counts and SHA-256 hashes with PowerShell:

```powershell
$materialsRoot = "tools/mvp/acceptance/materials"
$manifestPath = Join-Path $materialsRoot "manifest.json"
$manifest = Get-Content -Raw -Encoding UTF8 $manifestPath | ConvertFrom-Json

foreach ($item in $manifest.materials) {
  $path = Join-Path $materialsRoot $item.file
  $hash = (Get-FileHash -Algorithm SHA256 $path).Hash.ToLowerInvariant()
  $text = Get-Content -Raw -Encoding UTF8 $path

  if ($item.count.unit -eq "words") {
    $count = ([regex]::Matches($text, "\b[\p{L}\p{N}'-]+\b")).Count
  } else {
    $count = (($text -replace "\s", "").Length)
  }

  if ($hash -ne $item.sha256_utf8) {
    throw "$($item.id) hash mismatch: $hash"
  }
  if ($count -ne [int]$item.count.value) {
    throw "$($item.id) count mismatch: $count"
  }
}
```

## Evidence shape

Use `fixtures/passing-windows-acceptance.json` as the schema example. Real runs
must replace fixture values with measured device/provider output before a
release claim is made.
