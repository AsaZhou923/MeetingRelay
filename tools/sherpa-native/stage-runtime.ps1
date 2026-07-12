[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$LibDir,
    [ValidateSet("Debug", "Release", "All")]
    [string]$Configuration = "All",
    [string]$DestinationRoot
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
        throw "$Label must remain below the repository target directory: $candidate"
    }
    Assert-NoReparsePathChain -Path $candidate -Label $Label
    return $candidate
}

function Test-SameOrDescendantPath {
    param(
        [Parameter(Mandatory = $true)][string]$Candidate,
        [Parameter(Mandatory = $true)][string]$Parent
    )
    $resolvedCandidate = [IO.Path]::GetFullPath($Candidate).TrimEnd([IO.Path]::DirectorySeparatorChar)
    $resolvedParent = [IO.Path]::GetFullPath($Parent).TrimEnd([IO.Path]::DirectorySeparatorChar)
    $parentPrefix = $resolvedParent + [IO.Path]::DirectorySeparatorChar
    return $resolvedCandidate.Equals($resolvedParent, [StringComparison]::OrdinalIgnoreCase) -or
        $resolvedCandidate.StartsWith($parentPrefix, [StringComparison]::OrdinalIgnoreCase)
}

function New-SafeDirectory {
    param([Parameter(Mandatory = $true)][string]$Path)
    $resolved = Resolve-UnderTarget -Value $Path -Label "staging directory"
    $attributes = Get-ExistingPathAttributes -Path $resolved
    if ($null -eq $attributes) {
        New-Item -ItemType Directory -Path $resolved | Out-Null
    }
    elseif (($attributes -band [IO.FileAttributes]::Directory) -eq 0) {
        throw "Staging destination is not a directory: $resolved"
    }
    $null = Resolve-UnderTarget -Value $resolved -Label "created staging directory"
    Assert-NoReparsePathChain -Path $resolved -Label "created staging directory"
}

function Get-LowerSha256 {
    param([Parameter(Mandatory = $true)][string]$Path)
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Assert-Identity {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)]$Record
    )
    Assert-NoReparsePathChain -Path $Path -Label "runtime file"
    $attributes = Get-ExistingPathAttributes -Path $Path
    if ($null -eq $attributes -or
        ($attributes -band [IO.FileAttributes]::Directory) -ne 0 -or
        ($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Runtime entry is not a regular non-reparse file: $Path"
    }
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if ($item.Length -ne [Int64]$Record.size_bytes -or (Get-LowerSha256 -Path $Path) -ne $Record.sha256) {
        throw "Runtime file differs from the sealed inventory: $Path"
    }
}

function Remove-ExistingRegularFile {
    param([Parameter(Mandatory = $true)][string]$Path)
    $null = Resolve-UnderTarget -Value $Path -Label "staging replacement"
    $attributes = Get-ExistingPathAttributes -Path $Path
    if ($null -eq $attributes) {
        return
    }
    if (($attributes -band [IO.FileAttributes]::Directory) -ne 0 -or
        ($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Refusing to replace a non-regular or reparse entry: $Path"
    }
    Remove-Item -LiteralPath $Path -Force
    Assert-NoReparsePathChain -Path (Split-Path -Parent $Path) -Label "post-removal staging parent"
}

& node (Join-Path $scriptRoot "validate-lock.mjs") $lockPath
if ($LASTEXITCODE -ne 0) {
    throw "Committed sherpa native asset lock validation failed"
}

$resolvedLibDir = Resolve-UnderTarget -Value $LibDir -Label "LibDir"
$libAttributes = Get-ExistingPathAttributes -Path $resolvedLibDir
if ($null -eq $libAttributes -or ($libAttributes -band [IO.FileAttributes]::Directory) -eq 0) {
    throw "Pinned runtime lib directory does not exist: $resolvedLibDir"
}

$lock = Get-Content -LiteralPath $lockPath -Raw -Encoding UTF8 | ConvertFrom-Json
$runtimeRecords = @($lock.runtime.archive.inventory | Where-Object { $_.path.StartsWith("lib/", [StringComparison]::Ordinal) })
if ($runtimeRecords.Count -ne 7) {
    throw "Expected exactly seven locked runtime library files"
}
$expectedByName = @{}
foreach ($record in $runtimeRecords) {
    $name = Split-Path -Leaf $record.path
    if ($expectedByName.ContainsKey($name)) {
        throw "Duplicate runtime inventory basename: $name"
    }
    $expectedByName[$name] = $record
}
$actualEntries = @(Get-ChildItem -LiteralPath $resolvedLibDir -Force -ErrorAction Stop)
if ($actualEntries.Count -ne $runtimeRecords.Count) {
    throw "Runtime lib directory differs from the exact seven-file inventory"
}
foreach ($entry in $actualEntries) {
    if (-not $expectedByName.ContainsKey($entry.Name)) {
        throw "Runtime lib directory contains an unsealed entry: $($entry.FullName)"
    }
    Assert-Identity -Path $entry.FullName -Record $expectedByName[$entry.Name]
}

$dlls = @($runtimeRecords | Where-Object { $_.path.EndsWith(".dll", [StringComparison]::OrdinalIgnoreCase) })
if ($dlls.Count -ne 4) {
    throw "Expected exactly four locked runtime DLLs"
}

$destinationDirectories = @()
if ($DestinationRoot) {
    $destinationDirectories = @(Resolve-UnderTarget -Value $DestinationRoot -Label "DestinationRoot")
}
else {
    $profiles = switch ($Configuration) {
        "Debug" { @("debug") }
        "Release" { @("release") }
        default { @("debug", "release") }
    }
    foreach ($profile in $profiles) {
        foreach ($relativeDestination in @($profile, "$profile/deps", "$profile/examples")) {
            $destinationDirectories += Resolve-UnderTarget -Value (Join-Path $targetRoot $relativeDestination) -Label "profile staging directory"
        }
    }
}

foreach ($destinationDirectory in $destinationDirectories) {
    $destinationOverlapsSource =
        (Test-SameOrDescendantPath -Candidate $destinationDirectory -Parent $resolvedLibDir) -or
        (Test-SameOrDescendantPath -Candidate $resolvedLibDir -Parent $destinationDirectory)
    if ($destinationOverlapsSource) {
        throw "Staging destination must not equal, contain, or be contained by LibDir: $destinationDirectory"
    }
}

foreach ($destinationDirectory in $destinationDirectories) {
    New-SafeDirectory -Path $destinationDirectory
    foreach ($record in $dlls) {
        $name = Split-Path -Leaf $record.path
        $source = Join-Path $resolvedLibDir $name
        Assert-Identity -Path $source -Record $record
        $destination = Join-Path $destinationDirectory $name
        $partial = "$destination.meetingrelay-part"
        $backup = "$destination.meetingrelay-backup"
        Remove-ExistingRegularFile -Path $partial
        Remove-ExistingRegularFile -Path $backup
        $null = Resolve-UnderTarget -Value $partial -Label "runtime staging partial"
        $null = Resolve-UnderTarget -Value $backup -Label "runtime staging backup"
        Copy-Item -LiteralPath $source -Destination $partial
        $null = Resolve-UnderTarget -Value $partial -Label "written runtime staging partial"
        Assert-Identity -Path $partial -Record $record
        $destinationAttributes = Get-ExistingPathAttributes -Path $destination
        if ($null -eq $destinationAttributes) {
            [IO.File]::Move($partial, $destination)
        }
        else {
            if (($destinationAttributes -band [IO.FileAttributes]::Directory) -ne 0 -or
                ($destinationAttributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Refusing to replace a non-regular or reparse entry: $destination"
            }
            [IO.File]::Replace($partial, $destination, $backup)
        }
        $null = Resolve-UnderTarget -Value $destination -Label "staged runtime DLL"
        Assert-Identity -Path $destination -Record $record
        Remove-ExistingRegularFile -Path $backup
    }
    Write-Output "SHERPA_RUNTIME_STAGED=$destinationDirectory"
}
