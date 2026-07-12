[CmdletBinding()]
param(
    [string]$ArchiveTarPath,
    [string]$ArchiveBzip2Path
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = [IO.Path]::GetFullPath((Join-Path $scriptRoot "../.."))
$targetRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot "target"))
$testRoot = Join-Path $targetRoot ("wp-0.4.3b/path-hardening-" + [Guid]::NewGuid().ToString("N"))
$realRoot = Join-Path $testRoot "real"
$junction = Join-Path $testRoot "junction"
$archiveInput = Join-Path $testRoot "archive-input"
$archiveRoot = Join-Path $archiveInput "locked-root"
$archivePath = Join-Path $testRoot "hardlink.tar.bz2"
$overlapRoot = Join-Path $testRoot "overlap-source"
$overlapLibDir = Join-Path $overlapRoot "lib"
$testArchiveTarPath = $ArchiveTarPath
$testArchiveBzip2Path = $ArchiveBzip2Path
. (Join-Path $scriptRoot "materialize.ps1")
$systemTarPath = Resolve-WindowsSystemToolPath -Name "tar.exe"

function Assert-TestRootBoundary {
    $resolved = [IO.Path]::GetFullPath($testRoot)
    $prefix = $targetRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    if (-not $resolved.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Test root escaped target: $resolved"
    }
}

function Assert-ReparseRejection {
    param(
        [Parameter(Mandatory = $true)][ScriptBlock]$Operation,
        [Parameter(Mandatory = $true)][string]$Label
    )
    try {
        & $Operation
    }
    catch {
        if ($_.Exception.Message -notmatch "reparse point") {
            throw "$Label failed for the wrong reason: $($_.Exception.Message)"
        }
        Write-Output "$Label=PASS"
        return
    }
    throw "$Label did not reject a junction"
}

function Assert-OverlapRejection {
    param(
        [Parameter(Mandatory = $true)][string]$Destination,
        [Parameter(Mandatory = $true)][string]$Label
    )
    try {
        & (Join-Path $scriptRoot "stage-runtime.ps1") -LibDir $overlapLibDir -DestinationRoot $Destination
    }
    catch {
        if ($_.Exception.Message -notmatch "must not equal, contain, or be contained") {
            throw "$Label failed for the wrong reason: $($_.Exception.Message)"
        }
        Write-Output "$Label=PASS"
        return
    }
    throw "$Label did not reject a source/destination overlap"
}

Assert-TestRootBoundary
New-Item -ItemType Directory -Path $realRoot -Force | Out-Null
try {
    & cmd.exe /d /c "mklink /J `"$junction`" `"$realRoot`"" | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Output "JUNCTION_REGRESSION=SKIP (mklink /J unavailable)"
    }
    else {
        Assert-ReparseRejection -Label "MATERIALIZE_JUNCTION_REGRESSION" -Operation {
            & (Join-Path $scriptRoot "materialize.ps1") -CacheRoot (Join-Path $junction "cache") -AssetSet Runtime
        }
        Assert-ReparseRejection -Label "STAGE_JUNCTION_REGRESSION" -Operation {
            & (Join-Path $scriptRoot "stage-runtime.ps1") -LibDir (Join-Path $junction "lib") -DestinationRoot (Join-Path $testRoot "stage")
        }
        $lockedLibDir = Join-Path $targetRoot "sherpa-native/extracted/sherpa-onnx-v1.13.4-win-x64-shared-MT-Release-lib/lib"
        if (Test-Path -LiteralPath $lockedLibDir -PathType Container) {
            Assert-ReparseRejection -Label "STAGE_DESTINATION_JUNCTION_REGRESSION" -Operation {
                & (Join-Path $scriptRoot "stage-runtime.ps1") -LibDir $lockedLibDir -DestinationRoot (Join-Path $junction "stage")
            }
        }
        else {
            Write-Output "STAGE_DESTINATION_JUNCTION_REGRESSION=SKIP (locked runtime is not materialized)"
        }
    }

    $lockedLibDir = Join-Path $targetRoot "sherpa-native/extracted/sherpa-onnx-v1.13.4-win-x64-shared-MT-Release-lib/lib"
    if (-not (Test-Path -LiteralPath $lockedLibDir -PathType Container)) {
        throw "Locked runtime must be materialized before path-hardening overlap tests"
    }
    New-Item -ItemType Directory -Path $overlapLibDir -Force | Out-Null
    $lockedEntries = @(Get-ChildItem -LiteralPath $lockedLibDir -Force)
    if ($lockedEntries.Count -ne 7 -or @($lockedEntries | Where-Object { $_.PSIsContainer }).Count -ne 0) {
        throw "Locked runtime source is not the exact seven-file inventory"
    }
    foreach ($entry in $lockedEntries) {
        Copy-Item -LiteralPath $entry.FullName -Destination (Join-Path $overlapLibDir $entry.Name)
    }
    $sourceIdentity = @(
        Get-ChildItem -LiteralPath $overlapLibDir -File -Force |
            Sort-Object Name |
            ForEach-Object { "$($_.Name):$($_.Length):$((Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash)" }
    )
    Assert-OverlapRejection -Destination $overlapLibDir -Label "STAGE_EQUAL_OVERLAP_REGRESSION"
    Assert-OverlapRejection -Destination (Join-Path $overlapLibDir "nested") -Label "STAGE_DESCENDANT_OVERLAP_REGRESSION"
    Assert-OverlapRejection -Destination $overlapRoot -Label "STAGE_ANCESTOR_OVERLAP_REGRESSION"
    $sourceIdentityAfter = @(
        Get-ChildItem -LiteralPath $overlapLibDir -File -Force |
            Sort-Object Name |
            ForEach-Object { "$($_.Name):$($_.Length):$((Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash)" }
    )
    if (($sourceIdentity -join "`n") -ne ($sourceIdentityAfter -join "`n") -or
        @(Get-ChildItem -LiteralPath $overlapLibDir -Force).Count -ne 7) {
        throw "Overlap rejection mutated the exact seven-file source inventory"
    }

    New-Item -ItemType Directory -Path $archiveRoot -Force | Out-Null
    $first = Join-Path $archiveRoot "first.bin"
    $second = Join-Path $archiveRoot "second.bin"
    [IO.File]::WriteAllBytes($first, [byte[]](1, 2, 3, 4))
    try {
        New-Item -ItemType HardLink -Path $second -Target $first -ErrorAction Stop | Out-Null
    }
    catch {
        Write-Output "ARCHIVE_HARDLINK_REGRESSION=SKIP (hard-link creation unavailable)"
        return
    }
    & $systemTarPath -cjf $archivePath -C $archiveInput "locked-root"
    if ($LASTEXITCODE -ne 0) {
        throw "Could not create the hard-link regression archive"
    }
    $inventory = @(
        [PSCustomObject]@{ path = "first.bin" },
        [PSCustomObject]@{ path = "second.bin" }
    )
    $archiveEnvironmentNames = @("TAR_OPTIONS", "BZIP2", "BZIP")
    $savedArchiveEnvironment = @{}
    foreach ($name in $archiveEnvironmentNames) {
        if (Test-Path -LiteralPath "Env:$name") {
            $savedArchiveEnvironment[$name] = (Get-Item -LiteralPath "Env:$name").Value
        }
    }
    $injectedTarOptions = "--checkpoint=1 --checkpoint-action=echo=MEETINGRELAY_TAR_OPTIONS_INJECTED"
    $hardlinkRejected = $false
    try {
        $env:TAR_OPTIONS = $injectedTarOptions
        $env:BZIP2 = "-v"
        $env:BZIP = "-v"
        try {
            Assert-SafeArchiveListing `
                -ArchivePath $archivePath `
                -ExpectedRoot "locked-root" `
                -Inventory $inventory `
                -TarExecutable $testArchiveTarPath `
                -Bzip2Executable $testArchiveBzip2Path
        }
        catch {
            if ($_.Exception.Message -notmatch "links and special entries are forbidden") {
                throw "Archive hard-link regression failed for the wrong reason: $($_.Exception.Message)"
            }
            $hardlinkRejected = $true
        }
        if ($env:TAR_OPTIONS -ne $injectedTarOptions -or $env:BZIP2 -ne "-v" -or $env:BZIP -ne "-v") {
            throw "Archive command did not restore ambient archive environment variables"
        }
    }
    finally {
        foreach ($name in $archiveEnvironmentNames) {
            if ($savedArchiveEnvironment.ContainsKey($name)) {
                Set-Item -LiteralPath "Env:$name" -Value $savedArchiveEnvironment[$name]
            }
            else {
                Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue
            }
        }
    }
    if (-not $hardlinkRejected) {
        throw "Archive hard-link regression did not reject a hard-link entry"
    }
    Write-Output "ARCHIVE_HARDLINK_REGRESSION=PASS"
}
finally {
    $junctionAttributes = try { [IO.File]::GetAttributes($junction) } catch { $null }
    if ($null -ne $junctionAttributes -and ($junctionAttributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        Remove-Item -LiteralPath $junction -Force
    }
    Assert-TestRootBoundary
    $rootAttributes = try { [IO.File]::GetAttributes($testRoot) } catch { $null }
    if ($null -ne $rootAttributes -and ($rootAttributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) {
        Remove-Item -LiteralPath $testRoot -Recurse -Force
    }
}
