#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { TextDecoder } from "node:util";

import { encodeCanonicalJson } from "../phase0-harness/canonical-json.mjs";
import {
  PUBLIC_EVIDENCE_SCHEMA_PATH as PREFLIGHT_SCHEMA_PATH,
  REQUIRED_ROLES,
  VALIDATOR_SOURCE_PATH as PREFLIGHT_SOURCE_PATH,
  preflightCandidate,
  sha256Hex,
  validateRelativePath,
} from "./sidecar-candidate-preflight.mjs";
import {
  DEFAULT_CLEANUP_TIMEOUT_MS,
  DEFAULT_MAX_STDIO_BYTES,
  DEFAULT_TIMEOUT_MS,
  MAX_HEADER_BYTES,
  WIRE_VERSION,
  WireProtocolError,
  computeWireTranscriptSha256,
  decodeFrames,
  encodeFrame,
  sha256Hex as wireSha256Hex,
  validateRequestHeader,
  validateResponseHeader,
} from "./sidecar-wire-foundation.mjs";

export const PUBLIC_EVIDENCE_KIND = "meetingrelay-funasr-sidecar-python-launch-v1";
export const PUBLIC_EVIDENCE_SCHEMA_VERSION = "1.0";
export const PUBLIC_EVIDENCE_SCHEMA_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "sidecar-python-launch.schema.json",
);
export const LAUNCHER_SOURCE_PATH = fileURLToPath(import.meta.url);
export const WIRE_FOUNDATION_SOURCE_PATH = fileURLToPath(new URL("./sidecar-wire-foundation.mjs", import.meta.url));
export const FIXED_PROBE_SOURCE = [
  "import sys,struct,json",
  "def read_exact(n):",
  " b=sys.stdin.buffer.read(n)",
  " if len(b)!=n: raise SystemExit(11)",
  " return b",
  "p=read_exact(13)",
  "magic,version,hlen,plen=struct.unpack('>4sBII',p)",
  "if magic!=b'MRSW' or version!=1 or hlen>65536 or plen!=0: raise SystemExit(12)",
  "h=read_exact(hlen)",
  "if not h.endswith(b'\\n') or b'\\r' in h or b'\\x00' in h: raise SystemExit(13)",
  "req=json.loads(h.decode('utf-8'))",
  "if req!={'role':'sidecar-candidate','sequence':1,'transport':'isolated-process','type':'hello'}: raise SystemExit(14)",
  "resp={'role':'sidecar-candidate','sequence':1,'transport':'isolated-process','type':'hello_ok'}",
  "out=(json.dumps(resp,sort_keys=True,separators=(',',':'))+'\\n').encode('utf-8')",
  "sys.stdout.buffer.write(struct.pack('>4sBII',b'MRSW',1,len(out),0)+out)",
].join("\n");
export const FIXED_PROBE_SHA256 = sha256Hex(Buffer.from(FIXED_PROBE_SOURCE, "utf8"));
export const FIXED_ARGS = Object.freeze(["-I", "-S", "-B", "-c"]);

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const SHA256_RE = /^[0-9a-f]{64}$/u;
const FORBIDDEN_PUBLIC_KEYS = new Set([
  "absolute_path",
  "audio",
  "audio_path",
  "args",
  "bundle_root",
  "content",
  "controlled_root",
  "cwd",
  "default",
  "distribution_approval",
  "env",
  "environment",
  "executable_path",
  "file_path",
  "path",
  "plaintext",
  "plaintext_transcript",
  "rank",
  "root",
  "secret",
  "selection",
  "stderr",
  "stdout",
  "text",
  "threshold",
  "transcript",
  "transcript_text",
]);
const FORBIDDEN_PUBLIC_VALUE_RE =
  /(?:[A-Za-z]:\\|\\\\|\/tmp\/|\/home\/|\/Users\/|inputs\/|runtime\.bin|BEGIN (?:RSA |OPENSSH |)PRIVATE KEY)/iu;
const LIMITATIONS = Object.freeze([
  "python-launch-probe-only: invokes the caller-provided 4b-bound executable with fixed Python isolation flags and exchanges one hello frame; a compatible executable may emulate the Python CLI, so this is not CPython provenance",
  "executable-may-emulate-python-cli-no-cpython-provenance: no base DLL, stdlib, site-packages, loaded-image, or CPython distribution attestation is produced",
  "FunASR import, model load, audio processing, network access, download, quality, performance, ranking, selection, default, distribution, parent closeout, and Phase 1 remain unexecuted or unassessed",
  "packaging and materialization closure remain pending; this does not select or endorse a CPython distribution, base runtime, base DLL set, stdlib, site-packages, loaded-image set, or product packaging form",
  "no heartbeat, progress protocol, restart budget, recovery scheduler, Job Object containment, or grandchild-process containment proof is claimed; only bounded direct-child close is observed",
  "public evidence intentionally omits filesystem paths, file contents, plaintext, secrets, environment values, timings, host identity, parent closeout, and Phase 1 completion claims",
]);

export class PythonLaunchError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "PythonLaunchError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new PythonLaunchError(code, message);
}

function assertPlainObject(value, code, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(code, `${label} must be an object`);
  }
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

function assertPositiveSize(value, code, label) {
  if (!Number.isSafeInteger(value) || value < 1) fail(code, `${label} must be a positive safe integer`);
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

function sameFileIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.birthtimeNs === right.birthtimeNs &&
    left.mode === right.mode
  );
}

function resolveInsideRoot(controlledRoot, relativePath) {
  validateRelativePath(relativePath);
  const root = path.resolve(controlledRoot);
  const absolute = path.resolve(root, ...relativePath.split("/"));
  const rootPrefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  const comparableAbsolute = process.platform === "win32" ? absolute.toLowerCase() : absolute;
  const comparableRootPrefix = process.platform === "win32" ? rootPrefix.toLowerCase() : rootPrefix;
  if (!pathsEqualForPlatform(absolute, root) && !comparableAbsolute.startsWith(comparableRootPrefix)) {
    fail("PYTHON_LAUNCH_ROOT_ESCAPE", "relative_path escaped controlled root");
  }
  return absolute;
}

async function assertPathChainHasNoLinks(absolutePath) {
  const resolved = path.resolve(absolutePath);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  const relative = path.relative(parsed.root, resolved);
  const segments = relative === "" ? [] : relative.split(path.sep);
  for (const segment of segments) {
    current = path.join(current, segment);
    const link = await lstat(current, { bigint: true }).catch((error) => {
      fail("PYTHON_LAUNCH_FILE_OPEN", error.message);
    });
    if (link.isSymbolicLink() || !link.isFile() && !link.isDirectory()) {
      fail("PYTHON_LAUNCH_SPECIAL_FILE", "path chain must not contain a symlink, junction, or special file");
    }
  }
}

async function readBoundedCanonicalJson(filePath, code, label, maxBytes = 64 * 1024) {
  const absolute = rejectUnsafeLocalPath(filePath, code, label);
  await assertPathChainHasNoLinks(absolute);
  const handle = await open(absolute, "r").catch((error) => fail(code, error.message));
  try {
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile() || stat.size <= 0n || stat.size > BigInt(maxBytes)) {
      fail(code, `${label} must be a bounded regular file`);
    }
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
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      fail(code, `${label} must parse as JSON: ${error.message}`);
    }
    if (encodeCanonicalJson(parsed) !== text) fail(code, `${label} must be canonical indented JSON with one terminal LF`);
    return { absolute, bytes, parsed, sha256: sha256Hex(bytes) };
  } finally {
    await handle.close();
  }
}

async function statRegularFileNoLinks(filePath, expected = undefined) {
  const absolute = path.resolve(filePath);
  await assertPathChainHasNoLinks(absolute);
  const before = await lstat(absolute, { bigint: true }).catch((error) => fail("PYTHON_LAUNCH_FILE_OPEN", error.message));
  if (!before.isFile() || before.isSymbolicLink()) fail("PYTHON_LAUNCH_SPECIAL_FILE", "runtime must be a regular file");
  const handle = await open(absolute, "r").catch((error) => fail("PYTHON_LAUNCH_FILE_OPEN", error.message));
  try {
    const current = await handle.stat({ bigint: true });
    if (!current.isFile()) fail("PYTHON_LAUNCH_SPECIAL_FILE", "runtime handle must be a regular file");
    const beforeIdentity = { dev: before.dev, ino: before.ino, birthtimeNs: before.birthtimeNs, mode: before.mode };
    const currentIdentity = { dev: current.dev, ino: current.ino, birthtimeNs: current.birthtimeNs, mode: current.mode };
    if (!sameFileIdentity(beforeIdentity, currentIdentity)) {
      fail("PYTHON_LAUNCH_RUNTIME_DRIFT", "runtime file identity drifted while opening");
    }
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream()) {
      hash.update(chunk);
    }
    const observed = {
      size_bytes: Number(current.size),
      sha256: hash.digest("hex"),
      file_identity: currentIdentity,
    };
    if (
      expected !== undefined &&
      (observed.size_bytes !== expected.size_bytes ||
        observed.sha256 !== expected.sha256 ||
        expected.file_identity !== undefined && !sameFileIdentity(observed.file_identity, expected.file_identity))
    ) {
      fail("PYTHON_LAUNCH_RUNTIME_DRIFT", "runtime size or hash drifted");
    }
    return observed;
  } finally {
    await handle.close();
  }
}

function minimalEnv(executablePath) {
  if (process.platform === "win32") {
    const systemRoot = rejectUnsafeLocalPath(
      process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows",
      "PYTHON_LAUNCH_ENV",
      "SystemRoot",
      { absolute: true, pathListElement: true },
    );
    const executableDirectory = rejectUnsafeLocalPath(path.dirname(executablePath), "PYTHON_LAUNCH_ENV", "runtime directory", {
      absolute: true,
      pathListElement: true,
    });
    return {
      SystemRoot: systemRoot,
      WINDIR: systemRoot,
      PATH: `${executableDirectory};${systemRoot}\\System32`,
    };
  }
  const executableDirectory = rejectUnsafeLocalPath(path.dirname(executablePath), "PYTHON_LAUNCH_ENV", "runtime directory", {
    absolute: true,
    pathListElement: true,
  });
  return { PATH: `${executableDirectory}:/usr/bin:/bin` };
}

async function runBoundedProcess(command, args, options = {}) {
  const child = spawn(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
    windowsHide: true,
    detached: false,
    env: options.env,
    cwd: options.cwd,
  });
  let failure;
  const stdout = collectBounded(child.stdout, 64 * 1024, "PYTHON_LAUNCH_FIXTURE_STDOUT", (error) => {
    failure = error;
    if (!child.killed) child.kill();
  });
  const stderr = collectBounded(child.stderr, 64 * 1024, "PYTHON_LAUNCH_FIXTURE_STDERR", (error) => {
    failure = error;
    if (!child.killed) child.kill();
  });
  const result = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
  stdout.stop();
  stderr.stop();
  if (failure) throw failure;
  if (result.code !== 0 || result.signal !== null) {
    fail("PYTHON_LAUNCH_FIXTURE_PYTHON", "test-only Python fixture command failed");
  }
  return { stdout: stdout.read(), stderr: stderr.read() };
}

async function discoverHostPythonForFixture() {
  const candidates =
    process.platform === "win32"
      ? [
          { command: "python", prefix: [] },
          { command: "py", prefix: ["-3"] },
        ]
      : [
          { command: "python3", prefix: [] },
          { command: "python", prefix: [] },
        ];
  for (const candidate of candidates) {
    try {
      await runBoundedProcess(candidate.command, [...candidate.prefix, "-c", "import sys; raise SystemExit(0 if sys.version_info >= (3,8) else 1)"]);
      return candidate;
    } catch {
      // Try the next host-visible Python command. This is test-fixture discovery, not product selection.
    }
  }
  fail("PYTHON_LAUNCH_FIXTURE_PYTHON", "host Python 3.8+ is required for synthetic validation");
}

async function writeFixtureRoleFile(root, files, role, relativePath, bytes) {
  const absolute = path.join(root, ...relativePath.split("/"));
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, bytes);
  files.push({
    role,
    logical_id: `launch-${role}`,
    relative_path: relativePath,
    sha256: sha256Hex(bytes),
    size_bytes: bytes.length,
  });
}

export async function runSyntheticValidation() {
  const root = await mkdtemp(path.join(tmpdir(), "meetingrelay-python-launch-synthetic-"));
  try {
    const host = await discoverHostPythonForFixture();
    const venvRoot = path.join(root, "venv");
    await runBoundedProcess(host.command, [...host.prefix, "-m", "venv", venvRoot]);
    const executablePath = process.platform === "win32" ? path.join(venvRoot, "Scripts", "python.exe") : path.join(venvRoot, "bin", "python");
    const runtimeBytes = await readFile(executablePath);
    const files = [];
    for (const role of REQUIRED_ROLES) {
      if (role === "runtime") continue;
      await writeFixtureRoleFile(root, files, role, `inputs/${role}.bin`, Buffer.from(`synthetic ${role} bytes\n`, "utf8"));
    }
    files.push({
      role: "runtime",
      logical_id: "launch-runtime",
      relative_path: process.platform === "win32" ? "venv/Scripts/python.exe" : "venv/bin/python",
      sha256: sha256Hex(runtimeBytes),
      size_bytes: runtimeBytes.length,
    });
    files.sort((a, b) => a.role.localeCompare(b.role));
    const manifest = {
      kind: "meetingrelay-funasr-sidecar-candidate-preflight-input-v1",
      schema_version: "1.0",
      worker_role: "sidecar-candidate",
      measurement_status: "identity-preflight-only",
      execution_status: "not-executed",
      quality_gate_status: "not-assessed",
      formal_claims: "none",
      production_evidence: false,
      public_distribution: false,
      selection_authority: "none",
      files,
    };
    const manifestPath = path.join(root, "input-manifest.json");
    await writeFile(manifestPath, encodeCanonicalJson(manifest), "utf8");
    const preflightEvidence = await preflightCandidate(root, manifestPath);
    return await launchPythonCandidate(root, manifestPath, executablePath, preflightEvidence.candidate_descriptor.aggregate_sha256);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
      reject(new PythonLaunchError(`${label}_OVERFLOW`, `${label} exceeded bounded collection limit`));
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

async function launchProbe(executablePath, controlledRoot, options = {}) {
  const requestFrames = [
    { header: { type: "hello", sequence: 1, role: "sidecar-candidate", transport: "isolated-process" }, payload: Buffer.alloc(0) },
  ];
  validateRequestHeader(requestFrames[0].header, 1, requestFrames[0].payload);
  const stdinBytes = encodeFrame(requestFrames[0].header, requestFrames[0].payload, { maxPayloadBytes: 0 });
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cleanupTimeoutMs = options.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS;
  const maxStdoutBytes = options.maxStdoutBytes ?? DEFAULT_MAX_STDIO_BYTES;
  const maxStderrBytes = options.maxStderrBytes ?? 64 * 1024;
  const spawnOptions = {
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
    windowsHide: true,
    detached: false,
    cwd: controlledRoot,
    env: minimalEnv(executablePath),
  };
  const spawnImpl = options.spawnImpl ?? spawn;
  const child = spawnImpl(executablePath, [...FIXED_ARGS, FIXED_PROBE_SOURCE], spawnOptions);
  let timedOut = false;
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
  const stdoutBuffer = collectBounded(child.stdout, maxStdoutBytes, "PYTHON_LAUNCH_STDOUT", failChild);
  const stderrBuffer = collectBounded(child.stderr, maxStderrBytes, "PYTHON_LAUNCH_STDERR", failChild);
  const close = new Promise((resolveClose) => {
    child.on("error", (error) => failChild(new PythonLaunchError("PYTHON_LAUNCH_SPAWN_FAILED", error.message)));
    child.on("exit", (code, signal) => {
      exitResult = { code, signal };
    });
    child.on("close", () => {
      closed = true;
      resolveClose();
    });
  });
  child.stdin.on("error", (error) => {
    failChild(new PythonLaunchError("PYTHON_LAUNCH_STDIN_WRITE_FAILED", error.message));
  });
  const timer = setTimeout(() => {
    timedOut = true;
    failChild(new PythonLaunchError("PYTHON_LAUNCH_TIMEOUT", "python launch probe exceeded timeout"));
  }, timeoutMs);
  let cleanupTimedOut = false;
  try {
    child.stdin.end(stdinBytes, (error) => {
      if (error) failChild(new PythonLaunchError("PYTHON_LAUNCH_STDIN_WRITE_FAILED", error.message));
    });
    await Promise.race([close, failureSignal]);
  } finally {
    clearTimeout(timer);
    stdoutBuffer.stop();
    stderrBuffer.stop();
    if (!closed && !child.killed) child.kill();
    if (!closed) {
      const cleanupCompleted = await Promise.race([
        close.then(() => true),
        new Promise((resolveDelay) => setTimeout(() => resolveDelay(false), cleanupTimeoutMs)),
      ]);
      cleanupTimedOut = cleanupCompleted !== true;
    }
  }
  if (cleanupTimedOut) fail("PYTHON_LAUNCH_DIRECT_CHILD_CLOSE_TIMEOUT", "direct child did not close within bounded cleanup");
  if (timedOut && !failureError) failureError = new PythonLaunchError("PYTHON_LAUNCH_TIMEOUT", "python launch probe exceeded timeout");
  if (failureError) throw failureError;
  const stderr = stderrBuffer.read();
  if (stderr.length !== 0) fail("PYTHON_LAUNCH_STDERR_NONEMPTY", "python launch probe stderr must be empty");
  if (exitResult.code !== 0 || exitResult.signal !== null) fail("PYTHON_LAUNCH_NONZERO_EXIT", "python launch probe must exit cleanly");
  const responseFrames = decodeFrames(stdoutBuffer.read(), { maxPayloadBytes: 0, maxFrames: 2 });
  if (responseFrames.length !== 1) fail("PYTHON_LAUNCH_RESPONSE_COUNT", "python launch probe must return exactly one response frame");
  if (responseFrames[0].payload.length !== 0) fail("PYTHON_LAUNCH_PAYLOAD_UNEXPECTED", "hello_ok must not carry payload");
  validateResponseHeader(responseFrames[0].header, 1);
  if (responseFrames[0].header.type !== "hello_ok") fail("PYTHON_LAUNCH_RESPONSE_ORDER", "python launch probe must return hello_ok");
  return {
    requestFrames,
    responseFrames,
    processContract: {
      shell: spawnOptions.shell,
      windowsHide: spawnOptions.windowsHide,
      detached: spawnOptions.detached,
      cwd_is_controlled_root: true,
      minimal_environment: true,
      root_before_after_identity_match: true,
      path_entries: spawnOptions.env.PATH.split(process.platform === "win32" ? ";" : ":").length,
      proxy_environment_forwarded: false,
      fixed_argument_count: FIXED_ARGS.length + 1,
      fixed_arguments_sha256: sha256Hex(Buffer.from(encodeCanonicalJson([...FIXED_ARGS, "<fixed-probe-source>"]), "utf8")),
      direct_child_closed: true,
    },
  };
}

function scanForbiddenPublicEvidence(value, pathSegments = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanForbiddenPublicEvidence(item, [...pathSegments, String(index)]));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (FORBIDDEN_PUBLIC_KEYS.has(key)) {
        fail("PYTHON_LAUNCH_EVIDENCE_FORBIDDEN", `forbidden public evidence key ${[...pathSegments, key].join(".")}`);
      }
      scanForbiddenPublicEvidence(item, [...pathSegments, key]);
    }
    return;
  }
  if (typeof value === "string" && FORBIDDEN_PUBLIC_VALUE_RE.test(value)) {
    fail("PYTHON_LAUNCH_EVIDENCE_FORBIDDEN", `forbidden public evidence value at ${pathSegments.join(".")}`);
  }
}

export async function launchPythonCandidate(controlledRoot, inputManifestPath, pythonExecutablePath, expectedAggregateSha256, options = {}) {
  assertSha256(expectedAggregateSha256, "PYTHON_LAUNCH_AGGREGATE", "expected candidate aggregate");
  const root = rejectUnsafeLocalPath(controlledRoot, "PYTHON_LAUNCH_ROOT", "controlled root", { absolute: true });
  const executable = rejectUnsafeLocalPath(pythonExecutablePath, "PYTHON_LAUNCH_EXECUTABLE", "python executable", { absolute: true });
  await assertPathChainHasNoLinks(root);
  const rootStat = await lstat(root, { bigint: true }).catch((error) => fail("PYTHON_LAUNCH_ROOT", error.message));
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail("PYTHON_LAUNCH_ROOT", "controlled root must be a directory");

  const preflightEvidence = await preflightCandidate(root, inputManifestPath);
  if (preflightEvidence.candidate_descriptor.aggregate_sha256 !== expectedAggregateSha256) {
    fail("PYTHON_LAUNCH_AGGREGATE", "expected candidate aggregate did not match preflight evidence");
  }
  const reread = await readBoundedCanonicalJson(inputManifestPath, "PYTHON_LAUNCH_MANIFEST", "input manifest");
  if (reread.sha256 !== preflightEvidence.canonical_input_manifest_sha256) {
    fail("PYTHON_LAUNCH_MANIFEST_DRIFT", "canonical manifest changed after preflight");
  }
  const runtimeManifest = reread.parsed.files.find((entry) => entry.role === "runtime");
  if (!runtimeManifest) fail("PYTHON_LAUNCH_MANIFEST", "runtime role missing");
  validateRelativePath(runtimeManifest.relative_path);
  const runtimeAbsolute = resolveInsideRoot(root, runtimeManifest.relative_path);
  if (!pathsEqualForPlatform(executable, runtimeAbsolute)) {
    fail("PYTHON_LAUNCH_EXECUTABLE_MISMATCH", "explicit executable must be the manifest runtime file");
  }
  const [runtimeReal, executableReal] = await Promise.all([realpath(runtimeAbsolute), realpath(executable)]).catch((error) => {
    fail("PYTHON_LAUNCH_EXECUTABLE", error.message);
  });
  if (!pathsEqualForPlatform(runtimeReal, executableReal)) {
    fail("PYTHON_LAUNCH_EXECUTABLE_MISMATCH", "explicit executable must resolve to the manifest runtime file");
  }
  const expectedRuntime = {
    size_bytes: runtimeManifest.size_bytes,
    sha256: runtimeManifest.sha256,
  };
  const runtimeBefore = await statRegularFileNoLinks(runtimeAbsolute, expectedRuntime);
  const explicitBefore = await statRegularFileNoLinks(executable, expectedRuntime);
  if (!sameFileIdentity(runtimeBefore.file_identity, explicitBefore.file_identity)) {
    fail("PYTHON_LAUNCH_EXECUTABLE_MISMATCH", "explicit executable must be the manifest runtime file identity");
  }
  const probeRun = await launchProbe(runtimeAbsolute, root, options);
  const rootAfter = await lstat(root, { bigint: true }).catch((error) => fail("PYTHON_LAUNCH_ROOT", error.message));
  if (
    rootStat.dev !== rootAfter.dev ||
    rootStat.ino !== rootAfter.ino ||
    rootStat.birthtimeNs !== rootAfter.birthtimeNs ||
    !rootAfter.isDirectory() ||
    rootAfter.isSymbolicLink()
  ) {
    fail("PYTHON_LAUNCH_ROOT_DRIFT", "controlled root identity drifted during launch");
  }
  const runtimeAfter = await statRegularFileNoLinks(runtimeAbsolute, runtimeBefore);
  const schemaBytes = await readFile(PUBLIC_EVIDENCE_SCHEMA_PATH);
  JSON.parse(schemaBytes.toString("utf8"));
  const launcherBytes = await readFile(LAUNCHER_SOURCE_PATH);
  const wireBytes = await readFile(WIRE_FOUNDATION_SOURCE_PATH);
  const evidence = {
    kind: PUBLIC_EVIDENCE_KIND,
    schema_version: PUBLIC_EVIDENCE_SCHEMA_VERSION,
    schema_file_sha256: sha256Hex(schemaBytes),
    launcher_source_sha256: sha256Hex(launcherBytes),
    preflight_schema_sha256: sha256Hex(readFileSync(PREFLIGHT_SCHEMA_PATH)),
    preflight_validator_source_sha256: sha256Hex(readFileSync(PREFLIGHT_SOURCE_PATH)),
    preflight_evidence_sha256: sha256Hex(Buffer.from(encodeCanonicalJson(preflightEvidence), "utf8")),
    canonical_input_manifest_sha256: preflightEvidence.canonical_input_manifest_sha256,
    candidate_aggregate_sha256: expectedAggregateSha256,
    measurement_status: "python-launch-probe-only",
    execution_status: "interpreter-launched-no-funasr",
    quality_gate_status: "not-assessed",
    formal_claims: "none",
    production_evidence: false,
    public_distribution: false,
    selection_authority: "none",
    packaging_authority: "none",
    worker_role: "sidecar-candidate",
    runtime: {
      role: "runtime",
      logical_id_sha256: sha256Hex(Buffer.from(runtimeManifest.logical_id, "utf8")),
      size_bytes: runtimeBefore.size_bytes,
      sha256: runtimeBefore.sha256,
      before_after_identity_match:
        runtimeBefore.size_bytes === runtimeAfter.size_bytes &&
        runtimeBefore.sha256 === runtimeAfter.sha256 &&
        sameFileIdentity(runtimeBefore.file_identity, runtimeAfter.file_identity),
    },
    probe: {
      fixed_probe_sha256: FIXED_PROBE_SHA256,
      fixed_probe_imports_sha256: sha256Hex(Buffer.from(encodeCanonicalJson(["json", "struct", "sys"]), "utf8")),
      imported_wire_foundation_source_sha256: sha256Hex(wireBytes),
      wire_version: WIRE_VERSION,
      max_header_bytes: MAX_HEADER_BYTES,
      request_frame_count: probeRun.requestFrames.length,
      response_frame_count: probeRun.responseFrames.length,
      one_frame_transcript_sha256: computeWireTranscriptSha256(probeRun.requestFrames, probeRun.responseFrames),
      request_frame_sha256: wireSha256Hex(encodeFrame(probeRun.requestFrames[0].header, probeRun.requestFrames[0].payload, { maxPayloadBytes: 0 })),
      response_frame_sha256: wireSha256Hex(encodeFrame(probeRun.responseFrames[0].header, probeRun.responseFrames[0].payload, { maxPayloadBytes: 0 })),
    },
    process_contract: probeRun.processContract,
    limitations: [...LIMITATIONS],
  };
  validatePublicEvidence(evidence);
  return evidence;
}

export function validatePublicEvidence(evidence) {
  assertPlainObject(evidence, "PYTHON_LAUNCH_EVIDENCE_SCHEMA", "evidence");
  assertAllowedKeys(
    evidence,
    new Set([
      "kind",
      "schema_version",
      "schema_file_sha256",
      "launcher_source_sha256",
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
      "packaging_authority",
      "worker_role",
      "runtime",
      "probe",
      "process_contract",
      "limitations",
    ]),
    "PYTHON_LAUNCH_EVIDENCE_SCHEMA",
    "evidence",
  );
  if (evidence.kind !== PUBLIC_EVIDENCE_KIND || evidence.schema_version !== PUBLIC_EVIDENCE_SCHEMA_VERSION) {
    fail("PYTHON_LAUNCH_EVIDENCE_SCHEMA", "bad evidence kind or schema version");
  }
  for (const key of [
    "schema_file_sha256",
    "launcher_source_sha256",
    "preflight_schema_sha256",
    "preflight_validator_source_sha256",
    "preflight_evidence_sha256",
    "canonical_input_manifest_sha256",
    "candidate_aggregate_sha256",
  ]) {
    assertSha256(evidence[key], "PYTHON_LAUNCH_EVIDENCE_SCHEMA", key);
  }
  if (
    evidence.schema_file_sha256 !== sha256Hex(readFileSync(PUBLIC_EVIDENCE_SCHEMA_PATH)) ||
    evidence.launcher_source_sha256 !== sha256Hex(readFileSync(LAUNCHER_SOURCE_PATH)) ||
    evidence.preflight_schema_sha256 !== sha256Hex(readFileSync(PREFLIGHT_SCHEMA_PATH)) ||
    evidence.preflight_validator_source_sha256 !== sha256Hex(readFileSync(PREFLIGHT_SOURCE_PATH))
  ) {
    fail("PYTHON_LAUNCH_EVIDENCE_SCHEMA", "schema or source digest mismatch");
  }
  if (
    evidence.measurement_status !== "python-launch-probe-only" ||
    evidence.execution_status !== "interpreter-launched-no-funasr" ||
    evidence.quality_gate_status !== "not-assessed" ||
    evidence.formal_claims !== "none" ||
    evidence.production_evidence !== false ||
    evidence.public_distribution !== false ||
    evidence.selection_authority !== "none" ||
    evidence.packaging_authority !== "none" ||
    evidence.worker_role !== "sidecar-candidate"
  ) {
    fail("PYTHON_LAUNCH_EVIDENCE_OVERCLAIM", "evidence authority fields overclaim");
  }
  assertPlainObject(evidence.runtime, "PYTHON_LAUNCH_EVIDENCE_SCHEMA", "runtime");
  assertAllowedKeys(
    evidence.runtime,
    new Set(["role", "logical_id_sha256", "size_bytes", "sha256", "before_after_identity_match"]),
    "PYTHON_LAUNCH_EVIDENCE_SCHEMA",
    "runtime",
  );
  if (evidence.runtime.role !== "runtime" || evidence.runtime.before_after_identity_match !== true) {
    fail("PYTHON_LAUNCH_EVIDENCE_SCHEMA", "runtime identity mismatch");
  }
  assertSha256(evidence.runtime.logical_id_sha256, "PYTHON_LAUNCH_EVIDENCE_SCHEMA", "runtime.logical_id_sha256");
  assertSha256(evidence.runtime.sha256, "PYTHON_LAUNCH_EVIDENCE_SCHEMA", "runtime.sha256");
  assertPositiveSize(evidence.runtime.size_bytes, "PYTHON_LAUNCH_EVIDENCE_SCHEMA", "runtime.size_bytes");
  assertPlainObject(evidence.probe, "PYTHON_LAUNCH_EVIDENCE_SCHEMA", "probe");
  assertAllowedKeys(
    evidence.probe,
    new Set([
      "fixed_probe_sha256",
      "fixed_probe_imports_sha256",
      "imported_wire_foundation_source_sha256",
      "wire_version",
      "max_header_bytes",
      "request_frame_count",
      "response_frame_count",
      "one_frame_transcript_sha256",
      "request_frame_sha256",
      "response_frame_sha256",
    ]),
    "PYTHON_LAUNCH_EVIDENCE_SCHEMA",
    "probe",
  );
  for (const key of [
    "fixed_probe_sha256",
    "fixed_probe_imports_sha256",
    "imported_wire_foundation_source_sha256",
    "one_frame_transcript_sha256",
    "request_frame_sha256",
    "response_frame_sha256",
  ]) {
    assertSha256(evidence.probe[key], "PYTHON_LAUNCH_EVIDENCE_SCHEMA", `probe.${key}`);
  }
  if (
    evidence.probe.fixed_probe_sha256 !== FIXED_PROBE_SHA256 ||
    evidence.probe.fixed_probe_imports_sha256 !== sha256Hex(Buffer.from(encodeCanonicalJson(["json", "struct", "sys"]), "utf8")) ||
    evidence.probe.imported_wire_foundation_source_sha256 !== sha256Hex(readFileSync(WIRE_FOUNDATION_SOURCE_PATH)) ||
    evidence.probe.wire_version !== 1 ||
    evidence.probe.max_header_bytes !== MAX_HEADER_BYTES ||
    evidence.probe.request_frame_count !== 1 ||
    evidence.probe.response_frame_count !== 1
  ) {
    fail("PYTHON_LAUNCH_EVIDENCE_SCHEMA", "probe constants mismatch");
  }
  const expectedRequestFrame = { header: { type: "hello", sequence: 1, role: "sidecar-candidate", transport: "isolated-process" }, payload: Buffer.alloc(0) };
  const expectedResponseFrame = { header: { type: "hello_ok", sequence: 1, role: "sidecar-candidate", transport: "isolated-process" }, payload: Buffer.alloc(0) };
  const expectedRequestFrameSha256 = wireSha256Hex(encodeFrame(expectedRequestFrame.header, expectedRequestFrame.payload, { maxPayloadBytes: 0 }));
  const expectedResponseFrameSha256 = wireSha256Hex(encodeFrame(expectedResponseFrame.header, expectedResponseFrame.payload, { maxPayloadBytes: 0 }));
  const expectedTranscriptSha256 = computeWireTranscriptSha256([expectedRequestFrame], [expectedResponseFrame]);
  if (
    evidence.probe.request_frame_sha256 !== expectedRequestFrameSha256 ||
    evidence.probe.response_frame_sha256 !== expectedResponseFrameSha256 ||
    evidence.probe.one_frame_transcript_sha256 !== expectedTranscriptSha256
  ) {
    fail("PYTHON_LAUNCH_EVIDENCE_SCHEMA", "wire frame digest mismatch");
  }
  assertPlainObject(evidence.process_contract, "PYTHON_LAUNCH_EVIDENCE_SCHEMA", "process_contract");
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
      "fixed_argument_count",
      "fixed_arguments_sha256",
      "direct_child_closed",
    ]),
    "PYTHON_LAUNCH_EVIDENCE_SCHEMA",
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
    evidence.process_contract.fixed_argument_count !== 5 ||
    evidence.process_contract.fixed_arguments_sha256 !== sha256Hex(Buffer.from(encodeCanonicalJson([...FIXED_ARGS, "<fixed-probe-source>"]), "utf8")) ||
    evidence.process_contract.direct_child_closed !== true
  ) {
    fail("PYTHON_LAUNCH_EVIDENCE_SCHEMA", "process contract mismatch");
  }
  if (!Number.isInteger(evidence.process_contract.path_entries) || evidence.process_contract.path_entries < 1 || evidence.process_contract.path_entries > 3) {
    fail("PYTHON_LAUNCH_EVIDENCE_SCHEMA", "unexpected process path entry count");
  }
  if (!Array.isArray(evidence.limitations) || evidence.limitations.length !== LIMITATIONS.length) {
    fail("PYTHON_LAUNCH_EVIDENCE_SCHEMA", "limitations must be exact");
  }
  for (const [index, limitation] of LIMITATIONS.entries()) {
    if (evidence.limitations[index] !== limitation) fail("PYTHON_LAUNCH_EVIDENCE_SCHEMA", "limitation mismatch");
  }
  scanForbiddenPublicEvidence(evidence);
  return true;
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length === 1 && argv[0] === "--run-synthetic") {
    const evidence = await runSyntheticValidation();
    const evidenceText = encodeCanonicalJson(evidence);
    process.stdout.write(
      `funasr-sidecar-python-launch=verified evidence_sha256=${sha256Hex(Buffer.from(evidenceText, "utf8"))} candidate_aggregate_sha256=${evidence.candidate_aggregate_sha256} runtime_sha256=${evidence.runtime.sha256} fixed_probe_sha256=${evidence.probe.fixed_probe_sha256} one_frame_transcript_sha256=${evidence.probe.one_frame_transcript_sha256} measurement_status=${evidence.measurement_status} execution_status=${evidence.execution_status} quality_gate_status=${evidence.quality_gate_status} formal_claims=none production_evidence=false public_distribution=false selection_authority=none packaging_authority=none fixture_scope=test-only-venv-not-packaging-choice\n`,
    );
    return;
  }
  if (argv.length === 5 && argv[0] === "--launch") {
    const evidence = await launchPythonCandidate(argv[1], argv[2], argv[3], argv[4]);
    const evidenceText = encodeCanonicalJson(evidence);
    process.stdout.write(
      `funasr-sidecar-python-launch=verified evidence_sha256=${sha256Hex(Buffer.from(evidenceText, "utf8"))} candidate_aggregate_sha256=${evidence.candidate_aggregate_sha256} runtime_sha256=${evidence.runtime.sha256} fixed_probe_sha256=${evidence.probe.fixed_probe_sha256} one_frame_transcript_sha256=${evidence.probe.one_frame_transcript_sha256} measurement_status=${evidence.measurement_status} execution_status=${evidence.execution_status} quality_gate_status=${evidence.quality_gate_status} formal_claims=none production_evidence=false public_distribution=false selection_authority=none packaging_authority=none\n`,
    );
    return;
  }
  if (argv.length === 2 && argv[0] === "--validate-json") {
    let evidence;
    try {
      evidence = JSON.parse(argv[1]);
    } catch (error) {
      fail("PYTHON_LAUNCH_EVIDENCE_CANONICAL", `evidence must parse as JSON: ${error.message}`);
    }
    if (encodeCanonicalJson(evidence) !== argv[1]) {
      fail("PYTHON_LAUNCH_EVIDENCE_CANONICAL", "evidence must be canonical indented JSON with one terminal LF");
    }
    validatePublicEvidence(evidence);
    process.stdout.write(`funasr-sidecar-python-launch-json=verified evidence_sha256=${sha256Hex(Buffer.from(encodeCanonicalJson(evidence), "utf8"))}\n`);
    return;
  }
  fail(
    "PYTHON_LAUNCH_USAGE",
    "usage: node tools/funasr-sidecar/sidecar-python-launch.mjs [--run-synthetic]|--launch <controlled-root> <canonical-4b-input-manifest.json> <absolute-python-executable> <expected-candidate-aggregate-sha256>",
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const code = error.code ?? (error instanceof WireProtocolError ? error.code : "PYTHON_LAUNCH_FAILED");
    process.stderr.write(`${code}: ${error.message}\n`);
    process.exitCode = 1;
  });
}
