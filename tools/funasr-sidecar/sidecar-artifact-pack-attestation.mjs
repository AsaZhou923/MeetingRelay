#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { TextDecoder } from "node:util";

import { encodeCanonicalJson } from "../phase0-harness/canonical-json.mjs";
import { REQUIRED_ROLES, preflightCandidate } from "./sidecar-candidate-preflight.mjs";
import {
  attestPackageLock,
  readPackageLockFromCanonicalBytes,
  validatePublicEvidence as validatePackageLockEvidence,
} from "./sidecar-package-lock-attestation.mjs";

export const PUBLIC_EVIDENCE_KIND = "meetingrelay-funasr-sidecar-artifact-pack-attestation-v1";
export const PUBLIC_EVIDENCE_SCHEMA_VERSION = "1.0";
export const PUBLIC_EVIDENCE_SCHEMA_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "sidecar-artifact-pack-attestation.schema.json",
);
export const ATTESTOR_SOURCE_PATH = fileURLToPath(import.meta.url);

const ZERO_SHA = "0".repeat(64);
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_SMALL_JSON_BYTES = 4 * 1024 * 1024;
const MAX_PUBLIC_EVIDENCE_BYTES = 1024 * 1024;
const MAX_ARTIFACT_BYTES = 1024 * 1024 * 1024;
const MAX_TOTAL_ARTIFACT_BYTES = 16 * 1024 * 1024 * 1024;
const STREAM_CHUNK_BYTES = 1024 * 1024;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const ROOT_REQUIREMENTS = Object.freeze(["funasr==1.3.22", "torch==2.6.0+cpu", "torchaudio==2.6.0+cpu"]);
const BUILT_WHEEL_NAMES = Object.freeze(["aliyun-python-sdk-core", "antlr4-python3-runtime", "crcmod", "jieba", "oss2"]);
const TARGET = Object.freeze({
  os: "windows",
  arch: "amd64",
  cpython_version_family: "3.12.x",
  python_abi: "cp312",
  platform_tag: "win_amd64",
  accelerator_profile: "cpu-baseline",
});
const LIMITATIONS = Object.freeze([
  "artifact-pack-target-byte-attestation-only: this validates caller-supplied target artifact bytes under a controlled root and does not install, import, execute, or approve packages",
  "source-archive and build-record bytes are bound to package-lock declarations, but builds are not replayed and source provenance is not established",
  "license-set bytes are hashed for review plumbing only; this is not legal approval, distribution approval, or publication authority",
  "resolver, expected-environment, and import-map reports are target record bytes only; no environment is materialized and no import is attempted",
  "public evidence intentionally omits filesystem paths, artifact filenames, package names, requirement text, URLs, license text, report text, host identity, timings, and plaintext",
]);
const ALLOWED_PUBLIC_STRINGS = new Set([
  PUBLIC_EVIDENCE_KIND,
  PUBLIC_EVIDENCE_SCHEMA_VERSION,
  "meetingrelay-funasr-sidecar-artifact-pack-v1",
  "artifact-pack-target-byte-attestation-only",
  "artifact-target-bytes-verified-no-install-no-import",
  "artifact-pack-byte-identity-only",
  "source-archive-and-build-record-target-bytes-bound-only",
  "license-set-target-bytes-verified-not-legal-approval",
  "target-record-bytes-bound-only",
  "expected-projection-target-bytes-bound-only",
  "target-bytes-bound-no-import",
  "none",
  "not-assessed",
  "sidecar-candidate",
  "windows",
  "amd64",
  "3.12.x",
  "cp312",
  "win_amd64",
  "cpu-baseline",
  "synthetic-artifact-pack-contract-only",
  "caller-supplied-controlled-artifacts-not-product-approved",
  "path-url-name-text-free",
  ...LIMITATIONS,
]);
const FORBIDDEN_PUBLIC_KEYS = new Set(["absolute_path", "artifact", "content", "dependency", "file_path", "filename", "license_text", "package", "path", "requirement", "root", "source", "text", "url", "wheel_url"]);
const FORBIDDEN_PUBLIC_VALUE_RE = /(?:[A-Za-z]:\\|\\\\|\/tmp\/|\/home\/|\/Users\/|wheelhouse\/|artifacts\/|inputs\/|https?:\/\/|file:\/\/|funasr|torch|torchaudio|jieba|oss2|crcmod|aliyun|antlr|==|\.whl|\.tar\.gz|LICENSE|METADATA|RECORD)/iu;

export class ArtifactPackAttestationError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "ArtifactPackAttestationError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ArtifactPackAttestationError(code, message);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function identityFromStat(value) {
  return {
    dev: value.dev,
    ino: value.ino,
    size: value.size,
    mtimeNs: value.mtimeNs,
    ctimeNs: value.ctimeNs,
    birthtimeNs: value.birthtimeNs,
  };
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs && left.birthtimeNs === right.birthtimeNs;
}

function assertPlainObject(value, code, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(code, `${label} must be an object`);
}

function assertAllowedKeys(value, allowed, code, label) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(code, `${label} has unknown field ${key}`);
}

function assertSha256(value, code, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value) || value === ZERO_SHA) fail(code, `${label} must be non-zero lowercase sha256`);
}

function normalizePackageName(name) {
  if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,126}$/u.test(name) || name !== name.normalize("NFC")) fail("ARTIFACT_PACK_NAME", "distribution name must be a safe token");
  return name.toLowerCase().replaceAll(/[-_.]+/gu, "-");
}

function rejectUnsafeAbsolute(inputPath, code, label) {
  if (typeof inputPath !== "string" || inputPath.length === 0 || inputPath.includes("\0") || /[\r\n]/u.test(inputPath)) fail(code, `${label} must be a safe path`);
  if (inputPath.startsWith("\\\\") || inputPath.startsWith("//") || /^\\\\[.?]\\|^\/\/[.?]\//u.test(inputPath)) fail(code, `${label} must not use UNC or device syntax`);
  const colonIndexes = [...inputPath.matchAll(/:/gu)].map((match) => match.index);
  const hasDriveColon = colonIndexes.length === 1 && colonIndexes[0] === 1 && /^[A-Za-z]:[\\/]/u.test(inputPath);
  if ((colonIndexes.length > 0 && !hasDriveColon) || /^[A-Za-z]:(?![\\/])/u.test(inputPath) || !path.isAbsolute(inputPath)) fail(code, `${label} must be absolute local path without ADS or drive-relative syntax`);
  return path.resolve(inputPath);
}

function validateRelativePath(relativePath, code, label) {
  if (typeof relativePath !== "string" || relativePath.length === 0 || relativePath.length > 240 || relativePath !== relativePath.normalize("NFC")) fail(code, `${label} must be a bounded NFC relative path`);
  if (relativePath.includes("\\") || relativePath.includes(":") || relativePath.includes("\0") || relativePath.startsWith("/") || path.posix.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath)) fail(code, `${label} must not contain absolute, drive, ADS, UNC, or backslash syntax`);
  for (const segment of relativePath.split("/")) {
    if (segment === "" || segment === "." || segment === ".." || segment.endsWith(" ") || segment.endsWith(".") || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(segment)) fail(code, `${label} contains traversal, reserved, or unsafe segment`);
  }
  return relativePath;
}

function ensureInside(root, relativePath, code, label) {
  validateRelativePath(relativePath, code, label);
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, ...relativePath.split("/"));
  const prefix = resolvedRoot.endsWith(path.sep) ? resolvedRoot : `${resolvedRoot}${path.sep}`;
  const comparablePrefix = process.platform === "win32" ? prefix.toLowerCase() : prefix;
  const comparableResolved = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  if (resolved === resolvedRoot || !comparableResolved.startsWith(comparablePrefix)) fail(code, `${label} escaped controlled root`);
  return resolved;
}

function ensureAbsoluteInsideRoot(root, absolutePath, code, label) {
  const resolvedRoot = path.resolve(root);
  const resolved = rejectUnsafeAbsolute(absolutePath, code, label);
  const prefix = resolvedRoot.endsWith(path.sep) ? resolvedRoot : `${resolvedRoot}${path.sep}`;
  const comparablePrefix = process.platform === "win32" ? prefix.toLowerCase() : prefix;
  const comparableResolved = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  if (resolved === resolvedRoot || !comparableResolved.startsWith(comparablePrefix)) fail(code, `${label} escaped controlled root`);
  return resolved;
}

function assertNoSymlinkComponents(root, absolutePath, code, label) {
  const resolvedRoot = path.resolve(root);
  const resolved = ensureAbsoluteInsideRoot(resolvedRoot, absolutePath, code, label);
  const relative = path.relative(resolvedRoot, resolved);
  let current = resolvedRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = lstatSync(current, { bigint: true });
    if (stat.isSymbolicLink()) fail(code, `${label} must not traverse a symlink or junction`);
  }
  return resolved;
}

function resolveManifestPathInsideRoot(root, manifestPath, code, label) {
  if (typeof manifestPath !== "string" || manifestPath.length === 0) fail(code, `${label} must be a non-empty path`);
  const absolute = path.isAbsolute(manifestPath)
    ? ensureAbsoluteInsideRoot(root, manifestPath, code, label)
    : ensureInside(root, manifestPath, code, label);
  return assertNoSymlinkComponents(root, absolute, code, label);
}

async function snapshotControlledRoot(root) {
  const absolute = rejectUnsafeAbsolute(root, "ARTIFACT_PACK_ROOT", "controlled root");
  const before = await lstat(absolute, { bigint: true }).catch((error) => fail("ARTIFACT_PACK_ROOT", error.message));
  if (!before.isDirectory() || before.isSymbolicLink()) fail("ARTIFACT_PACK_ROOT", "controlled root must be a directory");
  return { absolute, identity: identityFromStat(before), real: await realpath(absolute) };
}

async function revalidateControlledRoot(snapshot) {
  const after = await lstat(snapshot.absolute, { bigint: true }).catch((error) => fail("ARTIFACT_PACK_ROOT_DRIFT", error.message));
  const afterReal = await realpath(snapshot.absolute).catch((error) => fail("ARTIFACT_PACK_ROOT_DRIFT", error.message));
  if (!after.isDirectory() || after.isSymbolicLink() || !sameIdentity(snapshot.identity, identityFromStat(after)) || snapshot.real !== afterReal) fail("ARTIFACT_PACK_ROOT_DRIFT", "controlled root drifted");
}

async function openStableRegularFile(filePath, maxBytes, code, label, options = {}) {
  const absolute = path.resolve(filePath);
  if (options.root !== undefined) assertNoSymlinkComponents(options.root, absolute, code, label);
  const beforePath = await lstat(absolute, { bigint: true }).catch((error) => fail(code, `${label} path could not be inspected: ${error.code ?? error.message}`));
  if (!beforePath.isFile() || beforePath.isSymbolicLink()) fail(code, `${label} must be a regular non-symlink file`);
  if (beforePath.nlink !== 1n) fail(code, `${label} must not be a hardlink alias`);
  if (beforePath.size < 1n || beforePath.size > BigInt(maxBytes)) fail(code, `${label} size is outside limit`);
  const handle = await open(absolute, "r").catch((error) => fail(code, `${label} could not be opened: ${error.code ?? error.message}`));
  let opened = true;
  try {
    const beforeHandle = await handle.stat({ bigint: true });
    if (!beforeHandle.isFile() || beforeHandle.isSymbolicLink() || beforeHandle.nlink !== 1n || !sameIdentity(identityFromStat(beforePath), identityFromStat(beforeHandle))) fail(code, `${label} path and handle identity mismatch`);
    return { absolute, handle, identity: identityFromStat(beforeHandle), size_bytes: Number(beforeHandle.size), close: async () => {
      if (opened) {
        opened = false;
        await handle.close();
      }
    } };
  } catch (error) {
    if (opened) await handle.close().catch(() => {});
    throw error;
  }
}

async function finishStableRegularFile(openedFile, code, label, options = {}) {
  try {
    const afterHandle = await openedFile.handle.stat({ bigint: true });
    if (!afterHandle.isFile() || afterHandle.isSymbolicLink() || afterHandle.nlink !== 1n || !sameIdentity(openedFile.identity, identityFromStat(afterHandle))) fail(code, `${label} handle identity drifted`);
    if (options.root !== undefined) assertNoSymlinkComponents(options.root, openedFile.absolute, code, label);
    const afterPath = await lstat(openedFile.absolute, { bigint: true }).catch((error) => fail(code, `${label} path postflight failed: ${error.code ?? error.message}`));
    if (!afterPath.isFile() || afterPath.isSymbolicLink() || afterPath.nlink !== 1n || !sameIdentity(openedFile.identity, identityFromStat(afterPath))) fail(code, `${label} path identity drifted`);
  } finally {
    await openedFile.close();
  }
}

async function hashStableRegularFile(filePath, expectedSizeBytes, maxBytes, code, label, options = {}) {
  const openedFile = await openStableRegularFile(filePath, maxBytes, code, label, options);
  try {
    if (openedFile.size_bytes !== expectedSizeBytes) fail(`${code}_DRIFT`, `${label} size drifted`);
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(Math.min(STREAM_CHUNK_BYTES, Math.max(1, expectedSizeBytes)));
    let offset = 0;
    while (offset < expectedSizeBytes) {
      const length = Math.min(chunk.length, expectedSizeBytes - offset);
      const { bytesRead } = await openedFile.handle.read(chunk, 0, length, offset);
      if (bytesRead <= 0) fail(`${code}_DRIFT`, `${label} ended before declared size`);
      hash.update(chunk.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const trailing = Buffer.allocUnsafe(1);
    const { bytesRead: trailingBytes } = await openedFile.handle.read(trailing, 0, 1, offset);
    if (trailingBytes !== 0) fail(`${code}_DRIFT`, `${label} exceeds declared size`);
    return { sha256: hash.digest("hex"), size_bytes: offset };
  } finally {
    await finishStableRegularFile(openedFile, code, label, options);
  }
}

async function readSmallStableRegularFile(filePath, maxBytes, code, label, options = {}) {
  const openedFile = await openStableRegularFile(filePath, maxBytes, code, label, options);
  try {
    const bytes = Buffer.alloc(openedFile.size_bytes);
    const { bytesRead } = await openedFile.handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== bytes.length) fail(`${code}_DRIFT`, `${label} ended before declared size`);
    const trailing = Buffer.allocUnsafe(1);
    const { bytesRead: trailingBytes } = await openedFile.handle.read(trailing, 0, 1, bytes.length);
    if (trailingBytes !== 0) fail(`${code}_DRIFT`, `${label} exceeds declared size`);
    return { sha256: sha256(bytes), size_bytes: bytes.length, bytes };
  } finally {
    await finishStableRegularFile(openedFile, code, label, options);
  }
}

async function readCanonicalJsonBytes(filePath, maxBytes, code, label, options = {}) {
  const file = await readSmallStableRegularFile(filePath, maxBytes, code, label, options);
  let text;
  try {
    text = UTF8_DECODER.decode(file.bytes);
  } catch (error) {
    fail(code, `${label} must be strict UTF-8: ${error.message}`);
  }
  if (!Buffer.from(text, "utf8").equals(file.bytes) || file.bytes.includes(0x00) || file.bytes.includes(0x0d) || !text.endsWith("\n")) fail(code, `${label} must be canonical UTF-8 JSON with LF`);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    fail(code, `${label} must parse as JSON: ${error.message}`);
  }
  if (encodeCanonicalJson(parsed) !== text) fail(code, `${label} must be canonical JSON`);
  return { ...file, text, parsed };
}

function assertTarget(value, code = "ARTIFACT_PACK_TARGET") {
  assertPlainObject(value, code, "target");
  assertAllowedKeys(value, new Set(["os", "arch", "cpython_version_family", "python_abi", "platform_tag", "accelerator_profile"]), code, "target");
  for (const [key, expected] of Object.entries(TARGET)) if (value[key] !== expected) fail(code, `target ${key} must match fixed contract`);
}

function assertSameTarget(left, right, code) {
  assertTarget(left, code);
  assertTarget(right, code);
  if (encodeCanonicalJson(left) !== encodeCanonicalJson(right)) fail(code, "target drift");
}

function uniquePathGuard(relativePath, seenPaths, seenCasefold, code) {
  const safe = validateRelativePath(relativePath, code, "artifact relative path");
  if (seenPaths.has(safe)) fail(code, "duplicate artifact path");
  const folded = safe.toLowerCase();
  if (seenCasefold.has(folded)) fail(code, "case-insensitive duplicate artifact path");
  seenPaths.add(safe);
  seenCasefold.add(folded);
  return safe;
}

async function validateArtifactEntry(entry, root, seenPaths, seenCasefold, budget, code, label, maxBytes = MAX_ARTIFACT_BYTES) {
  assertPlainObject(entry, code, label);
  assertAllowedKeys(entry, new Set(["relative_path", "sha256", "size_bytes"]), code, label);
  assertSha256(entry.sha256, code, `${label}.sha256`);
  if (!Number.isSafeInteger(entry.size_bytes) || entry.size_bytes < 1 || entry.size_bytes > maxBytes) fail(code, `${label}.size_bytes outside limit`);
  budget.total += entry.size_bytes;
  budget.count += 1;
  if (budget.total > MAX_TOTAL_ARTIFACT_BYTES) fail("ARTIFACT_PACK_TOTAL_SIZE", "artifact pack total target bytes exceed budget");
  const relativePath = uniquePathGuard(entry.relative_path, seenPaths, seenCasefold, code);
  const observed = await hashStableRegularFile(assertNoSymlinkComponents(root, ensureInside(root, relativePath, code, label), code, label), entry.size_bytes, maxBytes, code, label, { root });
  if (observed.sha256 !== entry.sha256 || observed.size_bytes !== entry.size_bytes) fail(`${code}_DRIFT`, `${label} bytes drifted`);
  return { ...observed, relative_path: relativePath };
}

async function validateSmallArtifactEntry(entry, root, seenPaths, seenCasefold, budget, code, label) {
  assertPlainObject(entry, code, label);
  assertAllowedKeys(entry, new Set(["relative_path", "sha256", "size_bytes"]), code, label);
  assertSha256(entry.sha256, code, `${label}.sha256`);
  if (!Number.isSafeInteger(entry.size_bytes) || entry.size_bytes < 1 || entry.size_bytes > MAX_SMALL_JSON_BYTES) fail(code, `${label}.size_bytes outside small JSON limit`);
  budget.total += entry.size_bytes;
  budget.count += 1;
  if (budget.total > MAX_TOTAL_ARTIFACT_BYTES) fail("ARTIFACT_PACK_TOTAL_SIZE", "artifact pack total target bytes exceed budget");
  const relativePath = uniquePathGuard(entry.relative_path, seenPaths, seenCasefold, code);
  const observed = await readSmallStableRegularFile(assertNoSymlinkComponents(root, ensureInside(root, relativePath, code, label), code, label), MAX_SMALL_JSON_BYTES, code, label, { root });
  if (observed.sha256 !== entry.sha256 || observed.size_bytes !== entry.size_bytes) fail(`${code}_DRIFT`, `${label} bytes drifted`);
  return { ...observed, relative_path: relativePath };
}

async function validateLicenseSet(set, root, lockDist, seenPaths, seenCasefold, budget) {
  assertPlainObject(set, "ARTIFACT_PACK_LICENSE", "license set");
  assertAllowedKeys(set, new Set(["distribution", "aggregate_sha256", "files"]), "ARTIFACT_PACK_LICENSE", "license set");
  if (normalizePackageName(set.distribution) !== normalizePackageName(lockDist.name)) fail("ARTIFACT_PACK_LICENSE_ORDER", "license set order or distribution mismatch");
  assertSha256(set.aggregate_sha256, "ARTIFACT_PACK_LICENSE", "license aggregate");
  if (!Array.isArray(set.files) || set.files.length < 1 || set.files.length > 8) fail("ARTIFACT_PACK_LICENSE", "license set files count outside limit");
  const files = [];
  for (const file of set.files) files.push(await validateArtifactEntry(file, root, seenPaths, seenCasefold, budget, "ARTIFACT_PACK_LICENSE", "license file"));
  const aggregate = sha256(Buffer.from(encodeCanonicalJson(files.map((file) => ({ sha256: file.sha256, size_bytes: file.size_bytes }))), "utf8"));
  if (aggregate !== set.aggregate_sha256 || aggregate !== lockDist.declared_license_files_aggregate_sha256) fail("ARTIFACT_PACK_LICENSE_AGGREGATE", "license aggregate mismatch");
  return { aggregate_sha256: aggregate, file_count: files.length, total_size_bytes: files.reduce((sum, file) => sum + file.size_bytes, 0) };
}

async function validateBuildRecord(recordEntry, root, lockDist, sourceEntry, seenPaths, seenCasefold, budget) {
  const file = await validateSmallArtifactEntry(recordEntry, root, seenPaths, seenCasefold, budget, "ARTIFACT_PACK_BUILD_RECORD", "build record");
  if (file.sha256 !== lockDist.built_wheel.declared_build_attestation_sha256) fail("ARTIFACT_PACK_BUILD_RECORD_HASH", "build record hash mismatch");
  let record;
  try {
    record = JSON.parse(file.bytes.toString("utf8"));
  } catch (error) {
    fail("ARTIFACT_PACK_BUILD_RECORD_JSON", `build record must parse: ${error.message}`);
  }
  if (encodeCanonicalJson(record) !== file.bytes.toString("utf8")) fail("ARTIFACT_PACK_BUILD_RECORD_CANONICAL", "build record must be canonical JSON");
  assertPlainObject(record, "ARTIFACT_PACK_BUILD_RECORD", "build record");
  assertAllowedKeys(record, new Set(["kind", "schema_version", "distribution", "version", "wheel_sha256", "source_archive_sha256", "target", "execution_status"]), "ARTIFACT_PACK_BUILD_RECORD", "build record");
  if (record.kind !== "meetingrelay-funasr-sidecar-build-record-v1" || record.schema_version !== "1.0" || record.execution_status !== "target-wheel-built-record-only") fail("ARTIFACT_PACK_BUILD_RECORD_SCHEMA", "bad build record identity");
  if (normalizePackageName(record.distribution) !== normalizePackageName(lockDist.name) || record.version !== lockDist.version) fail("ARTIFACT_PACK_BUILD_RECORD_IDENTITY", "build record package identity mismatch");
  if (record.wheel_sha256 !== lockDist.wheel.sha256 || record.source_archive_sha256 !== sourceEntry.sha256) fail("ARTIFACT_PACK_BUILD_RECORD_BINDING", "build record wheel/source binding mismatch");
  assertSameTarget(record.target, TARGET, "ARTIFACT_PACK_BUILD_RECORD_TARGET");
  return { sha256: file.sha256, size_bytes: file.size_bytes };
}

function validateManifestShape(manifest) {
  assertPlainObject(manifest, "ARTIFACT_PACK_MANIFEST_SCHEMA", "artifact pack manifest");
  assertAllowedKeys(manifest, new Set(["kind", "schema_version", "worker_role", "input_scope", "target", "package_lock_sha256", "candidate_aggregate_sha256", "artifacts"]), "ARTIFACT_PACK_MANIFEST_SCHEMA", "artifact pack manifest");
  if (manifest.kind !== "meetingrelay-funasr-sidecar-artifact-pack-v1" || manifest.schema_version !== "1.0" || manifest.worker_role !== "sidecar-candidate") fail("ARTIFACT_PACK_MANIFEST_SCHEMA", "bad artifact pack manifest identity");
  if (!["synthetic-artifact-pack-contract-only", "caller-supplied-controlled-artifacts-not-product-approved"].includes(manifest.input_scope)) fail("ARTIFACT_PACK_SCOPE", "unsupported input scope");
  assertTarget(manifest.target);
  assertSha256(manifest.package_lock_sha256, "ARTIFACT_PACK_MANIFEST_SCHEMA", "package_lock_sha256");
  assertSha256(manifest.candidate_aggregate_sha256, "ARTIFACT_PACK_MANIFEST_SCHEMA", "candidate_aggregate_sha256");
  assertPlainObject(manifest.artifacts, "ARTIFACT_PACK_MANIFEST_SCHEMA", "artifacts");
  assertAllowedKeys(manifest.artifacts, new Set(["license_sets", "source_archives", "build_records", "resolver_report", "expected_environment_report", "top_level_import_map"]), "ARTIFACT_PACK_MANIFEST_SCHEMA", "artifacts");
}

function declaredSize(entry, maxBytes, code, label) {
  assertPlainObject(entry, code, label);
  if (!Number.isSafeInteger(entry.size_bytes) || entry.size_bytes < 1 || entry.size_bytes > maxBytes) fail(code, `${label}.size_bytes outside limit`);
  return entry.size_bytes;
}

function validateDeclaredArtifactBudget(artifacts) {
  let total = 0;
  let count = 0;
  const add = (size) => {
    total += size;
    count += 1;
    if (total > MAX_TOTAL_ARTIFACT_BYTES) fail("ARTIFACT_PACK_TOTAL_SIZE", "artifact pack total target bytes exceed budget");
  };
  for (const set of artifacts.license_sets) {
    assertPlainObject(set, "ARTIFACT_PACK_LICENSE", "license set");
    if (!Array.isArray(set.files) || set.files.length < 1 || set.files.length > 8) fail("ARTIFACT_PACK_LICENSE", "license set files count outside limit");
    for (const file of set.files) add(declaredSize(file, MAX_ARTIFACT_BYTES, "ARTIFACT_PACK_LICENSE", "license file"));
  }
  for (const source of artifacts.source_archives) add(declaredSize(source, MAX_ARTIFACT_BYTES, "ARTIFACT_PACK_SOURCE", "source archive"));
  for (const record of artifacts.build_records) add(declaredSize(record, MAX_SMALL_JSON_BYTES, "ARTIFACT_PACK_BUILD_RECORD", "build record"));
  add(declaredSize(artifacts.resolver_report, MAX_SMALL_JSON_BYTES, "ARTIFACT_PACK_RESOLVER_REPORT", "resolver report"));
  add(declaredSize(artifacts.expected_environment_report, MAX_SMALL_JSON_BYTES, "ARTIFACT_PACK_ENVIRONMENT_REPORT", "expected environment report"));
  add(declaredSize(artifacts.top_level_import_map, MAX_SMALL_JSON_BYTES, "ARTIFACT_PACK_IMPORT_MAP", "top-level import map"));
  if (count !== 90) fail("ARTIFACT_PACK_ARTIFACT_COUNT", "exactly 90 target artifacts must be declared");
  return { count, total };
}

function validateLockInvariants(lock) {
  assertPlainObject(lock, "ARTIFACT_PACK_LOCK_SCHEMA", "package lock");
  assertAllowedKeys(lock, new Set(["kind", "schema_version", "worker_role", "target", "resolver_declaration", "materialization_policy", "root_requirements", "distributions", "expected_environment_report"]), "ARTIFACT_PACK_LOCK_SCHEMA", "package lock");
  if (lock.kind !== "meetingrelay-funasr-sidecar-package-lock-v1" || lock.schema_version !== "1.0" || lock.worker_role !== "sidecar-candidate") fail("ARTIFACT_PACK_LOCK_SCHEMA", "bad package lock identity");
  assertTarget(lock.target, "ARTIFACT_PACK_LOCK_TARGET");
  if (!Array.isArray(lock.root_requirements) || encodeCanonicalJson(lock.root_requirements) !== encodeCanonicalJson([...ROOT_REQUIREMENTS])) fail("ARTIFACT_PACK_LOCK_ROOTS", "root requirements drifted");
  if (!Array.isArray(lock.distributions) || lock.distributions.length !== 77) fail("ARTIFACT_PACK_LOCK_DISTRIBUTIONS", "distribution count must be 77");
  for (const distribution of lock.distributions) {
    assertPlainObject(distribution, "ARTIFACT_PACK_LOCK_DISTRIBUTION", "distribution");
    if (!distribution.wheel || typeof distribution.wheel !== "object") fail("ARTIFACT_PACK_LOCK_WHEEL", "distribution wheel missing");
  }
  const built = lock.distributions.filter((distribution) => distribution.built_wheel !== undefined);
  if (built.length !== 5 || built.map((item) => normalizePackageName(item.name)).join(",") !== BUILT_WHEEL_NAMES.join(",")) fail("ARTIFACT_PACK_BUILD_DECLARATIONS", "built wheel declarations drifted");
  return built;
}

export async function attestArtifactPack(controlledRoot, inputManifestPath, artifactPackManifestPath, expectedAggregateSha256) {
  assertSha256(expectedAggregateSha256, "ARTIFACT_PACK_AGGREGATE", "expected aggregate");
  const rootSnapshot = await snapshotControlledRoot(controlledRoot);
  const root = rootSnapshot.absolute;
  const preflight = await preflightCandidate(root, inputManifestPath);
  if (preflight.candidate_descriptor.aggregate_sha256 !== expectedAggregateSha256) fail("ARTIFACT_PACK_FOUR_B_DRIFT", "4b candidate aggregate mismatch");
  const fourEBefore = await attestPackageLock(root, inputManifestPath, expectedAggregateSha256);
  validatePackageLockEvidence(fourEBefore);
  const inputManifestFile = await readCanonicalJsonBytes(inputManifestPath, MAX_MANIFEST_BYTES, "ARTIFACT_PACK_INPUT_MANIFEST", "4b input manifest");
  if (inputManifestFile.sha256 !== preflight.canonical_input_manifest_sha256) fail("ARTIFACT_PACK_INPUT_MANIFEST_DRIFT", "input manifest drifted after 4b preflight");
  const manifestFile = await readCanonicalJsonBytes(resolveManifestPathInsideRoot(root, artifactPackManifestPath, "ARTIFACT_PACK_MANIFEST", "artifact pack manifest"), MAX_MANIFEST_BYTES, "ARTIFACT_PACK_MANIFEST", "artifact pack manifest", { root });
  validateManifestShape(manifestFile.parsed);
  const lockRole = preflight.roles.find((role) => role.role === "package-lock");
  if (!lockRole) fail("ARTIFACT_PACK_LOCK_BINDING", "4b package-lock role missing");
  if (manifestFile.parsed.package_lock_sha256 !== lockRole.sha256 || manifestFile.parsed.candidate_aggregate_sha256 !== expectedAggregateSha256) fail("ARTIFACT_PACK_MANIFEST_BINDING", "artifact pack manifest does not bind 4b/4e inputs");
  const inputManifest = inputManifestFile.parsed;
  if (!Array.isArray(inputManifest.files)) fail("ARTIFACT_PACK_INPUT_MANIFEST", "input manifest files missing");
  const packageLockRole = inputManifest.files.find((role) => role.role === "package-lock");
  if (!packageLockRole) fail("ARTIFACT_PACK_INPUT_MANIFEST", "input manifest package-lock role missing");
  const lockPath = ensureInside(root, packageLockRole.relative_path, "ARTIFACT_PACK_LOCK", "package lock");
  const lockFile = await readSmallStableRegularFile(assertNoSymlinkComponents(root, lockPath, "ARTIFACT_PACK_LOCK", "package lock"), MAX_MANIFEST_BYTES, "ARTIFACT_PACK_LOCK", "package lock", { root });
  if (lockFile.sha256 !== lockRole.sha256 || lockFile.sha256 !== packageLockRole.sha256 || lockFile.sha256 !== manifestFile.parsed.package_lock_sha256 || lockFile.sha256 !== fourEBefore.package_lock_role.sha256) fail("ARTIFACT_PACK_LOCK_BINDING", "package lock binding drifted");
  const lockEnvelope = readPackageLockFromCanonicalBytes(lockFile.bytes);
  const lock = lockEnvelope.parsed;
  const built = validateLockInvariants(lock);
  assertSameTarget(manifestFile.parsed.target, lock.target, "ARTIFACT_PACK_TARGET");

  const seenPaths = new Set();
  const seenCasefold = new Set();
  const budget = { count: 0, total: 0 };
  const artifacts = manifestFile.parsed.artifacts;
  if (!Array.isArray(artifacts.license_sets) || artifacts.license_sets.length !== 77) fail("ARTIFACT_PACK_LICENSE_COUNT", "license set count must be 77");
  if (!Array.isArray(artifacts.source_archives) || artifacts.source_archives.length !== 5) fail("ARTIFACT_PACK_SOURCE_COUNT", "source archive count must be five");
  if (!Array.isArray(artifacts.build_records) || artifacts.build_records.length !== 5) fail("ARTIFACT_PACK_BUILD_COUNT", "build record count must be five");
  validateDeclaredArtifactBudget(artifacts);
  const licenseSummaries = [];
  for (const [index, set] of artifacts.license_sets.entries()) licenseSummaries.push(await validateLicenseSet(set, root, lock.distributions[index], seenPaths, seenCasefold, budget));
  const sourceSummaries = [];
  for (const [index, entry] of artifacts.source_archives.entries()) {
    const lockDist = built[index];
    assertPlainObject(entry, "ARTIFACT_PACK_SOURCE", "source archive entry");
    assertAllowedKeys(entry, new Set(["distribution", "relative_path", "sha256", "size_bytes"]), "ARTIFACT_PACK_SOURCE", "source archive entry");
    if (normalizePackageName(entry.distribution) !== normalizePackageName(lockDist.name)) fail("ARTIFACT_PACK_SOURCE_ORDER", "source archive order mismatch");
    if (path.posix.basename(entry.relative_path) !== lockDist.built_wheel.source_archive.filename) fail("ARTIFACT_PACK_SOURCE_FILENAME", "source archive basename must match package-lock declaration");
    const observed = await validateArtifactEntry({ relative_path: entry.relative_path, sha256: entry.sha256, size_bytes: entry.size_bytes }, root, seenPaths, seenCasefold, budget, "ARTIFACT_PACK_SOURCE", "source archive");
    if (observed.sha256 !== lockDist.built_wheel.source_archive.declared_sha256 || observed.size_bytes !== lockDist.built_wheel.source_archive.declared_size_bytes) fail("ARTIFACT_PACK_SOURCE_BINDING", "source archive declaration mismatch");
    sourceSummaries.push(observed);
  }
  const buildSummaries = [];
  for (const [index, entry] of artifacts.build_records.entries()) {
    assertPlainObject(entry, "ARTIFACT_PACK_BUILD_RECORD", "build record entry");
    assertAllowedKeys(entry, new Set(["distribution", "relative_path", "sha256", "size_bytes"]), "ARTIFACT_PACK_BUILD_RECORD", "build record entry");
    if (normalizePackageName(entry.distribution) !== normalizePackageName(built[index].name)) fail("ARTIFACT_PACK_BUILD_RECORD_ORDER", "build record order mismatch");
    buildSummaries.push(await validateBuildRecord({ relative_path: entry.relative_path, sha256: entry.sha256, size_bytes: entry.size_bytes }, root, built[index], sourceSummaries[index], seenPaths, seenCasefold, budget));
  }
  const resolverReport = await validateArtifactEntry(artifacts.resolver_report, root, seenPaths, seenCasefold, budget, "ARTIFACT_PACK_RESOLVER_REPORT", "resolver report", MAX_SMALL_JSON_BYTES);
  if (resolverReport.sha256 !== lock.resolver_declaration.declared_report_sha256) fail("ARTIFACT_PACK_RESOLVER_REPORT_HASH", "resolver report hash mismatch");
  const expectedEnvironmentReport = await validateArtifactEntry(artifacts.expected_environment_report, root, seenPaths, seenCasefold, budget, "ARTIFACT_PACK_ENVIRONMENT_REPORT", "expected environment report", MAX_SMALL_JSON_BYTES);
  if (expectedEnvironmentReport.sha256 !== lock.expected_environment_report.expected_sha256) fail("ARTIFACT_PACK_ENVIRONMENT_REPORT_HASH", "expected environment report hash mismatch");
  const importMap = await validateArtifactEntry(artifacts.top_level_import_map, root, seenPaths, seenCasefold, budget, "ARTIFACT_PACK_IMPORT_MAP", "top-level import map", MAX_SMALL_JSON_BYTES);
  if (importMap.sha256 !== lock.expected_environment_report.expected_top_level_import_map_sha256) fail("ARTIFACT_PACK_IMPORT_MAP_HASH", "top-level import map hash mismatch");
  if (budget.count !== 90 || seenPaths.size !== 90) fail("ARTIFACT_PACK_ARTIFACT_COUNT", "exactly 90 target artifacts must be verified");
  await revalidateControlledRoot(rootSnapshot);
  const fourEAfter = await attestPackageLock(root, inputManifestPath, expectedAggregateSha256);
  if (encodeCanonicalJson(fourEBefore) !== encodeCanonicalJson(fourEAfter)) fail("ARTIFACT_PACK_FOUR_E_DRIFT", "4e evidence drifted across artifact-pack attestation");
  await revalidateControlledRoot(rootSnapshot);

  const schemaBytes = await readFile(PUBLIC_EVIDENCE_SCHEMA_PATH);
  JSON.parse(schemaBytes.toString("utf8"));
  const evidence = {
    kind: PUBLIC_EVIDENCE_KIND,
    schema_version: PUBLIC_EVIDENCE_SCHEMA_VERSION,
    schema_file_sha256: sha256(schemaBytes),
    attestor_source_sha256: sha256(await readFile(ATTESTOR_SOURCE_PATH)),
    four_e_before_evidence_sha256: sha256(Buffer.from(encodeCanonicalJson(fourEBefore), "utf8")),
    four_e_after_evidence_sha256: sha256(Buffer.from(encodeCanonicalJson(fourEAfter), "utf8")),
    candidate_aggregate_sha256: expectedAggregateSha256,
    package_lock_sha256: lockEnvelope.sha256,
    artifact_pack_manifest_sha256: manifestFile.sha256,
    measurement_status: "artifact-pack-target-byte-attestation-only",
    execution_status: "artifact-target-bytes-verified-no-install-no-import",
    packaging_authority: "artifact-pack-byte-identity-only",
    source_build_authority: "source-archive-and-build-record-target-bytes-bound-only",
    license_authority: "license-set-target-bytes-verified-not-legal-approval",
    resolver_report_authority: "target-record-bytes-bound-only",
    environment_report_authority: "expected-projection-target-bytes-bound-only",
    import_map_authority: "target-bytes-bound-no-import",
    package_metadata_authority: "none",
    environment_materialization_authority: "none",
    cpython_provenance_authority: "none",
    import_authority: "none",
    quality_gate_status: "not-assessed",
    formal_claims: "none",
    production_evidence: false,
    public_distribution: false,
    selection_authority: "none",
    worker_role: "sidecar-candidate",
    input_scope: manifestFile.parsed.input_scope,
    target: { ...TARGET },
    root_requirement_count: lock.root_requirements.length,
    distribution_count: lock.distributions.length,
    wheel_count: lock.distributions.length,
    license_set_count: licenseSummaries.length,
    license_file_count: licenseSummaries.reduce((sum, item) => sum + item.file_count, 0),
    source_archive_count: sourceSummaries.length,
    build_record_count: buildSummaries.length,
    resolver_report_count: 1,
    expected_environment_report_count: 1,
    top_level_import_map_count: 1,
    verified_artifact_count: seenPaths.size,
    license_set_aggregate_sha256: sha256(Buffer.from(encodeCanonicalJson(licenseSummaries), "utf8")),
    source_archive_set_sha256: sha256(Buffer.from(encodeCanonicalJson(sourceSummaries.map((item) => ({ sha256: item.sha256, size_bytes: item.size_bytes }))), "utf8")),
    build_record_set_sha256: sha256(Buffer.from(encodeCanonicalJson(buildSummaries), "utf8")),
    target_record_set_sha256: sha256(Buffer.from(encodeCanonicalJson([{ sha256: resolverReport.sha256, size_bytes: resolverReport.size_bytes }, { sha256: expectedEnvironmentReport.sha256, size_bytes: expectedEnvironmentReport.size_bytes }, { sha256: importMap.sha256, size_bytes: importMap.size_bytes }]), "utf8")),
    artifact_pack_set_sha256: sha256(Buffer.from(encodeCanonicalJson([...licenseSummaries, ...sourceSummaries.map((item) => ({ sha256: item.sha256, size_bytes: item.size_bytes })), ...buildSummaries, { sha256: resolverReport.sha256, size_bytes: resolverReport.size_bytes }, { sha256: expectedEnvironmentReport.sha256, size_bytes: expectedEnvironmentReport.size_bytes }, { sha256: importMap.sha256, size_bytes: importMap.size_bytes }]), "utf8")),
    limitations: [...LIMITATIONS],
  };
  validatePublicEvidence(evidence);
  return evidence;
}

function scanForbiddenPublicEvidence(value, pathSegments = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanForbiddenPublicEvidence(item, [...pathSegments, String(index)]));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (FORBIDDEN_PUBLIC_KEYS.has(key)) fail("ARTIFACT_PACK_EVIDENCE_FORBIDDEN", `forbidden public evidence key ${[...pathSegments, key].join(".")}`);
      scanForbiddenPublicEvidence(item, [...pathSegments, key]);
    }
    return;
  }
  if (typeof value === "string" && !ALLOWED_PUBLIC_STRINGS.has(value) && FORBIDDEN_PUBLIC_VALUE_RE.test(value)) fail("ARTIFACT_PACK_EVIDENCE_FORBIDDEN", `forbidden public evidence value at ${pathSegments.join(".")}`);
}

export function validatePublicEvidence(evidence) {
  assertPlainObject(evidence, "ARTIFACT_PACK_EVIDENCE_SCHEMA", "evidence");
  assertAllowedKeys(evidence, new Set(["kind", "schema_version", "schema_file_sha256", "attestor_source_sha256", "four_e_before_evidence_sha256", "four_e_after_evidence_sha256", "candidate_aggregate_sha256", "package_lock_sha256", "artifact_pack_manifest_sha256", "measurement_status", "execution_status", "packaging_authority", "source_build_authority", "license_authority", "resolver_report_authority", "environment_report_authority", "import_map_authority", "package_metadata_authority", "environment_materialization_authority", "cpython_provenance_authority", "import_authority", "quality_gate_status", "formal_claims", "production_evidence", "public_distribution", "selection_authority", "worker_role", "input_scope", "target", "root_requirement_count", "distribution_count", "wheel_count", "license_set_count", "license_file_count", "source_archive_count", "build_record_count", "resolver_report_count", "expected_environment_report_count", "top_level_import_map_count", "verified_artifact_count", "license_set_aggregate_sha256", "source_archive_set_sha256", "build_record_set_sha256", "target_record_set_sha256", "artifact_pack_set_sha256", "limitations"]), "ARTIFACT_PACK_EVIDENCE_SCHEMA", "evidence");
  if (evidence.kind !== PUBLIC_EVIDENCE_KIND || evidence.schema_version !== PUBLIC_EVIDENCE_SCHEMA_VERSION) fail("ARTIFACT_PACK_EVIDENCE_SCHEMA", "bad evidence identity");
  for (const key of ["schema_file_sha256", "attestor_source_sha256", "four_e_before_evidence_sha256", "four_e_after_evidence_sha256", "candidate_aggregate_sha256", "package_lock_sha256", "artifact_pack_manifest_sha256", "license_set_aggregate_sha256", "source_archive_set_sha256", "build_record_set_sha256", "target_record_set_sha256", "artifact_pack_set_sha256"]) assertSha256(evidence[key], "ARTIFACT_PACK_EVIDENCE_SCHEMA", key);
  if (evidence.schema_file_sha256 !== sha256(readFileSync(PUBLIC_EVIDENCE_SCHEMA_PATH)) || evidence.attestor_source_sha256 !== sha256(readFileSync(ATTESTOR_SOURCE_PATH))) fail("ARTIFACT_PACK_EVIDENCE_SCHEMA", "schema/source digest mismatch");
  if (evidence.measurement_status !== "artifact-pack-target-byte-attestation-only" || evidence.execution_status !== "artifact-target-bytes-verified-no-install-no-import" || evidence.packaging_authority !== "artifact-pack-byte-identity-only" || evidence.source_build_authority !== "source-archive-and-build-record-target-bytes-bound-only" || evidence.license_authority !== "license-set-target-bytes-verified-not-legal-approval" || evidence.resolver_report_authority !== "target-record-bytes-bound-only" || evidence.environment_report_authority !== "expected-projection-target-bytes-bound-only" || evidence.import_map_authority !== "target-bytes-bound-no-import" || evidence.package_metadata_authority !== "none" || evidence.environment_materialization_authority !== "none" || evidence.cpython_provenance_authority !== "none" || evidence.import_authority !== "none" || evidence.quality_gate_status !== "not-assessed" || evidence.formal_claims !== "none" || evidence.production_evidence !== false || evidence.public_distribution !== false || evidence.selection_authority !== "none" || evidence.worker_role !== "sidecar-candidate") fail("ARTIFACT_PACK_EVIDENCE_OVERCLAIM", "authority field overclaim");
  if (!["synthetic-artifact-pack-contract-only", "caller-supplied-controlled-artifacts-not-product-approved"].includes(evidence.input_scope)) fail("ARTIFACT_PACK_EVIDENCE_SCHEMA", "bad input scope");
  assertTarget(evidence.target, "ARTIFACT_PACK_EVIDENCE_SCHEMA");
  for (const [key, expected] of Object.entries({ root_requirement_count: 3, distribution_count: 77, wheel_count: 77, license_set_count: 77, source_archive_count: 5, build_record_count: 5, resolver_report_count: 1, expected_environment_report_count: 1, top_level_import_map_count: 1, verified_artifact_count: 90 })) {
    if (evidence[key] !== expected) fail("ARTIFACT_PACK_EVIDENCE_SCHEMA", `${key} mismatch`);
  }
  if (!Number.isSafeInteger(evidence.license_file_count) || evidence.license_file_count !== 77) fail("ARTIFACT_PACK_EVIDENCE_SCHEMA", "license file count mismatch");
  if (!Array.isArray(evidence.limitations) || encodeCanonicalJson(evidence.limitations) !== encodeCanonicalJson([...LIMITATIONS])) fail("ARTIFACT_PACK_EVIDENCE_SCHEMA", "limitations mismatch");
  scanForbiddenPublicEvidence(evidence);
  return evidence;
}

async function writeBytes(root, files, role, relativePath, bytes) {
  await mkdir(path.dirname(path.join(root, relativePath)), { recursive: true });
  await writeFile(path.join(root, relativePath), bytes);
  files.push({ role, logical_id: `artifact-pack-${role}`, relative_path: relativePath, sha256: sha256(bytes), size_bytes: bytes.length });
}

async function writeArtifact(root, relativePath, bytes) {
  await mkdir(path.dirname(path.join(root, relativePath)), { recursive: true });
  await writeFile(path.join(root, relativePath), bytes);
  return { relative_path: relativePath, sha256: sha256(bytes), size_bytes: bytes.length };
}

function syntheticDistributionNames() {
  const names = new Set(["funasr", "torch", "torchaudio", ...BUILT_WHEEL_NAMES]);
  for (let index = 0; names.size < 77; index += 1) names.add(`dep${String(index).padStart(3, "0")}`);
  return [...names].sort((a, b) => a.localeCompare(b));
}

function wheelFilename(name, version) {
  const platform = ["torch", "torchaudio"].includes(name) ? "cp312-cp312-win_amd64" : "py3-none-any";
  return `${name.replaceAll("-", "_")}-${version}-${platform}.whl`;
}

function packageVersion(name) {
  if (name === "funasr") return "1.3.22";
  if (name === "torch" || name === "torchaudio") return "2.6.0+cpu";
  return "1.0.0";
}

export async function createSyntheticArtifactPackFixture(options = {}) {
  assertPlainObject(options, "ARTIFACT_PACK_FIXTURE_OPTIONS", "fixture options");
  assertAllowedKeys(options, new Set(["afterCreate"]), "ARTIFACT_PACK_FIXTURE_OPTIONS", "fixture options");
  const root = await mkdtemp(path.join(os.tmpdir(), "meetingrelay-artifact-pack-"));
  let owned = true;
  try {
    const files = [];
    const artifactManifest = {
      kind: "meetingrelay-funasr-sidecar-artifact-pack-v1",
      schema_version: "1.0",
      worker_role: "sidecar-candidate",
      input_scope: "synthetic-artifact-pack-contract-only",
      target: { ...TARGET },
      package_lock_sha256: ZERO_SHA,
      candidate_aggregate_sha256: ZERO_SHA,
      artifacts: { license_sets: [], source_archives: [], build_records: [], resolver_report: undefined, expected_environment_report: undefined, top_level_import_map: undefined },
    };
    const names = syntheticDistributionNames();
    const wheelRows = [];
    for (const name of names) {
      const version = packageVersion(name);
      const filename = wheelFilename(name, version);
      const wheel = await writeArtifact(root, `wheelhouse/${filename}`, Buffer.from(`synthetic wheel bytes for ${name} ${version}\n`, "utf8"));
      wheelRows.push({ name, version, filename, wheel });
    }
    const importMapBytes = Buffer.from(encodeCanonicalJson({ kind: "meetingrelay-funasr-sidecar-top-level-import-map-v1", imports: [{ import_name: "funasr", distribution: "funasr" }] }), "utf8");
    artifactManifest.artifacts.top_level_import_map = await writeArtifact(root, "artifacts/import-map.json", importMapBytes);
    const expectedEnvBytes = Buffer.from(encodeCanonicalJson({ kind: "meetingrelay-funasr-sidecar-expected-environment-v1", distribution_count: 77, top_level_import_map_sha256: artifactManifest.artifacts.top_level_import_map.sha256 }), "utf8");
    artifactManifest.artifacts.expected_environment_report = await writeArtifact(root, "artifacts/expected-environment.json", expectedEnvBytes);
    const resolverBytes = Buffer.from(encodeCanonicalJson({ kind: "meetingrelay-funasr-sidecar-resolver-report-v1", tool: "pip", version: "25.0", distribution_count: 77 }), "utf8");
    artifactManifest.artifacts.resolver_report = await writeArtifact(root, "artifacts/resolver-report.json", resolverBytes);
    const distributions = [];
    for (const row of wheelRows) {
      const license = await writeArtifact(root, `artifacts/licenses/${row.name}/LICENSE.txt`, Buffer.from(`synthetic license bytes ${row.name}\n`, "utf8"));
      const licenseAggregate = sha256(Buffer.from(encodeCanonicalJson([{ sha256: license.sha256, size_bytes: license.size_bytes }]), "utf8"));
      artifactManifest.artifacts.license_sets.push({ distribution: row.name, aggregate_sha256: licenseAggregate, files: [license] });
      const deps = row.name === "funasr" ? names.filter((name) => name !== "funasr").map((name) => `${name}==${packageVersion(name)}`).sort() : [];
      const dist = {
        name: row.name,
        version: row.version,
        wheel: {
          filename: row.filename,
          relative_path: row.wheel.relative_path,
          sha256: row.wheel.sha256,
          size_bytes: row.wheel.size_bytes,
          declared_source_url: `https://files.pythonhosted.org/packages/${row.filename}`,
          tags: [row.filename.slice(0, -4).split("-").slice(-3).join("-")],
        },
        dependencies: deps,
        declared_top_level_imports: row.name === "funasr" ? ["funasr"] : [],
        declared_dist_info_metadata_sha256: sha256(`${row.name}-metadata\n`),
        declared_dist_info_record_sha256: sha256(`${row.name}-record\n`),
        declared_license_files_aggregate_sha256: licenseAggregate,
      };
      if (BUILT_WHEEL_NAMES.includes(row.name)) {
        const source = await writeArtifact(root, `artifacts/sources/${row.name}-${row.version}.tar.gz`, Buffer.from(`synthetic source archive ${row.name}\n`, "utf8"));
        artifactManifest.artifacts.source_archives.push({ distribution: row.name, ...source });
        dist.built_wheel = {
          source_archive: {
            filename: `${row.name}-${row.version}.tar.gz`,
            declared_source_url: `https://files.pythonhosted.org/packages/${row.name}-${row.version}.tar.gz`,
            declared_sha256: source.sha256,
            declared_size_bytes: source.size_bytes,
          },
          declared_build_attestation_sha256: ZERO_SHA,
        };
        const record = {
          kind: "meetingrelay-funasr-sidecar-build-record-v1",
          schema_version: "1.0",
          distribution: row.name,
          version: row.version,
          wheel_sha256: row.wheel.sha256,
          source_archive_sha256: source.sha256,
          target: { ...TARGET },
          execution_status: "target-wheel-built-record-only",
        };
        const recordBytes = Buffer.from(encodeCanonicalJson(record), "utf8");
        const recordArtifact = await writeArtifact(root, `artifacts/build-records/${row.name}.json`, recordBytes);
        dist.built_wheel.declared_build_attestation_sha256 = recordArtifact.sha256;
        artifactManifest.artifacts.build_records.push({ distribution: row.name, ...recordArtifact });
      }
      distributions.push(dist);
    }
    const lock = {
      kind: "meetingrelay-funasr-sidecar-package-lock-v1",
      schema_version: "1.0",
      worker_role: "sidecar-candidate",
      target: { ...TARGET },
      resolver_declaration: { tool: "pip", version: "25.0", declared_report_sha256: artifactManifest.artifacts.resolver_report.sha256 },
      materialization_policy: { wheelhouse_scope: "local-controlled-root-only", network: "disabled", index_access: "disabled", package_forms: ["wheel"], require_hashes: true, install_no_deps: true, allow_sdist: false, allow_editable: false, allow_vcs: false, allow_user_site: false, allow_global_site: false, allow_direct_url: false },
      root_requirements: [...ROOT_REQUIREMENTS],
      distributions,
      expected_environment_report: { report_kind: "pip-inspect-v1", expected_sha256: artifactManifest.artifacts.expected_environment_report.sha256, expected_distribution_count: 77, expected_top_level_import_map_sha256: artifactManifest.artifacts.top_level_import_map.sha256, verification_status: "not-materialized-not-verified" },
    };
    const lockBytes = Buffer.from(encodeCanonicalJson(lock), "utf8");
    await writeBytes(root, files, "package-lock", "inputs/package-lock.json", lockBytes);
    for (const role of REQUIRED_ROLES) {
      if (role === "package-lock") continue;
      await writeBytes(root, files, role, `inputs/${role}.bin`, Buffer.from(`synthetic ${role}\n`, "utf8"));
    }
    files.sort((a, b) => REQUIRED_ROLES.indexOf(a.role) - REQUIRED_ROLES.indexOf(b.role));
    const inputManifestBytes = Buffer.from(encodeCanonicalJson({
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
    }), "utf8");
    await writeFile(path.join(root, "input-manifest.json"), inputManifestBytes);
    const preflight = await preflightCandidate(root, path.join(root, "input-manifest.json"));
    artifactManifest.package_lock_sha256 = sha256(lockBytes);
    artifactManifest.candidate_aggregate_sha256 = preflight.candidate_descriptor.aggregate_sha256;
    const artifactManifestBytes = Buffer.from(encodeCanonicalJson(artifactManifest), "utf8");
    await writeFile(path.join(root, "artifact-pack-manifest.json"), artifactManifestBytes);
    const fixture = { root, manifestPath: path.join(root, "input-manifest.json"), artifactPackManifestPath: path.join(root, "artifact-pack-manifest.json"), aggregate: preflight.candidate_descriptor.aggregate_sha256, lock, artifactManifest };
    if (typeof options.afterCreate === "function") await options.afterCreate(fixture);
    owned = false;
    return fixture;
  } finally {
    if (owned) await rm(root, { recursive: true, force: true });
  }
}

async function runSyntheticValidation() {
  const fixture = await createSyntheticArtifactPackFixture();
  try {
    return await attestArtifactPack(fixture.root, fixture.manifestPath, fixture.artifactPackManifestPath, fixture.aggregate);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length === 1 && argv[0] === "--run-synthetic") {
    const evidence = await runSyntheticValidation();
    const text = encodeCanonicalJson(evidence);
    process.stdout.write(`funasr-sidecar-artifact-pack-attestation=verified evidence_sha256=${sha256(Buffer.from(text, "utf8"))} candidate_aggregate_sha256=${evidence.candidate_aggregate_sha256} package_lock_sha256=${evidence.package_lock_sha256} artifact_pack_manifest_sha256=${evidence.artifact_pack_manifest_sha256} distributions=77 wheels=77 root_requirements=3 license_sets=77 source_archives=5 build_records=5 verified_artifacts=90 measurement_status=${evidence.measurement_status} execution_status=${evidence.execution_status} packaging_authority=${evidence.packaging_authority} source_build_authority=${evidence.source_build_authority} license_authority=${evidence.license_authority} resolver_report_authority=${evidence.resolver_report_authority} environment_report_authority=${evidence.environment_report_authority} import_map_authority=${evidence.import_map_authority} package_metadata_authority=none environment_materialization_authority=none cpython_provenance_authority=none import_authority=none quality_gate_status=not-assessed formal_claims=none production_evidence=false public_distribution=false selection_authority=none fixture_scope=synthetic-artifact-pack-contract-only\n`);
    return;
  }
  if (argv.length === 5 && argv[0] === "--attest") {
    const evidence = await attestArtifactPack(argv[1], argv[2], argv[3], argv[4]);
    process.stdout.write(`${encodeCanonicalJson(evidence)}`);
    return;
  }
  if (argv.length === 2 && argv[0] === "--validate-json") {
    const evidence = (await readCanonicalJsonBytes(argv[1], MAX_PUBLIC_EVIDENCE_BYTES, "ARTIFACT_PACK_EVIDENCE_FILE", "public evidence")).parsed;
    validatePublicEvidence(evidence);
    process.stdout.write(`funasr-sidecar-artifact-pack-attestation-json=verified evidence_sha256=${sha256(Buffer.from(encodeCanonicalJson(evidence), "utf8"))}\n`);
    return;
  }
  fail("ARTIFACT_PACK_USAGE", "usage: artifact pack attestor expects --run-synthetic, --attest <controlled-root> <input-manifest> <artifact-pack-manifest> <aggregate>, or --validate-json <canonical-evidence-file>");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
