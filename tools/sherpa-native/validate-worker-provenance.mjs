import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

import {
  encodeCanonicalJson,
  encodeCanonicalJsonLine,
} from "../phase0-harness/canonical-json.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(HERE, "../..");
const MAX_SCHEMA_REGISTRY_BYTES = 65_536;
const LOCKED_WORKER_ID = "meetingrelay-sherpa-native-candidate-host-v1";
const MANIFEST_KEYS = Object.freeze([
  "descriptor",
  "executable_sha256",
  "role",
  "schema_registry_sha256",
  "worker_build_sha256",
  "worker_id",
]);
const DESCRIPTOR_KEYS = Object.freeze([
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
]);
const SCHEMA_REGISTRY_VALUE = Object.freeze({
  artifact_scope: "candidate-input",
  formal_claims: "none",
  schema_version: "1.0",
  schemas: ["meetingrelay.model-worker.v1"],
});

export const CANDIDATE_HOST_FILE_NAME =
  process.platform === "win32"
    ? "meetingrelay-sherpa-candidate-host.exe"
    : "meetingrelay-sherpa-candidate-host";
export const DEFAULT_SCHEMA_REGISTRY_PATH = path.join(
  HERE,
  "candidate-schema-registry.json",
);

export class WorkerProvenanceValidationError extends Error {
  constructor(code) {
    super(code);
    this.name = "WorkerProvenanceValidationError";
    this.code = code;
  }
}

function fail(code) {
  throw new WorkerProvenanceValidationError(code);
}

function assertExactKeys(value, expected, code = "PROV_SCHEMA_KEYS") {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(code);
  }
  const actual = Object.keys(value);
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    fail(code);
  }
}

function assertDigest(value) {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value) ||
    value === "0".repeat(64)
  ) {
    fail("PROV_DIGEST_FORMAT");
  }
}

async function assertRealPathChain(filePath) {
  const resolved = path.resolve(filePath);
  let current = resolved;
  while (true) {
    let metadata;
    try {
      metadata = await lstat(current);
    } catch {
      fail("PROV_FILE_NOT_REGULAR");
    }
    if (metadata.isSymbolicLink()) {
      fail("PROV_PATH_REPARSE");
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return resolved;
}

async function digestRegularFile(filePath, sizeLimit = null) {
  const resolved = await assertRealPathChain(filePath);
  const metadata = await lstat(resolved);
  if (!metadata.isFile() || metadata.size === 0) {
    fail("PROV_FILE_NOT_REGULAR");
  }
  if (sizeLimit !== null && metadata.size > sizeLimit) {
    fail("PROV_SCHEMA_SIZE");
  }
  const sha256 = await new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(resolved);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  }).catch(() => fail("PROV_FILE_NOT_REGULAR"));
  return { resolved, sha256, sizeBytes: metadata.size };
}

async function validateSchemaRegistry(schemaRegistryPath) {
  const material = await digestRegularFile(
    schemaRegistryPath,
    MAX_SCHEMA_REGISTRY_BYTES,
  );
  const actual = await readFile(material.resolved);
  const expected = await readFile(DEFAULT_SCHEMA_REGISTRY_PATH);
  let parsed;
  try {
    parsed = JSON.parse(actual.toString("utf8"));
  } catch {
    fail("PROV_SCHEMA_BYTES");
  }
  assertExactKeys(parsed, Object.keys(SCHEMA_REGISTRY_VALUE), "PROV_SCHEMA_BYTES");
  if (
    !actual.equals(expected) ||
    actual.toString("utf8") !== encodeCanonicalJson(SCHEMA_REGISTRY_VALUE) ||
    !isDeepStrictEqual(parsed, SCHEMA_REGISTRY_VALUE)
  ) {
    fail("PROV_SCHEMA_BYTES");
  }
  return material;
}

async function validateExecutable(executablePath) {
  const resolved = path.resolve(executablePath);
  if (path.basename(resolved) !== CANDIDATE_HOST_FILE_NAME) {
    fail("PROV_EXECUTABLE_IDENTITY");
  }
  if (path.basename(path.dirname(resolved)) !== "release") {
    fail("PROV_RELEASE_REQUIRED");
  }
  return digestRegularFile(resolved);
}

function parseCanonicalLine(bytes, code) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > 65_536) {
    fail(code);
  }
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) {
    fail(code);
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    fail(code);
  }
  if (encodeCanonicalJsonLine(value) !== text) {
    fail(code);
  }
  return value;
}

export async function validateWorkerProvenanceProjection({
  builderInputBytes,
  executablePath,
  projectionBytes,
  schemaRegistryPath,
}) {
  const executable = await validateExecutable(executablePath);
  const schemaRegistry = await validateSchemaRegistry(schemaRegistryPath);
  const projection = parseCanonicalLine(projectionBytes, "PROV_CANONICAL_JSON");
  const builderInput = parseCanonicalLine(builderInputBytes, "PROV_BUILDER_INPUT");
  assertExactKeys(projection, MANIFEST_KEYS);
  assertExactKeys(projection.descriptor, DESCRIPTOR_KEYS);
  assertExactKeys(
    builderInput.worker_manifest_descriptor_fragment,
    DESCRIPTOR_KEYS,
    "PROV_DESCRIPTOR_MISMATCH",
  );
  if (
    !isDeepStrictEqual(
      projection.descriptor,
      builderInput.worker_manifest_descriptor_fragment,
    )
  ) {
    fail("PROV_DESCRIPTOR_MISMATCH");
  }
  for (const digest of [
    projection.executable_sha256,
    projection.schema_registry_sha256,
    projection.worker_build_sha256,
  ]) {
    assertDigest(digest);
  }
  if (
    projection.executable_sha256 !== executable.sha256 ||
    projection.worker_build_sha256 !== executable.sha256
  ) {
    fail("PROV_EXECUTABLE_DIGEST");
  }
  if (projection.schema_registry_sha256 !== schemaRegistry.sha256) {
    fail("PROV_SCHEMA_DIGEST");
  }
  if (projection.role !== "native-candidate") {
    fail("PROV_ROLE");
  }
  if (
    projection.worker_id !== LOCKED_WORKER_ID ||
    !/^[A-Za-z0-9._-]+$/u.test(projection.worker_id)
  ) {
    fail("PROV_WORKER_ID");
  }

  const executablePostflight = await digestRegularFile(executable.resolved);
  const schemaPostflight = await validateSchemaRegistry(schemaRegistry.resolved);
  if (executablePostflight.sha256 !== executable.sha256) {
    fail("PROV_EXECUTABLE_DIGEST");
  }
  if (schemaPostflight.sha256 !== schemaRegistry.sha256) {
    fail("PROV_SCHEMA_DIGEST");
  }
  return {
    executableSha256: executable.sha256,
    schemaRegistrySha256: schemaRegistry.sha256,
    workerId: projection.worker_id,
  };
}

function emitCandidateBuilderInput() {
  const cargo = process.platform === "win32" ? "cargo.exe" : "cargo";
  const result = spawnSync(
    cargo,
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
      cwd: REPOSITORY_ROOT,
      encoding: null,
      env: { ...process.env, CARGO_TERM_COLOR: "never" },
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    },
  );
  if (result.error || result.status !== 0 || result.stderr.length !== 0) {
    fail("PROV_BUILDER_INPUT");
  }
  return result.stdout;
}

export async function runReleaseCandidateHost(
  executablePath,
  schemaRegistryPath = DEFAULT_SCHEMA_REGISTRY_PATH,
) {
  const executable = await validateExecutable(executablePath);
  const targetRoot = path.join(REPOSITORY_ROOT, "target");
  const relativeToTarget = path.relative(targetRoot, executable.resolved);
  if (
    relativeToTarget === "" ||
    relativeToTarget === ".." ||
    relativeToTarget.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeToTarget)
  ) {
    fail("PROV_EXECUTABLE_TARGET");
  }
  await validateSchemaRegistry(schemaRegistryPath);
  const result = spawnSync(executablePath, [schemaRegistryPath], {
    encoding: null,
    env: { ...process.env },
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
  if (result.error || result.status !== 0 || result.stderr.length !== 0) {
    fail("PROV_HOST_EXECUTION");
  }
  return validateWorkerProvenanceProjection({
    builderInputBytes: emitCandidateBuilderInput(),
    executablePath,
    projectionBytes: result.stdout,
    schemaRegistryPath,
  });
}

async function main(arguments_) {
  if (arguments_.length !== 2) {
    fail("PROV_USAGE");
  }
  const result = await runReleaseCandidateHost(arguments_[0], arguments_[1]);
  process.stdout.write(
    `candidate-host-provenance=verified worker_id=${result.workerId} ` +
      `executable_sha256=${result.executableSha256} ` +
      `schema_registry_sha256=${result.schemaRegistrySha256}\n`,
  );
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(
      `${error instanceof WorkerProvenanceValidationError ? error.code : "PROV_INTERNAL"}\n`,
    );
    process.exitCode = 1;
  });
}
