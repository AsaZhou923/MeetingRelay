# MeetingRelay

MeetingRelay 是一个面向个人使用的 Windows 本地会议转写工具。当前 main 分支只保留个人 MVP 需要的产品代码、启动脚本、打包脚本和最小验证；Phase 0、attestation、benchmark、候选引擎和历史实验代码已经归档到 [`archive/full-repository-before-mvp-trim-2026-07-23`](https://github.com/AsaZhou923/MeetingRelay/tree/archive/full-repository-before-mvp-trim-2026-07-23)。

## 当前实际能做什么

- 在 Windows 桌面应用中选择系统输出和麦克风输入。
- 开始、暂停、继续、停止一场会议录音与本地转写。
- 使用锁定的 Sherpa / SenseVoice 本地 ASR 作为当前唯一主引擎。
- 在 UI 中实时查看增量文本、音频状态、队列状态和错误提示。
- 可选连接本机 Ollama/LM Studio，或 OpenAI、DeepSeek、OpenRouter、xAI、阿里云百炼及其他 OpenAI-compatible 服务，把 durable final 原文翻译为中文、日文或英文；原文和完成译文分别持久化。
- 将已完成文本保存到本地 SQLite/WAL，并在异常退出后恢复已提交的 final 文本。
- 重新打开最近会议，复制全部文本，导出 JSON、Markdown 和 TXT。
- 构建一个同机使用的 Windows personal release 目录，包含程序、锁定模型、运行时和相对路径启动器。

这些能力已经接入桌面产品链路。仓库里剩余的 JS/PowerShell 工具主要用于资产物化、启动契约、发布契约和前端契约测试。

## 快速启动

要求：Windows、Rust 工具链、Node.js/pnpm，以及可获取的锁定 Sherpa 资产和运行时。

```powershell
pnpm install

# 只检查依赖、资产和启动契约，不打开应用
powershell -ExecutionPolicy Bypass -File tools/mvp/start.ps1 -DryRun

# 启动本地桌面应用
powershell -ExecutionPolicy Bypass -File tools/mvp/start.ps1
```

首次缺少锁定资产或 pnpm 缓存时，显式允许下载：

```powershell
powershell -ExecutionPolicy Bypass -File tools/mvp/start.ps1 -AllowDownload
```

### 下载本地 ASR 模型

推荐使用仓库脚本下载。它会下载当前锁定的 SenseVoice 模型、校验 SHA-256 并解压到 `target/sherpa-native`：

```powershell
powershell -ExecutionPolicy Bypass -File tools/sherpa-native/materialize.ps1 -AssetSet Model -AllowDownload
```

如果希望同时下载模型、Sherpa 原生运行库并启动完整桌面端，直接运行：

```powershell
powershell -ExecutionPolicy Bypass -File tools/mvp/start.ps1 -AllowDownload
```

模型压缩包约 163 MB，解压后的 `model.int8.onnx` 约 239 MB，默认位于：

```text
target/sherpa-native/extracted/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17/model.int8.onnx
```

也可以[直接下载锁定的模型压缩包](https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2)，其 SHA-256 为 `7d1efa2138a65b0b488df37f8b89e3d91a60676e416f515b952358d83dfd347e`。首次下载成功后，后续启动可以去掉 `-AllowDownload` 并复用本地缓存。

当前模型许可仅接受内部评估，公开再分发状态仍为 Pending，因此 GitHub Release 不附带模型文件。

### 配置 OpenAI-compatible 翻译

MeetingRelay 不捆绑翻译模型。既可以在本机 Ollama 或 LM Studio 中下载并加载模型，也可以使用供应商提供的 OpenAI-compatible Chat Completions 服务。界面内置 OpenAI、DeepSeek、OpenRouter、xAI 和阿里云百炼预设，也允许填写其他兼容服务的 Base URL。

常用 Base URL：

```text
Ollama:    http://127.0.0.1:11434/v1
LM Studio: http://127.0.0.1:1234/v1
OpenAI:    https://api.openai.com/v1
DeepSeek:  https://api.deepseek.com
OpenRouter:https://openrouter.ai/api/v1
xAI:       https://api.x.ai/v1
DashScope: https://dashscope.aliyuncs.com/compatible-mode/v1
```

1. 选择服务预设，或填写供应商给出的 OpenAI-compatible Base URL；支持 `/v1`、`/api/v1`、`/compatible-mode/v1` 等路径。
2. 填写服务实际暴露的模型 ID；Ollama 可用 `ollama list` 查看，LM Studio 可在 Local Server 页面查看，云端服务以供应商控制台/文档为准。
3. 选择本场会议的译文语言（中文、日文或英文）。
4. 若远程服务只有 HTTP，界面会显示橙色风险确认。只有明确勾选后才能测试或开始会议；应优先给服务配置 HTTPS。
5. 点击“测试连接”。测试只发送合成短句，不发送会议内容。
6. 确认本场录音提示后开始会议。每条原文会先提交到 SQLite，再异步翻译；翻译失败不会删除或阻塞原文。

`localhost`、`127.0.0.1` 和 `[::1]` 可直接使用 HTTP。远程 HTTP 默认拒绝，只有在界面中显式勾选“不安全的远程 HTTP”后才放行；此时 API Token 与 durable final 原文都以明文传输，可能被读取或篡改。该确认会作为非密钥偏好保存在本机，API Token 本身仍不写入 localStorage、SQLite、日志或导出，只在当前应用进程内使用。启用远程供应商会把每条 durable final 原文发送给该第三方，并可能产生费用或受其保留/训练政策约束；请在会议参与者同意且接受供应商政策后使用。目标语言与识别语言相同时会跳过模型请求，并持久化 `skipped` 状态。

实现参考了 `E:\Project Code\ref_repo\LiveTranslate` 的通用 `api_base + api_key + model` 配置方式，但没有照搬其明文密钥持久化。供应商协议参考：[Ollama OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility)、[LM Studio OpenAI-compatible endpoints](https://lmstudio.ai/docs/developer/openai-compat)、[OpenRouter Quickstart](https://openrouter.ai/docs/quickstart)、[DeepSeek API Docs](https://api-docs.deepseek.com/)、[xAI REST API](https://docs.x.ai/developers/rest-api-reference/inference)、[阿里云百炼 OpenAI-compatible API](https://www.alibabacloud.com/help/en/model-studio/deepseek-api)。

### 预发布 EXE

[`v0.0.1` 预发布版](https://github.com/AsaZhou923/MeetingRelay/releases/tag/v0.0.1) 提供当前源码构建的 `MeetingRelay.exe`，SHA-256 为 `2D8042763C3319E42A6BEB47953A4D1A5F6A1F3FE2EBA1A3FFE97ED0BF3C64BB`，包含稳定实时字幕、三语识别选择、OpenAI-compatible 翻译和显式确认后的远程 HTTP 支持。该文件未签名，也不包含模型和 Sherpa DLL，不能作为独立的一键安装包使用；完整同机运行目录仍应使用下面的 personal release 命令生成。

生成个人 release：

```powershell
pnpm mvp:release:personal
powershell -ExecutionPolicy Bypass -File target/mvp/personal-release/MeetingRelay.same-machine.ps1
```

## 常用验证

```powershell
pnpm --dir apps/desktop test
pnpm --dir apps/desktop typecheck
pnpm --dir apps/desktop build
cargo test -p meetingrelay-desktop
powershell -ExecutionPolicy Bypass -File tools/mvp/start.test.ps1
pnpm mvp:release:personal:test
```

## 真实设备验收

2026-07-23 使用 personal release 在开发者 Windows 电脑上完成了一次 `01:01:04` 的连续麦克风会议验收：麦克风累计接收 `175,902,720` 帧，25 条 final 文本全部实时显示并持久保存，停止后的最终 flush、复制全部文本、JSON / Markdown / TXT 导出以及重新打开同一会议均通过。进程私有内存在检查点保持约 331.7–331.8 MB；约第 17 分钟队列曾短暂达到 8/8，并在约一分钟内自行恢复到 0，整场没有应用错误。

这次验收证明了“麦克风输入 → 本地 ASR → UI 增量展示 → SQLite/WAL 保存 → 结束、导出、重开”的 60 分钟产品链路。系统输出通道本次为 0 帧，因此不把它写成系统回环已验收；实际转写准确率和延迟是否可接受仍由开发者结合有代表性的会议内容单独判断。

## 当前限制

- 目前只以 Sherpa / SenseVoice 作为产品 ASR；Whisper、FunASR 和更复杂候选评测不在 main 的 MVP 门禁中。
- release 是同机个人使用目录，不是签名安装包，也不声明对外再分发授权。
- 60 分钟麦克风链路已完成真实设备耐久验收；设备热插拔、系统输出回环，以及有代表性会议内容下的延迟和准确率仍需继续验收。
- 尚未加入独立 fallback；只有真实故障证明当前 Sherpa 恢复能力不足时再增加。
- 当前翻译以每条 final 的非流式 Chat Completions 请求实现；尚未提供 token 级流式显示、手动重试、上下文窗口、代理、自定义请求体/Headers 或完整 provider provenance/version。本机服务需由用户安装模型，云端服务需自行准备账户、模型权限和 API Token。
- `v0.0.1` 仍是个人内部评估用预发布；附件未签名、不包含模型和 Sherpa runtime，发布页必须与 README 中的 SHA-256 保持一致。
- main 分支不再维护企业审计、完整 provenance、formal evidence 或每个微小 schema 的文档门禁。

## 仓库结构

- `apps/desktop`：Tauri 桌面应用和前端契约。
- `crates/model-worker-sherpa-native`：当前产品 ASR 后端。
- `crates/model-worker-contract`：ASR 后端内部接口类型。
- `tools/sherpa-native`：锁定 Sherpa 资产校验、物化和运行时 staging。
- `tools/mvp`：个人启动和发布脚本及其契约测试。
- `.github/workflows/mvp.yml`：main/PR 唯一产品 CI。
