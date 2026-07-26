param(
    [Parameter(Mandatory = $true)]
    [string]$EvidencePath,

    [string]$ReportPath
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Add-AcceptanceFinding {
    param(
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][System.Collections.IList]$Findings,
        [Parameter(Mandatory = $true)][string]$Area,
        [Parameter(Mandatory = $true)][bool]$Pass,
        [Parameter(Mandatory = $true)][string]$Code,
        [Parameter(Mandatory = $true)][string]$Message
    )
    $Findings.Add([pscustomobject]@{
        area = $Area
        pass = $Pass
        code = $Code
        message = $Message
    }) | Out-Null
}

function Assert-HasProperty {
    param(
        [Parameter(Mandatory = $true)]$Object,
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$Code
    )
    if ($null -eq $Object -or -not ($Object.PSObject.Properties.Name -contains $Name)) {
        throw $Code
    }
    $Object.$Name
}

function Get-PercentileNearestRank {
    param(
        [Parameter(Mandatory = $true)][double[]]$Values,
        [Parameter(Mandatory = $true)][ValidateRange(1, 100)][int]$Percentile
    )
    if ($Values.Count -eq 0) {
        return 0
    }
    $sorted = @($Values | Sort-Object)
    $index = [Math]::Ceiling(($Percentile / 100.0) * $sorted.Count) - 1
    $index = [Math]::Max(0, [Math]::Min($index, $sorted.Count - 1))
    [double]$sorted[$index]
}

function Get-HostScheme {
    param([Parameter(Mandatory = $true)][string]$BaseUrl)
    try {
        return ([Uri]$BaseUrl).Scheme.ToLowerInvariant()
    }
    catch {
        return ""
    }
}

function Test-ProviderMeetings {
    param(
        [Parameter(Mandatory = $true)]$Evidence,
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][System.Collections.IList]$Findings
    )
    $area = "https-provider"
    $meetings = @(Assert-HasProperty -Object $Evidence -Name "meetings" -Code "MEETINGS_MISSING")
    $qualifying = @($meetings | Where-Object {
        $duration = [double]$_.durationMinutes
        $scheme = Get-HostScheme -BaseUrl ([string]$_.provider.baseUrl)
        $duration -ge 10 -and $duration -le 20 -and $scheme -eq "https"
    })
    Add-AcceptanceFinding $Findings $area ($qualifying.Count -ge 2) "HTTPS_10_20_MINUTE_MEETINGS" "requires at least two 10-20 minute meetings over HTTPS"

    $directions = @($qualifying | ForEach-Object { "$($_.sourceLanguage)->$($_.targetLanguage)" } | Sort-Object -Unique)
    Add-AcceptanceFinding $Findings $area ($directions.Count -ge 2) "LANGUAGE_PAIR_COVERAGE" "requires at least two distinct language-pair directions"

    foreach ($meeting in $qualifying) {
        $latencies = @($meeting.latencyMs | ForEach-Object { [double]$_ })
        $failures = @($meeting.failures)
        $hasCost = $meeting.PSObject.Properties.Name -contains "cost" -and $null -ne $meeting.cost -and (
            ($meeting.cost.PSObject.Properties.Name -contains "estimatedUsd" -and [double]$meeting.cost.estimatedUsd -ge 0) -or
            ($meeting.cost.PSObject.Properties.Name -contains "promptTokens" -and $meeting.cost.PSObject.Properties.Name -contains "completionTokens")
        )
        $qualityScore = if ($meeting.PSObject.Properties.Name -contains "qualityScore") { [double]$meeting.qualityScore } else { -1 }
        Add-AcceptanceFinding $Findings $area ($latencies.Count -gt 0) "LATENCY_EVIDENCE_$($meeting.id)" "meeting must include per-request latency samples"
        Add-AcceptanceFinding $Findings $area ($failures.Count -eq 0) "TRANSLATION_FAILURES_$($meeting.id)" "meeting must have zero provider failures"
        Add-AcceptanceFinding $Findings $area $hasCost "COST_EVIDENCE_$($meeting.id)" "meeting must include token usage or non-negative estimated cost"
        Add-AcceptanceFinding $Findings $area ($qualityScore -ge 0.8) "QUALITY_SCORE_$($meeting.id)" "meeting qualityScore must be at least 0.8"
    }
}

function Test-AudioContinuity {
    param(
        [Parameter(Mandatory = $true)]$Evidence,
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][System.Collections.IList]$Findings
    )
    $area = "audio-continuity"
    $audio = Assert-HasProperty -Object $Evidence -Name "audio" -Code "AUDIO_MISSING"
    $sampleRateHz = [double](Assert-HasProperty -Object $audio -Name "sampleRateHz" -Code "AUDIO_SAMPLE_RATE_MISSING")
    $expectedDurationSeconds = [double](Assert-HasProperty -Object $audio -Name "expectedDurationSeconds" -Code "AUDIO_DURATION_MISSING")
    $sources = @(Assert-HasProperty -Object $audio -Name "sources" -Code "AUDIO_SOURCES_MISSING")
    $expectedSamples = [Math]::Round($sampleRateHz * $expectedDurationSeconds)
    $maxAllowedMissing = $expectedSamples * 0.001
    $maxAllowedGapSamples = $sampleRateHz * 0.250

    Add-AcceptanceFinding $Findings $area ($expectedDurationSeconds -ge 7200) "AUDIO_TWO_HOUR_DURATION" "dual-source soak must be at least two hours"
    Add-AcceptanceFinding $Findings $area ($sources.Count -ge 2) "AUDIO_DUAL_SOURCE" "requires at least two captured sources"

    foreach ($source in $sources) {
        $gaps = @($source.gaps)
        $gapSamples = 0.0
        $maxGap = 0.0
        foreach ($gap in $gaps) {
            $length = [double]$gap.end - [double]$gap.start
            if ($length -gt 0) {
                $gapSamples += $length
                $maxGap = [Math]::Max($maxGap, $length)
            }
        }
        $rangeSamples = [double]$source.meetingSampleEnd - [double]$source.meetingSampleStart
        $reportedFrameLoss = [Math]::Max(0, $expectedSamples - [double]$source.frameCount)
        $missingSamples = [Math]::Max($gapSamples, [Math]::Max(0, $expectedSamples - $rangeSamples))
        $missingSamples = [Math]::Max($missingSamples, $reportedFrameLoss)
        $lossRate = if ($expectedSamples -gt 0) { $missingSamples / $expectedSamples } else { 1 }

        Add-AcceptanceFinding $Findings $area ($lossRate -le 0.001) "AUDIO_LOSS_$($source.source)" "source loss must be below or equal to 0.1%; actual=$([Math]::Round($lossRate * 100, 6))%"
        Add-AcceptanceFinding $Findings $area ($maxGap -le $maxAllowedGapSamples) "AUDIO_MAX_GAP_$($source.source)" "source continuous gap must be <= 250 ms; actual=$([Math]::Round(($maxGap / $sampleRateHz) * 1000, 3)) ms"
    }
}

function Test-TimelineAccuracy {
    param(
        [Parameter(Mandatory = $true)]$Evidence,
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][System.Collections.IList]$Findings
    )
    $area = "timeline"
    $timeline = Assert-HasProperty -Object $Evidence -Name "timeline" -Code "TIMELINE_MISSING"
    $sampleRateHz = [double](Assert-HasProperty -Object $timeline -Name "sampleRateHz" -Code "TIMELINE_SAMPLE_RATE_MISSING")
    $points = @(Assert-HasProperty -Object $timeline -Name "points" -Code "TIMELINE_POINTS_MISSING")
    $errors = New-Object System.Collections.ArrayList

    foreach ($point in $points) {
        $startError = [Math]::Abs(([double]$point.actualStartSample - [double]$point.expectedStartSample) / $sampleRateHz * 1000)
        $endError = [Math]::Abs(([double]$point.actualEndSample - [double]$point.expectedEndSample) / $sampleRateHz * 1000)
        $errors.Add([double]([Math]::Max($startError, $endError))) | Out-Null
    }

    $p95 = Get-PercentileNearestRank -Values @($errors | ForEach-Object { [double]$_ }) -Percentile 95
    $max = if ($errors.Count -eq 0) { 0 } else { ($errors | Measure-Object -Maximum).Maximum }
    Add-AcceptanceFinding $Findings $area ($points.Count -gt 0) "TIMELINE_POINTS_PRESENT" "timeline benchmark must include segment points"
    Add-AcceptanceFinding $Findings $area ($p95 -le 250) "TIMELINE_P95" "timeline p95 error must be <= 250 ms; actual=$([Math]::Round($p95, 3)) ms"
    Add-AcceptanceFinding $Findings $area ($max -le 500) "TIMELINE_MAX" "timeline max error must be <= 500 ms; actual=$([Math]::Round($max, 3)) ms"
}

function Measure-WindowsAcceptance {
    param([Parameter(Mandatory = $true)]$Evidence)

    $findings = New-Object System.Collections.ArrayList
    Add-AcceptanceFinding $findings "schema" ($Evidence.schemaVersion -eq "meetingrelay.windows.acceptance.v1") "SCHEMA_VERSION" "schemaVersion must be meetingrelay.windows.acceptance.v1"
    Test-ProviderMeetings -Evidence $Evidence -Findings $findings
    Test-AudioContinuity -Evidence $Evidence -Findings $findings
    Test-TimelineAccuracy -Evidence $Evidence -Findings $findings

    $passed = @($findings | Where-Object { $_.pass }).Count
    $failedFindings = @($findings | Where-Object { -not $_.pass })
    [pscustomobject]@{
        schemaVersion = "meetingrelay.windows.acceptance.report.v1"
        runId = $Evidence.runId
        generatedAt = (Get-Date).ToUniversalTime().ToString("o")
        passed = $failedFindings.Count -eq 0
        passedChecks = $passed
        failedChecks = $failedFindings.Count
        findings = @($findings)
    }
}

$resolvedEvidencePath = [IO.Path]::GetFullPath($EvidencePath)
if (-not (Test-Path -LiteralPath $resolvedEvidencePath -PathType Leaf)) {
    throw "ACCEPTANCE_EVIDENCE_NOT_FOUND path=$resolvedEvidencePath"
}

$evidence = Get-Content -LiteralPath $resolvedEvidencePath -Raw | ConvertFrom-Json
$report = Measure-WindowsAcceptance -Evidence $evidence
$reportJson = $report | ConvertTo-Json -Depth 12

if ($ReportPath) {
    $resolvedReportPath = [IO.Path]::GetFullPath($ReportPath)
    $parent = Split-Path -Parent $resolvedReportPath
    if ($parent -and -not (Test-Path -LiteralPath $parent -PathType Container)) {
        New-Item -ItemType Directory -Path $parent | Out-Null
    }
    Set-Content -LiteralPath $resolvedReportPath -Value $reportJson -Encoding UTF8
}

$reportJson | Write-Output
if (-not $report.passed) {
    throw "MEETINGRELAY_WINDOWS_ACCEPTANCE_FAILED failed_checks=$($report.failedChecks)"
}
