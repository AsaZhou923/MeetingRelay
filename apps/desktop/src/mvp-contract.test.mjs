import assert from "node:assert/strict";
import test from "node:test";

import { MVP_CONTRACT_VERSION, formatElapsed, parseMvpSnapshot } from "./mvp-contract.ts";

const source = (id) => ({
  id,
  label: id === "system" ? "Default speakers" : "Default microphone",
  ready: true,
  active: false,
  frames: "0",
  peak: 0,
  status: "ready",
  error: null,
});

const snapshot = {
  contractVersion: MVP_CONTRACT_VERSION,
  lifecycle: "ready",
  modelReady: true,
  modelLabel: "SenseVoice local CPU",
  localOnly: true,
  memoryOnly: true,
  sessionId: null,
  elapsedMs: "0",
  system: source("system"),
  microphone: source("microphone"),
  interim: null,
  finals: [],
  queueDepth: 0,
  error: null,
};

test("parses the strict ready snapshot and formats elapsed time", () => {
  assert.deepEqual(parseMvpSnapshot(snapshot), snapshot);
  assert.equal(formatElapsed("3723000"), "01:02:03");
});

test("rejects numeric counters and an invalid meter", () => {
  assert.throws(
    () => parseMvpSnapshot({ ...snapshot, elapsedMs: 0 }),
    /canonical unsigned decimal/,
  );
  assert.throws(
    () =>
      parseMvpSnapshot({
        ...snapshot,
        system: { ...snapshot.system, peak: 1.1 },
      }),
    /between zero and one/,
  );
});

test("rejects interim/final confusion and queue overflow", () => {
  const segment = {
    segmentId: "segment-1",
    revision: 1,
    isFinal: true,
    text: "hello",
    startedAtMs: "0",
    endedAtMs: "1000",
  };
  assert.throws(
    () => parseMvpSnapshot({ ...snapshot, interim: segment }),
    /finality differs/,
  );
  assert.throws(
    () => parseMvpSnapshot({ ...snapshot, queueDepth: 9 }),
    /outside the MVP bound/,
  );
});
