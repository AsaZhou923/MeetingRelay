import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  generateCandidateArtifactBundle,
  validateCollectorOnlyMeasuredHardwareReference,
  Wp04ArtifactContractError,
} from "./candidate-artifact-contract.mjs";
import {
  buildMeasuredHardwareReference,
  collectorSourcePath,
  collectWindowsRawFacts,
  encodeCollectedHardwareReference,
  HW_REF_COLLECTOR_VERSION,
  hwRefCollectorTargetRoot,
  HwRefCollectorError,
  powerFingerprintScript,
  resolveSystemPowerShellPath,
  runHwRefCollectorCli,
  validateCollectedHardwareReference,
  WINDOWS_COLLECTOR_ASSET_PATH,
  windowsCollectorScript,
} from "./hw-ref-collector.mjs";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function rawFacts() {
  return {
    audio_devices: [
      {
        driver_version: "10.0.26100.1",
        logical_role: "benchmark-audio-path",
        model: "Fixture Audio",
        signature_status: "signed",
        vendor: "FixtureVendor",
      },
    ],
    background_process_allowlist: [],
    bios: {
      release_date: "2026-01-01",
      vendor: "FixtureVendor",
      version: "1.0.0",
    },
    cooling: {
      ambient_celsius: "23.5",
      mode: "active",
    },
    cpu: {
      logical_processor_count: "16",
      model: "Fixture CPU",
      physical_core_count: "8",
      vendor: "FixtureVendor",
    },
    gpus: [
      {
        driver_version: "32.0.15.7283",
        execution_providers: [],
        model: "Fixture GPU",
        vendor: "FixtureVendor",
        vram_bytes: "8589934592",
      },
    ],
    memory: {
      total_bytes: "34359738368",
    },
    operating_system: {
      architecture: "x64",
      build: "26100",
      product: "Windows 11 Pro",
      ubr: "4652",
      version: "24H2",
    },
    power: {
      plan: `balanced@${"a".repeat(64)}`,
      source: "ac",
    },
    storage: [
      {
        capacity_bytes: "1000202273280",
        driver_version: "10.0.26100.1",
        filesystem: "NTFS",
        medium: "ssd",
        model: "Fixture Storage",
        vendor: "FixtureVendor",
      },
    ],
  };
}

function collectionInput(overrides = {}) {
  return {
    capturedAt: "2026-07-12T01:02:03.456Z",
    collector: {
      path: WINDOWS_COLLECTOR_ASSET_PATH,
      sha256: "a".repeat(64),
      version: HW_REF_COLLECTOR_VERSION,
    },
    hwRefId: "hw-ref-benchmark-001",
    rawFacts: rawFacts(),
    ...overrides,
  };
}

function validCliArgs(outputPath) {
  return [
    "--ambient-celsius",
    "23.5",
    "--audio-device-model",
    "Fixture Audio",
    "--audio-logical-role",
    "benchmark-audio-path",
    "--cooling-mode",
    "active",
    "--gpu-device-model",
    "Fixture GPU",
    "--gpu-vram-bytes",
    "8589934592",
    "--hw-ref-id",
    "hw-ref-benchmark-001",
    "--output",
    outputPath,
    "--power-source",
    "ac",
    "--storage-medium",
    "ssd",
    "--storage-volume",
    "E",
  ];
}

function windowsOperatorFacts() {
  return {
    ambientCelsius: "23.5",
    audioDeviceModel: "Fixture Audio",
    audioLogicalRole: "benchmark-audio-path",
    coolingMode: "active",
    gpuDeviceModel: "Fixture GPU",
    gpuVramBytes: "8589934592",
    powerSource: "ac",
    storageMedium: "ssd",
    storageVolume: "E",
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

async function expectCollectorCode(run, code) {
  await assert.rejects(
    async () => run(),
    (error) => error instanceof HwRefCollectorError && error.code === code,
    `expected ${code}`,
  );
}

test("collector builds only the exact measured/captured HW-REF document", () => {
  const hardware = buildMeasuredHardwareReference(collectionInput());
  assert.deepEqual(Object.keys(hardware).sort(), [
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
  ]);
  assert.equal(hardware.capture_scope, "measured");
  assert.equal(hardware.measurement_status, "captured");
  assert.deepEqual(hardware.claims, {
    formal_claims: "none",
    formal_metric_ids: [],
    production_claims: [],
    production_evidence: false,
    slo_claims: [],
  });
  assert.deepEqual(hardware.environment, rawFacts());
  assert.equal("sealed" in hardware, false);
  assert.equal("validationPhase" in hardware, false);
  assert.equal("artifact_scope" in hardware, false);
  assert.equal("execution_status" in hardware, false);
  assert.equal("quality" in hardware, false);
  assert.equal("performance" in hardware, false);
});

test("collector-only validation is explicit outside the HW-REF JSON", () => {
  const hardware = buildMeasuredHardwareReference(collectionInput());
  assert.deepEqual(validateCollectorOnlyMeasuredHardwareReference(hardware), {
    hwRefId: "hw-ref-benchmark-001",
    sealed: false,
    validationPhase: "collector-only",
  });
});

test("self-contained and canonical collector-only validators stay in parity", () => {
  const valid = buildMeasuredHardwareReference(collectionInput());
  assert.deepEqual(
    validateCollectedHardwareReference(valid),
    validateCollectorOnlyMeasuredHardwareReference(valid),
  );
  const mutations = [
    (hardware) => {
      hardware.claims.production_evidence = true;
    },
    (hardware) => {
      hardware.environment.gpus[0].execution_providers = ["cpu"];
    },
    (hardware) => {
      hardware.environment.gpus[0].execution_providers = ["cuda"];
    },
    (hardware) => {
      hardware.collector.path = "assets/alternate-hw-ref-collector.mjs";
    },
    (hardware) => {
      hardware.collector.version = "meetingrelay-hw-ref-collector-v2";
    },
    (hardware) => {
      hardware.environment.audio_devices.push(clone(hardware.environment.audio_devices[0]));
    },
    (hardware) => {
      hardware.environment.gpus.push(clone(hardware.environment.gpus[0]));
    },
    (hardware) => {
      hardware.environment.storage.push(clone(hardware.environment.storage[0]));
    },
    (hardware) => {
      hardware.environment.gpus[0].driver_version = "not-measured";
    },
    (hardware) => {
      hardware.environment.storage[0].model = "USBSTOR\\DISK&VEN_FIXTURE";
    },
    (hardware) => {
      hardware.environment.memory.total_bytes = "01";
    },
    (hardware) => {
      hardware.environment.unexpected = "field";
    },
    (hardware) => {
      hardware.environment.power.plan = "custom";
    },
    (hardware) => {
      hardware.environment.audio_devices[0].signature_status = "unknown";
    },
    (hardware) => {
      hardware.environment.cooling.ambient_celsius = "-0.0";
    },
  ];
  for (const mutate of mutations) {
    const hardware = clone(valid);
    mutate(hardware);
    assert.throws(
      () => validateCollectedHardwareReference(hardware),
      (error) => error instanceof HwRefCollectorError,
    );
    assert.throws(
      () => validateCollectorOnlyMeasuredHardwareReference(hardware),
      (error) => error instanceof Wp04ArtifactContractError,
    );
  }
});

test("collector-only validation rejects the old not-measured contract fixture", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "meetingrelay-hw-ref-fixture-"));
  try {
    await generateCandidateArtifactBundle(root);
    const fixture = JSON.parse(
      await readFile(path.join(root, "manifests", "hw-ref.json"), "utf8"),
    );
    assert.throws(
      () => validateCollectorOnlyMeasuredHardwareReference(fixture),
      (error) =>
        error instanceof Wp04ArtifactContractError &&
        error.code === "ART_SCHEMA_VALUE",
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("same captured facts encode to deterministic canonical NFC JSON", () => {
  const input = collectionInput();
  input.rawFacts.audio_devices[0].model = "Cafe\u0301 Audio";
  const first = encodeCollectedHardwareReference(
    buildMeasuredHardwareReference(input),
  );
  const second = encodeCollectedHardwareReference(
    buildMeasuredHardwareReference(clone(input)),
  );
  assert.equal(first, second);
  assert.equal(first.endsWith("\n"), true);
  assert.match(first, /"model": "Café Audio"/u);
  assert.equal(first.includes("Cafe\u0301 Audio"), false);
  assert.equal(first, `${JSON.stringify(JSON.parse(first), null, 2)}\n`);
});

test("raw facts reject unknown top-level, nested, and device fields", async () => {
  const mutations = [
    (facts) => {
      facts.telemetry_status = "disabled";
    },
    (facts) => {
      facts.cpu.family = "fixture";
    },
    (facts) => {
      facts.gpus[0].device_class = "display";
    },
  ];
  for (const mutate of mutations) {
    const input = collectionInput();
    mutate(input.rawFacts);
    await expectCollectorCode(
      () => buildMeasuredHardwareReference(input),
      "HW_REF_RAW_SCHEMA_KEYS",
    );
  }
});

test("raw facts reject hostname, serial, UUID, MAC, email, local path, and SID material", async () => {
  const mutations = [
    (facts) => {
      facts.hostname = "benchmark-host";
    },
    (facts) => {
      facts.bios.serial_number = "SERIAL-123";
    },
    (facts) => {
      facts.storage[0].pnp_device_id = "forbidden-even-before-value-validation";
    },
    (facts) => {
      facts.cpu.model = "550e8400-e29b-41d4-a716-446655440000";
    },
    (facts) => {
      facts.audio_devices[0].model = "00:11:22:33:44:55";
    },
    (facts) => {
      facts.storage[0].vendor = "owner@example.test";
    },
    (facts) => {
      facts.power.plan = "C:\\Users\\owner\\power.txt";
    },
    (facts) => {
      facts.operating_system.product = "S-1-5-21-1000-1001-1002-1003";
    },
    (facts) => {
      facts.audio_devices[0].model = "HDAUDIO\\FUNC_01&VEN_10EC&DEV_0295";
    },
    (facts) => {
      facts.gpus[0].model = "PCI\\VEN_10DE&DEV_2D58";
    },
    (facts) => {
      facts.storage[0].model = "USBSTOR\\DISK&VEN_FIXTURE";
    },
    (facts) => {
      facts.audio_devices[0].model = "BTHENUM\\DEV_001122334455";
    },
  ];
  for (const mutate of mutations) {
    const input = collectionInput();
    mutate(input.rawFacts);
    await expectCollectorCode(
      () => buildMeasuredHardwareReference(input),
      "HW_REF_PRIVACY_UNSAFE",
    );
  }
});

test("captured measurements cannot use placeholders or JSON numbers", () => {
  const placeholder = collectionInput();
  placeholder.rawFacts.gpus[0].driver_version = "not-measured";
  assert.throws(
    () => buildMeasuredHardwareReference(placeholder),
    (error) =>
      error instanceof HwRefCollectorError &&
      error.code === "HW_REF_SCHEMA_VALUE",
  );

  const numeric = collectionInput();
  numeric.rawFacts.memory.total_bytes = 34359738368;
  assert.throws(
    () => buildMeasuredHardwareReference(numeric),
    (error) =>
      error instanceof HwRefCollectorError &&
      error.code === "HW_REF_SCHEMA_U64",
  );
});

test("measured GPU providers exclude CPU", () => {
  const cpuOnGpu = collectionInput();
  cpuOnGpu.rawFacts.gpus[0].execution_providers = ["cpu"];
  assert.throws(
    () => buildMeasuredHardwareReference(cpuOnGpu),
    (error) =>
      error instanceof HwRefCollectorError &&
      error.code === "HW_REF_SCHEMA_VALUE",
  );

});

test("measured OS UBR may be zero", () => {
  const zeroUbr = collectionInput();
  zeroUbr.rawFacts.operating_system.ubr = "0";
  assert.equal(
    buildMeasuredHardwareReference(zeroUbr).environment.operating_system.ubr,
    "0",
  );
});

test("Windows raw collection is injectable and passes only explicit operator annotations", () => {
  let invocation;
  const expected = rawFacts();
  const actual = collectWindowsRawFacts(
    {
      ambientCelsius: "23.5",
      audioDeviceModel: "Fixture Audio",
      audioLogicalRole: "benchmark-audio-path",
      coolingMode: "active",
      gpuDeviceModel: "Fixture GPU",
      gpuVramBytes: "8589934592",
      powerSource: "ac",
      storageMedium: "ssd",
      storageVolume: "E",
    },
    {
      platform: "win32",
      spawn(command, args, options) {
        invocation = { args, command, options };
        return {
          error: undefined,
          status: 0,
          stderr: "",
          stdout: JSON.stringify(expected),
        };
      },
    },
  );
  assert.deepEqual(actual, expected);
  assert.equal(invocation.command, resolveSystemPowerShellPath());
  assert.deepEqual(invocation.args.slice(0, 5), [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
  ]);
  assert.equal(
    invocation.options.env.MEETINGRELAY_HW_REF_AMBIENT_CELSIUS,
    "23.5",
  );
  assert.equal(
    invocation.options.env.MEETINGRELAY_HW_REF_AUDIO_LOGICAL_ROLE,
    "benchmark-audio-path",
  );
  assert.equal(
    invocation.options.env.MEETINGRELAY_HW_REF_AUDIO_DEVICE_MODEL,
    "Fixture Audio",
  );
  assert.equal(invocation.options.env.MEETINGRELAY_HW_REF_COOLING_MODE, "active");
  assert.equal(
    invocation.options.env.MEETINGRELAY_HW_REF_GPU_DEVICE_MODEL,
    "Fixture GPU",
  );
  assert.equal(
    invocation.options.env.MEETINGRELAY_HW_REF_GPU_VRAM_BYTES,
    "8589934592",
  );
  assert.equal(invocation.options.env.MEETINGRELAY_HW_REF_POWER_SOURCE, "ac");
  assert.equal(invocation.options.env.MEETINGRELAY_HW_REF_STORAGE_MEDIUM, "ssd");
  assert.equal(invocation.options.env.MEETINGRELAY_HW_REF_STORAGE_VOLUME, "E");
  assert.equal(invocation.options.shell, false);
  assert.equal(invocation.options.windowsHide, true);
  assert.equal(
    invocation.options.env.PATH,
    path.join(process.env.SystemRoot, "System32"),
  );
  assert.equal(
    invocation.options.env.PSModulePath,
    path.join(path.dirname(invocation.command), "Modules"),
  );
});

test("hostile PATH and PSModulePath cannot replace system collection binaries", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "meetingrelay-hw-ref-path-"));
  try {
    await writeFile(path.join(root, "powershell.exe"), "hostile shim\n", "utf8");
    await writeFile(path.join(root, "powercfg.exe"), "hostile shim\n", "utf8");
    await writeFile(path.join(root, "cmd.exe"), "hostile shim\n", "utf8");
    let invoked = false;
    const facts = collectWindowsRawFacts(windowsOperatorFacts(), {
      environment: {
        ...process.env,
        PATH: root,
        PSModulePath: root,
        ComSpec: path.join(root, "cmd.exe"),
        meetingrelay_hw_ref_power_source: "hostile",
      },
      platform: "win32",
      spawn(command, _args, options) {
        invoked = true;
        assert.notEqual(command, path.join(root, "powershell.exe"));
        assert.equal(command, resolveSystemPowerShellPath());
        assert.notEqual(options.env.PATH, root);
        assert.notEqual(options.env.PSModulePath, root);
        assert.equal(
          options.env.ComSpec,
          path.join(process.env.SystemRoot, "System32", "cmd.exe"),
        );
        assert.equal(options.env.MEETINGRELAY_HW_REF_POWER_SOURCE, "ac");
        assert.equal(
          Object.keys(options.env).some(
            (key) => key === "meetingrelay_hw_ref_power_source",
          ),
          false,
        );
        return {
          error: undefined,
          status: 0,
          stderr: "",
          stdout: JSON.stringify(rawFacts()),
        };
      },
    });
    assert.equal(invoked, true);
    assert.deepEqual(facts, rawFacts());
    assert.ok(
      windowsCollectorScript.includes(
        'Join-Path ([Environment]::SystemDirectory) "powercfg.exe"',
      ),
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("Windows collection requires operator-only facts that cannot be inferred honestly", async () => {
  const complete = {
    ambientCelsius: "23.5",
    audioDeviceModel: "Fixture Audio",
    audioLogicalRole: "benchmark-audio-path",
    coolingMode: "active",
    gpuDeviceModel: "Fixture GPU",
    gpuVramBytes: "8589934592",
    powerSource: "ac",
    storageMedium: "ssd",
    storageVolume: "E",
  };
  for (const key of Object.keys(complete)) {
    const options = { ...complete };
    delete options[key];
    await expectCollectorCode(
      () =>
        collectWindowsRawFacts(options, {
          platform: "win32",
          spawn() {
            throw new Error("spawn must not run");
          },
        }),
      "HW_REF_OPERATOR_INPUT",
    );
  }
});

test("operator ambient temperature rejects negative zero before spawning", async () => {
  for (const ambientCelsius of ["-0", "-0.0", "-0.000"]) {
    await expectCollectorCode(
      () =>
        collectWindowsRawFacts(
          { ...windowsOperatorFacts(), ambientCelsius },
          {
            platform: "win32",
            spawn() {
              throw new Error("spawn must not run");
            },
          },
        ),
      "HW_REF_OPERATOR_INPUT",
    );
  }
  const negative = collectionInput();
  negative.rawFacts.cooling.ambient_celsius = "-0.5";
  assert.equal(
    buildMeasuredHardwareReference(negative).environment.cooling.ambient_celsius,
    "-0.5",
  );
});

test("Windows collection rejects non-Windows hosts before spawning", async () => {
  await expectCollectorCode(
    () => collectWindowsRawFacts(windowsOperatorFacts(), { platform: "linux" }),
    "HW_REF_PLATFORM",
  );
});

test("Windows collection reports native process failure stably", async () => {
  await expectCollectorCode(
    () =>
      collectWindowsRawFacts(windowsOperatorFacts(), {
        platform: "win32",
        spawn() {
          return { error: undefined, status: 9, stderr: "failed", stdout: "" };
        },
      }),
    "HW_REF_WINDOWS_COLLECTION",
  );
});

test("Windows collection rejects invalid native JSON stably", async () => {
  await expectCollectorCode(
    () =>
      collectWindowsRawFacts(windowsOperatorFacts(), {
        platform: "win32",
        spawn() {
          return { error: undefined, status: 0, stderr: "", stdout: "{" };
        },
      }),
    "HW_REF_WINDOWS_OUTPUT",
  );
});

test("one pinned collector source contains normalization and native collection", async () => {
  const source = await readFile(collectorSourcePath, "utf8");
  assert.ok(source.includes("buildMeasuredHardwareReference"));
  assert.ok(source.includes("runHwRefCollectorCli"));
  assert.ok(source.includes("const isMain"));
  assert.ok(source.includes("WINDOWS_COLLECTOR_SCRIPT"));
  const importSpecifiers = [
    ...[...source.matchAll(/\bfrom\s+["']([^"']+)["']/g)].map(
      (match) => match[1],
    ),
    ...[...source.matchAll(/^import\s+["']([^"']+)["']/gm)].map(
      (match) => match[1],
    ),
    ...[...source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']/g)].map(
      (match) => match[1],
    ),
  ];
  assert.ok(importSpecifiers.length > 0);
  assert.equal(importSpecifiers.every((specifier) => specifier.startsWith("node:")), true);
  assert.doesNotMatch(source, /\brequire\s*\(/);
  assert.ok(windowsCollectorScript.includes("Get-CimInstance"));
  assert.ok(windowsCollectorScript.includes("ConvertTo-Json"));
  assert.ok(
    windowsCollectorScript.includes(
      "RuntimeInformation]::OSArchitecture",
    ),
  );
  assert.equal(windowsCollectorScript.includes("AdapterRAM"), false);
  assert.equal(windowsCollectorScript.includes("Get-PhysicalDisk"), false);
  assert.equal(windowsCollectorScript.includes("Win32_Battery"), false);
  assert.equal(
    windowsCollectorScript.match(
      /\.ToUniversalTime\(\)\.ToString\("yyyy-MM-dd"/g,
    )?.length,
    2,
  );
  assert.ok(windowsCollectorScript.includes("$audio.IsSigned -isnot [bool]"));
  assert.ok(windowsCollectorScript.includes("BuildNumber, Caption"));
  assert.ok(
    windowsCollectorScript.includes(
      'Invoke-PowerCfg "effective-before" @("/Q")',
    ),
  );
  assert.ok(
    windowsCollectorScript.includes(
      'Invoke-PowerCfg "base-before" @("/Q", $activePowerGuidBefore)',
    ),
  );
  assert.ok(
    windowsCollectorScript.includes(
      'throw "power settings changed during capture"',
    ),
  );
  for (const alias of [
    "balanced",
    "high-performance",
    "ultimate-performance",
    "power-saver",
  ]) {
    assert.ok(windowsCollectorScript.includes(`{ "${alias}"; break }`));
  }
  assert.ok(
    windowsCollectorScript.includes(
      'default { throw "custom base power plans are unsupported by this collector version" }',
    ),
  );
  for (const forbidden of [
    "SerialNumber",
    "UUID",
    "MACAddress",
    "MachineGuid",
    "UserName",
    "ComputerName",
    "PSComputerName",
  ]) {
    assert.equal(windowsCollectorScript.includes(forbidden), false, forbidden);
  }
  assert.notEqual(sha256(Buffer.from(source, "utf8")), "0".repeat(64));
});

test("storage collection requires an explicitly signed driver record", () => {
  assert.ok(
    windowsCollectorScript.includes(
      "Select-Object -Property DeviceID, DriverVersion, IsSigned, Manufacturer",
    ),
  );
  assert.ok(windowsCollectorScript.includes("$driver.IsSigned -isnot [bool]"));
  assert.ok(windowsCollectorScript.includes("-not [bool] $driver.IsSigned"));
});

test("trusted PowerShell parser accepts the embedded collector without executing it", () => {
  const parserCommand = String.raw`
$source = [Console]::In.ReadToEnd()
$tokens = $null
$errors = $null
[System.Management.Automation.Language.Parser]::ParseInput(
  $source,
  [ref] $tokens,
  [ref] $errors
) | Out-Null
if ($errors.Count -ne 0) {
  $errors | ForEach-Object { [Console]::Error.WriteLine($_.Message) }
  exit 1
}
`;
  const powershellPath = resolveSystemPowerShellPath();
  const result = spawnSync(
    powershellPath,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", parserCommand],
    {
      encoding: "utf8",
      env: {
        SystemRoot: process.env.SystemRoot,
        windir: process.env.SystemRoot,
      },
      input: windowsCollectorScript,
      windowsHide: true,
    },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});

test("power fingerprint binds independent base and effective canonical bytes", () => {
  const command = `${powerFingerprintScript}
$base = ConvertTo-CanonicalPowerText @("Café base  ", "setting=1")
$baseEquivalent = ConvertTo-CanonicalPowerText @("Café base", "setting=1")
$effective = ConvertTo-CanonicalPowerText @("effective=1")
$result = [ordered]@{
  stable = Get-PowerFingerprint $base $effective
  canonical_equivalent = Get-PowerFingerprint $baseEquivalent $effective
  base_changed = Get-PowerFingerprint ($base + "changed" + [char] 10) $effective
  effective_changed = Get-PowerFingerprint $base ($effective + "changed" + [char] 10)
}
$result | ConvertTo-Json -Compress
`;
  const result = spawnSync(
    resolveSystemPowerShellPath(),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
    {
      encoding: "utf8",
      env: {
        SystemRoot: process.env.SystemRoot,
        windir: process.env.SystemRoot,
      },
      windowsHide: true,
    },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const fingerprints = JSON.parse(result.stdout);
  for (const digest of Object.values(fingerprints)) {
    assert.match(digest, /^[0-9a-f]{64}$/);
  }
  assert.equal(fingerprints.stable, fingerprints.canonical_equivalent);
  assert.notEqual(fingerprints.stable, fingerprints.base_changed);
  assert.notEqual(fingerprints.stable, fingerprints.effective_changed);
});

test("CLI streams the actual collector digest and reports an external unsealed summary", async () => {
  await mkdir(hwRefCollectorTargetRoot, { recursive: true });
  const root = await mkdtemp(
    path.join(hwRefCollectorTargetRoot, "meetingrelay-hw-ref-cli-"),
  );
  const outputPath = path.join(root, "hw-ref.json");
  let summaryBytes = "";
  try {
    await runHwRefCollectorCli({
      argv: [
        "--ambient-celsius",
        "23.5",
        "--audio-device-model",
        "Fixture Audio",
        "--audio-logical-role",
        "benchmark-audio-path",
        "--cooling-mode",
        "active",
        "--gpu-device-model",
        "Fixture GPU",
        "--gpu-vram-bytes",
        "8589934592",
        "--hw-ref-id",
        "hw-ref-benchmark-001",
        "--output",
        outputPath,
        "--power-source",
        "ac",
        "--storage-medium",
        "ssd",
        "--storage-volume",
        "E",
      ],
      async collectRawFacts(options) {
        assert.deepEqual(options, {
          ambientCelsius: "23.5",
          audioDeviceModel: "Fixture Audio",
          audioLogicalRole: "benchmark-audio-path",
          coolingMode: "active",
          gpuDeviceModel: "Fixture GPU",
          gpuVramBytes: "8589934592",
          powerSource: "ac",
          storageMedium: "ssd",
          storageVolume: "E",
        });
        assert.equal((await readFile(outputPath)).length, 0);
        await assert.rejects(
          writeFile(outputPath, "must-not-overwrite", { flag: "wx" }),
          { code: "EEXIST" },
        );
        const facts = rawFacts();
        return facts;
      },
      now() {
        return new Date("2026-07-12T01:02:03.456Z");
      },
      stdout: {
        write(bytes) {
          summaryBytes += bytes;
        },
      },
    });
    const sourceBytes = await readFile(collectorSourcePath);
    const outputBytes = await readFile(outputPath, "utf8");
    const hardware = JSON.parse(outputBytes);
    assert.equal(outputBytes, encodeCollectedHardwareReference(hardware));
    assert.deepEqual(hardware.collector, {
      path: WINDOWS_COLLECTOR_ASSET_PATH,
      sha256: sha256(sourceBytes),
      version: HW_REF_COLLECTOR_VERSION,
    });
    assert.deepEqual(JSON.parse(summaryBytes), {
      hwRefId: "hw-ref-benchmark-001",
      sealed: false,
      validationPhase: "collector-only",
    });
    assert.equal("outputPath" in JSON.parse(summaryBytes), false);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("CLI rejects caller-supplied collector digests", async () => {
  await assert.rejects(
    runHwRefCollectorCli({
      argv: ["--collector-sha256", "a".repeat(64)],
      collectRawFacts() {
        throw new Error("collector must not run");
      },
    }),
    (error) => error?.code === "HW_REF_CLI_ARGUMENT",
  );
});

test("CLI exclusive reservation preserves a pre-existing output byte-for-byte", async () => {
  await mkdir(hwRefCollectorTargetRoot, { recursive: true });
  const root = await mkdtemp(
    path.join(hwRefCollectorTargetRoot, "meetingrelay-hw-ref-existing-"),
  );
  const outputPath = path.join(root, "hw-ref.json");
  const existing = Buffer.from("existing-output-must-survive\n", "utf8");
  try {
    await writeFile(outputPath, existing, { flag: "wx" });
    await assert.rejects(
      runHwRefCollectorCli({
        argv: validCliArgs(outputPath),
        collectRawFacts() {
          throw new Error("collector must not run");
        },
      }),
      (error) => error?.code === "HW_REF_OUTPUT_CREATE",
    );
    assert.deepEqual(await readFile(outputPath), existing);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("CLI rejects collector source drift and removes its empty reservation", async () => {
  await mkdir(hwRefCollectorTargetRoot, { recursive: true });
  const root = await mkdtemp(
    path.join(hwRefCollectorTargetRoot, "meetingrelay-hw-ref-drift-"),
  );
  const outputPath = path.join(root, "hw-ref.json");
  let digestCalls = 0;
  try {
    await assert.rejects(
      runHwRefCollectorCli({
        argv: validCliArgs(outputPath),
        collectRawFacts() {
          return rawFacts();
        },
        digestSource() {
          digestCalls += 1;
          return Promise.resolve((digestCalls === 1 ? "a" : "b").repeat(64));
        },
        now() {
          return new Date("2026-07-12T01:02:03.456Z");
        },
      }),
      (error) => error?.code === "HW_REF_COLLECTOR_DRIFT",
    );
    assert.equal(digestCalls, 2);
    await assert.rejects(readFile(outputPath), { code: "ENOENT" });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("absolute invocation cannot redefine repository target through cwd", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "meetingrelay-hw-ref-cwd-"));
  const outsideTarget = path.join(root, "target");
  const outputPath = path.join(outsideTarget, "hw-ref.json");
  try {
    await mkdir(outsideTarget);
    const result = spawnSync(
      process.execPath,
      [collectorSourcePath, ...validCliArgs(outputPath)],
      { cwd: root, encoding: "utf8", windowsHide: true },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /HW_REF_OUTPUT_PATH/);
    await assert.rejects(readFile(outputPath), { code: "ENOENT" });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("CLI rejects NTFS alternate-stream output syntax before collection", async () => {
  await mkdir(hwRefCollectorTargetRoot, { recursive: true });
  const root = await mkdtemp(
    path.join(hwRefCollectorTargetRoot, "meetingrelay-hw-ref-ads-"),
  );
  try {
    await assert.rejects(
      runHwRefCollectorCli({
        argv: validCliArgs(path.join(root, "hw-ref.json:stream")),
        collectRawFacts() {
          throw new Error("collector must not run");
        },
      }),
      (error) => error?.code === "HW_REF_OUTPUT_PATH",
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("CLI confines output to target and rejects reparse-point parents", async () => {
  const outside = path.join(os.tmpdir(), "meetingrelay-hw-ref-outside.json");
  await assert.rejects(
    runHwRefCollectorCli({
      argv: [
        "--ambient-celsius",
        "23.5",
        "--audio-device-model",
        "Fixture Audio",
        "--audio-logical-role",
        "benchmark-audio-path",
        "--cooling-mode",
        "active",
        "--gpu-device-model",
        "Fixture GPU",
        "--gpu-vram-bytes",
        "8589934592",
        "--hw-ref-id",
        "hw-ref-benchmark-001",
        "--output",
        outside,
        "--power-source",
        "ac",
        "--storage-medium",
        "ssd",
        "--storage-volume",
        "E",
      ],
      collectRawFacts() {
        throw new Error("collector must not run");
      },
    }),
    (error) => error?.code === "HW_REF_OUTPUT_PATH",
  );

  await mkdir(hwRefCollectorTargetRoot, { recursive: true });
  const root = await mkdtemp(
    path.join(hwRefCollectorTargetRoot, "meetingrelay-hw-ref-reparse-"),
  );
  try {
    const actual = path.join(root, "actual");
    const linked = path.join(root, "linked");
    await mkdir(actual);
    await symlink(actual, linked, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(
      runHwRefCollectorCli({
        argv: [
          "--ambient-celsius",
          "23.5",
          "--audio-device-model",
          "Fixture Audio",
          "--audio-logical-role",
          "benchmark-audio-path",
          "--cooling-mode",
          "active",
          "--gpu-device-model",
          "Fixture GPU",
          "--gpu-vram-bytes",
          "8589934592",
          "--hw-ref-id",
          "hw-ref-benchmark-001",
          "--output",
          path.join(linked, "hw-ref.json"),
          "--power-source",
          "ac",
          "--storage-medium",
          "ssd",
          "--storage-volume",
          "E",
        ],
        collectRawFacts() {
          throw new Error("collector must not run");
        },
      }),
      (error) => error?.code === "HW_REF_OUTPUT_REPARSE",
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("CLI holds its wx reservation and rejects a swapped parent before handle write", async () => {
  await mkdir(hwRefCollectorTargetRoot, { recursive: true });
  const root = await mkdtemp(
    path.join(hwRefCollectorTargetRoot, "meetingrelay-hw-ref-swap-"),
  );
  const parent = path.join(root, "parent");
  const replacement = path.join(root, "replacement");
  await mkdir(parent);
  await mkdir(replacement);
  try {
    await assert.rejects(
      runHwRefCollectorCli({
        argv: [
          "--ambient-celsius",
          "23.5",
          "--audio-device-model",
          "Fixture Audio",
          "--audio-logical-role",
          "benchmark-audio-path",
          "--cooling-mode",
          "active",
          "--gpu-device-model",
          "Fixture GPU",
          "--gpu-vram-bytes",
          "8589934592",
          "--hw-ref-id",
          "hw-ref-benchmark-001",
          "--output",
          path.join(parent, "hw-ref.json"),
          "--power-source",
          "ac",
          "--storage-medium",
          "ssd",
          "--storage-volume",
          "E",
        ],
        async collectRawFacts() {
          await rm(parent, { recursive: true });
          await symlink(
            replacement,
            parent,
            process.platform === "win32" ? "junction" : "dir",
          );
          const facts = rawFacts();
          facts.gpus[0].execution_providers = [];
          return facts;
        },
        now() {
          return new Date("2026-07-12T01:02:03.456Z");
        },
      }),
      (error) => error?.code === "HW_REF_OUTPUT_REPARSE",
    );
    await assert.rejects(readFile(path.join(replacement, "hw-ref.json")), {
      code: "ENOENT",
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
