import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { encodeCanonicalJsonLine } from "../phase0-harness/canonical-json.mjs";

const SUBJECT_URL = new URL("./formal-run-trust-envelope.mjs", import.meta.url);
let subject;
let moduleLoadError = null;
try {
  subject = await import(SUBJECT_URL);
} catch (error) {
  moduleLoadError = error;
}

const IMPLEMENTATION_OPTIONS = moduleLoadError === null
  ? {}
  : { skip: "formal-run trust implementation is intentionally absent during RED" };

const ZERO_SHA256 = "0".repeat(64);
const COMMITTED_POLICY_SHA256 = "2bc5219213567d9b8bebb5bbd3e52eba8d5c21a26533a7ec8042fa6505a6e160";
const POLICY_SHA256 = "1".repeat(64);
const FLEURS_POLICY_SHA256 = "9a659b87a5c12dacf749226d6c51a7be1edbb98c6fae313293c985cbeda1da2c";
const BUILD_ATTESTATION_SHA256 = "2".repeat(64);
const QUALITY_HOST_SHA256 = "3".repeat(64);
const SOURCE_TREE_SHA256 = "4".repeat(64);
const CARGO_LOCK_SHA256 = "5".repeat(64);
const RUSTC_VV_SHA256 = "6".repeat(64);
const CARGO_V_SHA256 = "a".repeat(64);
const CARGO_EXECUTABLE_SHA256 = "b".repeat(64);
const GIT_EXECUTABLE_SHA256 = "c".repeat(64);
const RUSTC_EXECUTABLE_SHA256 = "d".repeat(64);
const RUNTIME_BUNDLE_SHA256 = "7".repeat(64);
const SECURITY_DESCRIPTOR_SHA256 = "8".repeat(64);
const OPERATOR_SID_SHA256 = "9".repeat(64);
const INVENTORY_SHA256 = "a".repeat(64);
const CREATE_RECEIPT_SHA256 = "b".repeat(64);
const DELETE_RECEIPT_SHA256 = "c".repeat(64);
const SOURCE_COMMIT = "d".repeat(40);
const PROBE_CONTENT_SHA256 = "e".repeat(64);
const PROBE_RELATIVE_NAME_SHA256 = sha256(Buffer.from("private-ledger.jsonl", "utf8"));
const PROBE_FILE_ID_128 = "ffeeddccbbaa99887766554433221100";
const PROBE_SIZE_BYTES = 42;
const ROOT_PATH = "C:\\MeetingRelay-Controlled\\formal-run-001";
const POLICY_PATH = "C:\\MeetingRelay-Policy\\formal-run-trust-policy.json";
const FLEURS_POLICY_PATH = "C:\\MeetingRelay-Policy\\fleurs-gold-source-policy.json";
const BUILD_ATTESTATION_PATH =
  "C:\\MeetingRelay-Policy\\quality-host-build-attestation.json";
const READINESS_PATH = "C:\\MeetingRelay-Evidence\\formal-run-readiness.json";
const VALIDATED_AT = "2026-07-16T00:00:00Z";
const THIRTY_DAYS_LATER = "2026-08-15T00:00:00Z";

const AUTHORITY = Object.freeze({
  execution_status: "not-run",
  formal_claims: "none",
  materialization_status: "not-run",
  production_evidence: false,
  public_distribution: false,
  quality_gate_status: "not-assessed",
});
const QUALITY_HOST_IMPORTS = Object.freeze([
  "api-ms-win-core-synch-l1-2-0.dll",
  "api-ms-win-crt-heap-l1-1-0.dll",
  "api-ms-win-crt-locale-l1-1-0.dll",
  "api-ms-win-crt-math-l1-1-0.dll",
  "api-ms-win-crt-runtime-l1-1-0.dll",
  "api-ms-win-crt-stdio-l1-1-0.dll",
  "api-ms-win-crt-string-l1-1-0.dll",
  "kernel32.dll",
  "ntdll.dll",
  "sherpa-onnx-c-api.dll",
  "vcruntime140.dll",
]);

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

const POLICY = Object.freeze({
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
  kind: "meetingrelay-formal-run-trust-policy-v1",
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
  schema_version: "1.0",
});

const PRIVATE_INPUT = Object.freeze({
  buildAttestationPath: BUILD_ATTESTATION_PATH,
  controlledRoot: ROOT_PATH,
  expectedBuildAttestationSha256: BUILD_ATTESTATION_SHA256,
  expectedFleursPolicySha256: FLEURS_POLICY_SHA256,
  expectedPolicySha256: POLICY_SHA256,
  expectedQualityHostSha256: QUALITY_HOST_SHA256,
  expectedSourceCommit: SOURCE_COMMIT,
  fleursPolicyPath: FLEURS_POLICY_PATH,
  policyPath: POLICY_PATH,
  readinessOutputPath: READINESS_PATH,
  retentionExpiresAt: THIRTY_DAYS_LATER,
});

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonical(value) {
  return Buffer.from(encodeCanonicalJsonLine(value), "utf8");
}

function clone(value) {
  return structuredClone(value);
}

function subjectTest(name, callback) {
  test(name, IMPLEMENTATION_OPTIONS, callback);
}

function api(name) {
  const value = subject?.[name];
  assert.notEqual(value, undefined, `missing export ${name}`);
  return value;
}

async function expectCode(action, code) {
  const ErrorClass = subject?.FormalRunTrustEnvelopeError;
  await assert.rejects(
    Promise.resolve().then(action),
    (error) =>
      (typeof ErrorClass !== "function" || error instanceof ErrorClass) &&
      error?.code === code,
    `expected ${code}`,
  );
}

function nativeRootAttestation() {
  return {
    authority: { ...AUTHORITY },
    inventory: {
      entries: [],
      entry_count: 0,
      sha256: INVENTORY_SHA256,
    },
    kind: "meetingrelay-controlled-root-native-attestation-v1",
    root: {
      aces: clone(ALLOWED_ACES),
      dacl_protected: true,
      drive_type: "fixed",
      file_id_128: "00112233445566778899aabbccddeeff",
      filesystem: "NTFS",
      operator_sid_sha256: OPERATOR_SID_SHA256,
      owner_principal: "operator",
      reparse_tag: null,
      retention_expires_at: THIRTY_DAYS_LATER,
      root_path_sha256: sha256(Buffer.from(ROOT_PATH, "utf8")),
      security_descriptor_sha256: SECURITY_DESCRIPTOR_SHA256,
      volume_serial_number: "123456789",
    },
    schema_version: "1.0",
  };
}

function buildAttestation() {
  return {
    authority: { ...AUTHORITY },
    cargo: {
      features: ["native-quality-sample", "native-sherpa"],
      lock_sha256: CARGO_LOCK_SHA256,
      profile: "release",
    },
    executable: {
      filename: "meetingrelay-sherpa-candidate-quality-host.exe",
      imports: [...QUALITY_HOST_IMPORTS],
      pe_format: "PE32+",
      pe_machine: "amd64",
      pe_subsystem: "console",
      required_dll_characteristics: [
        "DYNAMIC_BASE", "GUARD_CF", "HIGH_ENTROPY_VA", "NX_COMPAT",
      ],
      runtime_bundle_sha256: RUNTIME_BUNDLE_SHA256,
      sha256: QUALITY_HOST_SHA256,
      size_bytes: 1_048_576,
    },
    kind: "meetingrelay-quality-host-source-build-attestation-v1",
    schema_version: "1.0",
    source: {
      commit: SOURCE_COMMIT,
      tree_sha256: SOURCE_TREE_SHA256,
      worktree_status: "clean",
    },
    toolchain: {
      cargo_executable_sha256: CARGO_EXECUTABLE_SHA256,
      cargo_v_sha256: CARGO_V_SHA256,
      git_executable_sha256: GIT_EXECUTABLE_SHA256,
      rustc_executable_sha256: RUSTC_EXECUTABLE_SHA256,
      rustc_vv_sha256: RUSTC_VV_SHA256,
      target: "x86_64-pc-windows-msvc",
    },
  };
}

function createReceipt() {
  return {
    authority: { ...AUTHORITY },
    artifact_identity: {
      content_sha256: PROBE_CONTENT_SHA256,
      file_id_128: PROBE_FILE_ID_128,
      hard_link_count: 1,
      relative_name_sha256: PROBE_RELATIVE_NAME_SHA256,
      size_bytes: PROBE_SIZE_BYTES,
    },
    created_at: VALIDATED_AT,
    kind: "meetingrelay-controlled-root-create-receipt-v1",
    policy_sha256: POLICY_SHA256,
    receipt_scope: "formal-readiness-capability-probe",
    retention_expires_at: THIRTY_DAYS_LATER,
    root_identity: {
      file_id_128: "00112233445566778899aabbccddeeff",
      security_descriptor_sha256: SECURITY_DESCRIPTOR_SHA256,
      volume_serial_number: "123456789",
    },
    schema_version: "1.0",
  };
}

function deleteReceipt() {
  return {
    authority: { ...AUTHORITY },
    cleanup: {
      content_sha256: PROBE_CONTENT_SHA256,
      deletion_method: "set-file-information-by-handle",
      deleted_file_id_128: PROBE_FILE_ID_128,
      link_count_before: 1,
      relative_name_sha256: PROBE_RELATIVE_NAME_SHA256,
      replacement_status: "not-present",
      secure_erase: false,
      size_bytes: PROBE_SIZE_BYTES,
      volume_serial_number: "123456789",
    },
    create_receipt_sha256: CREATE_RECEIPT_SHA256,
    deleted_at: VALIDATED_AT,
    kind: "meetingrelay-controlled-root-delete-receipt-v1",
    policy_sha256: POLICY_SHA256,
    receipt_scope: "formal-readiness-capability-probe",
    schema_version: "1.0",
  };
}

function readinessBuildInput() {
  return {
    buildAttestation: buildAttestation(),
    buildAttestationSha256: BUILD_ATTESTATION_SHA256,
    createReceipt: createReceipt(),
    createReceiptSha256: CREATE_RECEIPT_SHA256,
    deleteReceipt: deleteReceipt(),
    deleteReceiptSha256: DELETE_RECEIPT_SHA256,
    nativeRootAttestation: nativeRootAttestation(),
    policy: clone(POLICY),
    policySha256: POLICY_SHA256,
    retention: { expires_at: THIRTY_DAYS_LATER, validated_at: VALIDATED_AT },
    source: fleursSourceJoin(),
  };
}

function fleursSourceJoin() {
  return {
    common_id_count: 320,
    configs: ["en_us", "ja_jp", "cmn_hans_cn"],
    dataset_id: "google/fleurs",
    policy_sha256: FLEURS_POLICY_SHA256,
    revision: "70bb2e84b976b7e960aa89f1c648e09c59f894dd",
    selected_utterance_count: 960,
    source_contract_status: "frozen-source-readiness",
    split: "test",
  };
}

function validationOptions() {
  return {
    controlledRoot: ROOT_PATH,
    expectedPolicySha256: POLICY_SHA256,
    expectedRetentionExpiresAt: THIRTY_DAYS_LATER,
    policy: clone(POLICY),
  };
}

function buildValidationOptions() {
  return {
    expectedCargoExecutableSha256: CARGO_EXECUTABLE_SHA256,
    expectedCargoLockSha256: CARGO_LOCK_SHA256,
    expectedCargoVSha256: CARGO_V_SHA256,
    expectedExecutableSha256: QUALITY_HOST_SHA256,
    expectedGitExecutableSha256: GIT_EXECUTABLE_SHA256,
    expectedPolicySha256: POLICY_SHA256,
    expectedRuntimeBundleSha256: RUNTIME_BUNDLE_SHA256,
    expectedRustcExecutableSha256: RUSTC_EXECUTABLE_SHA256,
    expectedRustcVvSha256: RUSTC_VV_SHA256,
    expectedSourceCommit: SOURCE_COMMIT,
    expectedSourceTreeSha256: SOURCE_TREE_SHA256,
    policy: clone(POLICY),
  };
}

function assessmentDependencies({
  calls = [],
  clock = () => new Date(VALIDATED_AT),
  readinessPublisher = async () => { calls.push("publish"); },
} = {}) {
  return {
    buildAttestationReader: async () => {
      calls.push("build-attestation");
      return {
        bytes: canonical(buildAttestation()),
        expected: {
          cargoExecutableSha256: CARGO_EXECUTABLE_SHA256,
          cargoLockSha256: CARGO_LOCK_SHA256,
          cargoVSha256: CARGO_V_SHA256,
          gitExecutableSha256: GIT_EXECUTABLE_SHA256,
          runtimeBundleSha256: RUNTIME_BUNDLE_SHA256,
          rustcExecutableSha256: RUSTC_EXECUTABLE_SHA256,
          rustcVvSha256: RUSTC_VV_SHA256,
          sourceTreeSha256: SOURCE_TREE_SHA256,
        },
        sha256: BUILD_ATTESTATION_SHA256,
      };
    },
    clock,
    createReceiptReader: async () => {
      calls.push("create-receipt");
      return {
        createBytes: canonical(createReceipt()),
        createSha256: CREATE_RECEIPT_SHA256,
        deleteBytes: canonical(deleteReceipt()),
        deleteSha256: DELETE_RECEIPT_SHA256,
      };
    },
    nativeRootAttestor: async () => {
      calls.push("root-attestation");
      return canonical(nativeRootAttestation());
    },
    policyReader: async () => {
      calls.push("policy");
      return { policy: clone(POLICY), policySha256: POLICY_SHA256 };
    },
    readinessPublisher,
    readinessReader: async ({ bytes }) => ({ bytes }),
    sourcePolicyReader: async () => {
      calls.push("source-policy");
      return { policySha256: FLEURS_POLICY_SHA256, source: fleursSourceJoin() };
    },
  };
}

async function temporaryDirectory(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "meetingrelay-formal-trust-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  return root;
}

test("formal-run trust implementation module exists", () => {
  if (moduleLoadError !== null) {
    assert.equal(moduleLoadError.code, "ERR_MODULE_NOT_FOUND");
    assert.fail(`expected RED implementation module: ${moduleLoadError.code}`);
  }
  assert.ok(subject);
});

subjectTest("module exports only the formal trust, readiness, and cleanup contract surface", () => {
  assert.deepEqual(Object.keys(subject).sort(), [
    "FormalRunTrustEnvelopeError",
    "__assessFormalRunReadinessForTest",
    "__cleanupControlledArtifactForTest",
    "__publishFormalRunReadinessEnvelopeForTest",
    "assessFormalRunReadiness",
    "buildFormalRunReadinessEnvelope",
    "buildFormalRunTrustPolicy",
    "cleanupControlledArtifact",
    "publishFormalRunReadinessEnvelope",
    "readPinnedFormalRunTrustPolicy",
    "validateCleanupCreateReceiptBytes",
    "validateCleanupDeleteReceiptBytes",
    "validateFormalRunReadinessEnvelopeBytes",
    "validateFormalRunTrustInput",
    "validateFormalRunTrustPolicyBytes",
    "validateNativeControlledRootAttestationBytes",
    "validateQualityHostBuildAttestationBytes",
  ]);
});

subjectTest("committed policy shape freezes strict authority, root, build, and 30-day retention", () => {
  const built = api("buildFormalRunTrustPolicy")(clone(POLICY));
  const validated = api("validateFormalRunTrustPolicyBytes")(built.bytes);
  assert.deepEqual(validated.policy, POLICY);
  assert.equal(validated.policy.retention.maximum_seconds, 2_592_000);
  assert.equal(validated.policy.authority.execution_status, "not-run");
  assert.equal(validated.policy.authority.quality_gate_status, "not-assessed");
  assert.equal(validated.policy.authority.production_evidence, false);
});

subjectTest("committed policy bytes are canonical and externally pinnable", async () => {
  const bytes = await readFile(new URL("./formal-run-trust-policy.json", import.meta.url));
  assert.equal(bytes.length, 1151);
  assert.equal(sha256(bytes), COMMITTED_POLICY_SHA256);
  const validated = api("validateFormalRunTrustPolicyBytes")(bytes);
  assert.deepEqual(validated.policy, POLICY);
  assert.deepEqual(api("buildFormalRunTrustPolicy")(validated.policy).bytes, bytes);
});

subjectTest("pinned policy requires an external expected SHA before reading", async (t) => {
  const root = await temporaryDirectory(t);
  const policyPath = path.join(root, "policy.json");
  await writeFile(policyPath, canonical(POLICY), { flag: "wx" });
  await expectCode(
    () => api("readPinnedFormalRunTrustPolicy")({
      expectedPolicySha256: undefined,
      policyPath,
    }),
    "FORMAL_TRUST_POLICY_TRUST_REQUIRED",
  );
});

subjectTest("pinned policy rejects a valid nonzero but incorrect external SHA", async (t) => {
  const root = await temporaryDirectory(t);
  const policyPath = path.join(root, "policy.json");
  await writeFile(policyPath, canonical(POLICY), { flag: "wx" });
  await expectCode(
    () => api("readPinnedFormalRunTrustPolicy")({
      expectedPolicySha256: "f".repeat(64),
      policyPath,
    }),
    "FORMAL_TRUST_POLICY_DIGEST_MISMATCH",
  );
});

subjectTest("pinned policy accepts canonical bytes with the exact external SHA", async (t) => {
  const root = await temporaryDirectory(t);
  const bytes = canonical(POLICY);
  const policyPath = path.join(root, "policy.json");
  await writeFile(policyPath, bytes, { flag: "wx" });
  const result = await api("readPinnedFormalRunTrustPolicy")({
    expectedPolicySha256: sha256(bytes),
    policyPath,
  });
  assert.equal(result.policySha256, sha256(bytes));
  assert.deepEqual(result.policy, POLICY);
});

subjectTest("policy rejects pretty JSON even when its values are otherwise exact", () => {
  const pretty = Buffer.from(`${JSON.stringify(POLICY, null, 2)}\n`, "utf8");
  assert.throws(
    () => api("validateFormalRunTrustPolicyBytes")(pretty),
    { code: "FORMAL_TRUST_POLICY_CANONICAL" },
  );
});

subjectTest("policy rejects any authority promotion", () => {
  const promoted = clone(POLICY);
  promoted.authority.quality_gate_status = "passed";
  assert.throws(
    () => api("validateFormalRunTrustPolicyBytes")(canonical(promoted)),
    { code: "FORMAL_TRUST_POLICY_AUTHORITY" },
  );
});

subjectTest("private input accepts only normalized local-drive controlled-root paths", () => {
  assert.deepEqual(api("validateFormalRunTrustInput")(clone(PRIVATE_INPUT)), PRIVATE_INPUT);
});

subjectTest("private input rejects relative UNC device ADS and non-NFC controlled roots", () => {
  for (const controlledRoot of [
    "relative\\controlled",
    "\\\\server\\share\\controlled",
    "\\\\?\\C:\\controlled",
    "C:\\controlled:stream",
    "C:\\e\u0301\\controlled",
  ]) {
    assert.throws(
      () => api("validateFormalRunTrustInput")({ ...PRIVATE_INPUT, controlledRoot }),
      { code: "FORMAL_TRUST_ROOT_PATH" },
      controlledRoot,
    );
  }
});

subjectTest("native root attestation accepts a fixed NTFS volume", () => {
  const result = api("validateNativeControlledRootAttestationBytes")(
    canonical(nativeRootAttestation()),
    validationOptions(),
  );
  assert.equal(result.record.root.drive_type, "fixed");
  assert.equal(result.record.root.filesystem, "NTFS");
});

subjectTest("native root attestation rejects a non-fixed drive", () => {
  const record = nativeRootAttestation();
  record.root.drive_type = "remote";
  assert.throws(
    () => api("validateNativeControlledRootAttestationBytes")(
      canonical(record),
      validationOptions(),
    ),
    { code: "FORMAL_TRUST_ROOT_DRIVE_TYPE" },
  );
});

subjectTest("native root attestation rejects a non-NTFS filesystem", () => {
  const record = nativeRootAttestation();
  record.root.filesystem = "ReFS";
  assert.throws(
    () => api("validateNativeControlledRootAttestationBytes")(
      canonical(record),
      validationOptions(),
    ),
    { code: "FORMAL_TRUST_ROOT_FILESYSTEM" },
  );
});

subjectTest("native root attestation requires a protected DACL", () => {
  const record = nativeRootAttestation();
  record.root.dacl_protected = false;
  assert.throws(
    () => api("validateNativeControlledRootAttestationBytes")(
      canonical(record),
      validationOptions(),
    ),
    { code: "FORMAL_TRUST_ROOT_DACL_PROTECTION" },
  );
});

subjectTest("native root attestation requires operator SYSTEM and Administrators only", () => {
  const record = nativeRootAttestation();
  record.root.aces.push({
    inherited: false,
    inheritance: "container-and-object",
    principal: "everyone",
    rights: "read",
    type: "allow",
  });
  assert.throws(
    () => api("validateNativeControlledRootAttestationBytes")(
      canonical(record),
      validationOptions(),
    ),
    { code: "FORMAL_TRUST_ROOT_DACL_PRINCIPAL" },
  );
});

subjectTest("native root attestation rejects inherited or reduced ACE rights", () => {
  const record = nativeRootAttestation();
  record.root.aces[1].inherited = true;
  record.root.aces[1].rights = "read";
  assert.throws(
    () => api("validateNativeControlledRootAttestationBytes")(
      canonical(record),
      validationOptions(),
    ),
    { code: "FORMAL_TRUST_ROOT_DACL_RIGHTS" },
  );
});

subjectTest("native root owner must classify as the exact operator token user", () => {
  const record = nativeRootAttestation();
  record.root.owner_principal = "administrators";
  assert.throws(
    () => api("validateNativeControlledRootAttestationBytes")(
      canonical(record),
      validationOptions(),
    ),
    { code: "FORMAL_TRUST_ROOT_OWNER" },
  );
});

subjectTest("native root attestation requires nonzero volume and 128-bit file identity", () => {
  const record = nativeRootAttestation();
  record.root.file_id_128 = "0".repeat(32);
  assert.throws(
    () => api("validateNativeControlledRootAttestationBytes")(
      canonical(record),
      validationOptions(),
    ),
    { code: "FORMAL_TRUST_ROOT_IDENTITY" },
  );
});

subjectTest("native root attestation rejects any root reparse tag", () => {
  const record = nativeRootAttestation();
  record.root.reparse_tag = "a000000c";
  assert.throws(
    () => api("validateNativeControlledRootAttestationBytes")(
      canonical(record),
      validationOptions(),
    ),
    { code: "FORMAL_TRUST_ROOT_REPARSE" },
  );
});

subjectTest("native inventory rejects any arbitrary child reparse tag", () => {
  const record = nativeRootAttestation();
  record.inventory = {
    entries: [{
      file_id_128: "11223344556677889900aabbccddeeff",
      reparse_tag: "8000001b",
      relative_path_sha256: "e".repeat(64),
    }],
    entry_count: 1,
    sha256: INVENTORY_SHA256,
  };
  assert.throws(
    () => api("validateNativeControlledRootAttestationBytes")(
      canonical(record),
      validationOptions(),
    ),
    { code: "FORMAL_TRUST_ROOT_REPARSE" },
  );
});

subjectTest("native inventory rejects counts above the policy bound", () => {
  const record = nativeRootAttestation();
  record.inventory.entry_count = 4097;
  assert.throws(
    () => api("validateNativeControlledRootAttestationBytes")(
      canonical(record),
      validationOptions(),
    ),
    { code: "FORMAL_TRUST_ROOT_INVENTORY" },
  );
});

subjectTest("retention accepts an exact 30-day finite window", () => {
  const result = api("buildFormalRunReadinessEnvelope")(readinessBuildInput());
  assert.equal(result.record.retention.expires_at, THIRTY_DAYS_LATER);
});

subjectTest("retention rejects a window one second above 30 days", () => {
  assert.throws(
    () => api("buildFormalRunReadinessEnvelope")({
      ...readinessBuildInput(),
      retention: {
        expires_at: "2026-08-15T00:00:01Z",
        validated_at: VALIDATED_AT,
      },
    }),
    { code: "FORMAL_TRUST_RETENTION_WINDOW" },
  );
});

subjectTest("retention rejects an expired deadline", () => {
  const input = readinessBuildInput();
  input.createReceipt.retention_expires_at = VALIDATED_AT;
  input.nativeRootAttestation.root.retention_expires_at = VALIDATED_AT;
  assert.throws(
    () => api("buildFormalRunReadinessEnvelope")({
      ...input,
      retention: { expires_at: VALIDATED_AT, validated_at: VALIDATED_AT },
    }),
    { code: "FORMAL_TRUST_RETENTION_EXPIRED" },
  );
});

subjectTest("retention rejects fractional or offset timestamps", () => {
  assert.throws(
    () => api("validateFormalRunTrustInput")({
      ...PRIVATE_INPUT,
      retentionExpiresAt: "2026-08-15T00:00:00.000+00:00",
    }),
    { code: "FORMAL_TRUST_RETENTION_FORMAT" },
  );
});

subjectTest("create receipt binds the policy and exact root volume and file ID", () => {
  const result = api("validateCleanupCreateReceiptBytes")(
    canonical(createReceipt()),
    {
      expectedArtifactFileId128: PROBE_FILE_ID_128,
      expectedContentSha256: PROBE_CONTENT_SHA256,
      expectedPolicySha256: POLICY_SHA256,
      expectedRelativeNameSha256: PROBE_RELATIVE_NAME_SHA256,
      expectedRootFileId128: "00112233445566778899aabbccddeeff",
      expectedSizeBytes: PROBE_SIZE_BYTES,
      expectedVolumeSerialNumber: "123456789",
    },
  );
  assert.equal(result.record.root_identity.file_id_128,
    "00112233445566778899aabbccddeeff");
});

subjectTest("create receipt freezes a positive retention window no longer than 30 days", () => {
  for (const [retentionExpiresAt, code] of [
    ["2026-07-16T00:00:00Z", "FORMAL_TRUST_RETENTION_EXPIRED"],
    ["2026-08-15T00:00:01Z", "FORMAL_TRUST_RETENTION_WINDOW"],
  ]) {
    const record = createReceipt();
    record.retention_expires_at = retentionExpiresAt;
    assert.throws(
      () => api("validateCleanupCreateReceiptBytes")(
        canonical(record),
        { expectedPolicySha256: POLICY_SHA256 },
      ),
      { code },
    );
  }
});

subjectTest("delete receipt requires Win32 handle-bound deletion", () => {
  const record = deleteReceipt();
  record.cleanup.deletion_method = "pathname-unlink";
  assert.throws(
    () => api("validateCleanupDeleteReceiptBytes")(
      canonical(record),
      {
        expectedCreateReceiptSha256: CREATE_RECEIPT_SHA256,
        expectedPolicySha256: POLICY_SHA256,
      },
    ),
    { code: "FORMAL_TRUST_CLEANUP_HANDLE_DELETE" },
  );
});

subjectTest("delete receipt rejects a different opened file ID", () => {
  const record = deleteReceipt();
  record.cleanup.deleted_file_id_128 = "0".repeat(32);
  assert.throws(
    () => api("validateCleanupDeleteReceiptBytes")(
      canonical(record),
      {
        expectedCreateReceiptSha256: CREATE_RECEIPT_SHA256,
        expectedDeletedFileId128: "ffeeddccbbaa99887766554433221100",
        expectedPolicySha256: POLICY_SHA256,
      },
    ),
    { code: "FORMAL_TRUST_CLEANUP_IDENTITY" },
  );
});

subjectTest("cleanup rejects a target with more than one hard link", async () => {
  await expectCode(
    () => api("__cleanupControlledArtifactForTest")(
      {
        controlledRoot: ROOT_PATH,
        createReceipt: createReceipt(),
        createReceiptSha256: CREATE_RECEIPT_SHA256,
        expectedPolicySha256: POLICY_SHA256,
        relativePath: "private-ledger.jsonl",
      },
      {
        clock: () => new Date("2026-08-15T00:00:00Z"),
        nativeDeleteByHandle: async () => ({ linkCountBefore: 2 }),
      },
    ),
    "FORMAL_TRUST_CLEANUP_LINK_COUNT",
  );
});

subjectTest("cleanup before the finite deadline never invokes native deletion", async () => {
  let deleteCalls = 0;
  await expectCode(
    () => api("__cleanupControlledArtifactForTest")(
      {
        controlledRoot: ROOT_PATH,
        createReceipt: createReceipt(),
        createReceiptSha256: CREATE_RECEIPT_SHA256,
        expectedPolicySha256: POLICY_SHA256,
        relativePath: "private-ledger.jsonl",
      },
      {
        clock: () => new Date("2026-08-14T23:59:59Z"),
        nativeDeleteByHandle: async () => { deleteCalls += 1; },
      },
    ),
    "FORMAL_TRUST_CLEANUP_NOT_DUE",
  );
  assert.equal(deleteCalls, 0);
});

subjectTest("cleanup derives the exact opened artifact identity from its pinned create receipt", async () => {
  const originalFileId = PROBE_FILE_ID_128;
  let receiptInput;
  const result = await api("__cleanupControlledArtifactForTest")(
    {
      controlledRoot: ROOT_PATH,
      createReceipt: createReceipt(),
      createReceiptSha256: CREATE_RECEIPT_SHA256,
      expectedPolicySha256: POLICY_SHA256,
      relativePath: "private-ledger.jsonl",
    },
    {
      clock: () => new Date(THIRTY_DAYS_LATER),
      nativeDeleteByHandle: async (input) => {
        assert.equal(input.expectedFileId128, originalFileId);
        assert.equal(input.expectedContentSha256, PROBE_CONTENT_SHA256);
        assert.equal(input.expectedSizeBytes, PROBE_SIZE_BYTES);
        return {
          contentSha256: PROBE_CONTENT_SHA256,
          deletedFileId128: originalFileId,
          deletionMethod: "set-file-information-by-handle",
          linkCountBefore: 1,
          relativeNameSha256: PROBE_RELATIVE_NAME_SHA256,
          replacementStatus: "not-present",
          sizeBytes: PROBE_SIZE_BYTES,
          volumeSerialNumber: "123456789",
        };
      },
      receiptPublisher: async (input) => { receiptInput = input; },
    },
  );
  assert.equal(result.record.cleanup.deleted_file_id_128, originalFileId);
  assert.equal(result.record.cleanup.replacement_status, "not-present");
  assert.ok(receiptInput);
});

subjectTest("cleanup receipt can never claim secure erase", () => {
  const record = deleteReceipt();
  record.cleanup.secure_erase = true;
  assert.throws(
    () => api("validateCleanupDeleteReceiptBytes")(
      canonical(record),
      {
        expectedCreateReceiptSha256: CREATE_RECEIPT_SHA256,
        expectedPolicySha256: POLICY_SHA256,
      },
    ),
    { code: "FORMAL_TRUST_CLEANUP_RECEIPT" },
  );
});

subjectTest("quality-host build attestation accepts every frozen clean Release join", () => {
  const result = api("validateQualityHostBuildAttestationBytes")(
    canonical(buildAttestation()),
    buildValidationOptions(),
  );
  assert.equal(result.record.source.worktree_status, "clean");
  assert.equal(result.record.executable.sha256, QUALITY_HOST_SHA256);
});

subjectTest("quality-host build attestation rejects a dirty worktree", () => {
  const record = buildAttestation();
  record.source.worktree_status = "dirty";
  assert.throws(
    () => api("validateQualityHostBuildAttestationBytes")(
      canonical(record), buildValidationOptions()),
    { code: "FORMAL_TRUST_HOST_SOURCE_DIRTY" },
  );
});

subjectTest("quality-host build attestation rejects source commit drift", () => {
  const record = buildAttestation();
  record.source.commit = "e".repeat(40);
  assert.throws(
    () => api("validateQualityHostBuildAttestationBytes")(
      canonical(record), buildValidationOptions()),
    { code: "FORMAL_TRUST_HOST_SOURCE_COMMIT" },
  );
});

subjectTest("quality-host build attestation rejects source tree drift", () => {
  const record = buildAttestation();
  record.source.tree_sha256 = "e".repeat(64);
  assert.throws(
    () => api("validateQualityHostBuildAttestationBytes")(
      canonical(record), buildValidationOptions()),
    { code: "FORMAL_TRUST_HOST_SOURCE_TREE" },
  );
});

subjectTest("quality-host build attestation rejects Cargo.lock drift", () => {
  const record = buildAttestation();
  record.cargo.lock_sha256 = "e".repeat(64);
  assert.throws(
    () => api("validateQualityHostBuildAttestationBytes")(
      canonical(record), buildValidationOptions()),
    { code: "FORMAL_TRUST_HOST_CARGO_LOCK" },
  );
});

subjectTest("quality-host build attestation rejects rustc identity drift", () => {
  const record = buildAttestation();
  record.toolchain.rustc_vv_sha256 = "e".repeat(64);
  assert.throws(
    () => api("validateQualityHostBuildAttestationBytes")(
      canonical(record), buildValidationOptions()),
    { code: "FORMAL_TRUST_HOST_RUSTC" },
  );
});

subjectTest("quality-host build attestation requires x86_64-pc-windows-msvc", () => {
  const record = buildAttestation();
  record.toolchain.target = "aarch64-pc-windows-msvc";
  assert.throws(
    () => api("validateQualityHostBuildAttestationBytes")(
      canonical(record), buildValidationOptions()),
    { code: "FORMAL_TRUST_HOST_TARGET" },
  );
});

subjectTest("quality-host build attestation requires the Release profile", () => {
  const record = buildAttestation();
  record.cargo.profile = "debug";
  assert.throws(
    () => api("validateQualityHostBuildAttestationBytes")(
      canonical(record), buildValidationOptions()),
    { code: "FORMAL_TRUST_HOST_PROFILE" },
  );
});

subjectTest("quality-host build attestation requires exactly the two frozen features", () => {
  const record = buildAttestation();
  record.cargo.features.push("native-fault-fixture");
  assert.throws(
    () => api("validateQualityHostBuildAttestationBytes")(
      canonical(record), buildValidationOptions()),
    { code: "FORMAL_TRUST_HOST_FEATURES" },
  );
});

subjectTest("quality-host build attestation rejects executable digest drift", () => {
  const record = buildAttestation();
  record.executable.sha256 = "e".repeat(64);
  assert.throws(
    () => api("validateQualityHostBuildAttestationBytes")(
      canonical(record), buildValidationOptions()),
    { code: "FORMAL_TRUST_HOST_EXECUTABLE" },
  );
});

subjectTest("quality-host build attestation rejects PE identity drift", () => {
  for (const mutate of [
    (record) => { record.executable.pe_subsystem = "windows-gui"; },
    (record) => { record.executable.required_dll_characteristics.reverse(); },
  ]) {
    const record = buildAttestation();
    mutate(record);
    assert.throws(
      () => api("validateQualityHostBuildAttestationBytes")(
        canonical(record), buildValidationOptions()),
      { code: "FORMAL_TRUST_HOST_PE" },
    );
  }
});

subjectTest("quality-host build attestation rejects runtime-bundle drift", () => {
  const record = buildAttestation();
  record.executable.runtime_bundle_sha256 = "e".repeat(64);
  assert.throws(
    () => api("validateQualityHostBuildAttestationBytes")(
      canonical(record), buildValidationOptions()),
    { code: "FORMAL_TRUST_HOST_RUNTIME" },
  );
});

subjectTest("readiness joins the exact root, receipt, policy, build, and retention identities", () => {
  const built = api("buildFormalRunReadinessEnvelope")(readinessBuildInput());
  const result = api("validateFormalRunReadinessEnvelopeBytes")(
    built.bytes,
    {
      currentTime: VALIDATED_AT,
      expectedBuildAttestationSha256: BUILD_ATTESTATION_SHA256,
      expectedCreateReceiptSha256: CREATE_RECEIPT_SHA256,
      expectedDeleteReceiptSha256: DELETE_RECEIPT_SHA256,
      expectedFleursPolicySha256: FLEURS_POLICY_SHA256,
      expectedPolicySha256: POLICY_SHA256,
    },
  );
  assert.equal(result.record.quality_host.build_attestation_sha256,
    BUILD_ATTESTATION_SHA256);
  assert.equal(result.record.controlled_root.create_receipt_sha256,
    CREATE_RECEIPT_SHA256);
  assert.equal(result.record.controlled_root.delete_receipt_sha256,
    DELETE_RECEIPT_SHA256);
  assert.equal(result.record.source.policy_sha256, FLEURS_POLICY_SHA256);
});

subjectTest("readiness rejects any drift from the frozen FLEURS source join", () => {
  const input = readinessBuildInput();
  input.source.revision = "main";
  assert.throws(
    () => api("buildFormalRunReadinessEnvelope")(input),
    { code: "FORMAL_TRUST_SOURCE_JOIN" },
  );
});

subjectTest("an expired readiness envelope is never accepted as live materialization readiness", () => {
  const built = api("buildFormalRunReadinessEnvelope")(readinessBuildInput());
  assert.throws(
    () => api("validateFormalRunReadinessEnvelopeBytes")(built.bytes, {
      currentTime: THIRTY_DAYS_LATER,
      expectedBuildAttestationSha256: BUILD_ATTESTATION_SHA256,
      expectedCreateReceiptSha256: CREATE_RECEIPT_SHA256,
      expectedDeleteReceiptSha256: DELETE_RECEIPT_SHA256,
      expectedFleursPolicySha256: FLEURS_POLICY_SHA256,
      expectedPolicySha256: POLICY_SHA256,
    }),
    { code: "FORMAL_TRUST_RETENTION_EXPIRED" },
  );
});

subjectTest("readiness authority remains metadata-only and cannot claim a run", () => {
  const built = api("buildFormalRunReadinessEnvelope")(readinessBuildInput());
  assert.deepEqual(built.record.authority, AUTHORITY);
  const text = built.bytes.toString("utf8").toLowerCase();
  for (const forbidden of [
    ROOT_PATH.toLowerCase(),
    "operator_sid",
    "s-1-",
    "sddl",
    "security_descriptor",
    "wav",
    "audio",
    "reference",
    "transcript",
    "http://",
    "https://",
  ]) {
    assert.equal(text.includes(forbidden), false, forbidden);
  }
});

subjectTest("readiness publication is create-new and preserves an existing target", async (t) => {
  const root = await temporaryDirectory(t);
  const target = path.join(root, "readiness.json");
  const competitor = Buffer.from("competitor-must-survive\n", "utf8");
  await writeFile(target, competitor, { flag: "wx" });
  const bytes = canonical({ authority: AUTHORITY, kind: "fixture" });
  await expectCode(
    () => api("publishFormalRunReadinessEnvelope")(target, bytes),
    "FORMAL_TRUST_READINESS_PUBLICATION",
  );
  assert.deepEqual(await readFile(target), competitor);
});

subjectTest("readiness publication detects post-create replacement without unlinking it", async (t) => {
  const root = await temporaryDirectory(t);
  const target = path.join(root, "readiness.json");
  const expected = canonical({ authority: AUTHORITY, kind: "fixture" });
  const competitor = Buffer.from("replacement-must-survive\n", "utf8");
  await expectCode(
    () => api("__publishFormalRunReadinessEnvelopeForTest")(
      target,
      expected,
      {
        afterCreateNew: async () => {
          await rm(target);
          await writeFile(target, competitor, { flag: "wx" });
        },
      },
    ),
    "FORMAL_TRUST_READINESS_POSTFLIGHT",
  );
  assert.deepEqual(await readFile(target), competitor);
});

subjectTest("readiness assessment invokes attestation dependencies but no audio or model runner", async () => {
  const calls = [];
  const result = await api("__assessFormalRunReadinessForTest")(
    clone(PRIVATE_INPUT),
    assessmentDependencies({ calls }),
  );
  assert.deepEqual([...new Set(calls)].sort(), [
    "build-attestation",
    "create-receipt",
    "policy",
    "publish",
    "root-attestation",
    "source-policy",
  ]);
  assert.equal(calls.filter((entry) => entry === "root-attestation").length, 3);
  assert.equal(calls.filter((entry) => entry === "source-policy").length, 2);
  assert.deepEqual(result.record.authority, AUTHORITY);
  assert.equal("audioRunner" in result, false);
  assert.equal("modelRunner" in result, false);
});

subjectTest("readiness assessment refuses to publish when retention expires during verification", async () => {
  const times = [VALIDATED_AT, THIRTY_DAYS_LATER];
  let publishCalls = 0;
  await expectCode(
    () => api("__assessFormalRunReadinessForTest")(
      clone(PRIVATE_INPUT),
      assessmentDependencies({
        clock: () => new Date(times.shift() ?? THIRTY_DAYS_LATER),
        readinessPublisher: async () => { publishCalls += 1; },
      }),
    ),
    "FORMAL_TRUST_RETENTION_EXPIRED",
  );
  assert.equal(publishCalls, 0);
});

subjectTest("readiness assessment never returns live authority after expiry during publication", async () => {
  const times = [VALIDATED_AT, VALIDATED_AT, THIRTY_DAYS_LATER];
  let publishCalls = 0;
  await expectCode(
    () => api("__assessFormalRunReadinessForTest")(
      clone(PRIVATE_INPUT),
      assessmentDependencies({
        clock: () => new Date(times.shift() ?? THIRTY_DAYS_LATER),
        readinessPublisher: async () => { publishCalls += 1; },
      }),
    ),
    "FORMAL_TRUST_RETENTION_EXPIRED",
  );
  assert.equal(publishCalls, 1);
});

subjectTest("readiness assessment fails closed on wall-clock rollback", async () => {
  const times = ["2026-07-16T00:00:01Z", VALIDATED_AT];
  let publishCalls = 0;
  await expectCode(
    () => api("__assessFormalRunReadinessForTest")(
      clone(PRIVATE_INPUT),
      assessmentDependencies({
        clock: () => new Date(times.shift() ?? VALIDATED_AT),
        readinessPublisher: async () => { publishCalls += 1; },
      }),
    ),
    "FORMAL_TRUST_CLOCK_ROLLBACK",
  );
  assert.equal(publishCalls, 0);
});

subjectTest("zero trust digests cannot enter any readiness join", () => {
  assert.throws(
    () => api("validateFormalRunTrustInput")({
      ...PRIVATE_INPUT,
      expectedBuildAttestationSha256: ZERO_SHA256,
    }),
    { code: "FORMAL_TRUST_DIGEST" },
  );
});

subjectTest("formal trust source has no archive extraction model execution or public run API", async () => {
  const source = await readFile(SUBJECT_URL, "utf8");
  for (const forbidden of [
    "runNativeCandidateQualityEvaluation",
    "test.tar.gz",
    "extractArchive",
    "materializeQualityCorpus",
    "scoreAsrTranscript",
  ]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
  assert.equal(Object.keys(subject).some((name) => /^run|audio|model|extract/iu.test(name)), false);
});
