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

## 当前限制

- 目前只以 Sherpa / SenseVoice 作为产品 ASR；Whisper、FunASR 和更复杂候选评测不在 main 的 MVP 门禁中。
- release 是同机个人使用目录，不是签名安装包，也不声明对外再分发授权。
- 设备热插拔、长时间真实会议、延迟和准确率仍需要在开发者自己的电脑上继续做真实验收。
- 尚未加入独立 fallback；只有真实故障证明当前 Sherpa 恢复能力不足时再增加。
- main 分支不再维护企业审计、完整 provenance、formal evidence 或每个微小 schema 的文档门禁。

## 仓库结构

- `apps/desktop`：Tauri 桌面应用和前端契约。
- `crates/model-worker-sherpa-native`：当前产品 ASR 后端。
- `crates/model-worker-contract`：ASR 后端内部接口类型。
- `tools/sherpa-native`：锁定 Sherpa 资产校验、物化和运行时 staging。
- `tools/mvp`：个人启动和发布脚本及其契约测试。
- `.github/workflows/mvp.yml`：main/PR 唯一产品 CI。
