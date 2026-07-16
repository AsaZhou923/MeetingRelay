[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = [IO.Path]::GetFullPath((Join-Path $scriptRoot "../.."))
$targetRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot "target"))
$sourcePath = Join-Path $scriptRoot "windows-controlled-root-attestor.c"
$outputDirectory = Join-Path $targetRoot "sherpa-native/formal-run-trust/msvc"
$executablePath = Join-Path $outputDirectory "meetingrelay-windows-controlled-root-attestor.exe"
$objectPath = Join-Path $outputDirectory "meetingrelay-windows-controlled-root-attestor.obj"
$metadataPath = Join-Path $outputDirectory "meetingrelay-windows-controlled-root-attestor.build.json"
$compileFlags = @(
    "/nologo", "/TC", "/std:c17", "/W4", "/WX", "/O2", "/MT", "/GS",
    "/DUNICODE", "/D_UNICODE"
)
$linkFlags = @(
    "/INCREMENTAL:NO", "/DYNAMICBASE", "/HIGHENTROPYVA", "/NXCOMPAT", "/guard:cf"
)

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

function Assert-SafeOutputPath {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Label
    )
    $resolved = [IO.Path]::GetFullPath($Path)
    $prefix = $targetRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    if (-not $resolved.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "$Label must remain below target: $resolved"
    }
    Assert-NoReparsePathChain -Path $resolved -Label $Label
    $attributes = Get-ExistingPathAttributes -Path $resolved
    if ($null -ne $attributes -and
        (($attributes -band [IO.FileAttributes]::Directory) -ne 0 -or
         ($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
        throw "$Label existing output is not a regular non-reparse file: $resolved"
    }
}

function Get-LowerSha256 {
    param([Parameter(Mandatory = $true)][string]$Path)
    Assert-RegularNonReparseFile -Path $Path -Label "hashed input"
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Import-VcVars64Environment {
    param([Parameter(Mandatory = $true)][string]$VcVarsPath)
    $lines = @(& $env:ComSpec /d /s /c "call `"$VcVarsPath`" >nul && set")
    if ($LASTEXITCODE -ne 0 -or $lines.Count -eq 0) {
        throw "vcvars64.bat did not produce an x64 compiler environment"
    }
    foreach ($line in $lines) {
        $separator = $line.IndexOf("=")
        if ($separator -gt 0) {
            Set-Item -LiteralPath ("Env:" + $line.Substring(0, $separator)) -Value $line.Substring($separator + 1)
        }
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

function Get-PeIdentity {
    param([Parameter(Mandatory = $true)][string]$Path)
    $bytes = [IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -lt 512 -or [BitConverter]::ToUInt16($bytes, 0) -ne 0x5A4D) {
        throw "Controlled-root attestor is not a valid MZ image"
    }
    $peOffset = [BitConverter]::ToInt32($bytes, 0x3C)
    if ($peOffset -lt 0x40 -or $peOffset + 96 -gt $bytes.Length -or
        [BitConverter]::ToUInt32($bytes, $peOffset) -ne 0x00004550) {
        throw "Controlled-root attestor has an invalid PE header"
    }
    $machine = [BitConverter]::ToUInt16($bytes, $peOffset + 4)
    $optionalHeaderMagic = [BitConverter]::ToUInt16($bytes, $peOffset + 24)
    $dllCharacteristics = [BitConverter]::ToUInt16($bytes, $peOffset + 24 + 70)
    if ($machine -ne 0x8664 -or $optionalHeaderMagic -ne 0x020B) {
        throw "Controlled-root attestor is not exact PE32+ AMD64"
    }
    $required = [ordered]@{
        DYNAMIC_BASE = 0x0040
        HIGH_ENTROPY_VA = 0x0020
        NX_COMPAT = 0x0100
        GUARD_CF = 0x4000
    }
    foreach ($entry in $required.GetEnumerator()) {
        if (($dllCharacteristics -band $entry.Value) -eq 0) {
            throw "Controlled-root attestor is missing PE security flag $($entry.Key)"
        }
    }
    return [PSCustomObject][ordered]@{
        machine = "0x8664"
        machine_name = "AMD64"
        optional_header_magic = "0x020b"
        dll_characteristics_value = ("0x{0:x4}" -f $dllCharacteristics)
        required_dll_characteristics = @($required.Keys)
    }
}

Assert-RegularNonReparseFile -Path $sourcePath -Label "controlled-root attestor source"
$vswherePath = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio/Installer/vswhere.exe"
Assert-RegularNonReparseFile -Path $vswherePath -Label "Visual Studio Installer vswhere.exe"
$installationPath = [string](@(& $vswherePath -version "[17.0,18.0)" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath) | Select-Object -First 1)
$installationVersion = [string](@(& $vswherePath -version "[17.0,18.0)" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationVersion) | Select-Object -First 1)
$installationPath = $installationPath.Trim()
$installationVersion = $installationVersion.Trim()
if ([string]::IsNullOrWhiteSpace($installationPath) -or
    [string]::IsNullOrWhiteSpace($installationVersion) -or
    -not $installationVersion.StartsWith("17.", [StringComparison]::Ordinal)) {
    throw "vswhere did not locate Visual Studio 2022 with VC x64 tools"
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
Assert-RegularNonReparseFile -Path $compilerPath -Label "Visual Studio Hostx64/x64 cl.exe"
Assert-RegularNonReparseFile -Path $vcVarsPath -Label "Visual Studio vcvars64.bat"
foreach ($output in @($executablePath, $objectPath, $metadataPath)) {
    Assert-SafeOutputPath -Path $output -Label "controlled-root build output"
}

$environmentSnapshot = @{}
foreach ($entry in @(Get-ChildItem Env:)) {
    $environmentSnapshot[$entry.Name] = $entry.Value
}
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
try {
    Import-VcVars64Environment -VcVarsPath $vcVarsPath
    $arguments = @($compileFlags) + @(
        "/Fe:$executablePath", "/Fo:$objectPath", $sourcePath, "/link"
    ) + @($linkFlags) + @("advapi32.lib")
    $compilerOutput = @(& $compilerPath @arguments 2>&1)
    if ($LASTEXITCODE -ne 0) {
        throw "MSVC controlled-root attestor build failed:`n$($compilerOutput -join [Environment]::NewLine)"
    }
}
finally {
    Restore-Environment -Snapshot $environmentSnapshot
}

Assert-RegularNonReparseFile -Path $executablePath -Label "built controlled-root attestor"
$metadata = [PSCustomObject][ordered]@{
    kind = "meetingrelay-windows-controlled-root-attestor-build-v1"
    schema_version = "1.0"
    executable_hash_scope = "local-build-identity-only-not-cross-toolchain-reproducibility"
    compiler = [PSCustomObject][ordered]@{
        family = "msvc"
        path = $compilerPath
        sha256 = Get-LowerSha256 -Path $compilerPath
        file_version = $compilerItem.VersionInfo.FileVersion
        product_version = $compilerItem.VersionInfo.ProductVersion
        visual_studio_installation = $installationPath
        visual_studio_version = $installationVersion
        vc_tools_version = $toolsetVersion
        host_architecture = "x64"
        target_architecture = "x64"
    }
    source = [PSCustomObject][ordered]@{
        relative_path = "tools/sherpa-native/windows-controlled-root-attestor.c"
        sha256 = Get-LowerSha256 -Path $sourcePath
    }
    build = [PSCustomObject][ordered]@{
        language = "c17"
        compile_flags = @($compileFlags)
        link_flags = @($linkFlags)
        system_libraries = @("advapi32.lib")
    }
    artifact = [PSCustomObject][ordered]@{
        relative_path = "target/sherpa-native/formal-run-trust/msvc/meetingrelay-windows-controlled-root-attestor.exe"
        sha256 = Get-LowerSha256 -Path $executablePath
        size_bytes = (Get-Item -LiteralPath $executablePath).Length
        pe = Get-PeIdentity -Path $executablePath
    }
}
$utf8WithoutBom = [Text.UTF8Encoding]::new($false)
[IO.File]::WriteAllText($metadataPath, ($metadata | ConvertTo-Json -Depth 8) + "`n", $utf8WithoutBom)
Assert-RegularNonReparseFile -Path $metadataPath -Label "controlled-root build metadata"
$persisted = Get-Content -LiteralPath $metadataPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($persisted.kind -cne $metadata.kind -or
    $persisted.source.sha256 -cne (Get-LowerSha256 -Path $sourcePath) -or
    $persisted.compiler.sha256 -cne (Get-LowerSha256 -Path $compilerPath) -or
    $persisted.artifact.sha256 -cne (Get-LowerSha256 -Path $executablePath) -or
    [Int64]$persisted.artifact.size_bytes -ne (Get-Item -LiteralPath $executablePath).Length) {
    throw "Controlled-root build metadata identity drifted"
}
Write-Output ("WINDOWS_CONTROLLED_ROOT_ATTESTOR_BUILD=PASS executable_sha256={0} metadata={1}" -f $metadata.artifact.sha256, $metadataPath)
