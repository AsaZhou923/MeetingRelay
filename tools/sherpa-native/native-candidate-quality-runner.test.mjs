import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { encodeCanonicalJsonLine } from "../phase0-harness/canonical-json.mjs";
import {
  aggregateDescriptiveAsrScores,
  getAsrScorerProfile,
  scoreAsrTranscript,
  validateDescriptiveAsrAggregate,
} from "./asr-error-rate.mjs";
import { validateAsrQualityRunPolicyCoverage } from "./asr-quality-run-policy.mjs";
import {
  buildControlledHypothesisLedger,
  buildControlledHypothesisLedgerSeal,
  publishControlledHypothesisLedger,
  publishControlledHypothesisLedgerSeal,
  readControlledHypothesisLedger,
  readControlledHypothesisLedgerSeal,
} from "./controlled-hypothesis-ledger.mjs";
import {
  NativeCandidateQualityRunnerError,
  __runNativeCandidateQualityEvaluationForTest,
  publishNativeCandidateQualityEvidence,
  runNativeCandidateQualityEvaluation,
  validateNativeCandidateQualityEvidenceFile,
  validateNativeCandidateQualityEvidenceRecord,
} from "./native-candidate-quality-runner.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const POLICY_PATH = path.join(HERE, "asr-quality-run-policy.json");
const SCORER_PATH = path.join(HERE, "asr-scorer-profile.json");
const CANDIDATE_ID = "sherpa-native-sensevoice-int8-2024-07-17-win-x64-cpu";
const SOURCE_COMMIT = "a".repeat(40);
const CONTRACT_SHA256 = "1".repeat(64);
const HARDWARE_SHA256 = "2".repeat(64);
const MEASURED_SHA256 = "3".repeat(64);
const CANDIDATE_MANIFEST_SHA256 = "5".repeat(64);
const OPERATOR_FACTS_SHA256 = "7".repeat(64);
const SCHEMA_REGISTRY_SHA256 = "8".repeat(64);
const BASELINE_HOST_SHA256 = "9".repeat(64);
const CORPUS_MANIFEST_SHA256 = "b".repeat(64);
const CORPUS_SNAPSHOT_SHA256 = "c".repeat(64);
const QUALITY_HOST_BYTES = Buffer.from("synthetic quality host\n", "utf8");
const QUALITY_HOST_SHA256 = sha256(QUALITY_HOST_BYTES);

const PARAMETER_SHA256_BY_LANGUAGE = Object.freeze({
  en: "f411caf1efd92b18b953c3bfd0bf6a4eb49d18068554ce9e70d8a493d325065d",
  ja: "946af178a84c720f928d08ed084fe37625a57447b2ad8e8dc5d36034ea319bf5",
  zh: "0ac8669e387262648fcf05fd301a9ba798bb2822e56ec952f1e17d6c692f802e",
});

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function clone(value) {
  return structuredClone(value);
}

function sampleIdentitySha256(sample) {
  return sha256(Buffer.from(JSON.stringify({
    language: sample.language,
    pcm_sha256: sample.pcmSha256,
    reference_sha256: sample.referenceSha256,
    sample_id: sample.sampleId,
    wav_sha256: sample.wavSha256,
    wav_size_bytes: sample.wavSizeBytes,
  }), "utf8"));
}

function corpusSamples() {
  const definitions = [
    ["sample-en", "en", "hello world", "hello world", "d"],
    ["sample-ja", "ja", "日本語", "", "e"],
    ["sample-zh", "zh", "你好", "你号", "f"],
  ];
  return definitions.map(([sampleId, language, referenceText, hypothesis, digit], index) => {
    const durationSamples = 160 * (index + 1);
    return Object.freeze({
      consentBytes: null,
      durationSamples,
      hypothesis,
      language,
      leakageGroupId: `LG-${sampleId}`,
      licenseBytes: Buffer.from("synthetic-license", "utf8"),
      pcmSha256: digit.repeat(64),
      referencePath: `C:\\controlled\\${sampleId}.txt`,
      referenceSha256: String(index + 1).repeat(64),
      referenceText,
      sampleId,
      sampleRateHz: 16_000,
      scenario: "synthetic-non-speech",
      split: "blind",
      tier: "tier-1",
      wavBytes: Buffer.alloc(44 + durationSamples * 2),
      wavPath: `C:\\controlled\\${sampleId}.wav`,
      wavSha256: digit.repeat(64),
      wavSizeBytes: 44 + durationSamples * 2,
    });
  });
}

function corpusFixture(samples = corpusSamples()) {
  return Object.freeze({
    manifestSha256: CORPUS_MANIFEST_SHA256,
    publicProjection: Object.freeze({
      corpus_id: "synthetic-mechanics-corpus",
      languages: Object.freeze(["en", "ja", "zh"]),
      manifest_sha256: CORPUS_MANIFEST_SHA256,
      sample_count: samples.length,
      scenario_counts: Object.freeze({ "synthetic-non-speech": samples.length }),
      split_counts: Object.freeze({ blind: samples.length }),
      tier_counts: Object.freeze({ "tier-1": samples.length }),
      validation_date: "2026-07-16",
    }),
    samples: Object.freeze(samples),
    snapshotSha256: CORPUS_SNAPSHOT_SHA256,
    validationDate: "2026-07-16",
  });
}

function candidate(language = "zh") {
  return {
    asset_lock_sha256: "d".repeat(64),
    candidate_id: CANDIDATE_ID,
    model_sha256: "e".repeat(64),
    package_lock_sha256: "f".repeat(64),
    parameter_sha256: PARAMETER_SHA256_BY_LANGUAGE[language],
    runtime_bundle_sha256: "1".repeat(64),
    tokens_sha256: "2".repeat(64),
  };
}

function componentResult(samples = corpusSamples()) {
  const record = {
    assessment_status: {
      default_status: "not-authorized",
      parent_closeout_status: "not-assessed",
      quality_status: "not-assessed",
      ranking_status: "not-authorized",
      selection_status: "not-authorized",
      threshold_status: "not-frozen",
    },
    authority: { formal_claims: "none", production_evidence: false },
    candidate_identity: {
      ...candidate(),
      baseline_execution_host: {
        executable_sha256: BASELINE_HOST_SHA256,
        schema_registry_sha256: SCHEMA_REGISTRY_SHA256,
      },
      candidate_manifest_sha256: CANDIDATE_MANIFEST_SHA256,
      measured_evidence_sha256: MEASURED_SHA256,
      parameter_sha256_by_language: { ...PARAMETER_SHA256_BY_LANGUAGE },
    },
    corpus_identity: {
      manifest_sha256: CORPUS_MANIFEST_SHA256,
      sample_count: samples.length,
      snapshot_sha256: CORPUS_SNAPSHOT_SHA256,
      validation_date: "2026-07-16",
    },
    execution_host_identity: {
      executable_sha256: QUALITY_HOST_SHA256,
      schema_registry_sha256: SCHEMA_REGISTRY_SHA256,
    },
    kind: "meetingrelay-native-candidate-component-evidence-v1",
    limitations: [
      "synthetic-contract-foundation-does-not-assess-model-quality",
      "component-evidence-excludes-hypothesis-content-and-scores",
      "candidate-source-and-hardware-artifacts-not-directly-materialized",
      "resource-sampling-unavailable",
      "publication-retains-auditable-create-new-staging-residue",
      "spawn-path-toctou-not-eliminated-by-node-supervisor",
      "thresholds-not-frozen",
      "ranking-selection-default-and-parent-closeout-not-authorized",
    ],
    results: samples.map((sample, index) => {
      const transcriptBytes = Buffer.from(sample.hypothesis, "utf8");
      return {
        attempt: 1,
        candidate_parameter_sha256: PARAMETER_SHA256_BY_LANGUAGE[sample.language],
        execute_elapsed_ns: String(1_000_000 + index),
        final_transcript_sha256: sha256(transcriptBytes),
        final_transcript_utf8_bytes: String(transcriptBytes.length),
        host_record_sha256: String(index + 3).repeat(64),
        language: sample.language,
        prepare_elapsed_ns: String(500_000 + index),
        resources: {
          reason: "SHERPA_QUALITY_RESOURCE_SAMPLING_UNAVAILABLE",
          status: "unavailable",
        },
        rtf: {
          denominator_audio_ns: String(sample.durationSamples * 62_500),
          numerator_execute_ns: String(1_000_000 + index),
        },
        sample_id: sample.sampleId,
        sample_identity_sha256: sampleIdentitySha256(sample),
        scenario: sample.scenario,
        sequence: index + 1,
        split: sample.split,
        tier: sample.tier,
      };
    }),
    schema_version: "1.0",
  };
  const bytes = Buffer.from(encodeCanonicalJsonLine(record), "utf8");
  return {
    bytes,
    evidenceSha256: sha256(bytes),
    record,
  };
}

function transcriptEntries(samples = corpusSamples()) {
  return samples.map((sample, index) => {
    const transcriptBytes = Buffer.from(sample.hypothesis, "utf8");
    return Object.freeze({
      attempt: 1,
      componentRecordSha256: String(index + 3).repeat(64),
      finalTranscript: sample.hypothesis,
      finalTranscriptSha256: sha256(transcriptBytes),
      finalTranscriptUtf8Bytes: String(transcriptBytes.length),
      language: sample.language,
      sampleId: sample.sampleId,
      sampleIdentitySha256: sampleIdentitySha256(sample),
      scenario: sample.scenario,
      sequence: index + 1,
      split: sample.split,
      tier: sample.tier,
    });
  });
}

function componentRunnerFixture({ entries = transcriptEntries(), result = componentResult() } = {}) {
  return async (...arguments_) => {
    const options = arguments_.find((value) =>
      value !== null && typeof value === "object" &&
      typeof value.privateTranscriptConsumer === "function"
    );
    assert.ok(options, "runner must install the private transcript consumer");
    for (const entry of entries) await options.privateTranscriptConsumer(entry);
    const componentInput = arguments_.find((value) =>
      value !== null && typeof value === "object" &&
      typeof value.outputEvidencePath === "string"
    );
    if (componentInput !== undefined) {
      await writeFile(componentInput.outputEvidencePath, result.bytes, { flag: "wx" });
    }
    return {
      evidenceSha256: result.evidenceSha256,
      record: clone(result.record),
    };
  };
}

function measuredEvidenceFixture() {
  return {
    contractManifestSha256: CONTRACT_SHA256,
    evidenceSha256: MEASURED_SHA256,
    hwRefId: "HW-REF-SYNTHETIC-001",
    record: {
      input_identity: {
        config_sha256: PARAMETER_SHA256_BY_LANGUAGE.zh,
        contract_manifest_sha256: CONTRACT_SHA256,
        execution_host_sha256: BASELINE_HOST_SHA256,
        hw_ref_id: "HW-REF-SYNTHETIC-001",
        locked_input_snapshot_sha256: "4".repeat(64),
        measured_hardware_reference_sha256: HARDWARE_SHA256,
        model_sha256: candidate().model_sha256,
        operator_facts_sha256: OPERATOR_FACTS_SHA256,
        quality_reference_manifest_sha256: "5".repeat(64),
        run_plan_sha256: "6".repeat(64),
        runtime_bundle_sha256: candidate().runtime_bundle_sha256,
        schema_registry_sha256: SCHEMA_REGISTRY_SHA256,
        source_commit: SOURCE_COMMIT,
        wav_sha256: "7".repeat(64),
        worker_id: "meetingrelay-sherpa-native-candidate-host-v1",
      },
    },
    sourceCommit: SOURCE_COMMIT,
  };
}

function bundleFixture() {
  return {
    assetLockSha256: candidate().asset_lock_sha256,
    baselineExecutionHostSha256: BASELINE_HOST_SHA256,
    candidateId: CANDIDATE_ID,
    candidateManifestSha256: CANDIDATE_MANIFEST_SHA256,
    configSha256: PARAMETER_SHA256_BY_LANGUAGE.zh,
    contractManifestSha256: CONTRACT_SHA256,
    hardwareEvidenceSha256: HARDWARE_SHA256,
    hwRefId: "HW-REF-SYNTHETIC-001",
    modelSha256: candidate().model_sha256,
    packageLockSha256: candidate().package_lock_sha256,
    runPlanSha256: "6".repeat(64),
    runtimeBundleSha256: candidate().runtime_bundle_sha256,
    schemaRegistrySha256: SCHEMA_REGISTRY_SHA256,
    sourceCommit: SOURCE_COMMIT,
    tokensSha256: candidate().tokens_sha256,
  };
}

async function makeContext(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "meetingrelay-quality-runner-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const bundleRoot = path.join(root, "bundle");
  const controlledRoot = path.join(root, "controlled");
  await Promise.all([
    mkdir(bundleRoot),
    mkdir(path.join(controlledRoot, "private"), { recursive: true }),
    writeFile(path.join(root, "quality-host.exe"), QUALITY_HOST_BYTES),
    writeFile(path.join(root, "measured-evidence.json"), "synthetic measured evidence\n", "utf8"),
  ]);
  const input = {
    bundleRoot,
    componentEvidencePath: path.join(root, "component-evidence.json"),
    controlledRoot,
    corpusInput: { opaque: "externally pinned corpus input" },
    expectedContractSha256: CONTRACT_SHA256,
    expectedHardwareEvidenceSha256: HARDWARE_SHA256,
    expectedMeasuredEvidenceSha256: MEASURED_SHA256,
    expectedQualityHostSha256: QUALITY_HOST_SHA256,
    expectedRunPolicySha256: sha256(await readFile(POLICY_PATH)),
    expectedScorerProfileSha256: getAsrScorerProfile().profile_sha256,
    expectedSourceCommit: SOURCE_COMMIT,
    finalEvidencePath: path.join(root, "quality-evidence.json"),
    ledgerRelativePath: path.join("private", "hypotheses.json"),
    measuredEvidencePath: path.join(root, "measured-evidence.json"),
    qualityHostPath: path.join(root, "quality-host.exe"),
    runPolicyPath: POLICY_PATH,
    scorerProfilePath: SCORER_PATH,
    sealRelativePath: path.join("private", "hypotheses.seal.json"),
  };
  return { input, root };
}

function scorerProfileReaderFixture() {
  const profile = getAsrScorerProfile();
  return async () => ({
    profile: { ...profile },
    profileId: profile.profile_id,
    profileSha256: profile.profile_sha256,
  });
}

function releaseHostFixture() {
  return async () => ({
    executableSha256: QUALITY_HOST_SHA256,
    schemaRegistrySha256: SCHEMA_REGISTRY_SHA256,
  });
}

function finalEvidenceReaderFixture() {
  return async (inputPath) => {
    const bytes = await readFile(inputPath);
    return {
      bytes,
      evidenceSha256: sha256(bytes),
      record: JSON.parse(bytes.toString("utf8")),
    };
  };
}

function finalEvidencePublisherFixture({ hooks = {} } = {}) {
  return async (outputPath, bytes, { afterPersistedRead } = {}) => {
    const stagingPath = path.join(
      path.dirname(outputPath),
      `.${path.basename(outputPath)}.0123456789abcdef0123456789abcdef.staging`,
    );
    await writeFile(stagingPath, bytes, { flag: "wx" });
    await writeFile(outputPath, bytes, { flag: "wx" });
    try {
      await hooks.afterFinalCreate?.({ bytes, outputPath, stagingPath });
      await afterPersistedRead?.();
    } catch (error) {
      throw error;
    }
    return outputPath;
  };
}

async function defaultDependencies(overrides = {}) {
  const policyBytes = await readFile(POLICY_PATH);
  const policy = JSON.parse(policyBytes.toString("utf8"));
  const corpus = corpusFixture();
  return {
    aggregateScores: aggregateDescriptiveAsrScores,
    bundleInspector: async () => clone(bundleFixture()),
    componentRunner: componentRunnerFixture(),
    corpusLoader: async () => corpus,
    finalEvidencePublisher: finalEvidencePublisherFixture(),
    finalEvidenceReader: finalEvidenceReaderFixture(),
    ledgerBuilder: buildControlledHypothesisLedger,
    ledgerPublisher: publishControlledHypothesisLedger,
    ledgerReader: readControlledHypothesisLedger,
    measuredEvidenceReader: async () => clone(measuredEvidenceFixture()),
    policyReader: async () => ({ policy: clone(policy), policySha256: sha256(policyBytes) }),
    releaseHostValidator: releaseHostFixture(),
    scoreTranscript: scoreAsrTranscript,
    scorerProfileReader: scorerProfileReaderFixture(),
    sealBuilder: buildControlledHypothesisLedgerSeal,
    sealPublisher: publishControlledHypothesisLedgerSeal,
    sealReader: readControlledHypothesisLedgerSeal,
    validateAggregate: validateDescriptiveAsrAggregate,
    validateCoverage: validateAsrQualityRunPolicyCoverage,
    hooks: {},
    ...overrides,
  };
}

async function expectCode(operation, code) {
  let captured;
  await assert.rejects(operation, (error) => {
    captured = error;
    return error instanceof NativeCandidateQualityRunnerError && error.code === code;
  });
  return captured;
}

async function expectQualityRunFailure(operation) {
  let captured;
  await assert.rejects(operation, (error) => {
    captured = error;
    return error instanceof NativeCandidateQualityRunnerError &&
      typeof error.code === "string" && error.code.startsWith("QUALITY_RUN_");
  });
  return captured;
}

function assertNoControlledTextOrPath(value, samples = corpusSamples()) {
  const serialized = JSON.stringify(value);
  const forbidden = [
    "C:\\controlled",
    "controlledRoot",
    "ledgerRelativePath",
    "sealRelativePath",
    "referencePath",
    "wavPath",
    ...samples.map((sample) => sample.referenceText),
    ...samples.map((sample) => sample.hypothesis).filter(Boolean),
  ];
  for (const secret of forbidden.filter(Boolean)) {
    assert.equal(serialized.includes(secret), false, secret);
  }
}

test("three-language evaluation preserves canonical sample order and exact descriptive scores", async (t) => {
  const { input } = await makeContext(t);
  const dependencies = await defaultDependencies();
  const result = await __runNativeCandidateQualityEvaluationForTest(input, dependencies);
  const expectedScores = corpusSamples().map((sample) => scoreAsrTranscript({
    hypothesis: sample.hypothesis,
    language: sample.language,
    reference: sample.referenceText,
    sampleId: sample.sampleId,
    scenario: sample.scenario,
    tier: sample.tier,
  }));
  assert.deepEqual(result.record.scores, expectedScores);
  assert.deepEqual(result.record.aggregate, aggregateDescriptiveAsrScores(expectedScores));
  assert.deepEqual(result.record.scores.map((score) => score.sampleId), [
    "sample-en",
    "sample-ja",
    "sample-zh",
  ]);
  assert.equal(result.evidenceSha256, sha256(await readFile(input.finalEvidencePath)));
});

test("an empty native hypothesis is scored as complete deletion without being excluded", async (t) => {
  const { input } = await makeContext(t);
  const result = await __runNativeCandidateQualityEvaluationForTest(
    input,
    await defaultDependencies(),
  );
  const score = result.record.scores.find(({ sampleId }) => sampleId === "sample-ja");
  assert.deepEqual(score.errors, {
    deletions: 3,
    insertions: 0,
    substitutions: 0,
    total: 3,
  });
  assert.deepEqual(score.errorRate, { denominator: "3", numerator: "3", status: "measured" });
  assert.equal(result.record.component_evidence.sample_count, 3);
  assert.equal(result.record.ledger_identity.entry_count, 3);
});

test("final evidence remains text-free and cannot promote quality or production authority", async (t) => {
  const { input } = await makeContext(t);
  const result = await __runNativeCandidateQualityEvaluationForTest(
    input,
    await defaultDependencies(),
  );
  assertNoControlledTextOrPath(result.record);
  const persistedText = await readFile(input.finalEvidencePath, "utf8");
  assertNoControlledTextOrPath(JSON.parse(persistedText));
  for (const key of [
    "bundleRoot", "componentEvidencePath", "controlledRoot", "finalEvidencePath",
    "measuredEvidencePath", "qualityHostPath", "runPolicyPath", "scorerProfilePath",
    "ledgerRelativePath", "sealRelativePath",
  ]) {
    assert.equal(persistedText.includes(input[key]), false, key);
  }
  assert.deepEqual(result.record.authority, {
    formal_claims: "none",
    production_evidence: false,
    public_distribution: false,
  });
  assert.equal(result.record.measurement_status, "scorer-mechanics-exercised");
  assert.equal(result.record.quality_gate_status, "not-assessed");
});

test("the public API exposes no caller adapter or optional policy defaults", async () => {
  assert.equal(runNativeCandidateQualityEvaluation.length, 1);
});

test("run input rejects missing and extra fields before any dependency is invoked", async (t) => {
  const { input } = await makeContext(t);
  let calls = 0;
  const dependencies = await defaultDependencies({
    bundleInspector: async () => { calls += 1; return clone(bundleFixture()); },
  });
  const missing = { ...input };
  delete missing.expectedRunPolicySha256;
  await expectCode(
    __runNativeCandidateQualityEvaluationForTest(missing, dependencies),
    "QUALITY_RUN_INPUT_FIELDS",
  );
  await expectCode(
    __runNativeCandidateQualityEvaluationForTest({ ...input, ambientPolicy: {} }, dependencies),
    "QUALITY_RUN_INPUT_FIELDS",
  );
  assert.equal(calls, 0);
});

test("trust anchors reject zero digests and zero commits before materialization", async (t) => {
  const { input } = await makeContext(t);
  let calls = 0;
  const dependencies = await defaultDependencies({
    corpusLoader: async () => { calls += 1; return corpusFixture(); },
  });
  await expectCode(
    __runNativeCandidateQualityEvaluationForTest({
      ...input,
      expectedMeasuredEvidenceSha256: "0".repeat(64),
    }, dependencies),
    "QUALITY_RUN_TRUST_ANCHOR",
  );
  await expectCode(
    __runNativeCandidateQualityEvaluationForTest({
      ...input,
      expectedSourceCommit: "0".repeat(40),
    }, dependencies),
    "QUALITY_RUN_SOURCE_COMMIT",
  );
  assert.equal(calls, 0);
});

test("the runner rejects any policy max_attempts other than one", async (t) => {
  const { input } = await makeContext(t);
  const bytes = await readFile(POLICY_PATH);
  const policy = JSON.parse(bytes.toString("utf8"));
  policy.max_attempts = 2;
  let componentCalls = 0;
  await expectQualityRunFailure(__runNativeCandidateQualityEvaluationForTest(
    input,
    await defaultDependencies({
      componentRunner: async () => { componentCalls += 1; throw new Error("must not run"); },
      policyReader: async () => ({ policy, policySha256: input.expectedRunPolicySha256 }),
    }),
  ));
  assert.equal(componentCalls, 0);
});

test("the runner rejects any policy that permits exclusions", async (t) => {
  const { input } = await makeContext(t);
  const bytes = await readFile(POLICY_PATH);
  const policy = JSON.parse(bytes.toString("utf8"));
  policy.exclusion_policy = "allow";
  let componentCalls = 0;
  await expectQualityRunFailure(__runNativeCandidateQualityEvaluationForTest(
    input,
    await defaultDependencies({
      componentRunner: async () => { componentCalls += 1; throw new Error("must not run"); },
      policyReader: async () => ({ policy, policySha256: input.expectedRunPolicySha256 }),
    }),
  ));
  assert.equal(componentCalls, 0);
});

test("missing a required language and scenario slice fails before native execution", async (t) => {
  const { input } = await makeContext(t);
  const incomplete = corpusFixture(corpusSamples().slice(0, 2));
  let componentCalls = 0;
  await expectQualityRunFailure(__runNativeCandidateQualityEvaluationForTest(
    input,
    await defaultDependencies({
      componentRunner: async () => { componentCalls += 1; throw new Error("must not run"); },
      corpusLoader: async () => incomplete,
    }),
  ));
  assert.equal(componentCalls, 0);
});

test("an unrequested language and scenario slice fails before native execution", async (t) => {
  const { input } = await makeContext(t);
  const baseline = corpusSamples();
  const extra = Object.freeze({
    ...baseline[0],
    hypothesis: "extra",
    leakageGroupId: "LG-sample-zz-extra",
    pcmSha256: "a".repeat(64),
    referencePath: "C:\\controlled\\sample-zz-extra.txt",
    referenceSha256: "b".repeat(64),
    referenceText: "extra",
    sampleId: "sample-zz-extra",
    scenario: "unexpected-scenario",
    wavPath: "C:\\controlled\\sample-zz-extra.wav",
    wavSha256: "c".repeat(64),
  });
  let componentCalls = 0;
  await expectQualityRunFailure(__runNativeCandidateQualityEvaluationForTest(
    input,
    await defaultDependencies({
      componentRunner: async () => { componentCalls += 1; throw new Error("must not run"); },
      corpusLoader: async () => corpusFixture([...baseline, extra]),
    }),
  ));
  assert.equal(componentCalls, 0);
});

test("private transcript callbacks must arrive in canonical sample order", async (t) => {
  const { input } = await makeContext(t);
  const reversed = [...transcriptEntries()].reverse();
  await expectQualityRunFailure(__runNativeCandidateQualityEvaluationForTest(
    input,
    await defaultDependencies({ componentRunner: componentRunnerFixture({ entries: reversed }) }),
  ));
  await assert.rejects(readFile(input.finalEvidencePath), { code: "ENOENT" });
});

test("private transcript callbacks cannot change the frozen attempt number", async (t) => {
  const { input } = await makeContext(t);
  const entries = transcriptEntries().map((entry, index) =>
    index === 0 ? { ...entry, attempt: 2 } : entry
  );
  await expectQualityRunFailure(__runNativeCandidateQualityEvaluationForTest(
    input,
    await defaultDependencies({ componentRunner: componentRunnerFixture({ entries }) }),
  ));
  await assert.rejects(readFile(input.finalEvidencePath), { code: "ENOENT" });
});

test("every component result requires exactly one private transcript callback", async (t) => {
  const { input } = await makeContext(t);
  await expectQualityRunFailure(__runNativeCandidateQualityEvaluationForTest(
    input,
    await defaultDependencies({
      componentRunner: componentRunnerFixture({ entries: transcriptEntries().slice(0, 2) }),
    }),
  ));
  await assert.rejects(readFile(input.finalEvidencePath), { code: "ENOENT" });
});

test("duplicate private transcript callbacks fail without publishing final evidence", async (t) => {
  const { input } = await makeContext(t);
  const entries = transcriptEntries();
  entries.splice(1, 0, entries[0]);
  await expectQualityRunFailure(__runNativeCandidateQualityEvaluationForTest(
    input,
    await defaultDependencies({ componentRunner: componentRunnerFixture({ entries }) }),
  ));
  await assert.rejects(readFile(input.finalEvidencePath), { code: "ENOENT" });
});

test("scorer callback failures never retain controlled plaintext in the error", async (t) => {
  const { input } = await makeContext(t);
  const secret = "private-hypothesis-must-not-escape";
  const error = await expectQualityRunFailure(__runNativeCandidateQualityEvaluationForTest(
    input,
    await defaultDependencies({
      scoreTranscript: () => { throw new Error(secret); },
    }),
  ));
  assert.equal(error.cause, undefined);
  assert.equal(String(error).includes(secret), false);
  assert.equal(JSON.stringify(error).includes(secret), false);
});

test("component failures never retain private transcript text or error causes", async (t) => {
  const { input } = await makeContext(t);
  const secret = "private-component-hypothesis-must-not-escape";
  const error = await expectQualityRunFailure(__runNativeCandidateQualityEvaluationForTest(
    input,
    await defaultDependencies({
      componentRunner: async (_componentInput, { privateTranscriptConsumer }) => {
        await privateTranscriptConsumer(transcriptEntries()[0]);
        throw new Error(secret);
      },
    }),
  ));
  assert.equal(error.cause, undefined);
  assert.equal(String(error).includes(secret), false);
  assert.equal(JSON.stringify(error).includes(secret), false);
});

test("every external trust anchor is checked before native execution", async (t) => {
  const mutations = [
    ["contract", (input) => { input.expectedContractSha256 = "a".repeat(64); }],
    ["hardware", (input) => { input.expectedHardwareEvidenceSha256 = "a".repeat(64); }],
    ["measured", (input) => { input.expectedMeasuredEvidenceSha256 = "a".repeat(64); }],
    ["quality-host", (input) => { input.expectedQualityHostSha256 = "a".repeat(64); }],
    ["run-policy", (input) => { input.expectedRunPolicySha256 = "a".repeat(64); }],
    ["scorer", (input) => { input.expectedScorerProfileSha256 = "a".repeat(64); }],
    ["source", (input) => { input.expectedSourceCommit = "b".repeat(40); }],
  ];
  for (const [lane, mutate] of mutations) {
    const { input } = await makeContext(t);
    mutate(input);
    let componentCalls = 0;
    await expectQualityRunFailure(__runNativeCandidateQualityEvaluationForTest(
      input,
      await defaultDependencies({
        componentRunner: async () => { componentCalls += 1; throw new Error("must not run"); },
      }),
    ));
    assert.equal(componentCalls, 0, lane);
  }
});

test("postflight re-reads reject policy corpus bundle measured host and scorer drift", async (t) => {
  const lanes = ["policy", "corpus", "bundle", "measured", "host", "scorer"];
  for (const lane of lanes) {
    const { input } = await makeContext(t);
    const base = await defaultDependencies();
    const calls = { bundle: 0, corpus: 0, host: 0, measured: 0, policy: 0, scorer: 0 };
    const driftedCorpus = { ...corpusFixture(), snapshotSha256: "f".repeat(64) };
    const driftedBundle = { ...bundleFixture(), runPlanSha256: "f".repeat(64) };
    const driftedMeasured = { ...measuredEvidenceFixture(), evidenceSha256: "f".repeat(64) };
    const policyBytes = await readFile(POLICY_PATH);
    const policy = JSON.parse(policyBytes.toString("utf8"));
    const dependencies = {
      ...base,
      bundleInspector: async () => {
        calls.bundle += 1;
        return clone(lane === "bundle" && calls.bundle > 1 ? driftedBundle : bundleFixture());
      },
      corpusLoader: async () => {
        calls.corpus += 1;
        return lane === "corpus" && calls.corpus > 1 ? driftedCorpus : corpusFixture();
      },
      measuredEvidenceReader: async () => {
        calls.measured += 1;
        return clone(lane === "measured" && calls.measured > 1 ? driftedMeasured : measuredEvidenceFixture());
      },
      policyReader: async () => {
        calls.policy += 1;
        return {
          policy: clone(policy),
          policySha256: lane === "policy" && calls.policy > 1
            ? "f".repeat(64)
            : input.expectedRunPolicySha256,
        };
      },
      releaseHostValidator: async () => {
        calls.host += 1;
        return {
          executableSha256: lane === "host" && calls.host > 1
            ? "f".repeat(64)
            : QUALITY_HOST_SHA256,
          schemaRegistrySha256: SCHEMA_REGISTRY_SHA256,
        };
      },
      scorerProfileReader: async () => {
        calls.scorer += 1;
        const profile = getAsrScorerProfile();
        const digest = lane === "scorer" && calls.scorer > 1
          ? "f".repeat(64)
          : profile.profile_sha256;
        return { profile: { ...profile }, profileId: profile.profile_id, profileSha256: digest };
      },
    };
    await expectQualityRunFailure(
      __runNativeCandidateQualityEvaluationForTest(input, dependencies),
    );
    assert.ok(calls[lane] > 1, `${lane} was not postflight re-read`);
    await assert.rejects(readFile(input.finalEvidencePath), { code: "ENOENT" });
  }
});

test("a ledger readback digest mismatch blocks seal and final publication", async (t) => {
  const { input } = await makeContext(t);
  let sealPublishes = 0;
  const dependencies = await defaultDependencies({
    ledgerReader: async (...arguments_) => {
      const value = await readControlledHypothesisLedger(...arguments_);
      return { ...value, ledgerSha256: "f".repeat(64) };
    },
    sealPublisher: async () => { sealPublishes += 1; throw new Error("must not publish"); },
  });
  await expectQualityRunFailure(
    __runNativeCandidateQualityEvaluationForTest(input, dependencies),
  );
  assert.equal(sealPublishes, 0);
  await assert.rejects(readFile(input.finalEvidencePath), { code: "ENOENT" });
});

test("a seal readback binding mismatch blocks final publication", async (t) => {
  const { input } = await makeContext(t);
  let finalPublishes = 0;
  const dependencies = await defaultDependencies({
    finalEvidencePublisher: async () => { finalPublishes += 1; throw new Error("must not publish"); },
    sealReader: async (...arguments_) => {
      const value = await readControlledHypothesisLedgerSeal(...arguments_);
      return { ...value, projectionSha256: "f".repeat(64) };
    },
  });
  await expectQualityRunFailure(
    __runNativeCandidateQualityEvaluationForTest(input, dependencies),
  );
  assert.equal(finalPublishes, 0);
  await assert.rejects(readFile(input.finalEvidencePath), { code: "ENOENT" });
});

test("postflight rejects component ledger and seal material drift", async (t) => {
  for (const lane of ["component", "ledger", "seal"]) {
    const { input } = await makeContext(t);
    const calls = { component: 0, ledger: 0, seal: 0 };
    const dependencies = await defaultDependencies({
      componentEvidenceReader: async (inputPath) => {
        calls.component += 1;
        const bytes = await readFile(inputPath);
        const record = JSON.parse(bytes.toString("utf8"));
        return {
          evidenceSha256: lane === "component" && calls.component > 1
            ? "f".repeat(64)
            : sha256(bytes),
          record,
        };
      },
      ledgerReader: async (...arguments_) => {
        calls.ledger += 1;
        const value = await readControlledHypothesisLedger(...arguments_);
        return lane === "ledger" && calls.ledger > 1
          ? { ...value, ledgerSha256: "f".repeat(64) }
          : value;
      },
      sealReader: async (...arguments_) => {
        calls.seal += 1;
        const value = await readControlledHypothesisLedgerSeal(...arguments_);
        return lane === "seal" && calls.seal > 1
          ? { ...value, sealSha256: "f".repeat(64) }
          : value;
      },
    });
    await expectQualityRunFailure(
      __runNativeCandidateQualityEvaluationForTest(input, dependencies),
    );
    assert.ok(calls[lane] > 1, `${lane} was not postflight re-read`);
    await assert.rejects(readFile(input.finalEvidencePath), { code: "ENOENT" });
  }
});

test("pre-existing component ledger seal and final targets are preserved", async (t) => {
  const lanes = [
    ["component", (input) => input.componentEvidencePath],
    ["ledger", (input) => path.join(input.controlledRoot, input.ledgerRelativePath)],
    ["seal", (input) => path.join(input.controlledRoot, input.sealRelativePath)],
    ["final", (input) => input.finalEvidencePath],
  ];
  for (const [lane, locate] of lanes) {
    const { input } = await makeContext(t);
    const target = locate(input);
    await writeFile(target, `competitor-${lane}\n`, "utf8");
    let componentCalls = 0;
    await expectQualityRunFailure(__runNativeCandidateQualityEvaluationForTest(
      input,
      await defaultDependencies({
        componentRunner: async () => { componentCalls += 1; throw new Error("must not run"); },
      }),
    ));
    assert.equal(componentCalls, 0, lane);
    assert.equal(await readFile(target, "utf8"), `competitor-${lane}\n`);
  }
});

test("a ledger publication race preserves competitor and staging pathnames", async (t) => {
  const { input } = await makeContext(t);
  const target = path.join(input.controlledRoot, input.ledgerRelativePath);
  const staging = path.join(path.dirname(target), ".hypotheses.json.competitor.staging");
  const competitor = Buffer.from("competitor-ledger\n", "utf8");
  await expectQualityRunFailure(__runNativeCandidateQualityEvaluationForTest(
    input,
    await defaultDependencies({
      ledgerPublisher: async (_controlledRoot, _relativePath, bytes) => {
        await writeFile(staging, bytes, { flag: "wx" });
        await writeFile(target, competitor, { flag: "wx" });
        throw new Error("injected ledger publication race");
      },
    }),
  ));
  assert.deepEqual(await readFile(target), competitor);
  assert.ok((await readFile(staging)).length > 0);
  await assert.rejects(readFile(input.finalEvidencePath), { code: "ENOENT" });
});

test("final persisted-record replacement retains competitor and staging audit residue", async (t) => {
  const { input, root } = await makeContext(t);
  const competitor = Buffer.from('{"competitor":true}\n', "utf8");
  const dependencies = await defaultDependencies({
    finalEvidencePublisher: finalEvidencePublisherFixture({
      hooks: {
        afterFinalCreate: async ({ outputPath }) => {
          await rm(outputPath, { force: true });
          await writeFile(outputPath, competitor);
        },
      },
    }),
  });
  await expectQualityRunFailure(
    __runNativeCandidateQualityEvaluationForTest(input, dependencies),
  );
  assert.deepEqual(await readFile(input.finalEvidencePath), competitor);
  assert.equal((await readdir(root)).filter((name) => name.endsWith(".staging")).length, 1);
});

test("an ambiguous final publication error never unlinks a competitor", async (t) => {
  const { input } = await makeContext(t);
  const competitor = Buffer.from("competitor-final\n", "utf8");
  await expectQualityRunFailure(__runNativeCandidateQualityEvaluationForTest(
    input,
    await defaultDependencies({
      finalEvidencePublisher: async (outputPath) => {
        await writeFile(outputPath, competitor, { flag: "wx" });
        throw new Error("ambiguous link result");
      },
    }),
  ));
  assert.deepEqual(await readFile(input.finalEvidencePath), competitor);
});

test("the production final publisher is create-new no-replace and retains its audit hard link", async (t) => {
  const { input, root } = await makeContext(t);
  await __runNativeCandidateQualityEvaluationForTest(input, await defaultDependencies());
  const bytes = await readFile(input.finalEvidencePath);
  const outputPath = path.join(root, "production-quality-evidence.json");
  const suffix = "0".repeat(32);
  assert.equal(
    await publishNativeCandidateQualityEvidence(outputPath, bytes, {
      randomSuffix: () => suffix,
    }),
    outputPath,
  );
  assert.deepEqual(await readFile(outputPath), bytes);
  const validated = await validateNativeCandidateQualityEvidenceFile(outputPath);
  assert.equal(validated.evidenceSha256, sha256(bytes));
  assert.deepEqual(validated.bytes, bytes);
  const stagingPath = path.join(root, `.production-quality-evidence.json.${suffix}.staging`);
  assert.deepEqual(await readFile(stagingPath), bytes);

  await expectCode(
    publishNativeCandidateQualityEvidence(outputPath, bytes, {
      randomSuffix: () => "1".repeat(32),
    }),
    "QUALITY_EVIDENCE_OUTPUT",
  );
  assert.deepEqual(await readFile(outputPath), bytes);
  assert.deepEqual(await readFile(stagingPath), bytes);
});

test("the production final publisher retains competitor and staging after a post-link replacement", async (t) => {
  const { input, root } = await makeContext(t);
  await __runNativeCandidateQualityEvaluationForTest(input, await defaultDependencies());
  const bytes = await readFile(input.finalEvidencePath);
  const outputPath = path.join(root, "replaced-quality-evidence.json");
  const suffix = "2".repeat(32);
  const competitor = Buffer.from("competitor-final\n", "utf8");
  await expectCode(
    publishNativeCandidateQualityEvidence(outputPath, bytes, {
      afterLinkBeforeRead: async ({ outputPath: publishedPath }) => {
        await rm(publishedPath, { force: true });
        await writeFile(publishedPath, competitor, { flag: "wx" });
      },
      randomSuffix: () => suffix,
    }),
    "QUALITY_EVIDENCE_OUTPUT",
  );
  assert.deepEqual(await readFile(outputPath), competitor);
  assert.deepEqual(
    await readFile(path.join(root, `.replaced-quality-evidence.json.${suffix}.staging`)),
    bytes,
  );

  const ambiguousOutput = path.join(root, "ambiguous-quality-evidence.json");
  const ambiguousSuffix = "3".repeat(32);
  await expectCode(
    publishNativeCandidateQualityEvidence(ambiguousOutput, bytes, {
      linkFile: async (source, target) => {
        await link(source, target);
        throw new Error("injected ambiguous link result");
      },
      randomSuffix: () => ambiguousSuffix,
    }),
    "QUALITY_EVIDENCE_OUTPUT",
  );
  assert.deepEqual(await readFile(ambiguousOutput), bytes);
  assert.deepEqual(
    await readFile(path.join(root, `.ambiguous-quality-evidence.json.${ambiguousSuffix}.staging`)),
    bytes,
  );
});

test("final record uses only the frozen root and nested identity fields", async (t) => {
  const { input } = await makeContext(t);
  const { record } = await __runNativeCandidateQualityEvaluationForTest(
    input,
    await defaultDependencies(),
  );
  assert.deepEqual(Object.keys(record).sort(), [
    "aggregate", "authority", "candidate_identity", "component_evidence",
    "corpus_identity", "hardware_identity", "kind", "ledger_identity",
    "measurement_status", "quality_gate_status", "run_policy_identity",
    "schema_version", "scorer_identity", "scores", "source_identity",
  ].sort());
  assert.deepEqual(Object.keys(record.candidate_identity).sort(), [
    "asset_lock_sha256", "baseline_execution_host_sha256", "candidate_id",
    "candidate_manifest_sha256", "config_sha256", "contract_manifest_sha256",
    "execution_host_sha256", "measured_evidence_sha256", "model_sha256",
    "package_lock_sha256", "runtime_bundle_sha256", "schema_registry_sha256",
    "tokens_sha256",
  ].sort());
  assert.deepEqual(Object.keys(record.component_evidence).sort(), ["sample_count", "sha256"]);
  assert.deepEqual(Object.keys(record.corpus_identity).sort(), [
    "manifest_sha256", "sample_count", "slice_count", "snapshot_sha256", "validation_date",
  ].sort());
  assert.deepEqual(Object.keys(record.hardware_identity).sort(), [
    "evidence_sha256", "hw_ref_id", "operator_facts_sha256",
  ].sort());
  assert.deepEqual(Object.keys(record.ledger_identity).sort(), [
    "candidate_identity_sha256", "entry_count", "projection_sha256", "seal_sha256", "sha256",
  ].sort());
  assert.deepEqual(Object.keys(record.run_policy_identity).sort(), [
    "coverage_scope", "exclusion_policy", "max_attempts", "sha256",
  ].sort());
  assert.deepEqual(Object.keys(record.scorer_identity).sort(), ["profile_id", "profile_sha256"]);
  assert.deepEqual(Object.keys(record.source_identity).sort(), ["commit", "evidence_sha256"]);
});

test("the strict final validator rejects every authority or assessment promotion", async (t) => {
  const { input } = await makeContext(t);
  await __runNativeCandidateQualityEvaluationForTest(input, await defaultDependencies());
  const baseline = JSON.parse(await readFile(input.finalEvidencePath, "utf8"));
  const mutations = [
    (record) => { record.authority.formal_claims = "QUALITY-PASS"; },
    (record) => { record.authority.production_evidence = true; },
    (record) => { record.authority.public_distribution = true; },
    (record) => { record.measurement_status = "quality-measured"; },
    (record) => { record.quality_gate_status = "passed"; },
    (record) => { record.run_policy_identity.max_attempts = 2; },
    (record) => { record.run_policy_identity.exclusion_policy = "allow"; },
  ];
  for (const mutate of mutations) {
    const promoted = clone(baseline);
    mutate(promoted);
    assert.throws(
      () => validateNativeCandidateQualityEvidenceRecord(
        Buffer.from(encodeCanonicalJsonLine(promoted), "utf8"),
      ),
      (error) => error instanceof NativeCandidateQualityRunnerError,
    );
  }
});

test("the strict final validator rejects contradictory scorer corpus and source identities", async (t) => {
  const { input } = await makeContext(t);
  await __runNativeCandidateQualityEvaluationForTest(input, await defaultDependencies());
  const baseline = JSON.parse(await readFile(input.finalEvidencePath, "utf8"));
  const mutations = [
    [
      (record) => { record.scorer_identity.profile_sha256 = "a".repeat(64); },
      "QUALITY_EVIDENCE_SCORER_JOIN",
    ],
    [
      (record) => { record.corpus_identity.slice_count -= 1; },
      "QUALITY_EVIDENCE_COUNT_JOIN",
    ],
    [
      (record) => { record.source_identity.evidence_sha256 = "a".repeat(64); },
      "QUALITY_EVIDENCE_SOURCE_JOIN",
    ],
  ];
  for (const [mutate, code] of mutations) {
    const contradictory = clone(baseline);
    mutate(contradictory);
    assert.throws(
      () => validateNativeCandidateQualityEvidenceRecord(
        Buffer.from(encodeCanonicalJsonLine(contradictory), "utf8"),
      ),
      (error) => error instanceof NativeCandidateQualityRunnerError && error.code === code,
    );
  }
});

test("JSON Schema freezes the same exact fields and authority ceilings as the validator", async (t) => {
  const { input } = await makeContext(t);
  const { record } = await __runNativeCandidateQualityEvaluationForTest(
    input,
    await defaultDependencies(),
  );
  const schema = JSON.parse(await readFile(
    path.join(HERE, "native-candidate-quality-runner.schema.json"),
    "utf8",
  ));
  const dereference = (node) => {
    if (typeof node?.$ref !== "string") return node;
    const name = node.$ref.split("/").at(-1);
    return schema.$defs[name];
  };
  const assertExactObjectShape = (node, value, label) => {
    const resolved = dereference(node);
    assert.equal(resolved.type, "object", label);
    assert.equal(resolved.additionalProperties, false, label);
    assert.deepEqual([...resolved.required].sort(), Object.keys(value).sort(), label);
  };

  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assertExactObjectShape(schema, record, "root");
  for (const [property, value] of [
    ["authority", record.authority],
    ["candidate_identity", record.candidate_identity],
    ["component_evidence", record.component_evidence],
    ["corpus_identity", record.corpus_identity],
    ["hardware_identity", record.hardware_identity],
    ["ledger_identity", record.ledger_identity],
    ["run_policy_identity", record.run_policy_identity],
    ["scorer_identity", record.scorer_identity],
    ["source_identity", record.source_identity],
  ]) {
    assertExactObjectShape(schema.properties[property], value, property);
  }
  assertExactObjectShape(schema.$defs.score, record.scores[0], "score");
  assertExactObjectShape(schema.$defs.descriptiveAuthority, record.scores[0].authority, "score authority");
  assertExactObjectShape(schema.$defs.errorRate, record.scores[0].errorRate, "score rate");
  assertExactObjectShape(schema.$defs.errors, record.scores[0].errors, "score errors");
  assertExactObjectShape(schema.$defs.scorerProfile, record.scores[0].scorerProfile, "score profile");
  assertExactObjectShape(schema.$defs.aggregate, record.aggregate, "aggregate");
  assertExactObjectShape(schema.$defs.descriptiveAuthority, record.aggregate.authority, "aggregate authority");
  assertExactObjectShape(schema.$defs.scorerProfile, record.aggregate.scorer_profile, "aggregate profile");
  assertExactObjectShape(schema.$defs.languageSummary, record.aggregate.by_language[0], "language summary");
  assertExactObjectShape(
    schema.$defs.languageScenarioSummary,
    record.aggregate.by_language_scenario[0],
    "language scenario summary",
  );
  assertExactObjectShape(schema.$defs.errorSums, record.aggregate.by_language[0].error_sums, "error sums");
  assertExactObjectShape(
    schema.$defs.rateRange,
    record.aggregate.by_language[0].utterance_error_rate_range,
    "rate range",
  );
  assertExactObjectShape(
    schema.$defs.aggregateRate,
    record.aggregate.by_language[0].macro_error_rate,
    "aggregate rate",
  );

  assert.equal(schema.properties.kind.const, record.kind);
  assert.equal(schema.properties.schema_version.const, record.schema_version);
  assert.equal(schema.properties.measurement_status.const, "scorer-mechanics-exercised");
  assert.equal(schema.properties.quality_gate_status.const, "not-assessed");
  assert.equal(schema.$defs.publicAuthority.properties.formal_claims.const, "none");
  assert.equal(schema.$defs.publicAuthority.properties.production_evidence.const, false);
  assert.equal(schema.$defs.publicAuthority.properties.public_distribution.const, false);
  assert.equal(schema.properties.run_policy_identity.properties.coverage_scope.const, "synthetic-mechanics-only");
  assert.equal(schema.properties.run_policy_identity.properties.exclusion_policy.const, "none");
  assert.equal(schema.properties.run_policy_identity.properties.max_attempts.const, 1);
  assert.equal(schema.$defs.scorerProfile.properties.profile_id.const, "meetingrelay-asr-scorer-profile-v1");
  assert.equal(schema.properties.scores.maxItems, 1_000);
  assert.equal(new RegExp(schema.$defs.digest.pattern, "u").test("0".repeat(64)), false);
  assert.equal(new RegExp(schema.$defs.digest.pattern, "u").test("a".repeat(64)), true);
  assert.equal(new RegExp(schema.$defs.commit.pattern, "u").test("0".repeat(40)), false);
  assert.equal(new RegExp(schema.$defs.commit.pattern, "u").test("a".repeat(40)), true);

  const schemaText = JSON.stringify(schema);
  for (const forbidden of [
    "final_transcript", "referenceText", "wavPath", "ledger_path", "controlledRoot",
    "quality_passed", "selected_candidate", "default_candidate",
  ]) {
    assert.equal(schemaText.includes(forbidden), false, forbidden);
  }
});
