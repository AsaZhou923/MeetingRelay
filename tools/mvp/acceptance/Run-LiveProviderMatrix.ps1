param(
    [string]$BaseUrlEnvironmentVariable = "MEETINGRELAY_LIVE_TRANSLATION_BASE_URL",
    [Parameter(Mandatory = $true)][string]$Model,
    [string]$ApiKeyEnvironmentVariable = "MEETINGRELAY_LIVE_TRANSLATION_API_KEY",
    [ValidateRange(1, 20)][int]$SampleCount = 20,
    [string]$LogPath = "target/mvp/acceptance/live-provider-matrix.log"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if ($BaseUrlEnvironmentVariable -notmatch "^[A-Za-z_][A-Za-z0-9_]*$") {
    throw "LIVE_PROVIDER_BASE_URL_ENV_NAME_INVALID"
}
if ($ApiKeyEnvironmentVariable -notmatch "^[A-Za-z_][A-Za-z0-9_]*$") {
    throw "LIVE_PROVIDER_API_KEY_ENV_NAME_INVALID"
}

$baseUrl = [Environment]::GetEnvironmentVariable($BaseUrlEnvironmentVariable, "Process")
if ([string]::IsNullOrWhiteSpace($baseUrl)) {
    throw "LIVE_PROVIDER_BASE_URL_ENV_MISSING name=$BaseUrlEnvironmentVariable"
}
try {
    $scheme = ([Uri]$baseUrl).Scheme.ToLowerInvariant()
}
catch {
    throw "LIVE_PROVIDER_BASE_URL_INVALID"
}
if ($scheme -ne "https") {
    throw "LIVE_PROVIDER_HTTPS_REQUIRED"
}
$apiKey = [Environment]::GetEnvironmentVariable($ApiKeyEnvironmentVariable, "Process")
if ([string]::IsNullOrWhiteSpace($apiKey)) {
    throw "LIVE_PROVIDER_API_KEY_ENV_MISSING name=$ApiKeyEnvironmentVariable"
}

$resolvedLogPath = [IO.Path]::GetFullPath($LogPath)
$parent = Split-Path -Parent $resolvedLogPath
if ($parent -and -not (Test-Path -LiteralPath $parent -PathType Container)) {
    New-Item -ItemType Directory -Path $parent | Out-Null
}

$previous = @{
    MEETINGRELAY_LIVE_TRANSLATION_BASE_URL = $env:MEETINGRELAY_LIVE_TRANSLATION_BASE_URL
    MEETINGRELAY_LIVE_TRANSLATION_MODEL = $env:MEETINGRELAY_LIVE_TRANSLATION_MODEL
    MEETINGRELAY_LIVE_TRANSLATION_API_KEY = $env:MEETINGRELAY_LIVE_TRANSLATION_API_KEY
    MEETINGRELAY_LIVE_TRANSLATION_SAMPLE_COUNT = $env:MEETINGRELAY_LIVE_TRANSLATION_SAMPLE_COUNT
    MEETINGRELAY_LIVE_TRANSLATION_ALLOW_INSECURE_HTTP = $env:MEETINGRELAY_LIVE_TRANSLATION_ALLOW_INSECURE_HTTP
}

try {
    $env:MEETINGRELAY_LIVE_TRANSLATION_BASE_URL = $baseUrl
    $env:MEETINGRELAY_LIVE_TRANSLATION_MODEL = $Model
    $env:MEETINGRELAY_LIVE_TRANSLATION_API_KEY = $apiKey
    $env:MEETINGRELAY_LIVE_TRANSLATION_SAMPLE_COUNT = $SampleCount.ToString()
    Remove-Item -LiteralPath "Env:MEETINGRELAY_LIVE_TRANSLATION_ALLOW_INSECURE_HTTP" -ErrorAction SilentlyContinue

    cargo test -p meetingrelay-desktop mvp::translation::tests::live_openai_compatible_translation_matrix_when_configured --offline --locked -- --ignored --nocapture 2>&1 |
        Tee-Object -FilePath $resolvedLogPath
    if ($LASTEXITCODE -ne 0) {
        throw "LIVE_PROVIDER_MATRIX_FAILED log=$resolvedLogPath"
    }
}
finally {
    foreach ($name in $previous.Keys) {
        if ($null -eq $previous[$name]) {
            Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue
        }
        else {
            Set-Item -LiteralPath "Env:$name" -Value $previous[$name]
        }
    }
}

Write-Output "MEETINGRELAY_LIVE_PROVIDER_MATRIX_PASS log=$resolvedLogPath sample_count=$SampleCount"
