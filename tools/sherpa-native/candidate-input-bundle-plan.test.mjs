import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  encodeCanonicalJson,
  encodeCanonicalJsonLine,
} from "../phase0-harness/canonical-json.mjs";
import {
  fixturePaths,
  validateFixtureTree,
} from "../phase0-harness/fixture-contract.mjs";
import {
  buildMeasuredHardwareReference,
  HW_REF_COLLECTOR_VERSION,
  WINDOWS_COLLECTOR_ASSET_PATH,
} from "../phase0-harness/hw-ref-collector.mjs";
import {
  buildMeasuredSherpaCandidateInputBundlePlan,
  buildSherpaCandidateInputBundlePlan,
  CandidateInputBundlePlanError,
} from "./candidate-input-bundle-plan.mjs";
import { planSherpaCandidateInput } from "./candidate-input-plan.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../..");
const SOURCE_COMMIT = "97920c76e8c782d96364942e40d12c1543b8b3b1";
const SOURCE_URL = `https://github.com/AsaZhou923/MeetingRelay/commit/${SOURCE_COMMIT}`;
let inputPromise;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function runBuilder() {
  const command = process.platform === "win32" ? "cargo.exe" : "cargo";
  const result = spawnSync(
    command,
    [
      "run",
      "--quiet",
      "--locked",
      "--offline",
      "-p",
      "meetingrelay-model-worker-sherpa-native",
      "--bin",
      "emit_sherpa_candidate_builder_input",
      "--no-default-features",
    ],
    {
      cwd: REPO_ROOT,
      encoding: null,
      env: { ...process.env, CARGO_TERM_COLOR: "never" },
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr?.toString("utf8"));
  assert.equal(result.stderr?.length ?? 0, 0);
  return Buffer.from(result.stdout);
}

async function buildInput() {
  const [
    assetsLockBytes,
    cargoLockBytes,
    schemaRegistryBytes,
    meetingrelayNoticeBytes,
    sherpaApacheLicenseBytes,
    onnxruntimeMitLicenseBytes,
    funasrCurrentLicenseBytes,
    fixtureManifestBytes,
    validatedFixture,
  ] = await Promise.all([
    readFile(path.join(HERE, "assets.lock.json")),
    readFile(path.join(REPO_ROOT, "Cargo.lock")),
    readFile(path.join(HERE, "candidate-schema-registry.json")),
    readFile(path.join(HERE, "licenses", "meetingrelay-unlicensed-notice.txt")),
    readFile(path.join(HERE, "licenses", "apache-2.0-sherpa-onnx.txt")),
    readFile(path.join(HERE, "licenses", "mit-onnxruntime-1.27.0.txt")),
    readFile(path.join(HERE, "licenses", "funasr-model-license-1.1.txt")),
    readFile(path.join(fixturePaths.projectRoot, "manifest.json")),
    validateFixtureTree(),
  ]);
  const rustBuilderInputBytes = runBuilder();
  const builder = JSON.parse(rustBuilderInputBytes.toString("utf8"));
  const worker = {
    descriptor: builder.worker_manifest_descriptor_fragment,
    executable_sha256: "1".repeat(64),
    role: "native-candidate",
    schema_registry_sha256: sha256(schemaRegistryBytes),
    worker_build_sha256: "1".repeat(64),
    worker_id: "meetingrelay-sherpa-native-candidate-host-v1",
  };
  const candidatePlan = planSherpaCandidateInput({
    assetsLockBytes,
    cargoLockBytes,
    licenseBytes: {
      funasrCurrentLicenseBytes,
      meetingrelayNoticeBytes,
      onnxruntimeMitLicenseBytes,
      sherpaApacheLicenseBytes,
    },
    releaseWorkerProjectionBytes: Buffer.from(
      encodeCanonicalJsonLine(worker),
      "utf8",
    ),
    rustBuilderInputBytes,
    schemaRegistryBytes,
    sourceCommit: SOURCE_COMMIT,
    sourceUrl: SOURCE_URL,
    workerExecutableSizeBytes: "1234567",
  });
  const manifest = JSON.parse(fixtureManifestBytes.toString("utf8"));
  const fixtures = manifest.fixtures.map((fixture) => ({
    audioPath: fixture.audio.path,
    audioSha256: fixture.audio.sha256,
    fixtureId: fixture.fixture_id,
    pcmSha256: fixture.audio.pcm_sha256,
    referenceSha256: fixture.reference.sha256,
  }));
  return {
    candidatePlan,
    fixtureRegistryProjection: {
      ...fixtures[0],
      fixtures,
      manifestSha256: validatedFixture.manifestDigest,
    },
  };
}

async function baseInput() {
  inputPromise ??= buildInput();
  return cloneInput(await inputPromise);
}

function syntheticRawFacts() {
  return {
    audio_devices: [{
      driver_version: "10.0.26100.1",
      logical_role: "synthetic-test-audio-path",
      model: "Synthetic Test Audio",
      signature_status: "signed",
      vendor: "SyntheticTestVendor",
    }],
    background_process_allowlist: [],
    bios: {
      release_date: "2026-01-01",
      vendor: "SyntheticTestVendor",
      version: "1.0.0-test",
    },
    cooling: { ambient_celsius: "23.5", mode: "synthetic-test-active" },
    cpu: {
      logical_processor_count: "16",
      model: "Synthetic Test CPU",
      physical_core_count: "8",
      vendor: "SyntheticTestVendor",
    },
    gpus: [{
      driver_version: "32.0.15.7283",
      execution_providers: [],
      model: "Synthetic Test GPU",
      vendor: "SyntheticTestVendor",
      vram_bytes: "8589934592",
    }],
    memory: { total_bytes: "34359738368" },
    operating_system: {
      architecture: "x64",
      build: "26100",
      product: "Windows 11 Pro Synthetic Test",
      ubr: "4652",
      version: "24H2-test",
    },
    power: { plan: `balanced@${"a".repeat(64)}`, source: "ac" },
    storage: [{
      capacity_bytes: "1000202273280",
      driver_version: "10.0.26100.1",
      filesystem: "NTFS",
      medium: "ssd",
      model: "Synthetic Test Storage",
      vendor: "SyntheticTestVendor",
    }],
  };
}

async function measuredInput() {
  const legacyInput = await baseInput();
  const collectorBytes = await readFile(
    path.join(REPO_ROOT, "tools", "phase0-harness", "hw-ref-collector.mjs"),
  );
  const collectorSha256 = sha256(collectorBytes);
  const measuredHardwareReference = buildMeasuredHardwareReference({
    capturedAt: "2026-07-13T01:02:03.456Z",
    collector: {
      path: WINDOWS_COLLECTOR_ASSET_PATH,
      sha256: collectorSha256,
      version: HW_REF_COLLECTOR_VERSION,
    },
    hwRefId: "hw-ref-synthetic-test-only-001",
    rawFacts: syntheticRawFacts(),
  });
  const hardwareBytes = Buffer.from(
    encodeCanonicalJson(measuredHardwareReference),
    "utf8",
  );
  return {
    ...legacyInput,
    collectorSource: {
      path: "tools/phase0-harness/hw-ref-collector.mjs",
      sha256: collectorSha256,
      size_bytes: String(collectorBytes.length),
    },
    measuredHardwareReference,
    measuredHardwareReferenceSource: {
      path: "target/synthetic-test-only/hw-ref.json",
      sha256: sha256(hardwareBytes),
      size_bytes: String(hardwareBytes.length),
    },
  };
}

function cloneInput(input) {
  return {
    candidatePlan: {
      kind: input.candidatePlan.kind,
      materials: input.candidatePlan.materials.map((material) =>
        material.kind === "document"
          ? { ...material, bytes: Buffer.from(material.bytes) }
          : { ...material },
      ),
      schema_version: input.candidatePlan.schema_version,
    },
    fixtureRegistryProjection: JSON.parse(
      JSON.stringify(input.fixtureRegistryProjection),
    ),
  };
}

function material(plan, targetPath) {
  const matches = plan.materials.filter((entry) => entry.target_path === targetPath);
  assert.equal(matches.length, 1, targetPath);
  return matches[0];
}

function jsonMaterial(plan, targetPath) {
  const entry = material(plan, targetPath);
  assert.equal(entry.kind, "document");
  return JSON.parse(entry.bytes.toString("utf8"));
}

function mutateCandidateDocument(input, mutate) {
  const material = input.candidatePlan.materials.find(
    (entry) => entry.target_path === "manifests/candidate-manifest.json",
  );
  const value = JSON.parse(material.bytes.toString("utf8"));
  mutate(value);
  material.bytes = Buffer.from(encodeCanonicalJson(value), "utf8");
  material.sha256 = sha256(material.bytes);
  material.size_bytes = String(material.bytes.length);
}

function noClaims() {
  return {
    formal_claims: "none",
    formal_metric_ids: [],
    production_claims: [],
    production_evidence: false,
    slo_claims: [],
  };
}

test("f3a1 builds the exact deterministic sealed input plan from the real f2b planner", async () => {
  const input = await baseInput();
  const left = buildSherpaCandidateInputBundlePlan(input);
  const right = buildSherpaCandidateInputBundlePlan(await baseInput());

  assert.deepEqual(Object.keys(left), [
    "kind",
    "materials",
    "proposedContractSha256",
    "schema_version",
  ]);
  assert.equal(left.kind, "meetingrelay-sherpa-candidate-input-bundle-plan-v1");
  assert.equal(left.schema_version, "1.0");
  assert.match(left.proposedContractSha256, /^[0-9a-f]{64}$/u);
  assert.equal(left.materials.length, 28);
  assert.equal(left.materials.filter((entry) => entry.kind === "copy").length, 17);
  assert.equal(left.materials.filter((entry) => entry.kind === "document").length, 11);
  assert.deepEqual(
    left.materials.map((entry) => entry.target_path),
    [...left.materials.map((entry) => entry.target_path)].sort(),
  );
  assert.equal(new Set(left.materials.map((entry) => entry.target_path)).size, 28);

  const contractMaterial = material(left, "contract-manifest.json");
  const contract = JSON.parse(contractMaterial.bytes.toString("utf8"));
  const sealMaterial = material(left, "contract-manifest.sha256");
  const sealedMaterials = left.materials.filter(
    (entry) =>
      entry.target_path !== "contract-manifest.json" &&
      entry.target_path !== "contract-manifest.sha256",
  );
  assert.equal(contract.entries.length, 26);
  assert.equal(sealedMaterials.length, 26);
  assert.deepEqual(
    contract.entries.map((entry, index) => ({
      ...entry,
      kind: sealedMaterials[index].kind,
    })),
    sealedMaterials.map((entry) => ({
      kind: entry.kind,
      path: entry.target_path,
      sha256: entry.sha256,
      size_bytes: entry.size_bytes,
    })),
  );
  assert.equal(
    sealedMaterials.every((entry) => entry.kind === "copy" || entry.kind === "document"),
    true,
  );
  assert.deepEqual(contract, {
    contract_id: `contract-${jsonMaterial(left, "manifests/candidate-manifest.json").candidate_id}-input-v1`,
    entries: sealedMaterials.map((entry) => ({
      path: entry.target_path,
      sha256: entry.sha256,
      size_bytes: entry.size_bytes,
    })),
    formal_claims: "none",
    schema_version: "1.0",
  });
  assert.equal(contract.entries.some((entry) => entry.path.startsWith("evidence/")), false);
  assert.equal(contract.entries.some((entry) => entry.path === "contract-manifest.json"), false);
  assert.equal(contract.entries.some((entry) => entry.path === "contract-manifest.sha256"), false);
  assert.equal(contractMaterial.sha256, sha256(contractMaterial.bytes));
  assert.equal(contractMaterial.size_bytes, String(contractMaterial.bytes.length));
  assert.equal(left.proposedContractSha256, sha256(contractMaterial.bytes));
  assert.equal(
    sealMaterial.bytes.toString("ascii"),
    `${left.proposedContractSha256}  contract-manifest.json\n`,
  );
  assert.equal(sealMaterial.sha256, sha256(sealMaterial.bytes));
  assert.equal(sealMaterial.size_bytes, String(sealMaterial.bytes.length));

  for (const entry of left.materials) {
    const other = material(right, entry.target_path);
    assert.equal(other.kind, entry.kind, entry.target_path);
    assert.equal(other.sha256, entry.sha256, entry.target_path);
    assert.equal(other.size_bytes, entry.size_bytes, entry.target_path);
    if (entry.kind === "document") {
      assert.equal(other.bytes.compare(entry.bytes), 0, entry.target_path);
      if (entry.target_path !== "contract-manifest.sha256") {
        const text = entry.bytes.toString("utf8");
        const parsed = JSON.parse(text);
        if (["assets/parameters.json", "assets/runtime-inventory.json"].includes(entry.target_path)) {
          assert.equal(text, JSON.stringify(parsed), entry.target_path);
          assert.doesNotMatch(text, /[\r\n]/u, entry.target_path);
        } else {
          assert.equal(text, encodeCanonicalJson(parsed), entry.target_path);
        }
      }
    } else {
      assert.equal(other.source_root, entry.source_root, entry.target_path);
      assert.equal(
        other.source_relative_path,
        entry.source_relative_path,
        entry.target_path,
      );
      assert.equal(other.target_path, entry.target_path, entry.target_path);
    }
  }
});

test("legacy schema 1.0 remains the exact 28/26 fixture plan without a collector copy", async () => {
  const plan = buildSherpaCandidateInputBundlePlan(await baseInput());
  const contract = jsonMaterial(plan, "contract-manifest.json");
  assert.equal(plan.schema_version, "1.0");
  assert.equal(
    plan.proposedContractSha256,
    "da8836617dcb51fa4ecb17c4909f387a23c461b102c32cf18b11e5e290292fca",
  );
  assert.equal(plan.materials.length, 28);
  assert.equal(plan.materials.filter((entry) => entry.kind === "copy").length, 17);
  assert.equal(plan.materials.filter((entry) => entry.kind === "document").length, 11);
  assert.equal(contract.entries.length, 26);
  assert.equal(
    plan.materials.some(
      (entry) => entry.target_path === "assets/hw-ref-collector.mjs",
    ),
    false,
  );
});

test("measured schema 1.1 seals the official collector source and measured run joins", async () => {
  const input = await measuredInput();
  const left = buildMeasuredSherpaCandidateInputBundlePlan(input);
  const right = buildMeasuredSherpaCandidateInputBundlePlan(await measuredInput());
  const contract = jsonMaterial(left, "contract-manifest.json");
  const hardware = jsonMaterial(left, "manifests/hw-ref.json");
  const runPlan = jsonMaterial(left, "manifests/run-plan.json");
  const collector = material(left, "assets/hw-ref-collector.mjs");

  assert.equal(left.schema_version, "1.1");
  assert.equal(left.materials.length, 29);
  assert.equal(left.materials.filter((entry) => entry.kind === "copy").length, 18);
  assert.equal(left.materials.filter((entry) => entry.kind === "document").length, 11);
  assert.equal(contract.entries.length, 27);
  assert.deepEqual(left, right);
  assert.deepEqual(collector, {
    kind: "copy",
    sha256: input.collectorSource.sha256,
    size_bytes: input.collectorSource.size_bytes,
    source_relative_path: "tools/phase0-harness/hw-ref-collector.mjs",
    source_root: "repository",
    target_path: "assets/hw-ref-collector.mjs",
  });
  assert.equal(hardware.capture_scope, "measured");
  assert.equal(hardware.measurement_status, "captured");
  assert.equal(hardware.collector.path, collector.target_path);
  assert.equal(hardware.collector.sha256, collector.sha256);
  assert.equal(runPlan.hw_ref_id, hardware.hw_ref_id);
  assert.equal(
    runPlan.same_condition_contract.cooling_mode,
    hardware.environment.cooling.mode,
  );
  assert.equal(
    runPlan.same_condition_contract.power_plan,
    hardware.environment.power.plan,
  );
  assert.deepEqual(
    contract.entries.find((entry) => entry.path === collector.target_path),
    {
      path: collector.target_path,
      sha256: collector.sha256,
      size_bytes: collector.size_bytes,
    },
  );
  assert.deepEqual(input.measuredHardwareReference.claims, noClaims());
});

test("measured planning fails closed on source identity and collector join drift", async (context) => {
  const cases = [
    {
      code: "BUNDLE_PLAN_JOIN",
      name: "canonical HW digest drift",
      mutate(input) {
        input.measuredHardwareReferenceSource.sha256 = "b".repeat(64);
      },
    },
    {
      code: "BUNDLE_PLAN_JOIN",
      name: "canonical HW size drift",
      mutate(input) {
        input.measuredHardwareReferenceSource.size_bytes = "1";
      },
    },
    {
      code: "BUNDLE_PLAN_JOIN",
      name: "collector repository path drift",
      mutate(input) {
        input.collectorSource.path = "tools/phase0-harness/alternate.mjs";
      },
    },
    {
      code: "BUNDLE_PLAN_JOIN",
      name: "collector digest drift",
      mutate(input) {
        input.collectorSource.sha256 = "b".repeat(64);
      },
    },
  ];
  for (const case_ of cases) {
    await context.test(case_.name, async () => {
      const input = await measuredInput();
      case_.mutate(input);
      assert.throws(
        () => buildMeasuredSherpaCandidateInputBundlePlan(input),
        (error) => error?.code === case_.code,
      );
    });
  }
});

test("wrapper documents bind every candidate, fixture, hardware, and run-plan join", async () => {
  const input = await baseInput();
  const plan = buildSherpaCandidateInputBundlePlan(input);
  const candidate = jsonMaterial(plan, "manifests/candidate-manifest.json");
  const fixtureSet = jsonMaterial(plan, "manifests/fixture-set-manifest.json");
  const hardware = jsonMaterial(plan, "manifests/hw-ref.json");
  const runPlan = jsonMaterial(plan, "manifests/run-plan.json");
  const harness = jsonMaterial(plan, "assets/input-only-harness-plan.json");
  const vadEndpoint = jsonMaterial(plan, "assets/vad-endpoint-plan.json");
  const warmup = jsonMaterial(plan, "assets/warmup-plan.json");
  const byRole = new Map(
    candidate.artifacts.map((artifact) => [artifact.role, artifact]),
  );

  assert.equal(candidate.publishability_status, "pending");
  assert.equal(candidate.selection_status, "not-selected");
  assert.deepEqual(candidate.claims, noClaims());
  assert.deepEqual(harness, {
    artifact_scope: "candidate-input",
    core: {
      execution_status: "not-authorized",
      harness_kind: "input-only-contract-harness",
    },
    formal_claims: "none",
    production_evidence: false,
    schema_version: "1.0",
    ui: {
      execution_status: "not-authorized",
      harness_kind: "input-only-contract-harness",
    },
  });
  assert.deepEqual(vadEndpoint, {
    artifact_scope: "candidate-input",
    endpoint: { max_segment_ms: "30000", min_silence_ms: "300" },
    formal_claims: "none",
    schema_version: "1.0",
    vad: { frame_ms: "20", threshold_basis_points: "5000" },
  });
  assert.deepEqual(warmup, {
    actions: ["load-model", "prime-synthetic-calibration-fixture"],
    artifact_scope: "candidate-input",
    formal_claims: "none",
    schema_version: "1.0",
  });
  assert.deepEqual(fixtureSet, {
    artifact_scope: "candidate-run-input",
    fixture_set_id: `fixture-set-${candidate.candidate_id}`,
    fixtures: input.fixtureRegistryProjection.fixtures.map((fixture) => ({
      audio_path: fixture.audioPath,
      audio_sha256: fixture.audioSha256,
      fixture_id: fixture.fixtureId,
      pcm_sha256: fixture.pcmSha256,
      reference_sha256: fixture.referenceSha256,
    })),
    quality_evidence: false,
    registry: {
      path: "test-fixtures/manifest.json",
      sha256: input.fixtureRegistryProjection.manifestSha256,
    },
    schema_version: "1.0",
  });
  assert.deepEqual(hardware, {
    capture_scope: "contract-fixture",
    captured_at: null,
    claims: noClaims(),
    collector: {
      path: byRole.get("schema-registry").path,
      sha256: byRole.get("schema-registry").sha256,
      version: "meetingrelay-hw-ref-contract-fixture-v1",
    },
    environment: {
      audio_devices: [{
        driver_version: "not-measured",
        logical_role: "contract-fixture",
        model: "not-measured",
        signature_status: "not-measured",
        vendor: "not-measured",
      }],
      background_process_allowlist: [],
      bios: { release_date: null, vendor: "contract-fixture", version: "not-measured" },
      cooling: { ambient_celsius: null, mode: "not-measured" },
      cpu: {
        logical_processor_count: null,
        model: "contract-fixture",
        physical_core_count: null,
        vendor: "contract-fixture",
      },
      gpus: [{
        driver_version: "not-measured",
        execution_providers: [],
        model: "not-measured",
        vendor: "not-measured",
        vram_bytes: null,
      }],
      memory: { total_bytes: null },
      operating_system: {
        architecture: "x64",
        build: "not-measured",
        product: "Windows",
        ubr: null,
        version: "not-measured",
      },
      power: { plan: "not-measured", source: "not-measured" },
      storage: [{
        capacity_bytes: null,
        driver_version: "not-measured",
        filesystem: "not-measured",
        medium: "not-measured",
        model: "not-measured",
        vendor: "not-measured",
      }],
    },
    hardware_tier: "HW-REF",
    hw_ref_id: "hw-ref-contract-fixture-001",
    measurement_status: "not-measured",
    privacy_class: "contract-fixture-public-safe",
    privacy_policy: "no-stable-device-identifiers-v1",
    schema_version: "1.0",
  });

  const harnessRef = {
    path: "assets/input-only-harness-plan.json",
    sha256: material(plan, "assets/input-only-harness-plan.json").sha256,
  };
  const vadRef = {
    path: "assets/vad-endpoint-plan.json",
    sha256: material(plan, "assets/vad-endpoint-plan.json").sha256,
  };
  assert.deepEqual(runPlan, {
    build_profile: "release",
    candidate_ids: [candidate.candidate_id],
    claims: noClaims(),
    evidence_manifest_id: `evidence-${candidate.candidate_id}-pending`,
    execution_status: "planned",
    fixture_ids: fixtureSet.fixtures.map((fixture) => fixture.fixture_id),
    fixture_set_id: fixtureSet.fixture_set_id,
    harness: {
      command: {
        argv: [],
        cwd: "assets",
        executable_path: byRole.get("worker-executable").path,
      },
      core: harnessRef,
      environment_allowlist: [],
      lockfile: {
        path: byRole.get("package-lock").path,
        sha256: byRole.get("package-lock").sha256,
      },
      ui: harnessRef,
    },
    hw_ref_id: "hw-ref-contract-fixture-001",
    network_policy: "offline-only",
    order_policy: "seeded-round-robin-v1",
    run_plan_id: `run-plan-${candidate.candidate_id}`,
    same_condition_contract: {
      audio_playback_path: `test-fixtures/${fixtureSet.fixtures[0].audio_path}`,
      batch_size: "1",
      cooling_mode: "not-measured",
      endpoint_parameters: vadRef,
      execution_provider: candidate.worker_manifest_projection.descriptor.execution_provider,
      log_level: "info",
      model_sha256: byRole.get("model").sha256,
      parameter_sha256: byRole.get("parameters").sha256,
      pcm_sha256: fixtureSet.fixtures[0].pcm_sha256,
      power_plan: "not-measured",
      quantization: candidate.worker_manifest_projection.descriptor.quantization,
      thread_count: "1",
      translation_fixture_ids: [],
      vad_parameters: vadRef,
      warmup_plan: {
        path: "assets/warmup-plan.json",
        sha256: material(plan, "assets/warmup-plan.json").sha256,
      },
    },
    sampling: {
      cold_runs: "10",
      final_event_count: "10000",
      idle_baseline_seconds: "300",
      soak_durations_seconds: ["1800", "7200", "14400"],
      warm_samples_per_scenario: "30",
      warmup_runs: "1",
    },
    schema_version: "1.0",
    scope: "candidate-run",
    seed: "42",
    silent_cloud_fallback: false,
    source_commit: candidate.source.source_revision,
    steps: [
      { kind: "preflight", sequence: "1" },
      { kind: "publishability", sequence: "2" },
      { kind: "contract", sequence: "3" },
      { kind: "quality", sequence: "4" },
      { kind: "cold", sequence: "5" },
      { kind: "warmup", sequence: "6" },
      { kind: "warm", sequence: "7" },
      { kind: "soak-fault", sequence: "8" },
      { kind: "postflight", sequence: "9" },
    ],
  });
});

test("planner defensively copies all input and output document buffers", async () => {
  const input = await baseInput();
  const inputDocuments = input.candidatePlan.materials.filter(
    (entry) => entry.kind === "document",
  );
  assert.equal(inputDocuments.length, 3);
  const plan = buildSherpaCandidateInputBundlePlan(input);
  const outputDocuments = plan.materials.filter((entry) => entry.kind === "document");
  assert.equal(outputDocuments.length, 11);
  const outputSnapshots = new Map(
    outputDocuments.map((entry) => [entry.target_path, Buffer.from(entry.bytes)]),
  );
  for (const inputDocument of inputDocuments) inputDocument.bytes.fill(0);
  input.fixtureRegistryProjection.fixtures[0].audioPath = "drift.wav";
  for (const outputDocument of outputDocuments) {
    assert.equal(
      outputDocument.bytes.compare(outputSnapshots.get(outputDocument.target_path)),
      0,
      outputDocument.target_path,
    );
  }
  for (const inputDocument of inputDocuments) {
    assert.notEqual(material(plan, inputDocument.target_path).bytes, inputDocument.bytes);
  }

  const other = buildSherpaCandidateInputBundlePlan(await baseInput());
  for (const outputDocument of outputDocuments) outputDocument.bytes[0] ^= 0xff;
  for (const otherDocument of other.materials.filter((entry) => entry.kind === "document")) {
    const original = material(plan, otherDocument.target_path);
    assert.equal(
      otherDocument.bytes.compare(outputSnapshots.get(otherDocument.target_path)),
      0,
      otherDocument.target_path,
    );
    assert.notEqual(otherDocument.bytes, original.bytes, otherDocument.target_path);
  }
  assert.equal(Object.isFrozen(plan), true);
  assert.equal(Object.isFrozen(plan.materials), true);
});

test("candidate and fixture plan drift fails closed before a proposed seal exists", async (context) => {
  const cases = [
    {
      code: "BUNDLE_PLAN_KEYS",
      name: "unknown candidate plan key",
      mutate(input) {
        input.candidatePlan.unexpected = true;
      },
    },
    {
      code: "BUNDLE_PLAN_COUNT",
      name: "missing candidate material",
      mutate(input) {
        input.candidatePlan.materials.pop();
      },
    },
    {
      code: "BUNDLE_PLAN_DUPLICATE",
      name: "duplicate target path",
      mutate(input) {
        input.candidatePlan.materials[1].target_path =
          input.candidatePlan.materials[0].target_path;
      },
    },
    {
      code: "BUNDLE_PLAN_DIGEST",
      name: "mutated document bytes",
      mutate(input) {
        const document = input.candidatePlan.materials.find(
          (entry) => entry.kind === "document",
        );
        document.bytes[0] ^= 0xff;
      },
    },
    {
      code: "BUNDLE_PLAN_CANONICAL",
      name: "noncanonical but rehashed candidate JSON",
      mutate(input) {
        const candidate = input.candidatePlan.materials.find(
          (entry) => entry.target_path === "manifests/candidate-manifest.json",
        );
        const value = JSON.parse(candidate.bytes.toString("utf8"));
        candidate.bytes = Buffer.from(JSON.stringify(value), "utf8");
        candidate.sha256 = sha256(candidate.bytes);
        candidate.size_bytes = String(candidate.bytes.length);
      },
    },
    {
      code: "BUNDLE_PLAN_ORDER",
      name: "unsorted candidate materials",
      mutate(input) {
        [input.candidatePlan.materials[0], input.candidatePlan.materials[1]] =
          [input.candidatePlan.materials[1], input.candidatePlan.materials[0]];
      },
    },
    {
      code: "BUNDLE_PLAN_U64",
      name: "noncanonical size",
      mutate(input) {
        input.candidatePlan.materials[0].size_bytes = "01";
      },
    },
    {
      code: "BUNDLE_PLAN_U64",
      name: "uint64 overflow",
      mutate(input) {
        input.candidatePlan.materials[0].size_bytes = "18446744073709551616";
      },
    },
    {
      code: "BUNDLE_PLAN_U64",
      name: "zero size",
      mutate(input) {
        input.candidatePlan.materials[0].size_bytes = "0";
      },
    },
    {
      code: "BUNDLE_PLAN_DIGEST",
      name: "uppercase digest",
      mutate(input) {
        input.candidatePlan.materials[0].sha256 =
          input.candidatePlan.materials[0].sha256.toUpperCase();
      },
    },
    {
      code: "BUNDLE_PLAN_KIND",
      name: "unknown material kind",
      mutate(input) {
        input.candidatePlan.materials[0].kind = "link";
      },
    },
    {
      code: "BUNDLE_PLAN_VALUE",
      name: "unknown source root",
      mutate(input) {
        const copy = input.candidatePlan.materials.find(
          (entry) => entry.kind === "copy",
        );
        copy.source_root = "ambient-cwd";
      },
    },
    {
      code: "ART_PATH_TRAVERSAL",
      name: "unsafe source path",
      mutate(input) {
        const copy = input.candidatePlan.materials.find(
          (entry) => entry.kind === "copy",
        );
        copy.source_relative_path = "../Cargo.lock";
      },
    },
    {
      code: "ART_PATH_ABSOLUTE",
      name: "unsafe target path",
      mutate(input) {
        input.candidatePlan.materials[0].target_path = "C:/escape.bin";
      },
    },
    {
      code: "BUNDLE_PLAN_BOUNDARY",
      name: "candidate material occupies a wrapper path",
      mutate(input) {
        input.candidatePlan.materials[0].target_path =
          "assets/input-only-harness-plan.json";
        input.candidatePlan.materials.sort((left, right) =>
          left.target_path < right.target_path ? -1 : left.target_path > right.target_path ? 1 : 0,
        );
      },
    },
    {
      code: "BUNDLE_PLAN_BOUNDARY",
      name: "candidate material occupies an evidence path",
      mutate(input) {
        input.candidatePlan.materials[0].target_path = "evidence/forbidden.json";
        input.candidatePlan.materials.sort((left, right) =>
          left.target_path < right.target_path ? -1 : left.target_path > right.target_path ? 1 : 0,
        );
      },
    },
    {
      code: "BUNDLE_PLAN_BOUNDARY",
      name: "candidate material occupies the seal path",
      mutate(input) {
        input.candidatePlan.materials[0].target_path = "contract-manifest.sha256";
        input.candidatePlan.materials.sort((left, right) =>
          left.target_path < right.target_path ? -1 : left.target_path > right.target_path ? 1 : 0,
        );
      },
    },
    {
      code: "BUNDLE_PLAN_VALUE",
      name: "zero source commit",
      mutate(input) {
        mutateCandidateDocument(input, (candidate) => {
          candidate.source.source_revision = "0".repeat(40);
          candidate.source.source_url =
            `https://github.com/AsaZhou923/MeetingRelay/commit/${"0".repeat(40)}`;
        });
      },
    },
    {
      code: "BUNDLE_PLAN_VALUE",
      name: "short source revision",
      mutate(input) {
        mutateCandidateDocument(input, (candidate) => {
          candidate.source.source_revision = "a".repeat(39);
          candidate.source.source_url =
            `https://github.com/AsaZhou923/MeetingRelay/commit/${"a".repeat(39)}`;
        });
      },
    },
    {
      code: "BUNDLE_PLAN_VALUE",
      name: "uppercase source revision",
      mutate(input) {
        mutateCandidateDocument(input, (candidate) => {
          candidate.source.source_revision = candidate.source.source_revision.toUpperCase();
          candidate.source.source_url =
            `https://github.com/AsaZhou923/MeetingRelay/commit/${candidate.source.source_revision}`;
        });
      },
    },
    {
      code: "BUNDLE_PLAN_JOIN",
      name: "source URL points to another commit",
      mutate(input) {
        mutateCandidateDocument(input, (candidate) => {
          candidate.source.source_url =
            `https://github.com/AsaZhou923/MeetingRelay/commit/${"b".repeat(40)}`;
        });
      },
    },
    {
      code: "BUNDLE_PLAN_JOIN",
      name: "source URL points to another repository",
      mutate(input) {
        mutateCandidateDocument(input, (candidate) => {
          candidate.source.source_url =
            `https://github.com/example/MeetingRelay/commit/${candidate.source.source_revision}`;
        });
      },
    },
    {
      code: "BUNDLE_PLAN_KEYS",
      name: "fixture projection unknown key",
      mutate(input) {
        input.fixtureRegistryProjection.ambient = true;
      },
    },
    {
      code: "BUNDLE_PLAN_JOIN",
      name: "fixture summary drift",
      mutate(input) {
        input.fixtureRegistryProjection.audioSha256 = "2".repeat(64);
      },
    },
    {
      code: "BUNDLE_PLAN_DIGEST",
      name: "fixture registry digest drift",
      mutate(input) {
        input.fixtureRegistryProjection.manifestSha256 = "0".repeat(64);
      },
    },
  ];
  for (const case_ of cases) {
    await context.test(case_.name, async () => {
      const input = await baseInput();
      case_.mutate(input);
      assert.throws(
        () => buildSherpaCandidateInputBundlePlan(input),
        (error) =>
          (error instanceof CandidateInputBundlePlanError ||
            error?.name === "Wp04ArtifactContractError") &&
          error.code === case_.code,
      );
    });
  }
});

test("the pure plan grants no filesystem, external trust, execution, evidence, or selection authority", async () => {
  const source = await readFile(
    path.join(HERE, "candidate-input-bundle-plan.mjs"),
    "utf8",
  );
  assert.doesNotMatch(source, /node:(?:fs|child_process|os|process)/u);
  assert.doesNotMatch(source, /\b(?:process\.|Date\.|Math\.random|randomUUID)\b/u);

  const plan = buildSherpaCandidateInputBundlePlan(await baseInput());
  assert.equal(plan.materials.some((entry) => entry.target_path.startsWith("evidence/")), false);
  const serialized = JSON.stringify(plan);
  assert.doesNotMatch(serialized, /expectedContractSha256/u);
  assert.doesNotMatch(serialized, /"ranking_status"|"eligibility_status"/u);
  assert.equal("expectedContractSha256" in plan, false);
  assert.equal("contractManifestSha256" in plan, false);
  assert.equal("proposedContractSha256" in plan, true);
});
