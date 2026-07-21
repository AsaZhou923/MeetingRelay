import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { PassThrough, Writable } from "node:stream";
import { promisify } from "node:util";
import {
  buildPublicEvidence,
  buildRequestFrames,
  DEFAULT_MAX_PAYLOAD_BYTES,
  decodeFrames,
  encodeFrame,
  EXPECTED_FAULT_CODES,
  PUBLIC_EVIDENCE_KIND,
  PUBLIC_EVIDENCE_SCHEMA_PATH,
  runFaultMatrix,
  runFoundation,
  runMockSidecarCleanHost,
  scanForbidden,
  sha256Hex,
  validatePublicEvidence,
  validateRequestHeader,
  WireProtocolError,
} from "./sidecar-wire-foundation.mjs";

const execFileAsync = promisify(execFile);

test("encodes and decodes canonical MRSW frames", () => {
  const [frame] = buildRequestFrames(Buffer.from("abc"));
  const encoded = encodeFrame(frame.header, frame.payload);
  assert.equal(encoded.subarray(0, 4).toString("ascii"), "MRSW");
  assert.equal(encoded.readUInt8(4), 1);
  const decoded = decodeFrames(encoded);
  assert.deepEqual(decoded[0].header, frame.header);
  assert.equal(decoded[0].payload.length, 0);
});

test("request validator enforces clean state machine and payload digest", () => {
  const frames = buildRequestFrames(Buffer.from("audio"));
  frames.forEach((frame, index) => validateRequestHeader(frame.header, index + 1, frame.payload));
  const bad = { ...frames[2], header: { ...frames[2].header, payload_sha256: "f".repeat(64) } };
  assert.throws(() => validateRequestHeader(bad.header, 3, bad.payload), WireProtocolError);
});

test("mock sidecar clean host returns deterministic bounded responses", async () => {
  const first = await runMockSidecarCleanHost();
  const second = await runMockSidecarCleanHost();
  assert.equal(first.responseFrames.length, 5);
  assert.deepEqual(first.responseFrames.map((frame) => frame.header.type), ["hello_ok", "prepared", "audio_ok", "flushed", "shutdown_ok"]);
  assert.equal(
    first.responseFrames[3].header.transcript_digest_sha256,
    second.responseFrames[3].header.transcript_digest_sha256,
  );
  assert.equal(first.spawnContract.command_is_process_exec_path, true);
  assert.equal(first.spawnContract.shell, false);
  assert.equal(first.spawnContract.windowsHide, true);
  assert.equal(first.spawnContract.detached, false);
  assert.equal(first.spawnContract.proxy_environment_forwarded, false);
});

test("fault matrix covers wire, process, and final-frame failures then recovers with a fresh clean host", async () => {
  const faults = await runFaultMatrix();
  const codes = new Set(faults.map((fault) => fault.case));
  for (const required of [
    "bad-magic",
    "bad-length",
    "bom",
    "cr",
    "nul",
    "non-utf8",
    "schema-drift",
    "sequence-skip",
    "sequence-duplicate",
    "payload-digest",
    "payload-oversize",
    "stderr",
    "timeout",
    "nonzero-exit",
    "stdout-overflow",
    "extra-after-final",
  ]) {
    assert.equal(codes.has(required), true, required);
  }
});

test("public evidence stays descriptive and rejects authority creep", async () => {
  const evidence = await runFoundation();
  assert.equal(evidence.kind, "meetingrelay-funasr-sidecar-wire-foundation-v1");
  assert.equal(evidence.measurement_status, "wire-fault-foundation-only");
  assert.equal(evidence.quality_gate_status, "not-assessed");
  assert.equal(evidence.execution_status, "mock-sidecar-only");
  assert.equal(evidence.formal_claims, "none");
  assert.equal(evidence.production_evidence, false);
  assert.equal(evidence.public_distribution, false);
  assert.equal(evidence.faults.covered_count >= 16, true);
  assert.equal(evidence.faults.rows.length, 16);
  assert.doesNotThrow(() => validatePublicEvidence(evidence));
  assert.throws(() => validatePublicEvidence({ ...evidence, threshold: 0.9 }), /SIDECAR_EVIDENCE_SCHEMA/u);
  assert.throws(
    () => validatePublicEvidence({ ...evidence, wire: { ...evidence.wire, audio_path: "C:\\secret\\sample.wav" } }),
    /SIDECAR_EVIDENCE_FORBIDDEN_FIELD|SIDECAR_EVIDENCE_SCHEMA/u,
  );
  assert.throws(
    () => validatePublicEvidence({ ...evidence, limitations: ["C:\\secret\\sample.wav", ...evidence.limitations.slice(1)] }),
    /SIDECAR_EVIDENCE_FORBIDDEN_VALUE|SIDECAR_EVIDENCE_SCHEMA/u,
  );
  assert.throws(() => validatePublicEvidence({ ...evidence, public_distribution: true }), /overclaims/u);
  assert.throws(() => scanForbidden({ transcript: "redacted" }), /SIDECAR_EVIDENCE_FORBIDDEN_FIELD/u);
  assert.throws(() => scanForbidden({ safe: "C:\\secret\\sample.wav" }), /SIDECAR_EVIDENCE_FORBIDDEN_VALUE/u);
});

test("evidence builder validates digests and limitations", async () => {
  const clean = await runMockSidecarCleanHost();
  const faults = await runFaultMatrix();
  const evidence = buildPublicEvidence(clean, faults);
  assert.match(evidence.wire.transcript_schema_sha256, /^[0-9a-f]{64}$/u);
  assert.match(evidence.wire.transcript_digest_sha256, /^[0-9a-f]{64}$/u);
  assert.match(evidence.wire.wire_transcript_sha256, /^[0-9a-f]{64}$/u);
  assert.match(evidence.schema_file_sha256, /^[0-9a-f]{64}$/u);
  assert.equal(evidence.limitations.some((item) => item.includes("Job Object")), true);
});

test("CLI run emits a strict verification marker", async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, ["tools/funasr-sidecar/sidecar-wire-foundation.mjs"], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(stderr, "");
  assert.match(
    stdout,
    /^funasr-sidecar-wire-foundation=verified evidence_sha256=[0-9a-f]{64} faults=16 measurement_status=wire-fault-foundation-only quality_gate_status=not-assessed execution_status=mock-sidecar-only formal_claims=none production_evidence=false public_distribution=false\r?\n$/u,
  );
});

test("codec rejects noncanonical and terminal newline drift", () => {
  const frame = buildRequestFrames()[0];
  const encoded = encodeFrame(frame.header, frame.payload);
  const headerStart = 13;
  const mutated = Buffer.from(encoded);
  mutated[headerStart] = 0x20;
  assert.throws(() => decodeFrames(mutated), WireProtocolError);
  const noLf = Buffer.from(encoded);
  noLf[noLf.length - 1] = 0x20;
  assert.throws(() => decodeFrames(noLf), WireProtocolError);
});

test("encodeFrame rejects negotiated payload boundary before Buffer/RangeError", () => {
  assert.throws(
    () => encodeFrame({ type: "audio", sequence: 1 }, Buffer.alloc(2), { maxPayloadBytes: 1 }),
    /SIDECAR_WIRE_PAYLOAD_TOO_LARGE/u,
  );
  assert.doesNotThrow(() => encodeFrame({ type: "audio", sequence: 1 }, Buffer.alloc(DEFAULT_MAX_PAYLOAD_BYTES)));
});

test("supervisor returns bounded cleanup timeout when direct child ignores kill after failure", async () => {
  function fakeSpawn() {
    const child = new EventEmitter();
    child.stdin = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = false;
    child.kill = () => {
      child.killed = true;
      return true;
    };
    queueMicrotask(() => child.stdout.write(Buffer.alloc(2048, 0x41)));
    return child;
  }
  const started = Date.now();
  await assert.rejects(
    () =>
      runMockSidecarCleanHost({
        spawnImpl: fakeSpawn,
        maxStdoutBytes: 8,
        cleanupTimeoutMs: 20,
        timeoutMs: 500,
      }),
    /SIDECAR_SUPERVISOR_CLEANUP_TIMEOUT/u,
  );
  assert.equal(Date.now() - started < 1000, true);
});

test("supervisor converts stdin EPIPE into stable bounded failure", async () => {
  function fakeSpawn() {
    const child = new EventEmitter();
    child.stdin = new Writable({
      write(_chunk, _encoding, callback) {
        const error = Object.assign(new Error("EPIPE"), { code: "EPIPE" });
        callback(error);
      },
    });
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = false;
    child.kill = () => {
      child.killed = true;
      queueMicrotask(() => {
        child.emit("exit", null, "SIGTERM");
        child.emit("close");
      });
      return true;
    };
    return child;
  }
  const started = Date.now();
  await assert.rejects(
    () =>
      runMockSidecarCleanHost({
        spawnImpl: fakeSpawn,
        cleanupTimeoutMs: 50,
        timeoutMs: 500,
      }),
    /SIDECAR_SUPERVISOR_STDIN_WRITE_FAILED/u,
  );
  assert.equal(Date.now() - started < 1000, true);
});

test("external JSON schema parses and mirrors manual validator constants", async () => {
  const schema = JSON.parse(await readFile(PUBLIC_EVIDENCE_SCHEMA_PATH, "utf8"));
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.kind.const, PUBLIC_EVIDENCE_KIND);
  assert.equal(schema.properties.schema_version.const, "1.0");
  assert.equal(schema.properties.wire.additionalProperties, false);
  assert.equal(schema.properties.wire.properties.max_header_bytes.const, 65_536);
  assert.equal(schema.properties.wire.properties.max_payload_bytes.const, DEFAULT_MAX_PAYLOAD_BYTES);
  assert.equal(schema.properties.faults.additionalProperties, false);
  assert.deepEqual(
    [...schema.properties.faults.properties.rows.items.properties.case.enum].sort(),
    [...EXPECTED_FAULT_CODES.keys()].sort(),
  );
  assert.equal(schema.properties.supervisor.additionalProperties, false);
  assert.equal(schema.properties.limitations.minItems, 4);
});

test("sha256 helper is stable lowercase hex", () => {
  assert.equal(sha256Hex(Buffer.from("abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});
