$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot "start.ps1")

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

$validOutput = @(
    "validator informational output",
    "MEETINGRELAY_SHERPA_LOCK=C:\locked\assets.lock.json",
    "MEETINGRELAY_SHERPA_LOCK_SHA256=lock-sha",
    "MEETINGRELAY_SHERPA_PARAMETER_SHA256=parameter-sha",
    "SHERPA_ONNX_LIB_DIR=C:\locked\runtime\lib",
    "MEETINGRELAY_SHERPA_MODEL=C:\locked\model.onnx",
    "MEETINGRELAY_SHERPA_MODEL_SHA256=model-sha",
    "MEETINGRELAY_SHERPA_TOKENS=C:\locked\tokens.txt",
    "MEETINGRELAY_SHERPA_TOKENS_SHA256=tokens-sha",
    "MEETINGRELAY_SHERPA_WAV=C:\locked\smoke.wav"
)

$parsed = ConvertFrom-MvpEnvironmentOutput -Output $validOutput
Assert-Equal -Expected 9 -Actual $parsed.Count -Label "all allowlisted assignments parsed"
Assert-Equal -Expected "C:\locked\runtime\lib" -Actual $parsed["SHERPA_ONNX_LIB_DIR"] -Label "runtime path preserved literally"

Assert-ThrowsLike `
    -Action { ConvertFrom-MvpEnvironmentOutput -Output ($validOutput + "PATH=C:\untrusted") } `
    -Pattern "MVP_ASSET_ENV_INVALID unexpected_name=PATH" `
    -Label "unexpected assignment rejected"

Assert-ThrowsLike `
    -Action { ConvertFrom-MvpEnvironmentOutput -Output ($validOutput + $validOutput[1]) } `
    -Pattern "MVP_ASSET_ENV_INVALID duplicate_name=MEETINGRELAY_SHERPA_LOCK" `
    -Label "duplicate assignment rejected"

Assert-ThrowsLike `
    -Action { ConvertFrom-MvpEnvironmentOutput -Output $validOutput[0..8] } `
    -Pattern "MVP_ASSET_ENV_INVALID missing_name=MEETINGRELAY_SHERPA_WAV" `
    -Label "missing assignment rejected"

$env:MEETINGRELAY_MVP_TEST_SENTINEL = "before"
$previous = Set-MvpEnvironment -Values @{ MEETINGRELAY_MVP_TEST_SENTINEL = "during" }
Assert-Equal -Expected "during" -Actual $env:MEETINGRELAY_MVP_TEST_SENTINEL -Label "environment applied"
Restore-MvpEnvironment -Previous $previous
Assert-Equal -Expected "before" -Actual $env:MEETINGRELAY_MVP_TEST_SENTINEL -Label "environment restored"
Remove-Item -LiteralPath "Env:MEETINGRELAY_MVP_TEST_SENTINEL"

$previousAbsent = Set-MvpEnvironment -Values @{ MEETINGRELAY_MVP_TEST_ABSENT = "temporary" }
Restore-MvpEnvironment -Previous $previousAbsent
Assert-Equal -Expected $false -Actual (Test-Path -LiteralPath "Env:MEETINGRELAY_MVP_TEST_ABSENT") -Label "absent environment removed"

Write-Output "MEETINGRELAY_MVP_LAUNCHER_TEST_PASS assertions=8"
