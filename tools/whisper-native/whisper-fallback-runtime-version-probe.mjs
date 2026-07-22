#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { TextDecoder } from "node:util";

import { encodeCanonicalJson } from "../phase0-harness/canonical-json.mjs";
import {
  MAX_CANDIDATE_FILE_BYTES,
  PUBLIC_EVIDENCE_SCHEMA_PATH as PREFLIGHT_SCHEMA_PATH,
  STREAM_CHUNK_BYTES,
  VALIDATOR_SOURCE_PATH as PREFLIGHT_SOURCE_PATH,
  createSyntheticFixture,
  preflightWhisperFallbackCandidate,
  sha256Hex,
  validateRelativePath,
} from "./whisper-fallback-candidate-preflight.mjs";

export { sha256Hex };
export const PUBLIC_EVIDENCE_KIND = "meetingrelay-whisper-fallback-runtime-version-probe-v1";
export const PUBLIC_EVIDENCE_SCHEMA_VERSION = "1.0";
export const MEASUREMENT_STATUS = "whisper-runtime-version-marker-path-observation-only";
export const EXECUTION_STATUS = "runtime-path-launched-fixed-version-marker-observed-no-model-no-transcription";
export const LAUNCH_BINDING_STATUS =
  "preflight-prespawn-postflight-path-identity-observed-spawn-reopen-window-not-eliminated";
export const FIXED_ARGS = Object.freeze(["--meetingrelay-whisper-runtime-version-probe-v1"]);
export const PUBLIC_EVIDENCE_SCHEMA_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "whisper-fallback-runtime-version-probe.schema.json",
);
export const VALIDATOR_SOURCE_PATH = fileURLToPath(import.meta.url);

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const SHA256_RE = /^[0-9a-f]{64}$/u;
const VERSION_RE = /^[0-9][0-9A-Za-z._+-]{0,63}$/u;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_STDOUT_BYTES = 4096;
const MAX_STDERR_BYTES = 4096;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_CLEANUP_TIMEOUT_MS = 2_000;
const BOUND_RUNTIME_STATE = new WeakMap();
const LIMITATIONS = Object.freeze([
  "whisper-runtime-version-marker-path-observation-only: observes the same manifest runtime path identity before, immediately before, and after a direct path-based launch with one fixed argument",
  "Node path-based process creation reopens the executable path after verification; the spawn reopen window is not eliminated and the loaded image is not attested",
  "the caller-provided executable marker is observed but its implementation semantics are not source-attested; no operating-system network isolation is established",
  "the probe does not select, download, load, validate, benchmark, rank, default, or distribute any Whisper model and does not process audio or produce transcription",
  "the fixed version marker is runtime plumbing evidence only; compatibility, fallback eligibility, quality, performance, resource use, and production readiness remain unassessed",
  "public evidence intentionally omits filesystem paths, file contents, stdout text, linked version text, secrets, environment values, timings, host identity, model names, package names, and transcript text",
]);
const FORBIDDEN_PUBLIC_KEYS = new Set([
  "absolute_path",
  "args",
  "audio",
  "audio_path",
  "content",
  "controlled_root",
  "cwd",
  "default",
  "distribution_approval",
  "env",
  "environment",
  "executable_path",
  "file_path",
  "linked_whisper_cpp_version",
  "model_name",
  "path",
  "plaintext",
  "rank",
  "root",
  "secret",
  "selection",
  "stderr",
  "stdout",
  "text",
  "threshold",
  "transcript",
  "version",
]);
const FORBIDDEN_PUBLIC_VALUE_RE =
  /(?:[A-Za-z]:\\|\\\\|\/tmp\/|\/home\/|\/Users\/|inputs\/|runtime(?:\.exe|\.bytes|\.bin)|ggml-|gguf|\.wav|\.mp3|\.flac|BEGIN (?:RSA |OPENSSH |)PRIVATE KEY|transcript\s)/iu;

export class RuntimeVersionProbeError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "RuntimeVersionProbeError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new RuntimeVersionProbeError(code, message);
}

function assertPlainObject(value, code, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(code, `${label} must be an object`);
}

function assertAllowedKeys(value, allowed, code, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(code, `${label} has unknown field ${key}`);
  }
}

function assertSha256(value, code, label) {
  if (typeof value !== "string" || !SHA256_RE.test(value) || value === "0".repeat(64)) {
    fail(code, `${label} must be non-zero lowercase sha256 hex`);
  }
}

function rejectUnsafeLocalPath(inputPath, code, label, options = {}) {
  if (typeof inputPath !== "string" || inputPath.length === 0) fail(code, `${label} must be a non-empty local path`);
  const parsed = path.win32.parse(inputPath);
  const colonIndexes = [...inputPath.matchAll(/:/gu)].map((match) => match.index);
  const hasOnlyAbsoluteDriveColon =
    colonIndexes.length === 1 &&
    colonIndexes[0] === 1 &&
    parsed.root.length === 3 &&
    /^[A-Za-z]:[\\/]/u.test(inputPath);
  if (
    inputPath.startsWith("\\\\") ||
    inputPath.startsWith("//") ||
    /^\\\\[.?]\\|^\/\/[.?]\//u.test(inputPath) ||
    /^[A-Za-z]:(?![\\/])/u.test(inputPath) ||
    (colonIndexes.length > 0 && !hasOnlyAbsoluteDriveColon) ||
    inputPath.includes("\0") ||
    /[\r\n]/u.test(inputPath) ||
    (options.pathListElement === true && inputPath.includes(path.delimiter)) ||
    (options.absolute === true && !path.isAbsolute(inputPath))
  ) {
    fail(code, `${label} must be local path syntax, not UNC/device/drive-relative/ADS syntax`);
  }
  return path.resolve(inputPath);
}

export function pathsEqualForPlatform(left, right, platform = process.platform) {
  const leftResolved = path.resolve(left);
  const rightResolved = path.resolve(right);
  return platform === "win32" ? leftResolved.toLowerCase() === rightResolved.toLowerCase() : leftResolved === rightResolved;
}

function identityFromStat(value) {
  return {
    birthtimeNs: value.birthtimeNs,
    ctimeNs: value.ctimeNs,
    dev: value.dev,
    ino: value.ino,
    mode: value.mode,
    mtimeNs: value.mtimeNs,
    size: value.size,
  };
}

function sameFileIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.birthtimeNs === right.birthtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.mode === right.mode &&
    left.mtimeNs === right.mtimeNs &&
    left.size === right.size
  );
}

async function assertPathChainHasNoLinks(absolutePath) {
  const resolved = path.resolve(absolutePath);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  const relative = path.relative(parsed.root, resolved);
  const segments = relative === "" ? [] : relative.split(path.sep);
  for (const segment of segments) {
    current = path.join(current, segment);
    const link = await lstat(current, { bigint: true }).catch((error) => fail("WHISPER_RUNTIME_PROBE_FILE_OPEN", error.message));
    if (link.isSymbolicLink() || (!link.isFile() && !link.isDirectory())) {
      fail("WHISPER_RUNTIME_PROBE_SPECIAL_FILE", "path chain must not contain a symlink, junction, or special file");
    }
  }
}

function resolveInsideRoot(controlledRoot, relativePath) {
  validateRelativePath(relativePath);
  const root = path.resolve(controlledRoot);
  const absolute = path.resolve(root, ...relativePath.split("/"));
  const rootPrefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  const comparableAbsolute = process.platform === "win32" ? absolute.toLowerCase() : absolute;
  const comparableRootPrefix = process.platform === "win32" ? rootPrefix.toLowerCase() : rootPrefix;
  if (!pathsEqualForPlatform(absolute, root) && !comparableAbsolute.startsWith(comparableRootPrefix)) {
    fail("WHISPER_RUNTIME_PROBE_ROOT_ESCAPE", "relative_path escaped controlled root");
  }
  return absolute;
}

async function readBoundedCanonicalJson(filePath, code, label, maxBytes = MAX_MANIFEST_BYTES) {
  const absolute = rejectUnsafeLocalPath(filePath, code, label);
  await assertPathChainHasNoLinks(absolute);
  const handle = await open(absolute, "r").catch((error) => fail(code, error.message));
  try {
    const fileStat = await handle.stat({ bigint: true });
    if (!fileStat.isFile() || fileStat.size <= 0n || fileStat.size > BigInt(maxBytes)) fail(code, `${label} must be a bounded regular file`);
    const bytes = await handle.readFile();
    let text;
    try {
      text = UTF8_DECODER.decode(bytes);
    } catch (error) {
      fail(code, `${label} must be strict UTF-8: ${error.message}`);
    }
    if (!Buffer.from(text, "utf8").equals(bytes) || text.includes("\r") || !text.endsWith("\n")) {
      fail(code, `${label} must be UTF-8 canonical JSON with LF`);
    }
    const parsed = JSON.parse(text);
    if (encodeCanonicalJson(parsed) !== text) fail(code, `${label} must be canonical indented JSON with one terminal LF`);
    return { absolute, bytes, parsed, sha256: sha256Hex(bytes) };
  } finally {
    await handle.close();
  }
}

async function hashRegularFileNoLinks(filePath, expected = undefined, options = {}) {
  const absolute = path.resolve(filePath);
  await assertPathChainHasNoLinks(absolute);
  const beforeLink = await lstat(absolute, { bigint: true }).catch((error) => fail("WHISPER_RUNTIME_PROBE_FILE_OPEN", error.message));
  if (!beforeLink.isFile() || beforeLink.isSymbolicLink()) fail("WHISPER_RUNTIME_PROBE_SPECIAL_FILE", "runtime must be a regular file");
  const before = await stat(absolute, { bigint: true });
  if (before.nlink !== 1n) fail("WHISPER_RUNTIME_PROBE_SPECIAL_FILE", "runtime must have exactly one hardlink");
  await options.beforeOpenForTest?.(absolute);
  const handle = await open(absolute, "r").catch((error) => fail("WHISPER_RUNTIME_PROBE_FILE_OPEN", error.message));
  try {
    const current = await handle.stat({ bigint: true });
    if (!current.isFile() || current.nlink !== 1n) fail("WHISPER_RUNTIME_PROBE_SPECIAL_FILE", "runtime handle must be a regular single-link file");
    const currentSize = Number(current.size);
    if (!Number.isSafeInteger(currentSize) || currentSize < 1 || currentSize > MAX_CANDIDATE_FILE_BYTES) {
      fail("WHISPER_RUNTIME_PROBE_SIZE", "runtime size is empty, unsafe, or exceeds the preflight per-file limit");
    }
    const beforeIdentity = identityFromStat(before);
    const currentIdentity = identityFromStat(current);
    if (!sameFileIdentity(beforeIdentity, currentIdentity)) fail("WHISPER_RUNTIME_PROBE_RUNTIME_DRIFT", "runtime identity drifted while opening");
    await options.afterOpenForTest?.(absolute);
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(Math.min(STREAM_CHUNK_BYTES, currentSize));
    let total = 0;
    while (total < currentSize) {
      const requested = Math.min(chunk.length, currentSize - total);
      const { bytesRead } = await handle.read(chunk, 0, requested, total);
      if (bytesRead === 0) break;
      hash.update(chunk.subarray(0, bytesRead));
      total += bytesRead;
    }
    const afterHandle = await handle.stat({ bigint: true });
    const afterLink = await lstat(absolute, { bigint: true }).catch((error) => fail("WHISPER_RUNTIME_PROBE_FILE_OPEN", error.message));
    if (!afterLink.isFile() || afterLink.isSymbolicLink() || afterLink.nlink !== 1n || afterHandle.nlink !== 1n) {
      fail("WHISPER_RUNTIME_PROBE_SPECIAL_FILE", "runtime path or handle changed to a link or special file");
    }
    const afterHandleIdentity = identityFromStat(afterHandle);
    const afterPathIdentity = identityFromStat(afterLink);
    if (!sameFileIdentity(currentIdentity, afterHandleIdentity) || !sameFileIdentity(currentIdentity, afterPathIdentity)) {
      fail("WHISPER_RUNTIME_PROBE_RUNTIME_DRIFT", "runtime identity drifted during read");
    }
    await assertPathChainHasNoLinks(absolute);
    if (total !== currentSize) fail("WHISPER_RUNTIME_PROBE_RUNTIME_DRIFT", "runtime byte count drifted during streaming read");
    const observed = { size_bytes: total, sha256: hash.digest("hex"), file_identity: currentIdentity };
    if (
      expected !== undefined &&
      (observed.size_bytes !== expected.size_bytes ||
        observed.sha256 !== expected.sha256 ||
        (expected.file_identity !== undefined && !sameFileIdentity(observed.file_identity, expected.file_identity)))
    ) {
      fail("WHISPER_RUNTIME_PROBE_RUNTIME_DRIFT", "runtime size, hash, or identity drifted");
    }
    return observed;
  } finally {
    await handle.close();
  }
}

function minimalEnv(executablePath) {
  const executableDirectory = rejectUnsafeLocalPath(path.dirname(executablePath), "WHISPER_RUNTIME_PROBE_ENV", "runtime directory", {
    absolute: true,
    pathListElement: true,
  });
  if (process.platform === "win32") {
    const systemRoot = rejectUnsafeLocalPath(process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows", "WHISPER_RUNTIME_PROBE_ENV", "SystemRoot", {
      absolute: true,
      pathListElement: true,
    });
    return { SystemRoot: systemRoot, WINDIR: systemRoot, PATH: `${executableDirectory};${systemRoot}\\System32` };
  }
  return { PATH: `${executableDirectory}:/usr/bin:/bin` };
}

function collectBounded(stream, maxBytes, label, reject) {
  const chunks = [];
  let total = 0;
  let collecting = true;
  stream.on("data", (chunk) => {
    if (!collecting) return;
    total += chunk.length;
    if (total > maxBytes) {
      collecting = false;
      reject(new RuntimeVersionProbeError(`${label}_OVERFLOW`, `${label} exceeded bounded collection limit`));
      return;
    }
    chunks.push(chunk);
  });
  return {
    stop: () => {
      collecting = false;
    },
    read: () => Buffer.concat(chunks),
  };
}

function assertBoundRuntime(token) {
  if (token === null || typeof token !== "object" || !BOUND_RUNTIME_STATE.has(token)) {
    fail("WHISPER_RUNTIME_PROBE_UNBOUND_RUNTIME", "runtime probe requires a bound manifest runtime token");
  }
  return BOUND_RUNTIME_STATE.get(token);
}

export async function bindExactManifestRuntime(controlledRoot, inputManifestPath, executablePath, expectedAggregateSha256, options = {}) {
  assertSha256(expectedAggregateSha256, "WHISPER_RUNTIME_PROBE_AGGREGATE", "expected candidate aggregate");
  const root = rejectUnsafeLocalPath(controlledRoot, "WHISPER_RUNTIME_PROBE_ROOT", "controlled root", { absolute: true });
  const executable = rejectUnsafeLocalPath(executablePath, "WHISPER_RUNTIME_PROBE_EXECUTABLE", "probe executable", { absolute: true });
  await assertPathChainHasNoLinks(root);
  const rootStat = await lstat(root, { bigint: true }).catch((error) => fail("WHISPER_RUNTIME_PROBE_ROOT", error.message));
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail("WHISPER_RUNTIME_PROBE_ROOT", "controlled root must be a directory");
  const preflightEvidence = await preflightWhisperFallbackCandidate(root, inputManifestPath);
  if (preflightEvidence.candidate_descriptor.aggregate_sha256 !== expectedAggregateSha256) {
    fail("WHISPER_RUNTIME_PROBE_AGGREGATE", "expected candidate aggregate did not match preflight evidence");
  }
  const reread = await readBoundedCanonicalJson(inputManifestPath, "WHISPER_RUNTIME_PROBE_MANIFEST", "input manifest");
  if (reread.sha256 !== preflightEvidence.canonical_input_manifest_sha256) fail("WHISPER_RUNTIME_PROBE_MANIFEST_DRIFT", "canonical manifest changed after preflight");
  const runtimeManifest = reread.parsed.files.find((entry) => entry.role === "runtime");
  if (!runtimeManifest) fail("WHISPER_RUNTIME_PROBE_MANIFEST", "runtime role missing");
  const runtimeAbsolute = resolveInsideRoot(root, runtimeManifest.relative_path);
  if (!pathsEqualForPlatform(executable, runtimeAbsolute)) fail("WHISPER_RUNTIME_PROBE_EXECUTABLE_MISMATCH", "explicit executable must be the manifest runtime file");
  const [runtimeReal, executableReal] = await Promise.all([realpath(runtimeAbsolute), realpath(executable)]).catch((error) =>
    fail("WHISPER_RUNTIME_PROBE_EXECUTABLE", error.message),
  );
  if (!pathsEqualForPlatform(runtimeReal, executableReal)) fail("WHISPER_RUNTIME_PROBE_EXECUTABLE_MISMATCH", "explicit executable must resolve to the manifest runtime file");
  const runtimeBefore = await hashRegularFileNoLinks(
    runtimeAbsolute,
    { size_bytes: runtimeManifest.size_bytes, sha256: runtimeManifest.sha256 },
    { afterOpenForTest: options.afterRuntimeOpenForTest, beforeOpenForTest: options.beforeRuntimeOpenForTest },
  );
  const token = Object.freeze(Object.create(null));
  BOUND_RUNTIME_STATE.set(token, {
    root,
    root_stat: rootStat,
    runtime_absolute: runtimeAbsolute,
    runtime_manifest: runtimeManifest,
    runtime_before: runtimeBefore,
    canonical_manifest_sha256: reread.sha256,
    preflight_evidence: preflightEvidence,
    candidate_aggregate_sha256: expectedAggregateSha256,
  });
  return token;
}

async function runFixedVersionProbe(boundRuntime, options = {}) {
  const bound = assertBoundRuntime(boundRuntime);
  await options.beforePreSpawnCheckForTest?.(bound.runtime_absolute);
  const preSpawn = await hashRegularFileNoLinks(bound.runtime_absolute, bound.runtime_before);
  if (!sameFileIdentity(preSpawn.file_identity, bound.runtime_before.file_identity)) {
    fail("WHISPER_RUNTIME_PROBE_RUNTIME_DRIFT", "runtime identity drifted immediately before path-based spawn");
  }
  const spawnOptions = {
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
    windowsHide: true,
    detached: false,
    cwd: bound.root,
    env: minimalEnv(bound.runtime_absolute),
  };
  await options.afterPreSpawnCheckForTest?.(bound.runtime_absolute);
  const child = (options.spawnImpl ?? spawn)(bound.runtime_absolute, [...FIXED_ARGS], spawnOptions);
  let failureError;
  let exitResult = { code: null, signal: null };
  let closed = false;
  let signalFailure;
  const failureSignal = new Promise((resolveFailure) => {
    signalFailure = resolveFailure;
  });
  const failChild = (error) => {
    if (!failureError) {
      failureError = error;
      if (!child.killed) child.kill();
      signalFailure();
    }
  };
  const stdoutBuffer = collectBounded(child.stdout, options.maxStdoutBytes ?? MAX_STDOUT_BYTES, "WHISPER_RUNTIME_PROBE_STDOUT", failChild);
  const stderrBuffer = collectBounded(child.stderr, options.maxStderrBytes ?? MAX_STDERR_BYTES, "WHISPER_RUNTIME_PROBE_STDERR", failChild);
  const close = new Promise((resolveClose) => {
    child.on("error", (error) => failChild(new RuntimeVersionProbeError("WHISPER_RUNTIME_PROBE_SPAWN_FAILED", error.message)));
    child.on("exit", (code, signal) => {
      exitResult = { code, signal };
    });
    child.on("close", () => {
      closed = true;
      resolveClose();
    });
  });
  const timer = setTimeout(() => failChild(new RuntimeVersionProbeError("WHISPER_RUNTIME_PROBE_TIMEOUT", "fixed runtime probe exceeded timeout")), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    await Promise.race([close, failureSignal]);
  } finally {
    clearTimeout(timer);
    stdoutBuffer.stop();
    stderrBuffer.stop();
    if (!closed && !child.killed) child.kill();
    if (!closed) {
      const cleanupCompleted = await Promise.race([
        close.then(() => true),
        new Promise((resolveDelay) => setTimeout(() => resolveDelay(false), options.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS)),
      ]);
      if (cleanupCompleted !== true) fail("WHISPER_RUNTIME_PROBE_DIRECT_CHILD_CLOSE_TIMEOUT", "direct child did not close within bounded cleanup");
    }
  }
  if (failureError) throw failureError;
  const stderr = stderrBuffer.read();
  if (stderr.length !== 0) fail("WHISPER_RUNTIME_PROBE_STDERR_NONEMPTY", "fixed runtime probe stderr must be empty");
  if (exitResult.code !== 0 || exitResult.signal !== null) fail("WHISPER_RUNTIME_PROBE_NONZERO_EXIT", "fixed runtime probe must exit cleanly");
  const stdout = stdoutBuffer.read();
  let stdoutText;
  try {
    stdoutText = UTF8_DECODER.decode(stdout);
  } catch {
    fail("WHISPER_RUNTIME_PROBE_STDOUT", "stdout must be strict UTF-8");
  }
  const match = /^meetingrelay-whisper-runtime-version-probe-v1 linked_whisper_cpp_version=([0-9][0-9A-Za-z._+-]{0,63}) measurement_status=whisper-runtime-version-marker-path-observation-only execution_status=runtime-path-launched-fixed-version-marker-observed-no-model-no-transcription quality_gate_status=not-assessed formal_claims=none production_evidence=false public_distribution=false selection_authority=none fallback_authority=none loaded_image_attestation=false network_isolation_authority=none\r?\n$/u.exec(stdoutText);
  if (!match || !VERSION_RE.test(match[1])) fail("WHISPER_RUNTIME_PROBE_STDOUT_AMBIGUOUS", "runtime probe stdout marker must be exact and unique");
  return {
    linkedVersion: match[1],
    stdoutSha256: sha256Hex(stdout),
    processContract: {
      shell: spawnOptions.shell,
      windowsHide: spawnOptions.windowsHide,
      detached: spawnOptions.detached,
      cwd_is_controlled_root: true,
      minimal_environment: true,
      root_before_after_identity_match: true,
      path_entries: spawnOptions.env.PATH.split(process.platform === "win32" ? ";" : ":").length,
      proxy_environment_forwarded: false,
      direct_child_closed: true,
      spawn_path_reopen_window_eliminated: false,
    },
  };
}

async function postflightExactRuntimeRootIdentity(boundRuntime) {
  const bound = assertBoundRuntime(boundRuntime);
  const rootAfter = await lstat(bound.root, { bigint: true }).catch((error) => fail("WHISPER_RUNTIME_PROBE_ROOT", error.message));
  if (
    bound.root_stat.dev !== rootAfter.dev ||
    bound.root_stat.ino !== rootAfter.ino ||
    bound.root_stat.birthtimeNs !== rootAfter.birthtimeNs ||
    !rootAfter.isDirectory() ||
    rootAfter.isSymbolicLink()
  ) {
    fail("WHISPER_RUNTIME_PROBE_ROOT_DRIFT", "controlled root identity drifted during fixed probe");
  }
  const runtimeAfter = await hashRegularFileNoLinks(bound.runtime_absolute, bound.runtime_before);
  return {
    root_before_after_identity_match: true,
    runtime_before_after_identity_match:
      bound.runtime_before.size_bytes === runtimeAfter.size_bytes &&
      bound.runtime_before.sha256 === runtimeAfter.sha256 &&
      sameFileIdentity(bound.runtime_before.file_identity, runtimeAfter.file_identity),
  };
}

export async function probeWhisperFallbackRuntimeVersion(controlledRoot, inputManifestPath, executablePath, expectedAggregateSha256, options = {}) {
  const bound = await bindExactManifestRuntime(controlledRoot, inputManifestPath, executablePath, expectedAggregateSha256, options);
  const probeRun = await runFixedVersionProbe(bound, options);
  const postflight = await postflightExactRuntimeRootIdentity(bound);
  const boundState = assertBoundRuntime(bound);
  const schemaBytes = await readFile(PUBLIC_EVIDENCE_SCHEMA_PATH);
  JSON.parse(schemaBytes.toString("utf8"));
  const validatorBytes = await readFile(VALIDATOR_SOURCE_PATH);
  const preflightEvidence = boundState.preflight_evidence;
  const evidence = {
    kind: PUBLIC_EVIDENCE_KIND,
    schema_version: PUBLIC_EVIDENCE_SCHEMA_VERSION,
    schema_file_sha256: sha256Hex(schemaBytes),
    validator_source_sha256: sha256Hex(validatorBytes),
    preflight_schema_sha256: sha256Hex(readFileSync(PREFLIGHT_SCHEMA_PATH)),
    preflight_validator_source_sha256: sha256Hex(readFileSync(PREFLIGHT_SOURCE_PATH)),
    preflight_evidence_sha256: sha256Hex(Buffer.from(encodeCanonicalJson(preflightEvidence), "utf8")),
    canonical_input_manifest_sha256: preflightEvidence.canonical_input_manifest_sha256,
    candidate_aggregate_sha256: expectedAggregateSha256,
    measurement_status: MEASUREMENT_STATUS,
    execution_status: EXECUTION_STATUS,
    quality_gate_status: "not-assessed",
    formal_claims: "none",
    production_evidence: false,
    public_distribution: false,
    selection_authority: "none",
    fallback_authority: "none",
    launch_binding_status: LAUNCH_BINDING_STATUS,
    loaded_image_attestation: false,
    network_isolation_authority: "none",
    worker_role: "whisper-fallback-candidate",
    runtime: {
      role: "runtime",
      logical_id_sha256: sha256Hex(Buffer.from(boundState.runtime_manifest.logical_id, "utf8")),
      size_bytes: boundState.runtime_before.size_bytes,
      sha256: boundState.runtime_before.sha256,
      before_after_identity_match: postflight.runtime_before_after_identity_match,
    },
    probe: {
      fixed_argument_count: FIXED_ARGS.length,
      fixed_arguments_sha256: sha256Hex(Buffer.from(encodeCanonicalJson(FIXED_ARGS), "utf8")),
      stdout_marker_sha256: probeRun.stdoutSha256,
      linked_version_sha256: sha256Hex(Buffer.from(probeRun.linkedVersion, "utf8")),
    },
    process_contract: probeRun.processContract,
    limitations: [...LIMITATIONS],
  };
  validatePublicEvidence(evidence);
  return evidence;
}

export function scanForbiddenPublicEvidence(value, pathSegments = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanForbiddenPublicEvidence(item, [...pathSegments, String(index)]));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (FORBIDDEN_PUBLIC_KEYS.has(key)) fail("WHISPER_RUNTIME_PROBE_EVIDENCE_FORBIDDEN", `forbidden public evidence key ${[...pathSegments, key].join(".")}`);
      scanForbiddenPublicEvidence(item, [...pathSegments, key]);
    }
    return;
  }
  if (typeof value === "string") {
    if (LIMITATIONS.includes(value)) return;
    if (FORBIDDEN_PUBLIC_VALUE_RE.test(value)) fail("WHISPER_RUNTIME_PROBE_EVIDENCE_FORBIDDEN", `forbidden public evidence value at ${pathSegments.join(".")}`);
  }
}

export function validatePublicEvidence(evidence) {
  assertPlainObject(evidence, "WHISPER_RUNTIME_PROBE_EVIDENCE_SCHEMA", "evidence");
  assertAllowedKeys(
    evidence,
    new Set([
      "kind",
      "schema_version",
      "schema_file_sha256",
      "validator_source_sha256",
      "preflight_schema_sha256",
      "preflight_validator_source_sha256",
      "preflight_evidence_sha256",
      "canonical_input_manifest_sha256",
      "candidate_aggregate_sha256",
      "measurement_status",
      "execution_status",
      "quality_gate_status",
      "formal_claims",
      "production_evidence",
      "public_distribution",
      "selection_authority",
      "fallback_authority",
      "launch_binding_status",
      "loaded_image_attestation",
      "network_isolation_authority",
      "worker_role",
      "runtime",
      "probe",
      "process_contract",
      "limitations",
    ]),
    "WHISPER_RUNTIME_PROBE_EVIDENCE_SCHEMA",
    "evidence",
  );
  if (evidence.kind !== PUBLIC_EVIDENCE_KIND || evidence.schema_version !== PUBLIC_EVIDENCE_SCHEMA_VERSION) fail("WHISPER_RUNTIME_PROBE_EVIDENCE_SCHEMA", "bad evidence identity");
  for (const key of [
    "schema_file_sha256",
    "validator_source_sha256",
    "preflight_schema_sha256",
    "preflight_validator_source_sha256",
    "preflight_evidence_sha256",
    "canonical_input_manifest_sha256",
    "candidate_aggregate_sha256",
  ]) {
    assertSha256(evidence[key], "WHISPER_RUNTIME_PROBE_EVIDENCE_SCHEMA", key);
  }
  if (
    evidence.schema_file_sha256 !== sha256Hex(readFileSync(PUBLIC_EVIDENCE_SCHEMA_PATH)) ||
    evidence.validator_source_sha256 !== sha256Hex(readFileSync(VALIDATOR_SOURCE_PATH)) ||
    evidence.preflight_schema_sha256 !== sha256Hex(readFileSync(PREFLIGHT_SCHEMA_PATH)) ||
    evidence.preflight_validator_source_sha256 !== sha256Hex(readFileSync(PREFLIGHT_SOURCE_PATH))
  ) {
    fail("WHISPER_RUNTIME_PROBE_EVIDENCE_SCHEMA", "schema or validator digest mismatch");
  }
  if (
    evidence.measurement_status !== MEASUREMENT_STATUS ||
    evidence.execution_status !== EXECUTION_STATUS ||
    evidence.quality_gate_status !== "not-assessed" ||
    evidence.formal_claims !== "none" ||
    evidence.production_evidence !== false ||
    evidence.public_distribution !== false ||
    evidence.selection_authority !== "none" ||
    evidence.fallback_authority !== "none" ||
    evidence.launch_binding_status !== LAUNCH_BINDING_STATUS ||
    evidence.loaded_image_attestation !== false ||
    evidence.network_isolation_authority !== "none" ||
    evidence.worker_role !== "whisper-fallback-candidate"
  ) {
    fail("WHISPER_RUNTIME_PROBE_EVIDENCE_OVERCLAIM", "evidence authority fields overclaim");
  }
  assertPlainObject(evidence.runtime, "WHISPER_RUNTIME_PROBE_EVIDENCE_SCHEMA", "runtime");
  assertAllowedKeys(evidence.runtime, new Set(["role", "logical_id_sha256", "size_bytes", "sha256", "before_after_identity_match"]), "WHISPER_RUNTIME_PROBE_EVIDENCE_SCHEMA", "runtime");
  if (evidence.runtime.role !== "runtime" || evidence.runtime.before_after_identity_match !== true) fail("WHISPER_RUNTIME_PROBE_EVIDENCE_SCHEMA", "runtime identity mismatch");
  assertSha256(evidence.runtime.logical_id_sha256, "WHISPER_RUNTIME_PROBE_EVIDENCE_SCHEMA", "runtime.logical_id_sha256");
  assertSha256(evidence.runtime.sha256, "WHISPER_RUNTIME_PROBE_EVIDENCE_SCHEMA", "runtime.sha256");
  if (
    !Number.isSafeInteger(evidence.runtime.size_bytes) ||
    evidence.runtime.size_bytes < 1 ||
    evidence.runtime.size_bytes > MAX_CANDIDATE_FILE_BYTES
  ) {
    fail("WHISPER_RUNTIME_PROBE_EVIDENCE_SCHEMA", "runtime.size_bytes must stay within the 5b per-file limit");
  }
  assertPlainObject(evidence.probe, "WHISPER_RUNTIME_PROBE_EVIDENCE_SCHEMA", "probe");
  assertAllowedKeys(evidence.probe, new Set(["fixed_argument_count", "fixed_arguments_sha256", "stdout_marker_sha256", "linked_version_sha256"]), "WHISPER_RUNTIME_PROBE_EVIDENCE_SCHEMA", "probe");
  if (evidence.probe.fixed_argument_count !== 1 || evidence.probe.fixed_arguments_sha256 !== sha256Hex(Buffer.from(encodeCanonicalJson(FIXED_ARGS), "utf8"))) {
    fail("WHISPER_RUNTIME_PROBE_EVIDENCE_SCHEMA", "fixed argument contract mismatch");
  }
  assertSha256(evidence.probe.stdout_marker_sha256, "WHISPER_RUNTIME_PROBE_EVIDENCE_SCHEMA", "probe.stdout_marker_sha256");
  assertSha256(evidence.probe.linked_version_sha256, "WHISPER_RUNTIME_PROBE_EVIDENCE_SCHEMA", "probe.linked_version_sha256");
  assertPlainObject(evidence.process_contract, "WHISPER_RUNTIME_PROBE_EVIDENCE_SCHEMA", "process_contract");
  assertAllowedKeys(
    evidence.process_contract,
    new Set([
      "shell",
      "windowsHide",
      "detached",
      "cwd_is_controlled_root",
      "minimal_environment",
      "root_before_after_identity_match",
      "path_entries",
      "proxy_environment_forwarded",
      "direct_child_closed",
      "spawn_path_reopen_window_eliminated",
    ]),
    "WHISPER_RUNTIME_PROBE_EVIDENCE_SCHEMA",
    "process_contract",
  );
  if (
    evidence.process_contract.shell !== false ||
    evidence.process_contract.windowsHide !== true ||
    evidence.process_contract.detached !== false ||
    evidence.process_contract.cwd_is_controlled_root !== true ||
    evidence.process_contract.minimal_environment !== true ||
    evidence.process_contract.root_before_after_identity_match !== true ||
    evidence.process_contract.proxy_environment_forwarded !== false ||
    evidence.process_contract.direct_child_closed !== true ||
    evidence.process_contract.spawn_path_reopen_window_eliminated !== false ||
    !Number.isInteger(evidence.process_contract.path_entries) ||
    evidence.process_contract.path_entries < 1 ||
    evidence.process_contract.path_entries > 3
  ) {
    fail("WHISPER_RUNTIME_PROBE_EVIDENCE_SCHEMA", "process contract mismatch");
  }
  if (!Array.isArray(evidence.limitations) || evidence.limitations.length !== LIMITATIONS.length) fail("WHISPER_RUNTIME_PROBE_EVIDENCE_SCHEMA", "limitations must be exact");
  for (const [index, limitation] of LIMITATIONS.entries()) {
    if (evidence.limitations[index] !== limitation) fail("WHISPER_RUNTIME_PROBE_EVIDENCE_SCHEMA", "limitation mismatch");
  }
  scanForbiddenPublicEvidence(evidence);
  return true;
}

async function writeSyntheticProbe(root) {
  const relativePath = process.platform === "win32" ? "inputs/runtime-probe.cmd" : "inputs/runtime-probe.sh";
  const absolute = path.join(root, ...relativePath.split("/"));
  await mkdir(path.dirname(absolute), { recursive: true });
  const body =
    process.platform === "win32"
      ? "@echo off\r\nif not \"%1\"==\"--meetingrelay-whisper-runtime-version-probe-v1\" exit /b 64\r\necho meetingrelay-whisper-runtime-version-probe-v1 linked_whisper_cpp_version=1.8.3 measurement_status=whisper-runtime-version-marker-path-observation-only execution_status=runtime-path-launched-fixed-version-marker-observed-no-model-no-transcription quality_gate_status=not-assessed formal_claims=none production_evidence=false public_distribution=false selection_authority=none fallback_authority=none loaded_image_attestation=false network_isolation_authority=none\r\n"
      : "#!/bin/sh\nif [ \"$1\" != \"--meetingrelay-whisper-runtime-version-probe-v1\" ]; then exit 64; fi\nprintf '%s\\n' 'meetingrelay-whisper-runtime-version-probe-v1 linked_whisper_cpp_version=1.8.3 measurement_status=whisper-runtime-version-marker-path-observation-only execution_status=runtime-path-launched-fixed-version-marker-observed-no-model-no-transcription quality_gate_status=not-assessed formal_claims=none production_evidence=false public_distribution=false selection_authority=none fallback_authority=none loaded_image_attestation=false network_isolation_authority=none'\n";
  await writeFile(absolute, body, { encoding: "utf8", mode: 0o700 });
  return { absolute, relativePath, bytes: Buffer.from(body, "utf8") };
}

export async function createSyntheticRuntimeFixture(root) {
  const fixture = await createSyntheticFixture(root);
  const runtime = await writeSyntheticProbe(root);
  const runtimeEntry = fixture.manifest.files.find((entry) => entry.role === "runtime");
  runtimeEntry.logical_id = "synthetic-runtime-version-probe";
  runtimeEntry.relative_path = runtime.relativePath;
  runtimeEntry.sha256 = sha256Hex(runtime.bytes);
  runtimeEntry.size_bytes = runtime.bytes.length;
  await writeFile(fixture.manifestPath, encodeCanonicalJson(fixture.manifest), "utf8");
  const preflightEvidence = await preflightWhisperFallbackCandidate(root, fixture.manifestPath);
  return { ...fixture, executablePath: runtime.absolute, candidateAggregateSha256: preflightEvidence.candidate_descriptor.aggregate_sha256 };
}

async function runSynthetic() {
  const root = await mkdtemp(path.join(tmpdir(), "meetingrelay-whisper-runtime-probe-"));
  try {
    const fixture = await createSyntheticRuntimeFixture(root);
    const marker =
      "meetingrelay-whisper-runtime-version-probe-v1 linked_whisper_cpp_version=1.8.3 measurement_status=whisper-runtime-version-marker-path-observation-only execution_status=runtime-path-launched-fixed-version-marker-observed-no-model-no-transcription quality_gate_status=not-assessed formal_claims=none production_evidence=false public_distribution=false selection_authority=none fallback_authority=none loaded_image_attestation=false network_isolation_authority=none\n";
    const spawnImpl = () => {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const stdin = new PassThrough();
      const listeners = new Map();
      const child = {
        killed: false,
        stdout,
        stderr,
        stdin,
        kill: () => {
          child.killed = true;
        },
        on: (event, handler) => {
          if (!listeners.has(event)) listeners.set(event, []);
          listeners.get(event).push(handler);
          return child;
        },
      };
      queueMicrotask(() => {
        stdout.end(marker);
        stderr.end();
        for (const handler of listeners.get("exit") ?? []) handler(0, null);
        for (const handler of listeners.get("close") ?? []) handler(0, null);
      });
      return child;
    };
    return await probeWhisperFallbackRuntimeVersion(root, fixture.manifestPath, fixture.executablePath, fixture.candidateAggregateSha256, {
      spawnImpl,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length === 0 || (argv.length === 1 && argv[0] === "--run-synthetic")) {
    const evidence = await runSynthetic();
    const evidenceText = encodeCanonicalJson(evidence);
    process.stdout.write(
      `whisper-fallback-runtime-version-probe=verified evidence_sha256=${sha256Hex(Buffer.from(evidenceText, "utf8"))} candidate_aggregate_sha256=${evidence.candidate_aggregate_sha256} runtime_sha256=${evidence.runtime.sha256} stdout_marker_sha256=${evidence.probe.stdout_marker_sha256} linked_version_sha256=${evidence.probe.linked_version_sha256} measurement_status=${evidence.measurement_status} execution_status=${evidence.execution_status} quality_gate_status=${evidence.quality_gate_status} formal_claims=none production_evidence=false public_distribution=false selection_authority=none fallback_authority=none launch_binding_status=${evidence.launch_binding_status} loaded_image_attestation=false network_isolation_authority=none fixture_scope=synthetic-runtime-version-marker-path-observation-no-model-no-transcription\n`,
    );
    return;
  }
  if (argv.length === 5 && argv[0] === "--probe") {
    const evidence = await probeWhisperFallbackRuntimeVersion(argv[1], argv[2], argv[3], argv[4]);
    const evidenceText = encodeCanonicalJson(evidence);
    process.stdout.write(
      `whisper-fallback-runtime-version-probe=verified evidence_sha256=${sha256Hex(Buffer.from(evidenceText, "utf8"))} candidate_aggregate_sha256=${evidence.candidate_aggregate_sha256} runtime_sha256=${evidence.runtime.sha256} stdout_marker_sha256=${evidence.probe.stdout_marker_sha256} linked_version_sha256=${evidence.probe.linked_version_sha256} measurement_status=${evidence.measurement_status} execution_status=${evidence.execution_status} quality_gate_status=${evidence.quality_gate_status} formal_claims=none production_evidence=false public_distribution=false selection_authority=none fallback_authority=none launch_binding_status=${evidence.launch_binding_status} loaded_image_attestation=false network_isolation_authority=none\n`,
    );
    return;
  }
  if (argv.length === 2 && argv[0] === "--validate-json") {
    let evidence;
    try {
      evidence = JSON.parse(argv[1]);
    } catch (error) {
      fail("WHISPER_RUNTIME_PROBE_EVIDENCE_CANONICAL", `evidence must parse as JSON: ${error.message}`);
    }
    if (encodeCanonicalJson(evidence) !== argv[1]) fail("WHISPER_RUNTIME_PROBE_EVIDENCE_CANONICAL", "evidence must be canonical indented JSON with one terminal LF");
    validatePublicEvidence(evidence);
    process.stdout.write(`whisper-fallback-runtime-version-probe-json=verified evidence_sha256=${sha256Hex(Buffer.from(encodeCanonicalJson(evidence), "utf8"))}\n`);
    return;
  }
  fail(
    "WHISPER_RUNTIME_PROBE_USAGE",
    "usage: node tools/whisper-native/whisper-fallback-runtime-version-probe.mjs [--run-synthetic]|--probe <controlled-root> <canonical-input-manifest.json> <absolute-runtime-probe-executable> <expected-candidate-aggregate-sha256>|--validate-json '<canonical-json>'",
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.code ?? "WHISPER_RUNTIME_PROBE_FAILED"}: ${error.message}\n`);
    process.exitCode = 1;
  });
}
