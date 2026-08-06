# Design

## Source of truth

- Status: Implemented baseline
- Last refreshed: 2026-08-05
- Primary product surfaces: Windows 桌面端的实时会议、会议记录、设置与诊断界面
- Evidence reviewed:
  - `apps/desktop/src/main.ts`
  - `apps/desktop/src/styles.css`
  - `apps/desktop/src/mvp-contract.ts`
  - `apps/desktop/src/transcript-render.test.mjs`
  - `apps/desktop/src/mvp-contract.test.mjs`
  - `apps/desktop/src-tauri/src/mvp/service.rs`
  - `apps/desktop/src-tauri/src/mvp/secret_store.rs`
  - `apps/desktop/src-tauri/src/mvp/translation.rs`
  - `apps/desktop/src-tauri/src/mvp/cohere_asr.rs`
  - `E:\Project Code\docs\01 - Projects\MeetingRelay\产品需求与 MVP.md`
  - `E:\Project Code\docs\01 - Projects\MeetingRelay\当前架构与实现状态.md`
  - 2026-08-04 用户反馈与界面截图
- This document is the stable design direction. The detailed investigation and delivery plan live in `E:\Project Code\docs\01 - Projects\MeetingRelay\界面与交互优化调查及修改方案.md`.

## Implementation snapshot

The 2026-08-05 baseline now includes the three primary views, persistent in-place provider probe results, immediate and duplicate-safe start feedback, an independent transcript viewport with explicit follow-latest behavior, a fixed and explicitly labelled latest-line area, a persistent original-plus-translation/translation-only display choice shared by the main view and overlay, remembered non-secret meeting/Provider settings, an optional post-commit live TXT mirror, a Chinese-first visual language, no-window PowerShell execution, and a 15-second provider probe budget. The meeting controls remain visible at the top of the live-meeting rail while its detailed checks scroll independently. Meeting Records and Settings use intrinsically sized cards inside their own vertical workspaces, so card contents are never compressed or clipped to satisfy the grid.

The remaining measurement work is explicitly tracked rather than treated as complete: cold/warm start p50/p95 telemetry, a real local/LAN/cloud provider matrix, 125%/150% Windows scaling coverage, and further decomposition of `main.ts`.

## Brand

MeetingRelay 应表现为一个安静、可靠、尊重隐私的本地会议工具，而不是开发者调试台。

- 核心气质：可信、克制、专注、可恢复。
- 视觉重点：会议状态和实时文字优先，技术诊断信息退到设置或高级区。
- 避免：大量全大写英文、极小字号、两套互相竞争的配色、内部阶段编号和队列术语直接暴露给普通用户。

## Product goals

1. 用户能在一次会议中完成检查、开始、阅读实时文字、停止和导出，不需要在长页面中寻找控件。
2. 任一操作在 100 ms 内给出可见反馈；耗时任务持续显示阶段和结果。
3. 实时文字始终是录制界面的主角，默认自动跟随最新内容，同时尊重用户向上阅读的意图。
4. 常用界面采用简体中文；品牌、协议和行业固有名词保留原文。
5. 高级能力继续可用，但通过渐进披露与主流程隔离。

## Personas and jobs

- 会议参与者：快速确认设备和服务可用，开始录制，持续阅读当前内容，在结束后导出。
- 复盘用户：查找历史会议，查看详情、说话人、摘要和导出结果。
- 高级用户或维护者：配置模型与翻译服务、检查存储、查看失败任务和诊断信息。

## Information architecture

一级导航只保留三项：

1. **实时会议**：会前检查、会议控制、实时文字和最少量的当前状态。
2. **会议记录**：历史列表、会议详情、说话人、摘要、导出和数据治理。
3. **设置**：音频、识别、翻译服务、存储、诊断和恢复工具。

实时会议界面采用固定高度的应用壳：顶部为导航和全局状态，中部为紧凑检查区与大面积文字区，底部为固定会议控制。R3/R4/R5 等内部阶段标记不进入用户导航或正文。

## Design principles

- **会议优先**：把开始会议和读文字所需的信息放在第一屏。
- **渐进披露**：默认展示决策所需信息；诊断细节通过“查看详情”进入。
- **反馈就地**：连接测试结果显示在触发控件旁，不用阻塞弹窗，也不因列表刷新消失。
- **保持上下文**：用户向上阅读时不强行跳到底部；新内容到达时提供明确的“回到最新”。
- **状态可解释**：加载、成功、失败、禁用、空数据都有可读文案和下一步。
- **单一视觉语言**：同一套间距、字号、颜色和组件状态覆盖全部页面。

## Visual language

- 主背景使用低对比度深色中性色；绿色只表达进行中或成功，蓝色用于可操作焦点，橙红色用于警告或错误。
- 正文最小字号 14 px；辅助标签和状态最小 12 px；按钮最小 13 px；实时文字建议 18–22 px。
- 常用点击目标至少 32 px，主要操作建议 36–40 px。
- 等宽字体只用于路径、日志、标识符和结构化数据，不用于整段界面文案。
- 减少全大写和过宽字距。标题通过字号、字重和留白建立层级。
- 当前的绿色主界面与蓝灰高级控制台应合并为一套令牌，不再并列存在。

## Components

- `AppShell`：固定窗口结构与一级导航，限制页面级滚动。
- `PrimaryNav`：实时会议、会议记录、设置。
- `SessionReadinessChecklist`：把设备、模型、翻译和存储检查压缩为可展开的就绪清单。
- `SessionControlBar`：开始、启动中阶段、停止和运行时长；开始后保持位置稳定。
- `ProviderProbeResult`：连接测试的加载、成功、失败和详情；结果独立于配置列表刷新。
- `TranscriptViewport`：只承载最终文字历史，拥有独立滚动区域。
- `LatestLineDock`：固定在文字区底部，优先显示当前临时句，否则显示最新确认句；不随历史列表滚走，内容过长时限制在三行内。
- `TranscriptDisplayPicker`：持久化选择“原文 + 译文”或“仅显示译文”；实时列表、最新一句与悬浮字幕必须遵循同一规则。
- `LiveTextMirrorSetting`：会前选择是否把 durable final 原文实时写入独立 TXT；活动会议中锁定目录。
- `DataDirectorySetting`：输入并验证主数据绝对目录；明确区分当前目录与重启后目录，不暗示自动迁移旧数据。
- `CaptionOverlay`：固定标题为“实时字幕”，优先 interim、否则保留最新 final；不显示 revision/timeline/队列等调试信息，提供拖动、右下角缩放和持久化字号控制。
- `FollowLatestButton`：用户离开底部且有新内容时出现，点击后恢复自动跟随。
- `SecondaryWorkspace`：会议详情、说话人、摘要、导出、治理与诊断的次级工作区。

## Accessibility

- 所有操作可用键盘到达，并有清晰的 `:focus-visible` 样式。
- 使用真实按钮、标签与区域语义；异步状态通过 `aria-live`，耗时容器使用 `aria-busy`。
- 颜色不是唯一状态线索；状态必须同时有文字或图标。
- 普通文字与背景对比度至少达到 WCAG AA；主要交互不依赖悬停。
- 动画遵循 `prefers-reduced-motion`，自动滚动在减少动态时改为即时定位。
- “跳到实时文字”链接保留，但使用统一的中文文案。

## Responsive behavior

- 目标桌面基线：1920×1080、1366×768、1280×720；900×700 作为紧凑窗口验收尺寸。
- 宽屏时就绪清单与文字区可并排；窄于约 1100 px 时清单折叠到文字区上方。
- 中部内容区占用剩余高度，只有 `TranscriptViewport` 和次级列表独立滚动。
- 会议记录与设置的卡片按内容高度展开，由各自的 `SecondaryWorkspace` 统一纵向滚动；不得用等分网格行压缩卡片内容。
- 主要控制条固定在窗口底部，不应被历史列表或高级设置推离视口。
- 悬浮字幕默认 `760×180`，在紧凑到 `320px` 宽时仍保留字幕、字号控制与右下角缩放入口，不产生横向滚动。
- 不以横向滚动解决主流程空间不足；技术表格可在次级页面内局部滚动。

## Interaction states

### 开始会议

- `idle`：显示“开始会议”。
- `validating`：点击后立即进入，显示“正在检查设备和服务…”。
- `preparing_provider`：显示“正在准备识别/翻译服务…”。
- `opening_audio`：显示“正在连接音频设备…”。
- `recording`：显示录制状态和运行时长。
- `error`：保留失败阶段、可执行建议和重试入口。

若后端暂时不能提供细分阶段，首版至少实现 `idle → starting → recording/error`，且在点击后的同一帧可见。

### 测试连接

- 结果显示在当前服务卡片内，包含服务名、耗时和成功/失败摘要。
- 配置刷新不得覆盖最近一次测试结果；再次测试或主动关闭才清除。
- 不使用系统弹窗。底层非交互 PowerShell 进程必须以无窗口方式启动。
- 独立探测应使用短超时，并显示“连接中”和“等待响应”阶段。

### 实时文字

- 默认开启“跟随最新”。新文字到达时滚动到底部并更新固定的当前句。
- 用户主动向上滚动后暂停跟随，保持阅读位置，并显示新内容数量与“回到最新”。
- 点击“回到最新”或滚回底部后恢复跟随。
- 临时句更新不应重建整个历史列表，也不应改变用户当前的历史阅读位置。
- 默认显示原文与译文；选择“仅显示译文”时，completed 显示译文，pending/failed/skipped/disabled 显示明确状态，任何一种状态都不得回退显示原文或留空。
- “仅显示译文”只改变展示，不改变原文的 SQLite 持久化、会议历史、复制或导出语义。
- 实时 TXT 默认关闭；启用后只在 SQLite final commit ACK 后追加非重复原文，使用 UTF-8/LF、逐会议新文件并拒绝覆盖。

## Content voice

- 主界面默认使用简体中文，语气简短、直接、可执行。
- 保留原文的类别：`MeetingRelay`、Windows、SQLite、JSON、Markdown、API、Base URL、API Token、模型和服务品牌名。
- 翻译示例：`LIVE TRANSCRIPT` → `实时文字`；`Show overlay` → `显示悬浮字幕`；`Test provider` → `测试连接`。
- 错误文案采用“发生了什么 + 可做什么”的结构，内部错误码放在可展开详情中。
- 避免把 R3/R4/R5、commit ACK、queue、provider state 等实现术语放在普通流程中。

## Implementation constraints

- 保持现有 Tauri + Vite + 原生 TypeScript DOM 架构；本轮不引入 React/Vue/Svelte 或新的 UI 依赖。
- 先用回归测试锁定现有行为，再拆分 `main.ts` 中的视图、状态和事件绑定。
- 第一阶段优先修复反馈链路，不以大规模重写阻塞弹窗、结果持久化和启动反馈。
- 将界面文案集中到单一模块，并用允许列表保留必要英文。
- 所有非交互 PowerShell 子进程复用 Windows `CREATE_NO_WINDOW` 模式。
- 为开始流程与连接测试记录前端感知耗时和后端阶段耗时，再用 p50/p95 验证优化效果。
- 高级能力可以迁移位置，但不得丢失已有功能或数据访问入口。

## Open questions

- 用户更偏好固定显示“正在说的临时句”，还是固定显示“最新确认句 + 临时句”两行？
- 主要使用的窗口尺寸和缩放比例是什么？是否需要兼容 125%/150% Windows 缩放？
- 连接测试短超时应统一为 15 秒，还是按本地/LAN/云服务分别配置？
- 凭据访问的中期方案是批量/惰性 PowerShell，还是切换到原生 Windows Credential API？
- 当前真实的点击开始到录制成功 p50/p95 尚未测量；应先埋点再确定性能预算。
- 实时 TXT 是否需要原生目录选择器，以及译文/双语实时文件模式？当前首版明确只接受已存在的绝对目录并写 durable 原文。
