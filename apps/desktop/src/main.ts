import { invoke } from "@tauri-apps/api/core";

import {
  AUDIO_DEVICE_PREFERENCE_KEY,
  TRANSLATION_PREFERENCE_KEY,
  formatMvpErrorMessage,
  formatMvpSnapshotError,
  formatElapsed,
  hasCompleteMvpTranscript,
  hasAllMvpExportFormats,
  isMvpActiveSession,
  parseMvpTranscriptText,
  parseAudioDeviceInventory,
  parseAudioDevicePreference,
  parseMvpExportResult,
  parseMvpRecognitionLanguage,
  parseMvpSnapshot,
  parseTranslationPreference,
  parseTranslationProbe,
  requiresInsecureRemoteHttpAcknowledgement,
  resolveAudioDeviceSelection,
  type AudioDeviceInventory,
  type AudioSourceSnapshot,
  type ExportArtifact,
  type MvpExportResult,
  type MvpRecognitionLanguage,
  type MvpSnapshot,
  type TranscriptSegment,
  type TranslationConfig,
  type TranslationPreference,
} from "./mvp-contract";
import { planTranscriptReconciliation } from "./transcript-render";
import "./styles.css";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("MeetingRelay app root is missing.");

app.innerHTML = `
  <main class="relay-shell">
    <header class="masthead">
      <div class="brand-lockup">
        <p class="kicker">PRIVATE MEETING CAPTURE / WINDOWS</p>
        <h1>Meeting<span>Relay</span></h1>
      </div>
      <div class="privacy-stamp" aria-label="Privacy and storage mode">
        <span class="privacy-dot"></span>
        <span><strong>本地识别</strong>音频与记录留在此电脑；启用云端翻译时，仅 final 原文发往所选服务</span>
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
          <label class="device-picker language-picker">
            <span>本次识别语言</span>
            <select id="recognition-language" disabled>
              <option value="zh">中文 · ZH</option>
              <option value="ja">日本語 · JA</option>
              <option value="en">English · EN</option>
            </select>
            <small>会议开始后锁定；下一次会议可重新选择。</small>
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

        <section class="translation-panel" aria-label="OpenAI-compatible translation">
          <div class="translation-heading">
            <div>
              <div class="rail-index">02 / TRANSLATION</div>
              <strong>OpenAI-compatible 翻译</strong>
            </div>
            <label class="translation-toggle">
              <input id="translation-enabled" type="checkbox" />
              <span>启用</span>
            </label>
          </div>
          <div class="translation-grid">
            <label class="device-picker">
              <span>服务预设</span>
              <select id="translation-provider">
                <option value="ollama">Ollama</option>
                <option value="lmstudio">LM Studio</option>
                <option value="openai">OpenAI</option>
                <option value="deepseek">DeepSeek</option>
                <option value="openrouter">OpenRouter</option>
                <option value="xai">xAI</option>
                <option value="dashscope">阿里云百炼 / DashScope</option>
                <option value="custom">其他兼容服务</option>
              </select>
            </label>
            <label class="device-picker">
              <span>译文语言</span>
              <select id="translation-language">
                <option value="zh">中文 · ZH</option>
                <option value="ja">日本語 · JA</option>
                <option value="en">English · EN</option>
              </select>
            </label>
          </div>
          <label class="device-picker">
            <span>OpenAI-compatible Base URL</span>
            <input id="translation-base-url" type="url" value="http://127.0.0.1:11434/v1" spellcheck="false" />
          </label>
          <label class="device-picker">
            <span>模型名称</span>
            <input id="translation-model" type="text" placeholder="填写供应商提供的模型 ID" spellcheck="false" />
          </label>
          <label class="device-picker translation-api-key">
            <span>API Token（多数云服务必填，不保存）</span>
            <input id="translation-api-key" type="password" autocomplete="off" spellcheck="false" />
          </label>
          <label id="translation-insecure-http-row" class="translation-insecure-http" hidden>
            <input id="translation-allow-insecure-http" type="checkbox" />
            <span>
              <strong>允许不安全的远程 HTTP</strong>
              <small>API Token 和 final 原文将以明文传输，可能被网络中的第三方读取或篡改。</small>
            </span>
          </label>
          <div class="translation-actions">
            <button id="test-translation" class="secondary-button" type="button">测试连接</button>
            <p id="translation-status" aria-live="polite">关闭；原文照常保存。</p>
          </div>
          <small class="translation-privacy">本机回环地址可直接使用 HTTP；远程 HTTP 必须显式确认风险，仍建议优先配置 HTTPS。API Token 不保存。</small>
        </section>

        <section class="storage-panel" aria-label="Durable storage">
          <div class="rail-index">03 / STORAGE</div>
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
          <span>我确认本次会议允许录音转写，并同意原文与可用译文保存在本机；启用翻译时，final 原文会发送给所选服务，其中第三方云端服务受其隐私与计费规则约束。</span>
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
          <div class="rail-index">04 / RECENT</div>
          <button id="open-recent" class="secondary-button" type="button" disabled>重新打开最近会议</button>
          <p id="recent-summary" class="recent-summary">暂无已打开会议。</p>
        </section>
      </aside>

      <section class="transcript-stage" aria-labelledby="transcript-title">
        <div class="stage-heading">
          <div class="stage-copy">
            <div class="rail-index">05 / LIVE TRANSCRIPT</div>
            <h2 id="transcript-title">实时文字</h2>
            <p>原文先持久保存；若启用翻译，译文随后对齐显示，失败不会影响原文。</p>
          </div>
          <div class="session-clock">
            <span id="lifecycle">BOOTING</span>
            <strong id="elapsed">00:00:00</strong>
          </div>
        </div>
        <div class="transcript-viewport">
          <div id="empty-state" class="empty-state">
            <div class="signal-art" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>
            <strong>等待会议声音</strong>
            <p>确认设备和识别语言后开始。只有成功写入本地 SQLite 的 final 内容才会进入记录。</p>
          </div>
          <ol id="transcript" class="transcript-list" aria-label="已保存的实时转写"></ol>
          <p id="transcript-announcer" class="sr-only" aria-live="polite" aria-atomic="true"></p>
          <div id="interim" class="interim-line" hidden>
            <span>正在识别</span>
            <p></p>
          </div>
        </div>
        <section class="export-panel" aria-label="Exports">
          <div class="export-actions">
            <span>会议完成后可用</span>
            <button id="copy-transcript" class="secondary-button" type="button" disabled>复制全部转写</button>
            <button id="export-all" class="secondary-button" type="button" disabled>导出 JSON / Markdown / TXT</button>
          </div>
          <p id="copy-status" class="copy-status" aria-live="polite"></p>
          <textarea id="copy-fallback" class="copy-fallback" readonly hidden aria-label="已准备的转写文本"></textarea>
          <ul id="export-results" class="export-results" aria-live="polite"></ul>
        </section>
        <footer class="stage-footer">
          <span>队列 <strong id="queue-depth">0 / 8</strong></span>
          <span>翻译 <strong id="translation-queue-depth">关闭</strong></span>
          <span>识别语言 <strong id="footer-language">中文 · ZH</strong></span>
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
  recognitionLanguage: element<HTMLSelectElement>("#recognition-language"),
  translationEnabled: element<HTMLInputElement>("#translation-enabled"),
  translationProvider: element<HTMLSelectElement>("#translation-provider"),
  translationLanguage: element<HTMLSelectElement>("#translation-language"),
  translationBaseUrl: element<HTMLInputElement>("#translation-base-url"),
  translationModel: element<HTMLInputElement>("#translation-model"),
  translationApiKey: element<HTMLInputElement>("#translation-api-key"),
  translationAllowInsecureHttp: element<HTMLInputElement>(
    "#translation-allow-insecure-http",
  ),
  translationInsecureHttpRow: element<HTMLElement>("#translation-insecure-http-row"),
  testTranslation: element<HTMLButtonElement>("#test-translation"),
  translationStatus: element<HTMLParagraphElement>("#translation-status"),
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
  transcriptAnnouncer: element<HTMLParagraphElement>("#transcript-announcer"),
  interim: element<HTMLElement>("#interim"),
  interimText: element<HTMLParagraphElement>("#interim p"),
  queue: element<HTMLElement>("#queue-depth"),
  translationQueue: element<HTMLElement>("#translation-queue-depth"),
  storageIndicator: element<HTMLElement>("#storage-indicator"),
  storageStatus: element<HTMLElement>("#storage-status"),
  storageDetail: element<HTMLElement>("#storage-detail"),
  savedCount: element<HTMLElement>("#saved-count"),
  visibleWindow: element<HTMLElement>("#visible-window"),
  meetingId: element<HTMLElement>("#meeting-id"),
  footerStorage: element<HTMLElement>("#footer-storage"),
  footerLanguage: element<HTMLElement>("#footer-language"),
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
let preparedLanguage: MvpRecognitionLanguage = "zh";
let languagePreparing = false;
let translationTesting = false;
let lastClipboardText: string | null = null;
const MVP_EXPORT_TARGET_DIR = "MeetingRelayExports";

function message(error: unknown): string {
  return formatMvpErrorMessage(error);
}

function isActive(snapshot: MvpSnapshot): boolean {
  return isMvpActiveSession(snapshot);
}

const LANGUAGE_LABELS: Record<MvpRecognitionLanguage, string> = {
  zh: "中文 · ZH",
  ja: "日本語 · JA",
  en: "English · EN",
};

const TRANSLATION_PROVIDER_URLS = {
  ollama: "http://127.0.0.1:11434/v1",
  lmstudio: "http://127.0.0.1:1234/v1",
  openai: "https://api.openai.com/v1",
  deepseek: "https://api.deepseek.com",
  openrouter: "https://openrouter.ai/api/v1",
  xai: "https://api.x.ai/v1",
  dashscope: "https://dashscope.aliyuncs.com/compatible-mode/v1",
} as const;

function currentRecognitionLanguage(): MvpRecognitionLanguage {
  return parseMvpRecognitionLanguage(controls.recognitionLanguage.value);
}

function currentTranslationConfig(): TranslationConfig {
  return {
    enabled: controls.translationEnabled.checked,
    baseUrl: controls.translationBaseUrl.value.trim(),
    model: controls.translationModel.value.trim(),
    apiKey: controls.translationApiKey.value.trim() || null,
    targetLanguage: parseMvpRecognitionLanguage(controls.translationLanguage.value),
    allowInsecureHttp: controls.translationAllowInsecureHttp.checked,
  };
}

function translationConfigReady(): boolean {
  const config = currentTranslationConfig();
  const insecureHttpAcknowledged =
    !requiresInsecureRemoteHttpAcknowledgement(config.baseUrl) || config.allowInsecureHttp;
  return (
    !config.enabled ||
    (config.baseUrl.length > 0 && config.model.length > 0 && insecureHttpAcknowledged)
  );
}

function readTranslationPreference(): TranslationPreference | null {
  try {
    const serialized = window.localStorage.getItem(TRANSLATION_PREFERENCE_KEY);
    const preference = parseTranslationPreference(serialized);
    if (serialized !== null && preference === null) {
      window.localStorage.removeItem(TRANSLATION_PREFERENCE_KEY);
    }
    return preference;
  } catch {
    return null;
  }
}

function persistTranslationPreference(): void {
  const config = currentTranslationConfig();
  if (config.baseUrl.length === 0 || config.model.length === 0) return;
  try {
    window.localStorage.setItem(
      TRANSLATION_PREFERENCE_KEY,
      JSON.stringify({
        version: 1,
        enabled: config.enabled,
        baseUrl: config.baseUrl,
        model: config.model,
        targetLanguage: config.targetLanguage,
        allowInsecureHttp: config.allowInsecureHttp,
      }),
    );
  } catch {
    // Non-secret settings remain valid for this run when local storage is unavailable.
  }
}

function applyTranslationPreference(preference: TranslationPreference | null): void {
  if (preference === null) return;
  controls.translationEnabled.checked = preference.enabled;
  controls.translationBaseUrl.value = preference.baseUrl;
  controls.translationModel.value = preference.model;
  controls.translationLanguage.value = preference.targetLanguage;
  controls.translationAllowInsecureHttp.checked = preference.allowInsecureHttp;
  const provider = Object.entries(TRANSLATION_PROVIDER_URLS).find(
    ([, url]) => url === preference.baseUrl,
  )?.[0];
  controls.translationProvider.value = provider ?? "custom";
}

function renderTranslationControls(active: boolean): void {
  const config = currentTranslationConfig();
  const requiresInsecureHttp = requiresInsecureRemoteHttpAcknowledgement(config.baseUrl);
  controls.translationQueue.textContent = config.enabled
    ? `${latest?.translationQueueDepth ?? 0} / 32`
    : "关闭";
  const locked = active || translationTesting;
  controls.translationEnabled.disabled = active;
  controls.translationProvider.disabled = locked || !config.enabled;
  controls.translationLanguage.disabled = locked || !config.enabled;
  controls.translationBaseUrl.disabled = locked || !config.enabled;
  controls.translationModel.disabled = locked || !config.enabled;
  controls.translationApiKey.disabled = locked || !config.enabled;
  controls.translationInsecureHttpRow.hidden = !config.enabled || !requiresInsecureHttp;
  controls.translationAllowInsecureHttp.disabled =
    locked || !config.enabled || !requiresInsecureHttp;
  controls.testTranslation.disabled =
    locked || !config.enabled || !translationConfigReady();
  if (!config.enabled) {
    controls.translationStatus.dataset.status = "idle";
    controls.translationStatus.textContent = "关闭；原文照常保存。";
  } else if (config.targetLanguage === currentRecognitionLanguage()) {
    controls.translationStatus.dataset.status = "skipped";
    controls.translationStatus.textContent = "译文语言与识别语言相同，本次将跳过模型请求。";
  } else if (!translationConfigReady()) {
    controls.translationStatus.dataset.status = "error";
    controls.translationStatus.textContent =
      requiresInsecureHttp && !config.allowInsecureHttp
        ? "远程 HTTP 会明文传输 Token 和会议文字；请勾选风险确认，或改用 HTTPS。"
        : "请填写 Base URL 和模型名称。";
  } else if (active) {
    controls.translationStatus.dataset.status = requiresInsecureHttp ? "warning" : "ready";
    controls.translationStatus.textContent = requiresInsecureHttp
      ? "会议进行中，已允许远程明文 HTTP；Token 和 final 原文可能被读取或篡改。"
      : "会议进行中，翻译配置已锁定。";
  } else if (
    !translationTesting &&
    !["success", "error"].includes(controls.translationStatus.dataset.status ?? "")
  ) {
    controls.translationStatus.dataset.status = requiresInsecureHttp ? "warning" : "ready";
    controls.translationStatus.textContent = requiresInsecureHttp
      ? "已允许远程明文 HTTP；Token 和 final 原文可能被读取或篡改。"
      : "配置已就绪；建议开始前测试连接。";
  }
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
    hasCompleteMvpTranscript(snapshot) &&
    snapshot.translationQueueDepth === 0 &&
    ["ready", "completed", "interrupted"].includes(snapshot.durabilityStatus) &&
    hasAllMvpExportFormats(snapshot.availableExports) &&
    BigInt(snapshot.savedFinalCount) > 0n
  );
}

function canCopyTranscript(snapshot: MvpSnapshot): boolean {
  return (
    snapshot.meetingId !== null &&
    !isActive(snapshot) &&
    hasCompleteMvpTranscript(snapshot) &&
    snapshot.translationQueueDepth === 0 &&
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

function transcriptRow(key: string): HTMLLIElement {
  const item = document.createElement("li");
  const order = document.createElement("span");
  const content = document.createElement("div");
  const body = document.createElement("p");
  const translation = document.createElement("p");
  const badge = document.createElement("span");
  item.className = "saved-final";
  item.dataset.sequence = key;
  item.dataset.enter = "true";
  order.className = "transcript-sequence";
  order.dataset.role = "sequence";
  content.className = "transcript-content";
  body.dataset.role = "text";
  translation.className = "translation-line";
  translation.dataset.role = "translation";
  translation.hidden = true;
  badge.className = "saved-badge";
  badge.dataset.role = "saved";
  badge.textContent = "已保存";
  content.append(body, translation);
  item.append(order, content, badge);
  item.addEventListener(
    "animationend",
    () => {
      delete item.dataset.enter;
    },
    { once: true },
  );
  return item;
}

function updateTranscriptRow(item: HTMLLIElement, segment: TranscriptSegment): void {
  const order = item.querySelector<HTMLElement>('[data-role="sequence"]');
  const body = item.querySelector<HTMLParagraphElement>('[data-role="text"]');
  const translation = item.querySelector<HTMLParagraphElement>('[data-role="translation"]');
  if (!order || !body || !translation) throw new Error("Transcript row structure is invalid.");
  const sequence = segment.sequence.padStart(2, "0");
  if (order.textContent !== sequence) order.textContent = sequence;
  if (body.textContent !== segment.text) body.textContent = segment.text;
  translation.dataset.status = segment.translationStatus;
  translation.title = "";
  if (segment.translationStatus === "completed") {
    translation.hidden = false;
    translation.textContent = `${LANGUAGE_LABELS[segment.translationTarget ?? "zh"]} 译文 · ${segment.translationText ?? ""}`;
  } else if (segment.translationStatus === "pending") {
    translation.hidden = false;
    translation.textContent = "正在通过所选服务翻译…";
  } else if (segment.translationStatus === "failed") {
    translation.hidden = false;
    translation.textContent = "翻译失败，原文已安全保存。";
    translation.title = segment.translationError ?? "";
  } else if (segment.translationStatus === "skipped") {
    translation.hidden = false;
    translation.textContent = "译文语言与识别语言相同，已跳过翻译。";
  } else {
    translation.hidden = true;
    translation.textContent = "";
  }
  item.dataset.revision = String(segment.revision);
}

function renderTranscript(finals: readonly TranscriptSegment[]): void {
  const currentRows = Array.from(controls.transcript.children).map((child) => {
    if (!(child instanceof HTMLLIElement) || !child.dataset.sequence) {
      throw new Error("Transcript list contains an invalid row.");
    }
    return child;
  });
  const currentKeys = currentRows.map((row) => row.dataset.sequence as string);
  const desiredKeys = finals.map((segment) => segment.sequence);
  const plan = planTranscriptReconciliation(currentKeys, desiredKeys);
  const rowByKey = new Map(currentRows.map((row) => [row.dataset.sequence as string, row]));
  const followLatest =
    controls.transcript.scrollHeight -
      controls.transcript.scrollTop -
      controls.transcript.clientHeight <
    72;
  const previousScrollHeight = controls.transcript.scrollHeight;

  for (const key of plan.removals) {
    rowByKey.get(key)?.remove();
    rowByKey.delete(key);
  }

  for (const [index, segment] of finals.entries()) {
    let item = rowByKey.get(segment.sequence);
    if (!item) {
      item = transcriptRow(segment.sequence);
      rowByKey.set(segment.sequence, item);
    }
    updateTranscriptRow(item, segment);
    const currentAtIndex = controls.transcript.children.item(index);
    if (currentAtIndex !== item) {
      controls.transcript.insertBefore(item, currentAtIndex);
    }
  }

  if (plan.insertions.length > 0) {
    const inserted = new Set(plan.insertions);
    let latestInserted: TranscriptSegment | undefined;
    for (let index = finals.length - 1; index >= 0; index -= 1) {
      if (inserted.has(finals[index].sequence)) {
        latestInserted = finals[index];
        break;
      }
    }
    if (latestInserted) {
      controls.transcriptAnnouncer.textContent = `已保存第 ${latestInserted.sequence} 条：${latestInserted.text}`;
    }
    if (followLatest) {
      controls.transcript.scrollTop = controls.transcript.scrollHeight;
    } else {
      controls.transcript.scrollTop +=
        controls.transcript.scrollHeight - previousScrollHeight;
    }
  }
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
    !ready ||
    languagePreparing ||
    translationTesting ||
    !translationConfigReady() ||
    preparedLanguage !== currentRecognitionLanguage() ||
    !controls.consent.checked ||
    currentAudioDeviceSelection() === null;
  controls.pauseResume.disabled = !["recording", "paused"].includes(snapshot.lifecycle);
  controls.pauseResume.textContent = paused ? "继续转写" : "暂停转写";
  controls.pauseResume.dataset.state =
    paused ? "paused" : snapshot.lifecycle === "recording" ? "recording" : "idle";
  controls.stop.disabled = !active;
  controls.consent.disabled = active;
  controls.recognitionLanguage.disabled =
    active ||
    languagePreparing ||
    snapshot.lifecycle !== "ready" ||
    !snapshot.modelReady;
  controls.footerLanguage.textContent = LANGUAGE_LABELS[currentRecognitionLanguage()];
  renderAudioDeviceControls(active);
  renderTranslationControls(active);
  controls.queue.textContent = `${snapshot.queueDepth} / 8`;
  controls.translationQueue.textContent = controls.translationEnabled.checked
    ? `${snapshot.translationQueueDepth} / 32`
    : "关闭";
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

  renderTranscript(snapshot.finals);
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
  if (!latest || (!isActive(latest) && latest.translationQueueDepth === 0)) return;
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

function translationSettingsChanged(): void {
  persistTranslationPreference();
  controls.translationStatus.dataset.status = "ready";
  controls.translationStatus.textContent = "配置已更新；建议开始前测试连接。";
  if (latest) {
    render(latest);
  } else {
    renderTranslationControls(false);
  }
}

controls.translationProvider.addEventListener("change", () => {
  const provider = controls.translationProvider.value as keyof typeof TRANSLATION_PROVIDER_URLS;
  const preset = TRANSLATION_PROVIDER_URLS[provider];
  if (preset !== undefined) controls.translationBaseUrl.value = preset;
  translationSettingsChanged();
});

controls.translationBaseUrl.addEventListener("input", () => {
  const matchesPreset = Object.values(TRANSLATION_PROVIDER_URLS).includes(
    controls.translationBaseUrl.value.trim() as (typeof TRANSLATION_PROVIDER_URLS)[keyof typeof TRANSLATION_PROVIDER_URLS],
  );
  if (!matchesPreset) controls.translationProvider.value = "custom";
  translationSettingsChanged();
});

controls.translationModel.addEventListener("input", translationSettingsChanged);

for (const control of [
  controls.translationEnabled,
  controls.translationLanguage,
  controls.translationBaseUrl,
  controls.translationModel,
  controls.translationAllowInsecureHttp,
]) {
  control.addEventListener("change", translationSettingsChanged);
}

controls.translationApiKey.addEventListener("input", () => {
  controls.translationStatus.dataset.status = "ready";
  controls.translationStatus.textContent = "Token 仅用于当前进程；建议开始前测试连接。";
});

controls.testTranslation.addEventListener("click", async () => {
  translationTesting = true;
  controls.translationStatus.dataset.status = "testing";
  controls.translationStatus.textContent = "正在连接所选服务并请求一条测试译文…";
  if (latest) render(latest);
  try {
    const probe = parseTranslationProbe(
      await invoke<unknown>("mvp_test_translation", {
        config: currentTranslationConfig(),
      }),
    );
    controls.translationStatus.dataset.status = "success";
    controls.translationStatus.textContent = `连接成功 · ${probe.model} · ${probe.latencyMs} ms · ${probe.preview}`;
    persistTranslationPreference();
  } catch (error) {
    controls.translationStatus.dataset.status = "error";
    controls.translationStatus.textContent = `连接失败：${message(error)}`;
  } finally {
    translationTesting = false;
    if (latest) render(latest);
  }
});

controls.recognitionLanguage.addEventListener("change", async () => {
  const language = currentRecognitionLanguage();
  controls.footerLanguage.textContent = LANGUAGE_LABELS[language];
  if (language === preparedLanguage) {
    if (latest) render(latest);
    return;
  }
  languagePreparing = true;
  controls.recognitionLanguage.disabled = true;
  controls.start.disabled = true;
  controls.model.dataset.ready = "false";
  controls.model.textContent = `正在准备 ${LANGUAGE_LABELS[language]} 识别模型…`;
  controls.error.textContent = "";
  let switchError: string | null = null;
  try {
    const snapshot = await call("mvp_prepare_language", { language });
    preparedLanguage = language;
    render(snapshot);
  } catch (error) {
    controls.recognitionLanguage.value = preparedLanguage;
    switchError = `无法切换识别语言：${message(error)}`;
  } finally {
    languagePreparing = false;
    if (latest) render(latest);
    if (switchError !== null) controls.error.textContent = switchError;
  }
});

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
        language: currentRecognitionLanguage(),
        translation: currentTranslationConfig(),
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

applyTranslationPreference(readTranslationPreference());
renderTranslationControls(false);

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
