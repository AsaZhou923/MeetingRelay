import { createHash } from "node:crypto";

import { encodeCanonicalJson } from "../phase0-harness/canonical-json.mjs";
import {
  HW_REF_ID,
  validateArtifactPath,
  validateCollectorOnlyMeasuredHardwareReference,
  validatePlannedCandidateManifest,
} from "../phase0-harness/candidate-artifact-contract.mjs";

const PLAN_KIND = "meetingrelay-sherpa-candidate-input-bundle-plan-v1";
const PLAN_SCHEMA_VERSION = "1.0";
const CANDIDATE_PLAN_KIND = "meetingrelay-sherpa-candidate-input-plan-v1";
const CANDIDATE_PLAN_SCHEMA_VERSION = "1.0";
const CONTRACT_MANIFEST_PATH = "contract-manifest.json";
const CONTRACT_SEAL_PATH = "contract-manifest.sha256";
const CANDIDATE_MANIFEST_PATH = "manifests/candidate-manifest.json";
const FIXTURE_SET_MANIFEST_PATH = "manifests/fixture-set-manifest.json";
const HW_REF_PATH = "manifests/hw-ref.json";
const RUN_PLAN_PATH = "manifests/run-plan.json";
const HARNESS_PLAN_PATH = "assets/input-only-harness-plan.json";
const VAD_ENDPOINT_PLAN_PATH = "assets/vad-endpoint-plan.json";
const WARMUP_PLAN_PATH = "assets/warmup-plan.json";
const HW_REF_COLLECTOR_ASSET_PATH = "assets/hw-ref-collector.mjs";
const HW_REF_COLLECTOR_SOURCE_PATH =
  "tools/phase0-harness/hw-ref-collector.mjs";
const MAX_U64 = (1n << 64n) - 1n;
const DIGEST = /^[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const PROJECT_COMMIT_URL_PREFIX =
  "https://github.com/AsaZhou923/MeetingRelay/commit/";

const REQUIRED_SOURCE_ROOTS = new Set([
  "repository",
  "rust-target",
  "sherpa-model-extraction",
  "sherpa-runtime-extraction",
]);

const WRAPPER_PATHS = Object.freeze([
  HARNESS_PLAN_PATH,
  VAD_ENDPOINT_PLAN_PATH,
  WARMUP_PLAN_PATH,
  FIXTURE_SET_MANIFEST_PATH,
  HW_REF_PATH,
  RUN_PLAN_PATH,
]);

export class CandidateInputBundlePlanError extends Error {
  constructor(code, message, field = null) {
    super(`${code}: ${message}${field === null ? "" : ` (${field})`}`);
    this.name = "CandidateInputBundlePlanError";
    this.code = code;
    this.field = field;
  }
}

function fail(code, message, field = null) {
  throw new CandidateInputBundlePlanError(code, message, field);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function exactKeys(value, expected, field) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("BUNDLE_PLAN_TYPE", "expected an object", field);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    fail(
      "BUNDLE_PLAN_KEYS",
      `expected keys ${wanted.join(",")}, got ${actual.join(",")}`,
      field,
    );
  }
}

function digest(value, field) {
  if (typeof value !== "string" || !DIGEST.test(value) || value === "0".repeat(64)) {
    fail("BUNDLE_PLAN_DIGEST", "expected a non-zero lowercase SHA-256", field);
  }
  return value;
}

function canonicalU64(value, field, minimum = 1n) {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/u.test(value)) {
    fail("BUNDLE_PLAN_U64", "expected a canonical uint64 string", field);
  }
  const parsed = BigInt(value);
  if (parsed < minimum || parsed > MAX_U64) {
    fail("BUNDLE_PLAN_U64", "value is outside uint64 bounds", field);
  }
  return value;
}

function canonicalJsonMaterial(targetPath, value) {
  const bytes = Buffer.from(encodeCanonicalJson(value), "utf8");
  return {
    bytes,
    kind: "document",
    sha256: sha256(bytes),
    size_bytes: String(bytes.length),
    target_path: targetPath,
  };
}

function documentMaterial(targetPath, bytes) {
  const output = Buffer.from(bytes);
  return {
    bytes: output,
    kind: "document",
    sha256: sha256(output),
    size_bytes: String(output.length),
    target_path: targetPath,
  };
}

function parseCanonicalDocument(material, field) {
  if (!Buffer.isBuffer(material.bytes)) {
    fail("BUNDLE_PLAN_BUFFER", "document bytes must be a Buffer", `${field}.bytes`);
  }
  const bytes = Buffer.from(material.bytes);
  if (
    sha256(bytes) !== material.sha256 ||
    String(bytes.length) !== material.size_bytes
  ) {
    fail("BUNDLE_PLAN_DIGEST", "document bytes differ from their identity", field);
  }
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    fail(
      "BUNDLE_PLAN_JSON",
      error instanceof Error ? error.message : "invalid JSON",
      field,
    );
  }
  if (!Buffer.from(encodeCanonicalJson(value), "utf8").equals(bytes)) {
    fail("BUNDLE_PLAN_CANONICAL", "document must be canonical JSON", field);
  }
  return { bytes, value };
}

function validateAndCloneCandidatePlan(candidatePlan) {
  exactKeys(candidatePlan, ["kind", "materials", "schema_version"], "candidatePlan");
  if (
    candidatePlan.kind !== CANDIDATE_PLAN_KIND ||
    candidatePlan.schema_version !== CANDIDATE_PLAN_SCHEMA_VERSION
  ) {
    fail("BUNDLE_PLAN_VALUE", "candidate plan identity differs", "candidatePlan");
  }
  if (!Array.isArray(candidatePlan.materials) || candidatePlan.materials.length !== 20) {
    fail("BUNDLE_PLAN_COUNT", "candidate plan must contain exactly 20 materials", "candidatePlan.materials");
  }

  const cloned = [];
  const paths = new Set();
  let previousPath = null;
  for (const [index, material] of candidatePlan.materials.entries()) {
    const field = `candidatePlan.materials[${index}]`;
    if (material?.kind === "copy") {
      exactKeys(
        material,
        [
          "kind",
          "sha256",
          "size_bytes",
          "source_relative_path",
          "source_root",
          "target_path",
        ],
        field,
      );
      if (!REQUIRED_SOURCE_ROOTS.has(material.source_root)) {
        fail("BUNDLE_PLAN_VALUE", "copy material source root differs", `${field}.source_root`);
      }
      validateArtifactPath(material.source_relative_path, `${field}.source_relative_path`);
      cloned.push({
        kind: "copy",
        sha256: material.sha256,
        size_bytes: material.size_bytes,
        source_relative_path: material.source_relative_path,
        source_root: material.source_root,
        target_path: material.target_path,
      });
    } else if (material?.kind === "document") {
      exactKeys(
        material,
        ["bytes", "kind", "sha256", "size_bytes", "target_path"],
        field,
      );
      if (!Buffer.isBuffer(material.bytes)) {
        fail("BUNDLE_PLAN_BUFFER", "document bytes must be a Buffer", `${field}.bytes`);
      }
      const bytes = Buffer.from(material.bytes);
      if (
        sha256(bytes) !== material.sha256 ||
        String(bytes.length) !== material.size_bytes
      ) {
        fail("BUNDLE_PLAN_DIGEST", "document bytes differ from their identity", field);
      }
      cloned.push({
        bytes,
        kind: "document",
        sha256: material.sha256,
        size_bytes: material.size_bytes,
        target_path: material.target_path,
      });
    } else {
      fail("BUNDLE_PLAN_KIND", "material kind must be copy or document", `${field}.kind`);
    }

    validateArtifactPath(material.target_path, `${field}.target_path`);
    digest(material.sha256, `${field}.sha256`);
    canonicalU64(material.size_bytes, `${field}.size_bytes`);
    if (paths.has(material.target_path)) {
      fail("BUNDLE_PLAN_DUPLICATE", "material target path is duplicated", `${field}.target_path`);
    }
    if (previousPath !== null && previousPath >= material.target_path) {
      fail("BUNDLE_PLAN_ORDER", "candidate materials must be strictly sorted", field);
    }
    if (
      WRAPPER_PATHS.includes(material.target_path) ||
      material.target_path === CONTRACT_MANIFEST_PATH ||
      material.target_path === CONTRACT_SEAL_PATH ||
      material.target_path.startsWith("evidence/")
    ) {
      fail("BUNDLE_PLAN_BOUNDARY", "candidate material crosses the bundle wrapper boundary", field);
    }
    paths.add(material.target_path);
    previousPath = material.target_path;
  }

  const candidateMaterials = cloned.filter(
    (material) => material.target_path === CANDIDATE_MANIFEST_PATH,
  );
  if (candidateMaterials.length !== 1 || candidateMaterials[0].kind !== "document") {
    fail("BUNDLE_PLAN_COUNT", "candidate manifest document must appear exactly once", CANDIDATE_MANIFEST_PATH);
  }
  const parsedCandidate = parseCanonicalDocument(
    candidateMaterials[0],
    CANDIDATE_MANIFEST_PATH,
  ).value;
  const plannedEntries = new Map(
    cloned
      .filter((material) => material.target_path !== CANDIDATE_MANIFEST_PATH)
      .map((material) => [
        material.target_path,
        { sha256: material.sha256, size_bytes: material.size_bytes },
      ]),
  );
  validatePlannedCandidateManifest(parsedCandidate, plannedEntries);
  if (
    parsedCandidate.artifact_scope !== "candidate-input" ||
    parsedCandidate.publishability_status !== "pending" ||
    parsedCandidate.selection_status !== "not-selected" ||
    parsedCandidate.claims?.formal_claims !== "none" ||
    parsedCandidate.claims?.production_evidence !== false ||
    parsedCandidate.claims?.formal_metric_ids?.length !== 0 ||
    parsedCandidate.claims?.production_claims?.length !== 0 ||
    parsedCandidate.claims?.slo_claims?.length !== 0
  ) {
    fail("BUNDLE_PLAN_AUTHORITY", "candidate exceeds input-only planning authority", CANDIDATE_MANIFEST_PATH);
  }
  if (
    typeof parsedCandidate.source?.source_revision !== "string" ||
    !COMMIT.test(parsedCandidate.source.source_revision) ||
    parsedCandidate.source.source_revision === "0".repeat(40)
  ) {
    fail("BUNDLE_PLAN_VALUE", "candidate source revision must be a non-zero 40-hex commit", "candidate.source.source_revision");
  }
  if (
    parsedCandidate.source.source_url !==
    `${PROJECT_COMMIT_URL_PREFIX}${parsedCandidate.source.source_revision}`
  ) {
    fail(
      "BUNDLE_PLAN_JOIN",
      "candidate source URL does not join its MeetingRelay source revision",
      "candidate.source.source_url",
    );
  }
  return { candidate: parsedCandidate, materials: cloned };
}

function validateFixtureProjection(projection) {
  exactKeys(
    projection,
    [
      "audioPath",
      "audioSha256",
      "fixtureId",
      "fixtures",
      "manifestSha256",
      "pcmSha256",
      "referenceSha256",
    ],
    "fixtureRegistryProjection",
  );
  digest(projection.manifestSha256, "fixtureRegistryProjection.manifestSha256");
  if (!Array.isArray(projection.fixtures) || projection.fixtures.length !== 1) {
    fail("BUNDLE_PLAN_COUNT", "fixture projection must contain the verified calibration fixture", "fixtureRegistryProjection.fixtures");
  }
  const fixtures = projection.fixtures.map((fixture, index) => {
    const field = `fixtureRegistryProjection.fixtures[${index}]`;
    exactKeys(
      fixture,
      ["audioPath", "audioSha256", "fixtureId", "pcmSha256", "referenceSha256"],
      field,
    );
    validateArtifactPath(fixture.audioPath, `${field}.audioPath`);
    for (const key of ["audioSha256", "pcmSha256", "referenceSha256"]) {
      digest(fixture[key], `${field}.${key}`);
    }
    if (
      typeof fixture.fixtureId !== "string" ||
      !/^[A-Za-z0-9._-]+$/u.test(fixture.fixtureId)
    ) {
      fail("BUNDLE_PLAN_VALUE", "fixture ID differs", `${field}.fixtureId`);
    }
    return { ...fixture };
  });
  const first = fixtures[0];
  for (const key of [
    "audioPath",
    "audioSha256",
    "fixtureId",
    "pcmSha256",
    "referenceSha256",
  ]) {
    if (projection[key] !== first[key]) {
      fail("BUNDLE_PLAN_JOIN", "fixture summary differs from its fixture list", `fixtureRegistryProjection.${key}`);
    }
  }
  return { fixtures, manifestSha256: projection.manifestSha256 };
}

function validateMeasuredSourceDescriptor(source, field) {
  exactKeys(source, ["path", "sha256", "size_bytes"], field);
  if (
    typeof source.path !== "string" ||
    source.path.length === 0 ||
    source.path.includes("\0")
  ) {
    fail("BUNDLE_PLAN_VALUE", "measured source path differs", `${field}.path`);
  }
  digest(source.sha256, `${field}.sha256`);
  canonicalU64(source.size_bytes, `${field}.size_bytes`);
  return { ...source };
}

function claims() {
  return {
    formal_claims: "none",
    formal_metric_ids: [],
    production_claims: [],
    production_evidence: false,
    slo_claims: [],
  };
}

function artifactByRole(candidate, role) {
  const matches = candidate.artifacts.filter((artifact) => artifact.role === role);
  if (matches.length !== 1) {
    fail("BUNDLE_PLAN_JOIN", `candidate role ${role} must appear exactly once`, role);
  }
  return matches[0];
}

function buildWrappers(candidate, fixtureProjection, candidateMaterials) {
  const candidateEntries = new Map(
    candidateMaterials.map((material) => [material.target_path, material]),
  );
  const worker = artifactByRole(candidate, "worker-executable");
  const cargoLock = artifactByRole(candidate, "package-lock");
  const schemaRegistry = artifactByRole(candidate, "schema-registry");
  const parameters = artifactByRole(candidate, "parameters");
  const model = artifactByRole(candidate, "model");
  const descriptor = candidate.worker_manifest_projection.descriptor;
  if (
    worker.sha256 !== candidate.worker_manifest_projection.executable_sha256 ||
    cargoLock.sha256 !== descriptor.package_lock_sha256 ||
    parameters.sha256 !== descriptor.parameter_sha256 ||
    model.sha256 !== descriptor.model_sha256 ||
    schemaRegistry.sha256 !== candidate.worker_manifest_projection.schema_registry_sha256
  ) {
    fail("BUNDLE_PLAN_JOIN", "candidate projection differs from its material roles", CANDIDATE_MANIFEST_PATH);
  }
  for (const artifact of [worker, cargoLock, schemaRegistry, parameters, model]) {
    if (candidateEntries.get(artifact.path)?.sha256 !== artifact.sha256) {
      fail("BUNDLE_PLAN_JOIN", "candidate artifact differs from planned material", artifact.path);
    }
  }

  const fixtureSetId = `fixture-set-${candidate.candidate_id}`;
  const runPlanId = `run-plan-${candidate.candidate_id}`;
  const evidenceManifestId = `evidence-${candidate.candidate_id}-pending`;
  const fixtureSet = {
    artifact_scope: "candidate-run-input",
    fixture_set_id: fixtureSetId,
    fixtures: fixtureProjection.fixtures.map((fixture) => ({
      audio_path: fixture.audioPath,
      audio_sha256: fixture.audioSha256,
      fixture_id: fixture.fixtureId,
      pcm_sha256: fixture.pcmSha256,
      reference_sha256: fixture.referenceSha256,
    })),
    quality_evidence: false,
    registry: {
      path: "test-fixtures/manifest.json",
      sha256: fixtureProjection.manifestSha256,
    },
    schema_version: "1.0",
  };
  const hardware = {
    capture_scope: "contract-fixture",
    captured_at: null,
    claims: claims(),
    collector: {
      path: schemaRegistry.path,
      sha256: schemaRegistry.sha256,
      version: "meetingrelay-hw-ref-contract-fixture-v1",
    },
    environment: {
      audio_devices: [
        {
          driver_version: "not-measured",
          logical_role: "contract-fixture",
          model: "not-measured",
          signature_status: "not-measured",
          vendor: "not-measured",
        },
      ],
      background_process_allowlist: [],
      bios: {
        release_date: null,
        vendor: "contract-fixture",
        version: "not-measured",
      },
      cooling: { ambient_celsius: null, mode: "not-measured" },
      cpu: {
        logical_processor_count: null,
        model: "contract-fixture",
        physical_core_count: null,
        vendor: "contract-fixture",
      },
      gpus: [
        {
          driver_version: "not-measured",
          execution_providers: [],
          model: "not-measured",
          vendor: "not-measured",
          vram_bytes: null,
        },
      ],
      memory: { total_bytes: null },
      operating_system: {
        architecture: "x64",
        build: "not-measured",
        product: "Windows",
        ubr: null,
        version: "not-measured",
      },
      power: { plan: "not-measured", source: "not-measured" },
      storage: [
        {
          capacity_bytes: null,
          driver_version: "not-measured",
          filesystem: "not-measured",
          medium: "not-measured",
          model: "not-measured",
          vendor: "not-measured",
        },
      ],
    },
    hardware_tier: "HW-REF",
    hw_ref_id: HW_REF_ID,
    measurement_status: "not-measured",
    privacy_class: "contract-fixture-public-safe",
    privacy_policy: "no-stable-device-identifiers-v1",
    schema_version: "1.0",
  };
  const harnessPlan = {
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
  };
  const vadEndpointPlan = {
    artifact_scope: "candidate-input",
    endpoint: { max_segment_ms: "30000", min_silence_ms: "300" },
    formal_claims: "none",
    schema_version: "1.0",
    vad: { frame_ms: "20", threshold_basis_points: "5000" },
  };
  const warmupPlan = {
    actions: ["load-model", "prime-synthetic-calibration-fixture"],
    artifact_scope: "candidate-input",
    formal_claims: "none",
    schema_version: "1.0",
  };

  const initial = [
    canonicalJsonMaterial(HARNESS_PLAN_PATH, harnessPlan),
    canonicalJsonMaterial(VAD_ENDPOINT_PLAN_PATH, vadEndpointPlan),
    canonicalJsonMaterial(WARMUP_PLAN_PATH, warmupPlan),
    canonicalJsonMaterial(FIXTURE_SET_MANIFEST_PATH, fixtureSet),
    canonicalJsonMaterial(HW_REF_PATH, hardware),
  ];
  const wrapperEntries = new Map(initial.map((material) => [material.target_path, material]));
  const firstFixture = fixtureSet.fixtures[0];
  const runPlan = {
    build_profile: "release",
    candidate_ids: [candidate.candidate_id],
    claims: claims(),
    evidence_manifest_id: evidenceManifestId,
    execution_status: "planned",
    fixture_ids: fixtureSet.fixtures.map((fixture) => fixture.fixture_id),
    fixture_set_id: fixtureSetId,
    harness: {
      command: {
        argv: [],
        cwd: "assets",
        executable_path: worker.path,
      },
      core: {
        path: HARNESS_PLAN_PATH,
        sha256: wrapperEntries.get(HARNESS_PLAN_PATH).sha256,
      },
      environment_allowlist: [],
      lockfile: { path: cargoLock.path, sha256: cargoLock.sha256 },
      ui: {
        path: HARNESS_PLAN_PATH,
        sha256: wrapperEntries.get(HARNESS_PLAN_PATH).sha256,
      },
    },
    hw_ref_id: HW_REF_ID,
    network_policy: "offline-only",
    order_policy: "seeded-round-robin-v1",
    run_plan_id: runPlanId,
    same_condition_contract: {
      audio_playback_path: `test-fixtures/${firstFixture.audio_path}`,
      batch_size: "1",
      cooling_mode: hardware.environment.cooling.mode,
      endpoint_parameters: {
        path: VAD_ENDPOINT_PLAN_PATH,
        sha256: wrapperEntries.get(VAD_ENDPOINT_PLAN_PATH).sha256,
      },
      execution_provider: descriptor.execution_provider,
      log_level: "info",
      model_sha256: model.sha256,
      parameter_sha256: parameters.sha256,
      pcm_sha256: firstFixture.pcm_sha256,
      power_plan: hardware.environment.power.plan,
      quantization: descriptor.quantization,
      thread_count: "1",
      translation_fixture_ids: [],
      vad_parameters: {
        path: VAD_ENDPOINT_PLAN_PATH,
        sha256: wrapperEntries.get(VAD_ENDPOINT_PLAN_PATH).sha256,
      },
      warmup_plan: {
        path: WARMUP_PLAN_PATH,
        sha256: wrapperEntries.get(WARMUP_PLAN_PATH).sha256,
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
  };
  initial.push(canonicalJsonMaterial(RUN_PLAN_PATH, runPlan));
  return initial;
}

function freezePlan(plan) {
  for (const material of plan.materials) Object.freeze(material);
  Object.freeze(plan.materials);
  return Object.freeze(plan);
}

/**
 * Purely derives a proposed, sealed candidate-input bundle plan. The returned
 * digest is not an external trust decision and is never named as an expected
 * contract digest.
 */
export function buildSherpaCandidateInputBundlePlan(input) {
  exactKeys(input, ["candidatePlan", "fixtureRegistryProjection"], "input");
  const { candidate, materials: candidateMaterials } = validateAndCloneCandidatePlan(
    input.candidatePlan,
  );
  const fixtureProjection = validateFixtureProjection(input.fixtureRegistryProjection);
  const wrapperMaterials = buildWrappers(
    candidate,
    fixtureProjection,
    candidateMaterials,
  );
  const contractInputs = [...candidateMaterials, ...wrapperMaterials].sort((left, right) =>
    compareStrings(left.target_path, right.target_path),
  );
  if (
    contractInputs.length !== 26 ||
    contractInputs.filter((material) => material.kind === "copy").length !== 17 ||
    contractInputs.filter((material) => material.kind === "document").length !== 9 ||
    new Set(contractInputs.map((material) => material.target_path)).size !== 26 ||
    contractInputs.some(
      (material, index) =>
        index > 0 && contractInputs[index - 1].target_path >= material.target_path,
    )
  ) {
    fail("BUNDLE_PLAN_COUNT", "sealed input inventory must be 26 unique sorted entries", "materials");
  }
  const contract = {
    contract_id: `contract-${candidate.candidate_id}-input-v1`,
    entries: contractInputs.map((material) => ({
      path: material.target_path,
      sha256: material.sha256,
      size_bytes: material.size_bytes,
    })),
    formal_claims: "none",
    schema_version: "1.0",
  };
  const contractMaterial = canonicalJsonMaterial(CONTRACT_MANIFEST_PATH, contract);
  const proposedContractSha256 = contractMaterial.sha256;
  const sealMaterial = documentMaterial(
    CONTRACT_SEAL_PATH,
    Buffer.from(`${proposedContractSha256}  ${CONTRACT_MANIFEST_PATH}\n`, "ascii"),
  );
  const materials = [...contractInputs, contractMaterial, sealMaterial].sort((left, right) =>
    compareStrings(left.target_path, right.target_path),
  );
  if (
    materials.length !== 28 ||
    materials.filter((material) => material.kind === "copy").length !== 17 ||
    materials.filter((material) => material.kind === "document").length !== 11 ||
    new Set(materials.map((material) => material.target_path)).size !== 28
  ) {
    fail("BUNDLE_PLAN_COUNT", "bundle plan must contain 28 unique materials", "materials");
  }
  return freezePlan({
    kind: PLAN_KIND,
    materials,
    proposedContractSha256,
    schema_version: PLAN_SCHEMA_VERSION,
  });
}

/**
 * Derives the measured-HW variant of the sealed candidate-input plan. The
 * caller remains responsible for reading both source files and supplying
 * their independently calculated identities; this pure function grants no
 * filesystem or trust authority.
 */
export function buildMeasuredSherpaCandidateInputBundlePlan(input) {
  exactKeys(
    input,
    [
      "candidatePlan",
      "collectorSource",
      "fixtureRegistryProjection",
      "measuredHardwareReference",
      "measuredHardwareReferenceSource",
    ],
    "input",
  );
  const collectorSource = validateMeasuredSourceDescriptor(
    input.collectorSource,
    "collectorSource",
  );
  if (collectorSource.path !== HW_REF_COLLECTOR_SOURCE_PATH) {
    fail(
      "BUNDLE_PLAN_JOIN",
      "collector source must be the repository-owned measured HW collector",
      "collectorSource.path",
    );
  }
  validateArtifactPath(collectorSource.path, "collectorSource.path");
  const measuredHardwareReferenceSource = validateMeasuredSourceDescriptor(
    input.measuredHardwareReferenceSource,
    "measuredHardwareReferenceSource",
  );
  validateCollectorOnlyMeasuredHardwareReference(
    input.measuredHardwareReference,
  );
  const hardwareMaterial = canonicalJsonMaterial(
    HW_REF_PATH,
    input.measuredHardwareReference,
  );
  if (
    measuredHardwareReferenceSource.sha256 !== hardwareMaterial.sha256 ||
    measuredHardwareReferenceSource.size_bytes !== hardwareMaterial.size_bytes
  ) {
    fail(
      "BUNDLE_PLAN_JOIN",
      "measured HW source identity differs from its canonical document bytes",
      "measuredHardwareReferenceSource",
    );
  }
  if (
    input.measuredHardwareReference.collector.path !==
      HW_REF_COLLECTOR_ASSET_PATH ||
    input.measuredHardwareReference.collector.sha256 !== collectorSource.sha256
  ) {
    fail(
      "BUNDLE_PLAN_JOIN",
      "measured HW collector identity differs from the repository source copy",
      "measuredHardwareReference.collector",
    );
  }

  const legacyPlan = buildSherpaCandidateInputBundlePlan({
    candidatePlan: input.candidatePlan,
    fixtureRegistryProjection: input.fixtureRegistryProjection,
  });
  const legacyContractMaterial = legacyPlan.materials.find(
    (material) => material.target_path === CONTRACT_MANIFEST_PATH,
  );
  const legacyRunPlanMaterial = legacyPlan.materials.find(
    (material) => material.target_path === RUN_PLAN_PATH,
  );
  const legacyContract = parseCanonicalDocument(
    legacyContractMaterial,
    CONTRACT_MANIFEST_PATH,
  ).value;
  const runPlan = parseCanonicalDocument(
    legacyRunPlanMaterial,
    RUN_PLAN_PATH,
  ).value;
  runPlan.hw_ref_id = input.measuredHardwareReference.hw_ref_id;
  runPlan.same_condition_contract.cooling_mode =
    input.measuredHardwareReference.environment.cooling.mode;
  runPlan.same_condition_contract.power_plan =
    input.measuredHardwareReference.environment.power.plan;
  const runPlanMaterial = canonicalJsonMaterial(RUN_PLAN_PATH, runPlan);
  const collectorMaterial = {
    kind: "copy",
    sha256: collectorSource.sha256,
    size_bytes: collectorSource.size_bytes,
    source_relative_path: HW_REF_COLLECTOR_SOURCE_PATH,
    source_root: "repository",
    target_path: HW_REF_COLLECTOR_ASSET_PATH,
  };
  const contractInputs = [
    ...legacyPlan.materials.filter(
      (material) =>
        ![
          CONTRACT_MANIFEST_PATH,
          CONTRACT_SEAL_PATH,
          HW_REF_PATH,
          RUN_PLAN_PATH,
        ].includes(material.target_path),
    ),
    collectorMaterial,
    hardwareMaterial,
    runPlanMaterial,
  ].sort((left, right) => compareStrings(left.target_path, right.target_path));
  if (
    contractInputs.length !== 27 ||
    contractInputs.filter((material) => material.kind === "copy").length !== 18 ||
    contractInputs.filter((material) => material.kind === "document").length !== 9 ||
    new Set(contractInputs.map((material) => material.target_path)).size !== 27
  ) {
    fail(
      "BUNDLE_PLAN_COUNT",
      "measured sealed input inventory must be 27 unique entries",
      "materials",
    );
  }
  const contract = {
    contract_id: legacyContract.contract_id,
    entries: contractInputs.map((material) => ({
      path: material.target_path,
      sha256: material.sha256,
      size_bytes: material.size_bytes,
    })),
    formal_claims: "none",
    schema_version: "1.0",
  };
  const contractMaterial = canonicalJsonMaterial(CONTRACT_MANIFEST_PATH, contract);
  const proposedContractSha256 = contractMaterial.sha256;
  const sealMaterial = documentMaterial(
    CONTRACT_SEAL_PATH,
    Buffer.from(`${proposedContractSha256}  ${CONTRACT_MANIFEST_PATH}\n`, "ascii"),
  );
  const materials = [...contractInputs, contractMaterial, sealMaterial].sort(
    (left, right) => compareStrings(left.target_path, right.target_path),
  );
  if (
    materials.length !== 29 ||
    materials.filter((material) => material.kind === "copy").length !== 18 ||
    materials.filter((material) => material.kind === "document").length !== 11 ||
    new Set(materials.map((material) => material.target_path)).size !== 29
  ) {
    fail(
      "BUNDLE_PLAN_COUNT",
      "measured bundle plan must contain 29 unique materials",
      "materials",
    );
  }
  return freezePlan({
    kind: PLAN_KIND,
    materials,
    proposedContractSha256,
    schema_version: "1.1",
  });
}

export const candidateInputBundlePlanPaths = Object.freeze({
  collectorAsset: HW_REF_COLLECTOR_ASSET_PATH,
  collectorSource: HW_REF_COLLECTOR_SOURCE_PATH,
  contractManifest: CONTRACT_MANIFEST_PATH,
  contractSeal: CONTRACT_SEAL_PATH,
  wrappers: WRAPPER_PATHS,
});
