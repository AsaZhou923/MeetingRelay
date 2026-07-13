import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rm,
} from "node:fs/promises";
import path from "node:path";

import { encodeCanonicalJson } from "../phase0-harness/canonical-json.mjs";
import {
  validateArtifactPath,
  validateCandidateArtifactInputBundle,
} from "../phase0-harness/candidate-artifact-contract.mjs";
import { publishWindowsDirectoryNoReplace } from "./windows-directory-publisher.mjs";

const PLAN_KIND = "meetingrelay-sherpa-candidate-input-bundle-plan-v1";
const PLAN_SCHEMA_VERSION = "1.0";
const CONTRACT_MANIFEST_PATH = "contract-manifest.json";
const CONTRACT_SEAL_PATH = "contract-manifest.sha256";
const CANDIDATE_MANIFEST_PATH = "manifests/candidate-manifest.json";
const RUN_PLAN_PATH = "manifests/run-plan.json";
const HARNESS_PLAN_PATH = "assets/input-only-harness-plan.json";
const DIGEST = /^[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const PROJECT_COMMIT_URL_PREFIX =
  "https://github.com/AsaZhou923/MeetingRelay/commit/";
const U64 = /^(0|[1-9][0-9]*)$/u;
const MAX_U64 = (1n << 64n) - 1n;
const SOURCE_ROOT_NAMES = Object.freeze([
  "repository",
  "rust-target",
  "sherpa-model-extraction",
  "sherpa-runtime-extraction",
]);

export class CandidateInputMaterializeError extends Error {
  constructor(code, message, field = null, options = undefined) {
    super(`${code}: ${message}${field === null ? "" : ` (${field})`}`, options);
    this.name = "CandidateInputMaterializeError";
    this.code = code;
    this.field = field;
  }
}

function fail(code, message, field = null, options = undefined) {
  throw new CandidateInputMaterializeError(code, message, field, options);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function exactKeys(value, expected, field) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("BUNDLE_MATERIALIZE_TYPE", "expected an object", field);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    fail(
      "BUNDLE_MATERIALIZE_KEYS",
      `expected keys ${wanted.join(",")}, got ${actual.join(",")}`,
      field,
    );
  }
}

function assertDigest(value, field) {
  if (typeof value !== "string" || !DIGEST.test(value) || value === "0".repeat(64)) {
    fail(
      field === "expectedContractSha256"
        ? "BUNDLE_MATERIALIZE_TRUST"
        : "BUNDLE_MATERIALIZE_PLAN",
      "expected a non-zero lowercase SHA-256",
      field,
    );
  }
}

function assertU64(value, field) {
  if (typeof value !== "string" || !U64.test(value)) {
    fail("BUNDLE_MATERIALIZE_PLAN", "expected a canonical uint64 string", field);
  }
  const parsed = BigInt(value);
  if (parsed < 1n || parsed > MAX_U64) {
    fail("BUNDLE_MATERIALIZE_PLAN", "value is outside uint64 bounds", field);
  }
}

function parseCanonicalDocument(material, field) {
  if (!Buffer.isBuffer(material.bytes)) {
    fail("BUNDLE_MATERIALIZE_PLAN", "document bytes must be a Buffer", `${field}.bytes`);
  }
  if (
    sha256(material.bytes) !== material.sha256 ||
    String(material.bytes.length) !== material.size_bytes
  ) {
    fail("BUNDLE_MATERIALIZE_PLAN", "document bytes differ from their identity", field);
  }
  let value;
  try {
    value = JSON.parse(material.bytes.toString("utf8"));
  } catch (error) {
    fail(
      "BUNDLE_MATERIALIZE_PLAN",
      error instanceof Error ? error.message : "document is not JSON",
      field,
      { cause: error },
    );
  }
  const expected = ["assets/parameters.json", "assets/runtime-inventory.json"].includes(
    material.target_path,
  )
    ? Buffer.from(JSON.stringify(value), "utf8")
    : Buffer.from(encodeCanonicalJson(value), "utf8");
  if (!expected.equals(material.bytes)) {
    fail("BUNDLE_MATERIALIZE_PLAN", "document is not canonical JSON", field);
  }
  return value;
}

function validatePlan(plan) {
  exactKeys(
    plan,
    ["kind", "materials", "proposedContractSha256", "schema_version"],
    "plan",
  );
  if (plan.kind !== PLAN_KIND || plan.schema_version !== PLAN_SCHEMA_VERSION) {
    fail("BUNDLE_MATERIALIZE_PLAN", "bundle plan identity differs", "plan");
  }
  assertDigest(plan.proposedContractSha256, "plan.proposedContractSha256");
  if (!Array.isArray(plan.materials) || plan.materials.length !== 28) {
    fail("BUNDLE_MATERIALIZE_PLAN", "bundle plan must contain exactly 28 materials", "plan.materials");
  }

  const byPath = new Map();
  const validatedMaterials = [];
  let previous = null;
  let copies = 0;
  let documents = 0;
  for (const [index, material] of plan.materials.entries()) {
    const field = `plan.materials[${index}]`;
    if (material?.kind === "copy") {
      exactKeys(
        material,
        ["kind", "sha256", "size_bytes", "source_relative_path", "source_root", "target_path"],
        field,
      );
      if (!SOURCE_ROOT_NAMES.includes(material.source_root)) {
        fail("BUNDLE_MATERIALIZE_PLAN", "copy source root differs", `${field}.source_root`);
      }
      validateArtifactPath(material.source_relative_path, `${field}.source_relative_path`);
      copies += 1;
    } else if (material?.kind === "document") {
      exactKeys(material, ["bytes", "kind", "sha256", "size_bytes", "target_path"], field);
      if (!Buffer.isBuffer(material.bytes)) {
        fail("BUNDLE_MATERIALIZE_PLAN", "document bytes must be a Buffer", `${field}.bytes`);
      }
      documents += 1;
    } else {
      fail("BUNDLE_MATERIALIZE_PLAN", "material kind must be copy or document", `${field}.kind`);
    }
    validateArtifactPath(material.target_path, `${field}.target_path`);
    assertDigest(material.sha256, `${field}.sha256`);
    assertU64(material.size_bytes, `${field}.size_bytes`);
    if (previous !== null && previous >= material.target_path) {
      fail("BUNDLE_MATERIALIZE_PLAN", "material paths must be strictly sorted", field);
    }
    if (byPath.has(material.target_path)) {
      fail("BUNDLE_MATERIALIZE_PLAN", "material target path is duplicated", field);
    }
    const validated =
      material.kind === "document"
        ? { ...material, bytes: Buffer.from(material.bytes) }
        : { ...material };
    byPath.set(validated.target_path, validated);
    validatedMaterials.push(validated);
    previous = material.target_path;
  }
  if (copies !== 17 || documents !== 11) {
    fail("BUNDLE_MATERIALIZE_PLAN", "bundle plan must contain 17 copies and 11 documents", "plan.materials");
  }

  for (const [targetPath, material] of byPath) {
    if (material.kind === "document" && targetPath !== CONTRACT_SEAL_PATH) {
      parseCanonicalDocument(material, targetPath);
    } else if (material.kind === "document") {
      if (
        sha256(material.bytes) !== material.sha256 ||
        String(material.bytes.length) !== material.size_bytes
      ) {
        fail("BUNDLE_MATERIALIZE_PLAN", "seal bytes differ from their identity", targetPath);
      }
    }
  }
  const contractMaterial = byPath.get(CONTRACT_MANIFEST_PATH);
  const sealMaterial = byPath.get(CONTRACT_SEAL_PATH);
  if (contractMaterial?.kind !== "document" || sealMaterial?.kind !== "document") {
    fail("BUNDLE_MATERIALIZE_PLAN", "contract manifest and seal documents are required");
  }
  const contract = parseCanonicalDocument(contractMaterial, CONTRACT_MANIFEST_PATH);
  exactKeys(contract, ["contract_id", "entries", "formal_claims", "schema_version"], CONTRACT_MANIFEST_PATH);
  if (
    contract.schema_version !== "1.0" ||
    contract.formal_claims !== "none" ||
    !Array.isArray(contract.entries) ||
    contract.entries.length !== 26
  ) {
    fail("BUNDLE_MATERIALIZE_PLAN", "contract manifest identity or inventory differs", CONTRACT_MANIFEST_PATH);
  }
  const sealed = validatedMaterials.filter(
    (material) =>
      material.target_path !== CONTRACT_MANIFEST_PATH &&
      material.target_path !== CONTRACT_SEAL_PATH,
  );
  for (const [index, entry] of contract.entries.entries()) {
    exactKeys(entry, ["path", "sha256", "size_bytes"], `contract.entries[${index}]`);
    const material = sealed[index];
    if (
      material === undefined ||
      entry.path !== material.target_path ||
      entry.sha256 !== material.sha256 ||
      entry.size_bytes !== material.size_bytes
    ) {
      fail("BUNDLE_MATERIALIZE_PLAN", "contract inventory differs from planned materials", `contract.entries[${index}]`);
    }
  }
  if (
    contractMaterial.sha256 !== plan.proposedContractSha256 ||
    !sealMaterial.bytes.equals(
      Buffer.from(
        `${plan.proposedContractSha256}  ${CONTRACT_MANIFEST_PATH}\n`,
        "ascii",
      ),
    )
  ) {
    fail("BUNDLE_MATERIALIZE_PLAN", "proposed contract digest or seal differs", "plan.proposedContractSha256");
  }
  const candidateMaterial = byPath.get(CANDIDATE_MANIFEST_PATH);
  const runPlanMaterial = byPath.get(RUN_PLAN_PATH);
  if (candidateMaterial?.kind !== "document" || runPlanMaterial?.kind !== "document") {
    fail(
      "BUNDLE_MATERIALIZE_PLAN",
      "candidate manifest and run plan documents are required",
    );
  }
  const candidate = parseCanonicalDocument(candidateMaterial, CANDIDATE_MANIFEST_PATH);
  const revision = candidate.source?.source_revision;
  if (
    typeof revision !== "string" ||
    !COMMIT.test(revision) ||
    revision === "0".repeat(40) ||
    candidate.source?.source_url !== `${PROJECT_COMMIT_URL_PREFIX}${revision}`
  ) {
    fail(
      "BUNDLE_MATERIALIZE_PLAN",
      "candidate source must be a non-zero MeetingRelay commit URL/revision pair",
      "candidate.source",
    );
  }
  const runPlan = parseCanonicalDocument(runPlanMaterial, RUN_PLAN_PATH);
  if (runPlan.source_commit !== revision) {
    fail(
      "BUNDLE_MATERIALIZE_PLAN",
      "run plan source commit differs from the candidate revision",
      "runPlan.source_commit",
    );
  }
  return validatedMaterials;
}

function pathKey(value) {
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function pathsOverlap(left, right) {
  const leftKey = pathKey(left);
  const rightKey = pathKey(right);
  const relativeLeft = path.relative(leftKey, rightKey);
  const relativeRight = path.relative(rightKey, leftKey);
  const descends = (relative) =>
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative));
  return descends(relativeLeft) || descends(relativeRight);
}

function sameIdentity(left, right) {
  return (
    typeof left?.dev === "bigint" &&
    typeof left?.ino === "bigint" &&
    typeof right?.dev === "bigint" &&
    typeof right?.ino === "bigint" &&
    left.dev > 0n &&
    left.ino > 0n &&
    right.dev > 0n &&
    right.ino > 0n &&
    left.dev === right.dev &&
    left.ino === right.ino
  );
}

function assertUsableIdentity(stat, code, message, field) {
  if (
    typeof stat?.dev !== "bigint" ||
    typeof stat?.ino !== "bigint" ||
    stat.dev <= 0n ||
    stat.ino <= 0n
  ) {
    fail(code, message, field);
  }
}

function assertLocalWindowsAbsolutePath(value, field) {
  if (
    typeof value !== "string" ||
    !path.isAbsolute(value) ||
    value !== value.normalize("NFC") ||
    path.normalize(value) !== value
  ) {
    fail("BUNDLE_MATERIALIZE_PATH", "expected a normalized absolute path", field);
  }
  const root = path.parse(value).root;
  if (!/^[A-Za-z]:\\$/u.test(root)) {
    fail(
      "BUNDLE_MATERIALIZE_PATH",
      "a fully qualified local drive path is required; UNC and rooted-without-drive paths are unsupported",
      field,
    );
  }
  const relative = path.relative(root, value);
  const reserved = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    if (
      segment === "." ||
      segment === ".." ||
      segment.endsWith(".") ||
      segment.endsWith(" ") ||
      /[\u0000-\u001f<>:"|?*]/u.test(segment) ||
      reserved.test(segment)
    ) {
      fail(
        "BUNDLE_MATERIALIZE_PATH",
        "path contains an ADS, reserved name, or unsafe Windows segment",
        field,
      );
    }
  }
}

async function assertDirectAbsolutePath(
  value,
  field,
  finalMustBeDirectory,
  reparseCode = "BUNDLE_MATERIALIZE_PATH",
) {
  const root = path.parse(value).root;
  const segments = path.relative(root, value).split(path.sep).filter(Boolean);
  let current = root;
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    const stat = await lstat(current).catch((error) => {
      fail("BUNDLE_MATERIALIZE_PATH", "path component cannot be inspected", field, { cause: error });
    });
    const final = index === segments.length - 1;
    if (
      stat.isSymbolicLink() ||
      ((!final || finalMustBeDirectory) && !stat.isDirectory())
    ) {
      fail(
        reparseCode,
        "path components must be direct directories, not links or junctions",
        field,
      );
    }
  }
}

async function assertDirectDescendant(root, relativePath, field) {
  let current = root;
  const segments = relativePath.split("/");
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    const stat = await lstat(current).catch((error) => {
      fail("BUNDLE_MATERIALIZE_SOURCE", "source component cannot be inspected", field, { cause: error });
    });
    const final = index === segments.length - 1;
    if (stat.isSymbolicLink() || (!final && !stat.isDirectory())) {
      fail(
        "BUNDLE_MATERIALIZE_SOURCE_REPARSE",
        "source path contains a link, junction, or non-directory parent",
        field,
      );
    }
  }
}

async function inspectDirectory(root, field) {
  assertLocalWindowsAbsolutePath(root, field);
  const lexical = path.resolve(root);
  await assertDirectAbsolutePath(
    lexical,
    field,
    true,
    "BUNDLE_MATERIALIZE_SOURCE_REPARSE",
  );
  const stat = await lstat(lexical, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail("BUNDLE_MATERIALIZE_ROOT", "source root must be a direct directory, not a reparse link", field);
  }
  assertUsableIdentity(
    stat,
    "BUNDLE_MATERIALIZE_SOURCE_IDENTITY",
    "source root has no usable filesystem identity",
    field,
  );
  const resolved = await realpath(lexical);
  return { lexical, resolved, stat };
}

async function assertOutputAbsent(outputRoot) {
  try {
    await lstat(outputRoot);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    fail("BUNDLE_MATERIALIZE_OUTPUT", "output path cannot be inspected", "outputRoot", { cause: error });
  }
  fail("BUNDLE_MATERIALIZE_OUTPUT_EXISTS", "output path already exists", "outputRoot");
}

async function writeAll(handle, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const result = await handle.write(bytes, offset, bytes.length - offset, null);
    if (result.bytesWritten === 0) {
      fail("BUNDLE_MATERIALIZE_WRITE", "write made no forward progress");
    }
    offset += result.bytesWritten;
  }
}

async function runCheckpoint(hooks, name, context) {
  const hook = hooks[name];
  if (hook !== undefined) {
    await hook(Object.freeze({ ...context }));
  }
}

async function assertOwnedTempDirectoryChain(
  tempRoot,
  targetParent,
  identity,
  directoryIdentities = null,
) {
  const currentRoot = await lstat(tempRoot, { bigint: true }).catch((error) => {
    fail(
      "BUNDLE_MATERIALIZE_TEMP_IDENTITY",
      "temporary bundle root cannot be re-inspected",
      null,
      { cause: error },
    );
  });
  const currentRootRealpath = await realpath(tempRoot).catch((error) => {
    fail(
      "BUNDLE_MATERIALIZE_TEMP_IDENTITY",
      "temporary bundle root cannot be resolved again",
      null,
      { cause: error },
    );
  });
  if (
    !currentRoot.isDirectory() ||
    currentRoot.isSymbolicLink() ||
    !sameIdentity(currentRoot, identity.stat) ||
    pathKey(currentRootRealpath) !== pathKey(identity.resolved)
  ) {
    fail(
      "BUNDLE_MATERIALIZE_TEMP_IDENTITY",
      "temporary bundle root identity changed",
    );
  }
  const relative = path.relative(tempRoot, targetParent);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    fail("BUNDLE_MATERIALIZE_TEMP_IDENTITY", "target parent escaped the temporary bundle");
  }
  let current = tempRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = await lstat(current, { bigint: true }).catch((error) => {
      fail(
        "BUNDLE_MATERIALIZE_TEMP_IDENTITY",
        "target parent cannot be inspected",
        null,
        { cause: error },
      );
    });
    assertUsableIdentity(
      stat,
      "BUNDLE_MATERIALIZE_TEMP_IDENTITY",
      "target parent has no usable filesystem identity",
      null,
    );
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      fail(
        "BUNDLE_MATERIALIZE_TEMP_REPARSE",
        "target parents must be direct directories",
      );
    }
    const resolved = await realpath(current).catch((error) => {
      fail(
        "BUNDLE_MATERIALIZE_TEMP_IDENTITY",
        "target parent cannot be resolved",
        null,
        { cause: error },
      );
    });
    const relativeKey = path.relative(tempRoot, current);
    const expected = directoryIdentities?.get(relativeKey);
    if (
      expected !== undefined &&
      (!sameIdentity(stat, expected.stat) ||
        pathKey(resolved) !== pathKey(expected.resolved))
    ) {
      fail(
        "BUNDLE_MATERIALIZE_TEMP_IDENTITY",
        "target parent identity changed",
        relativeKey,
      );
    }
    if (directoryIdentities !== null && expected === undefined) {
      directoryIdentities.set(relativeKey, { resolved, stat });
    }
  }
}

async function assertRecordedTargetParentIdentities(
  root,
  directoryIdentities,
  { rootWasMoved = false } = {},
) {
  for (const [relativePath, expected] of directoryIdentities) {
    const current = path.join(root, relativePath);
    const stat = await lstat(current, { bigint: true }).catch((error) => {
      fail(
        "BUNDLE_MATERIALIZE_TEMP_IDENTITY",
        "recorded target parent cannot be inspected",
        relativePath,
        { cause: error },
      );
    });
    const resolved = await realpath(current).catch((error) => {
      fail(
        "BUNDLE_MATERIALIZE_TEMP_IDENTITY",
        "recorded target parent cannot be resolved",
        relativePath,
        { cause: error },
      );
    });
    assertUsableIdentity(
      stat,
      "BUNDLE_MATERIALIZE_TEMP_IDENTITY",
      "recorded target parent has no usable filesystem identity",
      relativePath,
    );
    const expectedResolved = rootWasMoved
      ? path.join(root, relativePath)
      : expected.resolved;
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      !sameIdentity(stat, expected.stat) ||
      pathKey(resolved) !== pathKey(expectedResolved)
    ) {
      fail(
        "BUNDLE_MATERIALIZE_TEMP_IDENTITY",
        "recorded target parent identity changed",
        relativePath,
      );
    }
  }
}

async function createTarget(
  tempRoot,
  targetPath,
  tempIdentity,
  directoryIdentities,
) {
  const target = path.join(tempRoot, ...targetPath.split("/"));
  const targetParent = path.dirname(target);
  await mkdir(targetParent, { recursive: true });
  await assertOwnedTempDirectoryChain(
    tempRoot,
    targetParent,
    tempIdentity,
    directoryIdentities,
  );
  return target;
}

async function writeDocument(
  tempRoot,
  tempIdentity,
  directoryIdentities,
  material,
) {
  const bytes = Buffer.from(material.bytes);
  if (
    sha256(bytes) !== material.sha256 ||
    String(bytes.length) !== material.size_bytes
  ) {
    fail("BUNDLE_MATERIALIZE_PLAN", "document buffer changed after validation", material.target_path);
  }
  const target = await createTarget(
    tempRoot,
    material.target_path,
    tempIdentity,
    directoryIdentities,
  );
  const handle = await open(target, "wx", 0o600);
  try {
    await writeAll(handle, bytes);
  } finally {
    await handle.close();
  }
}

async function streamCopy(
  tempRoot,
  tempIdentity,
  directoryIdentities,
  material,
  source,
  hooks,
) {
  const currentRootStat = await lstat(source.lexical, { bigint: true }).catch((error) => {
    fail("BUNDLE_MATERIALIZE_SOURCE_IDENTITY", "source root cannot be re-inspected", material.source_root, { cause: error });
  });
  const currentRootRealpath = await realpath(source.lexical).catch((error) => {
    fail("BUNDLE_MATERIALIZE_SOURCE_IDENTITY", "source root cannot be resolved again", material.source_root, { cause: error });
  });
  if (
    !currentRootStat.isDirectory() ||
    currentRootStat.isSymbolicLink() ||
    !sameIdentity(currentRootStat, source.stat) ||
    pathKey(currentRootRealpath) !== pathKey(source.resolved)
  ) {
    fail("BUNDLE_MATERIALIZE_SOURCE_IDENTITY", "source root identity changed", material.source_root);
  }
  const sourcePath = path.join(
    source.lexical,
    ...material.source_relative_path.split("/"),
  );
  await assertDirectDescendant(
    source.lexical,
    material.source_relative_path,
    material.source_relative_path,
  );
  const before = await lstat(sourcePath, { bigint: true }).catch((error) => {
    fail("BUNDLE_MATERIALIZE_SOURCE", "source file cannot be inspected", material.source_relative_path, { cause: error });
  });
  if (!before.isFile() || before.isSymbolicLink()) {
    fail("BUNDLE_MATERIALIZE_SOURCE_REPARSE", "source must be a direct regular file", material.source_relative_path);
  }
  assertUsableIdentity(
    before,
    "BUNDLE_MATERIALIZE_SOURCE_IDENTITY",
    "source file has no usable filesystem identity",
    material.source_relative_path,
  );
  const resolvedBefore = await realpath(sourcePath);
  const relative = path.relative(source.resolved, resolvedBefore);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    fail("BUNDLE_MATERIALIZE_SOURCE_REPARSE", "source resolves outside its named root", material.source_relative_path);
  }

  await runCheckpoint(hooks, "beforeSourceOpen", {
    material,
    sourcePath,
  });
  const input = await open(sourcePath, "r");
  let output;
  try {
    const opened = await input.stat({ bigint: true });
    assertUsableIdentity(
      opened,
      "BUNDLE_MATERIALIZE_SOURCE_IDENTITY",
      "opened source has no usable filesystem identity",
      material.source_relative_path,
    );
    if (!opened.isFile() || !sameIdentity(before, opened)) {
      fail("BUNDLE_MATERIALIZE_SOURCE_IDENTITY", "opened source identity differs from lstat", material.source_relative_path);
    }
    if (opened.size.toString() !== material.size_bytes) {
      fail(
        "BUNDLE_MATERIALIZE_SIZE",
        "source size differs from the plan before streaming",
        material.source_relative_path,
      );
    }
    const target = await createTarget(
      tempRoot,
      material.target_path,
      tempIdentity,
      directoryIdentities,
    );
    output = await open(target, "wx", 0o600);
    const hash = createHash("sha256");
    let size = 0n;
    for await (const chunk of input.createReadStream({ autoClose: false })) {
      hash.update(chunk);
      size += BigInt(chunk.length);
      await writeAll(output, chunk);
    }
    await runCheckpoint(hooks, "beforeSourcePostcheck", {
      material,
      sourcePath,
    });
    const afterHandle = await input.stat({ bigint: true });
    const afterPath = await lstat(sourcePath, { bigint: true }).catch((error) => {
      fail("BUNDLE_MATERIALIZE_SOURCE_IDENTITY", "source path disappeared while streaming", material.source_relative_path, { cause: error });
    });
    const resolvedAfter = await realpath(sourcePath).catch((error) => {
      fail("BUNDLE_MATERIALIZE_SOURCE_IDENTITY", "source path cannot be resolved after streaming", material.source_relative_path, { cause: error });
    });
    if (
      !sameIdentity(opened, afterHandle) ||
      !sameIdentity(opened, afterPath) ||
      opened.size !== afterHandle.size ||
      opened.size !== afterPath.size ||
      pathKey(resolvedBefore) !== pathKey(resolvedAfter)
    ) {
      fail("BUNDLE_MATERIALIZE_SOURCE_IDENTITY", "source identity changed while streaming", material.source_relative_path);
    }
    if (size.toString() !== material.size_bytes) {
      fail("BUNDLE_MATERIALIZE_SIZE", "source size differs from the plan", material.source_relative_path);
    }
    if (hash.digest("hex") !== material.sha256) {
      fail("BUNDLE_MATERIALIZE_DIGEST", "source digest differs from the plan", material.source_relative_path);
    }
  } finally {
    if (output !== undefined) await output.close();
    await input.close();
  }
}

async function validateHarness(tempRoot) {
  const expected = {
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
  const handle = await open(path.join(tempRoot, ...HARNESS_PLAN_PATH.split("/")), "r");
  try {
    const bytes = await handle.readFile();
    if (!bytes.equals(Buffer.from(encodeCanonicalJson(expected), "utf8"))) {
      fail("BUNDLE_MATERIALIZE_HARNESS", "input-only harness grants unsupported authority", HARNESS_PLAN_PATH);
    }
  } finally {
    await handle.close();
  }
}

async function inspectOwnedTempForCleanup(
  tempRoot,
  identity,
  directoryIdentities,
) {
  try {
    const current = await lstat(tempRoot, { bigint: true });
    const resolved = await realpath(tempRoot);
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      !sameIdentity(current, identity.stat) ||
      pathKey(resolved) !== pathKey(identity.resolved)
    ) {
      return "temporary bundle identity changed before cleanup";
    }
    await assertRecordedTargetParentIdentities(
      tempRoot,
      directoryIdentities,
    );
    return null;
  } catch (error) {
    return error?.code === "ENOENT"
      ? "temporary bundle disappeared before cleanup"
      : "temporary bundle could not be safely inspected for cleanup";
  }
}

async function cleanupOwnedTemp(
  tempRoot,
  identity,
  directoryIdentities,
  hooks,
) {
  const firstInspection = await inspectOwnedTempForCleanup(
    tempRoot,
    identity,
    directoryIdentities,
  );
  if (firstInspection !== null) {
    return { completed: false, reason: firstInspection };
  }
  try {
    await runCheckpoint(hooks, "beforeCleanupRemove", { tempRoot });
  } catch {
    return {
      completed: false,
      reason: "cleanup checkpoint failed before removal",
    };
  }
  const secondInspection = await inspectOwnedTempForCleanup(
    tempRoot,
    identity,
    directoryIdentities,
  );
  if (secondInspection !== null) {
    return { completed: false, reason: secondInspection };
  }
  try {
    await rm(tempRoot, { force: false, recursive: true });
    return { completed: true, reason: null };
  } catch {
    return {
      completed: false,
      reason: "temporary bundle could not be safely removed",
    };
  }
}

async function assertParentIdentity(parent, expectedStat, expectedRealpath) {
  const current = await lstat(parent, { bigint: true }).catch((error) => {
    fail("BUNDLE_MATERIALIZE_OUTPUT", "output parent cannot be re-inspected", "outputRoot", { cause: error });
  });
  const currentRealpath = await realpath(parent).catch((error) => {
    fail("BUNDLE_MATERIALIZE_OUTPUT", "output parent cannot be resolved again", "outputRoot", { cause: error });
  });
  if (
    !current.isDirectory() ||
    current.isSymbolicLink() ||
    !sameIdentity(current, expectedStat) ||
    pathKey(currentRealpath) !== pathKey(expectedRealpath)
  ) {
    fail("BUNDLE_MATERIALIZE_OUTPUT", "output parent identity changed", "outputRoot");
  }
}

async function inspectPublishedOutput(output, tempIdentity) {
  let stat;
  try {
    stat = await lstat(output, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false, owned: false };
    fail(
      "BUNDLE_MATERIALIZE_OUTPUT",
      "publish result cannot be inspected",
      "outputRoot",
      { cause: error },
    );
  }
  if (
    stat.isDirectory() &&
    !stat.isSymbolicLink() &&
    sameIdentity(stat, tempIdentity.stat)
  ) {
    const resolved = await realpath(output).catch(() => null);
    if (resolved !== null && pathKey(resolved) === pathKey(output)) {
      return { exists: true, owned: true };
    }
  }
  return { exists: true, owned: false };
}

const PRODUCTION_HOOKS = Object.freeze({});
const PRODUCTION_MATERIALIZER_DEPENDENCIES = Object.freeze({
  hooks: PRODUCTION_HOOKS,
  publishDirectory: publishWindowsDirectoryNoReplace,
});

/**
 * Materializes and namespace-atomically publishes one externally authorized
 * candidate-input bundle with a native no-replace destination operation.
 * This v1 operation is Windows-only and assumes a same-volume local
 * filesystem. It is not crash-durable, does not support network shares, and
 * its source, temporary-root, and parent checks are fail-closed path
 * revalidations rather than a handle-bound transaction.
 * `expectedContractSha256` is mandatory and never defaults from the plan's
 * merely proposed digest.
 */
async function materializeSherpaCandidateInputBundleCore(
  { plan, sourceRoots, outputRoot, expectedContractSha256 },
  { hooks, publishDirectory },
) {
  if (expectedContractSha256 === undefined) {
    fail(
      "BUNDLE_MATERIALIZE_TRUST_REQUIRED",
      "an independently supplied contract digest is required",
      "expectedContractSha256",
    );
  }
  assertDigest(expectedContractSha256, "expectedContractSha256");
  if (process.platform !== "win32") {
    fail("BUNDLE_MATERIALIZE_PLATFORM", "v1 supports Windows local filesystems only");
  }
  const materials = validatePlan(plan);
  if (expectedContractSha256 !== plan.proposedContractSha256) {
    fail(
      "BUNDLE_MATERIALIZE_TRUST_MISMATCH",
      "external contract digest does not match the proposed sealed contract",
      "expectedContractSha256",
    );
  }
  exactKeys(sourceRoots, SOURCE_ROOT_NAMES, "sourceRoots");
  const sourceRootSnapshot = Object.fromEntries(
    SOURCE_ROOT_NAMES.map((name) => [name, sourceRoots[name]]),
  );
  if (typeof outputRoot !== "string" || !path.isAbsolute(outputRoot)) {
    fail("BUNDLE_MATERIALIZE_OUTPUT", "outputRoot must be absolute", "outputRoot");
  }
  assertLocalWindowsAbsolutePath(outputRoot, "outputRoot");

  const inspectedRoots = {};
  for (const name of SOURCE_ROOT_NAMES) {
    if (
      typeof sourceRootSnapshot[name] !== "string" ||
      !path.isAbsolute(sourceRootSnapshot[name])
    ) {
      fail("BUNDLE_MATERIALIZE_ROOT", "source root must be absolute", `sourceRoots.${name}`);
    }
    inspectedRoots[name] = await inspectDirectory(
      sourceRootSnapshot[name],
      `sourceRoots.${name}`,
    );
  }

  const output = path.resolve(outputRoot);
  const parent = path.dirname(output);
  await assertDirectAbsolutePath(parent, "outputRoot", true);
  const parentStat = await lstat(parent, { bigint: true }).catch((error) => {
    fail("BUNDLE_MATERIALIZE_OUTPUT", "output parent cannot be inspected", "outputRoot", { cause: error });
  });
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    fail("BUNDLE_MATERIALIZE_OUTPUT", "output parent must be a direct directory", "outputRoot");
  }
  assertUsableIdentity(
    parentStat,
    "BUNDLE_MATERIALIZE_OUTPUT",
    "output parent has no usable filesystem identity",
    "outputRoot",
  );
  const resolvedParent = await realpath(parent);
  const prospectiveOutput = path.join(resolvedParent, path.basename(output));
  for (const [name, source] of Object.entries(inspectedRoots)) {
    if (
      pathsOverlap(output, source.lexical) ||
      pathsOverlap(prospectiveOutput, source.resolved)
    ) {
      fail(
        "BUNDLE_MATERIALIZE_PATH_OVERLAP",
        "output must not equal, contain, or descend from a source root",
        `sourceRoots.${name}`,
      );
    }
  }
  await assertOutputAbsent(output);

  const tempRoot = await mkdtemp(path.join(parent, `.${path.basename(output)}.meetingrelay-tmp-`));
  const directoryIdentities = new Map();
  let tempIdentity = null;
  let published = false;
  let nativePublished = false;
  let failure = null;
  try {
    tempIdentity = {
      resolved: await realpath(tempRoot),
      stat: await lstat(tempRoot, { bigint: true }),
    };
    assertUsableIdentity(
      tempIdentity.stat,
      "BUNDLE_MATERIALIZE_TEMP_IDENTITY",
      "temporary bundle has no usable filesystem identity",
      null,
    );
    for (const material of materials) {
      if (material.kind === "document") {
        await writeDocument(
          tempRoot,
          tempIdentity,
          directoryIdentities,
          material,
        );
      } else {
        await streamCopy(
          tempRoot,
          tempIdentity,
          directoryIdentities,
          material,
          inspectedRoots[material.source_root],
          hooks,
        );
      }
    }
    await runCheckpoint(hooks, "beforePublishRevalidation", {
      output,
      parent,
      tempRoot,
    });
    await assertParentIdentity(parent, parentStat, resolvedParent);
    await assertOwnedTempDirectoryChain(tempRoot, tempRoot, tempIdentity);
    await assertRecordedTargetParentIdentities(
      tempRoot,
      directoryIdentities,
    );
    await validateHarness(tempRoot);
    await validateCandidateArtifactInputBundle(tempRoot, {
      expectedContractSha256,
    });
    await runCheckpoint(hooks, "afterInputValidation", {
      output,
      parent,
      tempRoot,
    });
    await assertParentIdentity(parent, parentStat, resolvedParent);
    await assertOwnedTempDirectoryChain(tempRoot, tempRoot, tempIdentity);
    await assertRecordedTargetParentIdentities(
      tempRoot,
      directoryIdentities,
    );
    await validateHarness(tempRoot);
    await validateCandidateArtifactInputBundle(tempRoot, {
      expectedContractSha256,
    });
    await assertParentIdentity(parent, parentStat, resolvedParent);
    await assertOwnedTempDirectoryChain(tempRoot, tempRoot, tempIdentity);
    await assertRecordedTargetParentIdentities(
      tempRoot,
      directoryIdentities,
    );
    try {
      await publishDirectory({
        destinationDirectory: output,
        sourceDirectory: tempRoot,
      });
    } catch (error) {
      const result = await inspectPublishedOutput(output, tempIdentity);
      if (result.owned) {
        nativePublished = true;
        fail(
          "BUNDLE_MATERIALIZE_PUBLISH",
          "native publish completed without a valid success result",
          "outputRoot",
          { cause: error },
        );
      }
      if (result.exists) {
        fail("BUNDLE_MATERIALIZE_OUTPUT_EXISTS", "output path appeared before publish", "outputRoot", { cause: error });
      }
      fail("BUNDLE_MATERIALIZE_PUBLISH", "native no-replace publish failed", "outputRoot", { cause: error });
    }
    nativePublished = true;
    const publishResult = await inspectPublishedOutput(output, tempIdentity);
    if (!publishResult.owned) {
      fail(
        "BUNDLE_MATERIALIZE_PUBLISH_VERIFY",
        "published output identity differs from the temporary bundle",
        "outputRoot",
      );
    }
    await runCheckpoint(hooks, "afterNativePublishBeforeValidation", {
      output,
      parent,
      tempRoot,
    });
    const postCheckpointPublishResult = await inspectPublishedOutput(
      output,
      tempIdentity,
    );
    if (!postCheckpointPublishResult.owned) {
      fail(
        "BUNDLE_MATERIALIZE_PUBLISH_VERIFY",
        "published output identity changed before final validation",
        "outputRoot",
      );
    }
    await assertParentIdentity(parent, parentStat, resolvedParent);
    await assertRecordedTargetParentIdentities(
      output,
      directoryIdentities,
      { rootWasMoved: true },
    );
    try {
      await lstat(tempRoot);
      fail(
        "BUNDLE_MATERIALIZE_PUBLISH_VERIFY",
        "temporary bundle name remained after publish",
        "outputRoot",
      );
    } catch (error) {
      if (error instanceof CandidateInputMaterializeError) throw error;
      if (error?.code !== "ENOENT") {
        fail(
          "BUNDLE_MATERIALIZE_PUBLISH_VERIFY",
          "temporary bundle absence cannot be verified",
          "outputRoot",
          { cause: error },
        );
      }
    }
    await validateHarness(output);
    const validation = await validateCandidateArtifactInputBundle(output, {
      expectedContractSha256,
    });
    await assertParentIdentity(parent, parentStat, resolvedParent);
    const finalPublishResult = await inspectPublishedOutput(output, tempIdentity);
    if (!finalPublishResult.owned) {
      fail(
        "BUNDLE_MATERIALIZE_PUBLISH_VERIFY",
        "published output identity changed after final validation",
        "outputRoot",
      );
    }
    await assertRecordedTargetParentIdentities(
      output,
      directoryIdentities,
      { rootWasMoved: true },
    );
    published = true;
    return { ...validation, bundleRoot: output };
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    if (!published && !nativePublished) {
      let cleanupHookFailed = false;
      try {
        await runCheckpoint(hooks, "beforeCleanup", {
          failure,
          tempRoot,
        });
      } catch {
        cleanupHookFailed = true;
      }
      const cleanup = cleanupHookFailed
        ? {
            completed: false,
            reason: "cleanup checkpoint failed before identity verification",
          }
        : tempIdentity === null
          ? {
              completed: false,
              reason: "temporary bundle identity snapshot was not established",
            }
          : await cleanupOwnedTemp(
              tempRoot,
              tempIdentity,
              directoryIdentities,
              hooks,
            );
      if (!cleanup.completed) {
        if (failure !== null && typeof failure === "object") {
          failure.cleanupCompleted = false;
          failure.cleanupPath = tempRoot;
          failure.cleanupReason = cleanup.reason;
        } else {
          fail(
            "BUNDLE_MATERIALIZE_CLEANUP",
            cleanup.reason,
            tempRoot,
          );
        }
      }
    }
  }
}

export async function materializeSherpaCandidateInputBundle(input) {
  return materializeSherpaCandidateInputBundleCore(
    input,
    PRODUCTION_MATERIALIZER_DEPENDENCIES,
  );
}

export async function __materializeSherpaCandidateInputBundleForTest(
  input,
  { hooks = PRODUCTION_HOOKS, publishDirectory = publishWindowsDirectoryNoReplace } = {},
) {
  return materializeSherpaCandidateInputBundleCore(input, {
    hooks,
    publishDirectory,
  });
}

export function __assertUsableIdentityForTest(stat) {
  assertUsableIdentity(
    stat,
    "BUNDLE_MATERIALIZE_IDENTITY_UNAVAILABLE",
    "filesystem identity is unavailable",
    "identity",
  );
}
