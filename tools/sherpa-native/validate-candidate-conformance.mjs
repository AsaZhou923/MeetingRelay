import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { encodeCanonicalJsonLine } from "../phase0-harness/canonical-json.mjs";
import { validateLockFile } from "./validate-lock.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(HERE, "../..");
const EXECUTION_HOST_FILE_NAME =
  process.platform === "win32"
    ? "meetingrelay-sherpa-candidate-execution-host.exe"
    : "meetingrelay-sherpa-candidate-execution-host";
const LOCKED_WORKER_ID = "meetingrelay-sherpa-native-candidate-host-v1";
const LOCKED_WAV_SHA256 =
  "b77f1794fe374a0ba1ee1dc458bfaf9349496cbbfc32780c50ba3c5a7ad8e373";
const MAX_RECORD_BYTES = 65_536;
const HOST_TIMEOUT_MS = 120_000;
const AMBIENT_HOST_ENV_KEYS = Object.freeze([
  "MEETINGRELAY_SHERPA_LOCK",
  "MEETINGRELAY_SHERPA_LOCK_SHA256",
  "MEETINGRELAY_SHERPA_PARAMETER_SHA256",
  "MEETINGRELAY_SHERPA_MODEL",
  "MEETINGRELAY_SHERPA_MODEL_SHA256",
  "MEETINGRELAY_SHERPA_TOKENS",
  "MEETINGRELAY_SHERPA_TOKENS_SHA256",
  "MEETINGRELAY_SHERPA_WAV",
  "RUST_BACKTRACE",
  "RUST_LIB_BACKTRACE",
  "SHERPA_ONNX_LIB_DIR",
]);
const ROOT_KEYS = Object.freeze([
  "authority",
  "checks",
  "execution",
  "kind",
  "limitations",
  "schema_version",
  "worker_manifest",
]);
const AUTHORITY_KEYS = Object.freeze(["formal_claims", "production_evidence"]);
const CHECK_KEYS = Object.freeze([
  "bounded_audio_gap",
  "bounded_credit_backpressure",
  "cancellation",
  "final_and_replay",
  "handshake_manifest",
  "heartbeat_progress",
  "loaded_runtime_identity",
  "prepare",
  "provenance_join",
  "restart_replay",
  "rust_panic_containment",
  "stable_failure",
]);
const EXECUTION_KEYS = Object.freeze([
  "actual_native_inference",
  "backend_execute_calls",
  "final_transcript_sha256",
  "final_transcript_utf8_bytes",
  "fixture_wav_sha256",
  "outer_process_boundary",
  "resource_performance_measurement",
  "semantic_transport",
]);
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
const LIMITATIONS = Object.freeze([
  "native-process-abort-isolation-not-tested",
  "onsite-quality-performance-not-measured",
  "resource-usage-not-measured",
]);

export class CandidateConformanceValidationError extends Error {
  constructor(code) {
    super(code);
    this.name = "CandidateConformanceValidationError";
    this.code = code;
  }
}

function fail(code) {
  throw new CandidateConformanceValidationError(code);
}

export function sanitizeCandidateHostEnvironment(
  environment = process.env,
  executableDirectory,
) {
  const blocked = new Set(AMBIENT_HOST_ENV_KEYS.map((key) => key.toUpperCase()));
  const sanitized = Object.fromEntries(
    Object.entries(environment).filter(([key]) => {
      const normalized = key.toUpperCase();
      return (
        !normalized.startsWith("MEETINGRELAY_SHERPA_") &&
        !blocked.has(normalized) &&
        (process.platform !== "win32" || normalized !== "PATH")
      );
    }),
  );
  if (process.platform === "win32") {
    const systemRoot = Object.entries(sanitized).find(
      ([key]) => key.toUpperCase() === "SYSTEMROOT",
    )?.[1];
    if (
      typeof executableDirectory !== "string" ||
      executableDirectory.length === 0 ||
      typeof systemRoot !== "string" ||
      !path.win32.isAbsolute(systemRoot)
    ) {
      fail("CONF_HOST_EXECUTION");
    }
    sanitized.PATH = [
      path.win32.resolve(executableDirectory),
      path.win32.join(systemRoot, "System32"),
    ].join(path.win32.delimiter);
  }
  return sanitized;
}

export function extractCandidateHostRecord(spawnResult) {
  if (
    spawnResult === null ||
    typeof spawnResult !== "object" ||
    spawnResult.error != null ||
    spawnResult.status !== 0 ||
    spawnResult.signal !== null ||
    !Buffer.isBuffer(spawnResult.stdout) ||
    spawnResult.stdout.length === 0 ||
    spawnResult.stdout.length > MAX_RECORD_BYTES ||
    !Buffer.isBuffer(spawnResult.stderr) ||
    spawnResult.stderr.length !== 0
  ) {
    fail("CONF_HOST_EXECUTION");
  }
  return spawnResult.stdout;
}

function assertExactKeys(value, expected, code) {
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

function assertDigest(value, code) {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value) ||
    value === "0".repeat(64)
  ) {
    fail(code);
  }
}

function parseCanonicalRecord(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_RECORD_BYTES) {
    fail("CONF_CANONICAL_JSON");
  }
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) {
    fail("CONF_CANONICAL_JSON");
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    fail("CONF_CANONICAL_JSON");
  }
  if (encodeCanonicalJsonLine(value) !== text) {
    fail("CONF_CANONICAL_JSON");
  }
  return value;
}

export function validateNativeCandidateConformanceRecord({
  descriptor,
  executableBytes,
  recordBytes,
  schemaRegistryBytes,
}) {
  if (!Buffer.isBuffer(executableBytes) || executableBytes.length === 0) {
    fail("CONF_EXECUTABLE_JOIN");
  }
  if (!Buffer.isBuffer(schemaRegistryBytes) || schemaRegistryBytes.length === 0) {
    fail("CONF_SCHEMA_JOIN");
  }
  const executableSha256 = createHash("sha256").update(executableBytes).digest("hex");
  const schemaRegistrySha256 = createHash("sha256").update(schemaRegistryBytes).digest("hex");
  assertDigest(executableSha256, "CONF_EXECUTABLE_JOIN");
  assertDigest(schemaRegistrySha256, "CONF_SCHEMA_JOIN");
  const record = parseCanonicalRecord(recordBytes);
  assertExactKeys(record, ROOT_KEYS, "CONF_SCHEMA_KEYS");
  assertExactKeys(record.authority, AUTHORITY_KEYS, "CONF_AUTHORITY");
  if (
    record.authority.formal_claims !== "none" ||
    record.authority.production_evidence !== false
  ) {
    fail("CONF_AUTHORITY");
  }
  assertExactKeys(record.checks, CHECK_KEYS, "CONF_CHECKS");
  if (CHECK_KEYS.some((key) => record.checks[key] !== true)) {
    fail("CONF_CHECKS");
  }
  assertExactKeys(record.execution, EXECUTION_KEYS, "CONF_EXECUTION");
  assertDigest(record.execution.final_transcript_sha256, "CONF_EXECUTION");
  assertDigest(record.execution.fixture_wav_sha256, "CONF_EXECUTION");
  if (
    record.execution.actual_native_inference !== true ||
    record.execution.backend_execute_calls !== 1 ||
    !Number.isSafeInteger(record.execution.final_transcript_utf8_bytes) ||
    record.execution.final_transcript_utf8_bytes <= 0 ||
    record.execution.fixture_wav_sha256 !== LOCKED_WAV_SHA256 ||
    record.execution.outer_process_boundary !== "crash-containment-only" ||
    record.execution.resource_performance_measurement !== "unmeasured" ||
    record.execution.semantic_transport !== "in-process"
  ) {
    fail("CONF_EXECUTION");
  }
  if (
    record.kind !== "meetingrelay-native-candidate-conformance-v1" ||
    record.schema_version !== "1.0" ||
    !isDeepStrictEqual(record.limitations, LIMITATIONS)
  ) {
    fail("CONF_SCOPE");
  }
  assertExactKeys(record.worker_manifest, MANIFEST_KEYS, "CONF_MANIFEST_KEYS");
  assertExactKeys(
    record.worker_manifest.descriptor,
    DESCRIPTOR_KEYS,
    "CONF_DESCRIPTOR_JOIN",
  );
  if (!isDeepStrictEqual(record.worker_manifest.descriptor, descriptor)) {
    fail("CONF_DESCRIPTOR_JOIN");
  }
  if (
    record.worker_manifest.executable_sha256 !== executableSha256 ||
    record.worker_manifest.worker_build_sha256 !== executableSha256
  ) {
    fail("CONF_EXECUTABLE_JOIN");
  }
  if (record.worker_manifest.schema_registry_sha256 !== schemaRegistrySha256) {
    fail("CONF_SCHEMA_JOIN");
  }
  if (
    record.worker_manifest.worker_id !== LOCKED_WORKER_ID ||
    record.worker_manifest.role !== "native-candidate"
  ) {
    fail("CONF_MANIFEST_IDENTITY");
  }
  return {
    executableSha256,
    finalTranscriptSha256: record.execution.final_transcript_sha256,
    finalTranscriptUtf8Bytes: record.execution.final_transcript_utf8_bytes,
    schemaRegistrySha256,
    workerId: record.worker_manifest.worker_id,
  };
}

async function assertRealPathChain(inputPath, code) {
  const resolved = path.resolve(inputPath);
  let current = resolved;
  while (true) {
    let metadata;
    try {
      metadata = await lstat(current);
    } catch {
      fail(code);
    }
    if (metadata.isSymbolicLink()) {
      fail(code);
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return resolved;
}

async function digestRegularFile(inputPath, code) {
  const resolved = await assertRealPathChain(inputPath, code);
  let metadata;
  try {
    metadata = await lstat(resolved);
  } catch {
    fail(code);
  }
  if (!metadata.isFile() || metadata.size <= 0 || !Number.isSafeInteger(metadata.size)) {
    fail(code);
  }
  const sha256 = await new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(resolved);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  }).catch(() => fail(code));
  return { resolved, sha256, sizeBytes: metadata.size };
}

function emitLockedDescriptor() {
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
      encoding: "utf8",
      env: { ...process.env, CARGO_TERM_COLOR: "never" },
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    },
  );
  if (result.error || result.status !== 0 || result.stderr !== "") {
    fail("CONF_BUILDER_DESCRIPTOR");
  }
  let input;
  try {
    input = JSON.parse(result.stdout);
  } catch {
    fail("CONF_BUILDER_DESCRIPTOR");
  }
  if (encodeCanonicalJsonLine(input) !== result.stdout) {
    fail("CONF_BUILDER_DESCRIPTOR");
  }
  assertExactKeys(input.worker_manifest_descriptor_fragment, DESCRIPTOR_KEYS, "CONF_BUILDER_DESCRIPTOR");
  return input.worker_manifest_descriptor_fragment;
}

function inventoryEntry(lock, relativePath, code) {
  const entry = lock.model.archive.inventory.find((value) => value.path === relativePath);
  if (entry === undefined) {
    fail(code);
  }
  return entry;
}

async function validateMaterial(inputPath, expected, code) {
  const material = await digestRegularFile(inputPath, code);
  if (material.sizeBytes !== expected.size_bytes || material.sha256 !== expected.sha256) {
    fail(code);
  }
  return material;
}

function lockedRuntimeDllEntries(lock, code) {
  const inventory = lock?.runtime?.archive?.inventory;
  if (!Array.isArray(inventory)) {
    fail(code);
  }
  const entries = inventory
    .filter(
      (entry) =>
        entry !== null &&
        typeof entry === "object" &&
        typeof entry.path === "string" &&
        entry.path.endsWith(".dll"),
    )
    .map((entry) => ({ ...entry, fileName: path.posix.basename(entry.path) }))
    .sort((left, right) => left.fileName.localeCompare(right.fileName, "en"));
  if (entries.length === 0) {
    fail(code);
  }
  const names = new Set();
  for (const entry of entries) {
    if (
      !entry.path.startsWith("lib/") ||
      entry.fileName.length === 0 ||
      names.has(entry.fileName.toUpperCase()) ||
      !Number.isSafeInteger(entry.size_bytes) ||
      entry.size_bytes <= 0
    ) {
      fail(code);
    }
    assertDigest(entry.sha256, code);
    names.add(entry.fileName.toUpperCase());
  }
  return entries;
}

export async function validateStagedRuntimeClosure(
  executablePath,
  lock,
  code = "CONF_STAGED_RUNTIME_JOIN",
) {
  const executable = await digestRegularFile(executablePath, code);
  const executableDirectory = path.dirname(executable.resolved);
  const entries = lockedRuntimeDllEntries(lock, code);
  const snapshot = [];
  for (const entry of entries) {
    const material = await validateMaterial(
      path.join(executableDirectory, entry.fileName),
      entry,
      code,
    );
    snapshot.push({
      fileName: entry.fileName,
      sha256: material.sha256,
      sizeBytes: material.sizeBytes,
    });
  }
  return snapshot;
}

async function validateRuntime(runtimeLibDir, lock) {
  const resolved = await assertRealPathChain(runtimeLibDir, "CONF_RUNTIME_JOIN");
  const metadata = await lstat(resolved);
  if (!metadata.isDirectory()) {
    fail("CONF_RUNTIME_JOIN");
  }
  const expected = lock.runtime.archive.inventory.map((entry) => ({
    ...entry,
    fileName: path.posix.basename(entry.path),
  }));
  const actualNames = (await readdir(resolved)).sort();
  const expectedNames = expected.map((entry) => entry.fileName).sort();
  if (!isDeepStrictEqual(actualNames, expectedNames)) {
    fail("CONF_RUNTIME_JOIN");
  }
  for (const entry of expected) {
    await validateMaterial(path.join(resolved, entry.fileName), entry, "CONF_RUNTIME_JOIN");
  }
  return resolved;
}

async function validateInputs(
  input,
  descriptor,
  stagedRuntimeCode = "CONF_STAGED_RUNTIME_JOIN",
) {
  let locked;
  try {
    locked = await validateLockFile(input.assetLockPath);
  } catch {
    fail("CONF_ASSET_LOCK_JOIN");
  }
  if (locked.lockSha256 !== descriptor.model_manifest_sha256) {
    fail("CONF_ASSET_LOCK_JOIN");
  }
  const schemaRegistry = await digestRegularFile(
    input.schemaRegistryPath,
    "CONF_SCHEMA_JOIN",
  );
  const committedSchema = await readFile(path.join(HERE, "candidate-schema-registry.json"));
  if (!(await readFile(schemaRegistry.resolved)).equals(committedSchema)) {
    fail("CONF_SCHEMA_JOIN");
  }
  const executable = await digestRegularFile(input.executablePath, "CONF_EXECUTABLE_JOIN");
  if (
    path.basename(executable.resolved) !== EXECUTION_HOST_FILE_NAME ||
    path.basename(path.dirname(executable.resolved)) !== "release"
  ) {
    fail("CONF_EXECUTABLE_IDENTITY");
  }
  const stagedRuntime = await validateStagedRuntimeClosure(
    executable.resolved,
    locked.lock,
    stagedRuntimeCode,
  );
  const packageLock = await digestRegularFile(input.packageLockPath, "CONF_PACKAGE_LOCK_JOIN");
  if (packageLock.sha256 !== descriptor.package_lock_sha256) {
    fail("CONF_PACKAGE_LOCK_JOIN");
  }
  const model = await validateMaterial(
    input.modelPath,
    inventoryEntry(locked.lock, locked.lock.entrypoints.model_relative_path, "CONF_MODEL_JOIN"),
    "CONF_MODEL_JOIN",
  );
  if (model.sha256 !== descriptor.model_sha256) {
    fail("CONF_MODEL_JOIN");
  }
  const tokens = await validateMaterial(
    input.tokensPath,
    inventoryEntry(locked.lock, locked.lock.entrypoints.tokens_relative_path, "CONF_TOKENS_JOIN"),
    "CONF_TOKENS_JOIN",
  );
  const wav = await validateMaterial(
    input.wavPath,
    inventoryEntry(locked.lock, locked.lock.entrypoints.smoke_wav_relative_path, "CONF_WAV_JOIN"),
    "CONF_WAV_JOIN",
  );
  if (wav.sha256 !== LOCKED_WAV_SHA256) {
    fail("CONF_WAV_JOIN");
  }
  const runtimeLibDir = await validateRuntime(input.runtimeLibDir, locked.lock);
  if (locked.lock.runtime.archive.bundle_sha256 !== descriptor.runtime_sha256) {
    fail("CONF_RUNTIME_JOIN");
  }
  return {
    assetLockPath: locked.lockPath,
    executable,
    model,
    packageLock,
    runtimeLibDir,
    schemaRegistry,
    stagedRuntime,
    tokens,
    wav,
  };
}

export async function runReleaseNativeCandidateConformance(input) {
  const descriptor = emitLockedDescriptor();
  const before = await validateInputs(input, descriptor);
  const lockedInputSnapshotBytes = Buffer.from(
    encodeCanonicalJsonLine({
      asset_lock_sha256: descriptor.model_manifest_sha256,
      cargo_lock_sha256: before.packageLock.sha256,
      model_sha256: before.model.sha256,
      parameter_sha256: descriptor.parameter_sha256,
      runtime_bundle_sha256: descriptor.runtime_sha256,
      schema_registry_sha256: before.schemaRegistry.sha256,
      tokens_sha256: before.tokens.sha256,
      wav_sha256: before.wav.sha256,
    }).slice(0, -1),
    "utf8",
  );
  const lockedInputSnapshotSha256 = createHash("sha256")
    .update(lockedInputSnapshotBytes)
    .digest("hex");
  const result = spawnSync(
    before.executable.resolved,
    [
      before.schemaRegistry.resolved,
      before.model.resolved,
      before.tokens.resolved,
      before.runtimeLibDir,
      before.assetLockPath,
      before.packageLock.resolved,
      before.wav.resolved,
    ],
    {
      cwd: REPOSITORY_ROOT,
      encoding: null,
      env: sanitizeCandidateHostEnvironment(
        process.env,
        path.dirname(before.executable.resolved),
      ),
      killSignal: "SIGKILL",
      maxBuffer: MAX_RECORD_BYTES,
      timeout: HOST_TIMEOUT_MS,
      windowsHide: true,
    },
  );
  const recordBytes = extractCandidateHostRecord(result);
  const validated = validateNativeCandidateConformanceRecord({
    descriptor,
    executableBytes: await readFile(before.executable.resolved),
    recordBytes,
    schemaRegistryBytes: await readFile(before.schemaRegistry.resolved),
  });
  const record = parseCanonicalRecord(recordBytes);
  const after = await validateInputs(input, descriptor, "CONF_POSTFLIGHT_JOIN");
  if (
    after.executable.sha256 !== before.executable.sha256 ||
    after.schemaRegistry.sha256 !== before.schemaRegistry.sha256 ||
    after.model.sha256 !== before.model.sha256 ||
    after.tokens.sha256 !== before.tokens.sha256 ||
    after.wav.sha256 !== before.wav.sha256 ||
    after.packageLock.sha256 !== before.packageLock.sha256 ||
    !isDeepStrictEqual(after.stagedRuntime, before.stagedRuntime)
  ) {
    fail("CONF_POSTFLIGHT_JOIN");
  }
  return {
    ...validated,
    backendExecuteCalls: record.execution.backend_execute_calls,
    checkSummary: {
      passed: CHECK_KEYS.filter((key) => record.checks[key] === true).length,
      total: CHECK_KEYS.length,
    },
    conformanceRecordSha256: createHash("sha256").update(recordBytes).digest("hex"),
    lockedInputSnapshotSha256,
  };
}

async function main(arguments_) {
  if (arguments_.length !== 8) {
    fail("CONF_USAGE");
  }
  const result = await runReleaseNativeCandidateConformance({
    executablePath: arguments_[0],
    schemaRegistryPath: arguments_[1],
    modelPath: arguments_[2],
    tokensPath: arguments_[3],
    runtimeLibDir: arguments_[4],
    assetLockPath: arguments_[5],
    packageLockPath: arguments_[6],
    wavPath: arguments_[7],
  });
  process.stdout.write(
    `candidate-native-conformance=verified worker_id=${result.workerId} ` +
      `executable_sha256=${result.executableSha256} ` +
      `schema_registry_sha256=${result.schemaRegistrySha256} ` +
      `final_transcript_sha256=${result.finalTranscriptSha256} ` +
      "formal_claims=none production_evidence=false\n",
  );
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(
      `${error instanceof CandidateConformanceValidationError ? error.code : "CONF_INTERNAL"}\n`,
    );
    process.exitCode = 1;
  });
}
