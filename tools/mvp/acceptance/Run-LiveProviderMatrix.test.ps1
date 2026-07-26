$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

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
        return $_.Exception.Message
    }
    throw "ASSERT_THROW_MISSING label=$Label"
}

function Assert-NotContains {
    param(
        [Parameter(Mandatory = $true)][string]$Value,
        [Parameter(Mandatory = $true)][string]$Needle,
        [Parameter(Mandatory = $true)][string]$Label
    )
    if ($Value.IndexOf($Needle, [StringComparison]::Ordinal) -ge 0) {
        throw "ASSERT_NOT_CONTAINS_FAILED label=$Label"
    }
}

$scriptPath = Join-Path $PSScriptRoot "Run-LiveProviderMatrix.ps1"
$baseName = "MEETINGRELAY_TEST_LIVE_BASE_URL"
$keyName = "MEETINGRELAY_TEST_LIVE_API_KEY"
$previousBase = [Environment]::GetEnvironmentVariable($baseName, "Process")
$previousKey = [Environment]::GetEnvironmentVariable($keyName, "Process")

try {
    [Environment]::SetEnvironmentVariable($baseName, $null, "Process")
    [Environment]::SetEnvironmentVariable($keyName, $null, "Process")
    Assert-ThrowsLike `
        -Action { & $scriptPath -Model "test-model" -BaseUrlEnvironmentVariable $baseName -ApiKeyEnvironmentVariable $keyName } `
        -Pattern "LIVE_PROVIDER_BASE_URL_ENV_MISSING*" `
        -Label "missing endpoint rejected" | Out-Null

    $httpEndpoint = "http://sensitive.example.invalid/v1"
    [Environment]::SetEnvironmentVariable($baseName, $httpEndpoint, "Process")
    $httpError = Assert-ThrowsLike `
        -Action { & $scriptPath -Model "test-model" -BaseUrlEnvironmentVariable $baseName -ApiKeyEnvironmentVariable $keyName } `
        -Pattern "LIVE_PROVIDER_HTTPS_REQUIRED" `
        -Label "http endpoint rejected"
    Assert-NotContains -Value $httpError -Needle $httpEndpoint -Label "endpoint omitted from error"

    [Environment]::SetEnvironmentVariable($baseName, "https://example.invalid/v1", "Process")
    Assert-ThrowsLike `
        -Action { & $scriptPath -Model "test-model" -BaseUrlEnvironmentVariable $baseName -ApiKeyEnvironmentVariable $keyName } `
        -Pattern "LIVE_PROVIDER_API_KEY_ENV_MISSING*" `
        -Label "missing api key rejected" | Out-Null
}
finally {
    [Environment]::SetEnvironmentVariable($baseName, $previousBase, "Process")
    [Environment]::SetEnvironmentVariable($keyName, $previousKey, "Process")
}

Write-Output "MEETINGRELAY_LIVE_PROVIDER_MATRIX_TEST_PASS assertions=4"
