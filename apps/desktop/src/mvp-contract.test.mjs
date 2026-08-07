import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  MVP_CONTRACT_VERSION,
  APP_PREFERENCE_KEY,
  MAX_INFERENCE_QUEUE_DEPTH,
  formatMvpErrorMessage,
  formatMvpSnapshotError,
  formatElapsed,
  hasCompleteMvpTranscript,
  hasAllMvpExportFormats,
  isMvpActiveLifecycle,
  isMvpActiveSession,
  isWindowsAbsoluteDirectory,
  parseAudioDeviceInventory,
  parseAudioDevicePreference,
  parseAppPreference,
  parseAsrModelProfiles,
  parseDeletePreview,
  parseDeleteResult,
  parseDataDirectorySettings,
  parseDiagnosticBundleResult,
  parseExportOptions,
  parseInterruptedMeetings,
  parseMeetingDetail,
  parseMeetingListPage,
  parseLocalTranslationDiscovery,
  parseMvpAudioSourceMode,
  parseMvpExportResult,
  parseMvpRecognitionLanguage,
  parseMvpSnapshot,
  parseMvpTranscriptText,
  parseProviderProfiles,
  parseProviderProfileDraft,
  parseSegmentAudioLocation,
  parseSegmentSearchPage,
  parseSpeakerDiarizationResult,
  parseSpeakerVersion,
  parseSummaryJob,
  parseTranslationPreference,
  parseTranslationProbe,
  parseTranslationRetryProgress,
  requiresInsecureRemoteHttpAcknowledgement,
  resolveAudioDeviceSelection,
} from "./mvp-contract.ts";

test("parses restart-scoped data directory settings", () => {
  assert.deepEqual(
    parseDataDirectorySettings({
      activeDataDir: "C:\\Users\\Example\\AppData\\Local\\MeetingRelay\\mvp",
      configuredDataDir: "D:\\MeetingRelay Data",
      restartRequired: true,
      environmentOverride: false,
      activeStorageAvailable: true,
    }),
    {
      activeDataDir: "C:\\Users\\Example\\AppData\\Local\\MeetingRelay\\mvp",
      configuredDataDir: "D:\\MeetingRelay Data",
      restartRequired: true,
      environmentOverride: false,
      activeStorageAvailable: true,
    },
  );
  assert.throws(
    () =>
      parseDataDirectorySettings({
        activeDataDir: "relative",
        configuredDataDir: "D:\\MeetingRelay Data",
        restartRequired: true,
        environmentOverride: false,
        activeStorageAvailable: true,
      }),
    /activeDataDir/,
  );
});

test("wires data directory recovery before preflight as a validated restart-scoped setting", () => {
  const mainSource = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
  assert.match(mainSource, /id="data-directory"/);
  assert.match(mainSource, /invoke<unknown>\("mvp_save_data_directory", \{ dataDirectory \}\)/);
  assert.match(
    mainSource,
    /await loadDataDirectorySettings\(\)[\s\S]*render\(await call\("mvp_preflight"\)\)/,
  );
  assert.match(mainSource, /activeStorageAvailable/);
  assert.match(mainSource, /重启 MeetingRelay 后生效/);
  assert.match(mainSource, /旧数据仍保留/);
});

test("accepts only the per-meeting Chinese Japanese and English choices", () => {
  assert.equal(parseMvpRecognitionLanguage("zh"), "zh");
  assert.equal(parseMvpRecognitionLanguage("ja"), "ja");
  assert.equal(parseMvpRecognitionLanguage("en"), "en");
  assert.throws(() => parseMvpRecognitionLanguage("auto"), /recognition language/);
  assert.throws(() => parseMvpRecognitionLanguage("ko"), /recognition language/);
});

test("accepts only the three R2 audio source modes", () => {
  assert.equal(parseMvpAudioSourceMode("system_only"), "system_only");
  assert.equal(parseMvpAudioSourceMode("microphone_only"), "microphone_only");
  assert.equal(parseMvpAudioSourceMode("both"), "both");
  assert.throws(() => parseMvpAudioSourceMode("none"), /audio source mode/);
});

test("parses non-secret last-used application settings", () => {
  assert.equal(APP_PREFERENCE_KEY, "meetingrelay.app-settings.v1");
  assert.deepEqual(
    parseAppPreference(
      JSON.stringify({
        version: 1,
        recognitionLanguage: "ja",
        sourceMode: "system_only",
        transcriptDisplayMode: "translation_only",
        liveTextEnabled: true,
        liveTextDirectory: "C:\\Users\\Example\\Documents\\MeetingRelay Live",
      }),
    ),
    {
      version: 1,
      recognitionLanguage: "ja",
      sourceMode: "system_only",
      transcriptDisplayMode: "translation_only",
      liveTextEnabled: true,
      liveTextDirectory: "C:\\Users\\Example\\Documents\\MeetingRelay Live",
    },
  );
  assert.equal(
    parseAppPreference(
      JSON.stringify({
        version: 1,
        recognitionLanguage: "ja",
        sourceMode: "system_only",
        transcriptDisplayMode: "translation_only",
        liveTextEnabled: true,
        liveTextDirectory: "C:\\invalid\u0000path",
      }),
    ),
    null,
  );
});

test("recognizes drive and UNC live-text directories before backend validation", () => {
  assert.equal(isWindowsAbsoluteDirectory("C:\\Users\\Example\\MeetingRelay"), true);
  assert.equal(isWindowsAbsoluteDirectory("D:/MeetingRelay"), true);
  assert.equal(isWindowsAbsoluteDirectory("\\\\server\\share\\MeetingRelay"), true);
  assert.equal(isWindowsAbsoluteDirectory("C:relative"), false);
  assert.equal(isWindowsAbsoluteDirectory("relative\\MeetingRelay"), false);
});

test("parses the bounded R7 ASR model registry", () => {
  const profiles = parseAsrModelProfiles([
    {
      modelId: "sensevoice-zh-en-ja-ko-yue-int8-2024-07-17",
      label: "SenseVoice Small",
      tier: "stable-default",
      engine: "sherpa-onnx",
      engineVersion: "1.13.4",
      runtimeVersion: "1.27.0",
      modelRevision: "2024-07-17",
      modelSha256: "c".repeat(64),
      quantization: "int8",
      executionProvider: "CPU",
      nativeStreaming: false,
      supportedLanguages: ["zh", "ja", "en"],
      modelSizeBytes: "239233841",
      recommendedMemoryMb: 1024,
      licenseId: "LicenseRef-Test",
      installState: "verified",
      benchmarkStatus: "baseline-locked",
      selectable: true,
    },
    {
      modelId: "cohere-transcribe-03-2026",
      label: "Cohere Transcribe 2B",
      tier: "high-quality-default",
      engine: "transformers",
      engineVersion: "5.4.0",
      runtimeVersion: "torch-2.10.0+cu128",
      modelRevision: "b1eacc2686a3d08ceaae5f24a88b1d519620bc09",
      modelSha256: "9".repeat(64),
      quantization: "bf16",
      executionProvider: "CUDA",
      nativeStreaming: false,
      supportedLanguages: ["zh", "ja", "en"],
      modelSizeBytes: "4131862976",
      recommendedMemoryMb: 8192,
      licenseId: "Apache-2.0",
      installState: "verified",
      benchmarkStatus: "local-smoke-verified",
      selectable: true,
    },
  ]);
  assert.equal(profiles[0].tier, "stable-default");
  assert.equal(profiles[0].executionProvider, "CPU");
  assert.equal(profiles[0].nativeStreaming, false);
  assert.equal(profiles[1].tier, "high-quality-default");
  assert.equal(profiles[1].executionProvider, "CUDA");
  assert.equal(profiles[0].supportedLanguages[1], "ja");
  assert.throws(
    () =>
      parseAsrModelProfiles([
        {
          ...profiles[0],
          modelSha256: "not-a-digest",
        },
      ]),
    /modelSha256/,
  );
});

test("parses R8 local model discovery without credentials", () => {
  const discovery = parseLocalTranslationDiscovery({
    baseUrl: "http://127.0.0.1:11434/v1",
    endpoint: "http://127.0.0.1:11434/v1/models",
    providerFlavor: "ollama",
    models: [
      { id: "qwen2.5:7b", ownedBy: "ollama" },
      { id: "gemma3:4b", ownedBy: null },
    ],
    latencyMs: 12,
  });
  assert.equal(discovery.models[0].id, "qwen2.5:7b");
  assert.equal("apiKey" in discovery, false);
  assert.throws(
    () => parseLocalTranslationDiscovery({ ...discovery, models: [] }),
    /models/,
  );
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
  meetingSampleStart: String(sequence * 16_000),
  meetingSampleEnd: String(sequence * 16_000 + 14_400),
  timelineRevision: 1,
  translationStatus: "disabled",
  translationTarget: null,
  translationText: null,
  translationError: null,
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
  translationQueueDepth: 0,
  disk: {
    status: "ok",
    dataDir: "C:\\Users\\Example\\AppData\\Local\\MeetingRelay",
    freeBytes: "104857600",
    requiredBytes: "52428800",
    warning: null,
  },
  error: null,
};

test("parses completed translation state and rejects inconsistent shapes", () => {
  const translated = finalSegment(1);
  translated.translationStatus = "completed";
  translated.translationTarget = "ja";
  translated.translationText = "保存済み";
  assert.equal(
    parseMvpSnapshot({ ...snapshot, finals: [translated] }).finals[0].translationText,
    "保存済み",
  );
  assert.throws(
    () =>
      parseMvpSnapshot({
        ...snapshot,
        finals: [{ ...translated, translationText: null }],
      }),
    /translation state/,
  );
});

test("parses timeline sample fields for overlay-safe transcript rendering", () => {
  const parsed = parseMvpSnapshot({
    ...snapshot,
    lifecycle: "recording",
    durabilityStatus: "recording",
    interim: {
      ...finalSegment(1, "draft words"),
      segmentId: "interim-active",
      sequence: "0",
      revision: 3,
      isFinal: false,
      saved: false,
      committedAt: null,
      commitId: null,
      meetingSampleStart: "48000",
      meetingSampleEnd: "64000",
      timelineRevision: 7,
    },
    finals: [{ ...finalSegment(2), timelineRevision: 9 }],
    savedFinalCount: "1",
    totalFinalCount: "1",
    lastSavedSequence: "2",
  });

  assert.equal(parsed.interim?.meetingSampleStart, "48000");
  assert.equal(parsed.interim?.meetingSampleEnd, "64000");
  assert.equal(parsed.interim?.timelineRevision, 7);
  assert.equal(parsed.finals[0].meetingSampleStart, "32000");
  assert.equal(parsed.finals[0].timelineRevision, 9);
  assert.throws(
    () =>
      parseMvpSnapshot({
        ...snapshot,
        finals: [{ ...finalSegment(3), timelineRevision: 0 }],
      }),
    /timelineRevision/,
  );
  assert.throws(
    () =>
      parseMvpSnapshot({
        ...snapshot,
        finals: [{ ...finalSegment(4), meetingSampleStart: 0 }],
      }),
    /meetingSampleStart/,
  );
});

test("parses non-secret local translation preferences and probe results", () => {
  assert.deepEqual(
    parseTranslationPreference(
      JSON.stringify({
        version: 1,
        enabled: true,
        provider: "ollama",
        baseUrl: "",
        model: "qwen2.5:7b",
        targetLanguage: "zh",
      }),
    ),
    {
      version: 1,
      enabled: true,
      provider: "ollama",
      baseUrl: "",
      model: "qwen2.5:7b",
      targetLanguage: "zh",
      allowInsecureHttp: false,
      providerProfileId: null,
    },
  );
  assert.equal(
    parseTranslationPreference(
      JSON.stringify({
        version: 1,
        enabled: true,
        provider: "custom",
        baseUrl: "",
        model: "qwen2.5:7b",
        targetLanguage: "ja",
        allowInsecureHttp: true,
      }),
    )?.allowInsecureHttp,
    true,
  );
  assert.equal(parseTranslationPreference('{"version":1,"apiKey":"secret"}'), null);
  assert.deepEqual(
    parseTranslationPreference(
      JSON.stringify({
        version: 1,
        enabled: false,
        provider: "openai",
        providerProfileId: "provider-cloud-default",
        baseUrl: "",
        model: "",
        targetLanguage: "ja",
      }),
    ),
    {
      version: 1,
      enabled: false,
      provider: "openai",
      providerProfileId: "provider-cloud-default",
      baseUrl: "",
      model: "",
      targetLanguage: "ja",
      allowInsecureHttp: false,
    },
  );
  assert.equal(
    parseTranslationPreference(
      JSON.stringify({
        version: 1,
        enabled: true,
        provider: "custom",
        baseUrl: "https://api.example.test/v1",
        model: "model",
        targetLanguage: "zh",
      }),
    ),
    null,
  );
  assert.equal(
    parseTranslationPreference(
      JSON.stringify({
        version: 1,
        enabled: true,
        provider: "openai",
        Authorization: "Bearer mr-test-token-r1-r2",
        model: "model",
        targetLanguage: "zh",
      }),
    ),
    null,
  );
  assert.deepEqual(
    parseTranslationProbe({
      endpoint: "http://127.0.0.1:11434/v1/chat/completions",
      model: "qwen2.5:7b",
      targetLanguage: "zh",
      latencyMs: 42,
      preview: "连接成功",
    }),
    {
      endpoint: "http://127.0.0.1:11434/v1/chat/completions",
      model: "qwen2.5:7b",
      targetLanguage: "zh",
      latencyMs: 42,
      preview: "连接成功",
    },
  );
});

test("does not persist translation secrets or sensitive URLs in ordinary localStorage", () => {
  const mainSource = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
  const storageWrites = [...mainSource.matchAll(/localStorage\.setItem\(([\s\S]*?)\);\n/g)]
    .map((match) => match[1])
    .join("\n");
  assert.doesNotMatch(storageWrites, /apiKey|Authorization|Bearer mr-test-token-r1-r2/);
  assert.doesNotMatch(storageWrites, /baseUrl:\s*config\.baseUrl/);
  assert.match(mainSource, /API Token 不写入普通设置或 SQLite/);
  assert.match(mainSource, /Windows Credential Manager/);
  assert.doesNotMatch(mainSource, /API Token[^`\n]*不保存/);
  assert.doesNotMatch(mainSource, /밑균/);
  assert.match(mainSource, /id="provider-remove-secret"/);
  assert.match(mainSource, /"mvp_delete_provider_secret"/);
  assert.match(mainSource, /not_required/);
  assert.match(mainSource, /profile\.class === "local"/);
});

test("parses disk health and retry/recovery R1 R2 command result shapes", () => {
  assert.equal(
    parseMvpSnapshot({
      ...snapshot,
      disk: { ...snapshot.disk, status: "warning", warning: "low space" },
    }).disk.status,
    "warning",
  );
  assert.deepEqual(
    parseTranslationRetryProgress({
      batchId: "retry-20260725-001",
      status: "running",
      total: 3,
      progress: 1,
      succeeded: 1,
      failed: 0,
      cancelled: 0,
      costRiskAccepted: true,
      message: null,
    }),
    {
      batchId: "retry-20260725-001",
      status: "running",
      total: 3,
      progress: 1,
      succeeded: 1,
      failed: 0,
      cancelled: 0,
      costRiskAccepted: true,
      message: null,
    },
  );
  assert.throws(
    () =>
      parseTranslationRetryProgress({
        batchId: null,
        status: "running",
        total: 1,
        progress: 2,
        succeeded: 0,
        failed: 0,
        cancelled: 0,
        costRiskAccepted: true,
        message: null,
      }),
    /counters/,
  );
  assert.deepEqual(
    parseDiagnosticBundleResult({
      path: "C:\\Users\\Example\\Desktop\\meetingrelay-diagnostics.zip",
      byteLength: 2048,
      sha256: "c".repeat(64),
      redacted: true,
    }).redacted,
    true,
  );
  assert.equal(
    parseInterruptedMeetings([
      {
        meetingId: "meeting-20260725-001",
        startedAt: "2026-07-25T09:00:00Z",
        updatedAt: "2026-07-25T09:30:00Z",
        savedFinalCount: "12",
        pendingFinalCount: "1",
        translationFailedCount: 2,
        reason: "POWER_LOSS",
        recommendedAction: "recover",
      },
    ])[0].recommendedAction,
    "recover",
  );
  assert.equal(
    parseSegmentAudioLocation({
      available: true,
      path: "C:\\Users\\Example\\AppData\\Local\\MeetingRelay\\raw.wav",
      offsetMs: "1200",
      durationMs: "900",
      reason: null,
    }).offsetMs,
    "1200",
  );
  assert.throws(
    () =>
      parseSegmentAudioLocation({
        available: true,
        path: null,
        offsetMs: null,
        durationMs: null,
        reason: null,
      }),
    /available segment audio/,
  );
});

test("requires explicit acknowledgement only for non-loopback HTTP providers", () => {
  assert.equal(
    requiresInsecureRemoteHttpAcknowledgement("http://192.168.1.3:11434/v1"),
    true,
  );
  assert.equal(requiresInsecureRemoteHttpAcknowledgement("http://example.com/v1"), true);
  assert.equal(requiresInsecureRemoteHttpAcknowledgement("http://localhost:11434/v1"), false);
  assert.equal(requiresInsecureRemoteHttpAcknowledgement("http://127.0.0.1:11434/v1"), false);
  assert.equal(requiresInsecureRemoteHttpAcknowledgement("http://[::1]:1234/v1"), false);
  assert.equal(requiresInsecureRemoteHttpAcknowledgement("https://api.example.com/v1"), false);
  assert.equal(requiresInsecureRemoteHttpAcknowledgement("not a URL"), false);
});

test("parses the strict durable ready snapshot and formats elapsed time", () => {
  assert.deepEqual(parseMvpSnapshot(snapshot), snapshot);
  assert.equal(formatElapsed("3723000"), "01:02:03");
});

test("accepts the full bounded Cohere meeting provenance label", () => {
  const modelLabel =
    "Cohere Transcribe 2B · zh · CUDA · local [engine=transformers@5.4.0;runtime=torch-2.10.0+cu128;model=cohere-transcribe-03-2026;revision=b1eacc2686a3d08ceaae5f24a88b1d519620bc09;sha256=987bd3e141c7bfdb5a78f5db11397ee7737308357e6cc0a3f36a4979b158137a;quantization=bf16;native_streaming=false]";
  assert.equal(parseMvpSnapshot({ ...snapshot, modelLabel }).modelLabel, modelLabel);
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
    () => parseMvpSnapshot({ ...snapshot, queueDepth: MAX_INFERENCE_QUEUE_DEPTH + 1 }),
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
  assert.equal(hasAllMvpExportFormats(["json", "markdown", "txt", "docx", "pdf"]), true);
  assert.equal(hasAllMvpExportFormats(["txt", "json", "markdown", "pdf", "docx"]), true);
  assert.equal(hasAllMvpExportFormats(["json", "markdown", "txt"]), false);
  assert.equal(hasAllMvpExportFormats(["json", "json", "txt", "docx", "pdf"]), false);
});

test("parses R3 meeting library pages details and tags with bounded shapes", () => {
  const meeting = {
    meetingId: "meeting-20260725-001",
    title: "Design sync",
    status: "completed",
    startedAt: "2026-07-25T01:00:00Z",
    updatedAt: "2026-07-25T02:00:00Z",
    durationMs: "3600000",
    language: "zh",
    savedFinalCount: "2",
    translationFailedCount: 0,
    summaryStatus: "completed",
    tags: ["client", "roadmap"],
  };
  assert.equal(
    parseMeetingListPage({
      items: [meeting],
      nextCursor: "cursor-2",
      total: 10000,
      pageSize: 50,
      elapsedMs: 19,
    }).items[0].title,
    "Design sync",
  );
  assert.equal(
    parseMeetingListPage({
      items: [{ ...meeting, language: "unknown" }],
      nextCursor: null,
      total: 1,
      pageSize: 50,
      elapsedMs: 1,
    }).items[0].language,
    "unknown",
  );
  assert.equal(
    parseMeetingDetail({
      meeting,
      segments: [finalSegment(1), finalSegment(2)],
      summary: null,
    }).segments[1].sequence,
    "2",
  );
  assert.throws(
    () =>
      parseMeetingListPage({
        items: [meeting],
        nextCursor: null,
        total: 1,
        pageSize: 0,
        elapsedMs: 1,
      }),
    /pageSize/,
  );
  assert.throws(
    () =>
      parseMeetingListPage({
        items: [{ ...meeting, tags: ["dup", "dup"] }],
        nextCursor: null,
        total: 1,
        pageSize: 50,
        elapsedMs: 1,
      }),
    /duplicates/,
  );
});

test("parses R3 full text search hits with scope and exact jump targets", () => {
  const page = parseSegmentSearchPage({
    hits: [
      {
        meetingId: "meeting-20260725-001",
        meetingTitle: "Design sync",
        segmentId: "segment-42",
        sequence: "42",
        scope: "translation",
        snippet: "命中的译文片段",
        score: 12.5,
      },
      {
        meetingId: "meeting-20260725-001",
        meetingTitle: "Design sync",
        segmentId: null,
        sequence: null,
        scope: "summary",
        snippet: "摘要命中",
        score: 3,
      },
    ],
    nextCursor: null,
    total: 2,
    elapsedMs: 8,
  });
  assert.equal(page.hits[0].scope, "translation");
  assert.equal(page.hits[0].segmentId, "segment-42");
  assert.equal(page.hits[1].sequence, null);
  assert.throws(
    () =>
      parseSegmentSearchPage({
        hits: [
          {
            meetingId: "meeting-20260725-001",
            meetingTitle: "Design sync",
            segmentId: "segment-1",
            sequence: "1",
            scope: "unknown",
            snippet: "bad",
            score: 1,
          },
        ],
        nextCursor: null,
        total: 1,
        elapsedMs: 1,
      }),
    /scope/,
  );
});

test("parses R3 provider profiles and deletion preview without accepting secrets", () => {
  const profiles = parseProviderProfiles([
    {
      profileId: "provider-local",
      label: "Ollama",
      class: "local",
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "qwen2.5:7b",
      policyUrl: null,
      dataFlow: "Loopback only.",
      configVersion: 1,
      secretState: "not_required",
      lastTestStatus: "untested",
      lastTestAt: null,
      lastError: null,
    },
  ]);
  assert.equal(profiles[0].class, "local");
  assert.equal(profiles[0].secretState, "not_required");
  assert.equal(Object.keys(profiles[0]).some((key) => /secret/i.test(key) && key !== "secretState"), false);
  assert.deepEqual(
    parseProviderProfileDraft({
      profileId: "provider-local",
      label: "Ollama",
      class: "local",
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "qwen2.5:7b",
      policyUrl: null,
      dataFlow: "Loopback only.",
      configVersion: 2,
    }),
    {
      profileId: "provider-local",
      label: "Ollama",
      class: "local",
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "qwen2.5:7b",
      policyUrl: null,
      dataFlow: "Loopback only.",
      configVersion: 2,
    },
  );
  assert.throws(
    () =>
      parseProviderProfileDraft({
        profileId: "provider-local",
        label: "Ollama",
        class: "cloud",
        baseUrl: "https://api.example.test/v1",
        model: "model",
        policyUrl: null,
        dataFlow: "Cloud provider.",
        configVersion: 0,
      }),
    /configVersion/,
  );
  assert.equal(
    parseDeletePreview({
      meetingId: "meeting-20260725-001",
      recoveryWindowSeconds: 600,
      includeRaw: true,
      includeDerived: true,
      entries: [
        {
          type: "raw",
          path: "C:\\MeetingRelay\\raw.wav",
          byteLength: "1024",
          description: "raw audio",
        },
      ],
      willDeleteBytes: "1024",
      canRestore: true,
    }).entries[0].type,
    "raw",
  );
  assert.equal(
    parseDeleteResult({
      meetingId: "meeting-20260725-001",
      deleted: true,
      restoredUntil: "2026-07-25T02:10:00Z",
      entriesDeleted: 3,
      bytesDeleted: "2048",
    }).bytesDeleted,
    "2048",
  );
});

test("parses R4 summary jobs, citation links, and selectable export options", () => {
  const job = parseSummaryJob({
    jobId: "summary-job-1",
    meetingId: "meeting-20260725-001",
    status: "completed",
    version: 2,
    totalChunks: 4,
    completedChunks: 4,
    canCancel: false,
    canRetry: true,
    message: null,
    result: {
      summaryId: "summary-2",
      version: 2,
      language: "zh",
      overview: "本次会议确认路线图。",
      actions: ["修复 R0 环境问题"],
      decisions: ["R3/R4 先完成"],
      openQuestions: ["是否启用云端摘要？"],
      citations: [
        { segmentId: "segment-1", sequence: "1", label: "segment 1" },
        { segmentId: null, sequence: null, label: "model-generated grouping" },
      ],
      createdAt: "2026-07-25T02:00:00Z",
    },
  });
  assert.equal(job.result?.version, 2);
  assert.equal(job.result?.citations[1].sequence, null);
  assert.throws(
    () =>
      parseSummaryJob({
        ...job,
        result: null,
        totalChunks: 1,
        completedChunks: 2,
      }),
    /chunk counters/,
  );
  const parsedExportOptions = parseExportOptions({
      formats: ["json", "docx", "pdf"],
      includeOriginal: true,
      includeTranslation: true,
      bilingual: true,
      includeSpeaker: true,
      includeSummary: true,
      includeTimestamp: true,
      summaryVersion: 2,
      speakerVersion: 3,
    });
  assert.deepEqual(parsedExportOptions.formats, ["json", "docx", "pdf"]);
  assert.equal(parsedExportOptions.summaryVersion, 2);
  assert.equal(parsedExportOptions.speakerVersion, 3);
  assert.throws(
    () =>
      parseExportOptions({
        formats: ["json", "json"],
        includeOriginal: true,
        includeTranslation: false,
        bilingual: false,
        includeSpeaker: false,
        includeSummary: false,
        includeTimestamp: true,
        speakerVersion: 0,
      }),
    /duplicate/,
  );
  assert.throws(
    () =>
      parseExportOptions({
        formats: ["json"],
        includeOriginal: true,
        includeTranslation: false,
        bilingual: false,
        includeSpeaker: true,
        includeSummary: false,
        includeTimestamp: true,
        speakerVersion: 0,
      }),
    /speakerVersion/,
  );
});

test("requires an explicit summary provider and risk acknowledgement before transcript egress", () => {
  const mainSource = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
  assert.match(mainSource, /id="summary-provider"/);
  assert.match(mainSource, /confirmSummaryProviderEgress/);
  assert.match(mainSource, /summaryRiskAccepted:\s*true/);
  assert.doesNotMatch(
    mainSource,
    /mvp_summary_start[\s\S]{0,300}providerProfileId:\s*selectedProviderId/,
  );
});

test("parses R5 speaker versions and diarization results with strict bounds", () => {
  const speakerVersion = {
    meetingId: "meeting-20260725-001",
    version: 2,
    parentVersion: 1,
    algorithm: "meetingrelay.speaker.local-window-cluster.v1",
    digest: "d".repeat(64),
    createdAt: "2026-07-25T02:00:00Z",
    operation: "diarize",
    identities: [
      { speakerId: "spk-1", displayName: "Alice" },
      { speakerId: "spk-2", displayName: "Speaker 2" },
    ],
    assignments: [
      {
        segmentId: "segment-1",
        sequence: "1",
        sourceRevision: 1,
        speakerId: "spk-1",
        confidence: 0.94,
      },
    ],
  };

  const parsed = parseSpeakerVersion(speakerVersion);
  assert.equal(parsed?.version, 2);
  assert.equal(parsed?.identities[0].displayName, "Alice");
  assert.equal(parsed?.assignments[0].sequence, "1");
  assert.equal(parseSpeakerVersion(null), null);
  assert.deepEqual(
    parseSpeakerDiarizationResult({
      meetingId: "meeting-20260725-001",
      version: 3,
      status: "completed",
      reason: null,
    }),
    {
      meetingId: "meeting-20260725-001",
      version: 3,
      status: "completed",
      reason: null,
    },
  );
  assert.equal(
    parseSpeakerDiarizationResult({
      meetingId: "meeting-20260725-001",
      version: null,
      status: "unavailable",
      reason: "SPEAKER_RAW_AUDIO_REQUIRED",
    }).status,
    "unavailable",
  );
  assert.throws(
    () =>
      parseSpeakerVersion({
        ...speakerVersion,
        identities: [{ speakerId: "spk-1", displayName: "Alice\nbad" }],
      }),
    /displayName/,
  );
  assert.throws(
    () =>
      parseSpeakerVersion({
        ...speakerVersion,
        assignments: [{ ...speakerVersion.assignments[0], confidence: 1.2 }],
      }),
    /confidence/,
  );
  assert.throws(() => parseSpeakerVersion({ ...speakerVersion, version: 0 }), /version/);
  assert.throws(
    () =>
      parseSpeakerVersion({
        ...speakerVersion,
        assignments: [{ ...speakerVersion.assignments[0], speakerId: "spk-missing" }],
      }),
    /unknown identity/,
  );
});

test("wires R5 export to an explicit selected speaker version", () => {
  const mainSource = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
  assert.match(mainSource, /id="speaker-version-input" type="number" min="1" step="1"/);
  assert.match(mainSource, /"mvp_speaker_version"/);
  assert.match(mainSource, /latestSpeakerVersion/);
  assert.match(
    mainSource,
    /speakerVersion:\s*[\s\S]*controls\.exportSpeaker\.checked[\s\S]*speakerVersion\.version[\s\S]*null/,
  );
  assert.match(mainSource, /SPEAKER_EDIT_REQUIRES_LATEST_VERSION/);
});

test("uses Tauri window API for compact overlay controls", () => {
  const mainSource = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
  const overlaySource = readFileSync(new URL("./caption-overlay.ts", import.meta.url), "utf8");
  assert.match(mainSource, /import \{ Window \} from "@tauri-apps\/api\/window"/);
  assert.match(mainSource, /import \{ listen \} from "@tauri-apps\/api\/event"/);
  assert.match(mainSource, /Window\.getByLabel\(CAPTION_OVERLAY_WINDOW_LABEL\)/);
  assert.match(mainSource, /CAPTION_OVERLAY_WINDOW_MISSING/);
  assert.match(mainSource, /overlayWindow\.isVisible\(\)/);
  assert.match(mainSource, /overlayWindow\.show\(\)/);
  assert.match(mainSource, /overlayWindow\.hide\(\)/);
  assert.match(mainSource, /await syncOverlayState\(\);\s*await setOverlayVisible\(!overlayVisible\)/);
  assert.match(mainSource, /listen\(CAPTION_OVERLAY_HIDDEN_EVENT/);
  assert.match(mainSource, /syncOverlayState\(\)/);
  assert.match(mainSource, /beforeunload[\s\S]*unlisten\(\)/);
  assert.match(overlaySource, /import \{ emitTo \} from "@tauri-apps\/api\/event"/);
  assert.match(overlaySource, /aria-label="关闭悬浮字幕"/);
  assert.match(overlaySource, /renderedCaptionSignature/);
  assert.match(overlaySource, /overlayWindow\.hide\(\)/);
  assert.match(overlaySource, /emitTo\(MAIN_WINDOW_LABEL, OVERLAY_HIDDEN_EVENT/);
  assert.doesNotMatch(overlaySource, /overlayWindow\.close\(\)|destroy\(\)/);
  assert.doesNotMatch(mainSource, /mvp_overlay_(?:show|hide|state)/);
});

test("pauses compact overlay snapshot polling while the native window is hidden", () => {
  const overlaySource = readFileSync(new URL("./caption-overlay.ts", import.meta.url), "utf8");
  assert.match(overlaySource, /getCurrentWindow/);
  assert.match(
    overlaySource,
    /await overlayWindow\.isVisible\(\)[\s\S]*invoke<unknown>\("mvp_snapshot"\)/,
  );
  assert.match(overlaySource, /refreshInFlight/);
  assert.match(overlaySource, /visibilitychange/);
  assert.match(overlaySource, /setInterval\(\(\) => void refreshWhenVisible\(\), 250\)/);
});

test("restricts application IPC commands by window capability", () => {
  const buildSource = readFileSync(new URL("../src-tauri/build.rs", import.meta.url), "utf8");
  const libSource = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
  const modSource = readFileSync(new URL("../src-tauri/src/mvp/mod.rs", import.meta.url), "utf8");
  const mainCapability = JSON.parse(
    readFileSync(new URL("../src-tauri/capabilities/default.json", import.meta.url), "utf8"),
  );
  const overlayCapability = JSON.parse(
    readFileSync(new URL("../src-tauri/capabilities/caption-overlay.json", import.meta.url), "utf8"),
  );

  assert.match(buildSource, /AppManifest::new\(\)\.commands/);
  const registeredCommands = [...libSource.matchAll(/mvp::(mvp_[a-z_]+)/g)].map(
    (match) => match[1],
  );
  const manifestCommands = [...buildSource.matchAll(/"(mvp_[a-z_]+)"/g)].map(
    (match) => match[1],
  );
  const mainCommands = mainCapability.permissions
    .filter((permission) => permission.startsWith("allow-mvp-"))
    .map((permission) => permission.slice("allow-".length).replaceAll("-", "_"));
  assert.deepEqual(new Set(manifestCommands), new Set(registeredCommands));
  assert.deepEqual(new Set(mainCommands), new Set(registeredCommands));
  assert.ok(mainCapability.permissions.includes("core:event:allow-listen"));
  assert.ok(mainCapability.permissions.includes("core:event:allow-unlisten"));
  assert.ok(overlayCapability.permissions.includes("allow-mvp-snapshot"));
  assert.ok(overlayCapability.permissions.includes("core:window:allow-hide"));
  assert.ok(overlayCapability.permissions.includes("core:event:allow-emit-to"));
  assert.equal(
    overlayCapability.permissions.filter((permission) => permission.startsWith("allow-mvp-")).length,
    1,
  );
  assert.ok(!overlayCapability.permissions.includes("core:window:allow-close"));
  assert.ok(!overlayCapability.permissions.includes("core:window:allow-destroy"));
  assert.doesNotMatch(libSource, /mvp::mvp_test_translation/);
  assert.doesNotMatch(modSource, /pub fn mvp_test_translation/);
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
  assert.match(
    formatMvpErrorMessage("TRANSLATION_BASE_URL_HTTPS_REQUIRED"),
    /显式确认风险/,
  );
  assert.match(formatMvpErrorMessage("TRANSLATION_BASE_URL_INVALID"), /Base URL 无效/);
  assert.match(formatMvpErrorMessage("TRANSLATION_TIMEOUT"), /原文已保存在本机/);
  assert.match(formatMvpErrorMessage("TRANSLATION_PROBE_TIMEOUT"), /15 秒内未响应/);
  assert.match(formatMvpErrorMessage("LOCAL_TRANSLATION_SERVICE_TIMEOUT"), /本地翻译服务/);
  assert.match(formatMvpErrorMessage("LIVE_TEXT_DIRECTORY_NOT_ABSOLUTE"), /绝对路径/);
  assert.match(formatMvpErrorMessage("LIVE_TEXT_DIRECTORY_UNAVAILABLE"), /不存在或不是文件夹/);
  assert.match(formatMvpErrorMessage("LIVE_TEXT_MIRROR_BEGIN_FAILED"), /会议未开始/);
  assert.match(formatMvpErrorMessage("LIVE_TEXT_MIRROR_WRITE_FAILED"), /SQLite/);
  assert.equal(formatMvpErrorMessage("CUSTOM_FAILURE"), "CUSTOM_FAILURE");
  assert.match(
    formatMvpSnapshotError({
      ...snapshot,
      error: "ASR_WORKER_STOPPED",
    }),
    /自动重建引擎/,
  );
  assert.equal(
    formatMvpSnapshotError({
      ...snapshot,
      error: null,
      microphone: {
        ...snapshot.microphone,
        status: "disabled",
        error: "AUDIO_SOURCE_DISABLED",
      },
    }),
    "",
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
