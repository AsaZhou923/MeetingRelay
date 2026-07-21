#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import {
  buildRequestFrames,
  decodeFrames,
  encodeFrame,
  MOCK_STDIN_MAX_BYTES,
  sha256Hex,
  validateRequestHeader,
} from "./sidecar-wire-foundation.mjs";
import { encodeCanonicalJsonLine } from "../phase0-harness/canonical-json.mjs";

function transcriptDigests(audioDigest, audioFrames) {
  const schema = {
    kind: "meetingrelay-funasr-mock-transcript-v1",
    fields: ["audio_frames", "audio_sha256"],
    plaintext_public: false,
  };
  const transcript = {
    kind: "meetingrelay-funasr-mock-transcript-v1",
    audio_frames: audioFrames,
    audio_sha256: audioDigest,
  };
  return {
    transcript_schema_sha256: sha256Hex(Buffer.from(encodeCanonicalJsonLine(schema), "utf8")),
    transcript_digest_sha256: sha256Hex(Buffer.from(encodeCanonicalJsonLine(transcript), "utf8")),
  };
}

async function readStdin() {
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    total += chunk.length;
    if (total > MOCK_STDIN_MAX_BYTES) {
      throw new Error("SIDECAR_SUPERVISOR_STDIN_OVERFLOW");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function runMockSidecar() {
  const fault = process.env.MEETINGRELAY_MOCK_SIDECAR_FAULT ?? "";
  if (fault === "stderr") {
    process.stderr.write("mock sidecar injected stderr\n");
    return 0;
  }
  if (fault === "timeout") {
    await new Promise(() => {});
    return 0;
  }
  if (fault === "nonzero") {
    return 17;
  }
  if (fault === "stdout-overflow") {
    process.stdout.write(Buffer.alloc(2 * 1024 * 1024, 0x41));
    return 0;
  }
  const input = await readStdin();
  const frames = decodeFrames(input);
  const template = buildRequestFrames();
  if (frames.length !== template.length) {
    throw new Error("sidecar request count mismatch");
  }
  let audioDigest = "0".repeat(64);
  let audioFrames = 0;
  const responses = [];
  for (const [index, frame] of frames.entries()) {
    validateRequestHeader(frame.header, index + 1, frame.payload);
    if (frame.header.type === "hello") {
      responses.push({ type: "hello_ok", sequence: 1, role: "sidecar-candidate", transport: "isolated-process" });
    } else if (frame.header.type === "prepare") {
      responses.push({ type: "prepared", sequence: 2, audio_format: "pcm_s16le", sample_rate_hz: 16_000 });
    } else if (frame.header.type === "audio") {
      audioDigest = frame.header.payload_sha256;
      audioFrames += 1;
      responses.push({
        type: "audio_ok",
        sequence: 3,
        payload_bytes: frame.header.payload_bytes,
        payload_sha256: frame.header.payload_sha256,
      });
    } else if (frame.header.type === "flush") {
      responses.push({ type: "flushed", sequence: 4, audio_frames: audioFrames, ...transcriptDigests(audioDigest, audioFrames) });
    } else if (frame.header.type === "shutdown") {
      responses.push({ type: "shutdown_ok", sequence: 5 });
    }
  }
  if (fault === "extra-response-frame") {
    responses.push({ type: "shutdown_ok", sequence: 6 });
  }
  process.stdout.write(Buffer.concat(responses.map((header) => encodeFrame(header))));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runMockSidecar()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
}
