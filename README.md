# MeetingRelay

MeetingRelay 是一个面向个人使用的 Windows 本地会议转写工具。当前 main 分支只保留个人 MVP 需要的产品代码、启动脚本、打包脚本和最小验证；Phase 0、attestation、benchmark、候选引擎和历史实验代码已经归档到 [`archive/full-repository-before-mvp-trim-2026-07-23`](https://github.com/AsaZhou923/MeetingRelay/tree/archive/full-repository-before-mvp-trim-2026-07-23)。

## 当前实际能做什么

- 在 Windows 桌面应用中选择系统输出和麦克风输入。
- 开始、暂停、继续、停止一场会议录音与本地转写。
- 使用锁定的 Sherpa / SenseVoice 本地 ASR 作为当前唯一主引擎。
- 在 UI 中实时查看增量文本、音频状态、队列状态和错误提示。
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

### 预发布 EXE

[`v0.0.1` 预发布版](https://github.com/AsaZhou923/MeetingRelay/releases/tag/v0.0.1) 提供单独的 `MeetingRelay.exe`，SHA-256 为 `fc69a400af8001c0fb4979c6f71272d011e3b4660e4f29f983d27dd6805240a1`，用于与该标签源码及锁定资产配套。该文件未签名，也不包含模型和 Sherpa DLL，不能作为独立的一键安装包使用；完整同机运行目录仍应使用下面的 personal release 命令生成。

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
- main 分支不再维护企业审计、完整 provenance、formal evidence 或每个微小 schema 的文档门禁。

## 仓库结构

- `apps/desktop`：Tauri 桌面应用和前端契约。
- `crates/model-worker-sherpa-native`：当前产品 ASR 后端。
- `crates/model-worker-contract`：ASR 后端内部接口类型。
- `tools/sherpa-native`：锁定 Sherpa 资产校验、物化和运行时 staging。
- `tools/mvp`：个人启动和发布脚本及其契约测试。
- `.github/workflows/mvp.yml`：main/PR 唯一产品 CI。
