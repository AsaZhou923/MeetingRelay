import {
  translationOnlyText,
  type LatestTranscriptLine,
} from "./frontend-state.ts";
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

export type OverlayCaptionLine = LatestTranscriptLine & {
  key: string;
  current: boolean;
};

export function selectOverlayCaptions(
  snapshot: Pick<MvpSnapshot, "interim" | "finals">,
  displayMode: MvpTranscriptDisplayMode,
): OverlayCaptionLine[] {
  if (displayMode === "translation_only") {
    const lines = snapshot.finals.slice(-3).map((final) => ({
      ...translationOnlyText(final),
      key: finalCaptionKey(final),
      current: false,
    }));
    return markCurrent(lines);
  }

  const interimText = snapshot.interim?.text.trim() ?? "";
  if (interimText.length > 0) {
    return markCurrent([
      ...meaningfulFinals(snapshot.finals).slice(-2).map((final) => ({
        text: final.text.trim(),
        kind: "final" as const,
        key: finalCaptionKey(final),
        current: false,
      })),
      {
        text: interimText,
        kind: "interim" as const,
        key: `interim:${snapshot.interim?.segmentId ?? "current"}`,
        current: false,
      },
    ]);
  }

  const lines = meaningfulFinals(snapshot.finals)
    .slice(-3)
    .map((final) => ({
      text: final.text.trim(),
      kind: "final" as const,
      key: finalCaptionKey(final),
      current: false,
    }));
  if (lines.length > 0) return markCurrent(lines);

  return [{ text: "", kind: "empty", key: "empty", current: true }];
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

function meaningfulFinals(finals: readonly TranscriptSegment[]): TranscriptSegment[] {
  return finals.filter((final) => final.text.trim().length > 0);
}

function finalCaptionKey(final: TranscriptSegment): string {
  return `final:${final.segmentId}`;
}

function markCurrent(lines: OverlayCaptionLine[]): OverlayCaptionLine[] {
  return lines.map((line, index) => ({
    ...line,
    current: index === lines.length - 1,
  }));
}
