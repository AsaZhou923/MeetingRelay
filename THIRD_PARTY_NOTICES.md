# Third-party notices

MeetingRelay-authored code is licensed under the Apache License, Version 2.0,
as described in the repository's `LICENSE` and `NOTICE.md` files. The notices
below apply to third-party components and model assets and are not replaced or
modified by the MeetingRelay project license.

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

## Cohere Transcribe model

- Component: `CohereLabs/cohere-transcribe-03-2026`
- Locked revision:
  `b1eacc2686a3d08ceaae5f24a88b1d519620bc09`
- Model file SHA-256:
  `987bd3e141c7bfdb5a78f5db11397ee7737308357e6cc0a3f36a4979b158137a`
- License: Apache-2.0
- Access: gated Hugging Face model; the user must accept the upstream terms.
- Distribution: the weights are downloaded to the user's Hugging Face cache
  and are not bundled in the current MeetingRelay release.

## Cohere Python/CUDA runtime

- Components: PyTorch `2.10.0` (CUDA 12.8), Transformers `5.4.0`,
  Hugging Face Hub `1.25.1`, SentencePiece `0.2.2`, and protobuf `7.35.1`
- Purpose: isolated local Cohere Transcribe inference worker
- Licenses: see the corresponding upstream package metadata.
- Distribution: installed by `tools/cohere-transcribe/setup.ps1` into a
  user-local runtime; not bundled in the current MeetingRelay release.
