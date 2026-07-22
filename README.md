# MeetingRelay

MeetingRelay 是一个面向个人使用的 Windows 本地会议转写工具。当前目标不是建立企业审计或形式化供应链证明，而是让开发者本人能够稳定完成一场真实会议：选择音频、实时看到文字、结束后保存和导出，并尽量不因普通错误丢失已经生成的结果。

## 当前可以做什么

- 在 Windows 上通过 Tauri 桌面应用枚举并选择系统输出和麦克风，再进行本地双源采集；默认设备会明确标出。
- 使用本地 Sherpa / SenseVoice 中文 CPU 模型进行真实离线转写。
- 在界面中查看增量文本、已保存 final、音频状态、队列状态和错误。
- 开始、暂停、继续和停止同一场会议；暂停期间音频不会进入 DSP/ASR，final 仅在 SQLite/WAL 提交成功后标记为已保存。
- 复制数据库中的全部已保存转写，或重新打开最近一次会议，并从同一快照导出 JSON、Markdown 和 TXT。
- 在异常退出后恢复已经提交的 final；未提交尾段不会伪装成已保存结果。
- Sherpa 推理遇到可恢复错误时会在提交前自动重试一次；已结束的推理线程会在下一场会议前重建。
- 生成包含程序、锁定模型、运行时和相对路径启动器的个人 Windows Release 目录，无需从源码目录启动。

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

也可以生成并运行个人 Release 目录：

```powershell
pnpm mvp:release:personal
powershell -ExecutionPolicy Bypass -File target/mvp/personal-release/MeetingRelay.same-machine.ps1
```

该目录用于开发者本人本机使用和内部评估；它不是签名安装包，也没有获得模型或运行时再分发授权。

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

- 当前个人 MVP 固定同时采集系统输出和麦克风；单一来源模式暂缓，只有真实使用证明需要时再加入。
- 运行中物理设备热插拔不会自动切换设备；应用会保留已提交文本并提示停止、重新选择和重新开始，物理拔插回归尚未执行。
- Sherpa / SenseVoice 是唯一产品 ASR；Whisper 和 FunASR 只有工具、探针或离线契约，未接入桌面转写。
- 已有一次超过 15 分钟的真机 soak 记录，但尚未完成约 60 分钟真实会议验收。
- 暂停/继续、全量复制、最近会议重开和同机个人 Release 已通过短时真机 smoke，但尚未做物理设备拔插和真实长会压力回归。
- 个人 Release 是约 295 MB 的目录式可执行程序，不是 MSI/NSIS 安装包；签名和对外可重复分发属于 Deferred。
- fallback 未实现；当前 Sherpa 的一次自动恢复和下场会议前重建已经满足个人 MVP，只有真实故障证明不足时才增加一个 fallback。

## 文档

核心项目文档位于 `E:\Project Code\docs\01 - Projects\MeetingRelay`，其中任务状态、实现状态和测试状态是当前权威来源。

原顶层 README 已原样保存在 [README.phase0-archive.md](README.phase0-archive.md)。Phase 0、attestation、benchmark 和 provenance 工具继续保留，但属于 Optional Hardening / Archived Phase 0，不阻塞个人 MVP。
