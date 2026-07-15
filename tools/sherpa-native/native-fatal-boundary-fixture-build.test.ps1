[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = [IO.Path]::GetFullPath((Join-Path $scriptRoot "../.."))
$targetRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot "target"))
$buildScript = Join-Path $scriptRoot "build-native-fatal-boundary-fixture.ps1"
$outputDirectory = Join-Path $targetRoot "sherpa-native/fatal-fixtures/msvc"
$executablePath = Join-Path $outputDirectory "meetingrelay-native-fatal-boundary-fixture.exe"
$metadataPath = Join-Path $outputDirectory "meetingrelay-native-fatal-boundary-fixture.build.json"
$testRoot = Join-Path $targetRoot ("sherpa-native/fatal-fixtures/test-" + [Guid]::NewGuid().ToString("N"))

function Assert-UnderTarget {
    param([Parameter(Mandatory = $true)][string]$Path)
    $resolved = [IO.Path]::GetFullPath($Path)
    $prefix = $targetRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    if (-not $resolved.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Fatal-boundary fixture test path escaped target: $resolved"
    }
}

function Get-LowerSha256 {
    param([Parameter(Mandatory = $true)][string]$Path)
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Quote-WindowsArgument {
    param([Parameter(Mandatory = $true)][string]$Value)
    if ($Value.Contains('"')) {
        throw "Test arguments must not contain quote characters"
    }
    return '"' + $Value + '"'
}

function Invoke-CapturedFixture {
    param([string[]]$Argument)
    $startInfo = New-Object Diagnostics.ProcessStartInfo
    $startInfo.FileName = $executablePath
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.Arguments = (($Argument | ForEach-Object { Quote-WindowsArgument -Value $_ }) -join " ")
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $startInfo
    if (-not $process.Start()) {
        throw "Could not start the fatal-boundary fixture"
    }
    $stdout = $process.StandardOutput.ReadToEnd()
    $stderr = $process.StandardError.ReadToEnd()
    $process.WaitForExit()
    return [PSCustomObject]@{
        ExitCode = $process.ExitCode
        ExitCodeDword = [BitConverter]::ToUInt32([BitConverter]::GetBytes([Int32]$process.ExitCode), 0)
        Stdout = $stdout
        Stderr = $stderr
    }
}

function Assert-EmptyStreams {
    param(
        [Parameter(Mandatory = $true)]$Result,
        [Parameter(Mandatory = $true)][string]$Label
    )
    if ($Result.Stdout.Length -ne 0 -or $Result.Stderr.Length -ne 0) {
        throw "$Label wrote unexpected stdout or stderr"
    }
}

Assert-UnderTarget -Path $testRoot
$pathSafetyOutput = @(& $buildScript -PathSafetySelfTest)
if (($pathSafetyOutput -join "`n") -cne "NATIVE_FATAL_BOUNDARY_PATH_SAFETY_SELF_TEST=PASS") {
    throw "Fatal-boundary build helper path-safety self-test did not pass exactly"
}
$buildOutput = @(& $buildScript)
if ($buildOutput.Count -ne 1 -or
    $buildOutput[0] -notmatch '^NATIVE_FATAL_BOUNDARY_FIXTURE_BUILD=PASS executable_sha256=[0-9a-f]{64} metadata=.+\.json$') {
    throw "Fatal-boundary build helper did not emit its exact PASS marker"
}
if (-not (Test-Path -LiteralPath $executablePath -PathType Leaf) -or
    -not (Test-Path -LiteralPath $metadataPath -PathType Leaf)) {
    throw "Fatal-boundary build helper did not produce its exact outputs"
}

$metadata = Get-Content -LiteralPath $metadataPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($metadata.kind -cne "meetingrelay-native-fatal-boundary-fixture-build-v1" -or
    $metadata.schema_version -cne "1.0" -or
    $metadata.executable_hash_scope -cne "local-build-identity-only-not-cross-toolchain-reproducibility" -or
    $metadata.source.sha256 -cne (Get-LowerSha256 -Path (Join-Path $scriptRoot "native-fatal-boundary-fixture.c")) -or
    $metadata.compiler.sha256 -cne (Get-LowerSha256 -Path $metadata.compiler.path) -or
    $metadata.artifact.sha256 -cne (Get-LowerSha256 -Path $executablePath) -or
    $metadata.artifact.pe.machine -cne "0x8664" -or
    $metadata.artifact.pe.optional_header_magic -cne "0x020b" -or
    (@($metadata.artifact.pe.required_dll_characteristics) -join "`n") -cne (@("DYNAMIC_BASE", "NX_COMPAT", "GUARD_CF") -join "`n")) {
    throw "Fatal-boundary persisted build metadata failed independent identity validation"
}

New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
try {
    $usageResult = Invoke-CapturedFixture -Argument @()
    if ($usageResult.ExitCode -ne 64) {
        throw "Fatal-boundary invalid CLI returned $($usageResult.ExitCode), expected 64"
    }
    Assert-EmptyStreams -Result $usageResult -Label "invalid CLI"

    $dummyPaths = @(
        (Join-Path $testRoot "fault-host-marker.json"),
        (Join-Path $testRoot "schema.json"),
        (Join-Path $testRoot "model.onnx"),
        (Join-Path $testRoot "tokens.txt"),
        (Join-Path $testRoot "runtime"),
        (Join-Path $testRoot "assets.lock.json"),
        (Join-Path $testRoot "Cargo.lock"),
        (Join-Path $testRoot "fixture.wav")
    )
    $missingFaultHost = Join-Path $testRoot "meetingrelay-sherpa-candidate-fault-host.exe"
    $invalidHostResult = Invoke-CapturedFixture -Argument (@(
        "supervise-rust",
        "abort-after-prepare",
        (Join-Path $testRoot "launcher.json"),
        (Join-Path $testRoot "result.json"),
        $missingFaultHost
    ) + $dummyPaths)
    if ($invalidHostResult.ExitCode -ne 65) {
        throw "Missing exact fault host returned $($invalidHostResult.ExitCode), expected 65"
    }
    Assert-EmptyStreams -Result $invalidHostResult -Label "fault-host identity rejection"

    $invalidLaneContracts = @(
        @("unknown-mode", (Join-Path $testRoot "result-a.json")),
        @("abort-after-prepare", "-"),
        @("hang-after-inference", (Join-Path $testRoot "result-b.json"))
    )
    foreach ($contract in $invalidLaneContracts) {
        $invalidLaneResult = Invoke-CapturedFixture -Argument (@(
            "supervise-rust",
            $contract[0],
            (Join-Path $testRoot "launcher-invalid.json"),
            $contract[1],
            $missingFaultHost
        ) + $dummyPaths)
        if ($invalidLaneResult.ExitCode -ne 64) {
            throw "Invalid lane contract returned $($invalidLaneResult.ExitCode), expected 64"
        }
        Assert-EmptyStreams -Result $invalidLaneResult -Label "invalid lane contract"
    }

    $representativeMarker = Join-Path $testRoot "representative-av.marker.json"
    $representativeResult = Invoke-CapturedFixture -Argument @("representative-av", $representativeMarker)
    if ($representativeResult.ExitCodeDword -ne 3221225477) {
        throw ("Representative access violation returned DWORD {0}, expected 3221225477" -f $representativeResult.ExitCodeDword)
    }
    Assert-EmptyStreams -Result $representativeResult -Label "representative access violation"
    $expectedMarker = '{"checkpoint":"before-injected-access-violation","expected_exit_code_dword":3221225477,"fault_origin":"injected-representative-boundary","kind":"meetingrelay-native-fatal-representative-av-marker-v1","sherpa_defect":false}' + "`n"
    $markerBytesBefore = [IO.File]::ReadAllBytes($representativeMarker)
    $actualMarker = [Text.Encoding]::UTF8.GetString($markerBytesBefore)
    if ($actualMarker -cne $expectedMarker) {
        throw "Representative access-violation marker differs from the exact canonical record"
    }

    $createNewResult = Invoke-CapturedFixture -Argument @("representative-av", $representativeMarker)
    if ($createNewResult.ExitCode -ne 77) {
        throw "Representative marker reuse returned $($createNewResult.ExitCode), expected 77"
    }
    Assert-EmptyStreams -Result $createNewResult -Label "representative CREATE_NEW rejection"
    $markerBytesAfter = [IO.File]::ReadAllBytes($representativeMarker)
    if ([Convert]::ToBase64String($markerBytesAfter) -cne [Convert]::ToBase64String($markerBytesBefore)) {
        throw "Representative CREATE_NEW rejection changed the existing marker"
    }
}
finally {
    Assert-UnderTarget -Path $testRoot
    if (Test-Path -LiteralPath $testRoot) {
        Remove-Item -LiteralPath $testRoot -Recurse -Force
    }
}

Write-Output "NATIVE_FATAL_BOUNDARY_FIXTURE_TEST=PASS"
