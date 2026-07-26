[CmdletBinding()]
param(
    [string]$FilePath = $env:TAURI_SIGNING_ARTIFACT,
    [string]$CertificateThumbprint = $env:MEETINGRELAY_SIGNING_CERT_THUMBPRINT,
    [string]$CertificatePath = $env:MEETINGRELAY_SIGNING_CERT_PATH,
    [string]$CertificatePassword = $env:MEETINGRELAY_SIGNING_CERT_PASSWORD,
    [string]$TimestampUrl = $(if ($env:MEETINGRELAY_SIGNING_TIMESTAMP_URL) { $env:MEETINGRELAY_SIGNING_TIMESTAMP_URL } else { "http://timestamp.digicert.com" }),
    [switch]$UnsignedTestBuild
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot "..\shared\Initialize-MeetingRelayPowerShell.ps1")
Initialize-MeetingRelayPowerShell -RequiredModules "Microsoft.PowerShell.Security"

function Assert-DistributionSigningPolicy {
    param(
        [string]$CertificateThumbprint = $env:MEETINGRELAY_SIGNING_CERT_THUMBPRINT,
        [string]$CertificatePath = $env:MEETINGRELAY_SIGNING_CERT_PATH,
        [switch]$UnsignedTestBuild
    )

    if ($UnsignedTestBuild -or $env:MEETINGRELAY_UNSIGNED_TEST_BUILD -eq "1") {
        return
    }
    if ([string]::IsNullOrWhiteSpace($CertificateThumbprint) -and [string]::IsNullOrWhiteSpace($CertificatePath)) {
        throw "MEETINGRELAY_DISTRIBUTION_SIGNING_REQUIRED Provide -CertificateThumbprint or -CertificatePath for a formal Windows release, or pass -UnsignedTestBuild for an explicitly non-release test build."
    }
}

function Test-MeetingRelaySealedRuntimeLibArtifact {
    param([Parameter(Mandatory = $true)][string]$FilePath)

    $resolved = [IO.Path]::GetFullPath($FilePath)
    return $resolved -match '\\apps\\desktop\\src-tauri\\resources\\runtime\\lib\\[^\\]+\.dll$'
}

function Test-MeetingRelayAlreadyValidAuthenticodeSignature {
    param([Parameter(Mandatory = $true)][string]$FilePath)

    if (-not (Test-Path -LiteralPath $FilePath -PathType Leaf)) {
        throw "MEETINGRELAY_DISTRIBUTION_ARTIFACT_MISSING path=$FilePath"
    }
    $signature = Get-AuthenticodeSignature -LiteralPath $FilePath
    return $signature.Status -eq "Valid"
}

function Test-MeetingRelaySigningShouldSkip {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string]$AuthenticodeStatus
    )

    if (Test-MeetingRelaySealedRuntimeLibArtifact -FilePath $FilePath) {
        return [PSCustomObject]@{
            ShouldSkip = $true
            Reason = "sealed_runtime_lib"
        }
    }
    $status = if ([string]::IsNullOrWhiteSpace($AuthenticodeStatus)) {
        [string](Get-AuthenticodeSignature -LiteralPath $FilePath).Status
    }
    else {
        $AuthenticodeStatus
    }
    if ($status -eq "Valid") {
        return [PSCustomObject]@{
            ShouldSkip = $true
            Reason = "already_valid"
        }
    }
    return [PSCustomObject]@{
        ShouldSkip = $false
        Reason = "needs_signing"
    }
}

function Resolve-MeetingRelaySignTool {
    $command = Get-Command "signtool.exe" -ErrorAction SilentlyContinue
    if ($null -ne $command) {
        return $command.Source
    }

    $windowsKits = Join-Path ${env:ProgramFiles(x86)} "Windows Kits/10/bin"
    if (Test-Path -LiteralPath $windowsKits -PathType Container) {
        $candidate = Get-ChildItem -LiteralPath $windowsKits -Recurse -Filter "signtool.exe" -File |
            Where-Object { $_.FullName -match "\\x64\\signtool\.exe$" } |
            Sort-Object FullName -Descending |
            Select-Object -First 1
        if ($null -ne $candidate) {
            return $candidate.FullName
        }
    }

    throw "MEETINGRELAY_DISTRIBUTION_SIGNTOOL_MISSING Install Windows SDK signtool.exe."
}

function Invoke-MeetingRelayArtifactSigning {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string]$CertificateThumbprint = $env:MEETINGRELAY_SIGNING_CERT_THUMBPRINT,
        [string]$CertificatePath = $env:MEETINGRELAY_SIGNING_CERT_PATH,
        [string]$CertificatePassword = $env:MEETINGRELAY_SIGNING_CERT_PASSWORD,
        [string]$TimestampUrl = $(if ($env:MEETINGRELAY_SIGNING_TIMESTAMP_URL) { $env:MEETINGRELAY_SIGNING_TIMESTAMP_URL } else { "http://timestamp.digicert.com" }),
        [switch]$UnsignedTestBuild
    )

    if (-not (Test-Path -LiteralPath $FilePath -PathType Leaf)) {
        throw "MEETINGRELAY_DISTRIBUTION_ARTIFACT_MISSING path=$FilePath"
    }

    Assert-DistributionSigningPolicy `
        -CertificateThumbprint $CertificateThumbprint `
        -CertificatePath $CertificatePath `
        -UnsignedTestBuild:$UnsignedTestBuild

    if ($UnsignedTestBuild) {
        Set-Content -LiteralPath "$FilePath.unsigned-test-build" -Value "UnsignedTestBuild: true" -Encoding ASCII
        Write-Host "MEETINGRELAY_DISTRIBUTION_UNSIGNED_TEST_BUILD artifact=$FilePath"
        return
    }
    if ($env:MEETINGRELAY_UNSIGNED_TEST_BUILD -eq "1") {
        Write-Host "MEETINGRELAY_DISTRIBUTION_UNSIGNED_TEST_BUILD_ENV artifact=$FilePath"
        return
    }

    $skipDecision = Test-MeetingRelaySigningShouldSkip -FilePath $FilePath
    if ($skipDecision.ShouldSkip) {
        Write-Host "MEETINGRELAY_DISTRIBUTION_SIGN_SKIP $($skipDecision.Reason) artifact=$FilePath"
        return
    }

    $signTool = Resolve-MeetingRelaySignTool
    $arguments = @("sign", "/fd", "SHA256", "/tr", $TimestampUrl, "/td", "SHA256")
    if (-not [string]::IsNullOrWhiteSpace($CertificateThumbprint)) {
        $arguments += @("/sha1", $CertificateThumbprint)
    }
    else {
        if (-not (Test-Path -LiteralPath $CertificatePath -PathType Leaf)) {
            throw "MEETINGRELAY_DISTRIBUTION_CERTIFICATE_MISSING path=$CertificatePath"
        }
        $arguments += @("/f", $CertificatePath)
        if (-not [string]::IsNullOrEmpty($CertificatePassword)) {
            $arguments += @("/p", $CertificatePassword)
        }
    }
    $arguments += $FilePath

    & $signTool @arguments
    if ($LASTEXITCODE -ne 0) {
        throw "MEETINGRELAY_DISTRIBUTION_SIGNING_FAILED exit=$LASTEXITCODE artifact=$FilePath"
    }
}

if ($MyInvocation.InvocationName -ne ".") {
    try {
        Invoke-MeetingRelayArtifactSigning `
            -FilePath $FilePath `
            -CertificateThumbprint $CertificateThumbprint `
            -CertificatePath $CertificatePath `
            -CertificatePassword $CertificatePassword `
            -TimestampUrl $TimestampUrl `
            -UnsignedTestBuild:$UnsignedTestBuild
    }
    catch {
        Write-Error $_.Exception.Message
        exit 1
    }
}
