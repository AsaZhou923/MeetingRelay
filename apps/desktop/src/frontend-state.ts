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
