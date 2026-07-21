#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { encodeCanonicalJson } from "../phase0-harness/canonical-json.mjs";
import {
  PUBLIC_EVIDENCE_SCHEMA_PATH as PREFLIGHT_SCHEMA_PATH,
  REQUIRED_ROLES,
  VALIDATOR_SOURCE_PATH as PREFLIGHT_SOURCE_PATH,
  preflightCandidate,
  sha256Hex,
} from "./sidecar-candidate-preflight.mjs";
import {
  MAX_HEADER_BYTES,
  WIRE_VERSION,
  WireProtocolError,
  computeWireTranscriptSha256,
  encodeFrame,
  sha256Hex as wireSha256Hex,
} from "./sidecar-wire-foundation.mjs";
import {
  BOUNDARY_SOURCE_PATH,
  FIXED_HELLO_PROBE_SHA256,
  FIXED_HELLO_PROBE_SOURCE,
  FIXED_PYTHON_ARGS,
  bindExactManifestRuntime,
  getBoundRuntimeSnapshot,
  pathsEqualForPlatform,
  postflightExactRuntimeRootIdentity,
  runFixedHelloProbe,
} from "./sidecar-python-probe-boundary.mjs";

export const PUBLIC_EVIDENCE_KIND = "meetingrelay-funasr-sidecar-python-launch-v1";
export const PUBLIC_EVIDENCE_SCHEMA_VERSION = "1.1";
export const PUBLIC_EVIDENCE_SCHEMA_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "sidecar-python-launch.schema.json",
);
export const LAUNCHER_SOURCE_PATH = fileURLToPath(import.meta.url);
export const WIRE_FOUNDATION_SOURCE_PATH = fileURLToPath(new URL("./sidecar-wire-foundation.mjs", import.meta.url));
export const FIXED_PROBE_SOURCE = FIXED_HELLO_PROBE_SOURCE;
export const FIXED_PROBE_SHA256 = FIXED_HELLO_PROBE_SHA256;
export const FIXED_ARGS = FIXED_PYTHON_ARGS;
export { pathsEqualForPlatform };

const SHA256_RE = /^[0-9a-f]{64}$/u;
const FORBIDDEN_PUBLIC_KEYS = new Set([
  "absolute_path",
  "audio",
  "audio_path",
  "args",
  "bundle_root",
  "content",
  "controlled_root",
  "cwd",
  "default",
  "distribution_approval",
  "env",
  "environment",
  "executable_path",
  "file_path",
  "path",
  "plaintext",
  "plaintext_transcript",
  "rank",
  "root",
  "secret",
  "selection",
  "stderr",
  "stdout",
  "text",
  "threshold",
  "transcript",
  "transcript_text",
]);
const FORBIDDEN_PUBLIC_VALUE_RE =
  /(?:[A-Za-z]:\\|\\\\|\/tmp\/|\/home\/|\/Users\/|inputs\/|runtime\.bin|BEGIN (?:RSA |OPENSSH |)PRIVATE KEY)/iu;
const LIMITATIONS = Object.freeze([
  "python-launch-probe-only: invokes the caller-provided 4b-bound executable with fixed Python isolation flags and exchanges one hello frame; a compatible executable may emulate the Python CLI, so this is not CPython provenance",
  "executable-may-emulate-python-cli-no-cpython-provenance: no base DLL, stdlib, site-packages, loaded-image, or CPython distribution attestation is produced",
  "FunASR import, model load, audio processing, network access, download, quality, performance, ranking, selection, default, distribution, parent closeout, and Phase 1 remain unexecuted or unassessed",
  "packaging and materialization closure remain pending; this does not select or endorse a CPython distribution, base runtime, base DLL set, stdlib, site-packages, loaded-image set, or product packaging form",
  "no heartbeat, progress protocol, restart budget, recovery scheduler, Job Object containment, or grandchild-process containment proof is claimed; only bounded direct-child close is observed",
  "public evidence intentionally omits filesystem paths, file contents, plaintext, secrets, environment values, timings, host identity, parent closeout, and Phase 1 completion claims",
]);

export class PythonLaunchError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "PythonLaunchError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new PythonLaunchError(code, message);
}

function assertPlainObject(value, code, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(code, `${label} must be an object`);
  }
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
  if (!Number.isSafeInteger(value) || value < 1) fail(code, `${label} must be a positive safe integer`);
}

async function runBoundedProcess(command, args, options = {}) {
  const child = spawn(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
    windowsHide: true,
    detached: false,
    env: options.env,
    cwd: options.cwd,
  });
  let failure;
  const stdout = collectBounded(child.stdout, 64 * 1024, "PYTHON_LAUNCH_FIXTURE_STDOUT", (error) => {
    failure = error;
    if (!child.killed) child.kill();
  });
  const stderr = collectBounded(child.stderr, 64 * 1024, "PYTHON_LAUNCH_FIXTURE_STDERR", (error) => {
    failure = error;
    if (!child.killed) child.kill();
  });
  const result = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
  stdout.stop();
  stderr.stop();
  if (failure) throw failure;
  if (result.code !== 0 || result.signal !== null) {
    fail("PYTHON_LAUNCH_FIXTURE_PYTHON", "test-only Python fixture command failed");
  }
  return { stdout: stdout.read(), stderr: stderr.read() };
}

async function discoverHostPythonForFixture() {
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
    try {
      await runBoundedProcess(candidate.command, [...candidate.prefix, "-c", "import sys; raise SystemExit(0 if sys.version_info >= (3,8) else 1)"]);
      return candidate;
    } catch {
      // Try the next host-visible Python command. This is test-fixture discovery, not product selection.
    }
  }
  fail("PYTHON_LAUNCH_FIXTURE_PYTHON", "host Python 3.8+ is required for synthetic validation");
}

async function writeFixtureRoleFile(root, files, role, relativePath, bytes) {
  const absolute = path.join(root, ...relativePath.split("/"));
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, bytes);
  files.push({
    role,
    logical_id: `launch-${role}`,
    relative_path: relativePath,
    sha256: sha256Hex(bytes),
    size_bytes: bytes.length,
  });
}

export async function runSyntheticValidation() {
  const root = await mkdtemp(path.join(tmpdir(), "meetingrelay-python-launch-synthetic-"));
  try {
    const host = await discoverHostPythonForFixture();
    const venvRoot = path.join(root, "venv");
    await runBoundedProcess(host.command, [...host.prefix, "-m", "venv", venvRoot]);
    const executablePath = process.platform === "win32" ? path.join(venvRoot, "Scripts", "python.exe") : path.join(venvRoot, "bin", "python");
    const runtimeBytes = await readFile(executablePath);
    const files = [];
    for (const role of REQUIRED_ROLES) {
      if (role === "runtime") continue;
      await writeFixtureRoleFile(root, files, role, `inputs/${role}.bin`, Buffer.from(`synthetic ${role} bytes\n`, "utf8"));
    }
    files.push({
      role: "runtime",
      logical_id: "launch-runtime",
      relative_path: process.platform === "win32" ? "venv/Scripts/python.exe" : "venv/bin/python",
      sha256: sha256Hex(runtimeBytes),
      size_bytes: runtimeBytes.length,
    });
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
    const preflightEvidence = await preflightCandidate(root, manifestPath);
    return await launchPythonCandidate(root, manifestPath, executablePath, preflightEvidence.candidate_descriptor.aggregate_sha256);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
      reject(new PythonLaunchError(`${label}_OVERFLOW`, `${label} exceeded bounded collection limit`));
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

function mapBoundaryError(error) {
  if (typeof error.code !== "string" || !error.code.startsWith("PYTHON_PROBE_BOUNDARY_")) throw error;
  const mappedCode = error.code.replace("PYTHON_PROBE_BOUNDARY_", "PYTHON_LAUNCH_");
  const mappedMessage = error.message.replace(/^PYTHON_PROBE_BOUNDARY_[A-Z_]+: /u, "");
  throw new PythonLaunchError(mappedCode, mappedMessage);
}

function scanForbiddenPublicEvidence(value, pathSegments = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanForbiddenPublicEvidence(item, [...pathSegments, String(index)]));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (FORBIDDEN_PUBLIC_KEYS.has(key)) {
        fail("PYTHON_LAUNCH_EVIDENCE_FORBIDDEN", `forbidden public evidence key ${[...pathSegments, key].join(".")}`);
      }
      scanForbiddenPublicEvidence(item, [...pathSegments, key]);
    }
    return;
  }
  if (typeof value === "string" && FORBIDDEN_PUBLIC_VALUE_RE.test(value)) {
    fail("PYTHON_LAUNCH_EVIDENCE_FORBIDDEN", `forbidden public evidence value at ${pathSegments.join(".")}`);
  }
}

export async function launchPythonCandidate(controlledRoot, inputManifestPath, pythonExecutablePath, expectedAggregateSha256, options = {}) {
  assertSha256(expectedAggregateSha256, "PYTHON_LAUNCH_AGGREGATE", "expected candidate aggregate");
  let bound;
  let probeRun;
  let postflight;
  try {
    bound = await bindExactManifestRuntime(controlledRoot, inputManifestPath, pythonExecutablePath, expectedAggregateSha256, options);
    probeRun = await runFixedHelloProbe(bound, options);
    postflight = await postflightExactRuntimeRootIdentity(bound);
  } catch (error) {
    mapBoundaryError(error);
  }
  const boundSnapshot = getBoundRuntimeSnapshot(bound);
  const runtimeManifest = boundSnapshot.runtime_manifest;
  const runtimeBefore = boundSnapshot.runtime_before;
  const preflightEvidence = boundSnapshot.preflight_evidence;
  const schemaBytes = await readFile(PUBLIC_EVIDENCE_SCHEMA_PATH);
  JSON.parse(schemaBytes.toString("utf8"));
  const launcherBytes = await readFile(LAUNCHER_SOURCE_PATH);
  const wireBytes = await readFile(WIRE_FOUNDATION_SOURCE_PATH);
  const evidence = {
    kind: PUBLIC_EVIDENCE_KIND,
    schema_version: PUBLIC_EVIDENCE_SCHEMA_VERSION,
    schema_file_sha256: sha256Hex(schemaBytes),
    launcher_source_sha256: sha256Hex(launcherBytes),
    python_probe_boundary_source_sha256: sha256Hex(readFileSync(BOUNDARY_SOURCE_PATH)),
    preflight_schema_sha256: sha256Hex(readFileSync(PREFLIGHT_SCHEMA_PATH)),
    preflight_validator_source_sha256: sha256Hex(readFileSync(PREFLIGHT_SOURCE_PATH)),
    preflight_evidence_sha256: sha256Hex(Buffer.from(encodeCanonicalJson(preflightEvidence), "utf8")),
    canonical_input_manifest_sha256: preflightEvidence.canonical_input_manifest_sha256,
    candidate_aggregate_sha256: expectedAggregateSha256,
    measurement_status: "python-launch-probe-only",
    execution_status: "interpreter-launched-no-funasr",
    quality_gate_status: "not-assessed",
    formal_claims: "none",
    production_evidence: false,
    public_distribution: false,
    selection_authority: "none",
    packaging_authority: "none",
    worker_role: "sidecar-candidate",
    runtime: {
      role: "runtime",
      logical_id_sha256: sha256Hex(Buffer.from(runtimeManifest.logical_id, "utf8")),
      size_bytes: runtimeBefore.size_bytes,
      sha256: runtimeBefore.sha256,
      before_after_identity_match: postflight.runtime_before_after_identity_match,
    },
    probe: {
      fixed_probe_sha256: FIXED_PROBE_SHA256,
      fixed_probe_imports_sha256: sha256Hex(Buffer.from(encodeCanonicalJson(["json", "struct", "sys"]), "utf8")),
      imported_wire_foundation_source_sha256: sha256Hex(wireBytes),
      wire_version: WIRE_VERSION,
      max_header_bytes: MAX_HEADER_BYTES,
      request_frame_count: probeRun.requestFrames.length,
      response_frame_count: probeRun.responseFrames.length,
      one_frame_transcript_sha256: computeWireTranscriptSha256(probeRun.requestFrames, probeRun.responseFrames),
      request_frame_sha256: wireSha256Hex(encodeFrame(probeRun.requestFrames[0].header, probeRun.requestFrames[0].payload, { maxPayloadBytes: 0 })),
      response_frame_sha256: wireSha256Hex(encodeFrame(probeRun.responseFrames[0].header, probeRun.responseFrames[0].payload, { maxPayloadBytes: 0 })),
    },
    process_contract: {
      ...probeRun.processContract,
      fixed_argument_count: FIXED_ARGS.length + 1,
      fixed_arguments_sha256: sha256Hex(Buffer.from(encodeCanonicalJson([...FIXED_ARGS, "<fixed-probe-source>"]), "utf8")),
    },
    limitations: [...LIMITATIONS],
  };
  validatePublicEvidence(evidence);
  return evidence;
}

export function validatePublicEvidence(evidence) {
  assertPlainObject(evidence, "PYTHON_LAUNCH_EVIDENCE_SCHEMA", "evidence");
  assertAllowedKeys(
    evidence,
    new Set([
      "kind",
      "schema_version",
      "schema_file_sha256",
      "launcher_source_sha256",
      "python_probe_boundary_source_sha256",
      "preflight_schema_sha256",
      "preflight_validator_source_sha256",
      "preflight_evidence_sha256",
      "canonical_input_manifest_sha256",
      "candidate_aggregate_sha256",
      "measurement_status",
      "execution_status",
      "quality_gate_status",
      "formal_claims",
      "production_evidence",
      "public_distribution",
      "selection_authority",
      "packaging_authority",
      "worker_role",
      "runtime",
      "probe",
      "process_contract",
      "limitations",
    ]),
    "PYTHON_LAUNCH_EVIDENCE_SCHEMA",
    "evidence",
  );
  if (evidence.kind !== PUBLIC_EVIDENCE_KIND || evidence.schema_version !== PUBLIC_EVIDENCE_SCHEMA_VERSION) {
    fail("PYTHON_LAUNCH_EVIDENCE_SCHEMA", "bad evidence kind or schema version");
  }
  for (const key of [
    "schema_file_sha256",
    "launcher_source_sha256",
    "python_probe_boundary_source_sha256",
    "preflight_schema_sha256",
    "preflight_validator_source_sha256",
    "preflight_evidence_sha256",
    "canonical_input_manifest_sha256",
    "candidate_aggregate_sha256",
  ]) {
    assertSha256(evidence[key], "PYTHON_LAUNCH_EVIDENCE_SCHEMA", key);
  }
  if (
    evidence.schema_file_sha256 !== sha256Hex(readFileSync(PUBLIC_EVIDENCE_SCHEMA_PATH)) ||
    evidence.launcher_source_sha256 !== sha256Hex(readFileSync(LAUNCHER_SOURCE_PATH)) ||
    evidence.python_probe_boundary_source_sha256 !== sha256Hex(readFileSync(BOUNDARY_SOURCE_PATH)) ||
    evidence.preflight_schema_sha256 !== sha256Hex(readFileSync(PREFLIGHT_SCHEMA_PATH)) ||
    evidence.preflight_validator_source_sha256 !== sha256Hex(readFileSync(PREFLIGHT_SOURCE_PATH))
  ) {
    fail("PYTHON_LAUNCH_EVIDENCE_SCHEMA", "schema or source digest mismatch");
  }
  if (
    evidence.measurement_status !== "python-launch-probe-only" ||
    evidence.execution_status !== "interpreter-launched-no-funasr" ||
    evidence.quality_gate_status !== "not-assessed" ||
    evidence.formal_claims !== "none" ||
    evidence.production_evidence !== false ||
    evidence.public_distribution !== false ||
    evidence.selection_authority !== "none" ||
    evidence.packaging_authority !== "none" ||
    evidence.worker_role !== "sidecar-candidate"
  ) {
    fail("PYTHON_LAUNCH_EVIDENCE_OVERCLAIM", "evidence authority fields overclaim");
  }
  assertPlainObject(evidence.runtime, "PYTHON_LAUNCH_EVIDENCE_SCHEMA", "runtime");
  assertAllowedKeys(
    evidence.runtime,
    new Set(["role", "logical_id_sha256", "size_bytes", "sha256", "before_after_identity_match"]),
    "PYTHON_LAUNCH_EVIDENCE_SCHEMA",
    "runtime",
  );
  if (evidence.runtime.role !== "runtime" || evidence.runtime.before_after_identity_match !== true) {
    fail("PYTHON_LAUNCH_EVIDENCE_SCHEMA", "runtime identity mismatch");
  }
  assertSha256(evidence.runtime.logical_id_sha256, "PYTHON_LAUNCH_EVIDENCE_SCHEMA", "runtime.logical_id_sha256");
  assertSha256(evidence.runtime.sha256, "PYTHON_LAUNCH_EVIDENCE_SCHEMA", "runtime.sha256");
  assertPositiveSize(evidence.runtime.size_bytes, "PYTHON_LAUNCH_EVIDENCE_SCHEMA", "runtime.size_bytes");
  assertPlainObject(evidence.probe, "PYTHON_LAUNCH_EVIDENCE_SCHEMA", "probe");
  assertAllowedKeys(
    evidence.probe,
    new Set([
      "fixed_probe_sha256",
      "fixed_probe_imports_sha256",
      "imported_wire_foundation_source_sha256",
      "wire_version",
      "max_header_bytes",
      "request_frame_count",
      "response_frame_count",
      "one_frame_transcript_sha256",
      "request_frame_sha256",
      "response_frame_sha256",
    ]),
    "PYTHON_LAUNCH_EVIDENCE_SCHEMA",
    "probe",
  );
  for (const key of [
    "fixed_probe_sha256",
    "fixed_probe_imports_sha256",
    "imported_wire_foundation_source_sha256",
    "one_frame_transcript_sha256",
    "request_frame_sha256",
    "response_frame_sha256",
  ]) {
    assertSha256(evidence.probe[key], "PYTHON_LAUNCH_EVIDENCE_SCHEMA", `probe.${key}`);
  }
  if (
    evidence.probe.fixed_probe_sha256 !== FIXED_PROBE_SHA256 ||
    evidence.probe.fixed_probe_imports_sha256 !== sha256Hex(Buffer.from(encodeCanonicalJson(["json", "struct", "sys"]), "utf8")) ||
    evidence.probe.imported_wire_foundation_source_sha256 !== sha256Hex(readFileSync(WIRE_FOUNDATION_SOURCE_PATH)) ||
    evidence.probe.wire_version !== 1 ||
    evidence.probe.max_header_bytes !== MAX_HEADER_BYTES ||
    evidence.probe.request_frame_count !== 1 ||
    evidence.probe.response_frame_count !== 1
  ) {
    fail("PYTHON_LAUNCH_EVIDENCE_SCHEMA", "probe constants mismatch");
  }
  const expectedRequestFrame = { header: { type: "hello", sequence: 1, role: "sidecar-candidate", transport: "isolated-process" }, payload: Buffer.alloc(0) };
  const expectedResponseFrame = { header: { type: "hello_ok", sequence: 1, role: "sidecar-candidate", transport: "isolated-process" }, payload: Buffer.alloc(0) };
  const expectedRequestFrameSha256 = wireSha256Hex(encodeFrame(expectedRequestFrame.header, expectedRequestFrame.payload, { maxPayloadBytes: 0 }));
  const expectedResponseFrameSha256 = wireSha256Hex(encodeFrame(expectedResponseFrame.header, expectedResponseFrame.payload, { maxPayloadBytes: 0 }));
  const expectedTranscriptSha256 = computeWireTranscriptSha256([expectedRequestFrame], [expectedResponseFrame]);
  if (
    evidence.probe.request_frame_sha256 !== expectedRequestFrameSha256 ||
    evidence.probe.response_frame_sha256 !== expectedResponseFrameSha256 ||
    evidence.probe.one_frame_transcript_sha256 !== expectedTranscriptSha256
  ) {
    fail("PYTHON_LAUNCH_EVIDENCE_SCHEMA", "wire frame digest mismatch");
  }
  assertPlainObject(evidence.process_contract, "PYTHON_LAUNCH_EVIDENCE_SCHEMA", "process_contract");
  assertAllowedKeys(
    evidence.process_contract,
    new Set([
      "shell",
      "windowsHide",
      "detached",
      "cwd_is_controlled_root",
      "minimal_environment",
      "root_before_after_identity_match",
      "path_entries",
      "proxy_environment_forwarded",
      "fixed_argument_count",
      "fixed_arguments_sha256",
      "direct_child_closed",
    ]),
    "PYTHON_LAUNCH_EVIDENCE_SCHEMA",
    "process_contract",
  );
  if (
    evidence.process_contract.shell !== false ||
    evidence.process_contract.windowsHide !== true ||
    evidence.process_contract.detached !== false ||
    evidence.process_contract.cwd_is_controlled_root !== true ||
    evidence.process_contract.minimal_environment !== true ||
    evidence.process_contract.root_before_after_identity_match !== true ||
    evidence.process_contract.proxy_environment_forwarded !== false ||
    evidence.process_contract.fixed_argument_count !== 5 ||
    evidence.process_contract.fixed_arguments_sha256 !== sha256Hex(Buffer.from(encodeCanonicalJson([...FIXED_ARGS, "<fixed-probe-source>"]), "utf8")) ||
    evidence.process_contract.direct_child_closed !== true
  ) {
    fail("PYTHON_LAUNCH_EVIDENCE_SCHEMA", "process contract mismatch");
  }
  if (!Number.isInteger(evidence.process_contract.path_entries) || evidence.process_contract.path_entries < 1 || evidence.process_contract.path_entries > 3) {
    fail("PYTHON_LAUNCH_EVIDENCE_SCHEMA", "unexpected process path entry count");
  }
  if (!Array.isArray(evidence.limitations) || evidence.limitations.length !== LIMITATIONS.length) {
    fail("PYTHON_LAUNCH_EVIDENCE_SCHEMA", "limitations must be exact");
  }
  for (const [index, limitation] of LIMITATIONS.entries()) {
    if (evidence.limitations[index] !== limitation) fail("PYTHON_LAUNCH_EVIDENCE_SCHEMA", "limitation mismatch");
  }
  scanForbiddenPublicEvidence(evidence);
  return true;
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length === 1 && argv[0] === "--run-synthetic") {
    const evidence = await runSyntheticValidation();
    const evidenceText = encodeCanonicalJson(evidence);
    process.stdout.write(
      `funasr-sidecar-python-launch=verified evidence_sha256=${sha256Hex(Buffer.from(evidenceText, "utf8"))} candidate_aggregate_sha256=${evidence.candidate_aggregate_sha256} runtime_sha256=${evidence.runtime.sha256} fixed_probe_sha256=${evidence.probe.fixed_probe_sha256} one_frame_transcript_sha256=${evidence.probe.one_frame_transcript_sha256} measurement_status=${evidence.measurement_status} execution_status=${evidence.execution_status} quality_gate_status=${evidence.quality_gate_status} formal_claims=none production_evidence=false public_distribution=false selection_authority=none packaging_authority=none fixture_scope=test-only-venv-not-packaging-choice\n`,
    );
    return;
  }
  if (argv.length === 5 && argv[0] === "--launch") {
    const evidence = await launchPythonCandidate(argv[1], argv[2], argv[3], argv[4]);
    const evidenceText = encodeCanonicalJson(evidence);
    process.stdout.write(
      `funasr-sidecar-python-launch=verified evidence_sha256=${sha256Hex(Buffer.from(evidenceText, "utf8"))} candidate_aggregate_sha256=${evidence.candidate_aggregate_sha256} runtime_sha256=${evidence.runtime.sha256} fixed_probe_sha256=${evidence.probe.fixed_probe_sha256} one_frame_transcript_sha256=${evidence.probe.one_frame_transcript_sha256} measurement_status=${evidence.measurement_status} execution_status=${evidence.execution_status} quality_gate_status=${evidence.quality_gate_status} formal_claims=none production_evidence=false public_distribution=false selection_authority=none packaging_authority=none\n`,
    );
    return;
  }
  if (argv.length === 2 && argv[0] === "--validate-json") {
    let evidence;
    try {
      evidence = JSON.parse(argv[1]);
    } catch (error) {
      fail("PYTHON_LAUNCH_EVIDENCE_CANONICAL", `evidence must parse as JSON: ${error.message}`);
    }
    if (encodeCanonicalJson(evidence) !== argv[1]) {
      fail("PYTHON_LAUNCH_EVIDENCE_CANONICAL", "evidence must be canonical indented JSON with one terminal LF");
    }
    validatePublicEvidence(evidence);
    process.stdout.write(`funasr-sidecar-python-launch-json=verified evidence_sha256=${sha256Hex(Buffer.from(encodeCanonicalJson(evidence), "utf8"))}\n`);
    return;
  }
  fail(
    "PYTHON_LAUNCH_USAGE",
    "usage: node tools/funasr-sidecar/sidecar-python-launch.mjs [--run-synthetic]|--launch <controlled-root> <canonical-4b-input-manifest.json> <absolute-python-executable> <expected-candidate-aggregate-sha256>",
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const code = error.code ?? (error instanceof WireProtocolError ? error.code : "PYTHON_LAUNCH_FAILED");
    process.stderr.write(`${code}: ${error.message}\n`);
    process.exitCode = 1;
  });
}
