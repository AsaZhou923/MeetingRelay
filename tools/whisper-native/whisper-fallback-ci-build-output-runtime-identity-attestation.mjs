#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants, readFileSync } from "node:fs";
import { access, copyFile, link, lstat, mkdir, mkdtemp, open, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL, fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";

import { encodeCanonicalJson } from "../phase0-harness/canonical-json.mjs";
import {
  INPUT_MANIFEST_KIND,
  MEASUREMENT_STATUS as PREFLIGHT_MEASUREMENT_STATUS,
  REQUIRED_ROLES,
  WORKER_ROLE,
  preflightWhisperFallbackCandidate,
  sha256Hex,
} from "./whisper-fallback-candidate-preflight.mjs";
import {
  EXECUTION_STATUS as PROBE_EXECUTION_STATUS,
  FIXED_ARGS,
  LAUNCH_BINDING_STATUS,
  MEASUREMENT_STATUS as PROBE_MEASUREMENT_STATUS,
  probeWhisperFallbackRuntimeVersion,
} from "./whisper-fallback-runtime-version-probe.mjs";

export { sha256Hex };
export { LAUNCH_BINDING_STATUS };

export const PUBLIC_EVIDENCE_KIND = "meetingrelay-whisper-fallback-ci-build-output-runtime-identity-attestation-v1";
export const PUBLIC_EVIDENCE_SCHEMA_VERSION = "1.0";
export const MEASUREMENT_STATUS = "whisper-ci-build-output-runtime-identity-attestation-only";
export const EXECUTION_STATUS = "ci-built-runtime-path-launched-fixed-version-marker-observed-no-model-no-transcription";
export const BUILD_OUTPUT_IDENTITY_ATTESTATION = true;
export const PUBLIC_EVIDENCE_SCHEMA_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "whisper-fallback-ci-build-output-runtime-identity-attestation.schema.json",
);
export const VALIDATOR_SOURCE_PATH = fileURLToPath(import.meta.url);

const SHA256_RE = /^[0-9a-f]{64}$/u;
const HEAD_RE = /^[0-9a-f]{40}$/u;
const MAX_RUNTIME_BYTES = 8 * 1024 * 1024 * 1024;
const STREAM_CHUNK_BYTES = 1024 * 1024;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const RUNTIME_EXE_NAME = process.platform === "win32" ? "meetingrelay-whisper-runtime-version-probe.exe" : "meetingrelay-whisper-runtime-version-probe";
const SOURCE_RELATIVE_PATHS = Object.freeze([
  "Cargo.lock",
  "Cargo.toml",
  "crates/model-worker-whisper-native/Cargo.toml",
  ".cargo/config.toml",
  "rust-toolchain.toml",
]);
const REQUIRED_LOCK_PACKAGES = Object.freeze([
  Object.freeze({
    checksum: "2088172d00f936c348d6a72f488dc2660ab3f507263a195df308a3c2383229f6",
    name: "whisper-rs",
    source: "registry+https://github.com/rust-lang/crates.io-index",
    version: "0.16.0",
  }),
  Object.freeze({
    checksum: "6986c0fe081241d391f09b9a071fbcbb59720c3563628c3c829057cf69f2a56f",
    name: "whisper-rs-sys",
    source: "registry+https://github.com/rust-lang/crates.io-index",
    version: "0.15.0",
  }),
]);
const OBSERVED_TOOL_NAMES = Object.freeze(["cargo", "rustc", "git", "cmake", "clang", "libclang"]);
const CARGO_FAILURE_DIAGNOSTIC_MAX_BYTES = 16 * 1024;
const CARGO_FAILURE_DIAGNOSTIC_MAX_CHARS = 8 * 1024;
const CARGO_BUILD_ARGS = Object.freeze([
  "build",
  "--release",
  "-p",
  "meetingrelay-model-worker-whisper-native",
  "--bin",
  "meetingrelay-whisper-runtime-version-probe",
  "--no-default-features",
  "--features",
  "native-whisper",
  "--message-format=json",
  "--offline",
  "--locked",
]);
const REAL_OBSERVATION_SCOPE = "windows-ci-clean-exact-head-build-output";
const SYNTHETIC_OBSERVATION_SCOPE = "synthetic-injected-harness";
const FORBIDDEN_ENV_RE =
  /^(?:RUSTFLAGS|RUSTC|RUSTDOC|RUSTDOCFLAGS|RUSTC_BOOTSTRAP|RUSTC_WRAPPER|RUSTC_WORKSPACE_WRAPPER|CARGO_ENCODED_RUSTFLAGS|CARGO_ENCODED_RUSTDOCFLAGS|CARGO_BUILD_(?:TARGET|RUSTFLAGS|RUSTC|RUSTC_WRAPPER|RUSTDOC|RUSTDOCFLAGS)|CARGO_PROFILE_.+|CARGO_TARGET_[A-Z0-9_]+_(?:LINKER|RUNNER|RUSTFLAGS)|CC|CXX|AR|LINK|CL|CFLAGS|CXXFLAGS|LDFLAGS|CMAKE|CMAKE_.+|BINDGEN_EXTRA_CLANG_ARGS(?:_.+)?|CLANG_PATH|LLVM_CONFIG_PATH|WHISPER_.+|GGML_.+)$/u;
const ALLOWED_CI_RESOLVER_ENV_RE = /^MEETINGRELAY_WHISPER_(?:CARGO|RUSTC|GIT|CMAKE|CLANG|LIBCLANG)_PATH$/u;
const FORBIDDEN_PUBLIC_KEYS = new Set([
  "absolute_path",
  "args",
  "audio",
  "audio_path",
  "content",
  "cwd",
  "env",
  "environment",
  "executable",
  "executable_path",
  "file_path",
  "linked_whisper_cpp_version",
  "machine",
  "model_name",
  "path",
  "plaintext",
  "root",
  "run_id",
  "secret",
  "stderr",
  "stdout",
  "text",
  "timestamp",
  "transcript",
  "user",
  "version_output",
]);
const FORBIDDEN_PUBLIC_VALUE_RE =
  /(?:[A-Za-z]:\\|\\\\|\/tmp\/|\/home\/|\/Users\/|target\/|target\\|inputs\/|inputs\\|\.pdb\b|\.wav\b|\.mp3\b|\.flac\b|ggml-|gguf|BEGIN (?:RSA |OPENSSH |)PRIVATE KEY|linked_whisper_cpp_version=|transcript\s)/iu;
const LIMITATIONS = Object.freeze([
  "single Windows CI build observation: one isolated Cargo release build output was hashed, placed into the 5b runtime role, and launched by the existing 5c fixed-marker probe",
  "not reproducible-build proof and not source-build provenance; source files, Cargo manifests, lockfile entries, tool bytes, and tracked-tree state are observations only",
  "registry source byte closure is not established; Cargo registry package observations are limited to lockfile package names, versions, checksums, and source digests",
  "toolchain provenance authority is observed tool bytes only; version command outputs are digested, not published as plaintext",
  "loaded image attestation is false; Node path-based spawn still has the disclosed reopen window and cannot prove the final loaded image bytes",
  "network isolation authority is none even though the Cargo child is invoked with --offline and locked inputs",
  "no model or license selection or approval, no model load, no audio, no transcription, no ModelBackend, no quality, performance, resource, fallback, ranking, default, legal, distribution, parent WP-0.4.5, CT-WORKER-CANDIDATE-001, or Phase1 authority is created",
  "public evidence intentionally omits filesystem paths, file contents, stdout text, linked version text, tool version text, environment values, timings, run IDs, user names, machine names, model names, and transcript text",
]);

export class CiBuildOutputRuntimeIdentityAttestationError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "CiBuildOutputRuntimeIdentityAttestationError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new CiBuildOutputRuntimeIdentityAttestationError(code, message);
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
  if (typeof value !== "string" || !SHA256_RE.test(value) || value === "0".repeat(64)) fail(code, `${label} must be non-zero lowercase sha256 hex`);
}

function assertHead(value, code, label) {
  if (typeof value !== "string" || !HEAD_RE.test(value)) fail(code, `${label} must be a 40-character lowercase git commit`);
}

function hashObject(value) {
  return sha256Hex(Buffer.from(encodeCanonicalJson(value), "utf8"));
}

function pathDigest(value) {
  return sha256Hex(Buffer.from(path.resolve(value), "utf8"));
}

function pathsEqual(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function isInside(parent, child) {
  const parentResolved = path.resolve(parent);
  const childResolved = path.resolve(child);
  const prefix = parentResolved.endsWith(path.sep) ? parentResolved : `${parentResolved}${path.sep}`;
  const a = process.platform === "win32" ? childResolved.toLowerCase() : childResolved;
  const b = process.platform === "win32" ? prefix.toLowerCase() : prefix;
  return pathsEqual(parentResolved, childResolved) || a.startsWith(b);
}

function relativePosix(root, absolute) {
  return path.relative(root, absolute).split(path.sep).join("/");
}

function safeResolveAbsolute(inputPath, code, label) {
  if (typeof inputPath !== "string" || inputPath.length === 0 || inputPath.includes("\0") || /[\r\n]/u.test(inputPath) || !path.isAbsolute(inputPath)) {
    fail(code, `${label} must be an absolute local path`);
  }
  if (inputPath.startsWith("\\\\") || inputPath.startsWith("//") || /^\\\\[.?]\\|^\/\/[.?]\//u.test(inputPath) || /^[A-Za-z]:(?![\\/])/u.test(inputPath)) {
    fail(code, `${label} must not use UNC, device, or drive-relative syntax`);
  }
  return path.resolve(inputPath);
}

async function assertNoLinksInPath(absolutePath, code) {
  const resolved = path.resolve(absolutePath);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  for (const segment of path.relative(parsed.root, resolved).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const entry = await lstat(current, { bigint: true }).catch((error) => fail(code, error.message));
    if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) fail(code, "path chain must not contain symlinks, junctions, or special files");
  }
}

function identityDigest(stats) {
  return hashObject({
    birthtime_ns: String(stats.birthtimeNs),
    ctime_ns: String(stats.ctimeNs),
    dev: String(stats.dev),
    ino: String(stats.ino),
    mode: Number(stats.mode),
    mtime_ns: String(stats.mtimeNs),
    size: String(stats.size),
  });
}

async function hashRegularFile(absolutePath, code, maxBytes = MAX_RUNTIME_BYTES, options = {}) {
  await assertNoLinksInPath(absolutePath, code);
  const link = await lstat(absolutePath, { bigint: true }).catch((error) => fail(code, error.message));
  if (!link.isFile() || link.isSymbolicLink()) fail(code, "file must be regular and not a symlink");
  const before = await stat(absolutePath, { bigint: true });
  if ((options.requireSingleLink ?? true) && before.nlink !== undefined && before.nlink !== 1n) {
    fail(code, "file must have exactly one hardlink");
  }
  const size = Number(before.size);
  if (!Number.isSafeInteger(size) || size < 1 || size > maxBytes) fail(code, "file size must be within 1..8GiB");
  const handle = await open(absolutePath, "r").catch((error) => fail(code, error.message));
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.size !== before.size || opened.ino !== before.ino || opened.dev !== before.dev) fail(code, "file identity drifted before read");
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(Math.min(STREAM_CHUNK_BYTES, size));
    let total = 0;
    while (total < size) {
      const requested = Math.min(chunk.length, size - total);
      const { bytesRead } = await handle.read(chunk, 0, requested, total);
      if (bytesRead === 0) break;
      total += bytesRead;
      hash.update(chunk.subarray(0, bytesRead));
    }
    const after = await handle.stat({ bigint: true });
    const afterPath = await stat(absolutePath, { bigint: true });
    if (total !== size || after.size !== before.size || after.ino !== before.ino || after.dev !== before.dev || afterPath.ino !== before.ino || afterPath.dev !== before.dev) {
      fail(code, "file drifted during read");
    }
    return { sha256: hash.digest("hex"), size_bytes: size, identity_sha256: identityDigest(before) };
  } finally {
    await handle.close();
  }
}

export async function observeToolFileBytes(absolutePath) {
  const resolved = safeResolveAbsolute(absolutePath, "WHISPER_CI_ATTEST_TOOL", "observed tool");
  return await hashRegularFile(resolved, "WHISPER_CI_ATTEST_TOOL", 512 * 1024 * 1024, { requireSingleLink: false });
}

function decodeUtf8(bytes, code, label) {
  try {
    return UTF8_DECODER.decode(bytes);
  } catch (error) {
    fail(code, `${label} must be UTF-8: ${error.message}`);
  }
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = (options.spawnImpl ?? spawn)(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const maxStdout = options.maxStdoutBytes ?? 4 * 1024 * 1024;
    const maxStderr = options.maxStderrBytes ?? 1024 * 1024;
    let settled = false;
    const done = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      done(new CiBuildOutputRuntimeIdentityAttestationError("WHISPER_CI_ATTEST_CHILD_TIMEOUT", `${command} timed out`));
    }, options.timeoutMs ?? 120_000);
    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxStdout) {
        child.kill();
        done(new CiBuildOutputRuntimeIdentityAttestationError("WHISPER_CI_ATTEST_CHILD_STDOUT", `${command} stdout exceeded limit`));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > maxStderr) {
        child.kill();
        done(new CiBuildOutputRuntimeIdentityAttestationError("WHISPER_CI_ATTEST_CHILD_STDERR", `${command} stderr exceeded limit`));
        return;
      }
      stderr.push(chunk);
    });
    child.on("error", (error) => done(new CiBuildOutputRuntimeIdentityAttestationError("WHISPER_CI_ATTEST_CHILD_SPAWN", error.message)));
    child.on("close", (code, signal) => {
      done(null, { code, signal, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    });
  });
}

async function gitText(args, repoRoot, options = {}) {
  const result = await (options.runGit?.(args, repoRoot) ?? runProcess(options.gitCommand ?? "git", args, { cwd: repoRoot, timeoutMs: 60_000 }));
  if (result.code !== 0 || result.signal !== null) fail("WHISPER_CI_ATTEST_GIT", `git ${args[0]} failed`);
  return decodeUtf8(result.stdout, "WHISPER_CI_ATTEST_GIT", `git ${args[0]}`);
}

async function inspectGitState(repoRoot, expectedHead, options = {}) {
  const rootInput = safeResolveAbsolute(repoRoot, "WHISPER_CI_ATTEST_ROOT", "repo root");
  const actualRoot = path.resolve((await gitText(["rev-parse", "--show-toplevel"], rootInput, options)).trim());
  if (!pathsEqual(actualRoot, rootInput)) fail("WHISPER_CI_ATTEST_ROOT", "repo root must be the exact git worktree root");
  const head = (await gitText(["rev-parse", "HEAD"], actualRoot, options)).trim();
  assertHead(head, "WHISPER_CI_ATTEST_HEAD", "observed HEAD");
  if (head !== expectedHead) fail("WHISPER_CI_ATTEST_HEAD", "observed HEAD does not match expected HEAD");
  const status = await gitText(["status", "--porcelain=v1", "--untracked-files=all"], actualRoot, options);
  if (status.length !== 0) fail("WHISPER_CI_ATTEST_WORKTREE", "tracked or untracked nonignored worktree changes are present");
  const rootStat = await lstat(actualRoot, { bigint: true }).catch((error) => fail("WHISPER_CI_ATTEST_ROOT", error.message));
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail("WHISPER_CI_ATTEST_ROOT", "repo root must be a non-symlink directory");
  return { head, repo_root_identity_sha256: identityDigest(rootStat), repo_root_realpath_sha256: pathDigest(await realpath(actualRoot)), tracked_tree: await trackedTreeDigest(actualRoot, options) };
}

async function trackedTreeDigest(repoRoot, options = {}) {
  if (options.trackedTreeDigestForTest) return options.trackedTreeDigestForTest;
  const result = await (options.runGit?.(["ls-files", "--stage", "-z"], repoRoot) ?? runProcess(options.gitCommand ?? "git", ["ls-files", "--stage", "-z"], { cwd: repoRoot }));
  if (result.code !== 0 || result.signal !== null) fail("WHISPER_CI_ATTEST_TREE", "git ls-files failed");
  const entries = result.stdout.toString("utf8").split("\0").filter(Boolean);
  const hash = createHash("sha256");
  let count = 0;
  for (const entry of entries) {
    const match = /^([0-7]{6}) ([0-9a-f]{40,64}) ([0-3])\t(.+)$/u.exec(entry);
    if (!match) fail("WHISPER_CI_ATTEST_TREE", "git ls-files --stage produced an unexpected entry");
    const [, mode, objectId, stage, relPath] = match;
    const bytes = await readFile(path.join(repoRoot, ...relPath.split("/"))).catch((error) => fail("WHISPER_CI_ATTEST_TREE", error.message));
    hash.update(`${mode} ${objectId} ${stage} ${relPath}\0`);
    hash.update(sha256Hex(bytes));
    hash.update("\0");
    count += 1;
  }
  return { digest_sha256: hash.digest("hex"), entry_count: count };
}

async function assertTargetRootReady(repoRoot, expectedHead, options = {}) {
  const targetRoot = path.resolve(repoRoot, "target", "whisper-native", "wp-0.4.5d", expectedHead);
  if (!isInside(repoRoot, targetRoot)) fail("WHISPER_CI_ATTEST_TARGET", "target root escaped repo");
  if (await exists(targetRoot)) fail("WHISPER_CI_ATTEST_TARGET_EXISTS", "isolated target root already exists");
  const ignored = (await gitText(["check-ignore", "--quiet", "--", relativePosix(repoRoot, targetRoot)], repoRoot, options).then(
    () => true,
    (error) => {
      if (error instanceof CiBuildOutputRuntimeIdentityAttestationError) return false;
      throw error;
    },
  ));
  if (!ignored) fail("WHISPER_CI_ATTEST_TARGET_NOT_IGNORED", "isolated target root must be gitignored");
  return targetRoot;
}

async function exists(target) {
  return access(target, fsConstants.F_OK).then(
    () => true,
    () => false,
  );
}

async function hashOptionalFile(repoRoot, relativePath) {
  const absolute = path.resolve(repoRoot, ...relativePath.split("/"));
  const file = await hashRegularFile(absolute, "WHISPER_CI_ATTEST_SOURCE_FILE", 64 * 1024 * 1024);
  return { relative_path_sha256: sha256Hex(Buffer.from(relativePath, "utf8")), sha256: file.sha256, size_bytes: file.size_bytes };
}

async function observeSourceFiles(repoRoot) {
  const rows = [];
  for (const relativePath of SOURCE_RELATIVE_PATHS) rows.push(await hashOptionalFile(repoRoot, relativePath));
  return { file_count: rows.length, files: rows, aggregate_sha256: hashObject(rows) };
}

function parseCargoLockPackages(lockText) {
  const packages = [];
  for (const block of lockText.split(/\n(?=\[\[package\]\]\n)/u)) {
    if (!block.startsWith("[[package]]")) continue;
    const row = {};
    for (const key of ["name", "version", "source", "checksum"]) {
      const match = new RegExp(`^${key} = "([^"]+)"`, "mu").exec(block);
      if (match) row[key] = match[1];
    }
    packages.push(row);
  }
  return packages;
}

async function observeCargoRegistryLock(repoRoot) {
  const packages = parseCargoLockPackages(await readFile(path.join(repoRoot, "Cargo.lock"), "utf8"));
  const observations = [];
  for (const required of REQUIRED_LOCK_PACKAGES) {
    const matches = packages.filter((pkg) => pkg.name === required.name && pkg.version === required.version);
    if (matches.length !== 1) fail("WHISPER_CI_ATTEST_LOCK", `expected exactly one ${required.name} ${required.version} lock entry`);
    const pkg = matches[0];
    if (pkg.checksum !== required.checksum || pkg.source !== required.source) {
      fail("WHISPER_CI_ATTEST_LOCK", `${required.name} lock checksum or source drifted`);
    }
    observations.push({
      checksum: pkg.checksum,
      name_sha256: sha256Hex(Buffer.from(pkg.name, "utf8")),
      source_sha256: sha256Hex(Buffer.from(pkg.source, "utf8")),
      version: pkg.version,
    });
  }
  return { package_count: observations.length, packages: observations, registry_source_byte_closure: false, aggregate_sha256: hashObject(observations) };
}

export function validateAmbientEnvironment(env = process.env) {
  for (const [key, value] of Object.entries(env)) {
    const normalizedKey = key.toUpperCase();
    if (normalizedKey === "CARGO_NET_OFFLINE" && value !== undefined && value !== "true") fail("WHISPER_CI_ATTEST_ENV", "CARGO_NET_OFFLINE may only be present as true");
    if (normalizedKey === "CARGO_INCREMENTAL" && value !== undefined && value !== "0") fail("WHISPER_CI_ATTEST_ENV", "CARGO_INCREMENTAL may only be present as 0");
    if (ALLOWED_CI_RESOLVER_ENV_RE.test(normalizedKey)) continue;
    if (FORBIDDEN_ENV_RE.test(normalizedKey)) fail("WHISPER_CI_ATTEST_ENV", `forbidden build override environment variable ${key}`);
  }
}

async function resolveToolBytes(toolName, envKey, versionArgs, repoRoot, options = {}) {
  const resolved = await resolveConfiguredToolPath(toolName, envKey, repoRoot, options);
  const hashed = await observeToolFileBytes(resolved);
  const result = await runProcess(resolved, versionArgs, { cwd: repoRoot, env: options.childEnv ?? process.env, timeoutMs: 30_000 }).catch((error) => {
    if (toolName === "libclang") return { code: 0, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.from(error.message) };
    throw error;
  });
  if (toolName !== "libclang" && (result.code !== 0 || result.signal !== null)) fail("WHISPER_CI_ATTEST_TOOL", `${toolName} version command failed`);
  return {
    name_sha256: sha256Hex(Buffer.from(toolName, "utf8")),
    bytes_sha256: hashed.sha256,
    size_bytes: hashed.size_bytes,
    version_output_sha256: sha256Hex(Buffer.concat([result.stdout, result.stderr])),
  };
}

async function observeLibclangBytes(libclangPath) {
  const resolved = safeResolveAbsolute(libclangPath, "WHISPER_CI_ATTEST_TOOL", "libclang");
  const hashed = await observeToolFileBytes(resolved);
  return {
    name_sha256: sha256Hex(Buffer.from("libclang", "utf8")),
    bytes_sha256: hashed.sha256,
    size_bytes: hashed.size_bytes,
    version_output_sha256: sha256Hex(Buffer.alloc(0)),
  };
}

async function resolveCommand(command, repoRoot, options = {}) {
  if (path.isAbsolute(command)) return command;
  const shell = process.platform === "win32" ? "where.exe" : "which";
  const result = await runProcess(shell, [command], { cwd: repoRoot, env: options.childEnv ?? process.env, timeoutMs: 30_000 });
  if (result.code !== 0 || result.signal !== null) fail("WHISPER_CI_ATTEST_TOOL", `could not resolve ${command}`);
  const lines = decodeUtf8(result.stdout, "WHISPER_CI_ATTEST_TOOL", `${command} resolution`).split(/\r?\n/u).filter(Boolean);
  if (lines.length < 1) fail("WHISPER_CI_ATTEST_TOOL", `could not resolve ${command}`);
  return path.resolve(lines[0]);
}

export async function resolveConfiguredToolPath(toolName, envKey, repoRoot, options = {}) {
  const env = options.env ?? process.env;
  const override = env[envKey];
  const configured = options.toolResolver?.[toolName];
  const resolved = configured ?? (override ? safeResolveAbsolute(override, "WHISPER_CI_ATTEST_TOOL", envKey) : await resolveCommand(toolName, repoRoot, options));
  return safeResolveAbsolute(resolved, "WHISPER_CI_ATTEST_TOOL", `${toolName} executable`);
}

export async function bindExecutionToolPaths(repoRoot, options = {}) {
  const cargoCommand = await resolveConfiguredToolPath("cargo", "MEETINGRELAY_WHISPER_CARGO_PATH", repoRoot, options);
  const gitCommand = await resolveConfiguredToolPath("git", "MEETINGRELAY_WHISPER_GIT_PATH", repoRoot, options);
  const cmakeCommand = await resolveConfiguredToolPath("cmake", "MEETINGRELAY_WHISPER_CMAKE_PATH", repoRoot, options);
  return {
    ...options,
    cargoCommand,
    cmakeCommand,
    gitCommand,
    toolResolver: { ...options.toolResolver, cargo: cargoCommand, cmake: cmakeCommand, git: gitCommand },
  };
}

async function observeTools(repoRoot, options = {}) {
  if (options.toolObservationsForTest) return options.toolObservationsForTest;
  const env = options.env ?? process.env;
  const libclangCandidate = env.MEETINGRELAY_WHISPER_LIBCLANG_PATH ?? env.LIBCLANG_PATH;
  const libclang = libclangCandidate
    ? path.join(safeResolveAbsolute(libclangCandidate, "WHISPER_CI_ATTEST_TOOL", "LIBCLANG_PATH"), process.platform === "win32" ? "libclang.dll" : "libclang.so")
    : process.platform === "win32"
      ? "libclang.dll"
      : "libclang.so";
  const rows = [
    await resolveToolBytes("cargo", "MEETINGRELAY_WHISPER_CARGO_PATH", ["--version"], repoRoot, options),
    await resolveToolBytes("rustc", "MEETINGRELAY_WHISPER_RUSTC_PATH", ["--version", "--verbose"], repoRoot, options),
    await resolveToolBytes("git", "MEETINGRELAY_WHISPER_GIT_PATH", ["--version"], repoRoot, options),
    await resolveToolBytes("cmake", "MEETINGRELAY_WHISPER_CMAKE_PATH", ["--version"], repoRoot, options),
    await resolveToolBytes("clang", "MEETINGRELAY_WHISPER_CLANG_PATH", ["--version"], repoRoot, options),
    await observeLibclangBytes(options.toolResolver?.libclang ?? libclang),
  ];
  return { tool_count: rows.length, tools: rows, aggregate_sha256: hashObject(rows), toolchain_provenance_authority: "observed-tool-bytes-only" };
}

function childEnv(targetRoot, env = process.env, cmakeCommand) {
  const next = {};
  for (const [key, value] of Object.entries(env)) {
    const normalizedKey = key.toUpperCase();
    if (normalizedKey === "CARGO_NET_OFFLINE" || normalizedKey === "CARGO_INCREMENTAL" || normalizedKey === "CARGO_TARGET_DIR") continue;
    if (ALLOWED_CI_RESOLVER_ENV_RE.test(normalizedKey) || FORBIDDEN_ENV_RE.test(normalizedKey)) continue;
    next[key] = value;
  }
  return {
    ...next,
    CARGO_INCREMENTAL: "0",
    CARGO_NET_OFFLINE: "true",
    CARGO_TARGET_DIR: targetRoot,
    ...(cmakeCommand === undefined ? {} : { CMAKE: cmakeCommand }),
  };
}

function redactDiagnosticLiteral(value, literal, replacement) {
  if (typeof literal !== "string" || literal.length === 0) return value;
  const escaped = literal.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return value.replace(new RegExp(escaped, "giu"), replacement);
}

export function formatCargoFailureDiagnostic(stderr, repoRoot, targetRoot, env = process.env) {
  const bytes = Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr ?? "", "utf8");
  let value = bytes.subarray(Math.max(0, bytes.length - CARGO_FAILURE_DIAGNOSTIC_MAX_BYTES)).toString("utf8");
  value = value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "");
  for (const [literal, replacement] of [
    [targetRoot, "<target>"],
    [repoRoot, "<repo>"],
    [env.USERPROFILE, "<user-profile>"],
    [env.HOME, "<home>"],
    [env.RUNNER_TEMP, "<runner-temp>"],
  ]) {
    value = redactDiagnosticLiteral(value, literal, replacement);
  }
  value = value.trim();
  if (value.length === 0) return "<empty>";
  return value.slice(-CARGO_FAILURE_DIAGNOSTIC_MAX_CHARS);
}

export async function runCargoBuild(repoRoot, targetRoot, options = {}) {
  const args = [...CARGO_BUILD_ARGS];
  if (options.cargoMessagesForTest) return { args, messages: options.cargoMessagesForTest, stderr_sha256: sha256Hex(Buffer.alloc(0)) };
  const processOptions = {
    cwd: repoRoot,
    env: childEnv(targetRoot, options.env ?? process.env, options.cmakeCommand),
    timeoutMs: options.cargoTimeoutMs ?? 20 * 60_000,
    maxStdoutBytes: 64 * 1024 * 1024,
    maxStderrBytes: 8 * 1024 * 1024,
  };
  const result = options.runCargoForTest
    ? await options.runCargoForTest(options.cargoCommand ?? "cargo", args, processOptions)
    : await runProcess(options.cargoCommand ?? "cargo", args, processOptions);
  if (result.code !== 0 || result.signal !== null) {
    const stdoutSha256 = sha256Hex(result.stdout);
    const stderrSha256 = sha256Hex(result.stderr);
    const stdoutDiagnostic = formatCargoFailureDiagnostic(result.stdout, repoRoot, targetRoot, options.env ?? process.env);
    const stderrDiagnostic = formatCargoFailureDiagnostic(result.stderr, repoRoot, targetRoot, options.env ?? process.env);
    fail(
      "WHISPER_CI_ATTEST_CARGO_NONZERO",
      `cargo build failed exit_code=${result.code ?? "none"} signal=${result.signal ?? "none"} stdout_sha256=${stdoutSha256} stderr_sha256=${stderrSha256}\nstdout_tail:\n${stdoutDiagnostic}\nstderr_tail:\n${stderrDiagnostic}`,
    );
  }
  const messages = [];
  for (const [index, line] of decodeUtf8(result.stdout, "WHISPER_CI_ATTEST_CARGO_JSON", "cargo stdout").split(/\r?\n/u).entries()) {
    if (line.length === 0) continue;
    try {
      messages.push(JSON.parse(line));
    } catch (error) {
      fail("WHISPER_CI_ATTEST_CARGO_JSON", `invalid Cargo JSON at line ${index + 1}: ${error.message}`);
    }
  }
  return { args, messages, stderr_sha256: sha256Hex(result.stderr) };
}

export function selectCargoExecutable(build, targetRoot) {
  const expected = path.resolve(targetRoot, "release", RUNTIME_EXE_NAME);
  const executables = build.messages
    .filter((message) => {
      return (
        message?.reason === "compiler-artifact" &&
        message?.target?.name === "meetingrelay-whisper-runtime-version-probe" &&
        Array.isArray(message?.target?.kind) &&
        message.target.kind.length === 1 &&
        message.target.kind[0] === "bin" &&
        message?.profile?.test === false &&
        message?.profile?.opt_level !== "0" &&
        typeof message?.executable === "string" &&
        message.executable.length > 0
      );
    })
    .map((message) => path.resolve(message.executable));
  const unique = [...new Set(executables.map((item) => (process.platform === "win32" ? item.toLowerCase() : item)))];
  if (unique.length !== 1 || executables.length !== 1) fail("WHISPER_CI_ATTEST_ARTIFACT_AMBIGUITY", "expected exactly one matching Cargo compiler-artifact executable");
  if (!pathsEqual(executables[0], expected)) fail("WHISPER_CI_ATTEST_ARTIFACT_TARGET", "Cargo executable must be the exact isolated release target path");
  return executables[0];
}

export function parsePe(bytes) {
  if (bytes.length < 0x100 || bytes[0] !== 0x4d || bytes[1] !== 0x5a) fail("WHISPER_CI_ATTEST_PE", "executable must start with MZ");
  const peOffset = bytes.readUInt32LE(0x3c);
  if (peOffset < 0x40 || peOffset + 0x108 > bytes.length) fail("WHISPER_CI_ATTEST_PE", "PE header is outside bounded header read");
  if (bytes.toString("ascii", peOffset, peOffset + 4) !== "PE\u0000\u0000") fail("WHISPER_CI_ATTEST_PE", "PE signature missing");
  const machine = bytes.readUInt16LE(peOffset + 4);
  const sectionCount = bytes.readUInt16LE(peOffset + 6);
  const optionalSize = bytes.readUInt16LE(peOffset + 20);
  const optionalOffset = peOffset + 24;
  const magic = bytes.readUInt16LE(optionalOffset);
  const subsystem = bytes.readUInt16LE(optionalOffset + 68);
  if (machine !== 0x8664) fail("WHISPER_CI_ATTEST_PE", "PE machine must be AMD64");
  if (magic !== 0x20b) fail("WHISPER_CI_ATTEST_PE", "PE optional header must be PE32+");
  if (subsystem !== 3) fail("WHISPER_CI_ATTEST_PE", "PE subsystem must be console");
  if (sectionCount < 1 || optionalSize < 0xf0) fail("WHISPER_CI_ATTEST_PE", "PE section count and optional header size must be plausible");
  return { architecture: "amd64", optional_header: "pe32plus", subsystem: "console", section_count: sectionCount, optional_header_size: optionalSize };
}

async function inspectPe(absolutePath) {
  const handle = await open(absolutePath, "r").catch((error) => fail("WHISPER_CI_ATTEST_PE", error.message));
  try {
    const header = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    return parsePe(header.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

async function writeControlled5bRoot(targetRoot, builtExe) {
  const controlledRoot = path.join(targetRoot, "candidate-root");
  const inputsRoot = path.join(controlledRoot, "inputs");
  await mkdir(inputsRoot, { recursive: true });
  const sentinels = new Map([
    ["adapter-source", "ci build-output attestation adapter-source sentinel bytes only\n"],
    ["license", "ci build-output attestation license review sentinel bytes only\n"],
    ["model", "ci build-output attestation opaque model sentinel no model load\n"],
    ["model-manifest", "{\"ci\":true,\"role\":\"model-manifest\",\"authority\":\"sentinel-only\"}\n"],
    ["package-lock", "{\"ci\":true,\"role\":\"package-lock\",\"authority\":\"sentinel-only\"}\n"],
    ["parameters", "{\"ci\":true,\"role\":\"parameters\",\"authority\":\"sentinel-only\"}\n"],
  ]);
  const files = [];
  for (const role of REQUIRED_ROLES) {
    const relative = role === "runtime" ? `inputs/${RUNTIME_EXE_NAME}` : `inputs/${role}.bytes`;
    const absolute = path.join(controlledRoot, ...relative.split("/"));
    if (role === "runtime") await copyFile(builtExe, absolute);
    else await writeFile(absolute, sentinels.get(role), "utf8");
    const hashed = await hashRegularFile(absolute, "WHISPER_CI_ATTEST_5B_ROLE");
    files.push({ role, logical_id: `ci-wp-0.4.5d-${role}`, relative_path: relative, sha256: hashed.sha256, size_bytes: hashed.size_bytes });
  }
  const manifest = {
    kind: INPUT_MANIFEST_KIND,
    schema_version: "1.0",
    worker_role: WORKER_ROLE,
    measurement_status: PREFLIGHT_MEASUREMENT_STATUS,
    execution_status: "not-executed-no-model-no-transcription",
    quality_gate_status: "not-assessed",
    formal_claims: "none",
    production_evidence: false,
    public_distribution: false,
    selection_authority: "none",
    fallback_authority: "none",
    files,
  };
  const manifestPath = path.join(controlledRoot, "input-manifest.json");
  await writeFile(manifestPath, encodeCanonicalJson(manifest), "utf8");
  return { controlledRoot, manifestPath, runtimePath: path.join(controlledRoot, "inputs", RUNTIME_EXE_NAME), manifest };
}

function buildObservationDigest(build) {
  return hashObject({
    command_sha256: sha256Hex(Buffer.from(build.args.join("\0"), "utf8")),
    stderr_sha256: build.stderr_sha256,
    message_count: build.messages.length,
  });
}

export async function attestWhisperCiBuildOutputRuntimeIdentity(expectedHead, repoRoot, options = {}) {
  assertHead(expectedHead, "WHISPER_CI_ATTEST_HEAD", "expected HEAD");
  const root = safeResolveAbsolute(repoRoot, "WHISPER_CI_ATTEST_ROOT", "repo root");
  const injected = Object.keys(options).length > 0;
  if (options.observationScopeForTest !== undefined && options.observationScopeForTest !== SYNTHETIC_OBSERVATION_SCOPE) {
    fail("WHISPER_CI_ATTEST_SCOPE", "injected attestation options may only produce synthetic observation scope");
  }
  const observationScope = injected ? SYNTHETIC_OBSERVATION_SCOPE : REAL_OBSERVATION_SCOPE;
  validateAmbientEnvironment(options.env ?? process.env);
  const executionOptions = injected ? options : await bindExecutionToolPaths(root, options);
  const before = executionOptions.gitStateBeforeForTest ?? (await inspectGitState(root, expectedHead, executionOptions));
  const targetRoot = executionOptions.targetRootForTest ?? (await assertTargetRootReady(root, expectedHead, executionOptions));
  await mkdir(targetRoot, { recursive: true });
  const sourceFiles = executionOptions.sourceFilesForTest ?? (await observeSourceFiles(root));
  const registryLock = executionOptions.registryLockForTest ?? (await observeCargoRegistryLock(root));
  const tools = await observeTools(root, executionOptions);
  const build = await runCargoBuild(root, targetRoot, executionOptions);
  const selectedExecutable = executionOptions.selectedExecutableForTest ?? selectCargoExecutable(build, targetRoot);
  const buildRuntime = await hashRegularFile(selectedExecutable, "WHISPER_CI_ATTEST_RUNTIME", MAX_RUNTIME_BYTES, { requireSingleLink: false });
  const pe = executionOptions.peForTest ?? (await inspectPe(selectedExecutable));
  const controlled = executionOptions.controlledRootForTest ?? (await writeControlled5bRoot(targetRoot, selectedExecutable));
  const preflight = await preflightWhisperFallbackCandidate(controlled.controlledRoot, controlled.manifestPath);
  const probe = await probeWhisperFallbackRuntimeVersion(controlled.controlledRoot, controlled.manifestPath, controlled.runtimePath, preflight.candidate_descriptor.aggregate_sha256, executionOptions.probeOptionsForTest ?? {});
  if (probe.runtime.sha256 !== buildRuntime.sha256) fail("WHISPER_CI_ATTEST_5C_MISMATCH", "5c runtime SHA must equal selected build executable SHA");
  const copiedRuntime = await hashRegularFile(controlled.runtimePath, "WHISPER_CI_ATTEST_RUNTIME_COPY");
  if (copiedRuntime.sha256 !== buildRuntime.sha256) fail("WHISPER_CI_ATTEST_RUNTIME_DRIFT", "runtime copy changed before evidence");
  const after = executionOptions.gitStateAfterForTest ?? (await inspectGitState(root, expectedHead, executionOptions));
  if (after.head !== before.head || after.tracked_tree.digest_sha256 !== before.tracked_tree.digest_sha256 || after.repo_root_identity_sha256 !== before.repo_root_identity_sha256) {
    fail("WHISPER_CI_ATTEST_REPO_DRIFT", "repo HEAD, tracked tree, or root identity changed");
  }
  const schemaBytes = await readFile(PUBLIC_EVIDENCE_SCHEMA_PATH);
  JSON.parse(schemaBytes.toString("utf8"));
  const validatorBytes = await readFile(VALIDATOR_SOURCE_PATH);
  const evidence = {
    kind: PUBLIC_EVIDENCE_KIND,
    observation_scope: observationScope,
    schema_version: PUBLIC_EVIDENCE_SCHEMA_VERSION,
    schema_file_sha256: sha256Hex(schemaBytes),
    validator_source_sha256: sha256Hex(validatorBytes),
    expected_head_sha256: sha256Hex(Buffer.from(expectedHead, "utf8")),
    measurement_status: MEASUREMENT_STATUS,
    execution_status: EXECUTION_STATUS,
    build_output_identity_attestation: BUILD_OUTPUT_IDENTITY_ATTESTATION,
    source_build_provenance_authority: "none",
    registry_source_byte_closure: false,
    toolchain_provenance_authority: "observed-tool-bytes-only",
    loaded_image_attestation: false,
    network_isolation_authority: "none",
    quality_gate_status: "not-assessed",
    formal_claims: "none",
    production_evidence: false,
    public_distribution: false,
    selection_authority: "none",
    fallback_authority: "none",
    launch_binding_status: LAUNCH_BINDING_STATUS,
    repository: {
      before_sha256: hashObject(before),
      after_sha256: hashObject(after),
      clean_before_after_match: true,
      exact_head_observed: true,
      root_identity_before_after_match: true,
      tracked_tree_before_after_match: true,
      tracked_tree_digest_sha256: before.tracked_tree.digest_sha256,
      tracked_tree_entry_count: before.tracked_tree.entry_count,
    },
    source_materials: sourceFiles,
    cargo_registry_lock: registryLock,
    tool_observations: tools,
    cargo_build: {
      command_sha256: sha256Hex(Buffer.from(build.args.join("\0"), "utf8")),
      stderr_sha256: build.stderr_sha256,
      message_count: build.messages.length,
      selected_artifact_count: 1,
      build_observation_sha256: buildObservationDigest(build),
      isolated_target_root_sha256: executionOptions.isolatedTargetRootSha256ForTest ?? pathDigest(targetRoot),
      required_profile: "release",
      required_target_kind: "bin",
      required_feature_sha256: sha256Hex(Buffer.from("native-whisper", "utf8")),
      pdb_publication: false,
    },
    selected_runtime: {
      role: "runtime",
      size_bytes: buildRuntime.size_bytes,
      sha256: buildRuntime.sha256,
      identity_sha256: executionOptions.selectedRuntimeIdentitySha256ForTest ?? buildRuntime.identity_sha256,
      copied_runtime_sha256: copiedRuntime.sha256,
      pe,
    },
    five_b_preflight: {
      evidence_sha256: sha256Hex(Buffer.from(encodeCanonicalJson(preflight), "utf8")),
      candidate_aggregate_sha256: preflight.candidate_descriptor.aggregate_sha256,
      role_count: preflight.roles.length,
      runtime_role_sha256: preflight.roles.find((role) => role.role === "runtime").sha256,
    },
    five_c_probe: {
      evidence_sha256: sha256Hex(Buffer.from(encodeCanonicalJson(probe), "utf8")),
      measurement_status: PROBE_MEASUREMENT_STATUS,
      execution_status: PROBE_EXECUTION_STATUS,
      runtime_sha256: probe.runtime.sha256,
      stdout_marker_sha256: probe.probe.stdout_marker_sha256,
      linked_version_sha256: probe.probe.linked_version_sha256,
      launch_binding_status: probe.launch_binding_status,
      loaded_image_attestation: probe.loaded_image_attestation,
      network_isolation_authority: probe.network_isolation_authority,
    },
    joins: {
      build_runtime_equals_5b_runtime: true,
      build_runtime_equals_5c_runtime: true,
      join_sha256: hashObject({
        build_runtime_sha256: buildRuntime.sha256,
        five_b_runtime_sha256: preflight.roles.find((role) => role.role === "runtime").sha256,
        five_c_runtime_sha256: probe.runtime.sha256,
      }),
    },
    limitations: [...LIMITATIONS],
  };
  validatePublicEvidence(evidence);
  const evidenceText = encodeCanonicalJson(evidence);
  const persistedPath = path.join(targetRoot, "public-evidence.json");
  await writeFile(persistedPath, evidenceText, "utf8");
  const reread = await readFile(persistedPath, "utf8");
  if (reread !== evidenceText) fail("WHISPER_CI_ATTEST_EVIDENCE_REREAD", "persisted canonical evidence reread mismatch");
  const finalRuntime = await hashRegularFile(selectedExecutable, "WHISPER_CI_ATTEST_RUNTIME_FINAL", MAX_RUNTIME_BYTES, { requireSingleLink: false });
  const finalGit = executionOptions.gitStateFinalForTest ?? (await inspectGitState(root, expectedHead, executionOptions));
  if (finalRuntime.sha256 !== buildRuntime.sha256 || finalGit.head !== expectedHead || finalGit.tracked_tree.digest_sha256 !== before.tracked_tree.digest_sha256) {
    fail("WHISPER_CI_ATTEST_FINAL_DRIFT", "runtime bytes, HEAD, or tracked tree changed after evidence reread");
  }
  return evidence;
}

export function scanForbiddenPublicEvidence(value, pathSegments = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanForbiddenPublicEvidence(item, [...pathSegments, String(index)]));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (FORBIDDEN_PUBLIC_KEYS.has(key)) fail("WHISPER_CI_ATTEST_EVIDENCE_FORBIDDEN", `forbidden public evidence key ${[...pathSegments, key].join(".")}`);
      scanForbiddenPublicEvidence(item, [...pathSegments, key]);
    }
    return;
  }
  if (typeof value === "string") {
    if (LIMITATIONS.includes(value)) return;
    if (FORBIDDEN_PUBLIC_VALUE_RE.test(value)) fail("WHISPER_CI_ATTEST_EVIDENCE_FORBIDDEN", `forbidden public evidence value at ${pathSegments.join(".")}`);
  }
}

export function validatePublicEvidence(evidence) {
  assertPlainObject(evidence, "WHISPER_CI_ATTEST_EVIDENCE_SCHEMA", "evidence");
  assertAllowedKeys(
    evidence,
    new Set([
    "kind",
    "observation_scope",
    "schema_version",
      "schema_file_sha256",
      "validator_source_sha256",
      "expected_head_sha256",
      "measurement_status",
      "execution_status",
      "build_output_identity_attestation",
      "source_build_provenance_authority",
      "registry_source_byte_closure",
      "toolchain_provenance_authority",
      "loaded_image_attestation",
      "network_isolation_authority",
      "quality_gate_status",
      "formal_claims",
      "production_evidence",
      "public_distribution",
      "selection_authority",
      "fallback_authority",
      "launch_binding_status",
      "repository",
      "source_materials",
      "cargo_registry_lock",
      "tool_observations",
      "cargo_build",
      "selected_runtime",
      "five_b_preflight",
      "five_c_probe",
      "joins",
      "limitations",
    ]),
    "WHISPER_CI_ATTEST_EVIDENCE_SCHEMA",
    "evidence",
  );
  if (evidence.kind !== PUBLIC_EVIDENCE_KIND || evidence.schema_version !== PUBLIC_EVIDENCE_SCHEMA_VERSION) fail("WHISPER_CI_ATTEST_EVIDENCE_SCHEMA", "bad evidence identity");
  if (![REAL_OBSERVATION_SCOPE, SYNTHETIC_OBSERVATION_SCOPE].includes(evidence.observation_scope)) {
    fail("WHISPER_CI_ATTEST_EVIDENCE_SCHEMA", "bad observation scope");
  }
  for (const key of ["schema_file_sha256", "validator_source_sha256", "expected_head_sha256"]) assertSha256(evidence[key], "WHISPER_CI_ATTEST_EVIDENCE_SCHEMA", key);
  if (
    evidence.schema_file_sha256 !== sha256Hex(readFileSync(PUBLIC_EVIDENCE_SCHEMA_PATH)) ||
    evidence.validator_source_sha256 !== sha256Hex(readFileSync(VALIDATOR_SOURCE_PATH))
  ) {
    fail("WHISPER_CI_ATTEST_EVIDENCE_SCHEMA", "schema or validator digest mismatch");
  }
  if (
    evidence.measurement_status !== MEASUREMENT_STATUS ||
    evidence.execution_status !== EXECUTION_STATUS ||
    evidence.build_output_identity_attestation !== true ||
    evidence.source_build_provenance_authority !== "none" ||
    evidence.registry_source_byte_closure !== false ||
    evidence.toolchain_provenance_authority !== "observed-tool-bytes-only" ||
    evidence.loaded_image_attestation !== false ||
    evidence.network_isolation_authority !== "none" ||
    evidence.quality_gate_status !== "not-assessed" ||
    evidence.formal_claims !== "none" ||
    evidence.production_evidence !== false ||
    evidence.public_distribution !== false ||
    evidence.selection_authority !== "none" ||
    evidence.fallback_authority !== "none" ||
    evidence.launch_binding_status !== LAUNCH_BINDING_STATUS
  ) {
    fail("WHISPER_CI_ATTEST_EVIDENCE_OVERCLAIM", "authority fields overclaim");
  }
  assertPlainObject(evidence.repository, "WHISPER_CI_ATTEST_EVIDENCE_SCHEMA", "repository");
  assertAllowedKeys(
    evidence.repository,
    new Set([
      "before_sha256",
      "after_sha256",
      "clean_before_after_match",
      "exact_head_observed",
      "root_identity_before_after_match",
      "tracked_tree_before_after_match",
      "tracked_tree_digest_sha256",
      "tracked_tree_entry_count",
    ]),
    "WHISPER_CI_ATTEST_EVIDENCE_SCHEMA",
    "repository",
  );
  for (const key of ["before_sha256", "after_sha256", "tracked_tree_digest_sha256"]) assertSha256(evidence.repository[key], "WHISPER_CI_ATTEST_EVIDENCE_SCHEMA", `repository.${key}`);
  if (evidence.repository.before_sha256 !== evidence.repository.after_sha256) fail("WHISPER_CI_ATTEST_EVIDENCE_SCHEMA", "repository before/after digest mismatch");
  if (evidence.repository.clean_before_after_match !== true || evidence.repository.exact_head_observed !== true || evidence.repository.root_identity_before_after_match !== true || evidence.repository.tracked_tree_before_after_match !== true) {
    fail("WHISPER_CI_ATTEST_EVIDENCE_SCHEMA", "repository clean identity fields must be true");
  }
  if (!Number.isSafeInteger(evidence.repository.tracked_tree_entry_count) || evidence.repository.tracked_tree_entry_count < 1) fail("WHISPER_CI_ATTEST_EVIDENCE_SCHEMA", "tracked tree entry count invalid");
  validateSourceMaterials(evidence.source_materials);
  validateRegistryLock(evidence.cargo_registry_lock);
  validateToolObservations(evidence.tool_observations);
  validateCargoBuild(evidence.cargo_build);
  validateSelectedRuntime(evidence.selected_runtime);
  validateFiveB(evidence.five_b_preflight);
  validateFiveC(evidence.five_c_probe);
  if (
    evidence.selected_runtime.sha256 !== evidence.five_b_preflight.runtime_role_sha256 ||
    evidence.selected_runtime.sha256 !== evidence.five_c_probe.runtime_sha256
  ) {
    fail("WHISPER_CI_ATTEST_EVIDENCE_SCHEMA", "runtime SHA joins must match");
  }
  assertPlainObject(evidence.joins, "WHISPER_CI_ATTEST_EVIDENCE_SCHEMA", "joins");
  assertAllowedKeys(evidence.joins, new Set(["build_runtime_equals_5b_runtime", "build_runtime_equals_5c_runtime", "join_sha256"]), "WHISPER_CI_ATTEST_EVIDENCE_SCHEMA", "joins");
  assertSha256(evidence.joins.join_sha256, "WHISPER_CI_ATTEST_EVIDENCE_SCHEMA", "joins.join_sha256");
  if (evidence.joins.build_runtime_equals_5b_runtime !== true || evidence.joins.build_runtime_equals_5c_runtime !== true) fail("WHISPER_CI_ATTEST_EVIDENCE_SCHEMA", "joins must be true");
  if (
    evidence.joins.join_sha256 !==
    hashObject({
      build_runtime_sha256: evidence.selected_runtime.sha256,
      five_b_runtime_sha256: evidence.five_b_preflight.runtime_role_sha256,
      five_c_runtime_sha256: evidence.five_c_probe.runtime_sha256,
    })
  ) {
    fail("WHISPER_CI_ATTEST_EVIDENCE_SCHEMA", "join digest mismatch");
  }
  if (!Array.isArray(evidence.limitations) || evidence.limitations.length !== LIMITATIONS.length) fail("WHISPER_CI_ATTEST_EVIDENCE_SCHEMA", "limitations must be exact");
  for (const [index, limitation] of LIMITATIONS.entries()) if (evidence.limitations[index] !== limitation) fail("WHISPER_CI_ATTEST_EVIDENCE_SCHEMA", "limitation mismatch");
  scanForbiddenPublicEvidence(evidence);
  return true;
}

function validateSourceMaterials(value) {
  assertPlainObject(value, "WHISPER_CI_ATTEST_EVIDENCE_SCHEMA", "source_materials");
  assertAllowedKeys(value, new Set(["file_count", "files", "aggregate_sha256"]), "WHISPER_CI_ATTEST_EVIDENCE_SCHEMA", "source_materials");
  assertSha256(value.aggregate_sha256, "WHISPER_CI_ATTEST_EVIDENCE_SCHEMA", "source_materials.aggregate_sha256");
  if (value.file_count !== 5 || !Array.isArray(value.files) || value.files.length !== 5) fail("WHISPER_CI_ATTEST_EVIDENCE_SCHEMA", "source material count mismatch");
  for (const [index, file] of value.files.entries()) {
    assertPlainObject(file, "WHISPER_CI_ATTEST_EVIDENCE_SCHEMA", "source_material");
    assertAllowedKeys(file, new Set(["relative_path_sha256", "sha256", "size_bytes"]), "WHISPER_CI_ATTEST_EVIDENCE_SCHEMA", "source_material");
    assertSha256(file.relative_path_sha256, "WHISPER_CI_ATTEST_EVIDENCE_SCHEMA", "source_material.relative_path_sha256");
    assertSha256(file.sha256, "WHISPER_CI_ATTEST_EVIDENCE_SCHEMA", "source_material.sha256");
    if (!Number.isSafeInteger(file.size_bytes) || file.size_bytes < 1) fail("WHISPER_CI_ATTEST_EVIDENCE_SCHEMA", "source material size invalid");
    if (file.relative_path_sha256 !== sha256Hex(Buffer.from(SOURCE_RELATIVE_PATHS[index], "utf8"))) {
      fail("WHISPER_CI_ATTEST_EVIDENCE_SCHEMA", "source material identity or order mismatch");
    }
  }
  if (value.aggregate_sha256 !== hashObject(value.files)) fail("WHISPER_CI_ATTEST_EVIDENCE_SCHEMA", "source materials aggregate mismatch");
}

function validateRegistryLock(value) {
  assertPlainObject(value, "WHISPER_CI_ATTEST_EVIDENCE_SCHEMA", "cargo_registry_lock");
  assertAllowedKeys(value, new Set(["package_count", "packages", "registry_source_byte_closure", "aggregate_sha256"]), "WHISPER_CI_ATTEST_EVIDENCE_SCHEMA", "cargo_registry_lock");
  if (value.package_count !== 2 || value.registry_source_byte_closure !== false || !Array.isArray(value.packages) || value.packages.length !== 2) fail("WHISPER_CI_ATTEST_EVIDENCE_SCHEMA", "registry lock count mismatch");
  assertSha256(value.aggregate_sha256, "WHISPER_CI_ATTEST_EVIDENCE_SCHEMA", "cargo_registry_lock.aggregate_sha256");
  for (const [index, pkg] of value.packages.entries()) {
    assertPlainObject(pkg, "WHISPER_CI_ATTEST_EVIDENCE_SCHEMA", "cargo_registry_lock.package");
    assertAllowedKeys(pkg, new Set(["checksum", "name_sha256", "source_sha256", "version"]), "WHISPER_CI_ATTEST_EVIDENCE_SCHEMA", "cargo_registry_lock.package");
    assertSha256(pkg.name_sha256, "WHISPER_CI_ATTEST_EVIDENCE_SCHEMA", "package.name_sha256");
    assertSha256(pkg.source_sha256, "WHISPER_CI_ATTEST_EVIDENCE_SCHEMA", "package.source_sha256");
    const expected = REQUIRED_LOCK_PACKAGES[index];
    if (
      pkg.checksum !== expected.checksum ||
      pkg.name_sha256 !== sha256Hex(Buffer.from(expected.name, "utf8")) ||
      pkg.source_sha256 !== sha256Hex(Buffer.from(expected.source, "utf8")) ||
      pkg.version !== expected.version
    ) {
      fail("WHISPER_CI_ATTEST_EVIDENCE_SCHEMA", "package identity, order, source, version, or checksum mismatch");
    }
  }
  if (value.aggregate_sha256 !== hashObject(value.packages)) fail("WHISPER_CI_ATTEST_EVIDENCE_SCHEMA", "registry aggregate mismatch");
}

function validateToolObservations(value) {
  assertPlainObject(value, "WHISPER_CI_ATTEST_EVIDENCE_SCHEMA", "tool_observations");
  assertAllowedKeys(value, new Set(["tool_count", "tools", "aggregate_sha256", "toolchain_provenance_authority"]), "WHISPER_CI_ATTEST_EVIDENCE_SCHEMA", "tool_observations");
  if (value.tool_count !== 6 || value.toolchain_provenance_authority !== "observed-tool-bytes-only" || !Array.isArray(value.tools) || value.tools.length !== 6) fail("WHISPER_CI_ATTEST_EVIDENCE_SCHEMA", "tool observation count mismatch");
  assertSha256(value.aggregate_sha256, "WHISPER_CI_ATTEST_EVIDENCE_SCHEMA", "tool_observations.aggregate_sha256");
  for (const [index, tool] of value.tools.entries()) {
    assertPlainObject(tool, "WHISPER_CI_ATTEST_EVIDENCE_SCHEMA", "tool");
    assertAllowedKeys(tool, new Set(["name_sha256", "bytes_sha256", "size_bytes", "version_output_sha256"]), "WHISPER_CI_ATTEST_EVIDENCE_SCHEMA", "tool");
    for (const key of ["name_sha256", "bytes_sha256", "version_output_sha256"]) assertSha256(tool[key], "WHISPER_CI_ATTEST_EVIDENCE_SCHEMA", `tool.${key}`);
    if (!Number.isSafeInteger(tool.size_bytes) || tool.size_bytes < 1) fail("WHISPER_CI_ATTEST_EVIDENCE_SCHEMA", "tool size invalid");
    if (tool.name_sha256 !== sha256Hex(Buffer.from(OBSERVED_TOOL_NAMES[index], "utf8"))) {
      fail("WHISPER_CI_ATTEST_EVIDENCE_SCHEMA", "tool identity or order mismatch");
    }
  }
  if (value.aggregate_sha256 !== hashObject(value.tools)) fail("WHISPER_CI_ATTEST_EVIDENCE_SCHEMA", "tool aggregate mismatch");
}

function validateCargoBuild(value) {
  assertPlainObject(value, "WHISPER_CI_ATTEST_EVIDENCE_SCHEMA", "cargo_build");
  assertAllowedKeys(value, new Set(["command_sha256", "stderr_sha256", "message_count", "selected_artifact_count", "build_observation_sha256", "isolated_target_root_sha256", "required_profile", "required_target_kind", "required_feature_sha256", "pdb_publication"]), "WHISPER_CI_ATTEST_EVIDENCE_SCHEMA", "cargo_build");
  for (const key of ["command_sha256", "stderr_sha256", "build_observation_sha256", "isolated_target_root_sha256", "required_feature_sha256"]) assertSha256(value[key], "WHISPER_CI_ATTEST_EVIDENCE_SCHEMA", `cargo_build.${key}`);
  if (!Number.isSafeInteger(value.message_count) || value.message_count < 1 || value.selected_artifact_count !== 1 || value.required_profile !== "release" || value.required_target_kind !== "bin" || value.pdb_publication !== false) fail("WHISPER_CI_ATTEST_EVIDENCE_SCHEMA", "cargo build observation invalid");
  if (
    value.command_sha256 !== sha256Hex(Buffer.from(CARGO_BUILD_ARGS.join("\0"), "utf8")) ||
    value.required_feature_sha256 !== sha256Hex(Buffer.from("native-whisper", "utf8"))
  ) {
    fail("WHISPER_CI_ATTEST_EVIDENCE_SCHEMA", "Cargo command or feature identity mismatch");
  }
  if (
    value.build_observation_sha256 !==
    hashObject({ command_sha256: value.command_sha256, stderr_sha256: value.stderr_sha256, message_count: value.message_count })
  ) {
    fail("WHISPER_CI_ATTEST_EVIDENCE_SCHEMA", "cargo build observation digest mismatch");
  }
}

function validateSelectedRuntime(value) {
  assertPlainObject(value, "WHISPER_CI_ATTEST_EVIDENCE_SCHEMA", "selected_runtime");
  assertAllowedKeys(value, new Set(["role", "size_bytes", "sha256", "identity_sha256", "copied_runtime_sha256", "pe"]), "WHISPER_CI_ATTEST_EVIDENCE_SCHEMA", "selected_runtime");
  if (value.role !== "runtime" || value.copied_runtime_sha256 !== value.sha256) fail("WHISPER_CI_ATTEST_EVIDENCE_SCHEMA", "selected runtime join invalid");
  for (const key of ["sha256", "identity_sha256", "copied_runtime_sha256"]) assertSha256(value[key], "WHISPER_CI_ATTEST_EVIDENCE_SCHEMA", `selected_runtime.${key}`);
  if (!Number.isSafeInteger(value.size_bytes) || value.size_bytes < 1 || value.size_bytes > MAX_RUNTIME_BYTES) fail("WHISPER_CI_ATTEST_EVIDENCE_SCHEMA", "selected runtime size invalid");
  assertPlainObject(value.pe, "WHISPER_CI_ATTEST_EVIDENCE_SCHEMA", "pe");
  assertAllowedKeys(value.pe, new Set(["architecture", "optional_header", "subsystem", "section_count", "optional_header_size"]), "WHISPER_CI_ATTEST_EVIDENCE_SCHEMA", "pe");
  if (value.pe.architecture !== "amd64" || value.pe.optional_header !== "pe32plus" || value.pe.subsystem !== "console") fail("WHISPER_CI_ATTEST_EVIDENCE_SCHEMA", "PE authority mismatch");
  if (!Number.isSafeInteger(value.pe.section_count) || value.pe.section_count < 1 || !Number.isSafeInteger(value.pe.optional_header_size) || value.pe.optional_header_size < 0xf0) fail("WHISPER_CI_ATTEST_EVIDENCE_SCHEMA", "PE shape counts invalid");
}

function validateFiveB(value) {
  assertPlainObject(value, "WHISPER_CI_ATTEST_EVIDENCE_SCHEMA", "five_b_preflight");
  assertAllowedKeys(value, new Set(["evidence_sha256", "candidate_aggregate_sha256", "role_count", "runtime_role_sha256"]), "WHISPER_CI_ATTEST_EVIDENCE_SCHEMA", "five_b_preflight");
  for (const key of ["evidence_sha256", "candidate_aggregate_sha256", "runtime_role_sha256"]) assertSha256(value[key], "WHISPER_CI_ATTEST_EVIDENCE_SCHEMA", `five_b_preflight.${key}`);
  if (value.role_count !== 7) fail("WHISPER_CI_ATTEST_EVIDENCE_SCHEMA", "5b role count mismatch");
}

function validateFiveC(value) {
  assertPlainObject(value, "WHISPER_CI_ATTEST_EVIDENCE_SCHEMA", "five_c_probe");
  assertAllowedKeys(value, new Set(["evidence_sha256", "measurement_status", "execution_status", "runtime_sha256", "stdout_marker_sha256", "linked_version_sha256", "launch_binding_status", "loaded_image_attestation", "network_isolation_authority"]), "WHISPER_CI_ATTEST_EVIDENCE_SCHEMA", "five_c_probe");
  for (const key of ["evidence_sha256", "runtime_sha256", "stdout_marker_sha256", "linked_version_sha256"]) assertSha256(value[key], "WHISPER_CI_ATTEST_EVIDENCE_SCHEMA", `five_c_probe.${key}`);
  if (value.measurement_status !== PROBE_MEASUREMENT_STATUS || value.execution_status !== PROBE_EXECUTION_STATUS || value.launch_binding_status !== LAUNCH_BINDING_STATUS || value.loaded_image_attestation !== false || value.network_isolation_authority !== "none") fail("WHISPER_CI_ATTEST_EVIDENCE_SCHEMA", "5c authority mismatch");
}

async function runSynthetic() {
  const root = await mkdtemp(path.join(tmpdir(), "meetingrelay-whisper-ci-5d-"));
  const head = "0123456789abcdef0123456789abcdef01234567";
  try {
    const repo = path.join(root, "repo");
    const targetRoot = path.join(repo, "target", "whisper-native", "wp-0.4.5d", head);
    await mkdir(path.join(repo, "target", "whisper-native", "wp-0.4.5d"), { recursive: true });
    await mkdir(path.join(repo, ".cargo"), { recursive: true });
    await writeFile(path.join(repo, "Cargo.toml"), "[workspace]\n", "utf8");
    await writeFile(path.join(repo, ".cargo", "config.toml"), "[env]\n", "utf8");
    await writeFile(path.join(repo, "rust-toolchain.toml"), "[toolchain]\nchannel = \"1.95.0\"\n", "utf8");
    await mkdir(path.join(repo, "crates", "model-worker-whisper-native"), { recursive: true });
    await writeFile(path.join(repo, "crates", "model-worker-whisper-native", "Cargo.toml"), "[package]\nname = \"meetingrelay-model-worker-whisper-native\"\n", "utf8");
    await writeFile(
      path.join(repo, "Cargo.lock"),
      '[[package]]\nname = "whisper-rs"\nversion = "0.16.0"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "2088172d00f936c348d6a72f488dc2660ab3f507263a195df308a3c2383229f6"\n\n[[package]]\nname = "whisper-rs-sys"\nversion = "0.15.0"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "6986c0fe081241d391f09b9a071fbcbb59720c3563628c3c829057cf69f2a56f"\n',
      "utf8",
    );
    await mkdir(path.join(targetRoot, "release", "deps"), { recursive: true });
    const exe = path.join(targetRoot, "release", RUNTIME_EXE_NAME);
    const depsExe = path.join(targetRoot, "release", "deps", `meetingrelay_whisper_runtime_version_probe-synthetic${process.platform === "win32" ? ".exe" : ""}`);
    await writeFile(depsExe, makeSyntheticPe(), { mode: 0o700 });
    await link(depsExe, exe);
    const gitState = {
      head,
      repo_root_identity_sha256: sha256Hex(Buffer.from("root-id", "utf8")),
      repo_root_realpath_sha256: sha256Hex(Buffer.from("root-realpath", "utf8")),
      tracked_tree: { digest_sha256: sha256Hex(Buffer.from("tree", "utf8")), entry_count: 5 },
    };
    const message = {
      executable: exe,
      profile: { opt_level: "3", test: false },
      reason: "compiler-artifact",
      target: { kind: ["bin"], name: "meetingrelay-whisper-runtime-version-probe" },
    };
    const marker =
      "meetingrelay-whisper-runtime-version-probe-v1 linked_whisper_cpp_version=1.8.3 measurement_status=whisper-runtime-version-marker-path-observation-only execution_status=runtime-path-launched-fixed-version-marker-observed-no-model-no-transcription quality_gate_status=not-assessed formal_claims=none production_evidence=false public_distribution=false selection_authority=none fallback_authority=none loaded_image_attestation=false network_isolation_authority=none\n";
    const evidence = await attestWhisperCiBuildOutputRuntimeIdentity(head, repo, {
      cargoMessagesForTest: [message],
      env: {},
      gitStateAfterForTest: gitState,
      gitStateBeforeForTest: gitState,
      gitStateFinalForTest: gitState,
      peForTest: parsePe(makeSyntheticPe()),
      probeOptionsForTest: { spawnImpl: fakeSpawn(marker) },
      isolatedTargetRootSha256ForTest: sha256Hex(Buffer.from("synthetic-target-root", "utf8")),
      observationScopeForTest: "synthetic-injected-harness",
      selectedRuntimeIdentitySha256ForTest: sha256Hex(Buffer.from("synthetic-runtime-identity", "utf8")),
      targetRootForTest: targetRoot,
      toolObservationsForTest: syntheticToolObservations(),
    });
    return evidence;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export function makeSyntheticPe() {
  const bytes = Buffer.alloc(1024, 0);
  bytes[0] = 0x4d;
  bytes[1] = 0x5a;
  bytes.writeUInt32LE(0x80, 0x3c);
  bytes.write("PE\0\0", 0x80, "ascii");
  bytes.writeUInt16LE(0x8664, 0x84);
  bytes.writeUInt16LE(3, 0x86);
  bytes.writeUInt16LE(0xf0, 0x94);
  bytes.writeUInt16LE(0x20b, 0x98);
  bytes.writeUInt16LE(3, 0xdc);
  return bytes;
}

function syntheticToolObservations() {
  const tools = ["cargo", "rustc", "git", "cmake", "clang", "libclang"].map((name) => ({
    bytes_sha256: sha256Hex(Buffer.from(`${name}-bytes`, "utf8")),
    name_sha256: sha256Hex(Buffer.from(name, "utf8")),
    size_bytes: 17,
    version_output_sha256: sha256Hex(Buffer.from(`${name}-version`, "utf8")),
  }));
  return { aggregate_sha256: hashObject(tools), tool_count: tools.length, toolchain_provenance_authority: "observed-tool-bytes-only", tools };
}

function fakeSpawn(stdoutText) {
  return () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const listeners = new Map();
    const child = {
      killed: false,
      stdout,
      stderr,
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
      stdout.end(stdoutText);
      stderr.end();
      for (const handler of listeners.get("exit") ?? []) handler(0, null);
      for (const handler of listeners.get("close") ?? []) handler(0, null);
    });
    return child;
  };
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length === 0 || (argv.length === 1 && argv[0] === "--run-synthetic")) {
    const evidence = await runSynthetic();
    const evidenceText = encodeCanonicalJson(evidence);
    process.stdout.write(
      `whisper-fallback-ci-build-output-runtime-identity-attestation=verified evidence_sha256=${sha256Hex(Buffer.from(evidenceText, "utf8"))} runtime_sha256=${evidence.selected_runtime.sha256} candidate_aggregate_sha256=${evidence.five_b_preflight.candidate_aggregate_sha256} five_c_runtime_sha256=${evidence.five_c_probe.runtime_sha256} observation_scope=${evidence.observation_scope} measurement_status=${evidence.measurement_status} execution_status=${evidence.execution_status} build_output_identity_attestation=true source_build_provenance_authority=none registry_source_byte_closure=false toolchain_provenance_authority=observed-tool-bytes-only loaded_image_attestation=false network_isolation_authority=none quality_gate_status=not-assessed formal_claims=none production_evidence=false public_distribution=false selection_authority=none fallback_authority=none launch_binding_status=${evidence.launch_binding_status} fixture_scope=synthetic-ci-build-output-runtime-identity-attestation-no-model-no-transcription\n`,
    );
    return;
  }
  if (argv.length === 3 && argv[0] === "--attest") {
    const evidence = await attestWhisperCiBuildOutputRuntimeIdentity(argv[1], argv[2]);
    const evidenceText = encodeCanonicalJson(evidence);
    process.stdout.write(
      `whisper-fallback-ci-build-output-runtime-identity-attestation=verified evidence_sha256=${sha256Hex(Buffer.from(evidenceText, "utf8"))} runtime_sha256=${evidence.selected_runtime.sha256} candidate_aggregate_sha256=${evidence.five_b_preflight.candidate_aggregate_sha256} five_c_runtime_sha256=${evidence.five_c_probe.runtime_sha256} observation_scope=${evidence.observation_scope} measurement_status=${evidence.measurement_status} execution_status=${evidence.execution_status} build_output_identity_attestation=true source_build_provenance_authority=none registry_source_byte_closure=false toolchain_provenance_authority=observed-tool-bytes-only loaded_image_attestation=false network_isolation_authority=none quality_gate_status=not-assessed formal_claims=none production_evidence=false public_distribution=false selection_authority=none fallback_authority=none launch_binding_status=${evidence.launch_binding_status}\n`,
    );
    return;
  }
  if (argv.length === 2 && argv[0] === "--validate-json") {
    let evidence;
    try {
      evidence = JSON.parse(argv[1]);
    } catch (error) {
      fail("WHISPER_CI_ATTEST_EVIDENCE_CANONICAL", `evidence must parse as JSON: ${error.message}`);
    }
    if (encodeCanonicalJson(evidence) !== argv[1]) fail("WHISPER_CI_ATTEST_EVIDENCE_CANONICAL", "evidence must be canonical indented JSON with one terminal LF");
    validatePublicEvidence(evidence);
    process.stdout.write(`whisper-fallback-ci-build-output-runtime-identity-attestation-json=verified evidence_sha256=${sha256Hex(Buffer.from(encodeCanonicalJson(evidence), "utf8"))}\n`);
    return;
  }
  fail("WHISPER_CI_ATTEST_USAGE", "usage: node tools/whisper-native/whisper-fallback-ci-build-output-runtime-identity-attestation.mjs [--run-synthetic]|--attest <expected-head> <absolute-repo-root>|--validate-json '<canonical-json>'");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.code ?? "WHISPER_CI_ATTEST_FAILED"}: ${error.message}\n`);
    process.exitCode = 1;
  });
}
