import { createHash, randomBytes } from "node:crypto";
import { link, lstat, open, readFile, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

import {
  encodeCanonicalJson,
  encodeCanonicalJsonLine,
} from "../phase0-harness/canonical-json.mjs";
import {
  validateCandidateArtifactInputBundle,
} from "../phase0-harness/candidate-artifact-contract.mjs";
import {
  validateCollectedHardwareReference,
} from "../phase0-harness/hw-ref-collector.mjs";
import {
  materializeMeasuredSherpaCandidateInputCloseout,
  proposeMeasuredSherpaCandidateInputCloseout,
} from "./candidate-input-measured-closeout.mjs";
import { prepareQualitySmokeReference } from "./native-candidate-quality-smoke.mjs";
import { runReleaseNativeCandidateConformance } from "./validate-candidate-conformance.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EVIDENCE_KIND = "meetingrelay-native-candidate-measured-evidence-v1";
const EVIDENCE_SCHEMA_VERSION = "1.0";
const PLAN_KIND = "meetingrelay-sherpa-candidate-input-bundle-plan-v1";
const EXPECTED_WORKER_ID = "meetingrelay-sherpa-native-candidate-host-v1";
const EXPECTED_REFERENCE_MANIFEST_SHA256 =
  "cc2afff6bc92a6fe6e2b58e15332422dc3ecddae790eac6235fa543e2bd76590";
const EXPECTED_WAV_SHA256 =
  "b77f1794fe374a0ba1ee1dc458bfaf9349496cbbfc32780c50ba3c5a7ad8e373";
const DIGEST = /^[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const IDENTIFIER = /^[A-Za-z0-9._-]{1,128}$/u;
const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024;

const CONTRACT_MANIFEST_PATH = "contract-manifest.json";
const CONTRACT_SEAL_PATH = "contract-manifest.sha256";
const CANDIDATE_MANIFEST_PATH = "manifests/candidate-manifest.json";
const HW_REF_PATH = "manifests/hw-ref.json";
const RUN_PLAN_PATH = "manifests/run-plan.json";

const ROOT_KEYS = Object.freeze([
  "assessment_status",
  "authority",
  "execution",
  "execution_descriptor",
  "input_identity",
  "kind",
  "limitations",
  "schema_version",
]);
const ASSESSMENT_KEYS = Object.freeze([
  "ct_worker_candidate_status",
  "default_status",
  "full_run_plan_status",
  "parent_closeout_status",
  "performance_status",
  "publishability_status",
  "quality_status",
  "ranking_status",
  "resources_status",
  "selection_status",
]);
const AUTHORITY_KEYS = Object.freeze(["formal_claims", "production_evidence"]);
const EXECUTION_KEYS = Object.freeze([
  "actual_native_inference",
  "backend_execute_calls",
  "check_summary",
  "conformance_record_sha256",
]);
const EXECUTION_DESCRIPTOR_KEYS = Object.freeze([
  "argv_roles",
  "full_run_plan_argv_used",
  "full_run_plan_fixture_used",
  "scope",
]);
const INPUT_IDENTITY_KEYS = Object.freeze([
  "config_sha256",
  "contract_manifest_sha256",
  "execution_host_sha256",
  "hw_ref_id",
  "locked_input_snapshot_sha256",
  "measured_hardware_reference_sha256",
  "model_sha256",
  "operator_facts_sha256",
  "quality_reference_manifest_sha256",
  "run_plan_sha256",
  "runtime_bundle_sha256",
  "schema_registry_sha256",
  "source_commit",
  "wav_sha256",
  "worker_id",
]);
const CHECK_SUMMARY_KEYS = Object.freeze(["passed", "total"]);
const OPERATOR_FACT_KEYS = Object.freeze([
  "ambientCelsius",
  "audioDeviceModel",
  "audioLogicalRole",
  "coolingMode",
  "gpuDeviceModel",
  "gpuVramBytes",
  "powerSource",
  "storageMedium",
  "storageVolume",
]);
const CONFORMANCE_RESULT_KEYS = Object.freeze([
  "backendExecuteCalls",
  "checkSummary",
  "conformanceRecordSha256",
  "executableSha256",
  "finalTranscriptSha256",
  "finalTranscriptUtf8Bytes",
  "lockedInputSnapshotSha256",
  "schemaRegistrySha256",
  "workerId",
]);
const ARGV_ROLES = Object.freeze([
  "schema-registry",
  "model",
  "tokens",
  "runtime-library-directory",
  "model-manifest",
  "package-lock",
  "external-sealed-reference-wav",
]);
const LIMITATIONS = Object.freeze([
  "operator-facts-recorded-by-digest-only",
  "storage-volume-selection-not-persisted-in-hw-ref",
  "quality-not-assessed",
  "performance-not-assessed",
  "resource-usage-not-assessed",
  "publishability-ranking-selection-default-not-assessed",
  "calibration-full-run-plan-not-executed",
  "ct-worker-candidate-and-parent-closeout-not-authorized",
  "phase-1-not-authorized",
]);
const OPERATOR_FACT_SENTINELS = new Set([
  "contractfixture",
  "default",
  "missing",
  "na",
  "nil",
  "none",
  "notapplicable",
  "notavailable",
  "notcollected",
  "notmeasured",
  "notprovided",
  "notrecorded",
  "null",
  "pending",
  "placeholder",
  "synthetic",
  "tbc",
  "tbd",
  "test",
  "testing",
  "undefined",
  "unavailable",
  "unknown",
  "unset",
  "unspecified",
]);

export class NativeCandidateMeasuredEvidenceError extends Error {
  constructor(code, options = {}) {
    super(code, options);
    this.name = "NativeCandidateMeasuredEvidenceError";
    this.code = code;
  }
}

function fail(code, options = {}) {
  throw new NativeCandidateMeasuredEvidenceError(code, options);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function exactKeys(value, expected, code) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(code);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    fail(code);
  }
}

function assertDigest(value, code) {
  if (typeof value !== "string" || !DIGEST.test(value) || value === "0".repeat(64)) {
    fail(code);
  }
}

function assertCommit(value, code) {
  if (typeof value !== "string" || !COMMIT.test(value) || value === "0".repeat(40)) {
    fail(code);
  }
}

function assertIdentifier(value, code) {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) fail(code);
}

function isOperatorFactSentinel(value) {
  const normalized = value
    .trim()
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{P}\p{S}\s]+/gu, "");
  return normalized.length === 0 || OPERATOR_FACT_SENTINELS.has(normalized);
}

function parseCanonicalJsonLine(bytes, code) {
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length === 0 ||
    bytes.length > MAX_DOCUMENT_BYTES ||
    bytes.at(-1) !== 0x0a ||
    bytes.includes(0x0d)
  ) {
    fail(code);
  }
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) fail(code);
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    fail(code);
  }
  if (encodeCanonicalJsonLine(value) !== text) fail(code);
  return value;
}

function parseCanonicalDocument(bytes, code) {
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length === 0 ||
    bytes.length > MAX_DOCUMENT_BYTES ||
    bytes.at(-1) !== 0x0a ||
    bytes.includes(0x0d)
  ) {
    fail(code);
  }
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) fail(code);
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    fail(code);
  }
  if (encodeCanonicalJson(value) !== text) fail(code);
  return value;
}

function isStrictDescendant(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function assertNormalizedAbsolutePath(value, code) {
  if (
    typeof value !== "string" ||
    !path.isAbsolute(value) ||
    path.normalize(value) !== value ||
    value.normalize("NFC") !== value
  ) {
    fail(code);
  }
  return value;
}

function assertBundleRelativePath(value, code) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\\") ||
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    value !== value.normalize("NFC") ||
    value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    fail(code);
  }
  return value;
}

function resolveBundlePath(root, relativePath, code) {
  assertBundleRelativePath(relativePath, code);
  const resolved = path.resolve(root, ...relativePath.split("/"));
  if (!isStrictDescendant(root, resolved)) fail(code);
  return resolved;
}

function resolveSourceMaterialPath(sourceRoots, material, code) {
  if (
    material?.kind !== "copy" ||
    material.source_root !== "rust-target" ||
    typeof sourceRoots?.[material.source_root] !== "string"
  ) {
    fail(code);
  }
  const root = assertNormalizedAbsolutePath(sourceRoots[material.source_root], code);
  assertBundleRelativePath(material.source_relative_path, code);
  const resolved = path.resolve(root, ...material.source_relative_path.split("/"));
  if (!isStrictDescendant(root, resolved)) fail(code);
  return resolved;
}

function validateOperatorFacts(operatorFacts, expectedSha256) {
  exactKeys(operatorFacts, OPERATOR_FACT_KEYS, "MEASURED_EVIDENCE_OPERATOR_FACTS");
  assertDigest(expectedSha256, "MEASURED_EVIDENCE_OPERATOR_TRUST_REQUIRED");
  if (
    OPERATOR_FACT_KEYS.some(
      (key) =>
        typeof operatorFacts[key] !== "string" ||
        operatorFacts[key].trim().length === 0 ||
        isOperatorFactSentinel(operatorFacts[key]),
    ) ||
    typeof operatorFacts.gpuVramBytes !== "string" ||
    !/^[1-9][0-9]*$/u.test(operatorFacts.gpuVramBytes) ||
    BigInt(operatorFacts.gpuVramBytes) > (1n << 64n) - 1n ||
    !/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u.test(operatorFacts.ambientCelsius) ||
    /^-0(?:\.0+)?$/u.test(operatorFacts.ambientCelsius) ||
    !["ac", "battery"].includes(operatorFacts.powerSource) ||
    !["ssd", "hdd", "emmc", "other"].includes(operatorFacts.storageMedium) ||
    !/^[A-Z]$/u.test(operatorFacts.storageVolume)
  ) {
    fail("MEASURED_EVIDENCE_OPERATOR_FACTS");
  }
  const bytes = Buffer.from(encodeCanonicalJson(operatorFacts), "utf8");
  const digest = sha256(bytes);
  if (digest !== expectedSha256) fail("MEASURED_EVIDENCE_OPERATOR_TRUST_MISMATCH");
  return { digest, operatorFacts: { ...operatorFacts } };
}

function assertOperatorFactsJoin(operatorFacts, hardware) {
  const environment = hardware.environment;
  if (
    environment?.cooling?.ambient_celsius !== operatorFacts.ambientCelsius ||
    environment?.audio_devices?.length !== 1 ||
    environment.audio_devices[0].model !== operatorFacts.audioDeviceModel ||
    environment.audio_devices[0].logical_role !== operatorFacts.audioLogicalRole ||
    environment.cooling.mode !== operatorFacts.coolingMode ||
    environment?.gpus?.length !== 1 ||
    environment.gpus[0].model !== operatorFacts.gpuDeviceModel ||
    environment.gpus[0].vram_bytes !== operatorFacts.gpuVramBytes ||
    environment?.power?.source !== operatorFacts.powerSource ||
    environment?.storage?.length !== 1 ||
    environment.storage[0].medium !== operatorFacts.storageMedium
  ) {
    fail("MEASURED_EVIDENCE_OPERATOR_HW_JOIN");
  }
}

function materialByTarget(plan, targetPath, code) {
  const matches = plan.materials.filter((material) => material.target_path === targetPath);
  if (matches.length !== 1) fail(code);
  return matches[0];
}

function parsePlanDocument(plan, targetPath, code) {
  const material = materialByTarget(plan, targetPath, code);
  if (
    material.kind !== "document" ||
    !Buffer.isBuffer(material.bytes) ||
    sha256(material.bytes) !== material.sha256 ||
    String(material.bytes.length) !== material.size_bytes
  ) {
    fail(code);
  }
  return { material, value: parseCanonicalDocument(material.bytes, code) };
}

function inspectMeasuredProposal(
  proposal,
  {
    expectedContractSha256,
    expectedHardwareReferenceSha256,
    expectedHwRefId,
    operatorFacts,
  },
) {
  exactKeys(
    proposal,
    [
      "formalClaims",
      "plan",
      "productionEvidence",
      "proposedContractSha256",
      "status",
      "validationPhase",
    ],
    "MEASURED_EVIDENCE_PROPOSAL",
  );
  if (
    proposal.formalClaims !== "none" ||
    proposal.productionEvidence !== false ||
    proposal.status !== "proposed" ||
    proposal.validationPhase !== "input-only-proposal" ||
    proposal.proposedContractSha256 !== expectedContractSha256
  ) {
    fail("MEASURED_EVIDENCE_PROPOSAL");
  }
  const plan = proposal.plan;
  exactKeys(
    plan,
    ["kind", "materials", "proposedContractSha256", "schema_version"],
    "MEASURED_EVIDENCE_PROPOSAL_PLAN",
  );
  if (
    plan.kind !== PLAN_KIND ||
    plan.schema_version !== "1.1" ||
    plan.proposedContractSha256 !== expectedContractSha256 ||
    !Array.isArray(plan.materials) ||
    plan.materials.length !== 29
  ) {
    fail("MEASURED_EVIDENCE_PROPOSAL_PLAN");
  }
  const contract = parsePlanDocument(
    plan,
    CONTRACT_MANIFEST_PATH,
    "MEASURED_EVIDENCE_PROPOSAL_CONTRACT",
  );
  if (contract.material.sha256 !== expectedContractSha256) {
    fail("MEASURED_EVIDENCE_PROPOSAL_CONTRACT");
  }
  const seal = materialByTarget(
    plan,
    CONTRACT_SEAL_PATH,
    "MEASURED_EVIDENCE_PROPOSAL_SEAL",
  );
  if (
    seal.kind !== "document" ||
    !Buffer.isBuffer(seal.bytes) ||
    !seal.bytes.equals(
      Buffer.from(`${expectedContractSha256}  ${CONTRACT_MANIFEST_PATH}\n`, "ascii"),
    ) ||
    sha256(seal.bytes) !== seal.sha256 ||
    String(seal.bytes.length) !== seal.size_bytes
  ) {
    fail("MEASURED_EVIDENCE_PROPOSAL_SEAL");
  }
  const hardware = parsePlanDocument(
    plan,
    HW_REF_PATH,
    "MEASURED_EVIDENCE_PROPOSAL_HW",
  );
  if (
    hardware.material.sha256 !== expectedHardwareReferenceSha256 ||
    hardware.value.hw_ref_id !== expectedHwRefId
  ) {
    fail("MEASURED_EVIDENCE_HW_TRUST_MISMATCH");
  }
  try {
    validateCollectedHardwareReference(hardware.value);
  } catch (error) {
    fail("MEASURED_EVIDENCE_HW_CONTRACT", { cause: error });
  }
  assertOperatorFactsJoin(operatorFacts, hardware.value);
  const candidate = parsePlanDocument(
    plan,
    CANDIDATE_MANIFEST_PATH,
    "MEASURED_EVIDENCE_PROPOSAL_CANDIDATE",
  );
  const runPlan = parsePlanDocument(
    plan,
    RUN_PLAN_PATH,
    "MEASURED_EVIDENCE_PROPOSAL_RUN_PLAN",
  );
  return {
    candidate: candidate.value,
    hardware: hardware.value,
    plan,
    runPlan: runPlan.value,
  };
}

async function assertDirectPathChain(inputPath, code) {
  const resolved = path.resolve(inputPath);
  let current = resolved;
  while (true) {
    let metadata;
    try {
      metadata = await lstat(current);
    } catch {
      fail(code);
    }
    if (metadata.isSymbolicLink()) fail(code);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return resolved;
}

function pathKey(value) {
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function sameIdentity(left, right) {
  return (
    typeof left?.dev === "bigint" &&
    typeof left?.ino === "bigint" &&
    left.dev > 0n &&
    left.ino > 0n &&
    left.dev === right?.dev &&
    left.ino === right?.ino
  );
}

function sameSnapshot(left, right) {
  return (
    sameIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

async function rereadHandleBytes(handle, expectedLength, code) {
  const bytes = Buffer.allocUnsafe(expectedLength);
  let offset = 0;
  while (offset < expectedLength) {
    const { bytesRead } = await handle.read(
      bytes,
      offset,
      expectedLength - offset,
      offset,
    );
    if (bytesRead === 0) fail(code);
    offset += bytesRead;
  }
  const trailing = Buffer.allocUnsafe(1);
  const { bytesRead } = await handle.read(trailing, 0, 1, expectedLength);
  if (bytesRead !== 0) fail(code);
  return bytes;
}

async function readSmallRegularFile(inputPath, code) {
  const resolvedBefore = await assertDirectPathChain(inputPath, code);
  const resolvedIdentity = await realpath(resolvedBefore).catch(() => fail(code));
  const handle = await open(resolvedBefore, "r").catch(() => fail(code));
  let failure;
  try {
    const [beforePath, beforeHandle] = await Promise.all([
      lstat(resolvedBefore, { bigint: true }),
      handle.stat({ bigint: true }),
    ]);
    if (
      !beforePath.isFile() ||
      beforePath.isSymbolicLink() ||
      !beforeHandle.isFile() ||
      !sameSnapshot(beforePath, beforeHandle) ||
      beforeHandle.size < 1n ||
      beforeHandle.size > BigInt(MAX_DOCUMENT_BYTES)
    ) {
      fail(code);
    }
    const bytes = await handle.readFile();
    const [afterPath, afterHandle, resolvedAfter, verificationBytes] = await Promise.all([
      lstat(resolvedBefore, { bigint: true }).catch(() => null),
      handle.stat({ bigint: true }),
      realpath(resolvedBefore).catch(() => null),
      rereadHandleBytes(handle, bytes.length, code),
    ]);
    if (
      afterPath === null ||
      resolvedAfter === null ||
      !sameSnapshot(beforeHandle, afterHandle) ||
      !sameSnapshot(beforeHandle, afterPath) ||
      pathKey(resolvedAfter) !== pathKey(resolvedIdentity) ||
      BigInt(bytes.length) !== beforeHandle.size ||
      !verificationBytes.equals(bytes)
    ) {
      fail(code);
    }
    return {
      bytes,
      resolved: resolvedBefore,
      sha256: sha256(bytes),
      sizeBytes: String(bytes.length),
    };
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try {
      await handle.close();
    } catch (error) {
      if (failure === undefined) fail(code, { cause: error });
    }
  }
}

async function readBundleDocument(bundleRoot, relativePath, code) {
  const material = await readSmallRegularFile(
    resolveBundlePath(bundleRoot, relativePath, code),
    code,
  );
  return { ...material, value: parseCanonicalDocument(material.bytes, code) };
}

function artifactByRole(candidate, role, code) {
  const matches = candidate.artifacts?.filter((artifact) => artifact.role === role) ?? [];
  if (matches.length !== 1) fail(code);
  return matches[0];
}

function contractEntry(contractEntries, artifact, code) {
  const entry = contractEntries.get(artifact.path);
  if (
    entry === undefined ||
    entry.sha256 !== artifact.sha256 ||
    entry.size_bytes !== artifact.size_bytes
  ) {
    fail(code);
  }
  return entry;
}

function buildLockedInputSnapshotSha256(identity, wavSha256) {
  const bytes = Buffer.from(
    encodeCanonicalJsonLine({
      asset_lock_sha256: identity.assetLock.sha256,
      cargo_lock_sha256: identity.packageLock.sha256,
      model_sha256: identity.model.sha256,
      parameter_sha256: identity.parameters.sha256,
      runtime_bundle_sha256: identity.runtimeInventory.sha256,
      schema_registry_sha256: identity.schemaRegistry.sha256,
      tokens_sha256: identity.tokens.sha256,
      wav_sha256: wavSha256,
    }).slice(0, -1),
    "utf8",
  );
  return sha256(bytes);
}

function inspectCandidateContractStage(
  candidate,
  runPlan,
  contractEntries,
  bundleRoot,
  candidatePlan,
  sourceRoots,
) {
  const worker = artifactByRole(candidate, "worker-executable", "MEASURED_EVIDENCE_WORKER_JOIN");
  const schemaRegistry = artifactByRole(candidate, "schema-registry", "MEASURED_EVIDENCE_SCHEMA_JOIN");
  const model = artifactByRole(candidate, "model", "MEASURED_EVIDENCE_MODEL_JOIN");
  const tokens = artifactByRole(candidate, "tokens", "MEASURED_EVIDENCE_TOKENS_JOIN");
  const runtimeInventory = artifactByRole(candidate, "runtime", "MEASURED_EVIDENCE_RUNTIME_JOIN");
  const parameters = artifactByRole(candidate, "parameters", "MEASURED_EVIDENCE_CONFIG_JOIN");
  const assetLock = artifactByRole(candidate, "model-manifest", "MEASURED_EVIDENCE_LOCK_JOIN");
  const packageLock = artifactByRole(candidate, "package-lock", "MEASURED_EVIDENCE_LOCK_JOIN");
  const runtimeFiles = candidate.artifacts
    .filter((artifact) => artifact.role.startsWith("runtime-file-"))
    .sort((left, right) => left.path.localeCompare(right.path, "en"));
  if (runtimeFiles.length !== 7) fail("MEASURED_EVIDENCE_RUNTIME_JOIN");
  const runtimeDirectories = new Set(
    runtimeFiles.map((artifact) => path.posix.dirname(artifact.path)),
  );
  if (runtimeDirectories.size !== 1) fail("MEASURED_EVIDENCE_RUNTIME_JOIN");
  const runtimeDirectory = [...runtimeDirectories][0];
  for (const artifact of [
    worker,
    schemaRegistry,
    model,
    tokens,
    runtimeInventory,
    parameters,
    assetLock,
    packageLock,
    ...runtimeFiles,
  ]) {
    contractEntry(contractEntries, artifact, "MEASURED_EVIDENCE_CONTRACT_JOIN");
  }
  const projection = candidate.worker_manifest_projection;
  const descriptor = projection?.descriptor;
  if (
    projection?.worker_id !== EXPECTED_WORKER_ID ||
    projection?.executable_sha256 !== worker.sha256 ||
    projection?.worker_build_sha256 !== worker.sha256 ||
    projection?.schema_registry_sha256 !== schemaRegistry.sha256 ||
    descriptor?.model_sha256 !== model.sha256 ||
    descriptor?.parameter_sha256 !== parameters.sha256 ||
    descriptor?.runtime_sha256 !== runtimeInventory.sha256 ||
    descriptor?.model_manifest_sha256 !== assetLock.sha256 ||
    descriptor?.package_lock_sha256 !== packageLock.sha256
  ) {
    fail("MEASURED_EVIDENCE_DESCRIPTOR_JOIN");
  }
  assertCommit(candidate.source?.source_revision, "MEASURED_EVIDENCE_SOURCE_COMMIT");
  if (
    runPlan?.scope !== "candidate-run" ||
    runPlan.execution_status !== "planned" ||
    runPlan.source_commit !== candidate.source.source_revision ||
    !Array.isArray(runPlan.harness?.command?.argv) ||
    runPlan.harness.command.argv.length !== 0 ||
    typeof runPlan.same_condition_contract?.audio_playback_path !== "string" ||
    !runPlan.same_condition_contract.audio_playback_path.startsWith("test-fixtures/")
  ) {
    fail("MEASURED_EVIDENCE_FULL_RUN_BOUNDARY");
  }
  const workerPlanMaterials = candidatePlan.materials.filter(
    (material) => material.target_path === worker.path,
  );
  if (
    workerPlanMaterials.length !== 1 ||
    workerPlanMaterials[0].sha256 !== worker.sha256 ||
    workerPlanMaterials[0].size_bytes !== worker.size_bytes
  ) {
    fail("MEASURED_EVIDENCE_WORKER_SOURCE_JOIN");
  }
  const executionHostPath = resolveSourceMaterialPath(
    sourceRoots,
    workerPlanMaterials[0],
    "MEASURED_EVIDENCE_WORKER_SOURCE_JOIN",
  );
  return {
    assetLock,
    conformanceInput: {
      assetLockPath: resolveBundlePath(bundleRoot, assetLock.path, "MEASURED_EVIDENCE_LOCK_JOIN"),
      executablePath: executionHostPath,
      modelPath: resolveBundlePath(bundleRoot, model.path, "MEASURED_EVIDENCE_MODEL_JOIN"),
      packageLockPath: resolveBundlePath(bundleRoot, packageLock.path, "MEASURED_EVIDENCE_LOCK_JOIN"),
      runtimeLibDir: resolveBundlePath(bundleRoot, runtimeDirectory, "MEASURED_EVIDENCE_RUNTIME_JOIN"),
      schemaRegistryPath: resolveBundlePath(bundleRoot, schemaRegistry.path, "MEASURED_EVIDENCE_SCHEMA_JOIN"),
      tokensPath: resolveBundlePath(bundleRoot, tokens.path, "MEASURED_EVIDENCE_TOKENS_JOIN"),
    },
    model,
    packageLock,
    parameters,
    runtimeInventory,
    schemaRegistry,
    tokens,
    worker,
  };
}

async function inspectMaterializedBundle(
  bundleRoot,
  {
    candidatePlan,
    expectedContractSha256,
    expectedHardwareReferenceSha256,
    expectedHwRefId,
    operatorFacts,
    sourceRoots,
  },
) {
  const resolvedRoot = await assertDirectPathChain(bundleRoot, "MEASURED_EVIDENCE_BUNDLE_PATH");
  const rootStat = await lstat(resolvedRoot).catch(() => fail("MEASURED_EVIDENCE_BUNDLE_PATH"));
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail("MEASURED_EVIDENCE_BUNDLE_PATH");
  const contract = await readBundleDocument(
    resolvedRoot,
    CONTRACT_MANIFEST_PATH,
    "MEASURED_EVIDENCE_CONTRACT",
  );
  if (contract.sha256 !== expectedContractSha256) fail("MEASURED_EVIDENCE_CONTRACT");
  const seal = await readSmallRegularFile(
    resolveBundlePath(resolvedRoot, CONTRACT_SEAL_PATH, "MEASURED_EVIDENCE_CONTRACT_SEAL"),
    "MEASURED_EVIDENCE_CONTRACT_SEAL",
  );
  if (
    !seal.bytes.equals(
      Buffer.from(`${expectedContractSha256}  ${CONTRACT_MANIFEST_PATH}\n`, "ascii"),
    )
  ) {
    fail("MEASURED_EVIDENCE_CONTRACT_SEAL");
  }
  exactKeys(
    contract.value,
    ["contract_id", "entries", "formal_claims", "schema_version"],
    "MEASURED_EVIDENCE_CONTRACT",
  );
  if (
    contract.value.formal_claims !== "none" ||
    contract.value.schema_version !== "1.0" ||
    !Array.isArray(contract.value.entries)
  ) {
    fail("MEASURED_EVIDENCE_CONTRACT");
  }
  const contractEntries = new Map();
  for (const entry of contract.value.entries) {
    exactKeys(entry, ["path", "sha256", "size_bytes"], "MEASURED_EVIDENCE_CONTRACT");
    assertBundleRelativePath(entry.path, "MEASURED_EVIDENCE_CONTRACT");
    assertDigest(entry.sha256, "MEASURED_EVIDENCE_CONTRACT");
    if (contractEntries.has(entry.path)) fail("MEASURED_EVIDENCE_CONTRACT");
    contractEntries.set(entry.path, entry);
  }
  const candidate = await readBundleDocument(
    resolvedRoot,
    CANDIDATE_MANIFEST_PATH,
    "MEASURED_EVIDENCE_CANDIDATE",
  );
  const hardware = await readBundleDocument(
    resolvedRoot,
    HW_REF_PATH,
    "MEASURED_EVIDENCE_HW",
  );
  const runPlan = await readBundleDocument(
    resolvedRoot,
    RUN_PLAN_PATH,
    "MEASURED_EVIDENCE_RUN_PLAN",
  );
  for (const document of [candidate, hardware, runPlan]) {
    const relativePath =
      document === candidate ? CANDIDATE_MANIFEST_PATH : document === hardware ? HW_REF_PATH : RUN_PLAN_PATH;
    const entry = contractEntries.get(relativePath);
    if (
      entry === undefined ||
      entry.sha256 !== document.sha256 ||
      entry.size_bytes !== document.sizeBytes
    ) {
      fail("MEASURED_EVIDENCE_CONTRACT_JOIN");
    }
  }
  if (
    hardware.sha256 !== expectedHardwareReferenceSha256 ||
    hardware.value.hw_ref_id !== expectedHwRefId
  ) {
    fail("MEASURED_EVIDENCE_HW_TRUST_MISMATCH");
  }
  try {
    validateCollectedHardwareReference(hardware.value);
  } catch (error) {
    fail("MEASURED_EVIDENCE_HW_CONTRACT", { cause: error });
  }
  assertOperatorFactsJoin(operatorFacts, hardware.value);
  const stageIdentity = inspectCandidateContractStage(
    candidate.value,
    runPlan.value,
    contractEntries,
    resolvedRoot,
    candidatePlan,
    sourceRoots,
  );
  return {
    bundleRoot: resolvedRoot,
    candidate: candidate.value,
    contractManifestSha256: contract.sha256,
    hardware: hardware.value,
    hardwareSha256: hardware.sha256,
    runPlan: runPlan.value,
    runPlanSha256: runPlan.sha256,
    stageIdentity,
  };
}

function comparableBundleIdentity(bundle) {
  return {
    candidate: bundle.candidate,
    contractManifestSha256: bundle.contractManifestSha256,
    hardware: bundle.hardware,
    hardwareSha256: bundle.hardwareSha256,
    runPlan: bundle.runPlan,
    runPlanSha256: bundle.runPlanSha256,
    stage: {
      assetLock: bundle.stageIdentity.assetLock,
      model: bundle.stageIdentity.model,
      packageLock: bundle.stageIdentity.packageLock,
      parameters: bundle.stageIdentity.parameters,
      runtimeInventory: bundle.stageIdentity.runtimeInventory,
      schemaRegistry: bundle.stageIdentity.schemaRegistry,
      tokens: bundle.stageIdentity.tokens,
      worker: bundle.stageIdentity.worker,
    },
  };
}

function validateMaterializerResult(result, expectedContractSha256, outputBundleRoot) {
  if (
    result?.status !== "input-valid" ||
    result.validationPhase !== "input-only" ||
    result.formalClaims !== "none" ||
    result.productionEvidence !== false ||
    result.contractManifestSha256 !== expectedContractSha256 ||
    path.resolve(result.bundleRoot ?? "") !== path.resolve(outputBundleRoot)
  ) {
    fail("MEASURED_EVIDENCE_MATERIALIZER_AUTHORITY");
  }
}

async function validateMaterializedBundle(dependency, bundleRoot, expectedContractSha256) {
  let validation;
  try {
    validation = await dependency(bundleRoot, { expectedContractSha256 });
  } catch (error) {
    fail("MEASURED_EVIDENCE_BUNDLE_VALIDATION", { cause: error });
  }
  if (
    validation?.status !== "input-valid" ||
    validation.validationPhase !== "input-only" ||
    validation.formalClaims !== "none" ||
    validation.productionEvidence !== false ||
    validation.contractManifestSha256 !== expectedContractSha256
  ) {
    fail("MEASURED_EVIDENCE_BUNDLE_VALIDATION");
  }
}

async function validateReference(referenceLoader, wavPath, bundleRoot) {
  const reference = await referenceLoader({ wavPath });
  if (
    reference?.manifestSha256 !== EXPECTED_REFERENCE_MANIFEST_SHA256 ||
    reference?.wavSha256 !== EXPECTED_WAV_SHA256 ||
    typeof reference.wavPath !== "string"
  ) {
    fail("MEASURED_EVIDENCE_WAV_JOIN");
  }
  const resolvedWav = path.resolve(reference.wavPath);
  if (resolvedWav === bundleRoot || isStrictDescendant(bundleRoot, resolvedWav)) {
    fail("MEASURED_EVIDENCE_WAV_MUST_BE_EXTERNAL");
  }
  return { ...reference, wavPath: resolvedWav };
}

function validateConformanceResult(result, expected) {
  exactKeys(result, CONFORMANCE_RESULT_KEYS, "MEASURED_EVIDENCE_CONFORMANCE");
  for (const key of [
    "conformanceRecordSha256",
    "executableSha256",
    "finalTranscriptSha256",
    "lockedInputSnapshotSha256",
    "schemaRegistrySha256",
  ]) {
    assertDigest(result[key], "MEASURED_EVIDENCE_CONFORMANCE");
  }
  if (
    result.backendExecuteCalls !== 1 ||
    result.checkSummary?.passed !== 12 ||
    result.checkSummary?.total !== 12 ||
    !Number.isSafeInteger(result.finalTranscriptUtf8Bytes) ||
    result.finalTranscriptUtf8Bytes <= 0 ||
    result.executableSha256 !== expected.executionHostSha256 ||
    result.schemaRegistrySha256 !== expected.schemaRegistrySha256 ||
    result.lockedInputSnapshotSha256 !== expected.lockedInputSnapshotSha256 ||
    result.workerId !== EXPECTED_WORKER_ID
  ) {
    fail("MEASURED_EVIDENCE_CONFORMANCE");
  }
  return result;
}

function validateAssessmentStatus(status) {
  exactKeys(status, ASSESSMENT_KEYS, "MEASURED_EVIDENCE_ASSESSMENT");
  if (
    ASSESSMENT_KEYS.some(
      (key) =>
        status[key] !== (key === "full_run_plan_status" ? "not-executed" : "not-assessed"),
    )
  ) {
    fail("MEASURED_EVIDENCE_ASSESSMENT");
  }
}

export function validateNativeCandidateMeasuredEvidenceRecord(bytes) {
  const record = parseCanonicalJsonLine(bytes, "MEASURED_EVIDENCE_CANONICAL");
  exactKeys(record, ROOT_KEYS, "MEASURED_EVIDENCE_SCHEMA");
  validateAssessmentStatus(record.assessment_status);
  exactKeys(record.authority, AUTHORITY_KEYS, "MEASURED_EVIDENCE_AUTHORITY");
  if (
    record.authority.formal_claims !== "none" ||
    record.authority.production_evidence !== false
  ) {
    fail("MEASURED_EVIDENCE_AUTHORITY");
  }
  exactKeys(record.execution, EXECUTION_KEYS, "MEASURED_EVIDENCE_EXECUTION");
  exactKeys(
    record.execution.check_summary,
    CHECK_SUMMARY_KEYS,
    "MEASURED_EVIDENCE_EXECUTION",
  );
  assertDigest(
    record.execution.conformance_record_sha256,
    "MEASURED_EVIDENCE_EXECUTION",
  );
  if (
    record.execution.actual_native_inference !== true ||
    record.execution.backend_execute_calls !== 1 ||
    record.execution.check_summary.passed !== 12 ||
    record.execution.check_summary.total !== 12
  ) {
    fail("MEASURED_EVIDENCE_EXECUTION");
  }
  exactKeys(
    record.execution_descriptor,
    EXECUTION_DESCRIPTOR_KEYS,
    "MEASURED_EVIDENCE_EXECUTION_DESCRIPTOR",
  );
  if (
    !isDeepStrictEqual(record.execution_descriptor.argv_roles, ARGV_ROLES) ||
    record.execution_descriptor.full_run_plan_argv_used !== false ||
    record.execution_descriptor.full_run_plan_fixture_used !== false ||
    record.execution_descriptor.scope !== "native-contract-stage-only"
  ) {
    fail("MEASURED_EVIDENCE_EXECUTION_DESCRIPTOR");
  }
  exactKeys(record.input_identity, INPUT_IDENTITY_KEYS, "MEASURED_EVIDENCE_INPUT");
  for (const key of INPUT_IDENTITY_KEYS.filter((key) => key.endsWith("sha256"))) {
    assertDigest(record.input_identity[key], "MEASURED_EVIDENCE_INPUT");
  }
  assertCommit(record.input_identity.source_commit, "MEASURED_EVIDENCE_INPUT");
  assertIdentifier(record.input_identity.hw_ref_id, "MEASURED_EVIDENCE_INPUT");
  if (
    record.input_identity.worker_id !== EXPECTED_WORKER_ID ||
    record.input_identity.wav_sha256 !== EXPECTED_WAV_SHA256 ||
    record.input_identity.quality_reference_manifest_sha256 !==
      EXPECTED_REFERENCE_MANIFEST_SHA256
  ) {
    fail("MEASURED_EVIDENCE_INPUT");
  }
  if (
    record.kind !== EVIDENCE_KIND ||
    record.schema_version !== EVIDENCE_SCHEMA_VERSION ||
    !isDeepStrictEqual(record.limitations, LIMITATIONS)
  ) {
    fail("MEASURED_EVIDENCE_SCOPE");
  }
  return {
    contractManifestSha256: record.input_identity.contract_manifest_sha256,
    evidenceSha256: sha256(bytes),
    hwRefId: record.input_identity.hw_ref_id,
    record,
    sourceCommit: record.input_identity.source_commit,
  };
}

async function assertNewEvidencePath(outputPath, code) {
  const normalized = assertNormalizedAbsolutePath(outputPath, code);
  const parent = path.dirname(normalized);
  const resolvedParent = await assertDirectPathChain(parent, code);
  const parentStat = await lstat(resolvedParent).catch(() => fail(code));
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) fail(code);
  const resolved = path.join(resolvedParent, path.basename(normalized));
  try {
    await lstat(resolved);
  } catch (error) {
    if (error?.code === "ENOENT") return resolved;
    fail(code);
  }
  fail(code);
}

async function inspectOwnedHardLinkPair(stagingPath, outputPath) {
  try {
    const [staging, output] = await Promise.all([
      lstat(stagingPath, { bigint: true }),
      lstat(outputPath, { bigint: true }),
    ]);
    if (
      !staging.isFile() ||
      staging.isSymbolicLink() ||
      !output.isFile() ||
      output.isSymbolicLink() ||
      !sameSnapshot(staging, output)
    ) {
      return { status: "mismatch" };
    }
    return { output, staging, status: "owned" };
  } catch (error) {
    return { error, status: error?.code === "ENOENT" ? "missing" : "error" };
  }
}

async function requireOwnedHardLinkPair(stagingPath, outputPath, code) {
  const inspection = await inspectOwnedHardLinkPair(stagingPath, outputPath);
  if (inspection.status !== "owned") fail(code, { cause: inspection.error });
  return inspection;
}

async function inspectCleanupOwnership(
  outputPath,
  recordedIdentity,
  expectedBytes,
  { requireExpectedContent = true } = {},
) {
  let before;
  try {
    before = await lstat(outputPath, { bigint: true });
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      !sameIdentity(recordedIdentity, before) ||
      (requireExpectedContent && before.size !== BigInt(expectedBytes.length))
    ) {
      return { status: "mismatch" };
    }
  } catch (error) {
    return { error, status: error?.code === "ENOENT" ? "absent" : "error" };
  }
  if (!requireExpectedContent) return { status: "owned" };
  let material;
  try {
    material = await readSmallRegularFile(
      outputPath,
      "MEASURED_EVIDENCE_FINAL_OWNERSHIP",
    );
  } catch (error) {
    return { error, status: "mismatch" };
  }
  let after;
  try {
    after = await lstat(outputPath, { bigint: true });
  } catch (error) {
    return { error, status: error?.code === "ENOENT" ? "absent" : "error" };
  }
  if (
    !sameSnapshot(before, after) ||
    !sameIdentity(recordedIdentity, after) ||
    !material.bytes.equals(expectedBytes)
  ) {
    return { status: "mismatch" };
  }
  return { status: "owned" };
}

function ownershipRaceError(failure, outputPath, status, cause) {
  const error = new NativeCandidateMeasuredEvidenceError(
    "MEASURED_EVIDENCE_FINAL_OWNERSHIP_RACE",
    { cause: failure ?? cause },
  );
  error.cleanupCompleted = false;
  error.competitorPreserved = status !== "absent";
  error.finalCleanupPath = outputPath;
  error.ownershipStatus = status;
  return error;
}

function stagingOwnershipRaceError(failure, stagingPath, status, cause) {
  const error = new NativeCandidateMeasuredEvidenceError(
    "MEASURED_EVIDENCE_STAGING_OWNERSHIP_RACE",
    { cause: failure ?? cause },
  );
  error.cleanupCompleted = false;
  error.competitorPreserved = true;
  error.cleanupPath = stagingPath;
  error.ownershipStatus = status;
  return error;
}

export async function publishNativeCandidateMeasuredEvidence(
  outputPath,
  bytes,
  operations = {},
) {
  validateNativeCandidateMeasuredEvidenceRecord(bytes);
  const resolved = await assertNewEvidencePath(outputPath, "MEASURED_EVIDENCE_OUTPUT");
  const randomSuffix = operations.randomSuffix ?? (() => randomBytes(16).toString("hex"));
  const suffix = randomSuffix();
  if (typeof suffix !== "string" || !/^[0-9a-f]{32}$/u.test(suffix)) {
    fail("MEASURED_EVIDENCE_OUTPUT");
  }
  const stagingPath = path.join(
    path.dirname(resolved),
    `.${path.basename(resolved)}.${suffix}.staging`,
  );
  const openFile = operations.openFile ?? open;
  const linkFile = operations.linkFile ?? link;
  const readFileBytes = operations.readFileBytes ?? readFile;
  const unlinkFile = operations.unlinkFile ?? unlink;
  const beforeLink = operations.beforeLink ?? (async () => {});
  const afterLinkBeforeRead = operations.afterLinkBeforeRead ?? (async () => {});
  const beforeCleanup = operations.beforeCleanup ?? (async () => {});
  let handle;
  let stagingIdentity;
  let stagingOwned = false;
  let finalOwned = false;
  let failure;
  try {
    handle = await openFile(stagingPath, "wx");
    stagingOwned = true;
    stagingIdentity = await handle.stat({ bigint: true });
    if (!stagingIdentity.isFile() || stagingIdentity.size !== 0n) {
      fail("MEASURED_EVIDENCE_STAGING");
    }
    await handle.writeFile(bytes);
    await handle.sync();
    const stagedHandleSnapshot = await handle.stat({ bigint: true });
    if (
      !stagedHandleSnapshot.isFile() ||
      !sameIdentity(stagingIdentity, stagedHandleSnapshot) ||
      stagedHandleSnapshot.size !== BigInt(bytes.length)
    ) {
      fail("MEASURED_EVIDENCE_STAGING");
    }
    await handle.close();
    handle = undefined;
    const stagedBeforeRead = await lstat(stagingPath, { bigint: true });
    const staged = await readFileBytes(stagingPath);
    const stagedAfterRead = await lstat(stagingPath, { bigint: true });
    if (
      !sameSnapshot(stagedHandleSnapshot, stagedBeforeRead) ||
      !sameSnapshot(stagedHandleSnapshot, stagedAfterRead) ||
      !Buffer.isBuffer(staged) ||
      !staged.equals(bytes)
    ) {
      fail("MEASURED_EVIDENCE_STAGING");
    }
    validateNativeCandidateMeasuredEvidenceRecord(staged);
    await beforeLink({ outputPath: resolved, stagingPath });
    await linkFile(stagingPath, resolved);
    finalOwned = true;
    const linkedIdentity = await requireOwnedHardLinkPair(
      stagingPath,
      resolved,
      "MEASURED_EVIDENCE_LINK_IDENTITY",
    );
    if (!sameIdentity(stagingIdentity, linkedIdentity.staging)) {
      fail("MEASURED_EVIDENCE_LINK_IDENTITY");
    }
    await afterLinkBeforeRead({ outputPath: resolved, stagingPath });
    const beforePersistedRead = await requireOwnedHardLinkPair(
      stagingPath,
      resolved,
      "MEASURED_EVIDENCE_PERSISTED_IDENTITY",
    );
    const persisted = await readFileBytes(resolved);
    const afterPersistedRead = await requireOwnedHardLinkPair(
      stagingPath,
      resolved,
      "MEASURED_EVIDENCE_PERSISTED_IDENTITY",
    );
    if (
      !sameSnapshot(beforePersistedRead.staging, afterPersistedRead.staging) ||
      !sameSnapshot(beforePersistedRead.output, afterPersistedRead.output) ||
      !Buffer.isBuffer(persisted) ||
      !persisted.equals(bytes)
    ) {
      fail("MEASURED_EVIDENCE_PERSISTED");
    }
    validateNativeCandidateMeasuredEvidenceRecord(persisted);
  } catch (error) {
    failure =
      error instanceof NativeCandidateMeasuredEvidenceError
        ? error
        : new NativeCandidateMeasuredEvidenceError("MEASURED_EVIDENCE_OUTPUT", {
            cause: error,
          });
  } finally {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch (error) {
        failure ??= new NativeCandidateMeasuredEvidenceError(
          "MEASURED_EVIDENCE_OUTPUT_CLOSE",
          { cause: error },
        );
      }
    }
    let cleanupAuthorized = true;
    let stagingCleanupAttempted = false;
    if (stagingOwned) {
      try {
        await beforeCleanup({ outputPath: resolved, stagingPath });
      } catch (error) {
        cleanupAuthorized = false;
        failure ??= new NativeCandidateMeasuredEvidenceError(
          "MEASURED_EVIDENCE_CLEANUP",
          { cause: error },
        );
        failure.cleanupCompleted = false;
        failure.cleanupPath = stagingPath;
      }
    }
    if (failure === undefined && stagingOwned && cleanupAuthorized) {
      stagingCleanupAttempted = true;
      const ownership = await inspectCleanupOwnership(
        stagingPath,
        stagingIdentity,
        bytes,
        { requireExpectedContent: false },
      );
      if (ownership.status === "owned") {
        try {
          await unlinkFile(stagingPath);
          stagingOwned = false;
        } catch (error) {
          failure = new NativeCandidateMeasuredEvidenceError(
            "MEASURED_EVIDENCE_CLEANUP",
            { cause: error },
          );
          failure.cleanupCompleted = false;
          failure.cleanupPath = stagingPath;
        }
      } else if (ownership.status === "absent") {
        stagingOwned = false;
      } else {
        stagingOwned = false;
        failure = stagingOwnershipRaceError(
          failure,
          stagingPath,
          ownership.status,
          ownership.error,
        );
      }
    }
    if (failure === undefined && finalOwned && !stagingOwned) {
      const ownership = await inspectCleanupOwnership(
        resolved,
        stagingIdentity,
        bytes,
      );
      if (ownership.status !== "owned") {
        finalOwned = false;
        failure = ownershipRaceError(
          failure,
          resolved,
          ownership.status,
          ownership.error,
        );
      }
    }
    if (failure !== undefined && finalOwned) {
      const ownership = await inspectCleanupOwnership(
        resolved,
        stagingIdentity,
        bytes,
      );
      if (ownership.status === "owned") {
        try {
          await unlinkFile(resolved);
          finalOwned = false;
        } catch (error) {
          failure.cleanupCompleted = false;
          failure.finalCleanupPath = resolved;
          failure.finalCleanupCause = error;
        }
      } else if (ownership.status === "absent") {
        finalOwned = false;
      } else {
        finalOwned = false;
        failure = ownershipRaceError(
          failure,
          resolved,
          ownership.status,
          ownership.error,
        );
      }
    }
    if (
      failure !== undefined &&
      stagingOwned &&
      cleanupAuthorized &&
      !stagingCleanupAttempted
    ) {
      const ownership = await inspectCleanupOwnership(
        stagingPath,
        stagingIdentity,
        bytes,
        { requireExpectedContent: false },
      );
      if (ownership.status === "owned") {
        try {
          await unlinkFile(stagingPath);
          stagingOwned = false;
        } catch (error) {
          failure.cleanupCompleted = false;
          failure.cleanupPath = stagingPath;
          failure.cleanupCause = error;
        }
      } else if (ownership.status === "absent") {
        stagingOwned = false;
      } else {
        stagingOwned = false;
        failure = stagingOwnershipRaceError(
          failure,
          stagingPath,
          ownership.status,
          ownership.error,
        );
      }
    }
    if (
      [
        "MEASURED_EVIDENCE_FINAL_OWNERSHIP_RACE",
        "MEASURED_EVIDENCE_STAGING_OWNERSHIP_RACE",
      ].includes(failure?.code) &&
      !stagingOwned &&
      !finalOwned
    ) {
      failure.ownedCleanupCompleted = true;
    }
  }
  if (failure !== undefined) throw failure;
  if (stagingOwned || !finalOwned) fail("MEASURED_EVIDENCE_OUTPUT");
  return resolved;
}

export async function validateNativeCandidateMeasuredEvidenceFile(inputPath) {
  const material = await readSmallRegularFile(inputPath, "MEASURED_EVIDENCE_FILE");
  return validateNativeCandidateMeasuredEvidenceRecord(material.bytes);
}

async function runHook(hooks, name, payload) {
  const hook = hooks[name];
  if (hook === undefined) return;
  if (typeof hook !== "function") fail("MEASURED_EVIDENCE_HOOK");
  await hook(payload);
}

function exactRunInput(input) {
  exactKeys(
    input,
    [
      "candidatePlan",
      "expectedContractSha256",
      "expectedHardwareReferenceSha256",
      "expectedHwRefId",
      "expectedOperatorFactsSha256",
      "fixtureRegistryProjection",
      "measuredHardwareReferencePath",
      "operatorFacts",
      "outputBundleRoot",
      "outputEvidencePath",
      "sourceRoots",
      "wavPath",
    ],
    "MEASURED_EVIDENCE_INPUT_KEYS",
  );
  assertDigest(input.expectedContractSha256, "MEASURED_EVIDENCE_CONTRACT_TRUST_REQUIRED");
  assertDigest(
    input.expectedHardwareReferenceSha256,
    "MEASURED_EVIDENCE_HW_TRUST_REQUIRED",
  );
  assertIdentifier(input.expectedHwRefId, "MEASURED_EVIDENCE_HW_TRUST_REQUIRED");
  const outputBundleRoot = assertNormalizedAbsolutePath(
    input.outputBundleRoot,
    "MEASURED_EVIDENCE_BUNDLE_PATH",
  );
  const outputEvidencePath = assertNormalizedAbsolutePath(
    input.outputEvidencePath,
    "MEASURED_EVIDENCE_OUTPUT",
  );
  if (
    outputEvidencePath === outputBundleRoot ||
    isStrictDescendant(outputBundleRoot, outputEvidencePath)
  ) {
    fail("MEASURED_EVIDENCE_OUTPUT_OVERLAP");
  }
  return { outputBundleRoot, outputEvidencePath };
}

async function runNativeCandidateMeasuredEvidenceCore(input, dependencies) {
  const { outputBundleRoot, outputEvidencePath } = exactRunInput(input);
  const operator = validateOperatorFacts(
    input.operatorFacts,
    input.expectedOperatorFactsSha256,
  );
  await assertNewEvidencePath(outputEvidencePath, "MEASURED_EVIDENCE_PARTIAL_OUTPUT");
  const proposalInput = {
    candidatePlan: input.candidatePlan,
    fixtureRegistryProjection: input.fixtureRegistryProjection,
    measuredHardwareReferencePath: input.measuredHardwareReferencePath,
  };
  const proposal = await dependencies.propose(proposalInput);
  const proposalIdentity = inspectMeasuredProposal(proposal, {
    expectedContractSha256: input.expectedContractSha256,
    expectedHardwareReferenceSha256: input.expectedHardwareReferenceSha256,
    expectedHwRefId: input.expectedHwRefId,
    operatorFacts: operator.operatorFacts,
  });
  await assertNewEvidencePath(outputEvidencePath, "MEASURED_EVIDENCE_PARTIAL_OUTPUT");
  const materialized = await dependencies.materialize({
    ...proposalInput,
    expectedContractSha256: input.expectedContractSha256,
    outputRoot: outputBundleRoot,
    sourceRoots: input.sourceRoots,
  });
  validateMaterializerResult(materialized, input.expectedContractSha256, outputBundleRoot);
  await runHook(dependencies.hooks, "afterMaterializeBeforePreflight", {
    bundleRoot: outputBundleRoot,
  });
  await validateMaterializedBundle(
    dependencies.validateBundle,
    outputBundleRoot,
    input.expectedContractSha256,
  );
  const preflight = await inspectMaterializedBundle(outputBundleRoot, {
    candidatePlan: input.candidatePlan,
    expectedContractSha256: input.expectedContractSha256,
    expectedHardwareReferenceSha256: input.expectedHardwareReferenceSha256,
    expectedHwRefId: input.expectedHwRefId,
    operatorFacts: operator.operatorFacts,
    sourceRoots: input.sourceRoots,
  });
  if (
    !isDeepStrictEqual(preflight.candidate, proposalIdentity.candidate) ||
    !isDeepStrictEqual(preflight.hardware, proposalIdentity.hardware) ||
    !isDeepStrictEqual(preflight.runPlan, proposalIdentity.runPlan)
  ) {
    fail("MEASURED_EVIDENCE_PROPOSAL_MATERIALIZED_JOIN");
  }
  const reference = await validateReference(
    dependencies.referenceLoader,
    input.wavPath,
    preflight.bundleRoot,
  );
  const expectedLockedInputSnapshotSha256 = buildLockedInputSnapshotSha256(
    preflight.stageIdentity,
    reference.wavSha256,
  );
  const conformanceInput = {
    ...preflight.stageIdentity.conformanceInput,
    wavPath: reference.wavPath,
  };
  await runHook(dependencies.hooks, "afterPreflightBeforeConformance", {
    bundleRoot: preflight.bundleRoot,
    conformanceInput,
  });
  await validateMaterializedBundle(
    dependencies.validateBundle,
    outputBundleRoot,
    input.expectedContractSha256,
  );
  const immediatePreExecution = await inspectMaterializedBundle(outputBundleRoot, {
    candidatePlan: input.candidatePlan,
    expectedContractSha256: input.expectedContractSha256,
    expectedHardwareReferenceSha256: input.expectedHardwareReferenceSha256,
    expectedHwRefId: input.expectedHwRefId,
    operatorFacts: operator.operatorFacts,
    sourceRoots: input.sourceRoots,
  });
  const immediateReference = await validateReference(
    dependencies.referenceLoader,
    input.wavPath,
    preflight.bundleRoot,
  );
  if (
    !isDeepStrictEqual(
      comparableBundleIdentity(immediatePreExecution),
      comparableBundleIdentity(preflight),
    ) ||
    immediateReference.manifestSha256 !== reference.manifestSha256 ||
    immediateReference.wavSha256 !== reference.wavSha256
  ) {
    fail("MEASURED_EVIDENCE_PREFLIGHT_MUTATION");
  }
  await assertNewEvidencePath(outputEvidencePath, "MEASURED_EVIDENCE_PARTIAL_OUTPUT");
  const conformance = validateConformanceResult(
    await dependencies.conformanceRunner(conformanceInput),
    {
      executionHostSha256: preflight.stageIdentity.worker.sha256,
      lockedInputSnapshotSha256: expectedLockedInputSnapshotSha256,
      schemaRegistrySha256: preflight.stageIdentity.schemaRegistry.sha256,
    },
  );
  await runHook(dependencies.hooks, "afterConformanceBeforePostflight", {
    bundleRoot: preflight.bundleRoot,
    conformanceInput,
  });
  await validateMaterializedBundle(
    dependencies.validateBundle,
    outputBundleRoot,
    input.expectedContractSha256,
  );
  const postflight = await inspectMaterializedBundle(outputBundleRoot, {
    candidatePlan: input.candidatePlan,
    expectedContractSha256: input.expectedContractSha256,
    expectedHardwareReferenceSha256: input.expectedHardwareReferenceSha256,
    expectedHwRefId: input.expectedHwRefId,
    operatorFacts: operator.operatorFacts,
    sourceRoots: input.sourceRoots,
  });
  const postflightReference = await validateReference(
    dependencies.referenceLoader,
    input.wavPath,
    preflight.bundleRoot,
  );
  if (
    !isDeepStrictEqual(comparableBundleIdentity(postflight), comparableBundleIdentity(preflight)) ||
    postflightReference.manifestSha256 !== reference.manifestSha256 ||
    postflightReference.wavSha256 !== reference.wavSha256
  ) {
    fail("MEASURED_EVIDENCE_POSTFLIGHT_MUTATION");
  }
  const evidence = {
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
      backend_execute_calls: conformance.backendExecuteCalls,
      check_summary: {
        passed: conformance.checkSummary.passed,
        total: conformance.checkSummary.total,
      },
      conformance_record_sha256: conformance.conformanceRecordSha256,
    },
    execution_descriptor: {
      argv_roles: [...ARGV_ROLES],
      full_run_plan_argv_used: false,
      full_run_plan_fixture_used: false,
      scope: "native-contract-stage-only",
    },
    input_identity: {
      config_sha256: preflight.stageIdentity.parameters.sha256,
      contract_manifest_sha256: preflight.contractManifestSha256,
      execution_host_sha256: conformance.executableSha256,
      hw_ref_id: preflight.hardware.hw_ref_id,
      locked_input_snapshot_sha256: conformance.lockedInputSnapshotSha256,
      measured_hardware_reference_sha256: preflight.hardwareSha256,
      model_sha256: preflight.stageIdentity.model.sha256,
      operator_facts_sha256: operator.digest,
      quality_reference_manifest_sha256: reference.manifestSha256,
      run_plan_sha256: preflight.runPlanSha256,
      runtime_bundle_sha256: preflight.stageIdentity.runtimeInventory.sha256,
      schema_registry_sha256: conformance.schemaRegistrySha256,
      source_commit: preflight.candidate.source.source_revision,
      wav_sha256: reference.wavSha256,
      worker_id: conformance.workerId,
    },
    kind: EVIDENCE_KIND,
    limitations: [...LIMITATIONS],
    schema_version: EVIDENCE_SCHEMA_VERSION,
  };
  const evidenceBytes = Buffer.from(encodeCanonicalJsonLine(evidence), "utf8");
  validateNativeCandidateMeasuredEvidenceRecord(evidenceBytes);
  await runHook(dependencies.hooks, "beforeEvidencePublish", {
    bundleRoot: preflight.bundleRoot,
    outputEvidencePath,
  });
  await assertNewEvidencePath(outputEvidencePath, "MEASURED_EVIDENCE_PARTIAL_OUTPUT");
  await dependencies.publishEvidence(outputEvidencePath, evidenceBytes);
  return dependencies.validateEvidenceFile(outputEvidencePath);
}

const PRODUCTION_DEPENDENCIES = Object.freeze({
  conformanceRunner: runReleaseNativeCandidateConformance,
  hooks: Object.freeze({}),
  materialize: materializeMeasuredSherpaCandidateInputCloseout,
  propose: proposeMeasuredSherpaCandidateInputCloseout,
  publishEvidence: publishNativeCandidateMeasuredEvidence,
  referenceLoader: prepareQualitySmokeReference,
  validateBundle: validateCandidateArtifactInputBundle,
  validateEvidenceFile: validateNativeCandidateMeasuredEvidenceFile,
});

export async function runNativeCandidateMeasuredEvidence(input) {
  return runNativeCandidateMeasuredEvidenceCore(input, PRODUCTION_DEPENDENCIES);
}

export async function __runNativeCandidateMeasuredEvidenceForTest(
  input,
  {
    conformanceRunner = PRODUCTION_DEPENDENCIES.conformanceRunner,
    hooks = PRODUCTION_DEPENDENCIES.hooks,
    materialize = PRODUCTION_DEPENDENCIES.materialize,
    propose = PRODUCTION_DEPENDENCIES.propose,
    publishEvidence = PRODUCTION_DEPENDENCIES.publishEvidence,
    referenceLoader = PRODUCTION_DEPENDENCIES.referenceLoader,
    validateBundle = PRODUCTION_DEPENDENCIES.validateBundle,
    validateEvidenceFile = PRODUCTION_DEPENDENCIES.validateEvidenceFile,
  } = {},
) {
  return runNativeCandidateMeasuredEvidenceCore(input, {
    conformanceRunner,
    hooks,
    materialize,
    propose,
    publishEvidence,
    referenceLoader,
    validateBundle,
    validateEvidenceFile,
  });
}

async function main(arguments_) {
  if (arguments_.length !== 2 || arguments_[0] !== "--validate") {
    fail("MEASURED_EVIDENCE_USAGE");
  }
  const result = await validateNativeCandidateMeasuredEvidenceFile(arguments_[1]);
  process.stdout.write(
    `candidate-native-measured-evidence-file=verified evidence_sha256=${result.evidenceSha256} ` +
      `contract_manifest_sha256=${result.contractManifestSha256} hw_ref_id=${result.hwRefId} ` +
      `source_commit=${result.sourceCommit} scope=native-contract-stage-only ` +
      "formal_claims=none production_evidence=false\n",
  );
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(
      `${
        error instanceof NativeCandidateMeasuredEvidenceError
          ? error.code
          : "MEASURED_EVIDENCE_INTERNAL"
      }\n`,
    );
    process.exitCode = 1;
  });
}

export const nativeCandidateMeasuredEvidencePaths = Object.freeze({
  moduleDirectory: HERE,
});
