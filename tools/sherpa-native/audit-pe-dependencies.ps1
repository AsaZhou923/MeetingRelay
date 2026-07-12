[CmdletBinding()]
param(
    [string]$RuntimeDir,
    [string[]]$BinaryPath,
    [switch]$ParserSelfTest
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
    Assert-NoReparsePathChain -Path $Path -Label $Label
    $attributes = Get-ExistingPathAttributes -Path $Path
    if ($null -eq $attributes -or
        ($attributes -band [IO.FileAttributes]::Directory) -ne 0 -or
        ($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "$Label is not a regular non-reparse file: $Path"
    }
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if ($item.Length -ne [Int64]$Record.size_bytes -or (Get-LowerSha256 -Path $Path) -ne $Record.sha256) {
        throw "$Label differs from the sealed lock identity: $Path"
    }
}

function Find-Dumpbin {
    $command = Get-Command dumpbin.exe -ErrorAction SilentlyContinue
    if ($command) {
        return $command.Source
    }

    $installations = @()
    $vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio/Installer/vswhere.exe"
    if (Test-Path -LiteralPath $vswhere -PathType Leaf) {
        $installations = @(& $vswhere -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath)
    }
    $installations += @(
        "${env:ProgramFiles(x86)}\Microsoft Visual Studio\2022\BuildTools",
        "${env:ProgramFiles(x86)}\Microsoft Visual Studio\2022\Enterprise",
        "${env:ProgramFiles(x86)}\Microsoft Visual Studio\2022\Professional",
        "${env:ProgramFiles(x86)}\Microsoft Visual Studio\2022\Community"
    )
    foreach ($installation in @($installations | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique)) {
        $matches = @(Get-ChildItem -Path (Join-Path $installation "VC/Tools/MSVC/*/bin/Hostx64/x64/dumpbin.exe") -File -ErrorAction SilentlyContinue | Sort-Object FullName -Descending)
        if ($matches.Count -gt 0) {
            return $matches[0].FullName
        }
    }
    throw "dumpbin.exe from the Visual C++ x64 tools is required for PE dependency auditing"
}

function Get-PeDependencies {
    param([Parameter(Mandatory = $true)][string]$Path)
    $output = @(& $dumpbin /DEPENDENTS /NOLOGO $Path 2>&1)
    if ($LASTEXITCODE -ne 0) {
        throw "dumpbin failed for $Path`n$($output -join [Environment]::NewLine)"
    }
    return @(ConvertFrom-DumpbinDependentsOutput -Output $output -Label $Path)
}

function ConvertFrom-DumpbinDependentsOutput {
    param(
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][AllowEmptyString()][string[]]$Output,
        [string]$Label = "dumpbin output"
    )
    $header = "Image has the following dependencies:"
    $inDependencies = $false
    $headerCount = 0
    $summaryFound = $false
    $dependencies = [Collections.Generic.List[string]]::new()
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($rawLine in $Output) {
        $line = ([string]$rawLine).Trim()
        if (-not $inDependencies) {
            if ($line -eq $header) {
                $headerCount++
                if ($headerCount -ne 1) {
                    throw "$Label contains multiple dependency headers"
                }
                $inDependencies = $true
            }
            continue
        }
        if ($line -eq "Summary") {
            $summaryFound = $true
            break
        }
        if ([string]::IsNullOrWhiteSpace($line)) {
            continue
        }
        if ($line -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*\.dll$') {
            throw "$Label contains an unrecognized dependency entry: $line"
        }
        $normalized = $line.ToLowerInvariant()
        if (-not $seen.Add($normalized)) {
            throw "$Label contains a duplicate dependency entry: $line"
        }
        $dependencies.Add($normalized)
    }
    if ($headerCount -ne 1 -or -not $inDependencies) {
        throw "$Label does not contain exactly one dependency header"
    }
    if (-not $summaryFound) {
        throw "$Label dependency section has no Summary terminator"
    }
    if ($dependencies.Count -eq 0) {
        throw "$Label dependency section is empty"
    }
    return @($dependencies | Sort-Object)
}

function Assert-ExactDependencies {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string[]]$Expected
    )
    $actual = @(Get-PeDependencies -Path $Path)
    $wanted = @($Expected | ForEach-Object { $_.ToLowerInvariant() } | Sort-Object -Unique)
    if (($actual -join "`n") -ne ($wanted -join "`n")) {
        throw "PE dependency set mismatch for $Path; expected [$($wanted -join ', ')], got [$($actual -join ', ')]"
    }
}

if ($ParserSelfTest) {
    $valid = @(
        "Dump of file fixture.dll",
        "",
        "  Image has the following dependencies:",
        "",
        "    KERNEL32.dll",
        "    api-ms-win-core-path-l1-1-0.dll",
        "",
        "  Summary",
        "       1000 .text"
    )
    $parsed = @(ConvertFrom-DumpbinDependentsOutput -Output $valid -Label "valid fixture")
    if (($parsed -join "`n") -ne (@("api-ms-win-core-path-l1-1-0.dll", "kernel32.dll") -join "`n")) {
        throw "Strict dumpbin parser did not preserve the exact valid dependency set"
    }
    $invalidFixtures = @(
        [PSCustomObject]@{ Lines = @(
                "Image has the following dependencies:",
                "KERNEL32.dll extra text",
                "Summary"
            ) },
        [PSCustomObject]@{ Lines = @(
                "Image has the following dependencies:",
                "api-ms-win-*.dll",
                "Summary"
            ) },
        [PSCustomObject]@{ Lines = @(
                "Image has the following dependencies:",
                "KERNEL32.dll"
            ) },
        [PSCustomObject]@{ Lines = @(
                "Image has the following dependencies:",
                "KERNEL32.dll",
                "kernel32.dll",
                "Summary"
            ) }
    )
    foreach ($fixture in $invalidFixtures) {
        try {
            $null = ConvertFrom-DumpbinDependentsOutput -Output $fixture.Lines -Label "invalid fixture"
        }
        catch {
            continue
        }
        throw "Strict dumpbin parser accepted an invalid dependency fixture"
    }
    Write-Output "PE_DEPENDENCY_PARSER_SELF_TEST=PASS"
}
else {
    if ([string]::IsNullOrWhiteSpace($RuntimeDir) -or $null -eq $BinaryPath -or $BinaryPath.Count -eq 0) {
        throw "RuntimeDir and at least one BinaryPath are required outside ParserSelfTest mode"
    }

    & node (Join-Path $scriptRoot "validate-lock.mjs") $lockPath
    if ($LASTEXITCODE -ne 0) {
        throw "Committed sherpa native asset lock validation failed"
    }
    $lock = Get-Content -LiteralPath $lockPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $resolvedRuntimeDir = Resolve-UnderTarget -Value $RuntimeDir -Label "RuntimeDir"
    $runtimeAttributes = Get-ExistingPathAttributes -Path $resolvedRuntimeDir
    if ($null -eq $runtimeAttributes -or ($runtimeAttributes -band [IO.FileAttributes]::Directory) -eq 0) {
        throw "RuntimeDir is not an existing directory: $resolvedRuntimeDir"
    }

$runtimeRecords = @($lock.runtime.archive.inventory | Where-Object { $_.path.StartsWith("lib/", [StringComparison]::Ordinal) })
if ($runtimeRecords.Count -ne 7) {
    throw "Expected exactly seven locked runtime library files"
}
$runtimeRecordsByName = @{}
foreach ($record in $runtimeRecords) {
    $name = (Split-Path -Leaf $record.path).ToLowerInvariant()
    if ($runtimeRecordsByName.ContainsKey($name)) {
        throw "Duplicate runtime inventory basename: $name"
    }
    $runtimeRecordsByName[$name] = $record
}
$actualRuntimeEntries = @(Get-ChildItem -LiteralPath $resolvedRuntimeDir -Force -ErrorAction Stop)
if ($actualRuntimeEntries.Count -ne $runtimeRecords.Count) {
    throw "RuntimeDir differs from the exact locked seven-file inventory"
}
foreach ($entry in $actualRuntimeEntries) {
    $name = $entry.Name.ToLowerInvariant()
    if (-not $runtimeRecordsByName.ContainsKey($name)) {
        throw "RuntimeDir contains an unsealed entry: $($entry.FullName)"
    }
    Assert-FileIdentity -Path $entry.FullName -Record $runtimeRecordsByName[$name] -Label "locked runtime library"
}

$lockedDllRecords = @($runtimeRecords | Where-Object { $_.path.EndsWith(".dll", [StringComparison]::OrdinalIgnoreCase) })
if ($lockedDllRecords.Count -ne 4) {
    throw "Expected exactly four locked runtime DLLs"
}
$lockedDllNames = @{}
foreach ($record in $lockedDllRecords) {
    $name = (Split-Path -Leaf $record.path).ToLowerInvariant()
    $lockedDllNames[$name] = $record
}

$dumpbin = Find-Dumpbin
$exactRuntimeImports = @{
    "sherpa-onnx-c-api.dll" = @("onnxruntime.dll", "kernel32.dll", "advapi32.dll")
    "onnxruntime.dll" = @("kernel32.dll", "advapi32.dll", "api-ms-win-core-path-l1-1-0.dll", "dbghelp.dll", "setupapi.dll", "dxgi.dll")
    "onnxruntime_providers_shared.dll" = @("kernel32.dll")
    "sherpa-onnx-cxx-api.dll" = @("sherpa-onnx-c-api.dll", "kernel32.dll")
}
foreach ($name in @($exactRuntimeImports.Keys | Sort-Object)) {
    Assert-ExactDependencies -Path (Join-Path $resolvedRuntimeDir $name) -Expected $exactRuntimeImports[$name]
}

$systemAllowlist = @(
    "api-ms-win-core-synch-l1-2-0.dll", "api-ms-win-crt-heap-l1-1-0.dll",
    "api-ms-win-crt-locale-l1-1-0.dll", "api-ms-win-crt-math-l1-1-0.dll",
    "api-ms-win-crt-runtime-l1-1-0.dll", "api-ms-win-crt-stdio-l1-1-0.dll",
    "api-ms-win-crt-string-l1-1-0.dll",
    "advapi32.dll", "bcrypt.dll", "bcryptprimitives.dll", "cfgmgr32.dll", "combase.dll",
    "crypt32.dll", "dbghelp.dll", "dxgi.dll", "gdi32.dll", "kernel32.dll", "msvcp140.dll",
    "ntdll.dll", "ole32.dll", "oleaut32.dll", "rpcrt4.dll", "secur32.dll", "setupapi.dll",
    "shell32.dll", "user32.dll", "userenv.dll", "ucrtbase.dll", "vcruntime140.dll",
    "vcruntime140_1.dll", "version.dll", "winmm.dll", "ws2_32.dll"
)
$systemAllowed = @{}
foreach ($name in $systemAllowlist) { $systemAllowed[$name] = $true }

foreach ($requestedBinary in $BinaryPath) {
    $binary = Resolve-UnderTarget -Value $requestedBinary -Label "BinaryPath"
    $attributes = Get-ExistingPathAttributes -Path $binary
    if ($null -eq $attributes -or ($attributes -band [IO.FileAttributes]::Directory) -ne 0) {
        throw "BinaryPath is not an existing regular file: $binary"
    }
    $dependencies = @(Get-PeDependencies -Path $binary)
    if ($dependencies -notcontains "sherpa-onnx-c-api.dll") {
        throw "Native smoke binary does not directly import sherpa-onnx-c-api.dll: $binary"
    }
    foreach ($dependency in $dependencies) {
        $allowed = $lockedDllNames.ContainsKey($dependency) -or
            $systemAllowed.ContainsKey($dependency)
        if (-not $allowed) {
            throw "Native smoke binary imports a non-allowlisted DLL: $dependency ($binary)"
        }
    }
    Write-Output "PE_DEPENDENCY_AUDIT=PASS binary=$binary imports=$($dependencies -join ',')"
}

    Write-Output "PE_RUNTIME_AUDIT=PASS dumpbin=$dumpbin"
}
