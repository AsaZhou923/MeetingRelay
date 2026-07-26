[CmdletBinding()]
param(
    [string]$FilePath,
    [switch]$AllowUnsignedTestBuild
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Test-MeetingRelaySignature {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [switch]$AllowUnsignedTestBuild
    )

    if (-not (Test-Path -LiteralPath $FilePath -PathType Leaf)) {
        throw "MEETINGRELAY_DISTRIBUTION_ARTIFACT_MISSING path=$FilePath"
    }

    $unsignedMarker = "$FilePath.unsigned-test-build"
    if ($AllowUnsignedTestBuild -and (Test-Path -LiteralPath $unsignedMarker -PathType Leaf)) {
        Write-Host "MEETINGRELAY_DISTRIBUTION_UNSIGNED_TEST_VERIFIED artifact=$FilePath"
        return [PSCustomObject]@{
            Path = [IO.Path]::GetFullPath($FilePath)
            Status = "UnsignedTestBuild"
            SignerCertificate = $null
        }
    }

    $signature = Get-AuthenticodeSignature -LiteralPath $FilePath
    if ($signature.Status -ne "Valid") {
        throw "MEETINGRELAY_DISTRIBUTION_SIGNATURE_INVALID status=$($signature.Status) artifact=$FilePath"
    }
    return [PSCustomObject]@{
        Path = [IO.Path]::GetFullPath($FilePath)
        Status = [string]$signature.Status
        SignerCertificate = $signature.SignerCertificate.Subject
    }
}

if ($MyInvocation.InvocationName -ne ".") {
    try {
        $result = Test-MeetingRelaySignature -FilePath $FilePath -AllowUnsignedTestBuild:$AllowUnsignedTestBuild
        $result | ConvertTo-Json -Depth 8
    }
    catch {
        Write-Error $_.Exception.Message
        exit 1
    }
}
