import { invoke } from "@tauri-apps/api/core";

import {
  AUDIO_DEVICE_PREFERENCE_KEY,
  formatMvpErrorMessage,
  formatMvpSnapshotError,
  formatElapsed,
  hasAllMvpExportFormats,
  isMvpActiveSession,
  parseMvpTranscriptText,
  parseAudioDeviceInventory,
  parseAudioDevicePreference,
  parseMvpExportResult,
  parseMvpSnapshot,
  resolveAudioDeviceSelection,
  type AudioDeviceInventory,
  type AudioSourceSnapshot,
  type ExportArtifact,
  type MvpExportResult,
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
      <div class="privacy-stamp" aria-label="Privacy and storage mode">
        <span class="privacy-dot"></span>
        本地处理 · SQLite/WAL 持久保存
      </div>
    </header>

    <section class="workspace">
      <aside class="control-rail" aria-label="Session controls">
        <div class="rail-index">01 / INPUT</div>
        <h2>声音源</h2>
        <div class="device-pickers" aria-label="音频设备选择">
          <label class="device-picker">
            <span>系统输出</span>
            <select id="system-device" disabled>
              <option value="">正在读取设备…</option>
            </select>
          </label>
          <label class="device-picker">
            <span>麦克风</span>
            <select id="microphone-device" disabled>
              <option value="">正在读取设备…</option>
            </select>
          </label>
          <p id="device-status" class="device-status" aria-live="polite">正在读取 Windows 音频设备…</p>
        </div>
        <div id="source-system" class="source-card" data-status="booting">
          <div class="source-heading">
            <span class="source-glyph">SYS</span>
            <div><strong>电脑播放声音</strong><small id="system-label">正在检测默认输出</small></div>
          </div>
          <div class="level-track"><i id="system-level"></i></div>
          <div class="source-meta"><span id="system-status">检测中</span><span id="system-frames">0 frames</span></div>
        </div>
        <div id="source-microphone" class="source-card" data-status="booting">
          <div class="source-heading">
            <span class="source-glyph">MIC</span>
            <div><strong>麦克风</strong><small id="microphone-label">正在检测默认输入</small></div>
          </div>
          <div class="level-track"><i id="microphone-level"></i></div>
          <div class="source-meta"><span id="microphone-status">检测中</span><span id="microphone-frames">0 frames</span></div>
        </div>

        <div class="model-line">
          <span>ASR ENGINE</span>
          <strong id="model-status">正在校验本地模型…</strong>
        </div>

        <section class="storage-panel" aria-label="Durable storage">
          <div class="rail-index">02 / STORAGE</div>
          <div class="storage-row">
            <span id="storage-indicator" class="storage-indicator" data-status="initializing"></span>
            <div>
              <strong id="storage-status">初始化本地持久化</strong>
              <small id="storage-detail">final 片段只在 SQLite 提交成功后显示为已保存。</small>
            </div>
          </div>
          <dl class="storage-metrics">
            <div><dt>已保存</dt><dd id="saved-count">0</dd></div>
            <div><dt>可见窗口</dt><dd id="visible-window">0 / 0</dd></div>
            <div><dt>会议</dt><dd id="meeting-id">未打开</dd></div>
          </dl>
        </section>

        <label class="consent-row">
          <input id="consent" type="checkbox" />
          <span>我确认本次会议允许录音转写，并同意转写文本以 SQLite/WAL 形式保存在本机应用数据目录。</span>
        </label>

        <div class="session-actions">
          <button id="start" class="start-button" type="button" disabled>
            <span class="record-mark"></span>开始实时转写
          </button>
          <button id="pause-resume" class="pause-button" type="button" disabled>暂停转写</button>
          <button id="stop" class="stop-button" type="button" disabled>停止并完成当前会议</button>
        </div>
        <p id="error" class="error-line" role="alert"></p>

        <section class="history-panel" aria-label="Recent meetings">
          <div class="rail-index">03 / RECENT</div>
          <button id="open-recent" class="secondary-button" type="button" disabled>重新打开最近会议</button>
          <p id="recent-summary" class="recent-summary">暂无已打开会议。</p>
        </section>
      </aside>

      <section class="transcript-stage" aria-labelledby="transcript-title">
        <div class="stage-heading">
          <div>
            <div class="rail-index">04 / LIVE TRANSCRIPT</div>
            <h2 id="transcript-title">实时文字</h2>
          </div>
          <div class="session-clock"><span id="lifecycle">BOOTING</span><strong id="elapsed">00:00:00</strong></div>
        </div>
        <div id="empty-state" class="empty-state">
          <div class="signal-art" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>
          <p>声音就绪后点击开始。interim 只显示在屏幕上；final 必须先提交到本地 SQLite，才会进入已保存列表和导出。</p>
        </div>
        <ol id="transcript" class="transcript-list" aria-live="polite"></ol>
        <div id="interim" class="interim-line" hidden><span>INTERIM</span><p></p></div>
        <section class="export-panel" aria-label="Exports">
          <div class="export-actions">
            <span>导出已保存会议</span>
            <button id="copy-transcript" class="secondary-button" type="button" disabled>复制全部转写</button>
            <button id="export-all" class="secondary-button" type="button" disabled>导出 JSON / Markdown / TXT</button>
          </div>
          <p id="copy-status" class="copy-status" aria-live="polite"></p>
          <textarea id="copy-fallback" class="copy-fallback" readonly hidden aria-label="已准备的转写文本"></textarea>
          <ul id="export-results" class="export-results" aria-live="polite"></ul>
        </section>
        <footer class="stage-footer">
          <span>队列 <strong id="queue-depth">0 / 8</strong></span>
          <span>固定语言 <strong>中文 · ZH</strong></span>
          <span>存储 <strong id="footer-storage">初始化</strong></span>
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
  systemDevice: element<HTMLSelectElement>("#system-device"),
  microphoneDevice: element<HTMLSelectElement>("#microphone-device"),
  deviceStatus: element<HTMLParagraphElement>("#device-status"),
  consent: element<HTMLInputElement>("#consent"),
  start: element<HTMLButtonElement>("#start"),
  pauseResume: element<HTMLButtonElement>("#pause-resume"),
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
  storageIndicator: element<HTMLElement>("#storage-indicator"),
  storageStatus: element<HTMLElement>("#storage-status"),
  storageDetail: element<HTMLElement>("#storage-detail"),
  savedCount: element<HTMLElement>("#saved-count"),
  visibleWindow: element<HTMLElement>("#visible-window"),
  meetingId: element<HTMLElement>("#meeting-id"),
  footerStorage: element<HTMLElement>("#footer-storage"),
  openRecent: element<HTMLButtonElement>("#open-recent"),
  recentSummary: element<HTMLElement>("#recent-summary"),
  copyTranscript: element<HTMLButtonElement>("#copy-transcript"),
  copyStatus: element<HTMLParagraphElement>("#copy-status"),
  copyFallback: element<HTMLTextAreaElement>("#copy-fallback"),
  exportAll: element<HTMLButtonElement>("#export-all"),
  exportResults: element<HTMLUListElement>("#export-results"),
};

let latest: MvpSnapshot | null = null;
let lastExport: MvpExportResult | null = null;
let pollTimer: number | null = null;
let audioDevices: AudioDeviceInventory | null = null;
let audioDeviceLoadError: string | null = null;
let lastClipboardText: string | null = null;
const MVP_EXPORT_TARGET_DIR = "MeetingRelayExports";

function message(error: unknown): string {
  return formatMvpErrorMessage(error);
}

function isActive(snapshot: MvpSnapshot): boolean {
  return isMvpActiveSession(snapshot);
}

function currentAudioDeviceSelection(): {
  systemOutputDeviceId: string;
  microphoneDeviceId: string;
} | null {
  if (
    audioDevices === null ||
    !audioDevices.systemOutputs.some(
      (device) => device.deviceId === controls.systemDevice.value,
    ) ||
    !audioDevices.microphones.some(
      (device) => device.deviceId === controls.microphoneDevice.value,
    )
  ) {
    return null;
  }
  return {
    systemOutputDeviceId: controls.systemDevice.value,
    microphoneDeviceId: controls.microphoneDevice.value,
  };
}

function populateDeviceSelect(
  select: HTMLSelectElement,
  devices: AudioDeviceInventory["systemOutputs"],
  selectedDeviceId: string | null,
  stale: boolean,
): void {
  const options = devices.map((device) => {
    const option = document.createElement("option");
    option.value = device.deviceId;
    option.textContent = `${device.name}${device.isDefault ? "（系统默认）" : ""}`;
    return option;
  });
  if (stale && selectedDeviceId !== null) {
    const unavailable = document.createElement("option");
    unavailable.value = selectedDeviceId;
    unavailable.textContent = "上次选择的设备已不可用（请重新选择）";
    unavailable.disabled = true;
    options.unshift(unavailable);
  } else if (selectedDeviceId === null) {
    const unavailable = document.createElement("option");
    unavailable.value = "";
    unavailable.textContent = "未找到可用设备";
    unavailable.disabled = true;
    options.unshift(unavailable);
  }
  select.replaceChildren(...options);
  select.value = selectedDeviceId ?? "";
}

function readAudioDevicePreference() {
  try {
    const serialized = window.localStorage.getItem(AUDIO_DEVICE_PREFERENCE_KEY);
    const preference = parseAudioDevicePreference(serialized);
    if (serialized !== null && preference === null) {
      window.localStorage.removeItem(AUDIO_DEVICE_PREFERENCE_KEY);
    }
    return preference;
  } catch {
    return null;
  }
}

function persistAudioDeviceSelection(): void {
  const selection = currentAudioDeviceSelection();
  if (selection === null) return;
  try {
    window.localStorage.setItem(
      AUDIO_DEVICE_PREFERENCE_KEY,
      JSON.stringify({ version: 1, ...selection }),
    );
  } catch {
    // Selection remains valid for this run even if browser storage is unavailable.
  }
}

function renderAudioDeviceControls(active: boolean): void {
  const selection = currentAudioDeviceSelection();
  controls.systemDevice.disabled = active || audioDevices === null || audioDevices.systemOutputs.length === 0;
  controls.microphoneDevice.disabled = active || audioDevices === null || audioDevices.microphones.length === 0;
  if (audioDeviceLoadError !== null) {
    controls.deviceStatus.dataset.status = "error";
    controls.deviceStatus.textContent = `读取设备失败：${audioDeviceLoadError}`;
  } else if (audioDevices === null) {
    controls.deviceStatus.dataset.status = "loading";
    controls.deviceStatus.textContent = "正在读取 Windows 音频设备…";
  } else if (selection === null) {
    controls.deviceStatus.dataset.status = "error";
    controls.deviceStatus.textContent = "请选择当前可用的系统输出和麦克风。";
  } else {
    controls.deviceStatus.dataset.status = "ready";
    controls.deviceStatus.textContent = active
      ? "会议进行中，音频设备已锁定。"
      : "设备已就绪；选择会保存在本机。";
  }
}

async function loadAudioDevices(): Promise<void> {
  const inventory = parseAudioDeviceInventory(await invoke<unknown>("mvp_audio_devices"));
  const selection = resolveAudioDeviceSelection(inventory, readAudioDevicePreference());
  audioDevices = inventory;
  audioDeviceLoadError = null;
  populateDeviceSelect(
    controls.systemDevice,
    inventory.systemOutputs,
    selection.systemOutputDeviceId,
    selection.staleSystemOutput,
  );
  populateDeviceSelect(
    controls.microphoneDevice,
    inventory.microphones,
    selection.microphoneDeviceId,
    selection.staleMicrophone,
  );
  renderAudioDeviceControls(latest !== null && isActive(latest));
}

function canExport(snapshot: MvpSnapshot): boolean {
  return (
    snapshot.meetingId !== null &&
    !isActive(snapshot) &&
    ["ready", "completed", "interrupted"].includes(snapshot.durabilityStatus) &&
    hasAllMvpExportFormats(snapshot.availableExports) &&
    BigInt(snapshot.savedFinalCount) > 0n
  );
}

function canCopyTranscript(snapshot: MvpSnapshot): boolean {
  return (
    snapshot.meetingId !== null &&
    !isActive(snapshot) &&
    ["ready", "completed", "interrupted"].includes(snapshot.durabilityStatus) &&
    BigInt(snapshot.savedFinalCount) > 0n
  );
}

function renderSource(source: AudioSourceSnapshot, paused: boolean): void {
  const card = element<HTMLElement>(`#source-${source.id}`);
  card.dataset.status = paused ? "paused" : source.status;
  element<HTMLElement>(`#${source.id}-label`).textContent = source.label || "未找到设备";
  element<HTMLElement>(`#${source.id}-status`).textContent =
    paused
      ? "已暂停"
      : source.status === "capturing"
      ? "采集中"
      : source.status === "ready"
        ? "已就绪"
        : source.status === "degraded"
          ? "降级"
          : "异常";
  element<HTMLElement>(`#${source.id}-frames`).textContent = `${source.frames} frames`;
  element<HTMLElement>(`#${source.id}-level`).style.transform = `scaleX(${source.peak})`;
}

function renderRecent(snapshot: MvpSnapshot): void {
  controls.openRecent.disabled = snapshot.latestOpenedMeeting === null || isActive(snapshot);
  controls.recentSummary.textContent =
    snapshot.latestOpenedMeeting === null
      ? "暂无已打开会议。"
      : `最近会议：${snapshot.latestOpenedMeeting}`;
}

function renderExportArtifact(result: ExportArtifact): HTMLLIElement {
  const item = document.createElement("li");
  item.dataset.status = "saved";
  const label = document.createElement("strong");
  const detail = document.createElement("span");
  label.textContent = result.format.toUpperCase();
  detail.textContent = `${result.path} · ${result.byteLength} bytes`;
  item.append(label, detail);
  return item;
}

function renderExports(snapshot: MvpSnapshot): void {
  controls.copyTranscript.disabled = !canCopyTranscript(snapshot);
  if (!canCopyTranscript(snapshot)) {
    lastClipboardText = null;
    controls.copyFallback.value = "";
    controls.copyFallback.hidden = true;
  }
  controls.exportAll.disabled = !canExport(snapshot);
  controls.exportResults.replaceChildren(
    ...(lastExport?.artifacts.map(renderExportArtifact) ?? []),
  );
}

async function writeClipboardText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText === undefined) {
    throw new Error("当前窗口无法访问剪贴板 API");
  }
  await navigator.clipboard.writeText(text);
}

function render(snapshot: MvpSnapshot): void {
  latest = snapshot;
  const active = isActive(snapshot);
  const paused = snapshot.lifecycle === "paused";
  const ready =
    snapshot.lifecycle === "ready" &&
    snapshot.modelReady &&
    snapshot.system.ready &&
    snapshot.microphone.ready &&
    ["ready", "completed", "interrupted"].includes(snapshot.durabilityStatus);
  controls.lifecycle.textContent = snapshot.lifecycle.toUpperCase();
  controls.lifecycle.dataset.state = snapshot.lifecycle;
  controls.elapsed.textContent = formatElapsed(snapshot.elapsedMs);
  controls.model.textContent = snapshot.modelReady
    ? snapshot.modelLabel
    : `不可用 · ${snapshot.modelLabel}`;
  controls.model.dataset.ready = String(snapshot.modelReady);
  controls.start.disabled =
    !ready || !controls.consent.checked || currentAudioDeviceSelection() === null;
  controls.pauseResume.disabled = !["recording", "paused"].includes(snapshot.lifecycle);
  controls.pauseResume.textContent = paused ? "继续转写" : "暂停转写";
  controls.pauseResume.dataset.state =
    paused ? "paused" : snapshot.lifecycle === "recording" ? "recording" : "idle";
  controls.stop.disabled = !active;
  controls.consent.disabled = active;
  renderAudioDeviceControls(active);
  controls.queue.textContent = `${snapshot.queueDepth} / 8`;
  controls.error.textContent = formatMvpSnapshotError(snapshot);
  controls.storageIndicator.dataset.status =
    snapshot.durabilityStatus === "error"
      ? "error"
      : snapshot.durabilityStatus === "initializing"
        ? "initializing"
        : snapshot.durabilityStatus === "paused"
          ? "paused"
          : "ready";
  controls.storageStatus.textContent =
    snapshot.durabilityStatus === "error"
      ? "本地持久化异常"
      : snapshot.durabilityStatus === "initializing"
        ? "初始化本地持久化"
        : snapshot.durabilityStatus === "recording"
          ? "本地持久化写入中"
          : snapshot.durabilityStatus === "paused"
            ? "本地持久化已暂停"
            : snapshot.durabilityStatus === "completed"
              ? "会议已完成并持久保存"
              : snapshot.durabilityStatus === "interrupted"
                ? "已恢复中断会议"
                : "本地持久化正常";
  controls.storageDetail.textContent =
    snapshot.durabilityStatus === "paused"
      ? "SQLite/WAL · 暂停期间音频不进入转写，已提交 final 保持可恢复"
      : "SQLite/WAL · final 仅在 commit ACK 或 DB reopen 后标为已保存";
  controls.savedCount.textContent = snapshot.savedFinalCount;
  controls.visibleWindow.textContent = `${snapshot.finals.length} / ${snapshot.totalFinalCount}`;
  controls.meetingId.textContent = snapshot.meetingId ?? "未打开";
  controls.footerStorage.textContent =
    snapshot.durabilityStatus === "error"
      ? "异常"
      : snapshot.durabilityStatus === "initializing"
        ? "初始化"
        : snapshot.durabilityStatus === "paused"
          ? "已暂停"
          : "SQLite 已开启";
  renderSource(snapshot.system, paused);
  renderSource(snapshot.microphone, paused);

  controls.transcript.replaceChildren(
    ...snapshot.finals.map((segment) => {
      const item = document.createElement("li");
      const order = document.createElement("time");
      const body = document.createElement("p");
      const badge = document.createElement("span");
      item.className = "saved-final";
      order.textContent = segment.sequence?.padStart(2, "0") ?? "??";
      body.textContent = segment.text;
      badge.className = "saved-badge";
      badge.textContent = "已保存";
      item.append(order, body, badge);
      return item;
    }),
  );
  controls.empty.hidden = snapshot.finals.length > 0 || snapshot.interim !== null || active;
  controls.interim.hidden = snapshot.interim === null;
  controls.interimText.textContent = snapshot.interim?.text ?? "";
  renderRecent(snapshot);
  renderExports(snapshot);
}

async function call(command: string, args?: Record<string, unknown>): Promise<MvpSnapshot> {
  return parseMvpSnapshot(await invoke<unknown>(command, args));
}

async function openRecentMeeting(): Promise<void> {
  render(await call("mvp_open_recent"));
}

async function exportMeeting(): Promise<void> {
  const meetingId = latest?.meetingId;
  if (meetingId === null || meetingId === undefined) {
    throw new Error("MVP_EXPORT_MEETING_MISSING");
  }
  lastExport = parseMvpExportResult(
    await invoke<unknown>("mvp_export_meeting", {
      meetingId,
      targetDir: MVP_EXPORT_TARGET_DIR,
    }),
  );
  if (latest) render(latest);
}

async function transcriptTextForMeeting(meetingId: string): Promise<string> {
  return parseMvpTranscriptText(
    await invoke<unknown>("mvp_transcript_text", {
      meetingId,
    }),
  );
}

function schedulePoll(): void {
  if (pollTimer !== null) window.clearTimeout(pollTimer);
  if (!latest || !isActive(latest)) return;
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

for (const select of [controls.systemDevice, controls.microphoneDevice]) {
  select.addEventListener("change", () => {
    persistAudioDeviceSelection();
    if (latest) {
      render(latest);
    } else {
      renderAudioDeviceControls(false);
    }
  });
}

controls.start.addEventListener("click", async () => {
  controls.start.disabled = true;
  controls.error.textContent = "";
  lastExport = null;
  lastClipboardText = null;
  controls.copyStatus.textContent = "";
  controls.copyFallback.value = "";
  controls.copyFallback.hidden = true;
  try {
    const selection = currentAudioDeviceSelection();
    if (selection === null) throw new Error("请选择当前可用的系统输出和麦克风");
    persistAudioDeviceSelection();
    render(
      await call("mvp_start", {
        consentAccepted: controls.consent.checked,
        ...selection,
      }),
    );
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

controls.pauseResume.addEventListener("click", async () => {
  const snapshot = latest;
  if (snapshot === null || !["recording", "paused"].includes(snapshot.lifecycle)) return;
  controls.pauseResume.disabled = true;
  try {
    render(await call(snapshot.lifecycle === "paused" ? "mvp_resume" : "mvp_pause"));
    schedulePoll();
  } catch (error) {
    controls.pauseResume.disabled =
      latest === null || !["recording", "paused"].includes(latest.lifecycle);
    controls.error.textContent =
      snapshot.lifecycle === "paused"
        ? `无法继续转写：${message(error)}`
        : `无法暂停转写：${message(error)}`;
  }
});

controls.openRecent.addEventListener("click", async () => {
  controls.openRecent.disabled = true;
  lastExport = null;
  lastClipboardText = null;
  controls.copyStatus.textContent = "";
  controls.copyFallback.value = "";
  controls.copyFallback.hidden = true;
  try {
    await openRecentMeeting();
  } catch (error) {
    controls.error.textContent = `无法重新打开最近会议：${message(error)}`;
  } finally {
    if (latest) render(latest);
  }
});

controls.exportAll.addEventListener("click", async () => {
  controls.exportAll.disabled = true;
  try {
    await exportMeeting();
  } catch (error) {
    controls.error.textContent = `导出三种格式失败：${message(error)}`;
    if (latest) render(latest);
  }
});

controls.copyTranscript.addEventListener("click", async () => {
  const snapshot = latest;
  if (snapshot === null || !canCopyTranscript(snapshot)) return;
  const meetingId = snapshot.meetingId;
  if (meetingId === null) return;
  controls.copyTranscript.disabled = true;
  controls.copyStatus.dataset.status = "loading";
  controls.copyStatus.textContent = "正在准备完整转写文本...";
  controls.copyFallback.value = "";
  controls.copyFallback.hidden = true;
  try {
    lastClipboardText = await transcriptTextForMeeting(meetingId);
  } catch (error) {
    lastClipboardText = null;
    controls.copyStatus.dataset.status = "error";
    controls.copyStatus.textContent = `无法读取完整转写文本：${message(error)}`;
    controls.error.textContent = "复制失败：无法从本地数据库读取完整转写文本。";
    controls.copyTranscript.disabled = latest === null || !canCopyTranscript(latest);
    return;
  }
  controls.copyStatus.textContent = "正在写入剪贴板...";
  try {
    await writeClipboardText(lastClipboardText);
    controls.copyStatus.dataset.status = "success";
    controls.copyStatus.textContent = "已复制全部转写文本。";
  } catch (error) {
    controls.copyFallback.value = lastClipboardText;
    controls.copyFallback.hidden = false;
    controls.copyFallback.select();
    controls.copyStatus.dataset.status = "error";
    controls.copyStatus.textContent = `剪贴板写入失败：${message(error)}。完整文本已保留在下方。`;
    controls.error.textContent = "复制失败：完整转写文本已保留，可手动复制。";
  } finally {
    controls.copyTranscript.disabled = latest === null || !canCopyTranscript(latest);
  }
});

void (async () => {
  try {
    await loadAudioDevices();
  } catch (error) {
    audioDeviceLoadError = message(error);
    renderAudioDeviceControls(false);
  }
  try {
    render(await call("mvp_preflight"));
  } catch (error) {
    controls.lifecycle.textContent = "ERROR";
    controls.lifecycle.dataset.state = "error";
    controls.model.textContent = "本地服务未就绪";
    controls.error.textContent = `预检失败：${message(error)}`;
  }
})();
