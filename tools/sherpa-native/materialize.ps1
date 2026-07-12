[CmdletBinding()]
param(
    [string]$CacheRoot = "target/sherpa-native",
    [string]$ArchiveSourceRoot,
    [string]$ArchiveTarPath,
    [string]$ArchiveBzip2Path,
    [ValidateSet("All", "Runtime", "Model")]
    [string]$AssetSet = "All",
    [switch]$AllowDownload
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

function Assert-RealDirectory {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Label
    )

    Assert-NoReparsePathChain -Path $Path -Label $Label
    $attributes = Get-ExistingPathAttributes -Path $Path
    if ($null -eq $attributes -or ($attributes -band [IO.FileAttributes]::Directory) -eq 0) {
        throw "$Label is not an existing real directory: $Path"
    }
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

function Assert-WithinCache {
    param(
        [Parameter(Mandatory = $true)][string]$Value,
        [string]$Label = "mutation"
    )

    $candidate = [IO.Path]::GetFullPath($Value)
    $prefix = $resolvedCacheRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    if ($candidate -ne $resolvedCacheRoot -and
        -not $candidate.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing filesystem mutation outside the verified cache root: $candidate"
    }
    Assert-NoReparsePathChain -Path $candidate -Label $Label
}

function New-SafeCacheDirectory {
    param([Parameter(Mandatory = $true)][string]$Path)

    Assert-WithinCache -Value $Path -Label "directory creation"
    $attributes = Get-ExistingPathAttributes -Path $Path
    if ($null -eq $attributes) {
        New-Item -ItemType Directory -Path $Path | Out-Null
    }
    elseif (($attributes -band [IO.FileAttributes]::Directory) -eq 0) {
        throw "Refusing to replace a non-directory cache entry: $Path"
    }
    Assert-WithinCache -Value $Path -Label "created directory"
    Assert-RealDirectory -Path $Path -Label "created directory"
}

function Get-SafeTree {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$Label
    )

    Assert-RealDirectory -Path $Root -Label $Label
    $files = New-Object 'System.Collections.Generic.List[object]'
    $directories = New-Object 'System.Collections.Generic.List[string]'
    $queue = New-Object 'System.Collections.Generic.Queue[string]'
    $queue.Enqueue([IO.Path]::GetFullPath($Root))
    while ($queue.Count -gt 0) {
        $directory = $queue.Dequeue()
        Assert-NoReparsePathChain -Path $directory -Label $Label
        foreach ($item in @(Get-ChildItem -LiteralPath $directory -Force -ErrorAction Stop)) {
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "$Label contains a reparse point: $($item.FullName)"
            }
            $relative = $item.FullName.Substring($Root.Length).TrimStart("\", "/").Replace("\", "/")
            if ($item.PSIsContainer) {
                $directories.Add($relative) | Out-Null
                $queue.Enqueue($item.FullName)
            }
            else {
                $files.Add([PSCustomObject]@{ Item = $item; Relative = $relative }) | Out-Null
            }
        }
    }
    return [PSCustomObject]@{
        Files = @($files.ToArray())
        Directories = @($directories.ToArray())
    }
}

function Remove-SafeCacheItem {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [switch]$Recurse
    )

    Assert-WithinCache -Value $Path -Label "removal"
    $attributes = Get-ExistingPathAttributes -Path $Path
    if ($null -eq $attributes) {
        return
    }
    if ($Recurse) {
        if (($attributes -band [IO.FileAttributes]::Directory) -eq 0) {
            throw "Recursive removal target is not a directory: $Path"
        }
        $null = Get-SafeTree -Root $Path -Label "recursive removal"
        Remove-Item -LiteralPath $Path -Recurse -Force
    }
    else {
        if (($attributes -band [IO.FileAttributes]::Directory) -ne 0) {
            throw "Non-recursive removal target is a directory: $Path"
        }
        Remove-Item -LiteralPath $Path -Force
    }
    Assert-NoReparsePathChain -Path (Split-Path -Parent $Path) -Label "post-removal parent"
}

function Move-SafeCacheItem {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Destination
    )

    Assert-WithinCache -Value $Source -Label "move source"
    Assert-WithinCache -Value $Destination -Label "move destination"
    if ($null -ne (Get-ExistingPathAttributes -Path $Destination)) {
        throw "Refusing to overwrite an existing move destination: $Destination"
    }
    Move-Item -LiteralPath $Source -Destination $Destination
    Assert-WithinCache -Value $Destination -Label "moved destination"
    Assert-NoReparsePathChain -Path (Split-Path -Parent $Source) -Label "post-move source parent"
}

function Get-LowerSha256 {
    param([Parameter(Mandatory = $true)][string]$Path)
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Resolve-WindowsSystemToolPath {
    param([Parameter(Mandatory = $true)][ValidateSet("curl.exe", "tar.exe")][string]$Name)

    if ([string]::IsNullOrWhiteSpace($env:SystemRoot)) {
        throw "SystemRoot is required to locate trusted Windows system tools"
    }
    $toolPath = [IO.Path]::GetFullPath((Join-Path $env:SystemRoot "System32\$Name"))
    Assert-RegularFile -Path $toolPath -Label "Windows system $Name"
    return $toolPath
}

function Invoke-SanitizedArchiveCommand {
    param(
        [Parameter(Mandatory = $true)][string]$Executable,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [string]$WorkingDirectory
    )

    $environmentNames = @("TAR_OPTIONS", "BZIP2", "BZIP")
    $savedEnvironment = @{}
    foreach ($name in $environmentNames) {
        $environmentPath = "Env:$name"
        if (Test-Path -LiteralPath $environmentPath) {
            $savedEnvironment[$name] = (Get-Item -LiteralPath $environmentPath).Value
        }
    }

    $locationPushed = $false
    $previousErrorActionPreference = $ErrorActionPreference
    $output = @()
    $exitCode = $null
    try {
        foreach ($name in $environmentNames) {
            Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue
        }
        if (-not [string]::IsNullOrWhiteSpace($WorkingDirectory)) {
            Push-Location -LiteralPath $WorkingDirectory
            $locationPushed = $true
        }
        $ErrorActionPreference = "Continue"
        $output = @(& $Executable @Arguments 2>&1)
        $exitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference
        if ($locationPushed) {
            Pop-Location
        }
        foreach ($name in $environmentNames) {
            if ($savedEnvironment.ContainsKey($name)) {
                Set-Item -LiteralPath "Env:$name" -Value $savedEnvironment[$name]
            }
            else {
                Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue
            }
        }
    }

    return [PSCustomObject]@{
        Output = $output
        ExitCode = $exitCode
    }
}

function Resolve-ArchiveTool {
    param(
        [string]$TarExecutable,
        [string]$Bzip2Executable
    )

    if ([string]::IsNullOrWhiteSpace($TarExecutable) -and
        [string]::IsNullOrWhiteSpace($Bzip2Executable)) {
        return [PSCustomObject]@{
            Kind = "windows-system-tar"
            TarPath = Resolve-WindowsSystemToolPath -Name "tar.exe"
            Bzip2Path = $null
        }
    }
    if ([string]::IsNullOrWhiteSpace($TarExecutable) -or
        [string]::IsNullOrWhiteSpace($Bzip2Executable)) {
        throw "ArchiveTarPath and ArchiveBzip2Path must be supplied together"
    }

    $tarPath = [IO.Path]::GetFullPath($TarExecutable)
    $bzip2Path = [IO.Path]::GetFullPath($Bzip2Executable)
    Assert-RegularFile -Path $tarPath -Label "explicit archive tar"
    Assert-RegularFile -Path $bzip2Path -Label "explicit archive bzip2"
    $expectedBzip2Path = [IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $tarPath) "bzip2.exe"))
    if (-not $bzip2Path.Equals($expectedBzip2Path, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Explicit GNU tar and bzip2 must be sibling Git-for-Windows tools"
    }
    $versionResult = Invoke-SanitizedArchiveCommand -Executable $tarPath -Arguments @("--version")
    $version = @($versionResult.Output)
    if ($versionResult.ExitCode -ne 0 -or $version.Count -eq 0 -or
        -not ([string]$version[0]).StartsWith("tar (GNU tar) ", [StringComparison]::Ordinal)) {
        throw "Explicit archive tar must identify as GNU tar"
    }
    $bzip2Result = Invoke-SanitizedArchiveCommand -Executable $bzip2Path -Arguments @("-h")
    $bzip2Identity = @($bzip2Result.Output)
    if ($bzip2Result.ExitCode -ne 0 -or $bzip2Identity.Count -eq 0 -or
        -not ([string]$bzip2Identity[0]).StartsWith(
            "bzip2, a block-sorting file compressor.  Version ",
            [StringComparison]::Ordinal
        )) {
        throw "Explicit archive bzip2 must identify as bzip2"
    }
    return [PSCustomObject]@{
        Kind = "git-for-windows-gnu-tar"
        TarPath = $tarPath
        Bzip2Path = $bzip2Path
    }
}

function Invoke-LockedHttpsDownload {
    param(
        [Parameter(Mandatory = $true)][string]$Url,
        [Parameter(Mandatory = $true)][string]$Destination,
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][Int64]$ExpectedSizeBytes
    )

    if (-not $Url.StartsWith("https://github.com/", [StringComparison]::Ordinal)) {
        throw "Locked download URL is not an allowed GitHub HTTPS URL: $Url"
    }
    $curlPath = Resolve-WindowsSystemToolPath -Name "curl.exe"
    Write-Host "SHERPA_ARCHIVE_DOWNLOAD_START name=$Name expected_bytes=$ExpectedSizeBytes"
    & $curlPath `
        --disable `
        --proto '=https' `
        --proto-redir '=https' `
        --tlsv1.2 `
        --retry 10 `
        --retry-connrefused `
        --location `
        --silent `
        --show-error `
        --fail `
        --output $Destination `
        $Url
    if ($LASTEXITCODE -ne 0) {
        throw "curl.exe failed to acquire locked archive $Name (exit $LASTEXITCODE)"
    }
    Write-Host "SHERPA_ARCHIVE_DOWNLOAD_COMPLETE name=$Name"
}

function Assert-FileIdentity {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][Int64]$SizeBytes,
        [Parameter(Mandatory = $true)][string]$Sha256,
        [Parameter(Mandatory = $true)][string]$Label
    )

    Assert-RegularFile -Path $Path -Label $Label
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if ($item.Length -ne $SizeBytes) {
        throw "$Label size mismatch: expected $SizeBytes, got $($item.Length)"
    }
    $actualSha256 = Get-LowerSha256 -Path $Path
    if ($actualSha256 -ne $Sha256) {
        throw "$Label SHA-256 mismatch: expected $Sha256, got $actualSha256"
    }
}

function Assert-SafeArchiveListing {
    param(
        [Parameter(Mandatory = $true)][string]$ArchivePath,
        [Parameter(Mandatory = $true)][string]$ExpectedRoot,
        [Parameter(Mandatory = $true)]$Inventory,
        [string]$TarExecutable,
        [string]$Bzip2Executable
    )

    Assert-RegularFile -Path $ArchivePath -Label "archive"
    $archiveTool = Resolve-ArchiveTool -TarExecutable $TarExecutable -Bzip2Executable $Bzip2Executable
    Write-Host "SHERPA_ARCHIVE_LISTING_START path=$ArchivePath tool=$($archiveTool.Kind)"
    if ($archiveTool.Kind -eq "git-for-windows-gnu-tar") {
        $listingResult = Invoke-SanitizedArchiveCommand `
            -Executable $archiveTool.TarPath `
            -Arguments @("--force-local", "--use-compress-program=/usr/bin/bzip2", "-tf", $ArchivePath)
    }
    else {
        $listingResult = Invoke-SanitizedArchiveCommand `
            -Executable $archiveTool.TarPath `
            -Arguments @("-tjf", $ArchivePath)
    }
    $entries = @($listingResult.Output)
    if ($listingResult.ExitCode -ne 0 -or $entries.Count -eq 0) {
        throw "Unable to inspect archive path listing: $ArchivePath"
    }
    Write-Host "SHERPA_ARCHIVE_PATH_LISTING_COMPLETE path=$ArchivePath entries=$($entries.Count)"
    if ($archiveTool.Kind -eq "git-for-windows-gnu-tar") {
        $verboseResult = Invoke-SanitizedArchiveCommand `
            -Executable $archiveTool.TarPath `
            -Arguments @("--force-local", "--use-compress-program=/usr/bin/bzip2", "-tvf", $ArchivePath)
    }
    else {
        $verboseResult = Invoke-SanitizedArchiveCommand `
            -Executable $archiveTool.TarPath `
            -Arguments @("-tvjf", $ArchivePath)
    }
    $verboseEntries = @($verboseResult.Output)
    if ($verboseResult.ExitCode -ne 0 -or $verboseEntries.Count -ne $entries.Count) {
        throw "Unable to inspect archive entry types: $ArchivePath"
    }

    $allowed = @{}
    $allowed[$ExpectedRoot] = "d"
    foreach ($record in $Inventory) {
        $parts = @($record.path.Split("/"))
        for ($index = 1; $index -lt $parts.Count; $index++) {
            $relativeDirectory = [string]::Join("/", $parts[0..($index - 1)])
            $allowed["$ExpectedRoot/$relativeDirectory"] = "d"
        }
        $allowed["$ExpectedRoot/$($record.path)"] = "-"
    }

    $seen = @{}
    for ($index = 0; $index -lt $entries.Count; $index++) {
        $entry = [string]$entries[$index]
        $verbose = ([string]$verboseEntries[$index]).TrimStart()
        if ([string]::IsNullOrWhiteSpace($verbose)) {
            throw "Archive has an empty verbose listing entry"
        }
        $entryType = $verbose.Substring(0, 1)
        if ($entryType -notin @("-", "d") -or $verbose.Contains(" link to ") -or $verbose.Contains(" -> ")) {
            throw "Archive links and special entries are forbidden: $verbose"
        }
        if ([string]::IsNullOrWhiteSpace($entry) -or
            $entry.Contains("\") -or
            $entry.StartsWith("/") -or
            $entry.Split("/").Contains("..")) {
            throw "Archive contains an unsafe path: $entry"
        }
        $normalized = $entry.TrimEnd("/")
        if (-not $allowed.ContainsKey($normalized) -or $allowed[$normalized] -ne $entryType) {
            throw "Archive contains an unsealed or incorrectly typed entry: $entry"
        }
        if ($seen.ContainsKey($normalized)) {
            throw "Archive contains a duplicate entry: $entry"
        }
        $seen[$normalized] = $true
    }
    foreach ($record in $Inventory) {
        $expectedFile = "$ExpectedRoot/$($record.path)"
        if (-not $seen.ContainsKey($expectedFile)) {
            throw "Archive omits a sealed inventory file: $expectedFile"
        }
    }
    Write-Host "SHERPA_ARCHIVE_LISTING_COMPLETE path=$ArchivePath"
}

function Assert-ExtractedInventory {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)]$Inventory,
        [Parameter(Mandatory = $true)][string]$Label
    )

    $tree = Get-SafeTree -Root $Root -Label "$Label extraction"
    $expectedFiles = @{}
    $expectedDirectories = @{}
    foreach ($record in $Inventory) {
        $expectedFiles[$record.path] = $record
        $parts = @($record.path.Split("/"))
        for ($index = 1; $index -lt $parts.Count; $index++) {
            $expectedDirectories[[string]::Join("/", $parts[0..($index - 1)])] = $true
        }
    }
    if (@($tree.Files).Count -ne $expectedFiles.Count -or
        @($tree.Directories).Count -ne $expectedDirectories.Count) {
        throw "$Label inventory shape differs from the sealed file/directory set"
    }
    foreach ($directory in @($tree.Directories)) {
        if (-not $expectedDirectories.ContainsKey($directory)) {
            throw "$Label contains an unsealed directory: $directory"
        }
    }
    foreach ($entry in @($tree.Files)) {
        if (-not $expectedFiles.ContainsKey($entry.Relative)) {
            throw "$Label contains an unsealed file: $($entry.Relative)"
        }
        $record = $expectedFiles[$entry.Relative]
        Assert-FileIdentity -Path $entry.Item.FullName -SizeBytes ([Int64]$record.size_bytes) -Sha256 $record.sha256 -Label "$Label/$($entry.Relative)"
    }
}

function Get-VerifiedArchive {
    param([Parameter(Mandatory = $true)]$Archive)

    $archiveDirectory = Join-Path $resolvedCacheRoot "archives"
    New-SafeCacheDirectory -Path $archiveDirectory
    $destination = Join-Path $archiveDirectory $Archive.name
    $destinationAttributes = Get-ExistingPathAttributes -Path $destination
    if ($null -ne $destinationAttributes) {
        Assert-FileIdentity -Path $destination -SizeBytes ([Int64]$Archive.size_bytes) -Sha256 $Archive.sha256 -Label $Archive.name
        return $destination
    }

    $source = $null
    if ($resolvedArchiveSourceRoot) {
        $candidate = Join-Path $resolvedArchiveSourceRoot $Archive.name
        if ($null -ne (Get-ExistingPathAttributes -Path $candidate)) {
            Assert-FileIdentity -Path $candidate -SizeBytes ([Int64]$Archive.size_bytes) -Sha256 $Archive.sha256 -Label "source/$($Archive.name)"
            $source = $candidate
        }
    }
    if (-not $source -and -not $AllowDownload) {
        throw "Offline asset is unavailable: $($Archive.name). Provide -ArchiveSourceRoot or rerun explicitly with -AllowDownload."
    }

    $partial = "$destination.part"
    Remove-SafeCacheItem -Path $partial
    Assert-WithinCache -Value $partial -Label "archive partial"
    if ($source) {
        Assert-NoReparsePathChain -Path $source -Label "archive source"
        Copy-Item -LiteralPath $source -Destination $partial
    }
    else {
        Invoke-LockedHttpsDownload `
            -Url $Archive.url `
            -Destination $partial `
            -Name $Archive.name `
            -ExpectedSizeBytes ([Int64]$Archive.size_bytes)
    }
    Assert-WithinCache -Value $partial -Label "written archive partial"
    Assert-FileIdentity -Path $partial -SizeBytes ([Int64]$Archive.size_bytes) -Sha256 $Archive.sha256 -Label "partial/$($Archive.name)"
    Move-SafeCacheItem -Source $partial -Destination $destination
    Assert-FileIdentity -Path $destination -SizeBytes ([Int64]$Archive.size_bytes) -Sha256 $Archive.sha256 -Label $Archive.name
    return $destination
}

function Get-VerifiedExtraction {
    param(
        [Parameter(Mandatory = $true)][string]$ArchivePath,
        [Parameter(Mandatory = $true)]$Archive,
        [Parameter(Mandatory = $true)][string]$Label
    )

    $extractedBase = Join-Path $resolvedCacheRoot "extracted"
    New-SafeCacheDirectory -Path $extractedBase
    $destination = Join-Path $extractedBase $Archive.extracted_directory
    $destinationAttributes = Get-ExistingPathAttributes -Path $destination
    if ($null -ne $destinationAttributes) {
        Assert-ExtractedInventory -Root $destination -Inventory $Archive.inventory -Label $Label
        return $destination
    }

    Assert-FileIdentity `
        -Path $ArchivePath `
        -SizeBytes ([Int64]$Archive.size_bytes) `
        -Sha256 $Archive.sha256 `
        -Label "$Label archive before listing"
    Assert-SafeArchiveListing `
        -ArchivePath $ArchivePath `
        -ExpectedRoot $Archive.extracted_directory `
        -Inventory $Archive.inventory `
        -TarExecutable $ArchiveTarPath `
        -Bzip2Executable $ArchiveBzip2Path
    $temporary = Join-Path $resolvedCacheRoot ("extracting-" + [Guid]::NewGuid().ToString("N"))
    New-SafeCacheDirectory -Path $temporary
    try {
        Assert-WithinCache -Value $temporary -Label "pre-extraction directory"
        Assert-FileIdentity `
            -Path $ArchivePath `
            -SizeBytes ([Int64]$Archive.size_bytes) `
            -Sha256 $Archive.sha256 `
            -Label "$Label archive before extraction"
        $archiveTool = Resolve-ArchiveTool -TarExecutable $ArchiveTarPath -Bzip2Executable $ArchiveBzip2Path
        Write-Host "SHERPA_ARCHIVE_EXTRACTION_START name=$($Archive.name) tool=$($archiveTool.Kind)"
        if ($archiveTool.Kind -eq "git-for-windows-gnu-tar") {
            $extractionResult = Invoke-SanitizedArchiveCommand `
                -Executable $archiveTool.TarPath `
                -Arguments @("--force-local", "--use-compress-program=/usr/bin/bzip2", "-xf", $ArchivePath) `
                -WorkingDirectory $temporary
        }
        else {
            $extractionResult = Invoke-SanitizedArchiveCommand `
                -Executable $archiveTool.TarPath `
                -Arguments @("-xjf", $ArchivePath, "-C", $temporary)
        }
        if ($extractionResult.ExitCode -ne 0) {
            throw "Failed to extract locked archive: $ArchivePath"
        }
        Write-Host "SHERPA_ARCHIVE_EXTRACTION_COMPLETE name=$($Archive.name)"
        Assert-WithinCache -Value $temporary -Label "post-extraction directory"
        $candidate = Join-Path $temporary $Archive.extracted_directory
        Assert-ExtractedInventory -Root $candidate -Inventory $Archive.inventory -Label $Label
        Move-SafeCacheItem -Source $candidate -Destination $destination
        Assert-ExtractedInventory -Root $destination -Inventory $Archive.inventory -Label $Label
    }
    finally {
        Remove-SafeCacheItem -Path $temporary -Recurse
    }
    return $destination
}

if ($MyInvocation.InvocationName -eq ".") {
    return
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "Node.js is required to validate the committed asset lock"
}
$null = Resolve-ArchiveTool -TarExecutable $ArchiveTarPath -Bzip2Executable $ArchiveBzip2Path

& node (Join-Path $scriptRoot "validate-lock.mjs") $lockPath
if ($LASTEXITCODE -ne 0) {
    throw "Committed sherpa native asset lock validation failed"
}
$lock = Get-Content -LiteralPath $lockPath -Raw -Encoding UTF8 | ConvertFrom-Json
$lockSha256 = Get-LowerSha256 -Path $lockPath

$resolvedCacheRoot = Resolve-UnderTarget -Value $CacheRoot -Label "CacheRoot"
$cacheAttributes = Get-ExistingPathAttributes -Path $resolvedCacheRoot
if ($null -eq $cacheAttributes) {
    New-Item -ItemType Directory -Path $resolvedCacheRoot | Out-Null
}
elseif (($cacheAttributes -band [IO.FileAttributes]::Directory) -eq 0) {
    throw "CacheRoot is not a directory: $resolvedCacheRoot"
}
$resolvedCacheRoot = Resolve-UnderTarget -Value $resolvedCacheRoot -Label "created CacheRoot"
Assert-RealDirectory -Path $resolvedCacheRoot -Label "CacheRoot"

$resolvedArchiveSourceRoot = $null
if ($ArchiveSourceRoot) {
    $resolvedArchiveSourceRoot = Resolve-UnderTarget -Value $ArchiveSourceRoot -Label "ArchiveSourceRoot"
    Assert-RealDirectory -Path $resolvedArchiveSourceRoot -Label "ArchiveSourceRoot"
}

$runtimeRoot = $null
$modelRoot = $null
if ($AssetSet -in @("All", "Runtime")) {
    $runtimeArchive = Get-VerifiedArchive -Archive $lock.runtime.archive
    $runtimeRoot = Get-VerifiedExtraction -ArchivePath $runtimeArchive -Archive $lock.runtime.archive -Label "runtime"
}
if ($AssetSet -in @("All", "Model")) {
    $modelArchive = Get-VerifiedArchive -Archive $lock.model.archive
    $modelRoot = Get-VerifiedExtraction -ArchivePath $modelArchive -Archive $lock.model.archive -Label "model"
}

Write-Output "MEETINGRELAY_SHERPA_LOCK=$([IO.Path]::GetFullPath($lockPath))"
Write-Output "MEETINGRELAY_SHERPA_LOCK_SHA256=$lockSha256"
Write-Output "MEETINGRELAY_SHERPA_PARAMETER_SHA256=$($lock.parameters.canonical_json_sha256)"
if ($runtimeRoot) {
    Write-Output "SHERPA_ONNX_LIB_DIR=$([IO.Path]::GetFullPath((Join-Path $runtimeRoot $lock.entrypoints.runtime_lib_relative_path)))"
}
if ($modelRoot) {
    Write-Output "MEETINGRELAY_SHERPA_MODEL=$([IO.Path]::GetFullPath((Join-Path $modelRoot $lock.entrypoints.model_relative_path)))"
    Write-Output "MEETINGRELAY_SHERPA_MODEL_SHA256=$((($lock.model.archive.inventory | Where-Object path -eq $lock.entrypoints.model_relative_path).sha256))"
    Write-Output "MEETINGRELAY_SHERPA_TOKENS=$([IO.Path]::GetFullPath((Join-Path $modelRoot $lock.entrypoints.tokens_relative_path)))"
    Write-Output "MEETINGRELAY_SHERPA_TOKENS_SHA256=$((($lock.model.archive.inventory | Where-Object path -eq $lock.entrypoints.tokens_relative_path).sha256))"
    Write-Output "MEETINGRELAY_SHERPA_WAV=$([IO.Path]::GetFullPath((Join-Path $modelRoot $lock.entrypoints.smoke_wav_relative_path)))"
}
