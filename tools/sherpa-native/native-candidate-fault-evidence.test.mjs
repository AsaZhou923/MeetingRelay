import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";

import { encodeCanonicalJsonLine } from "../phase0-harness/canonical-json.mjs";
import {
  NativeCandidateFaultEvidenceError,
  publishNativeCandidateFaultEvidence,
  requireProcessesExited,
  runFaultBoundaryProcess,
  runNativeCandidateFaultEvidence,
  validateNativeCandidateFaultEvidenceFile,
  validateNativeCandidateFaultEvidenceRecord,
} from "./native-candidate-fault-evidence.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_SHA =
  "0a539001c01b44b60267af4f3da4202349d489d89387dc444622fad053bfeb0b";
const FAULT_HOST_SHA = "1".repeat(64);
const BOUNDARY_SHA = "2".repeat(64);
const RUNTIME_DLLS = Object.freeze([
  Object.freeze({ name: "onnxruntime.dll", sha256: "3".repeat(64) }),
  Object.freeze({ name: "sherpa-onnx-c-api.dll", sha256: "4".repeat(64) }),
]);
const LIMITATIONS = Object.freeze([
  "injected-faults-not-natural-sherpa-defects",
  "fresh-process-recovery-only",
  "product-replay-and-restart-budget-not-tested",
  "onsite-quality-performance-resources-not-measured",
]);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function recovery(seed) {
  return {
    backend_execute_calls: 1,
    check_summary: { passed: 12, total: 12 },
    conformance_record_sha256: sha256(Buffer.from(seed, "utf8")),
    fresh_process: true,
  };
}

function fixtureRecord(abortStatus = 0x40000015) {
  const abortUnsigned = abortStatus >>> 0;
  return {
    authority: { formal_claims: "none", production_evidence: false },
    kind: "meetingrelay-native-candidate-fault-evidence-v1",
    lanes: [
      {
        checkpoint: "real-prepare-loaded-runtime-identity",
        fault_artifact_sha256: FAULT_HOST_SHA,
        fault_injected: true,
        loaded_runtime: RUNTIME_DLLS.map((value) => ({ ...value })),
        marker_sha256: "5".repeat(64),
        mode: "abort-after-prepare",
        observation: {
          natural_ntstatus: true,
          ntstatus_hex: `0x${abortUnsigned.toString(16).padStart(8, "0")}`,
          signed_i32: abortUnsigned | 0,
          timed_out: false,
          unsigned_u32: abortUnsigned,
        },
        postflight_snapshot_sha256: SNAPSHOT_SHA,
        recovery: recovery("abort-recovery"),
        representative_only: false,
      },
      {
        checkpoint: "successful-real-inference",
        fault_artifact_sha256: FAULT_HOST_SHA,
        fault_injected: true,
        loaded_runtime: RUNTIME_DLLS.map((value) => ({ ...value })),
        marker_sha256: "6".repeat(64),
        mode: "hang-after-inference",
        observation: {
          natural_ntstatus: false,
          ntstatus_hex: null,
          signed_i32: null,
          timed_out: true,
          unsigned_u32: null,
        },
        postflight_snapshot_sha256: SNAPSHOT_SHA,
        recovery: recovery("hang-recovery"),
        representative_only: false,
      },
      {
        checkpoint: "before-injected-access-violation",
        fault_artifact_sha256: BOUNDARY_SHA,
        fault_injected: true,
        loaded_runtime: [],
        marker_sha256: "7".repeat(64),
        mode: "representative-av",
        observation: {
          natural_ntstatus: true,
          ntstatus_hex: "0xc0000005",
          signed_i32: -1_073_741_819,
          timed_out: false,
          unsigned_u32: 3_221_225_477,
        },
        postflight_snapshot_sha256: SNAPSHOT_SHA,
        recovery: recovery("av-recovery"),
        representative_only: true,
      },
    ],
    limitations: [...LIMITATIONS],
    locked_input_snapshot_sha256: SNAPSHOT_SHA,
    schema_version: "1.0",
  };
}

function recordBytes(record = fixtureRecord()) {
  return Buffer.from(encodeCanonicalJsonLine(record), "utf8");
}

async function expectCode(run, code) {
  await assert.rejects(
    run,
    (error) =>
      error instanceof NativeCandidateFaultEvidenceError && error.code === code,
    `expected ${code}`,
  );
}

async function pathIsAbsent(target) {
  try {
    await lstat(target);
    return false;
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    throw error;
  }
}

async function createHarness(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "meetingrelay-fault-test-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const markerRoot = path.join(root, "markers");
  const outputEvidencePath = path.join(root, "fault-evidence.json");
  const faultHostPath = path.join(root, "release", "meetingrelay-sherpa-candidate-fault-host.exe");
  const boundaryFixturePath = path.join(
    root,
    "msvc",
    "meetingrelay-native-fatal-boundary-fixture.exe",
  );
  const input = {
    assetLockPath: path.join(root, "assets.lock.json"),
    boundaryFixturePath,
    executablePath: path.join(root, "release", "meetingrelay-sherpa-candidate-execution-host.exe"),
    faultHostPath,
    modelPath: path.join(root, "model.onnx"),
    outputEvidencePath,
    packageLockPath: path.join(root, "Cargo.lock"),
    runtimeLibDir: path.join(root, "runtime"),
    schemaRegistryPath: path.join(root, "candidate-schema-registry.json"),
    tokensPath: path.join(root, "tokens.txt"),
    wavPath: path.join(root, "input.wav"),
  };
  const calls = {
    cleanup: 0,
    conformance: 0,
    postflight: 0,
    process: 0,
    processExit: [],
  };

  const prepareInputs = async () => ({
    assetLockSha256: "8".repeat(64),
    boundaryFixture: {
      resolved: boundaryFixturePath,
      sha256: BOUNDARY_SHA,
      sizeBytes: 100,
    },
    expectedLoadedRuntime: RUNTIME_DLLS.map((value) => ({ ...value })),
    faultHost: {
      resolved: faultHostPath,
      sha256: FAULT_HOST_SHA,
      sizeBytes: 200,
    },
    stagedRuntime: RUNTIME_DLLS.map((entry) => ({
      fileName: entry.name,
      sha256: entry.sha256,
      sizeBytes: 10,
    })),
  });
  const conformanceRunner = async () => {
    calls.conformance += 1;
    const snapshot =
      options.snapshotDriftAt === calls.conformance
        ? "9".repeat(64)
        : SNAPSHOT_SHA;
    return {
      backendExecuteCalls: 1,
      checkSummary: {
        passed:
          options.badCheckSummaryAt === calls.conformance ? 11 : 12,
        total: 12,
      },
      conformanceRecordSha256: sha256(
        Buffer.from(`conformance-${calls.conformance}`, "utf8"),
      ),
      lockedInputSnapshotSha256: snapshot,
    };
  };
  const createMarkerRoot = async () => {
    await mkdir(markerRoot);
    if (options.preexistingMarker) {
      await writeFile(
        path.join(markerRoot, "abort-launcher.json"),
        "occupied\n",
        { flag: "wx" },
      );
    }
    return markerRoot;
  };
  const postflightInputs = async () => {
    calls.postflight += 1;
    if (options.postflightFailureAt === calls.postflight) {
      throw new NativeCandidateFaultEvidenceError(
        "FAULT_EVIDENCE_POSTFLIGHT_IDENTITY",
      );
    }
  };
  const processExitChecker = async (pids) => {
    calls.processExit.push([...pids]);
    if (options.processExitFailureAt === calls.processExit.length) {
      throw new NativeCandidateFaultEvidenceError(
        "FAULT_EVIDENCE_PROCESS_LIVENESS",
      );
    }
  };
  const processRunner = async ({ arguments: arguments_ }) => {
    calls.process += 1;
    const mode = arguments_[0] === "representative-av" ? "representative-av" : arguments_[1];
    const brokerPid = 4_100 + calls.process;
    const childPid = 5_100 + calls.process;
    const clean = {
      brokerCloseObserved: true,
      error: null,
      outputOverflow: false,
      pid: brokerPid,
      signal: null,
      stderr: Buffer.alloc(0),
      stdout:
        options.stdoutAt === calls.process
          ? Buffer.from("forbidden", "utf8")
          : Buffer.alloc(0),
      timedOut: false,
    };
    if (mode === "representative-av") {
      await writeFile(
        arguments_[1],
        encodeCanonicalJsonLine({
          checkpoint: "before-injected-access-violation",
          expected_exit_code_dword: 3_221_225_477,
          fault_origin: "injected-representative-boundary",
          kind: "meetingrelay-native-fatal-representative-av-marker-v1",
          sherpa_defect: false,
        }),
        { flag: "wx" },
      );
      return { ...clean, status: 3_221_225_477 };
    }
    const launcherPath = arguments_[2];
    const resultPath = arguments_[3];
    const faultMarkerPath = arguments_[5];
    await writeFile(
      launcherPath,
      encodeCanonicalJsonLine({
        broker_pid: brokerPid,
        checkpoint: "child-resumed-under-kill-on-close-job",
        child_pid: childPid,
        kind: "meetingrelay-native-fatal-launcher-marker-v1",
        mode,
      }),
      { flag: "wx" },
    );
    const faultMarker = {
      checkpoint:
        mode === "abort-after-prepare"
          ? "real-prepare-loaded-runtime-identity"
          : "successful-real-inference",
      kind: "meetingrelay-native-candidate-fault-checkpoint-v1",
      locked_input_snapshot_sha256: SNAPSHOT_SHA,
      mode,
      process_id: childPid,
      runtime_dlls: RUNTIME_DLLS.map((value) => ({ ...value })),
      schema_version: "1.0",
      self_sha256: FAULT_HOST_SHA,
    };
    if (mode === "hang-after-inference") {
      faultMarker.backend_execute_calls = 1;
    }
    await writeFile(faultMarkerPath, encodeCanonicalJsonLine(faultMarker), {
      flag: "wx",
    });
    if (mode === "abort-after-prepare") {
      await writeFile(
        resultPath,
        encodeCanonicalJsonLine({
          checkpoint: "child-exit-observed",
          child_exit_code_dword: options.abortStatus ?? 0x40000015,
          kind: "meetingrelay-native-fatal-result-marker-v1",
          mode,
        }),
        { flag: "wx" },
      );
      return { ...clean, status: 0 };
    }
    return {
      ...clean,
      signal: "SIGKILL",
      status: options.hangNaturalExit ? 76 : null,
      timedOut: !options.hangNaturalExit,
    };
  };

  const dependencies = {
    conformanceRunner,
    createMarkerRoot,
    postflightInputs,
    prepareInputs,
    processExitChecker,
    processRunner,
  };
  if (options.cleanupFailure) {
    dependencies.cleanupMarkerRoot = async () => {
      calls.cleanup += 1;
      throw new NativeCandidateFaultEvidenceError("FAULT_EVIDENCE_CLEANUP");
    };
  }
  return { calls, dependencies, input, markerRoot, outputEvidencePath, root };
}

test("strict canonical evidence accepts an observed, non-hardcoded abort status", () => {
  const input = recordBytes(fixtureRecord(0x40000015));
  const result = validateNativeCandidateFaultEvidenceRecord(input);
  assert.equal(result.evidenceSha256, sha256(input));
  assert.equal(result.laneCount, 3);
  assert.equal(result.lockedInputSnapshotSha256, SNAPSHOT_SHA);
  assert.equal(result.record.lanes[0].observation.ntstatus_hex, "0x40000015");
});

test("authority, kind, limitations, and exact root keys cannot drift", async () => {
  for (const drift of ["authority", "kind", "limitations", "root"]) {
    const record = fixtureRecord();
    if (drift === "authority") {
      record.authority.production_evidence = true;
    } else if (drift === "kind") {
      record.kind = "meetingrelay-native-candidate-fault-evidence-v2";
    } else if (drift === "limitations") {
      record.limitations.reverse();
    } else {
      record.unexpected = true;
    }
    await expectCode(
      async () => validateNativeCandidateFaultEvidenceRecord(recordBytes(record)),
      {
        authority: "FAULT_EVIDENCE_AUTHORITY",
        kind: "FAULT_EVIDENCE_SCOPE",
        limitations: "FAULT_EVIDENCE_SCOPE",
        root: "FAULT_EVIDENCE_SCHEMA",
      }[drift],
    );
  }
});

test("AV representation is exact lowercase DWORD/i32/hex and hang has no natural NTSTATUS", async () => {
  for (const drift of ["av-hex", "av-signed", "hang-status", "abort-zero"]) {
    const record = fixtureRecord();
    if (drift === "av-hex") {
      record.lanes[2].observation.ntstatus_hex = "0xC0000005";
    } else if (drift === "av-signed") {
      record.lanes[2].observation.signed_i32 += 1;
    } else if (drift === "hang-status") {
      record.lanes[1].observation.unsigned_u32 = 1;
    } else {
      Object.assign(record.lanes[0].observation, {
        ntstatus_hex: "0x00000000",
        signed_i32: 0,
        unsigned_u32: 0,
      });
    }
    await expectCode(
      async () => validateNativeCandidateFaultEvidenceRecord(recordBytes(record)),
      "FAULT_EVIDENCE_OBSERVATION",
    );
  }
});

test("recovery must retain a 12/12 fresh record with one backend execution", async () => {
  const record = fixtureRecord();
  record.lanes[1].recovery.check_summary.passed = 11;
  await expectCode(
    async () => validateNativeCandidateFaultEvidenceRecord(recordBytes(record)),
    "FAULT_EVIDENCE_RECOVERY",
  );
});

test("orchestrator runs all fatal lanes and a fresh 12/12 recovery after each", async (t) => {
  const harness = await createHarness(t);
  const result = await runNativeCandidateFaultEvidence(
    harness.input,
    harness.dependencies,
  );
  assert.equal(result.laneCount, 3);
  assert.equal(harness.calls.process, 3);
  assert.equal(harness.calls.conformance, 4);
  assert.equal(harness.calls.postflight, 3);
  assert.deepEqual(harness.calls.processExit, [
    [4_101, 5_101],
    [4_102, 5_102],
    [4_103],
  ]);
  assert.equal(await pathIsAbsent(harness.markerRoot), true);
  const persisted = await validateNativeCandidateFaultEvidenceFile(
    harness.outputEvidencePath,
  );
  assert.equal(persisted.record.lanes[0].observation.ntstatus_hex, "0x40000015");
  assert.equal(persisted.record.lanes[1].observation.timed_out, true);
  assert.equal(persisted.record.lanes[1].observation.ntstatus_hex, null);
  assert.equal(persisted.record.lanes[2].observation.ntstatus_hex, "0xc0000005");
});

test("a live broker or child blocks postflight and leaves no partial evidence", async (t) => {
  const harness = await createHarness(t, { processExitFailureAt: 1 });
  await expectCode(
    () => runNativeCandidateFaultEvidence(harness.input, harness.dependencies),
    "FAULT_EVIDENCE_PROCESS_LIVENESS",
  );
  assert.equal(harness.calls.conformance, 1);
  assert.equal(harness.calls.postflight, 0);
  assert.equal(await pathIsAbsent(harness.outputEvidencePath), true);
  assert.equal(await pathIsAbsent(harness.markerRoot), true);
});

test("postflight artifact/runtime identity drift blocks recovery and output", async (t) => {
  const harness = await createHarness(t, { postflightFailureAt: 2 });
  await expectCode(
    () => runNativeCandidateFaultEvidence(harness.input, harness.dependencies),
    "FAULT_EVIDENCE_POSTFLIGHT_IDENTITY",
  );
  assert.equal(harness.calls.conformance, 2);
  assert.equal(harness.calls.postflight, 2);
  assert.equal(await pathIsAbsent(harness.outputEvidencePath), true);
});

test("recovery snapshot or check drift fails closed after the fatal lane", async (t) => {
  for (const option of [
    { snapshotDriftAt: 2, code: "FAULT_EVIDENCE_RECOVERY" },
    { badCheckSummaryAt: 2, code: "FAULT_EVIDENCE_RECOVERY" },
  ]) {
    const harness = await createHarness(t, option);
    await expectCode(
      () => runNativeCandidateFaultEvidence(harness.input, harness.dependencies),
      option.code,
    );
    assert.equal(await pathIsAbsent(harness.outputEvidencePath), true);
  }
});

test("natural hang exit and any stdout are rejected without a partial record", async (t) => {
  for (const option of [{ hangNaturalExit: true }, { stdoutAt: 1 }]) {
    const harness = await createHarness(t, option);
    await assert.rejects(() =>
      runNativeCandidateFaultEvidence(harness.input, harness.dependencies),
    );
    assert.equal(await pathIsAbsent(harness.outputEvidencePath), true);
  }
});

test("create-new marker and evidence paths are never overwritten", async (t) => {
  const markerHarness = await createHarness(t, { preexistingMarker: true });
  await assert.rejects(() =>
    runNativeCandidateFaultEvidence(
      markerHarness.input,
      markerHarness.dependencies,
    ),
  );
  assert.equal(await pathIsAbsent(markerHarness.outputEvidencePath), true);

  const outputHarness = await createHarness(t);
  await writeFile(outputHarness.outputEvidencePath, "owned-by-caller\n", {
    flag: "wx",
  });
  await expectCode(
    () =>
      runNativeCandidateFaultEvidence(
        outputHarness.input,
        outputHarness.dependencies,
      ),
    "FAULT_EVIDENCE_PARTIAL_OUTPUT",
  );
  assert.equal(
    await readFile(outputHarness.outputEvidencePath, "utf8"),
    "owned-by-caller\n",
  );
});

test("atomic evidence publication never exposes a partial final record", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "meetingrelay-fault-publish-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const outputPath = path.join(root, "fault-evidence.json");
  const bytes = recordBytes(fixtureRecord());
  await expectCode(
    () =>
      publishNativeCandidateFaultEvidence(outputPath, bytes, {
        openFile: async (stagingPath, flags) => {
          const handle = await open(stagingPath, flags);
          return {
            close: () => handle.close(),
            sync: () => handle.sync(),
            writeFile: async (value) => {
              await handle.writeFile(value.subarray(0, 17));
              throw new Error("injected partial staging write");
            },
          };
        },
        randomSuffix: () => "a".repeat(32),
      }),
    "FAULT_EVIDENCE_OUTPUT",
  );
  assert.equal(await pathIsAbsent(outputPath), true);
  assert.deepEqual(await readdir(root), []);
});

test("atomic no-replace publication cleans staging when linking fails", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "meetingrelay-fault-link-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const outputPath = path.join(root, "fault-evidence.json");
  await expectCode(
    () =>
      publishNativeCandidateFaultEvidence(outputPath, recordBytes(fixtureRecord()), {
        linkFile: async () => {
          throw new Error("injected publication failure");
        },
        randomSuffix: () => "b".repeat(32),
      }),
    "FAULT_EVIDENCE_OUTPUT",
  );
  assert.equal(await pathIsAbsent(outputPath), true);
  assert.deepEqual(await readdir(root), []);
});

test("strict marker-root cleanup completes before evidence publication", async (t) => {
  const harness = await createHarness(t, { cleanupFailure: true });
  await expectCode(
    () => runNativeCandidateFaultEvidence(harness.input, harness.dependencies),
    "FAULT_EVIDENCE_CLEANUP",
  );
  assert.equal(harness.calls.cleanup, 1);
  assert.equal(await pathIsAbsent(harness.outputEvidencePath), true);
});

test("bounded liveness polling requires every broker and child PID to disappear", async () => {
  const probes = new Map([
    [41, 2],
    [42, 1],
  ]);
  await requireProcessesExited([41, 42, 41], async (pid) => {
    const remaining = probes.get(pid);
    probes.set(pid, remaining - 1);
    return remaining > 0;
  });
  assert.equal(probes.get(41), -1);
  assert.equal(probes.get(42), -2);
});

test("a rejected broker termination waits for broker-owned tree cleanup", async () => {
  class FakeStream extends EventEmitter {
    destroyedByRunner = false;

    destroy() {
      this.destroyedByRunner = true;
    }
  }
  class FakeChild extends EventEmitter {
    pid = 9001;
    stderr = new FakeStream();
    stdout = new FakeStream();
    killCalls = 0;
    unrefCalled = false;
    brokerAlive = true;
    childAlive = true;

    kill() {
      this.killCalls += 1;
      setTimeout(() => {
        this.brokerAlive = false;
        this.childAlive = false;
        this.emit("close", 73, null);
      }, 8);
      return false;
    }

    unref() {
      this.unrefCalled = true;
    }
  }
  const child = new FakeChild();
  const result = await runFaultBoundaryProcess({
    arguments: ["supervise-rust", "hang-after-inference"],
    executablePath: "unused-fixture.exe",
    postKillTimeoutMs: 20,
    spawnProcess: () => child,
    timeoutMs: 1,
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.error?.message, "FAULT_BOUNDARY_KILL_REJECTED");
  assert.equal(result.status, 73);
  assert.equal(child.killCalls, 1);
  assert.equal(child.brokerAlive, false);
  assert.equal(child.childAlive, false);
  assert.equal(child.stdout.destroyedByRunner, false);
  assert.equal(child.stderr.destroyedByRunner, false);
  assert.equal(child.unrefCalled, false);
});

test("broker cleanup watchdog hard-fails without detaching a live tree", async () => {
  class FakeStream extends EventEmitter {
    destroyedByRunner = false;

    destroy() {
      this.destroyedByRunner = true;
    }
  }
  class FakeChild extends EventEmitter {
    pid = 9002;
    stderr = new FakeStream();
    stdout = new FakeStream();
    unrefCalled = false;

    kill() {
      return false;
    }

    unref() {
      this.unrefCalled = true;
    }
  }
  const child = new FakeChild();
  const result = await runFaultBoundaryProcess({
    arguments: ["representative-av", "unused-marker"],
    executablePath: "unused-fixture.exe",
    postKillTimeoutMs: 5,
    spawnProcess: () => child,
    timeoutMs: 1,
  });
  assert.equal(result.error?.message, "FAULT_BOUNDARY_BROKER_CLEANUP_TIMEOUT");
  assert.equal(result.brokerCloseObserved, false);
  assert.equal(child.stdout.destroyedByRunner, false);
  assert.equal(child.stderr.destroyedByRunner, false);
  assert.equal(child.unrefCalled, false);
});

test("kill-relative cleanup grace exceeds every broker-owned deadline", async () => {
  const [runnerSource, boundarySource] = await Promise.all([
    readFile(path.join(HERE, "native-candidate-fault-evidence.mjs"), "utf8"),
    readFile(path.join(HERE, "native-fatal-boundary-fixture.c"), "utf8"),
  ]);
  assert.match(runnerSource, /const FATAL_PROCESS_TIMEOUT_MS = 120_000;/u);
  assert.match(runnerSource, /const POST_KILL_CLOSE_TIMEOUT_MS = 135_000;/u);
  assert.match(boundarySource, /ABORT_CHILD_WAIT_MS = 125000UL;/u);
  assert.match(boundarySource, /HANG_CHILD_WAIT_MS = 125000UL;/u);
  assert.doesNotMatch(boundarySource, /WaitForSingleObject\([^;]*INFINITE/u);
  assert.equal(135_000 > 125_000 - 120_000, true);
  assert.equal(135_000 > 125_000, true);
});

test("committed JSON schema freezes strict roots, limitations, and lowercase AV", async () => {
  const schema = JSON.parse(
    await readFile(
      path.join(HERE, "native-candidate-fault-evidence.schema.json"),
      "utf8",
    ),
  );
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, [
    "authority",
    "kind",
    "lanes",
    "limitations",
    "locked_input_snapshot_sha256",
    "schema_version",
  ]);
  assert.deepEqual(
    schema.properties.limitations.prefixItems.map((entry) => entry.const),
    LIMITATIONS,
  );
  const avProperties =
    schema.$defs.representativeAvLane.allOf[1].properties.observation.allOf[1]
      .properties;
  assert.deepEqual(
    {
      ntstatus_hex: avProperties.ntstatus_hex.const,
      signed_i32: avProperties.signed_i32.const,
      unsigned_u32: avProperties.unsigned_u32.const,
    },
    {
      ntstatus_hex: "0xc0000005",
      signed_i32: -1_073_741_819,
      unsigned_u32: 3_221_225_477,
    },
  );
});

test("fault fixtures and evidence tooling are statically excluded from shipping plans", async () => {
  const repositoryRoot = path.resolve(HERE, "../..");
  const files = [
    "tools/sherpa-native/candidate-input-plan.mjs",
    "tools/sherpa-native/candidate-input-bundle-plan.mjs",
    "apps/desktop/src-tauri/tauri.conf.json",
  ];
  const forbidden = [
    "meetingrelay-sherpa-candidate-fault-host",
    "meetingrelay-native-fatal-boundary-fixture",
    "native-candidate-fault-evidence",
  ];
  for (const relativePath of files) {
    const source = await readFile(path.join(repositoryRoot, relativePath), "utf8");
    for (const value of forbidden) {
      assert.equal(source.includes(value), false, `${relativePath}: ${value}`);
    }
  }
  const tauri = JSON.parse(
    await readFile(
      path.join(repositoryRoot, "apps/desktop/src-tauri/tauri.conf.json"),
      "utf8",
    ),
  );
  assert.deepEqual(tauri.bundle, { active: false });
  assert.equal(Object.hasOwn(tauri.bundle, "externalBin"), false);
  assert.equal(Object.hasOwn(tauri.bundle, "resources"), false);
});

test("read-only CLI validates an existing record and emits the exact non-authority marker", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "meetingrelay-fault-cli-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const evidencePath = path.join(root, "evidence.json");
  const bytes = recordBytes();
  await writeFile(evidencePath, bytes);
  const result = spawnSync(
    process.execPath,
    [
      path.join(HERE, "native-candidate-fault-evidence.mjs"),
      "--validate",
      evidencePath,
    ],
    { encoding: "utf8", windowsHide: true },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(
    result.stdout,
    `candidate-native-fault-evidence-file=verified evidence_sha256=${sha256(bytes)} ` +
      `locked_input_snapshot_sha256=${SNAPSHOT_SHA} lanes=3 ` +
      "formal_claims=none production_evidence=false\n",
  );
});
