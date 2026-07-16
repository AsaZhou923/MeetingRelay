[CmdletBinding()]
param(
    [string]$CacheRoot = "target/sherpa-native",
    [string]$ArchiveSourceRoot,
    [switch]$AllowDownload,
    [switch]$SkipFrontendBuild,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Get-MvpRepositoryRoot {
    $scriptRoot = Split-Path -Parent $PSCommandPath
    return [IO.Path]::GetFullPath((Join-Path $scriptRoot "../.."))
}

function Assert-MvpCommand {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [string]$InstallHint
    )

    $command = Get-Command $Name -ErrorAction SilentlyContinue
    if ($null -eq $command) {
        $hint = if ([string]::IsNullOrWhiteSpace($InstallHint)) { "" } else { " $InstallHint" }
        throw "MVP_TOOL_MISSING name=$Name.$hint"
    }
    return $command
}

function ConvertFrom-MvpEnvironmentOutput {
    param([Parameter(Mandatory = $true)][AllowEmptyCollection()][object[]]$Output)

    $requiredNames = @(
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
    $allowedNames = @{}
    foreach ($name in $requiredNames) {
        $allowedNames[$name] = $true
    }

    $result = @{}
    foreach ($entry in $Output) {
        $line = [string]$entry
        $match = [regex]::Match($line, "\A([A-Z][A-Z0-9_]*)=(.*)\z")
        if (-not $match.Success) {
            if (-not [string]::IsNullOrWhiteSpace($line)) {
                Write-Verbose "materializer: $line"
            }
            continue
        }

        $name = $match.Groups[1].Value
        if (-not $allowedNames.ContainsKey($name)) {
            throw "MVP_ASSET_ENV_INVALID unexpected_name=$name"
        }
        if ($result.ContainsKey($name)) {
            throw "MVP_ASSET_ENV_INVALID duplicate_name=$name"
        }

        $value = $match.Groups[2].Value
        if ([string]::IsNullOrWhiteSpace($value) -or $value.Contains([char]0)) {
            throw "MVP_ASSET_ENV_INVALID empty_or_nul_name=$name"
        }
        $result[$name] = $value
    }

    foreach ($name in $requiredNames) {
        if (-not $result.ContainsKey($name)) {
            throw "MVP_ASSET_ENV_INVALID missing_name=$name"
        }
    }
    return $result
}

function Set-MvpEnvironment {
    param([Parameter(Mandatory = $true)][hashtable]$Values)

    $previous = @{}
    foreach ($name in $Values.Keys) {
        $environmentPath = "Env:$name"
        $exists = Test-Path -LiteralPath $environmentPath
        $previous[$name] = [PSCustomObject]@{
            Exists = $exists
            Value = if ($exists) { (Get-Item -LiteralPath $environmentPath).Value } else { $null }
        }
        Set-Item -LiteralPath $environmentPath -Value $Values[$name]
    }
    return $previous
}

function Restore-MvpEnvironment {
    param([Parameter(Mandatory = $true)][hashtable]$Previous)

    foreach ($name in $Previous.Keys) {
        $environmentPath = "Env:$name"
        if ($Previous[$name].Exists) {
            Set-Item -LiteralPath $environmentPath -Value $Previous[$name].Value
        }
        else {
            Remove-Item -LiteralPath $environmentPath -ErrorAction SilentlyContinue
        }
    }
}

function Invoke-MvpNativeCommand {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [Parameter(Mandatory = $true)][string]$WorkingDirectory,
        [Parameter(Mandatory = $true)][string]$FailureCode
    )

    Push-Location -LiteralPath $WorkingDirectory
    try {
        & $FilePath @Arguments
        if ($LASTEXITCODE -ne 0) {
            throw "$FailureCode exit_code=$LASTEXITCODE"
        }
    }
    finally {
        Pop-Location
    }
}

function Test-MvpFrontendDependencies {
    param([Parameter(Mandatory = $true)][string]$DesktopRoot)

    $requiredPaths = @(
        "node_modules/@tauri-apps/cli/tauri.js",
        "node_modules/typescript/bin/tsc",
        "node_modules/vite/bin/vite.js"
    )
    foreach ($relativePath in $requiredPaths) {
        if (-not (Test-Path -LiteralPath (Join-Path $DesktopRoot $relativePath) -PathType Leaf)) {
            return $false
        }
    }
    return $true
}

function Assert-MvpRuntimePrecedenceSafe {
    param(
        [Parameter(Mandatory = $true)][string]$StagedRuntimeRoot,
        [Parameter(Mandatory = $true)][string]$ApplicationDirectory
    )

    $stagedDlls = @(Get-ChildItem -LiteralPath $StagedRuntimeRoot -Filter "*.dll" -File -Force)
    if ($stagedDlls.Count -ne 4) {
        throw "MVP_RUNTIME_STAGE_INVALID expected_dlls=4 actual_dlls=$($stagedDlls.Count)"
    }
    foreach ($stagedDll in $stagedDlls) {
        $applicationCopy = Join-Path $ApplicationDirectory $stagedDll.Name
        if (-not (Test-Path -LiteralPath $applicationCopy -PathType Leaf)) {
            continue
        }
        $stagedHash = (Get-FileHash -LiteralPath $stagedDll.FullName -Algorithm SHA256).Hash
        $applicationHash = (Get-FileHash -LiteralPath $applicationCopy -Algorithm SHA256).Hash
        if ($stagedHash -ne $applicationHash) {
            throw "MVP_RUNTIME_CONFLICT file=$applicationCopy Close any running MeetingRelay instance, then remove stale target output before retrying."
        }
    }
}

function Stop-MvpProcessTree {
    param([Parameter(Mandatory = $true)][Diagnostics.Process]$Process)

    if ($Process.HasExited) {
        return
    }

    Write-Host "MEETINGRELAY_MVP_CLEANUP pid=$($Process.Id)"
    $taskkill = Join-Path $env:SystemRoot "System32/taskkill.exe"
    if (Test-Path -LiteralPath $taskkill -PathType Leaf) {
        & $taskkill /PID $Process.Id /T /F 2>$null | Out-Null
    }
    if (-not $Process.WaitForExit(5000)) {
        $Process.Kill()
        $Process.WaitForExit()
    }
}

function Invoke-MeetingRelayMvp {
    param(
        [string]$CacheRoot = "target/sherpa-native",
        [string]$ArchiveSourceRoot,
        [switch]$AllowDownload,
        [switch]$SkipFrontendBuild,
        [switch]$DryRun
    )

    if ($env:OS -ne "Windows_NT") {
        throw "MVP_PLATFORM_UNSUPPORTED expected=windows"
    }

    $repoRoot = Get-MvpRepositoryRoot
    $desktopRoot = Join-Path $repoRoot "apps/desktop"
    $runtimeStageRoot = Join-Path $repoRoot "target/mvp/runtime"
    $materializer = Join-Path $repoRoot "tools/sherpa-native/materialize.ps1"
    $runtimeStager = Join-Path $repoRoot "tools/sherpa-native/stage-runtime.ps1"
    foreach ($requiredFile in @($materializer, $runtimeStager, (Join-Path $desktopRoot "package.json"))) {
        if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) {
            throw "MVP_REPOSITORY_INVALID missing=$requiredFile"
        }
    }

    $nodeCommand = Assert-MvpCommand -Name "node" -InstallHint "Install the repository-pinned Node.js toolchain."
    $nodePath = $nodeCommand.Source
    $null = Assert-MvpCommand -Name "cargo" -InstallHint "Install the Rust MSVC toolchain."
    $pnpmCommand = Assert-MvpCommand -Name "pnpm.cmd" -InstallHint "Enable Corepack for pnpm 9.15.9."
    $pnpmPath = $pnpmCommand.Source

    Write-Host "MEETINGRELAY_MVP_ASSETS cache=$CacheRoot allow_download=$($AllowDownload.IsPresent)"
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
        throw "MVP_ASSET_MATERIALIZE_FAILED $($_.Exception.Message)"
    }
    $assetEnvironment = ConvertFrom-MvpEnvironmentOutput -Output $materializerOutput
    $assetEnvironment["PATH"] = "$runtimeStageRoot$([IO.Path]::PathSeparator)$env:PATH"
    $previousEnvironment = Set-MvpEnvironment -Values $assetEnvironment

    try {
        Write-Host "MEETINGRELAY_MVP_RUNTIME_STAGE destination=$runtimeStageRoot"
        try {
            & $runtimeStager `
                -LibDir $assetEnvironment["SHERPA_ONNX_LIB_DIR"] `
                -Configuration Debug `
                -DestinationRoot $runtimeStageRoot
            Assert-MvpRuntimePrecedenceSafe `
                -StagedRuntimeRoot $runtimeStageRoot `
                -ApplicationDirectory (Join-Path $repoRoot "target/debug")
        }
        catch {
            throw "MVP_RUNTIME_STAGE_FAILED $($_.Exception.Message)"
        }

        if (-not (Test-MvpFrontendDependencies -DesktopRoot $desktopRoot)) {
            $installArguments = @("install", "--frozen-lockfile")
            if (-not $AllowDownload) {
                $installArguments += "--offline"
            }
            Write-Host "MEETINGRELAY_MVP_FRONTEND_DEPS mode=$(if ($AllowDownload) { 'network-allowed' } else { 'offline-only' })"
            try {
                Invoke-MvpNativeCommand `
                    -FilePath $pnpmPath `
                    -Arguments $installArguments `
                    -WorkingDirectory $repoRoot `
                    -FailureCode "MVP_FRONTEND_DEPS_FAILED"
            }
            catch {
                if (-not $AllowDownload) {
                    throw "MVP_FRONTEND_DEPS_UNAVAILABLE Offline pnpm install failed. Rerun with -AllowDownload only if network acquisition is intended. $($_.Exception.Message)"
                }
                throw
            }
        }

        if (-not $SkipFrontendBuild) {
            Write-Host "MEETINGRELAY_MVP_FRONTEND_BUILD"
            Invoke-MvpNativeCommand `
                -FilePath $pnpmPath `
                -Arguments @("build") `
                -WorkingDirectory $desktopRoot `
                -FailureCode "MVP_FRONTEND_BUILD_FAILED"
        }

        $tauriCli = Join-Path $desktopRoot "node_modules/@tauri-apps/cli/tauri.js"
        $tauriArguments = @("dev", "--no-watch", "--")
        if (-not $AllowDownload) {
            $tauriArguments += "--offline"
        }
        $tauriArguments += "--locked"
        $tauriCommandLine = '"' + $tauriCli.Replace('"', '\"') + '" ' + ($tauriArguments -join " ")

        if ($DryRun) {
            Write-Host "MEETINGRELAY_MVP_DRY_RUN_OK launch='node $tauriCommandLine'"
            return
        }

        Write-Host "MEETINGRELAY_MVP_START mode=tauri-dev"
        Write-Host "Close the MeetingRelay window or press Ctrl+C here to stop all launcher child processes."
        $process = $null
        try {
            $startInfo = [Diagnostics.ProcessStartInfo]::new()
            $startInfo.FileName = $nodePath
            $startInfo.Arguments = $tauriCommandLine
            $startInfo.WorkingDirectory = $desktopRoot
            $startInfo.UseShellExecute = $false
            $startInfo.CreateNoWindow = $true
            $process = [Diagnostics.Process]::new()
            $process.StartInfo = $startInfo
            if (-not $process.Start()) {
                throw "MVP_TAURI_DEV_START_FAILED"
            }
            while (-not $process.WaitForExit(250)) {
                # A bounded wait lets PowerShell process Ctrl+C and enter the cleanup block.
            }
            $process.WaitForExit()
            $exitCode = $process.ExitCode
            # Tauri dev terminates its Vite before-command with -1 after the
            # last desktop window closes normally on Windows.
            if ($exitCode -ne 0 -and $exitCode -ne -1) {
                throw "MVP_TAURI_DEV_FAILED exit_code=$exitCode"
            }
            Write-Host "MEETINGRELAY_MVP_STOPPED exit_code=$exitCode"
        }
        finally {
            if ($null -ne $process) {
                Stop-MvpProcessTree -Process $process
                $process.Dispose()
            }
        }
    }
    finally {
        Restore-MvpEnvironment -Previous $previousEnvironment
    }
}

if ($MyInvocation.InvocationName -ne ".") {
    try {
        Invoke-MeetingRelayMvp `
            -CacheRoot $CacheRoot `
            -ArchiveSourceRoot $ArchiveSourceRoot `
            -AllowDownload:$AllowDownload `
            -SkipFrontendBuild:$SkipFrontendBuild `
            -DryRun:$DryRun
    }
    catch {
        Write-Error "MEETINGRELAY_MVP_LAUNCH_FAILED $($_.Exception.Message)"
        exit 1
    }
}
