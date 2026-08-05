import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { translationOnlyText } from "./frontend-state";
import {
  APP_PREFERENCE_KEY,
  formatElapsed,
  parseAppPreference,
  parseMvpSnapshot,
  type MvpSnapshot,
  type MvpTranscriptDisplayMode,
  type TranscriptSegment,
} from "./mvp-contract";
import "./overlay.css";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("MeetingRelay overlay root is missing.");

app.innerHTML = `
  <main class="overlay-shell" aria-labelledby="overlay-title">
    <header class="overlay-header">
      <div>
        <p class="overlay-kicker">MeetingRelay compact overlay</p>
        <h1 id="overlay-title">Live captions</h1>
      </div>
      <dl class="overlay-meta" aria-label="Read-only session status">
        <div><dt>State</dt><dd id="overlay-state">BOOTING</dd></div>
        <div><dt>Time</dt><dd id="overlay-elapsed">00:00:00</dd></div>
        <div><dt>Finals</dt><dd id="overlay-count">0</dd></div>
      </dl>
    </header>
    <section class="overlay-interim" aria-labelledby="overlay-interim-title">
      <h2 id="overlay-interim-title">正在识别</h2>
      <p id="overlay-interim-text">等待实时字幕…</p>
    </section>
    <section class="overlay-finals" aria-labelledby="overlay-finals-title">
      <h2 id="overlay-finals-title">最近已保存</h2>
      <ol id="overlay-finals-list" aria-live="polite"></ol>
    </section>
    <p id="overlay-error" class="overlay-error" role="status"></p>
  </main>
`;

const state = element<HTMLElement>("#overlay-state");
const elapsed = element<HTMLElement>("#overlay-elapsed");
const count = element<HTMLElement>("#overlay-count");
const interimTitle = element<HTMLElement>("#overlay-interim-title");
const interim = element<HTMLParagraphElement>("#overlay-interim-text");
const finals = element<HTMLOListElement>("#overlay-finals-list");
const errorLine = element<HTMLParagraphElement>("#overlay-error");
const overlayWindow = getCurrentWindow();
let refreshInFlight = false;

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

function renderSegment(
  segment: TranscriptSegment,
  displayMode: MvpTranscriptDisplayMode,
): HTMLLIElement {
  const item = document.createElement("li");
  const heading = document.createElement("strong");
  const text = document.createElement("p");
  const meta = document.createElement("small");
  heading.textContent = `#${segment.sequence} · rev ${segment.revision} · timeline ${segment.timelineRevision}`;
  text.textContent =
    displayMode === "translation_only" ? translationOnlyText(segment).text : segment.text;
  meta.textContent = `samples ${segment.meetingSampleStart}–${segment.meetingSampleEnd}`;
  item.append(heading, text, meta);
  return item;
}

function render(snapshot: MvpSnapshot): void {
  const displayMode = currentDisplayMode();
  state.textContent = snapshot.lifecycle.toUpperCase();
  state.dataset.state = snapshot.lifecycle;
  elapsed.textContent = formatElapsed(snapshot.elapsedMs);
  count.textContent = `${snapshot.savedFinalCount}/${snapshot.totalFinalCount}`;
  interimTitle.textContent = displayMode === "translation_only" ? "译文状态" : "正在识别";
  interim.textContent =
    displayMode === "translation_only"
      ? "临时句尚无译文；等待确认并完成翻译。"
      : snapshot.interim === null
        ? "等待实时字幕…"
        : `${snapshot.interim.text} · rev ${snapshot.interim.revision} · timeline ${snapshot.interim.timelineRevision}`;
  finals.replaceChildren(
    ...snapshot.finals.slice(-5).map((segment) => renderSegment(segment, displayMode)),
  );
  errorLine.textContent = snapshot.error === null ? "" : snapshot.error;
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
void refreshWhenVisible();
window.setInterval(() => void refreshWhenVisible(), 750);
