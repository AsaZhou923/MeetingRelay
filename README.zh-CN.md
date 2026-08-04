<h1 align="center">MeetingRelay</h1>

<p align="center">
  <a href="README.md">English</a> · <strong>简体中文</strong>
</p>

<p align="center">
  面向 Windows 的本地优先会议转写工具：本机 Cohere Transcribe GPU / SenseVoice CPU ASR、SQLite 持久化，以及可选的 OpenAI-compatible 翻译。
</p>

<p align="center">
  <a href="https://github.com/AsaZhou923/MeetingRelay/releases/latest"><img alt="Release" src="https://img.shields.io/github/v/release/AsaZhou923/MeetingRelay?display_name=tag"></a>
  <a href="https://github.com/AsaZhou923/MeetingRelay/actions/workflows/mvp.yml"><img alt="Personal MVP CI" src="https://github.com/AsaZhou923/MeetingRelay/actions/workflows/mvp.yml/badge.svg?branch=main"></a>
  <a href="LICENSE"><img alt="License: Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-blue.svg"></a>
  <img alt="Platform" src="https://img.shields.io/badge/platform-Windows%2010%2F11-0078D4?logo=windows">
  <img alt="Tauri" src="https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri&logoColor=white">
  <img alt="Rust" src="https://img.shields.io/badge/Rust-1.95-000000?logo=rust">
</p>

<p align="center">
  <a href="#功能">功能</a> ·
  <a href="#快速开始">快速开始</a> ·
  <a href="#openai-compatible-翻译">翻译配置</a> ·
  <a href="#开发与验证">开发</a> ·
  <a href="#当前限制">限制</a>
</p>

MeetingRelay 同时采集电脑播放声音和麦克风输入，在本机完成实时语音识别，并且只在 SQLite 提交成功后把 final 文本标记为已保存。需要双语会议记录时，可以连接 Ollama、LM Studio 或第三方 OpenAI-compatible 服务；翻译失败不会删除、覆盖或延迟原文。

> [!IMPORTANT]
> 当前正式 Release 中的 `MeetingRelay.exe` 未签名，且不包含 Cohere 或 SenseVoice 模型运行时。首次使用请按[快速开始](#快速开始)准备本机资产。

## 功能

- **可选本地识别**：高质量 GPU 路径使用 Cohere Transcribe 2B CUDA/BF16，CPU 路径保留锁定的 Sherpa / SenseVoice int8；音频与 ASR 留在本机。
- **双音源采集**：支持选择 Windows 系统输出和麦克风设备。
- **中、日、英三语**：每场会议开始前选择中文、日文或英文，会议进行中锁定。
- **聚焦会议主流程**：实时会议、会议记录和设置分为三个视图，会议控制与实时文字不会再和管理工具挤在同一长页面。
- **稳定实时字幕**：确认文字按稳定键增量更新、独立滚动并默认跟随最新内容；用户查看旧内容时保留阅读位置，并可一键回到最新。
- **可预期的服务检查**：连接结果就地保留，探测预算限制为 15 秒，并且不会闪出 PowerShell 控制台窗口。
- **持久化优先**：原文先提交 SQLite/WAL，再显示为已保存并进入翻译队列。
- **可选 AI 翻译**：支持本机和第三方 OpenAI-compatible Chat Completions 服务。
- **故障隔离**：翻译、网络或模型失败不影响已经提交的原文。
- **会议恢复**：异常退出后可以恢复已提交的 final，并重新打开最近会议。
- **复制与导出**：支持复制完整转写，以及导出 JSON、Markdown 和 TXT。
- **Windows personal release**：生成包含 EXE、模型、runtime、锁文件和相对路径启动器的同机目录。

## 工作方式

```mermaid
flowchart LR
    SYS["系统输出"] --> CAP["Windows 音频采集"]
    MIC["麦克风"] --> CAP
    CAP --> ASR["Cohere GPU 或 SenseVoice CPU 本地 ASR"]
    ASR --> DB["SQLite / WAL<br/>durable final"]
    DB --> UI["稳定实时字幕"]
    DB --> TQ["独立翻译队列"]
    TQ --> LLM["OpenAI-compatible 服务"]
    LLM --> TR["译文状态与结果"]
    DB --> OUT["复制与导出"]
    TR --> OUT
```

核心顺序始终是：

1. 本地 ASR 产生 final。
2. 原文成功提交 SQLite。
3. UI 显示“已保存”。
4. 若启用翻译，再异步请求所选服务。
5. 译文以 `completed`、`failed` 或 `skipped` 状态独立持久化。

## 快速开始

### 环境要求

- Windows 10 或 Windows 11
- Node.js `24.13.0`
- pnpm `9.15.9`
- Rust `1.95.0`，包含 `rustfmt` 和 `clippy`
- Visual Studio 2022 Build Tools（Desktop development with C++）
- WebView2 Runtime
- Git for Windows

### 从源码启动

```powershell
git clone https://github.com/AsaZhou923/MeetingRelay.git
cd MeetingRelay

corepack enable
corepack prepare pnpm@9.15.9 --activate
pnpm install --frozen-lockfile

# 首次运行：下载并校验锁定的模型与原生运行库
powershell -ExecutionPolicy Bypass -File tools/mvp/start.ps1 -AllowDownload
```

资产下载完成后，后续启动不再需要 `-AllowDownload`：

```powershell
powershell -ExecutionPolicy Bypass -File tools/mvp/start.ps1
```

只检查依赖、资产和启动契约，不打开应用：

```powershell
powershell -ExecutionPolicy Bypass -File tools/mvp/start.ps1 -DryRun
```

## 本地 ASR 模型

### Cohere Transcribe 2B GPU 路径

先在 Hugging Face 接受 gated 模型条款并登录 CLI，再创建隔离的 CUDA
运行环境：

```powershell
hf auth login
powershell -ExecutionPolicy Bypass -File tools/cohere-transcribe/setup.ps1
```

脚本把锁定的 Python/CUDA 依赖安装到
`%LOCALAPPDATA%\MeetingRelay\runtimes\cohere-transcribe-03-2026`，并把精确
revision 下载到 Hugging Face 缓存。MeetingRelay 只有在模型文件大小匹配时
才允许选择；常驻 worker 在加载前还会校验完整 SHA-256。推理通过本机管道
完成，模型加载后不需要联网。

| 项目 | 值 |
| --- | --- |
| 模型 | `CohereLabs/cohere-transcribe-03-2026` |
| Revision | `b1eacc2686a3d08ceaae5f24a88b1d519620bc09` |
| `model.safetensors` | 4,131,862,976 bytes |
| 模型 SHA-256 | `987bd3e141c7bfdb5a78f5db11397ee7737308357e6cc0a3f36a4979b158137a` |
| Runtime | PyTorch `2.10.0` + CUDA 12.8、Transformers `5.4.0`、BF16 |
| 建议显存 | 8 GB 或以上 |
| 许可 | Apache-2.0；仍需 Hugging Face gated 访问授权 |

当前 RTX 5070 Ti Laptop GPU 上的 4 条日语 smoke（三条合成语音、一条
FLEURS 真人语音）得到归一化 CER `0`、平均 RTF `0.029`（约 35 倍实时）、
峰值显存 `3.894 GiB`、冷加载约 `10.5 s`。这证明本地集成可用，不等于
代表性长会议质量已经验收。

可通过与产品相同的 worker 协议重复执行 Windows 中/日/英三语 smoke：

```powershell
powershell -ExecutionPolicy Bypass -File tools/cohere-transcribe/smoke.ps1
```

最终本机结果中、日、英归一化 CER 均为 `0`，RTF 分别为 `0.102`、
`0.040`、`0.029`，报告写入 `target/mvp/acceptance/cohere-smoke/`。
最终 personal release 还通过了真实扬声器 loopback + 麦克风中文测试，
4 条 final 完整持久化，会议完成且没有重复模式噪声段。

### SenseVoice CPU 路径

推荐使用仓库脚本下载锁定的 CPU 模型。脚本会校验锁定文件、SHA-256 和
解压结果：

```powershell
powershell -ExecutionPolicy Bypass -File tools/sherpa-native/materialize.ps1 `
  -AssetSet Model `
  -AllowDownload
```

当前 CPU 模型：

| 项目 | 值 |
| --- | --- |
| 模型 | `sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17` |
| 压缩包 | 约 163 MB |
| `model.int8.onnx` | 约 239 MB |
| 压缩包 SHA-256 | `7d1efa2138a65b0b488df37f8b89e3d91a60676e416f515b952358d83dfd347e` |
| 默认目录 | `target/sherpa-native/extracted/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17/` |

也可以[直接下载上游模型压缩包](https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2)，但仍建议使用脚本完成完整性校验和目录物化。

> [!NOTE]
> 模型与原生运行库不包含在公开 Release 附件中。使用和再分发时还需要遵守对应上游项目与模型资产的许可条款。

## OpenAI-compatible 翻译

MeetingRelay 不捆绑翻译模型。可以使用本机 Ollama / LM Studio，也可以连接云端或自建的 OpenAI-compatible Chat Completions 服务。

### 内置预设

| 服务 | Base URL |
| --- | --- |
| Ollama | `http://127.0.0.1:11434/v1` |
| LM Studio | `http://127.0.0.1:1234/v1` |
| OpenAI | `https://api.openai.com/v1` |
| DeepSeek | `https://api.deepseek.com` |
| OpenRouter | `https://openrouter.ai/api/v1` |
| xAI | `https://api.x.ai/v1` |
| 阿里云百炼 / DashScope | `https://dashscope.aliyuncs.com/compatible-mode/v1` |

也可以选择“其他兼容服务”，填写自定义 Base URL、模型 ID 和 API Token。

### 配置步骤

1. 启用 OpenAI-compatible 翻译。
2. 选择服务预设，或填写自定义 Base URL。
3. 使用 Ollama 或 LM Studio 时，点击“刷新本地模型”读取 loopback
   `/v1/models` 列表并选择已安装模型；其他兼容服务仍可手填 model ID。
4. 选择本场会议的译文语言：中文、日文或英文。
5. 点击“测试连接”；测试只发送固定合成短句，不发送会议内容。
6. 确认录音与第三方数据发送提示后开始会议。

当译文语言与识别语言相同时，MeetingRelay 不会请求模型，而是把该条记录为 `skipped`。

Local profile 只接受 loopback 地址。Provider 测试会先确认所选模型存在，再执行真实的合成 Chat Completions 探针；本地服务失败会明确报错，绝不会自动回退到云端。

### 远程 HTTP

`localhost`、`127.0.0.1` 和 `[::1]` 可以直接使用 HTTP。非回环 HTTP 默认拒绝，只有在界面中显式勾选“不安全的远程 HTTP”后才放行。

> [!WARNING]
> 远程 HTTP 会以明文传输 API Token 和 durable final 原文，可能被读取或篡改。风险确认只表达用户选择，不能提供传输机密性或完整性；请优先配置 HTTPS。

API Token 只保存在当前应用进程内存，不写入 localStorage、SQLite、日志或导出。远程 HTTP 的风险确认属于非密钥偏好，可以保存在本机。

## 下载与发布

最新正式版本：[MeetingRelay v0.1.1](https://github.com/AsaZhou923/MeetingRelay/releases/latest)

| 文件 | 大小 | SHA-256 |
| --- | ---: | --- |
| [`MeetingRelay.exe`](https://github.com/AsaZhou923/MeetingRelay/releases/download/v0.1.1/MeetingRelay.exe) | 14,357,504 bytes | `B2276B4EFBF974EFCFA5B7D4A09C9DAE9789D8052880DBB0BDEC45C4C178997C` |

生成完整的同机运行目录：

```powershell
pnpm mvp:release:personal
powershell -ExecutionPolicy Bypass `
  -File target/mvp/personal-release/MeetingRelay.same-machine.ps1
```

输出目录：

```text
target/mvp/personal-release/
├── MeetingRelay.exe
├── MeetingRelay.same-machine.ps1
├── model/
├── runtime/
└── locks/
```

这是 package-local 的个人 Windows 构建，不是 MSI/NSIS 安装程序。

## 数据与安全

- 音频采集、本地 ASR、原文 SQLite 和导出默认只发生在本机。
- 只有启用翻译时，durable final 原文才会发送到所选服务。
- 原文提交发生在网络翻译之前；服务失败不会破坏本地记录。
- API Token 不持久化，也不会出现在复制或导出结果中。
- Base URL 拒绝 URL 凭据、查询参数和片段，远程 HTTP 需要显式确认。
- 第三方服务的数据保留、训练、费用和地域规则由对应供应商决定。
- 请在会议参与者同意录音、转写和必要的第三方数据发送后使用。

不要把 `.env`、API Token、会议数据库或真实会议导出提交到 Git。

## 开发与验证

前端：

```powershell
pnpm --dir apps/desktop test
pnpm --dir apps/desktop typecheck
pnpm --dir apps/desktop build
```

Rust：

```powershell
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-targets --all-features
```

启动与发布契约：

```powershell
powershell -ExecutionPolicy Bypass -File tools/mvp/start.test.ps1
pnpm mvp:release:personal:test
pnpm mvp:acceptance:test
```

CI 配置位于 [`.github/workflows/mvp.yml`](.github/workflows/mvp.yml)，在 Windows Server 2022 上执行依赖安装、前端验证、Rust 格式/Clippy/测试、锁定资产物化和 package-local Release 构建。

## 仓库结构

```text
MeetingRelay/
├── apps/desktop/                         # Tauri 2 桌面应用与前端
├── crates/model-worker-sherpa-native/   # SenseVoice 产品 ASR 后端
├── crates/model-worker-contract/        # ASR 内部接口类型
├── tools/cohere-transcribe/             # Cohere CUDA runtime 与常驻 worker
├── tools/sherpa-native/                 # 锁定资产、校验与 runtime staging
├── tools/mvp/                           # Windows 启动和发布脚本
├── tools/distribution/                  # NSIS staging、SBOM、签名与发布门禁
└── .github/workflows/mvp.yml            # Windows 产品 CI
```

更早的 Phase 0、attestation、benchmark、候选引擎和实验代码保存在归档分支 [`archive/full-repository-before-mvp-trim-2026-07-23`](https://github.com/AsaZhou923/MeetingRelay/tree/archive/full-repository-before-mvp-trim-2026-07-23)。

## 当前限制

- fail-closed ASR registry 现在会在精确 runtime 与模型已安装时提供 Cohere Transcribe 2B 高质量 GPU 档，同时保留 Sherpa / SenseVoice CPU 回退选项；推理失败后不会静默自动换模型。
- Cohere Transcribe 不是真正的原生流式解码。MeetingRelay 把端点分段/partial PCM 送给常驻模型，UI 得到的是分段实时更新，不是 token 级真流式。该路径也不提供词级时间戳、说话人或自动语言检测；会议语言由用户固定，segment 时间轴由 MeetingRelay 维护。
- Cohere 已通过上述本机 CUDA/集成 smoke，但仍需中/日/英同材料、噪声环境和代表性长会对比，才能量化它比 SenseVoice 强多少。
- 当前不做中日英混合识别；每场会议只选择一种识别语言。
- OpenAI-compatible 翻译目前是 final 级非流式请求；已支持单段/整场手动重试和脱敏 attempt provenance，但仍不支持 token streaming、上下文窗口、代理和自定义 Header/请求体。
- 60 分钟麦克风链路和有声系统输出短会已经通过真实设备验收；设备热插拔仍需继续验证。
- 短会已通过本地 ASR → 远程翻译 → SQLite 全链路。仓库也加入了可重复执行的 Windows 验收门禁，覆盖 10–20 分钟 HTTPS 会议、费用/延迟/质量、2 小时双音源 loss/gap 和 timeline p95/max；这些长时真实证据仍需代表性硬件完成。
- 已发布的 `MeetingRelay.exe` 未签名，公开附件不包含模型或 Sherpa runtime。仓库可构建带明确标记的未签名 NSIS 测试安装包；正式安装包仍等待资产再分发审批和 Authenticode 证书。
- 已加入基于显式原始音频捕获的会后说话人区分。若原始音频缺失或不可读，系统会返回 unavailable/failed，不会用文本长度生成伪说话人版本。

## Roadmap

- 完成代表性中、日、英长会的 ASR、翻译质量、费用和时间轴验收。
- 验证设备热插拔以及 2 小时 system/microphone/both 双源采集。
- 根据真实使用结果评估流式翻译是否必要。
- 审批锁定模型/runtime 的再分发记录，签名 NSIS 安装包与 bundled binary，并在第二台干净 Windows 电脑完成安装、升级、回滚拒绝和卸载验收。
- 完成 Cohere 与 SenseVoice 的中/日/英同材料、噪声和长会对比，并补齐受控分发与结构化 meeting/segment provenance。
- 在真实完全断网会议中验收已经实现的 Ollama / LM Studio 模型发现与会前选择，并补齐网络审计和长会资源数据。

## 贡献

欢迎提交 Issue 和 Pull Request。较大的功能或架构改动建议先开 Issue 说明使用场景、数据边界和验收方式。

提交前请至少运行：

```powershell
pnpm --dir apps/desktop test
pnpm --dir apps/desktop typecheck
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-targets --all-features
```

请保持改动小而可审查，不要提交 API Token、真实会议内容、模型文件或本机数据库。

## 许可与分发

MeetingRelay 自有源代码采用 [Apache License 2.0](LICENSE) 许可。该项目许可证不会替代或修改第三方软件、原生运行库及模型资产各自的许可证。

Cohere Transcribe、SenseVoice、Sherpa 原生运行库及其他第三方组件分别受其上游许可证和访问条款约束。Cohere Transcribe 使用 Apache-2.0，但 Hugging Face 权重仍是 gated，且当前不捆绑权重或 Python/CUDA runtime。仓库已经提供 `NOTICE.md`、`THIRD_PARTY_NOTICES.md`、SBOM 生成和严格的再分发审批门禁，但锁文件中的 distribution status 仍为 pending。因此当前正式 GitHub Release 仍只提供未签名 EXE，不捆绑模型和原生 runtime。

## 致谢

- [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)
- [SenseVoice](https://github.com/FunAudioLLM/SenseVoice)
- [Cohere Transcribe](https://huggingface.co/CohereLabs/cohere-transcribe-03-2026)
- [Tauri](https://tauri.app/)
- [Ollama](https://ollama.com/)
- [LM Studio](https://lmstudio.ai/)
