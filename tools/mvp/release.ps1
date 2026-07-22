[CmdletBinding()]
param(
    [string]$CacheRoot = "target/sherpa-native",
    [string]$ArchiveSourceRoot,
    [string]$OutputRoot = "target/mvp/personal-release",
    [switch]$AllowDownload,
    [switch]$UseExistingBuild,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$releaseInvocationParameters = @{
    CacheRoot = $CacheRoot
    ArchiveSourceRoot = $ArchiveSourceRoot
    OutputRoot = $OutputRoot
    AllowDownload = $AllowDownload
    UseExistingBuild = $UseExistingBuild
    DryRun = $DryRun
}
. (Join-Path $PSScriptRoot "start.ps1")
$CacheRoot = $releaseInvocationParameters.CacheRoot
$ArchiveSourceRoot = $releaseInvocationParameters.ArchiveSourceRoot
$OutputRoot = $releaseInvocationParameters.OutputRoot
$AllowDownload = $releaseInvocationParameters.AllowDownload
$UseExistingBuild = $releaseInvocationParameters.UseExistingBuild
$DryRun = $releaseInvocationParameters.DryRun

function Resolve-MvpTargetPath {
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
        throw "MVP_RELEASE_PATH_INVALID label=$Label path=$candidate expected_root=$targetRoot"
    }
    return $candidate
}

function ConvertTo-MvpSingleQuotedPowerShellLiteral {
    param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Value)

    return "'" + $Value.Replace("'", "''") + "'"
}

function New-MvpReleaseLauncher {
    param(
        [Parameter(Mandatory = $true)][string]$LauncherPath,
        [Parameter(Mandatory = $true)][string]$ExecutableName,
        [Parameter(Mandatory = $true)][hashtable]$Environment,
        [Parameter(Mandatory = $true)][hashtable]$PackagePaths
    )

    $orderedNames = @(
        "MEETINGRELAY_SHERPA_LOCK",
        "MEETINGRELAY_PACKAGE_LOCK",
        "MEETINGRELAY_SHERPA_LOCK_SHA256",
        "MEETINGRELAY_SHERPA_PARAMETER_SHA256",
        "SHERPA_ONNX_LIB_DIR",
        "MEETINGRELAY_SHERPA_MODEL",
        "MEETINGRELAY_SHERPA_MODEL_SHA256",
        "MEETINGRELAY_SHERPA_TOKENS",
        "MEETINGRELAY_SHERPA_TOKENS_SHA256",
        "MEETINGRELAY_SHERPA_WAV"
    )
    foreach ($name in $orderedNames) {
        if (-not $Environment.ContainsKey($name) -and -not $PackagePaths.ContainsKey($name)) {
            throw "MVP_RELEASE_LAUNCHER_ENV_MISSING name=$name"
        }
    }

    $lines = @(
        "[CmdletBinding()]",
        "param(",
        "    [Parameter(ValueFromRemainingArguments = `$true)]",
        "    [string[]]`$AppArguments",
        ")",
        "",
        "`$ErrorActionPreference = `"Stop`"",
        "Set-StrictMode -Version Latest",
        "",
        "`$launcherRoot = Split-Path -Parent `$PSCommandPath",
        "`$exePath = Join-Path `$launcherRoot $(ConvertTo-MvpSingleQuotedPowerShellLiteral -Value $ExecutableName)",
        "if (-not (Test-Path -LiteralPath `$exePath -PathType Leaf)) {",
        "    throw `"MEETINGRELAY_RELEASE_EXE_MISSING path=`$exePath`"",
        "}",
        ""
    )
    foreach ($name in $orderedNames) {
        if ($PackagePaths.ContainsKey($name)) {
            $literal = ConvertTo-MvpSingleQuotedPowerShellLiteral -Value ([string]$PackagePaths[$name])
            $lines += "`$" + "env:$name = Join-Path `$launcherRoot $literal"
        }
        else {
            $literal = ConvertTo-MvpSingleQuotedPowerShellLiteral -Value ([string]$Environment[$name])
            $lines += "`$" + "env:$name = $literal"
        }
    }
    $lines += @(
        "",
        "`$env:PATH = `$launcherRoot + [IO.Path]::PathSeparator + `$env:PATH",
        "`$resolvedAppArguments = if (`$null -eq `$AppArguments) { `$null } else { @(`$AppArguments) }",
        "if (`$null -ne `$resolvedAppArguments -and @(`$resolvedAppArguments).Count -gt 0) {",
        "    `$process = Start-Process -FilePath `$exePath -ArgumentList `$resolvedAppArguments -Wait -PassThru",
        "}",
        "else {",
        "    `$process = Start-Process -FilePath `$exePath -Wait -PassThru",
        "}",
        "exit `$process.ExitCode"
    )

    Set-Content -LiteralPath $LauncherPath -Value $lines -Encoding UTF8
}

function Get-MvpLowerSha256 {
    param([Parameter(Mandatory = $true)][string]$Path)

    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Copy-MvpVerifiedFile {
    param(
        [Parameter(Mandatory = $true)][string]$RepositoryRoot,
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Destination,
        [string]$ExpectedSha256,
        [Int64]$ExpectedSizeBytes = -1
    )

    $resolvedDestination = Resolve-MvpTargetPath -RepositoryRoot $RepositoryRoot -Value $Destination -Label "release-copy-destination"
    $destinationParent = Split-Path -Parent $resolvedDestination
    if (-not (Test-Path -LiteralPath $destinationParent -PathType Container)) {
        New-Item -ItemType Directory -Path $destinationParent | Out-Null
    }
    if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) {
        throw "MVP_RELEASE_COPY_SOURCE_MISSING source=$Source"
    }
    $sourceItem = Get-Item -LiteralPath $Source -Force
    if ($ExpectedSizeBytes -ge 0 -and $sourceItem.Length -ne $ExpectedSizeBytes) {
        throw "MVP_RELEASE_COPY_SOURCE_SIZE_MISMATCH source=$Source expected=$ExpectedSizeBytes actual=$($sourceItem.Length)"
    }
    $sourceSha256 = Get-MvpLowerSha256 -Path $Source
    if (-not [string]::IsNullOrWhiteSpace($ExpectedSha256) -and
        $sourceSha256 -ne $ExpectedSha256.ToLowerInvariant()) {
        throw "MVP_RELEASE_COPY_SOURCE_HASH_MISMATCH source=$Source expected=$ExpectedSha256 actual=$sourceSha256"
    }
    Copy-Item -LiteralPath $Source -Destination $resolvedDestination -Force
    $destinationSha256 = Get-MvpLowerSha256 -Path $resolvedDestination
    if ($sourceSha256 -ne $destinationSha256) {
        throw "MVP_RELEASE_COPY_HASH_MISMATCH source=$Source destination=$resolvedDestination"
    }
    return [PSCustomObject]@{
        Source = [IO.Path]::GetFullPath($Source)
        Destination = $resolvedDestination
        Sha256 = $destinationSha256
        SizeBytes = (Get-Item -LiteralPath $resolvedDestination -Force).Length
    }
}

function Copy-MvpPackageLocalAssets {
    param(
        [Parameter(Mandatory = $true)][string]$RepositoryRoot,
        [Parameter(Mandatory = $true)][string]$OutputRoot,
        [Parameter(Mandatory = $true)][hashtable]$AssetEnvironment
    )

    $lockPath = Join-Path $RepositoryRoot "tools/sherpa-native/assets.lock.json"
    $packageLockPath = Join-Path $RepositoryRoot "Cargo.lock"
    $lock = Get-Content -LiteralPath $lockPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $copied = New-Object 'System.Collections.Generic.List[object]'

    $copied.Add((Copy-MvpVerifiedFile `
        -RepositoryRoot $RepositoryRoot `
        -Source $AssetEnvironment["MEETINGRELAY_SHERPA_MODEL"] `
        -Destination (Join-Path $OutputRoot "model/model.int8.onnx") `
        -ExpectedSha256 $AssetEnvironment["MEETINGRELAY_SHERPA_MODEL_SHA256"])) | Out-Null
    $copied.Add((Copy-MvpVerifiedFile `
        -RepositoryRoot $RepositoryRoot `
        -Source $AssetEnvironment["MEETINGRELAY_SHERPA_TOKENS"] `
        -Destination (Join-Path $OutputRoot "model/tokens.txt") `
        -ExpectedSha256 $AssetEnvironment["MEETINGRELAY_SHERPA_TOKENS_SHA256"])) | Out-Null
    $copied.Add((Copy-MvpVerifiedFile `
        -RepositoryRoot $RepositoryRoot `
        -Source $AssetEnvironment["MEETINGRELAY_SHERPA_WAV"] `
        -Destination (Join-Path $OutputRoot "model/test_wavs/zh.wav"))) | Out-Null
    $copied.Add((Copy-MvpVerifiedFile `
        -RepositoryRoot $RepositoryRoot `
        -Source $lockPath `
        -Destination (Join-Path $OutputRoot "locks/assets.lock.json") `
        -ExpectedSha256 $AssetEnvironment["MEETINGRELAY_SHERPA_LOCK_SHA256"])) | Out-Null
    $copied.Add((Copy-MvpVerifiedFile `
        -RepositoryRoot $RepositoryRoot `
        -Source $packageLockPath `
        -Destination (Join-Path $OutputRoot "locks/Cargo.lock"))) | Out-Null

    foreach ($record in @($lock.runtime.archive.inventory | Where-Object { $_.path.StartsWith("lib/", [StringComparison]::Ordinal) })) {
        $relativePath = ([string]$record.path).Replace("/", [IO.Path]::DirectorySeparatorChar)
        $source = Join-Path $AssetEnvironment["SHERPA_ONNX_LIB_DIR"] (Split-Path -Leaf $relativePath)
        $copied.Add((Copy-MvpVerifiedFile `
            -RepositoryRoot $RepositoryRoot `
            -Source $source `
            -Destination (Join-Path $OutputRoot ("runtime/" + $relativePath.Replace("\", "/"))) `
            -ExpectedSha256 $record.sha256 `
            -ExpectedSizeBytes ([Int64]$record.size_bytes))) | Out-Null
    }

    return @($copied.ToArray())
}

function Assert-MvpLauncherHasNoWorkspaceReference {
    param(
        [Parameter(Mandatory = $true)][string]$LauncherPath,
        [Parameter(Mandatory = $true)][string]$RepositoryRoot
    )

    $launcher = Get-Content -LiteralPath $LauncherPath -Raw
    $workspace = [IO.Path]::GetFullPath($RepositoryRoot)
    if ($launcher.Contains($workspace) -or
        $launcher.Contains("target\sherpa-native") -or
        $launcher.Contains("target/sherpa-native") -or
        $launcher.Contains("tools\sherpa-native") -or
        $launcher.Contains("tools/sherpa-native") -or
        [regex]::IsMatch($launcher, "[A-Za-z]:\\")) {
        throw "MVP_RELEASE_LAUNCHER_WORKSPACE_REFERENCE path=$LauncherPath"
    }
}

function Assert-MvpPersonalReleaseOutput {
    param(
        [Parameter(Mandatory = $true)][string]$OutputRoot,
        [Parameter(Mandatory = $true)][string]$ExecutableName
    )

    $requiredFiles = @(
        $ExecutableName,
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
    )
    foreach ($fileName in $requiredFiles) {
        $path = Join-Path $OutputRoot $fileName
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            throw "MVP_RELEASE_OUTPUT_INVALID missing=$path"
        }
    }
}

function Invoke-MeetingRelayMvpRelease {
    param(
        [string]$CacheRoot = "target/sherpa-native",
        [string]$ArchiveSourceRoot,
        [string]$OutputRoot = "target/mvp/personal-release",
        [switch]$AllowDownload,
        [switch]$UseExistingBuild,
        [switch]$DryRun
    )

    if ($env:OS -ne "Windows_NT") {
        throw "MVP_RELEASE_PLATFORM_UNSUPPORTED expected=windows"
    }

    $repoRoot = Get-MvpRepositoryRoot
    $desktopRoot = Join-Path $repoRoot "apps/desktop"
    $releaseTargetRoot = Join-Path $repoRoot "target/release"
    $portableRoot = Resolve-MvpTargetPath -RepositoryRoot $repoRoot -Value $OutputRoot -Label "OutputRoot"
    $materializer = Join-Path $repoRoot "tools/sherpa-native/materialize.ps1"
    $runtimeStager = Join-Path $repoRoot "tools/sherpa-native/stage-runtime.ps1"
    foreach ($requiredFile in @($materializer, $runtimeStager, (Join-Path $desktopRoot "package.json"))) {
        if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) {
            throw "MVP_RELEASE_REPOSITORY_INVALID missing=$requiredFile"
        }
    }

    $nodeCommand = Assert-MvpCommand -Name "node" -InstallHint "Install the repository-pinned Node.js toolchain."
    $nodePath = $nodeCommand.Source
    $null = Assert-MvpCommand -Name "cargo" -InstallHint "Install the Rust MSVC toolchain."
    $pnpmCommand = Assert-MvpCommand -Name "pnpm.cmd" -InstallHint "Enable Corepack for pnpm 9.15.9."
    $pnpmPath = $pnpmCommand.Source

    Write-Host "MEETINGRELAY_MVP_RELEASE_ASSETS cache=$CacheRoot allow_download=$($AllowDownload.IsPresent)"
    $materializeParameters = @{
        CacheRoot = $CacheRoot
        AssetSet = "All"
    }
    if (-not [string]::IsNullOrWhiteSpace($ArchiveSourceRoot)) {
        $materializeParameters["ArchiveSourceRoot"] = $ArchiveSourceRoot
    }
    if ($AllowDownload) {
        $materializeParameters["AllowDownload"] = $true
    }

    try {
        $materializerOutput = @(& $materializer @materializeParameters)
    }
    catch {
        throw "MVP_RELEASE_ASSET_MATERIALIZE_FAILED $($_.Exception.Message)"
    }
    $assetEnvironment = ConvertFrom-MvpEnvironmentOutput -Output $materializerOutput
    $assetEnvironment["PATH"] = "$releaseTargetRoot$([IO.Path]::PathSeparator)$env:PATH"
    $previousEnvironment = Set-MvpEnvironment -Values $assetEnvironment

    try {
        Write-Host "MEETINGRELAY_MVP_RELEASE_RUNTIME_STAGE destination=$releaseTargetRoot"
        try {
            & $runtimeStager `
                -LibDir $assetEnvironment["SHERPA_ONNX_LIB_DIR"] `
                -Configuration Release
        }
        catch {
            throw "MVP_RELEASE_RUNTIME_STAGE_FAILED $($_.Exception.Message)"
        }

        if (-not (Test-MvpFrontendDependencies -DesktopRoot $desktopRoot)) {
            $installArguments = @("install", "--frozen-lockfile")
            if (-not $AllowDownload) {
                $installArguments += "--offline"
            }
            Write-Host "MEETINGRELAY_MVP_RELEASE_FRONTEND_DEPS mode=$(if ($AllowDownload) { 'network-allowed' } else { 'offline-only' })"
            try {
                Invoke-MvpNativeCommand `
                    -FilePath $pnpmPath `
                    -Arguments $installArguments `
                    -WorkingDirectory $repoRoot `
                    -FailureCode "MVP_RELEASE_FRONTEND_DEPS_FAILED"
            }
            catch {
                if (-not $AllowDownload) {
                    throw "MVP_RELEASE_FRONTEND_DEPS_UNAVAILABLE Offline pnpm install failed. Rerun with -AllowDownload only if network acquisition is intended. $($_.Exception.Message)"
                }
                throw
            }
        }

        $tauriCli = Join-Path $desktopRoot "node_modules/@tauri-apps/cli/tauri.js"
        $tauriArguments = @("build", "--no-bundle", "--")
        if (-not $AllowDownload) {
            $tauriArguments += "--offline"
        }
        $tauriArguments += "--locked"
        $tauriCommandLine = '"' + $tauriCli.Replace('"', '\"') + '" ' + ($tauriArguments -join " ")

        if ($DryRun) {
            Write-Host "MEETINGRELAY_MVP_RELEASE_DRY_RUN_OK kind=package-local-personal-internal-evaluation build='node $tauriCommandLine' output=$portableRoot use_existing_build=$($UseExistingBuild.IsPresent)"
            return
        }

        Write-Host "MEETINGRELAY_MVP_RELEASE_BUILD mode=tauri-no-bundle"
        $buildArguments = @($tauriCli) + $tauriArguments
        $builtExecutable = Join-Path $releaseTargetRoot "meetingrelay-desktop.exe"
        $usedExistingBuild = $false
        try {
            Invoke-MvpNativeCommand `
                -FilePath $nodePath `
                -Arguments $buildArguments `
                -WorkingDirectory $desktopRoot `
                -FailureCode "MVP_RELEASE_BUILD_FAILED"
        }
        catch {
            if (-not $UseExistingBuild -or -not (Test-Path -LiteralPath $builtExecutable -PathType Leaf)) {
                throw
            }
            $usedExistingBuild = $true
            Write-Warning "MEETINGRELAY_MVP_RELEASE_USING_EXISTING_BUILD reason='$($_.Exception.Message)' exe=$builtExecutable"
        }
        if (-not (Test-Path -LiteralPath $builtExecutable -PathType Leaf)) {
            throw "MVP_RELEASE_EXE_MISSING path=$builtExecutable"
        }

        if (-not (Test-Path -LiteralPath $portableRoot -PathType Container)) {
            New-Item -ItemType Directory -Path $portableRoot | Out-Null
        }
        Copy-Item -LiteralPath $builtExecutable -Destination (Join-Path $portableRoot "MeetingRelay.exe") -Force
        & $runtimeStager `
            -LibDir $assetEnvironment["SHERPA_ONNX_LIB_DIR"] `
            -Configuration Release `
            -DestinationRoot $portableRoot
        $copiedPackageFiles = Copy-MvpPackageLocalAssets `
            -RepositoryRoot $repoRoot `
            -OutputRoot $portableRoot `
            -AssetEnvironment $assetEnvironment

        $launchEnvironment = @{}
        foreach ($name in $assetEnvironment.Keys) {
            if ($name -ne "PATH") {
                $launchEnvironment[$name] = $assetEnvironment[$name]
            }
        }
        New-MvpReleaseLauncher `
            -LauncherPath (Join-Path $portableRoot "MeetingRelay.same-machine.ps1") `
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
        Assert-MvpPersonalReleaseOutput -OutputRoot $portableRoot -ExecutableName "MeetingRelay.exe"
        Assert-MvpLauncherHasNoWorkspaceReference -LauncherPath (Join-Path $portableRoot "MeetingRelay.same-machine.ps1") -RepositoryRoot $repoRoot

        Write-Host "MEETINGRELAY_MVP_RELEASE_READY kind=package-local-personal-internal-evaluation used_existing_build=$usedExistingBuild copied_files=$($copiedPackageFiles.Count) root=$portableRoot exe=$(Join-Path $portableRoot 'MeetingRelay.exe') launcher=$(Join-Path $portableRoot 'MeetingRelay.same-machine.ps1')"
    }
    finally {
        Restore-MvpEnvironment -Previous $previousEnvironment
    }
}

if ($MyInvocation.InvocationName -ne ".") {
    try {
        Invoke-MeetingRelayMvpRelease `
            -CacheRoot $CacheRoot `
            -ArchiveSourceRoot $ArchiveSourceRoot `
            -OutputRoot $OutputRoot `
            -AllowDownload:$AllowDownload `
            -UseExistingBuild:$UseExistingBuild `
            -DryRun:$DryRun
    }
    catch {
        Write-Error "MEETINGRELAY_MVP_RELEASE_FAILED $($_.Exception.Message)"
        exit 1
    }
}
