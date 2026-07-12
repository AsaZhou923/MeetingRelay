import { createHash } from "node:crypto";

import {
  canonicalizeJson,
  encodeCanonicalJson,
  encodeCanonicalJsonLine,
} from "../phase0-harness/canonical-json.mjs";
import {
  validateArtifactPath,
  validatePlannedCandidateManifest,
} from "../phase0-harness/candidate-artifact-contract.mjs";
import { validateLockObject } from "./validate-lock.mjs";

const MAX_U64 = (1n << 64n) - 1n;
const HEX_40 = /^[0-9a-f]{40}$/u;
const HEX_64 = /^[0-9a-f]{64}$/u;
const HTTPS_URL = /^https:\/\/\S+$/u;
const PROJECT_COMMIT_URL_PREFIX =
  "https://github.com/AsaZhou923/MeetingRelay/commit/";

const PLAN_KIND = "meetingrelay-sherpa-candidate-input-plan-v1";
const PLAN_SCHEMA_VERSION = "1.0";
const CANDIDATE_MANIFEST_PATH = "manifests/candidate-manifest.json";
const PROJECT_NOTICE_PATH = "licenses/meetingrelay-unlicensed-notice.txt";
const PROJECT_NOTICE_SOURCE_PATH =
  "tools/sherpa-native/licenses/meetingrelay-unlicensed-notice.txt";
const PROJECT_LICENSE_ID =
  "LicenseRef-MeetingRelay-Unlicensed-Internal-Evaluation";
const RUNTIME_INVENTORY_SIZE_BYTES = "935";
const RUNTIME_INVENTORY_SHA256 =
  "0682618f660a2a9f2278d99decb77624253aadde60e8199a9b07813b8d843317";
const WORKER_ID = "meetingrelay-sherpa-native-candidate-host-v1";
const RUST_TOOLCHAIN = "rust-1.95.0";

export const MEETINGRELAY_UNLICENSED_NOTICE = [
  "MeetingRelay Project Status Notice",
  "",
  "This file is a status notice only. It is not a license.",
  "",
  "MeetingRelay-authored portions of this repository are UNLICENSED.",
  "This status notice does not replace, amend, limit, or extend any third-party license terms.",
  "No rights or permission are granted to copy, modify, redistribute, or publish MeetingRelay-authored portions.",
  "Internal Phase 0 evaluation records the review scope only; it is not authorization.",
  "When attached to a compiled worker, this project notice is only a conservative non-publishable blocker. It is not a complete dependency license list or SBOM.",
  "Release SBOM, distribution approval, Legal review, and Product review remain pending.",
  "",
].join("\n");

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

// This is the only artifact-to-material mapping. Both the candidate manifest
// and the materialization plan are derived from it.
export const SHERPA_CANDIDATE_ARTIFACT_MAPPING = deepFreeze([
  {
    artifact_id: "artifact-cargo-lock",
    identity: "cargo-lock",
    license: "project",
    material_kind: "copy",
    role: "package-lock",
    source_relative_path: "Cargo.lock",
    source_root: "repository",
    target_path: "assets/Cargo.lock",
  },
  {
    artifact_id: "artifact-assets-lock",
    identity: "assets-lock",
    license: "project",
    material_kind: "copy",
    role: "model-manifest",
    source_relative_path: "tools/sherpa-native/assets.lock.json",
    source_root: "repository",
    target_path: "assets/assets.lock.json",
  },
  {
    artifact_id: "artifact-schema-registry",
    identity: "schema-registry",
    license: "project",
    material_kind: "copy",
    role: "schema-registry",
    source_relative_path: "tools/sherpa-native/candidate-schema-registry.json",
    source_root: "repository",
    target_path: "assets/candidate-schema-registry.json",
  },
  {
    artifact_id: "artifact-worker-executable",
    identity: "worker-executable",
    license: "project",
    material_kind: "copy",
    role: "worker-executable",
    source_relative_path: "release/meetingrelay-sherpa-candidate-host.exe",
    source_root: "rust-target",
    target_path: "assets/meetingrelay-sherpa-candidate-host.exe",
  },
  {
    artifact_id: "artifact-model",
    identity: "model",
    license: "model",
    material_kind: "copy",
    role: "model",
    source_relative_path: "model.int8.onnx",
    source_root: "sherpa-model-extraction",
    target_path: "assets/model.int8.onnx",
  },
  {
    artifact_id: "artifact-parameters",
    identity: "parameters",
    license: "project",
    material_kind: "document",
    role: "parameters",
    target_path: "assets/parameters.json",
  },
  {
    artifact_id: "artifact-runtime-inventory",
    identity: "runtime-inventory",
    license: "project",
    material_kind: "document",
    role: "runtime",
    target_path: "assets/runtime-inventory.json",
  },
  {
    artifact_id: "artifact-runtime-onnxruntime-dll",
    identity: "runtime:lib/onnxruntime.dll",
    license: "onnxruntime",
    material_kind: "copy",
    role: "runtime-file-onnxruntime-dll",
    source_relative_path: "lib/onnxruntime.dll",
    source_root: "sherpa-runtime-extraction",
    target_path: "assets/runtime/lib/onnxruntime.dll",
  },
  {
    artifact_id: "artifact-runtime-onnxruntime-lib",
    identity: "runtime:lib/onnxruntime.lib",
    license: "onnxruntime",
    material_kind: "copy",
    role: "runtime-file-onnxruntime-lib",
    source_relative_path: "lib/onnxruntime.lib",
    source_root: "sherpa-runtime-extraction",
    target_path: "assets/runtime/lib/onnxruntime.lib",
  },
  {
    artifact_id: "artifact-runtime-onnxruntime-providers-shared-dll",
    identity: "runtime:lib/onnxruntime_providers_shared.dll",
    license: "onnxruntime",
    material_kind: "copy",
    role: "runtime-file-onnxruntime-providers-shared-dll",
    source_relative_path: "lib/onnxruntime_providers_shared.dll",
    source_root: "sherpa-runtime-extraction",
    target_path: "assets/runtime/lib/onnxruntime_providers_shared.dll",
  },
  {
    artifact_id: "artifact-runtime-sherpa-onnx-c-api-dll",
    identity: "runtime:lib/sherpa-onnx-c-api.dll",
    license: "sherpa",
    material_kind: "copy",
    role: "runtime-file-sherpa-onnx-c-api-dll",
    source_relative_path: "lib/sherpa-onnx-c-api.dll",
    source_root: "sherpa-runtime-extraction",
    target_path: "assets/runtime/lib/sherpa-onnx-c-api.dll",
  },
  {
    artifact_id: "artifact-runtime-sherpa-onnx-c-api-lib",
    identity: "runtime:lib/sherpa-onnx-c-api.lib",
    license: "sherpa",
    material_kind: "copy",
    role: "runtime-file-sherpa-onnx-c-api-lib",
    source_relative_path: "lib/sherpa-onnx-c-api.lib",
    source_root: "sherpa-runtime-extraction",
    target_path: "assets/runtime/lib/sherpa-onnx-c-api.lib",
  },
  {
    artifact_id: "artifact-runtime-sherpa-onnx-cxx-api-dll",
    identity: "runtime:lib/sherpa-onnx-cxx-api.dll",
    license: "sherpa",
    material_kind: "copy",
    role: "runtime-file-sherpa-onnx-cxx-api-dll",
    source_relative_path: "lib/sherpa-onnx-cxx-api.dll",
    source_root: "sherpa-runtime-extraction",
    target_path: "assets/runtime/lib/sherpa-onnx-cxx-api.dll",
  },
  {
    artifact_id: "artifact-runtime-sherpa-onnx-cxx-api-lib",
    identity: "runtime:lib/sherpa-onnx-cxx-api.lib",
    license: "sherpa",
    material_kind: "copy",
    role: "runtime-file-sherpa-onnx-cxx-api-lib",
    source_relative_path: "lib/sherpa-onnx-cxx-api.lib",
    source_root: "sherpa-runtime-extraction",
    target_path: "assets/runtime/lib/sherpa-onnx-cxx-api.lib",
  },
  {
    artifact_id: "artifact-tokens",
    identity: "tokens",
    license: "model",
    material_kind: "copy",
    role: "tokens",
    source_relative_path: "tokens.txt",
    source_root: "sherpa-model-extraction",
    target_path: "assets/tokens.txt",
  },
]);

export class CandidateInputPlanError extends Error {
  constructor(code, message, field = null) {
    super(`${code}: ${message}${field === null ? "" : ` (${field})`}`);
    this.name = "CandidateInputPlanError";
    this.code = code;
    this.field = field;
  }
}

function fail(code, message, field = null) {
  throw new CandidateInputPlanError(code, message, field);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function exactKeys(value, expected, field) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("PLAN_SCHEMA_TYPE", "expected an object", field);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(
      "PLAN_UNKNOWN_FIELD",
      `expected keys ${wanted.join(",")}, got ${actual.join(",")}`,
      field,
    );
  }
}

function exact(value, expected, field) {
  if (value !== expected) {
    fail("PLAN_JOIN_MISMATCH", `expected ${JSON.stringify(expected)}`, field);
  }
}

function exactJson(value, expected, field) {
  if (JSON.stringify(value) !== JSON.stringify(expected)) {
    fail("PLAN_JOIN_MISMATCH", "JSON value differs from its locked source", field);
  }
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function inputBuffer(value, field) {
  if (!Buffer.isBuffer(value)) {
    fail("PLAN_BUFFER_REQUIRED", "expected a Buffer", field);
  }
  return Buffer.from(value);
}

function utf8Text(bytes, field) {
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes) || text.startsWith("\uFEFF")) {
    fail("PLAN_UTF8", "expected canonical UTF-8 without a BOM", field);
  }
  return text;
}

function parseJson(bytes, field) {
  const text = utf8Text(bytes, field);
  try {
    return { text, value: JSON.parse(text) };
  } catch (error) {
    fail("PLAN_JSON", error instanceof Error ? error.message : "invalid JSON", field);
  }
}

function parseCanonicalCompactLine(bytes, field) {
  const parsed = parseJson(bytes, field);
  if (parsed.text !== encodeCanonicalJsonLine(parsed.value)) {
    fail(
      "PLAN_CANONICAL_LINE",
      "expected recursively sorted NFC compact JSON with exactly one LF",
      field,
    );
  }
  return parsed.value;
}

function parseCanonicalIndented(bytes, field, recursivelySorted) {
  const parsed = parseJson(bytes, field);
  const expected = recursivelySorted
    ? encodeCanonicalJson(parsed.value)
    : `${JSON.stringify(parsed.value, null, 2)}\n`;
  if (parsed.text !== expected) {
    fail("PLAN_CANONICAL_JSON", "expected exact two-space JSON with one LF", field);
  }
  return parsed.value;
}

function canonicalU64(value, field, minimum = 0n) {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/u.test(value)) {
    fail("PLAN_U64", "expected a canonical uint64 string", field);
  }
  const parsed = BigInt(value);
  if (parsed < minimum || parsed > MAX_U64) {
    fail("PLAN_U64", "value is outside uint64 bounds", field);
  }
  return value;
}

function digest(value, field) {
  if (typeof value !== "string" || !HEX_64.test(value) || value === "0".repeat(64)) {
    fail("PLAN_DIGEST", "expected a non-zero lowercase SHA-256", field);
  }
  return value;
}

function entryByPath(inventory, relativePath, field) {
  const matches = inventory.filter((entry) => entry.path === relativePath);
  if (matches.length !== 1) {
    fail("PLAN_JOIN_MISMATCH", "expected exactly one locked inventory entry", field);
  }
  return matches[0];
}

function identityOf(bytes) {
  return { sha256: sha256(bytes), size_bytes: String(bytes.length) };
}

function licenseRecord(source, bytes, overrides = {}) {
  const identity = identityOf(bytes);
  return {
    distribution_status: "pending",
    license_id: source.license_id,
    review_scope: "internal-evaluation-only",
    review_source_status: source.review_status,
    review_status: "accepted",
    source_revision: source.source_revision,
    source_url: source.source_url,
    spdx_or_license_ref: source.license_id,
    text_path: source.snapshot_path,
    text_sha256: identity.sha256,
    text_size_bytes: identity.size_bytes,
    ...overrides,
  };
}

function copyMaterial(spec, identity) {
  validateArtifactPath(spec.source_relative_path, `${spec.identity}.source_relative_path`);
  return {
    kind: "copy",
    sha256: identity.sha256,
    size_bytes: identity.size_bytes,
    source_relative_path: spec.source_relative_path,
    source_root: spec.source_root,
    target_path: spec.target_path,
  };
}

function documentMaterial(spec, bytes) {
  const output = Buffer.from(bytes);
  const identity = identityOf(output);
  return {
    bytes: output,
    kind: "document",
    sha256: identity.sha256,
    size_bytes: identity.size_bytes,
    target_path: spec.target_path,
  };
}

function validateBuilder(builder, lock, identities) {
  exactKeys(builder, [
    "candidate_id",
    "claims",
    "deferred_builder_fields",
    "license_input",
    "locked_assets",
    "non_claim_guardrails",
    "projection_kind",
    "projection_schema_version",
    "publishability_status",
    "selection_status",
    "trust_anchor_policy",
    "worker_contract_version",
    "worker_manifest_descriptor_fragment",
    "worker_role",
  ], "rustBuilderInput");
  exact(builder.projection_kind, "sherpa-candidate-builder-input-v1", "builder.projection_kind");
  exact(
    builder.candidate_id,
    "sherpa-native-sensevoice-int8-2024-07-17-win-x64-cpu",
    "builder.candidate_id",
  );
  exact(builder.projection_schema_version, "1.0", "builder.projection_schema_version");
  exact(builder.worker_role, "native-candidate", "builder.worker_role");
  exact(builder.worker_contract_version, "meetingrelay.model-worker/1.0", "builder.worker_contract_version");
  exact(builder.publishability_status, "pending", "builder.publishability_status");
  exact(builder.selection_status, "not-selected", "builder.selection_status");
  exact(builder.trust_anchor_policy, "external-expectedContractSha256-required", "builder.trust_anchor_policy");
  exactJson(builder.claims, {
    formal_claims: "none",
    formal_metric_ids: [],
    production_claims: [],
    production_evidence: false,
    slo_claims: [],
  }, "builder.claims");
  exactJson(builder.non_claim_guardrails, {
    eligibility_status: "not-assessed",
    execution_status: "not-run",
    measurement_status: "not-measured",
    quality_evidence: false,
    ranking_status: "not-ranked",
  }, "builder.non_claim_guardrails");
  exactJson(builder.deferred_builder_fields, [
    "artifact-inventory-paths-roles-sizes-and-license-mapping",
    "build-and-source-metadata",
    "candidate-input-envelope-and-seals",
    "contract-wrapper-assets-and-role-digest-joins",
    "executable-worker-build-and-schema-registry-digests",
    "external-expectedContractSha256-value",
    "fixture-hw-run-plan-and-evidence",
    "validator-schema-bridge-for-assets-lock-cargo-lock-and-full-parameters",
    "worker-id",
  ], "builder.deferred_builder_fields");

  const modelLicense = lock.model.current_license_snapshot;
  exactJson(builder.license_input, {
    distribution_status: modelLicense.distribution_status,
    license_id: modelLicense.license_id,
    review_scope: "internal-evaluation-only",
    review_source_status: modelLicense.review_status,
    review_status: "accepted",
    source_revision: modelLicense.source_revision,
    source_url: modelLicense.source_url,
    spdx_or_license_ref: modelLicense.license_id,
    text_path: modelLicense.snapshot_path,
    text_sha256: modelLicense.sha256,
    text_size_bytes: String(modelLicense.size_bytes),
  }, "builder.license_input");

  const model = entryByPath(
    lock.model.archive.inventory,
    lock.entrypoints.model_relative_path,
    "lock.entrypoints.model_relative_path",
  );
  const tokens = entryByPath(
    lock.model.archive.inventory,
    lock.entrypoints.tokens_relative_path,
    "lock.entrypoints.tokens_relative_path",
  );
  exactJson(builder.locked_assets, {
    asset_lock_sha256: identities.assetsLock.sha256,
    model_license_text_sha256: modelLicense.sha256,
    model_sha256: model.sha256,
    package_lock_sha256: identities.cargoLock.sha256,
    parameter_sha256: lock.parameters.canonical_json_sha256,
    runtime_bundle_sha256: lock.runtime.archive.bundle_sha256,
    tokens_sha256: tokens.sha256,
  }, "builder.locked_assets");
}

function validateDescriptor(descriptor, lock, identities) {
  exactKeys(descriptor, [
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
  ], "descriptor");
  const model = entryByPath(lock.model.archive.inventory, lock.entrypoints.model_relative_path, "model");
  exactJson(descriptor, {
    engine_id: "sherpa-onnx",
    engine_version: lock.runtime.rust_crate.version,
    execution_provider: lock.parameters.provider,
    languages: [lock.parameters.language],
    model_id: lock.model.model_id,
    model_license_id: lock.model.current_license_snapshot.license_id,
    model_manifest_sha256: identities.assetsLock.sha256,
    model_sha256: model.sha256,
    offline: true,
    package_lock_sha256: identities.cargoLock.sha256,
    parameter_sha256: lock.parameters.canonical_json_sha256,
    quantization: "int8",
    runtime_id: "sherpa-onnx-shared-cpu",
    runtime_sha256: lock.runtime.archive.bundle_sha256,
    runtime_version: lock.runtime.onnxruntime_file_version,
    streaming: true,
  }, "descriptor");
}

function validateWorkerProjection(worker, builder, lock, identities, workerSize) {
  exactKeys(worker, [
    "descriptor",
    "executable_sha256",
    "role",
    "schema_registry_sha256",
    "worker_build_sha256",
    "worker_id",
  ], "releaseWorkerProjection");
  exact(worker.role, "native-candidate", "worker.role");
  exact(worker.worker_id, WORKER_ID, "worker.worker_id");
  digest(worker.executable_sha256, "worker.executable_sha256");
  exact(worker.worker_build_sha256, worker.executable_sha256, "worker.worker_build_sha256");
  exact(worker.schema_registry_sha256, identities.schemaRegistry.sha256, "worker.schema_registry_sha256");
  canonicalU64(workerSize, "workerExecutableSizeBytes", 1n);
  exactJson(
    worker.descriptor,
    builder.worker_manifest_descriptor_fragment,
    "worker.descriptor",
  );
  validateDescriptor(worker.descriptor, lock, identities);
}

function resolveArtifactIdentity(spec, context) {
  if (spec.identity === "cargo-lock") return context.identities.cargoLock;
  if (spec.identity === "assets-lock") return context.identities.assetsLock;
  if (spec.identity === "schema-registry") return context.identities.schemaRegistry;
  if (spec.identity === "worker-executable") {
    return {
      sha256: context.worker.executable_sha256,
      size_bytes: context.workerSize,
    };
  }
  if (spec.identity === "parameters") return identityOf(context.parameterBytes);
  if (spec.identity === "runtime-inventory") return identityOf(context.runtimeInventoryBytes);
  if (spec.identity === "model" || spec.identity === "tokens") {
    const relativePath =
      spec.identity === "model"
        ? context.lock.entrypoints.model_relative_path
        : context.lock.entrypoints.tokens_relative_path;
    const entry = entryByPath(
      context.lock.model.archive.inventory,
      relativePath,
      `artifact.${spec.identity}`,
    );
    return { sha256: entry.sha256, size_bytes: String(entry.size_bytes) };
  }
  if (spec.identity.startsWith("runtime:")) {
    const relativePath = spec.identity.slice("runtime:".length);
    const entry = entryByPath(
      context.lock.runtime.archive.inventory,
      relativePath,
      `artifact.${spec.identity}`,
    );
    return { sha256: entry.sha256, size_bytes: String(entry.size_bytes) };
  }
  fail("PLAN_INTERNAL", "unknown artifact identity", spec.identity);
}

function materialForArtifact(spec, context, identity) {
  if (spec.material_kind === "copy") return copyMaterial(spec, identity);
  const bytes =
    spec.identity === "parameters"
      ? context.parameterBytes
      : spec.identity === "runtime-inventory"
        ? context.runtimeInventoryBytes
        : null;
  if (bytes === null) fail("PLAN_INTERNAL", "document bytes are unresolved", spec.identity);
  const material = documentMaterial(spec, bytes);
  exact(material.sha256, identity.sha256, `${spec.identity}.sha256`);
  exact(material.size_bytes, identity.size_bytes, `${spec.identity}.size_bytes`);
  return material;
}

function licenseMaterial(targetPath, sourceRelativePath, bytes) {
  validateArtifactPath(sourceRelativePath, `${targetPath}.source_relative_path`);
  const identity = identityOf(bytes);
  return {
    kind: "copy",
    sha256: identity.sha256,
    size_bytes: identity.size_bytes,
    source_relative_path: sourceRelativePath,
    source_root: "repository",
    target_path: targetPath,
  };
}

/**
 * Builds a deterministic, pure in-memory materialization plan. The function
 * performs no filesystem, process, network, environment, clock, cwd, or random
 * operation and does not create a bundle or a seal.
 */
export function planSherpaCandidateInput(input) {
  exactKeys(input, [
    "assetsLockBytes",
    "cargoLockBytes",
    "licenseBytes",
    "releaseWorkerProjectionBytes",
    "rustBuilderInputBytes",
    "schemaRegistryBytes",
    "sourceCommit",
    "sourceUrl",
    "workerExecutableSizeBytes",
  ], "input");
  exactKeys(input.licenseBytes, [
    "funasrCurrentLicenseBytes",
    "meetingrelayNoticeBytes",
    "onnxruntimeMitLicenseBytes",
    "sherpaApacheLicenseBytes",
  ], "input.licenseBytes");

  const bytes = {
    assetsLock: inputBuffer(input.assetsLockBytes, "input.assetsLockBytes"),
    cargoLock: inputBuffer(input.cargoLockBytes, "input.cargoLockBytes"),
    funasr: inputBuffer(
      input.licenseBytes.funasrCurrentLicenseBytes,
      "input.licenseBytes.funasrCurrentLicenseBytes",
    ),
    notice: inputBuffer(
      input.licenseBytes.meetingrelayNoticeBytes,
      "input.licenseBytes.meetingrelayNoticeBytes",
    ),
    onnxruntime: inputBuffer(
      input.licenseBytes.onnxruntimeMitLicenseBytes,
      "input.licenseBytes.onnxruntimeMitLicenseBytes",
    ),
    rustBuilder: inputBuffer(input.rustBuilderInputBytes, "input.rustBuilderInputBytes"),
    schemaRegistry: inputBuffer(input.schemaRegistryBytes, "input.schemaRegistryBytes"),
    sherpa: inputBuffer(
      input.licenseBytes.sherpaApacheLicenseBytes,
      "input.licenseBytes.sherpaApacheLicenseBytes",
    ),
    workerProjection: inputBuffer(
      input.releaseWorkerProjectionBytes,
      "input.releaseWorkerProjectionBytes",
    ),
  };
  if (bytes.cargoLock.length === 0) fail("PLAN_SIZE", "Cargo.lock cannot be empty", "cargoLockBytes");
  exact(utf8Text(bytes.notice, "meetingrelayNoticeBytes"), MEETINGRELAY_UNLICENSED_NOTICE, "meetingrelayNoticeBytes");

  if (
    typeof input.sourceCommit !== "string" ||
    !HEX_40.test(input.sourceCommit) ||
    input.sourceCommit === "0".repeat(40)
  ) {
    fail(
      "PLAN_SOURCE",
      "sourceCommit must be a non-zero lowercase 40-hex commit",
      "sourceCommit",
    );
  }
  if (
    typeof input.sourceUrl !== "string" ||
    input.sourceUrl !== input.sourceUrl.normalize("NFC") ||
    !HTTPS_URL.test(input.sourceUrl) ||
    input.sourceUrl !== `${PROJECT_COMMIT_URL_PREFIX}${input.sourceCommit}`
  ) {
    fail(
      "PLAN_SOURCE",
      "sourceUrl must be the exact MeetingRelay GitHub commit URL for sourceCommit",
      "sourceUrl",
    );
  }
  const workerSize = canonicalU64(
    input.workerExecutableSizeBytes,
    "workerExecutableSizeBytes",
    1n,
  );

  const lock = parseCanonicalIndented(bytes.assetsLock, "assetsLockBytes", false);
  validateLockObject(lock);
  const schemaRegistry = parseCanonicalIndented(
    bytes.schemaRegistry,
    "schemaRegistryBytes",
    true,
  );
  exactJson(schemaRegistry, {
    artifact_scope: "candidate-input",
    formal_claims: "none",
    schema_version: "1.0",
    schemas: ["meetingrelay.model-worker.v1"],
  }, "schemaRegistryBytes");

  const identities = {
    assetsLock: identityOf(bytes.assetsLock),
    cargoLock: identityOf(bytes.cargoLock),
    schemaRegistry: identityOf(bytes.schemaRegistry),
  };
  const builder = parseCanonicalCompactLine(bytes.rustBuilder, "rustBuilderInputBytes");
  const worker = parseCanonicalCompactLine(
    bytes.workerProjection,
    "releaseWorkerProjectionBytes",
  );
  validateBuilder(builder, lock, identities);
  validateWorkerProjection(worker, builder, lock, identities, workerSize);

  const parameterMaterial = { ...lock.parameters };
  delete parameterMaterial.canonical_json_sha256;
  const parameterBytes = Buffer.from(
    JSON.stringify(canonicalizeJson(parameterMaterial)),
    "utf8",
  );
  exact(sha256(parameterBytes), lock.parameters.canonical_json_sha256, "parameters.sha256");
  if (parameterBytes.includes(0x0a) || parameterBytes.includes(0x0d)) {
    fail("PLAN_CANONICAL_JSON", "parameters must be compact JSON without LF", "parameters");
  }

  // Do not canonicalize this array. Its exact lock-owned object-key order is a
  // provenance input shared with Rust and intentionally produces another hash
  // than recursively sorted canonical JSON.
  const runtimeInventoryBytes = Buffer.from(
    JSON.stringify(lock.runtime.archive.inventory),
    "utf8",
  );
  exact(String(runtimeInventoryBytes.length), RUNTIME_INVENTORY_SIZE_BYTES, "runtimeInventory.size_bytes");
  exact(sha256(runtimeInventoryBytes), RUNTIME_INVENTORY_SHA256, "runtimeInventory.sha256");

  const licenseSources = {
    model: lock.model.current_license_snapshot,
    onnxruntime: lock.runtime.onnxruntime_license,
    sherpa: lock.runtime.license,
  };
  for (const [name, source, licenseBytes] of [
    ["model", licenseSources.model, bytes.funasr],
    ["onnxruntime", licenseSources.onnxruntime, bytes.onnxruntime],
    ["sherpa", licenseSources.sherpa, bytes.sherpa],
  ]) {
    exact(String(licenseBytes.length), String(source.size_bytes), `${name}License.size_bytes`);
    exact(sha256(licenseBytes), source.sha256, `${name}License.sha256`);
  }

  const projectLicense = {
    distribution_status: "pending",
    license_id: PROJECT_LICENSE_ID,
    review_scope: "internal-evaluation-only",
    review_source_status: "unlicensed",
    review_status: "rejected",
    source_revision: input.sourceCommit,
    source_url: input.sourceUrl,
    spdx_or_license_ref: PROJECT_LICENSE_ID,
    text_path: PROJECT_NOTICE_PATH,
    text_sha256: sha256(bytes.notice),
    text_size_bytes: String(bytes.notice.length),
  };
  const licenses = [
    licenseRecord(licenseSources.sherpa, bytes.sherpa),
    licenseRecord(licenseSources.model, bytes.funasr),
    projectLicense,
    licenseRecord(licenseSources.onnxruntime, bytes.onnxruntime),
  ].sort((left, right) => compareStrings(left.text_path, right.text_path));
  const licenseIds = {
    model: licenseSources.model.license_id,
    onnxruntime: licenseSources.onnxruntime.license_id,
    project: PROJECT_LICENSE_ID,
    sherpa: licenseSources.sherpa.license_id,
  };

  const context = {
    identities,
    lock,
    parameterBytes,
    runtimeInventoryBytes,
    worker,
    workerSize,
  };
  const artifacts = [];
  const materials = [];
  for (const spec of SHERPA_CANDIDATE_ARTIFACT_MAPPING) {
    validateArtifactPath(spec.target_path, `${spec.identity}.target_path`);
    const identity = resolveArtifactIdentity(spec, context);
    digest(identity.sha256, `${spec.identity}.sha256`);
    canonicalU64(identity.size_bytes, `${spec.identity}.size_bytes`, 1n);
    artifacts.push({
      artifact_id: spec.artifact_id,
      license_id: licenseIds[spec.license],
      path: spec.target_path,
      role: spec.role,
      sha256: identity.sha256,
      size_bytes: identity.size_bytes,
    });
    materials.push(materialForArtifact(spec, context, identity));
  }
  artifacts.sort((left, right) => compareStrings(left.path, right.path));

  const candidate = {
    artifact_scope: "candidate-input",
    artifacts,
    build: {
      profile: "release",
      target: "x86_64-pc-windows-msvc",
      toolchain: RUST_TOOLCHAIN,
    },
    candidate_id: builder.candidate_id,
    claims: JSON.parse(JSON.stringify(builder.claims)),
    licenses,
    publishability_status: "pending",
    schema_version: "1.1",
    selection_status: "not-selected",
    source: {
      source_revision: input.sourceCommit,
      source_sha256: worker.executable_sha256,
      source_url: input.sourceUrl,
    },
    worker_contract_version: builder.worker_contract_version,
    worker_manifest_projection: JSON.parse(JSON.stringify(worker)),
  };

  const licenseMaterials = [
    licenseMaterial(PROJECT_NOTICE_PATH, PROJECT_NOTICE_SOURCE_PATH, bytes.notice),
    licenseMaterial(
      licenseSources.sherpa.snapshot_path,
      `tools/sherpa-native/${licenseSources.sherpa.snapshot_path}`,
      bytes.sherpa,
    ),
    licenseMaterial(
      licenseSources.onnxruntime.snapshot_path,
      `tools/sherpa-native/${licenseSources.onnxruntime.snapshot_path}`,
      bytes.onnxruntime,
    ),
    licenseMaterial(
      licenseSources.model.snapshot_path,
      `tools/sherpa-native/${licenseSources.model.snapshot_path}`,
      bytes.funasr,
    ),
  ];
  materials.push(...licenseMaterials);
  const plannedEntries = new Map(
    materials.map((material) => [
      material.target_path,
      { sha256: material.sha256, size_bytes: material.size_bytes },
    ]),
  );
  const summary = validatePlannedCandidateManifest(candidate, plannedEntries);
  exact(summary.artifact_count, 15, "candidate.artifacts.length");
  exact(summary.validation_phase, "candidate-input-plan", "candidate.validation_phase");
  exact(summary.sealed, false, "candidate.sealed");

  const candidateBytes = Buffer.from(encodeCanonicalJson(candidate), "utf8");
  materials.push(
    documentMaterial(
      { target_path: CANDIDATE_MANIFEST_PATH },
      candidateBytes,
    ),
  );
  materials.sort((left, right) => compareStrings(left.target_path, right.target_path));
  const paths = materials.map((material) => material.target_path);
  if (new Set(paths).size !== paths.length) {
    fail("PLAN_DUPLICATE", "material target paths must be unique", "materials");
  }
  if (paths.some((value, index) => index > 0 && paths[index - 1] >= value)) {
    fail("PLAN_ORDER", "materials must be strictly target-path sorted", "materials");
  }

  return {
    kind: PLAN_KIND,
    materials,
    schema_version: PLAN_SCHEMA_VERSION,
  };
}
