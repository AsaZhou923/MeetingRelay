import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  link,
  lstat,
  mkdtemp,
  open,
  readFile,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { encodeCanonicalJsonLine } from "../phase0-harness/canonical-json.mjs";
import {
  runReleaseNativeCandidateConformance,
  sanitizeCandidateHostEnvironment,
  validateStagedRuntimeClosure,
} from "./validate-candidate-conformance.mjs";
import { validateLockFile } from "./validate-lock.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(HERE, "../..");
const EVIDENCE_KIND = "meetingrelay-native-candidate-fault-evidence-v1";
const SCHEMA_VERSION = "1.0";
const FAULT_HOST_FILE_NAME =
  process.platform === "win32"
    ? "meetingrelay-sherpa-candidate-fault-host.exe"
    : "meetingrelay-sherpa-candidate-fault-host";
const BOUNDARY_FIXTURE_FILE_NAME =
  "meetingrelay-native-fatal-boundary-fixture.exe";
const EXPECTED_FAULT_HOST_PATH = path.join(
  REPOSITORY_ROOT,
  "target",
  "sherpa-native",
  "fatal-fixtures",
  "rust-target",
  "release",
  FAULT_HOST_FILE_NAME,
);
const EXPECTED_BOUNDARY_FIXTURE_PATH = path.join(
  REPOSITORY_ROOT,
  "target",
  "sherpa-native",
  "fatal-fixtures",
  "msvc",
  BOUNDARY_FIXTURE_FILE_NAME,
);
const MAX_MARKER_BYTES = 65_536;
const MAX_PROCESS_OUTPUT_BYTES = 4_096;
const FATAL_PROCESS_TIMEOUT_MS = 120_000;
const HANG_CONFIRMATION_MS = 250;
const POLL_INTERVAL_MS = 20;
const PROCESS_EXIT_POLL_TIMEOUT_MS = 5_000;
const POST_KILL_CLOSE_TIMEOUT_MS = 135_000;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const NTSTATUS_PATTERN = /^0x[0-9a-f]{8}$/u;

const ROOT_KEYS = Object.freeze([
  "authority",
  "kind",
  "lanes",
  "limitations",
  "locked_input_snapshot_sha256",
  "schema_version",
]);
const AUTHORITY_KEYS = Object.freeze(["formal_claims", "production_evidence"]);
const LANE_KEYS = Object.freeze([
  "checkpoint",
  "fault_artifact_sha256",
  "fault_injected",
  "loaded_runtime",
  "marker_sha256",
  "mode",
  "observation",
  "postflight_snapshot_sha256",
  "recovery",
  "representative_only",
]);
const LOADED_RUNTIME_KEYS = Object.freeze(["name", "sha256"]);
const OBSERVATION_KEYS = Object.freeze([
  "natural_ntstatus",
  "ntstatus_hex",
  "signed_i32",
  "timed_out",
  "unsigned_u32",
]);
const RECOVERY_KEYS = Object.freeze([
  "backend_execute_calls",
  "check_summary",
  "conformance_record_sha256",
  "fresh_process",
]);
const CHECK_SUMMARY_KEYS = Object.freeze(["passed", "total"]);
const LIMITATIONS = Object.freeze([
  "injected-faults-not-natural-sherpa-defects",
  "fresh-process-recovery-only",
  "product-replay-and-restart-budget-not-tested",
  "onsite-quality-performance-resources-not-measured",
]);
const LANE_CONTRACTS = Object.freeze([
  Object.freeze({
    checkpoint: "real-prepare-loaded-runtime-identity",
    mode: "abort-after-prepare",
    representativeOnly: false,
  }),
  Object.freeze({
    checkpoint: "successful-real-inference",
    mode: "hang-after-inference",
    representativeOnly: false,
  }),
  Object.freeze({
    checkpoint: "before-injected-access-violation",
    mode: "representative-av",
    representativeOnly: true,
  }),
]);
const REQUIRED_LOADED_RUNTIME_NAMES = Object.freeze([
  "onnxruntime.dll",
  "sherpa-onnx-c-api.dll",
]);

export class NativeCandidateFaultEvidenceError extends Error {
  constructor(code) {
    super(code);
    this.name = "NativeCandidateFaultEvidenceError";
    this.code = code;
  }
}

function fail(code) {
  throw new NativeCandidateFaultEvidenceError(code);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertDigest(value, code) {
  if (
    typeof value !== "string" ||
    !DIGEST_PATTERN.test(value) ||
    value === "0".repeat(64)
  ) {
    fail(code);
  }
}

function assertExactKeys(value, expected, code) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(code);
  }
  const actual = Object.keys(value);
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    fail(code);
  }
}

function parseCanonicalJsonLine(bytes, code) {
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length === 0 ||
    bytes.length > MAX_MARKER_BYTES ||
    bytes.at(-1) !== 0x0a ||
    bytes.includes(0x0d)
  ) {
    fail(code);
  }
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) {
    fail(code);
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    fail(code);
  }
  if (encodeCanonicalJsonLine(value) !== text) {
    fail(code);
  }
  return value;
}

function normalizeStatus(status, code) {
  if (!Number.isSafeInteger(status)) {
    fail(code);
  }
  const unsignedU32 = status >>> 0;
  const signedI32 = unsignedU32 | 0;
  return {
    natural_ntstatus: true,
    ntstatus_hex: `0x${unsignedU32.toString(16).padStart(8, "0")}`,
    signed_i32: signedI32,
    timed_out: false,
    unsigned_u32: unsignedU32,
  };
}

function validateObservation(observation, mode) {
  assertExactKeys(observation, OBSERVATION_KEYS, "FAULT_EVIDENCE_OBSERVATION");
  if (mode === "hang-after-inference") {
    if (
      observation.natural_ntstatus !== false ||
      observation.ntstatus_hex !== null ||
      observation.signed_i32 !== null ||
      observation.timed_out !== true ||
      observation.unsigned_u32 !== null
    ) {
      fail("FAULT_EVIDENCE_OBSERVATION");
    }
    return;
  }
  if (
    observation.natural_ntstatus !== true ||
    observation.timed_out !== false ||
    !Number.isInteger(observation.signed_i32) ||
    observation.signed_i32 < -2_147_483_648 ||
    observation.signed_i32 > 2_147_483_647 ||
    !Number.isInteger(observation.unsigned_u32) ||
    observation.unsigned_u32 < 0 ||
    observation.unsigned_u32 > 4_294_967_295 ||
    typeof observation.ntstatus_hex !== "string" ||
    !NTSTATUS_PATTERN.test(observation.ntstatus_hex)
  ) {
    fail("FAULT_EVIDENCE_OBSERVATION");
  }
  const normalized = normalizeStatus(
    observation.unsigned_u32,
    "FAULT_EVIDENCE_OBSERVATION",
  );
  if (!isDeepStrictEqual(normalized, observation) || observation.unsigned_u32 === 0) {
    fail("FAULT_EVIDENCE_OBSERVATION");
  }
  if (
    mode === "representative-av" &&
    (observation.signed_i32 !== -1_073_741_819 ||
      observation.unsigned_u32 !== 3_221_225_477 ||
      observation.ntstatus_hex !== "0xc0000005")
  ) {
    fail("FAULT_EVIDENCE_OBSERVATION");
  }
}

function validateLoadedRuntime(loadedRuntime, representativeOnly) {
  if (!Array.isArray(loadedRuntime)) {
    fail("FAULT_EVIDENCE_RUNTIME");
  }
  if (representativeOnly) {
    if (loadedRuntime.length !== 0) {
      fail("FAULT_EVIDENCE_RUNTIME");
    }
    return;
  }
  if (loadedRuntime.length !== REQUIRED_LOADED_RUNTIME_NAMES.length) {
    fail("FAULT_EVIDENCE_RUNTIME");
  }
  for (const [index, entry] of loadedRuntime.entries()) {
    assertExactKeys(entry, LOADED_RUNTIME_KEYS, "FAULT_EVIDENCE_RUNTIME");
    if (entry.name !== REQUIRED_LOADED_RUNTIME_NAMES[index]) {
      fail("FAULT_EVIDENCE_RUNTIME");
    }
    assertDigest(entry.sha256, "FAULT_EVIDENCE_RUNTIME");
  }
}

function validateRecovery(recovery) {
  assertExactKeys(recovery, RECOVERY_KEYS, "FAULT_EVIDENCE_RECOVERY");
  assertExactKeys(
    recovery.check_summary,
    CHECK_SUMMARY_KEYS,
    "FAULT_EVIDENCE_RECOVERY",
  );
  assertDigest(
    recovery.conformance_record_sha256,
    "FAULT_EVIDENCE_RECOVERY",
  );
  if (
    recovery.backend_execute_calls !== 1 ||
    recovery.check_summary.passed !== 12 ||
    recovery.check_summary.total !== 12 ||
    recovery.fresh_process !== true
  ) {
    fail("FAULT_EVIDENCE_RECOVERY");
  }
}

export function validateNativeCandidateFaultEvidenceRecord(recordBytes) {
  const record = parseCanonicalJsonLine(
    recordBytes,
    "FAULT_EVIDENCE_CANONICAL_JSON",
  );
  assertExactKeys(record, ROOT_KEYS, "FAULT_EVIDENCE_SCHEMA");
  assertExactKeys(record.authority, AUTHORITY_KEYS, "FAULT_EVIDENCE_AUTHORITY");
  if (
    record.authority.formal_claims !== "none" ||
    record.authority.production_evidence !== false
  ) {
    fail("FAULT_EVIDENCE_AUTHORITY");
  }
  if (
    record.kind !== EVIDENCE_KIND ||
    record.schema_version !== SCHEMA_VERSION ||
    !isDeepStrictEqual(record.limitations, LIMITATIONS)
  ) {
    fail("FAULT_EVIDENCE_SCOPE");
  }
  assertDigest(
    record.locked_input_snapshot_sha256,
    "FAULT_EVIDENCE_INPUT_SNAPSHOT",
  );
  if (!Array.isArray(record.lanes) || record.lanes.length !== LANE_CONTRACTS.length) {
    fail("FAULT_EVIDENCE_LANES");
  }
  for (const [index, lane] of record.lanes.entries()) {
    const contract = LANE_CONTRACTS[index];
    assertExactKeys(lane, LANE_KEYS, "FAULT_EVIDENCE_LANE");
    if (
      lane.mode !== contract.mode ||
      lane.checkpoint !== contract.checkpoint ||
      lane.fault_injected !== true ||
      lane.representative_only !== contract.representativeOnly ||
      lane.postflight_snapshot_sha256 !== record.locked_input_snapshot_sha256
    ) {
      fail("FAULT_EVIDENCE_LANE");
    }
    assertDigest(lane.fault_artifact_sha256, "FAULT_EVIDENCE_LANE");
    assertDigest(lane.marker_sha256, "FAULT_EVIDENCE_LANE");
    validateLoadedRuntime(lane.loaded_runtime, contract.representativeOnly);
    validateObservation(lane.observation, contract.mode);
    validateRecovery(lane.recovery);
  }
  return {
    evidenceSha256: sha256(recordBytes),
    laneCount: record.lanes.length,
    lockedInputSnapshotSha256: record.locked_input_snapshot_sha256,
    record,
  };
}

async function assertRealPathChain(inputPath, code) {
  const resolved = path.resolve(inputPath);
  let current = resolved;
  while (true) {
    let metadata;
    try {
      metadata = await lstat(current);
    } catch {
      fail(code);
    }
    if (metadata.isSymbolicLink()) {
      fail(code);
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return resolved;
}

async function digestRegularFile(inputPath, code) {
  const resolved = await assertRealPathChain(inputPath, code);
  let metadata;
  try {
    metadata = await stat(resolved);
  } catch {
    fail(code);
  }
  if (!metadata.isFile() || metadata.size <= 0 || !Number.isSafeInteger(metadata.size)) {
    fail(code);
  }
  const bytes = await readFile(resolved).catch(() => fail(code));
  if (bytes.length !== metadata.size) {
    fail(code);
  }
  return { bytes, resolved, sha256: sha256(bytes), sizeBytes: bytes.length };
}

async function assertNewFilePath(outputPath, code) {
  const resolved = path.resolve(outputPath);
  const parent = await assertRealPathChain(path.dirname(resolved), code);
  if (path.dirname(resolved) !== parent) {
    fail(code);
  }
  try {
    await lstat(resolved);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return resolved;
    }
    fail(code);
  }
  fail(code);
}

function appendBounded(chunks, chunk, state) {
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  state.total += bytes.length;
  if (state.total <= MAX_PROCESS_OUTPUT_BYTES) {
    chunks.push(bytes);
  } else {
    state.overflow = true;
  }
}

export async function runFaultBoundaryProcess({
  arguments: arguments_,
  executablePath,
  hangMarkerPath = null,
  postKillTimeoutMs = POST_KILL_CLOSE_TIMEOUT_MS,
  spawnProcess = spawn,
  timeoutMs = FATAL_PROCESS_TIMEOUT_MS,
}) {
  return new Promise((resolve) => {
    const stdout = [];
    const stderr = [];
    const stdoutState = { overflow: false, total: 0 };
    const stderrState = { overflow: false, total: 0 };
    let hardTimeout;
    let hangPoll;
    let hangConfirmation;
    let postKillDeadline;
    let timedOut = false;
    let terminationRequested = false;
    let settled = false;
    let brokerCloseObserved = false;
    let spawnError = null;
    const child = spawnProcess(executablePath, arguments_, {
      cwd: REPOSITORY_ROOT,
      env: sanitizeCandidateHostEnvironment(process.env, path.dirname(executablePath)),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const finish = (status, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimeout);
      clearTimeout(hangConfirmation);
      clearTimeout(postKillDeadline);
      clearInterval(hangPoll);
      resolve({
        error: spawnError,
        brokerCloseObserved,
        outputOverflow: stdoutState.overflow || stderrState.overflow,
        pid: child.pid,
        signal,
        status,
        stderr: Buffer.concat(stderr),
        stdout: Buffer.concat(stdout),
        timedOut,
      });
    };
    child.stdout.on("data", (chunk) => appendBounded(stdout, chunk, stdoutState));
    child.stderr.on("data", (chunk) => appendBounded(stderr, chunk, stderrState));
    child.on("error", (error) => {
      spawnError = error;
    });
    child.on("close", (status, signal) => {
      brokerCloseObserved = true;
      finish(status, signal);
    });
    const requestTermination = () => {
      if (terminationRequested || settled) return;
      terminationRequested = true;
      timedOut = true;
      let accepted = false;
      try {
        accepted = child.kill("SIGKILL") === true;
      } catch (error) {
        spawnError = error;
      }
      if (!accepted && spawnError === null) {
        spawnError = new Error("FAULT_BOUNDARY_KILL_REJECTED");
      }
      if (settled) return;
      postKillDeadline = setTimeout(() => {
        spawnError = new Error("FAULT_BOUNDARY_BROKER_CLEANUP_TIMEOUT");
        // The exact broker owns a finite child deadline and a kill-on-close
        // Job. This watchdog bounds the Promise without destroying pipes or
        // unref'ing a potentially live tree; successful evidence still
        // requires a real close event plus subsequent PID liveness checks.
        finish(null, null);
      }, postKillTimeoutMs);
    };
    hardTimeout = setTimeout(() => {
      requestTermination();
    }, timeoutMs);
    if (hangMarkerPath !== null) {
      hangPoll = setInterval(async () => {
        try {
          const metadata = await lstat(hangMarkerPath);
          if (!metadata.isFile() || metadata.size <= 0) return;
          clearInterval(hangPoll);
          hangConfirmation = setTimeout(() => {
            requestTermination();
          }, HANG_CONFIRMATION_MS);
        } catch {
          // The create-new marker is expected to be absent until inference completes.
        }
      }, POLL_INTERVAL_MS);
    }
  });
}

function assertCleanProcessOutput(result, code) {
  if (
    result === null ||
    typeof result !== "object" ||
    result.outputOverflow === true ||
    !Buffer.isBuffer(result.stdout) ||
    result.stdout.length !== 0 ||
    !Buffer.isBuffer(result.stderr) ||
    result.stderr.length !== 0
  ) {
    fail(code);
  }
}

function buildRecovery(result, expectedSnapshotSha256) {
  if (
    result === null ||
    typeof result !== "object" ||
    result.backendExecuteCalls !== 1 ||
    result.checkSummary?.passed !== 12 ||
    result.checkSummary?.total !== 12 ||
    result.lockedInputSnapshotSha256 !== expectedSnapshotSha256
  ) {
    fail("FAULT_EVIDENCE_RECOVERY");
  }
  assertDigest(
    result.conformanceRecordSha256,
    "FAULT_EVIDENCE_RECOVERY",
  );
  return {
    backend_execute_calls: result.backendExecuteCalls,
    check_summary: {
      passed: result.checkSummary.passed,
      total: result.checkSummary.total,
    },
    conformance_record_sha256: result.conformanceRecordSha256,
    fresh_process: true,
  };
}

export async function publishNativeCandidateFaultEvidence(
  outputPath,
  bytes,
  operations = {},
) {
  validateNativeCandidateFaultEvidenceRecord(bytes);
  const resolved = await assertNewFilePath(outputPath, "FAULT_EVIDENCE_OUTPUT");
  const suffix = (operations.randomSuffix ?? (() => randomBytes(16).toString("hex")))();
  if (typeof suffix !== "string" || !/^[0-9a-f]{32}$/u.test(suffix)) {
    fail("FAULT_EVIDENCE_OUTPUT");
  }
  const stagingPath = path.join(
    path.dirname(resolved),
    `.${path.basename(resolved)}.${suffix}.staging`,
  );
  const openFile = operations.openFile ?? open;
  const linkFile = operations.linkFile ?? link;
  const readFileBytes = operations.readFileBytes ?? readFile;
  const unlinkFile = operations.unlinkFile ?? unlink;
  let handle;
  let stagingOwned = false;
  let finalPublished = false;
  let failed = false;
  try {
    handle = await openFile(stagingPath, "wx");
    stagingOwned = true;
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    const staged = await readFileBytes(stagingPath);
    if (!Buffer.isBuffer(staged) || !staged.equals(bytes)) {
      failed = true;
    } else {
      validateNativeCandidateFaultEvidenceRecord(staged);
    }
    if (failed) {
      throw new Error("FAULT_EVIDENCE_STAGING_VALIDATION");
    }
    await linkFile(stagingPath, resolved);
    finalPublished = true;
    const persisted = await readFileBytes(resolved);
    if (!Buffer.isBuffer(persisted) || !persisted.equals(bytes)) {
      failed = true;
    }
  } catch {
    failed = true;
  }
  if (handle !== undefined) {
    try {
      await handle.close();
    } catch {
      failed = true;
    }
  }
  if (stagingOwned) {
    try {
      await unlinkFile(stagingPath);
      stagingOwned = false;
    } catch {
      failed = true;
    }
  }
  if (failed) {
    if (finalPublished) {
      try {
        await unlinkFile(resolved);
        finalPublished = false;
      } catch {
        // A fully synced record may remain, but failure is never hidden.
      }
    }
    fail("FAULT_EVIDENCE_OUTPUT");
  }
  return resolved;
}

export async function validateNativeCandidateFaultEvidenceFile(inputPath) {
  const material = await digestRegularFile(inputPath, "FAULT_EVIDENCE_INPUT");
  return validateNativeCandidateFaultEvidenceRecord(material.bytes);
}

const LAUNCHER_MARKER_KEYS = Object.freeze([
  "broker_pid",
  "checkpoint",
  "child_pid",
  "kind",
  "mode",
]);
const ABORT_RESULT_MARKER_KEYS = Object.freeze([
  "checkpoint",
  "child_exit_code_dword",
  "kind",
  "mode",
]);
const REPRESENTATIVE_AV_MARKER_KEYS = Object.freeze([
  "checkpoint",
  "expected_exit_code_dword",
  "fault_origin",
  "kind",
  "sherpa_defect",
]);
const RUST_ABORT_MARKER_KEYS = Object.freeze([
  "checkpoint",
  "kind",
  "locked_input_snapshot_sha256",
  "mode",
  "process_id",
  "runtime_dlls",
  "schema_version",
  "self_sha256",
]);
const RUST_HANG_MARKER_KEYS = Object.freeze([
  "backend_execute_calls",
  ...RUST_ABORT_MARKER_KEYS,
]);

function assertU32(value, code) {
  if (!Number.isInteger(value) || value < 0 || value > 4_294_967_295) {
    fail(code);
  }
}

function validateLauncherMarker(bytes, mode, brokerPid) {
  const marker = parseCanonicalJsonLine(bytes, "FAULT_EVIDENCE_LAUNCHER_MARKER");
  assertExactKeys(
    marker,
    LAUNCHER_MARKER_KEYS,
    "FAULT_EVIDENCE_LAUNCHER_MARKER",
  );
  assertU32(marker.broker_pid, "FAULT_EVIDENCE_LAUNCHER_MARKER");
  assertU32(marker.child_pid, "FAULT_EVIDENCE_LAUNCHER_MARKER");
  if (
    marker.broker_pid !== brokerPid ||
    marker.checkpoint !== "child-resumed-under-kill-on-close-job" ||
    marker.kind !== "meetingrelay-native-fatal-launcher-marker-v1" ||
    marker.mode !== mode ||
    marker.child_pid === marker.broker_pid
  ) {
    fail("FAULT_EVIDENCE_LAUNCHER_MARKER");
  }
  return marker;
}

function validateFaultHostMarker({
  artifactSha256,
  bytes,
  childPid,
  expectedLoadedRuntime,
  expectedSnapshotSha256,
  mode,
}) {
  const marker = parseCanonicalJsonLine(bytes, "FAULT_EVIDENCE_FAULT_MARKER");
  assertExactKeys(
    marker,
    mode === "hang-after-inference"
      ? RUST_HANG_MARKER_KEYS
      : RUST_ABORT_MARKER_KEYS,
    "FAULT_EVIDENCE_FAULT_MARKER",
  );
  assertU32(marker.process_id, "FAULT_EVIDENCE_FAULT_MARKER");
  if (
    marker.kind !== "meetingrelay-native-candidate-fault-checkpoint-v1" ||
    marker.schema_version !== SCHEMA_VERSION ||
    marker.mode !== mode ||
    marker.checkpoint !==
      (mode === "abort-after-prepare"
        ? "real-prepare-loaded-runtime-identity"
        : "successful-real-inference") ||
    marker.process_id !== childPid ||
    marker.locked_input_snapshot_sha256 !== expectedSnapshotSha256 ||
    marker.self_sha256 !== artifactSha256 ||
    (mode === "hang-after-inference" && marker.backend_execute_calls !== 1)
  ) {
    fail("FAULT_EVIDENCE_FAULT_MARKER");
  }
  validateLoadedRuntime(marker.runtime_dlls, false);
  if (!isDeepStrictEqual(marker.runtime_dlls, expectedLoadedRuntime)) {
    fail("FAULT_EVIDENCE_FAULT_MARKER");
  }
  return marker;
}

function validateAbortResultMarker(bytes) {
  const marker = parseCanonicalJsonLine(bytes, "FAULT_EVIDENCE_ABORT_RESULT");
  assertExactKeys(
    marker,
    ABORT_RESULT_MARKER_KEYS,
    "FAULT_EVIDENCE_ABORT_RESULT",
  );
  assertU32(marker.child_exit_code_dword, "FAULT_EVIDENCE_ABORT_RESULT");
  if (
    marker.checkpoint !== "child-exit-observed" ||
    marker.kind !== "meetingrelay-native-fatal-result-marker-v1" ||
    marker.mode !== "abort-after-prepare" ||
    marker.child_exit_code_dword === 0
  ) {
    fail("FAULT_EVIDENCE_ABORT_RESULT");
  }
  return marker;
}

function validateRepresentativeAvMarker(bytes) {
  const marker = parseCanonicalJsonLine(bytes, "FAULT_EVIDENCE_AV_MARKER");
  assertExactKeys(
    marker,
    REPRESENTATIVE_AV_MARKER_KEYS,
    "FAULT_EVIDENCE_AV_MARKER",
  );
  if (
    marker.checkpoint !== "before-injected-access-violation" ||
    marker.expected_exit_code_dword !== 3_221_225_477 ||
    marker.fault_origin !== "injected-representative-boundary" ||
    marker.kind !== "meetingrelay-native-fatal-representative-av-marker-v1" ||
    marker.sherpa_defect !== false
  ) {
    fail("FAULT_EVIDENCE_AV_MARKER");
  }
  return marker;
}

async function readMarker(markerPath, code) {
  return digestRegularFile(markerPath, code);
}

async function prepareFaultEvidenceInputs(input) {
  if (process.platform !== "win32") {
    fail("FAULT_EVIDENCE_PLATFORM");
  }
  const faultHost = await digestRegularFile(
    input.faultHostPath,
    "FAULT_EVIDENCE_FAULT_HOST",
  );
  if (
    path.basename(faultHost.resolved) !== FAULT_HOST_FILE_NAME ||
    path.normalize(faultHost.resolved).toLowerCase() !==
      path.normalize(EXPECTED_FAULT_HOST_PATH).toLowerCase()
  ) {
    fail("FAULT_EVIDENCE_FAULT_HOST");
  }
  const boundaryFixture = await digestRegularFile(
    input.boundaryFixturePath,
    "FAULT_EVIDENCE_BOUNDARY_FIXTURE",
  );
  if (
    path.basename(boundaryFixture.resolved) !== BOUNDARY_FIXTURE_FILE_NAME ||
    path.normalize(boundaryFixture.resolved).toLowerCase() !==
      path.normalize(EXPECTED_BOUNDARY_FIXTURE_PATH).toLowerCase()
  ) {
    fail("FAULT_EVIDENCE_BOUNDARY_FIXTURE");
  }
  let lock;
  try {
    lock = await validateLockFile(input.assetLockPath);
  } catch {
    fail("FAULT_EVIDENCE_LOCK");
  }
  const stagedRuntime = await validateStagedRuntimeClosure(
    faultHost.resolved,
    lock.lock,
    "FAULT_EVIDENCE_RUNTIME",
  );
  const expectedLoadedRuntime = REQUIRED_LOADED_RUNTIME_NAMES.map((name) => {
    const entry = stagedRuntime.find((candidate) => candidate.fileName === name);
    if (entry === undefined) {
      fail("FAULT_EVIDENCE_RUNTIME");
    }
    return { name, sha256: entry.sha256 };
  });
  await assertNewFilePath(input.outputEvidencePath, "FAULT_EVIDENCE_OUTPUT");
  return {
    assetLockSha256: lock.lockSha256,
    boundaryFixture,
    expectedLoadedRuntime,
    faultHost,
    stagedRuntime,
  };
}

async function validatePostflightInputClosure(input, expected) {
  const current = await prepareFaultEvidenceInputs(input);
  if (current.assetLockSha256 !== expected.assetLockSha256) {
    fail("FAULT_EVIDENCE_POSTFLIGHT_LOCK");
  }
  if (
    current.boundaryFixture.resolved !== expected.boundaryFixture.resolved ||
    current.boundaryFixture.sha256 !== expected.boundaryFixture.sha256 ||
    current.boundaryFixture.sizeBytes !== expected.boundaryFixture.sizeBytes
  ) {
    fail("FAULT_EVIDENCE_POSTFLIGHT_BOUNDARY");
  }
  if (
    current.faultHost.resolved !== expected.faultHost.resolved ||
    current.faultHost.sha256 !== expected.faultHost.sha256 ||
    current.faultHost.sizeBytes !== expected.faultHost.sizeBytes
  ) {
    fail("FAULT_EVIDENCE_POSTFLIGHT_FAULT_HOST");
  }
  if (
    !isDeepStrictEqual(current.expectedLoadedRuntime, expected.expectedLoadedRuntime) ||
    !isDeepStrictEqual(current.stagedRuntime, expected.stagedRuntime)
  ) {
    fail("FAULT_EVIDENCE_POSTFLIGHT_RUNTIME");
  }
}

function defaultProcessLivenessProbe(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") {
      return false;
    }
    if (error?.code === "EPERM") {
      return true;
    }
    fail("FAULT_EVIDENCE_PROCESS_LIVENESS");
  }
}

export async function requireProcessesExited(
  pids,
  livenessProbe = defaultProcessLivenessProbe,
) {
  const uniquePids = [...new Set(pids)];
  if (
    uniquePids.length === 0 ||
    uniquePids.some((pid) => !Number.isInteger(pid) || pid <= 0)
  ) {
    fail("FAULT_EVIDENCE_PROCESS_LIVENESS");
  }
  const deadline = Date.now() + PROCESS_EXIT_POLL_TIMEOUT_MS;
  while (true) {
    const live = [];
    for (const pid of uniquePids) {
      if (await livenessProbe(pid)) {
        live.push(pid);
      }
    }
    if (live.length === 0) {
      return;
    }
    if (Date.now() >= deadline) {
      fail("FAULT_EVIDENCE_PROCESS_LIVENESS");
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

async function removeMarkerRootStrict(markerRoot) {
  let metadata;
  try {
    metadata = await lstat(markerRoot);
  } catch {
    fail("FAULT_EVIDENCE_CLEANUP");
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    fail("FAULT_EVIDENCE_CLEANUP");
  }
  try {
    await rm(markerRoot, {
      force: false,
      maxRetries: 3,
      recursive: true,
      retryDelay: 50,
    });
  } catch {
    fail("FAULT_EVIDENCE_CLEANUP");
  }
  try {
    await lstat(markerRoot);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return;
    }
    fail("FAULT_EVIDENCE_CLEANUP");
  }
  fail("FAULT_EVIDENCE_CLEANUP");
}

function conformanceInput(input) {
  return {
    assetLockPath: input.assetLockPath,
    executablePath: input.executablePath,
    modelPath: input.modelPath,
    packageLockPath: input.packageLockPath,
    runtimeLibDir: input.runtimeLibDir,
    schemaRegistryPath: input.schemaRegistryPath,
    tokensPath: input.tokensPath,
    wavPath: input.wavPath,
  };
}

function validateBaseline(result) {
  if (
    result === null ||
    typeof result !== "object" ||
    result.backendExecuteCalls !== 1 ||
    result.checkSummary?.passed !== 12 ||
    result.checkSummary?.total !== 12
  ) {
    fail("FAULT_EVIDENCE_BASELINE");
  }
  assertDigest(
    result.conformanceRecordSha256,
    "FAULT_EVIDENCE_BASELINE",
  );
  assertDigest(
    result.lockedInputSnapshotSha256,
    "FAULT_EVIDENCE_BASELINE",
  );
  return result.lockedInputSnapshotSha256;
}

async function runRecovery(conformanceRunner, input, expectedSnapshotSha256) {
  const result = await conformanceRunner(conformanceInput(input));
  return {
    recovery: buildRecovery(result, expectedSnapshotSha256),
    snapshotSha256: result.lockedInputSnapshotSha256,
  };
}

async function ensureNoPartialEvidence(outputEvidencePath) {
  await assertNewFilePath(outputEvidencePath, "FAULT_EVIDENCE_PARTIAL_OUTPUT");
}

export async function runNativeCandidateFaultEvidence(input, dependencies = {}) {
  const processRunner = dependencies.processRunner ?? runFaultBoundaryProcess;
  const conformanceRunner =
    dependencies.conformanceRunner ?? runReleaseNativeCandidateConformance;
  const prepareInputs =
    dependencies.prepareInputs ?? prepareFaultEvidenceInputs;
  const postflightInputs =
    dependencies.postflightInputs ?? validatePostflightInputClosure;
  const processExitChecker =
    dependencies.processExitChecker ?? requireProcessesExited;
  const cleanupMarkerRoot =
    dependencies.cleanupMarkerRoot ?? removeMarkerRootStrict;
  const createMarkerRoot =
    dependencies.createMarkerRoot ??
    (() => mkdtemp(path.join(os.tmpdir(), "meetingrelay-fault-evidence-")));
  const prepared = await prepareInputs(input);
  const baseline = await conformanceRunner(conformanceInput(input));
  const lockedInputSnapshotSha256 = validateBaseline(baseline);
  const markerRoot = await createMarkerRoot();
  const absoluteMarkerRoot = await assertRealPathChain(
    markerRoot,
    "FAULT_EVIDENCE_MARKER_ROOT",
  );
  const forwardedArguments = [
    path.resolve(input.schemaRegistryPath),
    path.resolve(input.modelPath),
    path.resolve(input.tokensPath),
    path.resolve(input.runtimeLibDir),
    path.resolve(input.assetLockPath),
    path.resolve(input.packageLockPath),
    path.resolve(input.wavPath),
  ];
  const lanes = [];
  let completedEvidenceBytes;
  let runFailure;

  try {
    await ensureNoPartialEvidence(input.outputEvidencePath);

    const abortLauncherPath = path.join(absoluteMarkerRoot, "abort-launcher.json");
    const abortResultPath = path.join(absoluteMarkerRoot, "abort-result.json");
    const abortFaultPath = path.join(absoluteMarkerRoot, "abort-fault.json");
    await Promise.all(
      [abortLauncherPath, abortResultPath, abortFaultPath].map((markerPath) =>
        assertNewFilePath(markerPath, "FAULT_EVIDENCE_CREATE_NEW_MARKER"),
      ),
    );
    const abortProcess = await processRunner({
      arguments: [
        "supervise-rust",
        "abort-after-prepare",
        abortLauncherPath,
        abortResultPath,
        prepared.faultHost.resolved,
        abortFaultPath,
        ...forwardedArguments,
      ],
      executablePath: prepared.boundaryFixture.resolved,
    });
    assertCleanProcessOutput(abortProcess, "FAULT_EVIDENCE_ABORT_PROCESS");
    if (
      abortProcess.error != null ||
      abortProcess.brokerCloseObserved !== true ||
      abortProcess.timedOut !== false ||
      abortProcess.status !== 0 ||
      abortProcess.signal !== null ||
      !Number.isInteger(abortProcess.pid) ||
      abortProcess.pid <= 0
    ) {
      fail("FAULT_EVIDENCE_ABORT_PROCESS");
    }
    const [abortLauncher, abortResult, abortFault] = await Promise.all([
      readMarker(abortLauncherPath, "FAULT_EVIDENCE_LAUNCHER_MARKER"),
      readMarker(abortResultPath, "FAULT_EVIDENCE_ABORT_RESULT"),
      readMarker(abortFaultPath, "FAULT_EVIDENCE_FAULT_MARKER"),
    ]);
    const abortLauncherRecord = validateLauncherMarker(
      abortLauncher.bytes,
      "abort-after-prepare",
      abortProcess.pid,
    );
    const abortFaultRecord = validateFaultHostMarker({
      artifactSha256: prepared.faultHost.sha256,
      bytes: abortFault.bytes,
      childPid: abortLauncherRecord.child_pid,
      expectedLoadedRuntime: prepared.expectedLoadedRuntime,
      expectedSnapshotSha256: lockedInputSnapshotSha256,
      mode: "abort-after-prepare",
    });
    const abortResultRecord = validateAbortResultMarker(abortResult.bytes);
    await processExitChecker(
      [abortProcess.pid, abortLauncherRecord.child_pid],
      dependencies.livenessProbe,
    );
    await ensureNoPartialEvidence(input.outputEvidencePath);
    await postflightInputs(input, prepared);
    const abortRecovery = await runRecovery(
      conformanceRunner,
      input,
      lockedInputSnapshotSha256,
    );
    lanes.push({
      checkpoint: abortFaultRecord.checkpoint,
      fault_artifact_sha256: prepared.faultHost.sha256,
      fault_injected: true,
      loaded_runtime: abortFaultRecord.runtime_dlls,
      marker_sha256: abortFault.sha256,
      mode: "abort-after-prepare",
      observation: normalizeStatus(
        abortResultRecord.child_exit_code_dword,
        "FAULT_EVIDENCE_ABORT_RESULT",
      ),
      postflight_snapshot_sha256: abortRecovery.snapshotSha256,
      recovery: abortRecovery.recovery,
      representative_only: false,
    });

    const hangLauncherPath = path.join(absoluteMarkerRoot, "hang-launcher.json");
    const hangFaultPath = path.join(absoluteMarkerRoot, "hang-fault.json");
    await Promise.all(
      [hangLauncherPath, hangFaultPath].map((markerPath) =>
        assertNewFilePath(markerPath, "FAULT_EVIDENCE_CREATE_NEW_MARKER"),
      ),
    );
    const hangProcess = await processRunner({
      arguments: [
        "supervise-rust",
        "hang-after-inference",
        hangLauncherPath,
        "-",
        prepared.faultHost.resolved,
        hangFaultPath,
        ...forwardedArguments,
      ],
      executablePath: prepared.boundaryFixture.resolved,
      hangMarkerPath: hangFaultPath,
    });
    assertCleanProcessOutput(hangProcess, "FAULT_EVIDENCE_HANG_PROCESS");
    if (
      hangProcess.error != null ||
      hangProcess.brokerCloseObserved !== true ||
      hangProcess.timedOut !== true ||
      !Number.isInteger(hangProcess.pid) ||
      hangProcess.pid <= 0
    ) {
      fail("FAULT_EVIDENCE_HANG_PROCESS");
    }
    const [hangLauncher, hangFault] = await Promise.all([
      readMarker(hangLauncherPath, "FAULT_EVIDENCE_LAUNCHER_MARKER"),
      readMarker(hangFaultPath, "FAULT_EVIDENCE_FAULT_MARKER"),
    ]);
    const hangLauncherRecord = validateLauncherMarker(
      hangLauncher.bytes,
      "hang-after-inference",
      hangProcess.pid,
    );
    const hangFaultRecord = validateFaultHostMarker({
      artifactSha256: prepared.faultHost.sha256,
      bytes: hangFault.bytes,
      childPid: hangLauncherRecord.child_pid,
      expectedLoadedRuntime: prepared.expectedLoadedRuntime,
      expectedSnapshotSha256: lockedInputSnapshotSha256,
      mode: "hang-after-inference",
    });
    await processExitChecker(
      [hangProcess.pid, hangLauncherRecord.child_pid],
      dependencies.livenessProbe,
    );
    await ensureNoPartialEvidence(input.outputEvidencePath);
    await postflightInputs(input, prepared);
    const hangRecovery = await runRecovery(
      conformanceRunner,
      input,
      lockedInputSnapshotSha256,
    );
    lanes.push({
      checkpoint: hangFaultRecord.checkpoint,
      fault_artifact_sha256: prepared.faultHost.sha256,
      fault_injected: true,
      loaded_runtime: hangFaultRecord.runtime_dlls,
      marker_sha256: hangFault.sha256,
      mode: "hang-after-inference",
      observation: {
        natural_ntstatus: false,
        ntstatus_hex: null,
        signed_i32: null,
        timed_out: true,
        unsigned_u32: null,
      },
      postflight_snapshot_sha256: hangRecovery.snapshotSha256,
      recovery: hangRecovery.recovery,
      representative_only: false,
    });

    const representativeMarkerPath = path.join(
      absoluteMarkerRoot,
      "representative-av.json",
    );
    await assertNewFilePath(
      representativeMarkerPath,
      "FAULT_EVIDENCE_CREATE_NEW_MARKER",
    );
    const representativeProcess = await processRunner({
      arguments: ["representative-av", representativeMarkerPath],
      executablePath: prepared.boundaryFixture.resolved,
    });
    assertCleanProcessOutput(
      representativeProcess,
      "FAULT_EVIDENCE_AV_PROCESS",
    );
    if (
      representativeProcess.error != null ||
      representativeProcess.brokerCloseObserved !== true ||
      representativeProcess.timedOut !== false ||
      representativeProcess.signal !== null
    ) {
      fail("FAULT_EVIDENCE_AV_PROCESS");
    }
    const representativeObservation = normalizeStatus(
      representativeProcess.status,
      "FAULT_EVIDENCE_AV_PROCESS",
    );
    if (representativeObservation.unsigned_u32 !== 3_221_225_477) {
      fail("FAULT_EVIDENCE_AV_PROCESS");
    }
    const representativeMarker = await readMarker(
      representativeMarkerPath,
      "FAULT_EVIDENCE_AV_MARKER",
    );
    const representativeMarkerRecord = validateRepresentativeAvMarker(
      representativeMarker.bytes,
    );
    if (
      representativeMarkerRecord.expected_exit_code_dword !==
      representativeObservation.unsigned_u32
    ) {
      fail("FAULT_EVIDENCE_AV_PROCESS");
    }
    await processExitChecker(
      [representativeProcess.pid],
      dependencies.livenessProbe,
    );
    await ensureNoPartialEvidence(input.outputEvidencePath);
    await postflightInputs(input, prepared);
    const representativeRecovery = await runRecovery(
      conformanceRunner,
      input,
      lockedInputSnapshotSha256,
    );
    lanes.push({
      checkpoint: representativeMarkerRecord.checkpoint,
      fault_artifact_sha256: prepared.boundaryFixture.sha256,
      fault_injected: true,
      loaded_runtime: [],
      marker_sha256: representativeMarker.sha256,
      mode: "representative-av",
      observation: representativeObservation,
      postflight_snapshot_sha256: representativeRecovery.snapshotSha256,
      recovery: representativeRecovery.recovery,
      representative_only: true,
    });

    const evidence = {
      authority: {
        formal_claims: "none",
        production_evidence: false,
      },
      kind: EVIDENCE_KIND,
      lanes,
      limitations: [...LIMITATIONS],
      locked_input_snapshot_sha256: lockedInputSnapshotSha256,
      schema_version: SCHEMA_VERSION,
    };
    const evidenceBytes = Buffer.from(encodeCanonicalJsonLine(evidence), "utf8");
    validateNativeCandidateFaultEvidenceRecord(evidenceBytes);
    completedEvidenceBytes = evidenceBytes;
  } catch (error) {
    runFailure = error;
  }
  await cleanupMarkerRoot(absoluteMarkerRoot);
  if (runFailure !== undefined) {
    throw runFailure;
  }
  if (!Buffer.isBuffer(completedEvidenceBytes)) {
    fail("FAULT_EVIDENCE_INTERNAL");
  }
  const publishEvidence =
    dependencies.publishEvidence ?? publishNativeCandidateFaultEvidence;
  await publishEvidence(input.outputEvidencePath, completedEvidenceBytes);
  return validateNativeCandidateFaultEvidenceFile(input.outputEvidencePath);
}

async function main(arguments_) {
  const [command, ...rest] = arguments_;
  if (command === "--validate" && rest.length === 1) {
    const result = await validateNativeCandidateFaultEvidenceFile(rest[0]);
    process.stdout.write(
      `candidate-native-fault-evidence-file=verified evidence_sha256=${result.evidenceSha256} ` +
        `locked_input_snapshot_sha256=${result.lockedInputSnapshotSha256} ` +
        `lanes=${result.laneCount} formal_claims=none production_evidence=false\n`,
    );
    return;
  }
  if (command === "--run" && rest.length === 11) {
    const result = await runNativeCandidateFaultEvidence({
      assetLockPath: rest[8],
      boundaryFixturePath: rest[1],
      executablePath: rest[3],
      faultHostPath: rest[0],
      modelPath: rest[5],
      outputEvidencePath: rest[2],
      packageLockPath: rest[9],
      runtimeLibDir: rest[7],
      schemaRegistryPath: rest[4],
      tokensPath: rest[6],
      wavPath: rest[10],
    });
    process.stdout.write(
      `candidate-native-fault-evidence=verified evidence_sha256=${result.evidenceSha256} ` +
        `locked_input_snapshot_sha256=${result.lockedInputSnapshotSha256} ` +
        `lanes=${result.laneCount} formal_claims=none production_evidence=false\n`,
    );
    return;
  }
  fail("FAULT_EVIDENCE_USAGE");
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(
      `${error instanceof NativeCandidateFaultEvidenceError ? error.code : "FAULT_EVIDENCE_INTERNAL"}\n`,
    );
    process.exitCode = 1;
  });
}
