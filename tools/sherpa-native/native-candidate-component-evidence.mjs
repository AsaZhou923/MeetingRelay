import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { link, lstat, open, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { encodeCanonicalJsonLine } from "../phase0-harness/canonical-json.mjs";
import { materializeQualityCorpus } from "./quality-corpus.mjs";

const KIND = "meetingrelay-native-candidate-component-evidence-v1";
const HOST_KIND = "meetingrelay-native-candidate-quality-sample-v1";
const VERSION = "1.0";
const CANDIDATE_ID = "sherpa-native-sensevoice-int8-2024-07-17-win-x64-cpu";
const RESOURCE_REASON = "SHERPA_QUALITY_RESOURCE_SAMPLING_UNAVAILABLE";
const PARAMETER_SHA256_BY_LANGUAGE = Object.freeze({
  en: "f411caf1efd92b18b953c3bfd0bf6a4eb49d18068554ce9e70d8a493d325065d",
  ja: "946af178a84c720f928d08ed084fe37625a57447b2ad8e8dc5d36034ea319bf5",
  zh: "0ac8669e387262648fcf05fd301a9ba798bb2822e56ec952f1e17d6c692f802e",
});
const DIGEST = /^[0-9a-f]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9._-]{1,128}$/u;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/u;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const MAX_U64 = (1n << 64n) - 1n;
const MAX_RECORD_BYTES = 64 * 1024 * 1024;
const MAX_WAV_BYTES = 64 * 1024 * 1024;
const MAX_EXECUTION_HOST_BYTES = 64 * 1024 * 1024;
const MAX_SCHEMA_REGISTRY_BYTES = 4 * 1024 * 1024;
const MAX_PCM_SAMPLE_COUNT = (MAX_WAV_BYTES - 44) / 2;
const MAX_CORPUS_MATERIAL_BYTES = 512n * 1024n * 1024n;
const MAX_CORPUS_SAMPLES = 1_000;
const LIMITATIONS = Object.freeze([
  "synthetic-contract-foundation-does-not-assess-model-quality",
  "native-hypothesis-content-not-collected-or-scored",
  "candidate-source-and-hardware-artifacts-not-directly-materialized",
  "resource-sampling-unavailable",
  "publication-retains-auditable-create-new-staging-residue",
  "spawn-path-toctou-not-eliminated-by-node-supervisor",
  "thresholds-not-frozen",
  "ranking-selection-default-and-parent-closeout-not-authorized",
]);
const ASSESSMENT = Object.freeze({
  default_status: "not-authorized",
  parent_closeout_status: "not-assessed",
  quality_status: "not-assessed",
  ranking_status: "not-authorized",
  selection_status: "not-authorized",
  threshold_status: "not-frozen",
});
const AUTHORITY = Object.freeze({ formal_claims: "none", production_evidence: false });

const CANDIDATE_KEYS = Object.freeze([
  "asset_lock_sha256", "candidate_id", "model_sha256",
  "package_lock_sha256", "parameter_sha256", "runtime_bundle_sha256",
  "tokens_sha256",
]);
const HOST_IDENTITY_KEYS = Object.freeze(["executable_sha256", "schema_registry_sha256"]);
const CANDIDATE_IDENTITY_KEYS = Object.freeze([
  ...CANDIDATE_KEYS, "candidate_manifest_sha256", "measured_evidence_sha256",
  "parameter_sha256_by_language", "baseline_execution_host",
]);
const HOST_ROOT_KEYS = Object.freeze([
  "authority", "candidate", "execution", "host", "kind", "resources", "rtf", "sample", "schema_version",
]);
const HOST_EXECUTION_KEYS = Object.freeze([
  "backend_execute_calls", "execute_elapsed_ns", "final_transcript_sha256",
  "final_transcript_utf8_bytes", "fresh_process_per_sample", "prepare_elapsed_ns",
]);
const HOST_RESOURCE_KEYS = Object.freeze([
  "cpu_time_ns", "gpu_time_ns", "peak_ram_bytes", "peak_vram_bytes", "reason", "status",
]);
const HOST_SAMPLE_KEYS = Object.freeze([
  "channels", "language", "pcm_bytes", "pcm_sample_count", "pcm_sha256",
  "reference_sha256", "sample_id", "sample_identity_sha256", "sample_rate_hz",
  "wav_sha256", "wav_size_bytes",
]);
const RTF_KEYS = Object.freeze(["denominator_audio_ns", "numerator_execute_ns"]);
const RESULT_KEYS = Object.freeze([
  "attempt", "candidate_parameter_sha256", "execute_elapsed_ns", "final_transcript_sha256", "final_transcript_utf8_bytes",
  "host_record_sha256", "language", "prepare_elapsed_ns", "resources", "rtf",
  "sample_id", "sample_identity_sha256", "scenario", "sequence", "split", "tier",
]);
const RESULT_RESOURCE_KEYS = Object.freeze(["reason", "status"]);
const ROOT_KEYS = Object.freeze([
  "assessment_status", "authority", "candidate_identity", "corpus_identity", "kind",
  "execution_host_identity", "limitations", "results", "schema_version",
]);
const CORPUS_IDENTITY_KEYS = Object.freeze(["manifest_sha256", "sample_count", "snapshot_sha256", "validation_date"]);
const RUN_INPUT_KEYS = Object.freeze([
  "assetLockPath", "corpusInput", "executablePath", "modelPath", "outputEvidencePath",
  "packageLockPath", "runtimeLibDir", "schemaRegistryPath", "tokensPath",
]);

export class NativeCandidateComponentEvidenceError extends Error {
  constructor(code, options = {}) {
    super(code, options);
    this.name = "NativeCandidateComponentEvidenceError";
    this.code = code;
  }
}

function fail(code, options = {}) {
  throw new NativeCandidateComponentEvidenceError(code, options);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function exactKeys(value, expected, code) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(code);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) fail(code);
}

function assertDigest(value, code) {
  if (typeof value !== "string" || !DIGEST.test(value) || value === "0".repeat(64)) fail(code);
}

function assertIdentifier(value, code) {
  if (typeof value !== "string" || !IDENTIFIER.test(value) || value !== value.normalize("NFC")) fail(code);
}

function assertDate(value, code) {
  if (typeof value !== "string" || !DATE.test(value)) fail(code);
  const instant = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(instant.getTime()) || instant.toISOString().slice(0, 10) !== value) fail(code);
}

function decimalBigInt(value, code) {
  if (typeof value !== "string" || value.length > 20 || !DECIMAL.test(value)) fail(code);
  const parsed = BigInt(value);
  if (parsed > MAX_U64) fail(code);
  return parsed;
}

function parseCanonicalLine(bytes, code) {
  if (
    !Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_RECORD_BYTES ||
    bytes.at(-1) !== 0x0a || bytes.includes(0x0d)
  ) {
    fail(code);
  }
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) fail(code);
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    fail(code);
  }
  if (encodeCanonicalJsonLine(value) !== text) fail(code);
  return value;
}

function validateCandidate(candidate, code) {
  exactKeys(candidate, CANDIDATE_KEYS, code);
  if (candidate.candidate_id !== CANDIDATE_ID) fail(code);
  for (const key of CANDIDATE_KEYS.filter((key) => key.endsWith("sha256"))) assertDigest(candidate[key], code);
  return structuredClone(candidate);
}

function validateHostIdentity(host, code) {
  exactKeys(host, HOST_IDENTITY_KEYS, code);
  for (const key of HOST_IDENTITY_KEYS) assertDigest(host[key], code);
  return structuredClone(host);
}

function validateCandidateJoin(join) {
  exactKeys(join, ["baselineExecutionHost", "candidate", "candidateManifestSha256", "executionHost", "measuredEvidenceSha256"], "COMPONENT_CANDIDATE_JOIN");
  const candidate = validateCandidate(join.candidate, "COMPONENT_CANDIDATE_JOIN");
  if (candidate.parameter_sha256 !== PARAMETER_SHA256_BY_LANGUAGE.zh) fail("COMPONENT_CANDIDATE_JOIN");
  const baselineExecutionHost = validateHostIdentity(join.baselineExecutionHost, "COMPONENT_CANDIDATE_JOIN");
  const executionHost = validateHostIdentity(join.executionHost, "COMPONENT_CANDIDATE_JOIN");
  assertDigest(join.candidateManifestSha256, "COMPONENT_CANDIDATE_JOIN");
  assertDigest(join.measuredEvidenceSha256, "COMPONENT_CANDIDATE_JOIN");
  return {
    baselineExecutionHost,
    candidate,
    candidateManifestSha256: join.candidateManifestSha256,
    executionHost,
    measuredEvidenceSha256: join.measuredEvidenceSha256,
  };
}

function candidateForLanguage(candidate, language) {
  return { ...candidate, parameter_sha256: PARAMETER_SHA256_BY_LANGUAGE[language] };
}

function sampleIdentitySha256(sample) {
  const preimage = JSON.stringify({
    language: sample.language,
    pcm_sha256: sample.pcmSha256,
    reference_sha256: sample.referenceSha256,
    sample_id: sample.sampleId,
    wav_sha256: sample.wavSha256,
    wav_size_bytes: sample.wavSizeBytes,
  });
  return sha256(Buffer.from(preimage, "utf8"));
}

function validateMaterializedCorpus(corpus) {
  if (corpus === null || typeof corpus !== "object" || !Array.isArray(corpus.samples)) fail("COMPONENT_CORPUS");
  assertDigest(corpus.manifestSha256, "COMPONENT_CORPUS");
  assertDigest(corpus.snapshotSha256, "COMPONENT_CORPUS");
  assertDate(corpus.validationDate, "COMPONENT_CORPUS");
  if (corpus.samples.length < 1 || corpus.samples.length > MAX_CORPUS_SAMPLES) fail("COMPONENT_CORPUS");
  const seen = new Set();
  let previousSampleId;
  let cumulativeBytes = 0n;
  const samples = corpus.samples.map((sample) => {
    if (
      sample === null || typeof sample !== "object" ||
      !["en", "ja", "zh"].includes(sample.language) ||
      sample.tier !== "tier-1" ||
      !["blind", "calibration", "dev"].includes(sample.split) ||
      !Number.isSafeInteger(sample.durationSamples) || sample.durationSamples <= 0 ||
      sample.durationSamples > MAX_PCM_SAMPLE_COUNT ||
      sample.sampleRateHz !== 16_000 ||
      !Number.isSafeInteger(sample.wavSizeBytes) || sample.wavSizeBytes <= 44 ||
      sample.wavSizeBytes > MAX_WAV_BYTES || sample.wavSizeBytes !== 44 + sample.durationSamples * 2 ||
      !isCanonicalLocalAbsolutePath(sample.wavPath) ||
      !Buffer.isBuffer(sample.wavBytes) || sample.wavBytes.length !== sample.wavSizeBytes ||
      !Buffer.isBuffer(sample.licenseBytes) ||
      !(sample.consentBytes === null || Buffer.isBuffer(sample.consentBytes)) ||
      typeof sample.referenceText !== "string" ||
      Buffer.byteLength(sample.referenceText, "utf8") < 1 ||
      Buffer.byteLength(sample.referenceText, "utf8") > MAX_WAV_BYTES ||
      Buffer.from(sample.referenceText, "utf8").toString("utf8") !== sample.referenceText ||
      sample.referenceText !== sample.referenceText.normalize("NFC") ||
      sample.referenceText.startsWith("\ufeff") || sample.referenceText.includes("\0") ||
      sample.referenceText.includes("\r") || sample.referenceText.includes("\n")
    ) {
      fail("COMPONENT_CORPUS");
    }
    assertIdentifier(sample.sampleId, "COMPONENT_CORPUS");
    assertIdentifier(sample.leakageGroupId, "COMPONENT_CORPUS");
    assertIdentifier(sample.scenario, "COMPONENT_CORPUS");
    for (const digest of [sample.pcmSha256, sample.referenceSha256, sample.wavSha256]) assertDigest(digest, "COMPONENT_CORPUS");
    if (seen.has(sample.sampleId)) fail("COMPONENT_CORPUS");
    if (previousSampleId !== undefined && previousSampleId > sample.sampleId) fail("COMPONENT_CORPUS");
    seen.add(sample.sampleId);
    previousSampleId = sample.sampleId;
    cumulativeBytes += BigInt(sample.wavBytes.length + sample.licenseBytes.length + Buffer.byteLength(sample.referenceText, "utf8") + (sample.consentBytes?.length ?? 0));
    if (cumulativeBytes > MAX_CORPUS_MATERIAL_BYTES) fail("COMPONENT_CORPUS");
    return sample;
  });
  return {
    comparable: {
      manifestSha256: corpus.manifestSha256,
      samples: samples.map((sample) => ({
        durationSamples: sample.durationSamples,
        language: sample.language,
        leakageGroupId: sample.leakageGroupId,
        pcmSha256: sample.pcmSha256,
        referenceSha256: sample.referenceSha256,
        sampleId: sample.sampleId,
        sampleRateHz: sample.sampleRateHz,
        scenario: sample.scenario,
        split: sample.split,
        tier: sample.tier,
        wavSha256: sample.wavSha256,
        wavSizeBytes: sample.wavSizeBytes,
      })),
      snapshotSha256: corpus.snapshotSha256,
      validationDate: corpus.validationDate,
    },
    manifestSha256: corpus.manifestSha256,
    samples,
    snapshotSha256: corpus.snapshotSha256,
    validationDate: corpus.validationDate,
  };
}

function validateHostRecord(bytes, sample, expectedCandidate) {
  const record = parseCanonicalLine(bytes, "COMPONENT_HOST_CANONICAL");
  exactKeys(record, HOST_ROOT_KEYS, "COMPONENT_HOST_FIELDS");
  exactKeys(record.authority, ["formal_claims", "production_evidence"], "COMPONENT_HOST_AUTHORITY");
  if (!isDeepStrictEqual(record.authority, AUTHORITY)) fail("COMPONENT_HOST_AUTHORITY");
  const hostCandidate = validateCandidate(record.candidate, "COMPONENT_HOST_CANDIDATE_JOIN");
  if (!isDeepStrictEqual(hostCandidate, candidateForLanguage(expectedCandidate.candidate, sample.language))) fail("COMPONENT_HOST_CANDIDATE_JOIN");
  exactKeys(record.execution, HOST_EXECUTION_KEYS, "COMPONENT_HOST_EXECUTION");
  const executeElapsed = decimalBigInt(record.execution.execute_elapsed_ns, "COMPONENT_HOST_EXECUTION");
  decimalBigInt(record.execution.prepare_elapsed_ns, "COMPONENT_HOST_EXECUTION");
  decimalBigInt(record.execution.final_transcript_utf8_bytes, "COMPONENT_HOST_EXECUTION");
  assertDigest(record.execution.final_transcript_sha256, "COMPONENT_HOST_EXECUTION");
  if (record.execution.backend_execute_calls !== 1 || record.execution.fresh_process_per_sample !== true) fail("COMPONENT_HOST_EXECUTION");
  const hostIdentity = validateHostIdentity(record.host, "COMPONENT_HOST_IDENTITY_JOIN");
  if (!isDeepStrictEqual(hostIdentity, expectedCandidate.executionHost)) fail("COMPONENT_HOST_IDENTITY_JOIN");
  exactKeys(record.resources, HOST_RESOURCE_KEYS, "COMPONENT_HOST_RESOURCES");
  if (
    record.resources.cpu_time_ns !== null || record.resources.gpu_time_ns !== null ||
    record.resources.peak_ram_bytes !== null || record.resources.peak_vram_bytes !== null ||
    record.resources.reason !== RESOURCE_REASON || record.resources.status !== "unavailable"
  ) {
    fail("COMPONENT_HOST_RESOURCES");
  }
  exactKeys(record.rtf, RTF_KEYS, "COMPONENT_HOST_RTF");
  const denominator = decimalBigInt(record.rtf.denominator_audio_ns, "COMPONENT_HOST_RTF");
  const numerator = decimalBigInt(record.rtf.numerator_execute_ns, "COMPONENT_HOST_RTF");
  if (denominator !== BigInt(sample.durationSamples) * 62_500n || numerator !== executeElapsed) fail("COMPONENT_HOST_RTF");
  exactKeys(record.sample, HOST_SAMPLE_KEYS, "COMPONENT_HOST_SAMPLE_JOIN");
  for (const key of ["pcm_sha256", "reference_sha256", "sample_identity_sha256", "wav_sha256"]) assertDigest(record.sample[key], "COMPONENT_HOST_SAMPLE_JOIN");
  if (
    record.sample.channels !== 1 || record.sample.language !== sample.language ||
    record.sample.pcm_bytes !== String(sample.durationSamples * 2) ||
    record.sample.pcm_sample_count !== String(sample.durationSamples) ||
    record.sample.pcm_sha256 !== sample.pcmSha256 ||
    record.sample.reference_sha256 !== sample.referenceSha256 ||
    record.sample.sample_id !== sample.sampleId ||
    record.sample.sample_identity_sha256 !== sampleIdentitySha256(sample) ||
    record.sample.sample_rate_hz !== sample.sampleRateHz ||
    record.sample.wav_sha256 !== sample.wavSha256 ||
    record.sample.wav_size_bytes !== String(sample.wavSizeBytes)
  ) {
    fail("COMPONENT_HOST_SAMPLE_JOIN");
  }
  if (record.kind !== HOST_KIND || record.schema_version !== VERSION) fail("COMPONENT_HOST_FIELDS");
  return { record, recordSha256: sha256(bytes) };
}

function validateAssessment(value) {
  exactKeys(value, Object.keys(ASSESSMENT), "COMPONENT_EVIDENCE_ASSESSMENT");
  if (!isDeepStrictEqual(value, ASSESSMENT)) fail("COMPONENT_EVIDENCE_ASSESSMENT");
}

function validateEvidenceResult(result, expectedSequence) {
  exactKeys(result, RESULT_KEYS, "COMPONENT_EVIDENCE_RESULT");
  for (const key of ["execute_elapsed_ns", "final_transcript_utf8_bytes", "prepare_elapsed_ns"]) decimalBigInt(result[key], "COMPONENT_EVIDENCE_RESULT");
  for (const key of ["candidate_parameter_sha256", "final_transcript_sha256", "host_record_sha256", "sample_identity_sha256"]) assertDigest(result[key], "COMPONENT_EVIDENCE_RESULT");
  assertIdentifier(result.sample_id, "COMPONENT_EVIDENCE_RESULT");
  assertIdentifier(result.scenario, "COMPONENT_EVIDENCE_RESULT");
  if (
    result.attempt !== 1 || result.sequence !== expectedSequence ||
    !["en", "ja", "zh"].includes(result.language) ||
    result.candidate_parameter_sha256 !== PARAMETER_SHA256_BY_LANGUAGE[result.language] ||
    !["blind", "calibration", "dev"].includes(result.split) ||
    result.tier !== "tier-1"
  ) fail("COMPONENT_EVIDENCE_RESULT");
  exactKeys(result.resources, RESULT_RESOURCE_KEYS, "COMPONENT_EVIDENCE_RESULT");
  if (result.resources.reason !== RESOURCE_REASON || result.resources.status !== "unavailable") fail("COMPONENT_EVIDENCE_RESULT");
  exactKeys(result.rtf, RTF_KEYS, "COMPONENT_EVIDENCE_RESULT");
  const numerator = decimalBigInt(result.rtf.numerator_execute_ns, "COMPONENT_EVIDENCE_RESULT");
  const denominator = decimalBigInt(result.rtf.denominator_audio_ns, "COMPONENT_EVIDENCE_RESULT");
  if (denominator === 0n || numerator !== BigInt(result.execute_elapsed_ns)) fail("COMPONENT_EVIDENCE_RESULT");
}

export function validateNativeCandidateComponentEvidenceRecord(bytes) {
  const record = parseCanonicalLine(bytes, "COMPONENT_EVIDENCE_CANONICAL");
  exactKeys(record, ROOT_KEYS, "COMPONENT_EVIDENCE_FIELDS");
  validateAssessment(record.assessment_status);
  exactKeys(record.authority, ["formal_claims", "production_evidence"], "COMPONENT_EVIDENCE_AUTHORITY");
  if (!isDeepStrictEqual(record.authority, AUTHORITY)) fail("COMPONENT_EVIDENCE_AUTHORITY");
  exactKeys(record.candidate_identity, CANDIDATE_IDENTITY_KEYS, "COMPONENT_EVIDENCE_CANDIDATE");
  const baselineCandidate = validateCandidate(Object.fromEntries(CANDIDATE_KEYS.map((key) => [key, record.candidate_identity[key]])), "COMPONENT_EVIDENCE_CANDIDATE");
  if (baselineCandidate.parameter_sha256 !== PARAMETER_SHA256_BY_LANGUAGE.zh) fail("COMPONENT_EVIDENCE_CANDIDATE");
  exactKeys(record.candidate_identity.parameter_sha256_by_language, ["en", "ja", "zh"], "COMPONENT_EVIDENCE_CANDIDATE");
  if (!isDeepStrictEqual(record.candidate_identity.parameter_sha256_by_language, PARAMETER_SHA256_BY_LANGUAGE)) fail("COMPONENT_EVIDENCE_CANDIDATE");
  validateHostIdentity(record.candidate_identity.baseline_execution_host, "COMPONENT_EVIDENCE_CANDIDATE");
  assertDigest(record.candidate_identity.candidate_manifest_sha256, "COMPONENT_EVIDENCE_CANDIDATE");
  assertDigest(record.candidate_identity.measured_evidence_sha256, "COMPONENT_EVIDENCE_CANDIDATE");
  validateHostIdentity(record.execution_host_identity, "COMPONENT_EVIDENCE_HOST");
  exactKeys(record.corpus_identity, CORPUS_IDENTITY_KEYS, "COMPONENT_EVIDENCE_CORPUS");
  assertDigest(record.corpus_identity.manifest_sha256, "COMPONENT_EVIDENCE_CORPUS");
  assertDigest(record.corpus_identity.snapshot_sha256, "COMPONENT_EVIDENCE_CORPUS");
  assertDate(record.corpus_identity.validation_date, "COMPONENT_EVIDENCE_CORPUS");
  if (!Number.isSafeInteger(record.corpus_identity.sample_count) || record.corpus_identity.sample_count < 1 || record.corpus_identity.sample_count > MAX_CORPUS_SAMPLES) fail("COMPONENT_EVIDENCE_CORPUS");
  if (record.kind !== KIND || record.schema_version !== VERSION || !isDeepStrictEqual(record.limitations, LIMITATIONS)) fail("COMPONENT_EVIDENCE_SCOPE");
  if (!Array.isArray(record.results) || record.results.length !== record.corpus_identity.sample_count) fail("COMPONENT_EVIDENCE_RESULT");
  const seen = new Set();
  let previousSampleId;
  for (const [index, result] of record.results.entries()) {
    validateEvidenceResult(result, index + 1);
    if (seen.has(result.sample_id)) fail("COMPONENT_EVIDENCE_RESULT");
    if (previousSampleId !== undefined && previousSampleId >= result.sample_id) fail("COMPONENT_EVIDENCE_RESULT");
    seen.add(result.sample_id);
    previousSampleId = result.sample_id;
  }
  return { evidenceSha256: sha256(bytes), record };
}

async function assertDirectPathChain(inputPath, finalKind, code) {
  const absolute = path.resolve(inputPath);
  const root = path.parse(absolute).root;
  const segments = path.relative(root, absolute).split(path.sep).filter(Boolean);
  let current = root;
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    let metadata;
    try {
      metadata = await lstat(current);
    } catch {
      fail(code);
    }
    const final = index === segments.length - 1;
    if (
      metadata.isSymbolicLink() || (!final && !metadata.isDirectory()) ||
      (final && finalKind === "file" && !metadata.isFile()) ||
      (final && finalKind === "directory" && !metadata.isDirectory())
    ) {
      fail(code);
    }
  }
  return absolute;
}

function isCanonicalLocalAbsolutePath(value) {
  if (
    typeof value !== "string" || value.length === 0 || value.includes("\0") ||
    /^[\\/]{2}/u.test(value) || !path.isAbsolute(value) || path.normalize(value) !== value ||
    value.normalize("NFC") !== value || path.resolve(value) !== value
  ) {
    return false;
  }
  return !value.slice(path.parse(value).root.length).includes(":");
}

function sameFileIdentity(left, right) {
  return (
    typeof left?.dev === "bigint" && typeof left?.ino === "bigint" &&
    left.dev > 0n && left.ino > 0n && left.dev === right?.dev && left.ino === right?.ino
  );
}

function sameFileSnapshot(left, right) {
  return sameFileIdentity(left, right) && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

async function inspectOutputParent(parentPath, code) {
  const absolute = await assertDirectPathChain(parentPath, "directory", code);
  const snapshot = await lstat(absolute, { bigint: true }).catch(() => fail(code));
  if (!snapshot.isDirectory() || snapshot.isSymbolicLink()) fail(code);
  return { path: absolute, snapshot };
}

async function revalidateOutputParent(material, { allowMetadataChange, code }) {
  const current = await inspectOutputParent(material.path, code);
  if (
    !sameFileIdentity(material.snapshot, current.snapshot) ||
    (!allowMetadataChange && !sameFileSnapshot(material.snapshot, current.snapshot))
  ) {
    fail(code);
  }
  return current;
}

async function inspectOwnedHardLinkPair(stagingPath, outputPath, code) {
  let staging;
  let output;
  try {
    [staging, output] = await Promise.all([
      lstat(stagingPath, { bigint: true }),
      lstat(outputPath, { bigint: true }),
    ]);
  } catch (error) {
    fail(code, { cause: error });
  }
  if (
    !staging.isFile() || staging.isSymbolicLink() ||
    !output.isFile() || output.isSymbolicLink() ||
    !sameFileSnapshot(staging, output)
  ) {
    fail(code);
  }
  return { output, staging };
}

async function inspectStableFile(inputPath, { code, expectedSha256, maxBytes }) {
  const absolute = await assertDirectPathChain(inputPath, "file", code);
  const handle = await open(absolute, "r").catch(() => fail(code));
  try {
    const [pathBefore, handleBefore] = await Promise.all([
      lstat(absolute, { bigint: true }),
      handle.stat({ bigint: true }),
    ]);
    if (
      !pathBefore.isFile() || pathBefore.isSymbolicLink() || !handleBefore.isFile() ||
      !sameFileSnapshot(pathBefore, handleBefore) || handleBefore.size < 1n ||
      handleBefore.size > BigInt(maxBytes)
    ) {
      fail(code);
    }
    const bytes = await handle.readFile();
    const verification = Buffer.alloc(bytes.length);
    let offset = 0;
    while (offset < verification.length) {
      const { bytesRead } = await handle.read(verification, offset, verification.length - offset, offset);
      if (bytesRead === 0) fail(code);
      offset += bytesRead;
    }
    const [pathAfter, handleAfter] = await Promise.all([
      lstat(absolute, { bigint: true }).catch(() => null),
      handle.stat({ bigint: true }),
    ]);
    if (
      pathAfter === null || !sameFileSnapshot(handleBefore, handleAfter) ||
      !sameFileSnapshot(handleBefore, pathAfter) || !verification.equals(bytes) ||
      (expectedSha256 !== undefined && sha256(bytes) !== expectedSha256)
    ) {
      fail(code);
    }
    return { bytes, path: absolute, snapshot: handleBefore };
  } finally {
    await handle.close().catch(() => fail(code));
  }
}

async function revalidateStableFile(material, { code, expectedSha256, maxBytes }) {
  const current = await inspectStableFile(material.path, { code, expectedSha256, maxBytes });
  if (!sameFileSnapshot(material.snapshot, current.snapshot) || !material.bytes.equals(current.bytes)) {
    fail(code);
  }
}

async function assertNewOutputPath(outputPath) {
  if (!isCanonicalLocalAbsolutePath(outputPath)) fail("COMPONENT_EVIDENCE_OUTPUT");
  const resolved = path.resolve(outputPath);
  await assertDirectPathChain(path.dirname(resolved), "directory", "COMPONENT_EVIDENCE_OUTPUT");
  try {
    await lstat(resolved);
  } catch (error) {
    if (error?.code === "ENOENT") return resolved;
    fail("COMPONENT_EVIDENCE_OUTPUT");
  }
  fail("COMPONENT_EVIDENCE_OUTPUT");
}

async function assertOutputPathAbsent(outputPath, code) {
  try {
    await lstat(outputPath);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    fail(code, { cause: error });
  }
  fail(code);
}

export async function publishNativeCandidateComponentEvidence(outputPath, bytes, operations = {}) {
  validateNativeCandidateComponentEvidenceRecord(bytes);
  const resolved = await assertNewOutputPath(outputPath);
  let parentMaterial = await inspectOutputParent(path.dirname(resolved), "COMPONENT_EVIDENCE_OUTPUT_PARENT");
  const suffix = (operations.randomSuffix ?? (() => randomBytes(16).toString("hex")))();
  if (typeof suffix !== "string" || !/^[0-9a-f]{32}$/u.test(suffix)) fail("COMPONENT_EVIDENCE_OUTPUT");
  const stagingPath = path.join(path.dirname(resolved), `.${path.basename(resolved)}.${suffix}.staging`);
  const openFile = operations.openFile ?? open;
  const linkFile = operations.linkFile ?? link;
  const readFileBytes = operations.readFileBytes ?? readFile;
  const beforeLink = operations.beforeLink ?? (async () => {});
  const afterLinkBeforeRead = operations.afterLinkBeforeRead ?? (async () => {});
  const afterPersistedRead = operations.afterPersistedRead ?? (async () => {});
  let handle;
  let stagingIdentity;
  let completed = false;
  let failure = false;
  try {
    parentMaterial = await revalidateOutputParent(parentMaterial, {
      allowMetadataChange: false,
      code: "COMPONENT_EVIDENCE_OUTPUT_PARENT",
    });
    handle = await openFile(stagingPath, "wx");
    stagingIdentity = await handle.stat({ bigint: true });
    if (!stagingIdentity.isFile() || stagingIdentity.size !== 0n) fail("COMPONENT_EVIDENCE_STAGING");
    parentMaterial = await revalidateOutputParent(parentMaterial, {
      allowMetadataChange: true,
      code: "COMPONENT_EVIDENCE_OUTPUT_PARENT",
    });
    await handle.writeFile(bytes);
    await handle.sync();
    const stagedHandleSnapshot = await handle.stat({ bigint: true });
    if (
      !stagedHandleSnapshot.isFile() || !sameFileIdentity(stagingIdentity, stagedHandleSnapshot) ||
      stagedHandleSnapshot.size !== BigInt(bytes.length)
    ) {
      fail("COMPONENT_EVIDENCE_STAGING");
    }
    await handle.close();
    handle = undefined;
    parentMaterial = await revalidateOutputParent(parentMaterial, {
      allowMetadataChange: false,
      code: "COMPONENT_EVIDENCE_OUTPUT_PARENT",
    });
    const stagedRead = await readFileBytes(stagingPath);
    const stagedMaterial = await inspectStableFile(stagingPath, {
      code: "COMPONENT_EVIDENCE_STAGING",
      expectedSha256: sha256(bytes),
      maxBytes: MAX_RECORD_BYTES,
    });
    if (
      !Buffer.isBuffer(stagedRead) || !stagedRead.equals(bytes) ||
      !stagedMaterial.bytes.equals(bytes) ||
      !sameFileSnapshot(stagedHandleSnapshot, stagedMaterial.snapshot)
    ) {
      fail("COMPONENT_EVIDENCE_STAGING");
    }
    validateNativeCandidateComponentEvidenceRecord(stagedMaterial.bytes);
    await beforeLink({ outputPath: resolved, stagingPath });
    parentMaterial = await revalidateOutputParent(parentMaterial, {
      allowMetadataChange: false,
      code: "COMPONENT_EVIDENCE_OUTPUT_PARENT",
    });
    await assertOutputPathAbsent(resolved, "COMPONENT_EVIDENCE_OUTPUT");
    await linkFile(stagingPath, resolved);
    parentMaterial = await revalidateOutputParent(parentMaterial, {
      allowMetadataChange: true,
      code: "COMPONENT_EVIDENCE_OUTPUT_PARENT",
    });
    const linkedPair = await inspectOwnedHardLinkPair(stagingPath, resolved, "COMPONENT_EVIDENCE_LINK_IDENTITY");
    if (!sameFileIdentity(stagingIdentity, linkedPair.staging)) fail("COMPONENT_EVIDENCE_LINK_IDENTITY");
    await afterLinkBeforeRead({ outputPath: resolved, stagingPath });
    parentMaterial = await revalidateOutputParent(parentMaterial, {
      allowMetadataChange: false,
      code: "COMPONENT_EVIDENCE_OUTPUT_PARENT",
    });
    const beforePersistedRead = await inspectOwnedHardLinkPair(stagingPath, resolved, "COMPONENT_EVIDENCE_PERSISTED_IDENTITY");
    const persistedRead = await readFileBytes(resolved);
    const persistedMaterial = await inspectStableFile(resolved, {
      code: "COMPONENT_EVIDENCE_PERSISTED",
      expectedSha256: sha256(bytes),
      maxBytes: MAX_RECORD_BYTES,
    });
    const afterPersistedReadPair = await inspectOwnedHardLinkPair(stagingPath, resolved, "COMPONENT_EVIDENCE_PERSISTED_IDENTITY");
    if (
      !sameFileSnapshot(beforePersistedRead.staging, afterPersistedReadPair.staging) ||
      !sameFileSnapshot(beforePersistedRead.output, afterPersistedReadPair.output) ||
      !sameFileSnapshot(persistedMaterial.snapshot, afterPersistedReadPair.output) ||
      !Buffer.isBuffer(persistedRead) || !persistedRead.equals(bytes) ||
      !persistedMaterial.bytes.equals(bytes)
    ) {
      fail("COMPONENT_EVIDENCE_PERSISTED");
    }
    validateNativeCandidateComponentEvidenceRecord(persistedMaterial.bytes);
    await afterPersistedRead({ outputPath: resolved, stagingPath });
    parentMaterial = await revalidateOutputParent(parentMaterial, {
      allowMetadataChange: false,
      code: "COMPONENT_EVIDENCE_OUTPUT_PARENT",
    });
    const preFinalPair = await inspectOwnedHardLinkPair(stagingPath, resolved, "COMPONENT_EVIDENCE_PERSISTED_IDENTITY");
    if (!sameFileIdentity(stagingIdentity, preFinalPair.staging)) fail("COMPONENT_EVIDENCE_PERSISTED_IDENTITY");
    const finalMaterial = await inspectStableFile(resolved, {
      code: "COMPONENT_EVIDENCE_FINAL_IDENTITY",
      expectedSha256: sha256(bytes),
      maxBytes: MAX_RECORD_BYTES,
    });
    if (!sameFileIdentity(stagingIdentity, finalMaterial.snapshot) || !finalMaterial.bytes.equals(bytes)) {
      fail("COMPONENT_EVIDENCE_FINAL_IDENTITY");
    }
    validateNativeCandidateComponentEvidenceRecord(finalMaterial.bytes);
    completed = true;
  } catch {
    failure = true;
  } finally {
    if (handle !== undefined) {
      try { await handle.close(); } catch { failure = true; }
    }
  }
  if (failure || !completed) fail("COMPONENT_EVIDENCE_OUTPUT");
  return resolved;
}

async function readValidatedNativeCandidateComponentEvidenceFile(inputPath) {
  const material = await inspectStableFile(inputPath, {
    code: "COMPONENT_EVIDENCE_INPUT",
    maxBytes: MAX_RECORD_BYTES,
  });
  return { bytes: material.bytes, ...validateNativeCandidateComponentEvidenceRecord(material.bytes) };
}

export async function validateNativeCandidateComponentEvidenceFile(inputPath) {
  const { bytes: _bytes, ...validated } = await readValidatedNativeCandidateComponentEvidenceFile(inputPath);
  return validated;
}

function invokeHost(executablePath, argv) {
  return new Promise((resolve, reject) => {
    execFile(executablePath, argv, {
      encoding: null,
      maxBuffer: 4 * 1024 * 1024,
      shell: false,
      timeout: 10 * 60 * 1000,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error !== null || !Buffer.isBuffer(stdout) || !Buffer.isBuffer(stderr) || stderr.length !== 0) {
        reject(new NativeCandidateComponentEvidenceError("COMPONENT_HOST_PROCESS"));
        return;
      }
      resolve(stdout);
    });
  });
}

function validateRunInput(input) {
  exactKeys(input, RUN_INPUT_KEYS, "COMPONENT_RUN_INPUT");
  const normalized = { corpusInput: input.corpusInput };
  for (const key of RUN_INPUT_KEYS.filter((key) => key !== "corpusInput")) {
    const value = input[key];
    if (!isCanonicalLocalAbsolutePath(value)) {
      fail("COMPONENT_RUN_INPUT");
    }
    normalized[key] = value;
  }
  return normalized;
}

function buildArgv(input, sample) {
  return [
    input.schemaRegistryPath,
    input.modelPath,
    input.tokensPath,
    input.runtimeLibDir,
    input.assetLockPath,
    input.packageLockPath,
    sample.sampleId,
    sample.language,
    sample.wavPath,
    String(sample.wavSizeBytes),
    sample.wavSha256,
    sample.pcmSha256,
    sample.referenceSha256,
  ];
}

async function runCore(input, dependencies) {
  const runInput = validateRunInput(input);
  const corpusLoader = dependencies.corpusLoader ?? materializeQualityCorpus;
  const candidateJoinLoader = dependencies.candidateJoinLoader;
  const sampleRunner = dependencies.sampleRunner ?? (({ argv, executablePath }) => invokeHost(executablePath, argv));
  const publishEvidence = dependencies.publishEvidence ?? publishNativeCandidateComponentEvidence;
  if (typeof corpusLoader !== "function" || typeof candidateJoinLoader !== "function" || typeof sampleRunner !== "function" || typeof publishEvidence !== "function") fail("COMPONENT_RUN_DEPENDENCY");
  await assertNewOutputPath(runInput.outputEvidencePath);
  const corpus = validateMaterializedCorpus(await corpusLoader(runInput.corpusInput));
  const candidateJoin = validateCandidateJoin(await candidateJoinLoader(runInput));
  const [executionHostMaterial, schemaRegistryMaterial] = await Promise.all([
    inspectStableFile(runInput.executablePath, {
      code: "COMPONENT_EXECUTION_HOST_IDENTITY",
      expectedSha256: candidateJoin.executionHost.executable_sha256,
      maxBytes: MAX_EXECUTION_HOST_BYTES,
    }),
    inspectStableFile(runInput.schemaRegistryPath, {
      code: "COMPONENT_SCHEMA_REGISTRY_IDENTITY",
      expectedSha256: candidateJoin.executionHost.schema_registry_sha256,
      maxBytes: MAX_SCHEMA_REGISTRY_BYTES,
    }),
  ]);
  const revalidateExecutionInputs = () => Promise.all([
    revalidateStableFile(executionHostMaterial, {
      code: "COMPONENT_EXECUTION_HOST_POSTFLIGHT",
      expectedSha256: candidateJoin.executionHost.executable_sha256,
      maxBytes: MAX_EXECUTION_HOST_BYTES,
    }),
    revalidateStableFile(schemaRegistryMaterial, {
      code: "COMPONENT_SCHEMA_REGISTRY_POSTFLIGHT",
      expectedSha256: candidateJoin.executionHost.schema_registry_sha256,
      maxBytes: MAX_SCHEMA_REGISTRY_BYTES,
    }),
  ]);
  const results = [];
  for (const sample of corpus.samples) {
    await assertNewOutputPath(runInput.outputEvidencePath);
    await revalidateExecutionInputs();
    const bytes = await sampleRunner({ argv: buildArgv(runInput, sample), executablePath: executionHostMaterial.path, sample });
    const host = validateHostRecord(bytes, sample, candidateJoin);
    await revalidateExecutionInputs();
    const [postCorpus, postJoin] = await Promise.all([
      corpusLoader(runInput.corpusInput).then(validateMaterializedCorpus),
      candidateJoinLoader(runInput).then(validateCandidateJoin),
    ]);
    if (!isDeepStrictEqual(postCorpus.comparable, corpus.comparable)) fail("COMPONENT_CORPUS_POSTFLIGHT");
    if (!isDeepStrictEqual(postJoin, candidateJoin)) fail("COMPONENT_CANDIDATE_POSTFLIGHT");
    results.push({
      attempt: 1,
      candidate_parameter_sha256: host.record.candidate.parameter_sha256,
      execute_elapsed_ns: host.record.execution.execute_elapsed_ns,
      final_transcript_sha256: host.record.execution.final_transcript_sha256,
      final_transcript_utf8_bytes: host.record.execution.final_transcript_utf8_bytes,
      host_record_sha256: host.recordSha256,
      language: sample.language,
      prepare_elapsed_ns: host.record.execution.prepare_elapsed_ns,
      resources: { reason: RESOURCE_REASON, status: "unavailable" },
      rtf: { ...host.record.rtf },
      sample_id: sample.sampleId,
      sample_identity_sha256: host.record.sample.sample_identity_sha256,
      scenario: sample.scenario,
      sequence: results.length + 1,
      split: sample.split,
      tier: sample.tier,
    });
  }
  const evidence = {
    assessment_status: { ...ASSESSMENT },
    authority: { ...AUTHORITY },
    candidate_identity: {
      ...candidateJoin.candidate,
      baseline_execution_host: { ...candidateJoin.baselineExecutionHost },
      candidate_manifest_sha256: candidateJoin.candidateManifestSha256,
      measured_evidence_sha256: candidateJoin.measuredEvidenceSha256,
      parameter_sha256_by_language: { ...PARAMETER_SHA256_BY_LANGUAGE },
    },
    corpus_identity: {
      manifest_sha256: corpus.manifestSha256,
      sample_count: corpus.samples.length,
      snapshot_sha256: corpus.snapshotSha256,
      validation_date: corpus.validationDate,
    },
    kind: KIND,
    execution_host_identity: { ...candidateJoin.executionHost },
    limitations: [...LIMITATIONS],
    results,
    schema_version: VERSION,
  };
  const evidenceBytes = Buffer.from(encodeCanonicalJsonLine(evidence), "utf8");
  validateNativeCandidateComponentEvidenceRecord(evidenceBytes);
  await revalidateExecutionInputs();
  await publishEvidence(runInput.outputEvidencePath, evidenceBytes);
  const persisted = await readValidatedNativeCandidateComponentEvidenceFile(runInput.outputEvidencePath);
  if (
    !persisted.bytes.equals(evidenceBytes) ||
    persisted.evidenceSha256 !== sha256(evidenceBytes) ||
    !isDeepStrictEqual(persisted.record, evidence)
  ) {
    fail("COMPONENT_EVIDENCE_PERSISTED");
  }
  return { evidenceSha256: persisted.evidenceSha256, record: persisted.record };
}

export async function runNativeCandidateComponentEvidence(input, { candidateJoinLoader }) {
  return runCore(input, { candidateJoinLoader });
}

export async function __runNativeCandidateComponentEvidenceForTest(input, dependencies) {
  return runCore(input, dependencies);
}

async function main(arguments_) {
  if (arguments_.length !== 2 || arguments_[0] !== "--validate") fail("COMPONENT_EVIDENCE_USAGE");
  const result = await validateNativeCandidateComponentEvidenceFile(arguments_[1]);
  process.stdout.write(
    `candidate-native-component-evidence-file=verified evidence_sha256=${result.evidenceSha256} samples=${result.record.results.length} formal_claims=none production_evidence=false quality_status=not-assessed threshold_status=not-frozen\n`,
  );
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof NativeCandidateComponentEvidenceError ? error.code : "COMPONENT_EVIDENCE_INTERNAL"}\n`);
    process.exitCode = 1;
  });
}
