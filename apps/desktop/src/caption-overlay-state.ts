import type { LatestTranscriptLine, TranslationDisplaySource } from "./frontend-state";
import type {
  MvpSnapshot,
  MvpTranscriptDisplayMode,
  TranscriptSegment,
} from "./mvp-contract";

export const OVERLAY_FONT_SIZE_STORAGE_KEY = "meetingrelay.captionOverlay.fontSizePx";
export const OVERLAY_DEFAULT_FONT_SIZE_PX = 34;
export const OVERLAY_MIN_FONT_SIZE_PX = 20;
export const OVERLAY_MAX_FONT_SIZE_PX = 72;
export const OVERLAY_FONT_SIZE_STEP_PX = 4;

export type OverlayCaptionLine = LatestTranscriptLine;

export function selectOverlayCaption(
  snapshot: Pick<MvpSnapshot, "interim" | "finals">,
  displayMode: MvpTranscriptDisplayMode,
): OverlayCaptionLine {
  if (displayMode === "translation_only") {
    const latestFinal = latestFinalSegment(snapshot.finals);
    if (latestFinal === undefined) return { text: "", kind: "empty" };
    return translationOnlyCaption(latestFinal);
  }

  const interimText = snapshot.interim?.text.trim() ?? "";
  if (interimText.length > 0) return { text: interimText, kind: "interim" };

  const finalText = latestFinalSegment(snapshot.finals)?.text.trim() ?? "";
  if (finalText.length > 0) return { text: finalText, kind: "final" };

  return { text: "", kind: "empty" };
}

export function parseOverlayFontSize(value: string | null): number {
  if (value === null) return OVERLAY_DEFAULT_FONT_SIZE_PX;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? clampOverlayFontSize(parsed) : OVERLAY_DEFAULT_FONT_SIZE_PX;
}

export function nextOverlayFontSize(current: number, direction: "smaller" | "larger"): number {
  const delta = direction === "larger" ? OVERLAY_FONT_SIZE_STEP_PX : -OVERLAY_FONT_SIZE_STEP_PX;
  return clampOverlayFontSize(current + delta);
}

export function clampOverlayFontSize(value: number): number {
  return Math.min(
    OVERLAY_MAX_FONT_SIZE_PX,
    Math.max(OVERLAY_MIN_FONT_SIZE_PX, Math.round(value)),
  );
}

function latestFinalSegment(finals: readonly TranscriptSegment[]): TranscriptSegment | undefined {
  return finals.at(-1);
}

function translationOnlyCaption(source: TranslationDisplaySource): LatestTranscriptLine {
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
