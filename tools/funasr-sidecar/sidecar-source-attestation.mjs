#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { TextDecoder } from "node:util";

import { encodeCanonicalJson } from "../phase0-harness/canonical-json.mjs";
import { REQUIRED_ROLES, sha256Hex, validateRelativePath } from "./sidecar-candidate-preflight.mjs";
import {
  BOUNDARY_SOURCE_PATH,
  FIXED_SOURCE_AUDITOR,
  FIXED_SOURCE_AUDITOR_SHA256,
  bindExactManifestRuntime,
  getBoundRuntimeSnapshot,
  postflightExactRuntimeRootIdentity,
  runFixedSourceParseCompileAuditor,
} from "./sidecar-python-probe-boundary.mjs";
import {
  PUBLIC_EVIDENCE_SCHEMA_PATH as PREFLIGHT_SCHEMA_PATH,
  VALIDATOR_SOURCE_PATH as PREFLIGHT_SOURCE_PATH,
} from "./sidecar-candidate-preflight.mjs";

export const PUBLIC_EVIDENCE_KIND = "meetingrelay-funasr-sidecar-source-attestation-v1";
export const PUBLIC_EVIDENCE_SCHEMA_VERSION = "1.0";
export const PUBLIC_EVIDENCE_SCHEMA_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "sidecar-source-attestation.schema.json");
export const ATTESTOR_SOURCE_PATH = fileURLToPath(import.meta.url);
export const REFERENCE_SOURCE_PATH = fileURLToPath(new URL("./python/meetingrelay_funasr_sidecar.py", import.meta.url));
export const MAX_SOURCE_BYTES = 256 * 1024;

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const SHA256_RE = /^[0-9a-f]{64}$/u;
const FORBIDDEN_PUBLIC_KEYS = new Set([
  "absolute_path",
  "args",
  "content",
  "cwd",
  "env",
  "environment",
  "executable_path",
  "file_path",
  "filename",
  "path",
  "root",
  "source",
  "stderr",
  "stdout",
  "text",
  "traceback",
]);
const FORBIDDEN_PUBLIC_VALUE_RE = /(?:[A-Za-z]:\\|\\\\|\/tmp\/|\/home\/|\/Users\/|inputs\/|\.py|Traceback|SyntaxError|from __future__|def )/u;
const LIMITATIONS = Object.freeze([
  "source-attestation-only: fixed sidecar-source bytes are compared to fixed MeetingRelay reference file bytes read by validator and parsed/compiled through a fixed isolated auditor",
  "fixed-file-byte-match-only: no Git provenance, commit ancestry, tag, signature, author, review, or repository cleanliness authority is claimed",
  "source parse/compile uses a direct child with -I -S -B -c and bounded stdin; the candidate module is never imported, executed, evaled, or py_compile/compileall/runpy/importlib loaded",
  "FunASR import, model load, audio processing, network access, download, quality, performance, ranking, selection, default, packaging, public distribution, and Phase 1 remain unexecuted or unassessed",
  "public evidence intentionally omits filesystem paths, source text, filenames, stderr, tracebacks, environment values, timings, host identity, and plaintext",
]);

export class SourceAttestationError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "SourceAttestationError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new SourceAttestationError(code, message);
}

function assertPlainObject(value, code, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(code, `${label} must be an object`);
}

function assertAllowedKeys(value, allowed, code, label) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(code, `${label} has unknown field ${key}`);
}

function assertSha256(value, code, label) {
  if (typeof value !== "string" || !SHA256_RE.test(value) || value === "0".repeat(64)) fail(code, `${label} must be non-zero lowercase sha256 hex`);
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
  for (const segment of relative === "" ? [] : relative.split(path.sep)) {
    current = path.join(current, segment);
    const link = await lstat(current, { bigint: true }).catch((error) => fail("SOURCE_ATTEST_FILE_OPEN", error.message));
    if (link.isSymbolicLink() || (!link.isFile() && !link.isDirectory())) fail("SOURCE_ATTEST_SPECIAL_FILE", "path chain must not contain links or special files");
  }
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

function resolveInsideRoot(controlledRoot, relativePath) {
  validateRelativePath(relativePath);
  const root = path.resolve(controlledRoot);
  const absolute = path.resolve(root, ...relativePath.split("/"));
  const rootPrefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  const comparableAbsolute = process.platform === "win32" ? absolute.toLowerCase() : absolute;
  const comparableRootPrefix = process.platform === "win32" ? rootPrefix.toLowerCase() : rootPrefix;
  if (absolute !== root && !comparableAbsolute.startsWith(comparableRootPrefix)) fail("SOURCE_ATTEST_ROOT_ESCAPE", "source escaped controlled root");
  return absolute;
}

async function readRegularBytes(filePath, maxBytes, code, label, options = {}) {
  const absolute = rejectUnsafeLocalPath(filePath, code, label);
  await assertPathChainHasNoLinks(absolute);
  const before = await lstat(absolute, { bigint: true }).catch((error) => fail(code, error.message));
  if (!before.isFile() || before.isSymbolicLink()) fail("SOURCE_ATTEST_SPECIAL_FILE", `${label} must be a regular non-symlink file`);
  await options.beforeOpenForTest?.(absolute);
  const handle = await open(absolute, "r").catch((error) => fail(code, error.message));
  try {
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile() || stat.size <= 0n || stat.size > BigInt(maxBytes)) fail(code, `${label} must be a bounded regular file`);
    const beforeIdentity = identityFromStat(before);
    const openIdentity = identityFromStat(stat);
    if (!sameFileIdentity(beforeIdentity, openIdentity)) fail("SOURCE_ATTEST_FILE_DRIFT", `${label} identity drifted while opening`);
    await options.afterOpenForTest?.(absolute);
    const bytes = await handle.readFile();
    const afterHandle = await handle.stat({ bigint: true });
    const afterLink = await lstat(absolute, { bigint: true }).catch((error) => fail(code, error.message));
    if (!afterLink.isFile() || afterLink.isSymbolicLink()) fail("SOURCE_ATTEST_SPECIAL_FILE", `${label} path changed to link or special file`);
    const afterHandleIdentity = identityFromStat(afterHandle);
    const afterPathIdentity = identityFromStat(afterLink);
    if (!sameFileIdentity(openIdentity, afterHandleIdentity) || !sameFileIdentity(openIdentity, afterPathIdentity)) {
      fail("SOURCE_ATTEST_FILE_DRIFT", `${label} identity drifted during read`);
    }
    await assertPathChainHasNoLinks(absolute);
    return { bytes, identity: openIdentity };
  } finally {
    await handle.close();
  }
}

function assertSourceEnvelope(bytes) {
  if (bytes.length === 0 || bytes.length > MAX_SOURCE_BYTES) fail("SOURCE_ATTEST_SOURCE_SIZE", "source size outside strict envelope");
  if (bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) fail("SOURCE_ATTEST_SOURCE_BOM", "source must not include UTF-8 BOM");
  if (bytes.includes(0x00)) fail("SOURCE_ATTEST_SOURCE_NUL", "source must not include NUL");
  if (bytes.includes(0x0d)) fail("SOURCE_ATTEST_SOURCE_CR", "source must be LF-only");
  let text;
  try {
    text = UTF8_DECODER.decode(bytes);
  } catch {
    fail("SOURCE_ATTEST_SOURCE_UTF8", "source must be fatal strict UTF-8");
  }
  if (!Buffer.from(text, "utf8").equals(bytes)) fail("SOURCE_ATTEST_SOURCE_UTF8", "source bytes must round-trip as UTF-8");
  if (text !== text.normalize("NFC")) fail("SOURCE_ATTEST_SOURCE_NFC", "source must be NFC-normalized");
  if (!text.endsWith("\n") || text.endsWith("\n\n")) fail("SOURCE_ATTEST_SOURCE_TERMINAL_LF", "source must have exactly one terminal LF");
  return { text, size_bytes: bytes.length, sha256: sha256Hex(bytes) };
}

function findManifestRole(manifest, role) {
  const entry = manifest.files.find((candidate) => candidate.role === role);
  if (!entry) fail("SOURCE_ATTEST_MANIFEST", `${role} role missing`);
  return entry;
}

export async function attestSidecarSource(controlledRoot, inputManifestPath, pythonExecutablePath, expectedAggregateSha256, options = {}) {
  const bound = await bindExactManifestRuntime(controlledRoot, inputManifestPath, pythonExecutablePath, expectedAggregateSha256);
  const boundSnapshot = getBoundRuntimeSnapshot(bound);
  const manifestEntry = findManifestRole(boundSnapshot.manifest, "sidecar-source");
  const root = path.resolve(controlledRoot);
  const sourcePath = resolveInsideRoot(root, manifestEntry.relative_path);
  const [sourceRead, referenceRead, schemaBytes, attestorBytes, boundaryBytes] = await Promise.all([
    readRegularBytes(sourcePath, MAX_SOURCE_BYTES, "SOURCE_ATTEST_SOURCE_FILE", "sidecar-source", {
      afterOpenForTest: options.afterSourceOpenForTest,
      beforeOpenForTest: options.beforeSourceOpenForTest,
    }),
    readRegularBytes(REFERENCE_SOURCE_PATH, MAX_SOURCE_BYTES, "SOURCE_ATTEST_REFERENCE_FILE", "reference source", {
      afterOpenForTest: options.afterReferenceOpenForTest,
      beforeOpenForTest: options.beforeReferenceOpenForTest,
    }),
    readFile(PUBLIC_EVIDENCE_SCHEMA_PATH),
    readFile(ATTESTOR_SOURCE_PATH),
    readFile(BOUNDARY_SOURCE_PATH),
  ]);
  JSON.parse(schemaBytes.toString("utf8"));
  const sourceBytes = sourceRead.bytes;
  const referenceBytes = referenceRead.bytes;
  const source = assertSourceEnvelope(sourceBytes);
  const reference = assertSourceEnvelope(referenceBytes);
  if (manifestEntry.size_bytes !== source.size_bytes || manifestEntry.sha256 !== source.sha256) {
    fail("SOURCE_ATTEST_MANIFEST_DRIFT", "sidecar-source bytes differ from 4b manifest");
  }
  if (source.size_bytes !== reference.size_bytes || source.sha256 !== reference.sha256) {
    fail("SOURCE_ATTEST_REFERENCE_DRIFT", "sidecar-source bytes must match the fixed reference file exactly");
  }
  const audit = await runFixedSourceParseCompileAuditor(bound, sourceBytes, options);
  const postflight = await postflightExactRuntimeRootIdentity(bound);
  const preflightEvidenceText = encodeCanonicalJson(boundSnapshot.preflight_evidence);
  const evidence = {
    kind: PUBLIC_EVIDENCE_KIND,
    schema_version: PUBLIC_EVIDENCE_SCHEMA_VERSION,
    schema_file_sha256: sha256Hex(schemaBytes),
    attestor_source_sha256: sha256Hex(attestorBytes),
    python_probe_boundary_source_sha256: sha256Hex(boundaryBytes),
    auditor_source_sha256: FIXED_SOURCE_AUDITOR_SHA256,
    reference_source_sha256: reference.sha256,
    reference_source_size_bytes: reference.size_bytes,
    preflight_schema_sha256: sha256Hex(readFileSync(PREFLIGHT_SCHEMA_PATH)),
    preflight_validator_source_sha256: sha256Hex(readFileSync(PREFLIGHT_SOURCE_PATH)),
    preflight_evidence_sha256: sha256Hex(Buffer.from(preflightEvidenceText, "utf8")),
    canonical_input_manifest_sha256: boundSnapshot.canonical_manifest_sha256,
    candidate_aggregate_sha256: boundSnapshot.candidate_aggregate_sha256,
    measurement_status: "source-attestation-only",
    execution_status: "source-parse-compile-only-no-import",
    source_binding_scope: "fixed-file-byte-match-only",
    git_provenance_authority: "none",
    cpython_provenance_authority: "none",
    packaging_authority: "none",
    quality_gate_status: "not-assessed",
    formal_claims: "none",
    production_evidence: false,
    public_distribution: false,
    selection_authority: "none",
    worker_role: "sidecar-candidate",
    source: {
      role: "sidecar-source",
      logical_id_sha256: sha256Hex(Buffer.from(manifestEntry.logical_id, "utf8")),
      size_bytes: source.size_bytes,
      sha256: source.sha256,
      reference_size_bytes: reference.size_bytes,
      reference_sha256: reference.sha256,
      manifest_reference_byte_match: true,
      envelope_utf8_nfc_lf_terminal: true,
    },
    runtime: {
      role: "runtime",
      logical_id_sha256: sha256Hex(Buffer.from(boundSnapshot.runtime_manifest.logical_id, "utf8")),
      size_bytes: boundSnapshot.runtime_before.size_bytes,
      sha256: boundSnapshot.runtime_before.sha256,
      before_after_identity_match: postflight.runtime_before_after_identity_match,
    },
    auditor: {
      fixed_auditor_sha256: FIXED_SOURCE_AUDITOR_SHA256,
      fixed_auditor_imports_sha256: sha256Hex(Buffer.from(encodeCanonicalJson(["ast", "json", "sys"]), "utf8")),
      parse_result_count: audit.module_count,
      compile_result_count: audit.module_count,
      top_level_statement_count: audit.top_level_statement_count,
      source_imported: false,
      source_executed: false,
      candidate_text_reported: false,
      process_contract_sha256: sha256Hex(Buffer.from(encodeCanonicalJson(audit.processContract), "utf8")),
    },
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
      if (FORBIDDEN_PUBLIC_KEYS.has(key) && key !== "source") fail("SOURCE_ATTEST_EVIDENCE_FORBIDDEN", `forbidden public evidence key ${[...pathSegments, key].join(".")}`);
      scanForbiddenPublicEvidence(item, [...pathSegments, key]);
    }
    return;
  }
  if (typeof value === "string" && !LIMITATIONS.includes(value) && FORBIDDEN_PUBLIC_VALUE_RE.test(value)) {
    fail("SOURCE_ATTEST_EVIDENCE_FORBIDDEN", `forbidden public evidence value at ${pathSegments.join(".")}`);
  }
}

export function validatePublicEvidence(evidence) {
  assertPlainObject(evidence, "SOURCE_ATTEST_EVIDENCE_SCHEMA", "evidence");
  assertAllowedKeys(
    evidence,
    new Set([
      "kind",
      "schema_version",
      "schema_file_sha256",
      "attestor_source_sha256",
      "python_probe_boundary_source_sha256",
      "auditor_source_sha256",
      "reference_source_sha256",
      "reference_source_size_bytes",
      "preflight_schema_sha256",
      "preflight_validator_source_sha256",
      "preflight_evidence_sha256",
      "canonical_input_manifest_sha256",
      "candidate_aggregate_sha256",
      "measurement_status",
      "execution_status",
      "source_binding_scope",
      "git_provenance_authority",
      "cpython_provenance_authority",
      "packaging_authority",
      "quality_gate_status",
      "formal_claims",
      "production_evidence",
      "public_distribution",
      "selection_authority",
      "worker_role",
      "source",
      "runtime",
      "auditor",
      "limitations",
    ]),
    "SOURCE_ATTEST_EVIDENCE_SCHEMA",
    "evidence",
  );
  if (evidence.kind !== PUBLIC_EVIDENCE_KIND || evidence.schema_version !== PUBLIC_EVIDENCE_SCHEMA_VERSION) fail("SOURCE_ATTEST_EVIDENCE_SCHEMA", "bad evidence kind or schema version");
  for (const key of [
    "schema_file_sha256",
    "attestor_source_sha256",
    "python_probe_boundary_source_sha256",
    "auditor_source_sha256",
    "reference_source_sha256",
    "preflight_schema_sha256",
    "preflight_validator_source_sha256",
    "preflight_evidence_sha256",
    "canonical_input_manifest_sha256",
    "candidate_aggregate_sha256",
  ]) {
    assertSha256(evidence[key], "SOURCE_ATTEST_EVIDENCE_SCHEMA", key);
  }
  if (
    evidence.schema_file_sha256 !== sha256Hex(readFileSync(PUBLIC_EVIDENCE_SCHEMA_PATH)) ||
    evidence.attestor_source_sha256 !== sha256Hex(readFileSync(ATTESTOR_SOURCE_PATH)) ||
    evidence.python_probe_boundary_source_sha256 !== sha256Hex(readFileSync(BOUNDARY_SOURCE_PATH)) ||
    evidence.auditor_source_sha256 !== FIXED_SOURCE_AUDITOR_SHA256 ||
    evidence.reference_source_sha256 !== sha256Hex(readFileSync(REFERENCE_SOURCE_PATH)) ||
    evidence.reference_source_size_bytes !== readFileSync(REFERENCE_SOURCE_PATH).length
  ) {
    fail("SOURCE_ATTEST_EVIDENCE_SCHEMA", "schema, source, auditor, boundary, or reference digest mismatch");
  }
  if (
    evidence.measurement_status !== "source-attestation-only" ||
    evidence.execution_status !== "source-parse-compile-only-no-import" ||
    evidence.source_binding_scope !== "fixed-file-byte-match-only" ||
    evidence.git_provenance_authority !== "none" ||
    evidence.cpython_provenance_authority !== "none" ||
    evidence.packaging_authority !== "none" ||
    evidence.quality_gate_status !== "not-assessed" ||
    evidence.formal_claims !== "none" ||
    evidence.production_evidence !== false ||
    evidence.public_distribution !== false ||
    evidence.selection_authority !== "none" ||
    evidence.worker_role !== "sidecar-candidate"
  ) {
    fail("SOURCE_ATTEST_EVIDENCE_OVERCLAIM", "evidence authority fields overclaim");
  }
  assertPlainObject(evidence.source, "SOURCE_ATTEST_EVIDENCE_SCHEMA", "source");
  assertAllowedKeys(evidence.source, new Set(["role", "logical_id_sha256", "size_bytes", "sha256", "reference_size_bytes", "reference_sha256", "manifest_reference_byte_match", "envelope_utf8_nfc_lf_terminal"]), "SOURCE_ATTEST_EVIDENCE_SCHEMA", "source");
  if (evidence.source.role !== "sidecar-source" || evidence.source.manifest_reference_byte_match !== true || evidence.source.envelope_utf8_nfc_lf_terminal !== true) fail("SOURCE_ATTEST_EVIDENCE_SCHEMA", "source binding mismatch");
  assertSha256(evidence.source.logical_id_sha256, "SOURCE_ATTEST_EVIDENCE_SCHEMA", "source.logical_id_sha256");
  assertSha256(evidence.source.sha256, "SOURCE_ATTEST_EVIDENCE_SCHEMA", "source.sha256");
  assertSha256(evidence.source.reference_sha256, "SOURCE_ATTEST_EVIDENCE_SCHEMA", "source.reference_sha256");
  if (evidence.source.sha256 !== evidence.reference_source_sha256 || evidence.source.reference_sha256 !== evidence.reference_source_sha256 || evidence.source.size_bytes !== evidence.reference_source_size_bytes || evidence.source.reference_size_bytes !== evidence.reference_source_size_bytes) fail("SOURCE_ATTEST_EVIDENCE_SCHEMA", "source/reference parity mismatch");
  assertPlainObject(evidence.runtime, "SOURCE_ATTEST_EVIDENCE_SCHEMA", "runtime");
  assertAllowedKeys(evidence.runtime, new Set(["role", "logical_id_sha256", "size_bytes", "sha256", "before_after_identity_match"]), "SOURCE_ATTEST_EVIDENCE_SCHEMA", "runtime");
  if (evidence.runtime.role !== "runtime" || evidence.runtime.before_after_identity_match !== true) fail("SOURCE_ATTEST_EVIDENCE_SCHEMA", "runtime identity mismatch");
  assertSha256(evidence.runtime.logical_id_sha256, "SOURCE_ATTEST_EVIDENCE_SCHEMA", "runtime.logical_id_sha256");
  assertSha256(evidence.runtime.sha256, "SOURCE_ATTEST_EVIDENCE_SCHEMA", "runtime.sha256");
  assertPlainObject(evidence.auditor, "SOURCE_ATTEST_EVIDENCE_SCHEMA", "auditor");
  assertAllowedKeys(evidence.auditor, new Set(["fixed_auditor_sha256", "fixed_auditor_imports_sha256", "parse_result_count", "compile_result_count", "top_level_statement_count", "source_imported", "source_executed", "candidate_text_reported", "process_contract_sha256"]), "SOURCE_ATTEST_EVIDENCE_SCHEMA", "auditor");
  if (
    evidence.auditor.fixed_auditor_sha256 !== FIXED_SOURCE_AUDITOR_SHA256 ||
    evidence.auditor.fixed_auditor_imports_sha256 !== sha256Hex(Buffer.from(encodeCanonicalJson(["ast", "json", "sys"]), "utf8")) ||
    evidence.auditor.parse_result_count !== 1 ||
    evidence.auditor.compile_result_count !== 1 ||
    !Number.isSafeInteger(evidence.auditor.top_level_statement_count) ||
    evidence.auditor.top_level_statement_count < 1 ||
    evidence.auditor.source_imported !== false ||
    evidence.auditor.source_executed !== false ||
    evidence.auditor.candidate_text_reported !== false
  ) {
    fail("SOURCE_ATTEST_EVIDENCE_SCHEMA", "auditor mismatch");
  }
  assertSha256(evidence.auditor.process_contract_sha256, "SOURCE_ATTEST_EVIDENCE_SCHEMA", "auditor.process_contract_sha256");
  if (!Array.isArray(evidence.limitations) || evidence.limitations.length !== LIMITATIONS.length) fail("SOURCE_ATTEST_EVIDENCE_SCHEMA", "limitations must be exact");
  for (const [index, limitation] of LIMITATIONS.entries()) if (evidence.limitations[index] !== limitation) fail("SOURCE_ATTEST_EVIDENCE_SCHEMA", "limitation mismatch");
  scanForbiddenPublicEvidence(evidence);
  return true;
}

async function writeFixtureRoleFile(root, files, role, relativePath, bytes) {
  const absolute = path.join(root, ...relativePath.split("/"));
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, bytes);
  files.push({
    role,
    logical_id: `source-${role}`,
    relative_path: relativePath,
    sha256: sha256Hex(bytes),
    size_bytes: bytes.length,
  });
  return absolute;
}

async function discoverHostPythonForFixture() {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
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
    const result = await execFileAsync(candidate.command, [...candidate.prefix, "-c", "import sys; raise SystemExit(0 if sys.version_info >= (3,8) else 1)"], { encoding: "utf8", windowsHide: true }).catch(() => undefined);
    if (result) return candidate;
  }
  fail("SOURCE_ATTEST_FIXTURE_PYTHON", "host Python 3.8+ is required for synthetic validation");
}

export async function runSyntheticValidation() {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  const root = await mkdtemp(path.join(tmpdir(), "meetingrelay-source-attest-"));
  try {
    const host = await discoverHostPythonForFixture();
    const venvRoot = path.join(root, "venv");
    await execFileAsync(host.command, [...host.prefix, "-m", "venv", venvRoot], { encoding: "utf8", windowsHide: true });
    const executablePath = process.platform === "win32" ? path.join(venvRoot, "Scripts", "python.exe") : path.join(venvRoot, "bin", "python");
    const runtimeBytes = await readFile(executablePath);
    const files = [];
    for (const role of REQUIRED_ROLES) {
      if (role === "runtime" || role === "sidecar-source") continue;
      await writeFixtureRoleFile(root, files, role, `inputs/${role}.bin`, Buffer.from(`synthetic ${role} bytes\n`, "utf8"));
    }
    files.push({
      role: "runtime",
      logical_id: "source-runtime",
      relative_path: process.platform === "win32" ? "venv/Scripts/python.exe" : "venv/bin/python",
      sha256: sha256Hex(runtimeBytes),
      size_bytes: runtimeBytes.length,
    });
    const referenceBytes = await readFile(REFERENCE_SOURCE_PATH);
    await writeFixtureRoleFile(root, files, "sidecar-source", "inputs/sidecar-source.py", referenceBytes);
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
    const preflight = await import("./sidecar-candidate-preflight.mjs").then((module) => module.preflightCandidate(root, manifestPath));
    return await attestSidecarSource(root, manifestPath, executablePath, preflight.candidate_descriptor.aggregate_sha256);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length === 1 && argv[0] === "--run-synthetic") {
    const evidence = await runSyntheticValidation();
    const evidenceText = encodeCanonicalJson(evidence);
    process.stdout.write(
      `funasr-sidecar-source-attestation=verified evidence_sha256=${sha256Hex(Buffer.from(evidenceText, "utf8"))} candidate_aggregate_sha256=${evidence.candidate_aggregate_sha256} reference_source_sha256=${evidence.reference_source_sha256} auditor_source_sha256=${evidence.auditor.fixed_auditor_sha256} measurement_status=${evidence.measurement_status} execution_status=${evidence.execution_status} source_binding_scope=${evidence.source_binding_scope} git_provenance_authority=none cpython_provenance_authority=none packaging_authority=none quality_gate_status=not-assessed formal_claims=none production_evidence=false public_distribution=false selection_authority=none fixture_scope=test-only-venv-not-packaging-choice\n`,
    );
    return;
  }
  if (argv.length === 5 && argv[0] === "--attest") {
    const evidence = await attestSidecarSource(argv[1], argv[2], argv[3], argv[4]);
    const evidenceText = encodeCanonicalJson(evidence);
    process.stdout.write(
      `funasr-sidecar-source-attestation=verified evidence_sha256=${sha256Hex(Buffer.from(evidenceText, "utf8"))} candidate_aggregate_sha256=${evidence.candidate_aggregate_sha256} reference_source_sha256=${evidence.reference_source_sha256} auditor_source_sha256=${evidence.auditor.fixed_auditor_sha256} measurement_status=${evidence.measurement_status} execution_status=${evidence.execution_status} source_binding_scope=${evidence.source_binding_scope} git_provenance_authority=none cpython_provenance_authority=none packaging_authority=none quality_gate_status=not-assessed formal_claims=none production_evidence=false public_distribution=false selection_authority=none\n`,
    );
    return;
  }
  if (argv.length === 2 && argv[0] === "--validate-json") {
    let evidence;
    try {
      evidence = JSON.parse(argv[1]);
    } catch (error) {
      fail("SOURCE_ATTEST_EVIDENCE_CANONICAL", `evidence must parse as JSON: ${error.message}`);
    }
    if (encodeCanonicalJson(evidence) !== argv[1]) fail("SOURCE_ATTEST_EVIDENCE_CANONICAL", "evidence must be canonical indented JSON with one terminal LF");
    validatePublicEvidence(evidence);
    process.stdout.write(`funasr-sidecar-source-attestation-json=verified evidence_sha256=${sha256Hex(Buffer.from(encodeCanonicalJson(evidence), "utf8"))}\n`);
    return;
  }
  fail("SOURCE_ATTEST_USAGE", "usage: node tools/funasr-sidecar/sidecar-source-attestation.mjs [--run-synthetic]|--attest <controlled-root> <canonical-4b-input-manifest.json> <absolute-python-executable> <expected-candidate-aggregate-sha256>|--validate-json '<canonical-json>'");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.code ?? "SOURCE_ATTEST_FAILED"}: ${error.message}\n`);
    process.exitCode = 1;
  });
}
