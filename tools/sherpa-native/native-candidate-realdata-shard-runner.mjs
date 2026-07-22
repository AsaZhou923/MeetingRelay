import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { link, lstat, open, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

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
import { readPinnedFleursGoldSourcePolicy } from "./fleurs-gold-source.mjs";
import {
  attestFormalRunControlledRootIdentity,
  validateFormalRunReadinessEnvelopeBytes,
} from "./formal-run-trust-envelope.mjs";
import { validateFleursMaterializedPublicEvidenceBytes } from "./fleurs-materialized-corpus.mjs";
import { materializeQualityCorpus } from "./quality-corpus.mjs";
import { readPinnedQualityShardHostSourceBuildAttestation } from "./quality-shard-host-source-build-attestor.mjs";

const KIND = "meetingrelay-native-candidate-realdata-shard-evidence-v1";
const POLICY_KIND = "meetingrelay-native-candidate-realdata-shard-policy-v1";
const REQUEST_KIND = "meetingrelay-native-candidate-realdata-shard-request-v1";
const RESPONSE_KIND = "meetingrelay-native-candidate-quality-shard-response-v1";
const POLICY_SCHEMA_VERSION = "1.0";
const RESPONSE_SCHEMA_VERSION = "1.0";
const EVIDENCE_SCHEMA_VERSION = "1.1";
const CANDIDATE_IDENTITY_SET_KIND = "meetingrelay-native-candidate-quality-shard-candidate-identity-set-v1";
const CANDIDATE_IDENTITY_SET_SCHEMA_VERSION = "1.0";
const SAMPLE_COUNT = 960;
const DIGEST = /^(?!0{64}$)[0-9a-f]{64}$/u;
const COMMIT = /^(?!0{40}$)[0-9a-f]{40}$/u;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const MAX_TRANSCRIPT_BYTES = 16_384;
const AUTHORITY = Object.freeze({
  formal_claims: "none",
  production_evidence: false,
  public_distribution: false,
});
const ROOT_KEYS = Object.freeze([
  "aggregate",
  "authority",
  "clock",
  "corpus_identity",
  "execution",
  "host_identity",
  "kind",
  "ledger_identity",
  "measurement_status",
  "policy_identity",
  "quality_gate_status",
  "readiness_identity",
  "resource_observations",
  "schema_version",
  "scorer_identity",
  "source_identity",
]);

export class NativeCandidateRealdataShardRunnerError extends Error {
  constructor(code, options = {}) {
    super(code, options);
    this.name = "NativeCandidateRealdataShardRunnerError";
    this.code = code;
  }
}

function fail(code, options = {}) {
  throw new NativeCandidateRealdataShardRunnerError(code, options);
}

function wrap(code, error) {
  if (error instanceof NativeCandidateRealdataShardRunnerError) throw error;
  fail(code, { cause: error });
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function exactKeys(value, expected, code) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(code);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(code);
  }
}

function assertDigest(value, code) {
  if (typeof value !== "string" || !DIGEST.test(value)) fail(code);
}

function assertCommit(value, code) {
  if (typeof value !== "string" || !COMMIT.test(value)) fail(code);
}

function assertIdentifier(value, code) {
  if (typeof value !== "string" || !IDENTIFIER.test(value) || value !== value.normalize("NFC")) fail(code);
}

function assertDecimal(value, code) {
  if (typeof value !== "string" || !DECIMAL.test(value) || value.length > 20) fail(code);
}

function formatUtcSecond(value, code = "REALDATA_CLOCK") {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) fail(code);
  const floored = new Date(Math.floor(value.getTime() / 1000) * 1000);
  const formatted = floored.toISOString().replace(".000Z", "Z");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(formatted)) fail(code);
  return formatted;
}

function assertAggregateDecimal(value, code) {
  if (typeof value !== "string" || !DECIMAL.test(value) || value.length > 1000) fail(code);
}

function gcd(left, right) {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) {
    const next = a % b;
    a = b;
    b = next;
  }
  return a;
}

function compareRates(left, right) {
  if (left.status !== "measured" || right.status !== "measured") fail("REALDATA_AGGREGATE");
  const leftScaled = BigInt(left.numerator) * BigInt(right.denominator);
  const rightScaled = BigInt(right.numerator) * BigInt(left.denominator);
  if (leftScaled < rightScaled) return -1;
  if (leftScaled > rightScaled) return 1;
  return 0;
}

function meanRates(rates) {
  if (rates.length === 0) return { denominator: "0", numerator: "0", status: "not-comparable" };
  let sum = { denominator: 1n, numerator: 0n };
  for (const rate of rates) {
    const denominator = BigInt(rate.denominator);
    const numerator = BigInt(rate.numerator);
    const divisor = gcd(sum.denominator, denominator);
    const leftScale = denominator / divisor;
    const rightScale = sum.denominator / divisor;
    sum = {
      denominator: sum.denominator * leftScale,
      numerator: sum.numerator * leftScale + numerator * rightScale,
    };
  }
  const denominator = sum.denominator * BigInt(rates.length);
  const divisor = gcd(sum.numerator, denominator);
  return {
    denominator: String(denominator / divisor),
    numerator: String(sum.numerator / divisor),
    status: "measured",
  };
}

function isCanonicalLocalAbsolutePath(value) {
  if (
    typeof value !== "string" || value.length === 0 || value.includes("\0") ||
    /^[\\/]{2}/u.test(value) || !path.isAbsolute(value) ||
    path.normalize(value) !== value || path.resolve(value) !== value ||
    value.normalize("NFC") !== value
  ) return false;
  return !value.slice(path.parse(value).root.length).includes(":");
}

function assertAbsolutePath(value, code) {
  if (!isCanonicalLocalAbsolutePath(value)) fail(code);
}

async function readStableFile(inputPath, code, maximum = MAX_JSON_BYTES) {
  assertAbsolutePath(inputPath, code);
  const root = path.parse(inputPath).root;
  let current = root;
  for (const [index, segment] of path.relative(root, inputPath).split(path.sep).filter(Boolean).entries()) {
    current = path.join(current, segment);
    const stat = await lstat(current, { bigint: true }).catch((error) => fail(code, { cause: error }));
    const final = index === path.relative(root, inputPath).split(path.sep).filter(Boolean).length - 1;
    if (stat.isSymbolicLink() || (!final && !stat.isDirectory()) || (final && !stat.isFile())) fail(code);
  }
  const before = await lstat(inputPath, { bigint: true }).catch((error) => fail(code, { cause: error }));
  const beforeRealpath = await realpath(inputPath).catch((error) => fail(code, { cause: error }));
  if (!before.isFile() || before.isSymbolicLink() || before.size < 1n || before.size > BigInt(maximum)) fail(code);
  const handle = await open(inputPath, "r").catch((error) => fail(code, { cause: error }));
  try {
    const opened = await handle.stat({ bigint: true });
    const first = await handle.readFile();
    const second = Buffer.alloc(first.length);
    let offset = 0;
    while (offset < second.length) {
      const { bytesRead } = await handle.read(second, offset, second.length - offset, offset);
      if (bytesRead <= 0) fail(code);
      offset += bytesRead;
    }
    const after = await lstat(inputPath, { bigint: true });
    const afterRealpath = await realpath(inputPath);
    if (
      !first.equals(second) || before.dev !== opened.dev || opened.dev !== after.dev ||
      before.ino !== opened.ino || opened.ino !== after.ino ||
      opened.size !== BigInt(first.length) || beforeRealpath !== afterRealpath
    ) fail(code);
    return first;
  } finally {
    await handle.close().catch(() => fail(code));
  }
}

function parseCanonicalLine(bytes, code) {
  if (
    !Buffer.isBuffer(bytes) || bytes.length < 2 || bytes.length > MAX_JSON_BYTES ||
    bytes.at(-1) !== 0x0a || bytes.subarray(0, -1).includes(0x0a) ||
    bytes.includes(0x0d)
  ) fail(code);
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) fail(code);
  let value;
  try { value = JSON.parse(text); } catch (error) { fail(code, { cause: error }); }
  if (encodeCanonicalJsonLine(value) !== text) fail(code);
  return value;
}

function validatePolicy(policy) {
  exactKeys(policy, ["authority", "canary", "execution", "kind", "schema_version"], "REALDATA_POLICY");
  if (
    policy.kind !== POLICY_KIND || policy.schema_version !== POLICY_SCHEMA_VERSION ||
    !isDeepStrictEqual(policy.authority, {
      formal_claims: "none",
      production_evidence: false,
      public_distribution: false,
      quality_gate_status: "not-assessed",
    })
  ) fail("REALDATA_POLICY");
  exactKeys(policy.execution, [
    "max_host_requests_per_shard", "max_scored_samples_per_shard", "sample_count", "shard_timeout_ms",
  ], "REALDATA_POLICY");
  if (
    policy.execution.sample_count !== SAMPLE_COUNT ||
    !Number.isSafeInteger(policy.execution.max_scored_samples_per_shard) ||
    policy.execution.max_scored_samples_per_shard < 1 ||
    policy.execution.max_scored_samples_per_shard > SAMPLE_COUNT ||
    !Number.isSafeInteger(policy.execution.max_host_requests_per_shard) ||
    policy.execution.max_host_requests_per_shard < policy.execution.max_scored_samples_per_shard ||
    policy.execution.max_host_requests_per_shard > SAMPLE_COUNT ||
    !Number.isSafeInteger(policy.execution.shard_timeout_ms) ||
    policy.execution.shard_timeout_ms < 1 ||
    policy.execution.shard_timeout_ms > 3_600_000
  ) fail("REALDATA_POLICY");
  exactKeys(policy.canary, ["cadence_samples", "sample_id"], "REALDATA_POLICY");
  assertIdentifier(policy.canary.sample_id, "REALDATA_POLICY");
  if (
    !Number.isSafeInteger(policy.canary.cadence_samples) ||
    policy.canary.cadence_samples < 1 ||
    policy.canary.cadence_samples > policy.execution.max_scored_samples_per_shard
  ) fail("REALDATA_POLICY");
  const expectedMaxHostRequests = policy.execution.max_scored_samples_per_shard +
    Math.max(1, Math.ceil(policy.execution.max_scored_samples_per_shard / policy.canary.cadence_samples));
  if (policy.execution.max_host_requests_per_shard !== expectedMaxHostRequests) fail("REALDATA_POLICY");
  return policy;
}

async function readPinnedPolicy(input) {
  assertDigest(input.expectedRealdataPolicySha256, "REALDATA_POLICY_TRUST_REQUIRED");
  const bytes = await readStableFile(input.policyPath, "REALDATA_POLICY_READ", 64 * 1024);
  if (sha256(bytes) !== input.expectedRealdataPolicySha256) fail("REALDATA_POLICY_DIGEST");
  return { bytes, policy: validatePolicy(parseCanonicalLine(bytes, "REALDATA_POLICY_CANONICAL")), sha256: sha256(bytes) };
}

function normalizeMaterializedCorpus(corpus) {
  if (
    corpus === null || typeof corpus !== "object" ||
    corpus.manifestSha256 === undefined ||
    corpus.snapshotSha256 === undefined ||
    !Array.isArray(corpus.samples)
  ) fail("REALDATA_CORPUS_SNAPSHOT");
  assertDigest(corpus.manifestSha256, "REALDATA_CORPUS_SNAPSHOT");
  assertDigest(corpus.snapshotSha256, "REALDATA_CORPUS_SNAPSHOT");
  if (corpus.samples.length !== SAMPLE_COUNT) fail("REALDATA_SAMPLE_COUNT");
  const normalized = corpus.samples.map((sample) => ({
    duration_samples: sample.durationSamples,
    language: sample.language,
    pcm_sha256: sample.pcmSha256,
    reference_sha256: sample.referenceSha256,
    reference_text: sample.referenceText,
    sample_id: sample.sampleId,
    scenario: sample.scenario,
    split: sample.split,
    tier: sample.tier,
    wav_path: sample.wavPath,
    wav_sha256: sample.wavSha256,
    wav_size_bytes: sample.wavSizeBytes,
  }));
  const seen = new Set();
  let previous;
  for (const [index, sample] of normalized.entries()) {
    assertIdentifier(sample.sample_id, "REALDATA_SAMPLE");
    if (seen.has(sample.sample_id) || (previous !== undefined && previous >= sample.sample_id)) {
      fail("REALDATA_SAMPLE_ORDER");
    }
    seen.add(sample.sample_id);
    previous = sample.sample_id;
    if (!["en", "ja", "zh"].includes(sample.language)) fail("REALDATA_SAMPLE");
    for (const key of ["pcm_sha256", "reference_sha256", "wav_sha256"]) assertDigest(sample[key], "REALDATA_SAMPLE");
    if (
      typeof sample.reference_text !== "string" ||
      sample.reference_text.length === 0 ||
      Buffer.byteLength(sample.reference_text, "utf8") > MAX_TRANSCRIPT_BYTES ||
      !isCanonicalLocalAbsolutePath(sample.wav_path) ||
      !Number.isSafeInteger(sample.duration_samples) ||
      sample.duration_samples < 1 ||
      !Number.isSafeInteger(sample.wav_size_bytes) ||
      sample.wav_size_bytes < 1
    ) fail("REALDATA_SAMPLE");
    if (index + 1 > SAMPLE_COUNT) fail("REALDATA_SAMPLE_COUNT");
  }
  return {
    materialization: {
      manifest_sha256: corpus.manifestSha256,
      sample_count: normalized.length,
      text_free_projection_sha256: corpus.publicProjection?.manifest_sha256 ?? corpus.manifestSha256,
    },
    samples: normalized,
    snapshot_sha256: corpus.snapshotSha256,
  };
}

async function readPinnedSnapshot(input) {
  const evidenceBytes = await readStableFile(input.materializationEvidencePath, "REALDATA_MATERIALIZATION_EVIDENCE_READ", 128 * 1024);
  if (sha256(evidenceBytes) !== input.expectedMaterializationEvidenceSha256) fail("REALDATA_MATERIALIZATION_EVIDENCE_DIGEST");
  const evidence = validateFleursMaterializedPublicEvidenceBytes(evidenceBytes);
  if (
    evidence.publicEvidence.corpus_manifest_sha256 !== input.expectedCorpusManifestSha256 ||
    evidence.publicEvidence.corpus_snapshot_sha256 !== input.expectedCorpusSnapshotSha256 ||
    evidence.publicEvidence.materialized_sample_count !== SAMPLE_COUNT ||
    evidence.publicEvidence.policy_sha256 !== input.expectedFleursPolicySha256
  ) fail("REALDATA_MATERIALIZATION_JOIN");
  const corpus = await materializeQualityCorpus({
    corpusRoot: input.materializedCorpusRoot,
    expectedManifestSha256: input.expectedCorpusManifestSha256,
    manifestPath: input.corpusManifestPath,
    validationDate: evidence.publicEvidence.validation_date,
  }).catch((error) => fail("REALDATA_CORPUS_READ", { cause: error }));
  const record = normalizeMaterializedCorpus(corpus);
  if (record.snapshot_sha256 !== input.expectedCorpusSnapshotSha256) fail("REALDATA_CORPUS_DIGEST");
  return { record, sha256: record.snapshot_sha256 };
}

function validateInput(input) {
  exactKeys(input, [
    "assetLockPath", "controlledRoot", "corpusManifestPath", "expectedAssetLockSha256",
    "expectedCorpusManifestSha256",
    "expectedCorpusSnapshotSha256", "expectedMaterializationEvidenceSha256",
    "expectedModelSha256", "expectedPackageLockSha256", "expectedRuntimeBundleSha256",
    "expectedSchemaRegistrySha256",
    "expectedCreateReceiptSha256", "expectedDeleteReceiptSha256", "expectedFleursPolicySha256",
    "expectedFormalPolicySha256", "expectedReadinessBuildAttestationSha256",
    "expectedReadinessSha256", "expectedScorerProfileSha256", "expectedTokensSha256",
    "expectedRealdataPolicySha256",
    "expectedShardHostBuildAttestationSha256", "expectedShardHostSha256", "expectedSourceCommit",
    "finalEvidencePath", "fleursPolicyPath", "ledgerRelativePath", "materializationEvidencePath",
    "materializedCorpusRoot", "modelPath", "packageLockPath", "policyPath",
    "readinessPath", "runtimeLibDir", "schemaRegistryPath", "scorerProfilePath", "sealRelativePath",
    "shardHostBuildAttestationPath", "shardHostPath", "tokensPath",
  ], "REALDATA_INPUT_FIELDS");
  for (const key of [
    "expectedAssetLockSha256", "expectedCorpusManifestSha256", "expectedCorpusSnapshotSha256",
    "expectedCreateReceiptSha256", "expectedDeleteReceiptSha256",
    "expectedFleursPolicySha256", "expectedFormalPolicySha256", "expectedReadinessSha256",
    "expectedMaterializationEvidenceSha256", "expectedModelSha256", "expectedPackageLockSha256",
    "expectedRealdataPolicySha256",
    "expectedReadinessBuildAttestationSha256", "expectedRuntimeBundleSha256",
    "expectedSchemaRegistrySha256", "expectedScorerProfileSha256", "expectedTokensSha256",
    "expectedShardHostBuildAttestationSha256", "expectedShardHostSha256",
  ]) assertDigest(input[key], "REALDATA_TRUST_ANCHOR");
  assertCommit(input.expectedSourceCommit, "REALDATA_SOURCE_COMMIT");
  for (const key of [
    "assetLockPath", "controlledRoot", "corpusManifestPath", "finalEvidencePath", "fleursPolicyPath",
    "materializationEvidencePath", "materializedCorpusRoot", "modelPath", "packageLockPath",
    "policyPath", "readinessPath", "runtimeLibDir", "schemaRegistryPath", "scorerProfilePath",
    "shardHostBuildAttestationPath", "shardHostPath", "tokensPath",
  ]) assertAbsolutePath(input[key], "REALDATA_PATH");
  if (input.ledgerRelativePath === input.sealRelativePath) fail("REALDATA_OUTPUT_OVERLAP");
  return input;
}

function rootIdentityFromReadiness(readiness) {
  return {
    file_id_128: readiness.record.controlled_root.file_id_128,
    volume_serial_number: readiness.record.controlled_root.volume_serial_number,
  };
}

function rootIdentityFromAttestation(attestation) {
  return {
    file_id_128: attestation.record.root.file_id_128,
    volume_serial_number: attestation.record.root.volume_serial_number,
  };
}

function assertControlledRootIdentity(readiness, liveRoot) {
  if (!isDeepStrictEqual(rootIdentityFromReadiness(readiness), rootIdentityFromAttestation(liveRoot))) {
    fail("REALDATA_CONTROLLED_ROOT_IDENTITY");
  }
}

function stableRootIdentityFromAttestation(attestation) {
  const root = attestation.record.root;
  return {
    dacl_protected: root.dacl_protected,
    drive_type: root.drive_type,
    file_id_128: root.file_id_128,
    filesystem: root.filesystem,
    operator_sid_sha256: root.operator_sid_sha256,
    owner_principal: root.owner_principal,
    reparse_tag: root.reparse_tag,
    retention_expires_at: root.retention_expires_at,
    root_path_sha256: root.root_path_sha256,
    security_descriptor_sha256: root.security_descriptor_sha256,
    volume_serial_number: root.volume_serial_number,
  };
}

async function assertStableDirectoryIdentity(inputPath, code) {
  assertAbsolutePath(inputPath, code);
  const before = await lstat(inputPath, { bigint: true }).catch((error) => fail(code, { cause: error }));
  const canonical = await realpath(inputPath).catch((error) => fail(code, { cause: error }));
  const after = await lstat(canonical, { bigint: true }).catch((error) => fail(code, { cause: error }));
  if (
    !before.isDirectory() || before.isSymbolicLink() ||
    !after.isDirectory() || after.isSymbolicLink() ||
    before.dev !== after.dev || before.ino !== after.ino ||
    canonical !== inputPath
  ) fail(code);
  return before;
}

async function assertMaterializedCorpusRootBound(input) {
  const snapshotId = path.basename(input.materializedCorpusRoot);
  assertIdentifier(snapshotId, "REALDATA_CORPUS_ROOT");
  if (
    path.dirname(input.materializedCorpusRoot) !== path.join(input.controlledRoot, "snapshots") ||
    input.materializedCorpusRoot !== path.join(input.controlledRoot, "snapshots", snapshotId) ||
    input.corpusManifestPath !== path.join(input.materializedCorpusRoot, "corpus-manifest.json") ||
    input.materializationEvidencePath !== path.join(input.materializedCorpusRoot, "materialization-public-evidence.json")
  ) fail("REALDATA_CORPUS_ROOT");
  await assertStableDirectoryIdentity(input.controlledRoot, "REALDATA_CONTROLLED_ROOT_IDENTITY");
  await assertStableDirectoryIdentity(path.join(input.controlledRoot, "snapshots"), "REALDATA_CORPUS_ROOT");
  await assertStableDirectoryIdentity(input.materializedCorpusRoot, "REALDATA_CORPUS_ROOT");
}

function partitionSamples(samples, maxShardSamples) {
  const shards = [];
  let current = [];
  for (const sample of samples) {
    if (
      current.length > 0 &&
      (current.length >= maxShardSamples || current[0].language !== sample.language)
    ) {
      shards.push(current);
      current = [];
    }
    current.push(sample);
  }
  if (current.length > 0) shards.push(current);
  for (const shard of shards) {
    if (new Set(shard.map((sample) => sample.language)).size !== 1) fail("REALDATA_SHARD_LANGUAGE");
  }
  return shards;
}

function sampleIdentitySha256(sample) {
  return sha256(Buffer.from(JSON.stringify({
    language: sample.language,
    pcm_sha256: sample.pcm_sha256,
    reference_sha256: sample.reference_sha256,
    sample_id: sample.sample_id,
    wav_sha256: sample.wav_sha256,
    wav_size_bytes: sample.wav_size_bytes,
  }), "utf8"));
}

function validateResource(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("REALDATA_RESOURCE");
  exactKeys(value, [
    "cpu_time_ns", "gpu_time_ns", "peak_ram_bytes", "peak_vram_bytes", "reason", "status",
  ], "REALDATA_RESOURCE");
  if (value.status === "unavailable" || value.status === "observed") {
    assertIdentifier(value.reason, "REALDATA_RESOURCE");
    for (const key of ["cpu_time_ns", "gpu_time_ns", "peak_ram_bytes", "peak_vram_bytes"]) {
      if (value[key] !== null) assertDecimal(value[key], "REALDATA_RESOURCE");
    }
    return value;
  }
  fail("REALDATA_RESOURCE");
}

function expectedResponseSampleIdentity(request, sample) {
  const expectedCanaryIdentity = request.is_canary
    ? sha256(Buffer.from(encodeCanonicalJsonLine({
        pcm_sha256: sample.pcm_sha256,
        reference_sha256: sample.reference_sha256,
        sample_id: sample.sample_id,
        wav_sha256: sample.wav_sha256,
      }), "utf8"))
    : "0".repeat(64);
  return {
    canary_identity_sha256: expectedCanaryIdentity,
    classification: request.is_canary ? "canary" : "sample",
    language: sample.language,
    pcm_sha256: sample.pcm_sha256,
    reference_sha256: sample.reference_sha256,
    sample_id: sample.sample_id,
    sample_identity_sha256: sampleIdentitySha256(sample),
    scored: !request.is_canary,
    wav_sha256: sample.wav_sha256,
    wav_size_bytes: String(sample.wav_size_bytes),
  };
}

function validateClock(value) {
  exactKeys(value, ["domain", "duration_ns"], "REALDATA_CLOCK");
  if (value.domain !== "process.hrtime.bigint") fail("REALDATA_CLOCK");
  assertDecimal(value.duration_ns, "REALDATA_CLOCK");
  return value;
}

function validateTranscript(value) {
  if (typeof value !== "string" || value.includes("\0") || Buffer.byteLength(value, "utf8") > MAX_TRANSCRIPT_BYTES) {
    fail("REALDATA_TRANSCRIPT");
  }
  return value;
}

function requestFor(sample, sequence, shardIndex, isCanary = false) {
  const canaryIdentity = isCanary
    ? sha256(Buffer.from(encodeCanonicalJsonLine({
        pcm_sha256: sample.pcm_sha256,
        reference_sha256: sample.reference_sha256,
        sample_id: sample.sample_id,
        wav_sha256: sample.wav_sha256,
      }), "utf8"))
    : "0".repeat(64);
  return {
    canary_identity_sha256: canaryIdentity,
    classification: isCanary ? "canary" : "sample",
    is_canary: isCanary,
    language: sample.language,
    pcm_sha256: sample.pcm_sha256,
    reference_sha256: sample.reference_sha256,
    request_sequence: sequence,
    sample_id: sample.sample_id,
    shard_index: shardIndex,
    wav_path: sample.wav_path,
    wav_sha256: sample.wav_sha256,
    wav_size_bytes: sample.wav_size_bytes,
  };
}

function jsonString(value) {
  return JSON.stringify(value);
}

function encodeShardRequestLine(request) {
  return `{"schema_version":"1.0","sequence":${request.request_sequence},"sample_id":${jsonString(request.sample_id)},"classification":${jsonString(request.classification)},"canary_identity_sha256":${jsonString(request.canary_identity_sha256)},"language":${jsonString(request.language)},"wav_path":${jsonString(request.wav_path)},"wav_size_bytes":${jsonString(String(request.wav_size_bytes))},"wav_sha256":${jsonString(request.wav_sha256)},"pcm_sha256":${jsonString(request.pcm_sha256)},"reference_sha256":${jsonString(request.reference_sha256)}}\n`;
}

function parseResponseLine(line) {
  const bytes = Buffer.from(`${line}\n`, "utf8");
  return parseCanonicalLine(bytes, "REALDATA_HOST_RESPONSE");
}

function unavailableResourceObservation(reason) {
  return { reason, status: "unavailable" };
}

async function sampleWindowsChildResources(pid) {
  if (process.platform !== "win32") return unavailableResourceObservation("supervisor-resource-sampling-non-windows");
  if (!Number.isSafeInteger(pid) || pid < 1) return unavailableResourceObservation("supervisor-resource-sampling-no-pid");
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  if (typeof systemRoot !== "string" || !/^[A-Za-z]:\\/u.test(systemRoot)) {
    return unavailableResourceObservation("supervisor-resource-sampling-no-systemroot");
  }
  const powershell = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  try {
    await readStableFile(powershell, "REALDATA_RESOURCE_SAMPLER_POWERSHELL", 16 * 1024 * 1024);
    const script = [
      "$ErrorActionPreference='Stop'",
      `[int]$pidValue=${pid}`,
      "$p=Get-Process -Id $pidValue",
      "$o=[ordered]@{status='available';pid=$p.Id;total_processor_time_ms=[int64]$p.TotalProcessorTime.TotalMilliseconds;working_set64=[int64]$p.WorkingSet64;peak_working_set64=[int64]$p.PeakWorkingSet64}",
      "$o|ConvertTo-Json -Compress",
    ].join(";");
    const output = await new Promise((resolve, reject) => {
      execFile(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
        encoding: "buffer",
        maxBuffer: 64 * 1024,
        windowsHide: true,
      }, (error, stdout, stderr) => {
        if (error !== null || stderr.length !== 0) reject(error ?? new Error("stderr"));
        else resolve(stdout);
      });
    });
    const parsed = JSON.parse(output.toString("utf8"));
    if (
      parsed?.status !== "available" || parsed.pid !== pid ||
      !Number.isSafeInteger(parsed.total_processor_time_ms) ||
      !Number.isSafeInteger(parsed.working_set64) ||
      !Number.isSafeInteger(parsed.peak_working_set64) ||
      parsed.working_set64 < 0 || parsed.peak_working_set64 < 0
    ) return unavailableResourceObservation("supervisor-resource-sampling-malformed");
    return {
      peak_working_set64: parsed.peak_working_set64,
      pid,
      status: "available",
      total_processor_time_ms: parsed.total_processor_time_ms,
      working_set64: parsed.working_set64,
    };
  } catch {
    return unavailableResourceObservation("supervisor-resource-sampling-failed");
  }
}

function validateSupervisorResourceObservation(value) {
  if (value?.status === "unavailable") {
    exactKeys(value, ["reason", "status"], "REALDATA_RESOURCE");
    assertIdentifier(value.reason, "REALDATA_RESOURCE");
    return value;
  }
  exactKeys(value, [
    "final_total_processor_time_ms", "max_peak_working_set64",
    "max_total_processor_time_ms", "max_working_set64", "sample_count", "status",
  ], "REALDATA_RESOURCE");
  if (
    value.status !== "available" ||
    !Number.isSafeInteger(value.final_total_processor_time_ms) || value.final_total_processor_time_ms < 0 ||
    !Number.isSafeInteger(value.max_total_processor_time_ms) || value.max_total_processor_time_ms < 0 ||
    !Number.isSafeInteger(value.max_working_set64) || value.max_working_set64 < 0 ||
    !Number.isSafeInteger(value.max_peak_working_set64) || value.max_peak_working_set64 < 0 ||
    !Number.isSafeInteger(value.sample_count) || value.sample_count < 1
  ) fail("REALDATA_RESOURCE");
  return value;
}

function aggregateSupervisorResourceSamples(samples) {
  const available = samples.filter((sample) => sample?.status === "available");
  if (available.length === 0) return unavailableResourceObservation("supervisor-resource-sampling-unavailable");
  return {
    final_total_processor_time_ms: Math.max(...available.map((sample) => sample.total_processor_time_ms)),
    max_peak_working_set64: Math.max(...available.map((sample) => sample.peak_working_set64)),
    max_total_processor_time_ms: Math.max(...available.map((sample) => sample.total_processor_time_ms)),
    max_working_set64: Math.max(...available.map((sample) => sample.working_set64)),
    sample_count: available.length,
    status: "available",
  };
}

function invokeShardHostWithSpawn({ executablePath, requests, resourceSampler = sampleWindowsChildResources, startupArguments, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(executablePath, startupArguments, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const stdout = [];
    const stderr = [];
    let killed = false;
    const resourceSamples = [];
    const timer = setTimeout(() => {
      killed = true;
      child.kill();
    }, timeoutMs);
    const collectResourceSample = async () => {
      try {
        resourceSamples.push(await resourceSampler(child.pid));
      } catch {
        resourceSamples.push(unavailableResourceObservation("supervisor-resource-sampling-failed"));
      }
    };
    const sampleTimer = setInterval(() => {
      void collectResourceSample();
    }, 1000);
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", (error) => {
      clearTimeout(timer);
      clearInterval(sampleTimer);
      reject(error);
    });
    void collectResourceSample();
    child.once("close", async (code, signal) => {
      clearTimeout(timer);
      clearInterval(sampleTimer);
      await collectResourceSample();
      if (killed || code !== 0 || signal !== null || Buffer.concat(stderr).length !== 0) {
        reject(new Error("REALDATA_HOST_EXIT"));
        return;
      }
      resolve({
        lines: Buffer.concat(stdout).toString("utf8").trimEnd().split("\n").filter(Boolean),
        resourceObservation: aggregateSupervisorResourceSamples(resourceSamples),
      });
    });
    for (const request of requests) child.stdin.write(encodeShardRequestLine(request));
    child.stdin.end();
  });
}

function startupArgumentsForShard(input, requests, maxHostRequestsPerShard) {
  const languages = new Set(requests.map((request) => request.language));
  if (languages.size !== 1) fail("REALDATA_SHARD_LANGUAGE");
  if (
    !Number.isSafeInteger(maxHostRequestsPerShard) ||
    maxHostRequestsPerShard < 1 ||
    requests.length > maxHostRequestsPerShard
  ) fail("REALDATA_SHARD_REQUEST_LIMIT");
  const totalPcmBytes = requests.reduce((sum, request) => sum + BigInt(request.wav_size_bytes - 44), 0n);
  if (totalPcmBytes < 1n || totalPcmBytes > 10_000_000_000n) fail("REALDATA_SHARD_PCM_BUDGET");
  return [
    input.schemaRegistryPath,
    input.modelPath,
    input.tokensPath,
    input.runtimeLibDir,
    input.assetLockPath,
    input.packageLockPath,
    [...languages][0],
    String(maxHostRequestsPerShard),
    String(totalPcmBytes),
  ];
}

function buildCanaryBases(samples, canarySampleId) {
  const bases = new Map();
  for (const sample of samples) {
    if (!bases.has(sample.language)) {
      bases.set(sample.language, {
        duration_samples: sample.duration_samples,
        language: sample.language,
        pcm_sha256: sample.pcm_sha256,
        reference_sha256: sample.reference_sha256,
        reference_text: sample.reference_text,
        sample_id: canarySampleId,
        scenario: sample.scenario,
        split: sample.split,
        tier: sample.tier,
        wav_path: sample.wav_path,
        wav_sha256: sample.wav_sha256,
        wav_size_bytes: sample.wav_size_bytes,
      });
    }
  }
  for (const language of ["en", "ja", "zh"]) {
    if (!bases.has(language)) fail("REALDATA_CANARY");
  }
  return bases;
}

function sortedObjectFromMap(map) {
  return Object.fromEntries([...map.entries()].sort(([left], [right]) => left.localeCompare(right, "en")));
}

async function runShardProcess({ dependencies, input, policy, requests }) {
  const result = await dependencies.invokeShardHost({
    executablePath: input.shardHostPath,
    requests,
    resourceSampler: dependencies.sampleChildResources,
    startupArguments: startupArgumentsForShard(input, requests, policy.execution.max_host_requests_per_shard),
    startupIdentities: {
      asset_lock_sha256: input.expectedAssetLockSha256,
      model_sha256: input.expectedModelSha256,
      package_lock_sha256: input.expectedPackageLockSha256,
      runtime_bundle_sha256: input.expectedRuntimeBundleSha256,
      schema_registry_sha256: input.expectedSchemaRegistrySha256,
      tokens_sha256: input.expectedTokensSha256,
    },
    timeoutMs: policy.execution.shard_timeout_ms,
  }).catch((error) => fail("REALDATA_HOST_PROCESS", { cause: error }));
  const lines = Array.isArray(result) ? result : result?.lines;
  const resourceObservation = Array.isArray(result)
    ? unavailableResourceObservation("supervisor-resource-sampling-unavailable")
    : validateSupervisorResourceObservation(result?.resourceObservation);
  if (!Array.isArray(lines) || lines.length !== requests.length) fail("REALDATA_HOST_RESPONSE_COUNT");
  return { resourceObservation, responses: lines.map(parseResponseLine) };
}

function validateHostResponse(response, request, sample, expected) {
  if (
    response === null || typeof response !== "object" || Array.isArray(response) ||
    !Object.hasOwn(response, "authority")
  ) fail("REALDATA_HOST_AUTHORITY");
  exactKeys(response, [
    "authority", "candidate", "execution", "host", "kind", "resources", "rtf", "sample",
    "schema_version", "shard",
  ], "REALDATA_HOST_RESPONSE");
  exactKeys(response.authority, ["formal_claims", "production_evidence"], "REALDATA_HOST_AUTHORITY");
  if (
    response.authority.formal_claims !== "none" ||
    response.authority.production_evidence !== false
  ) fail("REALDATA_HOST_AUTHORITY");
  exactKeys(response.execution, [
    "backend_execute_calls", "execute_elapsed_ns", "execute_finished_monotonic_ns",
    "execute_started_monotonic_ns", "final_transcript", "final_transcript_sha256",
    "final_transcript_utf8_bytes", "fresh_os_process_per_shard",
    "fresh_recognizer_stream_per_request", "prepare_elapsed_ns",
    "prepare_finished_monotonic_ns", "prepare_started_monotonic_ns", "request_sequence",
    "runtime_identity_post_status", "runtime_identity_pre_status", "shard_prepare_calls",
  ], "REALDATA_HOST_RESPONSE");
  exactKeys(response.sample, [
    "canary_identity_sha256", "channels", "classification", "language", "pcm_bytes",
    "pcm_sample_count", "pcm_sha256", "reference_sha256", "sample_id",
    "sample_identity_sha256", "sample_rate_hz", "scored", "wav_sha256", "wav_size_bytes",
  ], "REALDATA_HOST_RESPONSE");
  const candidateIdentitySha256 = sha256(Buffer.from(encodeCanonicalJsonLine(response.candidate), "utf8"));
  const expectedSample = expectedResponseSampleIdentity(request, sample);
  if (
    response.kind !== RESPONSE_KIND || response.schema_version !== RESPONSE_SCHEMA_VERSION ||
    response.execution.request_sequence !== request.request_sequence ||
    response.sample.sample_id !== request.sample_id ||
    response.sample.classification !== expectedSample.classification ||
    response.sample.language !== expectedSample.language ||
    response.sample.pcm_sha256 !== expectedSample.pcm_sha256 ||
    response.sample.reference_sha256 !== expectedSample.reference_sha256 ||
    response.sample.wav_sha256 !== expectedSample.wav_sha256 ||
    response.sample.wav_size_bytes !== expectedSample.wav_size_bytes ||
    response.sample.canary_identity_sha256 !== expectedSample.canary_identity_sha256 ||
    response.sample.sample_identity_sha256 !== expectedSample.sample_identity_sha256 ||
    response.sample.scored !== !request.is_canary ||
    response.execution.backend_execute_calls !== 1 ||
    response.execution.fresh_os_process_per_shard !== true ||
    response.execution.fresh_recognizer_stream_per_request !== true ||
    response.execution.shard_prepare_calls !== 1 ||
    response.execution.runtime_identity_pre_status !== "verified" ||
    response.execution.runtime_identity_post_status !== "verified"
  ) fail("REALDATA_HOST_RESPONSE");
  exactKeys(response.host, ["executable_sha256", "schema_registry_sha256"], "REALDATA_HOST_RESPONSE");
  assertDigest(response.host.executable_sha256, "REALDATA_HOST_RESPONSE");
  assertDigest(response.host.schema_registry_sha256, "REALDATA_HOST_RESPONSE");
  exactKeys(response.candidate, [
    "asset_lock_sha256", "candidate_id", "model_sha256", "package_lock_sha256",
    "parameter_sha256", "runtime_bundle_sha256", "tokens_sha256",
  ], "REALDATA_HOST_RESPONSE");
  if (
    response.host.executable_sha256 !== expected.hostSha256 ||
    response.host.schema_registry_sha256 !== expected.startup.schema_registry_sha256 ||
    response.candidate.asset_lock_sha256 !== expected.startup.asset_lock_sha256 ||
    response.candidate.model_sha256 !== expected.startup.model_sha256 ||
    response.candidate.package_lock_sha256 !== expected.startup.package_lock_sha256 ||
    response.candidate.runtime_bundle_sha256 !== expected.startup.runtime_bundle_sha256 ||
    response.candidate.tokens_sha256 !== expected.startup.tokens_sha256
  ) fail("REALDATA_HOST_IDENTITY");
  assertDigest(response.candidate.parameter_sha256, "REALDATA_HOST_RESPONSE");
  for (const key of [
    "execute_elapsed_ns", "execute_finished_monotonic_ns", "execute_started_monotonic_ns",
    "prepare_elapsed_ns", "prepare_finished_monotonic_ns", "prepare_started_monotonic_ns",
  ]) assertDecimal(response.execution[key], "REALDATA_HOST_RESPONSE");
  if (
    BigInt(response.execution.prepare_started_monotonic_ns) > BigInt(response.execution.prepare_finished_monotonic_ns) ||
    BigInt(response.execution.execute_started_monotonic_ns) > BigInt(response.execution.execute_finished_monotonic_ns)
  ) fail("REALDATA_CLOCK");
  validateResource(response.resources);
  const transcript = validateTranscript(response.execution.final_transcript);
  const transcriptBytes = Buffer.from(transcript, "utf8");
  if (
    response.execution.final_transcript_sha256 !== sha256(transcriptBytes) ||
    response.execution.final_transcript_utf8_bytes !== String(transcriptBytes.length)
  ) fail("REALDATA_TRANSCRIPT");
  return {
    attempt: 1,
    candidate_identity_sha256: candidateIdentitySha256,
    candidate_parameter_sha256: response.candidate.parameter_sha256,
    component_record_sha256: sha256(Buffer.from(encodeCanonicalJsonLine({
      execution: {
        execute_elapsed_ns: response.execution.execute_elapsed_ns,
        prepare_elapsed_ns: response.execution.prepare_elapsed_ns,
        request_sequence: response.execution.request_sequence,
      },
      host: response.host,
      sample: {
        sample_id: response.sample.sample_id,
        sample_identity_sha256: response.sample.sample_identity_sha256,
      },
    }), "utf8")),
    final_transcript: transcript,
    final_transcript_sha256: response.execution.final_transcript_sha256,
    final_transcript_utf8_bytes: response.execution.final_transcript_utf8_bytes,
    language: sample.language,
    sample_id: sample.sample_id,
    sample_identity_sha256: response.sample.sample_identity_sha256,
    scenario: sample.scenario,
    sequence: request.request_sequence,
    split: sample.split,
    tier: sample.tier,
  };
}

function assertNoForbiddenAuthority(record) {
  const text = JSON.stringify(record);
  for (const forbidden of [
    "threshold", "pass", "passed", "rank", "selection", "selected",
    "default", "publishable", "publishability",
  ]) {
    if (text.includes(forbidden)) fail("REALDATA_AUTHORITY_ESCALATION");
  }
}

function assertNoPrivateOrPathLikeLeak(value, code, keyPath = []) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoPrivateOrPathLikeLeak(entry, code, [...keyPath, String(index)]));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (/^(?:final_transcript|reference_text|wav_path|file_path|path|url)$/u.test(key)) fail(code);
      assertNoPrivateOrPathLikeLeak(entry, code, [...keyPath, key]);
    }
    return;
  }
  if (typeof value !== "string") return;
  if (
    value.includes("\0") ||
    /^[A-Za-z]:[\\/]/u.test(value) ||
    /^[\\/]{2}/u.test(value) ||
    /https?:\/\//iu.test(value) ||
    /(?:^|[\\/])controlled[\\/]/iu.test(value) ||
    value.includes("stable canary")
  ) fail(code);
}

function validateDigestLanguageMap(value, code) {
  exactKeys(value, ["en", "ja", "zh"], code);
  for (const digest of Object.values(value)) assertDigest(digest, code);
}

function validateDistinctDigestLanguageMap(value, code) {
  validateDigestLanguageMap(value, code);
  if (new Set(Object.values(value)).size !== 3) fail(code);
  return value;
}

function computeCandidateIdentityJoinSha256(candidateIdentityByLanguage, parameterSha256ByLanguage) {
  const identityMap = validateDistinctDigestLanguageMap(candidateIdentityByLanguage, "REALDATA_HOST_IDENTITY");
  const parameterMap = validateDistinctDigestLanguageMap(parameterSha256ByLanguage, "REALDATA_HOST_IDENTITY");
  return sha256(Buffer.from(encodeCanonicalJsonLine({
    candidate_identity_sha256_by_language: identityMap,
    candidate_parameter_sha256_by_language: parameterMap,
    kind: CANDIDATE_IDENTITY_SET_KIND,
    schema_version: CANDIDATE_IDENTITY_SET_SCHEMA_VERSION,
  }), "utf8"));
}

function validateStatusCountMap(value, allowed, code) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(code);
  exactKeys(value, allowed, code);
  let total = 0;
  for (const [key, count] of Object.entries(value)) {
    if (!allowed.includes(key) || !Number.isSafeInteger(count) || count < 0) fail(code);
    total += count;
  }
  return total;
}

function validateResourceObservationSummary(value, executionTotals) {
  exactKeys(value, [
    "host_peak_ram_bytes_max", "sample_count", "status_counts",
    "supervisor_process_peak_working_set64_max", "supervisor_process_status_counts",
  ], "REALDATA_RESOURCE");
  if (
    !Number.isSafeInteger(value.sample_count) || value.sample_count < 1 ||
    (value.host_peak_ram_bytes_max !== null &&
      (!Number.isSafeInteger(value.host_peak_ram_bytes_max) || value.host_peak_ram_bytes_max < 0)) ||
    (value.supervisor_process_peak_working_set64_max !== null &&
      (!Number.isSafeInteger(value.supervisor_process_peak_working_set64_max) ||
        value.supervisor_process_peak_working_set64_max < 0))
  ) fail("REALDATA_RESOURCE");
  const hostStatusCount = validateStatusCountMap(value.status_counts, ["observed", "unavailable"], "REALDATA_RESOURCE");
  const supervisorStatusCount = validateStatusCountMap(
    value.supervisor_process_status_counts,
    ["available", "unavailable"],
    "REALDATA_RESOURCE",
  );
  if (
    hostStatusCount !== value.sample_count ||
    (executionTotals !== undefined && (
      value.sample_count !== executionTotals.sampleCount + executionTotals.canaryCount ||
      supervisorStatusCount !== executionTotals.shardCount
    ))
  ) fail("REALDATA_RESOURCE");
}

function validateAggregateRate(rate, { allowUnavailable = true, utterance = false } = {}) {
  exactKeys(rate, ["denominator", "numerator", "status"], "REALDATA_AGGREGATE");
  assertAggregateDecimal(rate.denominator, "REALDATA_AGGREGATE");
  assertAggregateDecimal(rate.numerator, "REALDATA_AGGREGATE");
  if (rate.status === "measured") {
    if (rate.denominator === "0") fail("REALDATA_AGGREGATE");
  } else if (!allowUnavailable || rate.status !== "not-comparable" || rate.denominator !== "0" || rate.numerator !== "0") {
    fail("REALDATA_AGGREGATE");
  }
  if (utterance && rate.status === "measured" && BigInt(rate.numerator) > BigInt(rate.denominator) * 2n) {
    fail("REALDATA_AGGREGATE");
  }
}

function validateAggregateSummary(summary, field) {
  const languageScenario = field === "by_language_scenario";
  exactKeys(summary, [
    "comparable_sample_count", "error_sums", "key", ...(languageScenario ? ["language", "scenario"] : []),
    "macro_error_rate", "sample_count", "utterance_error_rate_range",
    "zero_reference_correct", "zero_reference_hallucinations",
  ], "REALDATA_AGGREGATE");
  assertIdentifier(languageScenario ? summary.scenario : "aggregate", "REALDATA_AGGREGATE");
  if (languageScenario) {
    if (!["en", "ja", "zh"].includes(summary.language) || summary.key !== `${summary.language}/${summary.scenario}`) {
      fail("REALDATA_AGGREGATE");
    }
  } else if (!["en", "ja", "zh"].includes(summary.key)) {
    fail("REALDATA_AGGREGATE");
  }
  for (const key of ["comparable_sample_count", "sample_count", "zero_reference_correct", "zero_reference_hallucinations"]) {
    if (!Number.isSafeInteger(summary[key]) || summary[key] < 0 || summary[key] > SAMPLE_COUNT) fail("REALDATA_AGGREGATE");
  }
  if (
    summary.comparable_sample_count > summary.sample_count ||
    summary.zero_reference_correct + summary.zero_reference_hallucinations + summary.comparable_sample_count !== summary.sample_count
  ) fail("REALDATA_AGGREGATE");
  exactKeys(summary.error_sums, ["deletions", "hypothesis_units", "insertions", "reference_units", "substitutions", "total"], "REALDATA_AGGREGATE");
  for (const value of Object.values(summary.error_sums)) {
    if (!Number.isSafeInteger(value) || value < 0 || value > SAMPLE_COUNT * MAX_TRANSCRIPT_BYTES * 2) fail("REALDATA_AGGREGATE");
  }
  if (
    summary.error_sums.total !== summary.error_sums.deletions + summary.error_sums.insertions + summary.error_sums.substitutions ||
    summary.error_sums.deletions > summary.error_sums.reference_units ||
    summary.error_sums.substitutions > summary.error_sums.reference_units ||
    summary.error_sums.total > summary.error_sums.reference_units + summary.error_sums.hypothesis_units ||
    summary.error_sums.reference_units < summary.comparable_sample_count ||
    summary.error_sums.hypothesis_units < summary.zero_reference_hallucinations
  ) fail("REALDATA_AGGREGATE");
  validateAggregateRate(summary.macro_error_rate);
  exactKeys(summary.utterance_error_rate_range, ["maximum", "minimum"], "REALDATA_AGGREGATE");
  validateAggregateRate(summary.utterance_error_rate_range.minimum, { utterance: true });
  validateAggregateRate(summary.utterance_error_rate_range.maximum, { utterance: true });
  if (
    summary.comparable_sample_count === 0 && summary.macro_error_rate.status !== "not-comparable" ||
    summary.comparable_sample_count > 0 && summary.macro_error_rate.status !== "measured" ||
    summary.utterance_error_rate_range.minimum.status !== summary.macro_error_rate.status ||
    summary.utterance_error_rate_range.maximum.status !== summary.macro_error_rate.status ||
    summary.comparable_sample_count > 0 &&
      compareRates(summary.utterance_error_rate_range.minimum, summary.utterance_error_rate_range.maximum) > 0
  ) fail("REALDATA_AGGREGATE");
}

function validatePublicAggregate(aggregate, scorerIdentity) {
  exactKeys(aggregate, [
    "assessment_status", "authority", "by_language", "by_language_scenario",
    "sample_count", "scorer_profile",
  ], "REALDATA_AGGREGATE");
  exactKeys(aggregate.authority, ["formal_claims", "production_evidence"], "REALDATA_AGGREGATE");
  exactKeys(aggregate.scorer_profile, ["profile_id", "profile_sha256"], "REALDATA_AGGREGATE");
  if (
    aggregate.assessment_status !== "descriptive-only" ||
    aggregate.authority.formal_claims !== "none" ||
    aggregate.authority.production_evidence !== false ||
    !isDeepStrictEqual(aggregate.scorer_profile, scorerIdentity) ||
    aggregate.sample_count !== SAMPLE_COUNT
  ) fail("REALDATA_AGGREGATE");
  let expectedTotals;
  for (const field of ["by_language", "by_language_scenario"]) {
    if (!Array.isArray(aggregate[field]) || aggregate[field].length === 0) fail("REALDATA_AGGREGATE");
    const keys = new Set();
    let previousKey;
    const totals = {
      comparable_sample_count: 0,
      deletions: 0,
      hypothesis_units: 0,
      insertions: 0,
      reference_units: 0,
      sample_count: 0,
      substitutions: 0,
      total: 0,
      zero_reference_correct: 0,
      zero_reference_hallucinations: 0,
    };
    for (const summary of aggregate[field]) {
      validateAggregateSummary(summary, field);
      if (keys.has(summary.key) || (previousKey !== undefined && previousKey > summary.key)) fail("REALDATA_AGGREGATE");
      keys.add(summary.key);
      previousKey = summary.key;
      for (const key of ["comparable_sample_count", "sample_count", "zero_reference_correct", "zero_reference_hallucinations"]) {
        totals[key] += summary[key];
      }
      for (const key of ["deletions", "hypothesis_units", "insertions", "reference_units", "substitutions", "total"]) {
        totals[key] += summary.error_sums[key];
      }
    }
    if (totals.sample_count !== SAMPLE_COUNT) fail("REALDATA_AGGREGATE");
    if (expectedTotals === undefined) expectedTotals = totals;
    else if (!isDeepStrictEqual(expectedTotals, totals)) fail("REALDATA_AGGREGATE");
  }
  for (const language of aggregate.by_language) {
    const scenarioRates = aggregate.by_language_scenario
      .filter((entry) => entry.language === language.key && entry.macro_error_rate.status === "measured")
      .map((entry) => entry.macro_error_rate);
    if (!isDeepStrictEqual(meanRates(scenarioRates), language.macro_error_rate)) fail("REALDATA_AGGREGATE");
  }
}

function validateFinalExecution(value) {
  exactKeys(value, [
    "canary_count", "canary_identity_sha256_by_language", "canary_transcript_sha256_by_language",
    "run_resource_observations_sha256", "sample_count", "shard_count", "shards",
  ], "REALDATA_EVIDENCE");
  if (
    !Number.isSafeInteger(value.canary_count) || value.canary_count < 1 ||
    value.sample_count !== SAMPLE_COUNT ||
    !Number.isSafeInteger(value.shard_count) || value.shard_count < 1 ||
    !Array.isArray(value.shards) || value.shards.length !== value.shard_count
  ) fail("REALDATA_EVIDENCE");
  validateDigestLanguageMap(value.canary_identity_sha256_by_language, "REALDATA_CANARY");
  validateDigestLanguageMap(value.canary_transcript_sha256_by_language, "REALDATA_CANARY");
  assertDigest(value.run_resource_observations_sha256, "REALDATA_RESOURCE");
  let scored = 0;
  let canaries = 0;
  for (const [index, shard] of value.shards.entries()) {
    exactKeys(shard, ["canary_count", "host_process_fresh", "resource_observation", "sample_count", "shard_index"], "REALDATA_EVIDENCE");
    if (
      shard.host_process_fresh !== true ||
      shard.shard_index !== index ||
      !Number.isSafeInteger(shard.sample_count) || shard.sample_count < 1 ||
      !Number.isSafeInteger(shard.canary_count) || shard.canary_count < 1
    ) fail("REALDATA_EVIDENCE");
    validateSupervisorResourceObservation(shard.resource_observation);
    scored += shard.sample_count;
    canaries += shard.canary_count;
  }
  if (scored !== SAMPLE_COUNT || canaries !== value.canary_count) fail("REALDATA_EVIDENCE");
  return {
    canaryCount: canaries,
    sampleCount: scored,
    shardCount: value.shard_count,
  };
}

function validateEvidenceRecord(record) {
  if (
    record !== null && typeof record === "object" && !Array.isArray(record) &&
    (!Object.hasOwn(record, "host_identity") ||
      !Object.hasOwn(record, "ledger_identity") ||
      record.host_identity === null ||
      record.ledger_identity === null ||
      typeof record.host_identity !== "object" ||
      typeof record.ledger_identity !== "object" ||
      Array.isArray(record.host_identity) ||
      Array.isArray(record.ledger_identity))
  ) fail("REALDATA_HOST_IDENTITY");
  exactKeys(record, ROOT_KEYS, "REALDATA_EVIDENCE_FIELDS");
  if (
    record.kind !== KIND || record.schema_version !== EVIDENCE_SCHEMA_VERSION ||
    record.measurement_status !== "measured" ||
    record.quality_gate_status !== "not-assessed" ||
    !isDeepStrictEqual(record.authority, AUTHORITY) ||
    record.execution.sample_count !== SAMPLE_COUNT
  ) fail("REALDATA_EVIDENCE");
  validatePublicAggregate(record.aggregate, record.scorer_identity);
  const executionTotals = validateFinalExecution(record.execution);
  validateResourceObservationSummary(record.resource_observations, executionTotals);
  exactKeys(record.ledger_identity, [
    "candidate_identity_join_sha256", "entry_count", "hardware_evidence_sha256",
    "projection_sha256", "seal_sha256", "sha256",
  ], "REALDATA_HOST_IDENTITY");
  if (record.ledger_identity.entry_count !== SAMPLE_COUNT) fail("REALDATA_EVIDENCE");
  exactKeys(record.host_identity, [
    "build_attestation_sha256", "candidate_identity_join_sha256",
    "candidate_identity_sha256_by_language", "candidate_parameter_sha256_by_language",
    "executable_sha256", "source_commit", "source_tree_sha256",
  ], "REALDATA_HOST_IDENTITY");
  const expectedCandidateIdentityJoinSha256 = computeCandidateIdentityJoinSha256(
    record.host_identity.candidate_identity_sha256_by_language,
    record.host_identity.candidate_parameter_sha256_by_language,
  );
  if (
    record.host_identity.candidate_identity_join_sha256 !== expectedCandidateIdentityJoinSha256 ||
    record.ledger_identity.candidate_identity_join_sha256 !== expectedCandidateIdentityJoinSha256
  ) {
    fail("REALDATA_HOST_IDENTITY");
  }
  const expectedResourceObservationsSha256 = sha256(
    Buffer.from(encodeCanonicalJsonLine(record.resource_observations), "utf8"),
  );
  if (
    record.execution.run_resource_observations_sha256 !== expectedResourceObservationsSha256 ||
    record.ledger_identity.hardware_evidence_sha256 !== expectedResourceObservationsSha256
  ) {
    fail("REALDATA_RESOURCE");
  }
  assertNoForbiddenAuthority(record);
  assertNoPrivateOrPathLikeLeak(record, "REALDATA_PRIVACY");
  return record;
}

export function validateNativeCandidateRealdataShardEvidenceRecord(bytes) {
  const record = parseCanonicalLine(bytes, "REALDATA_EVIDENCE_CANONICAL");
  return { evidenceSha256: sha256(bytes), record: validateEvidenceRecord(record) };
}

async function publishFinalEvidence(outputPath, bytes, operations = {}) {
  validateNativeCandidateRealdataShardEvidenceRecord(bytes);
  assertAbsolutePath(outputPath, "REALDATA_FINAL_OUTPUT");
  try {
    await lstat(outputPath, { bigint: true });
    fail("REALDATA_FINAL_OUTPUT");
  } catch (error) {
    if (error instanceof NativeCandidateRealdataShardRunnerError) throw error;
    if (error?.code !== "ENOENT") fail("REALDATA_FINAL_OUTPUT", { cause: error });
  }
  const suffix = (operations.randomSuffix ?? (() => randomBytes(16).toString("hex")))();
  if (!/^[0-9a-f]{32}$/u.test(suffix)) fail("REALDATA_FINAL_OUTPUT");
  const stagingPath = path.join(path.dirname(outputPath), `.${path.basename(outputPath)}.${suffix}.staging`);
  const handle = await (operations.openFile ?? open)(stagingPath, "wx", 0o600)
    .catch((error) => fail("REALDATA_FINAL_PUBLICATION", { cause: error }));
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close().catch(() => fail("REALDATA_FINAL_PUBLICATION"));
  }
  await (operations.linkFile ?? link)(stagingPath, outputPath)
    .catch((error) => fail("REALDATA_FINAL_PUBLICATION", { cause: error }));
  const persisted = await readFile(outputPath).catch((error) => fail("REALDATA_FINAL_PERSISTED", { cause: error }));
  if (!Buffer.isBuffer(persisted) || !persisted.equals(bytes)) fail("REALDATA_FINAL_PERSISTED");
  validateNativeCandidateRealdataShardEvidenceRecord(persisted);
  return outputPath;
}

function buildResourceObservations(entries) {
  const statuses = { observed: 0, unavailable: 0 };
  const hostAvailablePeaks = [];
  const supervisorStatuses = { available: 0, unavailable: 0 };
  const supervisorPeaks = [];
  for (const entry of entries) {
    const status = entry.response.resources.status;
    statuses[status] = (statuses[status] ?? 0) + 1;
    if (status === "observed" && entry.response.resources.peak_ram_bytes !== null) {
      hostAvailablePeaks.push(Number(entry.response.resources.peak_ram_bytes));
    }
  }
  for (const entry of entries.filter((value) => value.supervisorResource !== undefined)) {
    const status = entry.supervisorResource.status;
    supervisorStatuses[status] = (supervisorStatuses[status] ?? 0) + 1;
    if (status === "available") supervisorPeaks.push(entry.supervisorResource.max_peak_working_set64);
  }
  return {
    host_peak_ram_bytes_max: hostAvailablePeaks.length === 0 ? null : Math.max(...hostAvailablePeaks),
    sample_count: entries.length,
    supervisor_process_peak_working_set64_max: supervisorPeaks.length === 0 ? null : Math.max(...supervisorPeaks),
    supervisor_process_status_counts: Object.fromEntries(Object.entries(supervisorStatuses).sort()),
    status_counts: Object.fromEntries(Object.entries(statuses).sort()),
  };
}

function buildLedgerJoins(input, external, joins) {
  return {
    candidate_identity_sha256: joins.candidateIdentityJoinSha256,
    corpus_manifest_sha256: external.snapshot.record.materialization.manifest_sha256,
    corpus_snapshot_sha256: external.snapshot.sha256,
    execution_host_sha256: external.shardHostAttestation.record.executable.sha256,
    hardware_evidence_sha256: joins.hardwareEvidenceSha256,
    scorer_manifest_sha256: input.expectedScorerProfileSha256,
    scorer_profile_sha256: input.expectedScorerProfileSha256,
    source_commit: input.expectedSourceCommit,
    source_evidence_sha256: external.readiness.sha256,
  };
}

async function readPinnedSnapshotIdentity(input) {
  const evidenceBytes = await readStableFile(input.materializationEvidencePath, "REALDATA_MATERIALIZATION_EVIDENCE_READ", 128 * 1024);
  if (sha256(evidenceBytes) !== input.expectedMaterializationEvidenceSha256) fail("REALDATA_MATERIALIZATION_EVIDENCE_DIGEST");
  const evidence = validateFleursMaterializedPublicEvidenceBytes(evidenceBytes);
  if (
    evidence.publicEvidence.corpus_manifest_sha256 !== input.expectedCorpusManifestSha256 ||
    evidence.publicEvidence.corpus_snapshot_sha256 !== input.expectedCorpusSnapshotSha256 ||
    evidence.publicEvidence.policy_sha256 !== input.expectedFleursPolicySha256
  ) fail("REALDATA_MATERIALIZATION_JOIN");
  return { sha256: evidence.publicEvidence.corpus_snapshot_sha256 };
}

async function loadExternal(input, dependencies, { includeSnapshot } = { includeSnapshot: true }) {
  const [
    policy,
    snapshotIdentity,
    readinessBytes,
    fleursPolicy,
    scorerBytes,
    shardHostAttestation,
    shardHostBytes,
    assetLockBytes,
    modelBytes,
    packageLockBytes,
    schemaRegistryBytes,
    tokensBytes,
  ] = await Promise.all([
    dependencies.policyReader(input),
    includeSnapshot ? dependencies.snapshotReader(input) : dependencies.snapshotIdentityReader(input),
    readStableFile(input.readinessPath, "REALDATA_READINESS_READ", MAX_JSON_BYTES),
    readPinnedFleursGoldSourcePolicy({
      expectedPolicySha256: input.expectedFleursPolicySha256,
      policyPath: input.fleursPolicyPath,
    }).catch((error) => fail("REALDATA_FLEURS_POLICY", { cause: error })),
    readStableFile(input.scorerProfilePath, "REALDATA_SCORER_READ", 64 * 1024),
    dependencies.shardHostBuildAttestationReader(input),
    readStableFile(input.shardHostPath, "REALDATA_HOST_READ", 128 * 1024 * 1024),
    readStableFile(input.assetLockPath, "REALDATA_STARTUP_READ", 16 * 1024 * 1024),
    readStableFile(input.modelPath, "REALDATA_STARTUP_READ", 2 * 1024 * 1024 * 1024),
    readStableFile(input.packageLockPath, "REALDATA_STARTUP_READ", 16 * 1024 * 1024),
    readStableFile(input.schemaRegistryPath, "REALDATA_STARTUP_READ", 16 * 1024 * 1024),
    readStableFile(input.tokensPath, "REALDATA_STARTUP_READ", 128 * 1024 * 1024),
  ]);
  if (sha256(scorerBytes) !== input.expectedScorerProfileSha256) fail("REALDATA_SCORER_DIGEST");
  if (sha256(shardHostBytes) !== input.expectedShardHostSha256) fail("REALDATA_HOST_DIGEST");
  if (
    sha256(assetLockBytes) !== input.expectedAssetLockSha256 ||
    sha256(modelBytes) !== input.expectedModelSha256 ||
    sha256(packageLockBytes) !== input.expectedPackageLockSha256 ||
    sha256(schemaRegistryBytes) !== input.expectedSchemaRegistrySha256 ||
    sha256(tokensBytes) !== input.expectedTokensSha256
  ) fail("REALDATA_STARTUP_DIGEST");
  const readiness = validateFormalRunReadinessEnvelopeBytes(readinessBytes, {
    currentTime: formatUtcSecond(dependencies.now(), "REALDATA_CLOCK"),
    expectedBuildAttestationSha256: input.expectedReadinessBuildAttestationSha256,
    expectedCreateReceiptSha256: input.expectedCreateReceiptSha256,
    expectedDeleteReceiptSha256: input.expectedDeleteReceiptSha256,
    expectedFleursPolicySha256: input.expectedFleursPolicySha256,
    expectedPolicySha256: input.expectedFormalPolicySha256,
  });
  if (readiness.sha256 !== input.expectedReadinessSha256) fail("REALDATA_READINESS_DIGEST");
  if (readiness.record.quality_host.source_commit !== input.expectedSourceCommit) fail("REALDATA_SOURCE_COMMIT");
  if (fleursPolicy.policySha256 !== readiness.record.source.policy_sha256) fail("REALDATA_SOURCE_JOIN");
  const controlledRootIdentity = await dependencies.controlledRootIdentityReader(input, readiness)
    .catch((error) => fail("REALDATA_CONTROLLED_ROOT_IDENTITY", { cause: error }));
  assertControlledRootIdentity(readiness, controlledRootIdentity);
  if (shardHostAttestation.record.source.commit !== input.expectedSourceCommit) fail("REALDATA_SOURCE_COMMIT");
  if (shardHostAttestation.record.executable.runtime_bundle_sha256 !== input.expectedRuntimeBundleSha256) {
    fail("REALDATA_STARTUP_DIGEST");
  }
  return {
    fleursPolicy,
    policy,
    readiness,
    controlledRootIdentity,
    shardHostAttestation,
    snapshot: includeSnapshot ? snapshotIdentity : undefined,
    snapshotSha256: snapshotIdentity.sha256,
    startup: {
      asset_lock_sha256: input.expectedAssetLockSha256,
      model_sha256: input.expectedModelSha256,
      package_lock_sha256: input.expectedPackageLockSha256,
      runtime_bundle_sha256: input.expectedRuntimeBundleSha256,
      schema_registry_sha256: input.expectedSchemaRegistrySha256,
      tokens_sha256: input.expectedTokensSha256,
    },
  };
}

function assertExternalStable(left, right) {
  const comparable = (value) => JSON.stringify({
    c: stableRootIdentityFromAttestation(value.controlledRootIdentity),
    f: value.fleursPolicy.policySha256,
    p: value.policy.sha256,
    r: value.readiness.sha256,
    s: value.snapshotSha256,
    a: value.shardHostAttestation.sha256,
  });
  if (comparable(left) !== comparable(right)) fail("REALDATA_POSTFLIGHT_DRIFT");
}

async function runCore(rawInput, dependencies) {
  const input = validateInput(rawInput);
  await assertMaterializedCorpusRootBound(input);
  const initial = await loadExternal(input, dependencies);
  const shards = partitionSamples(initial.snapshot.record.samples, initial.policy.policy.execution.max_scored_samples_per_shard);
  const shardExecutions = [];
  const ledgerEntries = [];
  const responseRows = [];
  let scoredSampleCounter = 0;
  const canaryBases = buildCanaryBases(
    initial.snapshot.record.samples,
    initial.policy.policy.canary.sample_id,
  );
  const canaryIdentityByLanguage = new Map();
  const canaryTranscriptByLanguage = new Map();
  let canaryCount = 0;
  const candidateIdentityByLanguage = new Map();
  const candidateParameterByLanguage = new Map();
  const startedAt = dependencies.now();
  const monotonicStart = dependencies.monotonicNow();
  for (const [shardIndex, shardSamples] of shards.entries()) {
    const canaryBase = canaryBases.get(shardSamples[0]?.language);
    if (canaryBase === undefined) fail("REALDATA_CANARY");
    if (!isCanonicalLocalAbsolutePath(canaryBase.wav_path)) fail("REALDATA_CANARY");
    assertDigest(canaryBase.wav_sha256, "REALDATA_CANARY");
    if (!Number.isSafeInteger(canaryBase.wav_size_bytes) || canaryBase.wav_size_bytes < 1) fail("REALDATA_CANARY");
    const requests = [];
    let shardSequence = 1;
    let shardCanaryInserted = false;
    for (const sample of shardSamples) {
      requests.push(requestFor(sample, shardSequence, shardIndex, false));
      shardSequence += 1;
      scoredSampleCounter += 1;
      if (scoredSampleCounter % initial.policy.policy.canary.cadence_samples === 0) {
        requests.push(requestFor(canaryBase, shardSequence, shardIndex, true));
        shardSequence += 1;
        shardCanaryInserted = true;
      }
    }
    if (!shardCanaryInserted) {
      requests.push(requestFor(canaryBase, shardSequence, shardIndex, true));
      shardSequence += 1;
    }
    const shardResult = await runShardProcess({ dependencies, input, policy: initial.policy.policy, requests });
    const responses = shardResult.responses;
    const shardCanaryIds = [];
    for (const [index, request] of requests.entries()) {
      const sample = request.is_canary
        ? canaryBase
        : shardSamples.find((candidate) => candidate.sample_id === request.sample_id);
      if (sample === undefined) fail("REALDATA_HOST_RESPONSE");
      const entry = validateHostResponse(responses[index], request, sample, {
        hostSha256: input.expectedShardHostSha256,
        startup: initial.startup,
      });
      const priorCandidateIdentity = candidateIdentityByLanguage.get(entry.language);
      if (priorCandidateIdentity === undefined) candidateIdentityByLanguage.set(entry.language, entry.candidate_identity_sha256);
      else if (priorCandidateIdentity !== entry.candidate_identity_sha256) fail("REALDATA_HOST_IDENTITY");
      const priorCandidateParameter = candidateParameterByLanguage.get(entry.language);
      if (priorCandidateParameter === undefined) candidateParameterByLanguage.set(entry.language, entry.candidate_parameter_sha256);
      else if (priorCandidateParameter !== entry.candidate_parameter_sha256) fail("REALDATA_HOST_IDENTITY");
      const {
        candidate_identity_sha256: _candidateIdentitySha256,
        candidate_parameter_sha256: _candidateParameterSha256,
        ...ledgerEntry
      } = entry;
      responseRows.push({
        request,
        response: responses[index],
        supervisorResource: index === 0 ? shardResult.resourceObservation : undefined,
      });
      if (request.is_canary) {
        canaryCount += 1;
        const digest = entry.final_transcript_sha256;
        const priorDigest = canaryTranscriptByLanguage.get(request.language);
        if (priorDigest === undefined) canaryTranscriptByLanguage.set(request.language, digest);
        else if (priorDigest !== digest) fail("REALDATA_CANARY_DRIFT");
        const priorIdentity = canaryIdentityByLanguage.get(request.language);
        if (priorIdentity === undefined) canaryIdentityByLanguage.set(request.language, request.canary_identity_sha256);
        else if (priorIdentity !== request.canary_identity_sha256) fail("REALDATA_CANARY_DRIFT");
        shardCanaryIds.push(request.sample_id);
      } else {
        ledgerEntries.push({ ...ledgerEntry, sequence: ledgerEntries.length + 1 });
      }
    }
    shardExecutions.push({
      canary_count: shardCanaryIds.length,
      host_process_fresh: true,
      resource_observation: shardResult.resourceObservation,
      sample_count: shardSamples.length,
      shard_index: shardIndex,
    });
  }
  if (ledgerEntries.length !== SAMPLE_COUNT) fail("REALDATA_SAMPLE_COUNT");
  const monotonicDurationNs = String(dependencies.monotonicNow() - monotonicStart);
  assertDecimal(monotonicDurationNs, "REALDATA_CLOCK");
  const finishedAt = dependencies.now();

  const postRun = await loadExternal(input, dependencies, { includeSnapshot: false });
  assertExternalStable(initial, postRun);

  const candidateIdentitySha256ByLanguage = sortedObjectFromMap(candidateIdentityByLanguage);
  const candidateParameterSha256ByLanguage = sortedObjectFromMap(candidateParameterByLanguage);
  const candidateIdentityJoinSha256 = computeCandidateIdentityJoinSha256(
    candidateIdentitySha256ByLanguage,
    candidateParameterSha256ByLanguage,
  );
  const resourceObservations = buildResourceObservations(responseRows);
  const hardwareEvidenceSha256 = sha256(Buffer.from(encodeCanonicalJsonLine(resourceObservations), "utf8"));
  const ledgerJoins = buildLedgerJoins(input, initial, {
    candidateIdentityJoinSha256,
    hardwareEvidenceSha256,
  });
  const ledger = buildControlledHypothesisLedger({ entries: ledgerEntries, joins: ledgerJoins });
  await dependencies.ledgerPublisher(input.controlledRoot, input.ledgerRelativePath, ledger.bytes);
  const rereadLedger = await dependencies.ledgerReader(input.controlledRoot, input.ledgerRelativePath);
  if (rereadLedger.ledgerSha256 !== ledger.ledgerSha256 || !isDeepStrictEqual(rereadLedger.record.entries, ledgerEntries)) {
    fail("REALDATA_LEDGER_PERSISTED");
  }
  const seal = buildControlledHypothesisLedgerSeal(ledger.bytes);
  await dependencies.sealPublisher(input.controlledRoot, input.sealRelativePath, input.ledgerRelativePath, seal.bytes);
  const rereadSeal = await dependencies.sealReader(input.controlledRoot, input.sealRelativePath, input.ledgerRelativePath);
  if (rereadSeal.sealSha256 !== seal.sealSha256) fail("REALDATA_SEAL_PERSISTED");

  const byId = new Map(initial.snapshot.record.samples.map((sample) => [sample.sample_id, sample]));
  const scores = rereadLedger.record.entries.map((entry) => {
    const sample = byId.get(entry.sample_id);
    if (sample === undefined) fail("REALDATA_SCORE_JOIN");
    return dependencies.scoreTranscript({
      hypothesis: entry.final_transcript,
      language: entry.language,
      reference: sample.reference_text,
      sampleId: entry.sample_id,
      scenario: entry.scenario,
      tier: entry.tier,
    });
  });
  const aggregate = dependencies.aggregateScores(scores);
  dependencies.validateAggregate(aggregate, scores);
  const record = {
    aggregate,
    authority: { ...AUTHORITY },
    clock: {
      finished_at_utc: formatUtcSecond(finishedAt),
      monotonic_clock_domain: "process.hrtime.bigint",
      monotonic_duration_ns: monotonicDurationNs,
      started_at_utc: formatUtcSecond(startedAt),
    },
    corpus_identity: {
      manifest_sha256: initial.snapshot.record.materialization.manifest_sha256,
      sample_count: SAMPLE_COUNT,
      snapshot_sha256: initial.snapshot.sha256,
      text_free_projection_sha256: initial.snapshot.record.materialization.text_free_projection_sha256,
    },
    execution: {
      canary_count: canaryCount,
      canary_identity_sha256_by_language: sortedObjectFromMap(canaryIdentityByLanguage),
      canary_transcript_sha256_by_language: sortedObjectFromMap(canaryTranscriptByLanguage),
      run_resource_observations_sha256: hardwareEvidenceSha256,
      sample_count: SAMPLE_COUNT,
      shard_count: shards.length,
      shards: shardExecutions,
    },
    host_identity: {
      build_attestation_sha256: initial.shardHostAttestation.sha256,
      candidate_identity_join_sha256: candidateIdentityJoinSha256,
      candidate_identity_sha256_by_language: candidateIdentitySha256ByLanguage,
      candidate_parameter_sha256_by_language: candidateParameterSha256ByLanguage,
      executable_sha256: initial.shardHostAttestation.record.executable.sha256,
      source_commit: initial.shardHostAttestation.record.source.commit,
      source_tree_sha256: initial.shardHostAttestation.record.source.tree_sha256,
    },
    kind: KIND,
    ledger_identity: {
      entry_count: SAMPLE_COUNT,
      candidate_identity_join_sha256: candidateIdentityJoinSha256,
      hardware_evidence_sha256: hardwareEvidenceSha256,
      projection_sha256: seal.projectionSha256,
      seal_sha256: seal.sealSha256,
      sha256: ledger.ledgerSha256,
    },
    measurement_status: "measured",
    policy_identity: {
      fleurs_policy_sha256: initial.fleursPolicy.policySha256,
      realdata_policy_sha256: initial.policy.sha256,
    },
    quality_gate_status: "not-assessed",
    readiness_identity: {
      controlled_root_attestation_sha256: initial.readiness.record.controlled_root.attestation_sha256,
      readiness_sha256: initial.readiness.sha256,
    },
    resource_observations: resourceObservations,
    schema_version: EVIDENCE_SCHEMA_VERSION,
    scorer_identity: getAsrScorerProfile(),
    source_identity: {
      commit: input.expectedSourceCommit,
      dataset_id: initial.readiness.record.source.dataset_id,
      revision: initial.readiness.record.source.revision,
      utterance_count: SAMPLE_COUNT,
      source_contract_status: initial.readiness.record.source.source_contract_status,
    },
  };
  const bytes = Buffer.from(encodeCanonicalJsonLine(record), "utf8");
  validateNativeCandidateRealdataShardEvidenceRecord(bytes);
  const finalPostflight = await loadExternal(input, dependencies, { includeSnapshot: false });
  assertExternalStable(initial, finalPostflight);
  await dependencies.finalPublisher(input.finalEvidencePath, bytes);
  const persisted = await readStableFile(input.finalEvidencePath, "REALDATA_FINAL_PERSISTED", MAX_JSON_BYTES);
  const validated = validateNativeCandidateRealdataShardEvidenceRecord(persisted);
  if (!persisted.equals(bytes)) fail("REALDATA_FINAL_PERSISTED");
  return validated;
}

const PRODUCTION_DEPENDENCIES = Object.freeze({
  aggregateScores: aggregateDescriptiveAsrScores,
  controlledRootIdentityReader: (input, readiness) => attestFormalRunControlledRootIdentity({
    controlledRoot: input.controlledRoot,
    expectedPolicySha256: input.expectedFormalPolicySha256,
    expectedRetentionExpiresAt: readiness.record.retention.expires_at,
    retentionExpiresAt: readiness.record.retention.expires_at,
  }),
  finalPublisher: publishFinalEvidence,
  invokeShardHost: invokeShardHostWithSpawn,
  ledgerPublisher: publishControlledHypothesisLedger,
  ledgerReader: readControlledHypothesisLedger,
  monotonicNow: () => process.hrtime.bigint(),
  now: () => new Date(),
  policyReader: readPinnedPolicy,
  scoreTranscript: scoreAsrTranscript,
  sealPublisher: publishControlledHypothesisLedgerSeal,
  sealReader: readControlledHypothesisLedgerSeal,
  sampleChildResources: sampleWindowsChildResources,
  shardHostBuildAttestationReader: (input) => readPinnedQualityShardHostSourceBuildAttestation({
    attestationPath: input.shardHostBuildAttestationPath,
    expectedAttestationSha256: input.expectedShardHostBuildAttestationSha256,
    expectedExecutableSha256: input.expectedShardHostSha256,
    expectedSourceCommit: input.expectedSourceCommit,
  }),
  snapshotReader: readPinnedSnapshot,
  snapshotIdentityReader: readPinnedSnapshotIdentity,
  validateAggregate: validateDescriptiveAsrAggregate,
});

export async function runNativeCandidateRealdataShardEvaluation(input) {
  return runCore(input, PRODUCTION_DEPENDENCIES);
}

export async function __runNativeCandidateRealdataShardEvaluationForTest(input, dependencies = {}) {
  return runCore(input, { ...PRODUCTION_DEPENDENCIES, ...dependencies });
}

export function __invokeShardHostWithSpawnForTest(options) {
  return invokeShardHostWithSpawn(options);
}

export function __readPinnedRealdataPolicyForTest(input) {
  return readPinnedPolicy(input);
}

export async function validateNativeCandidateRealdataShardEvidenceFile(inputPath) {
  const bytes = await readStableFile(inputPath, "REALDATA_EVIDENCE_INPUT", MAX_JSON_BYTES);
  return { bytes, ...validateNativeCandidateRealdataShardEvidenceRecord(bytes) };
}

async function main(args) {
  if (args.length === 2 && args[0] === "--validate") {
    const result = await validateNativeCandidateRealdataShardEvidenceFile(path.resolve(args[1]));
    process.stdout.write(
      `native-candidate-realdata-shard-evidence=verified evidence_sha256=${result.evidenceSha256} samples=${result.record.execution.sample_count} shards=${result.record.execution.shard_count} measurement_status=measured quality_gate_status=not-assessed formal_claims=none production_evidence=false public_distribution=false\n`,
    );
    return;
  }
  if (args.length === 2 && args[0] === "--run") {
    const input = parseCanonicalLine(await readFile(path.resolve(args[1])), "REALDATA_INPUT_CANONICAL");
    const result = await runNativeCandidateRealdataShardEvaluation(input);
    process.stdout.write(
      `native-candidate-realdata-shard-run=verified evidence_sha256=${result.evidenceSha256} samples=${result.record.execution.sample_count} shards=${result.record.execution.shard_count} measurement_status=measured quality_gate_status=not-assessed formal_claims=none production_evidence=false public_distribution=false\n`,
    );
    return;
  }
  fail("REALDATA_USAGE");
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof NativeCandidateRealdataShardRunnerError ? error.code : "REALDATA_INTERNAL"}\n`);
    process.exitCode = 1;
  });
}
