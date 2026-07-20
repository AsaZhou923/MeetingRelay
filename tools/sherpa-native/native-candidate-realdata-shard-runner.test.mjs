import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { encodeCanonicalJsonLine } from "../phase0-harness/canonical-json.mjs";
import {
  aggregateDescriptiveAsrScores,
  getAsrScorerProfile,
  scoreAsrTranscript,
  validateDescriptiveAsrAggregate,
} from "./asr-error-rate.mjs";
import {
  buildControlledHypothesisLedger,
  buildControlledHypothesisLedgerSeal,
  publishControlledHypothesisLedger,
  publishControlledHypothesisLedgerSeal,
  readControlledHypothesisLedger,
  readControlledHypothesisLedgerSeal,
} from "./controlled-hypothesis-ledger.mjs";
import {
  NativeCandidateRealdataShardRunnerError,
  __invokeShardHostWithSpawnForTest,
  __readPinnedRealdataPolicyForTest,
  __runNativeCandidateRealdataShardEvaluationForTest,
  validateNativeCandidateRealdataShardEvidenceRecord,
} from "./native-candidate-realdata-shard-runner.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const POLICY_PATH = path.join(HERE, "native-candidate-realdata-shard-policy.json");
const FLEURS_POLICY_PATH = path.join(HERE, "fleurs-gold-source-policy.json");
const SCORER_PATH = path.join(HERE, "asr-scorer-profile.json");
const SOURCE_COMMIT = "a".repeat(40);
const FORMAL_POLICY_SHA256 = "1".repeat(64);
const READINESS_BUILD_SHA256 = "2".repeat(64);
const CREATE_SHA256 = "3".repeat(64);
const DELETE_SHA256 = "4".repeat(64);
const HOST_SHA256 = "ff0ac7ef61d01210c39d1504effe81ab321d42d512319aa10edc160574414812";
const HOST_ATTESTATION_SHA256 = "6".repeat(64);
const ROOT_ATTESTATION_SHA256 = "7".repeat(64);
const ROOT_SECURITY_DESCRIPTOR_SHA256 = "c".repeat(64);
const ROOT_OPERATOR_SID_SHA256 = "d".repeat(64);
const CORPUS_MANIFEST_SHA256 = "8".repeat(64);
const CORPUS_PROJECTION_SHA256 = "9".repeat(64);
const CORPUS_SNAPSHOT_SHA256 = "b".repeat(64);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function clone(value) {
  return structuredClone(value);
}

function sampleIdentitySha256(sample) {
  return sha256(Buffer.from(encodeCanonicalJsonLine({
    language: sample.language,
    pcm_sha256: sample.pcm_sha256,
    reference_sha256: sample.reference_sha256,
    sample_id: sample.sample_id,
    wav_sha256: sample.wav_sha256,
    wav_size_bytes: sample.wav_size_bytes,
  }), "utf8"));
}

function languageFor(index) {
  if (index < 320) return "en";
  if (index < 640) return "ja";
  return "zh";
}

function referenceFor(language) {
  if (language === "en") return "hello world";
  if (language === "ja") return "こんにちは";
  return "你好";
}

function samples(root) {
  return Array.from({ length: 960 }, (_, index) => {
    const id = `mr-fleurs-${String(index + 1).padStart(4, "0")}`;
    const language = languageFor(index);
    const reference = referenceFor(language);
    return {
      duration_samples: 16000 + index,
      language,
      pcm_sha256: sha256(Buffer.from(`pcm-${id}`, "utf8")),
      reference_sha256: sha256(Buffer.from(reference, "utf8")),
      reference_text: reference,
      sample_id: id,
      scenario: "fleurs-test",
      split: "blind",
      tier: "tier-1",
      wav_path: path.join(root, "controlled", "wav", `${id}.wav`),
      wav_sha256: sha256(Buffer.from(`wav-${id}`, "utf8")),
      wav_size_bytes: 44 + index + 2,
    };
  });
}

function snapshotRecord(root) {
  return {
    authority: {
      formal_claims: "none",
      production_evidence: false,
      public_distribution: false,
      quality_gate_status: "not-assessed",
    },
    kind: "meetingrelay-fleurs-materialized-corpus-snapshot-v1",
    materialization: {
      canary_wav_path: path.join(root, "controlled", "canary.wav"),
      canary_wav_sha256: "c".repeat(64),
      canary_wav_size_bytes: 46,
      manifest_sha256: CORPUS_MANIFEST_SHA256,
      sample_count: 960,
      text_free_projection_sha256: CORPUS_PROJECTION_SHA256,
    },
    samples: samples(root),
    schema_version: "1.0",
    source: {
      dataset_id: "google/fleurs",
      revision: "70bb2e84b976b7e960aa89f1c648e09c59f894dd",
    },
  };
}

function readinessRecord(fleursPolicySha256) {
  return {
    authority: {
      execution_status: "not-run",
      formal_claims: "none",
      materialization_status: "not-run",
      production_evidence: false,
      public_distribution: false,
      quality_gate_status: "not-assessed",
    },
    controlled_root: {
      attestation_sha256: ROOT_ATTESTATION_SHA256,
      create_receipt_sha256: CREATE_SHA256,
      delete_receipt_sha256: DELETE_SHA256,
      file_id_128: "a".repeat(32),
      inventory_entry_count: 0,
      inventory_sha256: "d".repeat(64),
      volume_serial_number: "1234",
    },
    kind: "meetingrelay-formal-run-readiness-envelope-v1",
    policy_sha256: FORMAL_POLICY_SHA256,
    quality_host: {
      build_attestation_sha256: READINESS_BUILD_SHA256,
      executable_sha256: "e".repeat(64),
      imports_sha256: "f".repeat(64),
      pe_hardening_status: "required-flags-present",
      runtime_bundle_sha256: "a".repeat(64),
      source_commit: SOURCE_COMMIT,
      source_tree_sha256: "b".repeat(64),
      toolchain_sha256: "c".repeat(64),
    },
    readiness_status: "ready-for-materialization-only",
    retention: {
      expires_at: "2026-08-01T00:00:00Z",
      maximum_seconds: 2592000,
      validated_at: "2026-07-20T00:00:00Z",
    },
    schema_version: "1.0",
    source: {
      common_id_count: 320,
      configs: ["en_us", "ja_jp", "cmn_hans_cn"],
      dataset_id: "google/fleurs",
      policy_sha256: fleursPolicySha256,
      revision: "70bb2e84b976b7e960aa89f1c648e09c59f894dd",
      selected_utterance_count: 960,
      source_contract_status: "frozen-source-readiness",
      split: "test",
    },
  };
}

function shardHostAttestation() {
  return {
    record: {
      executable: { runtime_bundle_sha256: "e".repeat(64), sha256: HOST_SHA256 },
      source: { commit: SOURCE_COMMIT, tree_sha256: "d".repeat(64) },
    },
    sha256: HOST_ATTESTATION_SHA256,
  };
}

function controlledRootAttestationFor(readiness, overrides = {}) {
  return {
    record: {
      root: {
        dacl_protected: true,
        drive_type: "fixed",
        file_id_128: readiness.record.controlled_root.file_id_128,
        filesystem: "NTFS",
        operator_sid_sha256: ROOT_OPERATOR_SID_SHA256,
        owner_principal: "operator",
        reparse_tag: null,
        retention_expires_at: readiness.record.retention.expires_at,
        root_path_sha256: sha256(Buffer.from(overrides.controlledRoot ?? "", "utf8")),
        security_descriptor_sha256: ROOT_SECURITY_DESCRIPTOR_SHA256,
        volume_serial_number: readiness.record.controlled_root.volume_serial_number,
        ...overrides.root,
      },
    },
    sha256: overrides.sha256 ?? readiness.record.controlled_root.attestation_sha256,
  };
}

async function makeContext(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "meetingrelay-realdata-shard-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  await mkdir(path.join(root, "controlled", "private"), { recursive: true });
  await mkdir(path.join(root, "controlled", "wav"), { recursive: true });
  await mkdir(path.join(root, "runtime"), { recursive: true });
  await writeFile(path.join(root, "shard-host.exe"), "synthetic host");
  const startupFiles = {
    assetLockPath: path.join(root, "asset.lock.json"),
    modelPath: path.join(root, "model.bin"),
    packageLockPath: path.join(root, "Cargo.lock"),
    schemaRegistryPath: path.join(root, "schema-registry.json"),
    tokensPath: path.join(root, "tokens.txt"),
  };
  for (const [key, filePath] of Object.entries(startupFiles)) {
    await writeFile(filePath, `${key}\n`);
  }
  const policyBytes = await readFile(POLICY_PATH);
  const fleursBytes = await readFile(FLEURS_POLICY_PATH);
  const snapshotBytes = Buffer.from(encodeCanonicalJsonLine(snapshotRecord(root)), "utf8");
  const materializationEvidenceBytes = Buffer.from(encodeCanonicalJsonLine({
    archive_sha256_by_config: { cmn_hans_cn: "a".repeat(64), en_us: "b".repeat(64), ja_jp: "c".repeat(64) },
    authority: {
      execution_status: "not-run",
      formal_claims: "none",
      materialization_status: "materialized",
      production_evidence: false,
      public_distribution: false,
      quality_gate_status: "not-assessed",
    },
    corpus_manifest_sha256: CORPUS_MANIFEST_SHA256,
    corpus_snapshot_sha256: CORPUS_SNAPSHOT_SHA256,
    kind: "meetingrelay-fleurs-materialized-corpus-v1",
    language_counts: { en: 320, ja: 320, zh: 320 },
    materialized_sample_count: 960,
    policy_sha256: sha256(fleursBytes),
    schema_version: "1.0",
    selection_sha256: "d".repeat(64),
    source_contract_status: "frozen-source-readiness",
    validation_date: "2026-07-21",
  }), "utf8");
  const readinessBytes = Buffer.from(encodeCanonicalJsonLine(readinessRecord(sha256(fleursBytes))), "utf8");
  const corpusManifestPath = path.join(root, "controlled", "snapshots", "fleurs-960", "corpus-manifest.json");
  const materializationEvidencePath = path.join(root, "controlled", "snapshots", "fleurs-960", "materialization-public-evidence.json");
  const readinessPath = path.join(root, "readiness.json");
  await mkdir(path.dirname(corpusManifestPath), { recursive: true });
  await writeFile(corpusManifestPath, "{}\n");
  await writeFile(materializationEvidencePath, materializationEvidenceBytes);
  await writeFile(readinessPath, readinessBytes);
  const input = {
    assetLockPath: startupFiles.assetLockPath,
    controlledRoot: path.join(root, "controlled"),
    corpusManifestPath,
    expectedAssetLockSha256: sha256(await readFile(startupFiles.assetLockPath)),
    expectedCorpusManifestSha256: CORPUS_MANIFEST_SHA256,
    expectedCorpusSnapshotSha256: CORPUS_SNAPSHOT_SHA256,
    expectedCreateReceiptSha256: CREATE_SHA256,
    expectedDeleteReceiptSha256: DELETE_SHA256,
    expectedFleursPolicySha256: sha256(fleursBytes),
    expectedFormalPolicySha256: FORMAL_POLICY_SHA256,
    expectedMaterializationEvidenceSha256: sha256(materializationEvidenceBytes),
    expectedModelSha256: sha256(await readFile(startupFiles.modelPath)),
    expectedPackageLockSha256: sha256(await readFile(startupFiles.packageLockPath)),
    expectedReadinessBuildAttestationSha256: READINESS_BUILD_SHA256,
    expectedReadinessSha256: sha256(readinessBytes),
    expectedRealdataPolicySha256: sha256(policyBytes),
    expectedRuntimeBundleSha256: "e".repeat(64),
    expectedSchemaRegistrySha256: sha256(await readFile(startupFiles.schemaRegistryPath)),
    expectedScorerProfileSha256: getAsrScorerProfile().profile_sha256,
    expectedShardHostBuildAttestationSha256: HOST_ATTESTATION_SHA256,
    expectedShardHostSha256: HOST_SHA256,
    expectedSourceCommit: SOURCE_COMMIT,
    expectedTokensSha256: sha256(await readFile(startupFiles.tokensPath)),
    finalEvidencePath: path.join(root, "realdata-evidence.json"),
    fleursPolicyPath: FLEURS_POLICY_PATH,
    ledgerRelativePath: path.join("private", "realdata-ledger.json"),
    materializationEvidencePath,
    materializedCorpusRoot: path.join(root, "controlled", "snapshots", "fleurs-960"),
    modelPath: startupFiles.modelPath,
    packageLockPath: startupFiles.packageLockPath,
    policyPath: POLICY_PATH,
    readinessPath,
    runtimeLibDir: path.join(root, "runtime"),
    schemaRegistryPath: startupFiles.schemaRegistryPath,
    scorerProfilePath: SCORER_PATH,
    sealRelativePath: path.join("private", "realdata-ledger.seal.json"),
    shardHostBuildAttestationPath: path.join(root, "shard-host-attestation.json"),
    shardHostPath: path.join(root, "shard-host.exe"),
    tokensPath: startupFiles.tokensPath,
  };
  return { input, root, snapshot: snapshotRecord(root) };
}

function mockDependencies({ responses, hooks = {} } = {}) {
  const policyBytesPromise = readFile(POLICY_PATH);
  let snapshotCalls = 0;
  let snapshotIdentityCalls = 0;
  let rootIdentityCalls = 0;
  let invokeCalls = 0;
  const requestLog = [];
  const calls = {
    finalPublishes: 0,
    get invokeCalls() { return invokeCalls; },
    ledgerPublishes: 0,
    requestLog,
    sealPublishes: 0,
    startupLog: [],
    get snapshotCalls() { return snapshotCalls; },
    get snapshotIdentityCalls() { return snapshotIdentityCalls; },
    get rootIdentityCalls() { return rootIdentityCalls; },
  };
  return {
    calls,
    dependencies: {
      aggregateScores: aggregateDescriptiveAsrScores,
      controlledRootIdentityReader: async (input, readiness) => {
        rootIdentityCalls += 1;
        if (responses?.rootReaderThrow !== undefined) throw responses.rootReaderThrow;
        const identityDrift = responses?.rootMismatch || (responses?.rootDrift && rootIdentityCalls > 1);
        const volumeDrift = responses?.rootVolumeDrift && rootIdentityCalls > 1;
        const attestationDrift = responses?.rootInventoryDrift && rootIdentityCalls > 1;
        return controlledRootAttestationFor(readiness, {
          controlledRoot: input.controlledRoot,
          root: {
            file_id_128: identityDrift ? "b".repeat(32) : readiness.record.controlled_root.file_id_128,
            volume_serial_number: volumeDrift ? "987654321" : readiness.record.controlled_root.volume_serial_number,
          },
          sha256: attestationDrift ? "e".repeat(64) : readiness.record.controlled_root.attestation_sha256,
        });
      },
      finalPublisher: async (outputPath, bytes) => {
        calls.finalPublishes += 1;
        await hooks.beforeFinalWrite?.();
        await writeFile(outputPath, bytes, { flag: "wx" });
      },
      invokeShardHost: async ({ requests, startupArguments, startupIdentities }) => {
        invokeCalls += 1;
        assert.equal(startupArguments.length, 9);
        assert.equal(startupArguments[6], requests[0].language);
        assert.equal(startupArguments[7], "66");
        assert.match(startupArguments[8], /^(?:0|[1-9][0-9]*)$/u);
        assert.equal(new Set(requests.map((request) => request.language)).size, 1);
        assert.ok(requests.length <= Number(startupArguments[7]));
        calls.startupLog.push([...startupArguments]);
        requestLog.push(...requests.map((request) => ({ ...request })));
        if (responses?.throwOnCall === invokeCalls) throw new Error("synthetic crash");
        const rows = requests.map((request, index) => {
          if (responses?.omitLast && index === requests.length - 1) return null;
          const sample = samples("").find((candidate) => candidate.sample_id === request.sample_id);
          const language = request.language;
          const responseSample = {
            language: request.language,
            pcm_sha256: request.pcm_sha256,
            reference_sha256: request.reference_sha256,
            sample_id: request.sample_id,
            wav_sha256: request.wav_sha256,
            wav_size_bytes: request.wav_size_bytes,
          };
          const transcript = request.is_canary
            ? (responses?.canaryDrift && invokeCalls > 1 ? "drifted canary" : "stable canary")
            : referenceFor(language);
          const transcriptBytes = Buffer.from(transcript, "utf8");
          return encodeCanonicalJsonLine({
            candidate: {
              asset_lock_sha256: startupIdentities.asset_lock_sha256,
              candidate_id: "sherpa-native-sensevoice-int8-2024-07-17-win-x64-cpu",
              model_sha256: startupIdentities.model_sha256,
              package_lock_sha256: startupIdentities.package_lock_sha256,
              parameter_sha256: "d".repeat(64),
              runtime_bundle_sha256: startupIdentities.runtime_bundle_sha256,
              tokens_sha256: startupIdentities.tokens_sha256,
            },
            execution: {
              backend_execute_calls: 1,
              execute_elapsed_ns: "1000",
              execute_finished_monotonic_ns: "3000",
              execute_started_monotonic_ns: "2000",
              final_transcript: transcript,
              final_transcript_sha256: sha256(transcriptBytes),
              final_transcript_utf8_bytes: String(transcriptBytes.length),
              fresh_os_process_per_shard: true,
              fresh_recognizer_stream_per_request: true,
              prepare_elapsed_ns: "1000",
              prepare_finished_monotonic_ns: "1000",
              prepare_started_monotonic_ns: "0",
              request_sequence: responses?.reorder ? request.request_sequence + 1 : request.request_sequence,
              runtime_identity_post_status: "verified",
              runtime_identity_pre_status: "verified",
              shard_prepare_calls: responses?.badReset ? 2 : 1,
            },
            host: {
              executable_sha256: HOST_SHA256,
              schema_registry_sha256: startupIdentities.schema_registry_sha256,
            },
            kind: "meetingrelay-native-candidate-quality-shard-response-v1",
            resources: responses?.badResource
              ? { status: "maybe" }
              : {
                  cpu_time_ns: index === 0 ? "11" : null,
                  gpu_time_ns: null,
                  peak_ram_bytes: index === 0 ? "123456" : null,
                  peak_vram_bytes: null,
                  reason: index === 0 ? "sampled" : "SHERPA_QUALITY_RESOURCE_SAMPLING_UNAVAILABLE",
                  status: index === 0 ? "observed" : "unavailable",
                },
            rtf: {
              denominator_audio_ns: "1000",
              numerator_execute_ns: "1000",
            },
            sample: {
              canary_identity_sha256: responses?.badCanaryIdentity
                ? "2".repeat(64)
                : request.canary_identity_sha256,
              channels: 1,
              classification: responses?.badClassification
                ? (request.is_canary ? "sample" : "canary")
                : request.classification,
              language: responses?.badLanguage ? "zh" : language,
              pcm_bytes: "2",
              pcm_sample_count: "1",
              pcm_sha256: responses?.badPcmSha ? "3".repeat(64) : request.pcm_sha256,
              reference_sha256: responses?.badReferenceSha ? "4".repeat(64) : request.reference_sha256,
              sample_id: request.sample_id,
              sample_identity_sha256: responses?.badSampleIdentity
                ? sha256(Buffer.from(request.sample_id, "utf8"))
                : sampleIdentitySha256(responseSample),
              sample_rate_hz: 16000,
              scored: !request.is_canary,
              wav_sha256: responses?.badWavSha ? "5".repeat(64) : request.wav_sha256,
              wav_size_bytes: responses?.badWavSize ? String(request.wav_size_bytes + 1) : String(request.wav_size_bytes),
            },
            schema_version: "1.0",
            shard: {
              max_samples: startupArguments[7],
              sample_index: String(index),
              total_pcm_bytes: "128",
            },
          }).trimEnd();
        }).filter(Boolean);
        if (responses?.duplicate) rows[1] = rows[0];
        return {
          lines: rows,
          resourceObservation: responses?.badSupervisorResource
            ? { status: "bad" }
            : {
                final_total_processor_time_ms: 7,
                max_peak_working_set64: 654321,
                max_total_processor_time_ms: 7,
                max_working_set64: 123456,
                sample_count: 2,
                status: "available",
              },
        };
      },
      ledgerPublisher: async (...args) => {
        calls.ledgerPublishes += 1;
        return publishControlledHypothesisLedger(...args);
      },
      ledgerReader: readControlledHypothesisLedger,
      monotonicNow: (() => {
        let value = 1000n;
        return () => {
          value += 1000n;
          return value;
        };
      })(),
      now: hooks.now ?? (() => new Date("2026-07-21T00:00:00Z")),
      policyReader: async (input) => {
        const bytes = await policyBytesPromise;
        const policy = JSON.parse(bytes.toString("utf8"));
        if (responses?.policyOverride !== undefined) responses.policyOverride(policy);
        const sha = responses?.policyDrift && snapshotIdentityCalls > 0 ? "f".repeat(64) : sha256(bytes);
        return { bytes, policy, sha256: sha };
      },
      scoreTranscript: scoreAsrTranscript,
      sealPublisher: async (...args) => {
        calls.sealPublishes += 1;
        return publishControlledHypothesisLedgerSeal(...args);
      },
      sealReader: readControlledHypothesisLedgerSeal,
      shardHostBuildAttestationReader: async () => shardHostAttestation(),
      snapshotIdentityReader: async (input) => {
        snapshotIdentityCalls += 1;
        return { sha256: responses?.snapshotDrift ? "f".repeat(64) : input.expectedCorpusSnapshotSha256 };
      },
      snapshotReader: async (input) => {
        snapshotCalls += 1;
        const syntheticRoot = path.dirname(path.dirname(input.materializedCorpusRoot));
        return {
          record: snapshotRecord(syntheticRoot),
          sha256: input.expectedCorpusSnapshotSha256,
        };
      },
      validateAggregate: validateDescriptiveAsrAggregate,
    },
  };
}

async function expectCode(operation, code) {
  await assert.rejects(operation, (error) =>
    error instanceof NativeCandidateRealdataShardRunnerError && error.code === code);
}

test("real-data runner partitions 960 samples, uses fresh shard processes, excludes canaries, and emits text-free evidence", async (t) => {
  const { input } = await makeContext(t);
  const { calls, dependencies } = mockDependencies();
  const result = await __runNativeCandidateRealdataShardEvaluationForTest(input, dependencies);
  assert.equal(calls.snapshotCalls, 1);
  assert.equal(calls.snapshotIdentityCalls, 2);
  assert.equal(calls.rootIdentityCalls, 3);
  assert.equal(calls.invokeCalls, 15);
  assert.equal(result.record.execution.sample_count, 960);
  assert.equal(result.record.execution.shard_count, 15);
  assert.equal(result.record.execution.canary_count, 30);
  assert.equal(result.record.execution.shards.every((shard) => shard.sample_count === 64), true);
  assert.equal(result.record.execution.shards.every((shard) => shard.canary_count === 2), true);
  assert.equal(calls.startupLog.every((argv) => argv[7] === "66"), true);
  assert.deepEqual(Object.keys(result.record.execution.canary_identity_sha256_by_language), ["en", "ja", "zh"]);
  assert.deepEqual(Object.keys(result.record.execution.canary_transcript_sha256_by_language), ["en", "ja", "zh"]);
  assert.equal(result.record.execution.shards.every((shard) => shard.canary_count >= 1), true);
  const canariesByLanguage = Map.groupBy(
    calls.requestLog.filter((request) => request.is_canary),
    (request) => request.language,
  );
  for (const [language, requests] of canariesByLanguage) {
    assert.equal(
      new Set(requests.map((request) => request.canary_identity_sha256)).size,
      1,
      language,
    );
  }
  assert.equal(result.record.ledger_identity.entry_count, 960);
  assert.equal(result.record.measurement_status, "measured");
  assert.equal(result.record.quality_gate_status, "not-assessed");
  assert.deepEqual(result.record.authority, {
    formal_claims: "none",
    production_evidence: false,
    public_distribution: false,
  });
  assert.equal(result.record.resource_observations.status_counts.observed, 15);
  assert.equal(result.record.resource_observations.status_counts.unavailable, 975);
  const text = await readFile(input.finalEvidencePath, "utf8");
  assert.equal(text.includes(input.controlledRoot), false);
  assert.equal(text.includes("hello world"), false);
  assert.equal(text.includes("こんにちは"), false);
  assert.equal(text.includes("你好"), false);
  assert.equal(text.includes("stable canary"), false);
  validateNativeCandidateRealdataShardEvidenceRecord(Buffer.from(text, "utf8"));
});

test("policy freezes 64 scored samples and 66 total host requests per shard", async (t) => {
  const { input } = await makeContext(t);
  const { calls, dependencies } = mockDependencies();
  await __runNativeCandidateRealdataShardEvaluationForTest(input, dependencies);
  assert.equal(calls.requestLog.length, 990);
  assert.equal(calls.startupLog.length, 15);
  assert.equal(calls.startupLog.every((argv) => argv[7] === "66"), true);

  const oneOver = mockDependencies({
    responses: {
      policyOverride: (policy) => {
        policy.execution.max_host_requests_per_shard = 65;
      },
    },
  });
  await expectCode(
    () => __runNativeCandidateRealdataShardEvaluationForTest(input, oneOver.dependencies),
    "REALDATA_SHARD_REQUEST_LIMIT",
  );
});

test("realdata runner floors nonzero-millisecond production clocks to canonical UTC seconds", async (t) => {
  const { input } = await makeContext(t);
  const nowValues = [
    "2026-07-21T00:00:00.987Z",
    "2026-07-21T00:00:01.456Z",
    "2026-07-21T00:00:02.789Z",
    "2026-07-21T00:00:03.321Z",
    "2026-07-21T00:00:04.654Z",
  ].map((value) => new Date(value));
  let nowIndex = 0;
  const { dependencies } = mockDependencies({
    hooks: {
      now: () => nowValues[Math.min(nowIndex++, nowValues.length - 1)],
    },
  });
  const result = await __runNativeCandidateRealdataShardEvaluationForTest(input, dependencies);
  assert.equal(result.record.clock.started_at_utc, "2026-07-21T00:00:01Z");
  assert.equal(result.record.clock.finished_at_utc, "2026-07-21T00:00:02Z");
  assert.doesNotMatch(result.record.clock.started_at_utc, /\.\d{3}Z$/u);
  assert.doesNotMatch(result.record.clock.finished_at_utc, /\.\d{3}Z$/u);

  const invalid = mockDependencies({
    hooks: {
      now: () => new Date(Number.NaN),
    },
  });
  await expectCode(
    () => __runNativeCandidateRealdataShardEvaluationForTest(input, invalid.dependencies),
    "REALDATA_CLOCK",
  );
});

test("production realdata policy reader requires the explicit realdata policy digest", async (t) => {
  await makeContext(t);
  const policyBytes = await readFile(POLICY_PATH);
  const result = await __readPinnedRealdataPolicyForTest({
    expectedRealdataPolicySha256: sha256(policyBytes),
    policyPath: POLICY_PATH,
  });
  assert.equal(result.sha256, sha256(policyBytes));
  await expectCode(
    () => __readPinnedRealdataPolicyForTest({
      expectedPolicySha256: sha256(policyBytes),
      policyPath: POLICY_PATH,
    }),
    "REALDATA_POLICY_TRUST_REQUIRED",
  );
});

test("controlled root and materialized corpus roots are bound before run and before final publish", async (t) => {
  {
    const { input } = await makeContext(t);
    const { dependencies } = mockDependencies({ responses: { rootMismatch: true } });
    await expectCode(
      () => __runNativeCandidateRealdataShardEvaluationForTest(input, dependencies),
      "REALDATA_CONTROLLED_ROOT_IDENTITY",
    );
    await assert.rejects(readFile(input.finalEvidencePath), { code: "ENOENT" });
  }
  {
    const { input, root } = await makeContext(t);
    await mkdir(path.join(root, "outside"), { recursive: true });
    input.materializedCorpusRoot = path.join(root, "outside", "fleurs-960");
    await mkdir(input.materializedCorpusRoot, { recursive: true });
    const { dependencies } = mockDependencies();
    await expectCode(
      () => __runNativeCandidateRealdataShardEvaluationForTest(input, dependencies),
      "REALDATA_CORPUS_ROOT",
    );
  }
  {
    const { input } = await makeContext(t);
    input.materializedCorpusRoot = path.join(input.controlledRoot, "snapshots", "..", "fleurs-960");
    const { dependencies } = mockDependencies();
    await expectCode(
      () => __runNativeCandidateRealdataShardEvaluationForTest(input, dependencies),
      "REALDATA_CORPUS_ROOT",
    );
  }
  {
    const { input } = await makeContext(t);
    const { dependencies } = mockDependencies({ responses: { rootInventoryDrift: true } });
    const result = await __runNativeCandidateRealdataShardEvaluationForTest(input, dependencies);
    assert.equal(result.record.readiness_identity.controlled_root_attestation_sha256, ROOT_ATTESTATION_SHA256);
    await readFile(input.finalEvidencePath);
  }
  {
    const { input } = await makeContext(t);
    const { dependencies } = mockDependencies({ responses: { rootDrift: true } });
    await expectCode(
      () => __runNativeCandidateRealdataShardEvaluationForTest(input, dependencies),
      "REALDATA_CONTROLLED_ROOT_IDENTITY",
    );
    await assert.rejects(readFile(input.finalEvidencePath), { code: "ENOENT" });
  }
  {
    const { input } = await makeContext(t);
    const { dependencies } = mockDependencies({ responses: { rootVolumeDrift: true } });
    await expectCode(
      () => __runNativeCandidateRealdataShardEvaluationForTest(input, dependencies),
      "REALDATA_CONTROLLED_ROOT_IDENTITY",
    );
    await assert.rejects(readFile(input.finalEvidencePath), { code: "ENOENT" });
  }
});

test("controlled root identity reader failures become stable runner errors before publishing", async (t) => {
  for (const cause of [
    new Error("external process failed"),
    Object.assign(new Error("FORMAL_TRUST_RETENTION_FORMAT"), { code: "FORMAL_TRUST_RETENTION_FORMAT" }),
  ]) {
    const { input } = await makeContext(t);
    const { calls, dependencies } = mockDependencies({
      responses: { rootReaderThrow: cause },
    });
    await assert.rejects(
      __runNativeCandidateRealdataShardEvaluationForTest(input, dependencies),
      (error) =>
        error instanceof NativeCandidateRealdataShardRunnerError &&
        error.code === "REALDATA_CONTROLLED_ROOT_IDENTITY" &&
        error.cause === cause,
    );
    assert.equal(calls.ledgerPublishes, 0);
    assert.equal(calls.sealPublishes, 0);
    assert.equal(calls.finalPublishes, 0);
    await assert.rejects(readFile(input.finalEvidencePath), { code: "ENOENT" });
  }
});

test("shard response omission duplicate reorder reset drift timeout and resource malformation fail closed before final evidence", async (t) => {
  for (const [caseName, responses, code] of [
    ["omit", { omitLast: true }, "REALDATA_HOST_RESPONSE_COUNT"],
    ["duplicate", { duplicate: true }, "REALDATA_HOST_RESPONSE"],
    ["reorder", { reorder: true }, "REALDATA_HOST_RESPONSE"],
    ["reset", { badReset: true }, "REALDATA_HOST_RESPONSE"],
    ["canary", { canaryDrift: true }, "REALDATA_CANARY_DRIFT"],
    ["crash", { throwOnCall: 2 }, "REALDATA_HOST_PROCESS"],
    ["resource", { badResource: true }, "REALDATA_RESOURCE"],
    ["classification", { badClassification: true }, "REALDATA_HOST_RESPONSE"],
    ["language", { badLanguage: true }, "REALDATA_HOST_RESPONSE"],
    ["wav-sha", { badWavSha: true }, "REALDATA_HOST_RESPONSE"],
    ["wav-size", { badWavSize: true }, "REALDATA_HOST_RESPONSE"],
    ["pcm-sha", { badPcmSha: true }, "REALDATA_HOST_RESPONSE"],
    ["reference-sha", { badReferenceSha: true }, "REALDATA_HOST_RESPONSE"],
    ["canary-identity", { badCanaryIdentity: true }, "REALDATA_HOST_RESPONSE"],
    ["sample-identity", { badSampleIdentity: true }, "REALDATA_HOST_RESPONSE"],
  ]) {
    const { input } = await makeContext(t);
    const { dependencies } = mockDependencies({ responses });
    await expectCode(
      () => __runNativeCandidateRealdataShardEvaluationForTest(input, dependencies),
      code,
    );
    await assert.rejects(readFile(input.finalEvidencePath), { code: "ENOENT" }, caseName);
  }
});

test("source policy snapshot and final-publication drift fail closed without replacing competitors", async (t) => {
  for (const responses of [{ policyDrift: true }, { snapshotDrift: true }]) {
    const { input } = await makeContext(t);
    const { dependencies } = mockDependencies({ responses });
    await expectCode(
      () => __runNativeCandidateRealdataShardEvaluationForTest(input, dependencies),
      "REALDATA_POSTFLIGHT_DRIFT",
    );
    await assert.rejects(readFile(input.finalEvidencePath), { code: "ENOENT" });
  }

  const { input } = await makeContext(t);
  const competitor = Buffer.from("competitor\n", "utf8");
  const { dependencies } = mockDependencies({
    hooks: {
      beforeFinalWrite: async () => {
        await writeFile(input.finalEvidencePath, competitor, { flag: "wx" });
      },
    },
  });
  await assert.rejects(
    __runNativeCandidateRealdataShardEvaluationForTest(input, dependencies),
    { code: "EEXIST" },
  );
  assert.deepEqual(await readFile(input.finalEvidencePath), competitor);
});

test("strict final validator rejects quality authority escalation and selected/default/rank fields", async (t) => {
  const { input } = await makeContext(t);
  const { dependencies } = mockDependencies();
  await __runNativeCandidateRealdataShardEvaluationForTest(input, dependencies);
  const baseline = JSON.parse(await readFile(input.finalEvidencePath, "utf8"));
  for (const mutate of [
    (record) => { record.authority.formal_claims = "quality-pass"; },
    (record) => { record.quality_gate_status = "passed"; },
    (record) => { record.selected_candidate = "host"; },
    (record) => { record.default = true; },
    (record) => { record.rank = 1; },
    (record) => { record.execution.canary_identity_sha256_by_language.fr = "a".repeat(64); },
    (record) => { record.execution.canary_transcript_sha256_by_language.en = "0".repeat(64); },
    (record) => { record.execution.shards[0].resource_observation.extra = true; },
    (record) => { record.resource_observations.status_counts.available = 1; },
    (record) => { record.resource_observations.supervisor_process_status_counts.observed = 1; },
    (record) => { record.ledger_identity.hardware_evidence_sha256 = "a".repeat(64); },
    (record) => { record.host_identity.reference_text = "stable canary"; },
    (record) => { record.host_identity.file_path = "C:\\controlled\\private\\x.wav"; },
    (record) => { record.aggregate = {}; },
    (record) => { record.aggregate.extra = true; },
    (record) => { record.aggregate.authority.production_evidence = true; },
    (record) => { record.aggregate.scorer_profile.profile_sha256 = "a".repeat(64); },
    (record) => { record.aggregate.sample_count = 959; },
    (record) => { record.aggregate.by_language[0].sample_count += 1; },
    (record) => { record.aggregate.by_language[0].error_sums.total += 1; },
    (record) => { record.aggregate.by_language[0].macro_error_rate.numerator = "999"; },
    (record) => { record.aggregate.by_language[0].utterance_error_rate_range.maximum.numerator = "999"; },
    (record) => { record.aggregate.by_language.reverse(); },
    (record) => { record.aggregate.by_language.push(clone(record.aggregate.by_language[0])); },
    (record) => { record.aggregate.by_language_scenario[0].key = "en/misleading"; },
  ]) {
    const mutated = clone(baseline);
    mutate(mutated);
    assert.throws(
      () => validateNativeCandidateRealdataShardEvidenceRecord(
        Buffer.from(encodeCanonicalJsonLine(mutated), "utf8"),
      ),
      (error) => error instanceof NativeCandidateRealdataShardRunnerError,
    );
  }
});

test("production shard spawn helper preserves argv and stdin, rejects stderr exit and timeout without publishing evidence", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "meetingrelay-shard-spawn-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const fixturePath = path.join(root, "fixture-child.mjs");
  const logPath = path.join(root, "child-log.json");
  const response = encodeCanonicalJsonLine({
    ok: true,
    schema_version: "1.0",
  }).trimEnd();
  await writeFile(fixturePath, `
import { appendFileSync } from "node:fs";
const mode = process.argv[2];
const logPath = process.argv[3];
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  appendFileSync(logPath, JSON.stringify({ argv: process.argv.slice(2), input }) + "\\n");
  if (mode === "stderr") {
    process.stderr.write("child stderr\\n");
    process.exit(0);
  }
  if (mode === "exit") process.exit(7);
  if (mode === "sleep") {
    setTimeout(() => process.stdout.write(${JSON.stringify(response)} + "\\n"), 10_000);
    return;
  }
  process.stdout.write(${JSON.stringify(response)} + "\\n");
});
`, "utf8");
  const requests = [{
    canary_identity_sha256: "0".repeat(64),
    classification: "sample",
    is_canary: false,
    language: "en",
    pcm_sha256: "1".repeat(64),
    reference_sha256: "2".repeat(64),
    request_sequence: 1,
    sample_id: "mr-fleurs-0001",
    shard_index: 0,
    wav_path: path.join(root, "one.wav"),
    wav_sha256: "3".repeat(64),
    wav_size_bytes: 46,
  }];
  const startupArguments = ["ok", logPath, "arg-three"];
  const result = await __invokeShardHostWithSpawnForTest({
    executablePath: process.execPath,
    requests,
    resourceSampler: async () => ({ reason: "test", status: "unavailable" }),
    startupArguments: [fixturePath, ...startupArguments],
    timeoutMs: 5_000,
  });
  assert.deepEqual(result.lines, [response]);
  assert.deepEqual(result.resourceObservation, { reason: "supervisor-resource-sampling-unavailable", status: "unavailable" });
  const logRows = (await readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(logRows[0].argv, startupArguments);
  assert.equal(logRows[0].input, "{\"schema_version\":\"1.0\",\"sequence\":1,\"sample_id\":\"mr-fleurs-0001\",\"classification\":\"sample\",\"canary_identity_sha256\":\"0000000000000000000000000000000000000000000000000000000000000000\",\"language\":\"en\",\"wav_path\":" + JSON.stringify(path.join(root, "one.wav")) + ",\"wav_size_bytes\":\"46\",\"wav_sha256\":\"3333333333333333333333333333333333333333333333333333333333333333\",\"pcm_sha256\":\"1111111111111111111111111111111111111111111111111111111111111111\",\"reference_sha256\":\"2222222222222222222222222222222222222222222222222222222222222222\"}\n");

  for (const mode of ["stderr", "exit", "sleep"]) {
    await assert.rejects(
      __invokeShardHostWithSpawnForTest({
        executablePath: process.execPath,
        requests,
        resourceSampler: async () => ({ reason: "test", status: "unavailable" }),
        startupArguments: [fixturePath, mode, logPath],
        timeoutMs: mode === "sleep" ? 100 : 5_000,
      }),
      /REALDATA_HOST_EXIT/u,
      mode,
    );
  }
});

test("schema freezes public root shape and authority ceilings", async (t) => {
  const { input } = await makeContext(t);
  const { dependencies } = mockDependencies();
  const result = await __runNativeCandidateRealdataShardEvaluationForTest(input, dependencies);
  const schema = JSON.parse(await readFile(
    path.join(HERE, "native-candidate-realdata-shard-runner.schema.json"),
    "utf8",
  ));
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual([...schema.required].sort(), Object.keys(result.record).sort());
  assert.equal(schema.properties.measurement_status.const, "measured");
  assert.equal(schema.properties.quality_gate_status.const, "not-assessed");
  assert.equal(schema.$defs.publicAuthority.properties.formal_claims.const, "none");
  assert.equal(schema.$defs.publicAuthority.properties.production_evidence.const, false);
  assert.equal(schema.$defs.publicAuthority.properties.public_distribution.const, false);
  const schemaText = JSON.stringify(schema);
  for (const forbidden of ["threshold", "passed", "rank", "selection", "selected", "default", "publishable"]) {
    assert.equal(schemaText.includes(forbidden), false, forbidden);
  }
});
