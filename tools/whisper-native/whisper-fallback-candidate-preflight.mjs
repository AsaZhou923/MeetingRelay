#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { TextDecoder } from "node:util";

import { encodeCanonicalJson } from "../phase0-harness/canonical-json.mjs";

export const PUBLIC_EVIDENCE_KIND = "meetingrelay-whisper-fallback-candidate-preflight-v1";
export const PUBLIC_EVIDENCE_SCHEMA_VERSION = "1.0";
export const INPUT_MANIFEST_KIND = "meetingrelay-whisper-fallback-candidate-preflight-input-v1";
export const PREIMAGE_DOMAIN = "meetingrelay.whisper-fallback-candidate.identity-preflight.v1";
export const WORKER_ROLE = "whisper-fallback-candidate";
export const MEASUREMENT_STATUS = "whisper-fallback-identity-preflight-only";
export const EXECUTION_STATUS = "not-executed-no-model-no-transcription";
export const MAX_INPUT_MANIFEST_BYTES = 64 * 1024;
export const MAX_CANDIDATE_FILE_BYTES = 8 * 1024 * 1024 * 1024;
export const MAX_TOTAL_CANDIDATE_BYTES = 16 * 1024 * 1024 * 1024;
export const STREAM_CHUNK_BYTES = 1024 * 1024;
export const REQUIRED_ROLES = Object.freeze([
  "adapter-source",
  "license",
  "model",
  "model-manifest",
  "package-lock",
  "parameters",
  "runtime",
]);
export const PUBLIC_EVIDENCE_SCHEMA_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "whisper-fallback-candidate-preflight.schema.json",
);
export const VALIDATOR_SOURCE_PATH = fileURLToPath(import.meta.url);

const REQUIRED_ROLE_SET = new Set(REQUIRED_ROLES);
const WINDOWS_DEVICE_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;
const SHA256_RE = /^[0-9a-f]{64}$/u;
const LOGICAL_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const FORBIDDEN_PUBLIC_KEYS = new Set([
  "absolute_path",
  "audio",
  "audio_path",
  "content",
  "controlled_root",
  "default",
  "distribution_approval",
  "environment",
  "file_path",
  "path",
  "plaintext",
  "plaintext_transcript",
  "rank",
  "root",
  "secret",
  "selection",
  "text",
  "threshold",
  "transcript",
  "transcript_text",
]);
const LIMITATIONS = Object.freeze([
  "whisper-fallback-identity-preflight-only: caller-provided bytes are hashed and joined, but no runtime is launched, no model is loaded, no audio is processed, no transcription is produced, no network or download authority is exercised, and no fallback candidate is selected",
  "adapter-source, runtime, model, package-lock, model-manifest, parameters, and license roles are byte-identity inputs only; their semantics, compatibility, ranking, defaults, and production suitability remain unassessed",
  "license bytes are identified for review plumbing only; this is not legal approval, model redistribution approval, public distribution approval, or publication authority",
  "public evidence intentionally omits filesystem paths, file contents, plaintext, secrets, environment values, timings, host identity, model names, package names, and transcript text",
]);

export class PreflightError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "PreflightError";
    this.code = code;
  }
}

export function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function fail(code, message) {
  throw new PreflightError(code, message);
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

function assertPositiveSize(value, code, label) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_CANDIDATE_FILE_BYTES) {
    fail(code, `${label} must be an integer between 1 and ${MAX_CANDIDATE_FILE_BYTES}`);
  }
}

function assertCanonicalJsonBytes(bytes, code, label, maxBytes = MAX_INPUT_MANIFEST_BYTES) {
  if (bytes.length === 0 || bytes.length > maxBytes) fail(code, `${label} size is outside the bounded manifest limit`);
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
  return parsed;
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
    (options.absolute === true && !path.isAbsolute(inputPath))
  ) {
    fail(code, `${label} must be local path syntax, not UNC/device/drive-relative/ADS syntax${options.absolute === true ? " or relative syntax" : ""}`);
  }
  return path.resolve(inputPath);
}

export function validateRelativePath(relativePath) {
  if (typeof relativePath !== "string" || relativePath.length === 0 || relativePath.length > 240) {
    fail("WHISPER_PREFLIGHT_PATH", "relative_path must be a bounded non-empty string");
  }
  if (relativePath !== relativePath.normalize("NFC")) fail("WHISPER_PREFLIGHT_PATH", "relative_path must be NFC-normalized");
  if (
    relativePath.includes("\\") ||
    relativePath.includes(":") ||
    relativePath.includes("\0") ||
    relativePath.startsWith("/") ||
    path.posix.isAbsolute(relativePath) ||
    path.win32.isAbsolute(relativePath)
  ) {
    fail("WHISPER_PREFLIGHT_PATH", "relative_path must not be absolute, Windows-style, UNC, ADS, or backslash syntax");
  }
  for (const segment of relativePath.split("/")) {
    if (segment === "" || segment === "." || segment === ".." || segment.endsWith(" ") || segment.endsWith(".") || WINDOWS_DEVICE_RE.test(segment)) {
      fail("WHISPER_PREFLIGHT_PATH", "relative_path contains a forbidden segment");
    }
  }
  return relativePath;
}

function resolveInsideRoot(controlledRoot, relativePath) {
  const root = path.resolve(controlledRoot);
  const absolute = path.resolve(root, ...relativePath.split("/"));
  const rootPrefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (absolute !== root && !absolute.toLowerCase().startsWith(rootPrefix.toLowerCase())) {
    fail("WHISPER_PREFLIGHT_ROOT_ESCAPE", "relative_path escaped controlled root");
  }
  return { absolute, root };
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function sameStableNode(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function assertPathChainHasNoLinks(absolutePath) {
  const resolved = path.resolve(absolutePath);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  const relative = path.relative(parsed.root, resolved);
  const segments = relative === "" ? [] : relative.split(path.sep);
  for (const segment of segments) {
    current = path.join(current, segment);
    const link = await lstat(current, { bigint: true }).catch((error) => fail("WHISPER_PREFLIGHT_FILE_OPEN", error.message));
    if (link.isSymbolicLink()) fail("WHISPER_PREFLIGHT_SPECIAL_FILE", "path chain must not contain a symlink or junction");
  }
}

async function snapshotControlledRoot(controlledRoot) {
  const root = rejectUnsafeLocalPath(controlledRoot, "WHISPER_PREFLIGHT_ROOT", "controlled root", { absolute: true });
  await assertPathChainHasNoLinks(root);
  const rootLink = await lstat(root, { bigint: true }).catch((error) => fail("WHISPER_PREFLIGHT_ROOT", error.message));
  if (!rootLink.isDirectory() || rootLink.isSymbolicLink()) fail("WHISPER_PREFLIGHT_ROOT", "controlled root must be a directory and not a symlink/junction");
  return { path: root, realpath: await realpath(root), stat: rootLink };
}

async function revalidateControlledRoot(snapshot) {
  const current = await lstat(snapshot.path, { bigint: true }).catch((error) => fail("WHISPER_PREFLIGHT_ROOT", error.message));
  if (!current.isDirectory() || current.isSymbolicLink() || !sameFileIdentity(snapshot.stat, current)) {
    fail("WHISPER_PREFLIGHT_TOCTOU", "controlled root changed during preflight");
  }
  if ((await realpath(snapshot.path)) !== snapshot.realpath) fail("WHISPER_PREFLIGHT_TOCTOU", "controlled root realpath changed during preflight");
}

async function assertSafeEntryAncestors(rootSnapshot, relativePath) {
  await revalidateControlledRoot(rootSnapshot);
  let current = rootSnapshot.path;
  for (const segment of relativePath.split("/").slice(0, -1)) {
    current = path.join(current, segment);
    const ancestor = await lstat(current, { bigint: true }).catch((error) => fail("WHISPER_PREFLIGHT_FILE_OPEN", error.message));
    if (!ancestor.isDirectory() || ancestor.isSymbolicLink()) {
      fail("WHISPER_PREFLIGHT_SPECIAL_FILE", "candidate input ancestor must be a regular directory and not a symlink/junction");
    }
  }
  await revalidateControlledRoot(rootSnapshot);
}

async function hashFromOpenHandle(handle, expectedSize) {
  const hash = createHash("sha256");
  const chunk = Buffer.allocUnsafe(Math.min(STREAM_CHUNK_BYTES, expectedSize));
  let total = 0;
  let position = 0;
  while (total < expectedSize) {
    const requested = Math.min(chunk.length, expectedSize - total);
    const { bytesRead } = await handle.read(chunk, 0, requested, position);
    if (bytesRead === 0) break;
    total += bytesRead;
    position += bytesRead;
    hash.update(chunk.subarray(0, bytesRead));
  }
  return { sha256: hash.digest("hex"), size_bytes: total };
}

async function hashRegularFile(rootSnapshot, relativePath, expectedSize, expectedSha256) {
  const { absolute } = resolveInsideRoot(rootSnapshot.path, relativePath);
  await assertSafeEntryAncestors(rootSnapshot, relativePath);
  const beforeLink = await lstat(absolute).catch((error) => fail("WHISPER_PREFLIGHT_FILE_OPEN", error.message));
  if (!beforeLink.isFile() || beforeLink.isSymbolicLink()) fail("WHISPER_PREFLIGHT_SPECIAL_FILE", "candidate input must be a regular non-symlink file");
  const before = await stat(absolute, { bigint: true });
  if (before.nlink > 1n) fail("WHISPER_PREFLIGHT_SPECIAL_FILE", "candidate input must not be hardlinked");
  const beforeSize = Number(before.size);
  if (!Number.isSafeInteger(beforeSize) || beforeSize < 1 || beforeSize > MAX_CANDIDATE_FILE_BYTES) fail("WHISPER_PREFLIGHT_SIZE", "candidate input size is empty or oversized");
  if (beforeSize !== expectedSize) fail("WHISPER_PREFLIGHT_SIZE_DRIFT", "candidate input size does not match manifest");
  const handle = await open(absolute, "r");
  try {
    const openStat = await handle.stat({ bigint: true });
    if (!openStat.isFile() || !sameFileIdentity(before, openStat)) fail("WHISPER_PREFLIGHT_TOCTOU", "candidate input changed before handle read");
    const observed = await hashFromOpenHandle(handle, expectedSize);
    const afterHandle = await handle.stat({ bigint: true });
    const afterLink = await lstat(absolute, { bigint: true });
    const afterPath = await stat(absolute, { bigint: true });
    if (!afterLink.isFile() || afterLink.isSymbolicLink() || !sameFileIdentity(openStat, afterHandle) || !sameFileIdentity(openStat, afterPath) || !sameStableNode(afterLink, afterPath)) {
      fail("WHISPER_PREFLIGHT_TOCTOU", "candidate input changed during preflight");
    }
    await assertSafeEntryAncestors(rootSnapshot, relativePath);
    if (observed.size_bytes !== expectedSize) fail("WHISPER_PREFLIGHT_SIZE_DRIFT", "read size does not match manifest");
    if (observed.sha256 !== expectedSha256) fail("WHISPER_PREFLIGHT_HASH_DRIFT", "read hash does not match manifest");
    return observed;
  } finally {
    await handle.close();
  }
}

async function readBoundedRegularFile(filePath, maxBytes, code, label) {
  const absolute = rejectUnsafeLocalPath(filePath, code, label);
  await assertPathChainHasNoLinks(path.dirname(absolute));
  const beforeLink = await lstat(absolute, { bigint: true }).catch((error) => fail(code, error.message));
  if (!beforeLink.isFile() || beforeLink.isSymbolicLink()) fail(code, `${label} must be a regular non-symlink file`);
  const before = await stat(absolute, { bigint: true });
  if (before.nlink > 1n) fail(code, `${label} must not be hardlinked`);
  const beforeSize = Number(before.size);
  if (!Number.isSafeInteger(beforeSize) || beforeSize < 1 || beforeSize > maxBytes) fail(code, `${label} size is empty or over limit`);
  const handle = await open(absolute, "r");
  try {
    const openStat = await handle.stat({ bigint: true });
    if (!openStat.isFile() || !sameFileIdentity(before, openStat)) fail("WHISPER_PREFLIGHT_TOCTOU", `${label} changed before handle read`);
    const bytes = Buffer.allocUnsafe(beforeSize);
    let total = 0;
    while (total < beforeSize) {
      const { bytesRead } = await handle.read(bytes, total, beforeSize - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    const afterHandle = await handle.stat({ bigint: true });
    const afterLink = await lstat(absolute, { bigint: true });
    const afterPath = await stat(absolute, { bigint: true });
    if (total !== beforeSize || !afterLink.isFile() || afterLink.isSymbolicLink() || !sameFileIdentity(openStat, afterHandle) || !sameFileIdentity(openStat, afterPath) || !sameStableNode(afterLink, afterPath)) {
      fail("WHISPER_PREFLIGHT_TOCTOU", `${label} changed during preflight`);
    }
    await assertPathChainHasNoLinks(path.dirname(absolute));
    return bytes;
  } finally {
    await handle.close();
  }
}

function validateAuthority(value, code, label) {
  if (
    value.measurement_status !== MEASUREMENT_STATUS ||
    value.execution_status !== EXECUTION_STATUS ||
    value.quality_gate_status !== "not-assessed" ||
    value.formal_claims !== "none" ||
    value.production_evidence !== false ||
    value.public_distribution !== false ||
    value.selection_authority !== "none" ||
    value.fallback_authority !== "none"
  ) {
    fail(code, `${label} authority fields overclaim`);
  }
}

function validateInputManifest(manifest) {
  assertPlainObject(manifest, "WHISPER_PREFLIGHT_MANIFEST", "manifest");
  assertAllowedKeys(
    manifest,
    new Set([
      "kind",
      "schema_version",
      "worker_role",
      "measurement_status",
      "execution_status",
      "quality_gate_status",
      "formal_claims",
      "production_evidence",
      "public_distribution",
      "selection_authority",
      "fallback_authority",
      "files",
    ]),
    "WHISPER_PREFLIGHT_MANIFEST",
    "manifest",
  );
  if (manifest.kind !== INPUT_MANIFEST_KIND || manifest.schema_version !== "1.0" || manifest.worker_role !== WORKER_ROLE) {
    fail("WHISPER_PREFLIGHT_MANIFEST", "bad manifest identity");
  }
  validateAuthority(manifest, "WHISPER_PREFLIGHT_OVERCLAIM", "manifest");
  if (!Array.isArray(manifest.files) || manifest.files.length !== REQUIRED_ROLES.length) fail("WHISPER_PREFLIGHT_ROLE_SET", "manifest must contain exactly seven role files");
  let totalSize = 0;
  const seenRoles = new Set();
  const seenLogicalIds = new Set();
  const seenPaths = new Set();
  for (const [index, entry] of manifest.files.entries()) {
    assertPlainObject(entry, "WHISPER_PREFLIGHT_MANIFEST", "file");
    assertAllowedKeys(entry, new Set(["role", "logical_id", "relative_path", "sha256", "size_bytes"]), "WHISPER_PREFLIGHT_MANIFEST", "file");
    if (entry.role !== REQUIRED_ROLES[index] || !REQUIRED_ROLE_SET.has(entry.role) || seenRoles.has(entry.role)) {
      fail("WHISPER_PREFLIGHT_ROLE_SET", "missing, duplicate, unordered, or unsupported role");
    }
    seenRoles.add(entry.role);
    if (typeof entry.logical_id !== "string" || !LOGICAL_ID_RE.test(entry.logical_id) || seenLogicalIds.has(entry.logical_id)) {
      fail("WHISPER_PREFLIGHT_LOGICAL_ID", "logical_id must be unique bounded lowercase token");
    }
    seenLogicalIds.add(entry.logical_id);
    assertSha256(entry.sha256, "WHISPER_PREFLIGHT_DIGEST", "file.sha256");
    assertPositiveSize(entry.size_bytes, "WHISPER_PREFLIGHT_SIZE", "file.size_bytes");
    totalSize += entry.size_bytes;
    if (totalSize > MAX_TOTAL_CANDIDATE_BYTES) fail("WHISPER_PREFLIGHT_SIZE", `manifest total size must not exceed ${MAX_TOTAL_CANDIDATE_BYTES}`);
    validateRelativePath(entry.relative_path);
    const foldedPath = entry.relative_path.toLowerCase();
    if (seenPaths.has(foldedPath)) fail("WHISPER_PREFLIGHT_PATH", "case-insensitive duplicate relative_path");
    seenPaths.add(foldedPath);
  }
}

function descriptorFromRoles(roles) {
  const descriptor = {
    preimage_domain: PREIMAGE_DOMAIN,
    role_count: roles.length,
    roles: roles.map((role) => ({
      logical_id_sha256: role.logical_id_sha256,
      role: role.role,
      sha256: role.sha256,
      size_bytes: role.size_bytes,
    })),
    worker_role: WORKER_ROLE,
  };
  const descriptorText = encodeCanonicalJson(descriptor);
  return {
    aggregate_sha256: sha256Hex(Buffer.from(`${PREIMAGE_DOMAIN}\n${descriptorText}`, "utf8")),
    descriptor_sha256: sha256Hex(Buffer.from(descriptorText, "utf8")),
    preimage_domain: PREIMAGE_DOMAIN,
    role_count: roles.length,
  };
}

export async function preflightWhisperFallbackCandidate(controlledRoot, inputManifestPath) {
  const rootSnapshot = await snapshotControlledRoot(controlledRoot);
  const manifestBytes = await readBoundedRegularFile(
    inputManifestPath,
    MAX_INPUT_MANIFEST_BYTES,
    "WHISPER_PREFLIGHT_MANIFEST_FILE",
    "input manifest",
  );
  const manifest = assertCanonicalJsonBytes(manifestBytes, "WHISPER_PREFLIGHT_MANIFEST_CANONICAL", "input manifest");
  validateInputManifest(manifest);
  const roles = [];
  for (const role of REQUIRED_ROLES) {
    const entry = manifest.files.find((candidate) => candidate.role === role);
    const observed = await hashRegularFile(rootSnapshot, entry.relative_path, entry.size_bytes, entry.sha256);
    roles.push({
      role,
      logical_id_sha256: sha256Hex(Buffer.from(entry.logical_id, "utf8")),
      sha256: observed.sha256,
      size_bytes: observed.size_bytes,
    });
  }
  await revalidateControlledRoot(rootSnapshot);
  const schemaBytes = await readFile(PUBLIC_EVIDENCE_SCHEMA_PATH);
  JSON.parse(schemaBytes.toString("utf8"));
  const validatorBytes = await readFile(VALIDATOR_SOURCE_PATH);
  const evidence = {
    kind: PUBLIC_EVIDENCE_KIND,
    schema_version: PUBLIC_EVIDENCE_SCHEMA_VERSION,
    schema_file_sha256: sha256Hex(schemaBytes),
    validator_source_sha256: sha256Hex(validatorBytes),
    canonical_input_manifest_sha256: sha256Hex(manifestBytes),
    measurement_status: MEASUREMENT_STATUS,
    execution_status: EXECUTION_STATUS,
    quality_gate_status: "not-assessed",
    formal_claims: "none",
    production_evidence: false,
    public_distribution: false,
    selection_authority: "none",
    fallback_authority: "none",
    worker_role: WORKER_ROLE,
    roles,
    candidate_descriptor: descriptorFromRoles(roles),
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
      if (FORBIDDEN_PUBLIC_KEYS.has(key)) fail("WHISPER_PREFLIGHT_EVIDENCE_FORBIDDEN", `public evidence contains forbidden key ${[...pathSegments, key].join(".")}`);
      scanForbiddenPublicEvidence(item, [...pathSegments, key]);
    }
    return;
  }
  if (typeof value === "string") {
    if (LIMITATIONS.includes(value)) return;
    if (/[A-Za-z]:\\|\\\\|\/|\.wav|\.mp3|\.flac|BEGIN [A-Z ]*PRIVATE KEY|secret|transcript\s|ggml-|gguf|\.bin/iu.test(value)) {
      fail("WHISPER_PREFLIGHT_EVIDENCE_FORBIDDEN", `public evidence contains forbidden value at ${pathSegments.join(".")}`);
    }
  }
}

export function validatePublicEvidence(evidence) {
  assertPlainObject(evidence, "WHISPER_PREFLIGHT_EVIDENCE_SCHEMA", "evidence");
  assertAllowedKeys(
    evidence,
    new Set([
      "kind",
      "schema_version",
      "schema_file_sha256",
      "validator_source_sha256",
      "canonical_input_manifest_sha256",
      "measurement_status",
      "execution_status",
      "quality_gate_status",
      "formal_claims",
      "production_evidence",
      "public_distribution",
      "selection_authority",
      "fallback_authority",
      "worker_role",
      "roles",
      "candidate_descriptor",
      "limitations",
    ]),
    "WHISPER_PREFLIGHT_EVIDENCE_SCHEMA",
    "evidence",
  );
  if (evidence.kind !== PUBLIC_EVIDENCE_KIND || evidence.schema_version !== PUBLIC_EVIDENCE_SCHEMA_VERSION) fail("WHISPER_PREFLIGHT_EVIDENCE_SCHEMA", "bad evidence identity");
  for (const key of ["schema_file_sha256", "validator_source_sha256", "canonical_input_manifest_sha256"]) {
    assertSha256(evidence[key], "WHISPER_PREFLIGHT_EVIDENCE_SCHEMA", key);
  }
  if (
    evidence.schema_file_sha256 !== sha256Hex(readFileSync(PUBLIC_EVIDENCE_SCHEMA_PATH)) ||
    evidence.validator_source_sha256 !== sha256Hex(readFileSync(VALIDATOR_SOURCE_PATH))
  ) {
    fail("WHISPER_PREFLIGHT_EVIDENCE_SCHEMA", "schema or validator digest mismatch");
  }
  validateAuthority(evidence, "WHISPER_PREFLIGHT_EVIDENCE_OVERCLAIM", "evidence");
  if (evidence.worker_role !== WORKER_ROLE) fail("WHISPER_PREFLIGHT_EVIDENCE_OVERCLAIM", "evidence worker_role overclaim");
  if (!Array.isArray(evidence.roles) || evidence.roles.length !== REQUIRED_ROLES.length) fail("WHISPER_PREFLIGHT_EVIDENCE_SCHEMA", "roles must contain exactly seven rows");
  for (const [index, role] of evidence.roles.entries()) {
    assertPlainObject(role, "WHISPER_PREFLIGHT_EVIDENCE_SCHEMA", "role");
    assertAllowedKeys(role, new Set(["role", "logical_id_sha256", "sha256", "size_bytes"]), "WHISPER_PREFLIGHT_EVIDENCE_SCHEMA", "role");
    if (role.role !== REQUIRED_ROLES[index]) fail("WHISPER_PREFLIGHT_EVIDENCE_SCHEMA", "roles must be unique and sorted");
    assertSha256(role.logical_id_sha256, "WHISPER_PREFLIGHT_EVIDENCE_SCHEMA", "role.logical_id_sha256");
    assertSha256(role.sha256, "WHISPER_PREFLIGHT_EVIDENCE_SCHEMA", "role.sha256");
    assertPositiveSize(role.size_bytes, "WHISPER_PREFLIGHT_EVIDENCE_SCHEMA", "role.size_bytes");
  }
  assertPlainObject(evidence.candidate_descriptor, "WHISPER_PREFLIGHT_EVIDENCE_SCHEMA", "candidate_descriptor");
  assertAllowedKeys(evidence.candidate_descriptor, new Set(["descriptor_sha256", "aggregate_sha256", "preimage_domain", "role_count"]), "WHISPER_PREFLIGHT_EVIDENCE_SCHEMA", "candidate_descriptor");
  assertSha256(evidence.candidate_descriptor.descriptor_sha256, "WHISPER_PREFLIGHT_EVIDENCE_SCHEMA", "descriptor_sha256");
  assertSha256(evidence.candidate_descriptor.aggregate_sha256, "WHISPER_PREFLIGHT_EVIDENCE_SCHEMA", "aggregate_sha256");
  if (JSON.stringify(evidence.candidate_descriptor) !== JSON.stringify(descriptorFromRoles(evidence.roles))) {
    fail("WHISPER_PREFLIGHT_EVIDENCE_SCHEMA", "candidate descriptor digest mismatch");
  }
  if (!Array.isArray(evidence.limitations) || evidence.limitations.length !== LIMITATIONS.length) fail("WHISPER_PREFLIGHT_EVIDENCE_SCHEMA", "limitations must be exact");
  for (const [index, limitation] of LIMITATIONS.entries()) {
    if (evidence.limitations[index] !== limitation) fail("WHISPER_PREFLIGHT_EVIDENCE_SCHEMA", "limitation mismatch");
  }
  scanForbiddenPublicEvidence(evidence);
  return true;
}

export async function createSyntheticFixture(root) {
  const files = [
    ["adapter-source", "inputs/adapter-source.txt", "synthetic adapter source bytes\n"],
    ["license", "inputs/license.txt", "synthetic license bytes for review plumbing only\n"],
    ["model", "inputs/model-identity.bytes", "synthetic opaque model identity bytes\n"],
    ["model-manifest", "inputs/model-manifest.json", "{\"synthetic\":true,\"role\":\"manifest\"}\n"],
    ["package-lock", "inputs/package-lock.json", "{\"synthetic\":true,\"lockfileVersion\":0}\n"],
    ["parameters", "inputs/parameters.json", "{\"synthetic\":true,\"role\":\"parameters\"}\n"],
    ["runtime", "inputs/runtime.bytes", "synthetic opaque runtime bytes\n"],
  ];
  const manifest = {
    kind: INPUT_MANIFEST_KIND,
    schema_version: "1.0",
    worker_role: WORKER_ROLE,
    measurement_status: MEASUREMENT_STATUS,
    execution_status: EXECUTION_STATUS,
    quality_gate_status: "not-assessed",
    formal_claims: "none",
    production_evidence: false,
    public_distribution: false,
    selection_authority: "none",
    fallback_authority: "none",
    files: [],
  };
  for (const [role, relativePath, text] of files) {
    const absolute = path.join(root, ...relativePath.split("/"));
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, text, { encoding: "utf8" });
    const bytes = Buffer.from(text, "utf8");
    manifest.files.push({
      role,
      logical_id: `synthetic-${role}`,
      relative_path: relativePath,
      sha256: sha256Hex(bytes),
      size_bytes: bytes.length,
    });
  }
  const manifestPath = path.join(root, "input-manifest.json");
  await writeFile(manifestPath, encodeCanonicalJson(manifest), { encoding: "utf8" });
  return { manifest, manifestPath };
}

async function runSynthetic() {
  const root = await mkdtemp(path.join(tmpdir(), "meetingrelay-whisper-preflight-"));
  try {
    await createSyntheticFixture(root);
    return await preflightWhisperFallbackCandidate(root, path.join(root, "input-manifest.json"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function main(argv) {
  if (argv.length === 0 || (argv.length === 1 && argv[0] === "--run-synthetic")) {
    const evidence = await runSynthetic();
    const evidenceText = encodeCanonicalJson(evidence);
    process.stdout.write(
      `whisper-fallback-candidate-preflight=verified evidence_sha256=${sha256Hex(Buffer.from(evidenceText, "utf8"))} candidate_aggregate_sha256=${evidence.candidate_descriptor.aggregate_sha256} roles=${evidence.roles.length} measurement_status=${evidence.measurement_status} execution_status=${evidence.execution_status} quality_gate_status=${evidence.quality_gate_status} formal_claims=none production_evidence=false public_distribution=false selection_authority=none fallback_authority=none\n`,
    );
    return;
  }
  if (argv.length === 3 && argv[0] === "--preflight") {
    const evidence = await preflightWhisperFallbackCandidate(argv[1], argv[2]);
    const evidenceText = encodeCanonicalJson(evidence);
    process.stdout.write(
      `whisper-fallback-candidate-preflight=verified evidence_sha256=${sha256Hex(Buffer.from(evidenceText, "utf8"))} candidate_aggregate_sha256=${evidence.candidate_descriptor.aggregate_sha256} roles=${evidence.roles.length} measurement_status=${evidence.measurement_status} execution_status=${evidence.execution_status} quality_gate_status=${evidence.quality_gate_status} formal_claims=none production_evidence=false public_distribution=false selection_authority=none fallback_authority=none\n`,
    );
    return;
  }
  if (argv.length === 2 && argv[0] === "--validate-json") {
    const evidence = assertCanonicalJsonBytes(Buffer.from(argv[1], "utf8"), "WHISPER_PREFLIGHT_EVIDENCE_CANONICAL", "evidence");
    validatePublicEvidence(evidence);
    process.stdout.write(`whisper-fallback-candidate-preflight-json=verified evidence_sha256=${sha256Hex(Buffer.from(encodeCanonicalJson(evidence), "utf8"))}\n`);
    return;
  }
  fail("WHISPER_PREFLIGHT_USAGE", "usage: node tools/whisper-native/whisper-fallback-candidate-preflight.mjs [--run-synthetic]|--preflight <controlled-root> <input-manifest.json>|--validate-json '<canonical-json>'");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
