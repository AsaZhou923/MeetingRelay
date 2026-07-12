[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$RuntimeDir,
    [Parameter(Mandatory = $true)][string]$TestExecutable,
    [Parameter(Mandatory = $true)][ValidateSet("Debug", "Release")][string]$Configuration,
    [ValidateRange(1000, 15000)][int]$HoldMilliseconds = 10000,
    [ValidateRange(5, 120)][int]$ReadyTimeoutSeconds = 60,
    [ValidateRange(10, 300)][int]$ExitTimeoutSeconds = 120
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = [IO.Path]::GetFullPath((Join-Path $scriptRoot "../.."))
$targetRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot "target"))
$lockPath = Join-Path $scriptRoot "assets.lock.json"

function Get-ExistingPathAttributes {
    param([Parameter(Mandatory = $true)][string]$Path)
    try {
        return [IO.File]::GetAttributes([IO.Path]::GetFullPath($Path))
    }
    catch [IO.FileNotFoundException] {
        return $null
    }
    catch [IO.DirectoryNotFoundException] {
        return $null
    }
}

function Assert-NoReparsePathChain {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Label
    )
    $current = [IO.Path]::GetFullPath($Path)
    while ($null -ne $current) {
        $attributes = Get-ExistingPathAttributes -Path $current
        if ($null -ne $attributes -and ($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "$Label path chain contains a reparse point: $current"
        }
        $parent = [IO.Directory]::GetParent($current)
        $current = if ($null -eq $parent) { $null } else { $parent.FullName }
    }
}

function Resolve-UnderTarget {
    param(
        [Parameter(Mandatory = $true)][string]$Value,
        [Parameter(Mandatory = $true)][string]$Label
    )
    $candidate = if ([IO.Path]::IsPathRooted($Value)) {
        [IO.Path]::GetFullPath($Value)
    }
    else {
        [IO.Path]::GetFullPath((Join-Path $repoRoot $Value))
    }
    $prefix = $targetRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    if (-not $candidate.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "$Label must resolve below the repository target directory: $candidate"
    }
    Assert-NoReparsePathChain -Path $candidate -Label $Label
    return $candidate
}

function Assert-RegularFile {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Label
    )
    Assert-NoReparsePathChain -Path $Path -Label $Label
    $attributes = Get-ExistingPathAttributes -Path $Path
    if ($null -eq $attributes -or
        ($attributes -band [IO.FileAttributes]::Directory) -ne 0 -or
        ($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "$Label is not an existing regular non-reparse file: $Path"
    }
}

function Get-LowerSha256 {
    param([Parameter(Mandatory = $true)][string]$Path)
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Assert-FileIdentity {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)]$Record,
        [Parameter(Mandatory = $true)][string]$Label
    )
    Assert-RegularFile -Path $Path -Label $Label
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if ($item.Length -ne [Int64]$Record.size_bytes -or (Get-LowerSha256 -Path $Path) -ne $Record.sha256) {
        throw "$Label differs from the sealed lock identity: $Path"
    }
}

function Remove-ProbeFile {
    param([Parameter(Mandatory = $true)][string]$Path)
    $attributes = Get-ExistingPathAttributes -Path $Path
    if ($null -eq $attributes) {
        return
    }
    if (($attributes -band [IO.FileAttributes]::Directory) -ne 0 -or
        ($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Refusing to replace a non-regular or reparse probe file: $Path"
    }
    Remove-Item -LiteralPath $Path -Force
}

& node (Join-Path $scriptRoot "validate-lock.mjs") $lockPath
if ($LASTEXITCODE -ne 0) {
    throw "Committed sherpa native asset lock validation failed"
}
$lock = Get-Content -LiteralPath $lockPath -Raw -Encoding UTF8 | ConvertFrom-Json
$runtimeDllRecords = @($lock.runtime.archive.inventory | Where-Object { $_.path.EndsWith(".dll", [StringComparison]::OrdinalIgnoreCase) })
if ($runtimeDllRecords.Count -ne 4) {
    throw "Expected exactly four locked runtime DLLs"
}
$recordsByName = @{}
foreach ($record in $runtimeDllRecords) {
    $name = (Split-Path -Leaf $record.path).ToLowerInvariant()
    if ($recordsByName.ContainsKey($name)) {
        throw "Duplicate locked runtime DLL basename: $name"
    }
    $recordsByName[$name] = $record
}

$resolvedRuntimeDir = Resolve-UnderTarget -Value $RuntimeDir -Label "RuntimeDir"
$runtimeAttributes = Get-ExistingPathAttributes -Path $resolvedRuntimeDir
if ($null -eq $runtimeAttributes -or ($runtimeAttributes -band [IO.FileAttributes]::Directory) -eq 0) {
    throw "RuntimeDir is not an existing real directory: $resolvedRuntimeDir"
}
foreach ($name in $recordsByName.Keys) {
    Assert-FileIdentity -Path (Join-Path $resolvedRuntimeDir $name) -Record $recordsByName[$name] -Label "source runtime DLL"
}

$resolvedTestExecutable = Resolve-UnderTarget -Value $TestExecutable -Label "TestExecutable"
Assert-RegularFile -Path $resolvedTestExecutable -Label "native smoke test executable"
if ((Split-Path -Leaf $resolvedTestExecutable) -notmatch '^native_sherpa_smoke-[0-9a-f]+\.exe$') {
    throw "TestExecutable is not an exact Cargo native smoke test artifact: $resolvedTestExecutable"
}
$executableDirectory = [IO.Path]::GetFullPath((Split-Path -Parent $resolvedTestExecutable))
Assert-NoReparsePathChain -Path $executableDirectory -Label "native smoke executable directory"
foreach ($name in $recordsByName.Keys) {
    Assert-FileIdentity -Path (Join-Path $executableDirectory $name) -Record $recordsByName[$name] -Label "staged runtime DLL"
}

$probeDirectory = Resolve-UnderTarget -Value (Join-Path $targetRoot "sherpa-native/module-probe/$($Configuration.ToLowerInvariant())") -Label "module probe directory"
$probeAttributes = Get-ExistingPathAttributes -Path $probeDirectory
if ($null -eq $probeAttributes) {
    New-Item -ItemType Directory -Path $probeDirectory | Out-Null
}
elseif (($probeAttributes -band [IO.FileAttributes]::Directory) -eq 0) {
    throw "Module probe path is not a directory: $probeDirectory"
}
$probeDirectory = Resolve-UnderTarget -Value $probeDirectory -Label "created module probe directory"
$readyFile = Join-Path $probeDirectory "ready.txt"
$stdoutFile = Join-Path $probeDirectory "stdout.txt"
$stderrFile = Join-Path $probeDirectory "stderr.txt"
foreach ($path in @($readyFile, $stdoutFile, $stderrFile)) {
    Remove-ProbeFile -Path $path
}

$requiredEnvironment = @(
    "MEETINGRELAY_SHERPA_LOCK",
    "MEETINGRELAY_SHERPA_MODEL",
    "MEETINGRELAY_SHERPA_TOKENS",
    "MEETINGRELAY_SHERPA_WAV",
    "SHERPA_ONNX_LIB_DIR"
)
foreach ($name in $requiredEnvironment) {
    if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($name, "Process"))) {
        throw "Required native smoke environment variable is missing: $name"
    }
}

$savedPath = $env:PATH
$savedReadyFile = [Environment]::GetEnvironmentVariable("MEETINGRELAY_SHERPA_MODULE_PROBE_READY_FILE", "Process")
$savedHold = [Environment]::GetEnvironmentVariable("MEETINGRELAY_SHERPA_MODULE_PROBE_HOLD_MS", "Process")
$process = [Diagnostics.Process]::new()
$processStarted = $false
$stdoutTask = $null
$stderrTask = $null
try {
    $env:PATH = "$executableDirectory;$(Join-Path $env:SystemRoot 'System32')"
    $env:MEETINGRELAY_SHERPA_MODULE_PROBE_READY_FILE = $readyFile
    $env:MEETINGRELAY_SHERPA_MODULE_PROBE_HOLD_MS = $HoldMilliseconds.ToString([Globalization.CultureInfo]::InvariantCulture)
    $testArguments = @(
        "--ignored",
        "--exact",
        "native_sense_voice_smoke_returns_nonempty_final",
        "--nocapture",
        "--test-threads=1"
    )
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $resolvedTestExecutable
    $startInfo.Arguments = $testArguments -join " "
    $startInfo.WorkingDirectory = $repoRoot
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $process.StartInfo = $startInfo
    if (-not $process.Start()) {
        throw "Could not start the native smoke executable"
    }
    $processStarted = $true
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()

    $readyDeadline = [DateTime]::UtcNow.AddSeconds($ReadyTimeoutSeconds)
    while (-not (Test-Path -LiteralPath $readyFile -PathType Leaf)) {
        $process.Refresh()
        if ($process.HasExited) {
            throw "Native smoke exited before publishing its loaded-module probe PID (exit $($process.ExitCode))"
        }
        if ([DateTime]::UtcNow -ge $readyDeadline) {
            throw "Timed out waiting for the native smoke loaded-module probe"
        }
        Start-Sleep -Milliseconds 100
    }
    Assert-RegularFile -Path $readyFile -Label "module probe ready file"
    $publishedPid = [int](Get-Content -LiteralPath $readyFile -Raw -Encoding UTF8).Trim()
    if ($publishedPid -ne $process.Id) {
        throw "Native smoke published an unexpected PID: expected $($process.Id), got $publishedPid"
    }

    $modules = @(Get-Process -Id $process.Id -Module -ErrorAction Stop)
    $loadedLockedModules = @($modules | Where-Object { $recordsByName.ContainsKey($_.ModuleName.ToLowerInvariant()) })
    foreach ($module in $loadedLockedModules) {
        $name = $module.ModuleName.ToLowerInvariant()
        $expectedPath = [IO.Path]::GetFullPath((Join-Path $executableDirectory $name))
        $actualPath = [IO.Path]::GetFullPath($module.FileName)
        if (-not $actualPath.Equals($expectedPath, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Locked runtime module loaded from outside the executable directory: $name ($actualPath)"
        }
        Assert-FileIdentity -Path $actualPath -Record $recordsByName[$name] -Label "loaded runtime module"
    }
    foreach ($requiredName in @("sherpa-onnx-c-api.dll", "onnxruntime.dll")) {
        $matches = @($loadedLockedModules | Where-Object { $_.ModuleName.Equals($requiredName, [StringComparison]::OrdinalIgnoreCase) })
        if ($matches.Count -ne 1) {
            throw "Expected exactly one loaded $requiredName module, got $($matches.Count)"
        }
    }
    Write-Output "LOADED_RUNTIME_MODULES=PASS configuration=$Configuration modules=$(@($loadedLockedModules.ModuleName | Sort-Object) -join ',')"

    if (-not $process.WaitForExit($ExitTimeoutSeconds * 1000)) {
        throw "Native smoke did not exit within $ExitTimeoutSeconds seconds"
    }
    $process.WaitForExit()
    $process.Refresh()
    $stdout = $stdoutTask.GetAwaiter().GetResult()
    $stderr = $stderrTask.GetAwaiter().GetResult()
    [IO.File]::WriteAllText($stdoutFile, $stdout, [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText($stderrFile, $stderr, [Text.UTF8Encoding]::new($false))
    if (-not [string]::IsNullOrWhiteSpace($stdout)) {
        $stdout | Write-Output
    }
    if (-not [string]::IsNullOrWhiteSpace($stderr)) {
        $stderr | Write-Output
    }
    $exitCode = $process.ExitCode
    if ($null -eq $exitCode -or $exitCode -ne 0) {
        throw "Native smoke exited with code $exitCode"
    }
    Write-Output "NATIVE_SMOKE_DIRECT=PASS configuration=$Configuration executable=$resolvedTestExecutable"
}
finally {
    $env:PATH = $savedPath
    if ($null -eq $savedReadyFile) {
        Remove-Item Env:MEETINGRELAY_SHERPA_MODULE_PROBE_READY_FILE -ErrorAction SilentlyContinue
    }
    else {
        $env:MEETINGRELAY_SHERPA_MODULE_PROBE_READY_FILE = $savedReadyFile
    }
    if ($null -eq $savedHold) {
        Remove-Item Env:MEETINGRELAY_SHERPA_MODULE_PROBE_HOLD_MS -ErrorAction SilentlyContinue
    }
    else {
        $env:MEETINGRELAY_SHERPA_MODULE_PROBE_HOLD_MS = $savedHold
    }
    if ($processStarted) {
        $process.Refresh()
        if (-not $process.HasExited) {
            Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
        }
    }
    $process.Dispose()
}
