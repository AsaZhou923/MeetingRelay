import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { link, lstat, open, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

import {
  encodeCanonicalJson,
  encodeCanonicalJsonLine,
} from "../phase0-harness/canonical-json.mjs";
import { validateCandidateArtifactInputBundle } from "../phase0-harness/candidate-artifact-contract.mjs";
import {
  aggregateDescriptiveAsrScores,
  assertAsrScorerRuntimeIdentity,
  getAsrScorerProfile,
  scoreAsrTranscript,
  validateDescriptiveAsrAggregate,
} from "./asr-error-rate.mjs";
import {
  readPinnedAsrQualityRunPolicy,
  validateAsrQualityRunPolicyCoverage,
} from "./asr-quality-run-policy.mjs";
import {
  buildControlledHypothesisLedger,
  buildControlledHypothesisLedgerSeal,
  publishControlledHypothesisLedger,
  publishControlledHypothesisLedgerSeal,
  readControlledHypothesisLedger,
  readControlledHypothesisLedgerSeal,
} from "./controlled-hypothesis-ledger.mjs";
import {
  runNativeCandidateComponentEvidence,
  validateNativeCandidateComponentEvidenceFile,
} from "./native-candidate-component-evidence.mjs";
import { validateNativeCandidateMeasuredEvidenceRecord } from "./native-candidate-measured-evidence.mjs";
import { materializeQualityCorpus } from "./quality-corpus.mjs";

const KIND = "meetingrelay-native-candidate-quality-evidence-v1";
const SCHEMA_VERSION = "1.0";
const MEASUREMENT_STATUS = "scorer-mechanics-exercised";
const QUALITY_GATE_STATUS = "not-assessed";
const CANDIDATE_ID = "sherpa-native-sensevoice-int8-2024-07-17-win-x64-cpu";
const RELEASE_HOST_USAGE = Buffer.from("SHERPA_QUALITY_USAGE\n", "ascii");
const DIGEST = /^(?!0{64}$)[0-9a-f]{64}$/u;
const COMMIT = /^(?!0{40}$)[0-9a-f]{40}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/u;
const MAX_FINAL_BYTES = 16 * 1024 * 1024;
const MAX_SMALL_INPUT_BYTES = 16 * 1024 * 1024;
const MAX_HOST_BYTES = 64 * 1024 * 1024;
const MAX_BUNDLE_DOCUMENT_BYTES = 16 * 1024 * 1024;
const MAX_SAMPLES = 1_000;
const WINDOWS_DOS_DEVICE = /^(?:AUX|CON|NUL|PRN|COM[1-9]|LPT[1-9])(?:\.|$)/iu;

const AUTHORITY = Object.freeze({
  formal_claims: "none",
  production_evidence: false,
  public_distribution: false,
});
const ROOT_KEYS = Object.freeze([
  "aggregate",
  "authority",
  "candidate_identity",
  "component_evidence",
  "corpus_identity",
  "hardware_identity",
  "kind",
  "ledger_identity",
  "measurement_status",
  "quality_gate_status",
  "run_policy_identity",
  "schema_version",
  "scorer_identity",
  "scores",
  "source_identity",
]);
const CANDIDATE_IDENTITY_KEYS = Object.freeze([
  "asset_lock_sha256",
  "baseline_execution_host_sha256",
  "candidate_id",
  "candidate_manifest_sha256",
  "config_sha256",
  "contract_manifest_sha256",
  "execution_host_sha256",
  "measured_evidence_sha256",
  "model_sha256",
  "package_lock_sha256",
  "runtime_bundle_sha256",
  "schema_registry_sha256",
  "tokens_sha256",
]);
const COMPONENT_IDENTITY_KEYS = Object.freeze(["sample_count", "sha256"]);
const CORPUS_IDENTITY_KEYS = Object.freeze([
  "manifest_sha256",
  "sample_count",
  "slice_count",
  "snapshot_sha256",
  "validation_date",
]);
const HARDWARE_IDENTITY_KEYS = Object.freeze([
  "evidence_sha256",
  "hw_ref_id",
  "operator_facts_sha256",
]);
const LEDGER_IDENTITY_KEYS = Object.freeze([
  "candidate_identity_sha256",
  "entry_count",
  "projection_sha256",
  "seal_sha256",
  "sha256",
]);
const POLICY_IDENTITY_KEYS = Object.freeze([
  "coverage_scope",
  "exclusion_policy",
  "max_attempts",
  "sha256",
]);
const SCORER_IDENTITY_KEYS = Object.freeze(["profile_id", "profile_sha256"]);
const SOURCE_IDENTITY_KEYS = Object.freeze(["commit", "evidence_sha256"]);
const INPUT_KEYS = Object.freeze([
  "bundleRoot",
  "componentEvidencePath",
  "controlledRoot",
  "corpusInput",
  "expectedContractSha256",
  "expectedHardwareEvidenceSha256",
  "expectedMeasuredEvidenceSha256",
  "expectedQualityHostSha256",
  "expectedRunPolicySha256",
  "expectedScorerProfileSha256",
  "expectedSourceCommit",
  "finalEvidencePath",
  "ledgerRelativePath",
  "measuredEvidencePath",
  "qualityHostPath",
  "runPolicyPath",
  "scorerProfilePath",
  "sealRelativePath",
]);
const BUNDLE_COMPONENT_PATH_KEYS = Object.freeze([
  "assetLockPath",
  "modelPath",
  "packageLockPath",
  "runtimeLibDir",
  "schemaRegistryPath",
  "tokensPath",
]);
const BUNDLE_IDENTITY_KEYS = Object.freeze([
  "assetLockSha256",
  "baselineExecutionHostSha256",
  "candidateId",
  "candidateManifestSha256",
  "configSha256",
  "contractManifestSha256",
  "hardwareEvidenceSha256",
  "hwRefId",
  "modelSha256",
  "packageLockSha256",
  "runPlanSha256",
  "runtimeBundleSha256",
  "schemaRegistrySha256",
  "sourceCommit",
  "tokensSha256",
]);
const CANDIDATE_KEYS = Object.freeze([
  "asset_lock_sha256",
  "candidate_id",
  "model_sha256",
  "package_lock_sha256",
  "parameter_sha256",
  "runtime_bundle_sha256",
  "tokens_sha256",
]);
const HOST_IDENTITY_KEYS = Object.freeze(["executable_sha256", "schema_registry_sha256"]);

export class NativeCandidateQualityRunnerError extends Error {
  constructor(code, options = {}) {
    super(code, options);
    this.name = "NativeCandidateQualityRunnerError";
    this.code = code;
  }
}

function fail(code, options = {}) {
  throw new NativeCandidateQualityRunnerError(code, options);
}

function wrap(code, error) {
  if (error instanceof NativeCandidateQualityRunnerError) throw error;
  fail(code, { cause: error });
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function exactKeys(value, expected, code) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(code);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(code);
  }
}

function assertDigest(value, code) {
  if (typeof value !== "string" || !DIGEST.test(value)) fail(code);
}

function assertCommit(value, code) {
  if (typeof value !== "string" || !COMMIT.test(value)) fail(code);
}

function assertIdentifier(value, code) {
  if (
    typeof value !== "string" || !IDENTIFIER.test(value) || value !== value.normalize("NFC")
  ) {
    fail(code);
  }
}

function assertDate(value, code) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) fail(code);
  const instant = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(instant.getTime()) || instant.toISOString().slice(0, 10) !== value) fail(code);
}

function assertCount(value, code, maximum = MAX_SAMPLES) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) fail(code);
}

function isCanonicalLocalAbsolutePath(value) {
  if (
    typeof value !== "string" || value.length === 0 || value.includes("\0") ||
    /^[\\/]{2}/u.test(value) || !path.isAbsolute(value) || path.normalize(value) !== value ||
    path.resolve(value) !== value || value.normalize("NFC") !== value
  ) {
    return false;
  }
  return !value.slice(path.parse(value).root.length).includes(":");
}

function assertAbsolutePath(value, code) {
  if (!isCanonicalLocalAbsolutePath(value)) fail(code);
  return value;
}

function sameIdentity(left, right) {
  const usable = (value) =>
    value !== null && typeof value === "object" &&
    typeof value.dev === "bigint" && value.dev > 0n &&
    typeof value.ino === "bigint" && value.ino > 0n &&
    typeof value.mode === "bigint";
  return usable(left) && usable(right) &&
    left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}

function sameSnapshot(left, right) {
  return sameIdentity(left, right) && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

async function assertDirectPathChain(inputPath, finalKind, code) {
  assertAbsolutePath(inputPath, code);
  const root = path.parse(inputPath).root;
  const segments = path.relative(root, inputPath).split(path.sep).filter(Boolean);
  let current = root;
  if (segments.length === 0) {
    const metadata = await lstat(root, { bigint: true }).catch((error) => fail(code, { cause: error }));
    if (
      metadata.isSymbolicLink() ||
      (finalKind === "directory" && !metadata.isDirectory()) ||
      (finalKind === "file" && !metadata.isFile())
    ) fail(code);
    return inputPath;
  }
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    const metadata = await lstat(current, { bigint: true }).catch((error) => fail(code, { cause: error }));
    const final = index === segments.length - 1;
    if (
      metadata.isSymbolicLink() || (!final && !metadata.isDirectory()) ||
      (final && finalKind === "directory" && !metadata.isDirectory()) ||
      (final && finalKind === "file" && !metadata.isFile())
    ) fail(code);
  }
  return inputPath;
}

async function readHandleBytes(handle, size, maximum, code) {
  if (typeof size !== "bigint" || size < 1n || size > BigInt(maximum)) fail(code);
  const bytes = Buffer.alloc(Number(size));
  let offset = 0;
  while (offset < bytes.length) {
    const result = await handle.read(bytes, offset, bytes.length - offset, offset)
      .catch((error) => fail(code, { cause: error }));
    if (
      result === null || typeof result !== "object" || !Number.isSafeInteger(result.bytesRead) ||
      result.bytesRead <= 0 || result.bytesRead > bytes.length - offset
    ) fail(code);
    offset += result.bytesRead;
  }
  const probe = Buffer.alloc(1);
  const end = await handle.read(probe, 0, 1, bytes.length)
    .catch((error) => fail(code, { cause: error }));
  if (end === null || typeof end !== "object" || end.bytesRead !== 0) fail(code);
  return bytes;
}

async function readStableFile(inputPath, { code, expectedSha256, maximum = MAX_SMALL_INPUT_BYTES }) {
  const filePath = await assertDirectPathChain(inputPath, "file", code);
  const [pathBefore, realpathBefore] = await Promise.all([
    lstat(filePath, { bigint: true }),
    realpath(filePath),
  ]).catch((error) => fail(code, { cause: error }));
  if (!pathBefore.isFile() || pathBefore.isSymbolicLink()) fail(code);
  let handle;
  try {
    handle = await open(filePath, "r");
    const handleBefore = await handle.stat({ bigint: true });
    if (!handleBefore.isFile() || !sameSnapshot(pathBefore, handleBefore)) fail(code);
    const first = await readHandleBytes(handle, handleBefore.size, maximum, code);
    const handleMiddle = await handle.stat({ bigint: true });
    const second = await readHandleBytes(handle, handleBefore.size, maximum, code);
    const handleAfter = await handle.stat({ bigint: true });
    const [pathAfter, realpathAfter] = await Promise.all([
      lstat(filePath, { bigint: true }),
      realpath(filePath),
    ]).catch((error) => fail(code, { cause: error }));
    if (
      !first.equals(second) || !sameSnapshot(handleBefore, handleMiddle) ||
      !sameSnapshot(handleMiddle, handleAfter) || !sameSnapshot(handleAfter, pathAfter) ||
      realpathBefore !== realpathAfter || BigInt(first.length) !== pathAfter.size ||
      (expectedSha256 !== undefined && sha256(first) !== expectedSha256)
    ) fail(code);
    return Object.freeze({ bytes: first, path: filePath, snapshot: pathAfter });
  } catch (error) {
    wrap(code, error);
  } finally {
    if (handle !== undefined) {
      try { await handle.close(); } catch (error) { fail(code, { cause: error }); }
    }
  }
}

function parseCanonicalDocument(bytes, code) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_BUNDLE_DOCUMENT_BYTES) fail(code);
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) fail(code);
  let value;
  try { value = JSON.parse(text); } catch (error) { fail(code, { cause: error }); }
  if (encodeCanonicalJson(value) !== text) fail(code);
  return value;
}

function parseCanonicalLine(bytes, code) {
  if (
    !Buffer.isBuffer(bytes) || bytes.length < 2 || bytes.length > MAX_FINAL_BYTES ||
    bytes.at(-1) !== 0x0a || bytes.subarray(0, -1).includes(0x0a) || bytes.includes(0x0d)
  ) fail(code);
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) fail(code);
  let value;
  try { value = JSON.parse(text); } catch (error) { fail(code, { cause: error }); }
  if (encodeCanonicalJsonLine(value) !== text) fail(code);
  return value;
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== "" && relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function assertBundleRelativePath(value, code) {
  const segments = typeof value === "string" ? value.split("/") : [];
  if (
    typeof value !== "string" || value.length === 0 || value.length > 1_024 ||
    value !== value.normalize("NFC") || value.includes("\\") || value.includes(":") ||
    path.posix.isAbsolute(value) || path.win32.isAbsolute(value) ||
    segments.some((segment) =>
      segment.length === 0 || segment === "." || segment === ".." || segment.endsWith(".") ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(segment) || WINDOWS_DOS_DEVICE.test(segment))
  ) fail(code);
  return value;
}

function resolveBundlePath(root, relativePath, code) {
  assertBundleRelativePath(relativePath, code);
  const resolved = path.resolve(root, ...relativePath.split("/"));
  if (!isWithin(root, resolved)) fail(code);
  return resolved;
}

function snapshotProjection(stat) {
  return Object.freeze({
    ctimeNs: stat.ctimeNs,
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
    mtimeNs: stat.mtimeNs,
    size: stat.size,
  });
}

function assertControlledRelativePath(value, code) {
  const segments = typeof value === "string" ? value.split(/[\\/]/u) : [];
  if (
    typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > 1_024 ||
    path.isAbsolute(value) || path.win32.isAbsolute(value) || path.posix.isAbsolute(value) ||
    value.includes("\0") || value.includes(":") || segments.join(path.sep) !== value ||
    segments.some((segment) =>
      segment.length === 0 || segment === "." || segment === ".." || segment.endsWith(".") ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(segment) || WINDOWS_DOS_DEVICE.test(segment))
  ) fail(code);
  return value;
}

async function assertNewAbsoluteOutput(outputPath, code) {
  assertAbsolutePath(outputPath, code);
  await assertDirectPathChain(path.dirname(outputPath), "directory", code);
  try {
    await lstat(outputPath, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") return outputPath;
    fail(code, { cause: error });
  }
  fail(code);
}

async function assertControlledOutputNew(controlledRoot, relativePath, code) {
  await assertDirectPathChain(controlledRoot, "directory", code);
  assertControlledRelativePath(relativePath, code);
  const target = path.resolve(controlledRoot, ...relativePath.split(path.sep));
  if (!isWithin(controlledRoot, target)) fail(code);
  await assertDirectPathChain(path.dirname(target), "directory", code);
  try {
    await lstat(target, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") return target;
    fail(code, { cause: error });
  }
  fail(code);
}

function pathKey(value) {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function validateRunInput(input) {
  exactKeys(input, INPUT_KEYS, "QUALITY_RUN_INPUT_FIELDS");
  for (const key of [
    "expectedContractSha256",
    "expectedHardwareEvidenceSha256",
    "expectedMeasuredEvidenceSha256",
    "expectedQualityHostSha256",
    "expectedRunPolicySha256",
    "expectedScorerProfileSha256",
  ]) assertDigest(input[key], "QUALITY_RUN_TRUST_ANCHOR");
  assertCommit(input.expectedSourceCommit, "QUALITY_RUN_SOURCE_COMMIT");
  for (const key of [
    "bundleRoot",
    "componentEvidencePath",
    "controlledRoot",
    "finalEvidencePath",
    "measuredEvidencePath",
    "qualityHostPath",
    "runPolicyPath",
    "scorerProfilePath",
  ]) assertAbsolutePath(input[key], "QUALITY_RUN_PATH");
  assertControlledRelativePath(input.ledgerRelativePath, "QUALITY_RUN_LEDGER_PATH");
  assertControlledRelativePath(input.sealRelativePath, "QUALITY_RUN_SEAL_PATH");
  if (input.corpusInput === null || typeof input.corpusInput !== "object" || Array.isArray(input.corpusInput)) {
    fail("QUALITY_RUN_CORPUS_INPUT");
  }
  const absoluteTargets = [
    input.componentEvidencePath,
    input.finalEvidencePath,
    path.resolve(input.controlledRoot, ...input.ledgerRelativePath.split(path.sep)),
    path.resolve(input.controlledRoot, ...input.sealRelativePath.split(path.sep)),
  ];
  if (new Set(absoluteTargets.map(pathKey)).size !== absoluteTargets.length) fail("QUALITY_RUN_OUTPUT_OVERLAP");
  const inputPaths = [
    input.measuredEvidencePath,
    input.qualityHostPath,
    input.runPolicyPath,
    input.scorerProfilePath,
  ];
  if (absoluteTargets.some((target) => inputPaths.some((source) => pathKey(target) === pathKey(source)))) {
    fail("QUALITY_RUN_OUTPUT_OVERLAP");
  }
  for (const output of absoluteTargets) {
    if (
      isWithin(input.bundleRoot, output) || isWithin(input.controlledRoot, input.bundleRoot) ||
      (isCanonicalLocalAbsolutePath(input.corpusInput?.corpusRoot) &&
        (isWithin(input.corpusInput.corpusRoot, output) || pathKey(output) === pathKey(input.corpusInput.corpusRoot)))
    ) {
      fail("QUALITY_RUN_OUTPUT_OVERLAP");
    }
  }
  return Object.freeze({ ...input });
}

async function assertAllOutputsNew(input) {
  const [component, final, ledger, seal] = await Promise.all([
    assertNewAbsoluteOutput(input.componentEvidencePath, "QUALITY_RUN_COMPONENT_OUTPUT"),
    assertNewAbsoluteOutput(input.finalEvidencePath, "QUALITY_RUN_FINAL_OUTPUT"),
    assertControlledOutputNew(input.controlledRoot, input.ledgerRelativePath, "QUALITY_RUN_LEDGER_OUTPUT"),
    assertControlledOutputNew(input.controlledRoot, input.sealRelativePath, "QUALITY_RUN_SEAL_OUTPUT"),
  ]);
  if (new Set([component, final, ledger, seal].map(pathKey)).size !== 4) fail("QUALITY_RUN_OUTPUT_OVERLAP");
}

function parsePositiveSize(value, code, maximum = Number.MAX_SAFE_INTEGER) {
  if (typeof value !== "string" || !DECIMAL.test(value) || value.length > 20) fail(code);
  const parsed = BigInt(value);
  if (parsed < 1n || parsed > BigInt(maximum)) fail(code);
  return parsed;
}

async function readBundleDocument(bundleRoot, relativePath, code) {
  const material = await readStableFile(resolveBundlePath(bundleRoot, relativePath, code), {
    code,
    maximum: MAX_BUNDLE_DOCUMENT_BYTES,
  });
  return Object.freeze({ ...material, sha256: sha256(material.bytes), value: parseCanonicalDocument(material.bytes, code) });
}

function artifactByRole(candidate, role, code) {
  const matches = candidate?.artifacts?.filter((artifact) => artifact?.role === role) ?? [];
  if (matches.length !== 1) fail(code);
  return matches[0];
}

function validateArtifactBinding(artifact, contractEntries, code) {
  if (artifact === null || typeof artifact !== "object" || Array.isArray(artifact)) fail(code);
  assertBundleRelativePath(artifact.path, code);
  assertDigest(artifact.sha256, code);
  const size = parsePositiveSize(artifact.size_bytes, code);
  const entry = contractEntries.get(artifact.path);
  if (entry === undefined || entry.sha256 !== artifact.sha256 || entry.size_bytes !== artifact.size_bytes) fail(code);
  return Object.freeze({ path: artifact.path, sha256: artifact.sha256, size });
}

async function inspectCandidateBundle(input) {
  let validation;
  try {
    validation = await validateCandidateArtifactInputBundle(input.bundleRoot, {
      expectedContractSha256: input.expectedContractSha256,
    });
  } catch (error) {
    wrap("QUALITY_RUN_BUNDLE", error);
  }
  if (
    validation === null || typeof validation !== "object" ||
    validation.bundleRoot !== input.bundleRoot || validation.candidateId !== CANDIDATE_ID ||
    validation.contractManifestSha256 !== input.expectedContractSha256 ||
    validation.formalClaims !== "none" || validation.productionEvidence !== false ||
    validation.status !== "input-valid" || validation.validationPhase !== "input-only"
  ) fail("QUALITY_RUN_BUNDLE");

  const contract = await readBundleDocument(input.bundleRoot, "contract-manifest.json", "QUALITY_RUN_CONTRACT");
  if (contract.sha256 !== input.expectedContractSha256) fail("QUALITY_RUN_CONTRACT");
  exactKeys(contract.value, ["contract_id", "entries", "formal_claims", "schema_version"], "QUALITY_RUN_CONTRACT");
  if (
    contract.value.formal_claims !== "none" || contract.value.schema_version !== "1.0" ||
    !Array.isArray(contract.value.entries) || contract.value.entries.length < 1
  ) fail("QUALITY_RUN_CONTRACT");
  const seal = await readStableFile(path.join(input.bundleRoot, "contract-manifest.sha256"), {
    code: "QUALITY_RUN_CONTRACT_SEAL",
    maximum: 256,
  });
  if (!seal.bytes.equals(Buffer.from(`${input.expectedContractSha256}  contract-manifest.json\n`, "ascii"))) {
    fail("QUALITY_RUN_CONTRACT_SEAL");
  }

  const contractEntries = new Map();
  let previousPath;
  for (const entry of contract.value.entries) {
    exactKeys(entry, ["path", "sha256", "size_bytes"], "QUALITY_RUN_CONTRACT");
    assertBundleRelativePath(entry.path, "QUALITY_RUN_CONTRACT");
    assertDigest(entry.sha256, "QUALITY_RUN_CONTRACT");
    parsePositiveSize(entry.size_bytes, "QUALITY_RUN_CONTRACT");
    if (contractEntries.has(entry.path) || (previousPath !== undefined && previousPath >= entry.path)) {
      fail("QUALITY_RUN_CONTRACT");
    }
    contractEntries.set(entry.path, entry);
    previousPath = entry.path;
  }

  const [candidate, hardware, runPlan] = await Promise.all([
    readBundleDocument(input.bundleRoot, "manifests/candidate-manifest.json", "QUALITY_RUN_CANDIDATE"),
    readBundleDocument(input.bundleRoot, "manifests/hw-ref.json", "QUALITY_RUN_HARDWARE"),
    readBundleDocument(input.bundleRoot, "manifests/run-plan.json", "QUALITY_RUN_RUN_PLAN"),
  ]);
  for (const [relativePath, document] of [
    ["manifests/candidate-manifest.json", candidate],
    ["manifests/hw-ref.json", hardware],
    ["manifests/run-plan.json", runPlan],
  ]) {
    const entry = contractEntries.get(relativePath);
    if (
      entry === undefined || entry.sha256 !== document.sha256 ||
      parsePositiveSize(entry.size_bytes, "QUALITY_RUN_CONTRACT_JOIN") !== BigInt(document.bytes.length)
    ) fail("QUALITY_RUN_CONTRACT_JOIN");
  }

  if (
    candidate.value.candidate_id !== CANDIDATE_ID ||
    candidate.value.source?.source_revision !== input.expectedSourceCommit ||
    runPlan.value.source_commit !== input.expectedSourceCommit ||
    hardware.sha256 !== input.expectedHardwareEvidenceSha256 ||
    hardware.value.hw_ref_id !== runPlan.value.hw_ref_id
  ) fail("QUALITY_RUN_DIRECT_JOIN");

  const worker = validateArtifactBinding(
    artifactByRole(candidate.value, "worker-executable", "QUALITY_RUN_CANDIDATE_ARTIFACT"),
    contractEntries,
    "QUALITY_RUN_CANDIDATE_ARTIFACT",
  );
  const schemaRegistry = validateArtifactBinding(
    artifactByRole(candidate.value, "schema-registry", "QUALITY_RUN_CANDIDATE_ARTIFACT"),
    contractEntries,
    "QUALITY_RUN_CANDIDATE_ARTIFACT",
  );
  const model = validateArtifactBinding(
    artifactByRole(candidate.value, "model", "QUALITY_RUN_CANDIDATE_ARTIFACT"),
    contractEntries,
    "QUALITY_RUN_CANDIDATE_ARTIFACT",
  );
  const tokens = validateArtifactBinding(
    artifactByRole(candidate.value, "tokens", "QUALITY_RUN_CANDIDATE_ARTIFACT"),
    contractEntries,
    "QUALITY_RUN_CANDIDATE_ARTIFACT",
  );
  const runtime = validateArtifactBinding(
    artifactByRole(candidate.value, "runtime", "QUALITY_RUN_CANDIDATE_ARTIFACT"),
    contractEntries,
    "QUALITY_RUN_CANDIDATE_ARTIFACT",
  );
  const config = validateArtifactBinding(
    artifactByRole(candidate.value, "parameters", "QUALITY_RUN_CANDIDATE_ARTIFACT"),
    contractEntries,
    "QUALITY_RUN_CANDIDATE_ARTIFACT",
  );
  const assetLock = validateArtifactBinding(
    artifactByRole(candidate.value, "model-manifest", "QUALITY_RUN_CANDIDATE_ARTIFACT"),
    contractEntries,
    "QUALITY_RUN_CANDIDATE_ARTIFACT",
  );
  const packageLock = validateArtifactBinding(
    artifactByRole(candidate.value, "package-lock", "QUALITY_RUN_CANDIDATE_ARTIFACT"),
    contractEntries,
    "QUALITY_RUN_CANDIDATE_ARTIFACT",
  );
  const runtimeFiles = candidate.value.artifacts
    .filter((artifact) => typeof artifact?.role === "string" && artifact.role.startsWith("runtime-file-"))
    .map((artifact) => validateArtifactBinding(artifact, contractEntries, "QUALITY_RUN_RUNTIME_ARTIFACT"))
    .sort((left, right) => left.path.localeCompare(right.path, "en"));
  if (runtimeFiles.length !== 7) fail("QUALITY_RUN_RUNTIME_ARTIFACT");
  const runtimeDirectories = new Set(runtimeFiles.map((artifact) => path.posix.dirname(artifact.path)));
  if (runtimeDirectories.size !== 1) fail("QUALITY_RUN_RUNTIME_ARTIFACT");
  const runtimeDirectory = [...runtimeDirectories][0];
  const descriptor = candidate.value.worker_manifest_projection?.descriptor;
  if (
    descriptor === null || typeof descriptor !== "object" || Array.isArray(descriptor) ||
    descriptor.model_sha256 !== model.sha256 || descriptor.package_lock_sha256 !== packageLock.sha256 ||
    descriptor.parameter_sha256 !== config.sha256
  ) {
    fail("QUALITY_RUN_CANDIDATE_DESCRIPTOR");
  }
  assertDigest(descriptor.runtime_sha256, "QUALITY_RUN_CANDIDATE_DESCRIPTOR");

  const snapshotPaths = [
    "contract-manifest.json",
    "contract-manifest.sha256",
    ...contract.value.entries.map((entry) => entry.path),
  ];
  const snapshotFingerprint = [];
  for (const relativePath of snapshotPaths) {
    const absolute = resolveBundlePath(input.bundleRoot, relativePath, "QUALITY_RUN_BUNDLE_SNAPSHOT");
    await assertDirectPathChain(absolute, "file", "QUALITY_RUN_BUNDLE_SNAPSHOT");
    const stat = await lstat(absolute, { bigint: true }).catch((error) => fail("QUALITY_RUN_BUNDLE_SNAPSHOT", { cause: error }));
    if (!stat.isFile() || stat.isSymbolicLink()) fail("QUALITY_RUN_BUNDLE_SNAPSHOT");
    const expected = contractEntries.get(relativePath);
    if (expected !== undefined && stat.size !== parsePositiveSize(expected.size_bytes, "QUALITY_RUN_BUNDLE_SNAPSHOT")) {
      fail("QUALITY_RUN_BUNDLE_SNAPSHOT");
    }
    snapshotFingerprint.push(Object.freeze({ relativePath, snapshot: snapshotProjection(stat) }));
  }

  const componentPaths = Object.freeze({
    assetLockPath: resolveBundlePath(input.bundleRoot, assetLock.path, "QUALITY_RUN_CANDIDATE_PATH"),
    modelPath: resolveBundlePath(input.bundleRoot, model.path, "QUALITY_RUN_CANDIDATE_PATH"),
    packageLockPath: resolveBundlePath(input.bundleRoot, packageLock.path, "QUALITY_RUN_CANDIDATE_PATH"),
    runtimeLibDir: resolveBundlePath(input.bundleRoot, runtimeDirectory, "QUALITY_RUN_CANDIDATE_PATH"),
    schemaRegistryPath: resolveBundlePath(input.bundleRoot, schemaRegistry.path, "QUALITY_RUN_CANDIDATE_PATH"),
    tokensPath: resolveBundlePath(input.bundleRoot, tokens.path, "QUALITY_RUN_CANDIDATE_PATH"),
  });
  for (const key of BUNDLE_COMPONENT_PATH_KEYS) {
    await assertDirectPathChain(
      componentPaths[key],
      key === "runtimeLibDir" ? "directory" : "file",
      "QUALITY_RUN_CANDIDATE_PATH",
    );
  }
  const identity = Object.freeze({
    assetLockSha256: assetLock.sha256,
    baselineExecutionHostSha256: worker.sha256,
    candidateId: candidate.value.candidate_id,
    candidateManifestSha256: candidate.sha256,
    configSha256: config.sha256,
    contractManifestSha256: contract.sha256,
    hardwareEvidenceSha256: hardware.sha256,
    hwRefId: hardware.value.hw_ref_id,
    modelSha256: model.sha256,
    packageLockSha256: packageLock.sha256,
    runPlanSha256: runPlan.sha256,
    runtimeBundleSha256: descriptor.runtime_sha256,
    schemaRegistrySha256: schemaRegistry.sha256,
    sourceCommit: candidate.value.source.source_revision,
    tokensSha256: tokens.sha256,
  });
  return Object.freeze({ componentPaths, identity, snapshotFingerprint: Object.freeze(snapshotFingerprint) });
}

async function readPinnedMeasuredEvidence(input) {
  const material = await readStableFile(input.measuredEvidencePath, {
    code: "QUALITY_RUN_MEASURED_EVIDENCE",
    expectedSha256: input.expectedMeasuredEvidenceSha256,
  });
  let validated;
  try { validated = validateNativeCandidateMeasuredEvidenceRecord(material.bytes); }
  catch (error) { wrap("QUALITY_RUN_MEASURED_EVIDENCE", error); }
  if (validated.evidenceSha256 !== input.expectedMeasuredEvidenceSha256) fail("QUALITY_RUN_MEASURED_EVIDENCE");
  return Object.freeze({ ...validated, path: material.path, snapshot: material.snapshot });
}

async function readPinnedPolicy(input) {
  let official;
  try {
    official = await readPinnedAsrQualityRunPolicy({
      expectedPolicySha256: input.expectedRunPolicySha256,
      policyPath: input.runPolicyPath,
    });
  } catch (error) {
    wrap("QUALITY_RUN_POLICY", error);
  }
  const material = await readStableFile(input.runPolicyPath, {
    code: "QUALITY_RUN_POLICY",
    expectedSha256: input.expectedRunPolicySha256,
  });
  if (official.policySha256 !== sha256(material.bytes)) fail("QUALITY_RUN_POLICY");
  return Object.freeze({ ...official, path: material.path, snapshot: material.snapshot });
}

async function readPinnedScorerProfile(input) {
  const material = await readStableFile(input.scorerProfilePath, {
    code: "QUALITY_RUN_SCORER_PROFILE",
    expectedSha256: input.expectedScorerProfileSha256,
  });
  const profile = parseCanonicalDocument(material.bytes, "QUALITY_RUN_SCORER_PROFILE");
  const runtime = assertAsrScorerRuntimeIdentity();
  const scorer = getAsrScorerProfile();
  if (
    scorer.profile_sha256 !== input.expectedScorerProfileSha256 ||
    scorer.profile_id !== profile.kind || !isDeepStrictEqual(profile.runtime, runtime)
  ) fail("QUALITY_RUN_SCORER_PROFILE");
  return Object.freeze({
    path: material.path,
    profile,
    profileId: scorer.profile_id,
    profileSha256: scorer.profile_sha256,
    snapshot: material.snapshot,
  });
}

function probeReleaseHost(executablePath) {
  return new Promise((resolve, reject) => {
    execFile(executablePath, [], {
      encoding: null,
      maxBuffer: 64 * 1024,
      shell: false,
      timeout: 30_000,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (
        error === null || !Buffer.isBuffer(stdout) || stdout.length !== 0 ||
        !Buffer.isBuffer(stderr) || !stderr.equals(RELEASE_HOST_USAGE)
      ) {
        reject(new NativeCandidateQualityRunnerError("QUALITY_RUN_RELEASE_HOST"));
        return;
      }
      resolve();
    });
  });
}

async function validateReleaseQualityHost(input) {
  const before = await readStableFile(input.qualityHostPath, {
    code: "QUALITY_RUN_RELEASE_HOST",
    expectedSha256: input.expectedQualityHostSha256,
    maximum: MAX_HOST_BYTES,
  });
  await probeReleaseHost(before.path);
  const after = await readStableFile(input.qualityHostPath, {
    code: "QUALITY_RUN_RELEASE_HOST",
    expectedSha256: input.expectedQualityHostSha256,
    maximum: MAX_HOST_BYTES,
  });
  if (!sameSnapshot(before.snapshot, after.snapshot) || !before.bytes.equals(after.bytes)) {
    fail("QUALITY_RUN_RELEASE_HOST_CHANGED");
  }
  return Object.freeze({ executableSha256: input.expectedQualityHostSha256, path: after.path, snapshot: after.snapshot });
}

function corpusComparable(corpus) {
  if (
    corpus === null || typeof corpus !== "object" || !Array.isArray(corpus.samples) ||
    corpus.samples.length < 1 || corpus.samples.length > MAX_SAMPLES
  ) fail("QUALITY_RUN_CORPUS");
  assertDigest(corpus.manifestSha256, "QUALITY_RUN_CORPUS");
  assertDigest(corpus.snapshotSha256, "QUALITY_RUN_CORPUS");
  assertDate(corpus.validationDate, "QUALITY_RUN_CORPUS");
  return Object.freeze({
    manifestSha256: corpus.manifestSha256,
    samples: Object.freeze(corpus.samples.map((sample) => Object.freeze({
      durationSamples: sample.durationSamples,
      language: sample.language,
      leakageGroupId: sample.leakageGroupId,
      pcmSha256: sample.pcmSha256,
      referenceSha256: sample.referenceSha256,
      sampleId: sample.sampleId,
      sampleRateHz: sample.sampleRateHz,
      scenario: sample.scenario,
      split: sample.split,
      tier: sample.tier,
      wavSha256: sample.wavSha256,
      wavSizeBytes: sample.wavSizeBytes,
    }))),
    snapshotSha256: corpus.snapshotSha256,
    validationDate: corpus.validationDate,
  });
}

async function captureCorpusSnapshot(input, materialized) {
  const manifest = await readStableFile(input.corpusInput.manifestPath, {
    code: "QUALITY_RUN_CORPUS_SNAPSHOT",
    expectedSha256: input.corpusInput.expectedManifestSha256,
  });
  const value = parseCanonicalDocument(manifest.bytes, "QUALITY_RUN_CORPUS_SNAPSHOT");
  const relativePaths = new Set();
  for (const sample of value.samples ?? []) {
    for (const relativePath of [
      sample?.wav?.path,
      sample?.reference?.path,
      sample?.rights?.license?.path,
      sample?.rights?.consent?.record_path,
    ]) {
      if (relativePath !== null && relativePath !== undefined) relativePaths.add(relativePath);
    }
  }
  const token = [{ path: manifest.path, snapshot: snapshotProjection(manifest.snapshot) }];
  for (const relativePath of [...relativePaths].sort()) {
    const absolute = resolveBundlePath(input.corpusInput.corpusRoot, relativePath, "QUALITY_RUN_CORPUS_SNAPSHOT");
    await assertDirectPathChain(absolute, "file", "QUALITY_RUN_CORPUS_SNAPSHOT");
    const stat = await lstat(absolute, { bigint: true }).catch((error) => fail("QUALITY_RUN_CORPUS_SNAPSHOT", { cause: error }));
    if (!stat.isFile() || stat.isSymbolicLink()) fail("QUALITY_RUN_CORPUS_SNAPSHOT");
    token.push({ path: absolute, snapshot: snapshotProjection(stat) });
  }
  return Object.freeze({
    materialized,
    revalidationToken: Object.freeze(token.map((entry) => Object.freeze(entry))),
  });
}

async function loadCorpusState(input) {
  let materialized;
  try { materialized = await materializeQualityCorpus(input.corpusInput); }
  catch (error) { wrap("QUALITY_RUN_CORPUS", error); }
  return captureCorpusSnapshot(input, materialized);
}

function normalizeCorpusState(value) {
  const wrapped = value !== null && typeof value === "object" && value.materialized !== undefined;
  const materialized = wrapped ? value.materialized : value;
  const comparable = corpusComparable(materialized);
  return Object.freeze({
    comparable,
    materialized,
    revalidationToken: wrapped ? value.revalidationToken : comparable,
  });
}

function optionalSnapshot(value) {
  return value?.snapshot ?? null;
}

function normalizeBundleState(value, input) {
  const identity = value?.identity ?? value;
  if (identity === null || typeof identity !== "object" || Array.isArray(identity)) {
    fail("QUALITY_RUN_BUNDLE");
  }
  for (const key of [
    "assetLockSha256", "baselineExecutionHostSha256", "candidateManifestSha256",
    "configSha256", "contractManifestSha256", "modelSha256", "packageLockSha256",
    "runtimeBundleSha256", "schemaRegistrySha256", "tokensSha256",
  ]) assertDigest(identity[key], "QUALITY_RUN_BUNDLE");
  if (identity.candidateId !== CANDIDATE_ID || identity.sourceCommit !== input.expectedSourceCommit) {
    fail("QUALITY_RUN_BUNDLE");
  }
  const componentPaths = value?.componentPaths ?? Object.freeze({
    assetLockPath: path.join(input.bundleRoot, "assets", "assets.lock.json"),
    modelPath: path.join(input.bundleRoot, "assets", "model.int8.onnx"),
    packageLockPath: path.join(input.bundleRoot, "assets", "Cargo.lock"),
    runtimeLibDir: path.join(input.bundleRoot, "assets", "runtime", "lib"),
    schemaRegistryPath: path.join(input.bundleRoot, "assets", "candidate-schema-registry.json"),
    tokensPath: path.join(input.bundleRoot, "assets", "tokens.txt"),
  });
  exactKeys(componentPaths, BUNDLE_COMPONENT_PATH_KEYS, "QUALITY_RUN_BUNDLE_PATHS");
  return Object.freeze({
    comparable: Object.freeze({ ...identity }),
    componentPaths: Object.freeze({ ...componentPaths }),
    revalidationToken: value?.snapshotFingerprint ?? identity,
  });
}

function normalizeMeasuredState(value, input) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("QUALITY_RUN_MEASURED_EVIDENCE");
  }
  if (value.evidenceSha256 !== input.expectedMeasuredEvidenceSha256) {
    fail("QUALITY_RUN_MEASURED_EVIDENCE");
  }
  const identity = value.record?.input_identity;
  if (identity === null || typeof identity !== "object" || Array.isArray(identity)) {
    fail("QUALITY_RUN_MEASURED_EVIDENCE");
  }
  for (const key of [
    "config_sha256", "contract_manifest_sha256", "execution_host_sha256",
    "measured_hardware_reference_sha256", "model_sha256", "operator_facts_sha256",
    "run_plan_sha256",
  ]) assertDigest(identity[key], "QUALITY_RUN_MEASURED_EVIDENCE");
  assertIdentifier(identity.hw_ref_id, "QUALITY_RUN_MEASURED_EVIDENCE");
  assertCommit(identity.source_commit, "QUALITY_RUN_MEASURED_EVIDENCE");
  return Object.freeze({
    comparable: Object.freeze({
      contractManifestSha256: identity.contract_manifest_sha256,
      evidenceSha256: value.evidenceSha256,
      executionHostSha256: identity.execution_host_sha256,
      hardwareEvidenceSha256: identity.measured_hardware_reference_sha256,
      hwRefId: identity.hw_ref_id,
      modelSha256: identity.model_sha256,
      operatorFactsSha256: identity.operator_facts_sha256,
      configSha256: identity.config_sha256,
      runPlanSha256: identity.run_plan_sha256,
      runtimeBundleSha256: identity.runtime_bundle_sha256,
      schemaRegistrySha256: identity.schema_registry_sha256,
      sourceCommit: identity.source_commit,
    }),
    revalidationToken: optionalSnapshot(value) ?? value.evidenceSha256,
    validated: value,
  });
}

function normalizePolicyState(value, input) {
  if (value?.policySha256 !== input.expectedRunPolicySha256 || value.policy === undefined) {
    fail("QUALITY_RUN_POLICY");
  }
  return Object.freeze({
    comparable: Object.freeze({ policy: structuredClone(value.policy), policySha256: value.policySha256 }),
    revalidationToken: optionalSnapshot(value) ?? value.policySha256,
  });
}

function normalizeScorerState(value, input) {
  if (
    value?.profileSha256 !== input.expectedScorerProfileSha256 ||
    typeof value.profileId !== "string" || value.profileId.length === 0
  ) fail("QUALITY_RUN_SCORER_PROFILE");
  return Object.freeze({
    comparable: Object.freeze({ profileId: value.profileId, profileSha256: value.profileSha256 }),
    revalidationToken: optionalSnapshot(value) ?? value.profileSha256,
  });
}

function normalizeHostState(value, input) {
  if (value?.executableSha256 !== input.expectedQualityHostSha256) fail("QUALITY_RUN_RELEASE_HOST");
  return Object.freeze({
    comparable: Object.freeze({
      executableSha256: value.executableSha256,
      schemaRegistrySha256: value.schemaRegistrySha256,
    }),
    revalidationToken: optionalSnapshot(value) ?? value.executableSha256,
  });
}

function assertStateUnchanged(before, after, code) {
  if (
    !isDeepStrictEqual(before.comparable, after.comparable) ||
    !isDeepStrictEqual(before.revalidationToken, after.revalidationToken)
  ) fail(code);
}

function validateExternalJoins(input, state) {
  const bundle = state.bundle.comparable;
  const measured = state.measured.comparable;
  const host = state.host.comparable;
  if (
    bundle.contractManifestSha256 !== input.expectedContractSha256 ||
    measured.contractManifestSha256 !== input.expectedContractSha256 ||
    measured.hardwareEvidenceSha256 !== input.expectedHardwareEvidenceSha256 ||
    measured.sourceCommit !== input.expectedSourceCommit ||
    bundle.sourceCommit !== input.expectedSourceCommit ||
    measured.modelSha256 !== bundle.modelSha256 ||
    measured.configSha256 !== bundle.configSha256 ||
    (measured.runtimeBundleSha256 !== undefined && measured.runtimeBundleSha256 !== bundle.runtimeBundleSha256) ||
    (measured.schemaRegistrySha256 !== undefined && measured.schemaRegistrySha256 !== bundle.schemaRegistrySha256) ||
    (measured.runPlanSha256 !== undefined && bundle.runPlanSha256 !== undefined &&
      measured.runPlanSha256 !== bundle.runPlanSha256) ||
    (bundle.hardwareEvidenceSha256 !== undefined && bundle.hardwareEvidenceSha256 !== input.expectedHardwareEvidenceSha256) ||
    (bundle.hwRefId !== undefined && bundle.hwRefId !== measured.hwRefId) ||
    host.executableSha256 !== input.expectedQualityHostSha256 ||
    (host.schemaRegistrySha256 !== undefined && host.schemaRegistrySha256 !== bundle.schemaRegistrySha256)
  ) fail("QUALITY_RUN_DIRECT_JOIN");
  const expectedBaseline = bundle.executionHostSha256 ?? bundle.baselineExecutionHostSha256;
  if (measured.executionHostSha256 !== expectedBaseline) fail("QUALITY_RUN_DIRECT_JOIN");
}

async function loadExternalState(input, dependencies) {
  const [bundleValue, measuredValue, policyValue, scorerValue, hostValue, corpusValue] = await Promise.all([
    dependencies.bundleInspector(input),
    dependencies.measuredEvidenceReader(input),
    dependencies.policyReader(input),
    dependencies.scorerProfileReader(input),
    dependencies.releaseHostValidator(input),
    dependencies.corpusLoader(input),
  ]).catch((error) => wrap("QUALITY_RUN_INPUT_STATE", error));
  const state = Object.freeze({
    bundle: normalizeBundleState(bundleValue, input),
    corpus: normalizeCorpusState(corpusValue),
    host: normalizeHostState(hostValue, input),
    measured: normalizeMeasuredState(measuredValue, input),
    policy: normalizePolicyState(policyValue, input),
    scorer: normalizeScorerState(scorerValue, input),
  });
  validateExternalJoins(input, state);
  try {
    dependencies.validateCoverage(state.policy.comparable.policy, state.corpus.materialized);
  } catch {
    fail("QUALITY_RUN_COVERAGE");
  }
  return state;
}

function assertExternalStateUnchanged(before, after) {
  for (const key of ["bundle", "corpus", "host", "measured", "policy", "scorer"]) {
    assertStateUnchanged(before[key], after[key], `QUALITY_RUN_${key.toUpperCase()}_CHANGED`);
  }
}

function buildCandidateJoin(state, input) {
  const bundle = state.bundle.comparable;
  return Object.freeze({
    baselineExecutionHost: Object.freeze({
      executable_sha256: bundle.baselineExecutionHostSha256,
      schema_registry_sha256: bundle.schemaRegistrySha256,
    }),
    candidate: Object.freeze({
      asset_lock_sha256: bundle.assetLockSha256,
      candidate_id: CANDIDATE_ID,
      model_sha256: bundle.modelSha256,
      package_lock_sha256: bundle.packageLockSha256,
      parameter_sha256: bundle.configSha256,
      runtime_bundle_sha256: bundle.runtimeBundleSha256,
      tokens_sha256: bundle.tokensSha256,
    }),
    candidateManifestSha256: bundle.candidateManifestSha256,
    executionHost: Object.freeze({
      executable_sha256: input.expectedQualityHostSha256,
      schema_registry_sha256: bundle.schemaRegistrySha256,
    }),
    measuredEvidenceSha256: input.expectedMeasuredEvidenceSha256,
  });
}

function componentInputFor(input, state) {
  return Object.freeze({
    ...state.bundle.componentPaths,
    corpusInput: input.corpusInput,
    executablePath: input.qualityHostPath,
    outputEvidencePath: input.componentEvidencePath,
  });
}

function validatePrivateTranscriptEntry(entry) {
  const keys = [
    "attempt", "componentRecordSha256", "finalTranscript", "finalTranscriptSha256",
    "finalTranscriptUtf8Bytes", "language", "sampleId", "sampleIdentitySha256",
    "scenario", "sequence", "split", "tier",
  ];
  exactKeys(entry, keys, "QUALITY_RUN_TRANSCRIPT");
  if (
    entry.attempt !== 1 || !Number.isSafeInteger(entry.sequence) || entry.sequence < 1 ||
    typeof entry.finalTranscript !== "string" || entry.finalTranscript.includes("\0")
  ) fail("QUALITY_RUN_TRANSCRIPT");
  for (const key of ["componentRecordSha256", "finalTranscriptSha256", "sampleIdentitySha256"]) {
    assertDigest(entry[key], "QUALITY_RUN_TRANSCRIPT");
  }
  assertIdentifier(entry.sampleId, "QUALITY_RUN_TRANSCRIPT");
  assertIdentifier(entry.scenario, "QUALITY_RUN_TRANSCRIPT");
  const transcriptBytes = Buffer.from(entry.finalTranscript, "utf8");
  if (
    transcriptBytes.toString("utf8") !== entry.finalTranscript || transcriptBytes.length > 16_384 ||
    entry.finalTranscriptSha256 !== sha256(transcriptBytes) ||
    entry.finalTranscriptUtf8Bytes !== String(transcriptBytes.length) ||
    !["en", "ja", "zh"].includes(entry.language) ||
    !["blind", "calibration", "dev"].includes(entry.split) || entry.tier !== "tier-1"
  ) fail("QUALITY_RUN_TRANSCRIPT");
  return Object.freeze({ ...entry });
}

function validateComponentResult(component, state, input, privateEntries) {
  if (component === null || typeof component !== "object" || Array.isArray(component)) {
    fail("QUALITY_RUN_COMPONENT");
  }
  assertDigest(component.evidenceSha256, "QUALITY_RUN_COMPONENT");
  const record = component.record;
  if (
    record?.kind !== "meetingrelay-native-candidate-component-evidence-v1" ||
    record.schema_version !== "1.0" || record.authority?.formal_claims !== "none" ||
    record.authority?.production_evidence !== false ||
    record.assessment_status?.quality_status !== "not-assessed" ||
    record.assessment_status?.threshold_status !== "not-frozen" || !Array.isArray(record.results)
  ) fail("QUALITY_RUN_COMPONENT");
  const bundle = state.bundle.comparable;
  const expectedCandidate = buildCandidateJoin(state, input);
  const candidateIdentity = record.candidate_identity;
  if (
    candidateIdentity?.candidate_id !== CANDIDATE_ID ||
    candidateIdentity.asset_lock_sha256 !== bundle.assetLockSha256 ||
    candidateIdentity.model_sha256 !== bundle.modelSha256 ||
    candidateIdentity.package_lock_sha256 !== bundle.packageLockSha256 ||
    candidateIdentity.parameter_sha256 !== bundle.configSha256 ||
    candidateIdentity.runtime_bundle_sha256 !== bundle.runtimeBundleSha256 ||
    candidateIdentity.tokens_sha256 !== bundle.tokensSha256 ||
    candidateIdentity.candidate_manifest_sha256 !== bundle.candidateManifestSha256 ||
    candidateIdentity.measured_evidence_sha256 !== input.expectedMeasuredEvidenceSha256 ||
    !isDeepStrictEqual(candidateIdentity.baseline_execution_host, expectedCandidate.baselineExecutionHost) ||
    !isDeepStrictEqual(record.execution_host_identity, expectedCandidate.executionHost)
  ) fail("QUALITY_RUN_COMPONENT_JOIN");
  const corpus = state.corpus.comparable;
  if (
    record.corpus_identity?.manifest_sha256 !== corpus.manifestSha256 ||
    record.corpus_identity?.snapshot_sha256 !== corpus.snapshotSha256 ||
    record.corpus_identity?.validation_date !== corpus.validationDate ||
    record.corpus_identity?.sample_count !== corpus.samples.length ||
    record.results.length !== corpus.samples.length || privateEntries.length !== corpus.samples.length
  ) fail("QUALITY_RUN_COMPONENT_JOIN");

  const ledgerEntries = [];
  let previousSampleId;
  for (let index = 0; index < corpus.samples.length; index += 1) {
    const sample = corpus.samples[index];
    const result = record.results[index];
    const privateEntry = privateEntries[index];
    if (
      privateEntry === undefined || result === undefined || result.sequence !== index + 1 ||
      privateEntry.sequence !== index + 1 || result.attempt !== 1 || privateEntry.attempt !== 1 ||
      sample.sampleId !== result.sample_id || sample.sampleId !== privateEntry.sampleId ||
      (previousSampleId !== undefined && previousSampleId >= sample.sampleId) ||
      result.language !== sample.language || privateEntry.language !== sample.language ||
      result.scenario !== sample.scenario || privateEntry.scenario !== sample.scenario ||
      result.split !== sample.split || privateEntry.split !== sample.split ||
      result.tier !== sample.tier || privateEntry.tier !== sample.tier ||
      result.host_record_sha256 !== privateEntry.componentRecordSha256 ||
      result.final_transcript_sha256 !== privateEntry.finalTranscriptSha256 ||
      result.final_transcript_utf8_bytes !== privateEntry.finalTranscriptUtf8Bytes ||
      result.sample_identity_sha256 !== privateEntry.sampleIdentitySha256
    ) fail("QUALITY_RUN_TRANSCRIPT_JOIN");
    previousSampleId = sample.sampleId;
    ledgerEntries.push({
      attempt: 1,
      component_record_sha256: privateEntry.componentRecordSha256,
      final_transcript: privateEntry.finalTranscript,
      final_transcript_sha256: privateEntry.finalTranscriptSha256,
      final_transcript_utf8_bytes: privateEntry.finalTranscriptUtf8Bytes,
      language: privateEntry.language,
      sample_id: privateEntry.sampleId,
      sample_identity_sha256: privateEntry.sampleIdentitySha256,
      scenario: privateEntry.scenario,
      sequence: privateEntry.sequence,
      split: privateEntry.split,
      tier: privateEntry.tier,
    });
  }
  return Object.freeze({ evidenceSha256: component.evidenceSha256, ledgerEntries, record });
}

function buildFinalCandidateIdentity(state, input) {
  const bundle = state.bundle.comparable;
  return Object.freeze({
    asset_lock_sha256: bundle.assetLockSha256,
    baseline_execution_host_sha256: bundle.baselineExecutionHostSha256,
    candidate_id: CANDIDATE_ID,
    candidate_manifest_sha256: bundle.candidateManifestSha256,
    config_sha256: bundle.configSha256,
    contract_manifest_sha256: input.expectedContractSha256,
    execution_host_sha256: input.expectedQualityHostSha256,
    measured_evidence_sha256: input.expectedMeasuredEvidenceSha256,
    model_sha256: bundle.modelSha256,
    package_lock_sha256: bundle.packageLockSha256,
    runtime_bundle_sha256: bundle.runtimeBundleSha256,
    schema_registry_sha256: bundle.schemaRegistrySha256,
    tokens_sha256: bundle.tokensSha256,
  });
}

function canonicalIdentitySha256(value) {
  return sha256(Buffer.from(encodeCanonicalJsonLine(value), "utf8"));
}

function buildLedgerJoins(candidateIdentity, state, input) {
  return Object.freeze({
    candidate_identity_sha256: canonicalIdentitySha256(candidateIdentity),
    corpus_manifest_sha256: state.corpus.comparable.manifestSha256,
    corpus_snapshot_sha256: state.corpus.comparable.snapshotSha256,
    execution_host_sha256: input.expectedQualityHostSha256,
    hardware_evidence_sha256: input.expectedHardwareEvidenceSha256,
    scorer_manifest_sha256: input.expectedScorerProfileSha256,
    scorer_profile_sha256: input.expectedScorerProfileSha256,
    source_commit: input.expectedSourceCommit,
    source_evidence_sha256: input.expectedMeasuredEvidenceSha256,
  });
}

function validateFinalCandidateIdentity(value) {
  exactKeys(value, CANDIDATE_IDENTITY_KEYS, "QUALITY_EVIDENCE_CANDIDATE");
  if (value.candidate_id !== CANDIDATE_ID) fail("QUALITY_EVIDENCE_CANDIDATE");
  for (const key of CANDIDATE_IDENTITY_KEYS.filter((key) => key.endsWith("sha256"))) {
    assertDigest(value[key], "QUALITY_EVIDENCE_CANDIDATE");
  }
}

function validateFinalEvidenceRecordObject(record) {
  exactKeys(record, ROOT_KEYS, "QUALITY_EVIDENCE_FIELDS");
  exactKeys(record.authority, Object.keys(AUTHORITY), "QUALITY_EVIDENCE_AUTHORITY");
  if (!isDeepStrictEqual(record.authority, AUTHORITY)) fail("QUALITY_EVIDENCE_AUTHORITY");
  if (
    record.kind !== KIND || record.schema_version !== SCHEMA_VERSION ||
    record.measurement_status !== MEASUREMENT_STATUS ||
    record.quality_gate_status !== QUALITY_GATE_STATUS
  ) fail("QUALITY_EVIDENCE_SCOPE");

  validateFinalCandidateIdentity(record.candidate_identity);
  exactKeys(record.component_evidence, COMPONENT_IDENTITY_KEYS, "QUALITY_EVIDENCE_COMPONENT");
  assertDigest(record.component_evidence.sha256, "QUALITY_EVIDENCE_COMPONENT");
  assertCount(record.component_evidence.sample_count, "QUALITY_EVIDENCE_COMPONENT");

  exactKeys(record.corpus_identity, CORPUS_IDENTITY_KEYS, "QUALITY_EVIDENCE_CORPUS");
  assertDigest(record.corpus_identity.manifest_sha256, "QUALITY_EVIDENCE_CORPUS");
  assertDigest(record.corpus_identity.snapshot_sha256, "QUALITY_EVIDENCE_CORPUS");
  assertDate(record.corpus_identity.validation_date, "QUALITY_EVIDENCE_CORPUS");
  assertCount(record.corpus_identity.sample_count, "QUALITY_EVIDENCE_CORPUS");
  assertCount(record.corpus_identity.slice_count, "QUALITY_EVIDENCE_CORPUS");

  exactKeys(record.hardware_identity, HARDWARE_IDENTITY_KEYS, "QUALITY_EVIDENCE_HARDWARE");
  assertDigest(record.hardware_identity.evidence_sha256, "QUALITY_EVIDENCE_HARDWARE");
  assertDigest(record.hardware_identity.operator_facts_sha256, "QUALITY_EVIDENCE_HARDWARE");
  assertIdentifier(record.hardware_identity.hw_ref_id, "QUALITY_EVIDENCE_HARDWARE");

  exactKeys(record.ledger_identity, LEDGER_IDENTITY_KEYS, "QUALITY_EVIDENCE_LEDGER");
  for (const key of LEDGER_IDENTITY_KEYS.filter((key) => key.endsWith("sha256"))) {
    assertDigest(record.ledger_identity[key], "QUALITY_EVIDENCE_LEDGER");
  }
  assertCount(record.ledger_identity.entry_count, "QUALITY_EVIDENCE_LEDGER");
  if (
    record.ledger_identity.candidate_identity_sha256 !==
      canonicalIdentitySha256(record.candidate_identity)
  ) fail("QUALITY_EVIDENCE_LEDGER");

  exactKeys(record.run_policy_identity, POLICY_IDENTITY_KEYS, "QUALITY_EVIDENCE_POLICY");
  assertDigest(record.run_policy_identity.sha256, "QUALITY_EVIDENCE_POLICY");
  if (
    record.run_policy_identity.coverage_scope !== "synthetic-mechanics-only" ||
    record.run_policy_identity.exclusion_policy !== "none" ||
    record.run_policy_identity.max_attempts !== 1
  ) fail("QUALITY_EVIDENCE_POLICY");

  exactKeys(record.scorer_identity, SCORER_IDENTITY_KEYS, "QUALITY_EVIDENCE_SCORER");
  assertDigest(record.scorer_identity.profile_sha256, "QUALITY_EVIDENCE_SCORER");
  if (record.scorer_identity.profile_id !== "meetingrelay-asr-scorer-profile-v1") {
    fail("QUALITY_EVIDENCE_SCORER");
  }
  exactKeys(record.source_identity, SOURCE_IDENTITY_KEYS, "QUALITY_EVIDENCE_SOURCE");
  assertCommit(record.source_identity.commit, "QUALITY_EVIDENCE_SOURCE");
  assertDigest(record.source_identity.evidence_sha256, "QUALITY_EVIDENCE_SOURCE");

  if (!Array.isArray(record.scores) || record.scores.length < 1 || record.scores.length > MAX_SAMPLES) {
    fail("QUALITY_EVIDENCE_SCORES");
  }
  let previousSampleId;
  for (const score of record.scores) {
    assertIdentifier(score?.sampleId, "QUALITY_EVIDENCE_SCORES");
    if (previousSampleId !== undefined && previousSampleId >= score.sampleId) {
      fail("QUALITY_EVIDENCE_SCORES");
    }
    previousSampleId = score.sampleId;
  }
  try { validateDescriptiveAsrAggregate(record.aggregate, record.scores); }
  catch { fail("QUALITY_EVIDENCE_AGGREGATE"); }
  const scorerIdentity = {
    profile_id: record.scorer_identity.profile_id,
    profile_sha256: record.scorer_identity.profile_sha256,
  };
  if (
    !isDeepStrictEqual(record.aggregate.scorer_profile, scorerIdentity) ||
    record.scores.some((score) => !isDeepStrictEqual(score.scorerProfile, scorerIdentity))
  ) fail("QUALITY_EVIDENCE_SCORER_JOIN");
  const observedSlices = new Set(
    record.scores.map((score) => `${score.language}\0${score.scenario}\0${score.tier}`),
  );
  if (
    record.source_identity.evidence_sha256 !== record.candidate_identity.measured_evidence_sha256
  ) fail("QUALITY_EVIDENCE_SOURCE_JOIN");
  const count = record.scores.length;
  if (
    record.component_evidence.sample_count !== count ||
    record.corpus_identity.sample_count !== count ||
    record.corpus_identity.slice_count !== observedSlices.size ||
    record.ledger_identity.entry_count !== count || record.aggregate.sample_count !== count
  ) fail("QUALITY_EVIDENCE_COUNT_JOIN");
}

export function validateNativeCandidateQualityEvidenceRecord(bytes) {
  const record = parseCanonicalLine(bytes, "QUALITY_EVIDENCE_CANONICAL");
  validateFinalEvidenceRecordObject(record);
  return { evidenceSha256: sha256(bytes), record };
}

async function revalidateStableMaterial(material, { code, expectedSha256, maximum }) {
  const current = await readStableFile(material.path, { code, expectedSha256, maximum });
  if (!sameSnapshot(material.snapshot, current.snapshot) || !material.bytes.equals(current.bytes)) fail(code);
  return current;
}

async function inspectOutputParent(parentPath, code) {
  await assertDirectPathChain(parentPath, "directory", code);
  const snapshot = await lstat(parentPath, { bigint: true }).catch((error) => fail(code, { cause: error }));
  if (!snapshot.isDirectory() || snapshot.isSymbolicLink()) fail(code);
  return Object.freeze({ path: parentPath, snapshot });
}

async function revalidateOutputParent(material, allowMetadataChange, code) {
  const current = await inspectOutputParent(material.path, code);
  if (
    !sameIdentity(material.snapshot, current.snapshot) ||
    (!allowMetadataChange && !sameSnapshot(material.snapshot, current.snapshot))
  ) fail(code);
  return current;
}

async function inspectHardLinkPair(stagingPath, outputPath, code) {
  const [staging, output] = await Promise.all([
    lstat(stagingPath, { bigint: true }), lstat(outputPath, { bigint: true }),
  ]).catch((error) => fail(code, { cause: error }));
  if (
    !staging.isFile() || staging.isSymbolicLink() || !output.isFile() || output.isSymbolicLink() ||
    !sameSnapshot(staging, output)
  ) fail(code);
  return { output, staging };
}

async function assertOutputAbsent(outputPath, code) {
  try { await lstat(outputPath, { bigint: true }); }
  catch (error) {
    if (error?.code === "ENOENT") return;
    fail(code, { cause: error });
  }
  fail(code);
}

export async function publishNativeCandidateQualityEvidence(outputPath, bytes, operations = {}) {
  const expectedBytes = Buffer.isBuffer(bytes) ? Buffer.from(bytes) : bytes;
  validateNativeCandidateQualityEvidenceRecord(expectedBytes);
  const resolved = await assertNewAbsoluteOutput(outputPath, "QUALITY_EVIDENCE_OUTPUT");
  let parent = await inspectOutputParent(path.dirname(resolved), "QUALITY_EVIDENCE_OUTPUT_PARENT");
  const suffix = (operations.randomSuffix ?? (() => randomBytes(16).toString("hex")))();
  if (typeof suffix !== "string" || !/^[0-9a-f]{32}$/u.test(suffix)) fail("QUALITY_EVIDENCE_OUTPUT");
  const stagingPath = path.join(path.dirname(resolved), `.${path.basename(resolved)}.${suffix}.staging`);
  const openFile = operations.openFile ?? open;
  const linkFile = operations.linkFile ?? link;
  const readFileBytes = operations.readFileBytes ?? readFile;
  const beforeLink = operations.beforeLink ?? (async () => {});
  const afterLinkBeforeRead = operations.afterLinkBeforeRead ?? (async () => {});
  const afterPersistedRead = operations.afterPersistedRead ?? (async () => {});
  let handle;
  let ownedIdentity;
  let completed = false;
  let failure = false;
  try {
    parent = await revalidateOutputParent(parent, false, "QUALITY_EVIDENCE_OUTPUT_PARENT");
    handle = await openFile(stagingPath, "wx", 0o600);
    ownedIdentity = await handle.stat({ bigint: true });
    if (!ownedIdentity.isFile() || ownedIdentity.size !== 0n) fail("QUALITY_EVIDENCE_STAGING");
    parent = await revalidateOutputParent(parent, true, "QUALITY_EVIDENCE_OUTPUT_PARENT");
    await handle.writeFile(expectedBytes);
    await handle.sync();
    const stagedHandle = await handle.stat({ bigint: true });
    if (!sameIdentity(ownedIdentity, stagedHandle) || stagedHandle.size !== BigInt(expectedBytes.length)) {
      fail("QUALITY_EVIDENCE_STAGING");
    }
    await handle.close();
    handle = undefined;
    parent = await revalidateOutputParent(parent, false, "QUALITY_EVIDENCE_OUTPUT_PARENT");
    const stagedRead = await readFileBytes(stagingPath);
    const stagedMaterial = await readStableFile(stagingPath, {
      code: "QUALITY_EVIDENCE_STAGING",
      expectedSha256: sha256(expectedBytes),
      maximum: MAX_FINAL_BYTES,
    });
    if (
      !Buffer.isBuffer(stagedRead) || !stagedRead.equals(expectedBytes) ||
      !stagedMaterial.bytes.equals(expectedBytes) || !sameSnapshot(stagedHandle, stagedMaterial.snapshot)
    ) fail("QUALITY_EVIDENCE_STAGING");
    validateNativeCandidateQualityEvidenceRecord(stagedMaterial.bytes);
    await beforeLink({ outputPath: resolved, stagingPath });
    parent = await revalidateOutputParent(parent, false, "QUALITY_EVIDENCE_OUTPUT_PARENT");
    await assertOutputAbsent(resolved, "QUALITY_EVIDENCE_OUTPUT");
    await linkFile(stagingPath, resolved);
    parent = await revalidateOutputParent(parent, true, "QUALITY_EVIDENCE_OUTPUT_PARENT");
    let pair = await inspectHardLinkPair(stagingPath, resolved, "QUALITY_EVIDENCE_LINK_IDENTITY");
    if (!sameIdentity(ownedIdentity, pair.staging)) fail("QUALITY_EVIDENCE_LINK_IDENTITY");
    await afterLinkBeforeRead({ outputPath: resolved, stagingPath });
    parent = await revalidateOutputParent(parent, false, "QUALITY_EVIDENCE_OUTPUT_PARENT");
    pair = await inspectHardLinkPair(stagingPath, resolved, "QUALITY_EVIDENCE_PERSISTED_IDENTITY");
    const persistedRead = await readFileBytes(resolved);
    const persisted = await readStableFile(resolved, {
      code: "QUALITY_EVIDENCE_PERSISTED",
      expectedSha256: sha256(expectedBytes),
      maximum: MAX_FINAL_BYTES,
    });
    const afterPair = await inspectHardLinkPair(stagingPath, resolved, "QUALITY_EVIDENCE_PERSISTED_IDENTITY");
    if (
      !sameSnapshot(pair.staging, afterPair.staging) || !sameSnapshot(pair.output, afterPair.output) ||
      !sameSnapshot(persisted.snapshot, afterPair.output) || !Buffer.isBuffer(persistedRead) ||
      !persistedRead.equals(expectedBytes) || !persisted.bytes.equals(expectedBytes)
    ) fail("QUALITY_EVIDENCE_PERSISTED");
    validateNativeCandidateQualityEvidenceRecord(persisted.bytes);
    await afterPersistedRead({ outputPath: resolved, stagingPath });
    parent = await revalidateOutputParent(parent, false, "QUALITY_EVIDENCE_OUTPUT_PARENT");
    const finalPair = await inspectHardLinkPair(stagingPath, resolved, "QUALITY_EVIDENCE_FINAL_IDENTITY");
    const finalMaterial = await readStableFile(resolved, {
      code: "QUALITY_EVIDENCE_FINAL_IDENTITY",
      expectedSha256: sha256(expectedBytes),
      maximum: MAX_FINAL_BYTES,
    });
    if (
      !sameIdentity(ownedIdentity, finalPair.staging) ||
      !sameSnapshot(finalPair.output, finalMaterial.snapshot) || !finalMaterial.bytes.equals(expectedBytes)
    ) fail("QUALITY_EVIDENCE_FINAL_IDENTITY");
    completed = true;
  } catch {
    failure = true;
  } finally {
    if (handle !== undefined) {
      try { await handle.close(); } catch { failure = true; }
    }
  }
  // Never pathname-unlink staging or final output here. A failure after the
  // create-new link is deliberately represented by retained audit residue.
  if (failure || !completed) fail("QUALITY_EVIDENCE_OUTPUT");
  return resolved;
}

export async function validateNativeCandidateQualityEvidenceFile(inputPath) {
  const material = await readStableFile(inputPath, {
    code: "QUALITY_EVIDENCE_INPUT",
    maximum: MAX_FINAL_BYTES,
  });
  return { bytes: material.bytes, ...validateNativeCandidateQualityEvidenceRecord(material.bytes) };
}

function normalizeDependencies(dependencies) {
  const resolved = {
    ...PRODUCTION_DEPENDENCIES,
    ...dependencies,
    hooks: dependencies?.hooks ?? PRODUCTION_DEPENDENCIES.hooks,
  };
  for (const key of [
    "aggregateScores", "bundleInspector", "componentEvidenceReader", "componentRunner",
    "corpusLoader", "finalEvidencePublisher", "finalEvidenceReader", "ledgerBuilder",
    "ledgerPublisher", "ledgerReader", "measuredEvidenceReader", "policyReader",
    "releaseHostValidator", "scoreTranscript", "scorerProfileReader", "sealBuilder",
    "sealPublisher", "sealReader", "validateAggregate", "validateCoverage",
  ]) {
    if (typeof resolved[key] !== "function") fail("QUALITY_RUN_DEPENDENCY");
  }
  if (resolved.hooks === null || typeof resolved.hooks !== "object" || Array.isArray(resolved.hooks)) {
    fail("QUALITY_RUN_DEPENDENCY");
  }
  return resolved;
}

async function runHook(hooks, name, payload) {
  const hook = hooks[name];
  if (hook === undefined) return;
  if (typeof hook !== "function") fail("QUALITY_RUN_HOOK");
  await hook(payload);
}

async function reloadCandidateJoinState(input, dependencies, initial) {
  const [bundleValue, measuredValue, hostValue] = await Promise.all([
    dependencies.bundleInspector(input),
    dependencies.measuredEvidenceReader(input),
    dependencies.releaseHostValidator(input),
  ]).catch(() => fail("QUALITY_RUN_CANDIDATE_POSTFLIGHT"));
  const current = {
    bundle: normalizeBundleState(bundleValue, input),
    host: normalizeHostState(hostValue, input),
    measured: normalizeMeasuredState(measuredValue, input),
  };
  for (const key of ["bundle", "host", "measured"]) {
    assertStateUnchanged(initial[key], current[key], "QUALITY_RUN_CANDIDATE_POSTFLIGHT");
  }
  validateExternalJoins(input, { ...initial, ...current });
  return buildCandidateJoin({ ...initial, ...current }, input);
}

function assertLedgerMaterial(ledger, expectedBytes, expectedJoins, expectedEntries) {
  if (
    ledger?.ledgerSha256 !== sha256(expectedBytes) ||
    !isDeepStrictEqual(ledger.record?.joins, expectedJoins) ||
    !isDeepStrictEqual(ledger.record?.entries, expectedEntries)
  ) fail("QUALITY_RUN_LEDGER_JOIN");
}

function assertSealMaterial(seal, ledgerSha256, expectedSeal) {
  if (
    seal?.ledgerSha256 !== ledgerSha256 || seal.sealSha256 !== expectedSeal.sealSha256 ||
    seal.projectionSha256 !== expectedSeal.projectionSha256 ||
    !isDeepStrictEqual(seal.record, expectedSeal.record)
  ) fail("QUALITY_RUN_SEAL_JOIN");
}

async function verifyPostflight(input, dependencies, expected) {
  const [external, component, ledger, seal] = await Promise.all([
    loadExternalState(input, dependencies),
    dependencies.componentEvidenceReader(input.componentEvidencePath),
    dependencies.ledgerReader(input.controlledRoot, input.ledgerRelativePath),
    dependencies.sealReader(
      input.controlledRoot,
      input.sealRelativePath,
      input.ledgerRelativePath,
    ),
  ]).catch(() => fail("QUALITY_RUN_POSTFLIGHT"));
  assertExternalStateUnchanged(expected.external, external);
  if (
    component?.evidenceSha256 !== expected.component.evidenceSha256 ||
    !isDeepStrictEqual(component.record, expected.component.record)
  ) fail("QUALITY_RUN_COMPONENT_CHANGED");
  assertLedgerMaterial(ledger, expected.ledger.bytes, expected.ledgerJoins, expected.ledgerEntries);
  assertSealMaterial(seal, expected.ledger.ledgerSha256, expected.seal);
  return external;
}

function buildScores(ledgerRecord, corpus, dependencies) {
  const samples = new Map(corpus.samples.map((sample) => [sample.sampleId, sample]));
  const scores = [];
  for (const entry of ledgerRecord.entries) {
    const sample = samples.get(entry.sample_id);
    if (
      sample === undefined || sample.language !== entry.language || sample.scenario !== entry.scenario ||
      sample.split !== entry.split || sample.tier !== entry.tier
    ) fail("QUALITY_RUN_SCORE_JOIN");
    let score;
    try {
      score = dependencies.scoreTranscript({
        hypothesis: entry.final_transcript,
        language: entry.language,
        reference: sample.referenceText,
        sampleId: entry.sample_id,
        scenario: entry.scenario,
        tier: entry.tier,
      });
    } catch {
      // The scorer receives controlled plaintext. Never retain its thrown value.
      fail("QUALITY_RUN_SCORE");
    }
    scores.push(score);
  }
  if (scores.length !== corpus.samples.length) fail("QUALITY_RUN_SCORE_JOIN");
  return scores;
}

async function runNativeCandidateQualityEvaluationCore(rawInput, suppliedDependencies) {
  const input = validateRunInput(rawInput);
  const dependencies = normalizeDependencies(suppliedDependencies);
  await assertAllOutputsNew(input);
  const initial = await loadExternalState(input, dependencies);
  const coverage = dependencies.validateCoverage(
    initial.policy.comparable.policy,
    initial.corpus.materialized,
  );
  const candidateIdentity = buildFinalCandidateIdentity(initial, input);
  const privateEntries = [];
  let transcriptConsumerFailed = false;
  let component;
  try {
    component = await dependencies.componentRunner(
      componentInputFor(input, initial),
      {
        candidateJoinLoader: () => reloadCandidateJoinState(input, dependencies, initial),
        privateTranscriptConsumer: async (entry) => {
          try {
            privateEntries.push(validatePrivateTranscriptEntry(entry));
          } catch {
            transcriptConsumerFailed = true;
            throw new Error("QUALITY_RUN_TRANSCRIPT");
          }
        },
      },
    );
  } catch {
    if (transcriptConsumerFailed) fail("QUALITY_RUN_TRANSCRIPT");
    fail("QUALITY_RUN_COMPONENT");
  }
  await runHook(dependencies.hooks, "afterComponent", { componentEvidencePath: input.componentEvidencePath });
  const afterComponent = await loadExternalState(input, dependencies);
  assertExternalStateUnchanged(initial, afterComponent);
  const normalizedComponent = validateComponentResult(component, afterComponent, input, privateEntries);
  const persistedComponent = await dependencies.componentEvidenceReader(input.componentEvidencePath)
    .catch(() => fail("QUALITY_RUN_COMPONENT_PERSISTED"));
  if (
    persistedComponent.evidenceSha256 !== normalizedComponent.evidenceSha256 ||
    !isDeepStrictEqual(persistedComponent.record, normalizedComponent.record)
  ) fail("QUALITY_RUN_COMPONENT_PERSISTED");

  const ledgerJoins = buildLedgerJoins(candidateIdentity, afterComponent, input);
  let ledger;
  try {
    ledger = dependencies.ledgerBuilder({ entries: normalizedComponent.ledgerEntries, joins: ledgerJoins });
  } catch {
    fail("QUALITY_RUN_LEDGER");
  }
  assertLedgerMaterial(ledger, ledger.bytes, ledgerJoins, normalizedComponent.ledgerEntries);
  await runHook(dependencies.hooks, "beforeLedgerPublish", {});
  try {
    await dependencies.ledgerPublisher(
      input.controlledRoot,
      input.ledgerRelativePath,
      ledger.bytes,
    );
  } catch {
    fail("QUALITY_RUN_LEDGER_PUBLICATION");
  }
  const persistedLedger = await dependencies.ledgerReader(input.controlledRoot, input.ledgerRelativePath)
    .catch(() => fail("QUALITY_RUN_LEDGER_PERSISTED"));
  assertLedgerMaterial(persistedLedger, ledger.bytes, ledgerJoins, normalizedComponent.ledgerEntries);

  let seal;
  try { seal = dependencies.sealBuilder(ledger.bytes); }
  catch { fail("QUALITY_RUN_SEAL"); }
  try {
    await dependencies.sealPublisher(
      input.controlledRoot,
      input.sealRelativePath,
      input.ledgerRelativePath,
      seal.bytes,
    );
  } catch {
    fail("QUALITY_RUN_SEAL_PUBLICATION");
  }
  const persistedSeal = await dependencies.sealReader(
    input.controlledRoot,
    input.sealRelativePath,
    input.ledgerRelativePath,
  ).catch(() => fail("QUALITY_RUN_SEAL_PERSISTED"));
  assertSealMaterial(persistedSeal, ledger.ledgerSha256, seal);

  const scores = buildScores(persistedLedger.record, afterComponent.corpus.materialized, dependencies);
  let aggregate;
  try {
    aggregate = dependencies.aggregateScores(scores);
    dependencies.validateAggregate(aggregate, scores);
  } catch {
    fail("QUALITY_RUN_AGGREGATE");
  }
  const record = {
    aggregate,
    authority: { ...AUTHORITY },
    candidate_identity: { ...candidateIdentity },
    component_evidence: {
      sample_count: normalizedComponent.record.results.length,
      sha256: normalizedComponent.evidenceSha256,
    },
    corpus_identity: {
      manifest_sha256: afterComponent.corpus.comparable.manifestSha256,
      sample_count: afterComponent.corpus.comparable.samples.length,
      slice_count: coverage.observedSliceCount,
      snapshot_sha256: afterComponent.corpus.comparable.snapshotSha256,
      validation_date: afterComponent.corpus.comparable.validationDate,
    },
    hardware_identity: {
      evidence_sha256: input.expectedHardwareEvidenceSha256,
      hw_ref_id: afterComponent.measured.comparable.hwRefId,
      operator_facts_sha256: afterComponent.measured.comparable.operatorFactsSha256,
    },
    kind: KIND,
    ledger_identity: {
      candidate_identity_sha256: ledgerJoins.candidate_identity_sha256,
      entry_count: normalizedComponent.ledgerEntries.length,
      projection_sha256: seal.projectionSha256,
      seal_sha256: seal.sealSha256,
      sha256: ledger.ledgerSha256,
    },
    measurement_status: MEASUREMENT_STATUS,
    quality_gate_status: QUALITY_GATE_STATUS,
    run_policy_identity: {
      coverage_scope: afterComponent.policy.comparable.policy.coverage_scope,
      exclusion_policy: afterComponent.policy.comparable.policy.exclusion_policy,
      max_attempts: afterComponent.policy.comparable.policy.max_attempts,
      sha256: input.expectedRunPolicySha256,
    },
    schema_version: SCHEMA_VERSION,
    scorer_identity: {
      profile_id: afterComponent.scorer.comparable.profileId,
      profile_sha256: afterComponent.scorer.comparable.profileSha256,
    },
    scores,
    source_identity: {
      commit: input.expectedSourceCommit,
      evidence_sha256: input.expectedMeasuredEvidenceSha256,
    },
  };
  const bytes = Buffer.from(encodeCanonicalJsonLine(record), "utf8");
  validateNativeCandidateQualityEvidenceRecord(bytes);
  const expected = {
    component: normalizedComponent,
    external: afterComponent,
    ledger,
    ledgerEntries: normalizedComponent.ledgerEntries,
    ledgerJoins,
    seal,
  };
  await verifyPostflight(input, dependencies, expected);
  await runHook(dependencies.hooks, "beforeFinalPublish", {});
  try {
    await dependencies.finalEvidencePublisher(input.finalEvidencePath, bytes, {
      afterPersistedRead: () => verifyPostflight(input, dependencies, expected),
    });
  } catch {
    fail("QUALITY_RUN_FINAL_PUBLICATION");
  }
  const persistedFinal = await dependencies.finalEvidenceReader(input.finalEvidencePath)
    .catch(() => fail("QUALITY_RUN_FINAL_PERSISTED"));
  let validatedFinal;
  try {
    if (!Buffer.isBuffer(persistedFinal?.bytes)) fail("QUALITY_RUN_FINAL_PERSISTED");
    validatedFinal = validateNativeCandidateQualityEvidenceRecord(persistedFinal.bytes);
    if (
      !persistedFinal.bytes.equals(bytes) || validatedFinal.evidenceSha256 !== sha256(bytes) ||
      !isDeepStrictEqual(validatedFinal.record, record)
    ) fail("QUALITY_RUN_FINAL_PERSISTED");
  } catch {
    fail("QUALITY_RUN_FINAL_PERSISTED");
  }
  await verifyPostflight(input, dependencies, expected);
  return { evidenceSha256: validatedFinal.evidenceSha256, record: validatedFinal.record };
}

const PRODUCTION_DEPENDENCIES = Object.freeze({
  aggregateScores: aggregateDescriptiveAsrScores,
  bundleInspector: inspectCandidateBundle,
  componentEvidenceReader: validateNativeCandidateComponentEvidenceFile,
  componentRunner: runNativeCandidateComponentEvidence,
  corpusLoader: loadCorpusState,
  finalEvidencePublisher: publishNativeCandidateQualityEvidence,
  finalEvidenceReader: validateNativeCandidateQualityEvidenceFile,
  hooks: Object.freeze({}),
  ledgerBuilder: buildControlledHypothesisLedger,
  ledgerPublisher: publishControlledHypothesisLedger,
  ledgerReader: readControlledHypothesisLedger,
  measuredEvidenceReader: readPinnedMeasuredEvidence,
  policyReader: readPinnedPolicy,
  releaseHostValidator: validateReleaseQualityHost,
  scoreTranscript: scoreAsrTranscript,
  scorerProfileReader: readPinnedScorerProfile,
  sealBuilder: buildControlledHypothesisLedgerSeal,
  sealPublisher: publishControlledHypothesisLedgerSeal,
  sealReader: readControlledHypothesisLedgerSeal,
  validateAggregate: validateDescriptiveAsrAggregate,
  validateCoverage: validateAsrQualityRunPolicyCoverage,
});

export async function runNativeCandidateQualityEvaluation(input) {
  return runNativeCandidateQualityEvaluationCore(input, PRODUCTION_DEPENDENCIES);
}

export async function __runNativeCandidateQualityEvaluationForTest(input, dependencies = {}) {
  return runNativeCandidateQualityEvaluationCore(input, dependencies);
}

async function main(arguments_) {
  if (arguments_.length !== 2 || arguments_[0] !== "--validate") fail("QUALITY_EVIDENCE_USAGE");
  const validated = await validateNativeCandidateQualityEvidenceFile(arguments_[1]);
  process.stdout.write(
    `native-candidate-quality-evidence=verified evidence_sha256=${validated.evidenceSha256} samples=${validated.record.scores.length} measurement_status=${MEASUREMENT_STATUS} quality_gate_status=${QUALITY_GATE_STATUS} formal_claims=none production_evidence=false public_distribution=false\n`,
  );
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof NativeCandidateQualityRunnerError ? error.code : "QUALITY_EVIDENCE_INTERNAL"}\n`);
    process.exitCode = 1;
  });
}
