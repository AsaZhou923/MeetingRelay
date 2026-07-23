import assert from "node:assert/strict";
import test from "node:test";

import {
  MVP_CONTRACT_VERSION,
  formatMvpErrorMessage,
  formatMvpSnapshotError,
  formatElapsed,
  hasCompleteMvpTranscript,
  hasAllMvpExportFormats,
  isMvpActiveLifecycle,
  isMvpActiveSession,
  parseAudioDeviceInventory,
  parseAudioDevicePreference,
  parseMvpExportResult,
  parseMvpRecognitionLanguage,
  parseMvpSnapshot,
  parseMvpTranscriptText,
  resolveAudioDeviceSelection,
} from "./mvp-contract.ts";

test("accepts only the per-meeting Chinese Japanese and English choices", () => {
  assert.equal(parseMvpRecognitionLanguage("zh"), "zh");
  assert.equal(parseMvpRecognitionLanguage("ja"), "ja");
  assert.equal(parseMvpRecognitionLanguage("en"), "en");
  assert.throws(() => parseMvpRecognitionLanguage("auto"), /recognition language/);
  assert.throws(() => parseMvpRecognitionLanguage("ko"), /recognition language/);
});

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

const finalSegment = (sequence, text = `saved ${sequence}`) => ({
  segmentId: `segment-${sequence}`,
  sequence: String(sequence),
  revision: 1,
  isFinal: true,
  saved: true,
  text,
  startedAtMs: String(sequence * 1000),
  endedAtMs: String(sequence * 1000 + 900),
  committedAt: String(sequence * 1000 + 950),
  commitId: `commit-${sequence}`,
});

const snapshot = {
  contractVersion: MVP_CONTRACT_VERSION,
  lifecycle: "ready",
  modelReady: true,
  modelLabel: "SenseVoice local CPU",
  localOnly: true,
  memoryOnly: false,
  meetingId: "meeting-20260721-001",
  sessionId: "meeting-20260721-001",
  durabilityStatus: "ready",
  savedFinalCount: "0",
  totalFinalCount: "0",
  visibleFinalWindowStartSequence: "1",
  lastSavedSequence: null,
  latestOpenedMeeting: null,
  availableExports: ["json", "markdown", "txt"],
  elapsedMs: "0",
  system: source("system"),
  microphone: source("microphone"),
  interim: null,
  finals: [],
  queueDepth: 0,
  error: null,
};

test("parses the strict durable ready snapshot and formats elapsed time", () => {
  assert.deepEqual(parseMvpSnapshot(snapshot), snapshot);
  assert.equal(formatElapsed("3723000"), "01:02:03");
});

test("rejects memory-only snapshots and unsupported durability state", () => {
  assert.throws(
    () => parseMvpSnapshot({ ...snapshot, memoryOnly: true }),
    /durable privacy boundary/,
  );
  assert.throws(
    () => parseMvpSnapshot({ ...snapshot, durabilityStatus: "memory" }),
    /durabilityStatus is unsupported/,
  );
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

test("rejects interim/final confusion, unsaved finals, and queue overflow", () => {
  const segment = finalSegment(1);
  assert.throws(
    () => parseMvpSnapshot({ ...snapshot, interim: segment }),
    /finality differs/,
  );
  assert.throws(
    () =>
      parseMvpSnapshot({
        ...snapshot,
        finals: [{ ...segment, saved: false }],
      }),
    /saved final/,
  );
  assert.throws(
    () => parseMvpSnapshot({ ...snapshot, queueDepth: 9 }),
    /outside the MVP bound/,
  );
});

test("parses the visible 64-row window while keeping total saved counts", () => {
  const finals = Array.from({ length: 64 }, (_, index) => finalSegment(index + 37));
  const parsed = parseMvpSnapshot({
    ...snapshot,
    finals,
    savedFinalCount: "100",
    totalFinalCount: "100",
    visibleFinalWindowStartSequence: "37",
    lastSavedSequence: "100",
  });

  assert.equal(parsed.finals.length, 64);
  assert.equal(parsed.savedFinalCount, "100");
  assert.equal(parsed.visibleFinalWindowStartSequence, "37");
  assert.equal(parsed.finals[0].sequence, "37");
  assert.equal(parsed.finals.at(-1)?.sequence, "100");
});

test("parses the Rust export result artifact shape", () => {
  assert.deepEqual(
    parseMvpExportResult({
      meetingId: "meeting-20260721-001",
      snapshotId: "snapshot-001",
      finalCount: 12,
      artifacts: [
        {
          format: "markdown",
          path: "C:\\Users\\Example\\Documents\\MeetingRelay\\meeting.md",
          byteLength: 1024,
          sha256: "a".repeat(64),
        },
        {
          format: "txt",
          path: "C:\\Users\\Example\\Documents\\MeetingRelay\\meeting.txt",
          byteLength: 512,
          sha256: "b".repeat(64),
        },
      ],
    }),
    {
      meetingId: "meeting-20260721-001",
      snapshotId: "snapshot-001",
      finalCount: 12,
      artifacts: [
        {
          format: "markdown",
          path: "C:\\Users\\Example\\Documents\\MeetingRelay\\meeting.md",
          byteLength: 1024,
          sha256: "a".repeat(64),
        },
        {
          format: "txt",
          path: "C:\\Users\\Example\\Documents\\MeetingRelay\\meeting.txt",
          byteLength: 512,
          sha256: "b".repeat(64),
        },
      ],
    },
  );
});

test("requires the full JSON Markdown TXT export capability set for UI export", () => {
  assert.equal(hasAllMvpExportFormats(["json", "markdown", "txt"]), true);
  assert.equal(hasAllMvpExportFormats(["txt", "json", "markdown"]), true);
  assert.equal(hasAllMvpExportFormats(["json", "markdown"]), false);
  assert.equal(hasAllMvpExportFormats(["json", "json", "txt"]), false);
});

test("parses paused snapshots and treats paused as an active session", () => {
  const parsed = parseMvpSnapshot({
    ...snapshot,
    lifecycle: "paused",
    durabilityStatus: "paused",
  });

  assert.equal(parsed.lifecycle, "paused");
  assert.equal(parsed.durabilityStatus, "paused");
  assert.equal(isMvpActiveSession(parsed), true);
  assert.equal(isMvpActiveLifecycle("paused"), true);
});

test("reports inactive completed lifecycle states for UI lock decisions", () => {
  assert.equal(isMvpActiveSession(snapshot), false);
  assert.equal(isMvpActiveLifecycle("ready"), false);
  assert.equal(isMvpActiveLifecycle("error"), false);
});

test("blocks copy and export affordances for persistently incomplete meetings", () => {
  assert.equal(
    hasCompleteMvpTranscript({
      durabilityStatus: "interrupted",
      error: "ASR_FINAL_OVERLOAD",
    }),
    false,
  );
  assert.equal(
    hasCompleteMvpTranscript({
      durabilityStatus: "interrupted",
      error: null,
    }),
    true,
  );
  assert.equal(
    hasCompleteMvpTranscript({
      durabilityStatus: "completed",
      error: null,
    }),
    true,
  );
});

test("parses full backend transcript text for clipboard copy", () => {
  assert.equal(parseMvpTranscriptText("full transcript\nsecond line"), "full transcript\nsecond line");
  assert.throws(() => parseMvpTranscriptText(123), /transcript text export/);
});

test("turns recoverable runtime error codes into actionable product messages", () => {
  assert.match(formatMvpErrorMessage("AUDIO_STREAM_ERROR"), /停止当前会议/);
  assert.match(formatMvpErrorMessage(new Error("ASR_WORKER_STOPPED")), /自动重建引擎/);
  assert.match(formatMvpErrorMessage("SHERPA_ASSET_MISSING"), /模型或运行时路径/);
  assert.match(formatMvpErrorMessage("MVP_RESUME_TIMEOUT"), /停止会议后重新开始/);
  assert.equal(formatMvpErrorMessage("CUSTOM_FAILURE"), "CUSTOM_FAILURE");
  assert.match(
    formatMvpSnapshotError({
      ...snapshot,
      error: "ASR_WORKER_STOPPED",
    }),
    /自动重建引擎/,
  );
});

test("parses selectable devices without collapsing duplicate display names", () => {
  const inventory = parseAudioDeviceInventory({
    systemOutputs: [
      { deviceId: "wasapi:speaker-a", name: "Speakers", isDefault: true },
      { deviceId: "wasapi:speaker-b", name: "Speakers", isDefault: false },
    ],
    microphones: [
      { deviceId: "wasapi:microphone-a", name: "USB Microphone", isDefault: true },
    ],
  });

  assert.equal(inventory.systemOutputs.length, 2);
  assert.equal(inventory.systemOutputs[0].name, inventory.systemOutputs[1].name);
  assert.notEqual(inventory.systemOutputs[0].deviceId, inventory.systemOutputs[1].deviceId);
});

test("uses current defaults only when there is no saved device preference", () => {
  const inventory = parseAudioDeviceInventory({
    systemOutputs: [
      { deviceId: "wasapi:speaker-a", name: "Speakers A", isDefault: false },
      { deviceId: "wasapi:speaker-b", name: "Speakers B", isDefault: true },
    ],
    microphones: [
      { deviceId: "wasapi:microphone-a", name: "Microphone", isDefault: true },
    ],
  });

  assert.deepEqual(resolveAudioDeviceSelection(inventory, null), {
    systemOutputDeviceId: "wasapi:speaker-b",
    microphoneDeviceId: "wasapi:microphone-a",
    staleSystemOutput: false,
    staleMicrophone: false,
  });
});

test("keeps a stale saved selection visible so the user must reselect", () => {
  const inventory = parseAudioDeviceInventory({
    systemOutputs: [
      { deviceId: "wasapi:speaker-current", name: "Current Speakers", isDefault: true },
    ],
    microphones: [
      { deviceId: "wasapi:microphone-current", name: "Current Mic", isDefault: true },
    ],
  });
  const preference = parseAudioDevicePreference(
    JSON.stringify({
      version: 1,
      systemOutputDeviceId: "wasapi:speaker-missing",
      microphoneDeviceId: "wasapi:microphone-current",
    }),
  );

  assert.deepEqual(resolveAudioDeviceSelection(inventory, preference), {
    systemOutputDeviceId: "wasapi:speaker-missing",
    microphoneDeviceId: "wasapi:microphone-current",
    staleSystemOutput: true,
    staleMicrophone: false,
  });
});

test("discards malformed local device preferences", () => {
  assert.equal(parseAudioDevicePreference("not json"), null);
  assert.equal(
    parseAudioDevicePreference(
      JSON.stringify({
        version: 1,
        systemOutputDeviceId: "wasapi:speaker\ninvalid",
        microphoneDeviceId: "wasapi:microphone",
      }),
    ),
    null,
  );
  assert.equal(
    parseAudioDevicePreference(
      JSON.stringify({
        version: 2,
        systemOutputDeviceId: "wasapi:speaker",
        microphoneDeviceId: "wasapi:microphone",
      }),
    ),
    null,
  );
});
