import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";

import { encodeCanonicalJson } from "../phase0-harness/canonical-json.mjs";
import { preflightCandidate, sha256Hex, validateRelativePath } from "./sidecar-candidate-preflight.mjs";
import {
  DEFAULT_CLEANUP_TIMEOUT_MS,
  DEFAULT_MAX_STDIO_BYTES,
  DEFAULT_TIMEOUT_MS,
  encodeFrame,
  decodeFrames,
  validateRequestHeader,
  validateResponseHeader,
} from "./sidecar-wire-foundation.mjs";

export const BOUNDARY_SOURCE_PATH = fileURLToPath(import.meta.url);
export const FIXED_PYTHON_ARGS = Object.freeze(["-I", "-S", "-B", "-c"]);
export const FIXED_HELLO_PROBE_SOURCE = [
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
export const FIXED_HELLO_PROBE_SHA256 = sha256Hex(Buffer.from(FIXED_HELLO_PROBE_SOURCE, "utf8"));
export const FIXED_SOURCE_AUDITOR = [
  "import ast,json,sys",
  "MAX=262144",
  "data=sys.stdin.buffer.read(MAX+1)",
  "if len(data)>MAX: print('{\"ok\":false,\"error\":\"SOURCE_TOO_LARGE\"}'); raise SystemExit(0)",
  "try:",
  " text=data.decode('utf-8')",
  " tree=ast.parse(text,filename='<candidate-source>',mode='exec')",
  " compile(tree,'<candidate-source>','exec')",
  " print(json.dumps({'ok':True,'module_count':1,'top_level_statement_count':len(tree.body)},sort_keys=True,separators=(',',':')))",
  "except SyntaxError:",
  " print('{\"ok\":false,\"error\":\"SYNTAX_ERROR\"}')",
  "except UnicodeDecodeError:",
  " print('{\"ok\":false,\"error\":\"UTF8_ERROR\"}')",
].join("\n");
export const FIXED_SOURCE_AUDITOR_SHA256 = sha256Hex(Buffer.from(FIXED_SOURCE_AUDITOR, "utf8"));

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const BOUND_RUNTIME_STATE = new WeakMap();

export class PythonProbeBoundaryError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "PythonProbeBoundaryError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new PythonProbeBoundaryError(code, message);
}

export function pathsEqualForPlatform(left, right, platform = process.platform) {
  const leftResolved = path.resolve(left);
  const rightResolved = path.resolve(right);
  return platform === "win32" ? leftResolved.toLowerCase() === rightResolved.toLowerCase() : leftResolved === rightResolved;
}

function identityFromStat(stat) {
  return {
    birthtimeNs: stat.birthtimeNs,
    ctimeNs: stat.ctimeNs,
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
    mtimeNs: stat.mtimeNs,
    size: stat.size,
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

function assertBoundRuntime(boundRuntime) {
  if (boundRuntime === null || typeof boundRuntime !== "object" || !BOUND_RUNTIME_STATE.has(boundRuntime)) {
    fail("PYTHON_PROBE_BOUNDARY_UNBOUND_RUNTIME", "fixed Python capability requires bindExactManifestRuntime token");
  }
  return BOUND_RUNTIME_STATE.get(boundRuntime);
}

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const item of Object.values(value)) deepFreeze(item);
  return value;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
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

async function assertPathChainHasNoLinks(absolutePath) {
  const resolved = path.resolve(absolutePath);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  const relative = path.relative(parsed.root, resolved);
  const segments = relative === "" ? [] : relative.split(path.sep);
  for (const segment of segments) {
    current = path.join(current, segment);
    const link = await lstat(current, { bigint: true }).catch((error) => fail("PYTHON_PROBE_BOUNDARY_FILE_OPEN", error.message));
    if (link.isSymbolicLink() || (!link.isFile() && !link.isDirectory())) {
      fail("PYTHON_PROBE_BOUNDARY_SPECIAL_FILE", "path chain must not contain a symlink, junction, or special file");
    }
  }
}

async function readBoundedCanonicalJson(filePath, code, label, maxBytes = 64 * 1024) {
  const absolute = rejectUnsafeLocalPath(filePath, code, label);
  await assertPathChainHasNoLinks(absolute);
  const handle = await open(absolute, "r").catch((error) => fail(code, error.message));
  try {
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile() || stat.size <= 0n || stat.size > BigInt(maxBytes)) fail(code, `${label} must be a bounded regular file`);
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

function resolveInsideRoot(controlledRoot, relativePath) {
  validateRelativePath(relativePath);
  const root = path.resolve(controlledRoot);
  const absolute = path.resolve(root, ...relativePath.split("/"));
  const rootPrefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  const comparableAbsolute = process.platform === "win32" ? absolute.toLowerCase() : absolute;
  const comparableRootPrefix = process.platform === "win32" ? rootPrefix.toLowerCase() : rootPrefix;
  if (!pathsEqualForPlatform(absolute, root) && !comparableAbsolute.startsWith(comparableRootPrefix)) {
    fail("PYTHON_PROBE_BOUNDARY_ROOT_ESCAPE", "relative_path escaped controlled root");
  }
  return absolute;
}

async function statRegularFileNoLinks(filePath, expected = undefined, options = {}) {
  const absolute = path.resolve(filePath);
  await assertPathChainHasNoLinks(absolute);
  const before = await lstat(absolute, { bigint: true }).catch((error) => fail("PYTHON_PROBE_BOUNDARY_FILE_OPEN", error.message));
  if (!before.isFile() || before.isSymbolicLink()) fail("PYTHON_PROBE_BOUNDARY_SPECIAL_FILE", "runtime must be a regular file");
  await options.beforeOpenForTest?.(absolute);
  const handle = await open(absolute, "r").catch((error) => fail("PYTHON_PROBE_BOUNDARY_FILE_OPEN", error.message));
  try {
    const current = await handle.stat({ bigint: true });
    if (!current.isFile()) fail("PYTHON_PROBE_BOUNDARY_SPECIAL_FILE", "runtime handle must be a regular file");
    const beforeIdentity = identityFromStat(before);
    const currentIdentity = identityFromStat(current);
    if (!sameFileIdentity(beforeIdentity, currentIdentity)) {
      fail("PYTHON_PROBE_BOUNDARY_RUNTIME_DRIFT", "runtime file identity drifted while opening");
    }
    await options.afterOpenForTest?.(absolute);
    const bytes = await handle.readFile();
    const hash = createHash("sha256").update(bytes);
    const afterHandle = await handle.stat({ bigint: true });
    const afterLink = await lstat(absolute, { bigint: true }).catch((error) => fail("PYTHON_PROBE_BOUNDARY_FILE_OPEN", error.message));
    if (!afterLink.isFile() || afterLink.isSymbolicLink()) fail("PYTHON_PROBE_BOUNDARY_SPECIAL_FILE", "runtime path changed to symlink or special file");
    const afterHandleIdentity = identityFromStat(afterHandle);
    const afterPathIdentity = identityFromStat(afterLink);
    if (!sameFileIdentity(currentIdentity, afterHandleIdentity) || !sameFileIdentity(currentIdentity, afterPathIdentity)) {
      fail("PYTHON_PROBE_BOUNDARY_RUNTIME_DRIFT", "runtime file identity drifted during read");
    }
    await assertPathChainHasNoLinks(absolute);
    const observed = { size_bytes: Number(current.size), sha256: hash.digest("hex"), file_identity: currentIdentity };
    if (
      expected !== undefined &&
      (observed.size_bytes !== expected.size_bytes ||
        observed.sha256 !== expected.sha256 ||
        (expected.file_identity !== undefined && !sameFileIdentity(observed.file_identity, expected.file_identity)))
    ) {
      fail("PYTHON_PROBE_BOUNDARY_RUNTIME_DRIFT", "runtime size, hash, or identity drifted");
    }
    return observed;
  } finally {
    await handle.close();
  }
}

function minimalEnv(executablePath) {
  if (process.platform === "win32") {
    const systemRoot = rejectUnsafeLocalPath(process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows", "PYTHON_PROBE_BOUNDARY_ENV", "SystemRoot", {
      absolute: true,
      pathListElement: true,
    });
    const executableDirectory = rejectUnsafeLocalPath(path.dirname(executablePath), "PYTHON_PROBE_BOUNDARY_ENV", "runtime directory", {
      absolute: true,
      pathListElement: true,
    });
    return { SystemRoot: systemRoot, WINDIR: systemRoot, PATH: `${executableDirectory};${systemRoot}\\System32` };
  }
  const executableDirectory = rejectUnsafeLocalPath(path.dirname(executablePath), "PYTHON_PROBE_BOUNDARY_ENV", "runtime directory", {
    absolute: true,
    pathListElement: true,
  });
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
      reject(new PythonProbeBoundaryError(`${label}_OVERFLOW`, `${label} exceeded bounded collection limit`));
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

async function runFixedPythonSnippet(boundState, fixedSource, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cleanupTimeoutMs = options.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS;
  const maxStdoutBytes = options.maxStdoutBytes ?? DEFAULT_MAX_STDIO_BYTES;
  const maxStderrBytes = options.maxStderrBytes ?? 64 * 1024;
  const spawnOptions = {
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
    windowsHide: true,
    detached: false,
    cwd: boundState.root,
    env: minimalEnv(boundState.runtime_absolute),
  };
  const child = (options.spawnImpl ?? spawn)(boundState.runtime_absolute, [...FIXED_PYTHON_ARGS, fixedSource], spawnOptions);
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
  const stdoutBuffer = collectBounded(child.stdout, maxStdoutBytes, "PYTHON_PROBE_BOUNDARY_STDOUT", failChild);
  const stderrBuffer = collectBounded(child.stderr, maxStderrBytes, "PYTHON_PROBE_BOUNDARY_STDERR", failChild);
  const close = new Promise((resolveClose) => {
    child.on("error", (error) => failChild(new PythonProbeBoundaryError("PYTHON_PROBE_BOUNDARY_SPAWN_FAILED", error.message)));
    child.on("exit", (code, signal) => {
      exitResult = { code, signal };
    });
    child.on("close", () => {
      closed = true;
      resolveClose();
    });
  });
  child.stdin.on("error", (error) => failChild(new PythonProbeBoundaryError("PYTHON_PROBE_BOUNDARY_STDIN_WRITE_FAILED", error.message)));
  const timer = setTimeout(() => failChild(new PythonProbeBoundaryError("PYTHON_PROBE_BOUNDARY_TIMEOUT", "fixed Python probe exceeded timeout")), timeoutMs);
  try {
    child.stdin.end(options.stdinBytes ?? Buffer.alloc(0), (error) => {
      if (error) failChild(new PythonProbeBoundaryError("PYTHON_PROBE_BOUNDARY_STDIN_WRITE_FAILED", error.message));
    });
    await Promise.race([close, failureSignal]);
  } finally {
    clearTimeout(timer);
    stdoutBuffer.stop();
    stderrBuffer.stop();
    if (!closed && !child.killed) child.kill();
    if (!closed) {
      const cleanupCompleted = await Promise.race([close.then(() => true), new Promise((resolveDelay) => setTimeout(() => resolveDelay(false), cleanupTimeoutMs))]);
      if (cleanupCompleted !== true) fail("PYTHON_PROBE_BOUNDARY_DIRECT_CHILD_CLOSE_TIMEOUT", "direct child did not close within bounded cleanup");
    }
  }
  if (failureError) throw failureError;
  const stderr = stderrBuffer.read();
  if (stderr.length !== 0) fail("PYTHON_PROBE_BOUNDARY_STDERR_NONEMPTY", "fixed Python probe stderr must be empty");
  if (exitResult.code !== 0 || exitResult.signal !== null) fail("PYTHON_PROBE_BOUNDARY_NONZERO_EXIT", "fixed Python probe must exit cleanly");
  return {
    stdout: stdoutBuffer.read(),
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
    },
  };
}

export async function bindExactManifestRuntime(controlledRoot, inputManifestPath, pythonExecutablePath, expectedAggregateSha256, options = {}) {
  if (typeof expectedAggregateSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(expectedAggregateSha256) || expectedAggregateSha256 === "0".repeat(64)) {
    fail("PYTHON_PROBE_BOUNDARY_AGGREGATE", "expected candidate aggregate must be non-zero lowercase sha256 hex");
  }
  const root = rejectUnsafeLocalPath(controlledRoot, "PYTHON_PROBE_BOUNDARY_ROOT", "controlled root", { absolute: true });
  const executable = rejectUnsafeLocalPath(pythonExecutablePath, "PYTHON_PROBE_BOUNDARY_EXECUTABLE", "python executable", { absolute: true });
  await assertPathChainHasNoLinks(root);
  const rootStat = await lstat(root, { bigint: true }).catch((error) => fail("PYTHON_PROBE_BOUNDARY_ROOT", error.message));
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail("PYTHON_PROBE_BOUNDARY_ROOT", "controlled root must be a directory");
  const preflightEvidence = await preflightCandidate(root, inputManifestPath);
  if (preflightEvidence.candidate_descriptor.aggregate_sha256 !== expectedAggregateSha256) {
    fail("PYTHON_PROBE_BOUNDARY_AGGREGATE", "expected candidate aggregate did not match preflight evidence");
  }
  const reread = await readBoundedCanonicalJson(inputManifestPath, "PYTHON_PROBE_BOUNDARY_MANIFEST", "input manifest");
  if (reread.sha256 !== preflightEvidence.canonical_input_manifest_sha256) {
    fail("PYTHON_PROBE_BOUNDARY_MANIFEST_DRIFT", "canonical manifest changed after preflight");
  }
  const runtimeManifest = reread.parsed.files.find((entry) => entry.role === "runtime");
  if (!runtimeManifest) fail("PYTHON_PROBE_BOUNDARY_MANIFEST", "runtime role missing");
  const runtimeAbsolute = resolveInsideRoot(root, runtimeManifest.relative_path);
  if (!pathsEqualForPlatform(executable, runtimeAbsolute)) {
    fail("PYTHON_PROBE_BOUNDARY_EXECUTABLE_MISMATCH", "explicit executable must be the manifest runtime file");
  }
  const [runtimeReal, executableReal] = await Promise.all([realpath(runtimeAbsolute), realpath(executable)]).catch((error) =>
    fail("PYTHON_PROBE_BOUNDARY_EXECUTABLE", error.message),
  );
  if (!pathsEqualForPlatform(runtimeReal, executableReal)) {
    fail("PYTHON_PROBE_BOUNDARY_EXECUTABLE_MISMATCH", "explicit executable must resolve to the manifest runtime file");
  }
  const runtimeBefore = await statRegularFileNoLinks(
    runtimeAbsolute,
    {
      size_bytes: runtimeManifest.size_bytes,
      sha256: runtimeManifest.sha256,
    },
    {
      afterOpenForTest: options.afterRuntimeOpenForTest,
      beforeOpenForTest: options.beforeRuntimeOpenForTest,
    },
  );
  const explicitBefore = await statRegularFileNoLinks(executable, {
    size_bytes: runtimeManifest.size_bytes,
    sha256: runtimeManifest.sha256,
  });
  if (!sameFileIdentity(runtimeBefore.file_identity, explicitBefore.file_identity)) {
    fail("PYTHON_PROBE_BOUNDARY_EXECUTABLE_MISMATCH", "explicit executable must be the manifest runtime file identity");
  }
  const state = {
    root,
    root_stat: rootStat,
    runtime_absolute: runtimeAbsolute,
    runtime_manifest: runtimeManifest,
    runtime_before: runtimeBefore,
    canonical_manifest_sha256: reread.sha256,
    manifest: reread.parsed,
    preflight_evidence: preflightEvidence,
    candidate_aggregate_sha256: expectedAggregateSha256,
  };
  const token = Object.freeze(Object.create(null));
  BOUND_RUNTIME_STATE.set(token, state);
  return token;
}

export async function runFixedHelloProbe(boundRuntime, options = {}) {
  const boundState = assertBoundRuntime(boundRuntime);
  const requestFrames = [
    { header: { type: "hello", sequence: 1, role: "sidecar-candidate", transport: "isolated-process" }, payload: Buffer.alloc(0) },
  ];
  validateRequestHeader(requestFrames[0].header, 1, requestFrames[0].payload);
  const stdinBytes = encodeFrame(requestFrames[0].header, requestFrames[0].payload, { maxPayloadBytes: 0 });
  const run = await runFixedPythonSnippet(boundState, FIXED_HELLO_PROBE_SOURCE, { ...options, stdinBytes });
  const responseFrames = decodeFrames(run.stdout, { maxPayloadBytes: 0, maxFrames: 2 });
  if (responseFrames.length !== 1) fail("PYTHON_PROBE_BOUNDARY_RESPONSE_COUNT", "python launch probe must return exactly one response frame");
  if (responseFrames[0].payload.length !== 0) fail("PYTHON_PROBE_BOUNDARY_PAYLOAD_UNEXPECTED", "hello_ok must not carry payload");
  validateResponseHeader(responseFrames[0].header, 1);
  if (responseFrames[0].header.type !== "hello_ok") fail("PYTHON_PROBE_BOUNDARY_RESPONSE_ORDER", "python launch probe must return hello_ok");
  return { requestFrames, responseFrames, processContract: run.processContract };
}

export async function runFixedSourceParseCompileAuditor(boundRuntime, candidateBytes, options = {}) {
  const boundState = assertBoundRuntime(boundRuntime);
  const run = await runFixedPythonSnippet(boundState, FIXED_SOURCE_AUDITOR, {
    ...options,
    stdinBytes: candidateBytes,
    maxStdoutBytes: options.maxStdoutBytes ?? 512,
    maxStderrBytes: options.maxStderrBytes ?? 4096,
  });
  let text;
  try {
    text = UTF8_DECODER.decode(run.stdout);
  } catch {
    fail("PYTHON_PROBE_BOUNDARY_AUDITOR_RESPONSE", "auditor response must be strict UTF-8");
  }
  if (!/^\{"(?:error":"[A-Z_]+","ok":false|module_count":1,"ok":true,"top_level_statement_count":[0-9]+)\}\r?\n?$/u.test(text)) {
    fail("PYTHON_PROBE_BOUNDARY_AUDITOR_RESPONSE", "auditor response must be stable canonical JSON");
  }
  const parsed = JSON.parse(text);
  if (parsed.ok !== true) fail(`PYTHON_PROBE_BOUNDARY_AUDITOR_${parsed.error ?? "FAILED"}`, "source parse/compile auditor rejected candidate");
  return {
    module_count: parsed.module_count,
    top_level_statement_count: parsed.top_level_statement_count,
    processContract: run.processContract,
  };
}

export async function postflightExactRuntimeRootIdentity(boundRuntime) {
  const boundState = assertBoundRuntime(boundRuntime);
  const rootAfter = await lstat(boundState.root, { bigint: true }).catch((error) => fail("PYTHON_PROBE_BOUNDARY_ROOT", error.message));
  if (
    boundState.root_stat.dev !== rootAfter.dev ||
    boundState.root_stat.ino !== rootAfter.ino ||
    boundState.root_stat.birthtimeNs !== rootAfter.birthtimeNs ||
    !rootAfter.isDirectory() ||
    rootAfter.isSymbolicLink()
  ) {
    fail("PYTHON_PROBE_BOUNDARY_ROOT_DRIFT", "controlled root identity drifted during fixed probe");
  }
  const runtimeAfter = await statRegularFileNoLinks(boundState.runtime_absolute, boundState.runtime_before);
  return {
    root_before_after_identity_match: true,
    runtime_before_after_identity_match:
      boundState.runtime_before.size_bytes === runtimeAfter.size_bytes &&
      boundState.runtime_before.sha256 === runtimeAfter.sha256 &&
      sameFileIdentity(boundState.runtime_before.file_identity, runtimeAfter.file_identity),
  };
}

export function getBoundRuntimeSnapshot(boundRuntime) {
  const boundState = assertBoundRuntime(boundRuntime);
  return deepFreeze({
    canonical_manifest_sha256: boundState.canonical_manifest_sha256,
    candidate_aggregate_sha256: boundState.candidate_aggregate_sha256,
    manifest: cloneJson(boundState.manifest),
    preflight_evidence: cloneJson(boundState.preflight_evidence),
    runtime_before: {
      sha256: boundState.runtime_before.sha256,
      size_bytes: boundState.runtime_before.size_bytes,
    },
    runtime_manifest: cloneJson(boundState.runtime_manifest),
  });
}

export function fixedBoundarySourceSha256() {
  return sha256Hex(readFileSync(BOUNDARY_SOURCE_PATH));
}
