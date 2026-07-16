import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

import { encodeCanonicalJsonLine } from "../phase0-harness/canonical-json.mjs";

const KIND = "meetingrelay-asr-quality-run-policy-v1";
const SCHEMA_VERSION = "1.0";
const COVERAGE_SCOPE = "synthetic-mechanics-only";
const EXCLUSION_POLICY = "none";
const QUALITY_GATE_STATUS = "not-assessed";
const MAX_ATTEMPTS = 1;
const MAX_POLICY_BYTES = 64 * 1024;
const MAX_SLICES = 1_000;
const MAX_CORPUS_SAMPLES = 1_000;
const DIGEST = /^(?!0{64}$)[0-9a-f]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const LANGUAGES = new Set(["en", "ja", "zh"]);
const TIERS = new Set(["tier-1"]);
const ROOT_KEYS = Object.freeze([
  "coverage_scope",
  "exclusion_policy",
  "kind",
  "max_attempts",
  "quality_gate_status",
  "required_slices",
  "schema_version",
]);
const SLICE_KEYS = Object.freeze(["language", "scenario", "tier"]);

export class AsrQualityRunPolicyError extends Error {
  constructor(code, options = {}) {
    super(code, options);
    this.name = "AsrQualityRunPolicyError";
    this.code = code;
  }
}

function fail(code, options = {}) {
  throw new AsrQualityRunPolicyError(code, options);
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

function assertIdentifier(value, code) {
  if (
    typeof value !== "string" ||
    !IDENTIFIER.test(value) ||
    value !== value.normalize("NFC")
  ) {
    fail(code);
  }
}

function sliceKey(slice) {
  return `${slice.language}/${slice.scenario}/${slice.tier}`;
}

function validateSlice(slice) {
  exactKeys(slice, SLICE_KEYS, "ASR_RUN_POLICY_SLICE_FIELDS");
  if (!LANGUAGES.has(slice.language) || !TIERS.has(slice.tier)) {
    fail("ASR_RUN_POLICY_SLICE_CLASSIFICATION");
  }
  assertIdentifier(slice.scenario, "ASR_RUN_POLICY_SLICE_SCENARIO");
}

function validatePolicyObject(policy) {
  exactKeys(policy, ROOT_KEYS, "ASR_RUN_POLICY_FIELDS");
  if (
    policy.coverage_scope !== COVERAGE_SCOPE ||
    policy.exclusion_policy !== EXCLUSION_POLICY ||
    policy.kind !== KIND ||
    policy.max_attempts !== MAX_ATTEMPTS ||
    policy.quality_gate_status !== QUALITY_GATE_STATUS ||
    policy.schema_version !== SCHEMA_VERSION
  ) {
    fail("ASR_RUN_POLICY_SCOPE");
  }
  if (
    !Array.isArray(policy.required_slices) ||
    policy.required_slices.length < 1 ||
    policy.required_slices.length > MAX_SLICES
  ) {
    fail("ASR_RUN_POLICY_SLICES");
  }
  const seen = new Set();
  let previous;
  for (const slice of policy.required_slices) {
    validateSlice(slice);
    const key = sliceKey(slice);
    if (seen.has(key)) fail("ASR_RUN_POLICY_SLICE_DUPLICATE");
    if (previous !== undefined && previous >= key) fail("ASR_RUN_POLICY_SLICE_ORDER");
    seen.add(key);
    previous = key;
  }
}

function parseCanonicalPolicy(bytes) {
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length < 2 ||
    bytes.length > MAX_POLICY_BYTES ||
    bytes.at(-1) !== 0x0a ||
    bytes.subarray(0, -1).includes(0x0a) ||
    bytes.includes(0x0d)
  ) {
    fail("ASR_RUN_POLICY_CANONICAL_JSON");
  }
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) fail("ASR_RUN_POLICY_CANONICAL_JSON");
  let policy;
  try {
    policy = JSON.parse(text);
  } catch {
    fail("ASR_RUN_POLICY_CANONICAL_JSON");
  }
  if (encodeCanonicalJsonLine(policy) !== text) fail("ASR_RUN_POLICY_CANONICAL_JSON");
  validatePolicyObject(policy);
  return policy;
}

export function validateAsrQualityRunPolicyBytes(bytes) {
  const policy = parseCanonicalPolicy(bytes);
  return { policy, policySha256: sha256(bytes) };
}

export function buildAsrQualityRunPolicy(policy) {
  validatePolicyObject(policy);
  const bytes = Buffer.from(encodeCanonicalJsonLine(policy), "utf8");
  return { bytes, ...validateAsrQualityRunPolicyBytes(bytes) };
}

function isCanonicalLocalAbsolutePath(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    /^[\\/]{2}/u.test(value) ||
    !path.isAbsolute(value) ||
    path.normalize(value) !== value ||
    path.resolve(value) !== value ||
    value.normalize("NFC") !== value
  ) {
    return false;
  }
  return !value.slice(path.parse(value).root.length).includes(":");
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

function sameStableFile(left, right) {
  return sameIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs;
}

async function assertDirectFilePath(inputPath, operations) {
  if (!isCanonicalLocalAbsolutePath(inputPath)) fail("ASR_RUN_POLICY_PATH");
  const lstatImpl = operations.lstatImpl ?? lstat;
  const root = path.parse(inputPath).root;
  const segments = path.relative(root, inputPath).split(path.sep).filter(Boolean);
  let current = root;
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    const metadata = await lstatImpl(current, { bigint: true }).catch(() => fail("ASR_RUN_POLICY_PATH"));
    const final = index === segments.length - 1;
    if (
      metadata.isSymbolicLink() ||
      (!final && !metadata.isDirectory()) ||
      (final && !metadata.isFile())
    ) {
      fail("ASR_RUN_POLICY_PATH");
    }
  }
  return inputPath;
}

async function readHandleBytes(handle, size) {
  if (typeof size !== "bigint" || size < 1n || size > BigInt(MAX_POLICY_BYTES)) {
    fail("ASR_RUN_POLICY_INPUT");
  }
  const bytes = Buffer.alloc(Number(size));
  let offset = 0;
  while (offset < bytes.length) {
    const result = await handle
      .read(bytes, offset, bytes.length - offset, offset)
      .catch(() => fail("ASR_RUN_POLICY_INPUT"));
    if (
      result === null ||
      typeof result !== "object" ||
      !Number.isSafeInteger(result.bytesRead) ||
      result.bytesRead <= 0 ||
      result.bytesRead > bytes.length - offset
    ) {
      fail("ASR_RUN_POLICY_INPUT");
    }
    offset += result.bytesRead;
  }
  const probe = Buffer.alloc(1);
  const end = await handle
    .read(probe, 0, 1, bytes.length)
    .catch(() => fail("ASR_RUN_POLICY_INPUT"));
  if (end === null || typeof end !== "object" || end.bytesRead !== 0) {
    fail("ASR_RUN_POLICY_INPUT");
  }
  return bytes;
}

export async function readPinnedAsrQualityRunPolicy(
  input,
  operations = {},
) {
  exactKeys(input, ["expectedPolicySha256", "policyPath"], "ASR_RUN_POLICY_INPUT_FIELDS");
  assertDigest(input.expectedPolicySha256, "ASR_RUN_POLICY_TRUST_REQUIRED");
  const policyPath = await assertDirectFilePath(input.policyPath, operations);
  const lstatImpl = operations.lstatImpl ?? lstat;
  const realpathImpl = operations.realpathImpl ?? realpath;
  const openFile = operations.openReadFile ?? open;
  const [pathBefore, realpathBefore] = await Promise.all([
    lstatImpl(policyPath, { bigint: true }),
    realpathImpl(policyPath),
  ]).catch(() => fail("ASR_RUN_POLICY_INPUT"));
  if (!pathBefore.isFile() || pathBefore.isSymbolicLink()) fail("ASR_RUN_POLICY_INPUT");

  let handle;
  let firstBytes;
  let secondBytes;
  let handleBefore;
  let handleMiddle;
  let handleAfter;
  try {
    handle = await openFile(policyPath, "r");
    handleBefore = await handle.stat({ bigint: true });
    if (!handleBefore.isFile() || !sameStableFile(pathBefore, handleBefore)) {
      fail("ASR_RUN_POLICY_INPUT");
    }
    firstBytes = await readHandleBytes(handle, handleBefore.size);
    handleMiddle = await handle.stat({ bigint: true });
    secondBytes = await readHandleBytes(handle, handleBefore.size);
    handleAfter = await handle.stat({ bigint: true });
  } catch (error) {
    if (error instanceof AsrQualityRunPolicyError) throw error;
    fail("ASR_RUN_POLICY_INPUT", { cause: error });
  } finally {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch {
        fail("ASR_RUN_POLICY_INPUT");
      }
    }
  }

  const validated = validateAsrQualityRunPolicyBytes(firstBytes);
  if (
    !firstBytes.equals(secondBytes) ||
    validated.policySha256 !== input.expectedPolicySha256
  ) {
    fail("ASR_RUN_POLICY_TRUST_MISMATCH");
  }
  const [pathAfter, realpathAfter] = await Promise.all([
    lstatImpl(policyPath, { bigint: true }),
    realpathImpl(policyPath),
  ]).catch(() => fail("ASR_RUN_POLICY_INPUT"));
  if (
    !sameStableFile(pathBefore, pathAfter) ||
    !sameStableFile(handleBefore, handleMiddle) ||
    !sameStableFile(handleMiddle, handleAfter) ||
    !sameStableFile(handleAfter, pathAfter) ||
    realpathBefore !== realpathAfter ||
    BigInt(firstBytes.length) !== pathAfter.size
  ) {
    fail("ASR_RUN_POLICY_INPUT_CHANGED");
  }
  return validated;
}

export function validateAsrQualityRunPolicyCoverage(policy, materializedCorpus) {
  validatePolicyObject(policy);
  if (
    materializedCorpus === null ||
    typeof materializedCorpus !== "object" ||
    !Array.isArray(materializedCorpus.samples) ||
    materializedCorpus.samples.length < 1 ||
    materializedCorpus.samples.length > MAX_CORPUS_SAMPLES
  ) {
    fail("ASR_RUN_POLICY_CORPUS");
  }

  const observed = new Set();
  const sampleIds = new Set();
  let previousSampleId;
  for (const sample of materializedCorpus.samples) {
    if (sample === null || typeof sample !== "object" || Array.isArray(sample)) {
      fail("ASR_RUN_POLICY_CORPUS");
    }
    assertIdentifier(sample.sampleId, "ASR_RUN_POLICY_CORPUS_SAMPLE");
    if (sampleIds.has(sample.sampleId)) fail("ASR_RUN_POLICY_CORPUS_SAMPLE");
    if (previousSampleId !== undefined && previousSampleId >= sample.sampleId) {
      fail("ASR_RUN_POLICY_CORPUS_SAMPLE");
    }
    sampleIds.add(sample.sampleId);
    previousSampleId = sample.sampleId;
    const slice = {
      language: sample.language,
      scenario: sample.scenario,
      tier: sample.tier,
    };
    validateSlice(slice);
    observed.add(sliceKey(slice));
  }

  const required = policy.required_slices.map(sliceKey);
  const observedSorted = [...observed].sort();
  if (
    required.length !== observedSorted.length ||
    required.some((key, index) => key !== observedSorted[index])
  ) {
    fail("ASR_RUN_POLICY_COVERAGE");
  }
  return Object.freeze({
    observedSliceCount: observedSorted.length,
    requiredSliceCount: required.length,
    sampleCount: materializedCorpus.samples.length,
    sliceKeys: Object.freeze(observedSorted),
  });
}
