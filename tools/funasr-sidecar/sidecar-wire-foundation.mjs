#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { TextDecoder } from "node:util";
import { encodeCanonicalJson, encodeCanonicalJsonLine } from "../phase0-harness/canonical-json.mjs";

export const WIRE_MAGIC = Buffer.from("MRSW", "ascii");
export const WIRE_VERSION = 1;
export const MAX_HEADER_BYTES = 65_536;
export const DEFAULT_MAX_PAYLOAD_BYTES = 1_048_576;
export const DEFAULT_MAX_STDIO_BYTES = 1_048_576;
export const DEFAULT_TIMEOUT_MS = 2_000;
export const DEFAULT_CLEANUP_TIMEOUT_MS = 250;
export const PUBLIC_EVIDENCE_KIND = "meetingrelay-funasr-sidecar-wire-foundation-v1";
export const PUBLIC_EVIDENCE_SCHEMA_VERSION = "1.0";
export const MOCK_SIDECAR_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "mock-sidecar.mjs");
export const PUBLIC_EVIDENCE_SCHEMA_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "sidecar-wire-foundation.schema.json");
export const MAX_REQUEST_FRAMES = 5;
export const MOCK_STDIN_MAX_BYTES = MAX_REQUEST_FRAMES * (13 + MAX_HEADER_BYTES + DEFAULT_MAX_PAYLOAD_BYTES);
export const ALLOWED_FAULT_MODES = new Set(["stderr", "timeout", "nonzero", "stdout-overflow", "extra-response-frame"]);

export const EXPECTED_FAULT_CODES = new Map([
  ["bad-magic", "SIDECAR_WIRE_WRONG_MAGIC"],
  ["bad-length", "SIDECAR_WIRE_HEADER_TOO_LARGE"],
  ["bom", "SIDECAR_WIRE_HEADER_BOM"],
  ["cr", "SIDECAR_WIRE_HEADER_CARRIAGE_RETURN"],
  ["nul", "SIDECAR_WIRE_HEADER_NUL"],
  ["non-utf8", "SIDECAR_WIRE_HEADER_UTF8"],
  ["schema-drift", "SIDECAR_SUPERVISOR_SCHEMA_DRIFT"],
  ["sequence-skip", "SIDECAR_SUPERVISOR_SEQUENCE_MISMATCH"],
  ["sequence-duplicate", "SIDECAR_SUPERVISOR_SEQUENCE_MISMATCH"],
  ["payload-digest", "SIDECAR_SUPERVISOR_PAYLOAD_DIGEST_MISMATCH"],
  ["payload-oversize", "SIDECAR_WIRE_PAYLOAD_TOO_LARGE"],
  ["stderr", "SIDECAR_SUPERVISOR_STDERR_NONEMPTY"],
  ["timeout", "SIDECAR_SUPERVISOR_TIMEOUT"],
  ["nonzero-exit", "SIDECAR_SUPERVISOR_NONZERO_EXIT"],
  ["stdout-overflow", "SIDECAR_SUPERVISOR_STDOUT_OVERFLOW"],
  ["extra-after-final", "SIDECAR_SUPERVISOR_RESPONSE_COUNT"],
]);

const decoder = new TextDecoder("utf-8", { fatal: true });
const forbiddenEvidenceKeys = new Set([
  "audio",
  "audio_path",
  "candidate",
  "controlled_root",
  "default",
  "file_path",
  "gold",
  "model_path",
  "plaintext_transcript",
  "publishable",
  "rank",
  "selection",
  "threshold",
  "transcript",
  "transcript_text",
  "wav",
]);

export class WireProtocolError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "WireProtocolError";
    this.code = code;
  }
}

export function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256File(path) {
  return sha256Hex(await readFile(path));
}

function assertPlainObject(value, code, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new WireProtocolError(code, `${label} must be an object`);
  }
}

function assertSafeInteger(value, code, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new WireProtocolError(code, `${label} must be a non-negative safe integer`);
  }
}

function assertHex64(value, code, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new WireProtocolError(code, `${label} must be lowercase sha256 hex`);
  }
}

function assertAllowedKeys(object, allowed, code, label) {
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) {
      throw new WireProtocolError(code, `${label} has unknown field ${key}`);
    }
  }
}

export function encodeFrame(header, payload = Buffer.alloc(0), options = {}) {
  const maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
  assertPlainObject(header, "SIDECAR_SUPERVISOR_HEADER_NOT_OBJECT", "header");
  const payloadBuffer = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  if (payloadBuffer.length > maxPayloadBytes || payloadBuffer.length > 0xffffffff) {
    throw new WireProtocolError("SIDECAR_WIRE_PAYLOAD_TOO_LARGE", "payload exceeds negotiated bound");
  }
  const headerBytes = Buffer.from(encodeCanonicalJsonLine(header), "utf8");
  if (headerBytes.length === 0) {
    throw new WireProtocolError("SIDECAR_WIRE_HEADER_EMPTY", "header is empty");
  }
  if (headerBytes.length > MAX_HEADER_BYTES) {
    throw new WireProtocolError("SIDECAR_WIRE_HEADER_TOO_LARGE", "header exceeds negotiated bound");
  }
  const prefix = Buffer.alloc(13);
  WIRE_MAGIC.copy(prefix, 0);
  prefix.writeUInt8(WIRE_VERSION, 4);
  prefix.writeUInt32BE(headerBytes.length, 5);
  prefix.writeUInt32BE(payloadBuffer.length, 9);
  return Buffer.concat([prefix, headerBytes, payloadBuffer]);
}

export function decodeFrames(buffer, options = {}) {
  const maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
  const maxFrames = options.maxFrames ?? 64;
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (frames.length >= maxFrames) {
      throw new WireProtocolError("SIDECAR_SUPERVISOR_TOO_MANY_FRAMES", "frame count exceeded negotiated bound");
    }
    if (buffer.length - offset < 13) {
      throw new WireProtocolError("SIDECAR_WIRE_FRAME_TOO_SHORT", "wire prefix is incomplete");
    }
    if (!buffer.subarray(offset, offset + 4).equals(WIRE_MAGIC)) {
      throw new WireProtocolError("SIDECAR_WIRE_WRONG_MAGIC", "wire magic mismatch");
    }
    const version = buffer.readUInt8(offset + 4);
    if (version !== WIRE_VERSION) {
      throw new WireProtocolError("SIDECAR_WIRE_UNSUPPORTED_VERSION", "wire version mismatch");
    }
    const headerLength = buffer.readUInt32BE(offset + 5);
    const payloadLength = buffer.readUInt32BE(offset + 9);
    if (headerLength === 0) {
      throw new WireProtocolError("SIDECAR_WIRE_HEADER_EMPTY", "header length is zero");
    }
    if (headerLength > MAX_HEADER_BYTES) {
      throw new WireProtocolError("SIDECAR_WIRE_HEADER_TOO_LARGE", "header length exceeds negotiated bound");
    }
    if (payloadLength > maxPayloadBytes) {
      throw new WireProtocolError("SIDECAR_WIRE_PAYLOAD_TOO_LARGE", "payload length exceeds negotiated bound");
    }
    const frameEnd = offset + 13 + headerLength + payloadLength;
    if (frameEnd > buffer.length) {
      throw new WireProtocolError("SIDECAR_WIRE_LENGTH_MISMATCH", "frame body is incomplete");
    }
    const headerBytes = buffer.subarray(offset + 13, offset + 13 + headerLength);
    if (headerBytes[0] === 0xef && headerBytes[1] === 0xbb && headerBytes[2] === 0xbf) {
      throw new WireProtocolError("SIDECAR_WIRE_HEADER_BOM", "header must not start with UTF-8 BOM");
    }
    if (headerBytes.includes(0x0d)) {
      throw new WireProtocolError("SIDECAR_WIRE_HEADER_CARRIAGE_RETURN", "header must not contain CR");
    }
    if (headerBytes.includes(0x00)) {
      throw new WireProtocolError("SIDECAR_WIRE_HEADER_NUL", "header must not contain NUL");
    }
    if (headerBytes[headerBytes.length - 1] !== 0x0a) {
      throw new WireProtocolError("SIDECAR_WIRE_HEADER_LINE_ENDING", "header must end with exactly one LF");
    }
    if (headerBytes.length > 1 && headerBytes[headerBytes.length - 2] === 0x0a) {
      throw new WireProtocolError("SIDECAR_WIRE_HEADER_LINE_ENDING", "header must contain one terminal LF only");
    }
    let headerText;
    try {
      headerText = decoder.decode(headerBytes.subarray(0, headerBytes.length - 1));
    } catch (error) {
      throw new WireProtocolError("SIDECAR_WIRE_HEADER_UTF8", `header must be UTF-8: ${error.message}`);
    }
    let header;
    try {
      header = JSON.parse(headerText);
    } catch (error) {
      throw new WireProtocolError("SIDECAR_SUPERVISOR_HEADER_JSON", `header must be JSON: ${error.message}`);
    }
    assertPlainObject(header, "SIDECAR_SUPERVISOR_HEADER_NOT_OBJECT", "header");
    const canonical = Buffer.from(encodeCanonicalJsonLine(header), "utf8");
    if (!canonical.equals(headerBytes)) {
      throw new WireProtocolError("SIDECAR_SUPERVISOR_HEADER_NOT_CANONICAL", "header must be canonical JSON line");
    }
    const payload = buffer.subarray(offset + 13 + headerLength, frameEnd);
    frames.push({ header, payload });
    offset = frameEnd;
  }
  return frames;
}

function validateHeaderEnvelope(header) {
  assertPlainObject(header, "SIDECAR_SUPERVISOR_SCHEMA_DRIFT", "header");
  if (typeof header.type !== "string") {
    throw new WireProtocolError("SIDECAR_SUPERVISOR_SCHEMA_DRIFT", "header.type must be a string");
  }
  assertSafeInteger(header.sequence, "SIDECAR_SUPERVISOR_SCHEMA_DRIFT", "header.sequence");
}

export function validateRequestHeader(header, expectedSequence = undefined, payload = Buffer.alloc(0)) {
  validateHeaderEnvelope(header);
  if (expectedSequence !== undefined && header.sequence !== expectedSequence) {
    throw new WireProtocolError("SIDECAR_SUPERVISOR_SEQUENCE_MISMATCH", "request sequence must be strictly increasing from one");
  }
  if (header.type === "hello") {
    assertAllowedKeys(header, new Set(["type", "sequence", "role", "transport"]), "SIDECAR_SUPERVISOR_SCHEMA_DRIFT", "hello");
    if (header.role !== "sidecar-candidate" || header.transport !== "isolated-process") {
      throw new WireProtocolError("SIDECAR_SUPERVISOR_SCHEMA_DRIFT", "hello role/transport mismatch");
    }
    if (payload.length !== 0) throw new WireProtocolError("SIDECAR_SUPERVISOR_PAYLOAD_UNEXPECTED", "hello payload must be empty");
  } else if (header.type === "prepare") {
    assertAllowedKeys(header, new Set(["type", "sequence", "audio_format", "sample_rate_hz"]), "SIDECAR_SUPERVISOR_SCHEMA_DRIFT", "prepare");
    if (header.audio_format !== "pcm_s16le" || header.sample_rate_hz !== 16_000) {
      throw new WireProtocolError("SIDECAR_SUPERVISOR_SCHEMA_DRIFT", "prepare audio format mismatch");
    }
    if (payload.length !== 0) throw new WireProtocolError("SIDECAR_SUPERVISOR_PAYLOAD_UNEXPECTED", "prepare payload must be empty");
  } else if (header.type === "audio") {
    assertAllowedKeys(header, new Set(["type", "sequence", "payload_bytes", "payload_sha256"]), "SIDECAR_SUPERVISOR_SCHEMA_DRIFT", "audio");
    assertSafeInteger(header.payload_bytes, "SIDECAR_SUPERVISOR_SCHEMA_DRIFT", "audio.payload_bytes");
    assertHex64(header.payload_sha256, "SIDECAR_SUPERVISOR_SCHEMA_DRIFT", "audio.payload_sha256");
    if (header.payload_bytes !== payload.length || header.payload_sha256 !== sha256Hex(payload)) {
      throw new WireProtocolError("SIDECAR_SUPERVISOR_PAYLOAD_DIGEST_MISMATCH", "audio payload length or digest mismatch");
    }
  } else if (header.type === "flush" || header.type === "shutdown") {
    assertAllowedKeys(header, new Set(["type", "sequence"]), "SIDECAR_SUPERVISOR_SCHEMA_DRIFT", header.type);
    if (payload.length !== 0) throw new WireProtocolError("SIDECAR_SUPERVISOR_PAYLOAD_UNEXPECTED", `${header.type} payload must be empty`);
  } else {
    throw new WireProtocolError("SIDECAR_SUPERVISOR_SCHEMA_DRIFT", `unsupported request type ${header.type}`);
  }
}

export function validateResponseHeader(header, expectedSequence = undefined) {
  validateHeaderEnvelope(header);
  if (expectedSequence !== undefined && header.sequence !== expectedSequence) {
    throw new WireProtocolError("SIDECAR_SUPERVISOR_SEQUENCE_MISMATCH", "response sequence must match request sequence");
  }
  const okTypes = new Map([
    ["hello_ok", new Set(["type", "sequence", "role", "transport"])],
    ["prepared", new Set(["type", "sequence", "audio_format", "sample_rate_hz"])],
    ["audio_ok", new Set(["type", "sequence", "payload_bytes", "payload_sha256"])],
    ["flushed", new Set(["type", "sequence", "audio_frames", "transcript_digest_sha256", "transcript_schema_sha256"])],
    ["shutdown_ok", new Set(["type", "sequence"])],
  ]);
  const allowed = okTypes.get(header.type);
  if (!allowed) throw new WireProtocolError("SIDECAR_SUPERVISOR_SCHEMA_DRIFT", `unsupported response type ${header.type}`);
  assertAllowedKeys(header, allowed, "SIDECAR_SUPERVISOR_SCHEMA_DRIFT", header.type);
  if (header.type === "hello_ok" && (header.role !== "sidecar-candidate" || header.transport !== "isolated-process")) {
    throw new WireProtocolError("SIDECAR_SUPERVISOR_SCHEMA_DRIFT", "hello_ok role/transport mismatch");
  }
  if (header.type === "prepared" && (header.audio_format !== "pcm_s16le" || header.sample_rate_hz !== 16_000)) {
    throw new WireProtocolError("SIDECAR_SUPERVISOR_SCHEMA_DRIFT", "prepared audio format mismatch");
  }
  if (header.type === "audio_ok") {
    assertSafeInteger(header.payload_bytes, "SIDECAR_SUPERVISOR_SCHEMA_DRIFT", "audio_ok.payload_bytes");
    assertHex64(header.payload_sha256, "SIDECAR_SUPERVISOR_SCHEMA_DRIFT", "audio_ok.payload_sha256");
  }
  if (header.type === "flushed") {
    assertSafeInteger(header.audio_frames, "SIDECAR_SUPERVISOR_SCHEMA_DRIFT", "flushed.audio_frames");
    assertHex64(header.transcript_digest_sha256, "SIDECAR_SUPERVISOR_SCHEMA_DRIFT", "flushed.transcript_digest_sha256");
    assertHex64(header.transcript_schema_sha256, "SIDECAR_SUPERVISOR_SCHEMA_DRIFT", "flushed.transcript_schema_sha256");
  }
}

export function buildRequestFrames(audioPayload = Buffer.from("meetingrelay mock audio\n", "utf8")) {
  const payload = Buffer.isBuffer(audioPayload) ? audioPayload : Buffer.from(audioPayload);
  return [
    { header: { type: "hello", sequence: 1, role: "sidecar-candidate", transport: "isolated-process" }, payload: Buffer.alloc(0) },
    { header: { type: "prepare", sequence: 2, audio_format: "pcm_s16le", sample_rate_hz: 16_000 }, payload: Buffer.alloc(0) },
    {
      header: { type: "audio", sequence: 3, payload_bytes: payload.length, payload_sha256: sha256Hex(payload) },
      payload,
    },
    { header: { type: "flush", sequence: 4 }, payload: Buffer.alloc(0) },
    { header: { type: "shutdown", sequence: 5 }, payload: Buffer.alloc(0) },
  ];
}

export function computeWireTranscriptSha256(requestFrames, responseFrames) {
  const hash = createHash("sha256");
  hash.update(Buffer.from("meetingrelay.sidecar-wire.transcript.v1\n", "utf8"));
  for (let index = 0; index < requestFrames.length; index += 1) {
    hash.update(Buffer.from("H", "ascii"));
    hash.update(encodeFrame(requestFrames[index].header, requestFrames[index].payload));
    if (responseFrames[index]) {
      hash.update(Buffer.from("W", "ascii"));
      hash.update(encodeFrame(responseFrames[index].header, responseFrames[index].payload));
    }
  }
  return hash.digest("hex");
}

function minimalEnv() {
  const nodeDir = dirname(process.execPath);
  const env = {
    PATH: nodeDir,
  };
  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot || "C:\\Windows";
    env.SystemRoot = systemRoot;
    env.WINDIR = systemRoot;
    env.PATH = `${nodeDir};${systemRoot}\\System32`;
  }
  return env;
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
      reject(new WireProtocolError(`${label}_OVERFLOW`, `${label} exceeded bounded collection limit`));
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

export async function runMockSidecarCleanHost(options = {}) {
  const sidecarPath = MOCK_SIDECAR_PATH;
  const faultMode = options.faultMode;
  if (faultMode !== undefined && !ALLOWED_FAULT_MODES.has(faultMode)) {
    throw new WireProtocolError("SIDECAR_SUPERVISOR_SCHEMA_DRIFT", "faultMode is not an allowed test mode");
  }
  const frames = options.frames ?? buildRequestFrames(options.audioPayload);
  for (const [index, frame] of frames.entries()) {
    validateRequestHeader(frame.header, index + 1, frame.payload);
  }
  const nodeExecutableSha256 = await sha256File(process.execPath);
  const mockSidecarSha256Before = await sha256File(sidecarPath);
  const stdinBytes = Buffer.concat(frames.map((frame) => encodeFrame(frame.header, frame.payload)));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cleanupTimeoutMs = options.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS;
  const maxStdoutBytes = options.maxStdoutBytes ?? DEFAULT_MAX_STDIO_BYTES;
  const maxStderrBytes = options.maxStderrBytes ?? 64 * 1024;
  const childEnv = minimalEnv();
  if (faultMode !== undefined) {
    childEnv.MEETINGRELAY_MOCK_SIDECAR_FAULT = faultMode;
  }
  const spawnOptions = {
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
    windowsHide: true,
    detached: false,
    env: childEnv,
  };
  const spawnImpl = options.spawnImpl ?? spawn;
  const child = spawnImpl(process.execPath, [sidecarPath], spawnOptions);
  let timedOut = false;
  let failureError;
  let exitResult = { code: null, signal: null };
  let closed = false;
  let signalFailure;
  const failureSignal = new Promise((resolveFailure) => {
    signalFailure = resolveFailure;
  });
  const fail = (error) => {
    if (!failureError) {
      failureError = error;
      if (!child.killed) child.kill();
      signalFailure();
    }
  };
  const stdoutBuffer = collectBounded(child.stdout, maxStdoutBytes, "SIDECAR_SUPERVISOR_STDOUT", fail);
  const stderrBuffer = collectBounded(child.stderr, maxStderrBytes, "SIDECAR_SUPERVISOR_STDERR", fail);
  const close = new Promise((resolveClose) => {
    child.on("error", (error) => fail(new WireProtocolError("SIDECAR_SUPERVISOR_SPAWN_FAILED", error.message)));
    child.on("exit", (code, signal) => {
      exitResult = { code, signal };
    });
    child.on("close", () => {
      closed = true;
      resolveClose();
    });
  });
  child.stdin.on("error", (error) => {
    fail(new WireProtocolError("SIDECAR_SUPERVISOR_STDIN_WRITE_FAILED", error.message));
  });
  const timer = setTimeout(() => {
    timedOut = true;
    fail(new WireProtocolError("SIDECAR_SUPERVISOR_TIMEOUT", "mock sidecar exceeded timeout"));
  }, timeoutMs);
  let cleanupTimedOut = false;
  try {
    child.stdin.end(stdinBytes, (error) => {
      if (error) {
        fail(new WireProtocolError("SIDECAR_SUPERVISOR_STDIN_WRITE_FAILED", error.message));
      }
    });
    await Promise.race([close, failureSignal]);
  } finally {
    clearTimeout(timer);
    stdoutBuffer.stop();
    stderrBuffer.stop();
    if (!closed && !child.killed) {
      child.kill();
    }
    if (!closed) {
      const cleanupCompleted = await Promise.race([close.then(() => true), new Promise((resolveDelay) => setTimeout(() => resolveDelay(false), cleanupTimeoutMs))]);
      cleanupTimedOut = cleanupCompleted !== true;
    }
  }
  if (cleanupTimedOut) {
    throw new WireProtocolError("SIDECAR_SUPERVISOR_CLEANUP_TIMEOUT", "direct child did not close within bounded cleanup");
  }
  if (timedOut && !failureError) {
    failureError = new WireProtocolError("SIDECAR_SUPERVISOR_TIMEOUT", "mock sidecar exceeded timeout");
  }
  const mockSidecarSha256After = await sha256File(sidecarPath);
  if (mockSidecarSha256Before !== mockSidecarSha256After) {
    throw new WireProtocolError("SIDECAR_SUPERVISOR_MOCK_CHANGED", "mock sidecar changed during supervised run");
  }
  if (failureError) {
    throw failureError;
  }
  const stderr = stderrBuffer.read();
  if (stderr.length !== 0) {
    throw new WireProtocolError("SIDECAR_SUPERVISOR_STDERR_NONEMPTY", "mock sidecar stderr must be empty");
  }
  if (exitResult.code !== 0 || exitResult.signal !== null) {
    throw new WireProtocolError("SIDECAR_SUPERVISOR_NONZERO_EXIT", "mock sidecar must exit cleanly");
  }
  const responseFrames = decodeFrames(stdoutBuffer.read(), { maxPayloadBytes: 0, maxFrames: 6 });
  if (responseFrames.length !== 5) {
    throw new WireProtocolError("SIDECAR_SUPERVISOR_RESPONSE_COUNT", "mock sidecar must return exactly five response frames");
  }
  responseFrames.forEach((frame, index) => {
    if (frame.payload.length !== 0) throw new WireProtocolError("SIDECAR_SUPERVISOR_PAYLOAD_UNEXPECTED", "responses must not carry payload");
    validateResponseHeader(frame.header, index + 1);
  });
  const expectedTypes = ["hello_ok", "prepared", "audio_ok", "flushed", "shutdown_ok"];
  responseFrames.forEach((frame, index) => {
    if (frame.header.type !== expectedTypes[index]) {
      throw new WireProtocolError("SIDECAR_SUPERVISOR_RESPONSE_ORDER", "response state machine order mismatch");
    }
  });
  return {
    requestFrames: frames,
    responseFrames,
    spawnContract: {
      command_is_process_exec_path: true,
      node_executable_sha256: nodeExecutableSha256,
      mock_sidecar_sha256: mockSidecarSha256Before,
      shell: spawnOptions.shell,
      windowsHide: spawnOptions.windowsHide,
      detached: spawnOptions.detached,
      minimal_environment: true,
      path_entries: childEnv.PATH.split(process.platform === "win32" ? ";" : ":").length,
      proxy_environment_forwarded: false,
      direct_child_closed: true,
    },
  };
}

function summarizeFault(code, fn) {
  const expected = EXPECTED_FAULT_CODES.get(code);
  try {
    fn();
  } catch (error) {
    const observed = error.code ?? "UNKNOWN";
    if (observed !== expected) {
      throw new WireProtocolError(
        "SIDECAR_SUPERVISOR_FAULT_CODE_MISMATCH",
        `fault ${code} observed ${observed}, expected ${expected}`,
      );
    }
    return { case: code, observed_code: observed, status: "covered" };
  }
  throw new Error(`fault ${code} did not fail`);
}

async function summarizeAsyncFault(code, fn) {
  const expected = EXPECTED_FAULT_CODES.get(code);
  try {
    await fn();
  } catch (error) {
    const observed = error.code ?? "UNKNOWN";
    if (observed !== expected) {
      throw new WireProtocolError(
        "SIDECAR_SUPERVISOR_FAULT_CODE_MISMATCH",
        `fault ${code} observed ${observed}, expected ${expected}`,
      );
    }
    return { case: code, observed_code: observed, status: "covered" };
  }
  throw new Error(`fault ${code} did not fail`);
}

export async function runFaultMatrix() {
  const good = buildRequestFrames();
  const goodBytes = Buffer.concat(good.map((frame) => encodeFrame(frame.header, frame.payload)));
  const badMagic = Buffer.from(goodBytes);
  badMagic[0] = 0x00;
  const badLength = Buffer.from(goodBytes);
  badLength.writeUInt32BE(MAX_HEADER_BYTES + 1, 5);
  const bom = encodeFrame(good[0].header);
  const bomHeader = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bom.subarray(13, 13 + bom.readUInt32BE(5))]);
  const bomFrame = Buffer.concat([Buffer.alloc(13), bomHeader]);
  WIRE_MAGIC.copy(bomFrame, 0);
  bomFrame.writeUInt8(WIRE_VERSION, 4);
  bomFrame.writeUInt32BE(bomHeader.length, 5);
  bomFrame.writeUInt32BE(0, 9);
  const cr = encodeFrame(good[0].header);
  cr[cr.length - 1] = 0x0d;
  const nul = encodeFrame(good[0].header);
  nul[13] = 0x00;
  const nonUtf8 = encodeFrame(good[0].header);
  nonUtf8[13] = 0xff;
  const schema = encodeFrame({ type: "hello", sequence: 1, role: "sidecar-candidate", transport: "isolated-process", extra: true });
  const seqSkip = [{ ...good[0], header: { ...good[0].header, sequence: 2 } }, ...good.slice(1)];
  const seqDup = [good[0], { ...good[1], header: { ...good[1].header, sequence: 1 } }, ...good.slice(2)];
  const digest = [good[0], good[1], { header: { ...good[2].header, payload_sha256: "0".repeat(64) }, payload: good[2].payload }, ...good.slice(3)];
  const oversizedPayload = encodeFrame({ type: "audio", sequence: 1, payload_bytes: 2, payload_sha256: sha256Hex(Buffer.from("xx")) }, Buffer.from("xx"));
  const faults = [
    summarizeFault("bad-magic", () => decodeFrames(badMagic)),
    summarizeFault("bad-length", () => decodeFrames(badLength)),
    summarizeFault("bom", () => decodeFrames(bomFrame)),
    summarizeFault("cr", () => decodeFrames(cr)),
    summarizeFault("nul", () => decodeFrames(nul)),
    summarizeFault("non-utf8", () => decodeFrames(nonUtf8)),
    summarizeFault("schema-drift", () => validateRequestHeader(decodeFrames(schema)[0].header, 1)),
    summarizeFault("sequence-skip", () => seqSkip.forEach((frame, index) => validateRequestHeader(frame.header, index + 1, frame.payload))),
    summarizeFault("sequence-duplicate", () => seqDup.forEach((frame, index) => validateRequestHeader(frame.header, index + 1, frame.payload))),
    summarizeFault("payload-digest", () => digest.forEach((frame, index) => validateRequestHeader(frame.header, index + 1, frame.payload))),
    summarizeFault("payload-oversize", () => decodeFrames(oversizedPayload, { maxPayloadBytes: 1 })),
    await summarizeAsyncFault("stderr", () => runMockSidecarCleanHost({ faultMode: "stderr" })),
    await summarizeAsyncFault("timeout", () => runMockSidecarCleanHost({ faultMode: "timeout", timeoutMs: 50 })),
    await summarizeAsyncFault("nonzero-exit", () => runMockSidecarCleanHost({ faultMode: "nonzero" })),
    await summarizeAsyncFault("stdout-overflow", () => runMockSidecarCleanHost({ faultMode: "stdout-overflow", maxStdoutBytes: 1024 })),
    await summarizeAsyncFault("extra-after-final", () => runMockSidecarCleanHost({ faultMode: "extra-response-frame" })),
  ];
  await runMockSidecarCleanHost();
  return faults.sort((a, b) => a.case.localeCompare(b.case));
}

export function scanForbidden(value, path = []) {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) scanForbidden(item, [...path, index]);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
    if (forbiddenEvidenceKeys.has(key)) {
        throw new WireProtocolError("SIDECAR_EVIDENCE_FORBIDDEN_FIELD", `public evidence contains forbidden field ${[...path, key].join(".")}`);
      }
      scanForbidden(item, [...path, key]);
    }
    return;
  }
  if (typeof value === "string") {
    if (/[A-Za-z]:\\|\/|\.wav|\.mp3|\.flac/iu.test(value)) {
      throw new WireProtocolError("SIDECAR_EVIDENCE_FORBIDDEN_VALUE", `public evidence contains forbidden value at ${path.join(".")}`);
    }
  }
}

export function buildPublicEvidence(cleanRun, faultMatrix) {
  const flushed = cleanRun.responseFrames.find((frame) => frame.header.type === "flushed").header;
  const wireTranscriptSha256 = computeWireTranscriptSha256(cleanRun.requestFrames, cleanRun.responseFrames);
  const schemaBytes = readFileSync(PUBLIC_EVIDENCE_SCHEMA_PATH);
  JSON.parse(schemaBytes.toString("utf8"));
  const faultRows = faultMatrix.map((fault) => ({ case: fault.case, observed_code: fault.observed_code, status: fault.status }));
  const evidence = {
    kind: PUBLIC_EVIDENCE_KIND,
    schema_version: PUBLIC_EVIDENCE_SCHEMA_VERSION,
    schema_file_sha256: sha256Hex(schemaBytes),
    measurement_status: "wire-fault-foundation-only",
    quality_gate_status: "not-assessed",
    execution_status: "mock-sidecar-only",
    formal_claims: "none",
    production_evidence: false,
    public_distribution: false,
    wire: {
      magic_sha256: sha256Hex(WIRE_MAGIC),
      version: WIRE_VERSION,
      max_header_bytes: MAX_HEADER_BYTES,
      max_payload_bytes: DEFAULT_MAX_PAYLOAD_BYTES,
      request_frame_count: cleanRun.requestFrames.length,
      response_frame_count: cleanRun.responseFrames.length,
      transcript_schema_sha256: flushed.transcript_schema_sha256,
      transcript_digest_sha256: flushed.transcript_digest_sha256,
      wire_transcript_preimage_domain: "meetingrelay.sidecar-wire.transcript.v1",
      wire_transcript_sha256: wireTranscriptSha256,
    },
    faults: {
      covered_count: faultRows.length,
      rows: faultRows,
      observations_sha256: sha256Hex(Buffer.from(encodeCanonicalJson(faultRows), "utf8")),
    },
    supervisor: cleanRun.spawnContract,
    limitations: [
      "mock-sidecar-only: no real FunASR model, Python runtime, model download, real audio, quality threshold, ranking, selection, default, or publication authority is exercised",
      "no heartbeat, progress protocol, restart budget, or recovery scheduler is exercised by this foundation",
      "no source or build attestation is produced by this Node-only mock-sidecar foundation",
      "no Job Object or grandchild containment proof is claimed; only direct child close is observed",
    ],
  };
  validatePublicEvidence(evidence);
  return evidence;
}

export function validatePublicEvidence(evidence) {
  assertPlainObject(evidence, "SIDECAR_EVIDENCE_SCHEMA", "evidence");
  assertAllowedKeys(
    evidence,
    new Set([
      "kind",
      "schema_version",
      "schema_file_sha256",
      "measurement_status",
      "quality_gate_status",
      "execution_status",
      "formal_claims",
      "production_evidence",
      "public_distribution",
      "wire",
      "faults",
      "supervisor",
      "limitations",
    ]),
    "SIDECAR_EVIDENCE_SCHEMA",
    "evidence",
  );
  if (evidence.kind !== PUBLIC_EVIDENCE_KIND) throw new WireProtocolError("SIDECAR_EVIDENCE_SCHEMA", "bad evidence kind");
  if (evidence.schema_version !== PUBLIC_EVIDENCE_SCHEMA_VERSION) throw new WireProtocolError("SIDECAR_EVIDENCE_SCHEMA", "bad schema version");
  assertHex64(evidence.schema_file_sha256, "SIDECAR_EVIDENCE_SCHEMA", "schema_file_sha256");
  const schemaSha = sha256Hex(readFileSync(PUBLIC_EVIDENCE_SCHEMA_PATH));
  if (evidence.schema_file_sha256 !== schemaSha) {
    throw new WireProtocolError("SIDECAR_EVIDENCE_SCHEMA", "schema file digest mismatch");
  }
  if (evidence.measurement_status !== "wire-fault-foundation-only") throw new WireProtocolError("SIDECAR_EVIDENCE_SCHEMA", "bad measurement status");
  if (evidence.quality_gate_status !== "not-assessed") throw new WireProtocolError("SIDECAR_EVIDENCE_SCHEMA", "bad quality status");
  if (evidence.execution_status !== "mock-sidecar-only") throw new WireProtocolError("SIDECAR_EVIDENCE_SCHEMA", "bad execution status");
  if (evidence.formal_claims !== "none" || evidence.production_evidence !== false || evidence.public_distribution !== false) {
    throw new WireProtocolError("SIDECAR_EVIDENCE_SCHEMA", "evidence overclaims authority");
  }
  assertPlainObject(evidence.wire, "SIDECAR_EVIDENCE_SCHEMA", "wire");
  assertAllowedKeys(
    evidence.wire,
    new Set([
      "magic_sha256",
      "version",
      "max_header_bytes",
      "max_payload_bytes",
      "request_frame_count",
      "response_frame_count",
      "transcript_schema_sha256",
      "transcript_digest_sha256",
      "wire_transcript_preimage_domain",
      "wire_transcript_sha256",
    ]),
    "SIDECAR_EVIDENCE_SCHEMA",
    "wire",
  );
  assertHex64(evidence.wire.magic_sha256, "SIDECAR_EVIDENCE_SCHEMA", "wire.magic_sha256");
  assertHex64(evidence.wire.transcript_schema_sha256, "SIDECAR_EVIDENCE_SCHEMA", "wire.transcript_schema_sha256");
  assertHex64(evidence.wire.transcript_digest_sha256, "SIDECAR_EVIDENCE_SCHEMA", "wire.transcript_digest_sha256");
  if (evidence.wire.wire_transcript_preimage_domain !== "meetingrelay.sidecar-wire.transcript.v1") {
    throw new WireProtocolError("SIDECAR_EVIDENCE_SCHEMA", "wire transcript domain mismatch");
  }
  assertHex64(evidence.wire.wire_transcript_sha256, "SIDECAR_EVIDENCE_SCHEMA", "wire.wire_transcript_sha256");
  if (evidence.wire.version !== 1 || evidence.wire.max_header_bytes !== MAX_HEADER_BYTES) {
    throw new WireProtocolError("SIDECAR_EVIDENCE_SCHEMA", "wire constants mismatch");
  }
  if (
    evidence.wire.max_payload_bytes !== DEFAULT_MAX_PAYLOAD_BYTES ||
    evidence.wire.request_frame_count !== 5 ||
    evidence.wire.response_frame_count !== 5
  ) {
    throw new WireProtocolError("SIDECAR_EVIDENCE_SCHEMA", "wire counts or payload bounds mismatch");
  }
  assertPlainObject(evidence.faults, "SIDECAR_EVIDENCE_SCHEMA", "faults");
  assertAllowedKeys(evidence.faults, new Set(["covered_count", "rows", "observations_sha256"]), "SIDECAR_EVIDENCE_SCHEMA", "faults");
  assertSafeInteger(evidence.faults.covered_count, "SIDECAR_EVIDENCE_SCHEMA", "faults.covered_count");
  if (!Array.isArray(evidence.faults.rows) || evidence.faults.rows.length !== EXPECTED_FAULT_CODES.size) {
    throw new WireProtocolError("SIDECAR_EVIDENCE_SCHEMA", "fault rows are incomplete");
  }
  const seenCases = new Set();
  let previousCase = "";
  for (const row of evidence.faults.rows) {
    assertPlainObject(row, "SIDECAR_EVIDENCE_SCHEMA", "fault row");
    assertAllowedKeys(row, new Set(["case", "observed_code", "status"]), "SIDECAR_EVIDENCE_SCHEMA", "fault row");
    if (typeof row.case !== "string" || !EXPECTED_FAULT_CODES.has(row.case)) {
      throw new WireProtocolError("SIDECAR_EVIDENCE_SCHEMA", "unknown fault case");
    }
    if (seenCases.has(row.case) || row.case.localeCompare(previousCase) < 0) {
      throw new WireProtocolError("SIDECAR_EVIDENCE_SCHEMA", "fault cases must be unique and sorted");
    }
    seenCases.add(row.case);
    previousCase = row.case;
    if (row.observed_code !== EXPECTED_FAULT_CODES.get(row.case) || row.status !== "covered") {
      throw new WireProtocolError("SIDECAR_EVIDENCE_SCHEMA", "fault observed code mismatch");
    }
  }
  if (evidence.faults.covered_count !== evidence.faults.rows.length) {
    throw new WireProtocolError("SIDECAR_EVIDENCE_SCHEMA", "fault count mismatch");
  }
  const observationsSha = sha256Hex(Buffer.from(encodeCanonicalJson(evidence.faults.rows), "utf8"));
  if (evidence.faults.observations_sha256 !== observationsSha) {
    throw new WireProtocolError("SIDECAR_EVIDENCE_SCHEMA", "fault observations digest mismatch");
  }
  assertHex64(evidence.faults.observations_sha256, "SIDECAR_EVIDENCE_SCHEMA", "fault observations digest");
  assertPlainObject(evidence.supervisor, "SIDECAR_EVIDENCE_SCHEMA", "supervisor");
  assertAllowedKeys(
    evidence.supervisor,
    new Set([
      "command_is_process_exec_path",
      "node_executable_sha256",
      "mock_sidecar_sha256",
      "shell",
      "windowsHide",
      "detached",
      "minimal_environment",
      "path_entries",
      "proxy_environment_forwarded",
      "direct_child_closed",
    ]),
    "SIDECAR_EVIDENCE_SCHEMA",
    "supervisor",
  );
  if (
    evidence.supervisor.command_is_process_exec_path !== true ||
    evidence.supervisor.shell !== false ||
    evidence.supervisor.windowsHide !== true ||
    evidence.supervisor.detached !== false ||
    evidence.supervisor.minimal_environment !== true ||
    evidence.supervisor.proxy_environment_forwarded !== false ||
    evidence.supervisor.direct_child_closed !== true
  ) {
    throw new WireProtocolError("SIDECAR_EVIDENCE_SCHEMA", "spawn contract mismatch");
  }
  assertHex64(evidence.supervisor.node_executable_sha256, "SIDECAR_EVIDENCE_SCHEMA", "supervisor.node_executable_sha256");
  assertHex64(evidence.supervisor.mock_sidecar_sha256, "SIDECAR_EVIDENCE_SCHEMA", "supervisor.mock_sidecar_sha256");
  if (!Number.isSafeInteger(evidence.supervisor.path_entries) || evidence.supervisor.path_entries < 1 || evidence.supervisor.path_entries > 2) {
    throw new WireProtocolError("SIDECAR_EVIDENCE_SCHEMA", "supervisor PATH entry count mismatch");
  }
  const expectedLimitations = [
    "mock-sidecar-only: no real FunASR model, Python runtime, model download, real audio, quality threshold, ranking, selection, default, or publication authority is exercised",
    "no heartbeat, progress protocol, restart budget, or recovery scheduler is exercised by this foundation",
    "no source or build attestation is produced by this Node-only mock-sidecar foundation",
    "no Job Object or grandchild containment proof is claimed; only direct child close is observed",
  ];
  if (!Array.isArray(evidence.limitations) || evidence.limitations.length !== expectedLimitations.length) {
    throw new WireProtocolError("SIDECAR_EVIDENCE_SCHEMA", "limitations must be explicit");
  }
  for (const [index, limitation] of expectedLimitations.entries()) {
    if (evidence.limitations[index] !== limitation) {
      throw new WireProtocolError("SIDECAR_EVIDENCE_SCHEMA", "limitation mismatch");
    }
  }
  scanForbidden(evidence);
  return true;
}

export async function runFoundation() {
  const cleanRun = await runMockSidecarCleanHost();
  const faultMatrix = await runFaultMatrix();
  return buildPublicEvidence(cleanRun, faultMatrix);
}

async function main(argv) {
  if (argv.length === 0 || argv[0] === "--run") {
    const evidence = await runFoundation();
    const evidenceText = encodeCanonicalJson(evidence);
    const evidenceSha = sha256Hex(Buffer.from(evidenceText, "utf8"));
    process.stdout.write(
      `funasr-sidecar-wire-foundation=verified evidence_sha256=${evidenceSha} faults=${evidence.faults.covered_count} measurement_status=${evidence.measurement_status} quality_gate_status=${evidence.quality_gate_status} execution_status=${evidence.execution_status} formal_claims=none production_evidence=false public_distribution=false\n`,
    );
    return;
  }
  if (argv[0] === "--validate" && argv.length === 2) {
    const evidence = JSON.parse(argv[1]);
    validatePublicEvidence(evidence);
    const evidenceText = encodeCanonicalJson(evidence);
    process.stdout.write(`funasr-sidecar-wire-foundation-json=verified evidence_sha256=${sha256Hex(Buffer.from(evidenceText, "utf8"))}\n`);
    return;
  }
  throw new Error("usage: node tools/funasr-sidecar/sidecar-wire-foundation.mjs [--run]|--validate '<json>'");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
