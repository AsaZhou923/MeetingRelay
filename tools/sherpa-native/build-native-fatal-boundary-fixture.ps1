[CmdletBinding()]
param(
    [switch]$PathSafetySelfTest
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = [IO.Path]::GetFullPath((Join-Path $scriptRoot "../.."))
$targetRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot "target"))
$sourcePath = Join-Path $scriptRoot "native-fatal-boundary-fixture.c"
$outputDirectory = Join-Path $targetRoot "sherpa-native/fatal-fixtures/msvc"
$executablePath = Join-Path $outputDirectory "meetingrelay-native-fatal-boundary-fixture.exe"
$objectPath = Join-Path $outputDirectory "meetingrelay-native-fatal-boundary-fixture.obj"
$metadataPath = Join-Path $outputDirectory "meetingrelay-native-fatal-boundary-fixture.build.json"
$compileFlags = @("/nologo", "/TC", "/std:c17", "/W4", "/WX", "/O2", "/MT", "/GS")
$linkFlags = @("/INCREMENTAL:NO", "/DYNAMICBASE", "/NXCOMPAT", "/guard:cf")

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
        if ($null -ne $attributes -and
            ($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "$Label path chain contains a reparse point: $current"
        }
        $parent = [IO.Directory]::GetParent($current)
        $current = if ($null -eq $parent) { $null } else { $parent.FullName }
    }
}

function Assert-RegularNonReparseFile {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Label
    )
    Assert-NoReparsePathChain -Path $Path -Label $Label
    $attributes = Get-ExistingPathAttributes -Path $Path
    if ($null -eq $attributes -or
        ($attributes -band [IO.FileAttributes]::Directory) -ne 0 -or
        ($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "$Label is not a regular non-reparse file: $Path"
    }
}

function Assert-SafeOutputFilePath {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Label
    )
    Assert-NoReparsePathChain -Path $Path -Label $Label
    $attributes = Get-ExistingPathAttributes -Path $Path
    if ($null -ne $attributes -and
        (($attributes -band [IO.FileAttributes]::Directory) -ne 0 -or
         ($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
        throw "$Label existing output is not a regular non-reparse file: $Path"
    }
}

function Assert-RegularNonReparseDirectory {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Label
    )
    Assert-NoReparsePathChain -Path $Path -Label $Label
    $attributes = Get-ExistingPathAttributes -Path $Path
    if ($null -eq $attributes -or
        ($attributes -band [IO.FileAttributes]::Directory) -eq 0 -or
        ($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "$Label is not a regular non-reparse directory: $Path"
    }
}

function Get-LowerSha256 {
    param([Parameter(Mandatory = $true)][string]$Path)
    Assert-RegularNonReparseFile -Path $Path -Label "hashed input"
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Assert-ExactSequence {
    param(
        [Parameter(Mandatory = $true)][object[]]$Actual,
        [Parameter(Mandatory = $true)][object[]]$Expected,
        [Parameter(Mandatory = $true)][string]$Label
    )
    if (($Actual -join "`n") -cne ($Expected -join "`n")) {
        throw "$Label differs from the exact build contract"
    }
}

function Get-PeIdentity {
    param([Parameter(Mandatory = $true)][string]$Path)
    $bytes = [IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -lt 512 -or [BitConverter]::ToUInt16($bytes, 0) -ne 0x5A4D) {
        throw "Fatal-boundary fixture is not a valid MZ image: $Path"
    }
    $peOffset = [BitConverter]::ToInt32($bytes, 0x3C)
    if ($peOffset -lt 0x40 -or $peOffset + 96 -gt $bytes.Length -or
        [BitConverter]::ToUInt32($bytes, $peOffset) -ne 0x00004550) {
        throw "Fatal-boundary fixture has an invalid PE header: $Path"
    }
    $machine = [BitConverter]::ToUInt16($bytes, $peOffset + 4)
    $optionalHeaderMagic = [BitConverter]::ToUInt16($bytes, $peOffset + 24)
    $dllCharacteristics = [BitConverter]::ToUInt16($bytes, $peOffset + 24 + 70)
    if ($machine -ne 0x8664 -or $optionalHeaderMagic -ne 0x020B) {
        throw ("Fatal-boundary fixture is not exact PE32+ AMD64: machine=0x{0:x4} optional=0x{1:x4}" -f $machine, $optionalHeaderMagic)
    }
    $requiredDllCharacteristics = [ordered]@{
        DYNAMIC_BASE = 0x0040
        NX_COMPAT = 0x0100
        GUARD_CF = 0x4000
    }
    foreach ($entry in $requiredDllCharacteristics.GetEnumerator()) {
        if (($dllCharacteristics -band $entry.Value) -eq 0) {
            throw ("Fatal-boundary fixture is missing PE security flag {0} (DllCharacteristics=0x{1:x4})" -f $entry.Key, $dllCharacteristics)
        }
    }
    return [PSCustomObject][ordered]@{
        machine = "0x8664"
        machine_name = "AMD64"
        optional_header_magic = "0x020b"
        dll_characteristics_value = ("0x{0:x4}" -f $dllCharacteristics)
        required_dll_characteristics = @($requiredDllCharacteristics.Keys)
    }
}

function Import-VcVars64Environment {
    param([Parameter(Mandatory = $true)][string]$VcVarsPath)
    $lines = @(& $env:ComSpec /d /s /c "call `"$VcVarsPath`" >nul && set")
    if ($LASTEXITCODE -ne 0 -or $lines.Count -eq 0) {
        throw "vcvars64.bat did not produce an x64 compiler environment"
    }
    foreach ($line in $lines) {
        $separator = $line.IndexOf("=")
        if ($separator -le 0) {
            continue
        }
        $name = $line.Substring(0, $separator)
        $value = $line.Substring($separator + 1)
        Set-Item -LiteralPath "Env:$name" -Value $value
    }
}

function Restore-Environment {
    param([Parameter(Mandatory = $true)][hashtable]$Snapshot)
    foreach ($entry in @(Get-ChildItem Env:)) {
        if (-not $Snapshot.ContainsKey($entry.Name)) {
            Remove-Item -LiteralPath "Env:$($entry.Name)" -ErrorAction SilentlyContinue
        }
    }
    foreach ($name in $Snapshot.Keys) {
        Set-Item -LiteralPath "Env:$name" -Value $Snapshot[$name]
    }
}

function Invoke-PathSafetySelfTest {
    $selfTestRoot = Join-Path $targetRoot ("sherpa-native/fatal-fixtures/path-safety-" + [Guid]::NewGuid().ToString("N"))
    $realDirectory = Join-Path $selfTestRoot "real"
    $junctionPath = Join-Path $selfTestRoot "junction"
    $regularFile = Join-Path $realDirectory "regular.bin"
    $directoryAsFile = Join-Path $realDirectory "directory-as-output-file"
    $junctionCreated = $false
    Assert-NoReparsePathChain -Path $selfTestRoot -Label "path safety self-test root"
    New-Item -ItemType Directory -Path $realDirectory -Force | Out-Null
    [IO.File]::WriteAllBytes($regularFile, [byte[]](1, 2, 3, 4))
    try {
        Assert-RegularNonReparseFile -Path $regularFile -Label "regular self-test file"
        & $env:ComSpec /d /c "mklink /J `"$junctionPath`" `"$realDirectory`"" | Out-Null
        if ($LASTEXITCODE -ne 0) {
            throw "Could not create the required path-safety junction fixture"
        }
        $junctionCreated = $true
        foreach ($candidate in @($junctionPath, (Join-Path $junctionPath "future.exe"))) {
            try {
                Assert-SafeOutputFilePath -Path $candidate -Label "junction output self-test"
            }
            catch {
                if ($_.Exception.Message -notmatch "path chain contains a reparse point") {
                    throw "Path-safety self-test rejected its junction for the wrong reason: $($_.Exception.Message)"
                }
                continue
            }
            throw "Path-safety self-test accepted a junction output path: $candidate"
        }
        New-Item -ItemType Directory -Path $directoryAsFile | Out-Null
        try {
            Assert-SafeOutputFilePath -Path $directoryAsFile -Label "directory output-file self-test"
        }
        catch {
            if ($_.Exception.Message -notmatch "existing output is not a regular non-reparse file") {
                throw "Path-safety self-test rejected its directory leaf for the wrong reason: $($_.Exception.Message)"
            }
            return
        }
        throw "Path-safety self-test accepted a directory where a regular output file is required"
    }
    finally {
        if ($junctionCreated) {
            [IO.Directory]::Delete($junctionPath)
        }
        Assert-NoReparsePathChain -Path $selfTestRoot -Label "path safety self-test cleanup root"
        if (Test-Path -LiteralPath $selfTestRoot) {
            Remove-Item -LiteralPath $selfTestRoot -Recurse -Force
        }
    }
}

function Assert-BuildMetadata {
    param(
        [Parameter(Mandatory = $true)]$Metadata,
        [Parameter(Mandatory = $true)][string]$CompilerPath,
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Executable
    )
    if ($Metadata.kind -cne "meetingrelay-native-fatal-boundary-fixture-build-v1" -or
        $Metadata.schema_version -cne "1.0" -or
        $Metadata.executable_hash_scope -cne "local-build-identity-only-not-cross-toolchain-reproducibility") {
        throw "Fatal-boundary build metadata scope drifted"
    }
    if ($Metadata.compiler.path -cne $CompilerPath -or
        $Metadata.compiler.sha256 -cne (Get-LowerSha256 -Path $CompilerPath) -or
        $Metadata.source.relative_path -cne "tools/sherpa-native/native-fatal-boundary-fixture.c" -or
        $Metadata.source.sha256 -cne (Get-LowerSha256 -Path $Source) -or
        $Metadata.artifact.relative_path -cne "target/sherpa-native/fatal-fixtures/msvc/meetingrelay-native-fatal-boundary-fixture.exe" -or
        $Metadata.artifact.sha256 -cne (Get-LowerSha256 -Path $Executable) -or
        [Int64]$Metadata.artifact.size_bytes -ne (Get-Item -LiteralPath $Executable).Length) {
        throw "Fatal-boundary build metadata identity drifted"
    }
    Assert-ExactSequence -Actual @($Metadata.build.compile_flags) -Expected $compileFlags -Label "compiler flags"
    Assert-ExactSequence -Actual @($Metadata.build.link_flags) -Expected $linkFlags -Label "linker flags"
    Assert-ExactSequence `
        -Actual @($Metadata.artifact.pe.required_dll_characteristics) `
        -Expected @("DYNAMIC_BASE", "NX_COMPAT", "GUARD_CF") `
        -Label "PE security flags"
    if ($Metadata.artifact.pe.machine -cne "0x8664" -or
        $Metadata.artifact.pe.machine_name -cne "AMD64" -or
        $Metadata.artifact.pe.optional_header_magic -cne "0x020b") {
        throw "Fatal-boundary build metadata does not describe exact PE32+ AMD64"
    }
}

if ($PathSafetySelfTest) {
    Invoke-PathSafetySelfTest
    Write-Output "NATIVE_FATAL_BOUNDARY_PATH_SAFETY_SELF_TEST=PASS"
    return
}
Assert-RegularNonReparseFile -Path $sourcePath -Label "fatal-boundary fixture source"

$vswherePath = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio/Installer/vswhere.exe"
Assert-RegularNonReparseFile -Path $vswherePath -Label "Visual Studio Installer vswhere.exe"
$installationPathResult = @(& $vswherePath `
    -version "[17.0,18.0)" `
    -latest `
    -products * `
    -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
    -property installationPath) | Select-Object -First 1
$installationVersionResult = @(& $vswherePath `
    -version "[17.0,18.0)" `
    -latest `
    -products * `
    -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
    -property installationVersion) | Select-Object -First 1
$installationPath = if ($null -eq $installationPathResult) { "" } else { ([string]$installationPathResult).Trim() }
$installationVersion = if ($null -eq $installationVersionResult) { "" } else { ([string]$installationVersionResult).Trim() }
if ([string]::IsNullOrWhiteSpace($installationPath) -or
    [string]::IsNullOrWhiteSpace($installationVersion) -or
    -not $installationVersion.StartsWith("17.", [StringComparison]::Ordinal)) {
    throw "vswhere did not locate a Visual Studio 2022 installation with VC x64 tools"
}

$compilerCandidates = @(Get-ChildItem -Path (Join-Path $installationPath "VC/Tools/MSVC/*/bin/Hostx64/x64/cl.exe") -File -ErrorAction SilentlyContinue |
    Sort-Object { [Version]$_.Directory.Parent.Parent.Parent.Name } -Descending)
if ($compilerCandidates.Count -eq 0) {
    throw "Visual Studio 2022 has no VC Hostx64/x64 cl.exe"
}
$compilerItem = $compilerCandidates[0]
$compilerPath = $compilerItem.FullName
$toolsetVersion = $compilerItem.Directory.Parent.Parent.Parent.Name
$vcVarsPath = Join-Path $installationPath "VC/Auxiliary/Build/vcvars64.bat"
Assert-RegularNonReparseFile -Path $compilerPath -Label "Visual Studio 2022 Hostx64/x64 cl.exe"
Assert-RegularNonReparseFile -Path $vcVarsPath -Label "Visual Studio 2022 vcvars64.bat"
Assert-NoReparsePathChain -Path $outputDirectory -Label "fatal-boundary output directory"
Assert-SafeOutputFilePath -Path $executablePath -Label "fatal-boundary executable"
Assert-SafeOutputFilePath -Path $objectPath -Label "fatal-boundary object"
Assert-SafeOutputFilePath -Path $metadataPath -Label "fatal-boundary metadata"

$environmentSnapshot = @{}
foreach ($entry in @(Get-ChildItem Env:)) {
    $environmentSnapshot[$entry.Name] = $entry.Value
}

New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
Assert-RegularNonReparseDirectory -Path $outputDirectory -Label "fatal-boundary output directory"
try {
    Import-VcVars64Environment -VcVarsPath $vcVarsPath
    $compilerArguments = @($compileFlags) + @(
        "/Fe:$executablePath",
        "/Fo:$objectPath",
        $sourcePath,
        "/link"
    ) + @($linkFlags)
    $compilerOutput = @(& $compilerPath @compilerArguments 2>&1)
    if ($LASTEXITCODE -ne 0) {
        throw "MSVC fatal-boundary fixture build failed:`n$($compilerOutput -join [Environment]::NewLine)"
    }
}
finally {
    Restore-Environment -Snapshot $environmentSnapshot
}

Assert-RegularNonReparseFile -Path $executablePath -Label "built fatal-boundary executable"
$peIdentity = Get-PeIdentity -Path $executablePath
$compilerVersion = $compilerItem.VersionInfo
$metadata = [PSCustomObject][ordered]@{
    kind = "meetingrelay-native-fatal-boundary-fixture-build-v1"
    schema_version = "1.0"
    executable_hash_scope = "local-build-identity-only-not-cross-toolchain-reproducibility"
    compiler = [PSCustomObject][ordered]@{
        family = "msvc"
        path = $compilerPath
        sha256 = Get-LowerSha256 -Path $compilerPath
        file_version = $compilerVersion.FileVersion
        product_version = $compilerVersion.ProductVersion
        visual_studio_installation = $installationPath
        visual_studio_version = $installationVersion
        vc_tools_version = $toolsetVersion
        host_architecture = "x64"
        target_architecture = "x64"
    }
    source = [PSCustomObject][ordered]@{
        relative_path = "tools/sherpa-native/native-fatal-boundary-fixture.c"
        sha256 = Get-LowerSha256 -Path $sourcePath
    }
    build = [PSCustomObject][ordered]@{
        language = "c17"
        compile_flags = @($compileFlags)
        link_flags = @($linkFlags)
    }
    artifact = [PSCustomObject][ordered]@{
        relative_path = "target/sherpa-native/fatal-fixtures/msvc/meetingrelay-native-fatal-boundary-fixture.exe"
        sha256 = Get-LowerSha256 -Path $executablePath
        size_bytes = (Get-Item -LiteralPath $executablePath).Length
        pe = $peIdentity
    }
}

$utf8WithoutBom = New-Object Text.UTF8Encoding($false)
$metadataJson = $metadata | ConvertTo-Json -Depth 8
[IO.File]::WriteAllText($metadataPath, $metadataJson + "`n", $utf8WithoutBom)
Assert-RegularNonReparseFile -Path $metadataPath -Label "persisted fatal-boundary metadata"
$persistedMetadata = Get-Content -LiteralPath $metadataPath -Raw -Encoding UTF8 | ConvertFrom-Json
Assert-BuildMetadata `
    -Metadata $persistedMetadata `
    -CompilerPath $compilerPath `
    -Source $sourcePath `
    -Executable $executablePath

Write-Output ("NATIVE_FATAL_BOUNDARY_FIXTURE_BUILD=PASS executable_sha256={0} metadata={1}" -f $metadata.artifact.sha256, $metadataPath)
