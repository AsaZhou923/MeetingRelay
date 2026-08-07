import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Window } from "@tauri-apps/api/window";

import {
  beginStartUiState,
  canBeginStart,
  finishStartUiState,
  mergeProbeStates,
  nextTranscriptFollowState,
  returnToLatest,
  selectLatestTranscriptLine,
  translationOnlyText,
  type ProbeUiState,
  type StartUiState,
  type TranscriptFollowState,
} from "./frontend-state";
import {
  AUDIO_DEVICE_PREFERENCE_KEY,
  APP_PREFERENCE_KEY,
  MAX_INFERENCE_QUEUE_DEPTH,
  TRANSLATION_PREFERENCE_KEY,
  formatMvpErrorMessage,
  formatMvpSnapshotError,
  formatElapsed,
  hasCompleteMvpTranscript,
  hasAllMvpExportFormats,
  isMvpActiveSession,
  isWindowsAbsoluteDirectory,
  parseDeletePreview,
  parseDeleteResult,
  parseDataDirectorySettings,
  parseExportOptions,
  parseMeetingDetail,
  parseMeetingListPage,
  parseMvpTranscriptText,
  parseAudioDeviceInventory,
  parseAudioDevicePreference,
  parseAppPreference,
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
  type DataDirectorySettings,
  type MeetingDetail,
  type MeetingListPage,
  type MvpExportResult,
  type MvpAudioSourceMode,
  type MvpRecognitionLanguage,
  type MvpSnapshot,
  type MvpTranscriptDisplayMode,
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
  <a class="skip-link" href="#transcript-title">跳到实时文字</a>
  <main id="main-content" class="relay-shell">
    <header class="masthead">
      <div class="brand-lockup">
        <p class="kicker">本地会议转写 / Windows</p>
        <h1>Meeting<span>Relay</span></h1>
      </div>
      <nav class="primary-nav" aria-label="主导航">
        <button class="primary-nav-button" type="button" data-view="live" aria-pressed="true">实时会议</button>
        <button class="primary-nav-button" type="button" data-view="records" aria-pressed="false">会议记录</button>
        <button class="primary-nav-button" type="button" data-view="settings" aria-pressed="false">设置</button>
      </nav>
      <div class="privacy-stamp" aria-label="隐私与存储模式">
        <span class="privacy-dot"></span>
        <span><strong>本地识别</strong>音频与记录留在此电脑；启用云端翻译时，仅确认后的原文发往所选服务</span>
      </div>
    </header>

    <section id="live-view" class="app-view" data-view-panel="live">
    <section class="workspace">
      <aside class="control-rail" aria-label="会议控制与输入设置">
        <div class="rail-index">01 / 会前检查</div>
        <h2>开始会议</h2>

        <label class="consent-row">
          <input id="consent" type="checkbox" />
          <span>我确认本次会议允许录音转写，并同意原文与可用译文保存在本机；启用翻译时，确认后的原文会发送给所选服务，其中第三方云端服务受其隐私与计费规则约束。</span>
        </label>

        <div class="session-control-dock">
          <div class="session-actions">
            <button id="start" class="start-button" type="button" disabled>
              <span class="record-mark"></span>开始实时转写
            </button>
            <button id="pause-resume" class="pause-button" type="button" disabled>暂停转写</button>
            <button id="stop" class="stop-button" type="button" disabled>结束会议</button>
          </div>
          <p id="start-status" class="start-status" aria-live="polite" aria-atomic="true"></p>
          <p id="error" class="error-line" role="alert"></p>
        </div>

        <div class="rail-index input-section-index">02 / 声音源</div>
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
            <span>保存原始音频（默认关闭）</span>
          </label>
          <p id="device-status" class="device-status" aria-live="polite">正在读取 Windows 音频设备…</p>
        </div>
        <div id="source-system" class="source-card" data-status="booting">
          <div class="source-heading">
            <span class="source-glyph">SYS</span>
            <div><strong>电脑播放声音</strong><small id="system-label">正在检测默认输出</small></div>
          </div>
          <div class="level-track"><i id="system-level"></i></div>
          <div class="source-meta"><span id="system-status">检测中</span><span id="system-frames">0 帧</span></div>
        </div>
        <div id="source-microphone" class="source-card" data-status="booting">
          <div class="source-heading">
            <span class="source-glyph">MIC</span>
            <div><strong>麦克风</strong><small id="microphone-label">正在检测默认输入</small></div>
          </div>
          <div class="level-track"><i id="microphone-level"></i></div>
          <div class="source-meta"><span id="microphone-status">检测中</span><span id="microphone-frames">0 帧</span></div>
        </div>

        <div class="model-line">
          <span>识别模型</span>
          <strong id="model-status">正在校验本地模型…</strong>
        </div>

        <section class="translation-panel" aria-label="OpenAI-compatible 翻译">
          <div class="translation-heading">
            <div>
              <div class="rail-index">02 / 翻译</div>
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
              <small>API Token 和确认后的原文将以明文传输，可能被网络中的第三方读取或篡改。</small>
            </span>
          </label>
          <div class="translation-actions">
            <button id="test-translation" class="secondary-button" type="button">测试连接</button>
            <p id="translation-status" aria-live="polite">关闭；原文照常保存。</p>
          </div>
          <small class="translation-privacy">本机回环地址可直接使用 HTTP；远程 HTTP 必须显式确认风险，仍建议优先配置 HTTPS。API Token 不写入普通设置或 SQLite；测试/开始时保存到 Windows Credential Manager。</small>
        </section>

        <section class="storage-panel" aria-label="本地持久化存储">
          <div class="rail-index">03 / 存储</div>
          <div class="storage-row">
            <span id="storage-indicator" class="storage-indicator" data-status="initializing"></span>
            <div>
              <strong id="storage-status">初始化本地持久化</strong>
              <small id="storage-detail">确认后的文字只在 SQLite 提交成功后显示为已保存。</small>
            </div>
          </div>
          <dl class="storage-metrics">
            <div><dt>已保存</dt><dd id="saved-count">0</dd></div>
            <div><dt>可见窗口</dt><dd id="visible-window">0 / 0</dd></div>
            <div><dt>会议</dt><dd id="meeting-id">未打开</dd></div>
            <div><dt>磁盘可用</dt><dd id="disk-free">检测中</dd></div>
          </dl>
          <p id="disk-warning" class="disk-warning" aria-live="polite"></p>
          <div class="data-directory-settings">
            <label class="device-picker">
              <span>主数据目录</span>
              <input id="data-directory" type="text" placeholder="例如 D:\\MeetingRelay Data" spellcheck="false" />
              <small>保存后从下次启动开始使用；不会自动移动旧目录中的数据库、录音或导出文件。</small>
            </label>
            <button id="save-data-directory" class="secondary-button" type="button">保存数据目录</button>
            <p id="data-directory-status" class="copy-status" aria-live="polite"></p>
          </div>
          <div class="live-text-settings">
            <label class="raw-audio-toggle">
              <input id="live-text-enabled" type="checkbox" />
              <span>同时实时写入 TXT（默认关闭）</span>
            </label>
            <label class="device-picker">
              <span>实时 TXT 目录</span>
              <input id="live-text-directory" type="text" placeholder="例如 C:\\Users\\你\\Documents\\MeetingRelay" spellcheck="false" />
              <small>填写已存在的绝对目录；每场会议创建独立文件。只有 SQLite 提交成功的确认原文才会追加写入。</small>
            </label>
            <p id="live-text-status" class="copy-status" aria-live="polite"></p>
          </div>
          <button id="create-diagnostic-bundle" class="secondary-button" type="button">生成最小诊断包</button>
          <p id="diagnostic-status" class="copy-status" aria-live="polite"></p>
        </section>

        <section class="retry-panel" aria-label="译文重试">
          <div class="rail-index">04 / 译文重试</div>
          <button id="retry-failed-translations" class="secondary-button" type="button" disabled>重试本场失败译文</button>
          <button id="cancel-translation-batch" class="secondary-button" type="button" disabled>取消批量重试</button>
          <p id="retry-progress" class="retry-progress" aria-live="polite">无批量重试任务。</p>
        </section>

        <section class="recovery-panel" aria-label="中断会议恢复">
          <div class="rail-index">05 / 恢复</div>
          <button id="refresh-interrupted" class="secondary-button" type="button">刷新中断会议</button>
          <ul id="interrupted-meetings" class="interrupted-meetings" aria-live="polite"></ul>
        </section>

        <section class="history-panel" aria-label="最近会议">
          <div class="rail-index">06 / 最近会议</div>
          <button id="open-recent" class="secondary-button" type="button" disabled>重新打开最近会议</button>
          <p id="recent-summary" class="recent-summary">暂无已打开会议。</p>
        </section>
      </aside>

      <section class="transcript-stage" aria-labelledby="transcript-title">
        <div class="stage-heading">
          <div class="stage-copy">
            <div class="rail-index">05 / 实时文字</div>
            <h2 id="transcript-title">实时文字</h2>
            <p>原文先持久保存；若启用翻译，译文随后对齐显示，失败不会影响原文。</p>
          </div>
          <div class="session-clock">
            <span id="lifecycle">启动中</span>
            <strong id="elapsed">00:00:00</strong>
            <label class="transcript-display-picker">
              <small>显示</small>
              <select id="transcript-display-mode">
                <option value="source_and_translation">原文 + 译文</option>
                <option value="translation_only">仅显示译文</option>
              </select>
            </label>
            <button id="overlay-toggle" class="secondary-button overlay-toggle" type="button" aria-pressed="false" disabled>显示悬浮字幕</button>
          </div>
        </div>
        <div class="transcript-viewport">
          <div id="empty-state" class="empty-state">
            <div class="signal-art" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>
            <strong>等待会议声音</strong>
            <p>确认设备和识别语言后开始。只有成功写入本地 SQLite 的确认文字才会进入记录。</p>
          </div>
          <ol id="transcript" class="transcript-list" aria-label="已保存的实时转写"></ol>
          <p id="transcript-announcer" class="sr-only" aria-live="polite" aria-atomic="true"></p>
          <button id="follow-latest" class="follow-latest-button" type="button" hidden>
            回到最新
            <span id="new-content-count">0 条新内容</span>
          </button>
          <div id="latest-dock" class="latest-dock" aria-live="polite">
            <div class="latest-dock-meta">
              <strong class="latest-dock-title">最新一句</strong>
              <span id="follow-state">正在跟随最新内容</span>
            </div>
            <p id="latest-line">等待实时文字。</p>
          </div>
          <div id="interim" class="interim-line" hidden>
            <span>正在识别</span>
            <p></p>
          </div>
        </div>
        <section class="export-panel" aria-label="导出">
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
          <span>待处理 <strong id="queue-depth">0 / ${MAX_INFERENCE_QUEUE_DEPTH}</strong></span>
          <span>翻译 <strong id="translation-queue-depth">关闭</strong></span>
          <span>识别语言 <strong id="footer-language">中文 · ZH</strong></span>
          <span>存储 <strong id="footer-storage">初始化</strong></span>
        </footer>
      </section>
    </section>
    </section>
    <section id="records-view" class="app-view secondary-workspace" data-view-panel="records" hidden aria-label="会议记录"></section>
    <section id="settings-view" class="app-view secondary-workspace" data-view-panel="settings" hidden aria-label="设置"></section>
  </main>
`;

element<HTMLElement>(".transcript-stage").insertAdjacentHTML(
  "beforeend",
  `
    <section class="r3r4-console" aria-label="高级工作区">
      <div class="console-grid">
        <section class="console-card library-card">
          <div class="console-heading">
            <div><span>会议记录</span><h3>会议列表</h3></div>
            <button id="library-refresh" class="secondary-button" type="button">刷新</button>
          </div>
          <div class="library-filters">
            <input id="library-search" type="search" placeholder="搜索原文、译文、摘要或说话人" spellcheck="false" />
            <input id="library-tags" type="text" placeholder="标签 1, 标签 2" spellcheck="false" />
          </div>
          <ol id="search-results" class="search-results" aria-live="polite"></ol>
          <ol id="library-list" class="library-list" aria-live="polite"></ol>
          <button id="library-more" class="secondary-button" type="button" disabled>加载下一页</button>
          <p id="library-status" class="copy-status" aria-live="polite"></p>
        </section>

        <section class="console-card detail-card">
          <div class="console-heading">
            <div><span>会议记录</span><h3>会议详情</h3></div>
            <input id="detail-sequence" type="number" min="1" step="1" placeholder="段落编号" />
          </div>
          <div id="detail-summary" class="detail-summary">尚未选择会议。</div>
          <div class="tag-editor">
            <input id="detail-tags" type="text" placeholder="编辑标签，用逗号分隔" spellcheck="false" />
            <button id="detail-save-tags" class="secondary-button" type="button" disabled>保存标签</button>
          </div>
          <section class="speaker-workspace" aria-labelledby="speaker-title">
            <div class="speaker-heading">
              <div>
                <span>说话人</span>
                <h4 id="speaker-title">说话人工作区</h4>
              </div>
              <div class="speaker-actions">
                <button id="speaker-run" class="secondary-button" type="button" disabled>分析说话人</button>
                <button id="speaker-refresh" class="secondary-button" type="button" disabled>刷新</button>
              </div>
            </div>
            <dl class="speaker-version">
              <div><dt>当前版本</dt><dd id="speaker-version">无</dd></div>
              <div><dt>最新版本</dt><dd id="speaker-latest-version">无</dd></div>
              <div><dt>算法</dt><dd id="speaker-algorithm">未运行</dd></div>
              <div><dt>状态</dt><dd id="speaker-status">请选择会议。</dd></div>
            </dl>
            <div class="speaker-version-picker">
              <label>
                <span>读取说话人版本</span>
                <input id="speaker-version-input" type="number" min="1" step="1" inputmode="numeric" disabled />
              </label>
              <button id="speaker-load-version" class="secondary-button" type="button" disabled>读取版本</button>
              <p id="speaker-edit-note">只允许编辑最新版本。</p>
            </div>
            <ol id="speaker-identities" class="speaker-identities" aria-live="polite"></ol>
            <form id="speaker-rename-form" class="speaker-form" aria-label="重命名说话人">
              <label>
                <span>说话人</span>
                <select id="speaker-rename-id" disabled></select>
              </label>
              <label>
                <span>新名称</span>
                <input id="speaker-rename-name" type="text" maxlength="80" spellcheck="false" disabled />
              </label>
              <button id="speaker-rename" class="secondary-button" type="submit" disabled>重命名</button>
            </form>
            <form id="speaker-merge-form" class="speaker-form" aria-label="合并说话人">
              <label>
                <span>从</span>
                <select id="speaker-merge-from" disabled></select>
              </label>
              <label>
                <span>合并到</span>
                <select id="speaker-merge-into" disabled></select>
              </label>
              <label>
                <span>合并后名称</span>
                <input id="speaker-merge-name" type="text" maxlength="80" spellcheck="false" disabled />
              </label>
              <button id="speaker-merge" class="secondary-button" type="submit" disabled>合并</button>
            </form>
            <button id="speaker-undo" class="secondary-button" type="button" disabled>撤销上次编辑</button>
          </section>
          <ol id="detail-segments" class="detail-segments"></ol>
        </section>

        <section class="console-card provider-card">
          <div class="console-heading">
            <div><span>服务设置</span><h3>翻译服务身份</h3></div>
            <button id="provider-refresh" class="secondary-button" type="button">刷新</button>
          </div>
          <div id="provider-list" class="provider-list" aria-live="polite"></div>
          <div class="provider-editor">
            <label><span>Base URL</span><input id="provider-base-url" type="url" spellcheck="false" /></label>
            <label><span>模型</span><input id="provider-model" type="text" spellcheck="false" /></label>
            <label><span>隐私政策 URL</span><input id="provider-policy-url" type="url" spellcheck="false" /></label>
            <label><span>数据流向</span><textarea id="provider-data-flow" rows="3" spellcheck="false"></textarea></label>
          </div>
          <button id="provider-save-profile" class="secondary-button" type="button" disabled>保存服务配置</button>
          <label class="secret-row">
            <span>当前服务密钥</span>
            <input id="provider-secret" type="password" autocomplete="off" spellcheck="false" />
          </label>
          <div class="provider-actions">
            <button id="provider-save-secret" class="secondary-button" type="button" disabled>保存到系统凭据</button>
            <button id="provider-remove-secret" class="secondary-button danger" type="button" disabled>移除系统凭据</button>
            <button id="provider-test" class="secondary-button" type="button" disabled>测试连接</button>
          </div>
          <p id="provider-status" class="copy-status" aria-live="polite"></p>
        </section>

        <section class="console-card governance-card">
          <div class="console-heading">
            <div><span>数据治理</span><h3>保留与删除</h3></div>
            <button id="delete-preview" class="secondary-button" type="button" disabled>预览删除</button>
          </div>
          <ul id="delete-preview-list" class="delete-preview-list"></ul>
          <div class="governance-actions">
            <button id="delete-execute" class="secondary-button danger" type="button" disabled>执行删除</button>
            <button id="delete-restore" class="secondary-button" type="button" disabled>恢复</button>
          </div>
          <p id="delete-status" class="copy-status" aria-live="polite"></p>
        </section>

        <section class="console-card summary-card">
          <div class="console-heading">
            <div><span>摘要</span><h3>中文结构化摘要</h3></div>
            <button id="summary-start" class="secondary-button" type="button" disabled>开始</button>
          </div>
          <label class="device-picker" for="summary-provider">
            <span>摘要服务（必须明确选择）</span>
            <select id="summary-provider">
              <option value="">选择本次摘要服务...</option>
            </select>
          </label>
          <p class="privacy-copy">
            本地服务会把完整会议文字留在此电脑。LAN 和云端服务会接收完整会议文字，可能产生费用，并适用其隐私政策。
          </p>
          <div class="summary-actions">
            <button id="summary-cancel" class="secondary-button" type="button" disabled>取消</button>
            <button id="summary-retry" class="secondary-button" type="button" disabled>重试新版本</button>
          </div>
          <div id="summary-output" class="summary-output">暂无摘要任务。</div>
        </section>

        <section class="console-card export-studio-card">
          <div class="console-heading">
            <div><span>导出</span><h3>导出工作区</h3></div>
            <button id="export-selected" class="secondary-button" type="button" disabled>导出所选内容</button>
          </div>
          <fieldset class="format-grid">
            <legend>导出格式</legend>
            <label><input type="checkbox" name="export-format" value="json" checked /> JSON</label>
            <label><input type="checkbox" name="export-format" value="markdown" checked /> Markdown</label>
            <label><input type="checkbox" name="export-format" value="txt" checked /> TXT</label>
            <label><input type="checkbox" name="export-format" value="docx" /> DOCX</label>
            <label><input type="checkbox" name="export-format" value="pdf" /> PDF</label>
          </fieldset>
          <fieldset class="format-grid">
            <legend>导出内容</legend>
            <label><input id="export-original" type="checkbox" checked /> 原文</label>
            <label><input id="export-translation" type="checkbox" checked /> 译文</label>
            <label><input id="export-bilingual" type="checkbox" checked /> 双语</label>
            <label><input id="export-speaker" type="checkbox" checked aria-describedby="export-speaker-note" /> 说话人 <small id="export-speaker-note">导出说话人标签前，请先分析说话人。</small></label>
            <label><input id="export-summary" type="checkbox" checked /> 摘要</label>
            <label><input id="export-timestamp" type="checkbox" checked /> 时间戳</label>
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
  navButtons: Array.from(document.querySelectorAll<HTMLButtonElement>(".primary-nav-button")),
  liveView: element<HTMLElement>("#live-view"),
  recordsView: element<HTMLElement>("#records-view"),
  settingsView: element<HTMLElement>("#settings-view"),
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
  startStatus: element<HTMLParagraphElement>("#start-status"),
  pauseResume: element<HTMLButtonElement>("#pause-resume"),
  stop: element<HTMLButtonElement>("#stop"),
  error: element<HTMLParagraphElement>("#error"),
  lifecycle: element<HTMLSpanElement>("#lifecycle"),
  elapsed: element<HTMLElement>("#elapsed"),
  transcriptDisplayMode: element<HTMLSelectElement>("#transcript-display-mode"),
  overlayToggle: element<HTMLButtonElement>("#overlay-toggle"),
  model: element<HTMLElement>("#model-status"),
  empty: element<HTMLElement>("#empty-state"),
  transcript: element<HTMLOListElement>("#transcript"),
  transcriptAnnouncer: element<HTMLParagraphElement>("#transcript-announcer"),
  followLatest: element<HTMLButtonElement>("#follow-latest"),
  newContentCount: element<HTMLSpanElement>("#new-content-count"),
  followState: element<HTMLSpanElement>("#follow-state"),
  latestLine: element<HTMLParagraphElement>("#latest-line"),
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
  dataDirectory: element<HTMLInputElement>("#data-directory"),
  saveDataDirectory: element<HTMLButtonElement>("#save-data-directory"),
  dataDirectoryStatus: element<HTMLParagraphElement>("#data-directory-status"),
  liveTextEnabled: element<HTMLInputElement>("#live-text-enabled"),
  liveTextDirectory: element<HTMLInputElement>("#live-text-directory"),
  liveTextStatus: element<HTMLParagraphElement>("#live-text-status"),
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
  summaryProvider: element<HTMLSelectElement>("#summary-provider"),
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
  [controls.systemDevice, "Windows 系统输出设备"],
  [controls.microphoneDevice, "Windows 麦克风设备"],
  [controls.recognitionLanguage, "本次会议识别语言"],
  [controls.asrModel, "本地识别模型"],
  [controls.sourceMode, "会议音源模式"],
  [controls.translationProvider, "翻译服务预设"],
  [controls.translationLanguage, "译文目标语言"],
  [controls.librarySearch, "搜索会议记录"],
  [controls.libraryTags, "按标签筛选会议记录"],
  [controls.detailSequence, "跳转到段落编号"],
  [controls.speakerVersionInput, "要读取的说话人版本号"],
  [controls.speakerRenameId, "要重命名的说话人"],
  [controls.speakerRenameName, "新的说话人显示名称"],
  [controls.speakerMergeFrom, "要合并的来源说话人"],
  [controls.speakerMergeInto, "要合并到的目标说话人"],
  [controls.speakerMergeName, "可选的合并后说话人名称"],
] as const) {
  control.setAttribute("aria-label", label);
}

type AppView = "live" | "records" | "settings";

function appendPanel(parent: HTMLElement, selector: string): void {
  const panel = document.querySelector<HTMLElement>(selector);
  if (panel !== null) parent.append(panel);
}

function organizePrimaryViews(): void {
  appendPanel(controls.recordsView, ".history-panel");
  appendPanel(controls.recordsView, ".retry-panel");
  appendPanel(controls.recordsView, ".recovery-panel");
  appendPanel(controls.recordsView, ".library-card");
  appendPanel(controls.recordsView, ".detail-card");
  appendPanel(controls.recordsView, ".summary-card");
  appendPanel(controls.recordsView, ".export-studio-card");
  appendPanel(controls.recordsView, ".governance-card");
  appendPanel(controls.settingsView, ".translation-panel");
  appendPanel(controls.settingsView, ".storage-panel");
  appendPanel(controls.settingsView, ".provider-card");
  const console = document.querySelector<HTMLElement>(".r3r4-console");
  console?.remove();
}

function setActiveView(view: AppView): void {
  for (const button of controls.navButtons) {
    const active = button.dataset.view === view;
    button.setAttribute("aria-pressed", String(active));
  }
  for (const [panel, panelView] of [
    [controls.liveView, "live"],
    [controls.recordsView, "records"],
    [controls.settingsView, "settings"],
  ] as const) {
    panel.hidden = panelView !== view;
  }
}

organizePrimaryViews();
setActiveView("live");

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
let dataDirectorySettings: DataDirectorySettings | null = null;
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
let preferredProviderProfileId: string | null = null;
let deletePreviewState: DeletePreview | null = null;
let summaryJob: SummaryJob | null = null;
let summaryPollTimer: number | null = null;
let startUiState: StartUiState = { phase: "idle", message: "" };
let transcriptFollowState: TranscriptFollowState = returnToLatest();
let providerProbeStates = new Map<string, ProbeUiState>();
const MVP_EXPORT_TARGET_DIR = "MeetingRelayExports";
const ASR_MODEL_PREFERENCE_KEY = "meetingrelay.asr-model.v1";
const R3_PAGE_SIZE = 50;
const CAPTION_OVERLAY_WINDOW_LABEL = "caption-overlay";
const CAPTION_OVERLAY_HIDDEN_EVENT = "meetingrelay://caption-overlay-hidden";

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
  unknown: "未知",
};
const LIFECYCLE_LABELS: Record<MvpSnapshot["lifecycle"], string> = {
  booting: "启动中",
  ready: "就绪",
  starting: "启动中",
  recording: "录制中",
  paused: "已暂停",
  stopping: "停止中",
  error: "异常",
};
const MEETING_STATUS_LABELS: Record<string, string> = {
  ready: "就绪",
  recording: "录制中",
  paused: "已暂停",
  completed: "已完成",
  interrupted: "已中断",
  error: "异常",
};
const SUMMARY_STATUS_LABELS: Record<string, string> = {
  idle: "无摘要",
  queued: "排队中",
  chunking: "分段中",
  combining: "合并中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
};
const TRANSLATION_STATUS_LABELS: Record<string, string> = {
  disabled: "关闭",
  pending: "待处理",
  completed: "已完成",
  failed: "失败",
  skipped: "已跳过",
};
const SEARCH_SCOPE_LABELS: Record<string, string> = {
  original: "原文",
  translation: "译文",
  summary: "摘要",
  speaker: "说话人",
};
const PROVIDER_CLASS_LABELS: Record<string, string> = {
  local: "本地",
  lan: "局域网",
  cloud: "云端",
};
const SECRET_STATE_LABELS: Record<string, string> = {
  missing: "缺失",
  present: "已保存",
  not_required: "不需要",
  unsupported: "不支持",
};
const PROVIDER_TEST_STATUS_LABELS: Record<string, string> = {
  untested: "未测试",
  passed: "成功",
  failed: "失败",
};

function labelFor(labels: Record<string, string>, value: string | null | undefined): string {
  if (value === null || value === undefined || value.length === 0) return "未知";
  return labels[value] ?? value;
}

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

function renderStartUiState(): void {
  controls.start.dataset.phase = startUiState.phase;
  controls.start.setAttribute("aria-busy", String(startUiState.phase === "running"));
  controls.startStatus.dataset.status = startUiState.phase;
  controls.startStatus.textContent = startUiState.message;
  if (startUiState.phase === "running") {
    controls.start.textContent = "正在启动...";
  } else {
    controls.start.replaceChildren();
    const mark = document.createElement("span");
    mark.className = "record-mark";
    controls.start.append(mark, "开始实时转写");
  }
}

function updateTranscriptFollowControls(): void {
  controls.followLatest.hidden = !transcriptFollowState.showJumpButton;
  controls.newContentCount.textContent = `${transcriptFollowState.unseenCount} 条新内容`;
  controls.followState.textContent = transcriptFollowState.announcement;
  controls.followState.dataset.following = String(transcriptFollowState.followLatest);
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

function currentTranscriptDisplayMode(): MvpTranscriptDisplayMode {
  return controls.transcriptDisplayMode.value === "translation_only"
    ? "translation_only"
    : "source_and_translation";
}

function currentLiveTextDirectory(): string | null {
  if (!controls.liveTextEnabled.checked) return null;
  const directory = controls.liveTextDirectory.value.trim();
  return directory.length > 0 ? directory : null;
}

function liveTextConfigReady(): boolean {
  const directory = currentLiveTextDirectory();
  return (
    !controls.liveTextEnabled.checked ||
    (directory !== null && isWindowsAbsoluteDirectory(directory))
  );
}

function readAppPreference() {
  try {
    const serialized = window.localStorage.getItem(APP_PREFERENCE_KEY);
    const preference = parseAppPreference(serialized);
    if (serialized !== null && preference === null) {
      window.localStorage.removeItem(APP_PREFERENCE_KEY);
    }
    return preference;
  } catch {
    return null;
  }
}

function persistAppPreference(): void {
  try {
    window.localStorage.setItem(
      APP_PREFERENCE_KEY,
      JSON.stringify({
        version: 1,
        recognitionLanguage: currentRecognitionLanguage(),
        sourceMode: currentSourceMode(),
        transcriptDisplayMode: currentTranscriptDisplayMode(),
        liveTextEnabled: controls.liveTextEnabled.checked,
        liveTextDirectory: controls.liveTextDirectory.value.trim(),
      }),
    );
  } catch {
    // The current selections remain usable when browser storage is unavailable.
  }
}

function applyAppPreference(): void {
  const preference = readAppPreference();
  if (preference === null) return;
  controls.recognitionLanguage.value = preference.recognitionLanguage;
  controls.sourceMode.value = preference.sourceMode;
  controls.transcriptDisplayMode.value = preference.transcriptDisplayMode;
  controls.liveTextEnabled.checked = preference.liveTextEnabled;
  controls.liveTextDirectory.value = preference.liveTextDirectory;
}

function renderLiveTextControls(active: boolean): void {
  controls.liveTextEnabled.disabled = active;
  controls.liveTextDirectory.disabled = active || !controls.liveTextEnabled.checked;
  if (!controls.liveTextEnabled.checked) {
    controls.liveTextStatus.dataset.status = "idle";
    controls.liveTextStatus.textContent = "关闭；SQLite/WAL 仍会保存完整会议原文。";
  } else if (!liveTextConfigReady()) {
    controls.liveTextStatus.dataset.status = "error";
    controls.liveTextStatus.textContent =
      "请填写 Windows 绝对目录，例如 C:\\Users\\你\\Documents\\MeetingRelay。";
  } else if (active) {
    controls.liveTextStatus.dataset.status = "success";
    controls.liveTextStatus.textContent = "会议进行中；每条确认原文会在 SQLite 提交后刷新到独立 TXT。";
  } else {
    controls.liveTextStatus.dataset.status = "ready";
    controls.liveTextStatus.textContent =
      "路径格式就绪；开始时会确认目录存在并可写，再创建不覆盖的 TXT。";
  }
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
  preferredProviderProfileId = profile.profileId;
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
  persistTranslationPreference();
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
  try {
    window.localStorage.setItem(
      TRANSLATION_PREFERENCE_KEY,
      JSON.stringify({
        version: 1,
        enabled: config.enabled,
        provider: controls.translationProvider.value,
        providerProfileId: selectedProviderId ?? preferredProviderProfileId,
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
  preferredProviderProfileId = preference.providerProfileId;
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
      ? "会议进行中，已允许远程明文 HTTP；Token 和确认后的原文可能被读取或篡改。"
      : "会议进行中，翻译配置已锁定。";
  } else if (
    !translationTesting &&
    !["success", "error"].includes(controls.translationStatus.dataset.status ?? "")
  ) {
    controls.translationStatus.dataset.status = requiresInsecureHttp ? "warning" : "ready";
    controls.translationStatus.textContent = requiresInsecureHttp
      ? "已允许远程明文 HTTP；Token 和确认后的原文可能被读取或篡改。"
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
  element<HTMLElement>(`#${source.id}-frames`).textContent = `${source.frames} 帧`;
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
  controls.summaryStart.disabled =
    snapshot.meetingId === null || isActive(snapshot) || controls.summaryProvider.value === "";
  controls.exportSelected.disabled = !canExport(snapshot);
}

function renderOverlayToggle(snapshot: MvpSnapshot): void {
  controls.overlayToggle.disabled = snapshot.meetingId === null && snapshot.interim === null && snapshot.finals.length === 0;
  controls.overlayToggle.textContent = overlayVisible ? "隐藏悬浮字幕" : "显示悬浮字幕";
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
  controls.speakerVersion.textContent = version === null ? "无" : String(version.version);
  controls.speakerLatestVersion.textContent =
    latestVersion === null ? "无" : String(latestVersion.version);
  controls.speakerAlgorithm.textContent = version?.algorithm ?? "未运行";
  controls.speakerVersionInput.disabled = latestVersion === null;
  controls.speakerVersionInput.min = "1";
  controls.speakerVersionInput.max = latestVersion === null ? "1" : String(latestVersion.version);
  controls.speakerVersionInput.value = version === null ? "" : String(version.version);
  controls.speakerLoadVersion.disabled = latestVersion === null;
  controls.speakerEditNote.dataset.status = viewingLatest ? "editable" : "readonly";
  controls.speakerEditNote.textContent =
    version === null
      ? "请先分析说话人，再编辑或导出说话人标签。"
      : viewingLatest
        ? "当前为最新说话人版本，可以编辑。"
        : `正在查看历史说话人版本 ${version.version}；返回最新版本 ${latestVersion?.version ?? ""} 后才能重命名、合并或撤销。`;
  const preservedStatus = controls.speakerStatus.dataset.status ?? "";
  if (!["loading", "failed", "unavailable", "skipped"].includes(preservedStatus)) {
    controls.speakerStatus.textContent =
      version === null
        ? hasMeeting
          ? "尚无已完成的说话人版本。"
          : "请选择会议。"
        : `${version.operation} 已完成 · ${version.identities.length} 位说话人 · ${version.assignments.length} 条分配`;
    controls.speakerStatus.dataset.status = version === null ? "empty" : "completed";
  }
  controls.speakerIdentities.replaceChildren(
    ...(version?.identities.map((identity) => {
      const item = document.createElement("li");
      const name = document.createElement("strong");
      const detail = document.createElement("span");
      name.textContent = identity.displayName;
      detail.textContent = `${identity.speakerId} · 已分配 ${counts.get(identity.speakerId) ?? 0} 段`;
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
      ? "导出说话人标签前，请先分析说话人。"
      : `将包含说话人版本 ${version.version}。`,
  );
  const speakerExportNote = document.querySelector<HTMLElement>("#export-speaker-note");
  if (speakerExportNote !== null) {
    speakerExportNote.textContent =
      version === null
        ? "导出说话人标签前，请先分析说话人。"
        : `说话人版本 ${version.version} 已就绪。`;
  }
}

function renderMeetingLibrary(): void {
  renderSearchResults();
  const page = meetingPage;
  if (page === null) {
    controls.libraryList.replaceChildren();
    controls.libraryMore.disabled = true;
    controls.libraryStatus.textContent = "会议列表尚未加载。";
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
      meta.textContent = `${labelFor(MEETING_STATUS_LABELS, meeting.status)} · ${formatElapsed(meeting.durationMs)} · ${MEETING_LANGUAGE_LABELS[meeting.language]} · 摘要 ${labelFor(SUMMARY_STATUS_LABELS, meeting.summaryStatus)} · ${meeting.tags.join(", ") || "无标签"}`;
      item.append(button, meta);
      return item;
    }),
  );
  controls.libraryMore.disabled = page.nextCursor === null;
  controls.libraryStatus.textContent = `${page.items.length}/${page.total} 场会议 · 查询 ${page.elapsedMs} ms`;
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
      button.textContent = `${labelFor(SEARCH_SCOPE_LABELS, hit.scope)} · ${hit.snippet}`;
      button.addEventListener("click", async () => {
        await loadMeetingDetail(hit.meetingId, hit.segmentId, hit.sequence);
      });
      meta.textContent = `${hit.meetingTitle} · ${hit.sequence === null ? "摘要" : `#${hit.sequence}`} · 匹配 ${hit.score.toFixed(2)}`;
      item.append(button, meta);
      return item;
    }),
  );
}

function renderMeetingDetail(): void {
  const detail = meetingDetail;
  if (detail === null) {
    controls.detailSummary.textContent = "尚未选择会议。";
    controls.detailTags.value = "";
    controls.detailSaveTags.disabled = true;
    controls.detailSegments.replaceChildren();
    renderSpeakerWorkspace();
    return;
  }
  const assignments = speakerAssignmentMap(speakerVersion);
  const names = speakerNameMap(speakerVersion);
  controls.detailSummary.textContent = `${detail.meeting.title} · ${labelFor(MEETING_STATUS_LABELS, detail.meeting.status)} · ${formatElapsed(detail.meeting.durationMs)} · ${detail.meeting.savedFinalCount} 条确认文字`;
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
          ? "说话人：未分配"
          : `说话人：${names.get(assignment.speakerId) ?? assignment.speakerId} · 置信度 ${Math.round(assignment.confidence * 100)}%`;
      text.textContent = segment.text;
      translation.textContent =
        segment.translationStatus === "completed"
          ? segment.translationText ?? ""
          : `译文状态 ${labelFor(TRANSLATION_STATUS_LABELS, segment.translationStatus)}`;
      item.append(header, speaker, text, translation);
      return item;
    }),
  );
}

function renderProviderProfiles(): void {
  const summaryProviderId = controls.summaryProvider.value;
  const summaryPlaceholder = document.createElement("option");
  summaryPlaceholder.value = "";
  summaryPlaceholder.textContent = "选择本次摘要服务...";
  controls.summaryProvider.replaceChildren(
    summaryPlaceholder,
    ...providerProfiles.map((profile) => {
      const option = document.createElement("option");
      option.value = profile.profileId;
      option.textContent = `${profile.label} · ${labelFor(PROVIDER_CLASS_LABELS, profile.class)} · ${profile.model}`;
      return option;
    }),
  );
  controls.summaryProvider.value = providerProfiles.some(
    (profile) => profile.profileId === summaryProviderId,
  )
    ? summaryProviderId
    : "";
  controls.providerList.replaceChildren(
    ...providerProfiles.map((profile) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "provider-profile";
      button.dataset.selected = String(profile.profileId === selectedProviderId);
      button.setAttribute("aria-pressed", String(profile.profileId === selectedProviderId));
      button.textContent = `${profile.label} · ${labelFor(PROVIDER_CLASS_LABELS, profile.class)} · v${profile.configVersion} · 密钥 ${labelFor(SECRET_STATE_LABELS, profile.secretState)} · 测试 ${labelFor(PROVIDER_TEST_STATUS_LABELS, profile.lastTestStatus)}`;
      button.title = `${profile.baseUrl}\n${profile.model}\n${profile.dataFlow}${profile.policyUrl ? `\n隐私政策：${profile.policyUrl}` : ""}${profile.lastError ? `\n错误：${profile.lastError}` : ""}`;
      button.addEventListener("click", () => {
        selectedProviderId = profile.profileId;
        preferredProviderProfileId = profile.profileId;
        persistTranslationPreference();
        controls.providerSecret.value = "";
        renderProviderProfiles();
      });
      return button;
    }),
  );
  const selected = providerProfiles.find((profile) => profile.profileId === selectedProviderId);
  const selectedProbe =
    selected === undefined ? undefined : providerProbeStates.get(selected.profileId);
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
  if (selected === undefined) {
    controls.providerStatus.textContent = "请选择服务。";
    controls.providerStatus.dataset.status = "idle";
  } else if (selectedProbe !== undefined) {
    controls.providerStatus.dataset.status = selectedProbe.phase;
    controls.providerStatus.textContent = selectedProbe.message;
  } else {
    controls.providerStatus.dataset.status = "idle";
    controls.providerStatus.textContent = `${selected.label}: ${selected.baseUrl} · ${selected.model} · ${selected.dataFlow}`;
  }
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
      ? "暂无删除预览。"
      : `预览 ${preview.entries.length} 项 · ${formatBytes(preview.willDeleteBytes)} · 可恢复 ${preview.recoveryWindowSeconds}s`;
}

function renderSummaryJob(): void {
  const job = summaryJob;
  controls.summaryCancel.disabled = job === null || !job.canCancel;
  controls.summaryRetry.disabled =
    job === null || !job.canRetry || controls.summaryProvider.value === "";
  if (job === null) {
    controls.summaryOutput.textContent = "暂无摘要任务。";
    return;
  }
  const progress = `${job.completedChunks}/${job.totalChunks}`;
  if (job.result === null) {
    controls.summaryOutput.textContent = `${labelFor(SUMMARY_STATUS_LABELS, job.status)} · 版本 ${job.version} · 分段 ${progress}${job.message ? ` · ${job.message}` : ""}`;
    return;
  }
  controls.summaryOutput.replaceChildren(
    sectionBlock("概览", [job.result.overview]),
    sectionBlock("行动项", job.result.actions),
    sectionBlock("决定", job.result.decisions),
    sectionBlock("待确认问题", job.result.openQuestions),
    sectionBlock(
      "引用",
      job.result.citations.map((citation) =>
        citation.sequence === null
          ? `${citation.label}（未关联）`
          : `${citation.label} -> 段落 ${citation.sequence}`,
      ),
    ),
  );
}

function sectionBlock(title: string, lines: readonly string[]): HTMLElement {
  const section = document.createElement("section");
  const heading = document.createElement("strong");
  const list = document.createElement("ul");
  heading.textContent = title;
  for (const line of lines.length > 0 ? lines : ["无"]) {
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
  const translationOnly = currentTranscriptDisplayMode() === "translation_only";
  body.hidden = translationOnly;
  item.dataset.displayMode = currentTranscriptDisplayMode();
  translation.dataset.status = segment.translationStatus;
  delete translation.dataset.kind;
  translation.title = "";
  if (translationOnly) {
    const presentation = translationOnlyText(segment);
    translation.hidden = false;
    translation.textContent = presentation.text;
    translation.dataset.kind = presentation.kind;
    if (segment.translationStatus === "failed") {
      translation.title = segment.translationError ?? "";
    }
  } else if (segment.translationStatus === "completed") {
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
        controls.error.textContent = `第 ${segment.sequence} 段暂无可回听音频：${location.reason ?? "原始音频未保存"}`;
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
  const wasAtBottom =
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
      const announced =
        currentTranscriptDisplayMode() === "translation_only"
          ? translationOnlyText(latestInserted).text
          : latestInserted.text;
      controls.transcriptAnnouncer.textContent = `已保存第 ${latestInserted.sequence} 条：${announced}`;
    }
    transcriptFollowState = nextTranscriptFollowState({
      followLatest: transcriptFollowState.followLatest,
      wasAtBottom,
      insertedCount: plan.insertions.length,
      previousUnseenCount: transcriptFollowState.unseenCount,
    });
    if (transcriptFollowState.followLatest) {
      controls.transcript.scrollTop = controls.transcript.scrollHeight;
    } else {
      controls.transcript.scrollTop +=
        controls.transcript.scrollHeight - previousScrollHeight;
    }
    updateTranscriptFollowControls();
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
  controls.lifecycle.textContent = LIFECYCLE_LABELS[snapshot.lifecycle];
  controls.lifecycle.dataset.state = snapshot.lifecycle;
  controls.elapsed.textContent = formatElapsed(snapshot.elapsedMs);
  controls.model.textContent = snapshot.modelReady
    ? snapshot.modelLabel
    : `不可用 · ${snapshot.modelLabel}`;
  controls.model.dataset.ready = String(snapshot.modelReady);
  controls.start.disabled =
    startUiState.phase === "running" ||
    !ready ||
    languagePreparing ||
    translationTesting ||
    !translationConfigReady() ||
    !liveTextConfigReady() ||
    preparedLanguage !== currentRecognitionLanguage() ||
    preparedAsrModelId !== currentAsrModelId() ||
    !controls.consent.checked ||
    currentAudioDeviceSelection() === null;
  renderStartUiState();
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
    asrModels.length === 0;
  controls.asrModel.disabled =
    active ||
    languagePreparing ||
    snapshot.lifecycle !== "ready" ||
    asrModels.length === 0;
  controls.footerLanguage.textContent = LANGUAGE_LABELS[currentRecognitionLanguage()];
  renderAudioDeviceControls(active);
  renderTranslationControls(active);
  renderLiveTextControls(active);
  renderOverlayToggle(snapshot);
  controls.queue.textContent = `${snapshot.queueDepth} / ${MAX_INFERENCE_QUEUE_DEPTH}`;
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
      ? "SQLite/WAL · 暂停期间音频不进入转写，已提交的确认文字保持可恢复"
      : "SQLite/WAL · 确认文字仅在数据库提交成功或重新打开后标为已保存";
  controls.savedCount.textContent = snapshot.savedFinalCount;
  controls.visibleWindow.textContent = `${snapshot.finals.length} / ${snapshot.totalFinalCount}`;
  controls.meetingId.textContent = snapshot.meetingId ?? "未打开";
  renderDisk(snapshot);
  renderDataDirectorySettings(active);
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
  controls.interim.hidden = true;
  controls.interimText.textContent = snapshot.interim?.text ?? "";
  const latestLine = selectLatestTranscriptLine(
    snapshot.interim?.text ?? null,
    snapshot.finals,
    currentTranscriptDisplayMode(),
  );
  controls.latestLine.textContent = latestLine.text;
  controls.latestLine.title = latestLine.text;
  controls.latestLine.dataset.kind = latestLine.kind;
  updateTranscriptFollowControls();
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

void listen(CAPTION_OVERLAY_HIDDEN_EVENT, () => {
  void syncOverlayState();
})
  .then((unlisten) => {
    window.addEventListener("beforeunload", () => unlisten(), { once: true });
  })
  .catch((error) => {
    controls.error.textContent = `悬浮字幕状态监听不可用：${message(error)}`;
  });

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
  controls.exportStudioStatus.textContent = `已导出 ${lastExport.artifacts.length} 个文件。`;
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
      controls.libraryStatus.textContent = `${searchPage.hits.length}/${searchPage.total} 条结果 · 查询 ${searchPage.elapsedMs} ms`;
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
  controls.speakerStatus.textContent = "正在分析说话人...";
  renderSpeakerWorkspace();
  const result = parseSpeakerDiarizationResult(
    await invoke<unknown>("mvp_speaker_diarize", { meetingId }),
  );
  if (result.status === "completed") {
    latestSpeakerVersion = parseSpeakerVersion(await invoke<unknown>("mvp_speaker_latest", { meetingId }));
    speakerVersion = latestSpeakerVersion;
    controls.speakerStatus.dataset.status = "completed";
    controls.speakerStatus.textContent = `说话人分析已完成，版本 ${result.version}。`;
  } else {
    controls.speakerStatus.dataset.status = result.status;
    controls.speakerStatus.textContent =
      result.status === "unavailable"
        ? `说话人分析不可用：${result.reason ?? "需要原始音频"}`
        : result.status === "failed"
          ? `说话人分析失败：${result.reason ?? "未知失败"}`
          : `已跳过说话人分析：${result.reason ?? "没有可分析的确认文字"}`;
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
  providerProbeStates = mergeProbeStates(providerProbeStates, providerProfiles);
  const preferredProfile = providerProfiles.find(
    (profile) => profile.profileId === preferredProviderProfileId,
  );
  if (preferredProfile !== undefined) {
    selectedProviderId = preferredProfile.profileId;
    controls.translationBaseUrl.value = preferredProfile.baseUrl;
    controls.translationModel.value = preferredProfile.model;
  } else if (
    selectedProviderId === null ||
    !providerProfiles.some((profile) => profile.profileId === selectedProviderId)
  ) {
    selectedProviderId = providerProfiles[0]?.profileId ?? null;
  }
  if (preferredProviderProfileId !== null && preferredProfile === undefined) {
    preferredProviderProfileId = null;
    controls.translationEnabled.checked = false;
    persistTranslationPreference();
  }
  renderProviderProfiles();
  renderTranslationControls(latest !== null && isActive(latest));
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
  preferredProviderProfileId = profile.profileId;
  persistTranslationPreference();
  providerProbeStates.set(profile.profileId, {
    profileId: profile.profileId,
    phase: "success",
    message: "服务配置已保存，配置版本已刷新；建议重新测试连接。",
    latencyMs: null,
    updatedAtMs: Date.now(),
  });
  renderProviderProfiles();
}

async function saveProviderSecret(): Promise<void> {
  if (selectedProviderId === null) return;
  const profileId = selectedProviderId;
  await invoke<unknown>("mvp_set_provider_secret", {
    profileId,
    secret: controls.providerSecret.value,
  });
  controls.providerSecret.value = "";
  providerProbeStates.set(profileId, {
    profileId,
    phase: "success",
    message: "密钥已保存到系统凭据；建议重新测试连接。",
    latencyMs: null,
    updatedAtMs: Date.now(),
  });
  await loadProviderProfiles();
}

async function deleteProviderSecret(): Promise<void> {
  if (selectedProviderId === null) return;
  const profileId = selectedProviderId;
  await invoke<unknown>("mvp_delete_provider_secret", {
    profileId,
  });
  controls.providerSecret.value = "";
  providerProbeStates.set(profileId, {
    profileId,
    phase: "success",
    message: "密钥已从系统凭据移除；需要密钥的服务将无法连接。",
    latencyMs: null,
    updatedAtMs: Date.now(),
  });
  await loadProviderProfiles();
}

async function testSelectedProvider(): Promise<void> {
  if (selectedProviderId === null) return;
  const profileId = selectedProviderId;
  const probe = parseTranslationProbe(
    await invoke<unknown>("mvp_test_provider", { profileId }),
  );
  providerProbeStates.set(profileId, {
    profileId,
    phase: "success",
    message: `连接成功 · ${probe.model} · ${probe.latencyMs} ms · ${probe.preview}`,
    latencyMs: probe.latencyMs,
    updatedAtMs: Date.now(),
  });
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
  controls.deleteStatus.textContent = `已删除 ${result.entriesDeleted} 项 · ${formatBytes(result.bytesDeleted)}${result.restoredUntil ? ` · 可恢复至 ${result.restoredUntil}` : ""}`;
  await loadMeetingLibrary(null, false).catch(() => undefined);
}

async function restoreDeletedMeeting(): Promise<void> {
  const meetingId = deletePreviewState?.meetingId ?? selectedMeetingId();
  if (meetingId === null) return;
  const result = parseDeleteResult(await invoke<unknown>("mvp_delete_restore", { meetingId }));
  controls.deleteStatus.dataset.status = "success";
  controls.deleteStatus.textContent = result.deleted ? "恢复未完成。" : "会议已恢复。";
  deletePreviewState = null;
  renderDeletePreview();
  await loadMeetingLibrary(null, false).catch(() => undefined);
}

function selectedSummaryProvider(): ProviderProfile {
  const profile = providerProfiles.find(
    (candidate) => candidate.profileId === controls.summaryProvider.value,
  );
  if (profile === undefined) throw new Error("SUMMARY_PROVIDER_REQUIRED");
  return profile;
}

function confirmSummaryProviderEgress(profile: ProviderProfile): boolean {
  if (profile.class === "local") return true;
  const policy = profile.policyUrl ?? "未配置隐私政策 URL";
  return window.confirm(
    `将完整会议文字发送到 ${profile.label}（${labelFor(PROVIDER_CLASS_LABELS, profile.class)}）？\n\n` +
      `模型：${profile.model}\n数据流向：${profile.dataFlow}\n隐私政策：${policy}\n\n` +
      "会议文字将离开此电脑。服务提供方可能保留或处理内容，并可能产生费用。",
  );
}

async function startSummaryJob(): Promise<void> {
  const meetingId = selectedMeetingId();
  if (meetingId === null) return;
  const profile = selectedSummaryProvider();
  if (!confirmSummaryProviderEgress(profile)) return;
  summaryJob = parseSummaryJob(
    await invoke<unknown>("mvp_summary_start", {
      meetingId,
      providerProfileId: profile.profileId,
      language: "zh",
      summaryRiskAccepted: true,
    }),
  );
  renderSummaryJob();
  scheduleSummaryPoll();
}

async function updateSummaryJob(command: "mvp_summary_cancel" | "mvp_summary_retry"): Promise<void> {
  if (summaryJob === null) return;
  if (command === "mvp_summary_retry") {
    const profile = selectedSummaryProvider();
    if (!confirmSummaryProviderEgress(profile)) return;
    summaryJob = parseSummaryJob(
      await invoke<unknown>(command, {
        jobId: summaryJob.jobId,
        providerProfileId: profile.profileId,
        summaryRiskAccepted: true,
      }),
    );
  } else {
    summaryJob = parseSummaryJob(await invoke<unknown>(command, { jobId: summaryJob.jobId }));
  }
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
      controls.summaryOutput.textContent = `读取摘要状态失败：${message(error)}`;
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

function renderDataDirectorySettings(active: boolean): void {
  const settings = dataDirectorySettings;
  controls.dataDirectory.disabled = active || settings?.environmentOverride === true;
  controls.saveDataDirectory.disabled =
    active ||
    settings?.environmentOverride === true ||
    !isWindowsAbsoluteDirectory(controls.dataDirectory.value);
  if (settings === null) return;
  if (settings.environmentOverride) {
    controls.dataDirectoryStatus.dataset.status = "warning";
    controls.dataDirectoryStatus.textContent =
      `当前由 MEETINGRELAY_MVP_DATA_DIR 固定为 ${settings.activeDataDir}，界面设置不可覆盖。`;
  } else if (!settings.activeStorageAvailable) {
    controls.dataDirectoryStatus.dataset.status = "error";
    const recoverySaved =
      settings.activeDataDir.toLocaleLowerCase() !==
      settings.configuredDataDir.toLocaleLowerCase();
    controls.dataDirectoryStatus.textContent = recoverySaved
      ? `当前启动的数据目录 ${settings.activeDataDir} 不可用；已保存 ${settings.configuredDataDir}，重启 MeetingRelay 后恢复。旧目录中的数据不会自动迁移。`
      : `当前配置的数据目录 ${settings.activeDataDir} 不可用。请选择新的可写绝对目录并保存，然后重启 MeetingRelay。`;
  } else if (settings.restartRequired) {
    controls.dataDirectoryStatus.dataset.status = "warning";
    controls.dataDirectoryStatus.textContent =
      `已保存 ${settings.configuredDataDir}；重启 MeetingRelay 后生效。旧数据仍保留在 ${settings.activeDataDir}。`;
  } else {
    controls.dataDirectoryStatus.dataset.status = "ready";
    controls.dataDirectoryStatus.textContent = `当前使用 ${settings.activeDataDir}。`;
  }
}

async function loadDataDirectorySettings(): Promise<void> {
  dataDirectorySettings = parseDataDirectorySettings(
    await invoke<unknown>("mvp_data_directory_settings"),
  );
  controls.dataDirectory.value = dataDirectorySettings.configuredDataDir;
  renderDataDirectorySettings(latest !== null && isActive(latest));
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

for (const button of controls.navButtons) {
  button.addEventListener("click", () => {
    const view = button.dataset.view;
    if (view === "live" || view === "records" || view === "settings") {
      setActiveView(view);
    }
  });
}

controls.transcript.addEventListener("scroll", () => {
  const atBottom =
    controls.transcript.scrollHeight -
      controls.transcript.scrollTop -
      controls.transcript.clientHeight <
    72;
  if (atBottom) {
    transcriptFollowState = returnToLatest();
  } else if (transcriptFollowState.followLatest) {
    transcriptFollowState = {
      ...transcriptFollowState,
      followLatest: false,
      announcement: "已暂停跟随，保留当前位置。",
    };
  }
  updateTranscriptFollowControls();
});

controls.followLatest.addEventListener("click", () => {
  transcriptFollowState = returnToLatest();
  controls.transcript.scrollTop = controls.transcript.scrollHeight;
  updateTranscriptFollowControls();
});

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
  persistAppPreference();
  if (latest) {
    render(latest);
  } else {
    renderAudioDeviceControls(false);
  }
});

controls.rawAudioEnabled.addEventListener("change", () => {
  if (latest) render(latest);
});

controls.transcriptDisplayMode.addEventListener("change", () => {
  persistAppPreference();
  if (latest) render(latest);
});

function liveTextSettingsChanged(): void {
  persistAppPreference();
  renderLiveTextControls(latest !== null && isActive(latest));
  if (latest) render(latest);
}

controls.liveTextEnabled.addEventListener("change", liveTextSettingsChanged);
controls.liveTextDirectory.addEventListener("input", liveTextSettingsChanged);
controls.dataDirectory.addEventListener("input", () => {
  renderDataDirectorySettings(latest !== null && isActive(latest));
});
controls.saveDataDirectory.addEventListener("click", async () => {
  const dataDirectory = controls.dataDirectory.value.trim();
  if (!isWindowsAbsoluteDirectory(dataDirectory)) {
    controls.dataDirectoryStatus.dataset.status = "error";
    controls.dataDirectoryStatus.textContent = "请输入盘符路径或 UNC 绝对目录。";
    return;
  }
  controls.saveDataDirectory.disabled = true;
  controls.dataDirectoryStatus.dataset.status = "loading";
  controls.dataDirectoryStatus.textContent = "正在验证并保存数据目录...";
  try {
    dataDirectorySettings = parseDataDirectorySettings(
      await invoke<unknown>("mvp_save_data_directory", { dataDirectory }),
    );
    controls.dataDirectory.value = dataDirectorySettings.configuredDataDir;
    renderDataDirectorySettings(latest !== null && isActive(latest));
  } catch (error) {
    controls.dataDirectoryStatus.dataset.status = "error";
    controls.dataDirectoryStatus.textContent = `保存失败：${message(error)}`;
    controls.saveDataDirectory.disabled = false;
  }
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
  if (translationTesting) return;
  let profileId: string | null = null;
  translationTesting = true;
  controls.testTranslation.disabled = true;
  controls.testTranslation.setAttribute("aria-busy", "true");
  controls.translationStatus.dataset.status = "testing";
  controls.translationStatus.textContent = "正在连接所选服务并请求一条测试译文…";
  if (latest) render(latest);
  try {
    profileId = await persistTranslationProviderProfile();
    if (profileId === null) throw new Error("TRANSLATION_PROVIDER_PROFILE_REQUIRED");
    const probe = parseTranslationProbe(
      await invoke<unknown>("mvp_test_provider", { profileId }),
    );
    controls.translationStatus.dataset.status = "success";
    controls.translationStatus.textContent = `连接成功 · ${probe.model} · ${probe.latencyMs} ms · ${probe.preview}`;
    providerProbeStates.set(profileId, {
      profileId,
      phase: "success",
      message: controls.translationStatus.textContent,
      latencyMs: probe.latencyMs,
      updatedAtMs: Date.now(),
    });
    persistTranslationPreference();
  } catch (error) {
    controls.translationStatus.dataset.status = "error";
    controls.translationStatus.textContent = `连接失败：${message(error)}`;
    if (profileId !== null) {
      providerProbeStates.set(profileId, {
        profileId,
        phase: "error",
        message: controls.translationStatus.textContent,
        latencyMs: null,
        updatedAtMs: Date.now(),
      });
    }
  } finally {
    translationTesting = false;
    controls.testTranslation.setAttribute("aria-busy", "false");
    if (latest) render(latest);
    else renderTranslationControls(false);
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
    persistAppPreference();
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
  if (!canBeginStart(startUiState)) return;
  startUiState = beginStartUiState();
  controls.start.disabled = true;
  renderStartUiState();
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
        liveTextDirectory: currentLiveTextDirectory(),
        translation: currentTranslationConfig(),
        translationProviderProfileId,
        ...selection,
      }),
    );
    startUiState = finishStartUiState(true);
    renderStartUiState();
    schedulePoll();
  } catch (error) {
    startUiState = finishStartUiState(false, `无法开始：${message(error)}`);
    if (latest) render(latest);
    controls.error.textContent = `无法开始：${message(error)}`;
    renderStartUiState();
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
    await syncOverlayState();
    await setOverlayVisible(!overlayVisible);
  } catch (error) {
    controls.error.textContent = `悬浮字幕控制失败：${message(error)}`;
    await syncOverlayState().catch((syncError) => {
      controls.error.textContent = `悬浮字幕控制失败：${message(error)}；状态刷新失败：${message(syncError)}`;
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
    controls.libraryStatus.textContent = `刷新会议列表失败：${message(error)}`;
  }
});

controls.libraryMore.addEventListener("click", async () => {
  const cursor = searchPage?.nextCursor ?? meetingPage?.nextCursor;
  if (cursor === null || cursor === undefined) return;
  try {
    await loadMeetingLibrary(cursor, true);
  } catch (error) {
    controls.libraryStatus.dataset.status = "error";
    controls.libraryStatus.textContent = `加载下一页失败：${message(error)}`;
  }
});

for (const input of [controls.librarySearch, controls.libraryTags]) {
  input.addEventListener("change", async () => {
    try {
      await loadMeetingLibrary(null, false);
    } catch (error) {
      controls.libraryStatus.dataset.status = "error";
      controls.libraryStatus.textContent = `筛选失败：${message(error)}`;
    }
  });
}

controls.detailSaveTags.addEventListener("click", async () => {
  controls.detailSaveTags.disabled = true;
  try {
    await saveMeetingTags();
  } catch (error) {
    controls.libraryStatus.dataset.status = "error";
    controls.libraryStatus.textContent = `保存标签失败：${message(error)}`;
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
    controls.speakerStatus.textContent = `分析说话人失败：${message(error)}`;
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
    controls.speakerStatus.textContent = `刷新说话人版本失败：${message(error)}`;
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
    controls.speakerStatus.textContent = `读取说话人版本失败：${message(error)}`;
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
    controls.speakerStatus.textContent = `重命名说话人失败：${message(error)}`;
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
    controls.speakerStatus.textContent = `合并说话人失败：${message(error)}`;
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
    controls.speakerStatus.textContent = `撤销说话人编辑失败：${message(error)}`;
  } finally {
    renderSpeakerWorkspace();
  }
});

controls.providerRefresh.addEventListener("click", async () => {
  try {
    await loadProviderProfiles();
  } catch (error) {
    controls.providerStatus.dataset.status = "error";
    controls.providerStatus.textContent = `刷新服务配置失败：${message(error)}`;
  }
});

controls.providerSaveSecret.addEventListener("click", async () => {
  controls.providerSaveSecret.disabled = true;
  try {
    await saveProviderSecret();
  } catch (error) {
    controls.providerStatus.dataset.status = "error";
    controls.providerStatus.textContent = `保存密钥失败：${message(error)}`;
  } finally {
    renderProviderProfiles();
  }
});

controls.providerRemoveSecret.addEventListener("click", async () => {
  controls.providerRemoveSecret.disabled = true;
  controls.providerStatus.dataset.status = "testing";
  controls.providerStatus.textContent = "正在移除当前服务密钥...";
  let removed = false;
  try {
    await deleteProviderSecret();
    removed = true;
  } catch (error) {
    controls.providerStatus.dataset.status = "error";
    controls.providerStatus.textContent = `移除密钥失败：${message(error)}`;
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
    controls.providerStatus.textContent = `保存服务配置失败：${message(error)}`;
  } finally {
    renderProviderProfiles();
  }
});

controls.providerTest.addEventListener("click", async () => {
  if (selectedProviderId === null) return;
  const profileId = selectedProviderId;
  controls.providerTest.disabled = true;
  providerProbeStates.set(profileId, {
    profileId,
    phase: "running",
    message: "正在测试所选翻译服务...",
    latencyMs: null,
    updatedAtMs: Date.now(),
  });
  controls.providerStatus.dataset.status = "testing";
  controls.providerStatus.textContent = "正在测试所选翻译服务...";
  try {
    await testSelectedProvider();
  } catch (error) {
    providerProbeStates.set(profileId, {
      profileId,
      phase: "error",
      message: `连接失败：${message(error)}`,
      latencyMs: null,
      updatedAtMs: Date.now(),
    });
    controls.providerStatus.dataset.status = "error";
    controls.providerStatus.textContent = `连接失败：${message(error)}`;
  } finally {
    renderProviderProfiles();
  }
});

controls.deletePreview.addEventListener("click", async () => {
  try {
    await previewDelete();
  } catch (error) {
    controls.deleteStatus.dataset.status = "error";
    controls.deleteStatus.textContent = `删除预览失败：${message(error)}`;
  }
});

controls.deleteExecute.addEventListener("click", async () => {
  controls.deleteExecute.disabled = true;
  try {
    await executeDelete();
  } catch (error) {
    controls.deleteStatus.dataset.status = "error";
    controls.deleteStatus.textContent = `删除失败：${message(error)}`;
  } finally {
    renderDeletePreview();
  }
});

controls.deleteRestore.addEventListener("click", async () => {
  try {
    await restoreDeletedMeeting();
  } catch (error) {
    controls.deleteStatus.dataset.status = "error";
    controls.deleteStatus.textContent = `恢复失败：${message(error)}`;
  }
});

controls.summaryProvider.addEventListener("change", () => {
  if (latest) render(latest);
  renderSummaryJob();
});

controls.summaryStart.addEventListener("click", async () => {
  controls.summaryStart.disabled = true;
  try {
    await startSummaryJob();
  } catch (error) {
    controls.summaryOutput.textContent = `启动摘要失败：${message(error)}`;
  } finally {
    if (latest) render(latest);
  }
});

controls.summaryCancel.addEventListener("click", async () => {
  try {
    await updateSummaryJob("mvp_summary_cancel");
  } catch (error) {
    controls.summaryOutput.textContent = `取消摘要失败：${message(error)}`;
  }
});

controls.summaryRetry.addEventListener("click", async () => {
  try {
    await updateSummaryJob("mvp_summary_retry");
  } catch (error) {
    controls.summaryOutput.textContent = `重试摘要失败：${message(error)}`;
  }
});

controls.exportSelected.addEventListener("click", async () => {
  controls.exportSelected.disabled = true;
  controls.exportStudioStatus.dataset.status = "loading";
  controls.exportStudioStatus.textContent = "正在导出所选内容...";
  try {
    await exportMeetingWithOptions();
  } catch (error) {
    controls.exportStudioStatus.dataset.status = "error";
    controls.exportStudioStatus.textContent = `导出所选内容失败：${message(error)}`;
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
    `将重新发送本场 ${failedCount} 条失败原文到所选翻译服务，可能产生额外费用。确认继续？`,
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

applyAppPreference();
applyTranslationPreference(readTranslationPreference());
renderTranslationControls(false);
renderLiveTextControls(false);
renderRetryProgress(null);
renderRecoveryCenter();

void (async () => {
  await loadDataDirectorySettings().catch((error) => {
    controls.dataDirectoryStatus.dataset.status = "error";
    controls.dataDirectoryStatus.textContent = `数据目录设置不可用：${message(error)}`;
  });
  await syncOverlayState().catch((error) => {
    controls.error.textContent = `悬浮字幕窗口不可用：${message(error)}`;
  });
  await loadAsrModels()
    .then(() => {
      preparedAsrModelId = null;
    })
    .catch((error) => {
      controls.error.textContent = `识别模型注册表不可用：${message(error)}`;
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
    controls.lifecycle.textContent = "异常";
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
    controls.libraryStatus.textContent = `会议记录不可用：${message(error)}`;
  });
  await loadProviderProfiles().catch((error) => {
    controls.providerStatus.dataset.status = "error";
    controls.providerStatus.textContent = `服务配置不可用：${message(error)}`;
  });
})();
