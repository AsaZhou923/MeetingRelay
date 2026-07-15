import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  encodeCanonicalJson,
  encodeCanonicalJsonLine,
} from "../phase0-harness/canonical-json.mjs";
import { buildMeasuredHardwareReference } from "../phase0-harness/hw-ref-collector.mjs";
import {
  __runNativeCandidateMeasuredEvidenceForTest,
  NativeCandidateMeasuredEvidenceError,
  publishNativeCandidateMeasuredEvidence,
  validateNativeCandidateMeasuredEvidenceFile,
  validateNativeCandidateMeasuredEvidenceRecord,
} from "./native-candidate-measured-evidence.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../..");
const SOURCE_COMMIT = "5fc1f7d8df8c5e29fc1acf71dd77ce227e2dd091";
const WORKER_ID = "meetingrelay-sherpa-native-candidate-host-v1";
const REFERENCE_MANIFEST_SHA256 =
  "cc2afff6bc92a6fe6e2b58e15332422dc3ecddae790eac6235fa543e2bd76590";
const WAV_SHA256 =
  "b77f1794fe374a0ba1ee1dc458bfaf9349496cbbfc32780c50ba3c5a7ad8e373";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalDocument(value) {
  return Buffer.from(encodeCanonicalJson(value), "utf8");
}

function material(bytes, targetPath, kind = "document") {
  return {
    bytes: Buffer.from(bytes),
    kind,
    sha256: sha256(bytes),
    size_bytes: String(bytes.length),
    target_path: targetPath,
  };
}

function artifact(role, artifactPath, bytes) {
  return {
    path: artifactPath,
    role,
    sha256: sha256(bytes),
    size_bytes: String(bytes.length),
  };
}

function operatorFacts() {
  return {
    ambientCelsius: "23.5",
    audioDeviceModel: "Contest Audio TestLab 9000",
    audioLogicalRole: "meeting-room-microphone",
    coolingMode: "active-performance-profile",
    gpuDeviceModel: "NVIDIA GeForce RTX 4060",
    gpuVramBytes: "8589934592",
    powerSource: "ac",
    storageMedium: "ssd",
    storageVolume: "E",
  };
}

function rawHardwareFacts() {
  return {
    audio_devices: [
      {
        driver_version: "10.0.26100.1",
        logical_role: "meeting-room-microphone",
        model: "Contest Audio TestLab 9000",
        signature_status: "signed",
        vendor: "Realtek Semiconductor Corp.",
      },
    ],
    background_process_allowlist: [],
    bios: {
      release_date: "2026-01-01",
      vendor: "American Megatrends International, LLC.",
      version: "F12",
    },
    cooling: { ambient_celsius: "23.5", mode: "active-performance-profile" },
    cpu: {
      logical_processor_count: "16",
      model: "AMD Ryzen 7 7840HS",
      physical_core_count: "8",
      vendor: "AuthenticAMD",
    },
    gpus: [
      {
        driver_version: "32.0.15.7283",
        execution_providers: [],
        model: "NVIDIA GeForce RTX 4060",
        vendor: "NVIDIA",
        vram_bytes: "8589934592",
      },
    ],
    memory: { total_bytes: "34359738368" },
    operating_system: {
      architecture: "x64",
      build: "26100",
      product: "Windows 11 Pro",
      ubr: "4652",
      version: "24H2",
    },
    power: { plan: `balanced@${"a".repeat(64)}`, source: "ac" },
    storage: [
      {
        capacity_bytes: "1000202273280",
        driver_version: "10.0.26100.1",
        filesystem: "NTFS",
        medium: "ssd",
        model: "Samsung SSD 990 PRO 1TB",
        vendor: "Samsung",
      },
    ],
  };
}

function evidenceRecord() {
  return {
    assessment_status: {
      ct_worker_candidate_status: "not-assessed",
      default_status: "not-assessed",
      full_run_plan_status: "not-executed",
      parent_closeout_status: "not-assessed",
      performance_status: "not-assessed",
      publishability_status: "not-assessed",
      quality_status: "not-assessed",
      ranking_status: "not-assessed",
      resources_status: "not-assessed",
      selection_status: "not-assessed",
    },
    authority: { formal_claims: "none", production_evidence: false },
    execution: {
      actual_native_inference: true,
      backend_execute_calls: 1,
      check_summary: { passed: 12, total: 12 },
      conformance_record_sha256: "1".repeat(64),
    },
    execution_descriptor: {
      argv_roles: [
        "schema-registry",
        "model",
        "tokens",
        "runtime-library-directory",
        "model-manifest",
        "package-lock",
        "external-sealed-reference-wav",
      ],
      full_run_plan_argv_used: false,
      full_run_plan_fixture_used: false,
      scope: "native-contract-stage-only",
    },
    input_identity: {
      config_sha256: "2".repeat(64),
      contract_manifest_sha256: "3".repeat(64),
      execution_host_sha256: "4".repeat(64),
      hw_ref_id: "hw-ref-onsite-001",
      locked_input_snapshot_sha256: "5".repeat(64),
      measured_hardware_reference_sha256: "6".repeat(64),
      model_sha256: "7".repeat(64),
      operator_facts_sha256: "8".repeat(64),
      quality_reference_manifest_sha256: REFERENCE_MANIFEST_SHA256,
      run_plan_sha256: "9".repeat(64),
      runtime_bundle_sha256: "a".repeat(64),
      schema_registry_sha256: "b".repeat(64),
      source_commit: SOURCE_COMMIT,
      wav_sha256: WAV_SHA256,
      worker_id: WORKER_ID,
    },
    kind: "meetingrelay-native-candidate-measured-evidence-v1",
    limitations: [
      "operator-facts-recorded-by-digest-only",
      "storage-volume-selection-not-persisted-in-hw-ref",
      "quality-not-assessed",
      "performance-not-assessed",
      "resource-usage-not-assessed",
      "publishability-ranking-selection-default-not-assessed",
      "calibration-full-run-plan-not-executed",
      "ct-worker-candidate-and-parent-closeout-not-authorized",
      "phase-1-not-authorized",
    ],
    schema_version: "1.0",
  };
}

async function createFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "meetingrelay-measured-evidence-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const roots = {
    repository: path.join(root, "repository"),
    "rust-target": path.join(root, "rust-target"),
    "sherpa-model-extraction": path.join(root, "model-source"),
    "sherpa-runtime-extraction": path.join(root, "runtime-source"),
  };
  await Promise.all(Object.values(roots).map((directory) => mkdir(directory, { recursive: true })));
  const outputBundleRoot = path.join(root, "measured-bundle");
  const outputEvidencePath = path.join(root, "measured-evidence.json");
  const wavPath = path.join(root, "external-zh.wav");
  await writeFile(wavPath, Buffer.from("external sealed zh wav", "utf8"));

  const bytesByPath = new Map();
  const add = (role, artifactPath, content) => {
    const bytes = Buffer.from(content, "utf8");
    bytesByPath.set(artifactPath, bytes);
    return artifact(role, artifactPath, bytes);
  };
  const worker = add(
    "worker-executable",
    "assets/meetingrelay-sherpa-candidate-execution-host.exe",
    "release execution host",
  );
  const schemaRegistry = add(
    "schema-registry",
    "assets/candidate-schema-registry.json",
    "candidate schema registry",
  );
  const model = add("model", "assets/model.int8.onnx", "locked model bytes");
  const tokens = add("tokens", "assets/tokens.txt", "locked tokens bytes");
  const runtimeInventory = add(
    "runtime",
    "assets/runtime-inventory.json",
    "runtime inventory bytes",
  );
  const parameters = add("parameters", "assets/parameters.json", "locked parameters bytes");
  const assetLock = add("model-manifest", "assets/assets.lock.json", "asset lock bytes");
  const packageLock = add("package-lock", "assets/Cargo.lock", "cargo lock bytes");
  const runtimeFiles = Array.from({ length: 7 }, (_, index) =>
    add(
      `runtime-file-${index + 1}`,
      `assets/runtime/lib/runtime-${index + 1}.dll`,
      `runtime dll ${index + 1}`,
    ),
  );
  const artifacts = [
    worker,
    schemaRegistry,
    model,
    tokens,
    runtimeInventory,
    parameters,
    assetLock,
    packageLock,
    ...runtimeFiles,
  ];
  const descriptor = {
    model_manifest_sha256: assetLock.sha256,
    model_sha256: model.sha256,
    package_lock_sha256: packageLock.sha256,
    parameter_sha256: parameters.sha256,
    runtime_sha256: runtimeInventory.sha256,
  };
  const candidate = {
    artifacts,
    source: {
      source_revision: SOURCE_COMMIT,
      source_url: `https://github.com/AsaZhou923/MeetingRelay/commit/${SOURCE_COMMIT}`,
    },
    worker_manifest_projection: {
      descriptor,
      executable_sha256: worker.sha256,
      schema_registry_sha256: schemaRegistry.sha256,
      worker_build_sha256: worker.sha256,
      worker_id: WORKER_ID,
    },
  };
  const facts = operatorFacts();
  const hardware = buildMeasuredHardwareReference({
    capturedAt: "2026-07-15T02:03:04.000Z",
    collector: {
      path: "assets/hw-ref-collector.mjs",
      sha256: "c".repeat(64),
      version: "meetingrelay-hw-ref-collector-v1",
    },
    hwRefId: "hw-ref-onsite-001",
    rawFacts: rawHardwareFacts(),
  });
  const runPlan = {
    execution_status: "planned",
    harness: { command: { argv: [] } },
    same_condition_contract: {
      audio_playback_path: "test-fixtures/calibration-tone.wav",
    },
    scope: "candidate-run",
    source_commit: SOURCE_COMMIT,
  };
  const workerSourceRelativePath =
    "release/meetingrelay-sherpa-candidate-execution-host.exe";
  const candidatePlan = {
    materials: [
      {
        kind: "copy",
        sha256: worker.sha256,
        size_bytes: worker.size_bytes,
        source_relative_path: workerSourceRelativePath,
        source_root: "rust-target",
        target_path: worker.path,
      },
    ],
  };
  const workerSourcePath = path.join(
    roots["rust-target"],
    ...workerSourceRelativePath.split("/"),
  );
  await mkdir(path.dirname(workerSourcePath), { recursive: true });
  await writeFile(workerSourcePath, bytesByPath.get(worker.path));
  const measuredHardwareReferencePath = path.join(root, "measured-hw-ref.json");
  await writeFile(measuredHardwareReferencePath, canonicalDocument(hardware));

  const fixture = {
    artifacts,
    bytesByPath,
    candidate,
    candidatePlan,
    facts,
    hardware,
    input: null,
    outputBundleRoot,
    outputEvidencePath,
    proposal: null,
    roots,
    runPlan,
    wavPath,
    workerSourcePath,
  };

  fixture.rebuild = () => {
    const documentBytes = new Map([
      ["manifests/candidate-manifest.json", canonicalDocument(fixture.candidate)],
      ["manifests/hw-ref.json", canonicalDocument(fixture.hardware)],
      ["manifests/run-plan.json", canonicalDocument(fixture.runPlan)],
    ]);
    const entries = [
      ...[...fixture.bytesByPath].map(([entryPath, bytes]) => ({
        path: entryPath,
        sha256: sha256(bytes),
        size_bytes: String(bytes.length),
      })),
      ...[...documentBytes].map(([entryPath, bytes]) => ({
        path: entryPath,
        sha256: sha256(bytes),
        size_bytes: String(bytes.length),
      })),
    ].sort((left, right) => left.path.localeCompare(right.path, "en"));
    const contract = {
      contract_id: "contract-native-measured-test",
      entries,
      formal_claims: "none",
      schema_version: "1.0",
    };
    const contractBytes = canonicalDocument(contract);
    const contractSha256 = sha256(contractBytes);
    const sealBytes = Buffer.from(
      `${contractSha256}  contract-manifest.json\n`,
      "ascii",
    );
    const planMaterials = [
      material(contractBytes, "contract-manifest.json"),
      material(sealBytes, "contract-manifest.sha256"),
      ...[...documentBytes].map(([targetPath, bytes]) => material(bytes, targetPath)),
    ];
    for (let index = planMaterials.length; index < 29; index += 1) {
      const bytes = Buffer.from(`dummy-${index}`, "utf8");
      planMaterials.push(material(bytes, `dummy/${String(index).padStart(2, "0")}.bin`));
    }
    fixture.documents = documentBytes;
    fixture.contract = contract;
    fixture.contractBytes = contractBytes;
    fixture.contractSha256 = contractSha256;
    fixture.sealBytes = sealBytes;
    fixture.proposal = {
      formalClaims: "none",
      plan: {
        kind: "meetingrelay-sherpa-candidate-input-bundle-plan-v1",
        materials: planMaterials,
        proposedContractSha256: contractSha256,
        schema_version: "1.1",
      },
      productionEvidence: false,
      proposedContractSha256: contractSha256,
      status: "proposed",
      validationPhase: "input-only-proposal",
    };
    fixture.hardwareSha256 = sha256(documentBytes.get("manifests/hw-ref.json"));
    fixture.operatorFactsSha256 = sha256(canonicalDocument(fixture.facts));
    fixture.lockedInputSnapshotSha256 = sha256(
      Buffer.from(
        encodeCanonicalJsonLine({
          asset_lock_sha256: assetLock.sha256,
          cargo_lock_sha256: packageLock.sha256,
          model_sha256: model.sha256,
          parameter_sha256: parameters.sha256,
          runtime_bundle_sha256: runtimeInventory.sha256,
          schema_registry_sha256: schemaRegistry.sha256,
          tokens_sha256: tokens.sha256,
          wav_sha256: WAV_SHA256,
        }).slice(0, -1),
        "utf8",
      ),
    );
    fixture.input = {
      candidatePlan: fixture.candidatePlan,
      expectedContractSha256: contractSha256,
      expectedHardwareReferenceSha256: fixture.hardwareSha256,
      expectedHwRefId: fixture.hardware.hw_ref_id,
      expectedOperatorFactsSha256: fixture.operatorFactsSha256,
      fixtureRegistryProjection: { fixture: "opaque-test-projection" },
      measuredHardwareReferencePath,
      operatorFacts: fixture.facts,
      outputBundleRoot,
      outputEvidencePath,
      sourceRoots: roots,
      wavPath,
    };
  };
  fixture.rebuild();

  fixture.writeBundle = async ({ skipUnsafe = false } = {}) => {
    await mkdir(outputBundleRoot);
    await writeFile(path.join(outputBundleRoot, "contract-manifest.json"), fixture.contractBytes);
    await writeFile(path.join(outputBundleRoot, "contract-manifest.sha256"), fixture.sealBytes);
    for (const [relativePath, bytes] of [
      ...fixture.bytesByPath,
      ...fixture.documents,
    ]) {
      if (relativePath.split("/").includes("..")) {
        if (skipUnsafe) continue;
        throw new Error("unsafe test bundle path");
      }
      const outputPath = path.join(outputBundleRoot, ...relativePath.split("/"));
      await mkdir(path.dirname(outputPath), { recursive: true });
      await writeFile(outputPath, bytes);
    }
  };

  fixture.validateBundle = async (bundleRoot, { expectedContractSha256 }) => {
    const contractBytes = await readFile(path.join(bundleRoot, "contract-manifest.json"));
    assert.equal(sha256(contractBytes), expectedContractSha256);
    const contract = JSON.parse(contractBytes.toString("utf8"));
    for (const entry of contract.entries) {
      const bytes = await readFile(path.join(bundleRoot, ...entry.path.split("/")));
      assert.equal(sha256(bytes), entry.sha256, entry.path);
      assert.equal(String(bytes.length), entry.size_bytes, entry.path);
    }
    return {
      contractManifestSha256: expectedContractSha256,
      formalClaims: "none",
      productionEvidence: false,
      status: "input-valid",
      validationPhase: "input-only",
    };
  };

  fixture.referenceLoader = async ({ wavPath: requestedWavPath }) => ({
    manifestSha256: REFERENCE_MANIFEST_SHA256,
    wavPath: path.resolve(requestedWavPath),
    wavSha256: WAV_SHA256,
  });
  fixture.conformanceRunner = async (input) => {
    assert.equal(input.executablePath, fixture.workerSourcePath);
    assert.equal(
      input.schemaRegistryPath,
      path.join(outputBundleRoot, ...schemaRegistry.path.split("/")),
    );
    assert.equal(input.modelPath, path.join(outputBundleRoot, ...model.path.split("/")));
    assert.equal(input.tokensPath, path.join(outputBundleRoot, ...tokens.path.split("/")));
    assert.equal(input.runtimeLibDir, path.join(outputBundleRoot, "assets", "runtime", "lib"));
    assert.equal(input.assetLockPath, path.join(outputBundleRoot, ...assetLock.path.split("/")));
    assert.equal(
      input.packageLockPath,
      path.join(outputBundleRoot, ...packageLock.path.split("/")),
    );
    assert.equal(input.wavPath, wavPath);
    return {
      backendExecuteCalls: 1,
      checkSummary: { passed: 12, total: 12 },
      conformanceRecordSha256: "d".repeat(64),
      executableSha256: worker.sha256,
      finalTranscriptSha256: "e".repeat(64),
      finalTranscriptUtf8Bytes: 38,
      lockedInputSnapshotSha256: fixture.lockedInputSnapshotSha256,
      schemaRegistrySha256: schemaRegistry.sha256,
      workerId: WORKER_ID,
    };
  };
  fixture.dependencies = (overrides = {}) => ({
    conformanceRunner: fixture.conformanceRunner,
    materialize: async () => {
      await fixture.writeBundle();
      return {
        bundleRoot: outputBundleRoot,
        contractManifestSha256: fixture.contractSha256,
        formalClaims: "none",
        productionEvidence: false,
        status: "input-valid",
        validationPhase: "input-only",
      };
    },
    propose: async () => fixture.proposal,
    referenceLoader: fixture.referenceLoader,
    validateBundle: fixture.validateBundle,
    ...overrides,
  });
  return fixture;
}

async function assertRejectsCode(operation, code) {
  await assert.rejects(
    operation,
    (error) => error instanceof NativeCandidateMeasuredEvidenceError && error.code === code,
  );
}

test("synthetic support fixture proves only the measured native contract stage", async (t) => {
  const fixture = await createFixture(t);
  const result = await __runNativeCandidateMeasuredEvidenceForTest(
    fixture.input,
    fixture.dependencies(),
  );
  assert.equal(result.contractManifestSha256, fixture.contractSha256);
  assert.equal(result.hwRefId, "hw-ref-onsite-001");
  assert.equal(result.sourceCommit, SOURCE_COMMIT);
  assert.equal(result.record.execution.backend_execute_calls, 1);
  assert.deepEqual(result.record.execution.check_summary, { passed: 12, total: 12 });
  assert.equal(result.record.execution_descriptor.scope, "native-contract-stage-only");
  assert.equal(result.record.execution_descriptor.full_run_plan_argv_used, false);
  assert.equal(result.record.execution_descriptor.full_run_plan_fixture_used, false);
  assert.equal(result.record.assessment_status.full_run_plan_status, "not-executed");
  assert.equal(result.record.assessment_status.quality_status, "not-assessed");
  assert.equal(result.record.assessment_status.performance_status, "not-assessed");
  assert.equal(result.record.assessment_status.resources_status, "not-assessed");
  assert.equal(result.record.assessment_status.parent_closeout_status, "not-assessed");
  assert.equal(result.record.authority.formal_claims, "none");
  assert.equal(result.record.authority.production_evidence, false);
  assert.match(fixture.facts.audioDeviceModel, /test/iu);
  assert.deepEqual(fixture.runPlan.harness.command.argv, []);
  assert.equal(
    fixture.runPlan.same_condition_contract.audio_playback_path,
    "test-fixtures/calibration-tone.wav",
  );
  assert.notEqual(fixture.wavPath, fixture.runPlan.same_condition_contract.audio_playback_path);
  assert.equal(result.record.input_identity.wav_sha256, WAV_SHA256);
  assert.equal(
    result.record.input_identity.measured_hardware_reference_sha256,
    fixture.hardwareSha256,
  );
  assert.equal(result.record.input_identity.operator_facts_sha256, fixture.operatorFactsSha256);
  assert.equal(
    (await lstat(fixture.outputBundleRoot)).isDirectory(),
    true,
  );
});

test("schema and runtime validator reject unknown fields and authority promotion", async () => {
  const schema = JSON.parse(
    await readFile(path.join(HERE, "native-candidate-measured-evidence.schema.json"), "utf8"),
  );
  assert.equal(schema.additionalProperties, false);
  assert.equal(
    schema.properties.execution_descriptor.$ref,
    "#/$defs/executionDescriptor",
  );
  assert.equal(
    schema.$defs.executionDescriptor.properties.scope.const,
    "native-contract-stage-only",
  );
  assert.equal(
    schema.$defs.assessmentStatus.properties.full_run_plan_status.const,
    "not-executed",
  );
  assert.equal(schema.$defs.execution.properties.backend_execute_calls.const, 1);
  assert.equal(schema.$defs.checkSummary.properties.passed.const, 12);

  const cases = [
    (record) => {
      record.unexpected = true;
    },
    (record) => {
      record.authority.production_evidence = true;
    },
    (record) => {
      record.authority.formal_claims = "performance";
    },
    (record) => {
      record.assessment_status.quality_status = "passed";
    },
    (record) => {
      record.assessment_status.full_run_plan_status = "completed";
    },
    (record) => {
      record.execution_descriptor.full_run_plan_argv_used = true;
    },
    (record) => {
      record.execution_descriptor.full_run_plan_fixture_used = true;
    },
    (record) => {
      record.execution_descriptor.scope = "candidate-run";
    },
    (record) => {
      record.execution.check_summary.passed = 11;
    },
  ];
  for (const mutate of cases) {
    const record = evidenceRecord();
    mutate(record);
    assert.throws(
      () =>
        validateNativeCandidateMeasuredEvidenceRecord(
          Buffer.from(encodeCanonicalJsonLine(record), "utf8"),
        ),
      NativeCandidateMeasuredEvidenceError,
    );
  }
  assert.throws(
    () =>
      validateNativeCandidateMeasuredEvidenceRecord(
        Buffer.from(JSON.stringify(evidenceRecord()), "utf8"),
      ),
    NativeCandidateMeasuredEvidenceError,
  );
});

test("package, CI, and README wire only synthetic measured-evidence authority", async () => {
  const [packageJson, workflow, readme] = await Promise.all([
    readFile(path.join(REPO_ROOT, "package.json"), "utf8").then(JSON.parse),
    readFile(path.join(REPO_ROOT, ".github", "workflows", "ci.yml"), "utf8"),
    readFile(path.join(HERE, "README.md"), "utf8"),
  ]);
  assert.equal(
    packageJson.scripts["phase0:sherpa-candidate-measured-evidence:test"],
    "node --test tools/sherpa-native/native-candidate-measured-evidence.test.mjs",
  );
  assert.equal(
    packageJson.scripts["phase0:sherpa-candidate-measured-evidence:validate"],
    "node tools/sherpa-native/native-candidate-measured-evidence.mjs --validate",
  );
  assert.equal(
    packageJson.scripts["phase0:sherpa-candidate-measured-evidence:run"],
    undefined,
  );
  assert.match(
    workflow,
    /Test WP-0\.4 measured-HW native contract-stage evidence \(synthetic only\)/u,
  );
  assert.equal(
    workflow.match(/pnpm phase0:sherpa-candidate-measured-evidence:test/gu)?.length,
    1,
  );
  assert.doesNotMatch(
    workflow,
    /phase0:sherpa-candidate-measured-evidence:(?:run|validate)/u,
  );
  assert.ok(
    workflow.indexOf("phase0:sherpa-candidate-measured-evidence:test") <
      workflow.indexOf("phase0:sherpa-candidate-conformance:test"),
  );
  for (const key of [
    "ambientCelsius",
    "audioDeviceModel",
    "audioLogicalRole",
    "coolingMode",
    "gpuDeviceModel",
    "gpuVramBytes",
    "powerSource",
    "storageMedium",
    "storageVolume",
  ]) {
    assert.ok(readme.includes("`" + key + "`"));
  }
  for (const boundary of [
    "expectedContractSha256",
    "expectedHardwareReferenceSha256",
    "expectedHwRefId",
    "expectedOperatorFactsSha256",
    "recursively key-sorted, NFC-normalized string values, UTF-8 encoded, two-space indented, and terminated by exactly one LF (`\\n`)",
    "native-contract-stage-only",
    "formal_claims=none",
    "production_evidence=false",
    "execution_status=planned",
    "harness.command.argv=[]",
    "The calibration fixture named by that plan is not executed",
    "CI runs only the synthetic contract test",
  ]) {
    assert.ok(readme.includes(boundary));
  }
  assert.match(readme, /There is intentionally no `--run` CLI/u);
  assert.match(readme, /pnpm phase0:sherpa-candidate-measured-evidence:validate/u);
  assert.doesNotMatch(readme, /production_evidence=true|formal_claims=(?!none)/u);
});

test("external trust anchors and all nine operator facts are mandatory before proposal work", async (t) => {
  const cases = [
    {
      code: "MEASURED_EVIDENCE_CONTRACT_TRUST_REQUIRED",
      mutate(input) {
        input.expectedContractSha256 = undefined;
      },
    },
    {
      code: "MEASURED_EVIDENCE_HW_TRUST_REQUIRED",
      mutate(input) {
        input.expectedHardwareReferenceSha256 = undefined;
      },
    },
    {
      code: "MEASURED_EVIDENCE_OPERATOR_TRUST_REQUIRED",
      mutate(input) {
        input.expectedOperatorFactsSha256 = undefined;
      },
    },
    {
      code: "MEASURED_EVIDENCE_OPERATOR_FACTS",
      mutate(input) {
        input.operatorFacts.coolingMode = "default";
      },
    },
    {
      code: "MEASURED_EVIDENCE_OPERATOR_FACTS",
      mutate(input) {
        delete input.operatorFacts.storageVolume;
      },
    },
  ];
  for (const [index, case_] of cases.entries()) {
    await t.test(`trust case ${index + 1}`, async (subtest) => {
      const fixture = await createFixture(subtest);
      const input = structuredClone(fixture.input);
      input.candidatePlan = fixture.input.candidatePlan;
      case_.mutate(input);
      let proposalCalls = 0;
      await assertRejectsCode(
        () =>
          __runNativeCandidateMeasuredEvidenceForTest(
            input,
            fixture.dependencies({
              async propose() {
                proposalCalls += 1;
                return fixture.proposal;
              },
            }),
          ),
        case_.code,
      );
      assert.equal(proposalCalls, 0);
    });
  }
});

test("normalized operator sentinels are rejected across all nine facts", async (t) => {
  const fixture = await createFixture(t);
  const cases = [
    ["ambientCelsius", " N / A "],
    ["audioDeviceModel", "NoNe"],
    ["audioLogicalRole", "TBD"],
    ["coolingMode", "un-set"],
    ["gpuDeviceModel", "UNAVAILABLE"],
    ["gpuVramBytes", "not_collected"],
    ["powerSource", "missing"],
    ["storageMedium", "not recorded"],
    ["storageVolume", "not-provided"],
    ["audioDeviceModel", " -- "],
  ];
  let proposalCalls = 0;
  for (const [key, sentinel] of cases) {
    const input = structuredClone(fixture.input);
    input.operatorFacts[key] = sentinel;
    input.expectedOperatorFactsSha256 = sha256(canonicalDocument(input.operatorFacts));
    await assertRejectsCode(
      () =>
        __runNativeCandidateMeasuredEvidenceForTest(
          input,
          fixture.dependencies({
            async propose() {
              proposalCalls += 1;
              return fixture.proposal;
            },
          }),
        ),
      "MEASURED_EVIDENCE_OPERATOR_FACTS",
    );
  }
  assert.equal(proposalCalls, 0);
});

test("contract, HW, operator, and seal mismatches stop before materialization", async (t) => {
  const cases = [
    {
      code: "MEASURED_EVIDENCE_PROPOSAL",
      mutate(fixture) {
        fixture.input.expectedContractSha256 = "f".repeat(64);
      },
    },
    {
      code: "MEASURED_EVIDENCE_HW_TRUST_MISMATCH",
      mutate(fixture) {
        fixture.input.expectedHardwareReferenceSha256 = "f".repeat(64);
      },
    },
    {
      code: "MEASURED_EVIDENCE_HW_TRUST_MISMATCH",
      mutate(fixture) {
        fixture.input.expectedHwRefId = "hw-ref-another-machine";
      },
    },
    {
      code: "MEASURED_EVIDENCE_OPERATOR_TRUST_MISMATCH",
      mutate(fixture) {
        fixture.input.expectedOperatorFactsSha256 = "f".repeat(64);
      },
    },
    {
      code: "MEASURED_EVIDENCE_OPERATOR_HW_JOIN",
      mutate(fixture) {
        fixture.facts.coolingMode = "quiet-profile";
        fixture.input.operatorFacts = fixture.facts;
        fixture.input.expectedOperatorFactsSha256 = sha256(canonicalDocument(fixture.facts));
      },
    },
    {
      code: "MEASURED_EVIDENCE_PROPOSAL_SEAL",
      mutate(fixture) {
        const seal = fixture.proposal.plan.materials.find(
          (entry) => entry.target_path === "contract-manifest.sha256",
        );
        seal.bytes = Buffer.from(`${fixture.contractSha256} contract-manifest.json\n`);
      },
    },
  ];
  for (const [index, case_] of cases.entries()) {
    await t.test(`join case ${index + 1}`, async (subtest) => {
      const fixture = await createFixture(subtest);
      case_.mutate(fixture);
      let materializeCalls = 0;
      await assertRejectsCode(
        () =>
          __runNativeCandidateMeasuredEvidenceForTest(
            fixture.input,
            fixture.dependencies({
              async materialize() {
                materializeCalls += 1;
                throw new Error("must not materialize");
              },
            }),
          ),
        case_.code,
      );
      assert.equal(materializeCalls, 0);
    });
  }
});

test("resealed candidate artifact path escape fails before conformance", async (t) => {
  const fixture = await createFixture(t);
  const model = fixture.candidate.artifacts.find((entry) => entry.role === "model");
  const oldPath = model.path;
  const bytes = fixture.bytesByPath.get(oldPath);
  fixture.bytesByPath.delete(oldPath);
  model.path = "../escaped-model.onnx";
  fixture.bytesByPath.set(model.path, bytes);
  fixture.rebuild();
  let conformanceCalls = 0;
  await assertRejectsCode(
    () =>
      __runNativeCandidateMeasuredEvidenceForTest(
        fixture.input,
        fixture.dependencies({
          async conformanceRunner() {
            conformanceCalls += 1;
          },
          async materialize() {
            await fixture.writeBundle({ skipUnsafe: true });
            return {
              bundleRoot: fixture.outputBundleRoot,
              contractManifestSha256: fixture.contractSha256,
              formalClaims: "none",
              productionEvidence: false,
              status: "input-valid",
              validationPhase: "input-only",
            };
          },
          async validateBundle() {
            return {
              contractManifestSha256: fixture.contractSha256,
              formalClaims: "none",
              productionEvidence: false,
              status: "input-valid",
              validationPhase: "input-only",
            };
          },
        }),
      ),
    "MEASURED_EVIDENCE_CONTRACT",
  );
  assert.equal(conformanceCalls, 0);
});

test("pre-execution mutation fails closed before native work", async (t) => {
  const fixture = await createFixture(t);
  let conformanceCalls = 0;
  await assertRejectsCode(
    () =>
      __runNativeCandidateMeasuredEvidenceForTest(
        fixture.input,
        fixture.dependencies({
          async conformanceRunner() {
            conformanceCalls += 1;
          },
          hooks: {
            async afterPreflightBeforeConformance() {
              await writeFile(
                path.join(fixture.outputBundleRoot, "manifests", "hw-ref.json"),
                Buffer.from("mutated", "utf8"),
              );
            },
          },
        }),
      ),
    "MEASURED_EVIDENCE_BUNDLE_VALIDATION",
  );
  assert.equal(conformanceCalls, 0);
  await assert.rejects(lstat(fixture.outputEvidencePath), { code: "ENOENT" });
});

test("post-execution bundle mutation prevents evidence publication", async (t) => {
  const fixture = await createFixture(t);
  let conformanceCalls = 0;
  const runner = fixture.conformanceRunner;
  await assertRejectsCode(
    () =>
      __runNativeCandidateMeasuredEvidenceForTest(
        fixture.input,
        fixture.dependencies({
          async conformanceRunner(input) {
            conformanceCalls += 1;
            return runner(input);
          },
          hooks: {
            async afterConformanceBeforePostflight() {
              await writeFile(
                path.join(fixture.outputBundleRoot, "assets", "model.int8.onnx"),
                Buffer.from("mutated", "utf8"),
              );
            },
          },
        }),
      ),
    "MEASURED_EVIDENCE_BUNDLE_VALIDATION",
  );
  assert.equal(conformanceCalls, 1);
  await assert.rejects(lstat(fixture.outputEvidencePath), { code: "ENOENT" });
});

test("external WAV identity mutation after conformance prevents publication", async (t) => {
  const fixture = await createFixture(t);
  let referenceCalls = 0;
  await assertRejectsCode(
    () =>
      __runNativeCandidateMeasuredEvidenceForTest(
        fixture.input,
        fixture.dependencies({
          async referenceLoader({ wavPath }) {
            referenceCalls += 1;
            return {
              manifestSha256: REFERENCE_MANIFEST_SHA256,
              wavPath,
              wavSha256: referenceCalls >= 3 ? "f".repeat(64) : WAV_SHA256,
            };
          },
        }),
      ),
    "MEASURED_EVIDENCE_WAV_JOIN",
  );
  assert.equal(referenceCalls, 3);
  await assert.rejects(lstat(fixture.outputEvidencePath), { code: "ENOENT" });
});

test("materializer authority promotion and full-run promotion are rejected", async (t) => {
  const fixture = await createFixture(t);
  await assertRejectsCode(
    () =>
      __runNativeCandidateMeasuredEvidenceForTest(
        fixture.input,
        fixture.dependencies({
          async materialize() {
            await fixture.writeBundle();
            return {
              bundleRoot: fixture.outputBundleRoot,
              contractManifestSha256: fixture.contractSha256,
              formalClaims: "performance",
              productionEvidence: true,
              status: "completed",
              validationPhase: "candidate-run",
            };
          },
        }),
      ),
    "MEASURED_EVIDENCE_MATERIALIZER_AUTHORITY",
  );

  const second = await createFixture(t);
  second.runPlan.execution_status = "completed";
  second.runPlan.harness.command.argv = ["assets/model.int8.onnx"];
  second.rebuild();
  await assertRejectsCode(
    () =>
      __runNativeCandidateMeasuredEvidenceForTest(
        second.input,
        second.dependencies(),
      ),
    "MEASURED_EVIDENCE_FULL_RUN_BOUNDARY",
  );
});

test("evidence publication is create-new and preserves an existing competitor", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "meetingrelay-measured-publish-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const outputPath = path.join(root, "evidence.json");
  const competitor = Buffer.from("competitor", "utf8");
  await writeFile(outputPath, competitor);
  const bytes = Buffer.from(encodeCanonicalJsonLine(evidenceRecord()), "utf8");
  await assertRejectsCode(
    () => publishNativeCandidateMeasuredEvidence(outputPath, bytes),
    "MEASURED_EVIDENCE_OUTPUT",
  );
  assert.deepEqual(await readFile(outputPath), competitor);
  assert.deepEqual(await readdir(root), ["evidence.json"]);
});

test("post-link replacement preserves competitors and cleans only owned names", async (t) => {
  await t.test("final path replacement", async (subtest) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "meetingrelay-measured-publish-"));
    subtest.after(() => rm(root, { force: true, recursive: true }));
    const outputPath = path.join(root, "after-link.json");
    const bytes = Buffer.from(encodeCanonicalJsonLine(evidenceRecord()), "utf8");
    const competitor = Buffer.from("post-link final competitor", "utf8");
    let captured;
    await assert.rejects(
      () =>
        publishNativeCandidateMeasuredEvidence(outputPath, bytes, {
          async afterLinkBeforeRead({ outputPath: linkedPath }) {
            await rm(linkedPath, { force: true });
            await writeFile(linkedPath, competitor);
          },
          randomSuffix: () => "4".repeat(32),
        }),
      (error) => {
        captured = error;
        return (
          error instanceof NativeCandidateMeasuredEvidenceError &&
          error.code === "MEASURED_EVIDENCE_FINAL_OWNERSHIP_RACE" &&
          error.competitorPreserved === true &&
          error.ownedCleanupCompleted === true
        );
      },
    );
    assert.equal(captured.cause.code, "MEASURED_EVIDENCE_PERSISTED_IDENTITY");
    assert.deepEqual(await readFile(outputPath), competitor);
    assert.deepEqual(await readdir(root), ["after-link.json"]);
  });

  await t.test("staging path replacement", async (subtest) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "meetingrelay-measured-publish-"));
    subtest.after(() => rm(root, { force: true, recursive: true }));
    const outputPath = path.join(root, "staging-race.json");
    const bytes = Buffer.from(encodeCanonicalJsonLine(evidenceRecord()), "utf8");
    const competitor = Buffer.from("post-link staging competitor", "utf8");
    let competitorPath;
    await assert.rejects(
      () =>
        publishNativeCandidateMeasuredEvidence(outputPath, bytes, {
          async afterLinkBeforeRead({ stagingPath }) {
            competitorPath = stagingPath;
            await rm(stagingPath, { force: true });
            await writeFile(stagingPath, competitor);
          },
          randomSuffix: () => "5".repeat(32),
        }),
      (error) =>
        error instanceof NativeCandidateMeasuredEvidenceError &&
        error.code === "MEASURED_EVIDENCE_STAGING_OWNERSHIP_RACE" &&
        error.competitorPreserved === true &&
        error.ownedCleanupCompleted === true,
    );
    await assert.rejects(lstat(outputPath), { code: "ENOENT" });
    assert.deepEqual(await readFile(competitorPath), competitor);
    assert.deepEqual(await readdir(root), [path.basename(competitorPath)]);
  });

  await t.test("final replacement after persisted validation", async (subtest) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "meetingrelay-measured-publish-"));
    subtest.after(() => rm(root, { force: true, recursive: true }));
    const outputPath = path.join(root, "cleanup-window.json");
    const bytes = Buffer.from(encodeCanonicalJsonLine(evidenceRecord()), "utf8");
    const competitor = Buffer.from("cleanup-window competitor", "utf8");
    await assert.rejects(
      () =>
        publishNativeCandidateMeasuredEvidence(outputPath, bytes, {
          async beforeCleanup({ outputPath: linkedPath }) {
            await rm(linkedPath, { force: true });
            await writeFile(linkedPath, competitor);
          },
          randomSuffix: () => "6".repeat(32),
        }),
      (error) =>
        error instanceof NativeCandidateMeasuredEvidenceError &&
        error.code === "MEASURED_EVIDENCE_FINAL_OWNERSHIP_RACE" &&
        error.competitorPreserved === true &&
        error.ownedCleanupCompleted === true,
    );
    assert.deepEqual(await readFile(outputPath), competitor);
    assert.deepEqual(await readdir(root), ["cleanup-window.json"]);
  });
});

test("link failure and persisted partial output clean every owned name", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "meetingrelay-measured-publish-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const bytes = Buffer.from(encodeCanonicalJsonLine(evidenceRecord()), "utf8");
  const firstOutput = path.join(root, "link-failure.json");
  await assertRejectsCode(
    () =>
      publishNativeCandidateMeasuredEvidence(firstOutput, bytes, {
        async linkFile() {
          throw new Error("injected link failure");
        },
        randomSuffix: () => "1".repeat(32),
      }),
    "MEASURED_EVIDENCE_OUTPUT",
  );
  assert.deepEqual(await readdir(root), []);

  const secondOutput = path.join(root, "partial.json");
  let reads = 0;
  await assertRejectsCode(
    () =>
      publishNativeCandidateMeasuredEvidence(secondOutput, bytes, {
        randomSuffix: () => "2".repeat(32),
        async readFileBytes(inputPath) {
          reads += 1;
          return reads === 1 ? readFile(inputPath) : Buffer.from("partial", "utf8");
        },
      }),
    "MEASURED_EVIDENCE_PERSISTED",
  );
  assert.deepEqual(await readdir(root), []);
});

test("cleanup failure is explicit and never leaves a final evidence name", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "meetingrelay-measured-publish-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const outputPath = path.join(root, "cleanup-failure.json");
  const bytes = Buffer.from(encodeCanonicalJsonLine(evidenceRecord()), "utf8");
  let captured;
  await assert.rejects(
    () =>
      publishNativeCandidateMeasuredEvidence(outputPath, bytes, {
        async beforeCleanup() {
          throw new Error("injected cleanup failure");
        },
        randomSuffix: () => "3".repeat(32),
      }),
    (error) => {
      captured = error;
      return (
        error instanceof NativeCandidateMeasuredEvidenceError &&
        error.code === "MEASURED_EVIDENCE_CLEANUP" &&
        error.cleanupCompleted === false
      );
    },
  );
  await assert.rejects(lstat(outputPath), { code: "ENOENT" });
  assert.equal(path.dirname(captured.cleanupPath), root);
  assert.match(path.basename(captured.cleanupPath), /^\.cleanup-failure\.json\./u);
  assert.equal((await readdir(root)).length, 1);
});

test("output overlap and unknown run input keys fail before proposal", async (t) => {
  const fixture = await createFixture(t);
  let proposalCalls = 0;
  await assertRejectsCode(
    () =>
      __runNativeCandidateMeasuredEvidenceForTest(
        {
          ...fixture.input,
          outputEvidencePath: path.join(fixture.outputBundleRoot, "evidence.json"),
        },
        fixture.dependencies({
          async propose() {
            proposalCalls += 1;
          },
        }),
      ),
    "MEASURED_EVIDENCE_OUTPUT_OVERLAP",
  );
  assert.equal(proposalCalls, 0);
  await assertRejectsCode(
    () =>
      __runNativeCandidateMeasuredEvidenceForTest(
        { ...fixture.input, unexpected: true },
        fixture.dependencies({
          async propose() {
            proposalCalls += 1;
          },
        }),
      ),
    "MEASURED_EVIDENCE_INPUT_KEYS",
  );
  assert.equal(proposalCalls, 0);
});

test("validation CLI accepts one strict evidence file and rejects run-like arguments", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "meetingrelay-measured-cli-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const evidencePath = path.join(root, "evidence.json");
  await writeFile(
    evidencePath,
    Buffer.from(encodeCanonicalJsonLine(evidenceRecord()), "utf8"),
  );
  const validated = await validateNativeCandidateMeasuredEvidenceFile(evidencePath);
  const result = spawnSync(
    process.execPath,
    [path.join(HERE, "native-candidate-measured-evidence.mjs"), "--validate", evidencePath],
    { cwd: REPO_ROOT, encoding: "utf8", windowsHide: true },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    new RegExp(
      `evidence_sha256=${validated.evidenceSha256} .*scope=native-contract-stage-only formal_claims=none production_evidence=false\\n$`,
      "u",
    ),
  );
  const rejected = spawnSync(
    process.execPath,
    [path.join(HERE, "native-candidate-measured-evidence.mjs"), "--run", evidencePath],
    { cwd: REPO_ROOT, encoding: "utf8", windowsHide: true },
  );
  assert.notEqual(rejected.status, 0);
  assert.equal(rejected.stdout, "");
  assert.equal(rejected.stderr, "MEASURED_EVIDENCE_USAGE\n");
});
