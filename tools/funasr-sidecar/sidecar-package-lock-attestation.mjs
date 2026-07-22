#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { TextDecoder } from "node:util";

import { encodeCanonicalJson } from "../phase0-harness/canonical-json.mjs";
import {
  PUBLIC_EVIDENCE_SCHEMA_PATH as PREFLIGHT_SCHEMA_PATH,
  VALIDATOR_SOURCE_PATH as PREFLIGHT_SOURCE_PATH,
  REQUIRED_ROLES,
  preflightCandidate,
  sha256Hex,
} from "./sidecar-candidate-preflight.mjs";

export const PUBLIC_EVIDENCE_KIND = "meetingrelay-funasr-sidecar-package-lock-attestation-v1";
export const PUBLIC_EVIDENCE_SCHEMA_VERSION = "1.0";
export const PUBLIC_EVIDENCE_SCHEMA_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "sidecar-package-lock-attestation.schema.json",
);
export const ATTESTOR_SOURCE_PATH = fileURLToPath(import.meta.url);
export const MAX_PACKAGE_LOCK_BYTES = 4 * 1024 * 1024;
export const MAX_WHEEL_BYTES = 8 * 1024 * 1024 * 1024;
const STREAM_CHUNK_BYTES = 1024 * 1024;

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const SHA256_RE = /^[0-9a-f]{64}$/u;
const NAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/u;
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+!-]{0,127}$/u;
const PIN_RE = /^([A-Za-z0-9][A-Za-z0-9._-]{0,126})==([A-Za-z0-9][A-Za-z0-9._+!-]{0,127})$/u;
const ZERO_SHA = "0".repeat(64);
const PIP_NAME = "pip";
const FUN_NAME = "funasr";
const T_NAME = "torch";
const TA_NAME = "torchaudio";
const EXECUTION_STATUS = "lock-contract-and-wheel-byte-identity-only-no-install-no-import";
const WHEEL_SOURCE_HOSTS = new Set(["download.pytorch.org", "files.pythonhosted.org"]);
const SOURCE_ARCHIVE_HOSTS = new Set(["files.pythonhosted.org"]);
const LIMITATIONS = Object.freeze([
  "package-lock-attestation-only: canonical lock bytes, dependency closure, target, resolver declaration, policy, and referenced wheel byte size and hash are validated under the controlled root",
  "metadata, RECORD, license, top-level import, resolver report, and expected environment report values are lock declarations only; their target bytes are not opened or verified",
  "lock-contract-only: no environment materialization, package execution, model load, audio handling, network access, quality ranking, default choice, or public distribution authority is claimed",
  "built-wheel declarations bind source archive and build-attestation digests only; source archive and build evidence bytes are not opened and no source-build authority is claimed",
  "public evidence intentionally omits filesystem paths, artifact filenames, URLs, requirement text, dependency names, environment values, timings, host identity, and plaintext",
]);
const ALLOWED_PUBLIC_STRINGS = new Set([
  PUBLIC_EVIDENCE_KIND,
  PUBLIC_EVIDENCE_SCHEMA_VERSION,
  "meetingrelay-funasr-sidecar-package-lock-v1",
  "package-lock-attestation-only",
  EXECUTION_STATUS,
  "four-b-package-lock-role-byte-match-only",
  "controlled-root-referenced-wheel-byte-match-only",
  "lock-fields-bound-only-target-bytes-unverified",
  "lock-contract-only",
  "none",
  "not-assessed",
  "sidecar-candidate",
  "windows",
  "amd64",
  "3.12.x",
  "cp312",
  "win_amd64",
  "cpu-baseline",
  "cuda",
  "package-lock",
  "not-materialized-not-verified",
]);
const FORBIDDEN_PUBLIC_KEYS = new Set([
  "absolute_path",
  "artifact",
  "content",
  "dependency",
  "direct_url",
  "environment",
  "file_path",
  "filename",
  "lock_text",
  "package",
  "path",
  "requirement",
  "root",
  "source",
  "text",
  "url",
  "wheel_url",
]);
const FORBIDDEN_PUBLIC_VALUE_RE = /(?:[A-Za-z]:\\|\\\\|\/tmp\/|\/home\/|\/Users\/|wheelhouse\/|inputs\/|https?:\/\/|file:\/\/|funasr-|torch-|funasr==|torch==|torchaudio==|direct_url|site-packages)/iu;

export class PackageLockAttestationError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "PackageLockAttestationError";
    this.code = code;
  }
}

export function readPackageLockFromCanonicalBytes(bytes) {
  return assertCanonicalLockBytes(bytes);
}

export function normalizePackageName(name) {
  return normalizeName(name);
}

function fail(code, message) {
  throw new PackageLockAttestationError(code, message);
}

function assertPlainObject(value, code, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(code, `${label} must be an object`);
}

function assertAllowedKeys(value, allowed, code, label) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(code, `${label} has unknown field ${key}`);
}

function assertSha256(value, code, label) {
  if (typeof value !== "string" || !SHA256_RE.test(value) || value === ZERO_SHA) fail(code, `${label} must be non-zero lowercase sha256 hex`);
}

function assertPositiveSize(value, code, label, max = MAX_WHEEL_BYTES) {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) fail(code, `${label} size must be a safe positive integer within limit`);
}

function normalizeName(name) {
  if (typeof name !== "string" || !NAME_RE.test(name) || name !== name.normalize("NFC")) fail("PACKAGE_LOCK_NAME", "distribution name must be a bounded normalized package token");
  return name.toLowerCase().replaceAll(/[-_.]+/gu, "-");
}

function parsePin(pin, code, label) {
  if (typeof pin !== "string" || pin.includes("[") || pin.includes("]")) fail(code, `${label} must be an exact pin without extras`);
  const match = pin.match(PIN_RE);
  if (!match) fail(code, `${label} must be an exact name==version pin`);
  return { name: normalizeName(match[1]), rawName: match[1], version: match[2] };
}

function assertCanonicalLockBytes(bytes) {
  if (bytes.length === 0 || bytes.length > MAX_PACKAGE_LOCK_BYTES) fail("PACKAGE_LOCK_SIZE", "package lock size is outside bounded limit");
  if (bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) fail("PACKAGE_LOCK_BOM", "package lock must not start with a UTF-8 BOM");
  if (bytes.includes(0x00)) fail("PACKAGE_LOCK_NUL", "package lock must not include NUL");
  if (bytes.includes(0x0d)) fail("PACKAGE_LOCK_CR_LF", "package lock must be LF-only");
  let text;
  try {
    text = UTF8_DECODER.decode(bytes);
  } catch (error) {
    fail("PACKAGE_LOCK_UTF8", `package lock must be strict UTF-8: ${error.message}`);
  }
  if (!Buffer.from(text, "utf8").equals(bytes)) fail("PACKAGE_LOCK_UTF8", "package lock bytes must round-trip");
  if (text !== text.normalize("NFC")) fail("PACKAGE_LOCK_NFC", "package lock must be NFC-normalized");
  if (!text.endsWith("\n") || text.endsWith("\n\n")) fail("PACKAGE_LOCK_TERMINAL_LF", "package lock must have exactly one terminal LF");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    fail("PACKAGE_LOCK_JSON", `package lock must parse as JSON: ${error.message}`);
  }
  if (encodeCanonicalJson(parsed) !== text) fail("PACKAGE_LOCK_CANONICAL", "package lock must be canonical JSON");
  return { text, parsed, sha256: sha256Hex(bytes), size_bytes: bytes.length };
}

function rejectUnsafeLocalPath(inputPath, code, label, options = {}) {
  if (typeof inputPath !== "string" || inputPath.length === 0) fail(code, `${label} must be a non-empty path`);
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
    (options.absolute === true && !path.isAbsolute(inputPath))
  ) {
    fail(code, `${label} must not use UNC, device, drive-relative, ADS, or escaped local syntax`);
  }
  return path.resolve(inputPath);
}

function validateSafeRelativePath(relativePath, code, label) {
  if (typeof relativePath !== "string" || relativePath.length === 0 || relativePath.length > 240) fail(code, `${label} must be a bounded relative path`);
  if (relativePath !== relativePath.normalize("NFC")) fail(code, `${label} must be NFC-normalized`);
  if (
    relativePath.includes("\\") ||
    relativePath.includes(":") ||
    relativePath.includes("\0") ||
    relativePath.startsWith("/") ||
    path.posix.isAbsolute(relativePath) ||
    path.win32.isAbsolute(relativePath)
  ) {
    fail(code, `${label} must not be absolute, UNC, drive, ADS, or backslash syntax`);
  }
  for (const segment of relativePath.split("/")) {
    if (segment === "" || segment === "." || segment === ".." || segment.endsWith(" ") || segment.endsWith(".")) fail(code, `${label} contains traversal or unsafe segment`);
  }
  return relativePath;
}

function resolveInsideRoot(controlledRoot, relativePath, code, label) {
  validateSafeRelativePath(relativePath, code, label);
  const root = path.resolve(controlledRoot);
  const absolute = path.resolve(root, ...relativePath.split("/"));
  const rootPrefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  const comparableAbsolute = process.platform === "win32" ? absolute.toLowerCase() : absolute;
  const comparableRootPrefix = process.platform === "win32" ? rootPrefix.toLowerCase() : rootPrefix;
  if (absolute !== root && !comparableAbsolute.startsWith(comparableRootPrefix)) fail(code, `${label} escaped controlled root`);
  return absolute;
}

function identityFromStat(value) {
  return {
    birthtimeNs: value.birthtimeNs,
    ctimeNs: value.ctimeNs,
    dev: value.dev,
    ino: value.ino,
    mode: value.mode,
    mtimeNs: value.mtimeNs,
    nlink: value.nlink,
    size: value.size,
  };
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.birthtimeNs === right.birthtimeNs && left.ctimeNs === right.ctimeNs && left.mode === right.mode && left.mtimeNs === right.mtimeNs && left.nlink === right.nlink && left.size === right.size;
}

async function assertPathChainHasNoLinks(absolutePath) {
  const resolved = path.resolve(absolutePath);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  const relative = path.relative(parsed.root, resolved);
  for (const segment of relative === "" ? [] : relative.split(path.sep)) {
    current = path.join(current, segment);
    const link = await lstat(current, { bigint: true }).catch((error) => fail("PACKAGE_LOCK_FILE_OPEN", error.message));
    if (link.isSymbolicLink() || (!link.isFile() && !link.isDirectory())) fail("PACKAGE_LOCK_SPECIAL_FILE", "path chain must not contain symlinks, reparse points, or special files");
  }
}

async function openStableRegularFile(filePath, maxBytes, code, label, { requireSingleLink = false } = {}) {
  const absolute = rejectUnsafeLocalPath(filePath, code, label);
  await assertPathChainHasNoLinks(absolute);
  const before = await lstat(absolute, { bigint: true }).catch((error) => fail(code, error.message));
  if (!before.isFile() || before.isSymbolicLink()) fail("PACKAGE_LOCK_SPECIAL_FILE", `${label} must be a regular non-symlink file`);
  const handle = await open(absolute, "r").catch((error) => fail(code, error.message));
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile()) fail("PACKAGE_LOCK_SPECIAL_FILE", `${label} must be a regular file`);
    if (requireSingleLink && opened.nlink !== 1n) fail("PACKAGE_LOCK_HARDLINK", `${label} must not be a hardlink alias`);
    const openedSize = Number(opened.size);
    if (!Number.isSafeInteger(openedSize) || openedSize < 1 || openedSize > maxBytes) fail(code, `${label} size outside bounded limit`);
    if (!sameFileIdentity(identityFromStat(before), identityFromStat(opened))) fail("PACKAGE_LOCK_FILE_DRIFT", `${label} identity drifted before read`);
    return { absolute, handle, opened, openedSize };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function finishStableRegularFile({ absolute, handle, opened }, code, label) {
  try {
    const afterHandle = await handle.stat({ bigint: true });
    const afterPath = await lstat(absolute, { bigint: true });
    if (!afterPath.isFile() || afterPath.isSymbolicLink()) fail("PACKAGE_LOCK_SPECIAL_FILE", `${label} path changed to link or special file`);
    if (!sameFileIdentity(identityFromStat(opened), identityFromStat(afterHandle)) || !sameFileIdentity(identityFromStat(opened), identityFromStat(afterPath))) fail("PACKAGE_LOCK_FILE_DRIFT", `${label} identity drifted during read`);
    await assertPathChainHasNoLinks(absolute);
  } finally {
    await handle.close();
  }
}

async function readRegularBytes(filePath, maxBytes, code, label, options = {}) {
  const openedFile = await openStableRegularFile(filePath, maxBytes, code, label, options);
  try {
    const bytes = await openedFile.handle.readFile();
    if (bytes.length !== openedFile.openedSize) fail("PACKAGE_LOCK_FILE_DRIFT", `${label} byte count drifted during read`);
    return bytes;
  } finally {
    await finishStableRegularFile(openedFile, code, label);
  }
}

async function hashRegularFile(filePath, expectedSize, code, label) {
  const openedFile = await openStableRegularFile(filePath, MAX_WHEEL_BYTES, code, label, { requireSingleLink: true });
  try {
    if (openedFile.openedSize !== expectedSize) fail("PACKAGE_LOCK_WHEEL_HASH_DRIFT", `${label} size drifted from package lock`);
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(STREAM_CHUNK_BYTES);
    let offset = 0;
    while (offset < expectedSize) {
      const length = Math.min(chunk.length, expectedSize - offset);
      const { bytesRead } = await openedFile.handle.read(chunk, 0, length, offset);
      if (bytesRead <= 0) fail("PACKAGE_LOCK_FILE_DRIFT", `${label} ended before its declared size`);
      hash.update(chunk.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const trailing = Buffer.allocUnsafe(1);
    const { bytesRead: trailingBytes } = await openedFile.handle.read(trailing, 0, 1, offset);
    if (trailingBytes !== 0) fail("PACKAGE_LOCK_FILE_DRIFT", `${label} exceeds its declared size`);
    return { sha256: hash.digest("hex"), size_bytes: offset };
  } finally {
    await finishStableRegularFile(openedFile, code, label);
  }
}

async function snapshotControlledRoot(root) {
  const absolute = rejectUnsafeLocalPath(root, "PACKAGE_LOCK_ROOT", "controlled root", { absolute: true });
  const before = await lstat(absolute, { bigint: true }).catch((error) => fail("PACKAGE_LOCK_ROOT", error.message));
  if (!before.isDirectory() || before.isSymbolicLink()) fail("PACKAGE_LOCK_ROOT", "controlled root must be a directory");
  return { absolute, identity: identityFromStat(before), real: await realpath(absolute) };
}

async function revalidateControlledRoot(snapshot) {
  const after = await lstat(snapshot.absolute, { bigint: true }).catch((error) => fail("PACKAGE_LOCK_ROOT_DRIFT", error.message));
  const afterReal = await realpath(snapshot.absolute).catch((error) => fail("PACKAGE_LOCK_ROOT_DRIFT", error.message));
  if (!after.isDirectory() || after.isSymbolicLink() || !sameFileIdentity(snapshot.identity, identityFromStat(after)) || snapshot.real !== afterReal) fail("PACKAGE_LOCK_ROOT_DRIFT", "controlled root drifted");
}

function findManifestRole(manifest, role) {
  const entries = Array.isArray(manifest) ? manifest : manifest.files;
  const entry = entries?.find((candidate) => candidate.role === role);
  if (!entry) fail("PACKAGE_LOCK_MANIFEST", `${role} role missing`);
  return entry;
}

function assertTarget(target) {
  assertPlainObject(target, "PACKAGE_LOCK_TARGET", "target");
  assertAllowedKeys(target, new Set(["os", "arch", "cpython_version_family", "python_abi", "platform_tag", "accelerator_profile"]), "PACKAGE_LOCK_TARGET", "target");
  if (target.os !== "windows") fail("PACKAGE_LOCK_TARGET", "target os must be windows");
  if (target.arch !== "amd64") fail("PACKAGE_LOCK_TARGET", "target arch must be amd64");
  if (target.cpython_version_family !== "3.12.x" || target.python_abi !== "cp312") fail("PACKAGE_LOCK_CPYTHON", "target must bind cp312");
  if (target.platform_tag !== "win_amd64") fail("PACKAGE_LOCK_TARGET_PLATFORM", "target platform must be win_amd64");
  if (!["cpu-baseline", "cuda"].includes(target.accelerator_profile)) fail("PACKAGE_LOCK_ACCELERATOR", "unsupported accelerator profile");
}

function assertResolver(resolver) {
  assertPlainObject(resolver, "PACKAGE_LOCK_RESOLVER", "resolver");
  assertAllowedKeys(resolver, new Set(["tool", "version", "declared_report_sha256"]), "PACKAGE_LOCK_RESOLVER", "resolver");
  if (resolver.tool !== PIP_NAME) fail("PACKAGE_LOCK_RESOLVER", "resolver tool must be expected tool");
  if (typeof resolver.version !== "string" || !VERSION_RE.test(resolver.version)) fail("PACKAGE_LOCK_RESOLVER", "resolver version must be bounded");
  assertSha256(resolver.declared_report_sha256, "PACKAGE_LOCK_REPORT_DIGEST", "resolver report sha256");
  return { tool: resolver.tool, version: resolver.version, report_sha256: resolver.declared_report_sha256 };
}

function assertPolicy(policy) {
  assertPlainObject(policy, "PACKAGE_LOCK_POLICY", "materialization_policy");
  assertAllowedKeys(policy, new Set(["wheelhouse_scope", "network", "index_access", "package_forms", "require_hashes", "install_no_deps", "allow_sdist", "allow_editable", "allow_vcs", "allow_user_site", "allow_global_site", "allow_direct_url"]), "PACKAGE_LOCK_POLICY", "materialization_policy");
  if (policy.wheelhouse_scope !== "local-controlled-root-only") fail("PACKAGE_LOCK_POLICY", "wheelhouse scope must stay local");
  if (policy.network !== "disabled") fail("PACKAGE_LOCK_NETWORK_POLICY", "network must be disabled");
  if (policy.index_access !== "disabled") fail("PACKAGE_LOCK_INDEX_POLICY", "index access must be disabled");
  if (!Array.isArray(policy.package_forms) || policy.package_forms.length !== 1 || policy.package_forms[0] !== "wheel") fail("PACKAGE_LOCK_WHEEL_POLICY", "only wheel form may be allowed");
  if (policy.require_hashes !== true) fail("PACKAGE_LOCK_HASH_POLICY", "hash policy must be required");
  if (policy.install_no_deps !== true) fail("PACKAGE_LOCK_NO_DEPS_POLICY", "dependency resolver side effects must be disabled");
  if (policy.allow_sdist !== false) fail("PACKAGE_LOCK_SDIST_POLICY", "sdist must be forbidden");
  if (policy.allow_editable !== false) fail("PACKAGE_LOCK_EDITABLE_POLICY", "editable form must be forbidden");
  if (policy.allow_vcs !== false) fail("PACKAGE_LOCK_VCS_POLICY", "vcs form must be forbidden");
  if (policy.allow_user_site !== false) fail("PACKAGE_LOCK_USER_POLICY", "user scope must be forbidden");
  if (policy.allow_global_site !== false) fail("PACKAGE_LOCK_GLOBAL_POLICY", "global scope must be forbidden");
  if (policy.allow_direct_url !== false) fail("PACKAGE_LOCK_DIRECT_URL_POLICY", "direct-url form must be forbidden");
}

function assertSecureArtifactUrl(urlText, filename, allowedHosts, code, label) {
  if (typeof urlText !== "string" || urlText.length > 2048 || urlText !== urlText.normalize("NFC")) fail(code, `${label} URL must be bounded`);
  let parsed;
  try {
    parsed = new URL(urlText);
  } catch {
    fail(code, `${label} URL must parse`);
  }
  if (parsed.protocol !== "https:") fail(`${code}_PATH`, `${label} URL must use secure non-local scheme`);
  if (parsed.username !== "" || parsed.password !== "" || parsed.search !== "" || parsed.hash !== "") fail(code, `${label} URL must not include credentials, query, or fragment`);
  if (!allowedHosts.has(parsed.hostname.toLowerCase())) fail(`${code}_HOST`, `${label} URL host is not an accepted artifact origin`);
  if (/^git\+/iu.test(urlText)) fail(`${code}_VCS`, `${label} URL must not use VCS syntax`);
  let urlBasename;
  try {
    urlBasename = decodeURIComponent(path.posix.basename(parsed.pathname));
  } catch {
    fail(code, `${label} URL pathname must use valid percent encoding`);
  }
  if (urlBasename !== filename) fail(code, `${label} URL basename must match the declared filename`);
  return parsed;
}

function parseWheelFilename(filename) {
  if (typeof filename !== "string" || filename.length === 0 || filename.length > 240 || filename !== filename.normalize("NFC")) fail("PACKAGE_LOCK_WHEEL", "wheel filename must be bounded");
  if (filename.startsWith("-e")) fail("PACKAGE_LOCK_WHEEL_EDITABLE", "editable wheel reference is forbidden");
  if (/\.tar\.gz$/iu.test(filename) || /\.zip$/iu.test(filename)) fail("PACKAGE_LOCK_WHEEL_SDIST", "sdist filename is forbidden");
  if (!filename.endsWith(".whl")) fail("PACKAGE_LOCK_WHEEL", "artifact must be a wheel");
  if (filename.includes("/") || filename.includes("\\") || filename.includes(":") || filename.includes("\0")) fail("PACKAGE_LOCK_WHEEL_PATH", "wheel filename must not contain path syntax");
  const parts = filename.slice(0, -4).split("-");
  if (parts.length < 5 || parts.length > 6) fail("PACKAGE_LOCK_WHEEL", "wheel filename must contain distribution, version, optional build, and tag triplet");
  return {
    distribution: normalizeName(parts[0]),
    version: parts[1],
    tag: parts.slice(-3).join("-"),
    pythonTag: parts.at(-3),
    abiTag: parts.at(-2),
    platformTag: parts.at(-1),
  };
}

function assertSourceArchiveFilename(filename) {
  if (typeof filename !== "string" || filename.length === 0 || filename.length > 240 || filename !== filename.normalize("NFC")) fail("PACKAGE_LOCK_BUILD_SOURCE_ARCHIVE", "source archive filename must be bounded and NFC-normalized");
  if (!filename.endsWith(".tar.gz")) fail("PACKAGE_LOCK_BUILD_SOURCE_ARCHIVE", "source archive filename must be tar.gz");
  if (filename.includes("/") || filename.includes("\\") || filename.includes(":") || filename.includes("\0") || filename === "." || filename === "..") fail("PACKAGE_LOCK_BUILD_SOURCE_ARCHIVE_PATH", "source archive filename must be a plain basename without path or ADS syntax");
}

function assertWheelTag(wheel, parsedFilename, target) {
  if (!Array.isArray(wheel.tags) || wheel.tags.length < 1 || wheel.tags.length > 16) fail("PACKAGE_LOCK_TAG", "wheel tags must be bounded");
  for (const tag of wheel.tags) if (typeof tag !== "string" || tag.length > 80 || tag !== tag.normalize("NFC")) fail("PACKAGE_LOCK_TAG", "wheel tag must be bounded");
  if (wheel.tags.length !== 1 || wheel.tags[0] !== parsedFilename.tag) fail("PACKAGE_LOCK_TAG_FILENAME", "declared wheel tag must exactly match the filename tag triplet");
  const pythonTags = parsedFilename.pythonTag.split(".");
  const universalPython = pythonTags.some((tag) => tag === "py3" || tag === "py2.py3");
  const exactCpython = pythonTags.includes(target.python_abi);
  const abi3Compatible = parsedFilename.abiTag === "abi3" && pythonTags.some((tag) => {
    const match = /^cp3(\d{1,2})$/u.exec(tag);
    return match !== null && Number(match[1]) <= 12;
  });
  if (parsedFilename.platformTag === "any") {
    if (!universalPython || parsedFilename.abiTag !== "none") fail("PACKAGE_LOCK_TAG_PLATFORM", "platform-independent wheel tag is incompatible with target");
    return;
  }
  if (parsedFilename.platformTag !== target.platform_tag) fail("PACKAGE_LOCK_TAG_PLATFORM", "wheel tag platform is incompatible with target");
  if (!((exactCpython && parsedFilename.abiTag === target.python_abi) || abi3Compatible)) fail("PACKAGE_LOCK_TAG_ABI", "wheel tag ABI is incompatible with target");
}

function validateDistributionShape(distribution) {
  assertPlainObject(distribution, "PACKAGE_LOCK_DISTRIBUTION", "distribution");
  assertAllowedKeys(distribution, new Set(["name", "version", "wheel", "dependencies", "declared_top_level_imports", "declared_dist_info_metadata_sha256", "declared_dist_info_record_sha256", "declared_license_files_aggregate_sha256", "built_wheel"]), "PACKAGE_LOCK_DISTRIBUTION", "distribution");
  const normalized = normalizeName(distribution.name);
  if (typeof distribution.version !== "string" || !VERSION_RE.test(distribution.version) || distribution.version !== distribution.version.normalize("NFC")) fail("PACKAGE_LOCK_DISTRIBUTION", "distribution version must be bounded");
  assertPlainObject(distribution.wheel, "PACKAGE_LOCK_WHEEL", "wheel");
  assertAllowedKeys(distribution.wheel, new Set(["filename", "relative_path", "sha256", "size_bytes", "declared_source_url", "tags"]), "PACKAGE_LOCK_WHEEL", "wheel");
  const parsedFilename = parseWheelFilename(distribution.wheel.filename);
  if (parsedFilename.distribution !== normalized || parsedFilename.version !== distribution.version) fail("PACKAGE_LOCK_WHEEL_IDENTITY", "wheel filename distribution and version must match the lock row");
  validateSafeRelativePath(distribution.wheel.relative_path, "PACKAGE_LOCK_WHEEL_PATH", "wheel relative path");
  if (path.basename(distribution.wheel.relative_path) !== distribution.wheel.filename) fail("PACKAGE_LOCK_WHEEL_PATH", "wheel filename must match relative path basename");
  assertSha256(distribution.wheel.sha256, "PACKAGE_LOCK_WHEEL_DIGEST", "wheel.sha256");
  assertPositiveSize(distribution.wheel.size_bytes, "PACKAGE_LOCK_WHEEL_SIZE", "wheel.size_bytes");
  assertSecureArtifactUrl(distribution.wheel.declared_source_url, distribution.wheel.filename, WHEEL_SOURCE_HOSTS, "PACKAGE_LOCK_URL", "wheel");
  assertSha256(distribution.declared_dist_info_metadata_sha256, "PACKAGE_LOCK_METADATA_DIGEST", "declared metadata sha256");
  assertSha256(distribution.declared_dist_info_record_sha256, "PACKAGE_LOCK_RECORD_DIGEST", "declared record sha256");
  assertSha256(distribution.declared_license_files_aggregate_sha256, "PACKAGE_LOCK_LICENSE_DIGEST", "declared license sha256");
  if (!Array.isArray(distribution.dependencies) || distribution.dependencies.length > 128) fail("PACKAGE_LOCK_DEPEND", "dependencies must be bounded");
  const dependencies = distribution.dependencies.map((dependency) => parsePin(dependency, "PACKAGE_LOCK_DEPEND_EXTRA", "dependency"));
  const sortedDependencies = [...distribution.dependencies].sort();
  if (JSON.stringify(sortedDependencies) !== JSON.stringify(distribution.dependencies)) fail("PACKAGE_LOCK_DEPEND_SORT", "dependencies must be sorted");
  const declaredImports = distribution.declared_top_level_imports;
  if (!Array.isArray(declaredImports) || declaredImports.length > 8) fail("PACKAGE_LOCK_IMPORT", "top-level imports must be bounded");
  for (const item of declaredImports) if (typeof item !== "string" || !NAME_RE.test(item) || item !== item.normalize("NFC")) fail("PACKAGE_LOCK_IMPORT", "top-level import must be a safe token");
  if (distribution.built_wheel !== undefined) validateBuiltWheel(distribution.built_wheel);
  return { normalized, dependencies, declaredImports, parsedFilename };
}

function validateBuiltWheel(value) {
  assertPlainObject(value, "PACKAGE_LOCK_BUILD", "built_wheel");
  assertAllowedKeys(value, new Set(["source_archive", "declared_build_attestation_sha256"]), "PACKAGE_LOCK_BUILD", "built_wheel");
  assertPlainObject(value.source_archive, "PACKAGE_LOCK_BUILD_SOURCE_ARCHIVE", "source_archive");
  assertAllowedKeys(value.source_archive, new Set(["filename", "declared_source_url", "declared_sha256", "declared_size_bytes"]), "PACKAGE_LOCK_BUILD_SOURCE_ARCHIVE", "source_archive");
  assertSourceArchiveFilename(value.source_archive.filename);
  assertSecureArtifactUrl(value.source_archive.declared_source_url, value.source_archive.filename, SOURCE_ARCHIVE_HOSTS, "PACKAGE_LOCK_BUILD_SOURCE_ARCHIVE_URL", "source archive");
  assertSha256(value.source_archive.declared_sha256, "PACKAGE_LOCK_BUILD_DIGEST", "source_archive.declared_sha256");
  assertPositiveSize(value.source_archive.declared_size_bytes, "PACKAGE_LOCK_BUILD_SOURCE_ARCHIVE_SIZE", "source_archive.declared_size_bytes", 1024 * 1024 * 1024);
  assertSha256(value.declared_build_attestation_sha256, "PACKAGE_LOCK_BUILD_ATTESTATION_DIGEST", "declared_build_attestation_sha256");
}

function validateRootRequirements(rootRequirements) {
  if (!Array.isArray(rootRequirements) || rootRequirements.length < 1 || rootRequirements.length > 128) fail("PACKAGE_LOCK_ROOT_COUNT_LIMIT", "root requirements count outside limit");
  if (JSON.stringify([...rootRequirements].sort()) !== JSON.stringify(rootRequirements)) fail("PACKAGE_LOCK_ROOT_SORT", "root requirements must be sorted");
  const seen = new Set();
  const roots = new Map();
  for (const item of rootRequirements) {
    const parsed = parsePin(item, "PACKAGE_LOCK_ROOT_PIN", "root requirement");
    if (seen.has(parsed.name)) fail("PACKAGE_LOCK_ROOT_DUPLICATE", "duplicate root requirement");
    seen.add(parsed.name);
    roots.set(parsed.name, parsed.version);
  }
  if (roots.size !== 3) fail("PACKAGE_LOCK_ROOT_COUNT", "root requirements must contain exactly the three integration roots");
  if (!roots.has(FUN_NAME)) fail("PACKAGE_LOCK_ROOT_FUNASR", "root requirements must include FunASR");
  if (!roots.has(T_NAME)) fail("PACKAGE_LOCK_ROOT_TENSOR", "root requirements must include base tensor package");
  if (!roots.has(TA_NAME)) fail("PACKAGE_LOCK_ROOT_AUDIO_TENSOR", "root requirements must include audio tensor package");
  if (roots.get(T_NAME) !== roots.get(TA_NAME)) fail("PACKAGE_LOCK_TENSOR_AUDIO_MISMATCH", "tensor package versions must match");
  return roots;
}

function validateDistributions(lock, roots) {
  if (!Array.isArray(lock.distributions) || lock.distributions.length < 1 || lock.distributions.length > 512) fail("PACKAGE_LOCK_DISTRIBUTION_COUNT_LIMIT", "distribution count outside limit");
  const byName = new Map();
  const filenames = new Set();
  let previous = "";
  let builtCount = 0;
  let importMapCount = 0;
  const graph = new Map();
  const declaredImportsByName = new Map();
  for (const item of lock.distributions) {
    const filenameKey = typeof item?.wheel?.filename === "string" ? item.wheel.filename.toLowerCase() : undefined;
    if (filenameKey !== undefined && filenames.has(filenameKey)) fail("PACKAGE_LOCK_DUPLICATE_FILENAME", "duplicate wheel filename");
    const validated = validateDistributionShape(item);
    if (validated.normalized.localeCompare(previous) < 0) fail("PACKAGE_LOCK_DISTRIBUTION_SORT", "distributions must be sorted by normalized name");
    previous = validated.normalized;
    if (byName.has(validated.normalized)) fail("PACKAGE_LOCK_DUPLICATE_DISTRIBUTION", "duplicate normalized distribution");
    byName.set(validated.normalized, item);
    filenames.add(filenameKey);
    assertWheelTag(item.wheel, validated.parsedFilename, lock.target);
    if (item.built_wheel !== undefined) builtCount += 1;
    if (validated.declaredImports.length > 0) importMapCount += validated.declaredImports.length;
    declaredImportsByName.set(validated.normalized, validated.declaredImports);
    graph.set(validated.normalized, validated.dependencies);
  }
  for (const [name, version] of roots) {
    const dist = byName.get(name);
    if (!dist || dist.version !== version) fail("PACKAGE_LOCK_MISSING_DEPEND", `missing root distribution ${name}`);
  }
  const funDeps = new Set(graph.get(FUN_NAME)?.map((item) => `${item.name}==${item.version}`) ?? []);
  if (!funDeps.has(`${T_NAME}==${roots.get(T_NAME)}`) || !funDeps.has(`${TA_NAME}==${roots.get(TA_NAME)}`)) fail("PACKAGE_LOCK_DEPEND_AUDIO_TENSOR", "FunASR dependency edges must include matching tensor packages");
  const importOwners = new Map();
  for (const item of lock.distributions) {
    const owner = normalizeName(item.name);
    for (const entry of declaredImportsByName.get(owner)) {
      const key = entry.toLowerCase();
      if (importOwners.has(key)) fail("PACKAGE_LOCK_IMPORT_CONFLICT", "top-level import is claimed by multiple distributions");
      importOwners.set(key, owner);
    }
  }
  const funImports = declaredImportsByName.get(FUN_NAME);
  if (!Array.isArray(funImports) || funImports.length !== 1 || funImports[0] !== FUN_NAME) fail("PACKAGE_LOCK_IMPORT_FUNASR", "FunASR distribution must expose only its import");
  for (const [key, owner] of importOwners) if (key !== FUN_NAME || owner !== FUN_NAME) fail("PACKAGE_LOCK_IMPORT_EXTRA", "unexpected top-level import mapping");
  const reachable = new Set();
  const stack = [...roots.keys()];
  while (stack.length > 0) {
    const current = stack.pop();
    if (reachable.has(current)) continue;
    reachable.add(current);
    if (!byName.has(current)) fail("PACKAGE_LOCK_MISSING_DEPEND", `missing dependency distribution ${current}`);
    for (const dependency of graph.get(current) ?? []) {
      const dist = byName.get(dependency.name);
      if (!dist) fail("PACKAGE_LOCK_MISSING_DEPEND", `missing dependency distribution ${dependency.name}`);
      if (dist.version !== dependency.version) fail("PACKAGE_LOCK_DEPEND_VERSION", "dependency version drift");
      stack.push(dependency.name);
    }
  }
  for (const name of byName.keys()) if (!reachable.has(name)) fail("PACKAGE_LOCK_UNREACHABLE_EXTRA", "unreachable extra distribution");
  return { builtCount, importMapCount };
}

function validateExpectedEnvironmentReport(report, distributionCount, importMapCount) {
  assertPlainObject(report, "PACKAGE_LOCK_EXPECTED_REPORT", "expected_environment_report");
  assertAllowedKeys(report, new Set(["report_kind", "expected_sha256", "expected_distribution_count", "expected_top_level_import_map_sha256", "verification_status"]), "PACKAGE_LOCK_EXPECTED_REPORT", "expected_environment_report");
  const reportKind = report.report_kind;
  const reportSha256 = report.expected_sha256;
  const reportDistributionCount = report.expected_distribution_count;
  const reportImportMapSha256 = report.expected_top_level_import_map_sha256;
  if (reportKind !== "pip-inspect-v1") fail("PACKAGE_LOCK_EXPECTED_REPORT", "expected report kind must be v1");
  if (report.verification_status !== "not-materialized-not-verified") fail("PACKAGE_LOCK_EXPECTED_REPORT_VERIFICATION", "expected report must remain unverified declaration");
  assertSha256(reportSha256, "PACKAGE_LOCK_EXPECTED_REPORT_DIGEST", "expected report sha256");
  assertSha256(reportImportMapSha256, "PACKAGE_LOCK_EXPECTED_REPORT_DIGEST", "expected top-level import map sha256");
  if (!Number.isSafeInteger(reportDistributionCount) || reportDistributionCount !== distributionCount || importMapCount < 1) fail("PACKAGE_LOCK_EXPECTED_REPORT", "expected report declaration count drift");
  return {
    report_kind: reportKind,
    expected_sha256: reportSha256,
    expected_distribution_count: reportDistributionCount,
    expected_top_level_import_map_sha256: reportImportMapSha256,
    verification_status: "not-materialized-not-verified",
  };
}

function validatePackageLock(lock) {
  assertPlainObject(lock, "PACKAGE_LOCK_SCHEMA", "package lock");
  assertAllowedKeys(lock, new Set(["kind", "schema_version", "worker_role", "target", "resolver_declaration", "materialization_policy", "root_requirements", "distributions", "expected_environment_report"]), "PACKAGE_LOCK_SCHEMA", "package lock");
  if (lock.kind !== "meetingrelay-funasr-sidecar-package-lock-v1" || lock.schema_version !== "1.0" || lock.worker_role !== "sidecar-candidate") fail("PACKAGE_LOCK_SCHEMA", "bad package lock kind, schema version, or worker role");
  assertTarget(lock.target);
  const resolver = assertResolver(lock.resolver_declaration);
  assertPolicy(lock.materialization_policy);
  const roots = validateRootRequirements(lock.root_requirements);
  const { builtCount, importMapCount } = validateDistributions(lock, roots);
  const normalizedExpectedReport = validateExpectedEnvironmentReport(lock.expected_environment_report, lock.distributions.length, importMapCount);
  return { builtCount, importMapCount, resolver, expectedReport: normalizedExpectedReport };
}

async function verifyWheelBytes(controlledRoot, distributions) {
  const verified = [];
  for (const distribution of distributions) {
    const absolute = resolveInsideRoot(controlledRoot, distribution.wheel.relative_path, "PACKAGE_LOCK_WHEEL_PATH", "wheel relative path");
    const observed = await hashRegularFile(absolute, distribution.wheel.size_bytes, "PACKAGE_LOCK_WHEEL_FILE", "wheel");
    if (observed.sha256 !== distribution.wheel.sha256) fail("PACKAGE_LOCK_WHEEL_HASH_DRIFT", "wheel bytes drifted from package lock");
    verified.push({ sha256: observed.sha256, size_bytes: observed.size_bytes, tags: distribution.wheel.tags });
  }
  return verified;
}

export async function attestPackageLock(controlledRoot, inputManifestPath, expectedAggregateSha256) {
  assertSha256(expectedAggregateSha256, "PACKAGE_LOCK_AGGREGATE", "expected aggregate");
  const rootSnapshot = await snapshotControlledRoot(controlledRoot);
  const root = rootSnapshot.absolute;
  const preflight = await preflightCandidate(root, inputManifestPath);
  if (preflight.candidate_descriptor.aggregate_sha256 !== expectedAggregateSha256) fail("PACKAGE_LOCK_AGGREGATE", "4b candidate aggregate mismatch");
  const packageLockRole = findManifestRole(preflight.roles, "package-lock");
  const manifestBytes = await readRegularBytes(inputManifestPath, 64 * 1024, "PACKAGE_LOCK_MANIFEST", "input manifest");
  if (sha256Hex(manifestBytes) !== preflight.canonical_input_manifest_sha256) fail("PACKAGE_LOCK_MANIFEST_DRIFT", "input manifest drifted after 4b preflight");
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const manifestRole = findManifestRole(manifest, "package-lock");
  const lockPath = resolveInsideRoot(root, manifestRole.relative_path, "PACKAGE_LOCK_PATH", "package-lock relative path");
  const lockBytes = await readRegularBytes(lockPath, MAX_PACKAGE_LOCK_BYTES, "PACKAGE_LOCK_FILE", "package-lock");
  const lockEnvelope = assertCanonicalLockBytes(lockBytes);
  if (lockEnvelope.sha256 !== manifestRole.sha256 || lockEnvelope.size_bytes !== manifestRole.size_bytes || lockEnvelope.sha256 !== packageLockRole.sha256 || lockEnvelope.size_bytes !== packageLockRole.size_bytes) fail("PACKAGE_LOCK_HASH_DRIFT", "package-lock bytes drifted from manifest or 4b role");
  const { builtCount, importMapCount, resolver, expectedReport } = validatePackageLock(lockEnvelope.parsed);
  const verifiedWheels = await verifyWheelBytes(root, lockEnvelope.parsed.distributions);
  await revalidateControlledRoot(rootSnapshot);
  const schemaBytes = await readFile(PUBLIC_EVIDENCE_SCHEMA_PATH);
  JSON.parse(schemaBytes.toString("utf8"));
  const attestorBytes = await readFile(ATTESTOR_SOURCE_PATH);
  const preflightEvidenceText = encodeCanonicalJson(preflight);
  const declaredDependencyGraphSha256 = sha256Hex(Buffer.from(encodeCanonicalJson(lockEnvelope.parsed.distributions.map((item) => ({ dependencies: item.dependencies, name: item.name, version: item.version }))), "utf8"));
  const declaredMetadataContractSha256 = sha256Hex(Buffer.from(encodeCanonicalJson(lockEnvelope.parsed.distributions.map((item) => ({
    name: item.name,
    version: item.version,
    metadata: item.declared_dist_info_metadata_sha256,
    record: item.declared_dist_info_record_sha256,
    license: item.declared_license_files_aggregate_sha256,
    imports: item.declared_top_level_imports,
  }))), "utf8"));
  const wheelArtifactSetSha256 = sha256Hex(Buffer.from(encodeCanonicalJson(verifiedWheels), "utf8"));
  const expectedReportDeclarationSha256 = sha256Hex(Buffer.from(encodeCanonicalJson(expectedReport), "utf8"));
  const wheelTotalSizeBytes = lockEnvelope.parsed.distributions.reduce((sum, item) => sum + item.wheel.size_bytes, 0);
  const evidence = {
    kind: PUBLIC_EVIDENCE_KIND,
    schema_version: PUBLIC_EVIDENCE_SCHEMA_VERSION,
    schema_file_sha256: sha256Hex(schemaBytes),
    attestor_source_sha256: sha256Hex(attestorBytes),
    preflight_schema_sha256: sha256Hex(readFileSync(PREFLIGHT_SCHEMA_PATH)),
    preflight_validator_source_sha256: sha256Hex(readFileSync(PREFLIGHT_SOURCE_PATH)),
    preflight_evidence_sha256: sha256Hex(Buffer.from(preflightEvidenceText, "utf8")),
    canonical_input_manifest_sha256: preflight.canonical_input_manifest_sha256,
    candidate_aggregate_sha256: preflight.candidate_descriptor.aggregate_sha256,
    measurement_status: "package-lock-attestation-only",
    execution_status: EXECUTION_STATUS,
    package_lock_binding_scope: "four-b-package-lock-role-byte-match-only",
    wheel_binding_scope: "controlled-root-referenced-wheel-byte-match-only",
    declaration_binding_scope: "lock-fields-bound-only-target-bytes-unverified",
    packaging_authority: "lock-contract-only",
    package_metadata_authority: "none",
    license_authority: "none",
    import_authority: "none",
    source_build_authority: "none",
    environment_materialization_authority: "none",
    cpython_provenance_authority: "none",
    quality_gate_status: "not-assessed",
    formal_claims: "none",
    production_evidence: false,
    public_distribution: false,
    selection_authority: "none",
    worker_role: "sidecar-candidate",
    lock_kind: lockEnvelope.parsed.kind,
    lock_schema_version: lockEnvelope.parsed.schema_version,
    target: {
      os: lockEnvelope.parsed.target.os,
      arch: lockEnvelope.parsed.target.arch,
      cpython_version_family: lockEnvelope.parsed.target.cpython_version_family,
      python_abi: lockEnvelope.parsed.target.python_abi,
      platform_tag: lockEnvelope.parsed.target.platform_tag,
      accelerator_profile: lockEnvelope.parsed.target.accelerator_profile,
    },
    resolver_declaration: {
      tool_sha256: sha256Hex(Buffer.from(resolver.tool, "utf8")),
      version_sha256: sha256Hex(Buffer.from(resolver.version, "utf8")),
      declared_report_sha256: resolver.report_sha256,
    },
    expected_environment_report: {
      verification_status: "not-materialized-not-verified",
      declared_report_sha256: expectedReport.expected_sha256,
      declared_distribution_count: expectedReport.expected_distribution_count,
      declared_top_level_import_map_sha256: expectedReport.expected_top_level_import_map_sha256,
    },
    package_lock_role: {
      role: "package-lock",
      logical_id_sha256: packageLockRole.logical_id_sha256,
      size_bytes: lockEnvelope.size_bytes,
      sha256: lockEnvelope.sha256,
      canonical_utf8_nfc_lf_terminal: true,
    },
    root_requirement_count: lockEnvelope.parsed.root_requirements.length,
    distribution_count: lockEnvelope.parsed.distributions.length,
    wheel_count: lockEnvelope.parsed.distributions.length,
    declared_top_level_import_map_count: importMapCount,
    wheel_total_size_bytes: wheelTotalSizeBytes,
    declared_dependency_graph_sha256: declaredDependencyGraphSha256,
    declared_metadata_contract_sha256: declaredMetadataContractSha256,
    wheel_artifact_set_sha256: wheelArtifactSetSha256,
    expected_environment_report_declaration_sha256: expectedReportDeclarationSha256,
    built_wheel_count: builtCount,
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
      if (FORBIDDEN_PUBLIC_KEYS.has(key)) fail("PACKAGE_LOCK_EVIDENCE_FORBIDDEN", `forbidden public evidence key ${[...pathSegments, key].join(".")}`);
      scanForbiddenPublicEvidence(item, [...pathSegments, key]);
    }
    return;
  }
  if (typeof value === "string" && !LIMITATIONS.includes(value) && !ALLOWED_PUBLIC_STRINGS.has(value) && FORBIDDEN_PUBLIC_VALUE_RE.test(value)) fail("PACKAGE_LOCK_EVIDENCE_FORBIDDEN", `forbidden public evidence value at ${pathSegments.join(".")}`);
}

export function validatePublicEvidence(evidence) {
  assertPlainObject(evidence, "PACKAGE_LOCK_EVIDENCE_SCHEMA", "evidence");
  assertAllowedKeys(evidence, new Set(["kind", "schema_version", "schema_file_sha256", "attestor_source_sha256", "preflight_schema_sha256", "preflight_validator_source_sha256", "preflight_evidence_sha256", "canonical_input_manifest_sha256", "candidate_aggregate_sha256", "measurement_status", "execution_status", "package_lock_binding_scope", "wheel_binding_scope", "declaration_binding_scope", "packaging_authority", "package_metadata_authority", "license_authority", "import_authority", "source_build_authority", "environment_materialization_authority", "cpython_provenance_authority", "quality_gate_status", "formal_claims", "production_evidence", "public_distribution", "selection_authority", "worker_role", "lock_kind", "lock_schema_version", "target", "resolver_declaration", "expected_environment_report", "package_lock_role", "root_requirement_count", "distribution_count", "wheel_count", "declared_top_level_import_map_count", "wheel_total_size_bytes", "declared_dependency_graph_sha256", "declared_metadata_contract_sha256", "wheel_artifact_set_sha256", "expected_environment_report_declaration_sha256", "built_wheel_count", "limitations"]), "PACKAGE_LOCK_EVIDENCE_SCHEMA", "evidence");
  if (evidence.kind !== PUBLIC_EVIDENCE_KIND || evidence.schema_version !== PUBLIC_EVIDENCE_SCHEMA_VERSION) fail("PACKAGE_LOCK_EVIDENCE_SCHEMA", "bad evidence kind or schema version");
  for (const key of ["schema_file_sha256", "attestor_source_sha256", "preflight_schema_sha256", "preflight_validator_source_sha256", "preflight_evidence_sha256", "canonical_input_manifest_sha256", "candidate_aggregate_sha256"]) assertSha256(evidence[key], "PACKAGE_LOCK_EVIDENCE_SCHEMA", key);
  if (evidence.schema_file_sha256 !== sha256Hex(readFileSync(PUBLIC_EVIDENCE_SCHEMA_PATH)) || evidence.attestor_source_sha256 !== sha256Hex(readFileSync(ATTESTOR_SOURCE_PATH)) || evidence.preflight_schema_sha256 !== sha256Hex(readFileSync(PREFLIGHT_SCHEMA_PATH)) || evidence.preflight_validator_source_sha256 !== sha256Hex(readFileSync(PREFLIGHT_SOURCE_PATH))) fail("PACKAGE_LOCK_EVIDENCE_SCHEMA", "source or schema digest mismatch");
  if (evidence.measurement_status !== "package-lock-attestation-only" || evidence.execution_status !== EXECUTION_STATUS || evidence.package_lock_binding_scope !== "four-b-package-lock-role-byte-match-only" || evidence.wheel_binding_scope !== "controlled-root-referenced-wheel-byte-match-only" || evidence.declaration_binding_scope !== "lock-fields-bound-only-target-bytes-unverified" || evidence.packaging_authority !== "lock-contract-only" || evidence.package_metadata_authority !== "none" || evidence.license_authority !== "none" || evidence.import_authority !== "none" || evidence.source_build_authority !== "none" || evidence.environment_materialization_authority !== "none" || evidence.cpython_provenance_authority !== "none" || evidence.quality_gate_status !== "not-assessed" || evidence.formal_claims !== "none" || evidence.production_evidence !== false || evidence.public_distribution !== false || evidence.selection_authority !== "none" || evidence.worker_role !== "sidecar-candidate") fail("PACKAGE_LOCK_EVIDENCE_OVERCLAIM", "evidence authority fields overclaim");
  if (evidence.lock_kind !== "meetingrelay-funasr-sidecar-package-lock-v1" || evidence.lock_schema_version !== "1.0") fail("PACKAGE_LOCK_EVIDENCE_SCHEMA", "lock identity mismatch");
  assertPlainObject(evidence.target, "PACKAGE_LOCK_EVIDENCE_SCHEMA", "target");
  assertAllowedKeys(evidence.target, new Set(["os", "arch", "cpython_version_family", "python_abi", "platform_tag", "accelerator_profile"]), "PACKAGE_LOCK_EVIDENCE_SCHEMA", "target");
  assertTarget(evidence.target);
  assertPlainObject(evidence.resolver_declaration, "PACKAGE_LOCK_EVIDENCE_SCHEMA", "resolver_declaration");
  assertAllowedKeys(evidence.resolver_declaration, new Set(["tool_sha256", "version_sha256", "declared_report_sha256"]), "PACKAGE_LOCK_EVIDENCE_SCHEMA", "resolver_declaration");
  assertSha256(evidence.resolver_declaration.tool_sha256, "PACKAGE_LOCK_EVIDENCE_SCHEMA", "resolver_declaration.tool_sha256");
  assertSha256(evidence.resolver_declaration.version_sha256, "PACKAGE_LOCK_EVIDENCE_SCHEMA", "resolver_declaration.version_sha256");
  assertSha256(evidence.resolver_declaration.declared_report_sha256, "PACKAGE_LOCK_EVIDENCE_SCHEMA", "resolver_declaration.declared_report_sha256");
  assertPlainObject(evidence.expected_environment_report, "PACKAGE_LOCK_EVIDENCE_SCHEMA", "expected_environment_report");
  assertAllowedKeys(evidence.expected_environment_report, new Set(["verification_status", "declared_report_sha256", "declared_distribution_count", "declared_top_level_import_map_sha256"]), "PACKAGE_LOCK_EVIDENCE_SCHEMA", "expected_environment_report");
  if (evidence.expected_environment_report.verification_status !== "not-materialized-not-verified") fail("PACKAGE_LOCK_EVIDENCE_OVERCLAIM", "expected environment report overclaims");
  assertSha256(evidence.expected_environment_report.declared_report_sha256, "PACKAGE_LOCK_EVIDENCE_SCHEMA", "expected_environment_report.declared_report_sha256");
  assertSha256(evidence.expected_environment_report.declared_top_level_import_map_sha256, "PACKAGE_LOCK_EVIDENCE_SCHEMA", "expected_environment_report.declared_top_level_import_map_sha256");
  if (!Number.isSafeInteger(evidence.expected_environment_report.declared_distribution_count) || evidence.expected_environment_report.declared_distribution_count < 1 || evidence.expected_environment_report.declared_distribution_count > 512) fail("PACKAGE_LOCK_EVIDENCE_SCHEMA", "expected environment distribution count must be bounded");
  assertPlainObject(evidence.package_lock_role, "PACKAGE_LOCK_EVIDENCE_SCHEMA", "package_lock_role");
  assertAllowedKeys(evidence.package_lock_role, new Set(["role", "logical_id_sha256", "size_bytes", "sha256", "canonical_utf8_nfc_lf_terminal"]), "PACKAGE_LOCK_EVIDENCE_SCHEMA", "package_lock_role");
  if (evidence.package_lock_role.role !== "package-lock" || evidence.package_lock_role.canonical_utf8_nfc_lf_terminal !== true) fail("PACKAGE_LOCK_EVIDENCE_SCHEMA", "package lock role mismatch");
  assertSha256(evidence.package_lock_role.logical_id_sha256, "PACKAGE_LOCK_EVIDENCE_SCHEMA", "package_lock_role.logical_id_sha256");
  assertSha256(evidence.package_lock_role.sha256, "PACKAGE_LOCK_EVIDENCE_SCHEMA", "package_lock_role.sha256");
  assertPositiveSize(evidence.package_lock_role.size_bytes, "PACKAGE_LOCK_EVIDENCE_SCHEMA", "package_lock_role.size_bytes", MAX_PACKAGE_LOCK_BYTES);
  for (const key of ["declared_dependency_graph_sha256", "declared_metadata_contract_sha256", "wheel_artifact_set_sha256", "expected_environment_report_declaration_sha256"]) assertSha256(evidence[key], "PACKAGE_LOCK_EVIDENCE_SCHEMA", key);
  for (const key of ["root_requirement_count", "distribution_count", "wheel_count", "declared_top_level_import_map_count", "built_wheel_count"]) if (!Number.isSafeInteger(evidence[key]) || evidence[key] < 0 || evidence[key] > 512) fail("PACKAGE_LOCK_EVIDENCE_SCHEMA", `${key} must be bounded count`);
  if (!Number.isSafeInteger(evidence.wheel_total_size_bytes) || evidence.wheel_total_size_bytes < 1 || evidence.wheel_total_size_bytes > MAX_WHEEL_BYTES * 512) fail("PACKAGE_LOCK_EVIDENCE_SCHEMA", "wheel total size must be bounded and positive");
  if (evidence.root_requirement_count !== 3 || evidence.distribution_count < 1 || evidence.wheel_count !== evidence.distribution_count || evidence.declared_top_level_import_map_count !== 1 || evidence.built_wheel_count > evidence.wheel_count) fail("PACKAGE_LOCK_EVIDENCE_SCHEMA", "count mismatch");
  if (evidence.expected_environment_report.declared_distribution_count !== evidence.distribution_count) fail("PACKAGE_LOCK_EVIDENCE_SCHEMA", "expected environment report count mismatch");
  if (!Array.isArray(evidence.limitations) || evidence.limitations.length !== LIMITATIONS.length) fail("PACKAGE_LOCK_EVIDENCE_SCHEMA", "limitations must be exact");
  for (const [index, limitation] of LIMITATIONS.entries()) if (evidence.limitations[index] !== limitation) fail("PACKAGE_LOCK_EVIDENCE_SCHEMA", "limitation mismatch");
  scanForbiddenPublicEvidence(evidence);
  return true;
}

async function writeSyntheticRole(root, files, role, relativePath, bytes) {
  const absolute = path.join(root, ...relativePath.split("/"));
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, bytes);
  files.push({ role, logical_id: `package-lock-${role}`, relative_path: relativePath, sha256: sha256Hex(bytes), size_bytes: bytes.length });
  return { relative_path: relativePath, sha256: sha256Hex(bytes), size_bytes: bytes.length };
}

function syntheticDistribution({ name, version, filename, relativePath, artifact, dependencies = [], topLevelImports = [] }) {
  const tag = filename.slice(0, -4).split("-").slice(-3).join("-");
  return {
    name,
    version,
    wheel: {
      filename,
      relative_path: relativePath,
      sha256: artifact.sha256,
      size_bytes: artifact.size_bytes,
      declared_source_url: `https://files.pythonhosted.org/packages/synthetic/${filename}`,
      tags: [tag],
    },
    dependencies,
    declared_top_level_imports: topLevelImports,
    declared_dist_info_metadata_sha256: sha256Hex(Buffer.from(`${name}-${version}-metadata\n`, "utf8")),
    declared_dist_info_record_sha256: sha256Hex(Buffer.from(`${name}-${version}-record\n`, "utf8")),
    declared_license_files_aggregate_sha256: sha256Hex(Buffer.from(`${name}-${version}-license\n`, "utf8")),
  };
}

async function runSyntheticValidation() {
  const tempRoot = path.resolve(process.env.TEMP || process.env.TMP || ".");
  const root = await mkdtemp(path.join(tempRoot, "meetingrelay-package-lock-attest-"));
  try {
    const files = [];
    const funArtifact = await writeSyntheticRole(root, [], "x", `wheelhouse/${FUN_NAME}-1.3.22-py3-none-any.whl`, Buffer.from(`synthetic wheel bytes for ${FUN_NAME}\n`, "utf8"));
    const tArtifact = await writeSyntheticRole(root, [], "x", `wheelhouse/${T_NAME}-2.6.0-cp312-cp312-win_amd64.whl`, Buffer.from(`synthetic wheel bytes for ${T_NAME}\n`, "utf8"));
    const taArtifact = await writeSyntheticRole(root, [], "x", `wheelhouse/${TA_NAME}-2.6.0-cp312-cp312-win_amd64.whl`, Buffer.from(`synthetic wheel bytes for ${TA_NAME}\n`, "utf8"));
    const reportSha = "b".repeat(64);
    const lock = {
      kind: "meetingrelay-funasr-sidecar-package-lock-v1",
      schema_version: "1.0",
      worker_role: "sidecar-candidate",
      target: { os: "windows", arch: "amd64", cpython_version_family: "3.12.x", python_abi: "cp312", platform_tag: "win_amd64", accelerator_profile: "cpu-baseline" },
      resolver_declaration: { tool: PIP_NAME, version: "25.1.1", declared_report_sha256: reportSha },
      materialization_policy: { wheelhouse_scope: "local-controlled-root-only", network: "disabled", index_access: "disabled", package_forms: ["wheel"], require_hashes: true, install_no_deps: true, allow_sdist: false, allow_editable: false, allow_vcs: false, allow_user_site: false, allow_global_site: false, allow_direct_url: false },
      root_requirements: [`${FUN_NAME}==1.3.22`, `${T_NAME}==2.6.0`, `${TA_NAME}==2.6.0`],
      distributions: [
        syntheticDistribution({ name: FUN_NAME, version: "1.3.22", filename: `${FUN_NAME}-1.3.22-py3-none-any.whl`, relativePath: funArtifact.relative_path, artifact: funArtifact, dependencies: [`${T_NAME}==2.6.0`, `${TA_NAME}==2.6.0`], topLevelImports: [FUN_NAME] }),
        syntheticDistribution({ name: T_NAME, version: "2.6.0", filename: `${T_NAME}-2.6.0-cp312-cp312-win_amd64.whl`, relativePath: tArtifact.relative_path, artifact: tArtifact }),
        syntheticDistribution({ name: TA_NAME, version: "2.6.0", filename: `${TA_NAME}-2.6.0-cp312-cp312-win_amd64.whl`, relativePath: taArtifact.relative_path, artifact: taArtifact, dependencies: [`${T_NAME}==2.6.0`] }),
      ],
      expected_environment_report: { report_kind: "pip-inspect-v1", expected_sha256: reportSha, expected_distribution_count: 3, expected_top_level_import_map_sha256: "c".repeat(64), verification_status: "not-materialized-not-verified" },
    };
    const lockBytes = Buffer.from(encodeCanonicalJson(lock), "utf8");
    await writeSyntheticRole(root, files, "package-lock", "inputs/package-lock.json", lockBytes);
    for (const role of REQUIRED_ROLES) {
      if (role === "package-lock") continue;
      await writeSyntheticRole(root, files, role, `inputs/${role}.bin`, Buffer.from(`synthetic ${role} bytes\n`, "utf8"));
    }
    files.sort((left, right) => left.role.localeCompare(right.role));
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
    const preflight = await preflightCandidate(root, manifestPath);
    return await attestPackageLock(root, manifestPath, preflight.candidate_descriptor.aggregate_sha256);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length === 1 && argv[0] === "--run-synthetic") {
    const evidence = await runSyntheticValidation();
    const evidenceText = encodeCanonicalJson(evidence);
    process.stdout.write(`funasr-sidecar-package-lock-attestation=verified evidence_sha256=${sha256Hex(Buffer.from(evidenceText, "utf8"))} candidate_aggregate_sha256=${evidence.candidate_aggregate_sha256} package_lock_sha256=${evidence.package_lock_role.sha256} distributions=${evidence.distribution_count} wheels=${evidence.wheel_count} root_requirements=${evidence.root_requirement_count} target=${evidence.target.os}-${evidence.target.arch}-${evidence.target.python_abi}-${evidence.target.platform_tag} accelerator_profile=${evidence.target.accelerator_profile} measurement_status=${evidence.measurement_status} execution_status=${evidence.execution_status} packaging_authority=${evidence.packaging_authority} source_build_authority=none environment_materialization_authority=none cpython_provenance_authority=none package_metadata_authority=none license_authority=none import_authority=none quality_gate_status=not-assessed formal_claims=none production_evidence=false public_distribution=false selection_authority=none fixture_scope=synthetic-lock-no-install-no-import\n`);
    return;
  }
  if (argv.length === 4 && argv[0] === "--attest") {
    const evidence = await attestPackageLock(argv[1], argv[2], argv[3]);
    const evidenceText = encodeCanonicalJson(evidence);
    process.stdout.write(`funasr-sidecar-package-lock-attestation=verified evidence_sha256=${sha256Hex(Buffer.from(evidenceText, "utf8"))} candidate_aggregate_sha256=${evidence.candidate_aggregate_sha256} package_lock_sha256=${evidence.package_lock_role.sha256} distributions=${evidence.distribution_count} wheels=${evidence.wheel_count} root_requirements=${evidence.root_requirement_count} target=${evidence.target.os}-${evidence.target.arch}-${evidence.target.python_abi}-${evidence.target.platform_tag} accelerator_profile=${evidence.target.accelerator_profile} measurement_status=${evidence.measurement_status} execution_status=${evidence.execution_status} packaging_authority=${evidence.packaging_authority} source_build_authority=none environment_materialization_authority=none cpython_provenance_authority=none package_metadata_authority=none license_authority=none import_authority=none quality_gate_status=not-assessed formal_claims=none production_evidence=false public_distribution=false selection_authority=none\n`);
    return;
  }
  if (argv.length === 2 && argv[0] === "--validate-json") {
    let evidence;
    try {
      evidence = JSON.parse(argv[1]);
    } catch (error) {
      fail("PACKAGE_LOCK_EVIDENCE_CANONICAL", `evidence must parse as JSON: ${error.message}`);
    }
    if (encodeCanonicalJson(evidence) !== argv[1]) fail("PACKAGE_LOCK_EVIDENCE_CANONICAL", "evidence must be canonical JSON");
    validatePublicEvidence(evidence);
    process.stdout.write(`funasr-sidecar-package-lock-attestation-json=verified evidence_sha256=${sha256Hex(Buffer.from(encodeCanonicalJson(evidence), "utf8"))}\n`);
    return;
  }
  fail("PACKAGE_LOCK_ATTEST_USAGE", "usage: package-lock attestor expects --run-synthetic, --attest <controlled-root> <manifest> <aggregate>, or --validate-json <canonical-json>");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.code ?? "PACKAGE_LOCK_ATTEST_FAILED"}: ${error.message}\n`);
    process.exitCode = 1;
  });
}
