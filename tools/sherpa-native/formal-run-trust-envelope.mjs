import { createHash, randomBytes } from "node:crypto";
import { execFile as execFileCallback, spawn } from "node:child_process";
import {
  lstat,
  open,
  readFile,
  realpath,
} from "node:fs/promises";
import path from "node:path";
import { promisify, isDeepStrictEqual } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import { encodeCanonicalJsonLine } from "../phase0-harness/canonical-json.mjs";
import { readPinnedFleursGoldSourcePolicy } from "./fleurs-gold-source.mjs";
import { verifyQualityHostSourceBuildAttestationLive } from "./quality-host-source-build-attestor.mjs";

const execFile = promisify(execFileCallback);
const SCHEMA_VERSION = "1.0";
const POLICY_KIND = "meetingrelay-formal-run-trust-policy-v1";
const ROOT_KIND = "meetingrelay-controlled-root-native-attestation-v1";
const BUILD_KIND = "meetingrelay-quality-host-source-build-attestation-v1";
const CREATE_KIND = "meetingrelay-controlled-root-create-receipt-v1";
const DELETE_KIND = "meetingrelay-controlled-root-delete-receipt-v1";
const READINESS_KIND = "meetingrelay-formal-run-readiness-envelope-v1";
const MAX_JSON_BYTES = 1024 * 1024;
const DIGEST = /^(?!0{64}$)[0-9a-f]{64}$/u;
const COMMIT = /^(?!0{40}$)[0-9a-f]{40}$/u;
const FILE_ID = /^(?!0{32}$)[0-9a-f]{32}$/u;
const POSITIVE_DECIMAL = /^[1-9][0-9]{0,19}$/u;
const UTC_SECONDS = /^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]Z$/u;
const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(MODULE_DIRECTORY, "../..");
const NATIVE_ATTESTOR_PATH = path.join(
  REPOSITORY_ROOT,
  "target/sherpa-native/formal-run-trust/msvc/meetingrelay-windows-controlled-root-attestor.exe",
);
const NATIVE_ATTESTOR_METADATA_PATH = path.join(
  REPOSITORY_ROOT,
  "target/sherpa-native/formal-run-trust/msvc/meetingrelay-windows-controlled-root-attestor.build.json",
);
const NATIVE_ATTESTOR_SOURCE_PATH = path.join(MODULE_DIRECTORY, "windows-controlled-root-attestor.c");

const AUTHORITY = Object.freeze({
  execution_status: "not-run",
  formal_claims: "none",
  materialization_status: "not-run",
  production_evidence: false,
  public_distribution: false,
  quality_gate_status: "not-assessed",
});
const ALLOWED_ACES = Object.freeze([
  Object.freeze({
    inherited: false,
    inheritance: "container-and-object",
    principal: "administrators",
    rights: "full-control",
    type: "allow",
  }),
  Object.freeze({
    inherited: false,
    inheritance: "container-and-object",
    principal: "operator",
    rights: "full-control",
    type: "allow",
  }),
  Object.freeze({
    inherited: false,
    inheritance: "container-and-object",
    principal: "system",
    rights: "full-control",
    type: "allow",
  }),
]);
const FIXED_POLICY = Object.freeze({
  authority: AUTHORITY,
  controlled_root: Object.freeze({
    allowed_aces: ALLOWED_ACES,
    dacl_protected: true,
    drive_type: "fixed",
    filesystem: "NTFS",
    maximum_inventory_entries: 4096,
    owner_principal: "operator",
    reparse_policy: "reject-any-tag",
  }),
  kind: POLICY_KIND,
  quality_host: Object.freeze({
    executable_filename: "meetingrelay-sherpa-candidate-quality-host.exe",
    features: Object.freeze(["native-quality-sample", "native-sherpa"]),
    pe_format: "PE32+",
    pe_machine: "amd64",
    pe_subsystem: "console",
    profile: "release",
    target: "x86_64-pc-windows-msvc",
  }),
  retention: Object.freeze({
    maximum_seconds: 2_592_000,
    mode: "finite-required",
  }),
  schema_version: SCHEMA_VERSION,
});
const FIXED_SOURCE_JOIN = Object.freeze({
  common_id_count: 320,
  configs: Object.freeze(["en_us", "ja_jp", "cmn_hans_cn"]),
  dataset_id: "google/fleurs",
  policy_sha256: "9a659b87a5c12dacf749226d6c51a7be1edbb98c6fae313293c985cbeda1da2c",
  revision: "70bb2e84b976b7e960aa89f1c648e09c59f894dd",
  selected_utterance_count: 960,
  source_contract_status: "frozen-source-readiness",
  split: "test",
});

export class FormalRunTrustEnvelopeError extends Error {
  constructor(code, options = {}) {
    super(code, options);
    this.name = "FormalRunTrustEnvelopeError";
    this.code = code;
  }
}

function fail(code, options = {}) {
  throw new FormalRunTrustEnvelopeError(code, options);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function exactKeys(value, expected, code) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(code);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(code);
  }
}

function assertDigest(value, code = "FORMAL_TRUST_DIGEST") {
  if (typeof value !== "string" || !DIGEST.test(value)) fail(code);
}

function assertCommit(value, code) {
  if (typeof value !== "string" || !COMMIT.test(value)) fail(code);
}

function assertAuthority(value, code) {
  if (!isDeepStrictEqual(value, AUTHORITY)) fail(code);
}

function parseCanonicalJsonLine(bytes, code, maximumBytes = MAX_JSON_BYTES) {
  if (
    !Buffer.isBuffer(bytes) || bytes.length < 3 || bytes.length > maximumBytes ||
    bytes.at(-1) !== 0x0a || bytes.subarray(0, -1).includes(0x0a) ||
    bytes.includes(0x0d) ||
    (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
  ) {
    fail(code);
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail(code);
  }
  if (text.includes("\ufeff") || !Buffer.from(text, "utf8").equals(bytes)) fail(code);
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    fail(code);
  }
  if (encodeCanonicalJsonLine(value) !== text) fail(code);
  return value;
}

function canonicalResult(record) {
  const bytes = Buffer.from(encodeCanonicalJsonLine(record), "utf8");
  return { bytes, record, sha256: sha256(bytes) };
}

function validatePolicyObject(policy) {
  exactKeys(policy, [
    "authority", "controlled_root", "kind", "quality_host", "retention", "schema_version",
  ], "FORMAL_TRUST_POLICY");
  if (!isDeepStrictEqual(policy.authority, AUTHORITY)) fail("FORMAL_TRUST_POLICY_AUTHORITY");
  if (!isDeepStrictEqual(policy, FIXED_POLICY)) fail("FORMAL_TRUST_POLICY");
  return policy;
}

function validateSourceJoin(source, expectedPolicySha256 = FIXED_SOURCE_JOIN.policy_sha256) {
  exactKeys(source, [
    "common_id_count", "configs", "dataset_id", "policy_sha256", "revision",
    "selected_utterance_count", "source_contract_status", "split",
  ], "FORMAL_TRUST_SOURCE_JOIN");
  if (!isDeepStrictEqual(source, { ...FIXED_SOURCE_JOIN, policy_sha256: expectedPolicySha256 })) {
    fail("FORMAL_TRUST_SOURCE_JOIN");
  }
  return source;
}

export function buildFormalRunTrustPolicy(policy = FIXED_POLICY) {
  validatePolicyObject(policy);
  const result = canonicalResult(policy);
  return { bytes: result.bytes, policy, policySha256: result.sha256 };
}

export function validateFormalRunTrustPolicyBytes(bytes) {
  const policy = parseCanonicalJsonLine(bytes, "FORMAL_TRUST_POLICY_CANONICAL", 64 * 1024);
  validatePolicyObject(policy);
  return { bytes, policy, policySha256: sha256(bytes) };
}

async function readStableRegularFile(inputPath, code) {
  if (typeof inputPath !== "string" || !path.isAbsolute(inputPath)) fail(code);
  let before;
  let handle;
  try {
    before = await lstat(inputPath, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink()) fail(code);
    handle = await open(inputPath, "r");
    const openedBefore = await handle.stat({ bigint: true });
    const bytes = await handle.readFile();
    const openedAfter = await handle.stat({ bigint: true });
    const after = await lstat(inputPath, { bigint: true });
    if (
      !after.isFile() || after.isSymbolicLink() ||
      before.dev !== openedBefore.dev || before.ino !== openedBefore.ino ||
      openedBefore.dev !== openedAfter.dev || openedBefore.ino !== openedAfter.ino ||
      openedAfter.dev !== after.dev || openedAfter.ino !== after.ino ||
      openedBefore.size !== openedAfter.size || openedAfter.size !== BigInt(bytes.length) ||
      openedBefore.mtimeNs !== openedAfter.mtimeNs
    ) {
      fail(code);
    }
    return { bytes, stat: openedAfter };
  } catch (error) {
    if (error instanceof FormalRunTrustEnvelopeError) throw error;
    fail(code, { cause: error });
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function readPinnedFormalRunTrustPolicy({ expectedPolicySha256, policyPath }) {
  if (typeof expectedPolicySha256 !== "string" || !DIGEST.test(expectedPolicySha256)) {
    fail("FORMAL_TRUST_POLICY_TRUST_REQUIRED");
  }
  const stable = await readStableRegularFile(policyPath, "FORMAL_TRUST_POLICY_READ");
  const actual = sha256(stable.bytes);
  if (actual !== expectedPolicySha256) fail("FORMAL_TRUST_POLICY_DIGEST_MISMATCH");
  return validateFormalRunTrustPolicyBytes(stable.bytes);
}

function assertWindowsLocalPath(value, code) {
  if (
    typeof value !== "string" || value.length < 4 || value !== value.normalize("NFC") ||
    /[\u0000-\u001f\u007f]/u.test(value) || value.includes("/") ||
    !/^[A-Za-z]:\\[^:]+$/u.test(value) || value.startsWith("\\\\") ||
    value.startsWith("\\\\?\\") || value.startsWith("\\\\.\\") ||
    path.win32.normalize(value) !== value ||
    value.split("\\").slice(1).some((part) => part.length === 0 || part === "." || part === ".." || part.endsWith(" ") || part.endsWith("."))
  ) {
    fail(code);
  }
}

function assertUtcSeconds(value, code) {
  if (typeof value !== "string" || !UTC_SECONDS.test(value)) fail(code);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().replace(".000Z", "Z") !== value) fail(code);
  return parsed;
}

export function validateFormalRunTrustInput(input) {
  exactKeys(input, [
    "buildAttestationPath", "controlledRoot", "expectedBuildAttestationSha256",
    "expectedFleursPolicySha256", "expectedPolicySha256", "expectedQualityHostSha256",
    "expectedSourceCommit", "fleursPolicyPath", "policyPath", "readinessOutputPath",
    "retentionExpiresAt",
  ], "FORMAL_TRUST_INPUT");
  assertWindowsLocalPath(input.controlledRoot, "FORMAL_TRUST_ROOT_PATH");
  for (const key of [
    "buildAttestationPath", "fleursPolicyPath", "policyPath", "readinessOutputPath",
  ]) {
    assertWindowsLocalPath(input[key], "FORMAL_TRUST_INPUT_PATH");
  }
  for (const key of [
    "expectedBuildAttestationSha256", "expectedFleursPolicySha256", "expectedPolicySha256",
    "expectedQualityHostSha256",
  ]) {
    assertDigest(input[key]);
  }
  if (input.expectedFleursPolicySha256 !== FIXED_SOURCE_JOIN.policy_sha256) {
    fail("FORMAL_TRUST_SOURCE_JOIN");
  }
  assertCommit(input.expectedSourceCommit, "FORMAL_TRUST_HOST_SOURCE_COMMIT");
  assertUtcSeconds(input.retentionExpiresAt, "FORMAL_TRUST_RETENTION_FORMAT");
  return input;
}

function validateAceSet(aces, policy) {
  if (!Array.isArray(aces)) fail("FORMAL_TRUST_ROOT_DACL_PRINCIPAL");
  const actualPrincipals = aces.map((ace) => ace?.principal).sort();
  const wantedPrincipals = policy.controlled_root.allowed_aces.map((ace) => ace.principal).sort();
  if (!isDeepStrictEqual(actualPrincipals, wantedPrincipals)) {
    fail("FORMAL_TRUST_ROOT_DACL_PRINCIPAL");
  }
  const ordered = [...aces].sort((left, right) => left.principal.localeCompare(right.principal, "en"));
  if (!isDeepStrictEqual(ordered, policy.controlled_root.allowed_aces)) {
    fail("FORMAL_TRUST_ROOT_DACL_RIGHTS");
  }
}

export function validateNativeControlledRootAttestationBytes(bytes, options) {
  const record = parseCanonicalJsonLine(bytes, "FORMAL_TRUST_ROOT_ATTESTATION");
  const policy = validatePolicyObject(options?.policy);
  assertDigest(options?.expectedPolicySha256);
  assertWindowsLocalPath(options?.controlledRoot, "FORMAL_TRUST_ROOT_PATH");
  exactKeys(record, ["authority", "inventory", "kind", "root", "schema_version"], "FORMAL_TRUST_ROOT_ATTESTATION");
  if (record.kind !== ROOT_KIND || record.schema_version !== SCHEMA_VERSION) fail("FORMAL_TRUST_ROOT_ATTESTATION");
  assertAuthority(record.authority, "FORMAL_TRUST_ROOT_AUTHORITY");
  exactKeys(record.root, [
    "aces", "dacl_protected", "drive_type", "file_id_128", "filesystem",
    "operator_sid_sha256", "owner_principal", "reparse_tag", "root_path_sha256",
    "retention_expires_at", "security_descriptor_sha256", "volume_serial_number",
  ], "FORMAL_TRUST_ROOT_ATTESTATION");
  if (record.root.drive_type !== policy.controlled_root.drive_type) fail("FORMAL_TRUST_ROOT_DRIVE_TYPE");
  if (record.root.filesystem !== policy.controlled_root.filesystem) fail("FORMAL_TRUST_ROOT_FILESYSTEM");
  if (record.root.dacl_protected !== true) fail("FORMAL_TRUST_ROOT_DACL_PROTECTION");
  validateAceSet(record.root.aces, policy);
  if (record.root.owner_principal !== policy.controlled_root.owner_principal) fail("FORMAL_TRUST_ROOT_OWNER");
  if (
    !FILE_ID.test(record.root.file_id_128) ||
    !POSITIVE_DECIMAL.test(record.root.volume_serial_number) ||
    !DIGEST.test(record.root.operator_sid_sha256) ||
    !DIGEST.test(record.root.security_descriptor_sha256) ||
    record.root.root_path_sha256 !== sha256(Buffer.from(options.controlledRoot, "utf8"))
  ) {
    fail("FORMAL_TRUST_ROOT_IDENTITY");
  }
  if (record.root.reparse_tag !== null) fail("FORMAL_TRUST_ROOT_REPARSE");
  assertUtcSeconds(record.root.retention_expires_at, "FORMAL_TRUST_RETENTION_FORMAT");
  if (record.root.retention_expires_at !== options?.expectedRetentionExpiresAt) {
    fail("FORMAL_TRUST_RETENTION_WINDOW");
  }
  exactKeys(record.inventory, ["entries", "entry_count", "sha256"], "FORMAL_TRUST_ROOT_INVENTORY");
  if (
    !Array.isArray(record.inventory.entries) || !Number.isSafeInteger(record.inventory.entry_count) ||
    record.inventory.entry_count < 0 ||
    record.inventory.entry_count > policy.controlled_root.maximum_inventory_entries ||
    (record.inventory.entries.length !== 0 && record.inventory.entry_count !== record.inventory.entries.length) ||
    !DIGEST.test(record.inventory.sha256)
  ) {
    fail("FORMAL_TRUST_ROOT_INVENTORY");
  }
  for (const entry of record.inventory.entries) {
    exactKeys(entry, ["file_id_128", "relative_path_sha256", "reparse_tag"], "FORMAL_TRUST_ROOT_INVENTORY");
    if (entry.reparse_tag !== null) fail("FORMAL_TRUST_ROOT_REPARSE");
    if (!FILE_ID.test(entry.file_id_128) || !DIGEST.test(entry.relative_path_sha256)) {
      fail("FORMAL_TRUST_ROOT_INVENTORY");
    }
  }
  return { bytes, record, sha256: sha256(bytes) };
}

export function validateQualityHostBuildAttestationBytes(bytes, options) {
  const record = parseCanonicalJsonLine(bytes, "FORMAL_TRUST_HOST_ATTESTATION");
  const policy = validatePolicyObject(options?.policy);
  assertDigest(options?.expectedPolicySha256);
  exactKeys(record, ["authority", "cargo", "executable", "kind", "schema_version", "source", "toolchain"], "FORMAL_TRUST_HOST_ATTESTATION");
  if (record.kind !== BUILD_KIND || record.schema_version !== SCHEMA_VERSION) fail("FORMAL_TRUST_HOST_ATTESTATION");
  assertAuthority(record.authority, "FORMAL_TRUST_HOST_AUTHORITY");
  exactKeys(record.cargo, ["features", "lock_sha256", "profile"], "FORMAL_TRUST_HOST_ATTESTATION");
  if (record.cargo.profile !== policy.quality_host.profile) fail("FORMAL_TRUST_HOST_PROFILE");
  if (!isDeepStrictEqual(record.cargo.features, policy.quality_host.features)) fail("FORMAL_TRUST_HOST_FEATURES");
  assertDigest(options?.expectedCargoLockSha256);
  if (record.cargo.lock_sha256 !== options.expectedCargoLockSha256) {
    fail("FORMAL_TRUST_HOST_CARGO_LOCK");
  }
  exactKeys(record.source, ["commit", "tree_sha256", "worktree_status"], "FORMAL_TRUST_HOST_ATTESTATION");
  if (record.source.worktree_status !== "clean") fail("FORMAL_TRUST_HOST_SOURCE_DIRTY");
  if (record.source.commit !== options?.expectedSourceCommit) fail("FORMAL_TRUST_HOST_SOURCE_COMMIT");
  assertDigest(options?.expectedSourceTreeSha256);
  if (record.source.tree_sha256 !== options?.expectedSourceTreeSha256) fail("FORMAL_TRUST_HOST_SOURCE_TREE");
  exactKeys(record.toolchain, [
    "cargo_executable_sha256", "cargo_v_sha256", "git_executable_sha256",
    "rustc_executable_sha256", "rustc_vv_sha256", "target",
  ], "FORMAL_TRUST_HOST_ATTESTATION");
  if (record.toolchain.target !== policy.quality_host.target) fail("FORMAL_TRUST_HOST_TARGET");
  for (const [field, expected] of [
    ["cargo_executable_sha256", options?.expectedCargoExecutableSha256],
    ["cargo_v_sha256", options?.expectedCargoVSha256],
    ["git_executable_sha256", options?.expectedGitExecutableSha256],
    ["rustc_executable_sha256", options?.expectedRustcExecutableSha256],
  ]) {
    assertDigest(expected);
    if (record.toolchain[field] !== expected) fail("FORMAL_TRUST_HOST_TOOLCHAIN");
  }
  assertDigest(options?.expectedRustcVvSha256);
  if (record.toolchain.rustc_vv_sha256 !== options.expectedRustcVvSha256) {
    fail("FORMAL_TRUST_HOST_RUSTC");
  }
  exactKeys(record.executable, [
    "filename", "imports", "pe_format", "pe_machine", "pe_subsystem",
    "required_dll_characteristics", "runtime_bundle_sha256", "sha256", "size_bytes",
  ], "FORMAL_TRUST_HOST_ATTESTATION");
  if (record.executable.sha256 !== options?.expectedExecutableSha256 ||
      record.executable.filename !== policy.quality_host.executable_filename ||
      !Number.isSafeInteger(record.executable.size_bytes) || record.executable.size_bytes < 1) {
    fail("FORMAL_TRUST_HOST_EXECUTABLE");
  }
  if (
    record.executable.pe_format !== policy.quality_host.pe_format ||
    record.executable.pe_machine !== policy.quality_host.pe_machine ||
    record.executable.pe_subsystem !== policy.quality_host.pe_subsystem
  ) {
    fail("FORMAL_TRUST_HOST_PE");
  }
  if (!isDeepStrictEqual(record.executable.required_dll_characteristics, [
    "DYNAMIC_BASE", "GUARD_CF", "HIGH_ENTROPY_VA", "NX_COMPAT",
  ]) || !Array.isArray(record.executable.imports) || record.executable.imports.length < 1 ||
      record.executable.imports.length > 64 ||
      !record.executable.imports.includes("sherpa-onnx-c-api.dll")) {
    fail("FORMAL_TRUST_HOST_PE");
  }
  const sortedImports = [...record.executable.imports].sort((left, right) =>
    Buffer.compare(Buffer.from(left, "ascii"), Buffer.from(right, "ascii")));
  if (!isDeepStrictEqual(record.executable.imports, sortedImports) ||
      new Set(record.executable.imports).size !== record.executable.imports.length ||
      record.executable.imports.some((name) => typeof name !== "string" ||
        !/^[a-z0-9._-]+\.dll$/u.test(name))) {
    fail("FORMAL_TRUST_HOST_PE");
  }
  assertDigest(options?.expectedRuntimeBundleSha256);
  if (record.executable.runtime_bundle_sha256 !== options.expectedRuntimeBundleSha256) {
    fail("FORMAL_TRUST_HOST_RUNTIME");
  }
  return { bytes, record, sha256: sha256(bytes) };
}

export function validateCleanupCreateReceiptBytes(bytes, options) {
  const record = parseCanonicalJsonLine(bytes, "FORMAL_TRUST_CLEANUP_RECEIPT");
  exactKeys(record, [
    "artifact_identity", "authority", "created_at", "kind", "policy_sha256",
    "receipt_scope", "retention_expires_at", "root_identity", "schema_version",
  ], "FORMAL_TRUST_CLEANUP_RECEIPT");
  if (record.kind !== CREATE_KIND || record.schema_version !== SCHEMA_VERSION) fail("FORMAL_TRUST_CLEANUP_RECEIPT");
  assertAuthority(record.authority, "FORMAL_TRUST_CLEANUP_RECEIPT");
  const createdAt = assertUtcSeconds(record.created_at, "FORMAL_TRUST_CLEANUP_RECEIPT");
  const retentionExpiresAt = assertUtcSeconds(
    record.retention_expires_at,
    "FORMAL_TRUST_CLEANUP_RECEIPT",
  );
  const retentionWindowMilliseconds = retentionExpiresAt.getTime() - createdAt.getTime();
  if (retentionWindowMilliseconds <= 0) {
    fail("FORMAL_TRUST_RETENTION_EXPIRED");
  }
  if (retentionWindowMilliseconds > FIXED_POLICY.retention.maximum_seconds * 1000) {
    fail("FORMAL_TRUST_RETENTION_WINDOW");
  }
  if (![
    "controlled-artifact-ownership", "formal-readiness-capability-probe",
  ].includes(record.receipt_scope) ||
      (options?.expectedReceiptScope !== undefined && record.receipt_scope !== options.expectedReceiptScope)) {
    fail("FORMAL_TRUST_CLEANUP_RECEIPT");
  }
  if (record.policy_sha256 !== options?.expectedPolicySha256) fail("FORMAL_TRUST_CLEANUP_RECEIPT");
  exactKeys(record.artifact_identity, [
    "content_sha256", "file_id_128", "hard_link_count", "relative_name_sha256", "size_bytes",
  ], "FORMAL_TRUST_CLEANUP_RECEIPT");
  if (
    !DIGEST.test(record.artifact_identity.content_sha256) ||
    !FILE_ID.test(record.artifact_identity.file_id_128) ||
    record.artifact_identity.hard_link_count !== 1 ||
    !DIGEST.test(record.artifact_identity.relative_name_sha256) ||
    !Number.isSafeInteger(record.artifact_identity.size_bytes) || record.artifact_identity.size_bytes < 1 ||
    (options?.expectedArtifactFileId128 !== undefined && record.artifact_identity.file_id_128 !== options.expectedArtifactFileId128) ||
    (options?.expectedContentSha256 !== undefined && record.artifact_identity.content_sha256 !== options.expectedContentSha256) ||
    (options?.expectedRelativeNameSha256 !== undefined && record.artifact_identity.relative_name_sha256 !== options.expectedRelativeNameSha256) ||
    (options?.expectedSizeBytes !== undefined && record.artifact_identity.size_bytes !== options.expectedSizeBytes)
  ) {
    fail("FORMAL_TRUST_CLEANUP_IDENTITY");
  }
  exactKeys(record.root_identity, ["file_id_128", "security_descriptor_sha256", "volume_serial_number"], "FORMAL_TRUST_CLEANUP_RECEIPT");
  if (
    !FILE_ID.test(record.root_identity.file_id_128) ||
    !DIGEST.test(record.root_identity.security_descriptor_sha256) ||
    !POSITIVE_DECIMAL.test(record.root_identity.volume_serial_number) ||
    (options?.expectedRootFileId128 !== undefined && record.root_identity.file_id_128 !== options.expectedRootFileId128) ||
    (options?.expectedVolumeSerialNumber !== undefined && record.root_identity.volume_serial_number !== options.expectedVolumeSerialNumber)
  ) {
    fail("FORMAL_TRUST_CLEANUP_IDENTITY");
  }
  return { bytes, record, sha256: sha256(bytes) };
}

export function validateCleanupDeleteReceiptBytes(bytes, options) {
  const record = parseCanonicalJsonLine(bytes, "FORMAL_TRUST_CLEANUP_RECEIPT");
  exactKeys(record, [
    "authority", "cleanup", "create_receipt_sha256", "deleted_at", "kind",
    "policy_sha256", "receipt_scope", "schema_version",
  ], "FORMAL_TRUST_CLEANUP_RECEIPT");
  if (record.kind !== DELETE_KIND || record.schema_version !== SCHEMA_VERSION) fail("FORMAL_TRUST_CLEANUP_RECEIPT");
  assertAuthority(record.authority, "FORMAL_TRUST_CLEANUP_RECEIPT");
  assertUtcSeconds(record.deleted_at, "FORMAL_TRUST_CLEANUP_RECEIPT");
  if (![
    "formal-readiness-capability-probe", "retention-enforced-cleanup",
  ].includes(record.receipt_scope) ||
      (options?.expectedReceiptScope !== undefined && record.receipt_scope !== options.expectedReceiptScope)) {
    fail("FORMAL_TRUST_CLEANUP_RECEIPT");
  }
  if (record.policy_sha256 !== options?.expectedPolicySha256 ||
      record.create_receipt_sha256 !== options?.expectedCreateReceiptSha256) {
    fail("FORMAL_TRUST_CLEANUP_RECEIPT");
  }
  exactKeys(record.cleanup, [
    "content_sha256", "deleted_file_id_128", "deletion_method", "link_count_before",
    "relative_name_sha256", "replacement_status", "secure_erase", "size_bytes",
    "volume_serial_number",
  ], "FORMAL_TRUST_CLEANUP_RECEIPT");
  if (record.cleanup.deletion_method !== "set-file-information-by-handle") {
    fail("FORMAL_TRUST_CLEANUP_HANDLE_DELETE");
  }
  if (!FILE_ID.test(record.cleanup.deleted_file_id_128) ||
      (options?.expectedDeletedFileId128 !== undefined && record.cleanup.deleted_file_id_128 !== options.expectedDeletedFileId128)) {
    fail("FORMAL_TRUST_CLEANUP_IDENTITY");
  }
  if (
    !DIGEST.test(record.cleanup.content_sha256) || !DIGEST.test(record.cleanup.relative_name_sha256) ||
    record.cleanup.link_count_before !== 1 || record.cleanup.replacement_status !== "not-present" ||
    record.cleanup.secure_erase !== false || !Number.isSafeInteger(record.cleanup.size_bytes) ||
    record.cleanup.size_bytes < 1 || !POSITIVE_DECIMAL.test(record.cleanup.volume_serial_number) ||
    (options?.expectedContentSha256 !== undefined && record.cleanup.content_sha256 !== options.expectedContentSha256) ||
    (options?.expectedRelativeNameSha256 !== undefined && record.cleanup.relative_name_sha256 !== options.expectedRelativeNameSha256) ||
    (options?.expectedSizeBytes !== undefined && record.cleanup.size_bytes !== options.expectedSizeBytes)
  ) {
    fail("FORMAL_TRUST_CLEANUP_RECEIPT");
  }
  return { bytes, record, sha256: sha256(bytes) };
}

function buildRetention(retention, policy) {
  exactKeys(retention, ["expires_at", "validated_at"], "FORMAL_TRUST_RETENTION_FORMAT");
  const validated = assertUtcSeconds(retention.validated_at, "FORMAL_TRUST_RETENTION_FORMAT");
  const expires = assertUtcSeconds(retention.expires_at, "FORMAL_TRUST_RETENTION_FORMAT");
  const windowMilliseconds = expires.getTime() - validated.getTime();
  if (windowMilliseconds <= 0) fail("FORMAL_TRUST_RETENTION_EXPIRED");
  if (windowMilliseconds > policy.retention.maximum_seconds * 1000) fail("FORMAL_TRUST_RETENTION_WINDOW");
  return {
    expires_at: retention.expires_at,
    maximum_seconds: policy.retention.maximum_seconds,
    validated_at: retention.validated_at,
  };
}

export function buildFormalRunReadinessEnvelope(input) {
  exactKeys(input, [
    "buildAttestation", "buildAttestationSha256", "createReceipt", "createReceiptSha256",
    "deleteReceipt", "deleteReceiptSha256", "nativeRootAttestation", "policy",
    "policySha256", "retention", "source",
  ], "FORMAL_TRUST_READINESS");
  const policy = validatePolicyObject(input.policy);
  for (const digest of [
    input.buildAttestationSha256, input.createReceiptSha256, input.deleteReceiptSha256,
    input.policySha256,
  ]) {
    assertDigest(digest);
  }
  const root = input.nativeRootAttestation;
  const build = input.buildAttestation;
  const create = input.createReceipt;
  const deletion = input.deleteReceipt;
  const source = validateSourceJoin(input.source);
  if (
    root?.kind !== ROOT_KIND || build?.kind !== BUILD_KIND || create?.kind !== CREATE_KIND ||
    deletion?.kind !== DELETE_KIND
  ) {
    fail("FORMAL_TRUST_READINESS");
  }
  if (
    create.policy_sha256 !== input.policySha256 ||
    create.root_identity.file_id_128 !== root.root.file_id_128 ||
    create.root_identity.security_descriptor_sha256 !== root.root.security_descriptor_sha256 ||
    create.root_identity.volume_serial_number !== root.root.volume_serial_number
  ) {
    fail("FORMAL_TRUST_READINESS_ROOT_JOIN");
  }
  if (root.root.retention_expires_at !== input.retention.expires_at) {
    fail("FORMAL_TRUST_RETENTION_WINDOW");
  }
  validateCleanupCreateReceiptBytes(Buffer.from(encodeCanonicalJsonLine(create), "utf8"), {
    expectedArtifactFileId128: create.artifact_identity?.file_id_128,
    expectedContentSha256: create.artifact_identity?.content_sha256,
    expectedPolicySha256: input.policySha256,
    expectedReceiptScope: "formal-readiness-capability-probe",
    expectedRelativeNameSha256: create.artifact_identity?.relative_name_sha256,
    expectedRootFileId128: root.root.file_id_128,
    expectedSizeBytes: create.artifact_identity?.size_bytes,
    expectedVolumeSerialNumber: root.root.volume_serial_number,
  });
  validateCleanupDeleteReceiptBytes(Buffer.from(encodeCanonicalJsonLine(deletion), "utf8"), {
    expectedContentSha256: create.artifact_identity.content_sha256,
    expectedCreateReceiptSha256: input.createReceiptSha256,
    expectedDeletedFileId128: create.artifact_identity.file_id_128,
    expectedPolicySha256: input.policySha256,
    expectedReceiptScope: "formal-readiness-capability-probe",
    expectedRelativeNameSha256: create.artifact_identity.relative_name_sha256,
    expectedSizeBytes: create.artifact_identity.size_bytes,
  });
  if (new Date(deletion.deleted_at).getTime() < new Date(create.created_at).getTime()) {
    fail("FORMAL_TRUST_CLEANUP_RECEIPT");
  }
  if (create.retention_expires_at !== input.retention.expires_at) {
    fail("FORMAL_TRUST_RETENTION_WINDOW");
  }
  const record = {
    authority: { ...AUTHORITY },
    controlled_root: {
      attestation_sha256: sha256(Buffer.from(encodeCanonicalJsonLine(root), "utf8")),
      create_receipt_sha256: input.createReceiptSha256,
      delete_receipt_sha256: input.deleteReceiptSha256,
      file_id_128: root.root.file_id_128,
      inventory_entry_count: root.inventory.entry_count,
      inventory_sha256: root.inventory.sha256,
      volume_serial_number: root.root.volume_serial_number,
    },
    kind: READINESS_KIND,
    policy_sha256: input.policySha256,
    quality_host: {
      build_attestation_sha256: input.buildAttestationSha256,
      executable_sha256: build.executable.sha256,
      imports_sha256: sha256(Buffer.from(encodeCanonicalJsonLine(build.executable.imports), "utf8")),
      pe_hardening_status: "required-flags-present",
      runtime_bundle_sha256: build.executable.runtime_bundle_sha256,
      source_commit: build.source.commit,
      source_tree_sha256: build.source.tree_sha256,
      toolchain_sha256: sha256(Buffer.from(encodeCanonicalJsonLine(build.toolchain), "utf8")),
    },
    readiness_status: "ready-for-materialization-only",
    retention: buildRetention(input.retention, policy),
    schema_version: SCHEMA_VERSION,
    source,
  };
  return canonicalResult(record);
}

export function validateFormalRunReadinessEnvelopeBytes(bytes, options) {
  const record = parseCanonicalJsonLine(bytes, "FORMAL_TRUST_READINESS");
  exactKeys(record, [
    "authority", "controlled_root", "kind", "policy_sha256", "quality_host",
    "readiness_status", "retention", "schema_version", "source",
  ], "FORMAL_TRUST_READINESS");
  if (record.kind !== READINESS_KIND || record.schema_version !== SCHEMA_VERSION ||
      record.readiness_status !== "ready-for-materialization-only") {
    fail("FORMAL_TRUST_READINESS");
  }
  assertAuthority(record.authority, "FORMAL_TRUST_READINESS_AUTHORITY");
  if (record.policy_sha256 !== options?.expectedPolicySha256) fail("FORMAL_TRUST_READINESS_POLICY");
  exactKeys(record.controlled_root, [
    "attestation_sha256", "create_receipt_sha256", "delete_receipt_sha256", "file_id_128",
    "inventory_entry_count", "inventory_sha256", "volume_serial_number",
  ], "FORMAL_TRUST_READINESS");
  if (record.controlled_root.create_receipt_sha256 !== options?.expectedCreateReceiptSha256) {
    fail("FORMAL_TRUST_READINESS_ROOT_JOIN");
  }
  if (record.controlled_root.delete_receipt_sha256 !== options?.expectedDeleteReceiptSha256) {
    fail("FORMAL_TRUST_READINESS_ROOT_JOIN");
  }
  assertDigest(record.controlled_root.attestation_sha256);
  assertDigest(record.controlled_root.inventory_sha256);
  if (!FILE_ID.test(record.controlled_root.file_id_128) ||
      !POSITIVE_DECIMAL.test(record.controlled_root.volume_serial_number) ||
      !Number.isSafeInteger(record.controlled_root.inventory_entry_count) || record.controlled_root.inventory_entry_count < 0) {
    fail("FORMAL_TRUST_READINESS");
  }
  exactKeys(record.quality_host, [
    "build_attestation_sha256", "executable_sha256", "imports_sha256",
    "pe_hardening_status", "runtime_bundle_sha256", "source_commit", "source_tree_sha256",
    "toolchain_sha256",
  ], "FORMAL_TRUST_READINESS");
  if (record.quality_host.build_attestation_sha256 !== options?.expectedBuildAttestationSha256) {
    fail("FORMAL_TRUST_READINESS_BUILD_JOIN");
  }
  for (const value of [
    record.quality_host.executable_sha256, record.quality_host.imports_sha256,
    record.quality_host.runtime_bundle_sha256, record.quality_host.source_tree_sha256,
    record.quality_host.toolchain_sha256,
  ]) assertDigest(value);
  if (record.quality_host.pe_hardening_status !== "required-flags-present") {
    fail("FORMAL_TRUST_HOST_PE");
  }
  assertCommit(record.quality_host.source_commit, "FORMAL_TRUST_READINESS");
  validateSourceJoin(record.source, options?.expectedFleursPolicySha256);
  exactKeys(record.retention, ["expires_at", "maximum_seconds", "validated_at"], "FORMAL_TRUST_READINESS");
  if (record.retention.maximum_seconds !== FIXED_POLICY.retention.maximum_seconds) fail("FORMAL_TRUST_RETENTION_WINDOW");
  buildRetention({ expires_at: record.retention.expires_at, validated_at: record.retention.validated_at }, FIXED_POLICY);
  const current = assertUtcSeconds(options?.currentTime, "FORMAL_TRUST_RETENTION_FORMAT");
  if (current.getTime() >= new Date(record.retention.expires_at).getTime()) {
    fail("FORMAL_TRUST_RETENTION_EXPIRED");
  }
  return { bytes, record, sha256: sha256(bytes) };
}

async function publishReadiness(outputPath, bytes, operations) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || typeof outputPath !== "string" || !path.isAbsolute(outputPath)) {
    fail("FORMAL_TRUST_READINESS_PUBLICATION");
  }
  const parentPath = path.dirname(outputPath);
  let parentBefore;
  try {
    const canonicalParent = await realpath(parentPath);
    parentBefore = await lstat(parentPath, { bigint: true });
    const canonicalParentBefore = await lstat(canonicalParent, { bigint: true });
    if (
      !parentBefore.isDirectory() || parentBefore.isSymbolicLink() ||
      !canonicalParentBefore.isDirectory() || canonicalParentBefore.isSymbolicLink() ||
      parentBefore.dev !== canonicalParentBefore.dev ||
      parentBefore.ino !== canonicalParentBefore.ino
    ) {
      fail("FORMAL_TRUST_READINESS_PUBLICATION");
    }
    let current = parentPath;
    while (true) {
      const currentStat = await lstat(current, { bigint: true });
      if (currentStat.isSymbolicLink()) fail("FORMAL_TRUST_READINESS_PUBLICATION");
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  } catch (error) {
    if (error instanceof FormalRunTrustEnvelopeError) throw error;
    fail("FORMAL_TRUST_READINESS_PUBLICATION", { cause: error });
  }
  let handle;
  let createdStat;
  try {
    handle = await open(outputPath, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    createdStat = await handle.stat({ bigint: true });
    await handle.close();
    handle = undefined;
  } catch (error) {
    await handle?.close().catch(() => {});
    if (error instanceof FormalRunTrustEnvelopeError) throw error;
    fail("FORMAL_TRUST_READINESS_PUBLICATION", { cause: error });
  }
  await operations.afterCreateNew?.({ outputPath, bytes });
  let persisted;
  let after;
  try {
    const stable = await readStableRegularFile(outputPath, "FORMAL_TRUST_READINESS_POSTFLIGHT");
    persisted = stable.bytes;
    after = stable.stat;
    const parentAfter = await lstat(parentPath, { bigint: true });
    const canonicalParentAfter = await realpath(parentPath);
    const canonicalParentAfterStat = await lstat(canonicalParentAfter, { bigint: true });
    if (
      !parentAfter.isDirectory() || parentAfter.isSymbolicLink() ||
      !canonicalParentAfterStat.isDirectory() || canonicalParentAfterStat.isSymbolicLink() ||
      parentAfter.dev !== parentBefore.dev || parentAfter.ino !== parentBefore.ino ||
      parentAfter.dev !== canonicalParentAfterStat.dev ||
      parentAfter.ino !== canonicalParentAfterStat.ino
    ) {
      fail("FORMAL_TRUST_READINESS_POSTFLIGHT");
    }
  } catch (error) {
    fail("FORMAL_TRUST_READINESS_POSTFLIGHT", { cause: error });
  }
  if (
    !after.isFile() || after.isSymbolicLink() || after.dev !== createdStat.dev ||
    after.ino !== createdStat.ino || after.size !== createdStat.size || !persisted.equals(bytes)
  ) {
    fail("FORMAL_TRUST_READINESS_POSTFLIGHT");
  }
  return { bytes: persisted, sha256: sha256(persisted), sizeBytes: persisted.length };
}

export async function __publishFormalRunReadinessEnvelopeForTest(outputPath, bytes, operations = {}) {
  return publishReadiness(outputPath, bytes, operations);
}

export async function publishFormalRunReadinessEnvelope(outputPath, bytes) {
  return publishReadiness(outputPath, bytes, {});
}

function secondsTimestamp(date) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) fail("FORMAL_TRUST_RETENTION_FORMAT");
  return new Date(Math.floor(date.getTime() / 1000) * 1000).toISOString().replace(".000Z", "Z");
}

function createAssessmentClock(clock) {
  if (typeof clock !== "function") fail("FORMAL_TRUST_RETENTION_FORMAT");
  let lastTimestampMilliseconds = Number.NEGATIVE_INFINITY;
  return () => {
    const timestamp = secondsTimestamp(clock());
    const timestampMilliseconds = Date.parse(timestamp);
    if (timestampMilliseconds < lastTimestampMilliseconds) {
      fail("FORMAL_TRUST_CLOCK_ROLLBACK");
    }
    lastTimestampMilliseconds = timestampMilliseconds;
    return timestamp;
  };
}

async function assess(input, dependencies) {
  validateFormalRunTrustInput(input);
  const currentAssessmentTime = createAssessmentClock(dependencies.clock);
  const validatedAt = currentAssessmentTime();
  const pinned = await dependencies.policyReader(input);
  if (pinned.policySha256 !== input.expectedPolicySha256) fail("FORMAL_TRUST_POLICY_DIGEST_MISMATCH");
  validatePolicyObject(pinned.policy);
  const pinnedSource = await dependencies.sourcePolicyReader(input);
  if (pinnedSource.policySha256 !== input.expectedFleursPolicySha256) {
    fail("FORMAL_TRUST_SOURCE_JOIN");
  }
  validateSourceJoin(pinnedSource.source, input.expectedFleursPolicySha256);

  const nativeBytes = await dependencies.nativeRootAttestor(input);
  const native = validateNativeControlledRootAttestationBytes(nativeBytes, {
    controlledRoot: input.controlledRoot,
    expectedPolicySha256: input.expectedPolicySha256,
    expectedRetentionExpiresAt: input.retentionExpiresAt,
    policy: pinned.policy,
  });

  const buildRead = await dependencies.buildAttestationReader(input);
  if (buildRead.sha256 !== input.expectedBuildAttestationSha256) fail("FORMAL_TRUST_HOST_ATTESTATION_DIGEST");
  const build = validateQualityHostBuildAttestationBytes(buildRead.bytes, {
    expectedCargoExecutableSha256: buildRead.expected?.cargoExecutableSha256,
    expectedCargoLockSha256: buildRead.expected?.cargoLockSha256,
    expectedCargoVSha256: buildRead.expected?.cargoVSha256,
    expectedExecutableSha256: input.expectedQualityHostSha256,
    expectedGitExecutableSha256: buildRead.expected?.gitExecutableSha256,
    expectedPolicySha256: input.expectedPolicySha256,
    expectedRuntimeBundleSha256: buildRead.expected?.runtimeBundleSha256,
    expectedRustcExecutableSha256: buildRead.expected?.rustcExecutableSha256,
    expectedRustcVvSha256: buildRead.expected?.rustcVvSha256,
    expectedSourceCommit: input.expectedSourceCommit,
    expectedSourceTreeSha256: buildRead.expected?.sourceTreeSha256,
    policy: pinned.policy,
  });

  const lifecycle = await dependencies.createReceiptReader({
    input,
    nativeRootAttestation: native.record,
    validatedAt,
  });
  const untrustedCreate = parseCanonicalJsonLine(
    lifecycle.createBytes,
    "FORMAL_TRUST_CLEANUP_RECEIPT",
  );
  const create = validateCleanupCreateReceiptBytes(lifecycle.createBytes, {
    expectedArtifactFileId128: untrustedCreate.artifact_identity?.file_id_128,
    expectedContentSha256: untrustedCreate.artifact_identity?.content_sha256,
    expectedPolicySha256: input.expectedPolicySha256,
    expectedReceiptScope: "formal-readiness-capability-probe",
    expectedRelativeNameSha256: untrustedCreate.artifact_identity?.relative_name_sha256,
    expectedRootFileId128: native.record.root.file_id_128,
    expectedSizeBytes: untrustedCreate.artifact_identity?.size_bytes,
    expectedVolumeSerialNumber: native.record.root.volume_serial_number,
  });
  const deletion = validateCleanupDeleteReceiptBytes(lifecycle.deleteBytes, {
    expectedContentSha256: create.record.artifact_identity.content_sha256,
    expectedCreateReceiptSha256: lifecycle.createSha256,
    expectedDeletedFileId128: create.record.artifact_identity.file_id_128,
    expectedPolicySha256: input.expectedPolicySha256,
    expectedReceiptScope: "formal-readiness-capability-probe",
    expectedRelativeNameSha256: create.record.artifact_identity.relative_name_sha256,
    expectedSizeBytes: create.record.artifact_identity.size_bytes,
  });
  if (
    dependencies.requireComputedDigests === true &&
    (lifecycle.createSha256 !== create.sha256 || lifecycle.deleteSha256 !== deletion.sha256)
  ) {
    fail("FORMAL_TRUST_CLEANUP_RECEIPT");
  }
  const postProbeBytes = await dependencies.nativeRootAttestor(input);
  validateNativeControlledRootAttestationBytes(postProbeBytes, {
    controlledRoot: input.controlledRoot,
    expectedPolicySha256: input.expectedPolicySha256,
    expectedRetentionExpiresAt: input.retentionExpiresAt,
    policy: pinned.policy,
  });
  if (!postProbeBytes.equals(nativeBytes)) fail("FORMAL_TRUST_ROOT_POSTFLIGHT");
  const built = buildFormalRunReadinessEnvelope({
    buildAttestation: build.record,
    buildAttestationSha256: input.expectedBuildAttestationSha256,
    createReceipt: create.record,
    createReceiptSha256: lifecycle.createSha256,
    deleteReceipt: deletion.record,
    deleteReceiptSha256: lifecycle.deleteSha256,
    nativeRootAttestation: native.record,
    policy: pinned.policy,
    policySha256: input.expectedPolicySha256,
    retention: { expires_at: input.retentionExpiresAt, validated_at: validatedAt },
    source: pinnedSource.source,
  });
  const finalRootBytes = await dependencies.nativeRootAttestor(input);
  validateNativeControlledRootAttestationBytes(finalRootBytes, {
    controlledRoot: input.controlledRoot,
    expectedPolicySha256: input.expectedPolicySha256,
    expectedRetentionExpiresAt: input.retentionExpiresAt,
    policy: pinned.policy,
  });
  if (!finalRootBytes.equals(nativeBytes)) fail("FORMAL_TRUST_ROOT_POSTFLIGHT");
  const finalSource = await dependencies.sourcePolicyReader(input);
  if (finalSource.policySha256 !== pinnedSource.policySha256 ||
      !isDeepStrictEqual(finalSource.source, pinnedSource.source)) {
    fail("FORMAL_TRUST_SOURCE_POSTFLIGHT");
  }
  validateFormalRunReadinessEnvelopeBytes(built.bytes, {
    expectedBuildAttestationSha256: input.expectedBuildAttestationSha256,
    currentTime: currentAssessmentTime(),
    expectedCreateReceiptSha256: lifecycle.createSha256,
    expectedDeleteReceiptSha256: lifecycle.deleteSha256,
    expectedFleursPolicySha256: input.expectedFleursPolicySha256,
    expectedPolicySha256: input.expectedPolicySha256,
  });
  await dependencies.readinessPublisher(input.readinessOutputPath, built.bytes);
  const reread = await dependencies.readinessReader({ bytes: built.bytes, input });
  return validateFormalRunReadinessEnvelopeBytes(reread.bytes, {
    expectedBuildAttestationSha256: input.expectedBuildAttestationSha256,
    currentTime: currentAssessmentTime(),
    expectedCreateReceiptSha256: lifecycle.createSha256,
    expectedDeleteReceiptSha256: lifecycle.deleteSha256,
    expectedFleursPolicySha256: input.expectedFleursPolicySha256,
    expectedPolicySha256: input.expectedPolicySha256,
  });
}

export async function __assessFormalRunReadinessForTest(input, dependencies) {
  return assess(input, dependencies);
}

function validateCleanupInput(input, expectedReceiptScope) {
  exactKeys(input, [
    "controlledRoot", "createReceipt", "createReceiptSha256", "expectedPolicySha256",
    "relativePath",
  ], "FORMAL_TRUST_CLEANUP_INPUT");
  assertWindowsLocalPath(input.controlledRoot, "FORMAL_TRUST_ROOT_PATH");
  for (const digest of [input.createReceiptSha256, input.expectedPolicySha256]) assertDigest(digest);
  if (typeof input.relativePath !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(input.relativePath) ||
      input.relativePath === ".meetingrelay-retention-v1") {
    fail("FORMAL_TRUST_CLEANUP_PATH");
  }
  const createBytes = Buffer.from(encodeCanonicalJsonLine(input.createReceipt), "utf8");
  const create = validateCleanupCreateReceiptBytes(createBytes, {
    expectedArtifactFileId128: input.createReceipt?.artifact_identity?.file_id_128,
    expectedContentSha256: input.createReceipt?.artifact_identity?.content_sha256,
    expectedPolicySha256: input.expectedPolicySha256,
    expectedReceiptScope,
    expectedRelativeNameSha256: sha256(Buffer.from(input.relativePath, "utf8")),
    expectedRootFileId128: input.createReceipt?.root_identity?.file_id_128,
    expectedSizeBytes: input.createReceipt?.artifact_identity?.size_bytes,
    expectedVolumeSerialNumber: input.createReceipt?.root_identity?.volume_serial_number,
  });
  return { create, input };
}

async function cleanup(input, dependencies) {
  const validatedInput = validateCleanupInput(input, dependencies.requiredCreateReceiptScope);
  const create = validatedInput.create.record;
  if (dependencies.requireComputedDigests === true &&
      sha256(validatedInput.create.bytes) !== input.createReceiptSha256) {
    fail("FORMAL_TRUST_CLEANUP_RECEIPT");
  }
  const now = dependencies.clock();
  const expiry = assertUtcSeconds(create.retention_expires_at, "FORMAL_TRUST_RETENTION_FORMAT");
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) fail("FORMAL_TRUST_RETENTION_FORMAT");
  if (now.getTime() < expiry.getTime()) fail("FORMAL_TRUST_CLEANUP_NOT_DUE");
  const native = await dependencies.nativeDeleteByHandle({
    ...input,
    expectedContentSha256: create.artifact_identity.content_sha256,
    expectedFileId128: create.artifact_identity.file_id_128,
    expectedRelativeNameSha256: create.artifact_identity.relative_name_sha256,
    expectedRootFileId128: create.root_identity.file_id_128,
    expectedSizeBytes: create.artifact_identity.size_bytes,
    expectedVolumeSerialNumber: create.root_identity.volume_serial_number,
  });
  if (native?.linkCountBefore !== 1) fail("FORMAL_TRUST_CLEANUP_LINK_COUNT");
  if (
    native.deletedFileId128 !== create.artifact_identity.file_id_128 ||
    native.contentSha256 !== create.artifact_identity.content_sha256 ||
    native.relativeNameSha256 !== create.artifact_identity.relative_name_sha256 ||
    native.sizeBytes !== create.artifact_identity.size_bytes ||
    native.volumeSerialNumber !== create.root_identity.volume_serial_number
  ) fail("FORMAL_TRUST_CLEANUP_IDENTITY");
  if (native.deletionMethod !== "set-file-information-by-handle") fail("FORMAL_TRUST_CLEANUP_HANDLE_DELETE");
  const record = {
    authority: { ...AUTHORITY },
    cleanup: {
      content_sha256: native.contentSha256,
      deleted_file_id_128: native.deletedFileId128,
      deletion_method: native.deletionMethod,
      link_count_before: native.linkCountBefore,
      relative_name_sha256: native.relativeNameSha256,
      replacement_status: native.replacementStatus,
      secure_erase: false,
      size_bytes: native.sizeBytes,
      volume_serial_number: native.volumeSerialNumber,
    },
    create_receipt_sha256: input.createReceiptSha256,
    deleted_at: secondsTimestamp(now),
    kind: DELETE_KIND,
    policy_sha256: input.expectedPolicySha256,
    receipt_scope: dependencies.deleteReceiptScope ?? "retention-enforced-cleanup",
    schema_version: SCHEMA_VERSION,
  };
  const built = canonicalResult(record);
  validateCleanupDeleteReceiptBytes(built.bytes, {
    expectedContentSha256: create.artifact_identity.content_sha256,
    expectedCreateReceiptSha256: input.createReceiptSha256,
    expectedDeletedFileId128: create.artifact_identity.file_id_128,
    expectedPolicySha256: input.expectedPolicySha256,
    expectedReceiptScope: dependencies.deleteReceiptScope ?? "retention-enforced-cleanup",
    expectedRelativeNameSha256: create.artifact_identity.relative_name_sha256,
    expectedSizeBytes: create.artifact_identity.size_bytes,
  });
  await dependencies.receiptPublisher?.({ ...built, input });
  return built;
}

export async function __cleanupControlledArtifactForTest(input, dependencies) {
  return cleanup(input, dependencies);
}

function parseReceiptLine(stdout, expectedMarker) {
  const text = Buffer.isBuffer(stdout) ? new TextDecoder("utf-8", { fatal: true }).decode(stdout) : String(stdout);
  if (!text.endsWith("\n") || text.includes("\r") || text.indexOf("\n") !== text.length - 1) {
    fail("FORMAL_TRUST_NATIVE_RECEIPT");
  }
  if (/[^\x20-\x7e\n]/u.test(text)) fail("FORMAL_TRUST_NATIVE_RECEIPT");
  const tokens = text.trimEnd().split(" ");
  if (tokens.length < 2 || tokens.shift() !== expectedMarker) fail("FORMAL_TRUST_NATIVE_RECEIPT");
  const fields = {};
  for (const part of tokens) {
    const index = part.indexOf("=");
    if (index < 1 || index === part.length - 1 || part.indexOf("=", index + 1) !== -1) {
      fail("FORMAL_TRUST_NATIVE_RECEIPT");
    }
    const key = part.slice(0, index);
    if (!/^[a-z][a-z0-9_]*$/u.test(key) || Object.hasOwn(fields, key)) {
      fail("FORMAL_TRUST_NATIVE_RECEIPT");
    }
    fields[key] = part.slice(index + 1);
  }
  return fields;
}

async function validateNativeAttestorBuild() {
  const metadataRead = await readStableRegularFile(
    NATIVE_ATTESTOR_METADATA_PATH,
    "FORMAL_TRUST_NATIVE_BUILD",
  );
  let metadata;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(metadataRead.bytes);
    if (text.includes("\ufeff")) fail("FORMAL_TRUST_NATIVE_BUILD");
    metadata = JSON.parse(text);
  } catch (error) {
    if (error instanceof FormalRunTrustEnvelopeError) throw error;
    fail("FORMAL_TRUST_NATIVE_BUILD", { cause: error });
  }
  exactKeys(metadata, [
    "artifact", "build", "compiler", "executable_hash_scope", "kind", "schema_version", "source",
  ], "FORMAL_TRUST_NATIVE_BUILD");
  if (
    metadata.kind !== "meetingrelay-windows-controlled-root-attestor-build-v1" ||
    metadata.schema_version !== SCHEMA_VERSION ||
    metadata.executable_hash_scope !== "local-build-identity-only-not-cross-toolchain-reproducibility" ||
    metadata.source?.relative_path !== "tools/sherpa-native/windows-controlled-root-attestor.c" ||
    metadata.artifact?.relative_path !==
      "target/sherpa-native/formal-run-trust/msvc/meetingrelay-windows-controlled-root-attestor.exe" ||
    metadata.compiler?.family !== "msvc" || metadata.compiler?.host_architecture !== "x64" ||
    metadata.compiler?.target_architecture !== "x64" ||
    metadata.build?.language !== "c17" ||
    !isDeepStrictEqual(metadata.build?.compile_flags, [
      "/nologo", "/TC", "/std:c17", "/W4", "/WX", "/O2", "/MT", "/GS",
      "/DUNICODE", "/D_UNICODE",
    ]) ||
    !isDeepStrictEqual(metadata.build?.link_flags, [
      "/INCREMENTAL:NO", "/DYNAMICBASE", "/HIGHENTROPYVA", "/NXCOMPAT", "/guard:cf",
    ]) ||
    !isDeepStrictEqual(metadata.build?.system_libraries, ["advapi32.lib"]) ||
    metadata.artifact?.pe?.machine !== "0x8664" ||
    metadata.artifact?.pe?.machine_name !== "AMD64" ||
    metadata.artifact?.pe?.optional_header_magic !== "0x020b" ||
    !isDeepStrictEqual(metadata.artifact?.pe?.required_dll_characteristics, [
      "DYNAMIC_BASE", "HIGH_ENTROPY_VA", "NX_COMPAT", "GUARD_CF",
    ])
  ) {
    fail("FORMAL_TRUST_NATIVE_BUILD");
  }
  const [sourceRead, executableRead, compilerRead] = await Promise.all([
    readStableRegularFile(NATIVE_ATTESTOR_SOURCE_PATH, "FORMAL_TRUST_NATIVE_BUILD"),
    readStableRegularFile(NATIVE_ATTESTOR_PATH, "FORMAL_TRUST_NATIVE_BUILD"),
    readStableRegularFile(metadata.compiler.path, "FORMAL_TRUST_NATIVE_BUILD"),
  ]);
  if (
    sha256(sourceRead.bytes) !== metadata.source.sha256 ||
    sha256(executableRead.bytes) !== metadata.artifact.sha256 ||
    executableRead.bytes.length !== metadata.artifact.size_bytes ||
    sha256(compilerRead.bytes) !== metadata.compiler.sha256
  ) {
    fail("FORMAL_TRUST_NATIVE_BUILD");
  }
  return {
    executablePath: NATIVE_ATTESTOR_PATH,
    executableSha256: metadata.artifact.sha256,
    metadataSha256: sha256(metadataRead.bytes),
  };
}

async function invokeNativeAttestor(input) {
  const trustedBuild = await validateNativeAttestorBuild();
  const executable = trustedBuild.executablePath;
  let result;
  try {
    result = await execFile(executable, ["attest", input.controlledRoot], {
      encoding: "buffer",
      windowsHide: true,
      maxBuffer: MAX_JSON_BYTES,
    });
  } catch (error) {
    fail("FORMAL_TRUST_ROOT_ATTESTATION", { cause: error });
  }
  const postBuild = await validateNativeAttestorBuild();
  if (!isDeepStrictEqual(postBuild, trustedBuild)) fail("FORMAL_TRUST_NATIVE_BUILD_POSTFLIGHT");
  const fields = parseReceiptLine(result.stdout, "CONTROLLED_ROOT_ATTESTATION=PASS");
  const expectedFields = [
    "volume_serial", "root_file_id", "owner_sid_sha256", "dacl_sha256", "ace_count",
    "inventory_sha256", "inventory_count", "inventory_bytes", "retention_marker",
    "retention_expires_unix_seconds", "filesystem", "drive_type", "protected_dacl",
    "reparse_count",
  ];
  if (!isDeepStrictEqual(Object.keys(fields), expectedFields)) fail("FORMAL_TRUST_ROOT_ATTESTATION");
  const retentionSeconds = Date.parse(input.retentionExpiresAt) / 1000;
  if (
    !/^[0-9a-f]{16}$/u.test(fields.volume_serial) || fields.volume_serial === "0000000000000000" ||
    !FILE_ID.test(fields.root_file_id) || !DIGEST.test(fields.owner_sid_sha256) ||
    !DIGEST.test(fields.dacl_sha256) || fields.ace_count !== "3" ||
    !DIGEST.test(fields.inventory_sha256) || !/^(?:0|[1-9][0-9]{0,3})$/u.test(fields.inventory_count) ||
    !/^(?:0|[1-9][0-9]{0,19})$/u.test(fields.inventory_bytes) ||
    fields.retention_marker !== "present" ||
    fields.retention_expires_unix_seconds !== String(retentionSeconds) ||
    fields.filesystem !== "NTFS" || fields.drive_type !== "fixed" ||
    fields.protected_dacl !== "true" || fields.reparse_count !== "0" ||
    Number(fields.inventory_count) > FIXED_POLICY.controlled_root.maximum_inventory_entries
  ) {
    fail("FORMAL_TRUST_ROOT_ATTESTATION");
  }
  const record = {
    authority: { ...AUTHORITY },
    inventory: {
      entries: [],
      entry_count: Number(fields.inventory_count),
      sha256: fields.inventory_sha256,
    },
    kind: ROOT_KIND,
    root: {
      aces: ALLOWED_ACES.map((ace) => ({ ...ace })),
      dacl_protected: true,
      drive_type: "fixed",
      file_id_128: fields.root_file_id,
      filesystem: "NTFS",
      operator_sid_sha256: fields.owner_sid_sha256,
      owner_principal: "operator",
      reparse_tag: null,
      retention_expires_at: input.retentionExpiresAt,
      root_path_sha256: sha256(Buffer.from(input.controlledRoot, "utf8")),
      security_descriptor_sha256: fields.dacl_sha256,
      volume_serial_number: BigInt(`0x${fields.volume_serial}`).toString(),
    },
    schema_version: SCHEMA_VERSION,
  };
  return Buffer.from(encodeCanonicalJsonLine(record), "utf8");
}

async function defaultBuildAttestationReader(input) {
  const stable = await readStableRegularFile(input.buildAttestationPath, "FORMAL_TRUST_HOST_ATTESTATION");
  const digest = sha256(stable.bytes);
  if (digest !== input.expectedBuildAttestationSha256) fail("FORMAL_TRUST_HOST_ATTESTATION_DIGEST");
  let live;
  try {
    live = await verifyQualityHostSourceBuildAttestationLive({
      bytes: stable.bytes,
      expectedSourceCommit: input.expectedSourceCommit,
    });
  } catch (error) {
    fail("FORMAL_TRUST_HOST_LIVE_VERIFICATION", { cause: error });
  }
  if (live.sha256 !== digest) {
    fail("FORMAL_TRUST_HOST_LIVE_VERIFICATION");
  }
  return {
    bytes: stable.bytes,
    expected: {
      cargoExecutableSha256: live.record.toolchain.cargo_executable_sha256,
      cargoLockSha256: live.record.cargo.lock_sha256,
      cargoVSha256: live.record.toolchain.cargo_v_sha256,
      gitExecutableSha256: live.record.toolchain.git_executable_sha256,
      runtimeBundleSha256: live.record.executable.runtime_bundle_sha256,
      rustcExecutableSha256: live.record.toolchain.rustc_executable_sha256,
      rustcVvSha256: live.record.toolchain.rustc_vv_sha256,
      sourceTreeSha256: live.record.source.tree_sha256,
    },
    sha256: digest,
  };
}

async function defaultSourcePolicyReader(input) {
  const pinned = await readPinnedFleursGoldSourcePolicy({
    expectedPolicySha256: input.expectedFleursPolicySha256,
    policyPath: input.fleursPolicyPath,
  });
  const source = {
    common_id_count: pinned.policy.selection.common_id_count,
    configs: pinned.policy.sources.map((entry) => entry.config),
    dataset_id: pinned.policy.dataset.dataset_id,
    policy_sha256: pinned.policySha256,
    revision: pinned.policy.dataset.revision,
    selected_utterance_count: pinned.policy.selection.selected_utterance_count,
    source_contract_status: pinned.policy.source_contract_status,
    split: pinned.policy.dataset.split,
  };
  validateSourceJoin(source, input.expectedFleursPolicySha256);
  return { policySha256: pinned.policySha256, source };
}

const MUTATION_RECEIPT_FIELDS = Object.freeze([
  "volume_serial", "root_file_id", "file_id", "content_sha256", "size_bytes",
  "relative_name_sha256", "hard_link_count", "operation",
]);

async function invokeNativeProcess(argumentsList, inputBytes = undefined) {
  const trustedBuild = await validateNativeAttestorBuild();
  const result = await new Promise((resolve, reject) => {
    const child = spawn(trustedBuild.executablePath, argumentsList, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    let stdoutLength = 0;
    let stderrLength = 0;
    child.once("error", reject);
    child.stdout.on("data", (chunk) => {
      stdoutLength += chunk.length;
      if (stdoutLength > MAX_JSON_BYTES) child.kill();
      else stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrLength += chunk.length;
      if (stderrLength > MAX_JSON_BYTES) child.kill();
      else stderr.push(chunk);
    });
    child.once("close", (code, signal) => {
      const output = { code, signal, stderr: Buffer.concat(stderr), stdout: Buffer.concat(stdout) };
      if (code !== 0 || signal !== null || stdoutLength > MAX_JSON_BYTES || stderrLength > MAX_JSON_BYTES) {
        reject(new Error("native attestor failed closed"));
      } else {
        resolve(output);
      }
    });
    child.stdin.end(inputBytes);
  }).catch((error) => fail("FORMAL_TRUST_NATIVE_RECEIPT", { cause: error }));
  if (result.stderr.length !== 0) fail("FORMAL_TRUST_NATIVE_RECEIPT");
  const postBuild = await validateNativeAttestorBuild();
  if (!isDeepStrictEqual(postBuild, trustedBuild)) fail("FORMAL_TRUST_NATIVE_BUILD_POSTFLIGHT");
  return result.stdout;
}

function validateMutationFields(fields, expected) {
  if (!isDeepStrictEqual(Object.keys(fields), MUTATION_RECEIPT_FIELDS) ||
      fields.volume_serial !== expected.volumeSerialHex ||
      fields.root_file_id !== expected.rootFileId128 ||
      !FILE_ID.test(fields.file_id) || fields.content_sha256 !== expected.contentSha256 ||
      fields.size_bytes !== String(expected.sizeBytes) ||
      fields.relative_name_sha256 !== expected.relativeNameSha256 ||
      fields.hard_link_count !== "1" || fields.operation !== expected.operation) {
    fail("FORMAL_TRUST_NATIVE_RECEIPT");
  }
}

async function defaultCreateReceiptReader({ input, nativeRootAttestation, validatedAt }) {
  const leaf = `formal-trust-probe-${randomBytes(16).toString("hex")}.bin`;
  const payload = Buffer.from("meetingrelay-formal-run-trust-capability-probe-v1\n", "utf8");
  const contentSha256 = sha256(payload);
  const relativeNameSha256 = sha256(Buffer.from(leaf, "utf8"));
  const volumeSerialHex = BigInt(nativeRootAttestation.root.volume_serial_number)
    .toString(16)
    .padStart(16, "0");
  const retentionSeconds = String(Date.parse(input.retentionExpiresAt) / 1000);
  const createFields = parseReceiptLine(
    await invokeNativeProcess([
      "create", input.controlledRoot, leaf, contentSha256, String(payload.length),
    ], payload),
    "CONTROLLED_ROOT_CREATE=PASS",
  );
  validateMutationFields(createFields, {
    contentSha256,
    operation: "create-new-flushed",
    relativeNameSha256,
    rootFileId128: nativeRootAttestation.root.file_id_128,
    sizeBytes: payload.length,
    volumeSerialHex,
  });
  const createRecord = {
    artifact_identity: {
      content_sha256: contentSha256,
      file_id_128: createFields.file_id,
      hard_link_count: 1,
      relative_name_sha256: relativeNameSha256,
      size_bytes: payload.length,
    },
    authority: { ...AUTHORITY },
    created_at: validatedAt,
    kind: CREATE_KIND,
    policy_sha256: input.expectedPolicySha256,
    receipt_scope: "formal-readiness-capability-probe",
    retention_expires_at: input.retentionExpiresAt,
    root_identity: {
      file_id_128: nativeRootAttestation.root.file_id_128,
      security_descriptor_sha256: nativeRootAttestation.root.security_descriptor_sha256,
      volume_serial_number: nativeRootAttestation.root.volume_serial_number,
    },
    schema_version: SCHEMA_VERSION,
  };
  const create = canonicalResult(createRecord);
  const deleteFields = parseReceiptLine(
    await invokeNativeProcess([
      "probe-delete", input.controlledRoot, leaf, volumeSerialHex,
      nativeRootAttestation.root.file_id_128, createFields.file_id, contentSha256,
      String(payload.length), retentionSeconds,
    ]),
    "CONTROLLED_ROOT_DELETE=PASS",
  );
  validateMutationFields(deleteFields, {
    contentSha256,
    operation: "handle-disposition-probe-delete",
    relativeNameSha256,
    rootFileId128: nativeRootAttestation.root.file_id_128,
    sizeBytes: payload.length,
    volumeSerialHex,
  });
  if (deleteFields.file_id !== createFields.file_id) fail("FORMAL_TRUST_CLEANUP_IDENTITY");
  try {
    await lstat(path.win32.join(input.controlledRoot, leaf));
    fail("FORMAL_TRUST_CLEANUP_POSTFLIGHT");
  } catch (error) {
    if (error instanceof FormalRunTrustEnvelopeError) throw error;
    if (error?.code !== "ENOENT") fail("FORMAL_TRUST_CLEANUP_POSTFLIGHT", { cause: error });
  }
  const deletion = canonicalResult({
    authority: { ...AUTHORITY },
    cleanup: {
      content_sha256: contentSha256,
      deleted_file_id_128: deleteFields.file_id,
      deletion_method: "set-file-information-by-handle",
      link_count_before: 1,
      relative_name_sha256: relativeNameSha256,
      replacement_status: "not-present",
      secure_erase: false,
      size_bytes: payload.length,
      volume_serial_number: nativeRootAttestation.root.volume_serial_number,
    },
    create_receipt_sha256: create.sha256,
    deleted_at: validatedAt,
    kind: DELETE_KIND,
    policy_sha256: input.expectedPolicySha256,
    receipt_scope: "formal-readiness-capability-probe",
    schema_version: SCHEMA_VERSION,
  });
  return {
    createBytes: create.bytes,
    createSha256: create.sha256,
    deleteBytes: deletion.bytes,
    deleteSha256: deletion.sha256,
  };
}

async function defaultReadinessReader({ input }) {
  return readStableRegularFile(input.readinessOutputPath, "FORMAL_TRUST_READINESS_POSTFLIGHT");
}

export async function assessFormalRunReadiness(input) {
  return assess(input, {
    buildAttestationReader: defaultBuildAttestationReader,
    clock: () => new Date(),
    createReceiptReader: defaultCreateReceiptReader,
    nativeRootAttestor: invokeNativeAttestor,
    policyReader: ({ expectedPolicySha256, policyPath }) =>
      readPinnedFormalRunTrustPolicy({ expectedPolicySha256, policyPath }),
    readinessPublisher: publishFormalRunReadinessEnvelope,
    readinessReader: defaultReadinessReader,
    requireComputedDigests: true,
    sourcePolicyReader: defaultSourcePolicyReader,
  });
}

async function invokeNativeDelete(input) {
  const target = path.win32.join(input.controlledRoot, input.relativePath);
  const stable = await readStableRegularFile(target, "FORMAL_TRUST_CLEANUP_IDENTITY");
  if (sha256(stable.bytes) !== input.expectedContentSha256 ||
      stable.bytes.length !== input.expectedSizeBytes) {
    fail("FORMAL_TRUST_CLEANUP_IDENTITY");
  }
  const volumeSerialHex = BigInt(input.expectedVolumeSerialNumber).toString(16).padStart(16, "0");
  const retentionSeconds = String(Date.parse(input.createReceipt.retention_expires_at) / 1000);
  const fields = parseReceiptLine(
    await invokeNativeProcess([
      "cleanup-delete", input.controlledRoot, input.relativePath, volumeSerialHex,
      input.expectedRootFileId128, input.expectedFileId128, input.expectedContentSha256,
      String(input.expectedSizeBytes), retentionSeconds,
    ]),
    "CONTROLLED_ROOT_DELETE=PASS",
  );
  validateMutationFields(fields, {
    contentSha256: input.expectedContentSha256,
    operation: "handle-disposition-cleanup-delete",
    relativeNameSha256: input.expectedRelativeNameSha256,
    rootFileId128: input.expectedRootFileId128,
    sizeBytes: input.expectedSizeBytes,
    volumeSerialHex,
  });
  if (fields.file_id !== input.expectedFileId128) fail("FORMAL_TRUST_CLEANUP_IDENTITY");
  return {
    contentSha256: fields.content_sha256,
    deletedFileId128: fields.file_id,
    deletionMethod: fields.operation === "handle-disposition-cleanup-delete"
      ? "set-file-information-by-handle"
      : fields.operation,
    linkCountBefore: Number(fields.hard_link_count),
    relativeNameSha256: fields.relative_name_sha256,
    replacementStatus: "not-present",
    sizeBytes: Number(fields.size_bytes),
    volumeSerialNumber: input.expectedVolumeSerialNumber,
  };
}

export async function cleanupControlledArtifact(input) {
  exactKeys(input, [
    "controlledRoot", "createReceiptPath", "expectedCreateReceiptSha256",
    "expectedPolicySha256", "relativePath",
  ], "FORMAL_TRUST_CLEANUP_INPUT");
  assertDigest(input.expectedCreateReceiptSha256);
  assertDigest(input.expectedPolicySha256);
  const stable = await readStableRegularFile(input.createReceiptPath, "FORMAL_TRUST_CLEANUP_RECEIPT");
  if (sha256(stable.bytes) !== input.expectedCreateReceiptSha256) {
    fail("FORMAL_TRUST_CLEANUP_RECEIPT");
  }
  const parsed = parseCanonicalJsonLine(stable.bytes, "FORMAL_TRUST_CLEANUP_RECEIPT");
  return cleanup({
    controlledRoot: input.controlledRoot,
    createReceipt: parsed,
    createReceiptSha256: input.expectedCreateReceiptSha256,
    expectedPolicySha256: input.expectedPolicySha256,
    relativePath: input.relativePath,
  }, {
    clock: () => new Date(),
    deleteReceiptScope: "retention-enforced-cleanup",
    nativeDeleteByHandle: invokeNativeDelete,
    requiredCreateReceiptScope: "controlled-artifact-ownership",
    requireComputedDigests: true,
  });
}

async function main(args) {
  if (args.length !== 2 || args[0] !== "--assess") fail("FORMAL_TRUST_USAGE");
  const inputBytes = await readFile(path.resolve(args[1]));
  const input = parseCanonicalJsonLine(inputBytes, "FORMAL_TRUST_INPUT");
  const result = await assessFormalRunReadiness(input);
  process.stdout.write(
    `FORMAL_RUN_READINESS=PASS evidence_sha256=${result.sha256} readiness_status=ready-for-materialization-only formal_claims=none production_evidence=false\n`,
  );
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    const code = error instanceof FormalRunTrustEnvelopeError ? error.code : "FORMAL_TRUST_UNEXPECTED";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}
