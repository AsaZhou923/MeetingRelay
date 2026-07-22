# MeetingRelay

MeetingRelay 是一个面向个人使用的 Windows 本地会议转写工具。当前目标不是建立企业审计或形式化供应链证明，而是让开发者本人能够稳定完成一场真实会议：选择音频、实时看到文字、结束后保存和导出，并尽量不因普通错误丢失已经生成的结果。

## 当前可以做什么

- 在 Windows 上通过 Tauri 桌面应用采集默认系统输出和默认麦克风。
- 使用本地 Sherpa / SenseVoice 中文 CPU 模型进行真实离线转写。
- 在界面中查看增量文本、已保存 final、音频状态、队列状态和错误。
- 开始和停止会议；final 仅在 SQLite/WAL 提交成功后标记为已保存。
- 重新打开最近一次会议，并从同一快照导出 JSON、Markdown 和 TXT。
- 在异常退出后恢复已经提交的 final；未提交尾段不会伪装成已保存结果。

这些是已接入桌面产品的运行链路，不是 mock 或 contract-only 声明。

## 快速启动

要求：Windows、Rust 工具链、Node.js/pnpm，以及已缓存的锁定 Sherpa 资产和运行时。

```powershell
# 只检查资产、运行时和前端，不打开应用
powershell -ExecutionPolicy Bypass -File tools/mvp/start.ps1 -DryRun

# 启动本地桌面应用
powershell -ExecutionPolicy Bypass -File tools/mvp/start.ps1
```

首次缺少锁定资产或 pnpm 缓存时，才显式允许下载：

```powershell
powershell -ExecutionPolicy Bypass -File tools/mvp/start.ps1 -AllowDownload
```

更多启动器说明见 [tools/mvp/README.md](tools/mvp/README.md)。

## 常用验证

```powershell
pnpm --dir apps/desktop test
pnpm --dir apps/desktop typecheck
pnpm --dir apps/desktop build
cargo test -p meetingrelay-desktop
powershell -ExecutionPolicy Bypass -File tools/mvp/start.test.ps1
```

## 当前限制

- 当前只能使用默认系统输出和默认麦克风，且两者同时启动；设备选择尚未接通。
- 只有开始和停止，没有暂停/继续。
- Sherpa / SenseVoice 是唯一产品 ASR；Whisper 和 FunASR 只有工具、探针或离线契约，未接入桌面转写。
- 已有一次超过 15 分钟的真机 soak 记录，但尚未完成约 60 分钟真实会议验收。
- 没有专用复制按钮、ASR 自动重启或已验证 fallback。
- 当前启动器运行 Tauri 开发模式；Windows 安装包和可重复分发尚未完成。
- 模型/运行时仍依赖仓库内的锁定资产流程，不是面向普通用户的安装体验。

## 文档

核心项目文档位于 `E:\Project Code\docs\01 - Projects\MeetingRelay`，其中任务状态、实现状态和测试状态是当前权威来源。

原顶层 README 已原样保存在 [README.phase0-archive.md](README.phase0-archive.md)。Phase 0、attestation、benchmark 和 provenance 工具继续保留，但属于 Optional Hardening / Archived Phase 0，不阻塞个人 MVP。
