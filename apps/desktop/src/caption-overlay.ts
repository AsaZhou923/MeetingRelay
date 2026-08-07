import { invoke } from "@tauri-apps/api/core";
import { emitTo } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

import {
  OVERLAY_FONT_SIZE_STORAGE_KEY,
  nextOverlayFontSize,
  parseOverlayFontSize,
  selectOverlayCaptions,
} from "./caption-overlay-state";
import {
  APP_PREFERENCE_KEY,
  parseAppPreference,
  parseMvpSnapshot,
  type MvpSnapshot,
  type MvpTranscriptDisplayMode,
} from "./mvp-contract";
import "./overlay.css";

const MAIN_WINDOW_LABEL = "main";
const OVERLAY_HIDDEN_EVENT = "meetingrelay://caption-overlay-hidden";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("MeetingRelay overlay root is missing.");

app.innerHTML = `
  <main class="overlay-shell" aria-labelledby="overlay-title">
    <header class="overlay-toolbar" aria-label="悬浮字幕控制">
      <span id="overlay-title" class="overlay-title" data-overlay-drag-region>实时字幕</span>
      <div class="overlay-actions">
        <div class="overlay-font-controls" aria-label="字幕字号">
          <button id="overlay-font-smaller" type="button" aria-label="缩小字幕">A-</button>
          <output id="overlay-font-size" aria-live="polite">34px</output>
          <button id="overlay-font-larger" type="button" aria-label="放大字幕">A+</button>
        </div>
        <button id="overlay-close" class="overlay-close" type="button" aria-label="关闭悬浮字幕">×</button>
      </div>
    </header>
    <section class="overlay-caption" aria-live="polite">
      <ul id="overlay-caption-list" class="overlay-caption-list"></ul>
    </section>
    <p id="overlay-error" class="overlay-error" role="status"></p>
    <button id="overlay-resize-handle" class="overlay-resize-handle" type="button" aria-label="拖动调整窗口大小"></button>
  </main>
`;

const captionList = element<HTMLUListElement>("#overlay-caption-list");
const fontSize = element<HTMLOutputElement>("#overlay-font-size");
const fontSmaller = element<HTMLButtonElement>("#overlay-font-smaller");
const fontLarger = element<HTMLButtonElement>("#overlay-font-larger");
const overlayClose = element<HTMLButtonElement>("#overlay-close");
const resizeHandle = element<HTMLButtonElement>("#overlay-resize-handle");
const errorLine = element<HTMLParagraphElement>("#overlay-error");
const overlayWindow = getCurrentWindow();
let refreshInFlight = false;
let renderedCaptionSignature = "";
let captionFontSizePx = parseOverlayFontSize(
  window.localStorage.getItem(OVERLAY_FONT_SIZE_STORAGE_KEY),
);

function element<T extends Element>(selector: string): T {
  const value = document.querySelector<T>(selector);
  if (!value) throw new Error(`Required overlay element is missing: ${selector}`);
  return value;
}

function currentDisplayMode(): MvpTranscriptDisplayMode {
  try {
    return (
      parseAppPreference(window.localStorage.getItem(APP_PREFERENCE_KEY))
        ?.transcriptDisplayMode ?? "source_and_translation"
    );
  } catch {
    return "source_and_translation";
  }
}

function render(snapshot: MvpSnapshot): void {
  const displayMode = currentDisplayMode();
  const selectedCaptions = selectOverlayCaptions(snapshot, displayMode);
  const nextCaptionSignature = JSON.stringify(
    selectedCaptions.map((line) => [line.key, line.kind, line.current, line.text]),
  );
  if (nextCaptionSignature !== renderedCaptionSignature) {
    captionList.replaceChildren(
      ...selectedCaptions.map((line, index) => {
        const item = document.createElement("li");
        item.textContent = line.text;
        item.dataset.kind = line.kind;
        item.dataset.current = String(line.current);
        item.dataset.recency = String(selectedCaptions.length - index - 1);
        item.dataset.key = line.key;
        item.setAttribute("aria-current", line.current ? "true" : "false");
        return item;
      }),
    );
    renderedCaptionSignature = nextCaptionSignature;
  }
  const nextError = snapshot.error === null ? "" : snapshot.error;
  if (errorLine.textContent !== nextError) errorLine.textContent = nextError;
}

function persistCaptionFontSize(nextSizePx: number): void {
  captionFontSizePx = nextSizePx;
  captionList.style.setProperty("--overlay-current-font-size", `${captionFontSizePx}px`);
  fontSize.textContent = `${captionFontSizePx}px`;
  window.localStorage.setItem(OVERLAY_FONT_SIZE_STORAGE_KEY, String(captionFontSizePx));
}

function adjustCaptionFontSize(direction: "smaller" | "larger"): void {
  persistCaptionFontSize(nextOverlayFontSize(captionFontSizePx, direction));
}

function installWindowChromeHandlers(): void {
  for (const dragRegion of document.querySelectorAll<HTMLElement>("[data-overlay-drag-region]")) {
    dragRegion.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      if ((event.target as HTMLElement | null)?.closest("button")) return;
      void overlayWindow.startDragging();
    });
  }

  resizeHandle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    void overlayWindow.startResizeDragging("SouthEast");
  });
}

async function hideOverlay(): Promise<void> {
  await overlayWindow.hide();
  await emitTo(MAIN_WINDOW_LABEL, OVERLAY_HIDDEN_EVENT, { windowLabel: "caption-overlay" });
}

async function refreshWhenVisible(): Promise<void> {
  if (refreshInFlight) return;
  refreshInFlight = true;
  try {
    if (!(await overlayWindow.isVisible())) return;
    render(parseMvpSnapshot(await invoke<unknown>("mvp_snapshot")));
    errorLine.dataset.status = "";
  } catch (error) {
    errorLine.dataset.status = "error";
    errorLine.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    refreshInFlight = false;
  }
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void refreshWhenVisible();
});
fontSmaller.addEventListener("click", () => adjustCaptionFontSize("smaller"));
fontLarger.addEventListener("click", () => adjustCaptionFontSize("larger"));
overlayClose.addEventListener("click", () => {
  void hideOverlay().catch((error) => {
    errorLine.dataset.status = "error";
    errorLine.textContent = error instanceof Error ? error.message : String(error);
  });
});
persistCaptionFontSize(captionFontSizePx);
installWindowChromeHandlers();
void refreshWhenVisible();
window.setInterval(() => void refreshWhenVisible(), 250);
