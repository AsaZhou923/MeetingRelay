import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { encodeCanonicalJsonLine } from "../phase0-harness/canonical-json.mjs";
import {
  CandidateConformanceValidationError,
  extractCandidateHostRecord,
  sanitizeCandidateHostEnvironment,
  runReleaseNativeCandidateConformance,
  validateNativeCandidateConformanceRecord,
  validateStagedRuntimeClosure,
} from "./validate-candidate-conformance.mjs";
import { DEFAULT_LOCK_PATH } from "./validate-lock.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function descriptor() {
  return {
    engine_id: "sherpa-onnx",
    engine_version: "1.13.4",
    execution_provider: "cpu",
    languages: ["zh"],
    model_id: "sensevoice-zh-en-ja-ko-yue-int8-2024-07-17",
    model_license_id: "LicenseRef-FunASR-Model-1.1-Internal-Evaluation",
    model_manifest_sha256: "1".repeat(64),
    model_sha256: "2".repeat(64),
    offline: true,
    package_lock_sha256: "3".repeat(64),
    parameter_sha256: "4".repeat(64),
    quantization: "int8",
    runtime_id: "sherpa-onnx-shared-cpu",
    runtime_sha256: "5".repeat(64),
    runtime_version: "1.27.0",
    streaming: true,
  };
}

function fixture() {
  const executableSha256 = sha256(Buffer.from("execution-host", "utf8"));
  const schemaRegistrySha256 = sha256(Buffer.from("schema-registry", "utf8"));
  const finalTranscriptSha256 = sha256(Buffer.from("private transcript", "utf8"));
  const workerManifest = {
    descriptor: descriptor(),
    executable_sha256: executableSha256,
    role: "native-candidate",
    schema_registry_sha256: schemaRegistrySha256,
    worker_build_sha256: executableSha256,
    worker_id: "meetingrelay-sherpa-native-candidate-host-v1",
  };
  const record = {
    authority: {
      formal_claims: "none",
      production_evidence: false,
    },
    checks: {
      bounded_audio_gap: true,
      bounded_credit_backpressure: true,
      cancellation: true,
      final_and_replay: true,
      handshake_manifest: true,
      heartbeat_progress: true,
      loaded_runtime_identity: true,
      rust_panic_containment: true,
      prepare: true,
      provenance_join: true,
      restart_replay: true,
      stable_failure: true,
    },
    execution: {
      actual_native_inference: true,
      backend_execute_calls: 1,
      final_transcript_sha256: finalTranscriptSha256,
      final_transcript_utf8_bytes: 18,
      fixture_wav_sha256:
        "b77f1794fe374a0ba1ee1dc458bfaf9349496cbbfc32780c50ba3c5a7ad8e373",
      outer_process_boundary: "crash-containment-only",
      resource_performance_measurement: "unmeasured",
      semantic_transport: "in-process",
    },
    kind: "meetingrelay-native-candidate-conformance-v1",
    limitations: [
      "native-process-abort-isolation-not-tested",
      "onsite-quality-performance-not-measured",
      "resource-usage-not-measured",
    ],
    schema_version: "1.0",
    worker_manifest: workerManifest,
  };
  return {
    descriptor: descriptor(),
    executableBytes: Buffer.from("execution-host", "utf8"),
    record,
    recordBytes: Buffer.from(encodeCanonicalJsonLine(record), "utf8"),
    schemaRegistryBytes: Buffer.from("schema-registry", "utf8"),
  };
}

async function expectCode(run, code) {
  await assert.rejects(
    run,
    (error) =>
      error instanceof CandidateConformanceValidationError && error.code === code,
    `expected ${code}`,
  );
}

function successfulSpawnResult(stdout = fixture().recordBytes) {
  return {
    error: undefined,
    signal: null,
    status: 0,
    stderr: Buffer.alloc(0),
    stdout,
  };
}

test("canonical native candidate conformance is a non-production supporting record with complete joins", () => {
  const input = fixture();
  const result = validateNativeCandidateConformanceRecord(input);

  assert.deepEqual(result, {
    executableSha256: sha256(input.executableBytes),
    finalTranscriptSha256: input.record.execution.final_transcript_sha256,
    finalTranscriptUtf8Bytes: input.record.execution.final_transcript_utf8_bytes,
    schemaRegistrySha256: sha256(input.schemaRegistryBytes),
    workerId: "meetingrelay-sherpa-native-candidate-host-v1",
  });
});

test("release conformance accepts the sealed candidate lock layout before validating later joins", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "meetingrelay-conf-lock-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const lockDirectory = path.join(root, "assets");
  const licenseDirectory = path.join(root, "licenses");
  await Promise.all([mkdir(lockDirectory), mkdir(licenseDirectory)]);
  const lockPath = path.join(lockDirectory, "assets.lock.json");
  await copyFile(DEFAULT_LOCK_PATH, lockPath);
  for (const name of [
    "apache-2.0-sherpa-onnx.txt",
    "funasr-model-license-1.1.txt",
    "mit-onnxruntime-1.27.0.txt",
  ]) {
    await copyFile(path.join(HERE, "licenses", name), path.join(licenseDirectory, name));
  }

  await expectCode(
    () => runReleaseNativeCandidateConformance({ assetLockPath: lockPath }),
    "CONF_ASSET_LOCK_JOIN",
  );
  await expectCode(
    () =>
      runReleaseNativeCandidateConformance({
        assetLicenseRoot: root,
        assetLockPath: lockPath,
        schemaRegistryPath: path.join(root, "missing-schema.json"),
      }),
    "CONF_SCHEMA_JOIN",
  );
});

test("conformance authority cannot be promoted to formal or production evidence", async () => {
  const input = fixture();
  input.record.authority.formal_claims = "performance";
  input.record.authority.production_evidence = true;
  input.recordBytes = Buffer.from(encodeCanonicalJsonLine(input.record), "utf8");

  await expectCode(
    async () => validateNativeCandidateConformanceRecord(input),
    "CONF_AUTHORITY",
  );
});

test("conformance rejects executable, schema, descriptor, and canonical-byte drift", async () => {
  for (const drift of ["executable", "schema", "descriptor", "canonical"]) {
    const input = fixture();
    if (drift === "executable") {
      input.record.worker_manifest.executable_sha256 = "9".repeat(64);
      input.recordBytes = Buffer.from(encodeCanonicalJsonLine(input.record), "utf8");
    } else if (drift === "schema") {
      input.record.worker_manifest.schema_registry_sha256 = "9".repeat(64);
      input.recordBytes = Buffer.from(encodeCanonicalJsonLine(input.record), "utf8");
    } else if (drift === "descriptor") {
      input.record.worker_manifest.descriptor.runtime_version = "unexpected";
      input.recordBytes = Buffer.from(encodeCanonicalJsonLine(input.record), "utf8");
    } else {
      input.recordBytes = Buffer.from(
        `${JSON.stringify(input.record, null, 2)}\n`,
        "utf8",
      );
    }
    const code = {
      canonical: "CONF_CANONICAL_JSON",
      descriptor: "CONF_DESCRIPTOR_JOIN",
      executable: "CONF_EXECUTABLE_JOIN",
      schema: "CONF_SCHEMA_JOIN",
    }[drift];
    await expectCode(
      async () => validateNativeCandidateConformanceRecord(input),
      code,
    );
  }
});

test("conformance requires every semantic check and actual native final proof", async () => {
  for (const drift of ["check", "loaded-runtime", "native", "transcript"]) {
    const input = fixture();
    if (drift === "check") {
      input.record.checks.rust_panic_containment = false;
    } else if (drift === "loaded-runtime") {
      input.record.checks.loaded_runtime_identity = false;
    } else if (drift === "native") {
      input.record.execution.actual_native_inference = false;
    } else {
      input.record.execution.final_transcript_utf8_bytes = 0;
    }
    input.recordBytes = Buffer.from(encodeCanonicalJsonLine(input.record), "utf8");
    await expectCode(
      async () => validateNativeCandidateConformanceRecord(input),
      drift === "check" || drift === "loaded-runtime"
        ? "CONF_CHECKS"
        : "CONF_EXECUTION",
    );
  }
});

test("conformance rejects scope kind, version, and limitation drift", async () => {
  for (const drift of ["kind", "schema", "limitations"]) {
    const input = fixture();
    if (drift === "kind") {
      input.record.kind = "meetingrelay-native-candidate-conformance-v2";
    } else if (drift === "schema") {
      input.record.schema_version = "2.0";
    } else {
      input.record.limitations = ["onsite-quality-performance-not-measured"];
    }
    input.recordBytes = Buffer.from(encodeCanonicalJsonLine(input.record), "utf8");
    await expectCode(
      async () => validateNativeCandidateConformanceRecord(input),
      "CONF_SCOPE",
    );
  }
});

test("conformance rejects worker identity and role drift", async () => {
  for (const drift of ["worker", "role"]) {
    const input = fixture();
    if (drift === "worker") {
      input.record.worker_manifest.worker_id = "unlocked-worker";
    } else {
      input.record.worker_manifest.role = "sidecar-candidate";
    }
    input.recordBytes = Buffer.from(encodeCanonicalJsonLine(input.record), "utf8");
    await expectCode(
      async () => validateNativeCandidateConformanceRecord(input),
      "CONF_MANIFEST_IDENTITY",
    );
  }
});

test("conformance rejects unknown root, manifest, and descriptor fields", async () => {
  for (const drift of ["root", "manifest", "descriptor"]) {
    const input = fixture();
    const code = {
      descriptor: "CONF_DESCRIPTOR_JOIN",
      manifest: "CONF_MANIFEST_KEYS",
      root: "CONF_SCHEMA_KEYS",
    }[drift];
    if (drift === "root") {
      input.record.unexpected = true;
    } else if (drift === "manifest") {
      input.record.worker_manifest.unexpected = true;
    } else {
      input.record.worker_manifest.descriptor.unexpected = true;
    }
    input.recordBytes = Buffer.from(encodeCanonicalJsonLine(input.record), "utf8");
    await expectCode(
      async () => validateNativeCandidateConformanceRecord(input),
      code,
    );
  }
});

test("conformance rejects execution proof and boundary-label drift", async () => {
  for (const drift of [
    "calls",
    "wav",
    "transcript",
    "outer-boundary",
    "measurement",
    "transport",
  ]) {
    const input = fixture();
    if (drift === "calls") {
      input.record.execution.backend_execute_calls = 2;
    } else if (drift === "wav") {
      input.record.execution.fixture_wav_sha256 = "6".repeat(64);
    } else if (drift === "transcript") {
      input.record.execution.final_transcript_sha256 = "0".repeat(64);
    } else if (drift === "outer-boundary") {
      input.record.execution.outer_process_boundary = "protocol-ipc";
    } else if (drift === "measurement") {
      input.record.execution.resource_performance_measurement = "measured";
    } else {
      input.record.execution.semantic_transport = "isolated-process";
    }
    input.recordBytes = Buffer.from(encodeCanonicalJsonLine(input.record), "utf8");
    await expectCode(
      async () => validateNativeCandidateConformanceRecord(input),
      "CONF_EXECUTION",
    );
  }
});

test("conformance rejects oversized and invalid UTF-8 records", async () => {
  for (const recordBytes of [Buffer.alloc(65_537, 0x61), Buffer.from([0xff])]) {
    const input = fixture();
    input.recordBytes = recordBytes;
    await expectCode(
      async () => validateNativeCandidateConformanceRecord(input),
      "CONF_CANONICAL_JSON",
    );
  }
});

test("host supervision returns the bounded canonical stdout from a clean exit", () => {
  const result = successfulSpawnResult();
  assert.strictEqual(extractCandidateHostRecord(result), result.stdout);
});

test("host supervision rejects a nonzero exit", async () => {
  const result = successfulSpawnResult();
  result.status = 2;
  await expectCode(async () => extractCandidateHostRecord(result), "CONF_HOST_EXECUTION");
});

test("host supervision rejects a signal termination", async () => {
  const result = successfulSpawnResult();
  result.status = null;
  result.signal = "SIGABRT";
  await expectCode(async () => extractCandidateHostRecord(result), "CONF_HOST_EXECUTION");
});

test("host supervision rejects a spawn error", async () => {
  const result = successfulSpawnResult();
  result.error = Object.assign(new Error("timed out"), { code: "ETIMEDOUT" });
  await expectCode(async () => extractCandidateHostRecord(result), "CONF_HOST_EXECUTION");
});

test("host supervision rejects stderr output", async () => {
  const result = successfulSpawnResult();
  result.stderr = Buffer.from("unexpected diagnostic", "utf8");
  await expectCode(async () => extractCandidateHostRecord(result), "CONF_HOST_EXECUTION");
});

test("host supervision rejects an empty stdout record", async () => {
  const result = successfulSpawnResult(Buffer.alloc(0));
  await expectCode(async () => extractCandidateHostRecord(result), "CONF_HOST_EXECUTION");
});

test("host supervision rejects stdout beyond the record bound", async () => {
  const result = successfulSpawnResult(Buffer.alloc(65_537, 0x61));
  await expectCode(async () => extractCandidateHostRecord(result), "CONF_HOST_EXECUTION");
});

test("host supervision removes ambient sherpa, Rust diagnostics, and PATH case-insensitively", () => {
  const sanitized = sanitizeCandidateHostEnvironment(
    {
      MEETINGRELAY_SHERPA_MODEL: "ambient-model",
      meetingrelay_sherpa_unexpected: "ambient-extension",
      PATH: "C:\\also-untrusted-bin",
      pAtH: "C:\\untrusted-bin",
      rust_backtrace: "full",
      Sherpa_Onnx_Lib_Dir: "ambient-runtime",
      systemroot: "C:\\Windows",
      TEMP: "C:\\Temp",
    },
    "C:\\meetingrelay\\target\\release",
  );
  assert.deepEqual(sanitized, {
    PATH: "C:\\meetingrelay\\target\\release;C:\\Windows\\System32",
    systemroot: "C:\\Windows",
    TEMP: "C:\\Temp",
  });
});

test(
  "staged Release runtime closure is exact and postflight rejects size or hash tampering",
  async (t) => {
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "meetingrelay-conf-"));
    t.after(() => rm(temporaryRoot, { force: true, recursive: true }));
    const releaseDirectory = path.join(temporaryRoot, "release");
    await mkdir(releaseDirectory);
    const executablePath = path.join(
      releaseDirectory,
      process.platform === "win32" ? "fixture-host.exe" : "fixture-host",
    );
    await writeFile(executablePath, "host");
    const runtimeFiles = new Map([
      ["onnxruntime.dll", Buffer.from("locked-onnx-runtime", "utf8")],
      ["sherpa-onnx-c-api.dll", Buffer.from("locked-sherpa-runtime", "utf8")],
    ]);
    const lock = {
      runtime: {
        archive: {
          inventory: [...runtimeFiles].map(([fileName, bytes]) => ({
            path: `lib/${fileName}`,
            sha256: sha256(bytes),
            size_bytes: bytes.length,
          })),
        },
      },
    };
    for (const [fileName, bytes] of runtimeFiles) {
      await writeFile(path.join(releaseDirectory, fileName), bytes);
    }

    const before = await validateStagedRuntimeClosure(executablePath, lock);
    assert.deepEqual(
      before.map(({ fileName }) => fileName),
      [...runtimeFiles.keys()],
    );

    const targetPath = path.join(releaseDirectory, "onnxruntime.dll");
    const original = runtimeFiles.get("onnxruntime.dll");
    await writeFile(targetPath, Buffer.alloc(original.length, 0x61));
    await expectCode(
      () =>
        validateStagedRuntimeClosure(
          executablePath,
          lock,
          "CONF_POSTFLIGHT_JOIN",
        ),
      "CONF_POSTFLIGHT_JOIN",
    );
    await writeFile(targetPath, Buffer.concat([original, Buffer.from("x")]));
    await expectCode(
      () =>
        validateStagedRuntimeClosure(
          executablePath,
          lock,
          "CONF_POSTFLIGHT_JOIN",
        ),
      "CONF_POSTFLIGHT_JOIN",
    );
  },
);

test(
  "staged Release runtime closure rejects a locked DLL that is not a regular file",
  async (t) => {
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "meetingrelay-conf-"));
    t.after(() => rm(temporaryRoot, { force: true, recursive: true }));
    const releaseDirectory = path.join(temporaryRoot, "release");
    await mkdir(releaseDirectory);
    const executablePath = path.join(releaseDirectory, "fixture-host.exe");
    const runtimeBytes = Buffer.from("locked-runtime", "utf8");
    await writeFile(executablePath, "host");
    await mkdir(path.join(releaseDirectory, "locked.dll"));
    await expectCode(
      () =>
        validateStagedRuntimeClosure(executablePath, {
          runtime: {
            archive: {
              inventory: [
                {
                  path: "lib/locked.dll",
                  sha256: sha256(runtimeBytes),
                  size_bytes: runtimeBytes.length,
                },
              ],
            },
          },
        }),
      "CONF_STAGED_RUNTIME_JOIN",
    );
  },
);
