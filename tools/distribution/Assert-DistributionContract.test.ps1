$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot "release.ps1")
. (Join-Path $PSScriptRoot "Sign-ReleaseArtifact.ps1")
. (Join-Path $PSScriptRoot "Verify-ReleaseArtifact.ps1")
. (Join-Path $PSScriptRoot "Test-DataRetention.ps1")
. (Join-Path $PSScriptRoot "Stage-DistributionResources.ps1")

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

function Assert-Matches {
    param(
        [Parameter(Mandatory = $true)][string]$Pattern,
        [Parameter(Mandatory = $true)][string]$Value,
        [Parameter(Mandatory = $true)][string]$Label
    )
    if ($Value -notmatch $Pattern) {
        throw "ASSERT_MATCH_FAILED label=$Label pattern=$Pattern"
    }
}

function Get-NullableFileState {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return [PSCustomObject]@{
            Exists = $false
            Sha256 = $null
        }
    }
    return [PSCustomObject]@{
        Exists = $true
        Sha256 = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
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

$repoRoot = Get-DistributionRepositoryRoot
$tauriConfigPath = Join-Path $repoRoot "apps/desktop/src-tauri/tauri.conf.json"
$tauriConfig = Get-Content -LiteralPath $tauriConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
$rootPackage = Get-Content -LiteralPath (Join-Path $repoRoot "package.json") -Raw -Encoding UTF8 | ConvertFrom-Json
$desktopPackage = Get-Content -LiteralPath (Join-Path $repoRoot "apps/desktop/package.json") -Raw -Encoding UTF8 | ConvertFrom-Json
$cargoManifest = Get-Content -LiteralPath (Join-Path $repoRoot "Cargo.toml") -Raw -Encoding UTF8
if ($cargoManifest -notmatch '(?ms)\[workspace\.package\].*?^version = "([^"]+)"') {
    throw "MEETINGRELAY_DISTRIBUTION_WORKSPACE_VERSION_MISSING"
}
$workspaceVersion = $Matches[1]

Assert-Equal -Expected $true -Actual $tauriConfig.bundle.active -Label "tauri bundling enabled"
Assert-Equal -Expected "nsis" -Actual ([string]$tauriConfig.bundle.targets[0]) -Label "nsis is only bundle target"
Assert-Equal -Expected "currentUser" -Actual $tauriConfig.bundle.windows.nsis.installMode -Label "nsis current user install"
Assert-Equal -Expected $false -Actual $tauriConfig.bundle.windows.allowDowngrades -Label "downgrades blocked"
Assert-Equal -Expected "../../../tools/distribution/nsis-hooks.nsh" -Actual $tauriConfig.bundle.windows.nsis.installerHooks -Label "nsis hook path"
Assert-Equal -Expected "../../../tools/distribution/Sign-ReleaseArtifact.ps1" -Actual $tauriConfig.bundle.windows.signCommand.args[5] -Label "sign hook script"
$resourceEntry = $tauriConfig.bundle.resources.PSObject.Properties | Where-Object { $_.Name -eq "resources/" } | Select-Object -First 1
Assert-Equal -Expected "" -Actual $resourceEntry.Value -Label "tauri maps staged resources into resource root"
Assert-Equal -Expected $workspaceVersion -Actual $rootPackage.version -Label "root package version matches workspace"
Assert-Equal -Expected $workspaceVersion -Actual $desktopPackage.version -Label "desktop package version matches workspace"
Assert-Equal -Expected $workspaceVersion -Actual $tauriConfig.version -Label "tauri version matches workspace"
Assert-Equal -Expected $false -Actual ($workspaceVersion -eq "0.0.1") -Label "new Windows features use a new semantic version"

Assert-ThrowsLike `
    -Action { Assert-MeetingRelayDistributionAssetApproval -RepositoryRoot $repoRoot } `
    -Pattern "MEETINGRELAY_DISTRIBUTION_ASSET_NOT_APPROVED*" `
    -Label "formal release rejects pending asset distribution status"

$assetGate = Assert-MeetingRelayDistributionAssetApproval -RepositoryRoot $repoRoot -UnsignedTestBuild
Assert-Equal -Expected $true -Actual ([bool](@($assetGate.statuses | Where-Object { $_.status -ne "approved-for-distribution" }).Count -ge 1)) -Label "unsigned test records pending asset status"

Assert-ThrowsLike `
    -Action { Assert-DistributionSigningPolicy -UnsignedTestBuild:$false } `
    -Pattern "MEETINGRELAY_DISTRIBUTION_SIGNING_REQUIRED*" `
    -Label "signing policy rejects missing certificate"

Assert-DistributionSigningPolicy -UnsignedTestBuild
Assert-Equal -Expected $true -Actual (Test-MeetingRelaySealedRuntimeLibArtifact -FilePath (Join-Path $repoRoot "apps/desktop/src-tauri/resources/runtime/lib/sherpa-onnx-c-api.dll")) -Label "sealed runtime lib path detected"
Assert-Equal -Expected $false -Actual (Test-MeetingRelaySealedRuntimeLibArtifact -FilePath (Join-Path $repoRoot "apps/desktop/src-tauri/resources/sherpa-onnx-c-api.dll")) -Label "root runtime dll is not sealed"
$alreadySignedDecision = Test-MeetingRelaySigningShouldSkip -FilePath (Join-Path $repoRoot "apps/desktop/src-tauri/resources/sherpa-onnx-c-api.dll") -AuthenticodeStatus "Valid"
Assert-Equal -Expected $true -Actual $alreadySignedDecision.ShouldSkip -Label "already valid signature skips signing"
Assert-Equal -Expected "already_valid" -Actual $alreadySignedDecision.Reason -Label "already valid skip reason recorded"

$testRoot = Join-Path $repoRoot "target/distribution/contract-test"
if (-not (Test-Path -LiteralPath $testRoot -PathType Container)) {
    New-Item -ItemType Directory -Path $testRoot | Out-Null
}
$currentInstallerName = Get-MeetingRelayCurrentInstallerFileName -Version $desktopPackage.version
Assert-Equal -Expected "MeetingRelay_$($desktopPackage.version)_x64-setup.exe" -Actual $currentInstallerName -Label "current installer name uses desktop package version"
Assert-ThrowsLike `
    -Action { Assert-MeetingRelayDistributionOutputRoot -RepositoryRoot $repoRoot -OutputRoot $testRoot } `
    -Pattern "MEETINGRELAY_DISTRIBUTION_OUTPUT_ROOT_INVALID*" `
    -Label "release output cleanup rejects non-release output root"
$cleanupRepoRoot = Join-Path $testRoot "cleanup-repo"
$releaseOutputRoot = Join-Path $cleanupRepoRoot "target/distribution/windows"
New-Item -ItemType Directory -Path $releaseOutputRoot -Force | Out-Null
$oldOutputInstaller = Join-Path $releaseOutputRoot "MeetingRelay_0.0.1_x64-setup.exe"
$currentOutputInstaller = Join-Path $releaseOutputRoot $currentInstallerName
Set-Content -LiteralPath $oldOutputInstaller -Value "old installer" -Encoding ASCII
Set-Content -LiteralPath "$oldOutputInstaller.unsigned-test-build" -Value "old marker" -Encoding ASCII
Set-Content -LiteralPath $currentOutputInstaller -Value "current installer" -Encoding ASCII
Set-Content -LiteralPath (Join-Path $releaseOutputRoot "release-manifest.json") -Value "{}" -Encoding ASCII
Clear-MeetingRelayDistributionOutput -RepositoryRoot $cleanupRepoRoot -OutputRoot $releaseOutputRoot
Assert-Equal -Expected $false -Actual (Test-Path -LiteralPath $oldOutputInstaller -PathType Leaf) -Label "old output installer cleaned"
Assert-Equal -Expected $false -Actual (Test-Path -LiteralPath "$oldOutputInstaller.unsigned-test-build" -PathType Leaf) -Label "old output marker cleaned"
Assert-Equal -Expected $false -Actual (Test-Path -LiteralPath $currentOutputInstaller -PathType Leaf) -Label "current output installer cleaned before rebuild"
Assert-Equal -Expected $false -Actual (Test-Path -LiteralPath (Join-Path $releaseOutputRoot "release-manifest.json") -PathType Leaf) -Label "old release manifest cleaned"
$fakeBundleRoot = Join-Path $repoRoot "target/release/bundle/nsis"
New-Item -ItemType Directory -Path $fakeBundleRoot -Force | Out-Null
$oldBundleInstaller = Join-Path $fakeBundleRoot "MeetingRelay_0.0.1_x64-setup.exe"
$currentBundleInstaller = Join-Path $fakeBundleRoot $currentInstallerName
Set-Content -LiteralPath $oldBundleInstaller -Value "old bundle installer" -Encoding ASCII
Set-Content -LiteralPath $currentBundleInstaller -Value "current bundle installer" -Encoding ASCII
Assert-Equal -Expected ([IO.Path]::GetFullPath($currentBundleInstaller)) -Actual (Get-MeetingRelayCurrentBundleInstaller -RepositoryRoot $repoRoot -Version $desktopPackage.version) -Label "bundle selection ignores stale installers"
$sealedTestPath = Join-Path $repoRoot "apps/desktop/src-tauri/resources/runtime/lib/r6-sealed-test.dll"
$sealedParent = Split-Path -Parent $sealedTestPath
New-Item -ItemType Directory -Path $sealedParent -Force | Out-Null
Set-Content -LiteralPath $sealedTestPath -Value "sealed" -Encoding ASCII
Invoke-MeetingRelayArtifactSigning -FilePath $sealedTestPath -CertificateThumbprint "FAKE"
Assert-Equal -Expected $false -Actual (Test-Path -LiteralPath "$sealedTestPath.unsigned-test-build" -PathType Leaf) -Label "formal sealed runtime lib skip does not write unsigned marker"
Remove-Item -LiteralPath $sealedTestPath -Force
Assert-ThrowsLike `
    -Action {
        Clear-DistributionGeneratedResources `
            -RepositoryRoot $repoRoot `
            -ResourcesRoot (Join-Path $repoRoot "target/distribution/not-contract/apps/desktop/src-tauri/resources")
    } `
    -Pattern "MEETINGRELAY_DISTRIBUTION_RESOURCES_ROOT_INVALID*" `
    -Label "cleanup rejects suffix-only fake resource root"
Assert-ThrowsLike `
    -Action { Assert-DistributionSafeRelativePath -RelativePath "lib/../escape.dll" -Label "runtime-inventory" } `
    -Pattern "MEETINGRELAY_DISTRIBUTION_RELATIVE_PATH_TRAVERSAL*" `
    -Label "runtime inventory traversal path rejected"
Assert-ThrowsLike `
    -Action { Assert-DistributionSafeRelativePath -RelativePath "C:\escape.dll" -Label "runtime-inventory" } `
    -Pattern "MEETINGRELAY_DISTRIBUTION_RELATIVE_PATH_ROOTED*" `
    -Label "runtime inventory rooted path rejected"
Assert-ThrowsLike `
    -Action {
        Resolve-DistributionSourceSnapshotPath `
            -SourceRoot (Join-Path $repoRoot "tools/sherpa-native") `
            -RelativePath "licenses/../escape.txt" `
            -Label "license-snapshot"
    } `
    -Pattern "MEETINGRELAY_DISTRIBUTION_RELATIVE_PATH_TRAVERSAL*" `
    -Label "license snapshot traversal path rejected"
Assert-ThrowsLike `
    -Action {
        Resolve-DistributionResourceDestination `
            -ResourcesRoot (Join-Path $testRoot "staged-resources") `
            -RelativePath "C:\escape.txt" `
            -Label "license-snapshot"
    } `
    -Pattern "MEETINGRELAY_DISTRIBUTION_RELATIVE_PATH_ROOTED*" `
    -Label "staged destination rooted path rejected"
Assert-ThrowsLike `
    -Action { Assert-MeetingRelayReleaseRoot -RepositoryRoot $repoRoot -ReleaseRoot $testRoot } `
    -Pattern "MEETINGRELAY_DISTRIBUTION_RELEASE_ROOT_INVALID*" `
    -Label "release marker cleanup rejects non-release root"
$releaseMarkerRoot = Join-Path $repoRoot "target/release"
$releaseMarkerPath = Join-Path $releaseMarkerRoot "runtime/lib/stale-marker.dll.unsigned-test-build"
New-Item -ItemType Directory -Path (Split-Path -Parent $releaseMarkerPath) -Force | Out-Null
Set-Content -LiteralPath $releaseMarkerPath -Value "stale marker" -Encoding ASCII
Clear-MeetingRelayReleaseUnsignedMarkers -RepositoryRoot $repoRoot
Assert-Equal -Expected $false -Actual (Test-Path -LiteralPath $releaseMarkerPath -PathType Leaf) -Label "stale release unsigned marker cleaned"
$artifactPath = Join-Path $testRoot "MeetingRelay_0.0.1_x64-setup.exe"
Set-Content -LiteralPath $artifactPath -Value "unsigned test artifact" -Encoding ASCII

Invoke-MeetingRelayArtifactSigning -FilePath $artifactPath -UnsignedTestBuild
Assert-Equal -Expected $true -Actual (Test-Path -LiteralPath "$artifactPath.unsigned-test-build" -PathType Leaf) -Label "unsigned marker created"
$envOnlyArtifactPath = Join-Path $testRoot "env-only-unsigned-artifact.exe"
Set-Content -LiteralPath $envOnlyArtifactPath -Value "env only unsigned artifact" -Encoding ASCII
$previousUnsignedEnv = $env:MEETINGRELAY_UNSIGNED_TEST_BUILD
try {
    $env:MEETINGRELAY_UNSIGNED_TEST_BUILD = "1"
    Invoke-MeetingRelayArtifactSigning -FilePath $envOnlyArtifactPath
}
finally {
    $env:MEETINGRELAY_UNSIGNED_TEST_BUILD = $previousUnsignedEnv
}
Assert-Equal -Expected $false -Actual (Test-Path -LiteralPath "$envOnlyArtifactPath.unsigned-test-build" -PathType Leaf) -Label "env-only unsigned signing does not write marker"

Assert-ThrowsLike `
    -Action { Test-MeetingRelaySignature -FilePath $artifactPath } `
    -Pattern "MEETINGRELAY_DISTRIBUTION_SIGNATURE_INVALID*" `
    -Label "formal verification rejects unsigned artifact"
Test-MeetingRelaySignature -FilePath $artifactPath -AllowUnsignedTestBuild

$manifest = New-MeetingRelayDistributionManifest `
    -RepositoryRoot $repoRoot `
    -OutputRoot $testRoot `
    -Artifacts @($artifactPath) `
    -UnsignedTestBuild `
    -BundledSignatures ([PSCustomObject]@{ mode = "skipped-unsigned-test-build"; targets = @() }) `
    -Verification ([PSCustomObject]@{ mode = "skipped-unsigned-test-build"; targets = @() })
Assert-Equal -Expected "unsigned-test-build" -Actual $manifest.signing.mode -Label "manifest records unsigned mode"
Assert-Equal -Expected "pending" -Actual $manifest.license.mode -Label "manifest records pending license mode for unsigned test"
Assert-Equal -Expected "skipped-unsigned-test-build" -Actual $manifest.bundledSignatures.mode -Label "manifest records bundled signature evidence"
Assert-Equal -Expected "skipped-unsigned-test-build" -Actual $manifest.verification.mode -Label "manifest records verification evidence"
Assert-Matches -Pattern "^[a-f0-9]{64}$" -Value $manifest.artifacts[0].sha256 -Label "artifact sha256 recorded"

$sbomPath = Join-Path $testRoot "sbom.json"
New-MeetingRelaySbom -RepositoryRoot $repoRoot -OutputPath $sbomPath
$sbom = Get-Content -LiteralPath $sbomPath -Raw -Encoding UTF8 | ConvertFrom-Json
Assert-Equal -Expected "MeetingRelay" -Actual $sbom.metadata.component.name -Label "sbom root component"
Assert-Equal -Expected $true -Actual ([bool](@($sbom.components | Where-Object { $_.name -eq "sherpa-onnx" }).Count -ge 1)) -Label "sbom includes sherpa"

$retention = Test-MeetingRelayDistributionDataRetention -RepositoryRoot $repoRoot
Assert-Equal -Expected $true -Actual $retention.localAppDataMvpRetained -Label "local mvp retained"
Assert-Equal -Expected $true -Actual $retention.credentialManagerRetained -Label "credential manager retained"
Assert-Equal -Expected $true -Actual $retention.rollbackRetainsData -Label "rollback retains data"

$hook = Get-Content -LiteralPath (Join-Path $repoRoot "tools/distribution/nsis-hooks.nsh") -Raw -Encoding UTF8
Assert-Contains -Needle "NSIS_HOOK_PREUNINSTALL" -Haystack $hook -Label "preuninstall hook exists"
Assert-Contains -Needle "MeetingRelay mvp data is intentionally retained" -Haystack $hook -Label "retention documented in hook"

Assert-ThrowsLike `
    -Action { Invoke-MeetingRelayDistributionRelease -DryRun } `
    -Pattern "MEETINGRELAY_DISTRIBUTION_ASSET_NOT_APPROVED*" `
    -Label "formal dry run rejects pending asset distribution"

$realOutputRoot = Join-Path $repoRoot "target/distribution/windows"
New-Item -ItemType Directory -Path $realOutputRoot -Force | Out-Null
$dryRunFixtureId = [guid]::NewGuid().ToString("N")
$dryRunSentinel = Join-Path $realOutputRoot "dry-run-sentinel-$dryRunFixtureId.txt"
$dryRunOldInstaller = Join-Path $realOutputRoot "MeetingRelay_dryrun-$dryRunFixtureId`_x64-setup.exe"
$dryRunOldMarker = "$dryRunOldInstaller.unsigned-test-build"
$dryRunCurrentInstaller = Join-Path $realOutputRoot $currentInstallerName
$dryRunManifest = Join-Path $realOutputRoot "release-manifest.json"
$dryRunSbom = Join-Path $realOutputRoot "sbom.json"
$dryRunPaths = @($dryRunSentinel, $dryRunOldInstaller, $dryRunOldMarker, $dryRunCurrentInstaller, $dryRunManifest, $dryRunSbom)
$dryRunStatesBefore = @{}
foreach ($path in $dryRunPaths) {
    $dryRunStatesBefore[$path] = Get-NullableFileState -Path $path
}
$dryRunCreatedPaths = New-Object 'System.Collections.Generic.List[string]'
try {
    foreach ($path in $dryRunPaths) {
        if (-not $dryRunStatesBefore[$path].Exists) {
            Set-Content -LiteralPath $path -Value "dry-run-fixture $dryRunFixtureId" -Encoding ASCII
            $dryRunCreatedPaths.Add($path) | Out-Null
            $dryRunStatesBefore[$path] = Get-NullableFileState -Path $path
        }
    }
    Invoke-MeetingRelayDistributionRelease -DryRun -UnsignedTestBuild
    foreach ($path in $dryRunPaths) {
        $after = Get-NullableFileState -Path $path
        Assert-Equal -Expected $dryRunStatesBefore[$path].Exists -Actual $after.Exists -Label "dry run preserves existence $path"
        Assert-Equal -Expected $dryRunStatesBefore[$path].Sha256 -Actual $after.Sha256 -Label "dry run preserves hash $path"
    }
}
finally {
    foreach ($path in @($dryRunCreatedPaths.ToArray())) {
        if (Test-Path -LiteralPath $path -PathType Leaf) {
            Remove-Item -LiteralPath $path -Force
        }
    }
}
foreach ($path in @($dryRunCreatedPaths.ToArray())) {
    Assert-Equal -Expected $false -Actual (Test-Path -LiteralPath $path -PathType Leaf) -Label "dry run fixture cleaned $path"
}

$fakeAssetRoot = Join-Path $testRoot "fake-assets"
$fakeRuntime = Join-Path $fakeAssetRoot "runtime"
$fakeModel = Join-Path $fakeAssetRoot "model"
New-Item -ItemType Directory -Path $fakeRuntime -Force | Out-Null
New-Item -ItemType Directory -Path $fakeModel -Force | Out-Null
$assetLock = Get-Content -LiteralPath (Join-Path $repoRoot "tools/sherpa-native/assets.lock.json") -Raw -Encoding UTF8 | ConvertFrom-Json
foreach ($record in @($assetLock.runtime.archive.inventory | Where-Object { $_.path.StartsWith("lib/", [StringComparison]::Ordinal) })) {
    $runtimeFile = Join-Path $fakeRuntime (Split-Path -Leaf ([string]$record.path))
    Set-Content -LiteralPath $runtimeFile -Value "fake runtime $($record.path)" -Encoding ASCII
}
Set-Content -LiteralPath (Join-Path $fakeModel "model.int8.onnx") -Value "fake model" -Encoding ASCII
Set-Content -LiteralPath (Join-Path $fakeModel "tokens.txt") -Value "fake tokens" -Encoding ASCII
Set-Content -LiteralPath (Join-Path $fakeModel "zh.wav") -Value "fake wav" -Encoding ASCII
$fakeEnvironment = @{
    MEETINGRELAY_SHERPA_LOCK = Join-Path $repoRoot "tools/sherpa-native/assets.lock.json"
    MEETINGRELAY_PACKAGE_LOCK = Join-Path $repoRoot "Cargo.lock"
    SHERPA_ONNX_LIB_DIR = $fakeRuntime
    MEETINGRELAY_SHERPA_MODEL = Join-Path $fakeModel "model.int8.onnx"
    MEETINGRELAY_SHERPA_TOKENS = Join-Path $fakeModel "tokens.txt"
    MEETINGRELAY_SHERPA_WAV = Join-Path $fakeModel "zh.wav"
}
$stagingRoot = Join-Path $testRoot "staged-resources"
$staged = Stage-MeetingRelayDistributionResources `
    -RepositoryRoot $repoRoot `
    -ResourcesRoot $stagingRoot `
    -AssetEnvironment $fakeEnvironment `
    -SkipHashVerification
Assert-MeetingRelaySealedRuntimeLibInventory -RepositoryRoot $repoRoot -RuntimeLibRoot (Join-Path $stagingRoot "runtime/lib")
$runtimeSidecar = Join-Path $stagingRoot "runtime/lib/sherpa-onnx-c-api.dll.unsigned-test-build"
Set-Content -LiteralPath $runtimeSidecar -Value "bad sidecar" -Encoding ASCII
Assert-ThrowsLike `
    -Action { Assert-MeetingRelaySealedRuntimeLibInventory -RepositoryRoot $repoRoot -RuntimeLibRoot (Join-Path $stagingRoot "runtime/lib") } `
    -Pattern "MEETINGRELAY_DISTRIBUTION_RUNTIME_LIB_UNSEALED_ENTRY*" `
    -Label "runtime lib inventory rejects unsigned marker sidecar"
Remove-Item -LiteralPath $runtimeSidecar -Force
$fakePostBuildRuntimeLib = Join-Path $testRoot "fake-post-build-target/release/runtime/lib"
New-Item -ItemType Directory -Path $fakePostBuildRuntimeLib -Force | Out-Null
foreach ($record in @($assetLock.runtime.archive.inventory | Where-Object { ([string]$_.path).StartsWith("lib/", [StringComparison]::Ordinal) })) {
    Set-Content -LiteralPath (Join-Path $fakePostBuildRuntimeLib (Split-Path -Leaf ([string]$record.path))) -Value "fake post build runtime" -Encoding ASCII
}
Assert-MeetingRelaySealedRuntimeLibInventory -RepositoryRoot $repoRoot -RuntimeLibRoot $fakePostBuildRuntimeLib
$fakePostBuildSidecar = Join-Path $fakePostBuildRuntimeLib "onnxruntime.dll.unsigned-test-build"
Set-Content -LiteralPath $fakePostBuildSidecar -Value "bad post-build sidecar" -Encoding ASCII
Assert-ThrowsLike `
    -Action { Assert-MeetingRelaySealedRuntimeLibInventory -RepositoryRoot $repoRoot -RuntimeLibRoot $fakePostBuildRuntimeLib } `
    -Pattern "MEETINGRELAY_DISTRIBUTION_RUNTIME_LIB_UNSEALED_ENTRY*" `
    -Label "post-build target runtime lib rejects unsigned marker sidecar"
Remove-Item -LiteralPath $fakePostBuildSidecar -Force
Assert-Equal -Expected $true -Actual (Test-Path -LiteralPath (Join-Path $stagingRoot "model/model.int8.onnx") -PathType Leaf) -Label "model staged"
Assert-Equal -Expected $true -Actual (Test-Path -LiteralPath (Join-Path $stagingRoot "runtime/lib/sherpa-onnx-c-api.dll") -PathType Leaf) -Label "runtime dll staged"
Assert-Equal -Expected $true -Actual (Test-Path -LiteralPath (Join-Path $stagingRoot "sherpa-onnx-c-api.dll") -PathType Leaf) -Label "runtime dll copied beside exe resource root"
Assert-Equal -Expected $true -Actual (Test-Path -LiteralPath (Join-Path $stagingRoot "locks/assets.lock.json") -PathType Leaf) -Label "asset lock staged"
Assert-Equal -Expected $true -Actual (Test-Path -LiteralPath (Join-Path $stagingRoot "licenses/apache-2.0-sherpa-onnx.txt") -PathType Leaf) -Label "license snapshot staged"
Assert-Equal -Expected $true -Actual (Test-Path -LiteralPath (Join-Path $stagingRoot "sbom.json") -PathType Leaf) -Label "sbom staged"
Assert-Equal -Expected $true -Actual ([bool]($staged.files.Count -ge 10)) -Label "staging manifest records files"
$rootDllRecord = @($staged.files | Where-Object { (Split-Path -Leaf $_.path) -eq "sherpa-onnx-c-api.dll" -and $_.path -notmatch "\\runtime\\lib\\" })[0]
$oldRootDllHash = $rootDllRecord.sha256
Set-Content -LiteralPath $rootDllRecord.path -Value "fake signed root dll" -Encoding ASCII
$staged = Update-MeetingRelayDistributionResourcesManifest -StageManifest $staged
$newRootDllRecord = @($staged.files | Where-Object { $_.path -eq $rootDllRecord.path })[0]
Assert-Equal -Expected $false -Actual ($oldRootDllHash -eq $newRootDllRecord.sha256) -Label "staging manifest refreshes signed root dll hash"

$unsignedBundledSigning = Invoke-MeetingRelayFormalBundledResourceSigning `
    -RepositoryRoot $repoRoot `
    -StageManifest $staged `
    -UnsignedTestBuild
Assert-Equal -Expected "skipped-unsigned-test-build" -Actual $unsignedBundledSigning.mode -Label "unsigned skips formal bundled dll signing"

$fakeReleaseRoot = Join-Path $testRoot "fake-release-root"
New-Item -ItemType Directory -Path $fakeReleaseRoot -Force | Out-Null
Set-Content -LiteralPath (Join-Path $fakeReleaseRoot "meetingrelay-desktop.exe") -Value "fake exe" -Encoding ASCII
foreach ($dllPath in @(Get-MeetingRelayRootRuntimeDllPaths -RepositoryRoot $repoRoot -ResourcesRoot $stagingRoot)) {
    Set-Content -LiteralPath (Join-Path $fakeReleaseRoot (Split-Path -Leaf $dllPath)) -Value "fake release dll" -Encoding ASCII
}
$targets = @(Get-MeetingRelayFormalVerificationTargets `
    -RepositoryRoot $repoRoot `
    -ReleaseRoot $fakeReleaseRoot `
    -Installers @($artifactPath))
Assert-Equal -Expected 6 -Actual $targets.Count -Label "formal verification enumerates exe root dlls and installer"
Assert-Equal -Expected $false -Actual ([bool](@($targets | Where-Object { $_.path -match "\\runtime\\lib\\" }).Count -gt 0)) -Label "formal verification excludes sealed runtime lib copies"
$unsignedVerification = Test-MeetingRelayFormalReleaseSignatures `
    -RepositoryRoot $repoRoot `
    -ReleaseRoot $fakeReleaseRoot `
    -Installers @($artifactPath) `
    -UnsignedTestBuild
Assert-Equal -Expected "skipped-unsigned-test-build" -Actual $unsignedVerification.mode -Label "unsigned skips formal signature verification"
Assert-ThrowsLike `
    -Action {
        Test-MeetingRelayFormalReleaseSignatures `
            -RepositoryRoot $repoRoot `
            -ReleaseRoot $fakeReleaseRoot `
            -Installers @($artifactPath)
    } `
    -Pattern "MEETINGRELAY_DISTRIBUTION_SIGNATURE_INVALID*" `
    -Label "formal verification rejects unsigned fake targets"

$fakeEnvironment["MEETINGRELAY_SHERPA_MODEL"] = Join-Path $fakeModel "missing-model.onnx"
Assert-ThrowsLike `
    -Action {
        Stage-MeetingRelayDistributionResources `
            -RepositoryRoot $repoRoot `
            -ResourcesRoot (Join-Path $testRoot "missing-staged-resources") `
            -AssetEnvironment $fakeEnvironment `
            -SkipHashVerification
    } `
    -Pattern "MEETINGRELAY_DISTRIBUTION_STAGE_SOURCE_MISSING*" `
    -Label "missing staged model is rejected"

Invoke-MeetingRelayDistributionRelease -DryRun -UnsignedTestBuild

Write-Output "MEETINGRELAY_DISTRIBUTION_CONTRACT_TEST_PASS assertions=90"
