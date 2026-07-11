import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { encodeCanonicalJson } from "./canonical-json.mjs";
import {
  fixturePaths,
  sha256,
  validateFixtureTree,
} from "./fixture-contract.mjs";

export const CONTRACT_TEST_ID = "CT-WORKER-ARTIFACT-001";
export const CANDIDATE_ID = "candidate-contract-fixture-001";
export const FIXTURE_SET_ID = "fixture-set-contract-fixture-001";
export const HW_REF_ID = "hw-ref-contract-fixture-001";
export const RUN_PLAN_ID = "run-plan-contract-fixture-001";
export const EVIDENCE_MANIFEST_ID = "evidence-contract-fixture-001";
export const LICENSE_ID = "license-project-generated";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(MODULE_DIR, "..", "..");
const DEFAULT_BUNDLE_ROOT = path.join(
  REPOSITORY_ROOT,
  "target",
  "wp-0.4",
  "ct-candidate-artifact-001",
);

const CONTRACT_MANIFEST_PATH = "contract-manifest.json";
const CONTRACT_SEAL_PATH = "contract-manifest.sha256";
const CANDIDATE_MANIFEST_PATH = "manifests/candidate-manifest.json";
const FIXTURE_SET_MANIFEST_PATH = "manifests/fixture-set-manifest.json";
const HW_REF_PATH = "manifests/hw-ref.json";
const RUN_PLAN_PATH = "manifests/run-plan.json";
const EVIDENCE_MANIFEST_PATH = "evidence/evidence-manifest.json";
const EVIDENCE_SEAL_PATH = "evidence/evidence-manifest.sha256";
const LICENSE_PATH = "licenses/project-generated.txt";

const ASSET_BYTES = Object.freeze({
  "assets/core-harness.bin": Buffer.from(
    "MeetingRelay WP-0.4.2 contract-only core harness bytes\n",
    "utf8",
  ),
  "assets/contract-model.bin": Buffer.from(
    "MeetingRelay WP-0.4.2 contract-only model bytes\n",
    "utf8",
  ),
  "assets/contract-runtime.bin": Buffer.from(
    "MeetingRelay WP-0.4.2 contract-only runtime bytes\n",
    "utf8",
  ),
  "assets/contract-worker.bin": Buffer.from(
    "MeetingRelay WP-0.4.2 contract-only worker bytes\n",
    "utf8",
  ),
  "assets/ui-harness.bin": Buffer.from(
    "MeetingRelay WP-0.4.2 contract-only UI harness bytes\n",
    "utf8",
  ),
});

const JSON_ASSETS = Object.freeze({
  "assets/model-manifest.json": {
    artifact_scope: "contract-fixture-only",
    formal_claims: "none",
    model_id: "model-contract-fixture",
    schema_version: "1.0",
  },
  "assets/package.lock": {
    artifact_scope: "contract-fixture-only",
    dependencies: [],
    formal_claims: "none",
    schema_version: "1.0",
  },
  "assets/parameters.json": {
    artifact_scope: "contract-fixture-only",
    batch_size: "1",
    formal_claims: "none",
    schema_version: "1.0",
    thread_count: "1",
  },
  "assets/schema-registry.json": {
    artifact_scope: "contract-fixture-only",
    formal_claims: "none",
    schemas: ["meetingrelay.model-worker.v1"],
    schema_version: "1.0",
  },
  "assets/vad-endpoint-plan.json": {
    artifact_scope: "contract-fixture-only",
    endpoint: {
      max_segment_ms: "30000",
      min_silence_ms: "300",
    },
    formal_claims: "none",
    schema_version: "1.0",
    vad: {
      frame_ms: "20",
      threshold_basis_points: "5000",
    },
  },
  "assets/warmup-plan.json": {
    actions: ["load-model", "prime-contract-fixture"],
    artifact_scope: "contract-fixture-only",
    formal_claims: "none",
    schema_version: "1.0",
  },
});

const LICENSE_BYTES = Buffer.from(
  [
    "MeetingRelay WP-0.4.2 project-generated contract fixture.",
    "This text covers only deterministic contract-test bytes.",
    "It does not license or approve any real runtime, model, or candidate.",
    "",
  ].join("\n"),
  "utf8",
);

const CONTRACT_INPUT_PATHS = Object.freeze(
  [
    CANDIDATE_MANIFEST_PATH,
    FIXTURE_SET_MANIFEST_PATH,
    HW_REF_PATH,
    RUN_PLAN_PATH,
    ...Object.keys(ASSET_BYTES),
    ...Object.keys(JSON_ASSETS),
    LICENSE_PATH,
  ].sort(),
);

const EXPECTED_FILES = Object.freeze(
  [
    CONTRACT_MANIFEST_PATH,
    CONTRACT_SEAL_PATH,
    ...CONTRACT_INPUT_PATHS,
    EVIDENCE_MANIFEST_PATH,
    EVIDENCE_SEAL_PATH,
  ].sort(),
);

const CLAIM_KEYS = Object.freeze([
  "formal_claims",
  "formal_metric_ids",
  "production_claims",
  "production_evidence",
  "slo_claims",
]);

const MAX_U64 = (1n << 64n) - 1n;
const MAX_RUN_COUNT = 10_000n;

export class Wp04ArtifactContractError extends Error {
  constructor(code, message, field = null) {
    super(message);
    this.name = "Wp04ArtifactContractError";
    this.code = code;
    this.field = field;
  }
}

function fail(code, message, field = null) {
  throw new Wp04ArtifactContractError(code, message, field);
}

function assertExactKeys(value, expected, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("ART_SCHEMA_TYPE", label + " must be an object", label);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    fail(
      "ART_SCHEMA_KEYS",
      label + " keys differ: " + actual.join(","),
      label,
    );
  }
}

function assertIdentifier(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 128 ||
    !/^[A-Za-z0-9._-]+$/.test(value)
  ) {
    fail("ART_SCHEMA_IDENTIFIER", label + " is not a Rust Identifier projection", label);
  }
}

function assertLanguageCode(value, label) {
  if (
    typeof value !== "string" ||
    value.length < 2 ||
    value.length > 16 ||
    !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value)
  ) {
    fail("ART_SCHEMA_LANGUAGE", label + " is not a Rust LanguageCode projection", label);
  }
}

export function assertDigest(value, label = "digest") {
  if (value === undefined || value === null || value === "") {
    fail("ART_DIGEST_MISSING", label + " is required", label);
  }
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    fail("ART_DIGEST_FORMAT", label + " must be a lowercase SHA-256 digest", label);
  }
  if (value === "0".repeat(64)) {
    fail("ART_DIGEST_ZERO", label + " cannot be the all-zero digest", label);
  }
}

function assertCanonicalU64(value, label, minimum = 0n, maximum = MAX_U64) {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    fail("ART_SCHEMA_U64", label + " must be a canonical uint64 string", label);
  }
  const parsed = BigInt(value);
  if (parsed > MAX_U64 || parsed < minimum || parsed > maximum) {
    fail("ART_SCHEMA_BOUND", label + " is outside the accepted range", label);
  }
  return parsed;
}

function parseRfc3339Nanoseconds(value, label) {
  if (typeof value !== "string") {
    fail("ART_SCHEMA_VALUE", label + " must be an RFC3339 UTC timestamp");
  }
  const match =
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/.exec(
      value,
    );
  if (!match) {
    fail("ART_SCHEMA_VALUE", label + " must be an RFC3339 UTC timestamp");
  }
  const wholeSecondMilliseconds = Date.parse(match[1] + "Z");
  if (
    !Number.isFinite(wholeSecondMilliseconds) ||
    new Date(wholeSecondMilliseconds).toISOString().slice(0, 19) !== match[1]
  ) {
    fail("ART_SCHEMA_VALUE", label + " contains an invalid calendar timestamp");
  }
  const fractionalNanoseconds = BigInt((match[2] ?? "").padEnd(9, "0") || "0");
  return BigInt(wholeSecondMilliseconds) * 1_000_000n + fractionalNanoseconds;
}

function assertUnique(values, label) {
  if (!Array.isArray(values) || values.length === 0) {
    fail("ART_SCHEMA_BOUND", label + " must be a non-empty array", label);
  }
  if (new Set(values).size !== values.length) {
    fail("ART_SCHEMA_DUPLICATE_ID", label + " contains a duplicate", label);
  }
}

export function validateArtifactPath(value, label = "path") {
  if (typeof value !== "string" || value.length === 0 || value !== value.normalize("NFC")) {
    fail("ART_PATH_FORMAT", label + " must be a non-empty NFC string", label);
  }
  if (/^(?:\\\\|\/\/)/.test(value)) {
    fail("ART_PATH_UNC", label + " cannot be a UNC path", label);
  }
  if (/^[A-Za-z]:/.test(value) || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) {
    fail("ART_PATH_ABSOLUTE", label + " cannot be absolute or drive-relative", label);
  }
  if (value.includes("\\")) {
    fail("ART_PATH_SEPARATOR", label + " must use forward slashes", label);
  }
  if (value.includes("\0") || /[\u0001-\u001f\u007f]/.test(value)) {
    fail("ART_PATH_FORMAT", label + " contains a control character", label);
  }
  const parts = value.split("/");
  if (
    parts.some(
      (part) =>
        part === "" ||
        part === "." ||
        part === ".." ||
        part.endsWith(".") ||
        part.endsWith(" "),
    )
  ) {
    fail("ART_PATH_TRAVERSAL", label + " contains an unsafe segment", label);
  }
  if (parts.some((part) => part.includes(":"))) {
    fail("ART_PATH_ADS", label + " cannot contain an NTFS alternate data stream", label);
  }
  if (
    parts.some((part) =>
      /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part),
    )
  ) {
    fail("ART_PATH_RESERVED", label + " contains a reserved Windows device name", label);
  }
  return value;
}

function resolveBundlePath(root, relativePath) {
  validateArtifactPath(relativePath);
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, ...relativePath.split("/"));
  const relative = path.relative(resolvedRoot, target);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(".." + path.sep) ||
    path.isAbsolute(relative)
  ) {
    fail("ART_PATH_TRAVERSAL", relativePath + " escapes the bundle root", relativePath);
  }
  return target;
}

async function assertRealPathComponents(root, relativePath) {
  const resolvedRoot = path.resolve(root);
  let metadata;
  try {
    metadata = await lstat(resolvedRoot);
  } catch (error) {
    if (error?.code === "ENOENT") {
      fail("ART_INVENTORY_MISMATCH", "bundle root does not exist", resolvedRoot);
    }
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    fail("ART_PATH_REPARSE_POINT", "bundle root must be a real directory", resolvedRoot);
  }
  const realRoot = await realpath(resolvedRoot);
  let current = resolvedRoot;
  for (const part of relativePath.split("/")) {
    current = path.join(current, part);
    let currentMetadata;
    try {
      currentMetadata = await lstat(current);
    } catch (error) {
      if (error?.code === "ENOENT") {
        fail("ART_INVENTORY_MISMATCH", relativePath + " is missing", relativePath);
      }
      throw error;
    }
    if (currentMetadata.isSymbolicLink()) {
      fail(
        "ART_PATH_REPARSE_POINT",
        relativePath + " crosses a symbolic link or junction",
        relativePath,
      );
    }
    const realCurrent = await realpath(current);
    const relativeReal = path.relative(realRoot, realCurrent);
    if (
      relativeReal === ".." ||
      relativeReal.startsWith(".." + path.sep) ||
      path.isAbsolute(relativeReal)
    ) {
      fail("ART_PATH_REPARSE_POINT", relativePath + " resolves outside the root", relativePath);
    }
  }
  return current;
}

async function digestRegularFile(root, relativePath) {
  const target = await assertRealPathComponents(root, relativePath);
  const metadata = await lstat(target);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    fail("ART_PATH_REPARSE_POINT", relativePath + " must be a regular file", relativePath);
  }
  const digest = await new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(target);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
  return { sha256: digest, sizeBytes: String(metadata.size) };
}

async function listFiles(root, directory = root) {
  const output = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      fail("ART_PATH_REPARSE_POINT", "bundle contains a symbolic link or junction", absolute);
    }
    if (entry.isDirectory()) {
      output.push(...(await listFiles(root, absolute)));
    } else if (entry.isFile()) {
      output.push(path.relative(root, absolute).split(path.sep).join("/"));
    } else {
      fail("ART_INVENTORY_MISMATCH", "bundle contains an unsupported entry", absolute);
    }
  }
  return output.sort();
}

async function ensureEmptyOutputRoot(root) {
  const resolvedRoot = path.resolve(root);
  try {
    const metadata = await lstat(resolvedRoot);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      fail("ART_PATH_REPARSE_POINT", "output root must be a real directory", resolvedRoot);
    }
    const entries = await readdir(resolvedRoot);
    if (entries.length !== 0) {
      fail("ART_INVENTORY_MISMATCH", "output root must be empty", resolvedRoot);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
    await mkdir(resolvedRoot, { recursive: true });
  }
  return resolvedRoot;
}

async function writeBundleFile(root, relativePath, bytes) {
  const target = resolveBundlePath(root, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, bytes);
}

async function writeCanonicalJson(root, relativePath, value) {
  const bytes = Buffer.from(encodeCanonicalJson(value), "utf8");
  await writeBundleFile(root, relativePath, bytes);
  return { sha256: sha256(bytes), sizeBytes: String(bytes.length) };
}

function makeClaims() {
  return {
    formal_claims: "none",
    formal_metric_ids: [],
    production_claims: [],
    production_evidence: false,
    slo_claims: [],
  };
}

function assetDescriptor(artifactId, role, relativePath, material) {
  return {
    artifact_id: artifactId,
    license_id: LICENSE_ID,
    path: relativePath,
    role,
    sha256: material.sha256,
    size_bytes: material.sizeBytes,
  };
}

function buildCandidateManifest(materials) {
  const worker = materials.get("assets/contract-worker.bin");
  const runtime = materials.get("assets/contract-runtime.bin");
  const model = materials.get("assets/contract-model.bin");
  const modelManifest = materials.get("assets/model-manifest.json");
  const parameters = materials.get("assets/parameters.json");
  const packageLock = materials.get("assets/package.lock");
  const schemaRegistry = materials.get("assets/schema-registry.json");
  const license = materials.get(LICENSE_PATH);

  return {
    artifact_scope: "contract-fixture-only",
    artifacts: [
      assetDescriptor("artifact-worker", "worker-executable", "assets/contract-worker.bin", worker),
      assetDescriptor("artifact-runtime", "runtime", "assets/contract-runtime.bin", runtime),
      assetDescriptor("artifact-model", "model", "assets/contract-model.bin", model),
      assetDescriptor(
        "artifact-model-manifest",
        "model-manifest",
        "assets/model-manifest.json",
        modelManifest,
      ),
      assetDescriptor("artifact-parameters", "parameters", "assets/parameters.json", parameters),
      assetDescriptor("artifact-package-lock", "package-lock", "assets/package.lock", packageLock),
      assetDescriptor(
        "artifact-schema-registry",
        "schema-registry",
        "assets/schema-registry.json",
        schemaRegistry,
      ),
    ].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0)),
    candidate_id: CANDIDATE_ID,
    build: {
      profile: "release",
      target: "x86_64-pc-windows-msvc",
      toolchain: "rust-1.95-contract-fixture",
    },
    claims: makeClaims(),
    licenses: [
      {
        distribution_status: "contract-fixture-only",
        license_id: LICENSE_ID,
        review_status: "contract-fixture-only",
        source_revision: "project-generated-wp-0.4.2",
        source_url: null,
        spdx_or_license_ref: "LicenseRef-Project-Generated",
        text_path: LICENSE_PATH,
        text_sha256: license.sha256,
        text_size_bytes: license.sizeBytes,
      },
    ],
    publishability_status: "not-assessed",
    schema_version: "1.0",
    selection_status: "not-selected",
    source: {
      source_revision: "project-generated-wp-0.4.2",
      source_sha256: worker.sha256,
      source_url: null,
    },
    worker_contract_version: "meetingrelay.model-worker/1.0",
    worker_manifest_projection: {
      descriptor: {
        engine_id: "engine-contract-fixture",
        engine_version: "1.0.0",
        execution_provider: "fixture-cpu",
        languages: ["und"],
        model_id: "model-contract-fixture",
        model_license_id: LICENSE_ID,
        model_manifest_sha256: modelManifest.sha256,
        model_sha256: model.sha256,
        offline: true,
        package_lock_sha256: packageLock.sha256,
        parameter_sha256: parameters.sha256,
        quantization: "contract-fixture",
        runtime_id: "runtime-contract-fixture",
        runtime_sha256: runtime.sha256,
        runtime_version: "1.0.0",
        streaming: true,
      },
      executable_sha256: worker.sha256,
      role: "contract-fixture",
      schema_registry_sha256: schemaRegistry.sha256,
      worker_build_sha256: worker.sha256,
      worker_id: "worker-contract-fixture",
    },
  };
}

async function readFixtureRegistryProjection() {
  const validated = await validateFixtureTree();
  const manifestPath = path.join(fixturePaths.projectRoot, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const fixtures = manifest.fixtures.map((fixture) => ({
    audioSha256: fixture.audio.sha256,
    audioPath: fixture.audio.path,
    fixtureId: fixture.fixture_id,
    pcmSha256: fixture.audio.pcm_sha256,
    referenceSha256: fixture.reference.sha256,
  }));
  const fixture = fixtures[0];
  return {
    ...fixture,
    fixtures,
    manifestSha256: validated.manifestDigest,
  };
}

function buildFixtureSetManifest(fixture) {
  return {
    artifact_scope: "contract-wiring-only",
    fixture_set_id: FIXTURE_SET_ID,
    fixtures: fixture.fixtures.map((entry) => ({
      audio_path: entry.audioPath,
      audio_sha256: entry.audioSha256,
      fixture_id: entry.fixtureId,
      pcm_sha256: entry.pcmSha256,
      reference_sha256: entry.referenceSha256,
    })),
    quality_evidence: false,
    registry: {
      path: "test-fixtures/manifest.json",
      sha256: fixture.manifestSha256,
    },
    schema_version: "1.0",
  };
}

function buildHardwareReference(materials) {
  return {
    capture_scope: "contract-fixture",
    captured_at: null,
    claims: makeClaims(),
    collector: {
      path: "assets/schema-registry.json",
      sha256: materials.get("assets/schema-registry.json").sha256,
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
      cooling: {
        ambient_celsius: null,
        mode: "not-measured",
      },
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
      memory: {
        total_bytes: null,
      },
      operating_system: {
        architecture: "x64",
        build: "not-measured",
        product: "Windows",
        ubr: null,
        version: "not-measured",
      },
      power: {
        plan: "not-measured",
        source: "not-measured",
      },
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
}

function buildRunPlan(candidate, fixture, materials) {
  const descriptor = candidate.worker_manifest_projection.descriptor;
  const parametersSha256 = materials.get("assets/parameters.json").sha256;
  return {
    build_profile: "release",
    candidate_ids: [candidate.candidate_id],
    claims: makeClaims(),
    evidence_manifest_id: EVIDENCE_MANIFEST_ID,
    execution_status: "not-run",
    fixture_ids: fixture.fixtures.map((entry) => entry.fixture_id),
    fixture_set_id: fixture.fixture_set_id,
    harness: {
      command: {
        argv: [],
        cwd: "assets",
        executable_path: "assets/contract-worker.bin",
      },
      core: {
        path: "assets/core-harness.bin",
        sha256: materials.get("assets/core-harness.bin").sha256,
      },
      environment_allowlist: [],
      lockfile: {
        path: "assets/package.lock",
        sha256: descriptor.package_lock_sha256,
      },
      ui: {
        path: "assets/ui-harness.bin",
        sha256: materials.get("assets/ui-harness.bin").sha256,
      },
    },
    hw_ref_id: HW_REF_ID,
    network_policy: "offline-only",
    order_policy: "seeded-round-robin-v1",
    run_plan_id: RUN_PLAN_ID,
    same_condition_contract: {
      audio_playback_path:
        "test-fixtures/" + fixture.fixtures[0].audio_path,
      batch_size: "1",
      cooling_mode: "not-measured",
      endpoint_parameters: {
        path: "assets/vad-endpoint-plan.json",
        sha256: materials.get("assets/vad-endpoint-plan.json").sha256,
      },
      execution_provider: descriptor.execution_provider,
      log_level: "info",
      model_sha256: descriptor.model_sha256,
      parameter_sha256: parametersSha256,
      pcm_sha256: fixture.fixtures[0].pcm_sha256,
      power_plan: "not-measured",
      quantization: descriptor.quantization,
      thread_count: "1",
      translation_fixture_ids: [],
      vad_parameters: {
        path: "assets/vad-endpoint-plan.json",
        sha256: materials.get("assets/vad-endpoint-plan.json").sha256,
      },
      warmup_plan: {
        path: "assets/warmup-plan.json",
        sha256: materials.get("assets/warmup-plan.json").sha256,
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
    scope: "contract-fixture-only",
    seed: "42",
    silent_cloud_fallback: false,
    source_commit: null,
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
}

function buildEvidenceManifest(contractSha256) {
  return {
    build_profile: "release",
    candidate_ids: [CANDIDATE_ID],
    command: {
      argv: [],
      cwd: "assets",
      executable_path: "assets/contract-worker.bin",
    },
    command_exit_code: null,
    contract_manifest_sha256: contractSha256,
    ended_at: null,
    eligibility_status: "not-assessed",
    evidence_manifest_id: EVIDENCE_MANIFEST_ID,
    execution_status: "not-run",
    exclusions: [],
    failures: [],
    fixture_set_id: FIXTURE_SET_ID,
    hw_ref_id: HW_REF_ID,
    observation_scope: "contract-fixture-only",
    output_artifacts: [],
    ranking_status: "not-ranked",
    run_id: null,
    run_plan_id: RUN_PLAN_ID,
    schema_version: "1.0",
    selection_status: "not-selected",
    source_commit: null,
    started_at: null,
    ...makeClaims(),
  };
}

export async function generateCandidateArtifactBundle(root = DEFAULT_BUNDLE_ROOT) {
  const resolvedRoot = await ensureEmptyOutputRoot(root);
  const materials = new Map();

  for (const [relativePath, bytes] of Object.entries(ASSET_BYTES)) {
    await writeBundleFile(resolvedRoot, relativePath, bytes);
    materials.set(relativePath, {
      sha256: sha256(bytes),
      sizeBytes: String(bytes.length),
    });
  }
  for (const [relativePath, value] of Object.entries(JSON_ASSETS)) {
    materials.set(relativePath, await writeCanonicalJson(resolvedRoot, relativePath, value));
  }
  await writeBundleFile(resolvedRoot, LICENSE_PATH, LICENSE_BYTES);
  materials.set(LICENSE_PATH, {
    sha256: sha256(LICENSE_BYTES),
    sizeBytes: String(LICENSE_BYTES.length),
  });

  const fixtureProjection = await readFixtureRegistryProjection();
  const candidateManifest = buildCandidateManifest(materials);
  const fixtureSetManifest = buildFixtureSetManifest(fixtureProjection);
  const hardwareReference = buildHardwareReference(materials);
  const runPlan = buildRunPlan(
    candidateManifest,
    fixtureSetManifest,
    materials,
  );

  materials.set(
    CANDIDATE_MANIFEST_PATH,
    await writeCanonicalJson(resolvedRoot, CANDIDATE_MANIFEST_PATH, candidateManifest),
  );
  materials.set(
    FIXTURE_SET_MANIFEST_PATH,
    await writeCanonicalJson(resolvedRoot, FIXTURE_SET_MANIFEST_PATH, fixtureSetManifest),
  );
  materials.set(
    HW_REF_PATH,
    await writeCanonicalJson(resolvedRoot, HW_REF_PATH, hardwareReference),
  );
  materials.set(
    RUN_PLAN_PATH,
    await writeCanonicalJson(resolvedRoot, RUN_PLAN_PATH, runPlan),
  );

  const contractManifest = {
    contract_id: CONTRACT_TEST_ID,
    entries: CONTRACT_INPUT_PATHS.map((relativePath) => ({
      path: relativePath,
      sha256: materials.get(relativePath).sha256,
      size_bytes: materials.get(relativePath).sizeBytes,
    })),
    formal_claims: "none",
    schema_version: "1.0",
  };
  const contractMaterial = await writeCanonicalJson(
    resolvedRoot,
    CONTRACT_MANIFEST_PATH,
    contractManifest,
  );
  await writeBundleFile(
    resolvedRoot,
    CONTRACT_SEAL_PATH,
    Buffer.from(
      contractMaterial.sha256 + "  " + CONTRACT_MANIFEST_PATH + "\n",
      "ascii",
    ),
  );

  const evidenceManifest = buildEvidenceManifest(contractMaterial.sha256);
  const evidenceMaterial = await writeCanonicalJson(
    resolvedRoot,
    EVIDENCE_MANIFEST_PATH,
    evidenceManifest,
  );
  await writeBundleFile(
    resolvedRoot,
    EVIDENCE_SEAL_PATH,
    Buffer.from(
      evidenceMaterial.sha256 + "  evidence-manifest.json\n",
      "ascii",
    ),
  );

  return validateCandidateArtifactBundle(resolvedRoot);
}

async function readCanonicalJson(root, relativePath) {
  const target = await assertRealPathComponents(root, relativePath);
  const bytes = await readFile(target);
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    fail("ART_CANONICAL_JSON", relativePath + " is not valid UTF-8 JSON: " + error.message);
  }
  const canonical = Buffer.from(encodeCanonicalJson(value), "utf8");
  if (canonical.compare(bytes) !== 0) {
    fail("ART_CANONICAL_JSON", relativePath + " is not canonical JSON", relativePath);
  }
  return { bytes, value };
}

async function validateSeal(root, manifestPath, sealPath, sealFileName) {
  const manifest = await readCanonicalJson(root, manifestPath);
  const digest = sha256(manifest.bytes);
  assertDigest(digest, manifestPath + ".sha256");
  const sealTarget = await assertRealPathComponents(root, sealPath);
  const sealBytes = await readFile(sealTarget);
  const expected = digest + "  " + sealFileName + "\n";
  if (sealBytes.toString("ascii") !== expected) {
    fail("ART_DIGEST_SEAL_MISMATCH", sealPath + " does not seal " + manifestPath, sealPath);
  }
  return { digest, value: manifest.value };
}

function validateClaims(claims, label) {
  assertExactKeys(claims, CLAIM_KEYS, label);
  if (
    claims.formal_claims !== "none" ||
    !Array.isArray(claims.formal_metric_ids) ||
    claims.formal_metric_ids.length !== 0 ||
    !Array.isArray(claims.slo_claims) ||
    claims.slo_claims.length !== 0 ||
    !Array.isArray(claims.production_claims) ||
    claims.production_claims.length !== 0 ||
    claims.production_evidence !== false
  ) {
    fail("ART_CLAIM_UNSUPPORTED", label + " exceeds the WP-0.4.2 claim authority", label);
  }
}

function validateEmbeddedClaimBoundary(value, label) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      validateEmbeddedClaimBoundary(entry, label + "[" + index + "]"),
    );
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (
        (key === "formal_claims" && entry !== "none") ||
        (["formal_metric_ids", "slo_claims", "production_claims"].includes(key) &&
          (!Array.isArray(entry) || entry.length !== 0)) ||
        (key === "production_evidence" && entry !== false)
      ) {
        fail(
          "ART_CLAIM_UNSUPPORTED",
          label + "." + key + " exceeds WP-0.4 artifact claim authority",
          label + "." + key,
        );
      }
      validateEmbeddedClaimBoundary(entry, label + "." + key);
    }
    return;
  }
  if (
    typeof value === "string" &&
    /\b(?:PERF-[A-Z0-9-]+|MR-[A-Z]{2,3}-[0-9]{3})\b.*\b(?:pass|slo|production|paint|default|eligible)\b/i.test(
      value,
    )
  ) {
    fail("ART_CLAIM_UNSUPPORTED", label + " contains an unsupported formal claim");
  }
}

function validateArtifactDescriptor(descriptor, label) {
  if (
    descriptor?.license_id === undefined ||
    typeof descriptor.license_id !== "string" ||
    descriptor.license_id.length === 0
  ) {
    fail("ART_LICENSE_MISSING", label + ".license_id is required", label + ".license_id");
  }
  assertExactKeys(
    descriptor,
    ["artifact_id", "license_id", "path", "role", "sha256", "size_bytes"],
    label,
  );
  assertIdentifier(descriptor.artifact_id, label + ".artifact_id");
  assertIdentifier(descriptor.license_id, label + ".license_id");
  assertIdentifier(descriptor.role, label + ".role");
  validateArtifactPath(descriptor.path, label + ".path");
  assertDigest(descriptor.sha256, label + ".sha256");
  assertCanonicalU64(descriptor.size_bytes, label + ".size_bytes", 1n);
}

function validateEvidenceArtifactDescriptor(descriptor, label) {
  assertExactKeys(
    descriptor,
    ["artifact_id", "path", "role", "sha256", "size_bytes"],
    label,
  );
  assertIdentifier(descriptor.artifact_id, label + ".artifact_id");
  assertIdentifier(descriptor.role, label + ".role");
  validateArtifactPath(descriptor.path, label + ".path");
  if (!descriptor.path.startsWith("evidence/artifacts/")) {
    fail("ART_PATH_FORMAT", label + ".path must stay below evidence/artifacts");
  }
  assertDigest(descriptor.sha256, label + ".sha256");
  assertCanonicalU64(descriptor.size_bytes, label + ".size_bytes", 1n);
}

function validateInputReference(reference, label, contractEntries) {
  assertExactKeys(reference, ["path", "sha256"], label);
  validateArtifactPath(reference.path, label + ".path");
  assertDigest(reference.sha256, label + ".sha256");
  if (contractEntries.get(reference.path)?.sha256 !== reference.sha256) {
    fail("ART_JOIN_MISMATCH", label + " does not join the sealed contract inventory");
  }
}

function validateWorkerManifestProjection(projection, isContractFixture) {
  assertExactKeys(
    projection,
    [
      "descriptor",
      "executable_sha256",
      "role",
      "schema_registry_sha256",
      "worker_build_sha256",
      "worker_id",
    ],
    "candidate.worker_manifest_projection",
  );
  assertIdentifier(projection.worker_id, "worker_id");
  if (
    (isContractFixture && projection.role !== "contract-fixture") ||
    (!isContractFixture &&
      ![
        "native-candidate",
        "sidecar-candidate",
        "fallback-candidate",
        "oracle-only",
      ].includes(projection.role))
  ) {
    fail("ART_SCHEMA_VALUE", "candidate role does not match its artifact scope");
  }
  assertDigest(projection.worker_build_sha256, "worker_build_sha256");
  assertDigest(projection.executable_sha256, "executable_sha256");
  assertDigest(projection.schema_registry_sha256, "schema_registry_sha256");

  const descriptor = projection.descriptor;
  assertExactKeys(
    descriptor,
    [
      "engine_id",
      "engine_version",
      "execution_provider",
      "languages",
      "model_id",
      "model_license_id",
      "model_manifest_sha256",
      "model_sha256",
      "offline",
      "package_lock_sha256",
      "parameter_sha256",
      "quantization",
      "runtime_id",
      "runtime_sha256",
      "runtime_version",
      "streaming",
    ],
    "candidate.worker_manifest_projection.descriptor",
  );
  for (const key of [
    "engine_id",
    "engine_version",
    "model_id",
    "model_license_id",
    "quantization",
    "runtime_id",
    "runtime_version",
  ]) {
    assertIdentifier(descriptor[key], "descriptor." + key);
  }
  for (const key of [
    "model_manifest_sha256",
    "model_sha256",
    "package_lock_sha256",
    "parameter_sha256",
    "runtime_sha256",
  ]) {
    assertDigest(descriptor[key], "descriptor." + key);
  }
  if (
    !["fixture-cpu", "cpu", "cuda", "directml", "openvino"].includes(
      descriptor.execution_provider,
    ) ||
    (isContractFixture && descriptor.execution_provider !== "fixture-cpu") ||
    (!isContractFixture && descriptor.execution_provider === "fixture-cpu") ||
    descriptor.streaming !== true ||
    descriptor.offline !== true
  ) {
    fail("ART_SCHEMA_VALUE", "candidate descriptor violates the Rust contract-fixture projection");
  }
  if (
    !Array.isArray(descriptor.languages) ||
    descriptor.languages.length === 0 ||
    descriptor.languages.length > 64
  ) {
    fail("ART_SCHEMA_BOUND", "descriptor.languages must contain 1..64 entries");
  }
  descriptor.languages.forEach((value, index) =>
    assertLanguageCode(value, "descriptor.languages[" + index + "]"),
  );
  if (
    new Set(descriptor.languages).size !== descriptor.languages.length ||
    descriptor.languages.some(
      (value, index) => index > 0 && descriptor.languages[index - 1] >= value,
    )
  ) {
    fail("ART_SCHEMA_DUPLICATE_ID", "descriptor.languages must be unique and sorted");
  }
}

function validateCandidateManifest(candidate, contractEntries) {
  assertExactKeys(
    candidate,
    [
      "artifact_scope",
      "artifacts",
      "build",
      "candidate_id",
      "claims",
      "licenses",
      "publishability_status",
      "schema_version",
      "selection_status",
      "source",
      "worker_contract_version",
      "worker_manifest_projection",
    ],
    "candidate",
  );
  const isContractFixture = candidate.artifact_scope === "contract-fixture-only";
  const isCandidateInput = candidate.artifact_scope === "candidate-input";
  if (
    candidate.schema_version !== "1.0" ||
    (!isContractFixture && !isCandidateInput) ||
    (isContractFixture && candidate.candidate_id !== CANDIDATE_ID) ||
    candidate.worker_contract_version !== "meetingrelay.model-worker/1.0"
  ) {
    fail("ART_SCHEMA_VALUE", "candidate identity or scope differs");
  }
  assertIdentifier(candidate.candidate_id, "candidate.candidate_id");
  assertExactKeys(candidate.build, ["profile", "target", "toolchain"], "candidate.build");
  if (
    candidate.build.profile !== "release" ||
    candidate.build.target !== "x86_64-pc-windows-msvc" ||
    typeof candidate.build.toolchain !== "string" ||
    candidate.build.toolchain.length === 0 ||
    (isContractFixture &&
      candidate.build.toolchain !== "rust-1.95-contract-fixture")
  ) {
    fail("ART_SCHEMA_VALUE", "candidate build provenance differs");
  }
  assertExactKeys(
    candidate.source,
    ["source_revision", "source_sha256", "source_url"],
    "candidate.source",
  );
  assertIdentifier(candidate.source.source_revision, "candidate.source.source_revision");
  assertDigest(candidate.source.source_sha256, "candidate.source.source_sha256");
  if (
    (isContractFixture && candidate.source.source_url !== null) ||
    (isCandidateInput &&
      (typeof candidate.source.source_url !== "string" ||
        !/^https:\/\/\S+$/.test(candidate.source.source_url)))
  ) {
    fail("ART_JOIN_MISMATCH", "candidate source URL does not match its artifact scope");
  }
  const expectedFixtureBytes = new Map([
    ...Object.entries(ASSET_BYTES),
    ...Object.entries(JSON_ASSETS).map(([relativePath, value]) => [
      relativePath,
      Buffer.from(encodeCanonicalJson(value), "utf8"),
    ]),
    [LICENSE_PATH, LICENSE_BYTES],
  ]);
  if (isContractFixture) {
    for (const [relativePath, bytes] of expectedFixtureBytes) {
      const entry = contractEntries.get(relativePath);
      if (
        !entry ||
        entry.sha256 !== sha256(bytes) ||
        entry.size_bytes !== String(bytes.length)
      ) {
        fail(
          "ART_DIGEST_MISMATCH",
          relativePath + " differs from the independently anchored contract fixture",
          relativePath,
        );
      }
    }
  }
  validateClaims(candidate.claims, "candidate.claims");
  if (
    (isContractFixture && candidate.publishability_status !== "not-assessed") ||
    (isCandidateInput &&
      !["pending", "accepted", "rejected"].includes(
        candidate.publishability_status,
      )) ||
    candidate.selection_status !== "not-selected"
  ) {
    fail("ART_CLAIM_UNSUPPORTED", "contract fixture cannot be publishable, eligible, or selected");
  }
  validateWorkerManifestProjection(
    candidate.worker_manifest_projection,
    isContractFixture,
  );
  if (
    (isContractFixture &&
      candidate.source.source_sha256 !==
        candidate.worker_manifest_projection.worker_build_sha256) ||
    (isCandidateInput &&
      ![...contractEntries.values()].some(
        (entry) => entry.sha256 === candidate.source.source_sha256,
      ))
  ) {
    fail("ART_JOIN_MISMATCH", "candidate source does not join a sealed input");
  }

  if (
    !Array.isArray(candidate.artifacts) ||
    candidate.artifacts.length < 7 ||
    candidate.artifacts.length > 256
  ) {
    fail("ART_SCHEMA_BOUND", "candidate.artifacts must contain 7..256 sealed assets");
  }
  const artifactIds = [];
  const artifactPaths = [];
  for (const [index, artifact] of candidate.artifacts.entries()) {
    validateArtifactDescriptor(artifact, "candidate.artifacts[" + index + "]");
    artifactIds.push(artifact.artifact_id);
    artifactPaths.push(artifact.path);
    const contractEntry = contractEntries.get(artifact.path);
    if (
      !contractEntry ||
      contractEntry.sha256 !== artifact.sha256 ||
      contractEntry.size_bytes !== artifact.size_bytes
    ) {
      fail("ART_JOIN_MISMATCH", artifact.path + " does not join the contract inventory");
    }
  }
  assertUnique(artifactIds, "candidate artifact IDs");
  assertUnique(artifactPaths, "candidate artifact paths");
  if (artifactPaths.some((value, index) => index > 0 && artifactPaths[index - 1] >= value)) {
    fail("ART_SCHEMA_VALUE", "candidate artifacts must be sorted by path");
  }

  if (
    !Array.isArray(candidate.licenses) ||
    candidate.licenses.length === 0 ||
    candidate.licenses.length > 128
  ) {
    fail("ART_LICENSE_MISSING", "candidate must contain 1..128 independent license records");
  }
  const licenseIds = [];
  for (const [index, license] of candidate.licenses.entries()) {
    if (
      license?.license_id === undefined ||
      license?.text_path === undefined ||
      license?.text_sha256 === undefined
    ) {
      fail("ART_LICENSE_MISSING", "license ID, text path, and digest are required");
    }
    assertExactKeys(
      license,
      [
        "distribution_status",
        "license_id",
        "review_status",
        "source_revision",
        "source_url",
        "spdx_or_license_ref",
        "text_path",
        "text_sha256",
        "text_size_bytes",
      ],
      "candidate.licenses[" + index + "]",
    );
    assertIdentifier(license.license_id, "candidate.licenses[" + index + "].license_id");
    assertIdentifier(
      license.source_revision,
      "candidate.licenses[" + index + "].source_revision",
    );
    licenseIds.push(license.license_id);
    validateArtifactPath(license.text_path, "candidate.licenses[" + index + "].text_path");
    assertDigest(license.text_sha256, "candidate.licenses[" + index + "].text_sha256");
    assertCanonicalU64(
      license.text_size_bytes,
      "candidate.licenses[" + index + "].text_size_bytes",
      1n,
    );
    if (
      typeof license.spdx_or_license_ref !== "string" ||
      license.spdx_or_license_ref.length === 0
    ) {
      fail("ART_LICENSE_MISSING", "license identifier is required");
    }
    const licenseEntry = contractEntries.get(license.text_path);
    if (
      !licenseEntry ||
      licenseEntry.sha256 !== license.text_sha256 ||
      licenseEntry.size_bytes !== license.text_size_bytes
    ) {
      fail("ART_LICENSE_REFERENCE", "license text does not join the sealed inventory");
    }
    if (
      isContractFixture &&
      (license.license_id !== LICENSE_ID ||
        license.review_status !== "contract-fixture-only" ||
        license.distribution_status !== "contract-fixture-only" ||
        license.spdx_or_license_ref !== "LicenseRef-Project-Generated" ||
        license.source_revision !== "project-generated-wp-0.4.2" ||
        license.source_url !== null)
    ) {
      fail("ART_LICENSE_REFERENCE", "contract-fixture license record differs");
    }
    if (
      isCandidateInput &&
      (!["pending", "accepted", "rejected"].includes(license.review_status) ||
        !["pending", "accepted", "rejected"].includes(
          license.distribution_status,
        ) ||
        typeof license.source_url !== "string" ||
        !/^https:\/\/\S+$/.test(license.source_url))
    ) {
      fail("ART_LICENSE_REFERENCE", "candidate license review or source record differs");
    }
  }
  assertUnique(licenseIds, "candidate license IDs");
  if (
    candidate.artifacts.some((artifact) => !licenseIds.includes(artifact.license_id)) ||
    !licenseIds.includes(
      candidate.worker_manifest_projection.descriptor.model_license_id,
    ) ||
    (candidate.publishability_status === "accepted" &&
      candidate.licenses.some(
        (license) =>
          license.review_status !== "accepted" ||
          license.distribution_status !== "accepted",
      ))
  ) {
    fail("ART_LICENSE_REFERENCE", "candidate artifact or model license reference is unresolved");
  }

  const byRole = new Map();
  for (const artifact of candidate.artifacts) {
    if (byRole.has(artifact.role)) {
      fail("ART_SCHEMA_DUPLICATE_ID", "candidate artifact role is duplicated");
    }
    byRole.set(artifact.role, artifact);
  }
  const projection = candidate.worker_manifest_projection;
  const descriptor = projection.descriptor;
  if (
    byRole.get("model")?.license_id !== descriptor.model_license_id ||
    byRole.get("model-manifest")?.license_id !== descriptor.model_license_id
  ) {
    fail(
      "ART_LICENSE_REFERENCE",
      "model and model-manifest licenses must match descriptor.model_license_id",
    );
  }
  const expectedProjection = [
    [projection.worker_build_sha256, "worker-executable"],
    [projection.executable_sha256, "worker-executable"],
    [projection.schema_registry_sha256, "schema-registry"],
    [descriptor.runtime_sha256, "runtime"],
    [descriptor.package_lock_sha256, "package-lock"],
    [descriptor.model_sha256, "model"],
    [descriptor.model_manifest_sha256, "model-manifest"],
    [descriptor.parameter_sha256, "parameters"],
  ];
  if (
    expectedProjection.some(
      ([digest, artifactRole]) => byRole.get(artifactRole)?.sha256 !== digest,
    )
  ) {
    fail("ART_JOIN_MISMATCH", "Rust manifest projection digests do not match candidate assets");
  }
}

async function validateLicenseTexts(root, candidate) {
  for (const license of candidate.licenses) {
    const target = await assertRealPathComponents(root, license.text_path);
    const bytes = await readFile(target);
    const text = bytes.toString("utf8");
    if (
      Buffer.from(text, "utf8").compare(bytes) !== 0 ||
      text.trim().length === 0 ||
      /[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)
    ) {
      fail("ART_LICENSE_REFERENCE", "license text is not non-empty canonical UTF-8");
    }
    if (
      candidate.publishability_status === "accepted" &&
      /\b(?:unlicensed|license\s+unknown|no\s+license)\b/i.test(text)
    ) {
      fail(
        "ART_LICENSE_REFERENCE",
        "accepted publishability contradicts the sealed license text",
      );
    }
  }
}

function validateFixtureSetManifest(fixtureSet, fixtureRegistry) {
  assertExactKeys(
    fixtureSet,
    [
      "artifact_scope",
      "fixture_set_id",
      "fixtures",
      "quality_evidence",
      "registry",
      "schema_version",
    ],
    "fixture-set",
  );
  const isContractFixture = fixtureSet.artifact_scope === "contract-wiring-only";
  const isCandidateInput = fixtureSet.artifact_scope === "candidate-run-input";
  if (
    fixtureSet.schema_version !== "1.0" ||
    (!isContractFixture && !isCandidateInput) ||
    (isContractFixture && fixtureSet.fixture_set_id !== FIXTURE_SET_ID) ||
    fixtureSet.quality_evidence !== false
  ) {
    fail("ART_SCHEMA_VALUE", "fixture-set identity or evidence scope differs");
  }
  assertIdentifier(fixtureSet.fixture_set_id, "fixture-set.fixture_set_id");
  assertExactKeys(fixtureSet.registry, ["path", "sha256"], "fixture-set.registry");
  validateArtifactPath(fixtureSet.registry.path, "fixture-set.registry.path");
  assertDigest(fixtureSet.registry.sha256, "fixture-set.registry.sha256");
  if (
    fixtureSet.registry.path !== "test-fixtures/manifest.json" ||
    fixtureSet.registry.sha256 !== fixtureRegistry.manifestSha256
  ) {
    fail("ART_JOIN_MISMATCH", "fixture registry digest or path differs");
  }
  if (
    !Array.isArray(fixtureSet.fixtures) ||
    fixtureSet.fixtures.length === 0 ||
    fixtureSet.fixtures.length > 256
  ) {
    fail("ART_SCHEMA_BOUND", "fixture-set must contain 1..256 fixtures");
  }
  const fixtureIds = [];
  const registryById = new Map(
    fixtureRegistry.fixtures.map((fixture) => [fixture.fixtureId, fixture]),
  );
  for (const [index, fixture] of fixtureSet.fixtures.entries()) {
    assertExactKeys(
      fixture,
      ["audio_path", "audio_sha256", "fixture_id", "pcm_sha256", "reference_sha256"],
      "fixture-set.fixtures[" + index + "]",
    );
    validateArtifactPath(fixture.audio_path, "fixture.audio_path");
    assertIdentifier(fixture.fixture_id, "fixture_id");
    fixtureIds.push(fixture.fixture_id);
    for (const key of ["audio_sha256", "pcm_sha256", "reference_sha256"]) {
      assertDigest(fixture[key], "fixture." + key);
    }
    const registryFixture = registryById.get(fixture.fixture_id);
    if (
      !registryFixture ||
      fixture.audio_path !== registryFixture.audioPath ||
      fixture.audio_sha256 !== registryFixture.audioSha256 ||
      fixture.pcm_sha256 !== registryFixture.pcmSha256 ||
      fixture.reference_sha256 !== registryFixture.referenceSha256
    ) {
      fail("ART_JOIN_MISMATCH", "fixture-set does not match the validated fixture registry");
    }
  }
  assertUnique(fixtureIds, "fixture-set fixture IDs");
}

function assertPrivacySafe(value, label = "hw-ref") {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertPrivacySafe(entry, label + "[" + index + "]"));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (
        /^(?:host_?name|user_?name|machine_?guid|serial(?:_number)?|mac(?:_address)?|device_?instance(?:_id)?|endpoint_?id|email|local_?path)$/i.test(
          key,
        )
      ) {
        fail("ART_PRIVACY_UNSAFE_IDENTIFIER", label + " contains forbidden key " + key, key);
      }
      assertPrivacySafe(entry, label + "." + key);
    }
    return;
  }
  if (
    typeof value === "string" &&
    (/[A-Za-z]:[\\/]/.test(value) ||
      /^(?:\\\\|\/\/)/.test(value) ||
      /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/.test(value) ||
      /(?:\b[0-9a-f]{2}:){5}[0-9a-f]{2}\b/i.test(value) ||
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i.test(
        value,
      ) ||
      /\bS-\d(?:-\d+){2,}\b/i.test(value))
  ) {
    fail("ART_PRIVACY_UNSAFE_IDENTIFIER", label + " contains a stable or local identifier", label);
  }
}

function validateHardwareReference(hardware, contractEntries) {
  assertPrivacySafe(hardware);
  assertExactKeys(
    hardware,
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
    "hw-ref",
  );
  const isContractFixture =
    hardware.capture_scope === "contract-fixture" &&
    hardware.measurement_status === "not-measured";
  const isMeasured =
    hardware.capture_scope === "measured" &&
    hardware.measurement_status === "captured";
  if (
    hardware.schema_version !== "1.0" ||
    (!isContractFixture && !isMeasured) ||
    hardware.hardware_tier !== "HW-REF" ||
    hardware.privacy_policy !== "no-stable-device-identifiers-v1"
  ) {
    fail("ART_SCHEMA_VALUE", "HW-REF identity or contract-fixture status differs");
  }
  assertIdentifier(hardware.hw_ref_id, "hw-ref.hw_ref_id");
  if (
    (isContractFixture &&
      (hardware.hw_ref_id !== HW_REF_ID ||
        hardware.captured_at !== null ||
        hardware.privacy_class !== "contract-fixture-public-safe")) ||
    (isMeasured &&
      (typeof hardware.captured_at !== "string" ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(
          hardware.captured_at,
        ) ||
        hardware.privacy_class !== "internal-benchmark-metadata"))
  ) {
    fail("ART_SCHEMA_VALUE", "HW-REF capture time or privacy class differs");
  }
  validateClaims(hardware.claims, "hw-ref.claims");
  assertExactKeys(hardware.collector, ["path", "sha256", "version"], "hw-ref.collector");
  validateArtifactPath(hardware.collector.path, "hw-ref.collector.path");
  assertDigest(hardware.collector.sha256, "hw-ref.collector.sha256");
  assertIdentifier(hardware.collector.version, "hw-ref.collector.version");
  if (
    contractEntries.get(hardware.collector.path)?.sha256 !==
    hardware.collector.sha256
  ) {
    fail("ART_JOIN_MISMATCH", "HW-REF collector does not join a sealed input");
  }
  assertExactKeys(
    hardware.environment,
    [
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
    ],
    "hw-ref.environment",
  );
  assertExactKeys(
    hardware.environment.bios,
    ["release_date", "vendor", "version"],
    "hw-ref.environment.bios",
  );
  assertExactKeys(
    hardware.environment.cooling,
    ["ambient_celsius", "mode"],
    "hw-ref.environment.cooling",
  );
  assertExactKeys(
    hardware.environment.cpu,
    ["logical_processor_count", "model", "physical_core_count", "vendor"],
    "hw-ref.environment.cpu",
  );
  assertExactKeys(
    hardware.environment.memory,
    ["total_bytes"],
    "hw-ref.environment.memory",
  );
  assertExactKeys(
    hardware.environment.operating_system,
    ["architecture", "build", "product", "ubr", "version"],
    "hw-ref.environment.operating_system",
  );
  assertExactKeys(hardware.environment.power, ["plan", "source"], "hw-ref.environment.power");
  if (
    !Array.isArray(hardware.environment.background_process_allowlist) ||
    hardware.environment.background_process_allowlist.some(
      (value) => typeof value !== "string" || value.length === 0,
    )
  ) {
    fail("ART_SCHEMA_TYPE", "HW-REF background process allowlist must contain strings");
  }
  if (
    !Array.isArray(hardware.environment.audio_devices) ||
    hardware.environment.audio_devices.length === 0 ||
    !Array.isArray(hardware.environment.gpus) ||
    hardware.environment.gpus.length === 0 ||
    !Array.isArray(hardware.environment.storage) ||
    hardware.environment.storage.length === 0
  ) {
    fail("ART_SCHEMA_BOUND", "HW-REF must cover audio, GPU, and storage devices");
  }
  for (const [index, device] of hardware.environment.audio_devices.entries()) {
    assertExactKeys(
      device,
      ["driver_version", "logical_role", "model", "signature_status", "vendor"],
      "hw-ref.environment.audio_devices[" + index + "]",
    );
  }
  for (const [index, gpu] of hardware.environment.gpus.entries()) {
    assertExactKeys(
      gpu,
      ["driver_version", "execution_providers", "model", "vendor", "vram_bytes"],
      "hw-ref.environment.gpus[" + index + "]",
    );
    if (
      !Array.isArray(gpu.execution_providers) ||
      gpu.execution_providers.some(
        (value) =>
          !["cpu", "cuda", "directml", "openvino"].includes(value),
      )
    ) {
      fail("ART_SCHEMA_VALUE", "HW-REF GPU execution provider list differs");
    }
  }
  for (const [index, storage] of hardware.environment.storage.entries()) {
    assertExactKeys(
      storage,
      [
        "capacity_bytes",
        "driver_version",
        "filesystem",
        "medium",
        "model",
        "vendor",
      ],
      "hw-ref.environment.storage[" + index + "]",
    );
  }
  const nullableMeasurements = [
    [
      hardware.environment.cpu.physical_core_count,
      "hw-ref.environment.cpu.physical_core_count",
    ],
    [
      hardware.environment.cpu.logical_processor_count,
      "hw-ref.environment.cpu.logical_processor_count",
    ],
    [hardware.environment.memory.total_bytes, "hw-ref.environment.memory.total_bytes"],
    ...hardware.environment.gpus.map((gpu, index) => [
      gpu.vram_bytes,
      "hw-ref.environment.gpus[" + index + "].vram_bytes",
    ]),
    ...hardware.environment.storage.map((storage, index) => [
      storage.capacity_bytes,
      "hw-ref.environment.storage[" + index + "].capacity_bytes",
    ]),
  ];
  for (const [value, label] of nullableMeasurements) {
    if (isContractFixture) {
      if (value !== null) {
        fail("ART_SCHEMA_VALUE", label + " must be null for a contract fixture");
      }
    } else {
      assertCanonicalU64(value, label, 1n);
    }
  }
  if (
    isContractFixture &&
    (hardware.environment.bios.release_date !== null ||
      hardware.environment.operating_system.ubr !== null)
  ) {
    fail("ART_SCHEMA_VALUE", "contract-fixture HW-REF cannot invent captured values");
  }
  if (
    isMeasured &&
    (typeof hardware.environment.bios.release_date !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(hardware.environment.bios.release_date) ||
      typeof hardware.environment.operating_system.ubr !== "string" ||
      !/^(0|[1-9][0-9]*)$/.test(hardware.environment.operating_system.ubr))
  ) {
    fail("ART_SCHEMA_VALUE", "measured HW-REF BIOS date or OS UBR differs");
  }
  if (isMeasured) {
    const requiredMeasuredText = [
      [hardware.collector.version, "hw-ref.collector.version"],
      [hardware.environment.bios.vendor, "hw-ref.environment.bios.vendor"],
      [hardware.environment.bios.version, "hw-ref.environment.bios.version"],
      [hardware.environment.bios.release_date, "hw-ref.environment.bios.release_date"],
      [hardware.environment.cooling.mode, "hw-ref.environment.cooling.mode"],
      [
        hardware.environment.cooling.ambient_celsius,
        "hw-ref.environment.cooling.ambient_celsius",
      ],
      [hardware.environment.cpu.vendor, "hw-ref.environment.cpu.vendor"],
      [hardware.environment.cpu.model, "hw-ref.environment.cpu.model"],
      [
        hardware.environment.operating_system.product,
        "hw-ref.environment.operating_system.product",
      ],
      [
        hardware.environment.operating_system.version,
        "hw-ref.environment.operating_system.version",
      ],
      [
        hardware.environment.operating_system.build,
        "hw-ref.environment.operating_system.build",
      ],
      [
        hardware.environment.operating_system.architecture,
        "hw-ref.environment.operating_system.architecture",
      ],
      [hardware.environment.power.source, "hw-ref.environment.power.source"],
      [hardware.environment.power.plan, "hw-ref.environment.power.plan"],
      ...hardware.environment.audio_devices.flatMap((device, index) => [
        [device.logical_role, "hw-ref.environment.audio_devices[" + index + "].logical_role"],
        [device.vendor, "hw-ref.environment.audio_devices[" + index + "].vendor"],
        [device.model, "hw-ref.environment.audio_devices[" + index + "].model"],
        [
          device.driver_version,
          "hw-ref.environment.audio_devices[" + index + "].driver_version",
        ],
        [
          device.signature_status,
          "hw-ref.environment.audio_devices[" + index + "].signature_status",
        ],
      ]),
      ...hardware.environment.gpus.flatMap((gpu, index) => [
        [gpu.vendor, "hw-ref.environment.gpus[" + index + "].vendor"],
        [gpu.model, "hw-ref.environment.gpus[" + index + "].model"],
        [gpu.driver_version, "hw-ref.environment.gpus[" + index + "].driver_version"],
      ]),
      ...hardware.environment.storage.flatMap((storage, index) => [
        [storage.vendor, "hw-ref.environment.storage[" + index + "].vendor"],
        [storage.model, "hw-ref.environment.storage[" + index + "].model"],
        [
          storage.driver_version,
          "hw-ref.environment.storage[" + index + "].driver_version",
        ],
        [storage.medium, "hw-ref.environment.storage[" + index + "].medium"],
        [storage.filesystem, "hw-ref.environment.storage[" + index + "].filesystem"],
      ]),
    ];
    for (const [value, label] of requiredMeasuredText) {
      if (
        typeof value !== "string" ||
        value.trim().length === 0 ||
        /(?:not-measured|contract-fixture|not-applicable)/i.test(value)
      ) {
        fail("ART_SCHEMA_VALUE", label + " must be captured without a placeholder");
      }
    }
    if (
      !/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(
        hardware.environment.cooling.ambient_celsius,
      )
    ) {
      fail("ART_SCHEMA_VALUE", "captured ambient_celsius must be a canonical decimal string");
    }
  }
}

function validateParameterAsset(parameters, expectedScope) {
  assertExactKeys(
    parameters,
    [
      "artifact_scope",
      "batch_size",
      "formal_claims",
      "schema_version",
      "thread_count",
    ],
    "parameters",
  );
  if (
    parameters.schema_version !== "1.0" ||
    parameters.artifact_scope !== expectedScope ||
    parameters.formal_claims !== "none"
  ) {
    fail("ART_CLAIM_UNSUPPORTED", "parameter asset identity or claim scope differs");
  }
  assertCanonicalU64(parameters.batch_size, "parameters.batch_size", 1n);
  assertCanonicalU64(parameters.thread_count, "parameters.thread_count", 1n);
}

function validateJsonContractAssets(
  modelManifest,
  packageLock,
  parameters,
  schemaRegistry,
  vadEndpointPlan,
  warmupPlan,
  candidate,
) {
  const expectedScope =
    candidate.artifact_scope === "contract-fixture-only"
      ? "contract-fixture-only"
      : "candidate-input";
  assertExactKeys(
    modelManifest,
    ["artifact_scope", "formal_claims", "model_id", "schema_version"],
    "model-manifest",
  );
  if (
    modelManifest.schema_version !== "1.0" ||
    modelManifest.artifact_scope !== expectedScope ||
    modelManifest.formal_claims !== "none" ||
    modelManifest.model_id !== candidate.worker_manifest_projection.descriptor.model_id
  ) {
    fail("ART_CLAIM_UNSUPPORTED", "model manifest identity or claim scope differs");
  }

  assertExactKeys(
    packageLock,
    ["artifact_scope", "dependencies", "formal_claims", "schema_version"],
    "package-lock",
  );
  if (
    packageLock.schema_version !== "1.0" ||
    packageLock.artifact_scope !== expectedScope ||
    packageLock.formal_claims !== "none" ||
    !Array.isArray(packageLock.dependencies) ||
    packageLock.dependencies.some((value) => typeof value !== "string")
  ) {
    fail("ART_CLAIM_UNSUPPORTED", "package lock identity or claim scope differs");
  }

  validateParameterAsset(parameters, expectedScope);

  assertExactKeys(
    schemaRegistry,
    ["artifact_scope", "formal_claims", "schema_version", "schemas"],
    "schema-registry",
  );
  if (
    schemaRegistry.schema_version !== "1.0" ||
    schemaRegistry.artifact_scope !== expectedScope ||
    schemaRegistry.formal_claims !== "none" ||
    !Array.isArray(schemaRegistry.schemas) ||
    !schemaRegistry.schemas.includes("meetingrelay.model-worker.v1") ||
    new Set(schemaRegistry.schemas).size !== schemaRegistry.schemas.length
  ) {
    fail("ART_CLAIM_UNSUPPORTED", "schema registry identity or claim scope differs");
  }

  assertExactKeys(
    vadEndpointPlan,
    ["artifact_scope", "endpoint", "formal_claims", "schema_version", "vad"],
    "vad-endpoint-plan",
  );
  assertExactKeys(
    vadEndpointPlan.endpoint,
    ["max_segment_ms", "min_silence_ms"],
    "vad-endpoint-plan.endpoint",
  );
  assertExactKeys(
    vadEndpointPlan.vad,
    ["frame_ms", "threshold_basis_points"],
    "vad-endpoint-plan.vad",
  );
  for (const [value, label] of [
    [vadEndpointPlan.endpoint.max_segment_ms, "endpoint.max_segment_ms"],
    [vadEndpointPlan.endpoint.min_silence_ms, "endpoint.min_silence_ms"],
    [vadEndpointPlan.vad.frame_ms, "vad.frame_ms"],
    [vadEndpointPlan.vad.threshold_basis_points, "vad.threshold_basis_points"],
  ]) {
    assertCanonicalU64(value, label, 1n);
  }
  if (
    vadEndpointPlan.schema_version !== "1.0" ||
    vadEndpointPlan.artifact_scope !== expectedScope ||
    vadEndpointPlan.formal_claims !== "none"
  ) {
    fail("ART_CLAIM_UNSUPPORTED", "VAD/endpoint plan identity or claim scope differs");
  }

  assertExactKeys(
    warmupPlan,
    ["actions", "artifact_scope", "formal_claims", "schema_version"],
    "warmup-plan",
  );
  if (
    warmupPlan.schema_version !== "1.0" ||
    warmupPlan.artifact_scope !== expectedScope ||
    warmupPlan.formal_claims !== "none" ||
    !Array.isArray(warmupPlan.actions) ||
    warmupPlan.actions.length === 0 ||
    warmupPlan.actions.some((value) => typeof value !== "string")
  ) {
    fail("ART_CLAIM_UNSUPPORTED", "warmup plan identity or claim scope differs");
  }
}

function validateRunPlan(
  runPlan,
  candidate,
  fixtureSet,
  hardware,
  parameters,
  contractEntries,
) {
  assertExactKeys(
    runPlan,
    [
      "candidate_ids",
      "build_profile",
      "claims",
      "evidence_manifest_id",
      "execution_status",
      "fixture_ids",
      "fixture_set_id",
      "harness",
      "hw_ref_id",
      "network_policy",
      "order_policy",
      "run_plan_id",
      "same_condition_contract",
      "sampling",
      "schema_version",
      "scope",
      "seed",
      "silent_cloud_fallback",
      "source_commit",
      "steps",
    ],
    "run-plan",
  );
  const isContractFixture = runPlan.scope === "contract-fixture-only";
  const isCandidateRun = runPlan.scope === "candidate-run";
  if (
    runPlan.schema_version !== "1.0" ||
    (!isContractFixture && !isCandidateRun) ||
    (isContractFixture && runPlan.run_plan_id !== RUN_PLAN_ID) ||
    (isContractFixture && runPlan.execution_status !== "not-run") ||
    (isCandidateRun && runPlan.execution_status !== "planned") ||
    runPlan.network_policy !== "offline-only" ||
    runPlan.silent_cloud_fallback !== false ||
    runPlan.build_profile !== "release" ||
    runPlan.order_policy !== "seeded-round-robin-v1" ||
    (isContractFixture && runPlan.source_commit !== null) ||
    (isCandidateRun &&
      (typeof runPlan.source_commit !== "string" ||
        !/^[0-9a-f]{40}$/.test(runPlan.source_commit))) ||
    (isContractFixture && runPlan.evidence_manifest_id !== EVIDENCE_MANIFEST_ID)
  ) {
    fail("ART_SCHEMA_VALUE", "run-plan identity or non-execution scope differs");
  }
  assertIdentifier(runPlan.run_plan_id, "run-plan.run_plan_id");
  assertIdentifier(runPlan.evidence_manifest_id, "run-plan.evidence_manifest_id");
  validateClaims(runPlan.claims, "run-plan.claims");
  assertUnique(runPlan.candidate_ids, "run-plan.candidate_ids");
  assertUnique(runPlan.fixture_ids, "run-plan.fixture_ids");
  if (
    JSON.stringify(runPlan.candidate_ids) !== JSON.stringify([candidate.candidate_id]) ||
    runPlan.fixture_set_id !== fixtureSet.fixture_set_id ||
    JSON.stringify(runPlan.fixture_ids) !==
      JSON.stringify(fixtureSet.fixtures.map((entry) => entry.fixture_id)) ||
    runPlan.hw_ref_id !== hardware.hw_ref_id ||
    (isContractFixture && candidate.artifact_scope !== "contract-fixture-only") ||
    (isCandidateRun && candidate.artifact_scope !== "candidate-input")
  ) {
    fail("ART_JOIN_MISMATCH", "run-plan references an unknown candidate, fixture, or HW-REF");
  }
  assertCanonicalU64(runPlan.seed, "run-plan.seed");
  assertExactKeys(
    runPlan.sampling,
    [
      "cold_runs",
      "final_event_count",
      "idle_baseline_seconds",
      "soak_durations_seconds",
      "warm_samples_per_scenario",
      "warmup_runs",
    ],
    "run-plan.sampling",
  );
  assertCanonicalU64(
    runPlan.sampling.cold_runs,
    "run-plan.sampling.cold_runs",
    10n,
    MAX_RUN_COUNT,
  );
  assertCanonicalU64(
    runPlan.sampling.warm_samples_per_scenario,
    "run-plan.sampling.warm_samples_per_scenario",
    30n,
    MAX_RUN_COUNT,
  );
  assertCanonicalU64(
    runPlan.sampling.warmup_runs,
    "run-plan.sampling.warmup_runs",
    1n,
    MAX_RUN_COUNT,
  );
  assertCanonicalU64(
    runPlan.sampling.idle_baseline_seconds,
    "run-plan.sampling.idle_baseline_seconds",
    300n,
    3600n,
  );
  assertCanonicalU64(
    runPlan.sampling.final_event_count,
    "run-plan.sampling.final_event_count",
    10_000n,
    MAX_U64,
  );
  if (
    !Array.isArray(runPlan.sampling.soak_durations_seconds) ||
    JSON.stringify(runPlan.sampling.soak_durations_seconds) !==
      JSON.stringify(["1800", "7200", "14400"])
  ) {
    fail("ART_SCHEMA_BOUND", "run-plan soak durations must cover 30m, 2h, and 4h");
  }
  runPlan.sampling.soak_durations_seconds.forEach((value, index) =>
    assertCanonicalU64(value, "run-plan.sampling.soak_durations_seconds[" + index + "]", 1n),
  );
  if (!Array.isArray(runPlan.steps) || runPlan.steps.length !== 9) {
    fail("ART_RUN_PLAN_ORDER", "run-plan must contain nine ordered stages");
  }
  const expectedKinds = [
    "preflight",
    "publishability",
    "contract",
    "quality",
    "cold",
    "warmup",
    "warm",
    "soak-fault",
    "postflight",
  ];
  for (const [index, step] of runPlan.steps.entries()) {
    assertExactKeys(step, ["kind", "sequence"], "run-plan.steps[" + index + "]");
    assertCanonicalU64(step.sequence, "run-plan.steps[" + index + "].sequence", 1n);
    if (step.sequence !== String(index + 1) || step.kind !== expectedKinds[index]) {
      fail("ART_RUN_PLAN_ORDER", "run-plan stage order differs");
    }
  }
  assertExactKeys(
    runPlan.same_condition_contract,
    [
      "batch_size",
      "audio_playback_path",
      "cooling_mode",
      "endpoint_parameters",
      "execution_provider",
      "log_level",
      "model_sha256",
      "parameter_sha256",
      "pcm_sha256",
      "power_plan",
      "quantization",
      "thread_count",
      "translation_fixture_ids",
      "vad_parameters",
      "warmup_plan",
    ],
    "run-plan.same_condition_contract",
  );
  const conditions = runPlan.same_condition_contract;
  assertCanonicalU64(conditions.batch_size, "same_condition.batch_size", 1n);
  assertCanonicalU64(conditions.thread_count, "same_condition.thread_count", 1n);
  validateArtifactPath(conditions.audio_playback_path, "same_condition.audio_playback_path");
  for (const key of ["model_sha256", "parameter_sha256", "pcm_sha256"]) {
    assertDigest(conditions[key], "same_condition." + key);
  }
  validateInputReference(
    conditions.endpoint_parameters,
    "same_condition.endpoint_parameters",
    contractEntries,
  );
  validateInputReference(
    conditions.vad_parameters,
    "same_condition.vad_parameters",
    contractEntries,
  );
  validateInputReference(
    conditions.warmup_plan,
    "same_condition.warmup_plan",
    contractEntries,
  );
  if (!Array.isArray(conditions.translation_fixture_ids)) {
    fail("ART_SCHEMA_TYPE", "translation_fixture_ids must be an array");
  }
  if (
    new Set(conditions.translation_fixture_ids).size !==
    conditions.translation_fixture_ids.length
  ) {
    fail("ART_SCHEMA_DUPLICATE_ID", "translation_fixture_ids contains a duplicate");
  }
  for (const [index, fixtureId] of conditions.translation_fixture_ids.entries()) {
    assertIdentifier(fixtureId, "translation_fixture_ids[" + index + "]");
    if (!fixtureSet.fixtures.some((fixture) => fixture.fixture_id === fixtureId)) {
      fail("ART_JOIN_MISMATCH", "translation fixture is not present in the sealed fixture-set");
    }
  }
  if (
    typeof conditions.log_level !== "string" ||
    !["off", "error", "warn", "info", "debug", "trace"].includes(
      conditions.log_level,
    )
  ) {
    fail("ART_SCHEMA_VALUE", "same_condition.log_level is not a supported fixed value");
  }
  const descriptor = candidate.worker_manifest_projection.descriptor;
  if (
    conditions.batch_size !== parameters.batch_size ||
    conditions.thread_count !== parameters.thread_count ||
    !fixtureSet.fixtures.some(
      (fixture) =>
        conditions.audio_playback_path === "test-fixtures/" + fixture.audio_path,
    ) ||
    conditions.model_sha256 !== descriptor.model_sha256 ||
    conditions.parameter_sha256 !== descriptor.parameter_sha256 ||
    !fixtureSet.fixtures.some(
      (fixture) => conditions.pcm_sha256 === fixture.pcm_sha256,
    ) ||
    conditions.execution_provider !== descriptor.execution_provider ||
    conditions.quantization !== descriptor.quantization ||
    conditions.vad_parameters.sha256 !== conditions.endpoint_parameters.sha256 ||
    conditions.power_plan !== hardware.environment.power.plan ||
    conditions.cooling_mode !== hardware.environment.cooling.mode
  ) {
    fail("ART_JOIN_MISMATCH", "run-plan same-condition digests or parameters differ");
  }

  assertExactKeys(
    runPlan.harness,
    [
      "command",
      "core",
      "environment_allowlist",
      "lockfile",
      "ui",
    ],
    "run-plan.harness",
  );
  validateInputReference(runPlan.harness.core, "run-plan.harness.core", contractEntries);
  validateInputReference(
    runPlan.harness.lockfile,
    "run-plan.harness.lockfile",
    contractEntries,
  );
  validateInputReference(runPlan.harness.ui, "run-plan.harness.ui", contractEntries);
  if (runPlan.harness.lockfile.sha256 !== descriptor.package_lock_sha256) {
    fail("ART_JOIN_MISMATCH", "run-plan harness identities do not join sealed assets");
  }
  assertExactKeys(
    runPlan.harness.command,
    ["argv", "cwd", "executable_path"],
    "run-plan.harness.command",
  );
  validateArtifactPath(runPlan.harness.command.cwd, "run-plan.harness.command.cwd");
  validateArtifactPath(
    runPlan.harness.command.executable_path,
    "run-plan.harness.command.executable_path",
  );
  const workerArtifact = candidate.artifacts.find(
    (artifact) => artifact.role === "worker-executable",
  );
  if (
    runPlan.harness.command.executable_path !== workerArtifact?.path ||
    !Array.isArray(runPlan.harness.command.argv) ||
    runPlan.harness.command.argv.some((value) => typeof value !== "string") ||
    !Array.isArray(runPlan.harness.environment_allowlist) ||
    runPlan.harness.environment_allowlist.some(
      (value) => typeof value !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(value),
    )
  ) {
    fail("ART_SCHEMA_VALUE", "run-plan command or environment allowlist differs");
  }
}

function validateEvidenceManifest(evidence, contractDigest, runPlan, candidate, fixtureSet, hardware) {
  assertExactKeys(
    evidence,
    [
      "candidate_ids",
      "build_profile",
      "command",
      "command_exit_code",
      "contract_manifest_sha256",
      "ended_at",
      "eligibility_status",
      "evidence_manifest_id",
      "execution_status",
      "exclusions",
      "failures",
      "fixture_set_id",
      "formal_claims",
      "formal_metric_ids",
      "hw_ref_id",
      "observation_scope",
      "output_artifacts",
      "production_claims",
      "production_evidence",
      "ranking_status",
      "run_id",
      "run_plan_id",
      "schema_version",
      "selection_status",
      "slo_claims",
      "source_commit",
      "started_at",
    ],
    "evidence",
  );
  assertDigest(evidence.contract_manifest_sha256, "evidence.contract_manifest_sha256");
  if (evidence.contract_manifest_sha256 !== contractDigest) {
    fail("ART_JOIN_CONTRACT_MISMATCH", "evidence references the wrong sealed contract");
  }
  validateClaims(
    Object.fromEntries(CLAIM_KEYS.map((key) => [key, evidence[key]])),
    "evidence.claims",
  );
  assertExactKeys(
    evidence.command,
    ["argv", "cwd", "executable_path"],
    "evidence.command",
  );
  validateArtifactPath(evidence.command.cwd, "evidence.command.cwd");
  validateArtifactPath(
    evidence.command.executable_path,
    "evidence.command.executable_path",
  );
  if (
    !Array.isArray(evidence.command.argv) ||
    evidence.command.argv.some((value) => typeof value !== "string") ||
    evidence.command.cwd !== runPlan.harness.command.cwd ||
    evidence.command.executable_path !==
      runPlan.harness.command.executable_path ||
    JSON.stringify(evidence.command.argv) !==
      JSON.stringify(runPlan.harness.command.argv) ||
    evidence.build_profile !== runPlan.build_profile ||
    !Array.isArray(evidence.failures) ||
    evidence.failures.some((value) => typeof value !== "string") ||
    !Array.isArray(evidence.exclusions) ||
    evidence.exclusions.some((value) => typeof value !== "string")
  ) {
    fail("ART_JOIN_CONTRACT_MISMATCH", "evidence command, build, or audit arrays differ");
  }
  const isNotRun = evidence.execution_status === "not-run";
  const isCompleted = evidence.execution_status === "completed";
  const isFailed = evidence.execution_status === "failed";
  if (
    evidence.schema_version !== "1.0" ||
    evidence.evidence_manifest_id !== runPlan.evidence_manifest_id ||
    (!isNotRun && !isCompleted && !isFailed) ||
    (isNotRun && evidence.observation_scope !== "contract-fixture-only") ||
    ((isCompleted || isFailed) &&
      evidence.observation_scope !== "candidate-run-raw") ||
    evidence.eligibility_status !== "not-assessed" ||
    evidence.selection_status !== "not-selected" ||
    evidence.ranking_status !== "not-ranked" ||
    !Array.isArray(evidence.output_artifacts) ||
    (isNotRun && evidence.output_artifacts.length !== 0) ||
    ((isCompleted || isFailed) && evidence.output_artifacts.length === 0) ||
    evidence.output_artifacts.length > 1024
  ) {
    fail("ART_CLAIM_UNSUPPORTED", "evidence exceeds the WP-0.4.2 contract-fixture authority");
  }
  const outputIds = [];
  const outputPaths = [];
  for (const [index, artifact] of evidence.output_artifacts.entries()) {
    validateEvidenceArtifactDescriptor(
      artifact,
      "evidence.output_artifacts[" + index + "]",
    );
    outputIds.push(artifact.artifact_id);
    outputPaths.push(artifact.path);
  }
  if (outputIds.length > 0) {
    assertUnique(outputIds, "evidence output artifact IDs");
    assertUnique(outputPaths, "evidence output artifact paths");
  }
  if (
    isNotRun &&
    (evidence.run_id !== null ||
      evidence.source_commit !== null ||
      evidence.started_at !== null ||
      evidence.ended_at !== null ||
      evidence.command_exit_code !== null ||
      evidence.failures.length !== 0 ||
      evidence.exclusions.length !== 0)
  ) {
    fail("ART_CLAIM_UNSUPPORTED", "not-run evidence cannot contain runtime observations");
  }
  if (isCompleted || isFailed) {
    assertIdentifier(evidence.run_id, "evidence.run_id");
    const startedAtNs = parseRfc3339Nanoseconds(
      evidence.started_at,
      "evidence.started_at",
    );
    const endedAtNs = parseRfc3339Nanoseconds(
      evidence.ended_at,
      "evidence.ended_at",
    );
    if (
      typeof evidence.source_commit !== "string" ||
      !/^[0-9a-f]{40}$/.test(evidence.source_commit) ||
      evidence.source_commit !== runPlan.source_commit ||
      endedAtNs < startedAtNs ||
      !Number.isInteger(evidence.command_exit_code) ||
      evidence.command_exit_code < 0 ||
      evidence.command_exit_code > 0x7fffffff ||
      (isCompleted &&
        (evidence.command_exit_code !== 0 || evidence.failures.length !== 0)) ||
      (isFailed && evidence.failures.length === 0)
    ) {
      fail("ART_SCHEMA_VALUE", "executed evidence runtime fields are invalid");
    }
  }
  if (
    evidence.run_plan_id !== runPlan.run_plan_id ||
    JSON.stringify(evidence.candidate_ids) !== JSON.stringify([candidate.candidate_id]) ||
    evidence.fixture_set_id !== fixtureSet.fixture_set_id ||
    evidence.hw_ref_id !== hardware.hw_ref_id ||
    (isNotRun && runPlan.scope !== "contract-fixture-only") ||
    ((isCompleted || isFailed) && runPlan.scope !== "candidate-run")
  ) {
    fail("ART_JOIN_CONTRACT_MISMATCH", "evidence input IDs differ from the sealed contract");
  }
}

export async function validateCandidateArtifactBundle(
  root = DEFAULT_BUNDLE_ROOT,
  options = {},
) {
  const resolvedRoot = path.resolve(root);
  const files = await listFiles(resolvedRoot);
  for (const requiredPath of [
    CONTRACT_MANIFEST_PATH,
    CONTRACT_SEAL_PATH,
    CANDIDATE_MANIFEST_PATH,
    FIXTURE_SET_MANIFEST_PATH,
    HW_REF_PATH,
    RUN_PLAN_PATH,
    EVIDENCE_MANIFEST_PATH,
    EVIDENCE_SEAL_PATH,
  ]) {
    if (!files.includes(requiredPath)) {
      fail("ART_INVENTORY_MISMATCH", requiredPath + " is missing", requiredPath);
    }
  }

  const contractSeal = await validateSeal(
    resolvedRoot,
    CONTRACT_MANIFEST_PATH,
    CONTRACT_SEAL_PATH,
    CONTRACT_MANIFEST_PATH,
  );
  const contract = contractSeal.value;
  assertExactKeys(
    contract,
    ["contract_id", "entries", "formal_claims", "schema_version"],
    "contract-manifest",
  );
  if (
    contract.schema_version !== "1.0" ||
    contract.formal_claims !== "none"
  ) {
    fail("ART_CLAIM_UNSUPPORTED", "contract manifest identity or claim scope differs");
  }
  assertIdentifier(contract.contract_id, "contract-manifest.contract_id");
  if (
    !Array.isArray(contract.entries) ||
    contract.entries.length < 4 ||
    contract.entries.length > 4096
  ) {
    fail("ART_INVENTORY_MISMATCH", "contract manifest entry count differs");
  }
  const contractEntries = new Map();
  for (const [index, entry] of contract.entries.entries()) {
    assertExactKeys(entry, ["path", "sha256", "size_bytes"], "contract.entries[" + index + "]");
    validateArtifactPath(entry.path, "contract.entries[" + index + "].path");
    assertDigest(entry.sha256, "contract.entries[" + index + "].sha256");
    assertCanonicalU64(entry.size_bytes, "contract.entries[" + index + "].size_bytes", 1n);
    if (contractEntries.has(entry.path)) {
      fail("ART_SCHEMA_DUPLICATE_ID", "contract manifest contains a duplicate path");
    }
    if (
      [
        CONTRACT_MANIFEST_PATH,
        CONTRACT_SEAL_PATH,
        EVIDENCE_MANIFEST_PATH,
        EVIDENCE_SEAL_PATH,
      ].includes(entry.path)
    ) {
      fail("ART_INVENTORY_MISMATCH", "contract entry crosses an input/output seal boundary");
    }
    contractEntries.set(entry.path, entry);
  }
  if (
    contract.entries.some(
      (entry, index) => index > 0 && contract.entries[index - 1].path >= entry.path,
    ) ||
    [CANDIDATE_MANIFEST_PATH, FIXTURE_SET_MANIFEST_PATH, HW_REF_PATH, RUN_PLAN_PATH].some(
      (requiredPath) => !contractEntries.has(requiredPath),
    )
  ) {
    fail("ART_INVENTORY_MISMATCH", "contract manifest paths are unsorted or incomplete");
  }
  const canonicalInputCache = new Map();
  for (const entry of contract.entries) {
    let actual;
    if (entry.path.endsWith(".json") || entry.path.endsWith(".lock")) {
      const parsed = await readCanonicalJson(resolvedRoot, entry.path);
      canonicalInputCache.set(entry.path, parsed);
      actual = {
        sha256: sha256(parsed.bytes),
        sizeBytes: String(parsed.bytes.length),
      };
    } else {
      actual = await digestRegularFile(resolvedRoot, entry.path);
    }
    if (actual.sha256 !== entry.sha256 || actual.sizeBytes !== entry.size_bytes) {
      fail("ART_DIGEST_MISMATCH", entry.path + " differs from its sealed digest", entry.path);
    }
  }
  for (const [relativePath, parsed] of canonicalInputCache) {
    validateEmbeddedClaimBoundary(parsed.value, relativePath);
  }

  const fixtureRegistry = await readFixtureRegistryProjection();
  const cachedValue = (relativePath) => {
    const parsed = canonicalInputCache.get(relativePath);
    if (!parsed) {
      fail("ART_JOIN_MISMATCH", relativePath + " is not a sealed canonical JSON input");
    }
    return parsed.value;
  };
  const candidate = cachedValue(CANDIDATE_MANIFEST_PATH);
  const fixtureSet = cachedValue(FIXTURE_SET_MANIFEST_PATH);
  const hardware = cachedValue(HW_REF_PATH);
  const runPlan = cachedValue(RUN_PLAN_PATH);
  validateCandidateManifest(candidate, contractEntries);
  await validateLicenseTexts(resolvedRoot, candidate);
  if (
    candidate.artifact_scope === "contract-fixture-only" &&
    contract.contract_id !== CONTRACT_TEST_ID
  ) {
    fail("ART_JOIN_CONTRACT_MISMATCH", "contract fixture uses an unexpected contract ID");
  }
  if (candidate.artifact_scope === "candidate-input") {
    if (options.expectedContractSha256 === undefined) {
      fail(
        "ART_TRUST_ANCHOR_REQUIRED",
        "candidate input requires an independently supplied contract digest",
      );
    }
    assertDigest(
      options.expectedContractSha256,
      "options.expectedContractSha256",
    );
    if (options.expectedContractSha256 !== contractSeal.digest) {
      fail("ART_JOIN_CONTRACT_MISMATCH", "candidate input trust anchor differs");
    }
    if (candidate.publishability_status === "accepted") {
      if (
        !Array.isArray(options.approvedLicenseSha256s) ||
        options.approvedLicenseSha256s.length === 0
      ) {
        fail(
          "ART_LICENSE_APPROVAL_REQUIRED",
          "accepted candidate input requires independently approved license digests",
        );
      }
      for (const digest of options.approvedLicenseSha256s) {
        assertDigest(digest, "options.approvedLicenseSha256s[]");
      }
      if (
        candidate.licenses.some(
          (license) =>
            !options.approvedLicenseSha256s.includes(license.text_sha256),
        )
      ) {
        fail(
          "ART_LICENSE_APPROVAL_REQUIRED",
          "candidate license digest is not present in the approved set",
        );
      }
    }
  }
  validateFixtureSetManifest(fixtureSet, fixtureRegistry);
  validateHardwareReference(hardware, contractEntries);
  const artifactByRole = new Map(
    candidate.artifacts.map((artifact) => [artifact.role, artifact]),
  );
  const readRoleJson = async (role) => {
    const artifact = artifactByRole.get(role);
    if (!artifact) {
      fail("ART_JOIN_MISMATCH", "candidate is missing required role " + role);
    }
    return cachedValue(artifact.path);
  };
  const parameters = await readRoleJson("parameters");
  const modelManifest = await readRoleJson("model-manifest");
  const packageLock = await readRoleJson("package-lock");
  const schemaRegistry = await readRoleJson("schema-registry");
  const vadEndpointPlan = cachedValue(
    runPlan.same_condition_contract.endpoint_parameters.path,
  );
  const warmupPlan = cachedValue(
    runPlan.same_condition_contract.warmup_plan.path,
  );
  validateJsonContractAssets(
    modelManifest,
    packageLock,
    parameters,
    schemaRegistry,
    vadEndpointPlan,
    warmupPlan,
    candidate,
  );
  validateRunPlan(
    runPlan,
    candidate,
    fixtureSet,
    hardware,
    parameters,
    contractEntries,
  );

  const evidenceSeal = await validateSeal(
    resolvedRoot,
    EVIDENCE_MANIFEST_PATH,
    EVIDENCE_SEAL_PATH,
    "evidence-manifest.json",
  );
  const evidence = evidenceSeal.value;
  validateEvidenceManifest(
    evidence,
    contractSeal.digest,
    runPlan,
    candidate,
    fixtureSet,
    hardware,
  );
  for (const artifact of evidence.output_artifacts) {
    const actual = await digestRegularFile(resolvedRoot, artifact.path);
    if (
      actual.sha256 !== artifact.sha256 ||
      actual.sizeBytes !== artifact.size_bytes
    ) {
      fail(
        "ART_DIGEST_MISMATCH",
        artifact.path + " differs from the evidence manifest",
        artifact.path,
      );
    }
    if (artifact.path.endsWith(".json")) {
      const parsed = await readCanonicalJson(resolvedRoot, artifact.path);
      validateEmbeddedClaimBoundary(parsed.value, artifact.path);
    }
  }

  const usedInputPaths = new Set([
    CANDIDATE_MANIFEST_PATH,
    FIXTURE_SET_MANIFEST_PATH,
    HW_REF_PATH,
    RUN_PLAN_PATH,
    ...candidate.artifacts.map((artifact) => artifact.path),
    ...candidate.licenses.map((license) => license.text_path),
    hardware.collector.path,
    runPlan.harness.core.path,
    runPlan.harness.lockfile.path,
    runPlan.harness.ui.path,
    runPlan.same_condition_contract.endpoint_parameters.path,
    runPlan.same_condition_contract.vad_parameters.path,
    runPlan.same_condition_contract.warmup_plan.path,
  ]);
  if (
    ![...usedInputPaths].some(
      (relativePath) =>
        contractEntries.get(relativePath)?.sha256 === candidate.source.source_sha256,
    )
  ) {
    const sourceMatches = [...contractEntries.values()].filter(
      (entry) => entry.sha256 === candidate.source.source_sha256,
    );
    if (sourceMatches.length !== 1) {
      fail("ART_JOIN_MISMATCH", "candidate source digest is ambiguous or unreferenced");
    }
    usedInputPaths.add(sourceMatches[0].path);
  }
  const sealedInputPaths = [...contractEntries.keys()].sort();
  const requiredInputPaths = [...usedInputPaths].sort();
  if (
    sealedInputPaths.length !== requiredInputPaths.length ||
    sealedInputPaths.some(
      (relativePath, index) => relativePath !== requiredInputPaths[index],
    )
  ) {
    fail("ART_INVENTORY_MISMATCH", "contract manifest contains an unused or missing input");
  }
  const expectedFiles = [
    CONTRACT_MANIFEST_PATH,
    CONTRACT_SEAL_PATH,
    EVIDENCE_MANIFEST_PATH,
    EVIDENCE_SEAL_PATH,
    ...sealedInputPaths,
    ...evidence.output_artifacts.map((artifact) => artifact.path),
  ].sort();
  const finalFiles = await listFiles(resolvedRoot);
  if (
    finalFiles.length !== expectedFiles.length ||
    finalFiles.some(
      (relativePath, index) => relativePath !== expectedFiles[index],
    )
  ) {
    fail(
      "ART_INVENTORY_MISMATCH",
      "bundle inventory differs: " + finalFiles.join(","),
      resolvedRoot,
    );
  }
  for (const entry of contract.entries) {
    const postflight = await digestRegularFile(resolvedRoot, entry.path);
    if (
      postflight.sha256 !== entry.sha256 ||
      postflight.sizeBytes !== entry.size_bytes
    ) {
      fail(
        "ART_DIGEST_MISMATCH",
        entry.path + " changed during contract validation",
        entry.path,
      );
    }
  }
  for (const artifact of evidence.output_artifacts) {
    const postflight = await digestRegularFile(resolvedRoot, artifact.path);
    if (
      postflight.sha256 !== artifact.sha256 ||
      postflight.sizeBytes !== artifact.size_bytes
    ) {
      fail(
        "ART_DIGEST_MISMATCH",
        artifact.path + " changed during evidence validation",
        artifact.path,
      );
    }
  }

  return {
    bundleRoot: resolvedRoot,
    candidateId: candidate.candidate_id,
    contractManifestSha256: contractSeal.digest,
    contractTestId: contract.contract_id,
    evidenceManifestSha256: evidenceSeal.digest,
    fixtureManifestSha256: fixtureRegistry.manifestSha256,
    formalClaims: "none",
    productionEvidence: false,
    status: "passed",
  };
}

export const candidateArtifactPaths = Object.freeze({
  contractManifestPath: CONTRACT_MANIFEST_PATH,
  contractSealPath: CONTRACT_SEAL_PATH,
  defaultBundleRoot: DEFAULT_BUNDLE_ROOT,
  evidenceManifestPath: EVIDENCE_MANIFEST_PATH,
  evidenceSealPath: EVIDENCE_SEAL_PATH,
  expectedFiles: EXPECTED_FILES,
  repositoryRoot: REPOSITORY_ROOT,
});
