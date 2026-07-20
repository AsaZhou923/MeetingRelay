import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
} from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";
import { fileURLToPath } from "node:url";

import { encodeCanonicalJsonLine } from "../phase0-harness/canonical-json.mjs";

const MODULE_PROFILE_NAME = new URL(import.meta.url).searchParams.get("profile") ?? "sample";
const MODULE_PROFILES = Object.freeze({
  sample: Object.freeze({
    buildTargetLeaf: "quality-host-builds",
    cargoFeature: "native-quality-sample",
    features: Object.freeze(["native-quality-sample", "native-sherpa"]),
    host: "meetingrelay-sherpa-candidate-quality-host",
    kind: "meetingrelay-quality-host-source-build-attestation-v1",
  }),
  shard: Object.freeze({
    buildTargetLeaf: "shard-host-builds",
    cargoFeature: "native-quality-shard",
    features: Object.freeze(["native-quality-sample", "native-quality-shard", "native-sherpa"]),
    host: "meetingrelay-sherpa-candidate-quality-shard-host",
    kind: "meetingrelay-quality-shard-host-source-build-attestation-v1",
  }),
});
if (!Object.hasOwn(MODULE_PROFILES, MODULE_PROFILE_NAME)) {
  throw Object.assign(new Error("unsupported quality host attestor profile"), {
    code: "QUALITY_HOST_ATTESTOR_PROFILE",
  });
}
const MODULE_PROFILE = MODULE_PROFILES[MODULE_PROFILE_NAME];
const KIND = MODULE_PROFILE.kind;
const SCHEMA_VERSION = "1.0";
const TARGET = "x86_64-pc-windows-msvc";
const PACKAGE = "meetingrelay-model-worker-sherpa-native";
const QUALITY_HOST = MODULE_PROFILE.host;
const QUALITY_HOST_EXE = `${QUALITY_HOST}.exe`;
const FEATURES = MODULE_PROFILE.features;
const CARGO_ARGS = Object.freeze([
  "build",
  "--release",
  "-p",
  PACKAGE,
  "--no-default-features",
  "--features",
  MODULE_PROFILE.cargoFeature,
  "--bin",
  QUALITY_HOST,
  "--message-format=json",
  "--offline",
  "--locked",
]);
const AUTHORITY = Object.freeze({
  execution_status: "not-run",
  formal_claims: "none",
  materialization_status: "not-run",
  production_evidence: false,
  public_distribution: false,
  quality_gate_status: "not-assessed",
});
const REQUIRED_DLL_CHARACTERISTICS = Object.freeze([
  "DYNAMIC_BASE",
  "GUARD_CF",
  "HIGH_ENTROPY_VA",
  "NX_COMPAT",
]);
const REQUIRED_DLL_CHARACTERISTICS_MASK = 0x0040 | 0x0020 | 0x0100 | 0x4000;
const SYSTEM_DLL_ALLOWLIST = new Set([
  "api-ms-win-core-synch-l1-2-0.dll",
  "api-ms-win-crt-heap-l1-1-0.dll",
  "api-ms-win-crt-locale-l1-1-0.dll",
  "api-ms-win-crt-math-l1-1-0.dll",
  "api-ms-win-crt-runtime-l1-1-0.dll",
  "api-ms-win-crt-stdio-l1-1-0.dll",
  "api-ms-win-crt-string-l1-1-0.dll",
  "advapi32.dll",
  "bcrypt.dll",
  "bcryptprimitives.dll",
  "cfgmgr32.dll",
  "combase.dll",
  "crypt32.dll",
  "dbghelp.dll",
  "dxgi.dll",
  "gdi32.dll",
  "kernel32.dll",
  "msvcp140.dll",
  "ntdll.dll",
  "ole32.dll",
  "oleaut32.dll",
  "rpcrt4.dll",
  "secur32.dll",
  "setupapi.dll",
  "shell32.dll",
  "user32.dll",
  "userenv.dll",
  "ucrtbase.dll",
  "vcruntime140.dll",
  "vcruntime140_1.dll",
  "version.dll",
  "winmm.dll",
  "ws2_32.dll",
]);
const INPUT_KEYS = Object.freeze([
  "assetLockPath",
  "expectedSourceCommit",
  "outputPath",
  "runtimeDir",
]);
const COMMIT = /^(?!0{40}$)[0-9a-f]{40}$/u;
const DIGEST = /^(?!0{64}$)[0-9a-f]{64}$/u;
const GIT_OBJECT_ID = /^(?!0+$)(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const TOOLCHAIN_RELEASE = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9._-]+)?$/u;
const MAX_GIT_INDEX_BYTES = 32 * 1024 * 1024;
const MAX_CARGO_OUTPUT_BYTES = 128 * 1024 * 1024;
const MAX_INPUT_BYTES = 64 * 1024;
const MAX_LOCK_BYTES = 1024 * 1024;
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
const OUTPUT_SUBTREE_RELATIVE = Object.freeze([
  "target",
  "sherpa-native",
  "formal-run-trust",
  "build-attestations",
]);
const BUILD_TARGET_SUBTREE_RELATIVE = Object.freeze([
  "target",
  "sherpa-native",
  "formal-run-trust",
  MODULE_PROFILE.buildTargetLeaf,
]);
const CONTROLLED_ENCODED_RUSTFLAGS = Object.freeze([
  "-Ccontrol-flow-guard=checks",
  "-Clink-arg=/DYNAMICBASE",
  "-Clink-arg=/HIGHENTROPYVA",
  "-Clink-arg=/NXCOMPAT",
  "-Clink-arg=/GUARD:CF",
].join("\u001f"));

export class QualityHostSourceBuildAttestorError extends Error {
  constructor(code, options) {
    super(code, options);
    this.name = "QualityHostSourceBuildAttestorError";
    this.code = code;
  }
}

function fail(code, cause) {
  throw new QualityHostSourceBuildAttestorError(
    code,
    cause === undefined ? undefined : { cause },
  );
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function isPlainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, expected, code) {
  if (!isPlainRecord(value)) fail(code);
  const actual = Object.keys(value).sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    fail(code);
  }
}

function decodeUtf8(bytes, code, maximumBytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > maximumBytes) fail(code);
  let text;
  try {
    text = UTF8.decode(bytes);
  } catch (error) {
    fail(code, error);
  }
  if (text.startsWith("\uFEFF") || !Buffer.from(text, "utf8").equals(bytes)) fail(code);
  return text;
}

function canonicalPathKey(value) {
  let normalized = path.win32.normalize(value);
  if (/^\\\\\?\\[A-Za-z]:\\/u.test(normalized)) normalized = normalized.slice(4);
  return normalized.toLowerCase();
}

function assertCanonicalLocalAbsolutePath(value, code) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    value !== value.normalize("NFC") ||
    !path.win32.isAbsolute(value) ||
    path.win32.normalize(value) !== value ||
    !/^[A-Za-z]:\\$/u.test(path.win32.parse(value).root)
  ) {
    fail(code);
  }
  const reserved = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;
  const root = path.win32.parse(value).root;
  for (const segment of path.win32.relative(root, value).split(path.win32.sep).filter(Boolean)) {
    if (
      segment.endsWith(".") ||
      segment.endsWith(" ") ||
      /[\u0000-\u001f<>:"|?*]/u.test(segment) ||
      reserved.test(segment)
    ) {
      fail(code);
    }
  }
}

function validateInput(input) {
  exactKeys(input, INPUT_KEYS, "QUALITY_HOST_ATTESTOR_INPUT");
  if (!COMMIT.test(input.expectedSourceCommit)) fail("QUALITY_HOST_ATTESTOR_INPUT");
  for (const field of ["assetLockPath", "outputPath", "runtimeDir"]) {
    assertCanonicalLocalAbsolutePath(input[field], "QUALITY_HOST_ATTESTOR_INPUT");
  }
  const uniquePaths = new Set([
    canonicalPathKey(input.assetLockPath),
    canonicalPathKey(input.outputPath),
    canonicalPathKey(input.runtimeDir),
  ]);
  if (uniquePaths.size !== 3) fail("QUALITY_HOST_ATTESTOR_INPUT");
  return Object.freeze({ ...input });
}

function environmentValue(environment, wanted) {
  const matches = Object.entries(environment ?? {})
    .filter(([key]) => key.toUpperCase() === wanted.toUpperCase());
  if (matches.length > 1) fail("QUALITY_HOST_ATTESTOR_ENVIRONMENT");
  return matches.length === 0 ? undefined : matches[0][1];
}

function assertNoAmbientInjection(environment) {
  const exact = new Set([
    "AR",
    "CARGO_BUILD_TARGET",
    "CARGO_ENCODED_RUSTFLAGS",
    "CARGO_HOME",
    "CARGO_INCREMENTAL",
    "CARGO_NET_OFFLINE",
    "CARGO_TARGET_DIR",
    "CC",
    "CFLAGS",
    "CL",
    "CXXFLAGS",
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_NOSYSTEM",
    "GIT_CONFIG_SYSTEM",
    "GIT_DIR",
    "GIT_WORK_TREE",
    "LDFLAGS",
    "LINK",
    "RUSTC",
    "RUSTC_BOOTSTRAP",
    "RUSTC_WRAPPER",
    "RUSTC_WORKSPACE_WRAPPER",
    "RUSTDOCFLAGS",
    "RUSTFLAGS",
    "RUSTUP_HOME",
    "RUSTUP_TOOLCHAIN",
    "SHERPA_ONNX_LIB_DIR",
    "_CL_",
  ]);
  for (const [key, value] of Object.entries(environment ?? {})) {
    if (value === undefined || value === null || String(value).length === 0) continue;
    const upper = key.toUpperCase();
    if (
      exact.has(upper) ||
      upper.startsWith("CARGO_PROFILE_") ||
      /^CARGO_TARGET_.*_(?:LINKER|RUNNER|RUSTFLAGS)$/u.test(upper) ||
      /^(?:AR|CC|CFLAGS|CXXFLAGS|LDFLAGS)_/u.test(upper)
    ) {
      fail("QUALITY_HOST_ATTESTOR_ENVIRONMENT");
    }
  }
}

function controlledEnvironments(environment) {
  assertNoAmbientInjection(environment);
  const systemRoot = environmentValue(environment, "SystemRoot");
  const userProfile = environmentValue(environment, "USERPROFILE");
  const pathValue = environmentValue(environment, "Path") ?? environmentValue(environment, "PATH");
  const temp = environmentValue(environment, "TEMP");
  const tmp = environmentValue(environment, "TMP") ?? temp;
  for (const value of [systemRoot, userProfile, temp, tmp]) {
    assertCanonicalLocalAbsolutePath(value, "QUALITY_HOST_ATTESTOR_ENVIRONMENT");
  }
  if (typeof pathValue !== "string" || pathValue.length === 0 || pathValue.includes("\0")) {
    fail("QUALITY_HOST_ATTESTOR_ENVIRONMENT");
  }
  const base = {
    ComSpec: path.win32.join(systemRoot, "System32", "cmd.exe"),
    HOME: userProfile,
    Path: pathValue,
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    SystemRoot: systemRoot,
    TEMP: temp,
    TMP: tmp,
    USERPROFILE: userProfile,
    WINDIR: systemRoot,
  };
  const git = Object.freeze({
    ...base,
    GIT_CONFIG_COUNT: "0",
    GIT_CONFIG_GLOBAL: "NUL",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "NUL",
    GIT_OPTIONAL_LOCKS: "0",
    LANG: "C",
    LC_ALL: "C",
  });
  const build = Object.freeze({
    ...base,
    CARGO_ENCODED_RUSTFLAGS: CONTROLLED_ENCODED_RUSTFLAGS,
    CARGO_INCREMENTAL: "0",
    CARGO_NET_OFFLINE: "true",
  });
  return Object.freeze({ build, git, resolver: Object.freeze(base), systemRoot, userProfile });
}

function qualityHostBuildTargetRoot(repoRoot, sourceCommit) {
  if (!COMMIT.test(sourceCommit)) fail("QUALITY_HOST_ATTESTOR_BUILD_TARGET");
  return path.win32.join(repoRoot, ...BUILD_TARGET_SUBTREE_RELATIVE, sourceCommit);
}

function buildEnvironmentForTarget(environments, buildTargetRoot, runtimeDir) {
  assertCanonicalLocalAbsolutePath(buildTargetRoot, "QUALITY_HOST_ATTESTOR_BUILD_TARGET");
  assertCanonicalLocalAbsolutePath(runtimeDir, "QUALITY_HOST_ATTESTOR_RUNTIME_INVENTORY");
  return Object.freeze({
    ...environments.build,
    CARGO_TARGET_DIR: buildTargetRoot,
    SHERPA_ONNX_LIB_DIR: runtimeDir,
  });
}

function assertSafeTrackedPath(trackedPath) {
  if (trackedPath !== trackedPath.normalize("NFC")) {
    fail("QUALITY_HOST_ATTESTOR_SOURCE_NFC_CONFLICT");
  }
  if (
    trackedPath.length === 0 ||
    trackedPath.startsWith("/") ||
    trackedPath.endsWith("/") ||
    trackedPath.includes("\\") ||
    trackedPath.includes("\0")
  ) {
    fail("QUALITY_HOST_ATTESTOR_SOURCE_PATH");
  }
  const reserved = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;
  const segments = trackedPath.split("/");
  if (
    segments.some((segment) =>
      segment.length === 0 ||
      segment === "." ||
      segment === ".." ||
      segment.endsWith(".") ||
      segment.endsWith(" ") ||
      /[\u0000-\u001f<>:"|?*]/u.test(segment) ||
      reserved.test(segment))
  ) {
    fail("QUALITY_HOST_ATTESTOR_SOURCE_PATH");
  }
}

function parseGitLsFilesStageZ(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_GIT_INDEX_BYTES) {
    fail("QUALITY_HOST_ATTESTOR_SOURCE_INDEX");
  }
  if (bytes.length !== 0 && bytes.at(-1) !== 0) fail("QUALITY_HOST_ATTESTOR_SOURCE_INDEX");
  const entries = [];
  const exactPaths = new Set();
  const casePaths = new Set();
  let offset = 0;
  while (offset < bytes.length) {
    const end = bytes.indexOf(0, offset);
    if (end < 0 || end === offset) fail("QUALITY_HOST_ATTESTOR_SOURCE_INDEX");
    const record = bytes.subarray(offset, end);
    const tab = record.indexOf(0x09);
    if (tab < 0 || record.indexOf(0x09, tab + 1) >= 0) {
      fail("QUALITY_HOST_ATTESTOR_SOURCE_INDEX");
    }
    const header = decodeUtf8(
      record.subarray(0, tab),
      "QUALITY_HOST_ATTESTOR_SOURCE_INDEX",
      256,
    );
    const match = /^([0-7]{6}) ([0-9a-f]{40}|[0-9a-f]{64}) ([0-3])$/u.exec(header);
    if (match === null || !GIT_OBJECT_ID.test(match[2])) {
      fail("QUALITY_HOST_ATTESTOR_SOURCE_INDEX");
    }
    const stage = Number(match[3]);
    if (stage !== 0) fail("QUALITY_HOST_ATTESTOR_SOURCE_STAGE");
    if (match[1] !== "100644" && match[1] !== "100755") {
      fail("QUALITY_HOST_ATTESTOR_SOURCE_MODE");
    }
    const trackedPath = decodeUtf8(
      record.subarray(tab + 1),
      "QUALITY_HOST_ATTESTOR_SOURCE_PATH",
      32 * 1024,
    );
    assertSafeTrackedPath(trackedPath);
    if (exactPaths.has(trackedPath)) fail("QUALITY_HOST_ATTESTOR_SOURCE_INDEX");
    const caseKey = trackedPath.toLowerCase();
    if (casePaths.has(caseKey)) fail("QUALITY_HOST_ATTESTOR_SOURCE_CASE_CONFLICT");
    exactPaths.add(trackedPath);
    casePaths.add(caseKey);
    entries.push({
      mode: match[1],
      object_id: match[2],
      path: trackedPath,
      stage,
    });
    offset = end + 1;
  }
  entries.sort((left, right) => Buffer.compare(
    Buffer.from(left.path, "utf8"),
    Buffer.from(right.path, "utf8"),
  ));
  return entries;
}

export function __parseGitLsFilesStageZForTest(bytes) {
  return parseGitLsFilesStageZ(bytes);
}

function asCommandResult(result, code) {
  if (
    !isPlainRecord(result) ||
    !Number.isInteger(result.exitCode) ||
    !Buffer.isBuffer(result.stdout) ||
    !Buffer.isBuffer(result.stderr)
  ) {
    fail(code);
  }
  if (result.exitCode !== 0) fail(code);
  return result;
}

async function runChecked(ops, executable, args, code, options = {}) {
  let result;
  try {
    result = await ops.runCommand(executable, args, {
      cwd: options.cwd,
      env: options.env,
      maxBuffer: options.maxBuffer,
      timeout: options.timeout,
    });
  } catch (error) {
    fail(code, error);
  }
  return asCommandResult(result, code);
}

async function readStableIdentity(ops, filePath, code) {
  let snapshot;
  try {
    snapshot = await ops.readStableFileIdentity(filePath);
  } catch (error) {
    fail(code, error);
  }
  if (
    !isPlainRecord(snapshot) ||
    !Buffer.isBuffer(snapshot.bytes) ||
    typeof snapshot.identity !== "string" ||
    snapshot.identity.length === 0 ||
    snapshot.identity.length > 512
  ) {
    fail(code);
  }
  return snapshot;
}

async function resolveBuildTools(ops, environments) {
  const wherePath = path.win32.join(environments.systemRoot, "System32", "where.exe");
  await readStableIdentity(ops, wherePath, "QUALITY_HOST_ATTESTOR_TOOL_RESOLUTION");
  const tools = {};
  for (const name of ["git", "cargo", "rustc"]) {
    const result = await runChecked(
      ops,
      wherePath,
      [`${name}.exe`],
      "QUALITY_HOST_ATTESTOR_TOOL_RESOLUTION",
      { env: environments.resolver, maxBuffer: MAX_INPUT_BYTES, timeout: 30_000 },
    );
    const text = decodeUtf8(
      result.stdout,
      "QUALITY_HOST_ATTESTOR_TOOL_RESOLUTION",
      MAX_INPUT_BYTES,
    );
    const lines = text.split(/\r?\n/u).filter((line) => line.length > 0);
    if (result.stderr.length !== 0 || lines.length === 0) {
      fail("QUALITY_HOST_ATTESTOR_TOOL_RESOLUTION");
    }
    const resolvedPaths = [];
    const seenPaths = new Set();
    for (const line of lines) {
      const resolvedPath = path.win32.normalize(line);
      assertCanonicalLocalAbsolutePath(
        resolvedPath,
        "QUALITY_HOST_ATTESTOR_TOOL_RESOLUTION",
      );
      if (
        path.win32.basename(resolvedPath).toLowerCase() !== `${name}.exe` ||
        seenPaths.has(canonicalPathKey(resolvedPath))
      ) {
        fail("QUALITY_HOST_ATTESTOR_TOOL_RESOLUTION");
      }
      seenPaths.add(canonicalPathKey(resolvedPath));
      resolvedPaths.push(resolvedPath);
    }
    const executablePath = resolvedPaths[0];
    const snapshot = await readStableIdentity(
      ops,
      executablePath,
      "QUALITY_HOST_ATTESTOR_TOOL_RESOLUTION",
    );
    tools[name] = Object.freeze({
      identity: snapshot.identity,
      path: executablePath,
      sha256: sha256(snapshot.bytes),
      size: snapshot.bytes.length,
    });
  }
  return Object.freeze(tools);
}

async function assertToolsStable(ops, tools) {
  for (const tool of Object.values(tools)) {
    const snapshot = await readStableIdentity(
      ops,
      tool.path,
      "QUALITY_HOST_ATTESTOR_TOOL_DRIFT",
    );
    if (
      snapshot.identity !== tool.identity ||
      snapshot.bytes.length !== tool.size ||
      sha256(snapshot.bytes) !== tool.sha256
    ) {
      fail("QUALITY_HOST_ATTESTOR_TOOL_DRIFT");
    }
  }
}

function singleLine(bytes, code, maximumBytes = 64 * 1024) {
  const text = decodeUtf8(bytes, code, maximumBytes);
  const line = text.replace(/\r?\n$/u, "");
  if (line.length === 0 || line.includes("\n") || line.includes("\r")) fail(code);
  return line;
}

function trackedAbsolutePath(repoRoot, trackedPath) {
  const result = path.win32.join(repoRoot, ...trackedPath.split("/"));
  const relative = path.win32.relative(repoRoot, result);
  if (relative.startsWith("..") || path.win32.isAbsolute(relative)) {
    fail("QUALITY_HOST_ATTESTOR_SOURCE_PATH");
  }
  return result;
}

async function readSourceSnapshot(
  ops,
  repoRoot,
  expectedSourceCommit,
  gitExecutable,
  gitEnvironment,
) {
  const head = singleLine(
    (await runChecked(
      ops,
      gitExecutable,
      ["rev-parse", "--verify", "HEAD"],
      "QUALITY_HOST_ATTESTOR_GIT_COMMAND",
      { cwd: repoRoot, env: gitEnvironment, maxBuffer: 64 * 1024, timeout: 30_000 },
    )).stdout,
    "QUALITY_HOST_ATTESTOR_SOURCE_COMMIT",
  );
  if (head !== expectedSourceCommit) fail("QUALITY_HOST_ATTESTOR_SOURCE_COMMIT");
  const status = await runChecked(
    ops,
    gitExecutable,
    ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"],
    "QUALITY_HOST_ATTESTOR_GIT_COMMAND",
    { cwd: repoRoot, env: gitEnvironment, maxBuffer: MAX_GIT_INDEX_BYTES, timeout: 30_000 },
  );
  if (status.stdout.length !== 0) fail("QUALITY_HOST_ATTESTOR_SOURCE_DIRTY");
  const stageBytes = (await runChecked(
    ops,
    gitExecutable,
    ["ls-files", "--stage", "-z"],
    "QUALITY_HOST_ATTESTOR_GIT_COMMAND",
    { cwd: repoRoot, env: gitEnvironment, maxBuffer: MAX_GIT_INDEX_BYTES, timeout: 30_000 },
  )).stdout;
  const entries = parseGitLsFilesStageZ(stageBytes);
  const manifest = [];
  const fileDigests = new Map();
  for (const entry of entries) {
    let bytes;
    try {
      bytes = await ops.readStableFile(trackedAbsolutePath(repoRoot, entry.path));
    } catch (error) {
      fail("QUALITY_HOST_ATTESTOR_SOURCE_READ", error);
    }
    if (!Buffer.isBuffer(bytes)) fail("QUALITY_HOST_ATTESTOR_SOURCE_READ");
    const fileSha256 = sha256(bytes);
    fileDigests.set(entry.path, fileSha256);
    manifest.push({
      mode: entry.mode,
      object_id: entry.object_id,
      path: entry.path,
      sha256: fileSha256,
      size_bytes: bytes.length,
    });
  }
  const cargoLockSha256 = fileDigests.get("Cargo.lock");
  if (cargoLockSha256 === undefined) fail("QUALITY_HOST_ATTESTOR_CARGO_LOCK");
  const rustToolchainSha256 = fileDigests.get("rust-toolchain.toml");
  if (rustToolchainSha256 === undefined) fail("QUALITY_HOST_ATTESTOR_RUST_TOOLCHAIN");
  let rustToolchainBytes;
  try {
    rustToolchainBytes = await ops.readStableFile(
      trackedAbsolutePath(repoRoot, "rust-toolchain.toml"),
    );
  } catch (error) {
    fail("QUALITY_HOST_ATTESTOR_RUST_TOOLCHAIN", error);
  }
  if (
    !Buffer.isBuffer(rustToolchainBytes) ||
    sha256(rustToolchainBytes) !== rustToolchainSha256
  ) {
    fail("QUALITY_HOST_ATTESTOR_SOURCE_DRIFT");
  }
  const manifestBytes = Buffer.from(encodeCanonicalJsonLine(manifest), "utf8");
  return {
    cargoLockSha256,
    fileDigests,
    head,
    indexSha256: sha256(stageBytes),
    manifest,
    rustToolchainBytes,
    rustToolchainSha256,
    treeSha256: sha256(manifestBytes),
  };
}

async function optionalDirectory(ops, directory, code) {
  let entries;
  try {
    entries = await ops.listDirectoryIfExists(directory);
  } catch (error) {
    fail(code, error);
  }
  if (entries === null) return null;
  if (!Array.isArray(entries)) fail(code);
  return entries;
}

function findCargoConfigEntries(entries, code) {
  const matches = [];
  for (const entry of entries) {
    exactKeys(entry, ["kind", "name"], code);
    if (typeof entry.name !== "string" || typeof entry.kind !== "string") fail(code);
    const lower = entry.name.toLowerCase();
    if (lower === "config" || lower === "config.toml") matches.push(entry);
  }
  return matches;
}

async function scanCargoConfiguration(ops, repoRoot, source, userProfile) {
  const code = "QUALITY_HOST_ATTESTOR_CARGO_CONFIG";
  const workspaceCargo = path.win32.join(repoRoot, ".cargo");
  const workspaceEntries = await optionalDirectory(ops, workspaceCargo, code);
  if (workspaceEntries === null) fail(code);
  const workspaceConfigs = findCargoConfigEntries(workspaceEntries, code);
  if (
    workspaceConfigs.length !== 1 ||
    workspaceConfigs[0].name !== "config.toml" ||
    workspaceConfigs[0].kind !== "file" ||
    source.fileDigests.get(".cargo/config.toml") === undefined
  ) {
    fail(code);
  }
  let workspaceBytes;
  try {
    workspaceBytes = await ops.readStableFile(path.win32.join(workspaceCargo, "config.toml"));
  } catch (error) {
    fail(code, error);
  }
  if (
    !Buffer.isBuffer(workspaceBytes) ||
    sha256(workspaceBytes) !== source.fileDigests.get(".cargo/config.toml")
  ) {
    fail(code);
  }

  const checked = new Set([canonicalPathKey(workspaceCargo)]);
  const external = [];
  let current = path.win32.dirname(repoRoot);
  while (true) {
    const cargoDirectory = path.win32.join(current, ".cargo");
    const key = canonicalPathKey(cargoDirectory);
    if (!checked.has(key)) {
      checked.add(key);
      const entries = await optionalDirectory(ops, cargoDirectory, code);
      if (entries !== null) {
        if (findCargoConfigEntries(entries, code).length !== 0) fail(code);
        external.push({ directory_key_sha256: sha256(Buffer.from(key, "utf8")), entries: [] });
      }
    }
    const parent = path.win32.dirname(current);
    if (canonicalPathKey(parent) === canonicalPathKey(current)) break;
    current = parent;
  }
  const userCargo = path.win32.join(userProfile, ".cargo");
  if (!checked.has(canonicalPathKey(userCargo))) {
    const entries = await optionalDirectory(ops, userCargo, code);
    if (entries !== null && findCargoConfigEntries(entries, code).length !== 0) fail(code);
  }
  const fingerprint = sha256(Buffer.from(encodeCanonicalJsonLine({
    external,
    workspace_config_sha256: sha256(workspaceBytes),
  }), "utf8"));
  return fingerprint;
}

function parsePinnedToolchain(bytes) {
  const text = decodeUtf8(bytes, "QUALITY_HOST_ATTESTOR_RUST_TOOLCHAIN", MAX_INPUT_BYTES);
  const matches = [...text.matchAll(/^\s*channel\s*=\s*"([^"]+)"\s*$/gmu)];
  if (matches.length !== 1 || !TOOLCHAIN_RELEASE.test(matches[0][1])) {
    fail("QUALITY_HOST_ATTESTOR_RUST_TOOLCHAIN");
  }
  return matches[0][1];
}

function parseRustcIdentity(bytes, pinnedRelease) {
  const text = decodeUtf8(bytes, "QUALITY_HOST_ATTESTOR_RUSTC", MAX_INPUT_BYTES);
  const hosts = [...text.matchAll(/^host: ([^\r\n]+)$/gmu)].map((match) => match[1]);
  const releases = [...text.matchAll(/^release: ([^\r\n]+)$/gmu)].map((match) => match[1]);
  if (hosts.length !== 1 || hosts[0] !== TARGET) fail("QUALITY_HOST_ATTESTOR_TARGET");
  if (releases.length !== 1 || releases[0] !== pinnedRelease) {
    fail("QUALITY_HOST_ATTESTOR_RUST_TOOLCHAIN");
  }
  return { rustcVvSha256: sha256(bytes), target: TARGET };
}

function parseCargoIdentity(bytes, pinnedRelease) {
  const line = singleLine(bytes, "QUALITY_HOST_ATTESTOR_CARGO", MAX_INPUT_BYTES);
  const match = /^cargo ([0-9]+\.[0-9]+\.[0-9]+)(?: \([0-9a-f]+ [0-9]{4}-[0-9]{2}-[0-9]{2}\))?$/u.exec(line);
  if (match === null || match[1] !== pinnedRelease) {
    fail("QUALITY_HOST_ATTESTOR_CARGO");
  }
  return { cargoVSha256: sha256(bytes) };
}

function sameStringArray(actual, expected) {
  return Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index]);
}

function parseCargoArtifact(bytes, expectedExecutablePath) {
  const text = decodeUtf8(bytes, "QUALITY_HOST_ATTESTOR_BUILD", MAX_CARGO_OUTPUT_BYTES);
  const matching = [];
  for (const line of text.split(/\r?\n/u)) {
    if (line.length === 0) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      fail("QUALITY_HOST_ATTESTOR_BUILD", error);
    }
    if (
      isPlainRecord(message) &&
      message.reason === "compiler-artifact" &&
      isPlainRecord(message.target) &&
      message.target.name === QUALITY_HOST
    ) {
      matching.push(message);
    }
  }
  if (matching.length !== 1) fail("QUALITY_HOST_ATTESTOR_ARTIFACT");
  const artifact = matching[0];
  if (
    typeof artifact.package_id !== "string" ||
    !artifact.package_id.includes(PACKAGE) ||
    artifact.executable !== expectedExecutablePath ||
    !Array.isArray(artifact.filenames) ||
    !artifact.filenames.includes(expectedExecutablePath) ||
    !sameStringArray(artifact.features, FEATURES) ||
    !sameStringArray(artifact.target.kind, ["bin"]) ||
    !sameStringArray(artifact.target.crate_types, ["bin"]) ||
    artifact.target.test !== false ||
    !isPlainRecord(artifact.profile) ||
    artifact.profile.test !== false ||
    artifact.profile.debug_assertions !== false ||
    artifact.profile.opt_level !== "3" ||
    (artifact.profile.debuginfo !== 0 && artifact.profile.debuginfo !== null)
  ) {
    fail("QUALITY_HOST_ATTESTOR_ARTIFACT");
  }
  return artifact;
}

function peRvaToOffset(bytes, rva, sizeOfHeaders, sections) {
  if (rva > 0 && rva < sizeOfHeaders && rva < bytes.length) return rva;
  const matches = sections.filter((section) => {
    const extent = Math.max(section.virtualSize, section.rawSize);
    return rva >= section.virtualAddress && rva < section.virtualAddress + extent;
  });
  if (matches.length !== 1) fail("QUALITY_HOST_ATTESTOR_PE_IMPORTS");
  const section = matches[0];
  const delta = rva - section.virtualAddress;
  if (delta >= section.rawSize || section.rawOffset + delta >= bytes.length) {
    fail("QUALITY_HOST_ATTESTOR_PE_IMPORTS");
  }
  return section.rawOffset + delta;
}

function readPeImportName(bytes, offset) {
  const maximumEnd = Math.min(bytes.length, offset + 260);
  let end = offset;
  while (end < maximumEnd && bytes[end] !== 0) end += 1;
  if (end === offset || end === maximumEnd) fail("QUALITY_HOST_ATTESTOR_PE_IMPORTS");
  const nameBytes = bytes.subarray(offset, end);
  if (nameBytes.some((value) => value < 0x21 || value > 0x7e)) {
    fail("QUALITY_HOST_ATTESTOR_PE_IMPORTS");
  }
  const name = nameBytes.toString("ascii").toLowerCase();
  if (!/^[a-z0-9._-]+\.dll$/u.test(name)) fail("QUALITY_HOST_ATTESTOR_PE_IMPORTS");
  return name;
}

function parsePeImports(bytes, optionalOffset, optionalSize, sections, sizeOfHeaders) {
  const importDirectoryOffset = optionalOffset + 112 + 8;
  const delayImportDirectoryOffset = optionalOffset + 112 + 13 * 8;
  if (
    importDirectoryOffset + 8 > optionalOffset + optionalSize ||
    delayImportDirectoryOffset + 8 > optionalOffset + optionalSize
  ) {
    fail("QUALITY_HOST_ATTESTOR_PE_IMPORTS");
  }
  const delayRva = bytes.readUInt32LE(delayImportDirectoryOffset);
  const delaySize = bytes.readUInt32LE(delayImportDirectoryOffset + 4);
  if (delayRva !== 0 || delaySize !== 0) fail("QUALITY_HOST_ATTESTOR_PE_IMPORTS");
  const importRva = bytes.readUInt32LE(importDirectoryOffset);
  const importSize = bytes.readUInt32LE(importDirectoryOffset + 4);
  if (importRva === 0 || importSize < 40 || importSize > 64 * 1024) {
    fail("QUALITY_HOST_ATTESTOR_PE_IMPORTS");
  }
  const descriptorOffset = peRvaToOffset(bytes, importRva, sizeOfHeaders, sections);
  const descriptorLimit = Math.min(
    bytes.length,
    descriptorOffset + importSize,
    descriptorOffset + 20 * 1024,
  );
  const imports = [];
  const seen = new Set();
  let terminated = false;
  for (let offset = descriptorOffset; offset + 20 <= descriptorLimit; offset += 20) {
    const descriptor = bytes.subarray(offset, offset + 20);
    if (descriptor.every((value) => value === 0)) {
      terminated = true;
      break;
    }
    const nameRva = bytes.readUInt32LE(offset + 12);
    const firstThunkRva = bytes.readUInt32LE(offset + 16);
    if (nameRva === 0 || firstThunkRva === 0) fail("QUALITY_HOST_ATTESTOR_PE_IMPORTS");
    const name = readPeImportName(
      bytes,
      peRvaToOffset(bytes, nameRva, sizeOfHeaders, sections),
    );
    if (seen.has(name)) fail("QUALITY_HOST_ATTESTOR_PE_IMPORTS");
    seen.add(name);
    imports.push(name);
  }
  if (!terminated || imports.length === 0 || !seen.has("sherpa-onnx-c-api.dll")) {
    fail("QUALITY_HOST_ATTESTOR_PE_IMPORTS");
  }
  imports.sort((left, right) => Buffer.compare(
    Buffer.from(left, "ascii"),
    Buffer.from(right, "ascii"),
  ));
  return imports;
}

function parsePeIdentity(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 0x100) fail("QUALITY_HOST_ATTESTOR_PE");
  if (bytes[0] !== 0x4d || bytes[1] !== 0x5a) fail("QUALITY_HOST_ATTESTOR_PE");
  const peOffset = bytes.readUInt32LE(0x3c);
  if (
    peOffset < 0x40 ||
    peOffset > bytes.length - 24 - 70 ||
    !bytes.subarray(peOffset, peOffset + 4).equals(Buffer.from("PE\0\0", "ascii"))
  ) {
    fail("QUALITY_HOST_ATTESTOR_PE");
  }
  const machine = bytes.readUInt16LE(peOffset + 4);
  const sectionCount = bytes.readUInt16LE(peOffset + 6);
  const optionalSize = bytes.readUInt16LE(peOffset + 20);
  const characteristics = bytes.readUInt16LE(peOffset + 22);
  const optionalOffset = peOffset + 24;
  if (
    machine !== 0x8664 ||
    sectionCount < 1 ||
    sectionCount > 96 ||
    optionalSize < 70 ||
    optionalOffset + optionalSize > bytes.length ||
    bytes.readUInt16LE(optionalOffset) !== 0x20b ||
    bytes.readUInt16LE(optionalOffset + 68) !== 3 ||
    (characteristics & 0x0002) === 0 ||
    (characteristics & 0x2000) !== 0
  ) {
    fail("QUALITY_HOST_ATTESTOR_PE");
  }
  const dllCharacteristics = bytes.readUInt16LE(optionalOffset + 70);
  if (
    (dllCharacteristics & REQUIRED_DLL_CHARACTERISTICS_MASK) !==
    REQUIRED_DLL_CHARACTERISTICS_MASK
  ) {
    fail("QUALITY_HOST_ATTESTOR_PE_HARDENING");
  }
  const sectionTableOffset = optionalOffset + optionalSize;
  if (sectionTableOffset + sectionCount * 40 > bytes.length) fail("QUALITY_HOST_ATTESTOR_PE");
  const sections = [];
  for (let index = 0; index < sectionCount; index += 1) {
    const offset = sectionTableOffset + index * 40;
    const section = {
      rawOffset: bytes.readUInt32LE(offset + 20),
      rawSize: bytes.readUInt32LE(offset + 16),
      virtualAddress: bytes.readUInt32LE(offset + 12),
      virtualSize: bytes.readUInt32LE(offset + 8),
    };
    if (
      section.rawSize === 0 ||
      section.virtualAddress === 0 ||
      section.rawOffset + section.rawSize > bytes.length
    ) {
      fail("QUALITY_HOST_ATTESTOR_PE");
    }
    sections.push(section);
  }
  const sizeOfHeaders = bytes.readUInt32LE(optionalOffset + 60);
  if (sizeOfHeaders < sectionTableOffset + sectionCount * 40 || sizeOfHeaders > bytes.length) {
    fail("QUALITY_HOST_ATTESTOR_PE");
  }
  const imports = parsePeImports(
    bytes,
    optionalOffset,
    optionalSize,
    sections,
    sizeOfHeaders,
  );
  return {
    imports,
    pe_format: "PE32+",
    pe_machine: "amd64",
    pe_subsystem: "console",
    required_dll_characteristics: [...REQUIRED_DLL_CHARACTERISTICS],
  };
}

export function __parsePeIdentityForTest(bytes) {
  return parsePeIdentity(bytes);
}

function validateQualityHostImports(imports, lockedRuntime) {
  const allowed = new Set([
    ...SYSTEM_DLL_ALLOWLIST,
    ...lockedRuntime.dlls.map(({ path: inventoryPath }) =>
      path.posix.basename(inventoryPath).toLowerCase()),
  ]);
  if (
    !imports.includes("sherpa-onnx-c-api.dll") ||
    imports.some((name) => !allowed.has(name))
  ) {
    fail("QUALITY_HOST_ATTESTOR_PE_IMPORTS");
  }
}

function parseAssetLock(bytes) {
  const text = decodeUtf8(bytes, "QUALITY_HOST_ATTESTOR_ASSET_LOCK", MAX_LOCK_BYTES);
  let lock;
  try {
    lock = JSON.parse(text);
  } catch (error) {
    fail("QUALITY_HOST_ATTESTOR_ASSET_LOCK", error);
  }
  const archive = lock?.runtime?.archive;
  if (
    !isPlainRecord(archive) ||
    !Array.isArray(archive.inventory) ||
    archive.inventory.length !== 7 ||
    !DIGEST.test(archive.bundle_sha256) ||
    typeof archive.extracted_directory !== "string" ||
    !/^[A-Za-z0-9._-]+$/u.test(archive.extracted_directory) ||
    archive.extracted_directory !== archive.extracted_directory.normalize("NFC")
  ) {
    fail("QUALITY_HOST_ATTESTOR_ASSET_LOCK");
  }
  const seen = new Set();
  const caseSeen = new Set();
  let prior = "";
  for (const entry of archive.inventory) {
    exactKeys(entry, ["path", "sha256", "size_bytes"], "QUALITY_HOST_ATTESTOR_ASSET_LOCK");
    if (
      typeof entry.path !== "string" ||
      !/^lib\/[A-Za-z0-9._-]+$/u.test(entry.path) ||
      entry.path !== entry.path.normalize("NFC") ||
      !DIGEST.test(entry.sha256) ||
      !Number.isSafeInteger(entry.size_bytes) ||
      entry.size_bytes < 1 ||
      entry.path <= prior ||
      seen.has(entry.path) ||
      caseSeen.has(entry.path.toLowerCase())
    ) {
      fail("QUALITY_HOST_ATTESTOR_ASSET_LOCK");
    }
    prior = entry.path;
    seen.add(entry.path);
    caseSeen.add(entry.path.toLowerCase());
  }
  if (
    sha256(Buffer.from(JSON.stringify(archive.inventory), "utf8")) !==
    archive.bundle_sha256
  ) {
    fail("QUALITY_HOST_ATTESTOR_ASSET_LOCK");
  }
  const dlls = archive.inventory.filter(({ path: inventoryPath }) =>
    inventoryPath.endsWith(".dll"));
  if (dlls.length !== 4) fail("QUALITY_HOST_ATTESTOR_ASSET_LOCK");
  return {
    bundleSha256: archive.bundle_sha256,
    dlls,
    extractedDirectory: archive.extracted_directory,
    inventory: archive.inventory,
  };
}

function validateDirectoryEntries(entries, code) {
  if (!Array.isArray(entries)) fail(code);
  const names = new Set();
  const caseNames = new Set();
  for (const entry of entries) {
    exactKeys(entry, ["kind", "name"], code);
    if (
      typeof entry.name !== "string" ||
      entry.name.length === 0 ||
      entry.name !== entry.name.normalize("NFC") ||
      entry.name.includes("/") ||
      entry.name.includes("\\") ||
      entry.kind !== "file" ||
      names.has(entry.name) ||
      caseNames.has(entry.name.toLowerCase())
    ) {
      fail(code);
    }
    names.add(entry.name);
    caseNames.add(entry.name.toLowerCase());
  }
  return names;
}

async function validateFileIdentity(ops, filePath, record, code) {
  const snapshot = await readStableIdentity(ops, filePath, code);
  const { bytes } = snapshot;
  if (
    bytes.length !== record.size_bytes ||
    sha256(bytes) !== record.sha256
  ) {
    fail(code);
  }
  return {
    identity: snapshot.identity,
    name: path.win32.basename(filePath),
    sha256: record.sha256,
    size_bytes: record.size_bytes,
  };
}

async function validateRuntimeClosure(ops, runtimeDir, releaseDir, lockedRuntime) {
  let runtimeEntries;
  let releaseEntries;
  try {
    [runtimeEntries, releaseEntries] = await Promise.all([
      ops.listDirectory(runtimeDir),
      ops.listDirectory(releaseDir),
    ]);
  } catch (error) {
    fail("QUALITY_HOST_ATTESTOR_RUNTIME_INVENTORY", error);
  }
  const runtimeNames = validateDirectoryEntries(
    runtimeEntries,
    "QUALITY_HOST_ATTESTOR_RUNTIME_INVENTORY",
  );
  const expectedRuntimeNames = new Set(
    lockedRuntime.inventory.map(({ path: inventoryPath }) => path.posix.basename(inventoryPath)),
  );
  if (
    runtimeNames.size !== expectedRuntimeNames.size ||
    [...runtimeNames].some((name) => !expectedRuntimeNames.has(name))
  ) {
    fail("QUALITY_HOST_ATTESTOR_RUNTIME_INVENTORY");
  }
  const runtimeManifest = [];
  for (const record of lockedRuntime.inventory) {
    runtimeManifest.push(await validateFileIdentity(
      ops,
      path.win32.join(runtimeDir, path.posix.basename(record.path)),
      record,
      "QUALITY_HOST_ATTESTOR_RUNTIME_INVENTORY",
    ));
  }

  if (!Array.isArray(releaseEntries)) fail("QUALITY_HOST_ATTESTOR_RUNTIME_ADJACENCY");
  const adjacentDlls = releaseEntries.filter((entry) =>
    typeof entry?.name === "string" && entry.name.toLowerCase().endsWith(".dll"));
  const adjacentNames = validateDirectoryEntries(
    adjacentDlls,
    "QUALITY_HOST_ATTESTOR_RUNTIME_ADJACENCY",
  );
  const expectedDllNames = new Set(
    lockedRuntime.dlls.map(({ path: inventoryPath }) => path.posix.basename(inventoryPath)),
  );
  if (
    adjacentNames.size !== expectedDllNames.size ||
    [...adjacentNames].some((name) => !expectedDllNames.has(name))
  ) {
    fail("QUALITY_HOST_ATTESTOR_RUNTIME_ADJACENCY");
  }
  const adjacentManifest = [];
  for (const record of lockedRuntime.dlls) {
    adjacentManifest.push(await validateFileIdentity(
      ops,
      path.win32.join(releaseDir, path.posix.basename(record.path)),
      record,
      "QUALITY_HOST_ATTESTOR_RUNTIME_ADJACENCY",
    ));
  }
  return {
    adjacentManifest,
    bundleSha256: lockedRuntime.bundleSha256,
    runtimeManifest,
  };
}

async function collectBuildClosure(
  ops,
  executablePath,
  runtimeDir,
  releaseDir,
  lockedRuntime,
) {
  const executableSnapshot = await readStableIdentity(
    ops,
    executablePath,
    "QUALITY_HOST_ATTESTOR_ARTIFACT",
  );
  if (executableSnapshot.bytes.length < 1) fail("QUALITY_HOST_ATTESTOR_ARTIFACT");
  const pe = parsePeIdentity(executableSnapshot.bytes);
  validateQualityHostImports(pe.imports, lockedRuntime);
  const runtime = await validateRuntimeClosure(
    ops,
    runtimeDir,
    releaseDir,
    lockedRuntime,
  );
  const manifest = {
    adjacent_dlls: runtime.adjacentManifest,
    executable: {
      identity: executableSnapshot.identity,
      name: QUALITY_HOST_EXE,
      sha256: sha256(executableSnapshot.bytes),
      size_bytes: executableSnapshot.bytes.length,
    },
    runtime_inventory: runtime.runtimeManifest,
  };
  return {
    executableBytes: executableSnapshot.bytes,
    fingerprint: sha256(Buffer.from(encodeCanonicalJsonLine(manifest), "utf8")),
    manifest,
    pe,
    runtimeBundleSha256: runtime.bundleSha256,
  };
}

function sameSnapshot(before, after) {
  return before.head === after.head &&
    before.indexSha256 === after.indexSha256 &&
    before.treeSha256 === after.treeSha256 &&
    before.cargoLockSha256 === after.cargoLockSha256 &&
    before.rustToolchainSha256 === after.rustToolchainSha256;
}

async function verifyBuildTargetBinding(ops, binding) {
  try {
    if (await ops.verifyBuildTargetBinding(binding) !== true) {
      fail("QUALITY_HOST_ATTESTOR_BUILD_TARGET");
    }
  } catch (error) {
    if (error instanceof QualityHostSourceBuildAttestorError) throw error;
    fail("QUALITY_HOST_ATTESTOR_BUILD_TARGET", error);
  }
}

async function attestCore(rawInput, ops) {
  const input = validateInput(rawInput);
  if (ops?.platform !== "win32") fail("QUALITY_HOST_ATTESTOR_PLATFORM");
  if (
    typeof ops.runCommand !== "function" ||
    typeof ops.readStableFile !== "function" ||
    typeof ops.readStableFileIdentity !== "function" ||
    typeof ops.listDirectory !== "function" ||
    typeof ops.listDirectoryIfExists !== "function" ||
    typeof ops.publishCreateNew !== "function" ||
    typeof ops.bindBuildTarget !== "function" ||
    typeof ops.verifyBuildTargetBinding !== "function"
  ) {
    fail("QUALITY_HOST_ATTESTOR_INTERNAL");
  }
  const environments = controlledEnvironments(ops.environment);
  const tools = await resolveBuildTools(ops, environments);
  const rootResult = await runChecked(
    ops,
    tools.git.path,
    ["rev-parse", "--show-toplevel"],
    "QUALITY_HOST_ATTESTOR_GIT_COMMAND",
    {
      cwd: ops.cwd,
      env: environments.git,
      maxBuffer: 64 * 1024,
      timeout: 30_000,
    },
  );
  const repoRoot = path.win32.normalize(singleLine(
    rootResult.stdout,
    "QUALITY_HOST_ATTESTOR_GIT_COMMAND",
  ));
  assertCanonicalLocalAbsolutePath(repoRoot, "QUALITY_HOST_ATTESTOR_GIT_COMMAND");
  const expectedAssetLockPath = path.win32.join(
    repoRoot,
    "tools",
    "sherpa-native",
    "assets.lock.json",
  );
  if (input.assetLockPath !== expectedAssetLockPath) {
    fail("QUALITY_HOST_ATTESTOR_ASSET_LOCK");
  }
  const outputRoot = path.win32.join(repoRoot, ...OUTPUT_SUBTREE_RELATIVE);
  if (
    canonicalPathKey(path.win32.dirname(input.outputPath)) !== canonicalPathKey(outputRoot) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/u.test(path.win32.basename(input.outputPath))
  ) {
    fail("QUALITY_HOST_ATTESTOR_OUTPUT_PATH");
  }
  const before = await readSourceSnapshot(
    ops,
    repoRoot,
    input.expectedSourceCommit,
    tools.git.path,
    environments.git,
  );
  const cargoConfigBefore = await scanCargoConfiguration(
    ops,
    repoRoot,
    before,
    environments.userProfile,
  );

  const relativeAssetLock = "tools/sherpa-native/assets.lock.json";
  if (
    before.fileDigests.get(relativeAssetLock) === undefined
  ) {
    fail("QUALITY_HOST_ATTESTOR_ASSET_LOCK");
  }
  let assetLockBytes;
  try {
    assetLockBytes = await ops.readStableFile(input.assetLockPath);
  } catch (error) {
    fail("QUALITY_HOST_ATTESTOR_ASSET_LOCK", error);
  }
  if (
    !Buffer.isBuffer(assetLockBytes) ||
    sha256(assetLockBytes) !== before.fileDigests.get(relativeAssetLock)
  ) {
    fail("QUALITY_HOST_ATTESTOR_SOURCE_DRIFT");
  }
  const lockedRuntime = parseAssetLock(assetLockBytes);
  const expectedRuntimeDir = path.win32.join(
    repoRoot,
    "target",
    "sherpa-native",
    "extracted",
    lockedRuntime.extractedDirectory,
    "lib",
  );
  if (input.runtimeDir !== expectedRuntimeDir) {
    fail("QUALITY_HOST_ATTESTOR_RUNTIME_INVENTORY");
  }
  const relativeOutput = path.win32.relative(repoRoot, input.outputPath)
    .split(path.win32.sep)
    .join("/");
  if (before.fileDigests.has(relativeOutput)) fail("QUALITY_HOST_ATTESTOR_OUTPUT_PATH");
  const ignoreResult = await runChecked(
    ops,
    tools.git.path,
    ["check-ignore", "--quiet", "--no-index", "--", input.outputPath],
    "QUALITY_HOST_ATTESTOR_OUTPUT_PATH",
    {
      cwd: repoRoot,
      env: environments.git,
      maxBuffer: 64 * 1024,
      timeout: 30_000,
    },
  );
  if (ignoreResult.stdout.length !== 0 || ignoreResult.stderr.length !== 0) {
    fail("QUALITY_HOST_ATTESTOR_OUTPUT_PATH");
  }
  let outputEntries;
  try {
    outputEntries = await ops.listDirectory(outputRoot);
  } catch (error) {
    fail("QUALITY_HOST_ATTESTOR_OUTPUT_PATH", error);
  }
  if (
    !Array.isArray(outputEntries) ||
    outputEntries.some((entry) =>
      typeof entry?.name !== "string" ||
      entry.name.toLowerCase() === path.win32.basename(input.outputPath).toLowerCase())
  ) {
    fail("QUALITY_HOST_ATTESTOR_OUTPUT_EXISTS");
  }

  const buildTargetRoot = qualityHostBuildTargetRoot(repoRoot, input.expectedSourceCommit);
  let buildTargetBinding;
  try {
    buildTargetBinding = await ops.bindBuildTarget({
      buildTargetRoot,
      repoRoot,
      requireAbsent: true,
    });
  } catch (error) {
    if (error?.code === "EEXIST") {
      fail("QUALITY_HOST_ATTESTOR_BUILD_TARGET_EXISTS", error);
    }
    fail("QUALITY_HOST_ATTESTOR_BUILD_TARGET", error);
  }
  await verifyBuildTargetBinding(ops, buildTargetBinding);
  const buildEnvironment = buildEnvironmentForTarget(
    environments,
    buildTargetRoot,
    input.runtimeDir,
  );

  const pinnedRelease = parsePinnedToolchain(before.rustToolchainBytes);
  const rustcResult = await runChecked(
    ops,
    tools.rustc.path,
    ["-vV"],
    "QUALITY_HOST_ATTESTOR_RUSTC",
    {
      cwd: repoRoot,
      env: buildEnvironment,
      maxBuffer: MAX_INPUT_BYTES,
      timeout: 60_000,
    },
  );
  if (rustcResult.stderr.length !== 0) fail("QUALITY_HOST_ATTESTOR_RUSTC");
  const rustc = parseRustcIdentity(rustcResult.stdout, pinnedRelease);

  const cargoVersionResult = await runChecked(
    ops,
    tools.cargo.path,
    ["-V"],
    "QUALITY_HOST_ATTESTOR_CARGO",
    {
      cwd: repoRoot,
      env: buildEnvironment,
      maxBuffer: MAX_INPUT_BYTES,
      timeout: 60_000,
    },
  );
  if (cargoVersionResult.stderr.length !== 0) fail("QUALITY_HOST_ATTESTOR_CARGO");
  const cargoIdentity = parseCargoIdentity(cargoVersionResult.stdout, pinnedRelease);

  await verifyBuildTargetBinding(ops, buildTargetBinding);
  const buildResult = await runChecked(
    ops,
    tools.cargo.path,
    CARGO_ARGS,
    "QUALITY_HOST_ATTESTOR_BUILD",
    {
      cwd: repoRoot,
      env: buildEnvironment,
      maxBuffer: MAX_CARGO_OUTPUT_BYTES,
      timeout: 30 * 60_000,
    },
  );
  const releaseDir = path.win32.join(buildTargetRoot, "release");
  const executablePath = path.win32.join(releaseDir, QUALITY_HOST_EXE);
  parseCargoArtifact(buildResult.stdout, executablePath);
  const closureBefore = await collectBuildClosure(
    ops,
    executablePath,
    input.runtimeDir,
    releaseDir,
    lockedRuntime,
  );
  await verifyBuildTargetBinding(ops, buildTargetBinding);

  const after = await readSourceSnapshot(
    ops,
    repoRoot,
    input.expectedSourceCommit,
    tools.git.path,
    environments.git,
  );
  if (!sameSnapshot(before, after)) fail("QUALITY_HOST_ATTESTOR_SOURCE_DRIFT");
  const cargoConfigAfter = await scanCargoConfiguration(
    ops,
    repoRoot,
    after,
    environments.userProfile,
  );
  if (cargoConfigAfter !== cargoConfigBefore) fail("QUALITY_HOST_ATTESTOR_CARGO_CONFIG");
  await assertToolsStable(ops, tools);

  const record = {
    authority: { ...AUTHORITY },
    cargo: {
      features: [...FEATURES],
      lock_sha256: before.cargoLockSha256,
      profile: "release",
    },
    executable: {
      filename: QUALITY_HOST_EXE,
      ...closureBefore.pe,
      runtime_bundle_sha256: closureBefore.runtimeBundleSha256,
      sha256: sha256(closureBefore.executableBytes),
      size_bytes: closureBefore.executableBytes.length,
    },
    kind: KIND,
    schema_version: SCHEMA_VERSION,
    source: {
      commit: input.expectedSourceCommit,
      tree_sha256: before.treeSha256,
      worktree_status: "clean",
    },
    toolchain: {
      cargo_executable_sha256: tools.cargo.sha256,
      cargo_v_sha256: cargoIdentity.cargoVSha256,
      git_executable_sha256: tools.git.sha256,
      rustc_executable_sha256: tools.rustc.sha256,
      rustc_vv_sha256: rustc.rustcVvSha256,
      target: rustc.target,
    },
  };
  const bytes = Buffer.from(encodeCanonicalJsonLine(record), "utf8");
  try {
    await ops.publishCreateNew(input.outputPath, bytes);
  } catch (error) {
    if (error?.code === "EEXIST") fail("QUALITY_HOST_ATTESTOR_OUTPUT_EXISTS", error);
    fail("QUALITY_HOST_ATTESTOR_OUTPUT_PUBLISH", error);
  }
  let persisted;
  try {
    persisted = await ops.readStableFile(input.outputPath);
  } catch (error) {
    fail("QUALITY_HOST_ATTESTOR_OUTPUT_POSTFLIGHT", error);
  }
  if (!Buffer.isBuffer(persisted) || !persisted.equals(bytes)) {
    fail("QUALITY_HOST_ATTESTOR_OUTPUT_POSTFLIGHT");
  }
  const closureAfter = await collectBuildClosure(
    ops,
    executablePath,
    input.runtimeDir,
    releaseDir,
    lockedRuntime,
  );
  if (
    encodeCanonicalJsonLine(closureBefore.manifest.executable) !==
    encodeCanonicalJsonLine(closureAfter.manifest.executable)
  ) {
    fail("QUALITY_HOST_ATTESTOR_ARTIFACT_DRIFT");
  }
  if (closureAfter.fingerprint !== closureBefore.fingerprint) {
    fail("QUALITY_HOST_ATTESTOR_RUNTIME_DRIFT");
  }
  await verifyBuildTargetBinding(ops, buildTargetBinding);
  const finalSource = await readSourceSnapshot(
    ops,
    repoRoot,
    input.expectedSourceCommit,
    tools.git.path,
    environments.git,
  );
  if (!sameSnapshot(before, finalSource)) fail("QUALITY_HOST_ATTESTOR_SOURCE_DRIFT");
  const cargoConfigFinal = await scanCargoConfiguration(
    ops,
    repoRoot,
    finalSource,
    environments.userProfile,
  );
  if (cargoConfigFinal !== cargoConfigBefore) fail("QUALITY_HOST_ATTESTOR_CARGO_CONFIG");
  await assertToolsStable(ops, tools);
  return {
    bytes,
    outputPath: input.outputPath,
    record,
    sha256: sha256(bytes),
  };
}

function parseCanonicalAttestation(bytes) {
  const code = "QUALITY_HOST_ATTESTOR_ATTESTATION";
  const text = decodeUtf8(bytes, code, MAX_LOCK_BYTES);
  let record;
  try {
    record = JSON.parse(text);
  } catch (error) {
    fail(code, error);
  }
  if (encodeCanonicalJsonLine(record) !== text) fail(code);
  exactKeys(
    record,
    ["authority", "cargo", "executable", "kind", "schema_version", "source", "toolchain"],
    code,
  );
  if (
    record.kind !== KIND ||
    record.schema_version !== SCHEMA_VERSION ||
    encodeCanonicalJsonLine(record.authority) !== encodeCanonicalJsonLine(AUTHORITY)
  ) {
    fail(code);
  }
  exactKeys(record.cargo, ["features", "lock_sha256", "profile"], code);
  if (
    !sameStringArray(record.cargo.features, FEATURES) ||
    !DIGEST.test(record.cargo.lock_sha256) ||
    record.cargo.profile !== "release"
  ) {
    fail(code);
  }
  exactKeys(record.executable, [
    "filename",
    "imports",
    "pe_format",
    "pe_machine",
    "pe_subsystem",
    "required_dll_characteristics",
    "runtime_bundle_sha256",
    "sha256",
    "size_bytes",
  ], code);
  if (
    record.executable.filename !== QUALITY_HOST_EXE ||
    record.executable.pe_format !== "PE32+" ||
    record.executable.pe_machine !== "amd64" ||
    record.executable.pe_subsystem !== "console" ||
    !sameStringArray(
      record.executable.required_dll_characteristics,
      REQUIRED_DLL_CHARACTERISTICS,
    ) ||
    !Array.isArray(record.executable.imports) ||
    record.executable.imports.length === 0 ||
    record.executable.imports.some((name, index, imports) =>
      typeof name !== "string" ||
      name !== name.toLowerCase() ||
      !/^[a-z0-9._-]+\.dll$/u.test(name) ||
      (index > 0 && name <= imports[index - 1])) ||
    !DIGEST.test(record.executable.runtime_bundle_sha256) ||
    !DIGEST.test(record.executable.sha256) ||
    !Number.isSafeInteger(record.executable.size_bytes) ||
    record.executable.size_bytes < 1
  ) {
    fail(code);
  }
  exactKeys(record.source, ["commit", "tree_sha256", "worktree_status"], code);
  if (
    !COMMIT.test(record.source.commit) ||
    !DIGEST.test(record.source.tree_sha256) ||
    record.source.worktree_status !== "clean"
  ) {
    fail(code);
  }
  exactKeys(record.toolchain, [
    "cargo_executable_sha256",
    "cargo_v_sha256",
    "git_executable_sha256",
    "rustc_executable_sha256",
    "rustc_vv_sha256",
    "target",
  ], code);
  for (const field of [
    "cargo_executable_sha256",
    "cargo_v_sha256",
    "git_executable_sha256",
    "rustc_executable_sha256",
    "rustc_vv_sha256",
  ]) {
    if (!DIGEST.test(record.toolchain[field])) fail(code);
  }
  if (record.toolchain.target !== TARGET) fail(code);
  return record;
}

async function verifyLiveCore(rawInput, ops) {
  exactKeys(rawInput, ["bytes", "expectedSourceCommit"], "QUALITY_HOST_ATTESTOR_LIVE_INPUT");
  if (!Buffer.isBuffer(rawInput.bytes) || !COMMIT.test(rawInput.expectedSourceCommit)) {
    fail("QUALITY_HOST_ATTESTOR_LIVE_INPUT");
  }
  const record = parseCanonicalAttestation(rawInput.bytes);
  if (record.source.commit !== rawInput.expectedSourceCommit) {
    fail("QUALITY_HOST_ATTESTOR_LIVE_MISMATCH");
  }
  if (ops?.platform !== "win32") fail("QUALITY_HOST_ATTESTOR_PLATFORM");
  if (
    typeof ops.runCommand !== "function" ||
    typeof ops.readStableFile !== "function" ||
    typeof ops.readStableFileIdentity !== "function" ||
    typeof ops.listDirectory !== "function" ||
    typeof ops.listDirectoryIfExists !== "function" ||
    typeof ops.bindBuildTarget !== "function" ||
    typeof ops.verifyBuildTargetBinding !== "function"
  ) {
    fail("QUALITY_HOST_ATTESTOR_INTERNAL");
  }
  const environments = controlledEnvironments(ops.environment);
  const tools = await resolveBuildTools(ops, environments);
  const rootResult = await runChecked(
    ops,
    tools.git.path,
    ["rev-parse", "--show-toplevel"],
    "QUALITY_HOST_ATTESTOR_GIT_COMMAND",
    {
      cwd: ops.cwd,
      env: environments.git,
      maxBuffer: MAX_INPUT_BYTES,
      timeout: 30_000,
    },
  );
  const repoRoot = path.win32.normalize(singleLine(
    rootResult.stdout,
    "QUALITY_HOST_ATTESTOR_GIT_COMMAND",
  ));
  assertCanonicalLocalAbsolutePath(repoRoot, "QUALITY_HOST_ATTESTOR_GIT_COMMAND");
  const before = await readSourceSnapshot(
    ops,
    repoRoot,
    rawInput.expectedSourceCommit,
    tools.git.path,
    environments.git,
  );
  const cargoConfigBefore = await scanCargoConfiguration(
    ops,
    repoRoot,
    before,
    environments.userProfile,
  );
  const assetLockPath = path.win32.join(
    repoRoot,
    "tools",
    "sherpa-native",
    "assets.lock.json",
  );
  let assetLockBytes;
  try {
    assetLockBytes = await ops.readStableFile(assetLockPath);
  } catch (error) {
    fail("QUALITY_HOST_ATTESTOR_ASSET_LOCK", error);
  }
  if (
    !Buffer.isBuffer(assetLockBytes) ||
    sha256(assetLockBytes) !== before.fileDigests.get("tools/sherpa-native/assets.lock.json")
  ) {
    fail("QUALITY_HOST_ATTESTOR_SOURCE_DRIFT");
  }
  const lockedRuntime = parseAssetLock(assetLockBytes);
  const runtimeDir = path.win32.join(
    repoRoot,
    "target",
    "sherpa-native",
    "extracted",
    lockedRuntime.extractedDirectory,
    "lib",
  );
  const buildTargetRoot = qualityHostBuildTargetRoot(repoRoot, rawInput.expectedSourceCommit);
  let buildTargetBinding;
  try {
    buildTargetBinding = await ops.bindBuildTarget({
      buildTargetRoot,
      repoRoot,
      requireAbsent: false,
    });
  } catch (error) {
    fail("QUALITY_HOST_ATTESTOR_BUILD_TARGET", error);
  }
  await verifyBuildTargetBinding(ops, buildTargetBinding);
  const buildEnvironment = buildEnvironmentForTarget(
    environments,
    buildTargetRoot,
    runtimeDir,
  );
  const releaseDir = path.win32.join(buildTargetRoot, "release");
  const executablePath = path.win32.join(releaseDir, QUALITY_HOST_EXE);
  const pinnedRelease = parsePinnedToolchain(before.rustToolchainBytes);
  const rustcResult = await runChecked(
    ops,
    tools.rustc.path,
    ["-vV"],
    "QUALITY_HOST_ATTESTOR_RUSTC",
    {
      cwd: repoRoot,
      env: buildEnvironment,
      maxBuffer: MAX_INPUT_BYTES,
      timeout: 60_000,
    },
  );
  if (rustcResult.stderr.length !== 0) fail("QUALITY_HOST_ATTESTOR_RUSTC");
  const rustc = parseRustcIdentity(rustcResult.stdout, pinnedRelease);
  const cargoVersionResult = await runChecked(
    ops,
    tools.cargo.path,
    ["-V"],
    "QUALITY_HOST_ATTESTOR_CARGO",
    {
      cwd: repoRoot,
      env: buildEnvironment,
      maxBuffer: MAX_INPUT_BYTES,
      timeout: 60_000,
    },
  );
  if (cargoVersionResult.stderr.length !== 0) fail("QUALITY_HOST_ATTESTOR_CARGO");
  const cargoIdentity = parseCargoIdentity(cargoVersionResult.stdout, pinnedRelease);
  await verifyBuildTargetBinding(ops, buildTargetBinding);
  const closureBefore = await collectBuildClosure(
    ops,
    executablePath,
    runtimeDir,
    releaseDir,
    lockedRuntime,
  );
  const after = await readSourceSnapshot(
    ops,
    repoRoot,
    rawInput.expectedSourceCommit,
    tools.git.path,
    environments.git,
  );
  if (!sameSnapshot(before, after)) fail("QUALITY_HOST_ATTESTOR_SOURCE_DRIFT");
  const cargoConfigAfter = await scanCargoConfiguration(
    ops,
    repoRoot,
    after,
    environments.userProfile,
  );
  if (cargoConfigAfter !== cargoConfigBefore) fail("QUALITY_HOST_ATTESTOR_CARGO_CONFIG");
  const closureAfter = await collectBuildClosure(
    ops,
    executablePath,
    runtimeDir,
    releaseDir,
    lockedRuntime,
  );
  if (closureAfter.fingerprint !== closureBefore.fingerprint) {
    fail("QUALITY_HOST_ATTESTOR_RUNTIME_DRIFT");
  }
  await verifyBuildTargetBinding(ops, buildTargetBinding);
  const finalSource = await readSourceSnapshot(
    ops,
    repoRoot,
    rawInput.expectedSourceCommit,
    tools.git.path,
    environments.git,
  );
  if (!sameSnapshot(before, finalSource)) fail("QUALITY_HOST_ATTESTOR_SOURCE_DRIFT");
  const cargoConfigFinal = await scanCargoConfiguration(
    ops,
    repoRoot,
    finalSource,
    environments.userProfile,
  );
  if (cargoConfigFinal !== cargoConfigBefore) fail("QUALITY_HOST_ATTESTOR_CARGO_CONFIG");
  await assertToolsStable(ops, tools);
  const expected = {
    authority: { ...AUTHORITY },
    cargo: {
      features: [...FEATURES],
      lock_sha256: before.cargoLockSha256,
      profile: "release",
    },
    executable: {
      filename: QUALITY_HOST_EXE,
      ...closureBefore.pe,
      runtime_bundle_sha256: closureBefore.runtimeBundleSha256,
      sha256: sha256(closureBefore.executableBytes),
      size_bytes: closureBefore.executableBytes.length,
    },
    kind: KIND,
    schema_version: SCHEMA_VERSION,
    source: {
      commit: rawInput.expectedSourceCommit,
      tree_sha256: before.treeSha256,
      worktree_status: "clean",
    },
    toolchain: {
      cargo_executable_sha256: tools.cargo.sha256,
      cargo_v_sha256: cargoIdentity.cargoVSha256,
      git_executable_sha256: tools.git.sha256,
      rustc_executable_sha256: tools.rustc.sha256,
      rustc_vv_sha256: rustc.rustcVvSha256,
      target: rustc.target,
    },
  };
  if (encodeCanonicalJsonLine(expected) !== rawInput.bytes.toString("utf8")) {
    fail("QUALITY_HOST_ATTESTOR_LIVE_MISMATCH");
  }
  return {
    assetLockPath,
    record,
    runtimeDir,
    sha256: sha256(rawInput.bytes),
  };
}

function parseCanonicalInput(bytes) {
  const text = decodeUtf8(bytes, "QUALITY_HOST_ATTESTOR_CLI_INPUT", MAX_INPUT_BYTES);
  let input;
  try {
    input = JSON.parse(text);
  } catch (error) {
    fail("QUALITY_HOST_ATTESTOR_CLI_INPUT", error);
  }
  if (encodeCanonicalJsonLine(input) !== text) fail("QUALITY_HOST_ATTESTOR_CLI_INPUT");
  return validateInput(input);
}

async function cliCore(arguments_, ops) {
  if (
    !Array.isArray(arguments_) ||
    arguments_.length !== 2 ||
    arguments_[0] !== "--attest" ||
    typeof arguments_[1] !== "string"
  ) {
    fail("QUALITY_HOST_ATTESTOR_USAGE");
  }
  const inputJsonPath = path.win32.isAbsolute(arguments_[1])
    ? path.win32.normalize(arguments_[1])
    : path.win32.resolve(ops.cwd, arguments_[1]);
  assertCanonicalLocalAbsolutePath(inputJsonPath, "QUALITY_HOST_ATTESTOR_CLI_INPUT");
  let inputBytes;
  try {
    inputBytes = await ops.readStableFile(inputJsonPath);
  } catch (error) {
    fail("QUALITY_HOST_ATTESTOR_CLI_INPUT", error);
  }
  const result = await attestCore(parseCanonicalInput(inputBytes), ops);
  ops.stdout.write(
    `QUALITY_HOST_SOURCE_BUILD_ATTESTATION=PASS attestation_sha256=${result.sha256} execution_status=not-run formal_claims=none production_evidence=false\n`,
  );
  return result;
}

function statsEqual(left, right) {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs;
}

async function productionReadStableFileIdentity(filePath) {
  const before = await lstat(filePath, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) {
    throw Object.assign(new Error("not a direct regular file"), { code: "EINVAL" });
  }
  const resolvedBefore = await realpath(filePath);
  if (canonicalPathKey(resolvedBefore) !== canonicalPathKey(filePath)) {
    throw Object.assign(new Error("reparse path"), { code: "EINVAL" });
  }
  const handle = await open(filePath, "r");
  try {
    const openedBefore = await handle.stat({ bigint: true });
    if (!openedBefore.isFile() || !statsEqual(before, openedBefore)) {
      throw Object.assign(new Error("file identity changed"), { code: "ESTALE" });
    }
    const bytes = await handle.readFile();
    const openedAfter = await handle.stat({ bigint: true });
    const after = await lstat(filePath, { bigint: true });
    const resolvedAfter = await realpath(filePath);
    if (
      !statsEqual(openedBefore, openedAfter) ||
      !statsEqual(openedAfter, after) ||
      BigInt(bytes.length) !== openedAfter.size ||
      canonicalPathKey(resolvedBefore) !== canonicalPathKey(resolvedAfter)
    ) {
      throw Object.assign(new Error("file changed while reading"), { code: "ESTALE" });
    }
    const identity = sha256(Buffer.from(encodeCanonicalJsonLine({
      birthtime_ns: String(openedAfter.birthtimeNs),
      dev: String(openedAfter.dev),
      ino: String(openedAfter.ino),
      nlink: String(openedAfter.nlink),
    }), "utf8"));
    return { bytes, identity };
  } finally {
    await handle.close();
  }
}

async function productionReadStableFile(filePath) {
  return (await productionReadStableFileIdentity(filePath)).bytes;
}

async function productionListDirectory(directory) {
  const before = await lstat(directory, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw Object.assign(new Error("not a direct directory"), { code: "EINVAL" });
  }
  const resolvedBefore = await realpath(directory);
  if (canonicalPathKey(resolvedBefore) !== canonicalPathKey(directory)) {
    throw Object.assign(new Error("reparse directory"), { code: "EINVAL" });
  }
  const entries = await readdir(directory, { withFileTypes: true });
  const after = await lstat(directory, { bigint: true });
  const resolvedAfter = await realpath(directory);
  if (
    !statsEqual(before, after) ||
    canonicalPathKey(resolvedBefore) !== canonicalPathKey(resolvedAfter)
  ) {
    throw Object.assign(new Error("directory changed while reading"), { code: "ESTALE" });
  }
  return entries.map((entry) => ({
    kind: entry.isFile()
      ? "file"
      : entry.isSymbolicLink()
        ? "symlink"
        : entry.isDirectory()
          ? "directory"
          : "other",
    name: entry.name,
  }));
}

async function productionListDirectoryIfExists(directory) {
  try {
    return await productionListDirectory(directory);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function productionDirectDirectoryIdentity(directory) {
  const normalized = path.win32.normalize(directory);
  const status = await lstat(normalized, { bigint: true });
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw Object.assign(new Error("not a direct directory"), { code: "EINVAL" });
  }
  const resolved = path.win32.normalize(await realpath(normalized));
  if (canonicalPathKey(resolved) !== canonicalPathKey(normalized)) {
    throw Object.assign(new Error("reparse directory"), { code: "EINVAL" });
  }
  return Object.freeze({
    dev: String(status.dev),
    ino: String(status.ino),
    path: normalized,
  });
}

async function productionVerifyBuildTargetBinding(binding) {
  if (!Array.isArray(binding?.directories) || binding.directories.length < 2) {
    throw Object.assign(new Error("invalid build-target binding"), { code: "EINVAL" });
  }
  const seen = new Set();
  for (const expected of binding.directories) {
    if (
      expected === null || typeof expected !== "object" ||
      typeof expected.path !== "string" || typeof expected.dev !== "string" ||
      typeof expected.ino !== "string" || seen.has(canonicalPathKey(expected.path))
    ) {
      throw Object.assign(new Error("invalid build-target binding"), { code: "EINVAL" });
    }
    seen.add(canonicalPathKey(expected.path));
    const current = await productionDirectDirectoryIdentity(expected.path);
    if (current.dev !== expected.dev || current.ino !== expected.ino) {
      throw Object.assign(new Error("build-target identity changed"), { code: "ESTALE" });
    }
  }
  return true;
}

async function productionBindBuildTarget({ buildTargetRoot, repoRoot, requireAbsent }) {
  assertCanonicalLocalAbsolutePath(repoRoot, "QUALITY_HOST_ATTESTOR_BUILD_TARGET");
  assertCanonicalLocalAbsolutePath(buildTargetRoot, "QUALITY_HOST_ATTESTOR_BUILD_TARGET");
  if (typeof requireAbsent !== "boolean") {
    throw Object.assign(new Error("invalid build-target reservation"), { code: "EINVAL" });
  }
  const sourceCommit = path.win32.basename(buildTargetRoot);
  const expectedRoot = qualityHostBuildTargetRoot(repoRoot, sourceCommit);
  if (canonicalPathKey(expectedRoot) !== canonicalPathKey(buildTargetRoot)) {
    throw Object.assign(new Error("unexpected build-target path"), { code: "EINVAL" });
  }

  const components = [...BUILD_TARGET_SUBTREE_RELATIVE, sourceCommit];
  const directories = [await productionDirectDirectoryIdentity(repoRoot)];
  let current = repoRoot;
  for (let index = 0; index < components.length; index += 1) {
    current = path.win32.join(current, components[index]);
    const isLeaf = index === components.length - 1;
    if (!requireAbsent) {
      directories.push(await productionDirectDirectoryIdentity(current));
      continue;
    }
    if (isLeaf) {
      await mkdir(current, { mode: 0o700, recursive: false });
    } else {
      try {
        await productionDirectDirectoryIdentity(current);
      } catch (error) {
        if (error?.code !== "ENOENT" || isLeaf) throw error;
        try {
          await mkdir(current, { mode: 0o700, recursive: false });
        } catch (mkdirError) {
          if (mkdirError?.code !== "EEXIST") throw mkdirError;
        }
      }
    }
    directories.push(await productionDirectDirectoryIdentity(current));
  }
  const binding = Object.freeze({ directories: Object.freeze(directories) });
  await productionVerifyBuildTargetBinding(binding);
  return binding;
}

function productionRunCommand(executable, args, options) {
  return new Promise((resolve) => {
    execFile(
      executable,
      args,
      {
        cwd: options.cwd,
        encoding: null,
        env: options.env,
        maxBuffer: options.maxBuffer,
        shell: false,
        timeout: options.timeout,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        resolve({
          exitCode: error === null ? 0 : (Number.isInteger(error.code) ? error.code : 1),
          stderr: Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr ?? ""),
          stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? ""),
        });
      },
    );
  });
}

async function productionPublishCreateNew(outputPath, bytes) {
  const handle = await open(outputPath, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    const status = await handle.stat({ bigint: true });
    if (!status.isFile() || status.size !== BigInt(bytes.length)) {
      throw Object.assign(new Error("published size mismatch"), { code: "EIO" });
    }
  } finally {
    await handle.close();
  }
}

function productionOps() {
  return Object.freeze({
    bindBuildTarget: productionBindBuildTarget,
    cwd: process.cwd(),
    environment: process.env,
    listDirectory: productionListDirectory,
    listDirectoryIfExists: productionListDirectoryIfExists,
    platform: process.platform,
    publishCreateNew: productionPublishCreateNew,
    readStableFile: productionReadStableFile,
    readStableFileIdentity: productionReadStableFileIdentity,
    runCommand: productionRunCommand,
    stdout: process.stdout,
    verifyBuildTargetBinding: productionVerifyBuildTargetBinding,
  });
}

export async function attestQualityHostSourceBuild(input) {
  return attestCore(input, productionOps());
}

export async function __attestQualityHostSourceBuildForTest(input, ops) {
  return attestCore(input, ops);
}

export async function verifyQualityHostSourceBuildAttestationLive(input) {
  return verifyLiveCore(input, productionOps());
}

export async function __verifyQualityHostSourceBuildAttestationLiveForTest(input, ops) {
  return verifyLiveCore(input, ops);
}

export async function runQualityHostSourceBuildAttestorCli(arguments_ = process.argv.slice(2)) {
  return cliCore(arguments_, productionOps());
}

export async function __runQualityHostSourceBuildAttestorCliForTest(arguments_, ops) {
  return cliCore(arguments_, ops);
}

const isMain = process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  try {
    await runQualityHostSourceBuildAttestorCli();
  } catch (error) {
    const code = error instanceof QualityHostSourceBuildAttestorError
      ? error.code
      : "QUALITY_HOST_ATTESTOR_INTERNAL";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}
