export const MVP_CONTRACT_VERSION = "meetingrelay.mvp.durable.v3";
export const MAX_INFERENCE_QUEUE_DEPTH = 32;

export const MVP_LIFECYCLES = [
  "booting",
  "ready",
  "starting",
  "recording",
  "paused",
  "stopping",
  "error",
] as const;

export const MVP_EXPORT_FORMATS = ["json", "markdown", "txt", "docx", "pdf"] as const;
export const MVP_RECOGNITION_LANGUAGES = ["zh", "ja", "en"] as const;
export const MVP_MEETING_LANGUAGES = [...MVP_RECOGNITION_LANGUAGES, "unknown"] as const;
export const MVP_AUDIO_SOURCE_MODES = ["system_only", "microphone_only", "both"] as const;
export const MVP_TRANSCRIPT_DISPLAY_MODES = [
  "source_and_translation",
  "translation_only",
] as const;
export const MVP_PROVIDER_CLASSES = ["local", "lan", "cloud"] as const;
export const MVP_SUMMARY_JOB_STATUSES = [
  "idle",
  "queued",
  "chunking",
  "combining",
  "completed",
  "failed",
  "cancelled",
] as const;
export const MVP_DELETE_ENTRY_TYPES = ["raw", "derived", "export", "summary", "metadata"] as const;
export const MVP_SEARCH_SCOPES = ["original", "translation", "summary", "speaker"] as const;
export const MVP_TRANSLATION_STATUSES = [
  "disabled",
  "pending",
  "completed",
  "failed",
  "skipped",
] as const;
export const MVP_DISK_STATUSES = ["ok", "warning", "critical", "error"] as const;
export const MVP_TRANSLATION_RETRY_STATUSES = [
  "idle",
  "running",
  "completed",
  "failed",
  "cancelled",
] as const;
export const MVP_INTERRUPTED_ACTIONS = ["recover", "finalize", "keep"] as const;
export const AUDIO_DEVICE_PREFERENCE_KEY = "meetingrelay.audio-devices.v1";
export const TRANSLATION_PREFERENCE_KEY = "meetingrelay.translation.v1";
export const APP_PREFERENCE_KEY = "meetingrelay.app-settings.v1";

export type MvpLifecycle = (typeof MVP_LIFECYCLES)[number];
export type MvpExportFormat = (typeof MVP_EXPORT_FORMATS)[number];
export type MvpRecognitionLanguage = (typeof MVP_RECOGNITION_LANGUAGES)[number];
export type MvpMeetingLanguage = (typeof MVP_MEETING_LANGUAGES)[number];
export type MvpAudioSourceMode = (typeof MVP_AUDIO_SOURCE_MODES)[number];
export type MvpTranscriptDisplayMode = (typeof MVP_TRANSCRIPT_DISPLAY_MODES)[number];
export type MvpProviderClass = (typeof MVP_PROVIDER_CLASSES)[number];
export type MvpSummaryJobStatus = (typeof MVP_SUMMARY_JOB_STATUSES)[number];
export type MvpDeleteEntryType = (typeof MVP_DELETE_ENTRY_TYPES)[number];
export type MvpSearchScope = (typeof MVP_SEARCH_SCOPES)[number];
export type MvpTranslationStatus = (typeof MVP_TRANSLATION_STATUSES)[number];
export type MvpDiskStatus = (typeof MVP_DISK_STATUSES)[number];
export type MvpTranslationRetryStatus = (typeof MVP_TRANSLATION_RETRY_STATUSES)[number];
export type MvpInterruptedAction = (typeof MVP_INTERRUPTED_ACTIONS)[number];
export type AudioSourceId = "system" | "microphone";
export type AudioSourceStatus = "disabled" | "ready" | "capturing" | "degraded" | "error";
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

export type AppPreference = {
  version: 1;
  recognitionLanguage: MvpRecognitionLanguage;
  sourceMode: MvpAudioSourceMode;
  transcriptDisplayMode: MvpTranscriptDisplayMode;
  liveTextEnabled: boolean;
  liveTextDirectory: string;
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
  meetingSampleStart: string;
  meetingSampleEnd: string;
  timelineRevision: number;
  translationStatus: MvpTranslationStatus;
  translationTarget: MvpRecognitionLanguage | null;
  translationText: string | null;
  translationError: string | null;
};

export type TranslationConfig = {
  enabled: boolean;
  baseUrl: string;
  model: string;
  apiKey: string | null;
  targetLanguage: MvpRecognitionLanguage;
  allowInsecureHttp: boolean;
};

export type TranslationPreference = Omit<TranslationConfig, "apiKey"> & {
  version: 1;
  provider: string;
  providerProfileId: string | null;
  baseUrl: "";
};

export type TranslationProbe = {
  endpoint: string;
  model: string;
  targetLanguage: MvpRecognitionLanguage;
  latencyMs: number;
  preview: string;
};

export type AsrModelProfile = {
  modelId: string;
  label: string;
  tier: "stable-default" | "high-quality-candidate" | "high-quality-default";
  engine: string;
  engineVersion: string;
  runtimeVersion: string;
  modelRevision: string;
  modelSha256: string;
  quantization: string;
  executionProvider: string;
  nativeStreaming: boolean;
  supportedLanguages: MvpRecognitionLanguage[];
  modelSizeBytes: string;
  recommendedMemoryMb: number;
  licenseId: string;
  installState: "verified" | "missing" | "invalid";
  benchmarkStatus: "baseline-locked" | "pending" | "verified" | "local-smoke-verified";
  selectable: boolean;
};

export type LocalTranslationModel = {
  id: string;
  ownedBy: string | null;
};

export type LocalTranslationDiscovery = {
  baseUrl: string;
  endpoint: string;
  providerFlavor: "ollama" | "lmstudio" | "openai-compatible";
  models: LocalTranslationModel[];
  latencyMs: number;
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

export type MeetingListItem = {
  meetingId: string;
  title: string;
  status: DurabilityStatus;
  startedAt: string;
  updatedAt: string;
  durationMs: string;
  language: MvpMeetingLanguage;
  savedFinalCount: string;
  translationFailedCount: number;
  summaryStatus: MvpSummaryJobStatus;
  tags: string[];
};

export type MeetingListPage = {
  items: MeetingListItem[];
  nextCursor: string | null;
  total: number;
  pageSize: number;
  elapsedMs: number;
};

export type MeetingDetail = {
  meeting: MeetingListItem;
  segments: TranscriptSegment[];
  summary: SummaryResult | null;
};

export type SegmentSearchHit = {
  meetingId: string;
  meetingTitle: string;
  segmentId: string | null;
  sequence: string | null;
  scope: MvpSearchScope;
  snippet: string;
  score: number;
};

export type SegmentSearchPage = {
  hits: SegmentSearchHit[];
  nextCursor: string | null;
  total: number;
  elapsedMs: number;
};

export type ProviderProfile = {
  profileId: string;
  label: string;
  class: MvpProviderClass;
  baseUrl: string;
  model: string;
  policyUrl: string | null;
  dataFlow: string;
  configVersion: number;
  secretState: "missing" | "present" | "not_required" | "unsupported";
  lastTestStatus: "untested" | "passed" | "failed";
  lastTestAt: string | null;
  lastError: string | null;
};

export type ProviderProfileDraft = Pick<
  ProviderProfile,
  "profileId" | "label" | "class" | "baseUrl" | "model" | "policyUrl" | "dataFlow" | "configVersion"
>;

export type DeletePreviewEntry = {
  type: MvpDeleteEntryType;
  path: string | null;
  byteLength: string;
  description: string;
};

export type DeletePreview = {
  meetingId: string;
  recoveryWindowSeconds: number;
  includeRaw: boolean;
  includeDerived: boolean;
  entries: DeletePreviewEntry[];
  willDeleteBytes: string;
  canRestore: boolean;
};

export type DeleteResult = {
  meetingId: string;
  deleted: boolean;
  restoredUntil: string | null;
  entriesDeleted: number;
  bytesDeleted: string;
};

export type SummaryCitation = {
  segmentId: string | null;
  sequence: string | null;
  label: string;
};

export type SummaryResult = {
  summaryId: string;
  version: number;
  language: MvpRecognitionLanguage;
  overview: string;
  actions: string[];
  decisions: string[];
  openQuestions: string[];
  citations: SummaryCitation[];
  createdAt: string;
};

export type SummaryJob = {
  jobId: string;
  meetingId: string;
  status: MvpSummaryJobStatus;
  version: number;
  totalChunks: number;
  completedChunks: number;
  canCancel: boolean;
  canRetry: boolean;
  message: string | null;
  result: SummaryResult | null;
};

export type SpeakerIdentity = {
  speakerId: string;
  displayName: string;
};

export type SpeakerAssignment = {
  segmentId: string;
  sequence: string;
  sourceRevision: number;
  speakerId: string;
  confidence: number;
};

export type SpeakerVersion = {
  meetingId: string;
  version: number;
  parentVersion: number | null;
  algorithm: string;
  digest: string;
  createdAt: string;
  operation: string;
  identities: SpeakerIdentity[];
  assignments: SpeakerAssignment[];
};

export type SpeakerDiarizationStatus = "completed" | "skipped" | "failed" | "unavailable";

export type SpeakerDiarizationResult = {
  meetingId: string;
  version: number | null;
  status: SpeakerDiarizationStatus;
  reason: string | null;
};

export type ExportOptions = {
  formats: MvpExportFormat[];
  includeOriginal: boolean;
  includeTranslation: boolean;
  bilingual: boolean;
  includeSpeaker: boolean;
  includeSummary: boolean;
  includeTimestamp: boolean;
  summaryVersion: number | null;
  speakerVersion: number | null;
};

export type DiskHealthSnapshot = {
  status: MvpDiskStatus;
  dataDir: string;
  freeBytes: string;
  requiredBytes: string;
  warning: string | null;
};

export type DataDirectorySettings = {
  activeDataDir: string;
  configuredDataDir: string;
  restartRequired: boolean;
  environmentOverride: boolean;
  activeStorageAvailable: boolean;
};

export type TranslationRetryProgress = {
  batchId: string | null;
  status: MvpTranslationRetryStatus;
  total: number;
  progress: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  costRiskAccepted: boolean;
  message: string | null;
};

export type DiagnosticBundleResult = {
  path: string;
  byteLength: number;
  sha256: string;
  redacted: true;
};

export type InterruptedMeeting = {
  meetingId: string;
  startedAt: string;
  updatedAt: string;
  savedFinalCount: string;
  pendingFinalCount: string;
  translationFailedCount: number;
  reason: string | null;
  recommendedAction: MvpInterruptedAction;
};

export type SegmentAudioLocation = {
  available: boolean;
  path: string | null;
  offsetMs: string | null;
  durationMs: string | null;
  reason: string | null;
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
  translationQueueDepth: number;
  disk: DiskHealthSnapshot;
  error: string | null;
};

export function hasAllMvpExportFormats(formats: readonly MvpExportFormat[]): boolean {
  const available = new Set(formats);
  return MVP_EXPORT_FORMATS.every((format) => available.has(format));
}

export function parseMvpRecognitionLanguage(value: unknown): MvpRecognitionLanguage {
  return enumValue(value, "recognition language", MVP_RECOGNITION_LANGUAGES);
}

export function parseMvpAudioSourceMode(value: unknown): MvpAudioSourceMode {
  return enumValue(value, "audio source mode", MVP_AUDIO_SOURCE_MODES);
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
    ["ASR_MODEL_NOT_FOUND", "所选本地识别模型不在已校验的模型注册表中。"],
    ["ASR_MODEL_NOT_READY", "所选本地识别模型尚未安装或完整性校验失败。"],
    ["ASR_MODEL_LANGUAGE_UNSUPPORTED", "所选本地识别模型不支持本次会议语言。"],
    ["MVP_DATA_DIR_INVALID", "主数据目录必须是有效的 Windows 绝对路径。"],
    ["MVP_DATA_DIR_UNWRITABLE", "无法创建或写入所选主数据目录。"],
    ["MVP_DATA_DIR_SETTINGS_UNAVAILABLE", "无法保存主数据目录设置。"],
    ["MVP_DATA_DIR_SESSION_ACTIVE", "会议进行中不能修改主数据目录。"],
    [
      "MVP_DATA_DIR_ENV_OVERRIDE",
      "当前由 MEETINGRELAY_MVP_DATA_DIR 环境变量固定数据目录，界面设置不能覆盖。",
    ],
    [
      "SHERPA_REALTIME_RECOGNITION_UNAVAILABLE",
      "本地转写引擎重试后仍不可用。请停止后重新开始；已经保存的文字不会丢失。",
    ],
    ["COHERE_ASR_RUNTIME_MISSING", "Cohere GPU 运行环境尚未安装，请运行 tools/cohere-transcribe/setup.ps1。"],
    ["COHERE_ASR_WORKER_MISSING", "Cohere 本地 worker 文件缺失，请检查安装或开发工作区。"],
    ["COHERE_ASR_MODEL_MISSING", "Cohere Transcribe 模型尚未下载到本机。"],
    ["COHERE_ASR_MODEL_INVALID", "Cohere Transcribe 模型完整性校验失败，请重新下载。"],
    ["COHERE_ASR_CUDA_UNAVAILABLE", "Cohere Transcribe 需要可用的 NVIDIA CUDA GPU。"],
    ["COHERE_ASR_CUDA_OUT_OF_MEMORY", "GPU 显存不足，无法完成本段 Cohere 转写。"],
    ["COHERE_ASR_WORKER_START_FAILED", "无法启动 Cohere GPU 识别进程。"],
    ["COHERE_ASR_WORKER_STOPPED", "Cohere GPU 识别进程意外停止，系统将尝试重建。"],
    ["COHERE_ASR_TIMEOUT", "Cohere GPU 识别超时，系统将尝试重建识别进程。"],
    ["COHERE_ASR_INFERENCE_FAILED", "Cohere GPU 转写失败；已经保存的文字不会丢失。"],
    [
      "SHERPA_ASSET_MISSING",
      "本地模型或运行时路径无效。请检查个人 Release 启动器或模型路径配置。",
    ],
    [
      "AUDIO_UNAVAILABLE",
      "所选音频设备当前不可用。请重新选择系统输出和麦克风后再开始。",
    ],
    [
      "TRANSLATION_BASE_URL_HTTPS_REQUIRED",
      "远程 HTTP 会明文传输 Token 和会议文字；请在翻译设置中显式确认风险，或改用 HTTPS。",
    ],
    [
      "TRANSLATION_BASE_URL_INVALID",
      "翻译 Base URL 无效；请填写服务提供的 OpenAI-compatible Base URL，不要包含账号、查询参数或片段。",
    ],
    ["TRANSLATION_MODEL_INVALID", "请填写所选服务实际提供的模型 ID。"],
    [
      "TRANSLATION_CONNECTION_FAILED",
      "无法连接翻译服务。请检查服务状态、Base URL、网络连接和模型 ID。",
    ],
    [
      "TRANSLATION_TIMEOUT",
      "翻译服务响应超时。原文已保存在本机，可检查服务与网络后重试失败译文。",
    ],
    [
      "TRANSLATION_PROBE_TIMEOUT",
      "连接测试 15 秒内未响应。请检查服务是否已启动、网络是否可达，然后重试。",
    ],
    [
      "LOCAL_TRANSLATION_SERVICE_TIMEOUT",
      "本地翻译服务连接测试超时。请确认 Ollama 或 LM Studio 已启动并加载所选模型。",
    ],
    [
      "LOCAL_TRANSLATION_SERVICE_UNAVAILABLE",
      "无法连接本地翻译服务。请先启动 Ollama 或 LM Studio 的本地服务器。",
    ],
    [
      "LOCAL_TRANSLATION_MODELS_EMPTY",
      "本地服务已启动，但没有可用模型；请先下载并加载翻译模型。",
    ],
    [
      "LOCAL_TRANSLATION_MODELS_HTTP_STATUS_404",
      "本地服务没有提供 OpenAI-compatible /v1/models；请确认已启动兼容 API 服务。",
    ],
    [
      "LOCAL_TRANSLATION_MODELS_RESPONSE_INVALID",
      "本地服务返回了无法识别的模型列表；请确认它兼容 OpenAI /v1/models。",
    ],
    [
      "LOCAL_TRANSLATION_MODEL_NOT_AVAILABLE",
      "所选模型不在本地服务的可用模型列表中；请刷新并重新选择。",
    ],
    ["LOCAL_TRANSLATION_LOOPBACK_REQUIRED", "本地翻译服务必须使用 localhost 或 127.0.0.1。"],
    [
      "TRANSLATION_HTTP_STATUS_401",
      "翻译服务拒绝授权，请检查 API Token。",
    ],
    [
      "TRANSLATION_HTTP_STATUS_404",
      "服务没有找到 OpenAI-compatible Chat Completions 接口或指定模型。",
    ],
    [
      "TRANSLATION_RESPONSE_INVALID",
      "服务返回了无法识别的响应，请确认它兼容 OpenAI Chat Completions。",
    ],
    [
      "TRANSLATION_WORKER_UNAVAILABLE",
      "翻译后台线程未能启动；原文功能仍可使用，请重启应用后重试。",
    ],
    [
      "LIVE_TEXT_DIRECTORY_NOT_ABSOLUTE",
      "实时 TXT 目录必须是绝对路径，例如 C:\\Users\\你\\Documents\\MeetingRelay。",
    ],
    [
      "LIVE_TEXT_DIRECTORY_UNAVAILABLE",
      "实时 TXT 目录不存在或不是文件夹；请先创建目录并确认当前用户可以访问。",
    ],
    [
      "LIVE_TEXT_MIRROR_BEGIN_FAILED",
      "无法创建本场会议的实时 TXT；请确认目录可写，且同名文件尚不存在。会议未开始。",
    ],
    [
      "LIVE_TEXT_MIRROR_WRITE_FAILED",
      "实时 TXT 写入已停止，但 SQLite 中已经提交的会议原文仍然安全。请在会后导出完整记录。",
    ],
    ["MVP_PAUSE_TIMEOUT", "暂停操作没有及时完成。请停止会议；已经保存的文字不会丢失。"],
    ["MVP_RESUME_TIMEOUT", "继续操作没有及时完成。请停止会议后重新开始；已经保存的文字不会丢失。"],
  ];
  return known.find(([code]) => normalized.includes(code))?.[1] ?? normalized;
}

export function formatMvpSnapshotError(
  snapshot: Pick<MvpSnapshot, "error" | "system" | "microphone">,
): string {
  const systemError = snapshot.system.status === "disabled" ? null : snapshot.system.error;
  const microphoneError =
    snapshot.microphone.status === "disabled" ? null : snapshot.microphone.error;
  const error = snapshot.error ?? systemError ?? microphoneError;
  return error === null ? "" : formatMvpErrorMessage(error);
}

const UINT64_MAX = 18_446_744_073_709_551_615n;
const CANONICAL_UNSIGNED_DECIMAL = /^(?:0|[1-9][0-9]*)$/;
const IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const SHA256 = /^[a-fA-F0-9]{64}$/;
const SOURCE_STATUSES = ["disabled", "ready", "capturing", "degraded", "error"] as const;
const DURABILITY_STATUSES = [
  "initializing",
  "ready",
  "recording",
  "paused",
  "completed",
  "interrupted",
  "error",
] as const;
const TRANSLATION_STATUSES = MVP_TRANSLATION_STATUSES;
const MAX_AUDIO_DEVICES_PER_ROLE = 256;
const MAX_AUDIO_DEVICE_ID_LENGTH = 1024;
const MAX_TAGS_PER_MEETING = 32;
const TAG_TEXT = /^[^\u0000-\u001f\u007f]{1,64}$/;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const SPEAKER_STATUSES = ["completed", "skipped", "failed", "unavailable"] as const;

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

export function parseAppPreference(serialized: string | null): AppPreference | null {
  if (serialized === null) return null;
  try {
    const preference = object(JSON.parse(serialized), "application preference");
    if (preference.version !== 1) return null;
    const liveTextDirectory = boundedString(
      preference.liveTextDirectory,
      "preference.liveTextDirectory",
      1024,
    ).trim();
    if (CONTROL_CHARACTER.test(liveTextDirectory)) return null;
    return {
      version: 1,
      recognitionLanguage: parseMvpRecognitionLanguage(preference.recognitionLanguage),
      sourceMode: parseMvpAudioSourceMode(preference.sourceMode),
      transcriptDisplayMode: enumValue(
        preference.transcriptDisplayMode,
        "preference.transcriptDisplayMode",
        MVP_TRANSCRIPT_DISPLAY_MODES,
      ),
      liveTextEnabled: boolean(preference.liveTextEnabled, "preference.liveTextEnabled"),
      liveTextDirectory,
    };
  } catch {
    return null;
  }
}

export function isWindowsAbsoluteDirectory(value: string): boolean {
  const path = value.trim();
  return /^(?:[a-zA-Z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/.test(path);
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

function positiveSafeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
  return value;
}

function u32(value: unknown, label: string): number {
  const parsed = positiveSafeInteger(value, label);
  if (parsed > 4_294_967_295) {
    throw new Error(`${label} exceeds u32.`);
  }
  return parsed;
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
  const translationStatus = enumValue(
    segment.translationStatus,
    "segment.translationStatus",
    TRANSLATION_STATUSES,
  );
  const translationTarget =
    segment.translationTarget === null
      ? null
      : parseMvpRecognitionLanguage(segment.translationTarget);
  const translationText = nullableString(
    segment.translationText,
    "segment.translationText",
    16_384,
  );
  const translationError = nullableString(
    segment.translationError,
    "segment.translationError",
    128,
  );
  const translationShapeValid =
    (!expectedFinal &&
      translationStatus === "disabled" &&
      translationTarget === null &&
      translationText === null &&
      translationError === null) ||
    (expectedFinal &&
      ((translationStatus === "disabled" &&
        translationTarget === null &&
        translationText === null &&
        translationError === null) ||
        (translationStatus === "pending" &&
          translationTarget !== null &&
          translationText === null &&
          translationError === null) ||
        (translationStatus === "completed" &&
          translationTarget !== null &&
          translationText !== null &&
          translationText.length > 0 &&
          translationError === null) ||
        (translationStatus === "failed" &&
          translationTarget !== null &&
          translationText === null &&
          translationError !== null &&
          translationError.length > 0) ||
        (translationStatus === "skipped" &&
          translationTarget !== null &&
          translationText === null &&
          translationError === null)));
  if (!translationShapeValid) {
    throw new Error("segment translation state is inconsistent.");
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
    meetingSampleStart: uint64(segment.meetingSampleStart, "segment.meetingSampleStart"),
    meetingSampleEnd: uint64(segment.meetingSampleEnd, "segment.meetingSampleEnd"),
    timelineRevision: positiveSafeInteger(segment.timelineRevision, "segment.timelineRevision"),
    translationStatus,
    translationTarget,
    translationText,
    translationError,
  };
}

export function parseTranslationProbe(value: unknown): TranslationProbe {
  const probe = object(value, "translation probe");
  return {
    endpoint: boundedString(probe.endpoint, "translation probe endpoint", 640),
    model: boundedString(probe.model, "translation probe model", 256),
    targetLanguage: parseMvpRecognitionLanguage(probe.targetLanguage),
    latencyMs: safeCount(probe.latencyMs, "translation probe latency"),
    preview: boundedString(probe.preview, "translation probe preview", 16_384),
  };
}

function providerKey(value: unknown): string {
  const key = boundedString(value, "translation provider", 64).trim();
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(key)) {
    throw new Error("translation provider is invalid.");
  }
  return key;
}

export function parseTranslationPreference(
  serialized: string | null,
): TranslationPreference | null {
  if (serialized === null) return null;
  try {
    const preference = object(JSON.parse(serialized), "translation preference");
    if (preference.version !== 1) return null;
    const model = boundedString(preference.model, "translation model", 256).trim();
    if ("apiKey" in preference || "Authorization" in preference) return null;
    if (preference.baseUrl !== undefined && preference.baseUrl !== "") return null;
    return {
      version: 1,
      enabled: boolean(preference.enabled, "translation enabled"),
      provider: providerKey(preference.provider ?? "custom"),
      providerProfileId:
        preference.providerProfileId === undefined || preference.providerProfileId === null
          ? null
          : identifier(preference.providerProfileId, "translation provider profile"),
      baseUrl: "",
      model,
      targetLanguage: parseMvpRecognitionLanguage(preference.targetLanguage),
      allowInsecureHttp:
        preference.allowInsecureHttp === undefined
          ? false
          : boolean(preference.allowInsecureHttp, "allow insecure HTTP"),
    };
  } catch {
    return null;
  }
}

function diskHealth(value: unknown): DiskHealthSnapshot {
  const disk = object(value, "disk health");
  return {
    status: enumValue(disk.status, "disk.status", MVP_DISK_STATUSES),
    dataDir: boundedString(disk.dataDir, "disk.dataDir", 1024),
    freeBytes: uint64(disk.freeBytes, "disk.freeBytes"),
    requiredBytes: uint64(disk.requiredBytes, "disk.requiredBytes"),
    warning: nullableString(disk.warning, "disk.warning", 512),
  };
}

export function parseDataDirectorySettings(value: unknown): DataDirectorySettings {
  const settings = object(value, "data directory settings");
  const activeDataDir = boundedString(
    settings.activeDataDir,
    "data directory activeDataDir",
    1024,
  ).trim();
  const configuredDataDir = boundedString(
    settings.configuredDataDir,
    "data directory configuredDataDir",
    1024,
  ).trim();
  if (
    !isWindowsAbsoluteDirectory(activeDataDir) ||
    !isWindowsAbsoluteDirectory(configuredDataDir)
  ) {
    throw new Error(
      "data directory activeDataDir/configuredDataDir require absolute Windows paths.",
    );
  }
  return {
    activeDataDir,
    configuredDataDir,
    restartRequired: boolean(settings.restartRequired, "data directory restartRequired"),
    environmentOverride: boolean(
      settings.environmentOverride,
      "data directory environmentOverride",
    ),
    activeStorageAvailable: boolean(
      settings.activeStorageAvailable,
      "data directory activeStorageAvailable",
    ),
  };
}

export function parseTranslationRetryProgress(value: unknown): TranslationRetryProgress {
  const progress = object(value, "translation retry progress");
  const total = safeCount(progress.total, "retry.total");
  const completed = safeCount(progress.progress, "retry.progress");
  const succeeded = safeCount(progress.succeeded, "retry.succeeded");
  const failed = safeCount(progress.failed, "retry.failed");
  const cancelled = safeCount(progress.cancelled, "retry.cancelled");
  if (completed > total || succeeded + failed + cancelled > total) {
    throw new Error("translation retry progress counters are inconsistent.");
  }
  return {
    batchId: nullableIdentifier(progress.batchId, "retry.batchId"),
    status: enumValue(progress.status, "retry.status", MVP_TRANSLATION_RETRY_STATUSES),
    total,
    progress: completed,
    succeeded,
    failed,
    cancelled,
    costRiskAccepted: boolean(progress.costRiskAccepted, "retry.costRiskAccepted"),
    message: nullableString(progress.message, "retry.message", 512),
  };
}

export function parseDiagnosticBundleResult(value: unknown): DiagnosticBundleResult {
  const result = object(value, "diagnostic bundle");
  const sha256 = boundedString(result.sha256, "diagnostic.sha256", 64);
  if (!SHA256.test(sha256)) throw new Error("diagnostic.sha256 must be a SHA-256 hex digest.");
  if (result.redacted !== true) throw new Error("diagnostic bundle must be redacted.");
  return {
    path: boundedString(result.path, "diagnostic.path", 1024),
    byteLength: safeCount(result.byteLength, "diagnostic.byteLength"),
    sha256,
    redacted: true,
  };
}

function interruptedMeeting(value: unknown): InterruptedMeeting {
  const meeting = object(value, "interrupted meeting");
  return {
    meetingId: identifier(meeting.meetingId, "interrupted.meetingId"),
    startedAt: boundedString(meeting.startedAt, "interrupted.startedAt", 64),
    updatedAt: boundedString(meeting.updatedAt, "interrupted.updatedAt", 64),
    savedFinalCount: uint64(meeting.savedFinalCount, "interrupted.savedFinalCount"),
    pendingFinalCount: uint64(meeting.pendingFinalCount, "interrupted.pendingFinalCount"),
    translationFailedCount: safeCount(
      meeting.translationFailedCount,
      "interrupted.translationFailedCount",
    ),
    reason: nullableString(meeting.reason, "interrupted.reason", 512),
    recommendedAction: enumValue(
      meeting.recommendedAction,
      "interrupted.recommendedAction",
      MVP_INTERRUPTED_ACTIONS,
    ),
  };
}

export function parseInterruptedMeetings(value: unknown): InterruptedMeeting[] {
  if (!Array.isArray(value) || value.length > 128) {
    throw new Error("interrupted meetings must be a bounded array.");
  }
  return value.map(interruptedMeeting);
}

export function parseSegmentAudioLocation(value: unknown): SegmentAudioLocation {
  const location = object(value, "segment audio location");
  const available = boolean(location.available, "audio.available");
  const path = nullableString(location.path, "audio.path", 1024);
  const offsetMs = location.offsetMs === null ? null : uint64(location.offsetMs, "audio.offsetMs");
  const durationMs =
    location.durationMs === null ? null : uint64(location.durationMs, "audio.durationMs");
  const reason = nullableString(location.reason, "audio.reason", 512);
  if (available && (path === null || offsetMs === null || durationMs === null)) {
    throw new Error("available segment audio must include path and time range.");
  }
  if (!available && reason === null) {
    throw new Error("unavailable segment audio must include a reason.");
  }
  return { available, path, offsetMs, durationMs, reason };
}

export function requiresInsecureRemoteHttpAcknowledgement(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "http:") return false;
    const hostname = url.hostname.toLowerCase();
    return !["localhost", "127.0.0.1", "[::1]"].includes(hostname);
  } catch {
    return false;
  }
}

function exportFormat(value: unknown): MvpExportFormat {
  return enumValue(value, "export format", MVP_EXPORT_FORMATS);
}

function tag(value: unknown, label: string): string {
  const text = boundedString(value, label, 64).trim();
  if (!TAG_TEXT.test(text)) {
    throw new Error(`${label} is invalid.`);
  }
  return text;
}

function tags(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_TAGS_PER_MEETING) {
    throw new Error(`${label} must be a bounded array.`);
  }
  const parsed = value.map((entry, index) => tag(entry, `${label}[${index}]`));
  if (new Set(parsed).size !== parsed.length) {
    throw new Error(`${label} contains duplicates.`);
  }
  return parsed;
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

function summaryStatus(value: unknown, label: string): MvpSummaryJobStatus {
  return enumValue(value, label, MVP_SUMMARY_JOB_STATUSES);
}

function providerClass(value: unknown, label: string): MvpProviderClass {
  return enumValue(value, label, MVP_PROVIDER_CLASSES);
}

function searchScope(value: unknown, label: string): MvpSearchScope {
  return enumValue(value, label, MVP_SEARCH_SCOPES);
}

function meetingListItem(value: unknown, label: string): MeetingListItem {
  const meeting = object(value, label);
  return {
    meetingId: identifier(meeting.meetingId, `${label}.meetingId`),
    title: boundedString(meeting.title, `${label}.title`, 256),
    status: enumValue(meeting.status, `${label}.status`, DURABILITY_STATUSES),
    startedAt: boundedString(meeting.startedAt, `${label}.startedAt`, 64),
    updatedAt: boundedString(meeting.updatedAt, `${label}.updatedAt`, 64),
    durationMs: uint64(meeting.durationMs, `${label}.durationMs`),
    language: enumValue(meeting.language, `${label}.language`, MVP_MEETING_LANGUAGES),
    savedFinalCount: uint64(meeting.savedFinalCount, `${label}.savedFinalCount`),
    translationFailedCount: safeCount(
      meeting.translationFailedCount,
      `${label}.translationFailedCount`,
    ),
    summaryStatus: summaryStatus(meeting.summaryStatus, `${label}.summaryStatus`),
    tags: tags(meeting.tags, `${label}.tags`),
  };
}

export function parseMeetingListPage(value: unknown): MeetingListPage {
  const page = object(value, "meeting list page");
  if (!Array.isArray(page.items) || page.items.length > 200) {
    throw new Error("meeting list page items are invalid.");
  }
  const pageSize = safeCount(page.pageSize, "meeting pageSize");
  if (pageSize === 0 || pageSize > 200 || page.items.length > pageSize) {
    throw new Error("meeting pageSize is outside the UI bound.");
  }
  return {
    items: page.items.map((item, index) => meetingListItem(item, `items[${index}]`)),
    nextCursor: nullableString(page.nextCursor, "meeting nextCursor", 256),
    total: safeCount(page.total, "meeting total"),
    pageSize,
    elapsedMs: safeCount(page.elapsedMs, "meeting elapsedMs"),
  };
}

export function parseMeetingDetail(value: unknown): MeetingDetail {
  const detail = object(value, "meeting detail");
  if (!Array.isArray(detail.segments) || detail.segments.length > 10_000) {
    throw new Error("meeting detail segments are invalid.");
  }
  return {
    meeting: meetingListItem(detail.meeting, "detail.meeting"),
    segments: detail.segments.map((item) => transcript(item, true)),
    summary: detail.summary === null ? null : summaryResult(detail.summary),
  };
}

function segmentSearchHit(value: unknown, label: string): SegmentSearchHit {
  const hit = object(value, label);
  const score = hit.score;
  if (typeof score !== "number" || !Number.isFinite(score) || score < 0) {
    throw new Error(`${label}.score must be a non-negative finite number.`);
  }
  return {
    meetingId: identifier(hit.meetingId, `${label}.meetingId`),
    meetingTitle: boundedString(hit.meetingTitle, `${label}.meetingTitle`, 256),
    segmentId: nullableIdentifier(hit.segmentId, `${label}.segmentId`),
    sequence: hit.sequence === null ? null : uint64(hit.sequence, `${label}.sequence`),
    scope: searchScope(hit.scope, `${label}.scope`),
    snippet: boundedString(hit.snippet, `${label}.snippet`, 1024),
    score,
  };
}

export function parseSegmentSearchPage(value: unknown): SegmentSearchPage {
  const page = object(value, "segment search page");
  if (!Array.isArray(page.hits) || page.hits.length > 200) {
    throw new Error("segment search hits are invalid.");
  }
  return {
    hits: page.hits.map((hit, index) => segmentSearchHit(hit, `hits[${index}]`)),
    nextCursor: nullableString(page.nextCursor, "segment search nextCursor", 256),
    total: safeCount(page.total, "segment search total"),
    elapsedMs: safeCount(page.elapsedMs, "segment search elapsedMs"),
  };
}

export function parseProviderProfiles(value: unknown): ProviderProfile[] {
  if (!Array.isArray(value) || value.length > 64) {
    throw new Error("provider profiles must be a bounded array.");
  }
  return value.map((entry, index) => {
    const profile = object(entry, `provider[${index}]`);
    const configVersion = safeCount(profile.configVersion, `provider[${index}].configVersion`);
    if (configVersion === 0) {
      throw new Error("provider configVersion must be positive.");
    }
    return {
      profileId: identifier(profile.profileId, `provider[${index}].profileId`),
      label: boundedString(profile.label, `provider[${index}].label`, 128),
      class: providerClass(profile.class, `provider[${index}].class`),
      baseUrl: boundedString(profile.baseUrl, `provider[${index}].baseUrl`, 640),
      model: boundedString(profile.model, `provider[${index}].model`, 256),
      policyUrl: nullableString(profile.policyUrl, `provider[${index}].policyUrl`, 640),
      dataFlow: boundedString(profile.dataFlow, `provider[${index}].dataFlow`, 1024),
      configVersion,
      secretState: enumValue(profile.secretState, `provider[${index}].secretState`, [
        "missing",
        "present",
        "not_required",
        "unsupported",
      ] as const),
      lastTestStatus: enumValue(profile.lastTestStatus, `provider[${index}].lastTestStatus`, [
        "untested",
        "passed",
        "failed",
      ] as const),
      lastTestAt: nullableString(profile.lastTestAt, `provider[${index}].lastTestAt`, 64),
      lastError: nullableString(profile.lastError, `provider[${index}].lastError`, 512),
    };
  });
}

export function parseAsrModelProfiles(value: unknown): AsrModelProfile[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 16) {
    throw new Error("ASR model profiles must be a non-empty bounded array.");
  }
  return value.map((entry, index) => {
    const profile = object(entry, `asrModel[${index}]`);
    if (!Array.isArray(profile.supportedLanguages) || profile.supportedLanguages.length === 0) {
      throw new Error(`asrModel[${index}].supportedLanguages is invalid.`);
    }
    const sha256 = boundedString(profile.modelSha256, `asrModel[${index}].modelSha256`, 64);
    if (!/^[a-f0-9]{64}$/.test(sha256)) {
      throw new Error(`asrModel[${index}].modelSha256 is invalid.`);
    }
    return {
      modelId: identifier(profile.modelId, `asrModel[${index}].modelId`),
      label: boundedString(profile.label, `asrModel[${index}].label`, 128),
      tier: enumValue(profile.tier, `asrModel[${index}].tier`, [
        "stable-default",
        "high-quality-candidate",
        "high-quality-default",
      ] as const),
      engine: identifier(profile.engine, `asrModel[${index}].engine`),
      engineVersion: boundedString(
        profile.engineVersion,
        `asrModel[${index}].engineVersion`,
        64,
      ),
      runtimeVersion: boundedString(
        profile.runtimeVersion,
        `asrModel[${index}].runtimeVersion`,
        64,
      ),
      modelRevision: boundedString(
        profile.modelRevision,
        `asrModel[${index}].modelRevision`,
        128,
      ),
      modelSha256: sha256,
      quantization: boundedString(
        profile.quantization,
        `asrModel[${index}].quantization`,
        32,
      ),
      executionProvider: boundedString(
        profile.executionProvider,
        `asrModel[${index}].executionProvider`,
        32,
      ),
      nativeStreaming: boolean(
        profile.nativeStreaming,
        `asrModel[${index}].nativeStreaming`,
      ),
      supportedLanguages: profile.supportedLanguages.map((language, languageIndex) =>
        enumValue(
          language,
          `asrModel[${index}].supportedLanguages[${languageIndex}]`,
          MVP_RECOGNITION_LANGUAGES,
        ),
      ),
      modelSizeBytes: uint64(profile.modelSizeBytes, `asrModel[${index}].modelSizeBytes`),
      recommendedMemoryMb: safeCount(
        profile.recommendedMemoryMb,
        `asrModel[${index}].recommendedMemoryMb`,
      ),
      licenseId: boundedString(profile.licenseId, `asrModel[${index}].licenseId`, 256),
      installState: enumValue(profile.installState, `asrModel[${index}].installState`, [
        "verified",
        "missing",
        "invalid",
      ] as const),
      benchmarkStatus: enumValue(
        profile.benchmarkStatus,
        `asrModel[${index}].benchmarkStatus`,
        ["baseline-locked", "pending", "verified", "local-smoke-verified"] as const,
      ),
      selectable: boolean(profile.selectable, `asrModel[${index}].selectable`),
    };
  });
}

export function parseLocalTranslationDiscovery(value: unknown): LocalTranslationDiscovery {
  const discovery = object(value, "local translation discovery");
  if (!Array.isArray(discovery.models) || discovery.models.length === 0 || discovery.models.length > 512) {
    throw new Error("local translation models are invalid.");
  }
  return {
    baseUrl: boundedString(discovery.baseUrl, "local translation baseUrl", 640),
    endpoint: boundedString(discovery.endpoint, "local translation endpoint", 640),
    providerFlavor: enumValue(discovery.providerFlavor, "local translation providerFlavor", [
      "ollama",
      "lmstudio",
      "openai-compatible",
    ] as const),
    models: discovery.models.map((entry, index) => {
      const model = object(entry, `local translation model[${index}]`);
      return {
        id: boundedString(model.id, `local translation model[${index}].id`, 256),
        ownedBy: nullableString(
          model.ownedBy,
          `local translation model[${index}].ownedBy`,
          128,
        ),
      };
    }),
    latencyMs: safeCount(discovery.latencyMs, "local translation latencyMs"),
  };
}

export function parseProviderProfileDraft(value: unknown): ProviderProfileDraft {
  const profile = object(value, "provider profile draft");
  const configVersion = safeCount(profile.configVersion, "provider draft.configVersion");
  if (configVersion === 0) {
    throw new Error("provider draft configVersion must be positive.");
  }
  return {
    profileId: identifier(profile.profileId, "provider draft.profileId"),
    label: boundedString(profile.label, "provider draft.label", 128),
    class: providerClass(profile.class, "provider draft.class"),
    baseUrl: boundedString(profile.baseUrl, "provider draft.baseUrl", 640),
    model: boundedString(profile.model, "provider draft.model", 256),
    policyUrl: nullableString(profile.policyUrl, "provider draft.policyUrl", 640),
    dataFlow: boundedString(profile.dataFlow, "provider draft.dataFlow", 1024),
    configVersion,
  };
}

function deletePreviewEntry(value: unknown, label: string): DeletePreviewEntry {
  const entry = object(value, label);
  return {
    type: enumValue(entry.type, `${label}.type`, MVP_DELETE_ENTRY_TYPES),
    path: nullableString(entry.path, `${label}.path`, 1024),
    byteLength: uint64(entry.byteLength, `${label}.byteLength`),
    description: boundedString(entry.description, `${label}.description`, 512),
  };
}

export function parseDeletePreview(value: unknown): DeletePreview {
  const preview = object(value, "delete preview");
  if (!Array.isArray(preview.entries) || preview.entries.length > 1024) {
    throw new Error("delete preview entries are invalid.");
  }
  const recoveryWindowSeconds = safeCount(
    preview.recoveryWindowSeconds,
    "delete recoveryWindowSeconds",
  );
  if (recoveryWindowSeconds > 86_400) {
    throw new Error("delete recovery window is outside the UI bound.");
  }
  return {
    meetingId: identifier(preview.meetingId, "delete.meetingId"),
    recoveryWindowSeconds,
    includeRaw: boolean(preview.includeRaw, "delete.includeRaw"),
    includeDerived: boolean(preview.includeDerived, "delete.includeDerived"),
    entries: preview.entries.map((entry, index) => deletePreviewEntry(entry, `entries[${index}]`)),
    willDeleteBytes: uint64(preview.willDeleteBytes, "delete.willDeleteBytes"),
    canRestore: boolean(preview.canRestore, "delete.canRestore"),
  };
}

export function parseDeleteResult(value: unknown): DeleteResult {
  const result = object(value, "delete result");
  return {
    meetingId: identifier(result.meetingId, "deleteResult.meetingId"),
    deleted: boolean(result.deleted, "deleteResult.deleted"),
    restoredUntil: nullableString(result.restoredUntil, "deleteResult.restoredUntil", 64),
    entriesDeleted: safeCount(result.entriesDeleted, "deleteResult.entriesDeleted"),
    bytesDeleted: uint64(result.bytesDeleted, "deleteResult.bytesDeleted"),
  };
}

function summaryCitation(value: unknown, label: string): SummaryCitation {
  const citation = object(value, label);
  const segmentId = nullableIdentifier(citation.segmentId, `${label}.segmentId`);
  const sequence = citation.sequence === null ? null : uint64(citation.sequence, `${label}.sequence`);
  return {
    segmentId,
    sequence,
    label: boundedString(citation.label, `${label}.label`, 128),
  };
}

function boundedStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > 256) {
    throw new Error(`${label} must be a bounded array.`);
  }
  return value.map((entry, index) => boundedString(entry, `${label}[${index}]`, 2048));
}

function summaryResult(value: unknown): SummaryResult {
  const result = object(value, "summary result");
  if (!Array.isArray(result.citations) || result.citations.length > 1024) {
    throw new Error("summary citations are invalid.");
  }
  const version = safeCount(result.version, "summary.version");
  if (version === 0) throw new Error("summary version must be positive.");
  return {
    summaryId: identifier(result.summaryId, "summary.summaryId"),
    version,
    language: parseMvpRecognitionLanguage(result.language),
    overview: boundedString(result.overview, "summary.overview", 32_768),
    actions: boundedStringArray(result.actions, "summary.actions"),
    decisions: boundedStringArray(result.decisions, "summary.decisions"),
    openQuestions: boundedStringArray(result.openQuestions, "summary.openQuestions"),
    citations: result.citations.map((entry, index) => summaryCitation(entry, `citations[${index}]`)),
    createdAt: boundedString(result.createdAt, "summary.createdAt", 64),
  };
}

export function parseSummaryJob(value: unknown): SummaryJob {
  const job = object(value, "summary job");
  const totalChunks = safeCount(job.totalChunks, "summary.totalChunks");
  const completedChunks = safeCount(job.completedChunks, "summary.completedChunks");
  if (completedChunks > totalChunks) {
    throw new Error("summary chunk counters are inconsistent.");
  }
  return {
    jobId: identifier(job.jobId, "summary.jobId"),
    meetingId: identifier(job.meetingId, "summary.meetingId"),
    status: summaryStatus(job.status, "summary.status"),
    version: safeCount(job.version, "summary.version"),
    totalChunks,
    completedChunks,
    canCancel: boolean(job.canCancel, "summary.canCancel"),
    canRetry: boolean(job.canRetry, "summary.canRetry"),
    message: nullableString(job.message, "summary.message", 512),
    result: job.result === null ? null : summaryResult(job.result),
  };
}

function speakerDisplayName(value: unknown, label: string): string {
  const text = boundedString(value, label, 80).trim();
  if (text.length === 0 || CONTROL_CHARACTER.test(text)) {
    throw new Error(`${label} is invalid.`);
  }
  return text;
}

function speakerIdentity(value: unknown, label: string): SpeakerIdentity {
  const identity = object(value, label);
  return {
    speakerId: identifier(identity.speakerId, `${label}.speakerId`),
    displayName: speakerDisplayName(identity.displayName, `${label}.displayName`),
  };
}

function speakerAssignment(value: unknown, label: string): SpeakerAssignment {
  const assignment = object(value, label);
  const confidence = assignment.confidence;
  if (
    typeof confidence !== "number" ||
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1
  ) {
    throw new Error(`${label}.confidence must be between zero and one.`);
  }
  return {
    segmentId: identifier(assignment.segmentId, `${label}.segmentId`),
    sequence: uint64(assignment.sequence, `${label}.sequence`),
    sourceRevision: u32(assignment.sourceRevision, `${label}.sourceRevision`),
    speakerId: identifier(assignment.speakerId, `${label}.speakerId`),
    confidence,
  };
}

export function parseSpeakerVersion(value: unknown): SpeakerVersion | null {
  if (value === null) return null;
  const version = object(value, "speaker version");
  const digest = boundedString(version.digest, "speaker.digest", 64);
  if (!SHA256.test(digest)) {
    throw new Error("speaker.digest must be a SHA-256 hex digest.");
  }
  if (!Array.isArray(version.identities) || version.identities.length > 64) {
    throw new Error("speaker identities must be a bounded array.");
  }
  if (!Array.isArray(version.assignments) || version.assignments.length > 10_000) {
    throw new Error("speaker assignments must be a bounded array.");
  }
  const identities = version.identities.map((entry, index) =>
    speakerIdentity(entry, `speaker.identities[${index}]`),
  );
  const identityIds = new Set(identities.map((identity) => identity.speakerId));
  if (identityIds.size !== identities.length) {
    throw new Error("speaker identities contain duplicates.");
  }
  const assignments = version.assignments.map((entry, index) =>
    speakerAssignment(entry, `speaker.assignments[${index}]`),
  );
  for (const assignment of assignments) {
    if (!identityIds.has(assignment.speakerId)) {
      throw new Error("speaker assignment references an unknown identity.");
    }
  }
  return {
    meetingId: identifier(version.meetingId, "speaker.meetingId"),
    version: u32(version.version, "speaker.version"),
    parentVersion: version.parentVersion === null ? null : u32(version.parentVersion, "speaker.parentVersion"),
    algorithm: boundedString(version.algorithm, "speaker.algorithm", 256),
    digest,
    createdAt: boundedString(version.createdAt, "speaker.createdAt", 64),
    operation: boundedString(version.operation, "speaker.operation", 64),
    identities,
    assignments,
  };
}

export function parseSpeakerDiarizationResult(value: unknown): SpeakerDiarizationResult {
  const result = object(value, "speaker diarization result");
  const version = result.version === null ? null : u32(result.version, "speaker result.version");
  const status = enumValue(result.status, "speaker result.status", SPEAKER_STATUSES);
  if ((status === "completed") !== (version !== null)) {
    throw new Error("speaker result status and version are inconsistent.");
  }
  return {
    meetingId: identifier(result.meetingId, "speaker result.meetingId"),
    version,
    status,
    reason: nullableString(result.reason, "speaker result.reason", 512),
  };
}

export function parseExportOptions(value: unknown): ExportOptions {
  const options = object(value, "export options");
  if (!Array.isArray(options.formats) || options.formats.length === 0) {
    throw new Error("export options must include at least one format.");
  }
  const formats = options.formats.map(exportFormat);
  if (new Set(formats).size !== formats.length) {
    throw new Error("export options contain duplicate formats.");
  }
  const summaryVersion =
    options.summaryVersion === null || options.summaryVersion === undefined
      ? null
      : safeCount(options.summaryVersion, "export.summaryVersion");
  if (summaryVersion === 0) {
    throw new Error("export summaryVersion must be positive.");
  }
  const speakerVersion =
    options.speakerVersion === null || options.speakerVersion === undefined
      ? null
      : safeCount(options.speakerVersion, "export.speakerVersion");
  if (speakerVersion === 0) {
    throw new Error("export speakerVersion must be positive.");
  }
  return {
    formats,
    includeOriginal: boolean(options.includeOriginal, "export.includeOriginal"),
    includeTranslation: boolean(options.includeTranslation, "export.includeTranslation"),
    bilingual: boolean(options.bilingual, "export.bilingual"),
    includeSpeaker: boolean(options.includeSpeaker, "export.includeSpeaker"),
    includeSummary: boolean(options.includeSummary, "export.includeSummary"),
    includeTimestamp: boolean(options.includeTimestamp, "export.includeTimestamp"),
    summaryVersion,
    speakerVersion,
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
    snapshot.queueDepth > MAX_INFERENCE_QUEUE_DEPTH
  ) {
    throw new Error("queueDepth is outside the MVP bound.");
  }
  if (
    typeof snapshot.translationQueueDepth !== "number" ||
    !Number.isSafeInteger(snapshot.translationQueueDepth) ||
    snapshot.translationQueueDepth < 0 ||
    snapshot.translationQueueDepth > 32
  ) {
    throw new Error("translationQueueDepth is outside the MVP bound.");
  }
  return {
    contractVersion: MVP_CONTRACT_VERSION,
    lifecycle,
    modelReady: boolean(snapshot.modelReady, "modelReady"),
    modelLabel: boundedString(snapshot.modelLabel, "modelLabel", 512),
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
    translationQueueDepth: snapshot.translationQueueDepth,
    disk: diskHealth(snapshot.disk),
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
