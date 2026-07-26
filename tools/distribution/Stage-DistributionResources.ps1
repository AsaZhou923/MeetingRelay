[CmdletBinding()]
param(
    [string]$RepositoryRoot,
    [string]$ResourcesRoot,
    [string]$CacheRoot = "target/sherpa-native",
    [string]$ArchiveSourceRoot,
    [switch]$AllowDownload,
    [switch]$SkipHashVerification
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot "Generate-Sbom.ps1")

function ConvertFrom-DistributionEnvironmentOutput {
    param([Parameter(Mandatory = $true)][string[]]$Output)

    $values = @{}
    $required = @(
        "MEETINGRELAY_SHERPA_LOCK",
        "MEETINGRELAY_SHERPA_LOCK_SHA256",
        "MEETINGRELAY_SHERPA_PARAMETER_SHA256",
        "SHERPA_ONNX_LIB_DIR",
        "MEETINGRELAY_SHERPA_MODEL",
        "MEETINGRELAY_SHERPA_MODEL_SHA256",
        "MEETINGRELAY_SHERPA_TOKENS",
        "MEETINGRELAY_SHERPA_TOKENS_SHA256",
        "MEETINGRELAY_SHERPA_WAV"
    )
    foreach ($line in $Output) {
        if ($line -match '^([A-Z0-9_]+)=(.*)$') {
            $name = $Matches[1]
            if ($required -contains $name) {
                if ($values.ContainsKey($name)) {
                    throw "MEETINGRELAY_DISTRIBUTION_ASSET_ENV_DUPLICATE name=$name"
                }
                $values[$name] = $Matches[2]
            }
        }
    }
    foreach ($name in $required) {
        if (-not $values.ContainsKey($name) -or [string]::IsNullOrWhiteSpace([string]$values[$name])) {
            throw "MEETINGRELAY_DISTRIBUTION_ASSET_ENV_MISSING name=$name"
        }
    }
    return $values
}

function Get-MeetingRelayDistributionAssetEnvironment {
    param(
        [Parameter(Mandatory = $true)][string]$RepositoryRoot,
        [string]$CacheRoot = "target/sherpa-native",
        [string]$ArchiveSourceRoot,
        [switch]$AllowDownload
    )

    $materializer = Join-Path $RepositoryRoot "tools/sherpa-native/materialize.ps1"
    if (-not (Test-Path -LiteralPath $materializer -PathType Leaf)) {
        throw "MEETINGRELAY_DISTRIBUTION_MATERIALIZER_MISSING path=$materializer"
    }

    $parameters = @{
        CacheRoot = $CacheRoot
        AssetSet = "All"
    }
    if (-not [string]::IsNullOrWhiteSpace($ArchiveSourceRoot)) {
        $parameters["ArchiveSourceRoot"] = $ArchiveSourceRoot
    }
    if ($AllowDownload) {
        $parameters["AllowDownload"] = $true
    }

    try {
        $output = @(& $materializer @parameters)
    }
    catch {
        throw "MEETINGRELAY_DISTRIBUTION_ASSETS_UNAVAILABLE $($_.Exception.Message)"
    }
    return ConvertFrom-DistributionEnvironmentOutput -Output $output
}

function Copy-DistributionStagedFile {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Destination,
        [string]$ExpectedSha256,
        [Int64]$ExpectedSizeBytes = -1,
        [switch]$SkipHashVerification
    )

    if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) {
        throw "MEETINGRELAY_DISTRIBUTION_STAGE_SOURCE_MISSING source=$Source"
    }
    $sourceItem = Get-Item -LiteralPath $Source -Force
    if (-not $SkipHashVerification -and $ExpectedSizeBytes -ge 0 -and $sourceItem.Length -ne $ExpectedSizeBytes) {
        throw "MEETINGRELAY_DISTRIBUTION_STAGE_SOURCE_SIZE_MISMATCH source=$Source expected=$ExpectedSizeBytes actual=$($sourceItem.Length)"
    }
    $sourceSha256 = (Get-FileHash -LiteralPath $Source -Algorithm SHA256).Hash.ToLowerInvariant()
    if (-not $SkipHashVerification -and -not [string]::IsNullOrWhiteSpace($ExpectedSha256) -and $sourceSha256 -ne $ExpectedSha256.ToLowerInvariant()) {
        throw "MEETINGRELAY_DISTRIBUTION_STAGE_SOURCE_HASH_MISMATCH source=$Source expected=$ExpectedSha256 actual=$sourceSha256"
    }
    $parent = Split-Path -Parent $Destination
    if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
        New-Item -ItemType Directory -Path $parent | Out-Null
    }
    Copy-Item -LiteralPath $Source -Destination $Destination -Force
    return [PSCustomObject]@{
        path = [IO.Path]::GetFullPath($Destination)
        sha256 = (Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash.ToLowerInvariant()
        sizeBytes = (Get-Item -LiteralPath $Destination -Force).Length
    }
}

function Test-DistributionPathIsDescendant {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$Path
    )

    $resolvedRoot = [IO.Path]::GetFullPath($Root).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
    $resolvedPath = [IO.Path]::GetFullPath($Path)
    $prefix = $resolvedRoot + [IO.Path]::DirectorySeparatorChar
    return $resolvedPath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
}

function Assert-DistributionSafeRelativePath {
    param(
        [Parameter(Mandatory = $true)][string]$RelativePath,
        [Parameter(Mandatory = $true)][string]$Label
    )

    if ([string]::IsNullOrWhiteSpace($RelativePath)) {
        throw "MEETINGRELAY_DISTRIBUTION_RELATIVE_PATH_INVALID label=$Label path=$RelativePath"
    }
    if ([IO.Path]::IsPathRooted($RelativePath)) {
        throw "MEETINGRELAY_DISTRIBUTION_RELATIVE_PATH_ROOTED label=$Label path=$RelativePath"
    }
    $segments = @($RelativePath -split '[\\/]')
    if (@($segments | Where-Object { $_ -eq ".." }).Count -gt 0) {
        throw "MEETINGRELAY_DISTRIBUTION_RELATIVE_PATH_TRAVERSAL label=$Label path=$RelativePath"
    }
}

function Resolve-DistributionResourceDestination {
    param(
        [Parameter(Mandatory = $true)][string]$ResourcesRoot,
        [Parameter(Mandatory = $true)][string]$RelativePath,
        [Parameter(Mandatory = $true)][string]$Label
    )

    Assert-DistributionSafeRelativePath -RelativePath $RelativePath -Label $Label
    $destination = [IO.Path]::GetFullPath((Join-Path $ResourcesRoot $RelativePath))
    if (-not (Test-DistributionPathIsDescendant -Root $ResourcesRoot -Path $destination)) {
        throw "MEETINGRELAY_DISTRIBUTION_RESOURCE_DESTINATION_INVALID label=$Label path=$destination root=$ResourcesRoot"
    }
    return $destination
}

function Resolve-DistributionSourceSnapshotPath {
    param(
        [Parameter(Mandatory = $true)][string]$SourceRoot,
        [Parameter(Mandatory = $true)][string]$RelativePath,
        [Parameter(Mandatory = $true)][string]$Label
    )

    Assert-DistributionSafeRelativePath -RelativePath $RelativePath -Label $Label
    $source = [IO.Path]::GetFullPath((Join-Path $SourceRoot $RelativePath))
    if (-not (Test-DistributionPathIsDescendant -Root $SourceRoot -Path $source)) {
        throw "MEETINGRELAY_DISTRIBUTION_SOURCE_SNAPSHOT_INVALID label=$Label path=$source root=$SourceRoot"
    }
    return $source
}

function Assert-DistributionResourcesRootAllowed {
    param(
        [Parameter(Mandatory = $true)][string]$RepositoryRoot,
        [Parameter(Mandatory = $true)][string]$ResourcesRoot
    )

    $resolvedRepositoryRoot = [IO.Path]::GetFullPath($RepositoryRoot)
    $resolvedRoot = [IO.Path]::GetFullPath($ResourcesRoot)
    $repoResourcesRoot = [IO.Path]::GetFullPath((Join-Path $resolvedRepositoryRoot "apps/desktop/src-tauri/resources"))
    $contractRoot = [IO.Path]::GetFullPath((Join-Path $resolvedRepositoryRoot "target/distribution/contract-test"))
    if ($resolvedRoot.Equals($repoResourcesRoot, [StringComparison]::OrdinalIgnoreCase)) {
        return $resolvedRoot
    }
    if (Test-DistributionPathIsDescendant -Root $contractRoot -Path $resolvedRoot) {
        return $resolvedRoot
    }
    throw "MEETINGRELAY_DISTRIBUTION_RESOURCES_ROOT_INVALID path=$resolvedRoot repository_root=$resolvedRepositoryRoot"
}

function Clear-DistributionGeneratedResources {
    param(
        [Parameter(Mandatory = $true)][string]$RepositoryRoot,
        [Parameter(Mandatory = $true)][string]$ResourcesRoot
    )

    $resolvedRoot = Assert-DistributionResourcesRootAllowed -RepositoryRoot $RepositoryRoot -ResourcesRoot $ResourcesRoot
    if (-not (Test-Path -LiteralPath $ResourcesRoot -PathType Container)) {
        New-Item -ItemType Directory -Path $resolvedRoot | Out-Null
        return
    }
    foreach ($item in @(Get-ChildItem -LiteralPath $resolvedRoot -Force | Where-Object { $_.Name -notin @(".gitignore", "README.md") })) {
        $itemPath = [IO.Path]::GetFullPath($item.FullName)
        if (-not (Test-DistributionPathIsDescendant -Root $resolvedRoot -Path $itemPath)) {
            throw "MEETINGRELAY_DISTRIBUTION_DELETE_TARGET_INVALID path=$itemPath root=$resolvedRoot"
        }
        Remove-Item -LiteralPath $itemPath -Recurse -Force
    }
}

function Stage-MeetingRelayDistributionResources {
    param(
        [string]$RepositoryRoot = (Get-DistributionRepositoryRoot),
        [string]$ResourcesRoot,
        [hashtable]$AssetEnvironment,
        [string]$CacheRoot = "target/sherpa-native",
        [string]$ArchiveSourceRoot,
        [switch]$AllowDownload,
        [switch]$SkipHashVerification
    )

    $RepositoryRoot = [IO.Path]::GetFullPath($RepositoryRoot)
    if ([string]::IsNullOrWhiteSpace($ResourcesRoot)) {
        $ResourcesRoot = Join-Path $RepositoryRoot "apps/desktop/src-tauri/resources"
    }
    $ResourcesRoot = [IO.Path]::GetFullPath($ResourcesRoot)

    $assetLockPath = Join-Path $RepositoryRoot "tools/sherpa-native/assets.lock.json"
    $cargoLockPath = Join-Path $RepositoryRoot "Cargo.lock"
    $noticePath = Join-Path $RepositoryRoot "NOTICE.md"
    $thirdPartyPath = Join-Path $RepositoryRoot "THIRD_PARTY_NOTICES.md"
    foreach ($required in @($assetLockPath, $cargoLockPath, $noticePath, $thirdPartyPath)) {
        if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
            throw "MEETINGRELAY_DISTRIBUTION_STAGE_REQUIRED_FILE_MISSING path=$required"
        }
    }

    if ($null -eq $AssetEnvironment) {
        $AssetEnvironment = Get-MeetingRelayDistributionAssetEnvironment `
            -RepositoryRoot $RepositoryRoot `
            -CacheRoot $CacheRoot `
            -ArchiveSourceRoot $ArchiveSourceRoot `
            -AllowDownload:$AllowDownload
    }

    $lock = Get-Content -LiteralPath $assetLockPath -Raw -Encoding UTF8 | ConvertFrom-Json
    Clear-DistributionGeneratedResources -RepositoryRoot $RepositoryRoot -ResourcesRoot $ResourcesRoot
    $files = New-Object 'System.Collections.Generic.List[object]'

    $files.Add((Copy-DistributionStagedFile -Source $noticePath -Destination (Resolve-DistributionResourceDestination -ResourcesRoot $ResourcesRoot -RelativePath "NOTICE.md" -Label "notice") -SkipHashVerification:$SkipHashVerification)) | Out-Null
    $files.Add((Copy-DistributionStagedFile -Source $thirdPartyPath -Destination (Resolve-DistributionResourceDestination -ResourcesRoot $ResourcesRoot -RelativePath "THIRD_PARTY_NOTICES.md" -Label "third-party-notices") -SkipHashVerification:$SkipHashVerification)) | Out-Null
    $files.Add((Copy-DistributionStagedFile -Source $assetLockPath -Destination (Resolve-DistributionResourceDestination -ResourcesRoot $ResourcesRoot -RelativePath "locks/assets.lock.json" -Label "asset-lock") -SkipHashVerification:$SkipHashVerification)) | Out-Null
    $files.Add((Copy-DistributionStagedFile -Source $cargoLockPath -Destination (Resolve-DistributionResourceDestination -ResourcesRoot $ResourcesRoot -RelativePath "locks/Cargo.lock" -Label "cargo-lock") -SkipHashVerification:$SkipHashVerification)) | Out-Null

    $modelRecord = @($lock.model.archive.inventory | Where-Object { $_.path -eq $lock.entrypoints.model_relative_path })[0]
    $tokensRecord = @($lock.model.archive.inventory | Where-Object { $_.path -eq $lock.entrypoints.tokens_relative_path })[0]
    $wavRecord = @($lock.model.archive.inventory | Where-Object { $_.path -eq $lock.entrypoints.smoke_wav_relative_path })[0]
    $files.Add((Copy-DistributionStagedFile -Source $AssetEnvironment["MEETINGRELAY_SHERPA_MODEL"] -Destination (Resolve-DistributionResourceDestination -ResourcesRoot $ResourcesRoot -RelativePath "model/model.int8.onnx" -Label "model") -ExpectedSha256 $modelRecord.sha256 -ExpectedSizeBytes ([Int64]$modelRecord.size_bytes) -SkipHashVerification:$SkipHashVerification)) | Out-Null
    $files.Add((Copy-DistributionStagedFile -Source $AssetEnvironment["MEETINGRELAY_SHERPA_TOKENS"] -Destination (Resolve-DistributionResourceDestination -ResourcesRoot $ResourcesRoot -RelativePath "model/tokens.txt" -Label "tokens") -ExpectedSha256 $tokensRecord.sha256 -ExpectedSizeBytes ([Int64]$tokensRecord.size_bytes) -SkipHashVerification:$SkipHashVerification)) | Out-Null
    $files.Add((Copy-DistributionStagedFile -Source $AssetEnvironment["MEETINGRELAY_SHERPA_WAV"] -Destination (Resolve-DistributionResourceDestination -ResourcesRoot $ResourcesRoot -RelativePath "model/test_wavs/zh.wav" -Label "smoke-wav") -ExpectedSha256 $wavRecord.sha256 -ExpectedSizeBytes ([Int64]$wavRecord.size_bytes) -SkipHashVerification:$SkipHashVerification)) | Out-Null

    foreach ($record in @($lock.runtime.archive.inventory)) {
        $runtimeInventoryPath = [string]$record.path
        Assert-DistributionSafeRelativePath -RelativePath $runtimeInventoryPath -Label "runtime-inventory"
    }
    foreach ($record in @($lock.runtime.archive.inventory | Where-Object { ([string]$_.path).StartsWith("lib/", [StringComparison]::Ordinal) })) {
        $runtimeInventoryPath = [string]$record.path
        $source = Join-Path $AssetEnvironment["SHERPA_ONNX_LIB_DIR"] (Split-Path -Leaf $runtimeInventoryPath)
        $destination = Resolve-DistributionResourceDestination -ResourcesRoot $ResourcesRoot -RelativePath ("runtime/" + $runtimeInventoryPath) -Label "runtime-inventory"
        $files.Add((Copy-DistributionStagedFile -Source $source -Destination $destination -ExpectedSha256 $record.sha256 -ExpectedSizeBytes ([Int64]$record.size_bytes) -SkipHashVerification:$SkipHashVerification)) | Out-Null
        if ($runtimeInventoryPath -like "*.dll") {
            $rootDllDestination = Resolve-DistributionResourceDestination -ResourcesRoot $ResourcesRoot -RelativePath (Split-Path -Leaf $runtimeInventoryPath) -Label "root-runtime-dll"
            $files.Add((Copy-DistributionStagedFile -Source $source -Destination $rootDllDestination -ExpectedSha256 $record.sha256 -ExpectedSizeBytes ([Int64]$record.size_bytes) -SkipHashVerification:$SkipHashVerification)) | Out-Null
        }
    }

    foreach ($snapshot in @(
        $lock.runtime.license,
        $lock.runtime.onnxruntime_license,
        $lock.model.embedded_license_pointer,
        $lock.model.license_at_model_release,
        $lock.model.current_license_snapshot
    )) {
        $snapshotPath = [string]$snapshot.snapshot_path
        $source = Resolve-DistributionSourceSnapshotPath -SourceRoot (Join-Path $RepositoryRoot "tools/sherpa-native") -RelativePath $snapshotPath -Label "license-snapshot"
        $files.Add((Copy-DistributionStagedFile -Source $source -Destination (Resolve-DistributionResourceDestination -ResourcesRoot $ResourcesRoot -RelativePath $snapshotPath -Label "license-snapshot") -ExpectedSha256 $snapshot.sha256 -ExpectedSizeBytes ([Int64]$snapshot.size_bytes) -SkipHashVerification:$SkipHashVerification)) | Out-Null
    }

    $sbomPath = Resolve-DistributionResourceDestination -ResourcesRoot $ResourcesRoot -RelativePath "sbom.json" -Label "sbom"
    $null = New-MeetingRelaySbom -RepositoryRoot $RepositoryRoot -OutputPath $sbomPath
    $files.Add([PSCustomObject]@{
        path = [IO.Path]::GetFullPath($sbomPath)
        sha256 = (Get-FileHash -LiteralPath $sbomPath -Algorithm SHA256).Hash.ToLowerInvariant()
        sizeBytes = (Get-Item -LiteralPath $sbomPath -Force).Length
    }) | Out-Null

    $stageManifest = [PSCustomObject]@{
        createdAt = (Get-Date).ToUniversalTime().ToString("o")
        resourcesRoot = $ResourcesRoot
        files = @($files.ToArray())
    }
    $stageManifest | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath (Resolve-DistributionResourceDestination -ResourcesRoot $ResourcesRoot -RelativePath "distribution-resources-manifest.json" -Label "stage-manifest") -Encoding UTF8
    return $stageManifest
}

function Update-MeetingRelayDistributionResourcesManifest {
    param(
        [Parameter(Mandatory = $true)][object]$StageManifest
    )

    foreach ($file in @($StageManifest.files)) {
        if (-not (Test-Path -LiteralPath $file.path -PathType Leaf)) {
            throw "MEETINGRELAY_DISTRIBUTION_STAGE_MANIFEST_FILE_MISSING path=$($file.path)"
        }
        $file.sha256 = (Get-FileHash -LiteralPath $file.path -Algorithm SHA256).Hash.ToLowerInvariant()
        $file.sizeBytes = (Get-Item -LiteralPath $file.path -Force).Length
    }
    $StageManifest | Add-Member -NotePropertyName updatedAt -NotePropertyValue (Get-Date).ToUniversalTime().ToString("o") -Force
    $manifestPath = Join-Path $StageManifest.resourcesRoot "distribution-resources-manifest.json"
    $StageManifest | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $manifestPath -Encoding UTF8
    return $StageManifest
}

if ($MyInvocation.InvocationName -ne ".") {
    try {
        $result = Stage-MeetingRelayDistributionResources `
            -RepositoryRoot $(if ($RepositoryRoot) { $RepositoryRoot } else { Get-DistributionRepositoryRoot }) `
            -ResourcesRoot $ResourcesRoot `
            -CacheRoot $CacheRoot `
            -ArchiveSourceRoot $ArchiveSourceRoot `
            -AllowDownload:$AllowDownload `
            -SkipHashVerification:$SkipHashVerification
        $result | ConvertTo-Json -Depth 20
    }
    catch {
        Write-Error $_.Exception.Message
        exit 1
    }
}
