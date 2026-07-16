import { invoke } from "@tauri-apps/api/core";

import {
  formatElapsed,
  parseMvpSnapshot,
  type AudioSourceSnapshot,
  type MvpSnapshot,
} from "./mvp-contract";
import "./styles.css";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("MeetingRelay app root is missing.");

app.innerHTML = `
  <main class="relay-shell">
    <header class="masthead">
      <div>
        <p class="kicker">LOCAL TRANSCRIPTION CONSOLE / MVP</p>
        <h1>Meeting<span>Relay</span></h1>
      </div>
      <div class="privacy-stamp" aria-label="Privacy mode">
        <span class="privacy-dot"></span>
        本地处理 · 临时会话
      </div>
    </header>

    <section class="workspace">
      <aside class="control-rail" aria-label="Session controls">
        <div class="rail-index">01 / INPUT</div>
        <h2>声音源</h2>
        <div id="source-system" class="source-card" data-status="booting">
          <div class="source-heading">
            <span class="source-glyph">SYS</span>
            <div><strong>电脑播放声音</strong><small id="system-label">正在检测默认输出…</small></div>
          </div>
          <div class="level-track"><i id="system-level"></i></div>
          <div class="source-meta"><span id="system-status">检测中</span><span id="system-frames">0 frames</span></div>
        </div>
        <div id="source-microphone" class="source-card" data-status="booting">
          <div class="source-heading">
            <span class="source-glyph">MIC</span>
            <div><strong>默认麦克风</strong><small id="microphone-label">正在检测默认输入…</small></div>
          </div>
          <div class="level-track"><i id="microphone-level"></i></div>
          <div class="source-meta"><span id="microphone-status">检测中</span><span id="microphone-frames">0 frames</span></div>
        </div>

        <div class="model-line">
          <span>ASR ENGINE</span>
          <strong id="model-status">正在校验本地模型…</strong>
        </div>

        <label class="consent-row">
          <input id="consent" type="checkbox" />
          <span>我确认本次会议允许录音转写</span>
        </label>

        <div class="session-actions">
          <button id="start" class="start-button" type="button" disabled>
            <span class="record-mark"></span>开始实时转写
          </button>
          <button id="stop" class="stop-button" type="button" disabled>停止并完成当前片段</button>
        </div>
        <p id="error" class="error-line" role="alert"></p>
      </aside>

      <section class="transcript-stage" aria-labelledby="transcript-title">
        <div class="stage-heading">
          <div>
            <div class="rail-index">02 / LIVE TRANSCRIPT</div>
            <h2 id="transcript-title">实时文字</h2>
          </div>
          <div class="session-clock"><span id="lifecycle">BOOTING</span><strong id="elapsed">00:00:00</strong></div>
        </div>
        <div id="empty-state" class="empty-state">
          <div class="signal-art" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>
          <p>声音就绪后，点击开始。文字仅保存在本次运行的内存中。</p>
        </div>
        <ol id="transcript" class="transcript-list" aria-live="polite"></ol>
        <div id="interim" class="interim-line" hidden><span>LIVE</span><p></p></div>
        <footer class="stage-footer">
          <span>队列 <strong id="queue-depth">0 / 8</strong></span>
          <span>固定语言 <strong>中文 · ZH</strong></span>
          <span>保存 <strong>关闭</strong></span>
        </footer>
      </section>
    </section>
  </main>
`;

function element<T extends Element>(selector: string): T {
  const value = document.querySelector<T>(selector);
  if (!value) throw new Error(`Required control is missing: ${selector}`);
  return value;
}

const controls = {
  consent: element<HTMLInputElement>("#consent"),
  start: element<HTMLButtonElement>("#start"),
  stop: element<HTMLButtonElement>("#stop"),
  error: element<HTMLParagraphElement>("#error"),
  lifecycle: element<HTMLSpanElement>("#lifecycle"),
  elapsed: element<HTMLElement>("#elapsed"),
  model: element<HTMLElement>("#model-status"),
  empty: element<HTMLElement>("#empty-state"),
  transcript: element<HTMLOListElement>("#transcript"),
  interim: element<HTMLElement>("#interim"),
  interimText: element<HTMLParagraphElement>("#interim p"),
  queue: element<HTMLElement>("#queue-depth"),
};

let latest: MvpSnapshot | null = null;
let pollTimer: number | null = null;

function message(error: unknown): string {
  const text = error instanceof Error ? error.message : typeof error === "string" ? error : "未知错误";
  return text.trim().replace(/\s+/g, " ").slice(0, 220) || "未知错误";
}

function renderSource(source: AudioSourceSnapshot): void {
  const card = element<HTMLElement>(`#source-${source.id}`);
  card.dataset.status = source.status;
  element<HTMLElement>(`#${source.id}-label`).textContent = source.label || "未找到设备";
  element<HTMLElement>(`#${source.id}-status`).textContent =
    source.status === "capturing" ? "采集中" : source.status === "ready" ? "已就绪" : source.status === "degraded" ? "降级" : "异常";
  element<HTMLElement>(`#${source.id}-frames`).textContent = `${source.frames} frames`;
  element<HTMLElement>(`#${source.id}-level`).style.transform = `scaleX(${source.peak})`;
}

function render(snapshot: MvpSnapshot): void {
  latest = snapshot;
  const active = ["starting", "recording", "stopping"].includes(snapshot.lifecycle);
  const ready = snapshot.lifecycle === "ready" && snapshot.modelReady && snapshot.system.ready && snapshot.microphone.ready;
  controls.lifecycle.textContent = snapshot.lifecycle.toUpperCase();
  controls.lifecycle.dataset.state = snapshot.lifecycle;
  controls.elapsed.textContent = formatElapsed(snapshot.elapsedMs);
  controls.model.textContent = snapshot.modelReady ? snapshot.modelLabel : `不可用 · ${snapshot.modelLabel}`;
  controls.model.dataset.ready = String(snapshot.modelReady);
  controls.start.disabled = !ready || !controls.consent.checked;
  controls.stop.disabled = !active;
  controls.consent.disabled = active;
  controls.queue.textContent = `${snapshot.queueDepth} / 8`;
  controls.error.textContent = snapshot.error ?? snapshot.system.error ?? snapshot.microphone.error ?? "";
  renderSource(snapshot.system);
  renderSource(snapshot.microphone);

  controls.transcript.replaceChildren(
    ...snapshot.finals.map((segment, index) => {
      const item = document.createElement("li");
      item.innerHTML = `<time>${String(index + 1).padStart(2, "0")}</time><p></p>`;
      item.querySelector("p")!.textContent = segment.text;
      return item;
    }),
  );
  controls.empty.hidden = snapshot.finals.length > 0 || snapshot.interim !== null || active;
  controls.interim.hidden = snapshot.interim === null;
  controls.interimText.textContent = snapshot.interim?.text ?? "";
}

async function call(command: string, args?: Record<string, unknown>): Promise<MvpSnapshot> {
  return parseMvpSnapshot(await invoke<unknown>(command, args));
}

function schedulePoll(): void {
  if (pollTimer !== null) window.clearTimeout(pollTimer);
  if (!latest || !["starting", "recording", "stopping"].includes(latest.lifecycle)) return;
  pollTimer = window.setTimeout(async () => {
    try {
      render(await call("mvp_snapshot"));
    } catch (error) {
      controls.error.textContent = `状态更新失败：${message(error)}`;
    } finally {
      schedulePoll();
    }
  }, 150);
}

controls.consent.addEventListener("change", () => {
  if (latest) render(latest);
});

controls.start.addEventListener("click", async () => {
  controls.start.disabled = true;
  controls.error.textContent = "";
  try {
    render(await call("mvp_start", { consentAccepted: controls.consent.checked }));
    schedulePoll();
  } catch (error) {
    if (latest) render(latest);
    controls.error.textContent = `无法开始：${message(error)}`;
  }
});

controls.stop.addEventListener("click", async () => {
  controls.stop.disabled = true;
  try {
    render(await call("mvp_stop"));
    schedulePoll();
  } catch (error) {
    controls.error.textContent = `无法停止：${message(error)}`;
  }
});

void (async () => {
  try {
    render(await call("mvp_preflight"));
  } catch (error) {
    controls.lifecycle.textContent = "ERROR";
    controls.lifecycle.dataset.state = "error";
    controls.model.textContent = "本地服务未就绪";
    controls.error.textContent = `预检失败：${message(error)}`;
  }
})();
