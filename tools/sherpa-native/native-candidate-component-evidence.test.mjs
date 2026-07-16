import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { encodeCanonicalJsonLine } from "../phase0-harness/canonical-json.mjs";
import {
  NativeCandidateComponentEvidenceError,
  __runNativeCandidateComponentEvidenceForTest,
  publishNativeCandidateComponentEvidence,
  validateNativeCandidateComponentEvidenceFile,
  validateNativeCandidateComponentEvidenceRecord,
} from "./native-candidate-component-evidence.mjs";

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../..");
const CANDIDATE_ID = "sherpa-native-sensevoice-int8-2024-07-17-win-x64-cpu";
const QUALITY_HOST_BYTES = Buffer.from("synthetic quality host executable bytes\n", "utf8");
const SCHEMA_REGISTRY_BYTES = Buffer.from('{"kind":"synthetic-schema-registry"}\n', "utf8");

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

const PARAMETER_SHA256_BY_LANGUAGE = {
  en: "f411caf1efd92b18b953c3bfd0bf6a4eb49d18068554ce9e70d8a493d325065d",
  ja: "946af178a84c720f928d08ed084fe37625a57447b2ad8e8dc5d36034ea319bf5",
  zh: "0ac8669e387262648fcf05fd301a9ba798bb2822e56ec952f1e17d6c692f802e",
};

function candidate(language = "zh") {
  return {
    asset_lock_sha256: "1".repeat(64),
    candidate_id: CANDIDATE_ID,
    model_sha256: "3".repeat(64),
    package_lock_sha256: "4".repeat(64),
    parameter_sha256: PARAMETER_SHA256_BY_LANGUAGE[language],
    runtime_bundle_sha256: "6".repeat(64),
    tokens_sha256: "8".repeat(64),
  };
}

function hostIdentity(
  executableSha256 = sha256(QUALITY_HOST_BYTES),
  schemaRegistrySha256 = sha256(SCHEMA_REGISTRY_BYTES),
) {
  return {
    executable_sha256: executableSha256,
    schema_registry_sha256: schemaRegistrySha256,
  };
}

function join() {
  return {
    baselineExecutionHost: hostIdentity("2".repeat(64)),
    candidate: candidate(),
    candidateManifestSha256: "9".repeat(64),
    executionHost: hostIdentity(),
    measuredEvidenceSha256: "a".repeat(64),
  };
}

function samples() {
  return [
    ["sample-zh", "zh", "clean", "tier-1", 160, "b", "c", "sensitive-zh-reference"],
    ["sample-ja", "ja", "noise", "tier-1", 320, "d", "e", "sensitive-ja-reference"],
    ["sample-en", "en", "clean", "tier-1", 480, "f", "1", "sensitive-en-reference"],
  ].map(([sampleId, language, scenario, tier, durationSamples, wavDigit, referenceDigit, referenceText]) => ({
    consentBytes: Buffer.from("sensitive-consent-body", "utf8"),
    durationSamples,
    language,
    leakageGroupId: `LG-${sampleId}`,
    licenseBytes: Buffer.from("sensitive-rights-body", "utf8"),
    pcmSha256: `${wavDigit}`.repeat(64),
    referencePath: `C:\\private\\${sampleId}.txt`,
    referenceSha256: `${referenceDigit}`.repeat(64),
    referenceText,
    sampleId,
    sampleRateHz: 16_000,
    scenario,
    split: "blind",
    tier,
    wavBytes: Buffer.alloc(44 + durationSamples * 2),
    wavPath: `C:\\private\\${sampleId}.wav`,
    wavSha256: `${wavDigit}`.repeat(64),
    wavSizeBytes: 44 + durationSamples * 2,
  })).sort((left, right) => left.sampleId < right.sampleId ? -1 : left.sampleId > right.sampleId ? 1 : 0);
}

function corpus() {
  return {
    manifestSha256: "b".repeat(64),
    publicProjection: {
      corpus_id: "corpus-v1",
      languages: ["en", "ja", "zh"],
      manifest_sha256: "b".repeat(64),
      sample_count: 3,
      scenario_counts: { clean: 2, noise: 1 },
      split_counts: { blind: 3 },
      tier_counts: { "tier-1": 3 },
    },
    samples: samples(),
    snapshotSha256: "c".repeat(64),
    validationDate: "2026-07-16",
  };
}

function sampleIdentitySha(sample) {
  return sha256(Buffer.from(JSON.stringify({
    language: sample.language,
    pcm_sha256: sample.pcmSha256,
    reference_sha256: sample.referenceSha256,
    sample_id: sample.sampleId,
    wav_sha256: sample.wavSha256,
    wav_size_bytes: sample.wavSizeBytes,
  }), "utf8"));
}

function hostRecord(sample, index, drift = {}) {
  const execute = String(1_000_000 + index);
  return {
    authority: { formal_claims: "none", production_evidence: false },
    candidate: candidate(sample.language),
    execution: {
      backend_execute_calls: 1,
      execute_elapsed_ns: execute,
      final_transcript_sha256: `${index + 2}`.repeat(64),
      final_transcript_utf8_bytes: String(10 + index),
      fresh_process_per_sample: true,
      prepare_elapsed_ns: String(500_000 + index),
    },
    host: hostIdentity(),
    kind: "meetingrelay-native-candidate-quality-sample-v1",
    resources: {
      cpu_time_ns: null,
      gpu_time_ns: null,
      peak_ram_bytes: null,
      peak_vram_bytes: null,
      reason: "SHERPA_QUALITY_RESOURCE_SAMPLING_UNAVAILABLE",
      status: "unavailable",
    },
    rtf: {
      denominator_audio_ns: String(sample.durationSamples * 62_500),
      numerator_execute_ns: execute,
    },
    sample: {
      channels: 1,
      language: sample.language,
      pcm_bytes: String(sample.durationSamples * 2),
      pcm_sample_count: String(sample.durationSamples),
      pcm_sha256: sample.pcmSha256,
      reference_sha256: sample.referenceSha256,
      sample_id: sample.sampleId,
      sample_identity_sha256: sampleIdentitySha(sample),
      sample_rate_hz: 16_000,
      wav_sha256: sample.wavSha256,
      wav_size_bytes: String(sample.wavSizeBytes),
    },
    schema_version: "1.0",
    ...drift,
  };
}

function input(outputEvidencePath) {
  return {
    assetLockPath: "C:\\sealed\\assets.lock.json",
    corpusInput: { opaque: "external-corpus-loader-input" },
    executablePath: path.join(path.dirname(outputEvidencePath), "quality-host.exe"),
    modelPath: "C:\\sealed\\model.onnx",
    outputEvidencePath,
    packageLockPath: "C:\\sealed\\Cargo.lock",
    runtimeLibDir: "C:\\sealed\\runtime",
    schemaRegistryPath: path.join(path.dirname(outputEvidencePath), "schema-registry.json"),
    tokensPath: "C:\\sealed\\tokens.txt",
  };
}

async function tempOutput(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "meetingrelay-component-evidence-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(path.join(root, "quality-host.exe"), QUALITY_HOST_BYTES);
  await writeFile(path.join(root, "schema-registry.json"), SCHEMA_REGISTRY_BYTES);
  return { output: path.join(root, "evidence.json"), root };
}

async function expectCode(operation, code) {
  await assert.rejects(operation, (error) =>
    error instanceof NativeCandidateComponentEvidenceError && error.code === code
  );
}

test("supervisor preserves manifest order, exact 13 argv, and one backend call per sample", async (t) => {
  const { output } = await tempOutput(t);
  const expectedCorpus = corpus();
  const calls = [];
  let corpusLoads = 0;
  let joinLoads = 0;
  const result = await __runNativeCandidateComponentEvidenceForTest(input(output), {
    candidateJoinLoader: async () => { joinLoads += 1; return join(); },
    corpusLoader: async () => { corpusLoads += 1; return expectedCorpus; },
    sampleRunner: async ({ argv, executablePath, sample }) => {
      calls.push({ argv, executablePath, sampleId: sample.sampleId });
      return Buffer.from(encodeCanonicalJsonLine(hostRecord(sample, calls.length)), "utf8");
    },
  });
  assert.equal(result.evidenceSha256, sha256(await readFile(output)));
  assert.deepEqual(calls.map((call) => call.sampleId), ["sample-en", "sample-ja", "sample-zh"]);
  for (const [index, call] of calls.entries()) {
    const sample = expectedCorpus.samples[index];
    assert.equal(call.executablePath, input(output).executablePath);
    assert.deepEqual(call.argv, [
      input(output).schemaRegistryPath,
      "C:\\sealed\\model.onnx",
      "C:\\sealed\\tokens.txt",
      "C:\\sealed\\runtime",
      "C:\\sealed\\assets.lock.json",
      "C:\\sealed\\Cargo.lock",
      sample.sampleId,
      sample.language,
      sample.wavPath,
      String(sample.wavSizeBytes),
      sample.wavSha256,
      sample.pcmSha256,
      sample.referenceSha256,
    ]);
  }
  assert.equal(corpusLoads, 4);
  assert.equal(joinLoads, 4);
  assert.equal(result.record.results.length, 3);
  assert.deepEqual(result.record.results.map(({ attempt, sequence }) => ({ attempt, sequence })), [
    { attempt: 1, sequence: 1 },
    { attempt: 1, sequence: 2 },
    { attempt: 1, sequence: 3 },
  ]);
  const reordered = structuredClone(result.record);
  reordered.results.reverse();
  reordered.results.forEach((entry, index) => { entry.sequence = index + 1; });
  assert.throws(
    () => validateNativeCandidateComponentEvidenceRecord(Buffer.from(encodeCanonicalJsonLine(reordered), "utf8")),
    (error) => error instanceof NativeCandidateComponentEvidenceError && error.code === "COMPONENT_EVIDENCE_RESULT",
  );
  const persisted = await readFile(output, "utf8");
  for (const forbidden of ["sensitive-", "C:\\private", "\"transcript\":", "consent", "source_url", "device_serial", "wavPath", "referencePath"]) {
    assert.equal(persisted.includes(forbidden), false, forbidden);
  }
  assert.deepEqual(result.record.assessment_status, {
    default_status: "not-authorized",
    parent_closeout_status: "not-assessed",
    quality_status: "not-assessed",
    ranking_status: "not-authorized",
    selection_status: "not-authorized",
    threshold_status: "not-frozen",
  });
});

test("run input paths are absolute normalized NFC and the spawned path is the hashed path", async (t) => {
  const { output } = await tempOutput(t);
  let dependencyCalls = 0;
  for (const invalidInput of [
    { ...input(output), executablePath: "relative-quality-host.exe" },
    { ...input(output), modelPath: "C:\\sealed\\e\u0301.onnx" },
    { ...input(output), runtimeLibDir: "\\\\?\\C:\\sealed\\runtime" },
    { ...input(output), tokensPath: "\\\\server\\share\\tokens.txt" },
    { ...input(output), modelPath: "C:\\sealed\\model.onnx:stream" },
  ]) {
    await expectCode(__runNativeCandidateComponentEvidenceForTest(invalidInput, {
      candidateJoinLoader: async () => { dependencyCalls += 1; return join(); },
      corpusLoader: async () => { dependencyCalls += 1; return corpus(); },
      sampleRunner: async () => { dependencyCalls += 1; return Buffer.alloc(0); },
    }), "COMPONENT_RUN_INPUT");
  }
  assert.equal(dependencyCalls, 0);
});

test("host record validator joins sample, candidate, host, integer elapsed and exact RTF", async (t) => {
  const mutations = [
    ["COMPONENT_HOST_FIELDS", (record) => { record.transcript = "leak"; }],
    ["COMPONENT_HOST_AUTHORITY", (record) => { record.authority.production_evidence = true; }],
    ["COMPONENT_HOST_CANDIDATE_JOIN", (record) => { record.candidate.model_sha256 = "f".repeat(64); }],
    ["COMPONENT_HOST_IDENTITY_JOIN", (record) => { record.host.executable_sha256 = "f".repeat(64); }],
    ["COMPONENT_HOST_EXECUTION", (record) => { record.execution.backend_execute_calls = 2; }],
    ["COMPONENT_HOST_EXECUTION", (record) => { record.execution.execute_elapsed_ns = "01"; }],
    ["COMPONENT_HOST_EXECUTION", (record) => { record.execution.execute_elapsed_ns = "18446744073709551616"; }],
    ["COMPONENT_HOST_SAMPLE_JOIN", (record) => { record.sample.language = record.sample.language === "en" ? "zh" : "en"; }],
    ["COMPONENT_HOST_SAMPLE_JOIN", (record) => { record.sample.sample_identity_sha256 = "f".repeat(64); }],
    ["COMPONENT_HOST_RTF", (record) => { record.rtf.denominator_audio_ns = "1"; }],
    ["COMPONENT_HOST_RTF", (record) => { record.rtf.numerator_execute_ns = "2"; }],
    ["COMPONENT_HOST_RESOURCES", (record) => { record.resources.peak_ram_bytes = "1"; }],
  ];
  for (const [code, mutate] of mutations) {
    const { output } = await tempOutput(t);
    const sample = corpus().samples[0];
    const record = hostRecord(sample, 1);
    mutate(record);
    let calls = 0;
    await expectCode(__runNativeCandidateComponentEvidenceForTest(input(output), {
      candidateJoinLoader: async () => join(),
      corpusLoader: async () => ({ ...corpus(), samples: [sample], publicProjection: { ...corpus().publicProjection, sample_count: 1 } }),
      sampleRunner: async () => { calls += 1; return Buffer.from(encodeCanonicalJsonLine(record), "utf8"); },
    }), code);
    assert.equal(calls, 1, code);
    await assert.rejects(readFile(output), { code: "ENOENT" });
  }
});

test("injected corpora cannot exceed the Rust host 64 MiB WAV boundary", async (t) => {
  const { output } = await tempOutput(t);
  const oversized = { ...corpus(), samples: [{
    ...corpus().samples[0],
    durationSamples: 33_554_411,
    wavSizeBytes: 67_108_866,
  }] };
  let runnerCalls = 0;
  await expectCode(__runNativeCandidateComponentEvidenceForTest(input(output), {
    candidateJoinLoader: async () => join(),
    corpusLoader: async () => oversized,
    sampleRunner: async () => { runnerCalls += 1; return Buffer.alloc(0); },
  }), "COMPONENT_CORPUS");
  assert.equal(runnerCalls, 0);
});

test("injected corpus order must remain canonical ASCII sample-id order", async (t) => {
  const { output } = await tempOutput(t);
  const reversed = { ...corpus(), samples: [...corpus().samples].reverse() };
  let runnerCalls = 0;
  await expectCode(__runNativeCandidateComponentEvidenceForTest(input(output), {
    candidateJoinLoader: async () => join(),
    corpusLoader: async () => reversed,
    sampleRunner: async () => { runnerCalls += 1; return Buffer.alloc(0); },
  }), "COMPONENT_CORPUS");
  assert.equal(runnerCalls, 0);
});

test("injected corpus cannot bypass the strict reference contract", async (t) => {
  for (const referenceText of ["", "e\u0301", "line\nbreak", "\ufeffreference", "embedded\0nul"]) {
    const { output } = await tempOutput(t);
    const one = { ...corpus().samples[0], referenceText };
    let runnerCalls = 0;
    await expectCode(__runNativeCandidateComponentEvidenceForTest(input(output), {
      candidateJoinLoader: async () => join(),
      corpusLoader: async () => ({ ...corpus(), samples: [one], publicProjection: { ...corpus().publicProjection, sample_count: 1 } }),
      sampleRunner: async () => { runnerCalls += 1; return Buffer.alloc(0); },
    }), "COMPONENT_CORPUS");
    assert.equal(runnerCalls, 0);
  }
});

test("injected corpus WAV paths must be canonical local absolute paths", async (t) => {
  for (const wavPath of ["relative.wav", "\\\\server\\share\\sample.wav", "\\\\?\\C:\\private\\sample.wav", "C:\\private\\sample.wav:stream"]) {
    const { output } = await tempOutput(t);
    const one = { ...corpus().samples[0], wavPath };
    let runnerCalls = 0;
    await expectCode(__runNativeCandidateComponentEvidenceForTest(input(output), {
      candidateJoinLoader: async () => join(),
      corpusLoader: async () => ({ ...corpus(), samples: [one], publicProjection: { ...corpus().publicProjection, sample_count: 1 } }),
      sampleRunner: async () => { runnerCalls += 1; return Buffer.alloc(0); },
    }), "COMPONENT_CORPUS");
    assert.equal(runnerCalls, 0);
  }
});

test("quality-host and schema-registry bytes are independently verified around every spawn", async (t) => {
  {
    const { output } = await tempOutput(t);
    await writeFile(input(output).executablePath, "forged host\n", "utf8");
    let runnerCalls = 0;
    await expectCode(__runNativeCandidateComponentEvidenceForTest(input(output), {
      candidateJoinLoader: async () => join(),
      corpusLoader: async () => corpus(),
      sampleRunner: async () => { runnerCalls += 1; return Buffer.alloc(0); },
    }), "COMPONENT_EXECUTION_HOST_IDENTITY");
    assert.equal(runnerCalls, 0);
    await assert.rejects(readFile(output), { code: "ENOENT" });
  }
  {
    const { output } = await tempOutput(t);
    await writeFile(input(output).schemaRegistryPath, "forged schema registry\n", "utf8");
    let runnerCalls = 0;
    await expectCode(__runNativeCandidateComponentEvidenceForTest(input(output), {
      candidateJoinLoader: async () => join(),
      corpusLoader: async () => corpus(),
      sampleRunner: async () => { runnerCalls += 1; return Buffer.alloc(0); },
    }), "COMPONENT_SCHEMA_REGISTRY_IDENTITY");
    assert.equal(runnerCalls, 0);
    await assert.rejects(readFile(output), { code: "ENOENT" });
  }
  {
    const { output } = await tempOutput(t);
    const one = corpus().samples[0];
    await expectCode(__runNativeCandidateComponentEvidenceForTest(input(output), {
      candidateJoinLoader: async () => join(),
      corpusLoader: async () => ({ ...corpus(), samples: [one], publicProjection: { ...corpus().publicProjection, sample_count: 1 } }),
      sampleRunner: async ({ sample }) => {
        await writeFile(input(output).schemaRegistryPath, "replaced schema after spawn\n", "utf8");
        return Buffer.from(encodeCanonicalJsonLine(hostRecord(sample, 1)), "utf8");
      },
    }), "COMPONENT_SCHEMA_REGISTRY_POSTFLIGHT");
    await assert.rejects(readFile(output), { code: "ENOENT" });
  }
  {
    const { output } = await tempOutput(t);
    const one = corpus().samples[0];
    await expectCode(__runNativeCandidateComponentEvidenceForTest(input(output), {
      candidateJoinLoader: async () => join(),
      corpusLoader: async () => ({ ...corpus(), samples: [one], publicProjection: { ...corpus().publicProjection, sample_count: 1 } }),
      sampleRunner: async ({ sample }) => {
        await writeFile(input(output).executablePath, "replaced after spawn\n", "utf8");
        return Buffer.from(encodeCanonicalJsonLine(hostRecord(sample, 1)), "utf8");
      },
    }), "COMPONENT_EXECUTION_HOST_POSTFLIGHT");
    await assert.rejects(readFile(output), { code: "ENOENT" });
  }
});

test("corpus and candidate/measured-evidence drift fail postflight before publication", async (t) => {
  for (const lane of ["corpus", "candidate"]) {
    const { output } = await tempOutput(t);
    let corpusLoads = 0;
    let joinLoads = 0;
    const oneSampleCorpus = { ...corpus(), samples: [corpus().samples[0]], publicProjection: { ...corpus().publicProjection, sample_count: 1 } };
    await expectCode(__runNativeCandidateComponentEvidenceForTest(input(output), {
      candidateJoinLoader: async () => {
        joinLoads += 1;
        return lane === "candidate" && joinLoads > 1 ? { ...join(), measuredEvidenceSha256: "f".repeat(64) } : join();
      },
      corpusLoader: async () => {
        corpusLoads += 1;
        return lane === "corpus" && corpusLoads > 1 ? { ...oneSampleCorpus, snapshotSha256: "f".repeat(64) } : oneSampleCorpus;
      },
      sampleRunner: async ({ sample }) => Buffer.from(encodeCanonicalJsonLine(hostRecord(sample, 1)), "utf8"),
    }), lane === "candidate" ? "COMPONENT_CANDIDATE_POSTFLIGHT" : "COMPONENT_CORPUS_POSTFLIGHT");
    await assert.rejects(readFile(output), { code: "ENOENT" });
  }
});

test("strict evidence validator prevents every authority promotion", () => {
  const evidence = {
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
      baseline_execution_host: hostIdentity("2".repeat(64)),
      candidate_manifest_sha256: "9".repeat(64),
      measured_evidence_sha256: "a".repeat(64),
      parameter_sha256_by_language: { ...PARAMETER_SHA256_BY_LANGUAGE },
    },
    corpus_identity: { manifest_sha256: "b".repeat(64), sample_count: 1, snapshot_sha256: "c".repeat(64), validation_date: "2026-07-16" },
    execution_host_identity: hostIdentity(),
    kind: "meetingrelay-native-candidate-component-evidence-v1",
    limitations: [
      "synthetic-contract-foundation-does-not-assess-model-quality",
      "native-hypothesis-content-not-collected-or-scored",
      "candidate-source-and-hardware-artifacts-not-directly-materialized",
      "resource-sampling-unavailable",
      "publication-retains-auditable-create-new-staging-residue",
      "spawn-path-toctou-not-eliminated-by-node-supervisor",
      "thresholds-not-frozen",
      "ranking-selection-default-and-parent-closeout-not-authorized",
    ],
    results: [{
      attempt: 1,
      candidate_parameter_sha256: PARAMETER_SHA256_BY_LANGUAGE.zh,
      execute_elapsed_ns: "1000001",
      final_transcript_sha256: "3".repeat(64),
      final_transcript_utf8_bytes: "11",
      host_record_sha256: "4".repeat(64),
      language: "zh",
      prepare_elapsed_ns: "500001",
      resources: { reason: "SHERPA_QUALITY_RESOURCE_SAMPLING_UNAVAILABLE", status: "unavailable" },
      rtf: { denominator_audio_ns: "10000000", numerator_execute_ns: "1000001" },
      sample_id: "sample-zh",
      sample_identity_sha256: sampleIdentitySha(corpus().samples.find((sample) => sample.language === "zh")),
      scenario: "clean",
      sequence: 1,
      split: "blind",
      tier: "tier-1",
    }],
    schema_version: "1.0",
  };
  assert.doesNotThrow(() => validateNativeCandidateComponentEvidenceRecord(Buffer.from(encodeCanonicalJsonLine(evidence), "utf8")));
  for (const mutate of [
    (record) => { record.results[0].attempt = 2; },
    (record) => { record.results[0].sequence = 2; },
    (record) => { record.results[0].prepare_elapsed_ns = "18446744073709551616"; },
  ]) {
    const reordered = structuredClone(evidence);
    mutate(reordered);
    assert.throws(
      () => validateNativeCandidateComponentEvidenceRecord(Buffer.from(encodeCanonicalJsonLine(reordered), "utf8")),
      (error) => error instanceof NativeCandidateComponentEvidenceError && error.code === "COMPONENT_EVIDENCE_RESULT",
    );
  }
  for (const mutate of [
    (record) => { record.authority.formal_claims = "PERF-001"; },
    (record) => { record.authority.production_evidence = true; },
    (record) => { record.assessment_status.quality_status = "passed"; },
    (record) => { record.assessment_status.threshold_status = "frozen"; },
    (record) => { record.assessment_status.ranking_status = "ranked"; },
    (record) => { record.assessment_status.selection_status = "selected"; },
    (record) => { record.assessment_status.default_status = "authorized"; },
    (record) => { record.assessment_status.parent_closeout_status = "passed"; },
  ]) {
    const promoted = structuredClone(evidence);
    mutate(promoted);
    assert.throws(
      () => validateNativeCandidateComponentEvidenceRecord(Buffer.from(encodeCanonicalJsonLine(promoted), "utf8")),
      (error) => error instanceof NativeCandidateComponentEvidenceError,
    );
  }
});

test("publication is atomic create-new and preserves an existing competitor", async (t) => {
  const { output, root } = await tempOutput(t);
  const bytes = Buffer.from(encodeCanonicalJsonLine({ bad: "record" }), "utf8");
  await assert.rejects(publishNativeCandidateComponentEvidence(output, bytes), (error) => error instanceof NativeCandidateComponentEvidenceError);
  await assert.rejects(readFile(output), { code: "ENOENT" });

  const one = corpus().samples[0];
  const validOutput = path.join(root, "first.json");
  await __runNativeCandidateComponentEvidenceForTest(input(validOutput), {
    candidateJoinLoader: async () => join(),
    corpusLoader: async () => ({ ...corpus(), samples: [one], publicProjection: { ...corpus().publicProjection, sample_count: 1 } }),
    sampleRunner: async () => Buffer.from(encodeCanonicalJsonLine(hostRecord(one, 1)), "utf8"),
  });
  const validBytes = await readFile(validOutput);
  await writeFile(output, "competitor\n", "utf8");
  await expectCode(publishNativeCandidateComponentEvidence(output, validBytes), "COMPONENT_EVIDENCE_OUTPUT");
  assert.equal(await readFile(output, "utf8"), "competitor\n");
  const postLinkFailure = path.join(root, "post-link-failure.json");
  let reads = 0;
  await expectCode(publishNativeCandidateComponentEvidence(postLinkFailure, validBytes, {
    readFileBytes: async (filePath) => {
      reads += 1;
      if (reads === 2) throw new Error("injected post-link read failure");
      return readFile(filePath);
    },
  }), "COMPONENT_EVIDENCE_OUTPUT");
  assert.equal((await readFile(postLinkFailure)).equals(validBytes), true);
  const ambiguousLinkFailure = path.join(root, "ambiguous-link-failure.json");
  await expectCode(publishNativeCandidateComponentEvidence(ambiguousLinkFailure, validBytes, {
    linkFile: async (stagingPath, outputPath) => {
      await link(stagingPath, outputPath);
      throw new Error("injected error after successful link");
    },
  }), "COMPONENT_EVIDENCE_OUTPUT");
  assert.equal((await readFile(ambiguousLinkFailure)).equals(validBytes), true);
  assert.equal((await readdir(root)).filter((name) => name.endsWith(".staging")).length, 3);
});

test("successful component publication never path-unlinks staging", async (t) => {
  const { root } = await tempOutput(t);
  const one = corpus().samples[0];
  const source = path.join(root, "source.json");
  await __runNativeCandidateComponentEvidenceForTest(input(source), {
    candidateJoinLoader: async () => join(),
    corpusLoader: async () => ({ ...corpus(), samples: [one], publicProjection: { ...corpus().publicProjection, sample_count: 1 } }),
    sampleRunner: async () => Buffer.from(encodeCanonicalJsonLine(hostRecord(one, 1)), "utf8"),
  });
  const bytes = await readFile(source);
  const output = path.join(root, "retained.json");
  let unlinkCalls = 0;
  await publishNativeCandidateComponentEvidence(output, bytes, {
    unlinkFile: async () => { unlinkCalls += 1; },
  });
  assert.equal(unlinkCalls, 0);
  const retained = (await readdir(root)).filter((name) => name.startsWith(".retained.json.") && name.endsWith(".staging"));
  assert.equal(retained.length, 1);
  assert.deepEqual(await readFile(path.join(root, retained[0])), bytes);
});

test("publication rejects valid target replacement and never removes the competitor", async (t) => {
  const { root } = await tempOutput(t);
  const one = corpus().samples[0];
  const source = path.join(root, "source.json");
  await __runNativeCandidateComponentEvidenceForTest(input(source), {
    candidateJoinLoader: async () => join(),
    corpusLoader: async () => ({ ...corpus(), samples: [one], publicProjection: { ...corpus().publicProjection, sample_count: 1 } }),
    sampleRunner: async () => Buffer.from(encodeCanonicalJsonLine(hostRecord(one, 1)), "utf8"),
  });
  const originalBytes = await readFile(source);
  const competitor = JSON.parse(originalBytes.toString("utf8"));
  competitor.corpus_identity.snapshot_sha256 = "d".repeat(64);
  const competitorBytes = Buffer.from(encodeCanonicalJsonLine(competitor), "utf8");
  assert.doesNotThrow(() => validateNativeCandidateComponentEvidenceRecord(competitorBytes));

  for (const hookName of ["afterLinkBeforeRead", "afterPersistedRead"]) {
    const output = path.join(root, `${hookName}.json`);
    await expectCode(publishNativeCandidateComponentEvidence(output, originalBytes, {
      [hookName]: async ({ outputPath }) => {
        await rm(outputPath, { force: true });
        await writeFile(outputPath, competitorBytes);
      },
    }), "COMPONENT_EVIDENCE_OUTPUT");
    assert.equal((await readFile(output)).equals(competitorBytes), true, hookName);
    for (const name of (await readdir(root)).filter((name) => name.endsWith(".staging"))) {
      await rm(path.join(root, name), { force: true });
    }
  }
  const stagingReplacementOutput = path.join(root, "staging-replacement.json");
  let competitorStagingPath;
  await expectCode(publishNativeCandidateComponentEvidence(stagingReplacementOutput, originalBytes, {
    afterLinkBeforeRead: async ({ stagingPath }) => {
      competitorStagingPath = stagingPath;
      await rm(stagingPath, { force: true });
      await writeFile(stagingPath, competitorBytes);
    },
  }), "COMPONENT_EVIDENCE_OUTPUT");
  assert.equal((await readFile(stagingReplacementOutput)).equals(originalBytes), true);
  assert.equal((await readFile(competitorStagingPath)).equals(competitorBytes), true);
  await rm(competitorStagingPath, { force: true });
  await rm(stagingReplacementOutput, { force: true });
  assert.deepEqual((await readdir(root)).filter((name) => name.endsWith(".staging")), []);
});

test("publication binds the output parent inode and fails closed on parent replacement", async (t) => {
  const { root } = await tempOutput(t);
  const one = corpus().samples[0];
  const source = path.join(root, "parent-source.json");
  await __runNativeCandidateComponentEvidenceForTest(input(source), {
    candidateJoinLoader: async () => join(),
    corpusLoader: async () => ({ ...corpus(), samples: [one], publicProjection: { ...corpus().publicProjection, sample_count: 1 } }),
    sampleRunner: async () => Buffer.from(encodeCanonicalJsonLine(hostRecord(one, 1)), "utf8"),
  });
  const bytes = await readFile(source);
  const parent = path.join(root, "publication-parent");
  const movedParent = path.join(root, "publication-parent-moved");
  await mkdir(parent);
  const output = path.join(parent, "evidence.json");
  await expectCode(publishNativeCandidateComponentEvidence(output, bytes, {
    beforeLink: async () => {
      await rename(parent, movedParent);
      await mkdir(parent);
    },
  }), "COMPONENT_EVIDENCE_OUTPUT");
  await assert.rejects(readFile(output), { code: "ENOENT" });
});

test("run postflight rejects a different valid record installed after publication", async (t) => {
  const { output } = await tempOutput(t);
  const one = corpus().samples[0];
  await expectCode(__runNativeCandidateComponentEvidenceForTest(input(output), {
    candidateJoinLoader: async () => join(),
    corpusLoader: async () => ({ ...corpus(), samples: [one], publicProjection: { ...corpus().publicProjection, sample_count: 1 } }),
    publishEvidence: async (outputPath, expectedBytes) => {
      await publishNativeCandidateComponentEvidence(outputPath, expectedBytes);
      const competitor = JSON.parse(expectedBytes.toString("utf8"));
      competitor.corpus_identity.snapshot_sha256 = "d".repeat(64);
      const competitorBytes = Buffer.from(encodeCanonicalJsonLine(competitor), "utf8");
      await rm(outputPath, { force: true });
      await writeFile(outputPath, competitorBytes);
    },
    sampleRunner: async () => Buffer.from(encodeCanonicalJsonLine(hostRecord(one, 1)), "utf8"),
  }), "COMPONENT_EVIDENCE_PERSISTED");
});

test("schema, package, CI, and README expose test+validate only with synthetic contract authority", async () => {
  const [schema, packageJson, workflow, readme] = await Promise.all([
    readFile(path.join(HERE, "native-candidate-component-evidence.schema.json"), "utf8").then(JSON.parse),
    readFile(path.join(REPO_ROOT, "package.json"), "utf8").then(JSON.parse),
    readFile(path.join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8"),
    readFile(path.join(HERE, "README.md"), "utf8"),
  ]);
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.authority.properties.formal_claims.const, "none");
  assert.equal(schema.properties.authority.properties.production_evidence.const, false);
  assert.equal(schema.properties.assessment_status.properties.quality_status.const, "not-assessed");
  assert.equal(schema.properties.assessment_status.properties.threshold_status.const, "not-frozen");
  assert.equal(schema.properties.assessment_status.properties.parent_closeout_status.const, "not-assessed");
  assert.equal(schema.properties.corpus_identity.required.includes("validation_date"), true);
  assert.equal(schema.$defs.result.required.includes("attempt"), true);
  assert.equal(schema.$defs.result.required.includes("sequence"), true);
  assert.equal(schema.properties.limitations.minItems, 8);
  const digestPattern = new RegExp(schema.$defs.digest.pattern, "u");
  assert.equal(digestPattern.test("0".repeat(64)), false);
  assert.equal(digestPattern.test("a".repeat(64)), true);
  assert.equal(schema.$defs.decimal.maxLength, 20);
  const decimalPattern = new RegExp(schema.$defs.decimal.pattern, "u");
  assert.equal(decimalPattern.test("18446744073709551615"), true);
  assert.equal(decimalPattern.test("18446744073709551616"), false);
  assert.equal(decimalPattern.test("99999999999999999999"), false);
  assert.equal(packageJson.scripts["phase0:sherpa-quality-foundation:test"], "node --test tools/sherpa-native/quality-corpus.test.mjs tools/sherpa-native/asr-error-rate.test.mjs tools/sherpa-native/controlled-hypothesis-ledger.test.mjs tools/sherpa-native/native-candidate-component-evidence.test.mjs");
  assert.equal(packageJson.scripts["phase0:sherpa-quality-foundation:validate"], "node tools/sherpa-native/native-candidate-component-evidence.mjs --validate");
  assert.equal(packageJson.scripts["phase0:sherpa-quality-foundation:run"], undefined);
  assert.match(workflow, /Test WP-0\.4 rights-aware quality foundation \(synthetic contract only\)/u);
  assert.match(workflow, /pnpm phase0:sherpa-quality-foundation:test/u);
  assert.equal(workflow.includes("phase0:sherpa-quality-foundation:run"), false);
  assert.match(readme, /rights-aware multi-utterance corpus/iu);
  assert.match(readme, /controlled-hypothesis-ledger\.mjs/u);
  assert.match(readme, /not published as an independently sealed file/u);
  assert.match(readme, /validation_date/u);
  assert.match(readme, /formal_claims=none/u);
  assert.match(readme, /synthetic non-speech/u);
});

test("validation CLI accepts one strict record and rejects run-shaped arguments", async (t) => {
  const { output } = await tempOutput(t);
  const one = corpus().samples[0];
  await __runNativeCandidateComponentEvidenceForTest(input(output), {
    candidateJoinLoader: async () => join(),
    corpusLoader: async () => ({ ...corpus(), samples: [one], publicProjection: { ...corpus().publicProjection, sample_count: 1 } }),
    sampleRunner: async () => Buffer.from(encodeCanonicalJsonLine(hostRecord(one, 1)), "utf8"),
  });
  const accepted = await execFileAsync(process.execPath, [path.join(HERE, "native-candidate-component-evidence.mjs"), "--validate", output], { encoding: "utf8", windowsHide: true });
  assert.match(accepted.stdout, /^candidate-native-component-evidence-file=verified evidence_sha256=[0-9a-f]{64} samples=1 formal_claims=none production_evidence=false quality_status=not-assessed threshold_status=not-frozen$/mu);
  await assert.rejects(
    execFileAsync(process.execPath, [path.join(HERE, "native-candidate-component-evidence.mjs"), "--run", output], { encoding: "utf8", windowsHide: true }),
  );
});
