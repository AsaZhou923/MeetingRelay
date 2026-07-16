[CmdletBinding()]
param(
    [switch]$AllowCapabilitySkip
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = [IO.Path]::GetFullPath((Join-Path $scriptRoot "../.."))
$targetRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot "target"))
$buildScript = Join-Path $scriptRoot "build-windows-controlled-root-attestor.ps1"
$outputDirectory = Join-Path $targetRoot "sherpa-native/formal-run-trust/msvc"
$executablePath = Join-Path $outputDirectory "meetingrelay-windows-controlled-root-attestor.exe"
$metadataPath = Join-Path $outputDirectory "meetingrelay-windows-controlled-root-attestor.build.json"
$testRoot = Join-Path $targetRoot ("sherpa-native/formal-run-trust/windows-test-" + [Guid]::NewGuid().ToString("N"))

function Assert-UnderTarget {
    param([Parameter(Mandatory = $true)][string]$Path)
    $resolved = [IO.Path]::GetFullPath($Path)
    $prefix = $targetRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    if (-not $resolved.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Windows controlled-root test path escaped target: $resolved"
    }
}

function Get-LowerSha256 {
    param([Parameter(Mandatory = $true)][string]$Path)
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-BytesSha256 {
    param([Parameter(Mandatory = $true)][byte[]]$Bytes)
    $sha256 = [Security.Cryptography.SHA256]::Create()
    try {
        return [BitConverter]::ToString($sha256.ComputeHash($Bytes)).Replace("-", "").ToLowerInvariant()
    }
    finally {
        $sha256.Dispose()
    }
}

function Set-ExactControlledAcl {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [switch]$AddUsersRead
    )
    $isDirectory = Test-Path -LiteralPath $Path -PathType Container
    $operatorSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $systemSid = [Security.Principal.SecurityIdentifier]::new("S-1-5-18")
    $administratorsSid = [Security.Principal.SecurityIdentifier]::new("S-1-5-32-544")
    $security = if ($isDirectory) {
        [Security.AccessControl.DirectorySecurity]::new()
    }
    else {
        [Security.AccessControl.FileSecurity]::new()
    }
    $inheritance = if ($isDirectory) {
        [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
            [Security.AccessControl.InheritanceFlags]::ObjectInherit
    }
    else {
        [Security.AccessControl.InheritanceFlags]::None
    }
    $security.SetOwner($operatorSid)
    $security.SetAccessRuleProtection($true, $false)
    foreach ($sid in @($operatorSid, $systemSid, $administratorsSid)) {
        $rule = [Security.AccessControl.FileSystemAccessRule]::new(
            $sid,
            [Security.AccessControl.FileSystemRights]::FullControl,
            $inheritance,
            [Security.AccessControl.PropagationFlags]::None,
            [Security.AccessControl.AccessControlType]::Allow
        )
        [void]$security.AddAccessRule($rule)
    }
    if ($AddUsersRead) {
        $usersRule = [Security.AccessControl.FileSystemAccessRule]::new(
            [Security.Principal.SecurityIdentifier]::new("S-1-5-32-545"),
            [Security.AccessControl.FileSystemRights]::Read,
            [Security.AccessControl.AccessControlType]::Allow
        )
        [void]$security.AddAccessRule($usersRule)
    }
    Set-Acl -LiteralPath $Path -AclObject $security
}

function Quote-WindowsArgument {
    param([Parameter(Mandatory = $true)][string]$Value)
    if ($Value.Contains('"')) {
        throw "Test arguments must not contain quote characters"
    }
    return '"' + $Value + '"'
}

function Invoke-Attestor {
    param(
        [Parameter(Mandatory = $true)][string[]]$Argument,
        [byte[]]$InputBytes = [byte[]]::new(0)
    )
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $executablePath
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardInput = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.StandardOutputEncoding = [Text.UTF8Encoding]::new($false, $true)
    $startInfo.StandardErrorEncoding = [Text.UTF8Encoding]::new($false, $true)
    $argumentListProperty = $startInfo.GetType().GetProperty("ArgumentList")
    if ($null -ne $argumentListProperty) {
        $argumentList = $argumentListProperty.GetValue($startInfo)
        foreach ($value in $Argument) {
            [void]$argumentList.Add($value)
        }
    }
    else {
        $startInfo.Arguments = (($Argument | ForEach-Object { Quote-WindowsArgument -Value $_ }) -join " ")
    }
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    if (-not $process.Start()) {
        throw "Could not start the Windows controlled-root attestor"
    }
    if ($InputBytes.Length -gt 0) {
        $process.StandardInput.BaseStream.Write($InputBytes, 0, $InputBytes.Length)
    }
    $process.StandardInput.BaseStream.Close()
    $stdout = $process.StandardOutput.ReadToEnd()
    $stderr = $process.StandardError.ReadToEnd()
    $process.WaitForExit()
    return [PSCustomObject]@{
        ExitCode = $process.ExitCode
        Stdout = $stdout
        Stderr = $stderr
    }
}

function Assert-FailedWithoutOutput {
    param(
        [Parameter(Mandatory = $true)]$Result,
        [Parameter(Mandatory = $true)][string]$Label
    )
    if ($Result.ExitCode -eq 0 -or $Result.Stdout.Length -ne 0 -or $Result.Stderr.Length -ne 0) {
        throw "$Label did not fail closed without output"
    }
}

function ConvertFrom-ReceiptLine {
    param(
        [Parameter(Mandatory = $true)][string]$Line,
        [Parameter(Mandatory = $true)][string]$ExpectedMarker
    )
    if (-not $Line.EndsWith("`n", [StringComparison]::Ordinal) -or $Line.Contains("`r") -or
        $Line.IndexOf("`n", [StringComparison]::Ordinal) -ne $Line.Length - 1) {
        throw "$ExpectedMarker receipt is not one LF-terminated ASCII line"
    }
    if ($Line.ToCharArray() | Where-Object { [int]$_ -gt 0x7f }) {
        throw "$ExpectedMarker receipt contains non-ASCII output"
    }
    $tokens = $Line.Substring(0, $Line.Length - 1).Split(' ')
    if ($tokens.Count -lt 2 -or $tokens[0] -cne $ExpectedMarker) {
        throw "$ExpectedMarker receipt marker differs"
    }
    $fields = [ordered]@{}
    foreach ($token in $tokens[1..($tokens.Count - 1)]) {
        $separator = $token.IndexOf('=')
        if ($separator -le 0 -or $separator -eq $token.Length - 1) {
            throw "$ExpectedMarker receipt contains an invalid token"
        }
        $name = $token.Substring(0, $separator)
        $value = $token.Substring($separator + 1)
        if ($fields.Contains($name)) {
            throw "$ExpectedMarker receipt contains a duplicate field"
        }
        $fields[$name] = $value
    }
    return $fields
}

Assert-UnderTarget -Path $testRoot
$buildOutput = @(& $buildScript)
if ($buildOutput.Count -ne 1 -or
    $buildOutput[0] -notmatch '^WINDOWS_CONTROLLED_ROOT_ATTESTOR_BUILD=PASS executable_sha256=[0-9a-f]{64} metadata=.+\.json$') {
    throw "Windows controlled-root build helper did not emit its exact PASS marker"
}
if (-not (Test-Path -LiteralPath $executablePath -PathType Leaf) -or
    -not (Test-Path -LiteralPath $metadataPath -PathType Leaf)) {
    throw "Windows controlled-root build helper did not produce its exact outputs"
}
$metadata = Get-Content -LiteralPath $metadataPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($metadata.kind -cne "meetingrelay-windows-controlled-root-attestor-build-v1" -or
    $metadata.schema_version -cne "1.0" -or
    $metadata.executable_hash_scope -cne "local-build-identity-only-not-cross-toolchain-reproducibility" -or
    $metadata.source.sha256 -cne (Get-LowerSha256 -Path (Join-Path $scriptRoot "windows-controlled-root-attestor.c")) -or
    $metadata.compiler.sha256 -cne (Get-LowerSha256 -Path $metadata.compiler.path) -or
    $metadata.artifact.sha256 -cne (Get-LowerSha256 -Path $executablePath) -or
    $metadata.artifact.pe.machine -cne "0x8664" -or
    $metadata.artifact.pe.optional_header_magic -cne "0x020b" -or
    (@($metadata.artifact.pe.required_dll_characteristics) -join "`n") -cne
        (@("DYNAMIC_BASE", "HIGH_ENTROPY_VA", "NX_COMPAT", "GUARD_CF") -join "`n")) {
    throw "Windows controlled-root persisted build metadata failed independent validation"
}

New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
try {
    $controlledRoot = Join-Path $testRoot "controlled"
    New-Item -ItemType Directory -Path $controlledRoot | Out-Null
    Set-ExactControlledAcl -Path $controlledRoot
    $inventoryPath = Join-Path $controlledRoot "inventory.bin"
    [IO.File]::WriteAllBytes($inventoryPath, [byte[]](1, 3, 3, 7))
    $retentionExpires = [DateTimeOffset]::UtcNow.AddDays(30).ToUnixTimeSeconds()
    $retentionMarkerPath = Join-Path $controlledRoot ".meetingrelay-retention-v1"
    [IO.File]::WriteAllText(
        $retentionMarkerPath,
        ([string]$retentionExpires) + "`n",
        [Text.UTF8Encoding]::new($false)
    )
    $attestResult = Invoke-Attestor -Argument @("attest", $controlledRoot)
    if ($attestResult.ExitCode -ne 0 -or $attestResult.Stderr.Length -ne 0) {
        throw "Exact controlled root did not attest successfully"
    }
    $attestation = ConvertFrom-ReceiptLine -Line $attestResult.Stdout -ExpectedMarker "CONTROLLED_ROOT_ATTESTATION=PASS"
    $expectedAttestationFields = @(
        "volume_serial", "root_file_id", "owner_sid_sha256", "dacl_sha256",
        "ace_count", "inventory_sha256", "inventory_count", "inventory_bytes",
        "retention_marker", "retention_expires_unix_seconds", "filesystem",
        "drive_type", "protected_dacl", "reparse_count"
    )
    if (($attestation.Keys -join "`n") -cne ($expectedAttestationFields -join "`n") -or
        $attestation.volume_serial -notmatch '^[0-9a-f]{16}$' -or
        $attestation.root_file_id -notmatch '^[0-9a-f]{32}$' -or
        $attestation.owner_sid_sha256 -notmatch '^[0-9a-f]{64}$' -or
        $attestation.dacl_sha256 -notmatch '^[0-9a-f]{64}$' -or
        $attestation.ace_count -cne "3" -or
        $attestation.inventory_sha256 -notmatch '^[0-9a-f]{64}$' -or
        $attestation.inventory_count -cne "2" -or
        $attestation.inventory_bytes -cne [string](4 + ([Text.Encoding]::UTF8.GetByteCount(([string]$retentionExpires) + "`n"))) -or
        $attestation.retention_marker -cne "present" -or
        $attestation.retention_expires_unix_seconds -cne [string]$retentionExpires -or
        $attestation.filesystem -cne "NTFS" -or
        $attestation.drive_type -cne "fixed" -or
        $attestation.protected_dacl -cne "true" -or
        $attestation.reparse_count -cne "0" -or
        $attestResult.Stdout.IndexOf($controlledRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or
        $attestResult.Stdout.IndexOf([Security.Principal.WindowsIdentity]::GetCurrent().User.Value, [StringComparison]::Ordinal) -ge 0) {
        throw "Controlled-root attestation fields or privacy boundary drifted"
    }

    $weakChildPath = Join-Path $controlledRoot "weak-child-acl.bin"
    [IO.File]::WriteAllBytes($weakChildPath, [byte[]](9, 9, 9))
    Set-ExactControlledAcl -Path $weakChildPath -AddUsersRead
    Assert-FailedWithoutOutput -Result (Invoke-Attestor -Argument @("attest", $controlledRoot)) -Label "weak descendant DACL"
    Remove-Item -LiteralPath $weakChildPath -Force

    $unprotectedRoot = Join-Path $testRoot "unprotected"
    New-Item -ItemType Directory -Path $unprotectedRoot | Out-Null
    Assert-FailedWithoutOutput -Result (Invoke-Attestor -Argument @("attest", $unprotectedRoot)) -Label "unprotected DACL"

    $extraAceRoot = Join-Path $testRoot "extra-ace"
    New-Item -ItemType Directory -Path $extraAceRoot | Out-Null
    $extraAcl = [Security.AccessControl.DirectorySecurity]::new()
    $extraOperatorSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $extraAcl.SetOwner($extraOperatorSid)
    $extraAcl.SetAccessRuleProtection($true, $false)
    foreach ($sid in @(
        $extraOperatorSid,
        [Security.Principal.SecurityIdentifier]::new("S-1-5-18"),
        [Security.Principal.SecurityIdentifier]::new("S-1-5-32-544")
    )) {
        $baselineRule = [Security.AccessControl.FileSystemAccessRule]::new(
            $sid,
            [Security.AccessControl.FileSystemRights]::FullControl,
            [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit,
            [Security.AccessControl.PropagationFlags]::None,
            [Security.AccessControl.AccessControlType]::Allow
        )
        [void]$extraAcl.AddAccessRule($baselineRule)
    }
    $usersRule = [Security.AccessControl.FileSystemAccessRule]::new(
        [Security.Principal.SecurityIdentifier]::new("S-1-5-32-545"),
        [Security.AccessControl.FileSystemRights]::Read,
        [Security.AccessControl.AccessControlType]::Allow
    )
    [void]$extraAcl.AddAccessRule($usersRule)
    Set-Acl -LiteralPath $extraAceRoot -AclObject $extraAcl
    Assert-FailedWithoutOutput -Result (Invoke-Attestor -Argument @("attest", $extraAceRoot)) -Label "extra DACL principal"

    $overRetentionRoot = Join-Path $testRoot "over-retention"
    New-Item -ItemType Directory -Path $overRetentionRoot | Out-Null
    Set-ExactControlledAcl -Path $overRetentionRoot
    $overRetentionExpires = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() + (30 * 24 * 60 * 60) + 60
    [IO.File]::WriteAllText(
        (Join-Path $overRetentionRoot ".meetingrelay-retention-v1"),
        ([string]$overRetentionExpires) + "`n",
        [Text.UTF8Encoding]::new($false)
    )
    Assert-FailedWithoutOutput -Result (Invoke-Attestor -Argument @("attest", $overRetentionRoot)) -Label "30-day-plus-one-minute retention"

    $overInventoryRoot = Join-Path $testRoot "over-inventory"
    New-Item -ItemType Directory -Path $overInventoryRoot | Out-Null
    Set-ExactControlledAcl -Path $overInventoryRoot
    [IO.File]::WriteAllText(
        (Join-Path $overInventoryRoot ".meetingrelay-retention-v1"),
        ([string]([DateTimeOffset]::UtcNow.AddDays(1).ToUnixTimeSeconds())) + "`n",
        [Text.UTF8Encoding]::new($false)
    )
    for ($index = 0; $index -lt 4096; $index++) {
        $overInventoryEntry = Join-Path $overInventoryRoot ("entry-{0:D4}.bin" -f $index)
        [IO.File]::WriteAllBytes($overInventoryEntry, [byte[]]::new(0))
    }
    Assert-FailedWithoutOutput -Result (Invoke-Attestor -Argument @("attest", $overInventoryRoot)) -Label "4096-entry-plus-marker inventory"

    $realDirectory = Join-Path $controlledRoot "real-directory"
    $junction = Join-Path $controlledRoot "junction"
    New-Item -ItemType Directory -Path $realDirectory | Out-Null
    & cmd.exe /d /c "mklink /J `"$junction`" `"$realDirectory`"" | Out-Null
    if ($LASTEXITCODE -eq 0) {
        Assert-FailedWithoutOutput -Result (Invoke-Attestor -Argument @("attest", $controlledRoot)) -Label "descendant junction"
        Remove-Item -LiteralPath $junction -Force
    }
    else {
        if ($AllowCapabilitySkip) {
            Write-Output "CONTROLLED_ROOT_REPARSE_TEST=SKIP capability=mklink-junction"
        }
        else {
            throw "Required junction capability is unavailable"
        }
    }
    Remove-Item -LiteralPath $realDirectory -Force

    $payload = [Text.Encoding]::UTF8.GetBytes("meetingrelay-controlled-root-probe-v1`n")
    $payloadSha256 = Get-BytesSha256 -Bytes $payload
    $nestedLeafResult = Invoke-Attestor -Argument @(
        "create", $controlledRoot, "nested\probe.bin", $payloadSha256, [string]$payload.Length
    ) -InputBytes $payload
    Assert-FailedWithoutOutput -Result $nestedLeafResult -Label "multi-segment controlled-root leaf"
    $leaf = "receipt-probe.bin"
    $createResult = Invoke-Attestor -Argument @(
        "create", $controlledRoot, $leaf, $payloadSha256, [string]$payload.Length
    ) -InputBytes $payload
    if ($createResult.ExitCode -ne 0 -or $createResult.Stderr.Length -ne 0) {
        throw "Handle-bound CREATE_NEW probe failed"
    }
    $create = ConvertFrom-ReceiptLine -Line $createResult.Stdout -ExpectedMarker "CONTROLLED_ROOT_CREATE=PASS"
    $expectedMutationFields = @(
        "volume_serial", "root_file_id", "file_id", "content_sha256",
        "size_bytes", "relative_name_sha256", "hard_link_count", "operation"
    )
    if (($create.Keys -join "`n") -cne ($expectedMutationFields -join "`n") -or
        $create.volume_serial -cne $attestation.volume_serial -or
        $create.root_file_id -cne $attestation.root_file_id -or
        $create.file_id -notmatch '^[0-9a-f]{32}$' -or
        $create.content_sha256 -cne $payloadSha256 -or
        $create.size_bytes -cne [string]$payload.Length -or
        $create.relative_name_sha256 -notmatch '^[0-9a-f]{64}$' -or
        $create.hard_link_count -cne "1" -or
        $create.operation -cne "create-new-flushed" -or
        $createResult.Stdout.IndexOf($controlledRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or
        $createResult.Stdout.IndexOf($leaf, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
        throw "Create receipt fields, identity, or privacy boundary drifted"
    }
    if ([Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $controlledRoot $leaf))) -cne
        [Convert]::ToBase64String($payload)) {
        throw "Created probe bytes differ"
    }

    $prematureCleanup = Invoke-Attestor -Argument @(
        "cleanup-delete", $controlledRoot, $leaf, $create.volume_serial, $create.root_file_id,
        $create.file_id, $create.content_sha256, $create.size_bytes, [string]$retentionExpires
    )
    Assert-FailedWithoutOutput -Result $prematureCleanup -Label "premature cleanup-delete"
    if (-not (Test-Path -LiteralPath (Join-Path $controlledRoot $leaf) -PathType Leaf)) {
        throw "Premature cleanup-delete removed the probe"
    }
    $deleteArguments = @(
        "probe-delete", $controlledRoot, $leaf, $create.volume_serial, $create.root_file_id,
        $create.file_id, $create.content_sha256, $create.size_bytes, [string]$retentionExpires
    )
    $deleteResult = Invoke-Attestor -Argument $deleteArguments
    if ($deleteResult.ExitCode -ne 0 -or $deleteResult.Stderr.Length -ne 0) {
        throw "Handle-bound delete probe failed"
    }
    $delete = ConvertFrom-ReceiptLine -Line $deleteResult.Stdout -ExpectedMarker "CONTROLLED_ROOT_DELETE=PASS"
    if (($delete.Keys -join "`n") -cne ($expectedMutationFields -join "`n") -or
        $delete.file_id -cne $create.file_id -or
        $delete.content_sha256 -cne $payloadSha256 -or
        $delete.hard_link_count -cne "1" -or
        $delete.operation -cne "handle-disposition-probe-delete" -or
        (Test-Path -LiteralPath (Join-Path $controlledRoot $leaf))) {
        throw "Delete receipt identity or handle-disposition result drifted"
    }

    $expiredDeleteRoot = Join-Path $testRoot "expired-delete"
    New-Item -ItemType Directory -Path $expiredDeleteRoot | Out-Null
    Set-ExactControlledAcl -Path $expiredDeleteRoot
    $initialDeleteExpiry = [DateTimeOffset]::UtcNow.AddDays(1).ToUnixTimeSeconds()
    $expiredMarkerPath = Join-Path $expiredDeleteRoot ".meetingrelay-retention-v1"
    [IO.File]::WriteAllText(
        $expiredMarkerPath,
        ([string]$initialDeleteExpiry) + "`n",
        [Text.UTF8Encoding]::new($false)
    )
    Set-ExactControlledAcl -Path $expiredMarkerPath
    $expiredLeaf = "expired-retention-probe.bin"
    $expiredCreateResult = Invoke-Attestor -Argument @(
        "create", $expiredDeleteRoot, $expiredLeaf, $payloadSha256, [string]$payload.Length
    ) -InputBytes $payload
    if ($expiredCreateResult.ExitCode -ne 0) {
        throw "Expired-retention delete fixture create failed"
    }
    $expiredCreate = ConvertFrom-ReceiptLine -Line $expiredCreateResult.Stdout -ExpectedMarker "CONTROLLED_ROOT_CREATE=PASS"
    $expiredMarker = [DateTimeOffset]::UtcNow.AddSeconds(-1).ToUnixTimeSeconds()
    [IO.File]::WriteAllText(
        $expiredMarkerPath,
        ([string]$expiredMarker) + "`n",
        [Text.UTF8Encoding]::new($false)
    )
    $wrongRetentionDelete = Invoke-Attestor -Argument @(
        "cleanup-delete", $expiredDeleteRoot, $expiredLeaf, $expiredCreate.volume_serial,
        $expiredCreate.root_file_id, $expiredCreate.file_id,
        $expiredCreate.content_sha256, $expiredCreate.size_bytes, [string]($expiredMarker - 1)
    )
    Assert-FailedWithoutOutput -Result $wrongRetentionDelete -Label "mismatched expired retention marker"
    if (-not (Test-Path -LiteralPath (Join-Path $expiredDeleteRoot $expiredLeaf) -PathType Leaf)) {
        throw "Retention mismatch removed the controlled artifact"
    }
    $expiredProbeDelete = Invoke-Attestor -Argument @(
        "probe-delete", $expiredDeleteRoot, $expiredLeaf, $expiredCreate.volume_serial,
        $expiredCreate.root_file_id, $expiredCreate.file_id,
        $expiredCreate.content_sha256, $expiredCreate.size_bytes, [string]$expiredMarker
    )
    Assert-FailedWithoutOutput -Result $expiredProbeDelete -Label "expired probe-delete"
    $expiredDelete = Invoke-Attestor -Argument @(
        "cleanup-delete", $expiredDeleteRoot, $expiredLeaf, $expiredCreate.volume_serial,
        $expiredCreate.root_file_id, $expiredCreate.file_id,
        $expiredCreate.content_sha256, $expiredCreate.size_bytes, [string]$expiredMarker
    )
    if ($expiredDelete.ExitCode -ne 0 -or
        (Test-Path -LiteralPath (Join-Path $expiredDeleteRoot $expiredLeaf))) {
        throw "Expired canonical retention marker did not permit handle-bound cleanup"
    }
    $expiredDeleteReceipt = ConvertFrom-ReceiptLine -Line $expiredDelete.Stdout -ExpectedMarker "CONTROLLED_ROOT_DELETE=PASS"
    if ($expiredDeleteReceipt.operation -cne "handle-disposition-cleanup-delete") {
        throw "Cleanup-delete receipt operation drifted"
    }

    $replacementLeaf = "replacement-probe.bin"
    $replacementPath = Join-Path $controlledRoot $replacementLeaf
    $ownedPath = Join-Path $controlledRoot "owned-probe.bin"
    $replacementCreateResult = Invoke-Attestor -Argument @(
        "create", $controlledRoot, $replacementLeaf, $payloadSha256, [string]$payload.Length
    ) -InputBytes $payload
    if ($replacementCreateResult.ExitCode -ne 0) {
        throw "Replacement fixture create failed"
    }
    $replacementCreate = ConvertFrom-ReceiptLine -Line $replacementCreateResult.Stdout -ExpectedMarker "CONTROLLED_ROOT_CREATE=PASS"
    Move-Item -LiteralPath $replacementPath -Destination $ownedPath
    $competitorBytes = [Text.Encoding]::UTF8.GetBytes("attacker-competitor-must-survive`n")
    [IO.File]::WriteAllBytes($replacementPath, $competitorBytes)
    Set-ExactControlledAcl -Path $replacementPath
    $replacementDelete = Invoke-Attestor -Argument @(
        "probe-delete", $controlledRoot, $replacementLeaf, $replacementCreate.volume_serial,
        $replacementCreate.root_file_id, $replacementCreate.file_id,
        $replacementCreate.content_sha256, $replacementCreate.size_bytes, [string]$retentionExpires
    )
    Assert-FailedWithoutOutput -Result $replacementDelete -Label "attacker replacement"
    if ([Convert]::ToBase64String([IO.File]::ReadAllBytes($replacementPath)) -cne
        [Convert]::ToBase64String($competitorBytes) -or -not (Test-Path -LiteralPath $ownedPath -PathType Leaf)) {
        throw "Attacker replacement or owned file did not survive rejected cleanup"
    }
    $ownedDelete = Invoke-Attestor -Argument @(
        "probe-delete", $controlledRoot, "owned-probe.bin", $replacementCreate.volume_serial,
        $replacementCreate.root_file_id, $replacementCreate.file_id,
        $replacementCreate.content_sha256, $replacementCreate.size_bytes, [string]$retentionExpires
    )
    if ($ownedDelete.ExitCode -ne 0 -or (Test-Path -LiteralPath $ownedPath)) {
        throw "Owned replacement fixture could not be cleaned by its opened handle"
    }

    $hardLinkLeaf = "hard-link-probe.bin"
    $hardLinkAlias = Join-Path $controlledRoot "hard-link-alias.bin"
    $hardLinkCreateResult = Invoke-Attestor -Argument @(
        "create", $controlledRoot, $hardLinkLeaf, $payloadSha256, [string]$payload.Length
    ) -InputBytes $payload
    if ($hardLinkCreateResult.ExitCode -ne 0) {
        throw "Hard-link fixture create failed"
    }
    $hardLinkCreate = ConvertFrom-ReceiptLine -Line $hardLinkCreateResult.Stdout -ExpectedMarker "CONTROLLED_ROOT_CREATE=PASS"
    $hardLinkCreated = $false
    try {
        New-Item -ItemType HardLink -Path $hardLinkAlias -Target (Join-Path $controlledRoot $hardLinkLeaf) -ErrorAction Stop | Out-Null
        $hardLinkCreated = $true
    }
    catch {
        if ($AllowCapabilitySkip) {
            Write-Output "CONTROLLED_ROOT_HARDLINK_TEST=SKIP capability=hard-link-create"
        }
        else {
            throw
        }
    }
    if ($hardLinkCreated) {
        $hardLinkDelete = Invoke-Attestor -Argument @(
            "probe-delete", $controlledRoot, $hardLinkLeaf, $hardLinkCreate.volume_serial,
            $hardLinkCreate.root_file_id, $hardLinkCreate.file_id,
            $hardLinkCreate.content_sha256, $hardLinkCreate.size_bytes, [string]$retentionExpires
        )
        Assert-FailedWithoutOutput -Result $hardLinkDelete -Label "hard-link cleanup"
        if (-not (Test-Path -LiteralPath (Join-Path $controlledRoot $hardLinkLeaf) -PathType Leaf) -or
            -not (Test-Path -LiteralPath $hardLinkAlias -PathType Leaf)) {
            throw "Hard-link cleanup rejection removed an alias"
        }
    }
}
finally {
    Assert-UnderTarget -Path $testRoot
    if (Test-Path -LiteralPath $testRoot) {
        Get-ChildItem -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue |
            Where-Object { ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 } |
            Sort-Object FullName -Descending |
            ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue }
        Remove-Item -LiteralPath $testRoot -Recurse -Force
    }
}

Write-Output "FORMAL_RUN_TRUST_ENVELOPE_WINDOWS_TEST=PASS"
