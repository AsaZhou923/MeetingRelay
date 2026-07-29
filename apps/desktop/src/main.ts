import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { Window } from "@tauri-apps/api/window";

import {
  AUDIO_DEVICE_PREFERENCE_KEY,
  TRANSLATION_PREFERENCE_KEY,
  formatMvpErrorMessage,
  formatMvpSnapshotError,
  formatElapsed,
  hasCompleteMvpTranscript,
  hasAllMvpExportFormats,
  isMvpActiveSession,
  parseDeletePreview,
  parseDeleteResult,
  parseExportOptions,
  parseMeetingDetail,
  parseMeetingListPage,
  parseMvpTranscriptText,
  parseAudioDeviceInventory,
  parseAudioDevicePreference,
  parseAsrModelProfiles,
  parseProviderProfiles,
  parseProviderProfileDraft,
  parseDiagnosticBundleResult,
  parseInterruptedMeetings,
  parseLocalTranslationDiscovery,
  parseMvpAudioSourceMode,
  parseMvpExportResult,
  parseMvpRecognitionLanguage,
  parseMvpSnapshot,
  parseSegmentAudioLocation,
  parseSegmentSearchPage,
  parseSpeakerDiarizationResult,
  parseSpeakerVersion,
  parseSummaryJob,
  parseTranslationPreference,
  parseTranslationProbe,
  parseTranslationRetryProgress,
  requiresInsecureRemoteHttpAcknowledgement,
  resolveAudioDeviceSelection,
  type AudioDeviceInventory,
  type AsrModelProfile,
  type DiagnosticBundleResult,
  type AudioSourceSnapshot,
  type InterruptedMeeting,
  type ExportArtifact,
  type DeletePreview,
  type MeetingDetail,
  type MeetingListPage,
  type MvpExportResult,
  type MvpAudioSourceMode,
  type MvpRecognitionLanguage,
  type MvpSnapshot,
  type ProviderProfile,
  type ProviderProfileDraft,
  type SegmentAudioLocation,
  type SegmentSearchPage,
  type SpeakerAssignment,
  type SpeakerIdentity,
  type SpeakerVersion,
  type SummaryJob,
  type TranscriptSegment,
  type TranslationConfig,
  type TranslationPreference,
  type TranslationRetryProgress,
} from "./mvp-contract";
import { planTranscriptReconciliation } from "./transcript-render";
import "./styles.css";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("MeetingRelay app root is missing.");

app.innerHTML = `
  <a class="skip-link" href="#transcript-title">Skip to live transcript</a>
  <main id="main-content" class="relay-shell">
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
      <aside class="control-rail" aria-label="Session controls and input settings">
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
          <label class="device-picker language-picker">
            <span>本地识别模型</span>
            <select id="asr-model" disabled>
              <option value="">正在读取模型注册表…</option>
            </select>
            <small>只显示已校验、可选择的本地模型；会议开始后锁定。</small>
          </label>
          <label class="device-picker">
            <span>音源模式</span>
            <select id="source-mode">
              <option value="both">系统 + 麦克风</option>
              <option value="system_only">仅系统播放</option>
              <option value="microphone_only">仅麦克风</option>
            </select>
          </label>
          <label class="raw-audio-toggle">
            <input id="raw-audio-enabled" type="checkbox" />
            <span>保存 raw audio（默认关闭）</span>
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
            <input id="translation-model" type="text" list="translation-model-options" placeholder="填写供应商提供的模型 ID" spellcheck="false" />
            <datalist id="translation-model-options"></datalist>
          </label>
          <button id="discover-local-models" class="secondary-button" type="button">刷新本地模型</button>
          <label class="device-picker translation-api-key">
            <span>API Token（多数云服务必填；测试/开始时写入 Windows Credential Manager）</span>
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
          <small class="translation-privacy">本机回环地址可直接使用 HTTP；远程 HTTP 必须显式确认风险，仍建议优先配置 HTTPS。API Token 不写入普通设置或 SQLite；测试/开始时保存到 Windows Credential Manager。</small>
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
            <div><dt>磁盘可用</dt><dd id="disk-free">检测中</dd></div>
          </dl>
          <p id="disk-warning" class="disk-warning" aria-live="polite"></p>
          <button id="create-diagnostic-bundle" class="secondary-button" type="button">生成最小诊断包</button>
          <p id="diagnostic-status" class="copy-status" aria-live="polite"></p>
        </section>

        <section class="retry-panel" aria-label="Translation retry">
          <div class="rail-index">04 / RETRY</div>
          <button id="retry-failed-translations" class="secondary-button" type="button" disabled>重试本场失败译文</button>
          <button id="cancel-translation-batch" class="secondary-button" type="button" disabled>取消批量重试</button>
          <p id="retry-progress" class="retry-progress" aria-live="polite">无批量重试任务。</p>
        </section>

        <section class="recovery-panel" aria-label="Interrupted meeting recovery">
          <div class="rail-index">05 / RECOVERY</div>
          <button id="refresh-interrupted" class="secondary-button" type="button">刷新中断会议</button>
          <ul id="interrupted-meetings" class="interrupted-meetings" aria-live="polite"></ul>
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
          <div class="rail-index">06 / RECENT</div>
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
            <button id="overlay-toggle" class="secondary-button overlay-toggle" type="button" aria-pressed="false" disabled>Show overlay</button>
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

element<HTMLElement>(".transcript-stage").insertAdjacentHTML(
  "beforeend",
  `
    <section class="r3r4-console" aria-label="R3 R4 evidence console">
      <div class="console-grid">
        <section class="console-card library-card">
          <div class="console-heading">
            <div><span>R3 / LIBRARY</span><h3>Meeting library</h3></div>
            <button id="library-refresh" class="secondary-button" type="button">Refresh</button>
          </div>
          <div class="library-filters">
            <input id="library-search" type="search" placeholder="Search transcript, translation, summary, speaker" spellcheck="false" />
            <input id="library-tags" type="text" placeholder="tag1, tag2" spellcheck="false" />
          </div>
          <ol id="search-results" class="search-results" aria-live="polite"></ol>
          <ol id="library-list" class="library-list" aria-live="polite"></ol>
          <button id="library-more" class="secondary-button" type="button" disabled>Load next page</button>
          <p id="library-status" class="copy-status" aria-live="polite"></p>
        </section>

        <section class="console-card detail-card">
          <div class="console-heading">
            <div><span>R3 / DETAIL</span><h3>Meeting detail</h3></div>
            <input id="detail-sequence" type="number" min="1" step="1" placeholder="segment #" />
          </div>
          <div id="detail-summary" class="detail-summary">No meeting selected.</div>
          <div class="tag-editor">
            <input id="detail-tags" type="text" placeholder="Edit tags, comma separated" spellcheck="false" />
            <button id="detail-save-tags" class="secondary-button" type="button" disabled>Save tags</button>
          </div>
          <section class="speaker-workspace" aria-labelledby="speaker-title">
            <div class="speaker-heading">
              <div>
                <span>R5 / SPEAKERS</span>
                <h4 id="speaker-title">Speaker workspace</h4>
              </div>
              <div class="speaker-actions">
                <button id="speaker-run" class="secondary-button" type="button" disabled>Run diarization</button>
                <button id="speaker-refresh" class="secondary-button" type="button" disabled>Refresh</button>
              </div>
            </div>
            <dl class="speaker-version">
              <div><dt>Selected version</dt><dd id="speaker-version">none</dd></div>
              <div><dt>Latest version</dt><dd id="speaker-latest-version">none</dd></div>
              <div><dt>Algorithm</dt><dd id="speaker-algorithm">not run</dd></div>
              <div><dt>Status</dt><dd id="speaker-status">Select a meeting.</dd></div>
            </dl>
            <div class="speaker-version-picker">
              <label>
                <span>Load speaker version</span>
                <input id="speaker-version-input" type="number" min="1" step="1" inputmode="numeric" disabled />
              </label>
              <button id="speaker-load-version" class="secondary-button" type="button" disabled>Load version</button>
              <p id="speaker-edit-note">Edits use the latest version only.</p>
            </div>
            <ol id="speaker-identities" class="speaker-identities" aria-live="polite"></ol>
            <form id="speaker-rename-form" class="speaker-form" aria-label="Rename speaker">
              <label>
                <span>Speaker</span>
                <select id="speaker-rename-id" disabled></select>
              </label>
              <label>
                <span>New name</span>
                <input id="speaker-rename-name" type="text" maxlength="80" spellcheck="false" disabled />
              </label>
              <button id="speaker-rename" class="secondary-button" type="submit" disabled>Rename</button>
            </form>
            <form id="speaker-merge-form" class="speaker-form" aria-label="Merge speakers">
              <label>
                <span>From</span>
                <select id="speaker-merge-from" disabled></select>
              </label>
              <label>
                <span>Into</span>
                <select id="speaker-merge-into" disabled></select>
              </label>
              <label>
                <span>Merged name</span>
                <input id="speaker-merge-name" type="text" maxlength="80" spellcheck="false" disabled />
              </label>
              <button id="speaker-merge" class="secondary-button" type="submit" disabled>Merge</button>
            </form>
            <button id="speaker-undo" class="secondary-button" type="button" disabled>Undo last speaker edit</button>
          </section>
          <ol id="detail-segments" class="detail-segments"></ol>
        </section>

        <section class="console-card provider-card">
          <div class="console-heading">
            <div><span>R3 / PROVIDER</span><h3>Provider identity</h3></div>
            <button id="provider-refresh" class="secondary-button" type="button">Refresh</button>
          </div>
          <div id="provider-list" class="provider-list" aria-live="polite"></div>
          <div class="provider-editor">
            <label><span>Base URL</span><input id="provider-base-url" type="url" spellcheck="false" /></label>
            <label><span>Model</span><input id="provider-model" type="text" spellcheck="false" /></label>
            <label><span>Policy URL</span><input id="provider-policy-url" type="url" spellcheck="false" /></label>
            <label><span>Data flow</span><textarea id="provider-data-flow" rows="3" spellcheck="false"></textarea></label>
          </div>
          <button id="provider-save-profile" class="secondary-button" type="button" disabled>Save provider profile</button>
          <label class="secret-row">
            <span>Selected provider secret</span>
            <input id="provider-secret" type="password" autocomplete="off" spellcheck="false" />
          </label>
          <div class="provider-actions">
            <button id="provider-save-secret" class="secondary-button" type="button" disabled>Save to OS vault</button>
            <button id="provider-remove-secret" class="secondary-button danger" type="button" disabled>Remove from OS vault</button>
            <button id="provider-test" class="secondary-button" type="button" disabled>Test provider</button>
          </div>
          <p id="provider-status" class="copy-status" aria-live="polite"></p>
        </section>

        <section class="console-card governance-card">
          <div class="console-heading">
            <div><span>R3 / GOVERNANCE</span><h3>Retention and deletion</h3></div>
            <button id="delete-preview" class="secondary-button" type="button" disabled>Preview delete</button>
          </div>
          <ul id="delete-preview-list" class="delete-preview-list"></ul>
          <div class="governance-actions">
            <button id="delete-execute" class="secondary-button danger" type="button" disabled>Execute delete</button>
            <button id="delete-restore" class="secondary-button" type="button" disabled>Restore</button>
          </div>
          <p id="delete-status" class="copy-status" aria-live="polite"></p>
        </section>

        <section class="console-card summary-card">
          <div class="console-heading">
            <div><span>R4 / SUMMARY</span><h3>Chinese structured summary</h3></div>
            <button id="summary-start" class="secondary-button" type="button" disabled>Start</button>
          </div>
          <div class="summary-actions">
            <button id="summary-cancel" class="secondary-button" type="button" disabled>Cancel</button>
            <button id="summary-retry" class="secondary-button" type="button" disabled>Retry new version</button>
          </div>
          <div id="summary-output" class="summary-output">No summary job.</div>
        </section>

        <section class="console-card export-studio-card">
          <div class="console-heading">
            <div><span>R4 / EXPORT</span><h3>Export studio</h3></div>
            <button id="export-selected" class="secondary-button" type="button" disabled>Export selected</button>
          </div>
          <fieldset class="format-grid">
            <legend>Export formats</legend>
            <label><input type="checkbox" name="export-format" value="json" checked /> JSON</label>
            <label><input type="checkbox" name="export-format" value="markdown" checked /> Markdown</label>
            <label><input type="checkbox" name="export-format" value="txt" checked /> TXT</label>
            <label><input type="checkbox" name="export-format" value="docx" /> DOCX</label>
            <label><input type="checkbox" name="export-format" value="pdf" /> PDF</label>
          </fieldset>
          <fieldset class="format-grid">
            <legend>Export content options</legend>
            <label><input id="export-original" type="checkbox" checked /> original</label>
            <label><input id="export-translation" type="checkbox" checked /> translation</label>
            <label><input id="export-bilingual" type="checkbox" checked /> bilingual</label>
            <label><input id="export-speaker" type="checkbox" checked aria-describedby="export-speaker-note" /> speaker <small id="export-speaker-note">Run speaker diarization before exporting speaker labels.</small></label>
            <label><input id="export-summary" type="checkbox" checked /> summary</label>
            <label><input id="export-timestamp" type="checkbox" checked /> timestamp</label>
          </fieldset>
          <p id="export-studio-status" class="copy-status" aria-live="polite"></p>
        </section>
      </div>
    </section>
  `,
);

function element<T extends Element>(selector: string): T {
  const value = document.querySelector<T>(selector);
  if (!value) throw new Error(`Required control is missing: ${selector}`);
  return value;
}

const controls = {
  systemDevice: element<HTMLSelectElement>("#system-device"),
  microphoneDevice: element<HTMLSelectElement>("#microphone-device"),
  recognitionLanguage: element<HTMLSelectElement>("#recognition-language"),
  asrModel: element<HTMLSelectElement>("#asr-model"),
  sourceMode: element<HTMLSelectElement>("#source-mode"),
  rawAudioEnabled: element<HTMLInputElement>("#raw-audio-enabled"),
  translationEnabled: element<HTMLInputElement>("#translation-enabled"),
  translationProvider: element<HTMLSelectElement>("#translation-provider"),
  translationLanguage: element<HTMLSelectElement>("#translation-language"),
  translationBaseUrl: element<HTMLInputElement>("#translation-base-url"),
  translationModel: element<HTMLInputElement>("#translation-model"),
  translationModelOptions: element<HTMLDataListElement>("#translation-model-options"),
  discoverLocalModels: element<HTMLButtonElement>("#discover-local-models"),
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
  overlayToggle: element<HTMLButtonElement>("#overlay-toggle"),
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
  diskFree: element<HTMLElement>("#disk-free"),
  diskWarning: element<HTMLParagraphElement>("#disk-warning"),
  createDiagnosticBundle: element<HTMLButtonElement>("#create-diagnostic-bundle"),
  diagnosticStatus: element<HTMLParagraphElement>("#diagnostic-status"),
  retryFailedTranslations: element<HTMLButtonElement>("#retry-failed-translations"),
  cancelTranslationBatch: element<HTMLButtonElement>("#cancel-translation-batch"),
  retryProgress: element<HTMLParagraphElement>("#retry-progress"),
  refreshInterrupted: element<HTMLButtonElement>("#refresh-interrupted"),
  interruptedMeetings: element<HTMLUListElement>("#interrupted-meetings"),
  footerStorage: element<HTMLElement>("#footer-storage"),
  footerLanguage: element<HTMLElement>("#footer-language"),
  openRecent: element<HTMLButtonElement>("#open-recent"),
  recentSummary: element<HTMLElement>("#recent-summary"),
  copyTranscript: element<HTMLButtonElement>("#copy-transcript"),
  copyStatus: element<HTMLParagraphElement>("#copy-status"),
  copyFallback: element<HTMLTextAreaElement>("#copy-fallback"),
  exportAll: element<HTMLButtonElement>("#export-all"),
  exportResults: element<HTMLUListElement>("#export-results"),
  libraryRefresh: element<HTMLButtonElement>("#library-refresh"),
  librarySearch: element<HTMLInputElement>("#library-search"),
  libraryTags: element<HTMLInputElement>("#library-tags"),
  searchResults: element<HTMLOListElement>("#search-results"),
  libraryList: element<HTMLOListElement>("#library-list"),
  libraryMore: element<HTMLButtonElement>("#library-more"),
  libraryStatus: element<HTMLParagraphElement>("#library-status"),
  detailSequence: element<HTMLInputElement>("#detail-sequence"),
  detailSummary: element<HTMLElement>("#detail-summary"),
  detailTags: element<HTMLInputElement>("#detail-tags"),
  detailSaveTags: element<HTMLButtonElement>("#detail-save-tags"),
  speakerRun: element<HTMLButtonElement>("#speaker-run"),
  speakerRefresh: element<HTMLButtonElement>("#speaker-refresh"),
  speakerVersion: element<HTMLElement>("#speaker-version"),
  speakerLatestVersion: element<HTMLElement>("#speaker-latest-version"),
  speakerAlgorithm: element<HTMLElement>("#speaker-algorithm"),
  speakerStatus: element<HTMLElement>("#speaker-status"),
  speakerVersionInput: element<HTMLInputElement>("#speaker-version-input"),
  speakerLoadVersion: element<HTMLButtonElement>("#speaker-load-version"),
  speakerEditNote: element<HTMLParagraphElement>("#speaker-edit-note"),
  speakerIdentities: element<HTMLOListElement>("#speaker-identities"),
  speakerRenameForm: element<HTMLFormElement>("#speaker-rename-form"),
  speakerRenameId: element<HTMLSelectElement>("#speaker-rename-id"),
  speakerRenameName: element<HTMLInputElement>("#speaker-rename-name"),
  speakerRename: element<HTMLButtonElement>("#speaker-rename"),
  speakerMergeForm: element<HTMLFormElement>("#speaker-merge-form"),
  speakerMergeFrom: element<HTMLSelectElement>("#speaker-merge-from"),
  speakerMergeInto: element<HTMLSelectElement>("#speaker-merge-into"),
  speakerMergeName: element<HTMLInputElement>("#speaker-merge-name"),
  speakerMerge: element<HTMLButtonElement>("#speaker-merge"),
  speakerUndo: element<HTMLButtonElement>("#speaker-undo"),
  detailSegments: element<HTMLOListElement>("#detail-segments"),
  providerRefresh: element<HTMLButtonElement>("#provider-refresh"),
  providerList: element<HTMLElement>("#provider-list"),
  providerBaseUrl: element<HTMLInputElement>("#provider-base-url"),
  providerModel: element<HTMLInputElement>("#provider-model"),
  providerPolicyUrl: element<HTMLInputElement>("#provider-policy-url"),
  providerDataFlow: element<HTMLTextAreaElement>("#provider-data-flow"),
  providerSaveProfile: element<HTMLButtonElement>("#provider-save-profile"),
  providerSecret: element<HTMLInputElement>("#provider-secret"),
  providerSaveSecret: element<HTMLButtonElement>("#provider-save-secret"),
  providerRemoveSecret: element<HTMLButtonElement>("#provider-remove-secret"),
  providerTest: element<HTMLButtonElement>("#provider-test"),
  providerStatus: element<HTMLParagraphElement>("#provider-status"),
  deletePreview: element<HTMLButtonElement>("#delete-preview"),
  deletePreviewList: element<HTMLUListElement>("#delete-preview-list"),
  deleteExecute: element<HTMLButtonElement>("#delete-execute"),
  deleteRestore: element<HTMLButtonElement>("#delete-restore"),
  deleteStatus: element<HTMLParagraphElement>("#delete-status"),
  summaryStart: element<HTMLButtonElement>("#summary-start"),
  summaryCancel: element<HTMLButtonElement>("#summary-cancel"),
  summaryRetry: element<HTMLButtonElement>("#summary-retry"),
  summaryOutput: element<HTMLElement>("#summary-output"),
  exportSelected: element<HTMLButtonElement>("#export-selected"),
  exportOriginal: element<HTMLInputElement>("#export-original"),
  exportTranslation: element<HTMLInputElement>("#export-translation"),
  exportBilingual: element<HTMLInputElement>("#export-bilingual"),
  exportSpeaker: element<HTMLInputElement>("#export-speaker"),
  exportSummary: element<HTMLInputElement>("#export-summary"),
  exportTimestamp: element<HTMLInputElement>("#export-timestamp"),
  exportStudioStatus: element<HTMLParagraphElement>("#export-studio-status"),
};

for (const [control, label] of [
  [controls.systemDevice, "Windows system output device"],
  [controls.microphoneDevice, "Windows microphone device"],
  [controls.recognitionLanguage, "Meeting recognition language"],
  [controls.asrModel, "Local ASR model"],
  [controls.sourceMode, "Meeting audio source mode"],
  [controls.translationProvider, "Translation provider preset"],
  [controls.translationLanguage, "Translation target language"],
  [controls.librarySearch, "Search meeting library"],
  [controls.libraryTags, "Filter meeting library by tags"],
  [controls.detailSequence, "Jump to detail segment number"],
  [controls.speakerVersionInput, "Speaker version number to load"],
  [controls.speakerRenameId, "Speaker to rename"],
  [controls.speakerRenameName, "New speaker display name"],
  [controls.speakerMergeFrom, "Speaker to merge from"],
  [controls.speakerMergeInto, "Speaker to merge into"],
  [controls.speakerMergeName, "Optional merged speaker display name"],
] as const) {
  control.setAttribute("aria-label", label);
}

let latest: MvpSnapshot | null = null;
let lastExport: MvpExportResult | null = null;
let overlayVisible = false;
let pollTimer: number | null = null;
let audioDevices: AudioDeviceInventory | null = null;
let audioDeviceLoadError: string | null = null;
let preparedLanguage: MvpRecognitionLanguage = "zh";
let preparedAsrModelId: string | null = null;
let asrModels: AsrModelProfile[] = [];
let languagePreparing = false;
let translationTesting = false;
let localModelDiscovering = false;
let lastClipboardText: string | null = null;
let latestRetryProgress: TranslationRetryProgress | null = null;
let retryProgressTimer: number | null = null;
let diagnosticBundle: DiagnosticBundleResult | null = null;
let interruptedMeetings: InterruptedMeeting[] = [];
let busyInterruptedMeetingIds = new Set<string>();
let audioPreview: HTMLAudioElement | null = null;
let meetingPage: MeetingListPage | null = null;
let searchPage: SegmentSearchPage | null = null;
let meetingDetail: MeetingDetail | null = null;
let latestSpeakerVersion: SpeakerVersion | null = null;
let speakerVersion: SpeakerVersion | null = null;
let providerProfiles: ProviderProfile[] = [];
let selectedProviderId: string | null = null;
let deletePreviewState: DeletePreview | null = null;
let summaryJob: SummaryJob | null = null;
let summaryPollTimer: number | null = null;
const MVP_EXPORT_TARGET_DIR = "MeetingRelayExports";
const ASR_MODEL_PREFERENCE_KEY = "meetingrelay.asr-model.v1";
const R3_PAGE_SIZE = 50;
const CAPTION_OVERLAY_WINDOW_LABEL = "caption-overlay";

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
const MEETING_LANGUAGE_LABELS: Record<MeetingListPage["items"][number]["language"], string> = {
  ...LANGUAGE_LABELS,
  unknown: "未知 · UNKNOWN",
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

function currentAsrModelId(): string | null {
  const value = controls.asrModel.value.trim();
  return value.length === 0 ? null : value;
}

function readAsrModelPreference(): string | null {
  try {
    const value = window.localStorage.getItem(ASR_MODEL_PREFERENCE_KEY)?.trim() ?? "";
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

function persistAsrModelPreference(): void {
  const modelId = currentAsrModelId();
  if (modelId === null) return;
  try {
    window.localStorage.setItem(ASR_MODEL_PREFERENCE_KEY, modelId);
  } catch {
    // The in-memory selection remains valid if browser storage is unavailable.
  }
}

function renderAsrModelOptions(preferredModelId: string | null = currentAsrModelId()): void {
  const language = currentRecognitionLanguage();
  const selectable = asrModels.filter(
    (profile) =>
      profile.selectable &&
      profile.installState === "verified" &&
      profile.supportedLanguages.includes(language),
  );
  controls.asrModel.replaceChildren(
    ...selectable.map((profile) => {
      const option = document.createElement("option");
      option.value = profile.modelId;
      const streaming = profile.nativeStreaming ? "原生流式" : "分段流式";
      option.textContent = `${profile.label} · ${profile.executionProvider} · ${profile.quantization} · ${streaming}`;
      option.title = `${profile.engine} ${profile.engineVersion} · ${profile.tier} · revision ${profile.modelRevision} · SHA-256 ${profile.modelSha256}`;
      return option;
    }),
  );
  const selected = selectable.find((profile) => profile.modelId === preferredModelId);
  controls.asrModel.value = selected?.modelId ?? selectable[0]?.modelId ?? "";
}

async function loadAsrModels(): Promise<void> {
  asrModels = parseAsrModelProfiles(await invoke<unknown>("mvp_asr_models"));
  renderAsrModelOptions(readAsrModelPreference());
}

function currentSourceMode(): MvpAudioSourceMode {
  return parseMvpAudioSourceMode(controls.sourceMode.value);
}

function currentTranslationConfig(): TranslationConfig {
  return {
    enabled: controls.translationEnabled.checked,
    baseUrl: controls.translationBaseUrl.value.trim(),
    model: controls.translationModel.value.trim(),
    apiKey: null,
    targetLanguage: parseMvpRecognitionLanguage(controls.translationLanguage.value),
    allowInsecureHttp: controls.translationAllowInsecureHttp.checked,
  };
}

function isLoopbackTranslationBaseUrl(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    const host = url.hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    // Backend validation returns the canonical endpoint error.
    return false;
  }
}

function translationProviderClass(baseUrl: string): "local" | "lan" | "cloud" {
  if (isLoopbackTranslationBaseUrl(baseUrl)) return "local";
  try {
    if (new URL(baseUrl).protocol === "http:") return "lan";
  } catch {
    // Backend validation returns the canonical endpoint error.
  }
  return "cloud";
}

function translationProviderProfile(config: TranslationConfig): ProviderProfile | null {
  const desiredClass = translationProviderClass(config.baseUrl);
  const selected = providerProfiles.find((profile) => profile.profileId === selectedProviderId);
  if (selected?.class === desiredClass) return selected;
  return providerProfiles.find((profile) => profile.class === desiredClass) ?? null;
}

async function persistTranslationProviderProfile(): Promise<string | null> {
  const config = currentTranslationConfig();
  if (!config.enabled) return null;
  const profile = translationProviderProfile(config);
  if (profile === null) throw new Error("TRANSLATION_PROVIDER_PROFILE_REQUIRED");
  selectedProviderId = profile.profileId;
  if (profile.baseUrl !== config.baseUrl || profile.model !== config.model) {
    await invoke<unknown>("mvp_save_provider_profile", {
      profile: {
        profileId: profile.profileId,
        label: profile.label,
        class: profile.class,
        baseUrl: config.baseUrl,
        model: config.model,
        policyUrl: profile.policyUrl,
        dataFlow: profile.dataFlow,
        configVersion: profile.configVersion,
      },
    });
  }
  const secret = controls.translationApiKey.value.trim();
  if (profile.class !== "local" && secret.length > 0) {
    await invoke<unknown>("mvp_set_provider_secret", {
      profileId: profile.profileId,
      secret,
    });
    controls.translationApiKey.value = "";
  }
  await loadProviderProfiles();
  return profile.profileId;
}

function translationConfigReady(): boolean {
  const config = currentTranslationConfig();
  const insecureHttpAcknowledged =
    !requiresInsecureRemoteHttpAcknowledgement(config.baseUrl) || config.allowInsecureHttp;
  return (
    !config.enabled ||
    (config.baseUrl.length > 0 &&
      config.model.length > 0 &&
      insecureHttpAcknowledged &&
      translationProviderProfile(config) !== null)
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
  if (config.model.length === 0) return;
  try {
    window.localStorage.setItem(
      TRANSLATION_PREFERENCE_KEY,
      JSON.stringify({
        version: 1,
        enabled: config.enabled,
        provider: controls.translationProvider.value,
        baseUrl: "",
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
  controls.translationModel.value = preference.model;
  controls.translationLanguage.value = preference.targetLanguage;
  controls.translationAllowInsecureHttp.checked = preference.allowInsecureHttp;
  controls.translationProvider.value =
    preference.provider in TRANSLATION_PROVIDER_URLS || preference.provider === "custom"
      ? preference.provider
      : "custom";
  const provider = controls.translationProvider.value as keyof typeof TRANSLATION_PROVIDER_URLS;
  const preset = TRANSLATION_PROVIDER_URLS[provider];
  if (preset !== undefined) controls.translationBaseUrl.value = preset;
}

function renderTranslationControls(active: boolean): void {
  const config = currentTranslationConfig();
  const loopback = isLoopbackTranslationBaseUrl(config.baseUrl);
  const requiresInsecureHttp = requiresInsecureRemoteHttpAcknowledgement(config.baseUrl);
  controls.translationQueue.textContent = config.enabled
    ? `${latest?.translationQueueDepth ?? 0} / 32`
    : "关闭";
  const locked = active || translationTesting || localModelDiscovering;
  controls.translationEnabled.disabled = active;
  controls.translationProvider.disabled = locked || !config.enabled;
  controls.translationLanguage.disabled = locked || !config.enabled;
  controls.translationBaseUrl.disabled = locked || !config.enabled;
  controls.translationModel.disabled = locked || !config.enabled;
  controls.discoverLocalModels.disabled =
    locked || !config.enabled || !isLoopbackTranslationBaseUrl(config.baseUrl);
  controls.translationApiKey.disabled = locked || !config.enabled || loopback;
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
  systemOutputDeviceId: string | null;
  microphoneDeviceId: string | null;
} | null {
  if (audioDevices === null) return null;
  const sourceMode = currentSourceMode();
  const needsSystem = sourceMode === "system_only" || sourceMode === "both";
  const needsMicrophone = sourceMode === "microphone_only" || sourceMode === "both";
  const systemOutputDeviceId =
    needsSystem &&
    audioDevices.systemOutputs.some((device) => device.deviceId === controls.systemDevice.value)
      ? controls.systemDevice.value
      : null;
  const microphoneDeviceId =
    needsMicrophone &&
    audioDevices.microphones.some((device) => device.deviceId === controls.microphoneDevice.value)
      ? controls.microphoneDevice.value
      : null;
  if ((needsSystem && systemOutputDeviceId === null) || (needsMicrophone && microphoneDeviceId === null)) {
    return null;
  }
  return {
    systemOutputDeviceId,
    microphoneDeviceId,
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
  if (
    selection === null ||
    selection.systemOutputDeviceId === null ||
    selection.microphoneDeviceId === null
  ) {
    return;
  }
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
  const sourceMode = currentSourceMode();
  const needsSystem = sourceMode === "system_only" || sourceMode === "both";
  const needsMicrophone = sourceMode === "microphone_only" || sourceMode === "both";
  controls.sourceMode.disabled = active;
  controls.rawAudioEnabled.disabled = active;
  controls.systemDevice.disabled =
    active || !needsSystem || audioDevices === null || audioDevices.systemOutputs.length === 0;
  controls.microphoneDevice.disabled =
    active || !needsMicrophone || audioDevices === null || audioDevices.microphones.length === 0;
  if (audioDeviceLoadError !== null) {
    controls.deviceStatus.dataset.status = "error";
    controls.deviceStatus.textContent = `读取设备失败：${audioDeviceLoadError}`;
  } else if (audioDevices === null) {
    controls.deviceStatus.dataset.status = "loading";
    controls.deviceStatus.textContent = "正在读取 Windows 音频设备…";
  } else if (selection === null) {
    controls.deviceStatus.dataset.status = "error";
    controls.deviceStatus.textContent =
      sourceMode === "system_only"
        ? "请选择当前可用的系统输出；麦克风可留空。"
        : sourceMode === "microphone_only"
          ? "请选择当前可用的麦克风；系统输出可留空。"
          : "请选择当前可用的系统输出和麦克风。";
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
  element<HTMLElement>(`#${source.id}-label`).textContent =
    source.status === "disabled" ? "本次未启用" : source.label || "未找到设备";
  element<HTMLElement>(`#${source.id}-status`).textContent =
    paused
      ? "已暂停"
      : source.status === "capturing"
      ? "采集中"
      : source.status === "ready"
        ? "已就绪"
        : source.status === "degraded"
          ? "降级"
          : source.status === "disabled"
            ? "未启用"
            : "异常";
  element<HTMLElement>(`#${source.id}-frames`).textContent = `${source.frames} frames`;
  element<HTMLElement>(`#${source.id}-level`).style.transform = `scaleX(${source.peak})`;
  card.setAttribute(
    "aria-label",
    `${source.label || source.id}: ${element<HTMLElement>(`#${source.id}-status`).textContent ?? ""}`,
  );
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
  controls.deletePreview.disabled = snapshot.meetingId === null || isActive(snapshot);
  controls.summaryStart.disabled = snapshot.meetingId === null || isActive(snapshot);
  controls.exportSelected.disabled = !canExport(snapshot);
}

function renderOverlayToggle(snapshot: MvpSnapshot): void {
  controls.overlayToggle.disabled = snapshot.meetingId === null && snapshot.interim === null && snapshot.finals.length === 0;
  controls.overlayToggle.textContent = overlayVisible ? "Hide overlay" : "Show overlay";
  controls.overlayToggle.setAttribute("aria-pressed", String(overlayVisible));
}

function tagFilters(): string[] {
  return controls.libraryTags.value
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function selectedMeetingId(): string | null {
  return meetingDetail?.meeting.meetingId ?? latest?.meetingId ?? null;
}

function idempotencyKey(operation: string): string {
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${operation}-${random}`;
}

function assignmentKey(segmentId: string, sequence: string): string {
  return `${segmentId}\u0000${sequence}`;
}

function speakerNameMap(version: SpeakerVersion | null): Map<string, string> {
  return new Map(version?.identities.map((identity) => [identity.speakerId, identity.displayName]) ?? []);
}

function speakerAssignmentMap(version: SpeakerVersion | null): Map<string, SpeakerAssignment> {
  return new Map(
    version?.assignments.map((assignment) => [
      assignmentKey(assignment.segmentId, assignment.sequence),
      assignment,
    ]) ?? [],
  );
}

function speakerAssignmentCounts(version: SpeakerVersion | null): Map<string, number> {
  const counts = new Map<string, number>();
  for (const assignment of version?.assignments ?? []) {
    counts.set(assignment.speakerId, (counts.get(assignment.speakerId) ?? 0) + 1);
  }
  return counts;
}

function speakerOptions(identities: readonly SpeakerIdentity[]): HTMLOptionElement[] {
  return identities.map((identity) => {
    const option = document.createElement("option");
    option.value = identity.speakerId;
    option.textContent = identity.displayName;
    return option;
  });
}

function renderSpeakerWorkspace(): void {
  const meetingId = selectedMeetingId();
  const hasMeeting = meetingId !== null;
  const version = speakerVersion?.meetingId === meetingId ? speakerVersion : null;
  const latestVersion =
    latestSpeakerVersion?.meetingId === meetingId ? latestSpeakerVersion : null;
  const viewingLatest =
    version !== null && latestVersion !== null && version.version === latestVersion.version;
  const counts = speakerAssignmentCounts(version);
  const canEdit = version !== null && viewingLatest && version.identities.length > 0;
  const canMerge = version !== null && viewingLatest && version.identities.length > 1;
  controls.speakerRun.disabled = !hasMeeting;
  controls.speakerRefresh.disabled = !hasMeeting;
  controls.speakerVersion.textContent = version === null ? "none" : String(version.version);
  controls.speakerLatestVersion.textContent =
    latestVersion === null ? "none" : String(latestVersion.version);
  controls.speakerAlgorithm.textContent = version?.algorithm ?? "not run";
  controls.speakerVersionInput.disabled = latestVersion === null;
  controls.speakerVersionInput.min = "1";
  controls.speakerVersionInput.max = latestVersion === null ? "1" : String(latestVersion.version);
  controls.speakerVersionInput.value = version === null ? "" : String(version.version);
  controls.speakerLoadVersion.disabled = latestVersion === null;
  controls.speakerEditNote.dataset.status = viewingLatest ? "editable" : "readonly";
  controls.speakerEditNote.textContent =
    version === null
      ? "Run speaker diarization before editing or exporting speaker labels."
      : viewingLatest
        ? "Editing is enabled for the latest speaker version."
        : `Viewing historical speaker version ${version.version}; rename, merge, and undo are disabled until you return to latest ${latestVersion?.version ?? "version"}.`;
  const preservedStatus = controls.speakerStatus.dataset.status ?? "";
  if (!["loading", "failed", "unavailable", "skipped"].includes(preservedStatus)) {
    controls.speakerStatus.textContent =
      version === null
        ? hasMeeting
          ? "No completed speaker version yet."
          : "Select a meeting."
        : `${version.operation} completed · ${version.identities.length} speakers · ${version.assignments.length} assignments`;
    controls.speakerStatus.dataset.status = version === null ? "empty" : "completed";
  }
  controls.speakerIdentities.replaceChildren(
    ...(version?.identities.map((identity) => {
      const item = document.createElement("li");
      const name = document.createElement("strong");
      const detail = document.createElement("span");
      name.textContent = identity.displayName;
      detail.textContent = `${identity.speakerId} · ${counts.get(identity.speakerId) ?? 0} assigned segment(s)`;
      item.append(name, detail);
      return item;
    }) ?? []),
  );
  controls.speakerRenameId.replaceChildren(...speakerOptions(version?.identities ?? []));
  controls.speakerMergeFrom.replaceChildren(...speakerOptions(version?.identities ?? []));
  controls.speakerMergeInto.replaceChildren(...speakerOptions(version?.identities ?? []));
  controls.speakerRenameId.disabled = !canEdit;
  controls.speakerRenameName.disabled = !canEdit;
  controls.speakerRename.disabled = !canEdit;
  controls.speakerMergeFrom.disabled = !canMerge;
  controls.speakerMergeInto.disabled = !canMerge;
  controls.speakerMergeName.disabled = !canMerge;
  controls.speakerMerge.disabled = !canMerge;
  controls.speakerUndo.disabled = version === null || !viewingLatest || version.parentVersion === null;
  controls.exportSpeaker.disabled = version === null;
  controls.exportSpeaker.checked = version !== null && controls.exportSpeaker.checked;
  controls.exportSpeaker.closest("label")?.setAttribute(
    "title",
    version === null
      ? "Run speaker diarization before including speaker labels in export."
      : `Speaker version ${version.version} will be included.`,
  );
  const speakerExportNote = document.querySelector<HTMLElement>("#export-speaker-note");
  if (speakerExportNote !== null) {
    speakerExportNote.textContent =
      version === null
        ? "Run speaker diarization before exporting speaker labels."
        : `Speaker version ${version.version} ready.`;
  }
}

function renderMeetingLibrary(): void {
  renderSearchResults();
  const page = meetingPage;
  if (page === null) {
    controls.libraryList.replaceChildren();
    controls.libraryMore.disabled = true;
    controls.libraryStatus.textContent = "Library not loaded.";
    return;
  }
  controls.libraryList.replaceChildren(
    ...page.items.map((meeting) => {
      const item = document.createElement("li");
      const button = document.createElement("button");
      const meta = document.createElement("span");
      button.type = "button";
      button.textContent = meeting.title;
      button.addEventListener("click", async () => {
        await loadMeetingDetail(meeting.meetingId);
      });
      meta.textContent = `${meeting.status} · ${formatElapsed(meeting.durationMs)} · ${MEETING_LANGUAGE_LABELS[meeting.language]} · summary ${meeting.summaryStatus} · ${meeting.tags.join(", ") || "no tags"}`;
      item.append(button, meta);
      return item;
    }),
  );
  controls.libraryMore.disabled = page.nextCursor === null;
  controls.libraryStatus.textContent = `${page.items.length}/${page.total} meetings · query ${page.elapsedMs} ms`;
}

function renderSearchResults(): void {
  const page = searchPage;
  if (page === null) {
    controls.searchResults.replaceChildren();
    return;
  }
  controls.searchResults.replaceChildren(
    ...page.hits.map((hit) => {
      const item = document.createElement("li");
      const button = document.createElement("button");
      const meta = document.createElement("span");
      button.type = "button";
      button.textContent = `${hit.scope} · ${hit.snippet}`;
      button.addEventListener("click", async () => {
        await loadMeetingDetail(hit.meetingId, hit.segmentId, hit.sequence);
      });
      meta.textContent = `${hit.meetingTitle} · ${hit.sequence === null ? "summary" : `#${hit.sequence}`} · score ${hit.score.toFixed(2)}`;
      item.append(button, meta);
      return item;
    }),
  );
}

function renderMeetingDetail(): void {
  const detail = meetingDetail;
  if (detail === null) {
    controls.detailSummary.textContent = "No meeting selected.";
    controls.detailTags.value = "";
    controls.detailSaveTags.disabled = true;
    controls.detailSegments.replaceChildren();
    renderSpeakerWorkspace();
    return;
  }
  const assignments = speakerAssignmentMap(speakerVersion);
  const names = speakerNameMap(speakerVersion);
  controls.detailSummary.textContent = `${detail.meeting.title} · ${detail.meeting.status} · ${formatElapsed(detail.meeting.durationMs)} · ${detail.meeting.savedFinalCount} finals`;
  controls.detailTags.value = detail.meeting.tags.join(", ");
  controls.detailSaveTags.disabled = false;
  renderSpeakerWorkspace();
  controls.detailSegments.replaceChildren(
    ...detail.segments.slice(0, 200).map((segment) => {
      const item = document.createElement("li");
      item.id = `detail-segment-${segment.sequence}`;
      item.dataset.sequence = segment.sequence;
      item.dataset.segmentId = segment.segmentId;
      item.tabIndex = -1;
      const header = document.createElement("strong");
      const text = document.createElement("p");
      const speaker = document.createElement("p");
      const translation = document.createElement("p");
      const assignment = assignments.get(assignmentKey(segment.segmentId, segment.sequence));
      header.textContent = `#${segment.sequence} · ${segment.startedAtMs}ms`;
      speaker.className = "speaker-label";
      speaker.textContent =
        assignment === undefined
          ? "Speaker: unassigned"
          : `Speaker: ${names.get(assignment.speakerId) ?? assignment.speakerId} · confidence ${Math.round(assignment.confidence * 100)}%`;
      text.textContent = segment.text;
      translation.textContent =
        segment.translationStatus === "completed"
          ? segment.translationText ?? ""
          : `translation ${segment.translationStatus}`;
      item.append(header, speaker, text, translation);
      return item;
    }),
  );
}

function renderProviderProfiles(): void {
  controls.providerList.replaceChildren(
    ...providerProfiles.map((profile) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "provider-profile";
      button.dataset.selected = String(profile.profileId === selectedProviderId);
      button.setAttribute("aria-pressed", String(profile.profileId === selectedProviderId));
      button.textContent = `${profile.label} · ${profile.class} · v${profile.configVersion} · secret ${profile.secretState} · test ${profile.lastTestStatus}`;
      button.title = `${profile.baseUrl}\n${profile.model}\n${profile.dataFlow}${profile.policyUrl ? `\nPolicy: ${profile.policyUrl}` : ""}${profile.lastError ? `\nError: ${profile.lastError}` : ""}`;
      button.addEventListener("click", () => {
        selectedProviderId = profile.profileId;
        controls.providerSecret.value = "";
        renderProviderProfiles();
      });
      return button;
    }),
  );
  const selected = providerProfiles.find((profile) => profile.profileId === selectedProviderId);
  controls.providerBaseUrl.value = selected?.baseUrl ?? "";
  controls.providerModel.value = selected?.model ?? "";
  controls.providerPolicyUrl.value = selected?.policyUrl ?? "";
  controls.providerDataFlow.value = selected?.dataFlow ?? "";
  for (const control of [
    controls.providerBaseUrl,
    controls.providerModel,
    controls.providerPolicyUrl,
    controls.providerDataFlow,
  ]) {
    control.disabled = selected === undefined;
  }
  controls.providerSaveProfile.disabled = selected === undefined;
  controls.providerSaveSecret.disabled =
    selected === undefined || selected.class === "local" || selected.secretState === "unsupported";
  controls.providerRemoveSecret.disabled = !providerSecretCanBeRemoved(selected);
  controls.providerTest.disabled = selected === undefined;
  controls.providerStatus.textContent =
    selected === undefined
      ? "Select a provider."
      : `${selected.label}: ${selected.baseUrl} · ${selected.model} · ${selected.dataFlow}`;
}

function providerSecretCanBeRemoved(profile: ProviderProfile | undefined): boolean {
  if (profile === undefined || profile.class === "local") return false;
  const secretState = profile.secretState as string;
  return !["missing", "not_required", "unsupported"].includes(secretState);
}

function renderDeletePreview(): void {
  const preview = deletePreviewState;
  controls.deletePreviewList.replaceChildren(
    ...(preview?.entries.map((entry) => {
      const item = document.createElement("li");
      item.textContent = `${entry.type} · ${entry.description} · ${formatBytes(entry.byteLength)}${entry.path ? ` · ${entry.path}` : ""}`;
      return item;
    }) ?? []),
  );
  controls.deleteExecute.disabled = preview === null;
  controls.deleteRestore.disabled = preview === null || !preview.canRestore;
  controls.deleteStatus.textContent =
    preview === null
      ? "No delete preview."
      : `Preview ${preview.entries.length} entries · ${formatBytes(preview.willDeleteBytes)} · recovery ${preview.recoveryWindowSeconds}s`;
}

function renderSummaryJob(): void {
  const job = summaryJob;
  controls.summaryCancel.disabled = job === null || !job.canCancel;
  controls.summaryRetry.disabled = job === null || !job.canRetry;
  if (job === null) {
    controls.summaryOutput.textContent = "No summary job.";
    return;
  }
  const progress = `${job.completedChunks}/${job.totalChunks}`;
  if (job.result === null) {
    controls.summaryOutput.textContent = `${job.status} · version ${job.version} · chunks ${progress}${job.message ? ` · ${job.message}` : ""}`;
    return;
  }
  controls.summaryOutput.replaceChildren(
    sectionBlock("Overview", [job.result.overview]),
    sectionBlock("Actions", job.result.actions),
    sectionBlock("Decisions", job.result.decisions),
    sectionBlock("Open questions", job.result.openQuestions),
    sectionBlock(
      "Citations",
      job.result.citations.map((citation) =>
        citation.sequence === null
          ? `${citation.label} (unlinked)`
          : `${citation.label} → segment ${citation.sequence}`,
      ),
    ),
  );
}

function sectionBlock(title: string, lines: readonly string[]): HTMLElement {
  const section = document.createElement("section");
  const heading = document.createElement("strong");
  const list = document.createElement("ul");
  heading.textContent = title;
  for (const line of lines.length > 0 ? lines : ["None"]) {
    const item = document.createElement("li");
    item.textContent = line;
    list.append(item);
  }
  section.append(heading, list);
  return section;
}

function transcriptRow(key: string): HTMLLIElement {
  const item = document.createElement("li");
  const order = document.createElement("span");
  const content = document.createElement("div");
  const body = document.createElement("p");
  const translation = document.createElement("p");
  const actions = document.createElement("div");
  const retry = document.createElement("button");
  const locate = document.createElement("button");
  const audio = document.createElement("audio");
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
  actions.className = "segment-actions";
  retry.className = "secondary-button";
  retry.type = "button";
  retry.dataset.role = "retry-translation";
  retry.textContent = "重试译文";
  retry.hidden = true;
  locate.className = "secondary-button";
  locate.type = "button";
  locate.dataset.role = "locate-audio";
  locate.textContent = "定位回听";
  audio.dataset.role = "audio-preview";
  audio.controls = true;
  audio.hidden = true;
  badge.className = "saved-badge";
  badge.dataset.role = "saved";
  badge.textContent = "已保存";
  actions.append(retry, locate, audio);
  content.append(body, translation, actions);
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
  const retry = item.querySelector<HTMLButtonElement>('[data-role="retry-translation"]');
  const locate = item.querySelector<HTMLButtonElement>('[data-role="locate-audio"]');
  const audio = item.querySelector<HTMLAudioElement>('[data-role="audio-preview"]');
  if (!order || !body || !translation || !retry || !locate || !audio) {
    throw new Error("Transcript row structure is invalid.");
  }
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
  retry.hidden = segment.translationStatus !== "failed";
  retry.disabled = segment.translationStatus !== "failed";
  retry.onclick = async () => {
    if (retry.disabled) return;
    retry.disabled = true;
    try {
      await retryTranslationSegment(segment);
    } catch (error) {
      controls.error.textContent = `重试第 ${segment.sequence} 段译文失败：${message(error)}`;
      retry.disabled = false;
    }
  };
  locate.onclick = async () => {
    if (locate.disabled) return;
    locate.disabled = true;
    try {
      const location = await locateSegmentAudio(segment);
      if (!location.available || location.path === null) {
        controls.error.textContent = `第 ${segment.sequence} 段暂无可回听音频：${location.reason ?? "raw audio 未保存"}`;
        audio.hidden = true;
        audio.removeAttribute("src");
        return;
      }
      audio.src = convertFileSrc(location.path);
      audio.currentTime = Number(BigInt(location.offsetMs ?? "0")) / 1000;
      audio.hidden = false;
      if (audioPreview !== null && audioPreview !== audio) audioPreview.pause();
      audioPreview = audio;
      await audio.play().catch(() => undefined);
    } catch (error) {
      controls.error.textContent = `定位第 ${segment.sequence} 段音频失败：${message(error)}`;
    } finally {
      locate.disabled = false;
    }
  };
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
  const sourceMode = currentSourceMode();
  const sourceReady =
    (sourceMode !== "system_only" && sourceMode !== "both" ? true : snapshot.system.ready) &&
    (sourceMode !== "microphone_only" && sourceMode !== "both" ? true : snapshot.microphone.ready);
  const ready =
    snapshot.lifecycle === "ready" &&
    snapshot.modelReady &&
    sourceReady &&
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
    preparedAsrModelId !== currentAsrModelId() ||
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
  controls.asrModel.disabled =
    active ||
    languagePreparing ||
    snapshot.lifecycle !== "ready" ||
    !snapshot.modelReady ||
    asrModels.length === 0;
  controls.footerLanguage.textContent = LANGUAGE_LABELS[currentRecognitionLanguage()];
  renderAudioDeviceControls(active);
  renderTranslationControls(active);
  renderOverlayToggle(snapshot);
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
  renderDisk(snapshot);
  controls.createDiagnosticBundle.disabled = active;
  controls.retryFailedTranslations.disabled =
    active ||
    snapshot.meetingId === null ||
    !snapshot.finals.some((segment) => segment.translationStatus === "failed") ||
    latestRetryProgress?.status === "running";
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

async function captionOverlayWindow(): Promise<Window> {
  const overlayWindow = await Window.getByLabel(CAPTION_OVERLAY_WINDOW_LABEL);
  if (overlayWindow === null) {
    throw new Error("CAPTION_OVERLAY_WINDOW_MISSING");
  }
  return overlayWindow;
}

async function syncOverlayState(): Promise<void> {
  overlayVisible = await (await captionOverlayWindow()).isVisible();
  if (latest !== null) renderOverlayToggle(latest);
}

async function setOverlayVisible(visible: boolean): Promise<void> {
  controls.overlayToggle.disabled = true;
  try {
    const overlayWindow = await captionOverlayWindow();
    if (visible) {
      await overlayWindow.show();
    } else {
      await overlayWindow.hide();
    }
    overlayVisible = await overlayWindow.isVisible();
  } finally {
    if (latest !== null) renderOverlayToggle(latest);
  }
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

async function exportMeetingWithOptions(): Promise<void> {
  const meetingId = selectedMeetingId();
  if (meetingId === null) throw new Error("MVP_EXPORT_MEETING_MISSING");
  const options = parseExportOptions({
    formats: Array.from(document.querySelectorAll<HTMLInputElement>('input[name="export-format"]:checked')).map(
      (input) => input.value,
    ),
    includeOriginal: controls.exportOriginal.checked,
    includeTranslation: controls.exportTranslation.checked,
    bilingual: controls.exportBilingual.checked,
    includeSpeaker: controls.exportSpeaker.checked && speakerVersion !== null,
    includeSummary: controls.exportSummary.checked,
    includeTimestamp: controls.exportTimestamp.checked,
    summaryVersion: meetingDetail?.summary?.version ?? summaryJob?.result?.version ?? null,
    speakerVersion:
      controls.exportSpeaker.checked && speakerVersion !== null ? speakerVersion.version : null,
  });
  lastExport = parseMvpExportResult(
    await invoke<unknown>("mvp_export_meeting_options", {
      meetingId,
      targetDir: MVP_EXPORT_TARGET_DIR,
      options,
    }),
  );
  controls.exportStudioStatus.dataset.status = "success";
  controls.exportStudioStatus.textContent = `Exported ${lastExport.artifacts.length} artifact(s).`;
  if (latest) render(latest);
}

async function loadMeetingLibrary(cursor: string | null = null, append = false): Promise<void> {
  controls.libraryRefresh.disabled = true;
  controls.libraryMore.disabled = true;
  try {
    const query = controls.librarySearch.value.trim();
    if (query.length > 0) {
      const page = parseSegmentSearchPage(
        await invoke<unknown>("mvp_search_segments", {
          text: query,
          scopes: ["original", "translation", "summary", "speaker"],
          tagIds: tagFilters(),
          limit: R3_PAGE_SIZE,
          cursor,
        }),
      );
      searchPage =
        append && searchPage !== null
          ? { ...page, hits: [...searchPage.hits, ...page.hits], total: page.total }
          : page;
      meetingPage = null;
      renderMeetingLibrary();
      controls.libraryStatus.textContent = `${searchPage.hits.length}/${searchPage.total} hits · query ${searchPage.elapsedMs} ms`;
      return;
    }
    searchPage = null;
    const page = parseMeetingListPage(
      await invoke<unknown>("mvp_list_meetings", {
        query,
        tags: tagFilters(),
        cursor,
        pageSize: R3_PAGE_SIZE,
      }),
    );
    meetingPage =
      append && meetingPage !== null
        ? { ...page, items: [...meetingPage.items, ...page.items], total: page.total }
        : page;
    renderMeetingLibrary();
  } finally {
    controls.libraryRefresh.disabled = false;
    controls.libraryMore.disabled =
      searchPage !== null
        ? searchPage.nextCursor === null
        : meetingPage?.nextCursor === null;
  }
}

async function loadMeetingDetail(
  meetingId: string,
  segmentId: string | null = null,
  sequence: string | null = null,
): Promise<void> {
  meetingDetail = parseMeetingDetail(await invoke<unknown>("mvp_meeting_detail", { meetingId }));
  latestSpeakerVersion = parseSpeakerVersion(
    await invoke<unknown>("mvp_speaker_latest", { meetingId }),
  );
  speakerVersion = latestSpeakerVersion;
  controls.speakerStatus.dataset.status = "";
  deletePreviewState = null;
  renderMeetingDetail();
  renderDeletePreview();
  if (segmentId !== null || sequence !== null) focusDetailSegment(segmentId, sequence);
  if (latest) render(latest);
}

async function refreshSpeakerVersion(): Promise<void> {
  const meetingId = selectedMeetingId();
  if (meetingId === null) return;
  latestSpeakerVersion = parseSpeakerVersion(await invoke<unknown>("mvp_speaker_latest", { meetingId }));
  speakerVersion = latestSpeakerVersion;
  renderMeetingDetail();
}

async function loadSpeakerVersion(): Promise<void> {
  const meetingId = selectedMeetingId();
  const latestVersion = latestSpeakerVersion;
  if (meetingId === null || latestVersion === null) return;
  const requested = Number(controls.speakerVersionInput.value);
  if (!Number.isSafeInteger(requested) || requested < 1 || requested > latestVersion.version) {
    throw new Error(`SPEAKER_VERSION_RANGE_1_TO_${latestVersion.version}`);
  }
  speakerVersion = parseSpeakerVersion(
    await invoke<unknown>("mvp_speaker_version", { meetingId, version: requested }),
  );
  if (speakerVersion === null) throw new Error("SPEAKER_VERSION_NOT_FOUND");
  controls.speakerStatus.dataset.status = "";
  renderMeetingDetail();
}

async function runSpeakerDiarization(): Promise<void> {
  const meetingId = selectedMeetingId();
  if (meetingId === null) return;
  controls.speakerStatus.dataset.status = "loading";
  controls.speakerStatus.textContent = "Running speaker diarization...";
  renderSpeakerWorkspace();
  const result = parseSpeakerDiarizationResult(
    await invoke<unknown>("mvp_speaker_diarize", { meetingId }),
  );
  if (result.status === "completed") {
    latestSpeakerVersion = parseSpeakerVersion(await invoke<unknown>("mvp_speaker_latest", { meetingId }));
    speakerVersion = latestSpeakerVersion;
    controls.speakerStatus.dataset.status = "completed";
    controls.speakerStatus.textContent = `Speaker diarization completed at version ${result.version}.`;
  } else {
    controls.speakerStatus.dataset.status = result.status;
    controls.speakerStatus.textContent =
      result.status === "unavailable"
        ? `Speaker diarization unavailable: ${result.reason ?? "raw audio is required"}`
        : result.status === "failed"
          ? `Speaker diarization failed: ${result.reason ?? "unknown failure"}`
          : `Speaker diarization skipped: ${result.reason ?? "no eligible transcript finals"}`;
  }
  renderMeetingDetail();
}

async function renameSpeaker(): Promise<void> {
  const meetingId = selectedMeetingId();
  if (meetingId === null || speakerVersion === null) return;
  if (latestSpeakerVersion === null || speakerVersion.version !== latestSpeakerVersion.version) {
    throw new Error("SPEAKER_EDIT_REQUIRES_LATEST_VERSION");
  }
  latestSpeakerVersion = parseSpeakerVersion(
    await invoke<unknown>("mvp_speaker_rename", {
      request: {
        meetingId,
        speakerId: controls.speakerRenameId.value,
        displayName: controls.speakerRenameName.value.trim(),
        baseVersion: speakerVersion.version,
        idempotencyKey: idempotencyKey("speaker-rename"),
      },
    }),
  );
  speakerVersion = latestSpeakerVersion;
  controls.speakerRenameName.value = "";
  renderMeetingDetail();
}

async function mergeSpeakers(): Promise<void> {
  const meetingId = selectedMeetingId();
  if (meetingId === null || speakerVersion === null) return;
  if (latestSpeakerVersion === null || speakerVersion.version !== latestSpeakerVersion.version) {
    throw new Error("SPEAKER_EDIT_REQUIRES_LATEST_VERSION");
  }
  latestSpeakerVersion = parseSpeakerVersion(
    await invoke<unknown>("mvp_speaker_merge", {
      request: {
        meetingId,
        fromSpeakerId: controls.speakerMergeFrom.value,
        intoSpeakerId: controls.speakerMergeInto.value,
        displayName: controls.speakerMergeName.value.trim() || null,
        baseVersion: speakerVersion.version,
        idempotencyKey: idempotencyKey("speaker-merge"),
      },
    }),
  );
  speakerVersion = latestSpeakerVersion;
  controls.speakerMergeName.value = "";
  renderMeetingDetail();
}

async function undoSpeakerEdit(): Promise<void> {
  const meetingId = selectedMeetingId();
  if (meetingId === null || speakerVersion === null) return;
  if (latestSpeakerVersion === null || speakerVersion.version !== latestSpeakerVersion.version) {
    throw new Error("SPEAKER_EDIT_REQUIRES_LATEST_VERSION");
  }
  latestSpeakerVersion = parseSpeakerVersion(
    await invoke<unknown>("mvp_speaker_undo", {
      request: {
        meetingId,
        baseVersion: speakerVersion.version,
        idempotencyKey: idempotencyKey("speaker-undo"),
      },
    }),
  );
  speakerVersion = latestSpeakerVersion;
  renderMeetingDetail();
}

function focusDetailSegment(segmentId: string | null, sequence: string | null): void {
  const selector =
    segmentId !== null
      ? `[data-segment-id="${CSS.escape(segmentId)}"]`
      : sequence !== null
        ? `[data-sequence="${CSS.escape(sequence)}"]`
        : "";
  const target =
    selector.length === 0 ? null : controls.detailSegments.querySelector<HTMLElement>(selector);
  target?.scrollIntoView({ block: "center" });
  if (target !== null) {
    for (const row of controls.detailSegments.querySelectorAll<HTMLElement>("[data-focused]")) {
      delete row.dataset.focused;
    }
    target.dataset.focused = "true";
    target.focus({ preventScroll: true });
  }
}

async function saveMeetingTags(): Promise<void> {
  const meetingId = selectedMeetingId();
  if (meetingId === null) return;
  meetingDetail = parseMeetingDetail(
    await invoke<unknown>("mvp_update_meeting_tags", {
      meetingId,
      tags: controls.detailTags.value
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
    }),
  );
  renderMeetingDetail();
  await loadMeetingLibrary(null, false).catch(() => undefined);
}

async function loadProviderProfiles(): Promise<void> {
  providerProfiles = parseProviderProfiles(await invoke<unknown>("mvp_provider_profiles"));
  if (
    selectedProviderId === null ||
    !providerProfiles.some((profile) => profile.profileId === selectedProviderId)
  ) {
    selectedProviderId = providerProfiles[0]?.profileId ?? null;
  }
  renderProviderProfiles();
}

function currentProviderDraft(): ProviderProfileDraft {
  const selected = providerProfiles.find((profile) => profile.profileId === selectedProviderId);
  if (selected === undefined) throw new Error("MVP_PROVIDER_PROFILE_MISSING");
  return parseProviderProfileDraft({
    profileId: selected.profileId,
    label: selected.label,
    class: selected.class,
    baseUrl: controls.providerBaseUrl.value.trim(),
    model: controls.providerModel.value.trim(),
    policyUrl: controls.providerPolicyUrl.value.trim() || null,
    dataFlow: controls.providerDataFlow.value.trim(),
    configVersion: selected.configVersion,
  });
}

async function saveProviderProfile(): Promise<void> {
  const profile = currentProviderDraft();
  providerProfiles = parseProviderProfiles(
    await invoke<unknown>("mvp_save_provider_profile", { profile }),
  );
  selectedProviderId = profile.profileId;
  controls.providerStatus.dataset.status = "success";
  controls.providerStatus.textContent = "Provider profile saved; config version refreshed.";
  renderProviderProfiles();
}

async function saveProviderSecret(): Promise<void> {
  if (selectedProviderId === null) return;
  await invoke<unknown>("mvp_set_provider_secret", {
    profileId: selectedProviderId,
    secret: controls.providerSecret.value,
  });
  controls.providerSecret.value = "";
  controls.providerStatus.dataset.status = "success";
  controls.providerStatus.textContent = "Secret stored in the OS credential vault.";
  await loadProviderProfiles();
}

async function deleteProviderSecret(): Promise<void> {
  if (selectedProviderId === null) return;
  await invoke<unknown>("mvp_delete_provider_secret", {
    profileId: selectedProviderId,
  });
  controls.providerSecret.value = "";
  await loadProviderProfiles();
  controls.providerStatus.dataset.status = "success";
  controls.providerStatus.textContent = "Secret removed from the OS credential vault.";
}

async function testSelectedProvider(): Promise<void> {
  if (selectedProviderId === null) return;
  const probe = parseTranslationProbe(
    await invoke<unknown>("mvp_test_provider", { profileId: selectedProviderId }),
  );
  controls.providerStatus.dataset.status = "success";
  controls.providerStatus.textContent = `Provider OK · ${probe.model} · ${probe.latencyMs} ms · ${probe.preview}`;
  await loadProviderProfiles();
}

async function previewDelete(): Promise<void> {
  const meetingId = selectedMeetingId();
  if (meetingId === null) return;
  deletePreviewState = parseDeletePreview(
    await invoke<unknown>("mvp_delete_preview", {
      meetingId,
      includeRaw: true,
      includeDerived: true,
    }),
  );
  renderDeletePreview();
}

async function executeDelete(): Promise<void> {
  const preview = deletePreviewState;
  if (preview === null) return;
  const result = parseDeleteResult(
    await invoke<unknown>("mvp_delete_execute", {
      meetingId: preview.meetingId,
      recoveryWindowSeconds: preview.recoveryWindowSeconds,
      includeRaw: preview.includeRaw,
      includeDerived: preview.includeDerived,
    }),
  );
  controls.deleteStatus.dataset.status = "success";
  controls.deleteStatus.textContent = `Deleted ${result.entriesDeleted} entries · ${formatBytes(result.bytesDeleted)}${result.restoredUntil ? ` · restorable until ${result.restoredUntil}` : ""}`;
  await loadMeetingLibrary(null, false).catch(() => undefined);
}

async function restoreDeletedMeeting(): Promise<void> {
  const meetingId = deletePreviewState?.meetingId ?? selectedMeetingId();
  if (meetingId === null) return;
  const result = parseDeleteResult(await invoke<unknown>("mvp_delete_restore", { meetingId }));
  controls.deleteStatus.dataset.status = "success";
  controls.deleteStatus.textContent = result.deleted ? "Restore did not complete." : "Meeting restored.";
  deletePreviewState = null;
  renderDeletePreview();
  await loadMeetingLibrary(null, false).catch(() => undefined);
}

async function startSummaryJob(): Promise<void> {
  const meetingId = selectedMeetingId();
  if (meetingId === null) return;
  summaryJob = parseSummaryJob(
    await invoke<unknown>("mvp_summary_start", {
      meetingId,
      providerProfileId: selectedProviderId,
      language: "zh",
    }),
  );
  renderSummaryJob();
  scheduleSummaryPoll();
}

async function updateSummaryJob(command: "mvp_summary_cancel" | "mvp_summary_retry"): Promise<void> {
  if (summaryJob === null) return;
  summaryJob = parseSummaryJob(await invoke<unknown>(command, { jobId: summaryJob.jobId }));
  renderSummaryJob();
  scheduleSummaryPoll();
}

function scheduleSummaryPoll(): void {
  if (summaryPollTimer !== null) window.clearTimeout(summaryPollTimer);
  if (
    summaryJob === null ||
    !["queued", "chunking", "combining"].includes(summaryJob.status)
  ) {
    return;
  }
  summaryPollTimer = window.setTimeout(async () => {
    try {
      summaryJob = parseSummaryJob(
        await invoke<unknown>("mvp_summary_status", { jobId: summaryJob?.jobId }),
      );
      renderSummaryJob();
      scheduleSummaryPoll();
    } catch (error) {
      controls.summaryOutput.textContent = `Summary status failed: ${message(error)}`;
    }
  }, 750);
}

async function transcriptTextForMeeting(meetingId: string): Promise<string> {
  return parseMvpTranscriptText(
    await invoke<unknown>("mvp_transcript_text", {
      meetingId,
    }),
  );
}

function formatBytes(bytes: string): string {
  const value = Number(BigInt(bytes));
  if (!Number.isFinite(value)) return `${bytes} B`;
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function renderDisk(snapshot: MvpSnapshot): void {
  controls.diskFree.textContent = formatBytes(snapshot.disk.freeBytes);
  controls.diskWarning.dataset.status = snapshot.disk.status;
  controls.diskWarning.textContent =
    snapshot.disk.warning ??
    `数据目录 ${snapshot.disk.dataDir}；启动预留 ${formatBytes(snapshot.disk.requiredBytes)}。`;
}

function renderRetryProgress(progress: TranslationRetryProgress | null): void {
  latestRetryProgress = progress;
  const running = progress?.status === "running";
  controls.cancelTranslationBatch.disabled = !running;
  controls.retryProgress.dataset.status = progress?.status ?? "idle";
  controls.retryProgress.textContent =
    progress === null || progress.status === "idle"
      ? "无批量重试任务。"
      : `批量重试 ${progress.status}：${progress.progress}/${progress.total}，成功 ${progress.succeeded}，失败 ${progress.failed}，取消 ${progress.cancelled}${progress.message ? `；${progress.message}` : ""}`;
  if (!running && retryProgressTimer !== null) {
    window.clearTimeout(retryProgressTimer);
    retryProgressTimer = null;
  }
}

function scheduleRetryProgressPoll(): void {
  if (retryProgressTimer !== null) window.clearTimeout(retryProgressTimer);
  retryProgressTimer = window.setTimeout(async () => {
    try {
      renderRetryProgress(
        parseTranslationRetryProgress(await invoke<unknown>("mvp_translation_retry_progress")),
      );
    } catch (error) {
      controls.retryProgress.dataset.status = "failed";
      controls.retryProgress.textContent = `读取批量重试进度失败：${message(error)}`;
      retryProgressTimer = null;
      return;
    }
    if (latestRetryProgress?.status === "running") scheduleRetryProgressPoll();
    if (latest) render(await call("mvp_snapshot"));
  }, 500);
}

function renderRecoveryCenter(): void {
  if (interruptedMeetings.length === 0) {
    const item = document.createElement("li");
    item.className = "interrupted-empty";
    item.textContent = "暂无需要处理的中断会议。";
    controls.interruptedMeetings.replaceChildren(item);
    return;
  }
  controls.interruptedMeetings.replaceChildren(
    ...interruptedMeetings.map((meeting) => {
      const item = document.createElement("li");
      item.dataset.meetingId = meeting.meetingId;
      const summary = document.createElement("div");
      const title = document.createElement("strong");
      const meta = document.createElement("span");
      const actions = document.createElement("div");
      title.textContent = meeting.meetingId;
      meta.textContent = `已保存 ${meeting.savedFinalCount}，待收口 ${meeting.pendingFinalCount}，失败译文 ${meeting.translationFailedCount}${meeting.reason ? `；${meeting.reason}` : ""}`;
      summary.append(title, meta);
      actions.className = "interrupted-actions";
      for (const [label, command] of [
        ["恢复", "mvp_recover_meeting"],
        ["完成收口", "mvp_finalize_interrupted"],
        ["保留中断", "mvp_keep_interrupted"],
      ] as const) {
        const button = document.createElement("button");
        button.className = "secondary-button";
        button.type = "button";
        button.textContent = label;
        button.disabled = busyInterruptedMeetingIds.has(meeting.meetingId);
        button.addEventListener("click", async () => {
          if (busyInterruptedMeetingIds.has(meeting.meetingId)) return;
          busyInterruptedMeetingIds = new Set(busyInterruptedMeetingIds).add(meeting.meetingId);
          renderRecoveryCenter();
          try {
            render(await call(command, { meetingId: meeting.meetingId }));
            await refreshInterruptedMeetings();
          } catch (error) {
            controls.error.textContent = `${label}中断会议失败：${message(error)}`;
          } finally {
            const next = new Set(busyInterruptedMeetingIds);
            next.delete(meeting.meetingId);
            busyInterruptedMeetingIds = next;
            renderRecoveryCenter();
          }
        });
        actions.append(button);
      }
      item.append(summary, actions);
      return item;
    }),
  );
}

async function refreshInterruptedMeetings(): Promise<void> {
  controls.refreshInterrupted.disabled = true;
  try {
    interruptedMeetings = parseInterruptedMeetings(
      await invoke<unknown>("mvp_interrupted_meetings"),
    );
    renderRecoveryCenter();
  } finally {
    controls.refreshInterrupted.disabled = false;
  }
}

async function retryTranslationSegment(segment: TranscriptSegment): Promise<void> {
  const meetingId = latest?.meetingId;
  if (meetingId === null || meetingId === undefined) return;
  const providerProfileId = await persistTranslationProviderProfile();
  if (providerProfileId === null) throw new Error("TRANSLATION_PROVIDER_PROFILE_REQUIRED");
  render(
    await call("mvp_retry_translation_segment", {
      meetingId,
      segmentId: segment.segmentId,
      sequence: segment.sequence,
      sourceLanguage: currentRecognitionLanguage(),
      translation: currentTranslationConfig(),
      providerProfileId,
    }),
  );
  schedulePoll();
}

async function locateSegmentAudio(segment: TranscriptSegment): Promise<SegmentAudioLocation> {
  const meetingId = latest?.meetingId;
  if (meetingId === null || meetingId === undefined) {
    throw new Error("MVP_AUDIO_LOCATION_MEETING_MISSING");
  }
  return parseSegmentAudioLocation(
    await invoke<unknown>("mvp_locate_segment_audio", {
      meetingId,
      segmentId: segment.segmentId,
      sequence: segment.sequence,
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

controls.sourceMode.addEventListener("change", () => {
  if (latest) {
    render(latest);
  } else {
    renderAudioDeviceControls(false);
  }
});

controls.rawAudioEnabled.addEventListener("change", () => {
  if (latest) render(latest);
});

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
  controls.translationModelOptions.replaceChildren();
  translationSettingsChanged();
});

controls.translationBaseUrl.addEventListener("input", () => {
  const matchesPreset = Object.values(TRANSLATION_PROVIDER_URLS).includes(
    controls.translationBaseUrl.value.trim() as (typeof TRANSLATION_PROVIDER_URLS)[keyof typeof TRANSLATION_PROVIDER_URLS],
  );
  if (!matchesPreset) controls.translationProvider.value = "custom";
  controls.translationModelOptions.replaceChildren();
  translationSettingsChanged();
});

controls.translationModel.addEventListener("input", translationSettingsChanged);

controls.discoverLocalModels.addEventListener("click", async () => {
  localModelDiscovering = true;
  controls.translationStatus.dataset.status = "testing";
  controls.translationStatus.textContent = "正在读取本机服务的 /v1/models…";
  if (latest) render(latest);
  try {
    const discovery = parseLocalTranslationDiscovery(
      await invoke<unknown>("mvp_discover_local_translation_models", {
        baseUrl: controls.translationBaseUrl.value.trim(),
      }),
    );
    controls.translationModelOptions.replaceChildren(
      ...discovery.models.map((model) => {
        const option = document.createElement("option");
        option.value = model.id;
        option.label = model.ownedBy === null ? model.id : `${model.id} · ${model.ownedBy}`;
        return option;
      }),
    );
    if (
      controls.translationModel.value.trim().length === 0 ||
      !discovery.models.some((model) => model.id === controls.translationModel.value.trim())
    ) {
      controls.translationModel.value = discovery.models[0].id;
      persistTranslationPreference();
    }
    controls.translationStatus.dataset.status = "success";
    controls.translationStatus.textContent = `发现 ${discovery.models.length} 个 ${discovery.providerFlavor} 本地模型 · ${discovery.latencyMs} ms；已选 ${controls.translationModel.value.trim()}。`;
  } catch (error) {
    controls.translationModelOptions.replaceChildren();
    controls.translationStatus.dataset.status = "error";
    controls.translationStatus.textContent = `本地模型发现失败：${message(error)}`;
  } finally {
    localModelDiscovering = false;
    if (latest) render(latest);
  }
});

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
  controls.translationStatus.textContent = "Token 将在测试或开始时写入 Windows 凭据管理器。";
});

controls.testTranslation.addEventListener("click", async () => {
  translationTesting = true;
  controls.translationStatus.dataset.status = "testing";
  controls.translationStatus.textContent = "正在连接所选服务并请求一条测试译文…";
  if (latest) render(latest);
  try {
    const profileId = await persistTranslationProviderProfile();
    if (profileId === null) throw new Error("TRANSLATION_PROVIDER_PROFILE_REQUIRED");
    const probe = parseTranslationProbe(
      await invoke<unknown>("mvp_test_provider", { profileId }),
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

async function prepareSelectedAsr(): Promise<void> {
  const language = currentRecognitionLanguage();
  const asrModelId = currentAsrModelId();
  if (language === preparedLanguage && asrModelId === preparedAsrModelId) {
    if (latest) render(latest);
    return;
  }
  languagePreparing = true;
  controls.recognitionLanguage.disabled = true;
  controls.asrModel.disabled = true;
  controls.start.disabled = true;
  controls.model.dataset.ready = "false";
  controls.model.textContent = `正在准备 ${LANGUAGE_LABELS[language]} 识别模型…`;
  controls.error.textContent = "";
  let switchError: string | null = null;
  try {
    const snapshot = await call("mvp_prepare_language", { language, asrModelId });
    preparedLanguage = language;
    preparedAsrModelId = asrModelId;
    persistAsrModelPreference();
    render(snapshot);
  } catch (error) {
    controls.recognitionLanguage.value = preparedLanguage;
    renderAsrModelOptions(preparedAsrModelId);
    switchError = `无法切换识别模型：${message(error)}`;
  } finally {
    languagePreparing = false;
    if (latest) render(latest);
    if (switchError !== null) controls.error.textContent = switchError;
  }
}

controls.recognitionLanguage.addEventListener("change", async () => {
  controls.footerLanguage.textContent = LANGUAGE_LABELS[currentRecognitionLanguage()];
  renderAsrModelOptions();
  await prepareSelectedAsr();
});

controls.asrModel.addEventListener("change", async () => {
  await prepareSelectedAsr();
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
    const translationProviderProfileId = await persistTranslationProviderProfile();
    render(
      await call("mvp_start", {
        consentAccepted: controls.consent.checked,
        language: currentRecognitionLanguage(),
        asrModelId: currentAsrModelId(),
        sourceMode: currentSourceMode(),
        rawAudioEnabled: controls.rawAudioEnabled.checked,
        translation: currentTranslationConfig(),
        translationProviderProfileId,
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

controls.overlayToggle.addEventListener("click", async () => {
  try {
    await setOverlayVisible(!overlayVisible);
  } catch (error) {
    controls.error.textContent = `Overlay control failed: ${message(error)}`;
    await syncOverlayState().catch((syncError) => {
      controls.error.textContent = `Overlay control failed: ${message(error)}; state refresh failed: ${message(syncError)}`;
    });
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

controls.libraryRefresh.addEventListener("click", async () => {
  try {
    await loadMeetingLibrary(null, false);
  } catch (error) {
    controls.libraryStatus.dataset.status = "error";
    controls.libraryStatus.textContent = `Library refresh failed: ${message(error)}`;
  }
});

controls.libraryMore.addEventListener("click", async () => {
  const cursor = searchPage?.nextCursor ?? meetingPage?.nextCursor;
  if (cursor === null || cursor === undefined) return;
  try {
    await loadMeetingLibrary(cursor, true);
  } catch (error) {
    controls.libraryStatus.dataset.status = "error";
    controls.libraryStatus.textContent = `Next page failed: ${message(error)}`;
  }
});

for (const input of [controls.librarySearch, controls.libraryTags]) {
  input.addEventListener("change", async () => {
    try {
      await loadMeetingLibrary(null, false);
    } catch (error) {
      controls.libraryStatus.dataset.status = "error";
      controls.libraryStatus.textContent = `Filter failed: ${message(error)}`;
    }
  });
}

controls.detailSaveTags.addEventListener("click", async () => {
  controls.detailSaveTags.disabled = true;
  try {
    await saveMeetingTags();
  } catch (error) {
    controls.libraryStatus.dataset.status = "error";
    controls.libraryStatus.textContent = `Save tags failed: ${message(error)}`;
  } finally {
    controls.detailSaveTags.disabled = meetingDetail === null;
  }
});

controls.detailSequence.addEventListener("change", () => {
  const sequence = controls.detailSequence.value.trim();
  if (sequence.length === 0) return;
  focusDetailSegment(null, sequence);
});

controls.speakerRun.addEventListener("click", async () => {
  controls.speakerRun.disabled = true;
  try {
    await runSpeakerDiarization();
  } catch (error) {
    controls.speakerStatus.dataset.status = "failed";
    controls.speakerStatus.textContent = `Speaker diarization failed: ${message(error)}`;
  } finally {
    renderSpeakerWorkspace();
  }
});

controls.speakerRefresh.addEventListener("click", async () => {
  controls.speakerRefresh.disabled = true;
  try {
    await refreshSpeakerVersion();
  } catch (error) {
    controls.speakerStatus.dataset.status = "failed";
    controls.speakerStatus.textContent = `Speaker refresh failed: ${message(error)}`;
  } finally {
    renderSpeakerWorkspace();
  }
});

controls.speakerLoadVersion.addEventListener("click", async () => {
  controls.speakerLoadVersion.disabled = true;
  try {
    await loadSpeakerVersion();
  } catch (error) {
    controls.speakerStatus.dataset.status = "failed";
    controls.speakerStatus.textContent = `Speaker version load failed: ${message(error)}`;
  } finally {
    renderSpeakerWorkspace();
  }
});

controls.speakerRenameForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  controls.speakerRename.disabled = true;
  try {
    await renameSpeaker();
  } catch (error) {
    controls.speakerStatus.dataset.status = "failed";
    controls.speakerStatus.textContent = `Speaker rename failed: ${message(error)}`;
  } finally {
    renderSpeakerWorkspace();
  }
});

controls.speakerMergeForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  controls.speakerMerge.disabled = true;
  try {
    await mergeSpeakers();
  } catch (error) {
    controls.speakerStatus.dataset.status = "failed";
    controls.speakerStatus.textContent = `Speaker merge failed: ${message(error)}`;
  } finally {
    renderSpeakerWorkspace();
  }
});

controls.speakerUndo.addEventListener("click", async () => {
  controls.speakerUndo.disabled = true;
  try {
    await undoSpeakerEdit();
  } catch (error) {
    controls.speakerStatus.dataset.status = "failed";
    controls.speakerStatus.textContent = `Speaker undo failed: ${message(error)}`;
  } finally {
    renderSpeakerWorkspace();
  }
});

controls.providerRefresh.addEventListener("click", async () => {
  try {
    await loadProviderProfiles();
  } catch (error) {
    controls.providerStatus.dataset.status = "error";
    controls.providerStatus.textContent = `Provider refresh failed: ${message(error)}`;
  }
});

controls.providerSaveSecret.addEventListener("click", async () => {
  controls.providerSaveSecret.disabled = true;
  try {
    await saveProviderSecret();
  } catch (error) {
    controls.providerStatus.dataset.status = "error";
    controls.providerStatus.textContent = `Secret save failed: ${message(error)}`;
  } finally {
    renderProviderProfiles();
  }
});

controls.providerRemoveSecret.addEventListener("click", async () => {
  controls.providerRemoveSecret.disabled = true;
  controls.providerStatus.dataset.status = "testing";
  controls.providerStatus.textContent = "Removing selected provider secret...";
  let removed = false;
  try {
    await deleteProviderSecret();
    removed = true;
  } catch (error) {
    controls.providerStatus.dataset.status = "error";
    controls.providerStatus.textContent = `Secret removal failed: ${message(error)}`;
  } finally {
    if (!removed) renderProviderProfiles();
  }
});

controls.providerSaveProfile.addEventListener("click", async () => {
  controls.providerSaveProfile.disabled = true;
  try {
    await saveProviderProfile();
  } catch (error) {
    controls.providerStatus.dataset.status = "error";
    controls.providerStatus.textContent = `Profile save failed: ${message(error)}`;
  } finally {
    renderProviderProfiles();
  }
});

controls.providerTest.addEventListener("click", async () => {
  controls.providerTest.disabled = true;
  controls.providerStatus.dataset.status = "testing";
  controls.providerStatus.textContent = "Testing selected provider...";
  try {
    await testSelectedProvider();
  } catch (error) {
    controls.providerStatus.dataset.status = "error";
    controls.providerStatus.textContent = `Provider test failed: ${message(error)}`;
  } finally {
    renderProviderProfiles();
  }
});

controls.deletePreview.addEventListener("click", async () => {
  try {
    await previewDelete();
  } catch (error) {
    controls.deleteStatus.dataset.status = "error";
    controls.deleteStatus.textContent = `Delete preview failed: ${message(error)}`;
  }
});

controls.deleteExecute.addEventListener("click", async () => {
  controls.deleteExecute.disabled = true;
  try {
    await executeDelete();
  } catch (error) {
    controls.deleteStatus.dataset.status = "error";
    controls.deleteStatus.textContent = `Delete failed: ${message(error)}`;
  } finally {
    renderDeletePreview();
  }
});

controls.deleteRestore.addEventListener("click", async () => {
  try {
    await restoreDeletedMeeting();
  } catch (error) {
    controls.deleteStatus.dataset.status = "error";
    controls.deleteStatus.textContent = `Restore failed: ${message(error)}`;
  }
});

controls.summaryStart.addEventListener("click", async () => {
  controls.summaryStart.disabled = true;
  try {
    await startSummaryJob();
  } catch (error) {
    controls.summaryOutput.textContent = `Summary start failed: ${message(error)}`;
  } finally {
    if (latest) render(latest);
  }
});

controls.summaryCancel.addEventListener("click", async () => {
  try {
    await updateSummaryJob("mvp_summary_cancel");
  } catch (error) {
    controls.summaryOutput.textContent = `Summary cancel failed: ${message(error)}`;
  }
});

controls.summaryRetry.addEventListener("click", async () => {
  try {
    await updateSummaryJob("mvp_summary_retry");
  } catch (error) {
    controls.summaryOutput.textContent = `Summary retry failed: ${message(error)}`;
  }
});

controls.exportSelected.addEventListener("click", async () => {
  controls.exportSelected.disabled = true;
  controls.exportStudioStatus.dataset.status = "loading";
  controls.exportStudioStatus.textContent = "Exporting selected artifacts...";
  try {
    await exportMeetingWithOptions();
  } catch (error) {
    controls.exportStudioStatus.dataset.status = "error";
    controls.exportStudioStatus.textContent = `Selected export failed: ${message(error)}`;
  } finally {
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

controls.createDiagnosticBundle.addEventListener("click", async () => {
  controls.createDiagnosticBundle.disabled = true;
  controls.diagnosticStatus.dataset.status = "loading";
  controls.diagnosticStatus.textContent = "正在生成脱敏诊断包...";
  try {
    diagnosticBundle = parseDiagnosticBundleResult(
      await invoke<unknown>("mvp_create_diagnostic_bundle"),
    );
    controls.diagnosticStatus.dataset.status = "success";
    controls.diagnosticStatus.textContent = `诊断包已生成：${diagnosticBundle.path} · ${diagnosticBundle.byteLength} bytes`;
  } catch (error) {
    diagnosticBundle = null;
    controls.diagnosticStatus.dataset.status = "error";
    controls.diagnosticStatus.textContent = `诊断包生成失败：${message(error)}`;
  } finally {
    controls.createDiagnosticBundle.disabled = latest !== null && isActive(latest);
  }
});

controls.retryFailedTranslations.addEventListener("click", async () => {
  const snapshot = latest;
  if (snapshot?.meetingId === null || snapshot?.meetingId === undefined) return;
  const failedCount = snapshot.finals.filter((segment) => segment.translationStatus === "failed").length;
  if (failedCount === 0) return;
  const accepted = window.confirm(
    `将重新发送本场 ${failedCount} 条失败 final 原文到所选翻译服务，可能产生额外费用。确认继续？`,
  );
  if (!accepted) return;
  controls.retryFailedTranslations.disabled = true;
  controls.retryProgress.dataset.status = "running";
  controls.retryProgress.textContent = "正在提交批量重试...";
  try {
    const providerProfileId = await persistTranslationProviderProfile();
    if (providerProfileId === null) throw new Error("TRANSLATION_PROVIDER_PROFILE_REQUIRED");
    renderRetryProgress(
      parseTranslationRetryProgress(
        await invoke<unknown>("mvp_retry_failed_translations", {
          meetingId: snapshot.meetingId,
          sourceLanguage: currentRecognitionLanguage(),
          translation: currentTranslationConfig(),
          providerProfileId,
          costRiskAccepted: true,
        }),
      ),
    );
    scheduleRetryProgressPoll();
  } catch (error) {
    controls.retryProgress.dataset.status = "failed";
    controls.retryProgress.textContent = `批量重试提交失败：${message(error)}`;
  } finally {
    if (latest) render(latest);
  }
});

controls.cancelTranslationBatch.addEventListener("click", async () => {
  if (latestRetryProgress?.status !== "running") return;
  controls.cancelTranslationBatch.disabled = true;
  try {
    renderRetryProgress(
      parseTranslationRetryProgress(await invoke<unknown>("mvp_cancel_translation_batch")),
    );
    if (latest) render(await call("mvp_snapshot"));
  } catch (error) {
    controls.retryProgress.dataset.status = "failed";
    controls.retryProgress.textContent = `取消批量重试失败：${message(error)}`;
    controls.cancelTranslationBatch.disabled = false;
  }
});

controls.refreshInterrupted.addEventListener("click", async () => {
  try {
    await refreshInterruptedMeetings();
  } catch (error) {
    controls.error.textContent = `刷新中断会议失败：${message(error)}`;
  }
});

applyTranslationPreference(readTranslationPreference());
renderTranslationControls(false);
renderRetryProgress(null);
renderRecoveryCenter();

void (async () => {
  await syncOverlayState().catch((error) => {
    controls.error.textContent = `Overlay window unavailable: ${message(error)}`;
  });
  await loadAsrModels()
    .then(() => {
      preparedAsrModelId = null;
    })
    .catch((error) => {
      controls.error.textContent = `ASR model registry unavailable: ${message(error)}`;
    });
  try {
    await loadAudioDevices();
  } catch (error) {
    audioDeviceLoadError = message(error);
    renderAudioDeviceControls(false);
  }
  try {
    render(await call("mvp_preflight"));
    if (preparedAsrModelId !== currentAsrModelId()) {
      await prepareSelectedAsr();
    }
  } catch (error) {
    controls.lifecycle.textContent = "ERROR";
    controls.lifecycle.dataset.state = "error";
    controls.model.textContent = "本地服务未就绪";
    controls.error.textContent = `预检失败：${message(error)}`;
  }
  try {
    await refreshInterruptedMeetings();
  } catch {
    // Recovery center stays usable after the backend command is registered.
  }
  await loadMeetingLibrary(null, false).catch((error) => {
    controls.libraryStatus.dataset.status = "error";
    controls.libraryStatus.textContent = `Library unavailable: ${message(error)}`;
  });
  await loadProviderProfiles().catch((error) => {
    controls.providerStatus.dataset.status = "error";
    controls.providerStatus.textContent = `Provider registry unavailable: ${message(error)}`;
  });
})();
