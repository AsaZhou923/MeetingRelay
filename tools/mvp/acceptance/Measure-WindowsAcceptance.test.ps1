$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot "..\..\shared\Get-MeetingRelayFileSha256.ps1")

function Assert-Equal {
    param(
        [Parameter(Mandatory = $true)]$Expected,
        [Parameter(Mandatory = $true)]$Actual,
        [Parameter(Mandatory = $true)][string]$Label
    )
    if ($Expected -ne $Actual) {
        throw "ASSERT_EQUAL_FAILED label=$Label expected=$Expected actual=$Actual"
    }
}

function Assert-ThrowsLike {
    param(
        [Parameter(Mandatory = $true)][scriptblock]$Action,
        [Parameter(Mandatory = $true)][string]$Pattern,
        [Parameter(Mandatory = $true)][string]$Label
    )
    try {
        & $Action
    }
    catch {
        if ($_.Exception.Message -notlike $Pattern) {
            throw "ASSERT_THROW_PATTERN_FAILED label=$Label message=$($_.Exception.Message)"
        }
        return
    }
    throw "ASSERT_THROW_MISSING label=$Label"
}

$scriptPath = Join-Path $PSScriptRoot "Measure-WindowsAcceptance.ps1"
$fixturePath = Join-Path $PSScriptRoot "fixtures\passing-windows-acceptance.json"
$testRoot = Join-Path ([IO.Path]::GetTempPath()) "meetingrelay-acceptance-test-$([Guid]::NewGuid())"
New-Item -ItemType Directory -Path $testRoot | Out-Null

try {
    $reportPath = Join-Path $testRoot "report.json"
    $passOutput = & $scriptPath -EvidencePath $fixturePath -ReportPath $reportPath
    $passReport = $passOutput | ConvertFrom-Json
    Assert-Equal -Expected $true -Actual $passReport.passed -Label "passing fixture accepted"
    Assert-Equal -Expected 0 -Actual $passReport.failedChecks -Label "passing fixture has no failed checks"
    Assert-Equal -Expected $true -Actual (Test-Path -LiteralPath $reportPath -PathType Leaf) -Label "report file written"

    $httpEvidence = Get-Content -LiteralPath $fixturePath -Raw | ConvertFrom-Json
    $httpEvidence.meetings[0].provider.baseUrl = "http://api.example.com/v1"
    $httpPath = Join-Path $testRoot "http.json"
    $httpEvidence | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $httpPath -Encoding UTF8
    Assert-ThrowsLike `
        -Action { & $scriptPath -EvidencePath $httpPath | Out-Null } `
        -Pattern "MEETINGRELAY_WINDOWS_ACCEPTANCE_FAILED*" `
        -Label "remote http meeting rejected"

    $gapEvidence = Get-Content -LiteralPath $fixturePath -Raw | ConvertFrom-Json
    $gapEvidence.audio.sources[1].gaps = @([pscustomobject]@{ start = 16000; end = 22000; reason = "CAPTURE_GAP" })
    $gapPath = Join-Path $testRoot "gap.json"
    $gapEvidence | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $gapPath -Encoding UTF8
    Assert-ThrowsLike `
        -Action { & $scriptPath -EvidencePath $gapPath | Out-Null } `
        -Pattern "MEETINGRELAY_WINDOWS_ACCEPTANCE_FAILED*" `
        -Label "continuous audio gap rejected"

    $timelineEvidence = Get-Content -LiteralPath $fixturePath -Raw | ConvertFrom-Json
    $timelineEvidence.timeline.points[0].actualStartSample = 16000
    $timelinePath = Join-Path $testRoot "timeline.json"
    $timelineEvidence | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $timelinePath -Encoding UTF8
    Assert-ThrowsLike `
        -Action { & $scriptPath -EvidencePath $timelinePath | Out-Null } `
        -Pattern "MEETINGRELAY_WINDOWS_ACCEPTANCE_FAILED*" `
        -Label "timeline p95 regression rejected"
}
finally {
    Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
}

$materialsRoot = Join-Path $PSScriptRoot "materials"
$materialsRootFull = [IO.Path]::GetFullPath($materialsRoot).TrimEnd('\') + '\'
$materialsManifest = Get-Content -LiteralPath (Join-Path $materialsRoot "manifest.json") -Raw -Encoding UTF8 | ConvertFrom-Json
Assert-Equal -Expected 1 -Actual $materialsManifest.schema_version -Label "material manifest schema"
Assert-Equal -Expected 3 -Actual @($materialsManifest.materials).Count -Label "representative material count"
$directions = @($materialsManifest.materials |
    ForEach-Object { @($_.recommended_directions) } |
    ForEach-Object { [string]$_.direction } |
    Sort-Object) -join ","
Assert-Equal `
    -Expected "en-US->zh-CN,ja-JP->zh-CN,zh-CN->ja-JP" `
    -Actual $directions `
    -Label "representative material directions"
$syntheticTerm = -join @([char]0x5408, [char]0x6210)
$consentTerm = -join @([char]0x540C, [char]0x610F)

foreach ($material in @($materialsManifest.materials)) {
    $relativePath = [string]$material.file
    if ([IO.Path]::IsPathRooted($relativePath) -or $relativePath.Split([char[]]@('\', '/')) -contains "..") {
        throw "MATERIAL_PATH_INVALID id=$($material.id)"
    }
    $materialPath = [IO.Path]::GetFullPath((Join-Path $materialsRoot $relativePath))
    if (-not $materialPath.StartsWith($materialsRootFull, [StringComparison]::OrdinalIgnoreCase)) {
        throw "MATERIAL_PATH_OUTSIDE_ROOT id=$($material.id)"
    }

    $text = Get-Content -LiteralPath $materialPath -Raw -Encoding UTF8
    $actualHash = Get-MeetingRelayFileSha256 -Path $materialPath
    Assert-Equal `
        -Expected ([string]$material.sha256_utf8).ToLowerInvariant() `
        -Actual $actualHash `
        -Label "material hash $($material.id)"

    $actualCount = if ([string]$material.count.unit -eq "words") {
        ([regex]::Matches($text, "\b[\p{L}\p{N}'-]+\b")).Count
    }
    else {
        ($text -replace "\s", "").Length
    }
    Assert-Equal `
        -Expected ([int]$material.count.value) `
        -Actual $actualCount `
        -Label "material count $($material.id)"

    $notice = @($text -split "\r?\n" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })[0]
    $hasSyntheticNotice = $notice.Contains($syntheticTerm) -or $notice.Contains("Synthetic")
    $hasConsentNotice = $notice.Contains($consentTerm) -or $notice.Contains("consent")
    if (-not $hasSyntheticNotice -or -not $hasConsentNotice) {
        throw "MATERIAL_CONSENT_NOTICE_MISSING id=$($material.id)"
    }
}

Write-Output "MEETINGRELAY_WINDOWS_ACCEPTANCE_TEST_PASS assertions=17"
