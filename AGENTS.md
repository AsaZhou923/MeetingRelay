# MeetingRelay project guidance

## Disk-space discipline

- Treat generated build, test, staging, acceptance, and unpublished packaging outputs as ephemeral. Remove outputs created by the current task after their evidence has been captured, unless the user explicitly asks to retain a frozen artifact.
- Reuse the workspace default Cargo target directory. Do not create persistent top-level variants such as `target/review-*`, `target/verify-*`, `target/user-feedback-*`, or version-specific Cargo target directories.
- When an isolated `CARGO_TARGET_DIR` is required to prevent stale-runtime contamination, place it under `target/agent-work/<stable-task-id>` and delete that exact directory before the final response.
- The following project-local asset caches are durable and must be preserved during ordinary cleanup:
  - `target/cohere-transcribe/`
  - `target/sherpa-native/archives/`
  - `target/sherpa-native/extracted/`
- Never delete all of `target/`, run broad wildcard cleanup, or run `cargo clean` without first preserving and revalidating the durable asset caches above.
- Do not duplicate model/runtime files into multiple test fixtures when the canonical cache can be referenced read-only. If a test requires staging, remove the staged copy after the test.
- Do not retain agent-created personal release packages, installer staging trees, screenshots, downloaded CI artifacts, or acceptance fixtures after verification unless they are the explicitly frozen deliverable.
- Before and after any task that performs a large build, model materialization, packaging, or acceptance run, record `du -sh target`. If the task adds more than 2 GiB, clean its ephemeral outputs or report the exact retained path and reason.
- Before deleting generated content, check for active Cargo, Rust, MeetingRelay, Python/model-worker, and packaging processes. Use exact paths, preserve unrelated user changes, and verify the retained model paths and hashes afterward.
- Keep secrets and durable user data out of `target/`; store only regenerable artifacts and the explicitly listed local asset caches there.
