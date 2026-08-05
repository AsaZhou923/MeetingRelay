export type AsyncPhase = "idle" | "running" | "success" | "error";

export interface StartUiState {
  phase: AsyncPhase;
  message: string;
}

export interface ProbeUiState {
  profileId: string;
  phase: AsyncPhase;
  message: string;
  latencyMs: number | null;
  updatedAtMs: number;
}

export interface ProviderSummary {
  profileId: string;
}

export interface TranscriptFollowInput {
  followLatest: boolean;
  wasAtBottom: boolean;
  insertedCount: number;
  previousUnseenCount: number;
}

export interface TranscriptFollowState {
  followLatest: boolean;
  unseenCount: number;
  showJumpButton: boolean;
  announcement: string;
}

export interface LatestTranscriptLine {
  text: string;
  kind: "interim" | "final" | "translation" | "status" | "empty";
}

export interface TranslationDisplaySource {
  translationStatus: string;
  translationText: string | null;
}

export interface TranscriptDisplaySource extends TranslationDisplaySource {
  text: string;
}

export type TranscriptDisplayMode = "source_and_translation" | "translation_only";

export function beginStartUiState(): StartUiState {
  return {
    phase: "running",
    message: "正在检查设备和服务...",
  };
}

export function canBeginStart(state: StartUiState): boolean {
  return state.phase !== "running";
}

export function finishStartUiState(success: boolean, errorMessage = ""): StartUiState {
  return success
    ? { phase: "success", message: "会议已开始。" }
    : { phase: "error", message: errorMessage || "启动失败，请检查设备和服务后重试。" };
}

export function returnToLatest(): TranscriptFollowState {
  return {
    followLatest: true,
    unseenCount: 0,
    showJumpButton: false,
    announcement: "正在跟随最新内容。",
  };
}

export function selectLatestTranscriptLine(
  interimText: string | null,
  finals: readonly (string | TranscriptDisplaySource)[],
  displayMode: TranscriptDisplayMode = "source_and_translation",
): LatestTranscriptLine {
  if (displayMode === "translation_only") {
    const latestFinal = finals.at(-1);
    if (latestFinal === undefined) return { text: "等待译文。", kind: "empty" };
    if (typeof latestFinal === "string") {
      return { text: "正在等待译文…", kind: "status" };
    }
    return translationOnlyText(latestFinal);
  }
  const interim = interimText?.trim() ?? "";
  if (interim.length > 0) return { text: interim, kind: "interim" };
  const latest = finals.at(-1);
  const latestFinal = (typeof latest === "string" ? latest : latest?.text)?.trim() ?? "";
  if (latestFinal.length > 0) return { text: latestFinal, kind: "final" };
  return { text: "等待实时文字。", kind: "empty" };
}

export function translationOnlyText(source: TranslationDisplaySource): LatestTranscriptLine {
  if (source.translationStatus === "completed") {
    const translation = source.translationText?.trim() ?? "";
    return translation.length > 0
      ? { text: translation, kind: "translation" }
      : { text: "译文为空；请重试翻译。", kind: "status" };
  }
  if (source.translationStatus === "pending") {
    return { text: "正在等待译文…", kind: "status" };
  }
  if (source.translationStatus === "failed") {
    return { text: "翻译失败；原文仍已安全保存。", kind: "status" };
  }
  if (source.translationStatus === "skipped") {
    return { text: "译文语言与识别语言相同，已跳过翻译。", kind: "status" };
  }
  return { text: "翻译未启用；可切回“原文 + 译文”查看原文。", kind: "status" };
}

export function mergeProbeStates(
  existing: ReadonlyMap<string, ProbeUiState>,
  profiles: readonly ProviderSummary[],
): Map<string, ProbeUiState> {
  const profileIds = new Set(profiles.map((profile) => profile.profileId));
  const next = new Map<string, ProbeUiState>();
  for (const [profileId, state] of existing.entries()) {
    if (profileIds.has(profileId)) next.set(profileId, state);
  }
  return next;
}

export function nextTranscriptFollowState(input: TranscriptFollowInput): TranscriptFollowState {
  const shouldFollow = input.followLatest || input.wasAtBottom;
  const unseenCount = shouldFollow
    ? 0
    : input.previousUnseenCount + Math.max(0, input.insertedCount);
  return {
    followLatest: shouldFollow,
    unseenCount,
    showJumpButton: unseenCount > 0,
    announcement:
      unseenCount > 0
        ? `有 ${unseenCount} 条新内容，点击“回到最新”继续跟随。`
        : shouldFollow
          ? "正在跟随最新内容。"
          : "已暂停跟随，保留当前位置。",
  };
}
