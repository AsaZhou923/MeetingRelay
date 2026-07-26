[CmdletBinding()]
param(
    [string]$RepositoryRoot,
    [string]$OutputPath = "target/distribution/windows/sbom.json"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Get-DistributionRepositoryRoot {
    $root = (& git -C $PSScriptRoot rev-parse --show-toplevel 2>$null)
    if ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace($root)) {
        return [IO.Path]::GetFullPath($root.Trim())
    }
    return [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "../.."))
}

function Get-FileSha256Lower {
    param([Parameter(Mandatory = $true)][string]$Path)
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function New-MeetingRelaySbom {
    param(
        [string]$RepositoryRoot = (Get-DistributionRepositoryRoot),
        [string]$OutputPath = "target/distribution/windows/sbom.json"
    )

    $RepositoryRoot = [IO.Path]::GetFullPath($RepositoryRoot)
    $rootPackagePath = Join-Path $RepositoryRoot "package.json"
    $desktopPackagePath = Join-Path $RepositoryRoot "apps/desktop/package.json"
    $cargoLockPath = Join-Path $RepositoryRoot "Cargo.lock"
    $assetLockPath = Join-Path $RepositoryRoot "tools/sherpa-native/assets.lock.json"

    $rootPackage = Get-Content -LiteralPath $rootPackagePath -Raw -Encoding UTF8 | ConvertFrom-Json
    $desktopPackage = Get-Content -LiteralPath $desktopPackagePath -Raw -Encoding UTF8 | ConvertFrom-Json
    $assetLock = Get-Content -LiteralPath $assetLockPath -Raw -Encoding UTF8 | ConvertFrom-Json

    $components = New-Object 'System.Collections.Generic.List[object]'
    $components.Add([PSCustomObject]@{
        type = "application"
        name = "MeetingRelay"
        version = [string]$desktopPackage.version
        purl = "pkg:generic/meetingrelay@$($desktopPackage.version)"
        licenses = @("UNLICENSED")
    }) | Out-Null

    foreach ($dependencySetName in @("dependencies", "devDependencies")) {
        $dependencySet = $desktopPackage.$dependencySetName
        if ($null -ne $dependencySet) {
            foreach ($property in $dependencySet.PSObject.Properties | Sort-Object Name) {
                $components.Add([PSCustomObject]@{
                    type = "library"
                    name = $property.Name
                    version = ([string]$property.Value).TrimStart("=")
                    scope = $dependencySetName
                    purl = "pkg:npm/$($property.Name)@$(([string]$property.Value).TrimStart('='))"
                }) | Out-Null
            }
        }
    }

    $cargoLock = Get-Content -LiteralPath $cargoLockPath -Raw -Encoding UTF8
    $cargoMatches = [regex]::Matches($cargoLock, '(?ms)\[\[package\]\]\s+name = "([^"]+)"\s+version = "([^"]+)"')
    foreach ($match in $cargoMatches) {
        $components.Add([PSCustomObject]@{
            type = "library"
            name = $match.Groups[1].Value
            version = $match.Groups[2].Value
            scope = "cargo-lock"
            purl = "pkg:cargo/$($match.Groups[1].Value)@$($match.Groups[2].Value)"
        }) | Out-Null
    }

    $components.Add([PSCustomObject]@{
        type = "library"
        name = "sherpa-onnx"
        version = [string]$assetLock.runtime.upstream_tag
        scope = "native-runtime"
        purl = "pkg:generic/sherpa-onnx@$($assetLock.runtime.upstream_tag)"
        hashes = @([PSCustomObject]@{ alg = "SHA-256"; content = [string]$assetLock.runtime.archive.sha256 })
        licenses = @([string]$assetLock.runtime.license.license_id)
    }) | Out-Null
    $components.Add([PSCustomObject]@{
        type = "machine-learning-model"
        name = [string]$assetLock.model.model_id
        version = [string]$assetLock.model.upstream_revision
        scope = "asr-model"
        hashes = @([PSCustomObject]@{ alg = "SHA-256"; content = [string]$assetLock.model.archive.sha256 })
        licenses = @([string]$assetLock.model.current_license_snapshot.license_id)
    }) | Out-Null

    $sbom = [PSCustomObject]@{
        bomFormat = "CycloneDX"
        specVersion = "1.5"
        serialNumber = "urn:uuid:$([guid]::NewGuid())"
        version = 1
        metadata = [PSCustomObject]@{
            timestamp = (Get-Date).ToUniversalTime().ToString("o")
            component = [PSCustomObject]@{
                type = "application"
                name = "MeetingRelay"
                version = [string]$desktopPackage.version
            }
            tools = @([PSCustomObject]@{
                vendor = "MeetingRelay"
                name = "tools/distribution/Generate-Sbom.ps1"
            })
        }
        components = @($components.ToArray())
        externalReferences = @(
            [PSCustomObject]@{ type = "other"; url = "file:NOTICE.md"; comment = "Project notice" },
            [PSCustomObject]@{ type = "other"; url = "file:THIRD_PARTY_NOTICES.md"; comment = "Third-party notices" }
        )
    }

    $resolvedOutput = if ([IO.Path]::IsPathRooted($OutputPath)) {
        [IO.Path]::GetFullPath($OutputPath)
    }
    else {
        [IO.Path]::GetFullPath((Join-Path $RepositoryRoot $OutputPath))
    }
    $parent = Split-Path -Parent $resolvedOutput
    if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
        New-Item -ItemType Directory -Path $parent | Out-Null
    }
    $sbom | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $resolvedOutput -Encoding UTF8
    return $sbom
}

if ($MyInvocation.InvocationName -ne ".") {
    try {
        New-MeetingRelaySbom `
            -RepositoryRoot $(if ($RepositoryRoot) { $RepositoryRoot } else { Get-DistributionRepositoryRoot }) `
            -OutputPath $OutputPath | ConvertTo-Json -Depth 20
    }
    catch {
        Write-Error $_.Exception.Message
        exit 1
    }
}
