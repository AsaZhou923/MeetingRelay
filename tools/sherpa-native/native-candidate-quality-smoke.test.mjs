import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdtemp,
  open,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { encodeCanonicalJsonLine } from "../phase0-harness/canonical-json.mjs";
import {
  inspectPcmS16leWave,
  NativeCandidateQualitySmokeError,
  publishNativeCandidateQualitySmokeEvidence,
  runNativeCandidateQualitySmoke,
  validateNativeCandidateQualitySmokeEvidenceRecord,
  validateQualitySmokeReferenceManifest,
  validateQualitySmokeReferenceTranscriptBytes,
} from "./native-candidate-quality-smoke.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(HERE, "../..");
const MANIFEST_SHA =
  "cc2afff6bc92a6fe6e2b58e15332422dc3ecddae790eac6235fa543e2bd76590";
const WAV_SHA =
  "b77f1794fe374a0ba1ee1dc458bfaf9349496cbbfc32780c50ba3c5a7ad8e373";
const TRANSCRIPT_SHA =
  "3dcf3d55f672e2d610a031580f924b47ddf147ff3d93f007b8386f9bef8cac58";
const SNAPSHOT_SHA =
  "0a539001c01b44b60267af4f3da4202349d489d89387dc444622fad053bfeb0b";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function audio() {
  return {
    bits_per_sample: 16,
    channel_count: 1,
    codec: "pcm-s16le",
    data_bytes: 178944,
    duration_milliseconds: 5592,
    file_bytes: 178988,
    sample_frames: 89472,
    sample_rate_hz: 16000,
    sha256: WAV_SHA,
  };
}

function runRecord(runIndex, conformanceRecordSha = `${runIndex}`.repeat(64)) {
  return {
    backend_execute_calls: 1,
    check_summary: { passed: 12, total: 12 },
    conformance_record_sha256: conformanceRecordSha,
    exact_reference_match: true,
    final_transcript_sha256: TRANSCRIPT_SHA,
    final_transcript_utf8_bytes: 38,
    fresh_process: true,
    input_snapshot_sha256: SNAPSHOT_SHA,
    run_index: runIndex,
    worker_id: "meetingrelay-sherpa-native-candidate-host-v1",
  };
}

function fixtureRecord() {
  return {
    authority: {
      formal_claims: "none",
      production_evidence: false,
    },
    input_identity: {
      execution_host_sha256: "a".repeat(64),
      locked_input_snapshot_sha256: SNAPSHOT_SHA,
      reference_manifest_sha256: MANIFEST_SHA,
      schema_registry_sha256: "b".repeat(64),
      wav_sha256: WAV_SHA,
    },
    kind: "meetingrelay-native-candidate-quality-smoke-evidence-v1",
    limitations: [
      "upstream-documented-reference-not-independent-gold",
      "audio-redistribution-rights-unresolved",
      "meetingrelay-locked-zh-not-upstream-parameter-identical",
      "single-reference-exact-match-not-product-quality-assessment",
      "performance-and-resource-usage-not-measured",
      "selection-default-and-parent-closeout-not-authorized",
    ],
    quality_gate_status: "not-assessed",
    redistribution_status: "unresolved",
    reference: {
      audio: audio(),
      manifest_sha256: MANIFEST_SHA,
      transcript: {
        match_basis: "sha256-and-utf8-byte-length",
        reference_role: "upstream-documented-smoke-reference-not-independent-gold",
        sha256: TRANSCRIPT_SHA,
        utf8_bytes: 38,
      },
      upstream_repository_commit: "0166495ed093aeb90f42c99da5f7cf91da1e110d",
    },
    runs: [runRecord(1), runRecord(2)],
    schema_version: "1.0",
  };
}

function evidenceBytes(record = fixtureRecord()) {
  return Buffer.from(encodeCanonicalJsonLine(record), "utf8");
}

function conformanceResult(runIndex, drift = {}) {
  return {
    backendExecuteCalls: 1,
    checkSummary: { passed: 12, total: 12 },
    conformanceRecordSha256: `${runIndex}`.repeat(64),
    executableSha256: "a".repeat(64),
    finalTranscriptSha256: TRANSCRIPT_SHA,
    finalTranscriptUtf8Bytes: 38,
    lockedInputSnapshotSha256: SNAPSHOT_SHA,
    schemaRegistrySha256: "b".repeat(64),
    workerId: "meetingrelay-sherpa-native-candidate-host-v1",
    ...drift,
  };
}

function preparedReference(drift = {}) {
  return {
    audio: audio(),
    manifest: {},
    manifestSha256: MANIFEST_SHA,
    wavPath: "untracked-cache/zh.wav",
    wavSha256: WAV_SHA,
    ...drift,
  };
}

async function expectCode(run, code) {
  await assert.rejects(
    run,
    (error) =>
      error instanceof NativeCandidateQualitySmokeError && error.code === code,
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

async function createHarness(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "meetingrelay-quality-smoke-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const outputEvidencePath = path.join(root, "quality-evidence.json");
  const input = {
    assetLockPath: "assets.lock.json",
    executablePath: "release/host.exe",
    modelPath: "model.int8.onnx",
    outputEvidencePath,
    packageLockPath: "Cargo.lock",
    runtimeLibDir: "runtime",
    schemaRegistryPath: "candidate-schema-registry.json",
    tokensPath: "tokens.txt",
    wavPath: "untracked-cache/zh.wav",
  };
  return { input, outputEvidencePath, root };
}

test("sealed reference manifest pins upstream provenance and canonical transcript bytes", async () => {
  const bytes = await readFile(path.join(HERE, "candidate-quality-smoke-reference.json"));
  const result = validateQualitySmokeReferenceManifest(bytes);

  assert.equal(result.manifestSha256, MANIFEST_SHA);
  assert.equal(result.record.audio.sha256, WAV_SHA);
  assert.equal(result.record.redistribution.status, "unresolved");
  assert.equal(result.record.transcript.sha256, TRANSCRIPT_SHA);
  assert.equal(result.record.transcript.utf8_bytes, 38);
  assert.deepEqual(
    result.record.upstream.documentation.map(({ role }) => role),
    [
      "documented-archive-and-test-wavs-presence",
      "documented-itn-output",
      "documented-zh-wav-transcript",
      "documented-default-language-auto",
    ],
  );
});

test("reference transcript rejects BOM, newline, content, and compatibility-normalization drift", async () => {
  const canonical = Buffer.from("开放时间早上9点至下午5点。", "utf8");
  assert.deepEqual(validateQualitySmokeReferenceTranscriptBytes(canonical), {
    sha256: TRANSCRIPT_SHA,
    utf8Bytes: 38,
  });

  for (const bytes of [
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), canonical]),
    Buffer.concat([canonical, Buffer.from("\n")]),
    Buffer.from("开放时间早上9点至下午五点。", "utf8"),
    Buffer.from("开放时间早上９点至下午5点。", "utf8"),
  ]) {
    await expectCode(
      async () => validateQualitySmokeReferenceTranscriptBytes(bytes),
      "QUALITY_SMOKE_TRANSCRIPT_BYTES",
    );
  }
});

test("PCM parser requires RIFF PCM S16LE framing and derives exact frame identity", async () => {
  const wav = Buffer.alloc(48);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(40, 4);
  wav.write("WAVE", 8, "ascii");
  wav.write("fmt ", 12, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24);
  wav.writeUInt32LE(32000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(4, 40);

  assert.deepEqual(inspectPcmS16leWave(wav), {
    bitsPerSample: 16,
    channelCount: 1,
    dataBytes: 4,
    sampleFrames: 2,
    sampleRateHz: 16000,
  });
  wav.writeUInt16LE(3, 32);
  await expectCode(async () => inspectPcmS16leWave(wav), "QUALITY_SMOKE_WAV_PCM");
});

test("strict quality evidence accepts exactly two fresh exact-match runs", () => {
  const result = validateNativeCandidateQualitySmokeEvidenceRecord(evidenceBytes());
  assert.equal(result.runCount, 2);
  assert.equal(result.lockedInputSnapshotSha256, SNAPSHOT_SHA);
  assert.equal(result.record.quality_gate_status, "not-assessed");
  assert.equal(result.record.redistribution_status, "unresolved");
});

test("authority, scope, limitations, and reference role cannot be promoted", async () => {
  for (const drift of ["authority", "quality", "redistribution", "limitations", "role"]) {
    const record = fixtureRecord();
    if (drift === "authority") record.authority.formal_claims = "quality";
    if (drift === "quality") record.quality_gate_status = "passed";
    if (drift === "redistribution") record.redistribution_status = "cleared";
    if (drift === "limitations") record.limitations.pop();
    if (drift === "role") record.reference.transcript.reference_role = "gold";
    await assert.rejects(
      async () => validateNativeCandidateQualitySmokeEvidenceRecord(evidenceBytes(record)),
      NativeCandidateQualitySmokeError,
    );
  }
});

test("partial, concatenated, duplicate-key, and duplicate-index records fail closed", async () => {
  const bytes = evidenceBytes();
  const duplicateRootKey = Buffer.from(
    `${bytes.toString("utf8").trimEnd().replace(/}$/, ',"schema_version":"1.0"}')}\n`,
    "utf8",
  );
  const duplicateIndex = fixtureRecord();
  duplicateIndex.runs[1].run_index = 1;
  for (const invalid of [
    bytes.subarray(0, bytes.length - 1),
    Buffer.concat([bytes, bytes]),
    duplicateRootKey,
    evidenceBytes(duplicateIndex),
  ]) {
    await assert.rejects(
      async () => validateNativeCandidateQualitySmokeEvidenceRecord(invalid),
      NativeCandidateQualitySmokeError,
    );
  }
});

test("evidence rejects transcript, WAV, manifest, and locked-input identity drift", async () => {
  for (const drift of ["transcript", "wav", "manifest", "snapshot"]) {
    const record = fixtureRecord();
    if (drift === "transcript") record.runs[0].final_transcript_utf8_bytes = 39;
    if (drift === "wav") record.input_identity.wav_sha256 = "c".repeat(64);
    if (drift === "manifest") {
      record.input_identity.reference_manifest_sha256 = "d".repeat(64);
    }
    if (drift === "snapshot") record.runs[1].input_snapshot_sha256 = "e".repeat(64);
    await assert.rejects(
      async () => validateNativeCandidateQualitySmokeEvidenceRecord(evidenceBytes(record)),
      NativeCandidateQualitySmokeError,
    );
  }
});

test("orchestrator performs exactly two conformance invocations and rechecks the reference", async (t) => {
  const harness = await createHarness(t);
  let conformanceCalls = 0;
  let referenceLoads = 0;
  const result = await runNativeCandidateQualitySmoke(harness.input, {
    conformanceRunner: async () => {
      conformanceCalls += 1;
      return conformanceResult(conformanceCalls);
    },
    referenceLoader: async () => {
      referenceLoads += 1;
      return preparedReference();
    },
  });

  assert.equal(conformanceCalls, 2);
  assert.equal(referenceLoads, 3);
  assert.equal(result.runCount, 2);
  assert.equal(await pathIsAbsent(harness.outputEvidencePath), false);
});

test("transcript mismatch fails before evidence publication", async (t) => {
  const harness = await createHarness(t);
  await expectCode(
    () =>
      runNativeCandidateQualitySmoke(harness.input, {
        conformanceRunner: async () =>
          conformanceResult(1, { finalTranscriptUtf8Bytes: 39 }),
        referenceLoader: async () => preparedReference(),
      }),
    "QUALITY_SMOKE_TRANSCRIPT_MISMATCH",
  );
  assert.equal(await pathIsAbsent(harness.outputEvidencePath), true);
});

test("runtime or locked-input drift between fresh runs fails before publication", async (t) => {
  const harness = await createHarness(t);
  let calls = 0;
  await expectCode(
    () =>
      runNativeCandidateQualitySmoke(harness.input, {
        conformanceRunner: async () => {
          calls += 1;
          return conformanceResult(
            calls,
            calls === 2 ? { lockedInputSnapshotSha256: "f".repeat(64) } : {},
          );
        },
        referenceLoader: async () => preparedReference(),
      }),
    "QUALITY_SMOKE_INPUT_DRIFT",
  );
  assert.equal(calls, 2);
  assert.equal(await pathIsAbsent(harness.outputEvidencePath), true);
});

test("reference mutation after a run fails before the second fresh process", async (t) => {
  const harness = await createHarness(t);
  let loads = 0;
  let runs = 0;
  await expectCode(
    () =>
      runNativeCandidateQualitySmoke(harness.input, {
        conformanceRunner: async () => {
          runs += 1;
          return conformanceResult(runs);
        },
        referenceLoader: async () => {
          loads += 1;
          return preparedReference(loads === 2 ? { wavSha256: "f".repeat(64) } : {});
        },
      }),
    "QUALITY_SMOKE_REFERENCE_POSTFLIGHT",
  );
  assert.equal(runs, 1);
  assert.equal(await pathIsAbsent(harness.outputEvidencePath), true);
});

test("atomic publication is no-replace and removes staging on link failure", async (t) => {
  const harness = await createHarness(t);
  const bytes = evidenceBytes();
  await writeFile(harness.outputEvidencePath, bytes);
  await expectCode(
    () => publishNativeCandidateQualitySmokeEvidence(harness.outputEvidencePath, bytes),
    "QUALITY_SMOKE_EVIDENCE_OUTPUT",
  );
  assert.deepEqual(await readFile(harness.outputEvidencePath), bytes);

  await rm(harness.outputEvidencePath);
  const suffix = "a".repeat(32);
  const stagingPath = path.join(
    harness.root,
    `.quality-evidence.json.${suffix}.staging`,
  );
  await expectCode(
    () =>
      publishNativeCandidateQualitySmokeEvidence(harness.outputEvidencePath, bytes, {
        linkFile: async () => {
          throw Object.assign(new Error("link failed"), { code: "EEXIST" });
        },
        openFile: open,
        randomSuffix: () => suffix,
      }),
    "QUALITY_SMOKE_EVIDENCE_OUTPUT",
  );
  assert.equal(await pathIsAbsent(stagingPath), true);
  assert.equal(await pathIsAbsent(harness.outputEvidencePath), true);
});

test("committed schema freezes authority, two run indexes, and unresolved scope", async () => {
  const schema = JSON.parse(
    await readFile(path.join(HERE, "native-candidate-quality-smoke.schema.json"), "utf8"),
  );
  assert.equal(
    schema.properties.authority.properties.formal_claims.const,
    "none",
  );
  assert.equal(schema.properties.runs.minItems, 2);
  assert.equal(schema.properties.runs.maxItems, 2);
  assert.equal(
    schema.properties.runs.prefixItems[0].allOf[1].properties.run_index.const,
    1,
  );
  assert.equal(
    schema.properties.runs.prefixItems[1].allOf[1].properties.run_index.const,
    2,
  );
  assert.equal(schema.properties.quality_gate_status.const, "not-assessed");
  assert.equal(schema.properties.redistribution_status.const, "unresolved");
});

test("the sealed zh WAV bytes are not committed under any tracked name", async () => {
  const listed = spawnSync("git", ["ls-files", "-z"], {
    cwd: REPOSITORY_ROOT,
    encoding: "buffer",
    windowsHide: true,
  });
  assert.equal(listed.status, 0, listed.stderr.toString("utf8"));
  const tracked = listed.stdout
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  for (const relativePath of tracked) {
    const absolutePath = path.join(REPOSITORY_ROOT, relativePath);
    const metadata = await lstat(absolutePath);
    if (metadata.isFile() && metadata.size === 178988) {
      assert.notEqual(sha256(await readFile(absolutePath)), WAV_SHA, relativePath);
    }
  }
});

test("package and CI wire contract tests, real evidence, strict validation, and cleanup", async () => {
  const packageJson = JSON.parse(
    await readFile(path.join(REPOSITORY_ROOT, "package.json"), "utf8"),
  );
  const workflow = await readFile(
    path.join(REPOSITORY_ROOT, ".github", "workflows", "ci.yml"),
    "utf8",
  );
  assert.equal(
    packageJson.scripts["phase0:sherpa-candidate-quality-smoke:test"],
    "node --test tools/sherpa-native/native-candidate-quality-smoke.test.mjs",
  );
  assert.equal(
    packageJson.scripts["phase0:sherpa-candidate-quality-smoke:run"],
    "node tools/sherpa-native/native-candidate-quality-smoke.mjs --run",
  );
  assert.equal(
    packageJson.scripts["phase0:sherpa-candidate-quality-smoke:validate"],
    "node tools/sherpa-native/native-candidate-quality-smoke.mjs --validate",
  );
  assert.match(workflow, /Test WP-0\.4 native exact-match quality-smoke evidence contract/u);
  assert.match(workflow, /Run actual sealed-reference native exact-match quality smoke/u);
  const cacheActionUses =
    workflow.match(/uses:\s*actions\/cache(?:\/(?:restore|save))?@[^\s]+/gu) ?? [];
  assert.deepEqual(cacheActionUses, ["uses: actions/cache@v5"]);
  assert.doesNotMatch(workflow, /uses:\s*actions\/upload-artifact@/u);
  const cacheContract = workflow.match(
    /- name: Cache Rust dependencies and build outputs[\s\S]*?restore-keys: \|\r?\n\s+\$\{\{ runner\.os \}\}-rust-no-model-assets-v1-1\.95\.0-\r?\n/u,
  )?.[0];
  assert.ok(cacheContract, "rotated no-model-assets cache namespace is required");
  const cachePaths = cacheContract
    .match(/path: \|\r?\n([\s\S]*?)\s+key:/u)?.[1]
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  assert.deepEqual(cachePaths, [
    "~/.cargo/registry",
    "~/.cargo/git",
    "target/debug",
    "target/release",
  ]);
  assert.ok(cachePaths.every((entry) => entry !== "target" && !entry.includes("**")));
  assert.doesNotMatch(cacheContract, /target\/sherpa-native/u);
  assert.match(
    cacheContract,
    /key: \$\{\{ runner\.os \}\}-rust-no-model-assets-v1-1\.95\.0-/u,
  );
  assert.doesNotMatch(cacheContract, /\$\{\{ runner\.os \}\}-rust-1\.95\.0-/u);
  assert.match(
    workflow,
    /& pnpm phase0:sherpa-candidate-quality-smoke:run `\r?\n\s+\$evidencePath/u,
  );
  assert.doesNotMatch(
    workflow,
    /phase0:sherpa-candidate-quality-smoke:(?:run|validate)\s+--(?:\s|`)/u,
  );
  assert.match(
    workflow,
    /candidate-native-quality-smoke-evidence=verified evidence_sha256=/u,
  );
  assert.match(workflow, /Clean native quality-smoke evidence state[\s\S]*if: always\(\)/u);
  assert.ok(
    workflow.indexOf("Run actual sealed-reference native exact-match quality smoke") <
      workflow.indexOf("Build exact Release candidate fault-host executable"),
  );
});

test("read-only CLI accepts one complete record and emits the exact non-authority marker", async (t) => {
  const harness = await createHarness(t);
  await writeFile(harness.outputEvidencePath, evidenceBytes());
  const result = spawnSync(
    process.execPath,
    [
      path.join(HERE, "native-candidate-quality-smoke.mjs"),
      "--validate",
      harness.outputEvidencePath,
    ],
    { encoding: "utf8", windowsHide: true },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.match(
    result.stdout,
    /^candidate-native-quality-smoke-evidence-file=verified evidence_sha256=[0-9a-f]{64} locked_input_snapshot_sha256=[0-9a-f]{64} runs=2 quality_gate_status=not-assessed redistribution_status=unresolved formal_claims=none production_evidence=false\n$/u,
  );
});
