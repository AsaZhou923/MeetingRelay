export const MVP_CONTRACT_VERSION = "meetingrelay.mvp.v1";

export const MVP_LIFECYCLES = [
  "booting",
  "ready",
  "starting",
  "recording",
  "stopping",
  "error",
] as const;

export type MvpLifecycle = (typeof MVP_LIFECYCLES)[number];
export type AudioSourceId = "system" | "microphone";
export type AudioSourceStatus = "ready" | "capturing" | "degraded" | "error";

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
  revision: number;
  isFinal: boolean;
  text: string;
  startedAtMs: string;
  endedAtMs: string | null;
};

export type MvpSnapshot = {
  contractVersion: string;
  lifecycle: MvpLifecycle;
  modelReady: boolean;
  modelLabel: string;
  localOnly: true;
  memoryOnly: true;
  sessionId: string | null;
  elapsedMs: string;
  system: AudioSourceSnapshot;
  microphone: AudioSourceSnapshot;
  interim: TranscriptSegment | null;
  finals: TranscriptSegment[];
  queueDepth: number;
  error: string | null;
};

const UINT64_MAX = 18_446_744_073_709_551_615n;
const CANONICAL_UNSIGNED_DECIMAL = /^(?:0|[1-9][0-9]*)$/;
const IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const SOURCE_STATUSES = ["ready", "capturing", "degraded", "error"] as const;

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

function nullableString(value: unknown, label: string, maximum: number): string | null {
  return value === null ? null : boundedString(value, label, maximum);
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

function audioSource(value: unknown, expectedId: AudioSourceId): AudioSourceSnapshot {
  const source = object(value, `${expectedId} source`);
  const status = boundedString(source.status, `${expectedId}.status`, 16);
  if (!SOURCE_STATUSES.includes(status as AudioSourceStatus)) {
    throw new Error(`${expectedId}.status is unsupported.`);
  }
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
    status: status as AudioSourceStatus,
    error: nullableString(source.error, `${expectedId}.error`, 256),
  };
}

function transcript(value: unknown, expectedFinal: boolean): TranscriptSegment {
  const segment = object(value, "transcript segment");
  const segmentId = boundedString(segment.segmentId, "segmentId", 128);
  if (!IDENTIFIER.test(segmentId)) {
    throw new Error("segmentId is invalid.");
  }
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
  return {
    segmentId,
    revision: segment.revision,
    isFinal: expectedFinal,
    text: boundedString(segment.text, "transcript text", 16_384),
    startedAtMs: uint64(segment.startedAtMs, "startedAtMs"),
    endedAtMs:
      segment.endedAtMs === null ? null : uint64(segment.endedAtMs, "endedAtMs"),
  };
}

export function parseMvpSnapshot(value: unknown): MvpSnapshot {
  const snapshot = object(value, "MVP snapshot");
  if (snapshot.contractVersion !== MVP_CONTRACT_VERSION) {
    throw new Error("MVP contract version is unsupported.");
  }
  const lifecycle = boundedString(snapshot.lifecycle, "lifecycle", 16);
  if (!MVP_LIFECYCLES.includes(lifecycle as MvpLifecycle)) {
    throw new Error("MVP lifecycle is unsupported.");
  }
  if (snapshot.localOnly !== true || snapshot.memoryOnly !== true) {
    throw new Error("MVP privacy boundary differs.");
  }
  if (!Array.isArray(snapshot.finals) || snapshot.finals.length > 64) {
    throw new Error("final transcript collection is invalid.");
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
    lifecycle: lifecycle as MvpLifecycle,
    modelReady: boolean(snapshot.modelReady, "modelReady"),
    modelLabel: boundedString(snapshot.modelLabel, "modelLabel", 256),
    localOnly: true,
    memoryOnly: true,
    sessionId:
      snapshot.sessionId === null
        ? null
        : boundedString(snapshot.sessionId, "sessionId", 128),
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
