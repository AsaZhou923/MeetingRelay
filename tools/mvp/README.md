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

## Package-local personal release

Build a repeatable personal Windows release from the repository root:

```powershell
pnpm mvp:release:personal
```

The internal-evaluation output is written to `target/mvp/personal-release`:

- `MeetingRelay.exe`
- `MeetingRelay.same-machine.ps1`
- `locks/assets.lock.json` and `locks/Cargo.lock`
- `model/model.int8.onnx`, `model/tokens.txt`, and `model/test_wavs/zh.wav`
- the full seven-file locked Sherpa/ONNX runtime lib inventory under `runtime/lib`
- the four locked runtime DLLs copied beside the executable for Windows loader precedence

This is a package-local personal build for this developer machine and internal evaluation. It is not an MSI, installer, signed distribution, or redistribution package. The generated launcher derives `MEETINGRELAY_SHERPA_MODEL`, `MEETINGRELAY_SHERPA_TOKENS`, `MEETINGRELAY_SHERPA_WAV`, `SHERPA_ONNX_LIB_DIR`, `MEETINGRELAY_SHERPA_LOCK`, and `MEETINGRELAY_PACKAGE_LOCK` from its own folder, then prepends that folder to `PATH` so the adjacent DLLs win loader precedence. The launcher should not contain checkout or target-cache absolute paths.

Downloads remain disabled by default. Use `-AllowDownload` only when acquiring the lock-pinned archives is intentional:

```powershell
powershell -ExecutionPolicy Bypass -File tools/mvp/release.ps1 -AllowDownload
```

Check the release helpers without building:

```powershell
pnpm mvp:release:personal:test
powershell -ExecutionPolicy Bypass -File tools/mvp/release.ps1 -DryRun
```

If Rust compilation is temporarily blocked but `target/release/meetingrelay-desktop.exe` already exists from a previous successful build, an explicit fallback can assemble the package-local release folder from that executable:

```powershell
powershell -ExecutionPolicy Bypass -File tools/mvp/release.ps1 -UseExistingBuild
```

The command logs `used_existing_build=True` when this fallback path was used.
