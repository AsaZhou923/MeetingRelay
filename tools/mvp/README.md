# MeetingRelay Windows MVP launcher

From the repository root, start the local desktop MVP with cached, lock-verified Sherpa assets:

```powershell
powershell -ExecutionPolicy Bypass -File tools/mvp/start.ps1
```

The launcher verifies the existing Sherpa lock, materializes only sealed assets, stages the locked runtime DLLs, checks/builds the frontend, and runs Tauri in fast development mode without the Rust file watcher. It captures only an allowlisted set of environment assignments from `tools/sherpa-native/materialize.ps1`; it never evaluates script output as PowerShell. Cargo also runs with `--offline --locked` unless downloads were explicitly enabled.

Downloads are disabled by default. If the locked archives and pnpm store are not already available locally, opt in explicitly:

```powershell
powershell -ExecutionPolicy Bypass -File tools/mvp/start.ps1 -AllowDownload
```

Useful repeat-run options:

```powershell
# Verify assets/runtime/frontend without opening the app.
powershell -ExecutionPolicy Bypass -File tools/mvp/start.ps1 -DryRun

# Skip the separate frontend build after a previously successful build.
powershell -ExecutionPolicy Bypass -File tools/mvp/start.ps1 -SkipFrontendBuild
```

Close the application window normally or press `Ctrl+C` in the launcher console. The launcher terminates the pnpm/Tauri child tree and restores every environment variable it temporarily set.
