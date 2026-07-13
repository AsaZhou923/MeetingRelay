import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { encodeCanonicalJson } from "../phase0-harness/canonical-json.mjs";
import {
  HW_REF_COLLECTOR_VERSION,
  WINDOWS_COLLECTOR_ASSET_PATH,
  hwRefCollectorTargetRoot,
  validateCollectedHardwareReference,
} from "../phase0-harness/hw-ref-collector.mjs";
import { buildMeasuredSherpaCandidateInputBundlePlan } from "./candidate-input-bundle-plan.mjs";
import { materializeSherpaCandidateInputBundle } from "./candidate-input-materializer.mjs";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(MODULE_DIR, "../..");
const COLLECTOR_SOURCE_PATH = path.join(
  REPOSITORY_ROOT,
  "tools",
  "phase0-harness",
  "hw-ref-collector.mjs",
);
const COLLECTOR_SOURCE_RELATIVE_PATH =
  "tools/phase0-harness/hw-ref-collector.mjs";
const MAX_HW_REF_BYTES = 1024 * 1024;
const MAX_COLLECTOR_BYTES = 4 * 1024 * 1024;
const DIGEST = /^[0-9a-f]{64}$/u;
const PRODUCTION_HOOKS = Object.freeze({});

export class MeasuredCandidateCloseoutError extends Error {
  constructor(code, message, field = null, options = {}) {
    super(`${code}: ${message}`, options);
    this.name = "MeasuredCandidateCloseoutError";
    this.code = code;
    this.field = field;
  }
}

function fail(code, message, field = null, options = {}) {
  throw new MeasuredCandidateCloseoutError(code, message, field, options);
}

function exactKeys(value, keys, field) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())
  ) {
    fail("MEASURED_CLOSEOUT_KEYS", `${field} keys differ`, field);
  }
}

function assertDigest(value, field) {
  if (typeof value !== "string" || !DIGEST.test(value) || /^0{64}$/u.test(value)) {
    fail(
      "MEASURED_CLOSEOUT_DIGEST",
      `${field} must be a non-zero lowercase SHA-256 digest`,
      field,
    );
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function pathKey(value) {
  return path.normalize(value).toLowerCase();
}

function isStrictDescendant(root, value) {
  const relative = path.relative(root, value);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
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

async function runHook(hooks, name, payload) {
  const hook = hooks[name];
  if (hook === undefined) return;
  if (typeof hook !== "function") {
    fail("MEASURED_CLOSEOUT_HOOK", `${name} must be callable`, name);
  }
  await hook(payload);
}

async function assertDirectFilePath(filePath, field) {
  if (
    typeof filePath !== "string" ||
    !path.isAbsolute(filePath) ||
    path.normalize(filePath) !== filePath ||
    filePath.normalize("NFC") !== filePath
  ) {
    fail(
      "MEASURED_CLOSEOUT_PATH",
      `${field} must be a normalized absolute path`,
      field,
    );
  }
  const root = path.parse(filePath).root;
  const segments = path.relative(root, filePath).split(path.sep).filter(Boolean);
  let current = root;
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    let stat;
    try {
      stat = await lstat(current, { bigint: true });
    } catch {
      fail("MEASURED_CLOSEOUT_PATH", `${field} cannot be inspected`, field);
    }
    const final = index === segments.length - 1;
    if (
      stat.isSymbolicLink() ||
      (!final && !stat.isDirectory()) ||
      (final && !stat.isFile())
    ) {
      fail(
        "MEASURED_CLOSEOUT_REPARSE",
        `${field} must be a direct regular file`,
        field,
      );
    }
  }
  let resolved;
  let resolvedParent;
  try {
    [resolved, resolvedParent] = await Promise.all([
      realpath(filePath),
      realpath(path.dirname(filePath)),
    ]);
  } catch {
    fail("MEASURED_CLOSEOUT_PATH", `${field} cannot be resolved`, field);
  }
  if (
    pathKey(resolved) !==
    pathKey(path.join(resolvedParent, path.basename(filePath)))
  ) {
    fail(
      "MEASURED_CLOSEOUT_REPARSE",
      `${field} final component is not direct`,
      field,
    );
  }
  return resolved;
}

async function rereadPinnedBytes(handle, expectedLength, field) {
  const bytes = Buffer.allocUnsafe(expectedLength);
  let offset = 0;
  while (offset < expectedLength) {
    const { bytesRead } = await handle.read(
      bytes,
      offset,
      expectedLength - offset,
      offset,
    );
    if (bytesRead === 0) {
      fail(
        "MEASURED_CLOSEOUT_IDENTITY",
        `${field} shortened while it was read`,
        field,
      );
    }
    offset += bytesRead;
  }
  const trailing = Buffer.allocUnsafe(1);
  const { bytesRead: trailingBytes } = await handle.read(
    trailing,
    0,
    1,
    expectedLength,
  );
  if (trailingBytes !== 0) {
    fail(
      "MEASURED_CLOSEOUT_IDENTITY",
      `${field} grew while it was read`,
      field,
    );
  }
  return bytes;
}

async function readPinnedFile(filePath, field, maximumBytes, hooks) {
  const resolvedBefore = await assertDirectFilePath(filePath, field);
  let handle;
  try {
    handle = await open(filePath, "r");
  } catch {
    fail("MEASURED_CLOSEOUT_READ", `${field} cannot be opened`, field);
  }
  let operationError;
  try {
    const [beforePath, beforeHandle] = await Promise.all([
      lstat(filePath, { bigint: true }),
      handle.stat({ bigint: true }),
    ]);
    if (
      !beforePath.isFile() ||
      beforePath.isSymbolicLink() ||
      !beforeHandle.isFile() ||
      !sameSnapshot(beforePath, beforeHandle) ||
      beforeHandle.size > BigInt(maximumBytes)
    ) {
      fail(
        "MEASURED_CLOSEOUT_FILE",
        `${field} identity, kind, or size is invalid`,
        field,
      );
    }
    const bytes = await handle.readFile();
    await runHook(hooks, "afterHwReadBeforePostcheck", {
      field,
      filePath,
    });
    const [afterPath, afterHandle, resolvedAfter, verificationBytes] =
      await Promise.all([
        lstat(filePath, { bigint: true }).catch(() => null),
        handle.stat({ bigint: true }),
        realpath(filePath).catch(() => null),
        rereadPinnedBytes(handle, bytes.length, field),
      ]);
    if (
      afterPath === null ||
      resolvedAfter === null ||
      !sameSnapshot(beforeHandle, afterHandle) ||
      !sameSnapshot(beforeHandle, afterPath) ||
      pathKey(resolvedAfter) !== pathKey(resolvedBefore) ||
      BigInt(bytes.length) !== beforeHandle.size ||
      !verificationBytes.equals(bytes)
    ) {
      fail(
        "MEASURED_CLOSEOUT_IDENTITY",
        `${field} changed while it was read`,
        field,
      );
    }
    return Object.freeze({
      bytes: Buffer.from(bytes),
      resolved: resolvedBefore,
      sha256: sha256(bytes),
      sizeBytes: String(bytes.length),
    });
  } catch (error) {
    operationError = error;
    if (error instanceof MeasuredCandidateCloseoutError) throw error;
    fail(
      "MEASURED_CLOSEOUT_READ",
      `${field} could not be read consistently`,
      field,
      { cause: error },
    );
  } finally {
    try {
      await handle.close();
    } catch (error) {
      if (operationError === undefined) {
        fail(
          "MEASURED_CLOSEOUT_CLOSE",
          `${field} could not be closed after reading`,
          field,
          { cause: error },
        );
      }
    }
  }
}

function parseCanonicalHardware(bytes) {
  let text;
  let value;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    value = JSON.parse(text);
  } catch {
    fail(
      "MEASURED_CLOSEOUT_HW_CANONICAL",
      "measured HW must be strict canonical UTF-8 JSON",
      "measuredHardwareReferencePath",
    );
  }
  const canonical = Buffer.from(encodeCanonicalJson(value), "utf8");
  if (!canonical.equals(bytes)) {
    fail(
      "MEASURED_CLOSEOUT_HW_CANONICAL",
      "measured HW bytes are not canonical",
      "measuredHardwareReferencePath",
    );
  }
  try {
    validateCollectedHardwareReference(value);
  } catch (error) {
    fail(
      "MEASURED_CLOSEOUT_HW_CONTRACT",
      "measured HW contract validation failed",
      "measuredHardwareReferencePath",
      { cause: error },
    );
  }
  return value;
}

async function proposeCore(input, { buildPlan, hooks }) {
  exactKeys(
    input,
    [
      "candidatePlan",
      "fixtureRegistryProjection",
      "measuredHardwareReferencePath",
    ],
    "input",
  );
  const {
    candidatePlan,
    fixtureRegistryProjection,
    measuredHardwareReferencePath,
  } = input;
  if (
    typeof measuredHardwareReferencePath !== "string" ||
    !path.isAbsolute(measuredHardwareReferencePath) ||
    path.normalize(measuredHardwareReferencePath) !==
      measuredHardwareReferencePath ||
    measuredHardwareReferencePath.normalize("NFC") !==
      measuredHardwareReferencePath
  ) {
    fail(
      "MEASURED_CLOSEOUT_PATH",
      "measured HW must be a normalized absolute path",
      "measuredHardwareReferencePath",
    );
  }
  const measuredPath = path.normalize(measuredHardwareReferencePath);
  const measuredRelative = path.relative(hwRefCollectorTargetRoot, measuredPath);
  if (
    !isStrictDescendant(hwRefCollectorTargetRoot, measuredPath) ||
    measuredRelative.includes(":") ||
    !/^[A-Za-z0-9._-]+\.json$/iu.test(path.basename(measuredPath)) ||
    /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(
      path.basename(measuredPath),
    )
  ) {
    fail(
      "MEASURED_CLOSEOUT_PATH",
      "measured HW must be a collector-compatible JSON file below the ignored target tree",
      "measuredHardwareReferencePath",
    );
  }
  const [hardwareSnapshot, collectorSnapshot] = await Promise.all([
    readPinnedFile(
      measuredPath,
      "measuredHardwareReferencePath",
      MAX_HW_REF_BYTES,
      hooks,
    ),
    readPinnedFile(
      COLLECTOR_SOURCE_PATH,
      "collectorSource",
      MAX_COLLECTOR_BYTES,
      PRODUCTION_HOOKS,
    ),
  ]);
  const resolvedTargetRoot = await realpath(hwRefCollectorTargetRoot);
  if (!isStrictDescendant(resolvedTargetRoot, hardwareSnapshot.resolved)) {
    fail(
      "MEASURED_CLOSEOUT_REPARSE",
      "measured HW resolves outside the ignored target tree",
      "measuredHardwareReferencePath",
    );
  }
  const hardware = parseCanonicalHardware(hardwareSnapshot.bytes);
  if (
    hardware.collector.path !== WINDOWS_COLLECTOR_ASSET_PATH ||
    hardware.collector.version !== HW_REF_COLLECTOR_VERSION ||
    hardware.collector.sha256 !== collectorSnapshot.sha256
  ) {
    fail(
      "MEASURED_CLOSEOUT_COLLECTOR_JOIN",
      "measured HW does not identify the pinned collector source",
      "measuredHardwareReferencePath",
    );
  }
  const sourceRelativePath = path
    .relative(REPOSITORY_ROOT, measuredPath)
    .split(path.sep)
    .join("/");
  const plan = buildPlan({
    candidatePlan,
    collectorSource: {
      path: COLLECTOR_SOURCE_RELATIVE_PATH,
      sha256: collectorSnapshot.sha256,
      size_bytes: collectorSnapshot.sizeBytes,
    },
    fixtureRegistryProjection,
    measuredHardwareReference: hardware,
    measuredHardwareReferenceSource: {
      path: sourceRelativePath,
      sha256: hardwareSnapshot.sha256,
      size_bytes: hardwareSnapshot.sizeBytes,
    },
  });
  if (
    plan?.schema_version !== "1.1" ||
    !Array.isArray(plan.materials) ||
    plan.materials.length !== 29
  ) {
    fail(
      "MEASURED_CLOSEOUT_PLAN",
      "measured builder did not return the exact schema 1.1 inventory",
      "plan",
    );
  }
  assertDigest(plan.proposedContractSha256, "plan.proposedContractSha256");
  return Object.freeze({
    formalClaims: "none",
    plan,
    productionEvidence: false,
    proposedContractSha256: plan.proposedContractSha256,
    status: "proposed",
    validationPhase: "input-only-proposal",
  });
}

async function materializeCore(input, dependencies) {
  exactKeys(
    input,
    [
      "candidatePlan",
      "expectedContractSha256",
      "fixtureRegistryProjection",
      "measuredHardwareReferencePath",
      "outputRoot",
      "sourceRoots",
    ],
    "input",
  );
  assertDigest(input.expectedContractSha256, "expectedContractSha256");
  const proposal = await proposeCore(
    {
      candidatePlan: input.candidatePlan,
      fixtureRegistryProjection: input.fixtureRegistryProjection,
      measuredHardwareReferencePath: input.measuredHardwareReferencePath,
    },
    dependencies,
  );
  if (input.expectedContractSha256 !== proposal.proposedContractSha256) {
    fail(
      "MEASURED_CLOSEOUT_TRUST_MISMATCH",
      "external contract digest does not match the measured proposal",
      "expectedContractSha256",
    );
  }
  await runHook(dependencies.hooks, "beforeMaterialize", {
    outputRoot: input.outputRoot,
    proposedContractSha256: proposal.proposedContractSha256,
  });
  const result = await dependencies.materialize({
    expectedContractSha256: input.expectedContractSha256,
    outputRoot: input.outputRoot,
    plan: proposal.plan,
    sourceRoots: input.sourceRoots,
  });
  if (
    result?.status !== "input-valid" ||
    result.validationPhase !== "input-only" ||
    result.formalClaims !== "none" ||
    result.productionEvidence !== false
  ) {
    fail(
      "MEASURED_CLOSEOUT_AUTHORITY",
      "materializer returned unsupported closeout authority",
      "result",
    );
  }
  return result;
}

const PRODUCTION_DEPENDENCIES = Object.freeze({
  buildPlan: buildMeasuredSherpaCandidateInputBundlePlan,
  hooks: PRODUCTION_HOOKS,
  materialize: materializeSherpaCandidateInputBundle,
});

export async function proposeMeasuredSherpaCandidateInputCloseout(input) {
  return proposeCore(input, PRODUCTION_DEPENDENCIES);
}

export async function materializeMeasuredSherpaCandidateInputCloseout(input) {
  return materializeCore(input, PRODUCTION_DEPENDENCIES);
}

export async function __proposeMeasuredCloseoutForTest(
  input,
  {
    buildPlan = buildMeasuredSherpaCandidateInputBundlePlan,
    hooks = PRODUCTION_HOOKS,
  } = {},
) {
  return proposeCore(input, { buildPlan, hooks, materialize: null });
}

export async function __materializeMeasuredCloseoutForTest(
  input,
  {
    buildPlan = buildMeasuredSherpaCandidateInputBundlePlan,
    hooks = PRODUCTION_HOOKS,
    materialize = materializeSherpaCandidateInputBundle,
  } = {},
) {
  return materializeCore(input, { buildPlan, hooks, materialize });
}

export const measuredCloseoutPaths = Object.freeze({
  collectorSourcePath: COLLECTOR_SOURCE_PATH,
  repositoryRoot: REPOSITORY_ROOT,
  targetRoot: hwRefCollectorTargetRoot,
});
