# Third-party notices

This file summarizes the third-party components that are material to the
Windows distribution. The generated SBOM is the machine-readable source for
release artifact inventory.

## Tauri

- Package: `tauri`, `@tauri-apps/api`, `@tauri-apps/cli`
- Purpose: desktop application shell and build tooling
- License: see upstream package metadata

## Vite and TypeScript

- Package: `vite`, `typescript`
- Purpose: frontend build and type checking
- License: see upstream package metadata

## SQLite / rusqlite

- Package: `rusqlite`
- Purpose: durable local meeting storage
- License: see upstream package metadata

## sherpa-onnx native runtime

- Component: `sherpa-onnx` Windows x64 shared runtime
- Locked version/tag: `v1.13.4`
- License snapshot: `tools/sherpa-native/licenses/apache-2.0-sherpa-onnx.txt`
- ONNX Runtime license snapshot:
  `tools/sherpa-native/licenses/mit-onnxruntime-1.27.0.txt`

## SenseVoice model

- Component: `sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17`
- License snapshots:
  - `tools/sherpa-native/licenses/funasr-model-license-1.0.txt`
  - `tools/sherpa-native/licenses/funasr-model-license-1.1.txt`
- Distribution status is tracked in `tools/sherpa-native/assets.lock.json`.
