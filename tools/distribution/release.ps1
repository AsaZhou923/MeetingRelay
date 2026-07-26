[CmdletBinding()]
param(
    [string]$OutputRoot = "target/distribution/windows",
    [string]$CertificateThumbprint = $env:MEETINGRELAY_SIGNING_CERT_THUMBPRINT,
    [string]$CertificatePath = $env:MEETINGRELAY_SIGNING_CERT_PATH,
    [string]$CertificatePassword = $env:MEETINGRELAY_SIGNING_CERT_PASSWORD,
    [string]$TimestampUrl = $(if ($env:MEETINGRELAY_SIGNING_TIMESTAMP_URL) { $env:MEETINGRELAY_SIGNING_TIMESTAMP_URL } else { "http://timestamp.digicert.com" }),
    [switch]$UnsignedTestBuild,
    [switch]$AllowDownload,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$distributionInvocationParameters = @{
    OutputRoot = $OutputRoot
    CertificateThumbprint = $CertificateThumbprint
    CertificatePath = $CertificatePath
    CertificatePassword = $CertificatePassword
    TimestampUrl = $TimestampUrl
    UnsignedTestBuild = $UnsignedTestBuild
    AllowDownload = $AllowDownload
    DryRun = $DryRun
}
. (Join-Path $PSScriptRoot "Sign-ReleaseArtifact.ps1")
. (Join-Path $PSScriptRoot "Verify-ReleaseArtifact.ps1")
. (Join-Path $PSScriptRoot "Generate-Sbom.ps1")
. (Join-Path $PSScriptRoot "Test-DataRetention.ps1")
. (Join-Path $PSScriptRoot "Stage-DistributionResources.ps1")
$OutputRoot = $distributionInvocationParameters.OutputRoot
$CertificateThumbprint = $distributionInvocationParameters.CertificateThumbprint
$CertificatePath = $distributionInvocationParameters.CertificatePath
$CertificatePassword = $distributionInvocationParameters.CertificatePassword
$TimestampUrl = $distributionInvocationParameters.TimestampUrl
$UnsignedTestBuild = $distributionInvocationParameters.UnsignedTestBuild
$AllowDownload = $distributionInvocationParameters.AllowDownload
$DryRun = $distributionInvocationParameters.DryRun

function Resolve-DistributionTargetPath {
    param(
        [Parameter(Mandatory = $true)][string]$RepositoryRoot,
        [Parameter(Mandatory = $true)][string]$Value,
        [Parameter(Mandatory = $true)][string]$Label
    )

    $targetRoot = [IO.Path]::GetFullPath((Join-Path $RepositoryRoot "target"))
    $candidate = if ([IO.Path]::IsPathRooted($Value)) {
        [IO.Path]::GetFullPath($Value)
    }
    else {
        [IO.Path]::GetFullPath((Join-Path $RepositoryRoot $Value))
    }
    $prefix = $targetRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    if (-not $candidate.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "MEETINGRELAY_DISTRIBUTION_PATH_INVALID label=$Label path=$candidate expected_root=$targetRoot"
    }
    return $candidate
}

function Get-MeetingRelayDesktopPackageVersion {
    param([string]$RepositoryRoot = (Get-DistributionRepositoryRoot))

    $package = Get-Content -LiteralPath (Join-Path $RepositoryRoot "apps/desktop/package.json") -Raw -Encoding UTF8 | ConvertFrom-Json
    if ([string]::IsNullOrWhiteSpace([string]$package.version)) {
        throw "MEETINGRELAY_DISTRIBUTION_VERSION_MISSING"
    }
    return [string]$package.version
}

function Get-MeetingRelayCurrentInstallerFileName {
    param([Parameter(Mandatory = $true)][string]$Version)

    if ($Version -notmatch '^\d+\.\d+\.\d+([-.+][0-9A-Za-z.-]+)?$') {
        throw "MEETINGRELAY_DISTRIBUTION_VERSION_INVALID version=$Version"
    }
    return "MeetingRelay_$($Version)_x64-setup.exe"
}

function Assert-MeetingRelayDistributionOutputRoot {
    param(
        [Parameter(Mandatory = $true)][string]$RepositoryRoot,
        [Parameter(Mandatory = $true)][string]$OutputRoot
    )

    $expectedRoot = [IO.Path]::GetFullPath((Join-Path $RepositoryRoot "target/distribution/windows"))
    $resolvedOutput = [IO.Path]::GetFullPath($OutputRoot)
    if (-not $resolvedOutput.Equals($expectedRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw "MEETINGRELAY_DISTRIBUTION_OUTPUT_ROOT_INVALID path=$resolvedOutput expected=$expectedRoot"
    }
    return $resolvedOutput
}

function Clear-MeetingRelayDistributionOutput {
    param(
        [Parameter(Mandatory = $true)][string]$RepositoryRoot,
        [Parameter(Mandatory = $true)][string]$OutputRoot
    )

    $resolvedOutput = Assert-MeetingRelayDistributionOutputRoot -RepositoryRoot $RepositoryRoot -OutputRoot $OutputRoot
    if (-not (Test-Path -LiteralPath $resolvedOutput -PathType Container)) {
        New-Item -ItemType Directory -Path $resolvedOutput | Out-Null
        return
    }
    $targets = @()
    $targets += @(Get-ChildItem -LiteralPath $resolvedOutput -Filter "*.exe" -File -Force)
    $targets += @(Get-ChildItem -LiteralPath $resolvedOutput -Filter "*.exe.unsigned-test-build" -File -Force)
    foreach ($name in @("release-manifest.json")) {
        $path = Join-Path $resolvedOutput $name
        if (Test-Path -LiteralPath $path -PathType Leaf) {
            $targets += @(Get-Item -LiteralPath $path -Force)
        }
    }
    foreach ($target in $targets) {
        $targetPath = [IO.Path]::GetFullPath($target.FullName)
        $prefix = $resolvedOutput.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
        if (-not $targetPath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
            throw "MEETINGRELAY_DISTRIBUTION_OUTPUT_DELETE_TARGET_INVALID path=$targetPath root=$resolvedOutput"
        }
        Remove-Item -LiteralPath $targetPath -Force
    }
}

function Get-MeetingRelayCurrentBundleInstaller {
    param(
        [Parameter(Mandatory = $true)][string]$RepositoryRoot,
        [Parameter(Mandatory = $true)][string]$Version
    )

    $bundleRoot = Join-Path $RepositoryRoot "target/release/bundle/nsis"
    $installerName = Get-MeetingRelayCurrentInstallerFileName -Version $Version
    $installerPath = Join-Path $bundleRoot $installerName
    if (-not (Test-Path -LiteralPath $installerPath -PathType Leaf)) {
        throw "MEETINGRELAY_DISTRIBUTION_INSTALLER_MISSING path=$installerPath"
    }
    return [IO.Path]::GetFullPath($installerPath)
}

function Assert-MeetingRelayReleaseRoot {
    param(
        [Parameter(Mandatory = $true)][string]$RepositoryRoot,
        [Parameter(Mandatory = $true)][string]$ReleaseRoot
    )

    $expectedRoot = [IO.Path]::GetFullPath((Join-Path $RepositoryRoot "target/release"))
    $resolvedRoot = [IO.Path]::GetFullPath($ReleaseRoot)
    if (-not $resolvedRoot.Equals($expectedRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw "MEETINGRELAY_DISTRIBUTION_RELEASE_ROOT_INVALID path=$resolvedRoot expected=$expectedRoot"
    }
    return $resolvedRoot
}

function Test-MeetingRelayPathDescendant {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$Path
    )

    $resolvedRoot = [IO.Path]::GetFullPath($Root).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
    $resolvedPath = [IO.Path]::GetFullPath($Path)
    $prefix = $resolvedRoot + [IO.Path]::DirectorySeparatorChar
    return $resolvedPath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
}

function Clear-MeetingRelayReleaseUnsignedMarkers {
    param(
        [Parameter(Mandatory = $true)][string]$RepositoryRoot,
        [string]$ReleaseRoot
    )

    if ([string]::IsNullOrWhiteSpace($ReleaseRoot)) {
        $ReleaseRoot = Join-Path $RepositoryRoot "target/release"
    }
    $resolvedRoot = Assert-MeetingRelayReleaseRoot -RepositoryRoot $RepositoryRoot -ReleaseRoot $ReleaseRoot
    if (-not (Test-Path -LiteralPath $resolvedRoot -PathType Container)) {
        return
    }
    foreach ($marker in @(Get-ChildItem -LiteralPath $resolvedRoot -Recurse -Filter "*.unsigned-test-build" -File -Force)) {
        $markerPath = [IO.Path]::GetFullPath($marker.FullName)
        if (-not (Test-MeetingRelayPathDescendant -Root $resolvedRoot -Path $markerPath)) {
            throw "MEETINGRELAY_DISTRIBUTION_RELEASE_MARKER_DELETE_TARGET_INVALID path=$markerPath root=$resolvedRoot"
        }
        Remove-Item -LiteralPath $markerPath -Force
    }
}

function Get-MeetingRelayDistributionConfig {
    param([string]$RepositoryRoot = (Get-DistributionRepositoryRoot))
    $configPath = Join-Path $RepositoryRoot "apps/desktop/src-tauri/tauri.conf.json"
    if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
        throw "MEETINGRELAY_DISTRIBUTION_CONFIG_MISSING path=$configPath"
    }
    return Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
}

function Assert-MeetingRelayDistributionConfig {
    param([string]$RepositoryRoot = (Get-DistributionRepositoryRoot))

    $config = Get-MeetingRelayDistributionConfig -RepositoryRoot $RepositoryRoot
    if ($config.bundle.active -ne $true) {
        throw "MEETINGRELAY_DISTRIBUTION_CONFIG_INVALID bundle.active must be true"
    }
    if (@($config.bundle.targets).Count -ne 1 -or [string]$config.bundle.targets[0] -ne "nsis") {
        throw "MEETINGRELAY_DISTRIBUTION_CONFIG_INVALID bundle.targets must be ['nsis']"
    }
    if ($config.bundle.windows.nsis.installMode -ne "currentUser") {
        throw "MEETINGRELAY_DISTRIBUTION_CONFIG_INVALID nsis.installMode must be currentUser"
    }
    if ($config.bundle.windows.allowDowngrades -ne $false) {
        throw "MEETINGRELAY_DISTRIBUTION_CONFIG_INVALID windows.allowDowngrades must be false"
    }
    if ($config.bundle.windows.nsis.installerHooks -ne "../../../tools/distribution/nsis-hooks.nsh") {
        throw "MEETINGRELAY_DISTRIBUTION_CONFIG_INVALID nsis.installerHooks must point at ../../../tools/distribution/nsis-hooks.nsh"
    }
    $resourceMap = $config.bundle.resources
    $resourceEntry = $resourceMap.PSObject.Properties | Where-Object { $_.Name -eq "resources/" } | Select-Object -First 1
    if ($null -eq $resourceEntry -or $resourceEntry.Value -ne "") {
        throw "MEETINGRELAY_DISTRIBUTION_CONFIG_INVALID bundle.resources must map resources/ to empty string"
    }
}

function Get-MeetingRelayDistributionStatuses {
    param([string]$RepositoryRoot = (Get-DistributionRepositoryRoot))

    $lockPath = Join-Path $RepositoryRoot "tools/sherpa-native/assets.lock.json"
    if (-not (Test-Path -LiteralPath $lockPath -PathType Leaf)) {
        throw "MEETINGRELAY_DISTRIBUTION_ASSET_LOCK_MISSING path=$lockPath"
    }
    $lock = Get-Content -LiteralPath $lockPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $statuses = New-Object 'System.Collections.Generic.List[object]'
    $candidates = @(
        @{ path = "scope.distribution_status"; value = $lock.scope.distribution_status },
        @{ path = "runtime.license.distribution_status"; value = $lock.runtime.license.distribution_status },
        @{ path = "runtime.onnxruntime_license.distribution_status"; value = $lock.runtime.onnxruntime_license.distribution_status },
        @{ path = "model.current_license_snapshot.distribution_status"; value = $lock.model.current_license_snapshot.distribution_status }
    )
    foreach ($candidate in $candidates) {
        $statuses.Add([PSCustomObject]@{
            path = $candidate.path
            status = [string]$candidate.value
        }) | Out-Null
    }
    return @($statuses.ToArray())
}

function Assert-MeetingRelayDistributionAssetApproval {
    param(
        [string]$RepositoryRoot = (Get-DistributionRepositoryRoot),
        [switch]$UnsignedTestBuild
    )

    $statuses = @(Get-MeetingRelayDistributionStatuses -RepositoryRoot $RepositoryRoot)
    $pending = @($statuses | Where-Object { $_.status -ne "approved-for-distribution" })
    if (@($pending).Count -gt 0 -and -not $UnsignedTestBuild) {
        $summary = (@($pending | ForEach-Object { "$($_.path)=$($_.status)" }) -join ",")
        throw "MEETINGRELAY_DISTRIBUTION_ASSET_NOT_APPROVED $summary"
    }
    return [PSCustomObject]@{
        mode = $(if (@($pending).Count -eq 0) { "approved-for-distribution" } else { "pending" })
        statuses = $statuses
    }
}

function New-MeetingRelayDistributionManifest {
    param(
        [Parameter(Mandatory = $true)][string]$RepositoryRoot,
        [Parameter(Mandatory = $true)][string]$OutputRoot,
        [Parameter(Mandatory = $true)][string[]]$Artifacts,
        [switch]$UnsignedTestBuild,
        [object]$AssetApproval,
        [object]$BundledSignatures,
        [object]$Verification
    )

    $package = Get-Content -LiteralPath (Join-Path $RepositoryRoot "apps/desktop/package.json") -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($null -eq $AssetApproval) {
        $AssetApproval = Assert-MeetingRelayDistributionAssetApproval -RepositoryRoot $RepositoryRoot -UnsignedTestBuild:$UnsignedTestBuild
    }
    $records = foreach ($artifact in $Artifacts) {
        [PSCustomObject]@{
            path = [IO.Path]::GetFullPath($artifact)
            fileName = Split-Path -Leaf $artifact
            sizeBytes = (Get-Item -LiteralPath $artifact -Force).Length
            sha256 = Get-MeetingRelayFileSha256 -Path $artifact
        }
    }
    return [PSCustomObject]@{
        product = "MeetingRelay"
        version = [string]$package.version
        createdAt = (Get-Date).ToUniversalTime().ToString("o")
        installer = [PSCustomObject]@{
            type = "nsis"
            installMode = "currentUser"
            allowDowngrades = $false
        }
        signing = [PSCustomObject]@{
            mode = $(if ($UnsignedTestBuild) { "unsigned-test-build" } else { "authenticode-required" })
        }
        license = [PSCustomObject]@{
            mode = [string]$AssetApproval.mode
            distributionStatuses = @($AssetApproval.statuses)
        }
        bundledSignatures = $BundledSignatures
        verification = $Verification
        retention = Test-MeetingRelayDistributionDataRetention -RepositoryRoot $RepositoryRoot
        artifacts = @($records)
    }
}

function Get-MeetingRelayRootRuntimeDllPaths {
    param(
        [string]$RepositoryRoot = (Get-DistributionRepositoryRoot),
        [string]$ResourcesRoot,
        [string]$ReleaseRoot
    )

    if ([string]::IsNullOrWhiteSpace($ResourcesRoot) -and [string]::IsNullOrWhiteSpace($ReleaseRoot)) {
        $ResourcesRoot = Join-Path $RepositoryRoot "apps/desktop/src-tauri/resources"
    }
    $root = if (-not [string]::IsNullOrWhiteSpace($ReleaseRoot)) { $ReleaseRoot } else { $ResourcesRoot }
    $lockPath = Join-Path $RepositoryRoot "tools/sherpa-native/assets.lock.json"
    $lock = Get-Content -LiteralPath $lockPath -Raw -Encoding UTF8 | ConvertFrom-Json
    return @($lock.runtime.archive.inventory |
        Where-Object { ([string]$_.path).StartsWith("lib/", [StringComparison]::Ordinal) -and ([string]$_.path).EndsWith(".dll", [StringComparison]::OrdinalIgnoreCase) } |
        ForEach-Object { Join-Path $root (Split-Path -Leaf ([string]$_.path)) })
}

function Invoke-MeetingRelayFormalBundledResourceSigning {
    param(
        [Parameter(Mandatory = $true)][string]$RepositoryRoot,
        [Parameter(Mandatory = $true)][object]$StageManifest,
        [string]$CertificateThumbprint = $env:MEETINGRELAY_SIGNING_CERT_THUMBPRINT,
        [string]$CertificatePath = $env:MEETINGRELAY_SIGNING_CERT_PATH,
        [string]$CertificatePassword = $env:MEETINGRELAY_SIGNING_CERT_PASSWORD,
        [string]$TimestampUrl = $(if ($env:MEETINGRELAY_SIGNING_TIMESTAMP_URL) { $env:MEETINGRELAY_SIGNING_TIMESTAMP_URL } else { "http://timestamp.digicert.com" }),
        [switch]$UnsignedTestBuild
    )

    if ($UnsignedTestBuild) {
        return [PSCustomObject]@{
            mode = "skipped-unsigned-test-build"
            targets = @()
        }
    }

    $resourcesRoot = [string]$StageManifest.resourcesRoot
    $targets = @(Get-MeetingRelayRootRuntimeDllPaths -RepositoryRoot $RepositoryRoot -ResourcesRoot $resourcesRoot)
    foreach ($target in $targets) {
        if (-not (Test-Path -LiteralPath $target -PathType Leaf)) {
            throw "MEETINGRELAY_DISTRIBUTION_ROOT_DLL_MISSING path=$target"
        }
        Invoke-MeetingRelayArtifactSigning `
            -FilePath $target `
            -CertificateThumbprint $CertificateThumbprint `
            -CertificatePath $CertificatePath `
            -CertificatePassword $CertificatePassword `
            -TimestampUrl $TimestampUrl
    }
    $null = Update-MeetingRelayDistributionResourcesManifest -StageManifest $StageManifest
    return [PSCustomObject]@{
        mode = "signed"
        targets = @($targets | ForEach-Object {
            [PSCustomObject]@{
                path = [IO.Path]::GetFullPath($_)
                sha256 = Get-MeetingRelayFileSha256 -Path $_
                sizeBytes = (Get-Item -LiteralPath $_ -Force).Length
            }
        })
    }
}

function Get-MeetingRelayFormalVerificationTargets {
    param(
        [Parameter(Mandatory = $true)][string]$RepositoryRoot,
        [string[]]$Installers = @(),
        [string]$ReleaseRoot
    )

    if ([string]::IsNullOrWhiteSpace($ReleaseRoot)) {
        $ReleaseRoot = Join-Path $RepositoryRoot "target/release"
    }
    $targets = New-Object 'System.Collections.Generic.List[object]'
    $targets.Add([PSCustomObject]@{
        kind = "main-executable"
        path = [IO.Path]::GetFullPath((Join-Path $ReleaseRoot "meetingrelay-desktop.exe"))
    }) | Out-Null
    foreach ($dll in @(Get-MeetingRelayRootRuntimeDllPaths -RepositoryRoot $RepositoryRoot -ReleaseRoot $ReleaseRoot)) {
        $targets.Add([PSCustomObject]@{
            kind = "bundled-runtime-dll"
            path = [IO.Path]::GetFullPath($dll)
        }) | Out-Null
    }
    foreach ($installer in @($Installers)) {
        $targets.Add([PSCustomObject]@{
            kind = "installer"
            path = [IO.Path]::GetFullPath($installer)
        }) | Out-Null
    }
    return @($targets.ToArray())
}

function Test-MeetingRelayFormalReleaseSignatures {
    param(
        [Parameter(Mandatory = $true)][string]$RepositoryRoot,
        [string[]]$Installers = @(),
        [string]$ReleaseRoot,
        [switch]$UnsignedTestBuild
    )

    $targets = @(Get-MeetingRelayFormalVerificationTargets -RepositoryRoot $RepositoryRoot -Installers $Installers -ReleaseRoot $ReleaseRoot)
    if ($UnsignedTestBuild) {
        return [PSCustomObject]@{
            mode = "skipped-unsigned-test-build"
            targets = @($targets)
        }
    }

    $evidence = New-Object 'System.Collections.Generic.List[object]'
    foreach ($target in $targets) {
        if (-not (Test-Path -LiteralPath $target.path -PathType Leaf)) {
            throw "MEETINGRELAY_DISTRIBUTION_SIGNATURE_TARGET_MISSING kind=$($target.kind) path=$($target.path)"
        }
        $signature = Test-MeetingRelaySignature -FilePath $target.path
        $evidence.Add([PSCustomObject]@{
            kind = $target.kind
            path = $target.path
            status = [string]$signature.Status
            signerCertificate = $signature.SignerCertificate
            sha256 = Get-MeetingRelayFileSha256 -Path $target.path
            sizeBytes = (Get-Item -LiteralPath $target.path -Force).Length
        }) | Out-Null
    }
    return [PSCustomObject]@{
        mode = "verified"
        targets = @($evidence.ToArray())
    }
}

function Assert-MeetingRelaySealedRuntimeLibInventory {
    param(
        [Parameter(Mandatory = $true)][string]$RepositoryRoot,
        [Parameter(Mandatory = $true)][string]$RuntimeLibRoot
    )

    $resolvedRoot = [IO.Path]::GetFullPath($RuntimeLibRoot)
    if (-not (Test-Path -LiteralPath $resolvedRoot -PathType Container)) {
        throw "MEETINGRELAY_DISTRIBUTION_RUNTIME_LIB_MISSING path=$resolvedRoot"
    }
    $lock = Get-Content -LiteralPath (Join-Path $RepositoryRoot "tools/sherpa-native/assets.lock.json") -Raw -Encoding UTF8 | ConvertFrom-Json
    $expected = @{}
    foreach ($record in @($lock.runtime.archive.inventory | Where-Object { ([string]$_.path).StartsWith("lib/", [StringComparison]::Ordinal) })) {
        $expected[(Split-Path -Leaf ([string]$record.path)).ToLowerInvariant()] = $true
    }
    $actual = @(Get-ChildItem -LiteralPath $resolvedRoot -File -Force)
    foreach ($file in $actual) {
        if (-not $expected.ContainsKey($file.Name.ToLowerInvariant())) {
            throw "MEETINGRELAY_DISTRIBUTION_RUNTIME_LIB_UNSEALED_ENTRY path=$($file.FullName)"
        }
    }
    if ($actual.Count -ne $expected.Count) {
        throw "MEETINGRELAY_DISTRIBUTION_RUNTIME_LIB_INVENTORY_MISMATCH expected=$($expected.Count) actual=$($actual.Count)"
    }
}

function Invoke-MeetingRelayDistributionRelease {
    param(
        [string]$OutputRoot = "target/distribution/windows",
        [string]$CertificateThumbprint = $env:MEETINGRELAY_SIGNING_CERT_THUMBPRINT,
        [string]$CertificatePath = $env:MEETINGRELAY_SIGNING_CERT_PATH,
        [string]$CertificatePassword = $env:MEETINGRELAY_SIGNING_CERT_PASSWORD,
        [string]$TimestampUrl = $(if ($env:MEETINGRELAY_SIGNING_TIMESTAMP_URL) { $env:MEETINGRELAY_SIGNING_TIMESTAMP_URL } else { "http://timestamp.digicert.com" }),
        [switch]$UnsignedTestBuild,
        [switch]$AllowDownload,
        [switch]$DryRun
    )

    if ($env:OS -ne "Windows_NT") {
        throw "MEETINGRELAY_DISTRIBUTION_PLATFORM_UNSUPPORTED expected=windows"
    }

    $repoRoot = Get-DistributionRepositoryRoot
    $resolvedOutput = Resolve-DistributionTargetPath -RepositoryRoot $repoRoot -Value $OutputRoot -Label "OutputRoot"
    $resolvedOutput = Assert-MeetingRelayDistributionOutputRoot -RepositoryRoot $repoRoot -OutputRoot $resolvedOutput
    $desktopVersion = Get-MeetingRelayDesktopPackageVersion -RepositoryRoot $repoRoot
    $assetApproval = Assert-MeetingRelayDistributionAssetApproval -RepositoryRoot $repoRoot -UnsignedTestBuild:$UnsignedTestBuild
    Assert-MeetingRelayDistributionConfig -RepositoryRoot $repoRoot
    Assert-DistributionSigningPolicy `
        -CertificateThumbprint $CertificateThumbprint `
        -CertificatePath $CertificatePath `
        -UnsignedTestBuild:$UnsignedTestBuild
    $retention = Test-MeetingRelayDistributionDataRetention -RepositoryRoot $repoRoot
    if (-not $retention.uninstallRetainsData) {
        throw "MEETINGRELAY_DISTRIBUTION_RETENTION_INVALID"
    }

    if ($DryRun) {
        Write-Host "MEETINGRELAY_DISTRIBUTION_DRY_RUN_OK kind=nsis install_mode=currentUser signing=$(if ($UnsignedTestBuild) { 'unsigned-test-build' } else { 'authenticode-required' }) output=$resolvedOutput"
        return
    }

    if (-not (Test-Path -LiteralPath $resolvedOutput -PathType Container)) {
        New-Item -ItemType Directory -Path $resolvedOutput | Out-Null
    }
    Clear-MeetingRelayDistributionOutput -RepositoryRoot $repoRoot -OutputRoot $resolvedOutput
    $sbomPath = Join-Path $resolvedOutput "sbom.json"
    $null = New-MeetingRelaySbom -RepositoryRoot $repoRoot -OutputPath $sbomPath

    $stageManifest = Stage-MeetingRelayDistributionResources `
        -RepositoryRoot $repoRoot `
        -AllowDownload:$AllowDownload
    Clear-MeetingRelayReleaseUnsignedMarkers -RepositoryRoot $repoRoot
    Assert-MeetingRelaySealedRuntimeLibInventory -RepositoryRoot $repoRoot -RuntimeLibRoot (Join-Path $repoRoot "apps/desktop/src-tauri/resources/runtime/lib")
    $bundledSignatures = Invoke-MeetingRelayFormalBundledResourceSigning `
        -RepositoryRoot $repoRoot `
        -StageManifest $stageManifest `
        -CertificateThumbprint $CertificateThumbprint `
        -CertificatePath $CertificatePath `
        -CertificatePassword $CertificatePassword `
        -TimestampUrl $TimestampUrl `
        -UnsignedTestBuild:$UnsignedTestBuild

    $previousUnsigned = $env:MEETINGRELAY_UNSIGNED_TEST_BUILD
    $previousThumbprint = $env:MEETINGRELAY_SIGNING_CERT_THUMBPRINT
    $previousCertPath = $env:MEETINGRELAY_SIGNING_CERT_PATH
    $previousCertPassword = $env:MEETINGRELAY_SIGNING_CERT_PASSWORD
    $previousTimestamp = $env:MEETINGRELAY_SIGNING_TIMESTAMP_URL
    try {
        if ($UnsignedTestBuild) {
            $env:MEETINGRELAY_UNSIGNED_TEST_BUILD = "1"
        }
        $env:MEETINGRELAY_SIGNING_CERT_THUMBPRINT = $CertificateThumbprint
        $env:MEETINGRELAY_SIGNING_CERT_PATH = $CertificatePath
        $env:MEETINGRELAY_SIGNING_CERT_PASSWORD = $CertificatePassword
        $env:MEETINGRELAY_SIGNING_TIMESTAMP_URL = $TimestampUrl

        $desktopRoot = Join-Path $repoRoot "apps/desktop"
        $nodeCommand = Get-Command "node" -ErrorAction SilentlyContinue
        if ($null -eq $nodeCommand) {
            throw "MEETINGRELAY_DISTRIBUTION_NODE_MISSING"
        }
        $tauriCli = Join-Path $desktopRoot "node_modules/@tauri-apps/cli/tauri.js"
        if (-not (Test-Path -LiteralPath $tauriCli -PathType Leaf)) {
            throw "MEETINGRELAY_DISTRIBUTION_TAURI_CLI_MISSING path=$tauriCli"
        }
        $arguments = @($tauriCli, "build")
        if (-not $AllowDownload) {
            $arguments += @("--", "--offline", "--locked")
        }
        Push-Location -LiteralPath $desktopRoot
        try {
            & $nodeCommand.Source @arguments
            if ($LASTEXITCODE -ne 0) {
                throw "MEETINGRELAY_DISTRIBUTION_BUILD_FAILED exit=$LASTEXITCODE"
            }
        }
        finally {
            Pop-Location
        }
    }
    finally {
        $env:MEETINGRELAY_UNSIGNED_TEST_BUILD = $previousUnsigned
        $env:MEETINGRELAY_SIGNING_CERT_THUMBPRINT = $previousThumbprint
        $env:MEETINGRELAY_SIGNING_CERT_PATH = $previousCertPath
        $env:MEETINGRELAY_SIGNING_CERT_PASSWORD = $previousCertPassword
        $env:MEETINGRELAY_SIGNING_TIMESTAMP_URL = $previousTimestamp
    }

    Assert-MeetingRelaySealedRuntimeLibInventory `
        -RepositoryRoot $repoRoot `
        -RuntimeLibRoot (Join-Path $repoRoot "target/release/runtime/lib")

    $artifacts = @((Get-MeetingRelayCurrentBundleInstaller -RepositoryRoot $repoRoot -Version $desktopVersion))

    foreach ($artifact in $artifacts) {
        Copy-Item -LiteralPath $artifact -Destination (Join-Path $resolvedOutput (Split-Path -Leaf $artifact)) -Force
        $copiedArtifact = Join-Path $resolvedOutput (Split-Path -Leaf $artifact)
        if ($UnsignedTestBuild) {
            Set-Content -LiteralPath "$copiedArtifact.unsigned-test-build" -Value "UnsignedTestBuild: true" -Encoding ASCII
        }
        Test-MeetingRelaySignature -FilePath $copiedArtifact -AllowUnsignedTestBuild:$UnsignedTestBuild | Out-Null
    }

    $copiedArtifacts = @(Get-ChildItem -LiteralPath $resolvedOutput -Filter "*.exe" -File | ForEach-Object { $_.FullName })
    $verification = Test-MeetingRelayFormalReleaseSignatures `
        -RepositoryRoot $repoRoot `
        -Installers $copiedArtifacts `
        -UnsignedTestBuild:$UnsignedTestBuild
    $manifest = New-MeetingRelayDistributionManifest `
        -RepositoryRoot $repoRoot `
        -OutputRoot $resolvedOutput `
        -Artifacts $copiedArtifacts `
        -UnsignedTestBuild:$UnsignedTestBuild `
        -AssetApproval $assetApproval `
        -BundledSignatures $bundledSignatures `
        -Verification $verification
    $manifest | Add-Member -NotePropertyName stagedResources -NotePropertyValue $stageManifest -Force
    $manifest | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath (Join-Path $resolvedOutput "release-manifest.json") -Encoding UTF8
    Write-Host "MEETINGRELAY_DISTRIBUTION_RELEASE_READY root=$resolvedOutput artifacts=$(@($copiedArtifacts).Count) sbom=$sbomPath"
}

if ($MyInvocation.InvocationName -ne ".") {
    try {
        Invoke-MeetingRelayDistributionRelease `
            -OutputRoot $OutputRoot `
            -CertificateThumbprint $CertificateThumbprint `
            -CertificatePath $CertificatePath `
            -CertificatePassword $CertificatePassword `
            -TimestampUrl $TimestampUrl `
            -UnsignedTestBuild:$UnsignedTestBuild `
            -AllowDownload:$AllowDownload `
            -DryRun:$DryRun
    }
    catch {
        Write-Error $_.Exception.Message
        exit 1
    }
}
