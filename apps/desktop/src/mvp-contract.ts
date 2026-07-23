export const MVP_CONTRACT_VERSION = "meetingrelay.mvp.durable.v1";

export const MVP_LIFECYCLES = [
  "booting",
  "ready",
  "starting",
  "recording",
  "paused",
  "stopping",
  "error",
] as const;

export const MVP_EXPORT_FORMATS = ["json", "markdown", "txt"] as const;
export const MVP_RECOGNITION_LANGUAGES = ["zh", "ja", "en"] as const;
export const AUDIO_DEVICE_PREFERENCE_KEY = "meetingrelay.audio-devices.v1";

export type MvpLifecycle = (typeof MVP_LIFECYCLES)[number];
export type MvpExportFormat = (typeof MVP_EXPORT_FORMATS)[number];
export type MvpRecognitionLanguage = (typeof MVP_RECOGNITION_LANGUAGES)[number];
export type AudioSourceId = "system" | "microphone";
export type AudioSourceStatus = "ready" | "capturing" | "degraded" | "error";
export type DurabilityStatus =
  | "initializing"
  | "ready"
  | "recording"
  | "paused"
  | "completed"
  | "interrupted"
  | "error";

export type AudioDeviceOption = {
  deviceId: string;
  name: string;
  isDefault: boolean;
};

export type AudioDeviceInventory = {
  systemOutputs: AudioDeviceOption[];
  microphones: AudioDeviceOption[];
};

export type AudioDevicePreference = {
  version: 1;
  systemOutputDeviceId: string;
  microphoneDeviceId: string;
};

export type ResolvedAudioDeviceSelection = {
  systemOutputDeviceId: string | null;
  microphoneDeviceId: string | null;
  staleSystemOutput: boolean;
  staleMicrophone: boolean;
};

export type AudioSourceSnapshot = {
  id: AudioSourceId;
  label: string;
  ready: boolean;
  active: boolean;
  frames: string;
  peak: number;
  status: AudioSourceStatus;
  error: string | null;
};

export type TranscriptSegment = {
  segmentId: string;
  sequence: string;
  revision: number;
  isFinal: boolean;
  saved: boolean;
  text: string;
  startedAtMs: string;
  endedAtMs: string | null;
  committedAt: string | null;
  commitId: string | null;
};

export type ExportArtifact = {
  format: MvpExportFormat;
  path: string;
  byteLength: number;
  sha256: string;
};

export type MvpExportResult = {
  meetingId: string;
  snapshotId: string;
  finalCount: number;
  artifacts: ExportArtifact[];
};

export type MvpSnapshot = {
  contractVersion: string;
  lifecycle: MvpLifecycle;
  modelReady: boolean;
  modelLabel: string;
  localOnly: true;
  memoryOnly: false;
  meetingId: string | null;
  sessionId: string | null;
  durabilityStatus: DurabilityStatus;
  savedFinalCount: string;
  totalFinalCount: string;
  visibleFinalWindowStartSequence: string;
  lastSavedSequence: string | null;
  latestOpenedMeeting: string | null;
  availableExports: MvpExportFormat[];
  elapsedMs: string;
  system: AudioSourceSnapshot;
  microphone: AudioSourceSnapshot;
  interim: TranscriptSegment | null;
  finals: TranscriptSegment[];
  queueDepth: number;
  error: string | null;
};

export function hasAllMvpExportFormats(formats: readonly MvpExportFormat[]): boolean {
  const available = new Set(formats);
  return MVP_EXPORT_FORMATS.every((format) => available.has(format));
}

export function parseMvpRecognitionLanguage(value: unknown): MvpRecognitionLanguage {
  return enumValue(value, "recognition language", MVP_RECOGNITION_LANGUAGES);
}

export function isMvpActiveLifecycle(lifecycle: MvpLifecycle): boolean {
  return ["starting", "recording", "paused", "stopping"].includes(lifecycle);
}

export function isMvpActiveSession(snapshot: MvpSnapshot): boolean {
  return isMvpActiveLifecycle(snapshot.lifecycle);
}

export function hasCompleteMvpTranscript(
  snapshot: Pick<MvpSnapshot, "durabilityStatus" | "error">,
): boolean {
  return snapshot.durabilityStatus !== "interrupted" || snapshot.error === null;
}

export function parseMvpTranscriptText(value: unknown): string {
  return boundedString(value, "transcript text export", 8 * 1024 * 1024);
}

export function formatMvpErrorMessage(value: unknown): string {
  const raw =
    value instanceof Error ? value.message : typeof value === "string" ? value : "未知错误";
  const normalized = raw.trim().replace(/\s+/g, " ").slice(0, 220) || "未知错误";
  const known: ReadonlyArray<readonly [string, string]> = [
    [
      "AUDIO_STREAM_ERROR",
      "音频设备连接已中断。请停止当前会议、重新选择设备后再开始；已经保存的文字不会丢失。",
    ],
    [
      "ASR_WORKER_STOPPED",
      "本地转写引擎已停止。请停止当前会议后重新开始，应用会自动重建引擎；已经保存的文字不会丢失。",
    ],
    [
      "ASR_FINAL_OVERLOAD",
      "本地转写队列已满。请停止后重新开始；已经提交到 SQLite 的文字仍然安全。",
    ],
    [
      "SHERPA_REALTIME_RECOGNITION_UNAVAILABLE",
      "本地转写引擎重试后仍不可用。请停止后重新开始；已经保存的文字不会丢失。",
    ],
    [
      "SHERPA_ASSET_MISSING",
      "本地模型或运行时路径无效。请检查个人 Release 启动器或模型路径配置。",
    ],
    [
      "AUDIO_UNAVAILABLE",
      "所选音频设备当前不可用。请重新选择系统输出和麦克风后再开始。",
    ],
    ["MVP_PAUSE_TIMEOUT", "暂停操作没有及时完成。请停止会议；已经保存的文字不会丢失。"],
    ["MVP_RESUME_TIMEOUT", "继续操作没有及时完成。请停止会议后重新开始；已经保存的文字不会丢失。"],
  ];
  return known.find(([code]) => normalized.includes(code))?.[1] ?? normalized;
}

export function formatMvpSnapshotError(
  snapshot: Pick<MvpSnapshot, "error" | "system" | "microphone">,
): string {
  const error = snapshot.error ?? snapshot.system.error ?? snapshot.microphone.error;
  return error === null ? "" : formatMvpErrorMessage(error);
}

const UINT64_MAX = 18_446_744_073_709_551_615n;
const CANONICAL_UNSIGNED_DECIMAL = /^(?:0|[1-9][0-9]*)$/;
const IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const SHA256 = /^[a-fA-F0-9]{64}$/;
const SOURCE_STATUSES = ["ready", "capturing", "degraded", "error"] as const;
const DURABILITY_STATUSES = [
  "initializing",
  "ready",
  "recording",
  "paused",
  "completed",
  "interrupted",
  "error",
] as const;
const MAX_AUDIO_DEVICES_PER_ROLE = 256;
const MAX_AUDIO_DEVICE_ID_LENGTH = 1024;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean.`);
  }
  return value;
}

function boundedString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.length > maximum || value.includes("\0")) {
    throw new Error(`${label} must be a bounded string.`);
  }
  return value;
}

function audioDeviceId(value: unknown, label: string): string {
  const text = boundedString(value, label, MAX_AUDIO_DEVICE_ID_LENGTH);
  if (text.length === 0 || CONTROL_CHARACTER.test(text)) {
    throw new Error(`${label} is invalid.`);
  }
  return text;
}

function audioDeviceList(value: unknown, label: string): AudioDeviceOption[] {
  if (!Array.isArray(value) || value.length > MAX_AUDIO_DEVICES_PER_ROLE) {
    throw new Error(`${label} must be a bounded array.`);
  }
  const seen = new Set<string>();
  let defaultCount = 0;
  const devices = value.map((entry, index) => {
    const device = object(entry, `${label}[${index}]`);
    const deviceId = audioDeviceId(device.deviceId, `${label}[${index}].deviceId`);
    if (seen.has(deviceId)) {
      throw new Error(`${label} contains a duplicate device id.`);
    }
    seen.add(deviceId);
    const name = boundedString(device.name, `${label}[${index}].name`, 256).trim();
    if (name.length === 0) {
      throw new Error(`${label}[${index}].name is empty.`);
    }
    const isDefault = boolean(device.isDefault, `${label}[${index}].isDefault`);
    if (isDefault) defaultCount += 1;
    return { deviceId, name, isDefault };
  });
  if (defaultCount > 1) {
    throw new Error(`${label} contains multiple defaults.`);
  }
  return devices;
}

export function parseAudioDeviceInventory(value: unknown): AudioDeviceInventory {
  const inventory = object(value, "audio device inventory");
  return {
    systemOutputs: audioDeviceList(inventory.systemOutputs, "systemOutputs"),
    microphones: audioDeviceList(inventory.microphones, "microphones"),
  };
}

export function parseAudioDevicePreference(serialized: string | null): AudioDevicePreference | null {
  if (serialized === null) return null;
  try {
    const preference = object(JSON.parse(serialized), "audio device preference");
    if (preference.version !== 1) return null;
    return {
      version: 1,
      systemOutputDeviceId: audioDeviceId(
        preference.systemOutputDeviceId,
        "preference.systemOutputDeviceId",
      ),
      microphoneDeviceId: audioDeviceId(
        preference.microphoneDeviceId,
        "preference.microphoneDeviceId",
      ),
    };
  } catch {
    return null;
  }
}

function resolvePreferredDevice(
  devices: readonly AudioDeviceOption[],
  savedDeviceId: string | undefined,
): { deviceId: string | null; stale: boolean } {
  if (savedDeviceId !== undefined) {
    return {
      deviceId: savedDeviceId,
      stale: !devices.some((device) => device.deviceId === savedDeviceId),
    };
  }
  return {
    deviceId: devices.find((device) => device.isDefault)?.deviceId ?? devices[0]?.deviceId ?? null,
    stale: false,
  };
}

export function resolveAudioDeviceSelection(
  inventory: AudioDeviceInventory,
  preference: AudioDevicePreference | null,
): ResolvedAudioDeviceSelection {
  const systemOutput = resolvePreferredDevice(
    inventory.systemOutputs,
    preference?.systemOutputDeviceId,
  );
  const microphone = resolvePreferredDevice(
    inventory.microphones,
    preference?.microphoneDeviceId,
  );
  return {
    systemOutputDeviceId: systemOutput.deviceId,
    microphoneDeviceId: microphone.deviceId,
    staleSystemOutput: systemOutput.stale,
    staleMicrophone: microphone.stale,
  };
}

function nullableString(value: unknown, label: string, maximum: number): string | null {
  return value === null ? null : boundedString(value, label, maximum);
}

function identifier(value: unknown, label: string): string {
  const text = boundedString(value, label, 128);
  if (!IDENTIFIER.test(text)) {
    throw new Error(`${label} is invalid.`);
  }
  return text;
}

function nullableIdentifier(value: unknown, label: string): string | null {
  return value === null ? null : identifier(value, label);
}

function uint64(value: unknown, label: string): string {
  if (typeof value !== "string" || !CANONICAL_UNSIGNED_DECIMAL.test(value)) {
    throw new Error(`${label} must be a canonical unsigned decimal string.`);
  }
  if (BigInt(value) > UINT64_MAX) {
    throw new Error(`${label} exceeds uint64.`);
  }
  return value;
}

function enumValue<T extends readonly string[]>(
  value: unknown,
  label: string,
  values: T,
): T[number] {
  const text = boundedString(value, label, 32);
  if (!values.includes(text)) {
    throw new Error(`${label} is unsupported.`);
  }
  return text;
}

function safeCount(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }
  return value;
}

function audioSource(value: unknown, expectedId: AudioSourceId): AudioSourceSnapshot {
  const source = object(value, `${expectedId} source`);
  const status = enumValue(source.status, `${expectedId}.status`, SOURCE_STATUSES);
  const peak = source.peak;
  if (typeof peak !== "number" || !Number.isFinite(peak) || peak < 0 || peak > 1) {
    throw new Error(`${expectedId}.peak must be between zero and one.`);
  }
  if (source.id !== expectedId) {
    throw new Error(`${expectedId}.id differs.`);
  }
  return {
    id: expectedId,
    label: boundedString(source.label, `${expectedId}.label`, 256),
    ready: boolean(source.ready, `${expectedId}.ready`),
    active: boolean(source.active, `${expectedId}.active`),
    frames: uint64(source.frames, `${expectedId}.frames`),
    peak,
    status,
    error: nullableString(source.error, `${expectedId}.error`, 256),
  };
}

function transcript(value: unknown, expectedFinal: boolean): TranscriptSegment {
  const segment = object(value, "transcript segment");
  const segmentId = identifier(segment.segmentId, "segmentId");
  if (
    typeof segment.revision !== "number" ||
    !Number.isSafeInteger(segment.revision) ||
    segment.revision < 1
  ) {
    throw new Error("revision must be a positive safe integer.");
  }
  if (segment.isFinal !== expectedFinal) {
    throw new Error("transcript finality differs from its collection.");
  }
  const saved = boolean(segment.saved, "segment.saved");
  if (expectedFinal && saved !== true) {
    throw new Error("saved final segments must have saved=true.");
  }
  if (!expectedFinal && saved !== false) {
    throw new Error("interim segments must not be saved.");
  }
  return {
    segmentId,
    sequence: expectedFinal ? uint64(segment.sequence, "segment.sequence") : "0",
    revision: segment.revision,
    isFinal: expectedFinal,
    saved,
    text: boundedString(segment.text, "transcript text", 16_384),
    startedAtMs: uint64(segment.startedAtMs, "startedAtMs"),
    endedAtMs:
      segment.endedAtMs === null ? null : uint64(segment.endedAtMs, "endedAtMs"),
    committedAt: expectedFinal
      ? boundedString(segment.committedAt, "segment.committedAt", 64)
      : null,
    commitId: expectedFinal ? identifier(segment.commitId, "segment.commitId") : null,
  };
}

function exportFormat(value: unknown): MvpExportFormat {
  return enumValue(value, "export format", MVP_EXPORT_FORMATS);
}

function exportArtifact(value: unknown): ExportArtifact {
  const artifact = object(value, "export artifact");
  const sha256 = boundedString(artifact.sha256, "export.sha256", 64);
  if (!SHA256.test(sha256)) {
    throw new Error("export.sha256 must be a SHA-256 hex digest.");
  }
  return {
    format: exportFormat(artifact.format),
    path: boundedString(artifact.path, "export.path", 1024),
    byteLength: safeCount(artifact.byteLength, "export.byteLength"),
    sha256,
  };
}

export function parseMvpExportResult(value: unknown): MvpExportResult {
  const result = object(value, "MVP export result");
  if (!Array.isArray(result.artifacts) || result.artifacts.length > MVP_EXPORT_FORMATS.length) {
    throw new Error("export artifacts collection is invalid.");
  }
  return {
    meetingId: identifier(result.meetingId, "meetingId"),
    snapshotId: identifier(result.snapshotId, "snapshotId"),
    finalCount: safeCount(result.finalCount, "export.finalCount"),
    artifacts: result.artifacts.map(exportArtifact),
  };
}

export function parseMvpSnapshot(value: unknown): MvpSnapshot {
  const snapshot = object(value, "MVP snapshot");
  if (snapshot.contractVersion !== MVP_CONTRACT_VERSION) {
    throw new Error("MVP contract version is unsupported.");
  }
  const lifecycle = enumValue(snapshot.lifecycle, "lifecycle", MVP_LIFECYCLES);
  if (snapshot.localOnly !== true || snapshot.memoryOnly !== false) {
    throw new Error("MVP durable privacy boundary differs.");
  }
  if (!Array.isArray(snapshot.finals) || snapshot.finals.length > 64) {
    throw new Error("final transcript collection is invalid.");
  }
  if (!Array.isArray(snapshot.availableExports)) {
    throw new Error("available exports must be an array.");
  }
  if (
    typeof snapshot.queueDepth !== "number" ||
    !Number.isSafeInteger(snapshot.queueDepth) ||
    snapshot.queueDepth < 0 ||
    snapshot.queueDepth > 8
  ) {
    throw new Error("queueDepth is outside the MVP bound.");
  }
  return {
    contractVersion: MVP_CONTRACT_VERSION,
    lifecycle,
    modelReady: boolean(snapshot.modelReady, "modelReady"),
    modelLabel: boundedString(snapshot.modelLabel, "modelLabel", 256),
    localOnly: true,
    memoryOnly: false,
    meetingId: nullableIdentifier(snapshot.meetingId, "meetingId"),
    sessionId: nullableIdentifier(snapshot.sessionId, "sessionId"),
    durabilityStatus: enumValue(
      snapshot.durabilityStatus,
      "durabilityStatus",
      DURABILITY_STATUSES,
    ),
    savedFinalCount: uint64(snapshot.savedFinalCount, "savedFinalCount"),
    totalFinalCount: uint64(snapshot.totalFinalCount, "totalFinalCount"),
    visibleFinalWindowStartSequence: uint64(
      snapshot.visibleFinalWindowStartSequence,
      "visibleFinalWindowStartSequence",
    ),
    lastSavedSequence:
      snapshot.lastSavedSequence === null
        ? null
        : uint64(snapshot.lastSavedSequence, "lastSavedSequence"),
    latestOpenedMeeting: nullableIdentifier(snapshot.latestOpenedMeeting, "latestOpenedMeeting"),
    availableExports: snapshot.availableExports.map(exportFormat),
    elapsedMs: uint64(snapshot.elapsedMs, "elapsedMs"),
    system: audioSource(snapshot.system, "system"),
    microphone: audioSource(snapshot.microphone, "microphone"),
    interim: snapshot.interim === null ? null : transcript(snapshot.interim, false),
    finals: snapshot.finals.map((item) => transcript(item, true)),
    queueDepth: snapshot.queueDepth,
    error: nullableString(snapshot.error, "snapshot.error", 256),
  };
}

export function formatElapsed(milliseconds: string): string {
  const totalSeconds = BigInt(uint64(milliseconds, "elapsed milliseconds")) / 1_000n;
  const hours = totalSeconds / 3_600n;
  const minutes = (totalSeconds % 3_600n) / 60n;
  const seconds = totalSeconds % 60n;
  return [hours, minutes, seconds].map((part) => part.toString().padStart(2, "0")).join(":");
}
