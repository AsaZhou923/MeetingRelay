$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot "release.ps1")

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

function Assert-Contains {
    param(
        [Parameter(Mandatory = $true)][string]$Needle,
        [Parameter(Mandatory = $true)][string]$Haystack,
        [Parameter(Mandatory = $true)][string]$Label
    )
    if (-not $Haystack.Contains($Needle)) {
        throw "ASSERT_CONTAINS_FAILED label=$Label needle=$Needle"
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

$repoRoot = Get-MvpRepositoryRoot
$resolved = Resolve-MvpTargetPath `
    -RepositoryRoot $repoRoot `
    -Value "target/mvp/release-test" `
    -Label "test-output"
Assert-Equal `
    -Expected ([IO.Path]::GetFullPath((Join-Path $repoRoot "target/mvp/release-test"))) `
    -Actual $resolved `
    -Label "relative output resolves under target"

Assert-ThrowsLike `
    -Action {
        Resolve-MvpTargetPath `
            -RepositoryRoot $repoRoot `
            -Value "tools/mvp/not-target" `
            -Label "bad-output"
    } `
    -Pattern "MVP_RELEASE_PATH_INVALID*" `
    -Label "output outside target rejected"

$testRoot = Join-Path $repoRoot "target/mvp/release-test"
New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
foreach ($fileName in @(
    "MeetingRelay.exe",
    "MeetingRelay.same-machine.ps1",
    "locks/assets.lock.json",
    "locks/Cargo.lock",
    "model/model.int8.onnx",
    "model/tokens.txt",
    "model/test_wavs/zh.wav",
    "runtime/lib/onnxruntime.dll",
    "runtime/lib/onnxruntime.lib",
    "runtime/lib/onnxruntime_providers_shared.dll",
    "runtime/lib/sherpa-onnx-c-api.dll",
    "runtime/lib/sherpa-onnx-c-api.lib",
    "runtime/lib/sherpa-onnx-cxx-api.dll",
    "runtime/lib/sherpa-onnx-cxx-api.lib",
    "onnxruntime.dll",
    "onnxruntime_providers_shared.dll",
    "sherpa-onnx-c-api.dll",
    "sherpa-onnx-cxx-api.dll"
)) {
    $path = Join-Path $testRoot $fileName
    $parent = Split-Path -Parent $path
    if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
        New-Item -ItemType Directory -Path $parent | Out-Null
    }
    Set-Content -LiteralPath $path -Value "test" -Encoding ASCII
}
Assert-MvpPersonalReleaseOutput -OutputRoot $testRoot -ExecutableName "MeetingRelay.exe"
Remove-Item -LiteralPath (Join-Path $testRoot "runtime/lib/sherpa-onnx-cxx-api.dll") -Force
Assert-ThrowsLike `
    -Action { Assert-MvpPersonalReleaseOutput -OutputRoot $testRoot -ExecutableName "MeetingRelay.exe" } `
    -Pattern "MVP_RELEASE_OUTPUT_INVALID*" `
    -Label "missing runtime dll rejected"

$launchEnvironment = @{
    MEETINGRELAY_SHERPA_LOCK = "C:\locked\assets.lock.json"
    MEETINGRELAY_SHERPA_LOCK_SHA256 = "lock-sha"
    MEETINGRELAY_SHERPA_PARAMETER_SHA256 = "parameter-sha"
    SHERPA_ONNX_LIB_DIR = "C:\locked\runtime\lib"
    MEETINGRELAY_SHERPA_MODEL = "C:\locked\model with 'quote'.onnx"
    MEETINGRELAY_SHERPA_MODEL_SHA256 = "model-sha"
    MEETINGRELAY_SHERPA_TOKENS = "C:\locked\tokens.txt"
    MEETINGRELAY_SHERPA_TOKENS_SHA256 = "tokens-sha"
    MEETINGRELAY_SHERPA_WAV = "C:\locked\smoke.wav"
}
$launcherPath = Join-Path $testRoot "GeneratedMeetingRelay.ps1"
New-MvpReleaseLauncher `
    -LauncherPath $launcherPath `
    -ExecutableName "MeetingRelay.exe" `
    -Environment $launchEnvironment `
    -PackagePaths @{
        MEETINGRELAY_SHERPA_LOCK = "locks/assets.lock.json"
        MEETINGRELAY_PACKAGE_LOCK = "locks/Cargo.lock"
        SHERPA_ONNX_LIB_DIR = "runtime/lib"
        MEETINGRELAY_SHERPA_MODEL = "model/model.int8.onnx"
        MEETINGRELAY_SHERPA_TOKENS = "model/tokens.txt"
        MEETINGRELAY_SHERPA_WAV = "model/test_wavs/zh.wav"
    }
$launcher = Get-Content -LiteralPath $launcherPath -Raw
Assert-Contains `
    -Needle '$env:SHERPA_ONNX_LIB_DIR = Join-Path $launcherRoot ''runtime/lib''' `
    -Haystack $launcher `
    -Label "runtime lib env derived from launcher"
Assert-Contains `
    -Needle '$env:MEETINGRELAY_PACKAGE_LOCK = Join-Path $launcherRoot ''locks/Cargo.lock''' `
    -Haystack $launcher `
    -Label "package lock env derived from launcher"
Assert-Contains `
    -Needle '$env:MEETINGRELAY_SHERPA_MODEL_SHA256 = ''model-sha''' `
    -Haystack $launcher `
    -Label "model hash env preserved"
Assert-Contains `
    -Needle '$env:PATH = $launcherRoot + [IO.Path]::PathSeparator + $env:PATH' `
    -Haystack $launcher `
    -Label "launcher gives local dlls precedence"
Assert-Contains `
    -Needle 'Start-Process -FilePath $exePath -ArgumentList $resolvedAppArguments -Wait -PassThru' `
    -Haystack $launcher `
    -Label "launcher waits on gui process"
Assert-MvpLauncherHasNoWorkspaceReference -LauncherPath $launcherPath -RepositoryRoot $repoRoot

Write-Output "MEETINGRELAY_MVP_RELEASE_TEST_PASS assertions=10"
