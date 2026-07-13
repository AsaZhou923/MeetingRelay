import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, lstatSync, realpathSync } from "node:fs";
import { lstat, open, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const HW_REF_COLLECTOR_VERSION = "meetingrelay-hw-ref-collector-v1";
export const WINDOWS_COLLECTOR_ASSET_PATH = "assets/hw-ref-collector.mjs";
export const collectorSourcePath = fileURLToPath(import.meta.url);
const MODULE_DIR = path.dirname(collectorSourcePath);
export const hwRefCollectorTargetRoot = path.resolve(MODULE_DIR, "..", "..", "target");

function canonicalizeJson(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalizeJson);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalizeJson(value[key])]),
    );
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new TypeError("canonical JSON cannot encode a non-finite number");
  }
  return typeof value === "string" ? value.normalize("NFC") : value;
}

function encodeCanonicalJson(value) {
  return `${JSON.stringify(canonicalizeJson(value), null, 2)}\n`;
}

function encodeCanonicalJsonLine(value) {
  return `${JSON.stringify(canonicalizeJson(value))}\n`;
}

const RAW_FACT_KEYS = Object.freeze([
  "audio_devices",
  "background_process_allowlist",
  "bios",
  "cooling",
  "cpu",
  "gpus",
  "memory",
  "operating_system",
  "power",
  "storage",
]);

const POWER_FINGERPRINT_SCRIPT = String.raw`
function ConvertTo-CanonicalPowerText([object[]] $Lines) {
  if ($null -eq $Lines -or $Lines.Count -lt 1) {
    throw "powercfg returned no query lines"
  }
  $normalized = @(
    $Lines | ForEach-Object {
      ([string] $_).TrimEnd().Normalize([Text.NormalizationForm]::FormC)
    }
  )
  $lf = [string] [char] 10
  return ($normalized -join $lf) + $lf
}

function Get-PowerFingerprint([string] $BaseText, [string] $EffectiveText) {
  $utf8 = [Text.UTF8Encoding]::new($false)
  $baseBytes = $utf8.GetBytes($BaseText)
  $effectiveBytes = $utf8.GetBytes($EffectiveText)
  $baseLength = $baseBytes.Length.ToString(
    [Globalization.CultureInfo]::InvariantCulture
  )
  $effectiveLength = $effectiveBytes.Length.ToString(
    [Globalization.CultureInfo]::InvariantCulture
  )
  $lf = [string] [char] 10
  $baseHeader = $utf8.GetBytes(
    "meetingrelay-power-plan-v1" + $lf + "base-bytes=$baseLength" + $lf
  )
  $effectiveHeader = $utf8.GetBytes(
    "effective-bytes=$effectiveLength" + $lf
  )
  $framed = [byte[]] (
    $baseHeader + $baseBytes + $effectiveHeader + $effectiveBytes
  )
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    $digest = $sha.ComputeHash($framed)
  } finally {
    $sha.Dispose()
  }
  return -join ($digest | ForEach-Object { $_.ToString("x2") })
}
`;

export const powerFingerprintScript = POWER_FINGERPRINT_SCRIPT;

const WINDOWS_COLLECTOR_SCRIPT = String.raw`
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

${POWER_FINGERPRINT_SCRIPT}

function Require-Text([object] $Value, [string] $Label) {
  if ($null -eq $Value -or [string]::IsNullOrWhiteSpace([string] $Value)) {
    throw "$Label was not captured"
  }
  return ([string] $Value).Trim()
}

function Require-U64([object] $Value, [string] $Label, [uint64] $Minimum = 1) {
  if ($null -eq $Value) {
    throw "$Label was not captured"
  }
  $parsed = [uint64] $Value
  if ($parsed -lt $Minimum) {
    throw "$Label is below its minimum"
  }
  return $parsed.ToString([System.Globalization.CultureInfo]::InvariantCulture)
}

$ambientCelsius = Require-Text $env:MEETINGRELAY_HW_REF_AMBIENT_CELSIUS "ambient_celsius"
if (
  $ambientCelsius -notmatch '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$' -or
  $ambientCelsius -match '^-0(?:\.0+)?$'
) {
  throw "ambient_celsius must be a canonical decimal"
}
$audioDeviceModel = Require-Text $env:MEETINGRELAY_HW_REF_AUDIO_DEVICE_MODEL "audio device model"
$audioLogicalRole = Require-Text $env:MEETINGRELAY_HW_REF_AUDIO_LOGICAL_ROLE "audio logical role"
$coolingMode = Require-Text $env:MEETINGRELAY_HW_REF_COOLING_MODE "cooling mode"
$powerSource = (Require-Text $env:MEETINGRELAY_HW_REF_POWER_SOURCE "power source").ToLowerInvariant()
if ($powerSource -notin @("ac", "battery")) {
  throw "power source must be ac or battery"
}
$gpuDeviceModel = Require-Text $env:MEETINGRELAY_HW_REF_GPU_DEVICE_MODEL "GPU device model"
$gpuVramBytes = Require-U64 $env:MEETINGRELAY_HW_REF_GPU_VRAM_BYTES "GPU VRAM"
$osArchitecture = switch ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()) {
  "X64" { "x64"; break }
  "Arm64" { "arm64"; break }
  "X86" { "x86"; break }
  default { throw "OS architecture is unsupported" }
}
$storageMedium = (Require-Text $env:MEETINGRELAY_HW_REF_STORAGE_MEDIUM "storage medium").ToLowerInvariant()
if ($storageMedium -notin @("ssd", "hdd", "emmc", "other")) {
  throw "storage medium must use a canonical operator-verified class"
}
$storageVolume = (Require-Text $env:MEETINGRELAY_HW_REF_STORAGE_VOLUME "storage volume").ToUpperInvariant()
if ($storageVolume -notmatch '^[A-Z]$') {
  throw "storage volume must be one drive letter"
}

$biosFact = Get-CimInstance -ClassName Win32_BIOS |
  Select-Object -Property Manufacturer, SMBIOSBIOSVersion, ReleaseDate -First 1
if ($null -eq $biosFact) {
  throw "BIOS facts were not captured"
}
$biosReleaseDate = if ($biosFact.ReleaseDate -is [DateTime]) {
  $biosFact.ReleaseDate.ToUniversalTime().ToString("yyyy-MM-dd", [System.Globalization.CultureInfo]::InvariantCulture)
} else {
  ([System.Management.ManagementDateTimeConverter]::ToDateTime([string] $biosFact.ReleaseDate)).ToUniversalTime().ToString("yyyy-MM-dd", [System.Globalization.CultureInfo]::InvariantCulture)
}

$processorFacts = @(
  Get-CimInstance -ClassName Win32_Processor |
    Select-Object -Property Manufacturer, Name, NumberOfCores, NumberOfLogicalProcessors
)
if ($processorFacts.Count -lt 1) {
  throw "CPU facts were not captured"
}
$physicalCores = ($processorFacts | Measure-Object -Property NumberOfCores -Sum).Sum
$logicalProcessors = ($processorFacts | Measure-Object -Property NumberOfLogicalProcessors -Sum).Sum
$cpuModels = @($processorFacts | ForEach-Object { Require-Text $_.Name "CPU model" } | Sort-Object -Unique)
$cpuVendors = @($processorFacts | ForEach-Object { Require-Text $_.Manufacturer "CPU vendor" } | Sort-Object -Unique)

$computerFact = Get-CimInstance -ClassName Win32_ComputerSystem |
  Select-Object -Property TotalPhysicalMemory -First 1
if ($null -eq $computerFact) {
  throw "memory facts were not captured"
}

$osFact = Get-CimInstance -ClassName Win32_OperatingSystem |
  Select-Object -Property BuildNumber, Caption, Version -First 1
$windowsVersion = Get-ItemProperty -LiteralPath "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion" |
  Select-Object -Property UBR
if ($null -eq $osFact -or $null -eq $windowsVersion) {
  throw "operating-system facts were not captured"
}
$allAudioFacts = @(
  Get-CimInstance -ClassName Win32_PnPSignedDriver -Filter "DeviceClass = 'MEDIA'" |
    Select-Object -Property DeviceName, Manufacturer, DriverVersion, IsSigned |
    Sort-Object -Property Manufacturer, DeviceName, DriverVersion
)
$audioFacts = @($allAudioFacts | Where-Object { $_.DeviceName -eq $audioDeviceModel })
if ($audioFacts.Count -ne 1) {
  throw "operator-selected audio device must match exactly one MEDIA device"
}
$audioDevices = @(
  foreach ($audio in $audioFacts) {
    if ($audio.IsSigned -isnot [bool]) {
      throw "audio signature status was not captured"
    }
    [ordered]@{
      driver_version = Require-Text $audio.DriverVersion "audio driver version"
      logical_role = $audioLogicalRole
      model = Require-Text $audio.DeviceName "audio model"
      signature_status = if ([bool] $audio.IsSigned) { "signed" } else { "unsigned" }
      vendor = Require-Text $audio.Manufacturer "audio vendor"
    }
  }
)

$gpuFacts = @(
  Get-CimInstance -ClassName Win32_VideoController |
    Select-Object -Property AdapterCompatibility, DriverVersion, Name |
    Where-Object { $_.Name -eq $gpuDeviceModel } |
    Sort-Object -Property AdapterCompatibility, Name, DriverVersion
)
if ($gpuFacts.Count -ne 1) {
  throw "operator-selected GPU must match exactly one video controller"
}
$gpus = @(
  foreach ($gpu in $gpuFacts) {
    $providersForGpu = [string[]] @()
    [ordered]@{
      driver_version = Require-Text $gpu.DriverVersion "GPU driver version"
      execution_providers = $providersForGpu
      model = Require-Text $gpu.Name "GPU model"
      vendor = Require-Text $gpu.AdapterCompatibility "GPU vendor"
      vram_bytes = $gpuVramBytes
    }
  }
)

$partitionFacts = @(
  Get-Partition -DriveLetter $storageVolume |
    Select-Object -Property DiskNumber, DriveLetter
)
$volumeFacts = @(
  Get-Volume -DriveLetter $storageVolume |
    Select-Object -Property DriveLetter, FileSystem
)
if ($partitionFacts.Count -ne 1 -or $volumeFacts.Count -ne 1) {
  throw "operator-selected storage volume must map to one partition and volume"
}
$diskNumber = [uint32] $partitionFacts[0].DiskNumber
$diskFacts = @(
  Get-CimInstance -ClassName Win32_DiskDrive |
    Select-Object -Property Index, Manufacturer, Model, PNPDeviceID, Size |
    Where-Object { $_.Index -eq $diskNumber }
)
if ($diskFacts.Count -ne 1) {
  throw "storage volume must associate with one physical disk"
}
$disk = $diskFacts[0]
$diskDriverFacts = @(
  Get-CimInstance -ClassName Win32_PnPSignedDriver -Filter "DeviceClass = 'DISKDRIVE'" |
    Select-Object -Property DeviceID, DriverVersion, IsSigned, Manufacturer |
    Where-Object { $_.DeviceID -eq $disk.PNPDeviceID }
)
if ($diskDriverFacts.Count -ne 1) {
  throw "physical disk must associate with one signed-driver record"
}
$driver = $diskDriverFacts[0]
if ($driver.IsSigned -isnot [bool] -or -not [bool] $driver.IsSigned) {
  throw "physical disk driver must report a signed status"
}
$vendor = if ($null -ne $disk.Manufacturer -and -not [string]::IsNullOrWhiteSpace([string] $disk.Manufacturer)) {
  ([string] $disk.Manufacturer).Trim()
} else {
  Require-Text $driver.Manufacturer "storage vendor"
}
$storage = @(
  [ordered]@{
    capacity_bytes = Require-U64 $disk.Size "storage capacity"
    driver_version = Require-Text $driver.DriverVersion "storage driver version"
    filesystem = Require-Text $volumeFacts[0].FileSystem "storage filesystem"
    medium = $storageMedium
    model = Require-Text $disk.Model "storage model"
    vendor = $vendor
  }
)

$powerCfgPath = Join-Path ([Environment]::SystemDirectory) "powercfg.exe"
function Invoke-PowerCfg([string] $Phase, [string[]] $Arguments) {
  $global:LASTEXITCODE = 0
  $output = @(& $powerCfgPath @Arguments)
  $exitCode = $global:LASTEXITCODE
  if ($exitCode -ne 0 -or $output.Count -lt 1) {
    throw "powercfg $Phase query failed"
  }
  return $output
}

function Get-ActivePowerGuid([string] $Phase) {
  $text = ConvertTo-CanonicalPowerText @(
    Invoke-PowerCfg $Phase @("/GETACTIVESCHEME")
  )
  $match = [regex]::Match(
    $text,
    '(?<guid>[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12})'
  )
  if (-not $match.Success) {
    throw "active power plan was not captured"
  }
  return $match.Groups["guid"].Value.ToLowerInvariant()
}

$activePowerGuidBefore = Get-ActivePowerGuid "active-before"
$powerPlanAlias = switch ($activePowerGuidBefore) {
  "381b4222-f694-41f0-9685-ff5bb260df2e" { "balanced"; break }
  "8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c" { "high-performance"; break }
  "e9a42b02-d5df-448d-aa00-03f14749eb61" { "ultimate-performance"; break }
  "a1841308-3541-4fab-bc81-f71556f20b4a" { "power-saver"; break }
  default { throw "custom base power plans are unsupported by this collector version" }
}
$basePowerBefore = ConvertTo-CanonicalPowerText @(
  Invoke-PowerCfg "base-before" @("/Q", $activePowerGuidBefore)
)
$effectivePowerBefore = ConvertTo-CanonicalPowerText @(
  Invoke-PowerCfg "effective-before" @("/Q")
)
$basePowerAfter = ConvertTo-CanonicalPowerText @(
  Invoke-PowerCfg "base-after" @("/Q", $activePowerGuidBefore)
)
$effectivePowerAfter = ConvertTo-CanonicalPowerText @(
  Invoke-PowerCfg "effective-after" @("/Q")
)
$activePowerGuidAfter = Get-ActivePowerGuid "active-after"
if (
  $activePowerGuidAfter -ne $activePowerGuidBefore -or
  $basePowerAfter -cne $basePowerBefore -or
  $effectivePowerAfter -cne $effectivePowerBefore
) {
  throw "power settings changed during capture"
}
$powerPlanDigest = Get-PowerFingerprint $basePowerBefore $effectivePowerBefore
$powerPlan = "$powerPlanAlias@$powerPlanDigest"
$result = [ordered]@{
  audio_devices = $audioDevices
  background_process_allowlist = @()
  bios = [ordered]@{
    release_date = $biosReleaseDate
    vendor = Require-Text $biosFact.Manufacturer "BIOS vendor"
    version = Require-Text $biosFact.SMBIOSBIOSVersion "BIOS version"
  }
  cooling = [ordered]@{
    ambient_celsius = $ambientCelsius
    mode = $coolingMode
  }
  cpu = [ordered]@{
    logical_processor_count = Require-U64 $logicalProcessors "logical processor count"
    model = $cpuModels -join "+"
    physical_core_count = Require-U64 $physicalCores "physical core count"
    vendor = $cpuVendors -join "+"
  }
  gpus = $gpus
  memory = [ordered]@{
    total_bytes = Require-U64 $computerFact.TotalPhysicalMemory "total memory"
  }
  operating_system = [ordered]@{
    architecture = $osArchitecture
    build = Require-Text $osFact.BuildNumber "OS build"
    product = Require-Text $osFact.Caption "OS product"
    ubr = Require-U64 $windowsVersion.UBR "OS UBR" 0
    version = Require-Text $osFact.Version "OS version"
  }
  power = [ordered]@{
    plan = $powerPlan
    source = $powerSource
  }
  storage = $storage
}

$result | ConvertTo-Json -Depth 8 -Compress
`;

export const windowsCollectorScript = WINDOWS_COLLECTOR_SCRIPT;

export class HwRefCollectorError extends Error {
  constructor(code, message, field = null) {
    super(message);
    this.name = "HwRefCollectorError";
    this.code = code;
    this.field = field;
  }
}

function fail(code, message, field = null) {
  throw new HwRefCollectorError(code, message, field);
}

function assertExactKeys(value, expected, label, code = "HW_REF_RAW_SCHEMA_KEYS") {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("HW_REF_RAW_SCHEMA_TYPE", `${label} must be an object`, label);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    fail(code, `${label} keys differ: ${actual.join(",")}`, label);
  }
}

function assertPrivacySafe(value, label = "rawFacts") {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertPrivacySafe(entry, `${label}[${index}]`));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (
        /^(?:host_?name|computer_?name|user_?name|machine_?guid|serial(?:_?number)?|uuid|mac(?:_?address)?|device_?instance(?:_?id)?|pnp_?device_?id|hardware_?id|endpoint_?id|email|local_?path|sid)$/i.test(
          key,
        )
      ) {
        fail(
          "HW_REF_PRIVACY_UNSAFE",
          `${label} contains forbidden key ${key}`,
          `${label}.${key}`,
        );
      }
      assertPrivacySafe(entry, `${label}.${key}`);
    }
    return;
  }
  if (
    typeof value === "string" &&
    (/[A-Za-z]:[\\/]/.test(value) ||
      /^(?:\\\\|\/\/)/.test(value) ||
      /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/.test(value) ||
      /\b(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}\b/i.test(value) ||
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i.test(
        value,
      ) ||
      /\b(?:PCI|HDAUDIO|USB(?:STOR|PRINT)?|BTHENUM|BTH|HID|DISPLAY|SCSI|STORAGE|SWD|ROOT|ACPI)\\[A-Z0-9_&.\\-]+/i.test(value) ||
      /\bS-\d(?:-\d+){2,}\b/i.test(value))
  ) {
    fail(
      "HW_REF_PRIVACY_UNSAFE",
      `${label} contains a stable or local identifier`,
      label,
    );
  }
}

function assertRawFactsShape(rawFacts) {
  assertPrivacySafe(rawFacts);
  assertExactKeys(rawFacts, RAW_FACT_KEYS, "rawFacts");
  assertExactKeys(
    rawFacts.bios,
    ["release_date", "vendor", "version"],
    "rawFacts.bios",
  );
  assertExactKeys(
    rawFacts.cooling,
    ["ambient_celsius", "mode"],
    "rawFacts.cooling",
  );
  assertExactKeys(
    rawFacts.cpu,
    ["logical_processor_count", "model", "physical_core_count", "vendor"],
    "rawFacts.cpu",
  );
  assertExactKeys(rawFacts.memory, ["total_bytes"], "rawFacts.memory");
  assertExactKeys(
    rawFacts.operating_system,
    ["architecture", "build", "product", "ubr", "version"],
    "rawFacts.operating_system",
  );
  assertExactKeys(rawFacts.power, ["plan", "source"], "rawFacts.power");
  for (const [index, device] of Object.entries(rawFacts.audio_devices ?? [])) {
    assertExactKeys(
      device,
      ["driver_version", "logical_role", "model", "signature_status", "vendor"],
      `rawFacts.audio_devices[${index}]`,
    );
  }
  for (const [index, gpu] of Object.entries(rawFacts.gpus ?? [])) {
    assertExactKeys(
      gpu,
      ["driver_version", "execution_providers", "model", "vendor", "vram_bytes"],
      `rawFacts.gpus[${index}]`,
    );
  }
  for (const [index, storage] of Object.entries(rawFacts.storage ?? [])) {
    assertExactKeys(
      storage,
      ["capacity_bytes", "driver_version", "filesystem", "medium", "model", "vendor"],
      `rawFacts.storage[${index}]`,
    );
  }
}

function sortObjects(values) {
  return [...values].sort((left, right) => {
    const leftBytes = JSON.stringify(left);
    const rightBytes = JSON.stringify(right);
    return leftBytes < rightBytes ? -1 : leftBytes > rightBytes ? 1 : 0;
  });
}

function normalizeRawFacts(rawFacts) {
  const normalized = canonicalizeJson(rawFacts);
  normalized.background_process_allowlist = [
    ...normalized.background_process_allowlist,
  ].sort();
  normalized.audio_devices = sortObjects(normalized.audio_devices);
  normalized.gpus = sortObjects(
    normalized.gpus.map((gpu) => ({
      ...gpu,
      execution_providers: [...gpu.execution_providers].sort(),
    })),
  );
  normalized.storage = sortObjects(normalized.storage);
  return normalized;
}

function validateOperatorOptions(options) {
  assertExactKeys(
    options,
    [
      "ambientCelsius",
      "audioDeviceModel",
      "audioLogicalRole",
      "coolingMode",
      "gpuDeviceModel",
      "gpuVramBytes",
      "powerSource",
      "storageMedium",
      "storageVolume",
    ],
    "operatorOptions",
    "HW_REF_OPERATOR_INPUT",
  );
  if (
    typeof options.ambientCelsius !== "string" ||
    !/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(options.ambientCelsius) ||
    /^-0(?:\.0+)?$/.test(options.ambientCelsius) ||
    typeof options.audioDeviceModel !== "string" ||
    options.audioDeviceModel.trim().length === 0 ||
    typeof options.audioLogicalRole !== "string" ||
    options.audioLogicalRole.trim().length === 0 ||
    typeof options.coolingMode !== "string" ||
    options.coolingMode.trim().length === 0 ||
    typeof options.gpuDeviceModel !== "string" ||
    options.gpuDeviceModel.trim().length === 0 ||
    typeof options.gpuVramBytes !== "string" ||
    !/^(?:[1-9][0-9]*)$/.test(options.gpuVramBytes) ||
    BigInt(options.gpuVramBytes) > (1n << 64n) - 1n ||
    !["ac", "battery"].includes(options.powerSource) ||
    !["ssd", "hdd", "emmc", "other"].includes(options.storageMedium) ||
    typeof options.storageVolume !== "string" ||
    !/^[A-Za-z]$/.test(options.storageVolume)
  ) {
    fail(
      "HW_REF_OPERATOR_INPUT",
      "ambient, cooling, device selection, VRAM, power, and storage facts are required",
      "operatorOptions",
    );
  }
}

function validateWindowsSelections(rawFacts, options) {
  if (
    rawFacts.audio_devices.length !== 1 ||
    rawFacts.audio_devices[0].model !== options.audioDeviceModel ||
    rawFacts.audio_devices[0].logical_role !== options.audioLogicalRole ||
    rawFacts.storage.length !== 1 ||
    rawFacts.gpus.length !== 1 ||
    rawFacts.gpus[0].model !== options.gpuDeviceModel ||
    rawFacts.gpus[0].vram_bytes !== options.gpuVramBytes ||
    rawFacts.gpus[0].execution_providers.length !== 0 ||
    rawFacts.power.source !== options.powerSource ||
    rawFacts.storage[0].medium !== options.storageMedium ||
    rawFacts.cooling.ambient_celsius !== options.ambientCelsius ||
    rawFacts.cooling.mode !== options.coolingMode
  ) {
    fail(
      "HW_REF_WINDOWS_OUTPUT",
      "Windows facts do not match the explicit benchmark selections",
    );
  }
}

function resolveTrustedWindowsFile(systemRoot, relativeParts, label) {
  if (typeof systemRoot !== "string" || !path.isAbsolute(systemRoot)) {
    fail("HW_REF_WINDOWS_RUNTIME", "SystemRoot must be an absolute Windows path");
  }
  const candidatePath = path.join(systemRoot, ...relativeParts);
  let status;
  let resolved;
  try {
    status = lstatSync(candidatePath);
    resolved = realpathSync(candidatePath);
  } catch {
    fail("HW_REF_WINDOWS_RUNTIME", `trusted system ${label} was not found`);
  }
  if (!status.isFile() || status.isSymbolicLink() || !samePath(candidatePath, resolved)) {
    fail("HW_REF_WINDOWS_RUNTIME", `trusted system ${label} path is reparse-backed`);
  }
  return resolved;
}

export function resolveSystemPowerShellPath(systemRoot = process.env.SystemRoot) {
  return resolveTrustedWindowsFile(
    systemRoot,
    ["System32", "WindowsPowerShell", "v1.0", "powershell.exe"],
    "PowerShell",
  );
}

function buildWindowsCollectorEnvironment(
  environment,
  powershellHome,
  systemDirectory,
  commandProcessor,
  operatorValues,
) {
  const childEnvironment = {};
  for (const [key, value] of Object.entries(environment)) {
    const normalized = key.toUpperCase();
    if (
      normalized === "PATH" ||
      normalized === "PSMODULEPATH" ||
      normalized === "COMSPEC" ||
      normalized === "SYSTEMROOT" ||
      normalized === "WINDIR" ||
      normalized.startsWith("MEETINGRELAY_HW_REF_")
    ) {
      continue;
    }
    childEnvironment[key] = value;
  }
  return {
    ...childEnvironment,
    PATH: systemDirectory,
    PSModulePath: path.join(powershellHome, "Modules"),
    ComSpec: commandProcessor,
    SystemRoot: environment.SystemRoot,
    windir: environment.SystemRoot,
    ...operatorValues,
  };
}

export function collectWindowsRawFacts(
  options,
  {
    environment = process.env,
    platform = process.platform,
    resolvePowerShell = resolveSystemPowerShellPath,
    spawn = spawnSync,
  } = {},
) {
  validateOperatorOptions(options);
  if (platform !== "win32") {
    fail("HW_REF_PLATFORM", "the measured HW-REF collector supports Windows only");
  }
  const powershellPath = resolvePowerShell(environment.SystemRoot);
  const systemDirectory = path.join(environment.SystemRoot, "System32");
  const powershellHome = path.dirname(powershellPath);
  const commandProcessor = resolveTrustedWindowsFile(
    environment.SystemRoot,
    ["System32", "cmd.exe"],
    "command processor",
  );
  resolveTrustedWindowsFile(
    environment.SystemRoot,
    ["System32", "powercfg.exe"],
    "powercfg",
  );
  const childEnvironment = buildWindowsCollectorEnvironment(
    environment,
    powershellHome,
    systemDirectory,
    commandProcessor,
    {
      MEETINGRELAY_HW_REF_AMBIENT_CELSIUS: options.ambientCelsius,
      MEETINGRELAY_HW_REF_AUDIO_DEVICE_MODEL: options.audioDeviceModel,
      MEETINGRELAY_HW_REF_AUDIO_LOGICAL_ROLE: options.audioLogicalRole,
      MEETINGRELAY_HW_REF_COOLING_MODE: options.coolingMode,
      MEETINGRELAY_HW_REF_GPU_DEVICE_MODEL: options.gpuDeviceModel,
      MEETINGRELAY_HW_REF_GPU_VRAM_BYTES: options.gpuVramBytes,
      MEETINGRELAY_HW_REF_POWER_SOURCE: options.powerSource,
      MEETINGRELAY_HW_REF_STORAGE_MEDIUM: options.storageMedium,
      MEETINGRELAY_HW_REF_STORAGE_VOLUME: options.storageVolume.toUpperCase(),
    },
  );
  const result = spawn(
    powershellPath,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      WINDOWS_COLLECTOR_SCRIPT,
    ],
    {
      encoding: "utf8",
      env: childEnvironment,
      maxBuffer: 1024 * 1024,
      shell: false,
      timeout: 60_000,
      windowsHide: true,
    },
  );
  if (result.error || result.status !== 0) {
    fail(
      "HW_REF_WINDOWS_COLLECTION",
      `Windows hardware collection failed with status ${result.status ?? "spawn-error"}`,
    );
  }
  let rawFacts;
  try {
    rawFacts = JSON.parse(result.stdout);
  } catch {
    fail("HW_REF_WINDOWS_OUTPUT", "Windows hardware collection returned invalid JSON");
  }
  try {
    assertRawFactsShape(rawFacts);
    validateWindowsSelections(rawFacts, options);
  } catch (error) {
    if (error instanceof HwRefCollectorError) {
      throw error;
    }
    fail("HW_REF_WINDOWS_OUTPUT", "Windows hardware collection returned invalid facts");
  }
  return normalizeRawFacts(rawFacts);
}

function assertCapturedText(value, label) {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    /(?:not-measured|contract-fixture|not-applicable)/i.test(value)
  ) {
    fail("HW_REF_SCHEMA_VALUE", `${label} must be a captured text value`, label);
  }
}

function assertCanonicalU64(value, label, minimum = 1n) {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    fail("HW_REF_SCHEMA_U64", `${label} must be a canonical uint64 string`, label);
  }
  const parsed = BigInt(value);
  if (parsed < minimum || parsed > (1n << 64n) - 1n) {
    fail("HW_REF_SCHEMA_BOUND", `${label} is outside uint64 bounds`, label);
  }
}

export function validateCollectedHardwareReference(hardwareReference) {
  assertPrivacySafe(hardwareReference, "hwRef");
  assertExactKeys(
    hardwareReference,
    [
      "capture_scope",
      "captured_at",
      "claims",
      "collector",
      "environment",
      "hardware_tier",
      "hw_ref_id",
      "measurement_status",
      "privacy_class",
      "privacy_policy",
      "schema_version",
    ],
    "hwRef",
  );
  if (
    hardwareReference.capture_scope !== "measured" ||
    hardwareReference.measurement_status !== "captured" ||
    hardwareReference.hardware_tier !== "HW-REF" ||
    hardwareReference.privacy_class !== "internal-benchmark-metadata" ||
    hardwareReference.privacy_policy !== "no-stable-device-identifiers-v1" ||
    hardwareReference.schema_version !== "1.0" ||
    typeof hardwareReference.captured_at !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(
      hardwareReference.captured_at,
    ) ||
    typeof hardwareReference.hw_ref_id !== "string" ||
    !/^[A-Za-z0-9._-]{1,128}$/.test(hardwareReference.hw_ref_id)
  ) {
    fail("HW_REF_SCHEMA_VALUE", "HW-REF identity or measured status differs");
  }
  assertExactKeys(
    hardwareReference.claims,
    [
      "formal_claims",
      "formal_metric_ids",
      "production_claims",
      "production_evidence",
      "slo_claims",
    ],
    "hwRef.claims",
  );
  if (
    hardwareReference.claims.formal_claims !== "none" ||
    hardwareReference.claims.production_evidence !== false ||
    !Array.isArray(hardwareReference.claims.formal_metric_ids) ||
    hardwareReference.claims.formal_metric_ids.length !== 0 ||
    !Array.isArray(hardwareReference.claims.production_claims) ||
    hardwareReference.claims.production_claims.length !== 0 ||
    !Array.isArray(hardwareReference.claims.slo_claims) ||
    hardwareReference.claims.slo_claims.length !== 0
  ) {
    fail("HW_REF_CLAIM_UNSUPPORTED", "collector cannot create formal claims");
  }
  assertExactKeys(
    hardwareReference.collector,
    ["path", "sha256", "version"],
    "hwRef.collector",
  );
  if (
    hardwareReference.collector.path !== WINDOWS_COLLECTOR_ASSET_PATH ||
    hardwareReference.collector.version !== HW_REF_COLLECTOR_VERSION ||
    typeof hardwareReference.collector.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(hardwareReference.collector.sha256) ||
    hardwareReference.collector.sha256 === "0".repeat(64)
  ) {
    fail("HW_REF_SCHEMA_VALUE", "collector provenance differs");
  }
  const environment = hardwareReference.environment;
  assertRawFactsShape(environment);
  if (
    !Array.isArray(environment.audio_devices) ||
    environment.audio_devices.length !== 1 ||
    !Array.isArray(environment.gpus) ||
    environment.gpus.length !== 1 ||
    !Array.isArray(environment.storage) ||
    environment.storage.length !== 1 ||
    !Array.isArray(environment.background_process_allowlist) ||
    environment.background_process_allowlist.some(
      (value) => typeof value !== "string" || value.length === 0,
    ) ||
    !Array.isArray(environment.gpus[0].execution_providers) ||
    environment.gpus[0].execution_providers.length !== 0
  ) {
    fail("HW_REF_SCHEMA_VALUE", "collector HW-REF device cardinality differs");
  }
  const textValues = [
    environment.bios.vendor,
    environment.bios.version,
    environment.cooling.mode,
    environment.cpu.model,
    environment.cpu.vendor,
    environment.operating_system.architecture,
    environment.operating_system.build,
    environment.operating_system.product,
    environment.operating_system.version,
    environment.power.plan,
    environment.power.source,
    ...environment.audio_devices.flatMap((device) => [
      device.driver_version,
      device.logical_role,
      device.model,
      device.signature_status,
      device.vendor,
    ]),
    ...environment.gpus.flatMap((gpu) => [
      gpu.driver_version,
      gpu.model,
      gpu.vendor,
    ]),
    ...environment.storage.flatMap((storage) => [
      storage.driver_version,
      storage.filesystem,
      storage.medium,
      storage.model,
      storage.vendor,
    ]),
  ];
  textValues.forEach((value, index) => assertCapturedText(value, `hwRef.text[${index}]`));
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(environment.bios.release_date) ||
    !/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(
      environment.cooling.ambient_celsius,
    ) ||
    /^-0(?:\.0+)?$/.test(environment.cooling.ambient_celsius) ||
    !["ac", "battery"].includes(environment.power.source) ||
    !/^(?:balanced|high-performance|ultimate-performance|power-saver)@[0-9a-f]{64}$/.test(
      environment.power.plan,
    ) ||
    !["ssd", "hdd", "emmc", "other"].includes(environment.storage[0].medium) ||
    !["signed", "unsigned"].includes(environment.audio_devices[0].signature_status) ||
    !["x64", "arm64", "x86"].includes(environment.operating_system.architecture)
  ) {
    fail("HW_REF_SCHEMA_VALUE", "collector HW-REF measured values differ");
  }
  assertCanonicalU64(environment.cpu.logical_processor_count, "logical processors");
  assertCanonicalU64(environment.cpu.physical_core_count, "physical cores");
  assertCanonicalU64(environment.memory.total_bytes, "memory bytes");
  assertCanonicalU64(environment.gpus[0].vram_bytes, "GPU VRAM bytes");
  assertCanonicalU64(environment.storage[0].capacity_bytes, "storage bytes");
  assertCanonicalU64(environment.operating_system.ubr, "OS UBR", 0n);
  return {
    hwRefId: hardwareReference.hw_ref_id,
    sealed: false,
    validationPhase: "collector-only",
  };
}

export function buildMeasuredHardwareReference(input) {
  assertExactKeys(
    input,
    ["capturedAt", "collector", "hwRefId", "rawFacts"],
    "collectorInput",
    "HW_REF_RAW_SCHEMA_KEYS",
  );
  assertExactKeys(
    input.collector,
    ["path", "sha256", "version"],
    "collectorInput.collector",
    "HW_REF_RAW_SCHEMA_KEYS",
  );
  assertRawFactsShape(input.rawFacts);
  const hardwareReference = canonicalizeJson({
    capture_scope: "measured",
    captured_at: input.capturedAt,
    claims: {
      formal_claims: "none",
      formal_metric_ids: [],
      production_claims: [],
      production_evidence: false,
      slo_claims: [],
    },
    collector: input.collector,
    environment: normalizeRawFacts(input.rawFacts),
    hardware_tier: "HW-REF",
    hw_ref_id: input.hwRefId,
    measurement_status: "captured",
    privacy_class: "internal-benchmark-metadata",
    privacy_policy: "no-stable-device-identifiers-v1",
    schema_version: "1.0",
  });
  validateCollectedHardwareReference(hardwareReference);
  return hardwareReference;
}

export function encodeCollectedHardwareReference(hardwareReference) {
  validateCollectedHardwareReference(hardwareReference);
  return encodeCanonicalJson(hardwareReference);
}

const CLI_FLAGS = Object.freeze({
  "--ambient-celsius": "ambientCelsius",
  "--audio-device-model": "audioDeviceModel",
  "--audio-logical-role": "audioLogicalRole",
  "--cooling-mode": "coolingMode",
  "--gpu-device-model": "gpuDeviceModel",
  "--gpu-vram-bytes": "gpuVramBytes",
  "--hw-ref-id": "hwRefId",
  "--output": "outputPath",
  "--power-source": "powerSource",
  "--storage-medium": "storageMedium",
  "--storage-volume": "storageVolume",
});

function parseArgs(argv) {
  if (!Array.isArray(argv) || argv.length % 2 !== 0) {
    fail("HW_REF_CLI_ARGUMENT", "collector arguments must be flag/value pairs");
  }
  const parsed = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const key = CLI_FLAGS[flag];
    if (!key || Object.hasOwn(parsed, key)) {
      fail("HW_REF_CLI_ARGUMENT", `unknown or duplicate collector flag: ${flag}`);
    }
    const value = argv[index + 1];
    if (typeof value !== "string" || value.length === 0) {
      fail("HW_REF_CLI_ARGUMENT", `collector flag ${flag} requires a value`);
    }
    parsed[key] = value;
  }
  if (Object.values(CLI_FLAGS).some((key) => !Object.hasOwn(parsed, key))) {
    fail("HW_REF_CLI_ARGUMENT", "all measured HW-REF collector flags are required");
  }
  parsed.powerSource = parsed.powerSource.toLowerCase();
  parsed.storageMedium = parsed.storageMedium.toLowerCase();
  return parsed;
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  const stream = createReadStream(filePath, { highWaterMark: 64 * 1024 });
  for await (const chunk of stream) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

function samePath(left, right) {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

async function assertSafeOutputPath(outputPath) {
  const resolvedOutput = path.resolve(outputPath);
  const relative = path.relative(hwRefCollectorTargetRoot, resolvedOutput);
  if (
    relative.length === 0 ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative) ||
    relative.includes(":") ||
    !/^[A-Za-z0-9._-]+\.json$/i.test(path.basename(resolvedOutput)) ||
    /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(
      path.basename(resolvedOutput),
    )
  ) {
    fail("HW_REF_OUTPUT_PATH", "collector output must be a file below repository target");
  }
  const outputParent = path.dirname(resolvedOutput);
  const parentRelative = path.relative(hwRefCollectorTargetRoot, outputParent);
  const components = [
    hwRefCollectorTargetRoot,
    ...parentRelative
      .split(path.sep)
      .filter((component) => component.length > 0)
      .map((_, index, all) =>
        path.join(hwRefCollectorTargetRoot, ...all.slice(0, index + 1)),
      ),
  ];
  for (const component of components) {
    let status;
    let resolvedComponent;
    try {
      status = await lstat(component);
      resolvedComponent = await realpath(component);
    } catch {
      fail("HW_REF_OUTPUT_PATH", "collector output parent must already exist");
    }
    if (
      !status.isDirectory() ||
      status.isSymbolicLink() ||
      !samePath(component, resolvedComponent)
    ) {
      fail("HW_REF_OUTPUT_REPARSE", "collector output path cannot cross a reparse point");
    }
  }
  return resolvedOutput;
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function assertReservedOutput(outputPath, openedStatus) {
  let currentStatus;
  try {
    currentStatus = await lstat(outputPath, { bigint: true });
  } catch {
    fail("HW_REF_OUTPUT_REPARSE", "reserved collector output disappeared");
  }
  if (
    currentStatus.isSymbolicLink() ||
    !currentStatus.isFile() ||
    !sameFileIdentity(currentStatus, openedStatus)
  ) {
    fail("HW_REF_OUTPUT_REPARSE", "reserved collector output identity changed");
  }
}

async function runCheckpoint(hooks, name, context) {
  const hook = hooks[name];
  if (hook !== undefined) {
    await hook(Object.freeze({ ...context }));
  }
}

async function cleanupReservedOutput(outputPath, openedStatus, hooks) {
  try {
    await assertSafeOutputPath(outputPath);
    await assertReservedOutput(outputPath, openedStatus);
    await runCheckpoint(hooks, "beforeFailureUnlink", { outputPath });
    await assertSafeOutputPath(outputPath);
    await assertReservedOutput(outputPath, openedStatus);
    await unlink(outputPath);
  } catch (error) {
    if (error instanceof HwRefCollectorError) {
      throw error;
    }
    fail(
      "HW_REF_OUTPUT_CLEANUP",
      "failed collector output could not be safely removed",
    );
  }
}

const PRODUCTION_HOOKS = Object.freeze({});

async function writeOutput(outputHandle, bytes) {
  await outputHandle.writeFile(bytes, { encoding: "utf8" });
}

async function syncOutput(outputHandle) {
  await outputHandle.sync();
}

async function closeOutput(outputHandle) {
  await outputHandle.close();
}

const PRODUCTION_CLI_DEPENDENCIES = Object.freeze({
  closeOutput,
  hooks: PRODUCTION_HOOKS,
  syncOutput,
  writeOutput,
});

async function runHwRefCollectorCliCore(
  {
    argv = process.argv.slice(2),
    collectRawFacts = collectWindowsRawFacts,
    digestSource = () => sha256File(collectorSourcePath),
    now = () => new Date(),
    stdout = process.stdout,
  } = {},
  { closeOutput, hooks, syncOutput, writeOutput },
) {
  const parsed = parseArgs(argv);
  const outputPath = await assertSafeOutputPath(parsed.outputPath);
  let outputHandle;
  try {
    outputHandle = await open(outputPath, "wx");
  } catch {
    fail("HW_REF_OUTPUT_CREATE", "collector output must not already exist");
  }
  let openedStatus;
  try {
    openedStatus = await outputHandle.stat({ bigint: true });
  } catch (error) {
    await outputHandle.close().catch(() => {});
    throw error;
  }
  let persisted = false;
  try {
    const collectorSha256 = await digestSource();
    const rawFacts = await collectRawFacts({
      ambientCelsius: parsed.ambientCelsius,
      audioDeviceModel: parsed.audioDeviceModel,
      audioLogicalRole: parsed.audioLogicalRole,
      coolingMode: parsed.coolingMode,
      gpuDeviceModel: parsed.gpuDeviceModel,
      gpuVramBytes: parsed.gpuVramBytes,
      powerSource: parsed.powerSource,
      storageMedium: parsed.storageMedium,
      storageVolume: parsed.storageVolume,
    });
    const hardwareReference = buildMeasuredHardwareReference({
      capturedAt: now().toISOString(),
      collector: {
        path: WINDOWS_COLLECTOR_ASSET_PATH,
        sha256: collectorSha256,
        version: HW_REF_COLLECTOR_VERSION,
      },
      hwRefId: parsed.hwRefId,
      rawFacts,
    });
    if ((await digestSource()) !== collectorSha256) {
      fail("HW_REF_COLLECTOR_DRIFT", "collector source changed during collection");
    }
    const postCollectionOutputPath = await assertSafeOutputPath(parsed.outputPath);
    if (!samePath(postCollectionOutputPath, outputPath)) {
      fail("HW_REF_OUTPUT_REPARSE", "collector output path changed during collection");
    }
    await assertReservedOutput(outputPath, openedStatus);
    await writeOutput(
      outputHandle,
      encodeCollectedHardwareReference(hardwareReference),
    );
    await syncOutput(outputHandle);
    await closeOutput(outputHandle);
    outputHandle = undefined;
    persisted = true;
    const summary = validateCollectedHardwareReference(hardwareReference);
    stdout.write(encodeCanonicalJsonLine(summary));
    return summary;
  } catch (error) {
    let cleanupError;
    if (!persisted) {
      try {
        await cleanupReservedOutput(outputPath, openedStatus, hooks);
      } catch (failure) {
        cleanupError = failure;
      }
    }
    if (outputHandle) {
      await outputHandle.close().catch(() => {});
    }
    if (cleanupError) {
      throw cleanupError;
    }
    throw error;
  }
}

export async function runHwRefCollectorCli(input = undefined) {
  return runHwRefCollectorCliCore(input, PRODUCTION_CLI_DEPENDENCIES);
}

export async function __runHwRefCollectorCliForTest(
  input,
  {
    closeOutput = PRODUCTION_CLI_DEPENDENCIES.closeOutput,
    hooks = PRODUCTION_HOOKS,
    syncOutput = PRODUCTION_CLI_DEPENDENCIES.syncOutput,
    writeOutput = PRODUCTION_CLI_DEPENDENCIES.writeOutput,
  } = {},
) {
  return runHwRefCollectorCliCore(input, {
    closeOutput,
    hooks,
    syncOutput,
    writeOutput,
  });
}

const isMain =
  typeof process.argv[1] === "string" &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  try {
    await runHwRefCollectorCli();
  } catch (error) {
    const code = typeof error?.code === "string" ? error.code : "HW_REF_COLLECTOR_FAILED";
    const message = error instanceof Error ? error.message : "collector failed";
    process.stderr.write(`${code}: ${message}\n`);
    process.exitCode = 1;
  }
}
