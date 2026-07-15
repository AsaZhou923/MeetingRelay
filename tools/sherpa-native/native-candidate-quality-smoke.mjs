import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { link, lstat, open, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { encodeCanonicalJsonLine } from "../phase0-harness/canonical-json.mjs";
import { runReleaseNativeCandidateConformance } from "./validate-candidate-conformance.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(HERE, "../..");
const DEFAULT_REFERENCE_MANIFEST_PATH = path.join(
  HERE,
  "candidate-quality-smoke-reference.json",
);
const EVIDENCE_KIND = "meetingrelay-native-candidate-quality-smoke-evidence-v1";
const REFERENCE_KIND = "meetingrelay-native-candidate-quality-smoke-reference-v1";
const SCHEMA_VERSION = "1.0";
const EXPECTED_REFERENCE_MANIFEST_SHA256 =
  "cc2afff6bc92a6fe6e2b58e15332422dc3ecddae790eac6235fa543e2bd76590";
const EXPECTED_WAV_SHA256 =
  "b77f1794fe374a0ba1ee1dc458bfaf9349496cbbfc32780c50ba3c5a7ad8e373";
const EXPECTED_TRANSCRIPT_SHA256 =
  "3dcf3d55f672e2d610a031580f924b47ddf147ff3d93f007b8386f9bef8cac58";
const EXPECTED_UPSTREAM_COMMIT = "0166495ed093aeb90f42c99da5f7cf91da1e110d";
const EXPECTED_WORKER_ID = "meetingrelay-sherpa-native-candidate-host-v1";
const EXPECTED_TRANSCRIPT_BYTES = Buffer.from(
  "开放时间早上9点至下午5点。",
  "utf8",
);
const MAX_JSON_BYTES = 65_536;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;

const EXPECTED_AUDIO = Object.freeze({
  bits_per_sample: 16,
  channel_count: 1,
  codec: "pcm-s16le",
  data_bytes: 178_944,
  duration_milliseconds: 5_592,
  file_bytes: 178_988,
  sample_frames: 89_472,
  sample_rate_hz: 16_000,
  sha256: EXPECTED_WAV_SHA256,
});
const EXPECTED_TRANSCRIPT = Object.freeze({
  canonical_utf8: "开放时间早上9点至下午5点。",
  reference_role: "upstream-documented-smoke-reference-not-independent-gold",
  sha256: EXPECTED_TRANSCRIPT_SHA256,
  utf8_bytes: 38,
});
const EXPECTED_REDISTRIBUTION = Object.freeze({
  commit_allowed: false,
  distribution_allowed: false,
  fixture_handling: "read-in-place-local-cache-only",
  status: "unresolved",
  upload_allowed: false,
});
const EXPECTED_ARCHIVE = Object.freeze({
  asset_id: 288_366_523,
  file_name:
    "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2",
  sha256: "7d1efa2138a65b0b488df37f8b89e3d91a60676e416f515b952358d83dfd347e",
  size_bytes: 163_002_883,
  source_url:
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2",
});
const EXPECTED_DOCUMENTATION = Object.freeze([
  Object.freeze({
    path: "docs/source/onnx/sense-voice/pretrained.rst",
    role: "documented-archive-and-test-wavs-presence",
    sha256: "f3bf36ad097ef66d03a721502411d77d16dbbbf2a16f7aa3715c92ce9ca4b860",
    source_url:
      "https://github.com/k2-fsa/sherpa/blob/0166495ed093aeb90f42c99da5f7cf91da1e110d/docs/source/onnx/sense-voice/pretrained.rst#L69-L100",
  }),
  Object.freeze({
    path: "docs/source/onnx/sense-voice/code/2024-07-17-itn.txt",
    role: "documented-itn-output",
    sha256: "9c4a2dbdbd365010b4c4d35070326dda83e91b0d5e93e746d132b131aac48bf4",
    source_url:
      "https://github.com/k2-fsa/sherpa/blob/0166495ed093aeb90f42c99da5f7cf91da1e110d/docs/source/onnx/sense-voice/code/2024-07-17-itn.txt#L1-L10",
  }),
  Object.freeze({
    path: "docs/source/onnx/sense-voice/python-api.rst",
    role: "documented-zh-wav-transcript",
    sha256: "18cfa0b7b84735e5229f3243e079ad19b5c896717e538212986d1c9dea5204e9",
    source_url:
      "https://github.com/k2-fsa/sherpa/blob/0166495ed093aeb90f42c99da5f7cf91da1e110d/docs/source/onnx/sense-voice/python-api.rst#L31-L34",
  }),
  Object.freeze({
    path: "docs/source/onnx/sense-voice/pretrained.rst",
    role: "documented-default-language-auto",
    sha256: "f3bf36ad097ef66d03a721502411d77d16dbbbf2a16f7aa3715c92ce9ca4b860",
    source_url:
      "https://github.com/k2-fsa/sherpa/blob/0166495ed093aeb90f42c99da5f7cf91da1e110d/docs/source/onnx/sense-voice/pretrained.rst#L172-L185",
  }),
]);
const LIMITATIONS = Object.freeze([
  "upstream-documented-reference-not-independent-gold",
  "audio-redistribution-rights-unresolved",
  "meetingrelay-locked-zh-not-upstream-parameter-identical",
  "single-reference-exact-match-not-product-quality-assessment",
  "performance-and-resource-usage-not-measured",
  "selection-default-and-parent-closeout-not-authorized",
]);

const ROOT_KEYS = Object.freeze([
  "authority",
  "input_identity",
  "kind",
  "limitations",
  "quality_gate_status",
  "redistribution_status",
  "reference",
  "runs",
  "schema_version",
]);
const AUTHORITY_KEYS = Object.freeze(["formal_claims", "production_evidence"]);
const INPUT_IDENTITY_KEYS = Object.freeze([
  "execution_host_sha256",
  "locked_input_snapshot_sha256",
  "reference_manifest_sha256",
  "schema_registry_sha256",
  "wav_sha256",
]);
const REFERENCE_KEYS = Object.freeze([
  "audio",
  "manifest_sha256",
  "transcript",
  "upstream_repository_commit",
]);
const AUDIO_KEYS = Object.freeze(Object.keys(EXPECTED_AUDIO));
const TRANSCRIPT_KEYS = Object.freeze([
  "match_basis",
  "reference_role",
  "sha256",
  "utf8_bytes",
]);
const RUN_KEYS = Object.freeze([
  "backend_execute_calls",
  "check_summary",
  "conformance_record_sha256",
  "exact_reference_match",
  "final_transcript_sha256",
  "final_transcript_utf8_bytes",
  "fresh_process",
  "input_snapshot_sha256",
  "run_index",
  "worker_id",
]);
const CHECK_SUMMARY_KEYS = Object.freeze(["passed", "total"]);

export class NativeCandidateQualitySmokeError extends Error {
  constructor(code) {
    super(code);
    this.name = "NativeCandidateQualitySmokeError";
    this.code = code;
  }
}

function fail(code) {
  throw new NativeCandidateQualitySmokeError(code);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertDigest(value, code) {
  if (
    typeof value !== "string" ||
    !DIGEST_PATTERN.test(value) ||
    value === "0".repeat(64)
  ) {
    fail(code);
  }
}

function assertExactKeys(value, expected, code) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(code);
  }
  const actual = Object.keys(value);
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    fail(code);
  }
}

function parseCanonicalJsonLine(bytes, code) {
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length === 0 ||
    bytes.length > MAX_JSON_BYTES ||
    bytes.at(-1) !== 0x0a ||
    bytes.includes(0x0d)
  ) {
    fail(code);
  }
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) {
    fail(code);
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    fail(code);
  }
  if (encodeCanonicalJsonLine(value) !== text) {
    fail(code);
  }
  return value;
}

export function validateQualitySmokeReferenceTranscriptBytes(bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.equals(EXPECTED_TRANSCRIPT_BYTES)) {
    fail("QUALITY_SMOKE_TRANSCRIPT_BYTES");
  }
  if (
    bytes.length !== EXPECTED_TRANSCRIPT.utf8_bytes ||
    sha256(bytes) !== EXPECTED_TRANSCRIPT.sha256
  ) {
    fail("QUALITY_SMOKE_TRANSCRIPT_BYTES");
  }
  return { sha256: EXPECTED_TRANSCRIPT.sha256, utf8Bytes: bytes.length };
}

export function inspectPcmS16leWave(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 44) {
    fail("QUALITY_SMOKE_WAV_PCM");
  }
  if (
    bytes.subarray(0, 4).toString("ascii") !== "RIFF" ||
    bytes.readUInt32LE(4) !== bytes.length - 8 ||
    bytes.subarray(8, 12).toString("ascii") !== "WAVE" ||
    bytes.subarray(12, 16).toString("ascii") !== "fmt " ||
    bytes.readUInt32LE(16) !== 16 ||
    bytes.readUInt16LE(20) !== 1 ||
    bytes.subarray(36, 40).toString("ascii") !== "data" ||
    bytes.readUInt32LE(40) !== bytes.length - 44
  ) {
    fail("QUALITY_SMOKE_WAV_PCM");
  }
  const channelCount = bytes.readUInt16LE(22);
  const sampleRateHz = bytes.readUInt32LE(24);
  const byteRate = bytes.readUInt32LE(28);
  const blockAlignBytes = bytes.readUInt16LE(32);
  const bitsPerSample = bytes.readUInt16LE(34);
  const dataBytes = bytes.readUInt32LE(40);
  if (
    channelCount <= 0 ||
    bitsPerSample !== 16 ||
    blockAlignBytes !== channelCount * 2 ||
    byteRate !== sampleRateHz * blockAlignBytes ||
    dataBytes % blockAlignBytes !== 0
  ) {
    fail("QUALITY_SMOKE_WAV_PCM");
  }
  return {
    bitsPerSample,
    channelCount,
    dataBytes,
    sampleFrames: dataBytes / blockAlignBytes,
    sampleRateHz,
  };
}

export function validateQualitySmokeReferenceWavBytes(bytes) {
  const inspected = inspectPcmS16leWave(bytes);
  if (
    bytes.length !== EXPECTED_AUDIO.file_bytes ||
    sha256(bytes) !== EXPECTED_AUDIO.sha256 ||
    inspected.bitsPerSample !== EXPECTED_AUDIO.bits_per_sample ||
    inspected.channelCount !== EXPECTED_AUDIO.channel_count ||
    inspected.dataBytes !== EXPECTED_AUDIO.data_bytes ||
    inspected.sampleFrames !== EXPECTED_AUDIO.sample_frames ||
    inspected.sampleRateHz !== EXPECTED_AUDIO.sample_rate_hz ||
    (inspected.sampleFrames * 1_000) / inspected.sampleRateHz !==
      EXPECTED_AUDIO.duration_milliseconds
  ) {
    fail("QUALITY_SMOKE_WAV_IDENTITY");
  }
  return { ...EXPECTED_AUDIO };
}

export function validateQualitySmokeReferenceManifest(bytes) {
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length === 0 ||
    bytes.length > MAX_JSON_BYTES ||
    bytes.at(-1) !== 0x0a ||
    bytes.includes(0x0d) ||
    sha256(bytes) !== EXPECTED_REFERENCE_MANIFEST_SHA256
  ) {
    fail("QUALITY_SMOKE_REFERENCE_MANIFEST");
  }
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) {
    fail("QUALITY_SMOKE_REFERENCE_MANIFEST");
  }
  let record;
  try {
    record = JSON.parse(text);
  } catch {
    fail("QUALITY_SMOKE_REFERENCE_MANIFEST");
  }
  if (`${JSON.stringify(record, null, 2)}\n` !== text) {
    fail("QUALITY_SMOKE_REFERENCE_MANIFEST");
  }
  validateQualitySmokeReferenceTranscriptBytes(
    Buffer.from(record?.transcript?.canonical_utf8 ?? "", "utf8"),
  );
  if (
    record.kind !== REFERENCE_KIND ||
    record.schema_version !== SCHEMA_VERSION ||
    !isDeepStrictEqual(record.audio, EXPECTED_AUDIO) ||
    !isDeepStrictEqual(record.transcript, EXPECTED_TRANSCRIPT) ||
    !isDeepStrictEqual(record.redistribution, EXPECTED_REDISTRIBUTION) ||
    !isDeepStrictEqual(record.upstream?.archive, EXPECTED_ARCHIVE) ||
    !isDeepStrictEqual(record.upstream?.documentation, EXPECTED_DOCUMENTATION) ||
    record.upstream?.parameter_alignment !==
      "meetingrelay-locked-zh-not-upstream-default-auto" ||
    record.upstream?.repository_commit !== EXPECTED_UPSTREAM_COMMIT ||
    record.upstream?.repository_url !== "https://github.com/k2-fsa/sherpa" ||
    record.upstream?.transcript_match_scope !==
      "upstream-documented-output-not-parameter-identical-reproduction"
  ) {
    fail("QUALITY_SMOKE_REFERENCE_MANIFEST");
  }
  return {
    manifestSha256: EXPECTED_REFERENCE_MANIFEST_SHA256,
    record,
  };
}

function validateEvidenceRun(run, index, inputIdentity) {
  assertExactKeys(run, RUN_KEYS, "QUALITY_SMOKE_EVIDENCE_RUN");
  assertExactKeys(
    run.check_summary,
    CHECK_SUMMARY_KEYS,
    "QUALITY_SMOKE_EVIDENCE_RUN",
  );
  assertDigest(run.conformance_record_sha256, "QUALITY_SMOKE_EVIDENCE_RUN");
  if (
    run.backend_execute_calls !== 1 ||
    run.check_summary.passed !== 12 ||
    run.check_summary.total !== 12 ||
    run.exact_reference_match !== true ||
    run.final_transcript_sha256 !== EXPECTED_TRANSCRIPT_SHA256 ||
    run.final_transcript_utf8_bytes !== EXPECTED_TRANSCRIPT_BYTES.length ||
    run.fresh_process !== true ||
    run.input_snapshot_sha256 !== inputIdentity.locked_input_snapshot_sha256 ||
    run.run_index !== index + 1 ||
    run.worker_id !== EXPECTED_WORKER_ID
  ) {
    fail("QUALITY_SMOKE_EVIDENCE_RUN");
  }
}

export function validateNativeCandidateQualitySmokeEvidenceRecord(bytes) {
  const record = parseCanonicalJsonLine(bytes, "QUALITY_SMOKE_EVIDENCE_CANONICAL");
  assertExactKeys(record, ROOT_KEYS, "QUALITY_SMOKE_EVIDENCE_SCHEMA");
  assertExactKeys(record.authority, AUTHORITY_KEYS, "QUALITY_SMOKE_EVIDENCE_AUTHORITY");
  if (
    record.authority.formal_claims !== "none" ||
    record.authority.production_evidence !== false
  ) {
    fail("QUALITY_SMOKE_EVIDENCE_AUTHORITY");
  }
  assertExactKeys(
    record.input_identity,
    INPUT_IDENTITY_KEYS,
    "QUALITY_SMOKE_EVIDENCE_INPUT",
  );
  for (const key of INPUT_IDENTITY_KEYS) {
    assertDigest(record.input_identity[key], "QUALITY_SMOKE_EVIDENCE_INPUT");
  }
  if (
    record.input_identity.reference_manifest_sha256 !==
      EXPECTED_REFERENCE_MANIFEST_SHA256 ||
    record.input_identity.wav_sha256 !== EXPECTED_WAV_SHA256
  ) {
    fail("QUALITY_SMOKE_EVIDENCE_INPUT");
  }
  assertExactKeys(record.reference, REFERENCE_KEYS, "QUALITY_SMOKE_EVIDENCE_REFERENCE");
  assertExactKeys(
    record.reference.audio,
    AUDIO_KEYS,
    "QUALITY_SMOKE_EVIDENCE_REFERENCE",
  );
  assertExactKeys(
    record.reference.transcript,
    TRANSCRIPT_KEYS,
    "QUALITY_SMOKE_EVIDENCE_REFERENCE",
  );
  if (
    !isDeepStrictEqual(record.reference.audio, EXPECTED_AUDIO) ||
    record.reference.manifest_sha256 !== EXPECTED_REFERENCE_MANIFEST_SHA256 ||
    record.reference.transcript.match_basis !== "sha256-and-utf8-byte-length" ||
    record.reference.transcript.reference_role !==
      EXPECTED_TRANSCRIPT.reference_role ||
    record.reference.transcript.sha256 !== EXPECTED_TRANSCRIPT.sha256 ||
    record.reference.transcript.utf8_bytes !== EXPECTED_TRANSCRIPT.utf8_bytes ||
    record.reference.upstream_repository_commit !== EXPECTED_UPSTREAM_COMMIT
  ) {
    fail("QUALITY_SMOKE_EVIDENCE_REFERENCE");
  }
  if (
    record.kind !== EVIDENCE_KIND ||
    record.schema_version !== SCHEMA_VERSION ||
    record.quality_gate_status !== "not-assessed" ||
    record.redistribution_status !== "unresolved" ||
    !isDeepStrictEqual(record.limitations, LIMITATIONS)
  ) {
    fail("QUALITY_SMOKE_EVIDENCE_SCOPE");
  }
  if (!Array.isArray(record.runs) || record.runs.length !== 2) {
    fail("QUALITY_SMOKE_EVIDENCE_RUNS");
  }
  for (const [index, run] of record.runs.entries()) {
    validateEvidenceRun(run, index, record.input_identity);
  }
  return {
    evidenceSha256: sha256(bytes),
    lockedInputSnapshotSha256:
      record.input_identity.locked_input_snapshot_sha256,
    record,
    runCount: record.runs.length,
  };
}

async function assertRealPathChain(inputPath, code) {
  const resolved = path.resolve(inputPath);
  let current = resolved;
  while (true) {
    let metadata;
    try {
      metadata = await lstat(current);
    } catch {
      fail(code);
    }
    if (metadata.isSymbolicLink()) {
      fail(code);
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return resolved;
}

async function readRegularFile(inputPath, code) {
  const resolved = await assertRealPathChain(inputPath, code);
  let before;
  try {
    before = await lstat(resolved);
  } catch {
    fail(code);
  }
  if (!before.isFile() || before.size <= 0 || !Number.isSafeInteger(before.size)) {
    fail(code);
  }
  const bytes = await readFile(resolved).catch(() => fail(code));
  const after = await lstat(resolved).catch(() => fail(code));
  if (
    !after.isFile() ||
    bytes.length !== before.size ||
    after.size !== before.size ||
    after.mtimeMs !== before.mtimeMs
  ) {
    fail(code);
  }
  return { bytes, resolved, sha256: sha256(bytes), sizeBytes: bytes.length };
}

function assertFixtureIsNotTracked(wavPath) {
  const relative = path.relative(REPOSITORY_ROOT, wavPath);
  if (
    relative.length === 0 ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return;
  }
  const result = spawnSync(
    process.platform === "win32" ? "git.exe" : "git",
    [
      "ls-files",
      "--error-unmatch",
      "--",
      relative.split(path.sep).join("/"),
    ],
    {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
      windowsHide: true,
    },
  );
  if (result.error != null || (result.status !== 0 && result.status !== 1)) {
    fail("QUALITY_SMOKE_WAV_TRACKING_CHECK");
  }
  if (result.status === 0) {
    fail("QUALITY_SMOKE_WAV_TRACKED");
  }
}

export async function prepareQualitySmokeReference({
  referenceManifestPath = DEFAULT_REFERENCE_MANIFEST_PATH,
  wavPath,
}) {
  const manifestMaterial = await readRegularFile(
    referenceManifestPath,
    "QUALITY_SMOKE_REFERENCE_MANIFEST",
  );
  const manifest = validateQualitySmokeReferenceManifest(manifestMaterial.bytes);
  const wavMaterial = await readRegularFile(wavPath, "QUALITY_SMOKE_WAV_IDENTITY");
  const audio = validateQualitySmokeReferenceWavBytes(wavMaterial.bytes);
  assertFixtureIsNotTracked(wavMaterial.resolved);
  return {
    audio,
    manifest: manifest.record,
    manifestSha256: manifest.manifestSha256,
    wavPath: wavMaterial.resolved,
    wavSha256: wavMaterial.sha256,
  };
}

async function assertNewFilePath(outputPath, code) {
  const resolved = path.resolve(outputPath);
  const parent = await assertRealPathChain(path.dirname(resolved), code);
  if (path.dirname(resolved) !== parent) fail(code);
  try {
    await lstat(resolved);
  } catch (error) {
    if (error?.code === "ENOENT") return resolved;
    fail(code);
  }
  fail(code);
}

export async function publishNativeCandidateQualitySmokeEvidence(
  outputPath,
  bytes,
  operations = {},
) {
  validateNativeCandidateQualitySmokeEvidenceRecord(bytes);
  const resolved = await assertNewFilePath(outputPath, "QUALITY_SMOKE_EVIDENCE_OUTPUT");
  const suffix = (operations.randomSuffix ?? (() => randomBytes(16).toString("hex")))();
  if (typeof suffix !== "string" || !/^[0-9a-f]{32}$/u.test(suffix)) {
    fail("QUALITY_SMOKE_EVIDENCE_OUTPUT");
  }
  const stagingPath = path.join(
    path.dirname(resolved),
    `.${path.basename(resolved)}.${suffix}.staging`,
  );
  const openFile = operations.openFile ?? open;
  const linkFile = operations.linkFile ?? link;
  const readFileBytes = operations.readFileBytes ?? readFile;
  const unlinkFile = operations.unlinkFile ?? unlink;
  let handle;
  let stagingOwned = false;
  let finalPublished = false;
  let failed = false;
  try {
    handle = await openFile(stagingPath, "wx");
    stagingOwned = true;
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    const staged = await readFileBytes(stagingPath);
    if (!Buffer.isBuffer(staged) || !staged.equals(bytes)) {
      failed = true;
    } else {
      validateNativeCandidateQualitySmokeEvidenceRecord(staged);
    }
    if (failed) throw new Error("QUALITY_SMOKE_EVIDENCE_STAGING");
    await linkFile(stagingPath, resolved);
    finalPublished = true;
    const persisted = await readFileBytes(resolved);
    if (!Buffer.isBuffer(persisted) || !persisted.equals(bytes)) failed = true;
  } catch {
    failed = true;
  }
  if (handle !== undefined) {
    try {
      await handle.close();
    } catch {
      failed = true;
    }
  }
  if (stagingOwned) {
    try {
      await unlinkFile(stagingPath);
      stagingOwned = false;
    } catch {
      failed = true;
    }
  }
  if (failed) {
    if (finalPublished) {
      try {
        await unlinkFile(resolved);
      } catch {
        // A complete record may remain, but publication failure is never hidden.
      }
    }
    fail("QUALITY_SMOKE_EVIDENCE_OUTPUT");
  }
  return resolved;
}

export async function validateNativeCandidateQualitySmokeEvidenceFile(inputPath) {
  const material = await readRegularFile(inputPath, "QUALITY_SMOKE_EVIDENCE_INPUT");
  return validateNativeCandidateQualitySmokeEvidenceRecord(material.bytes);
}

function conformanceInput(input) {
  return {
    assetLockPath: input.assetLockPath,
    executablePath: input.executablePath,
    modelPath: input.modelPath,
    packageLockPath: input.packageLockPath,
    runtimeLibDir: input.runtimeLibDir,
    schemaRegistryPath: input.schemaRegistryPath,
    tokensPath: input.tokensPath,
    wavPath: input.wavPath,
  };
}

function validateConformanceResult(result, runIndex) {
  if (result === null || typeof result !== "object") {
    fail("QUALITY_SMOKE_RUN");
  }
  for (const key of [
    "conformanceRecordSha256",
    "executableSha256",
    "lockedInputSnapshotSha256",
    "schemaRegistrySha256",
  ]) {
    assertDigest(result[key], "QUALITY_SMOKE_RUN");
  }
  if (
    result.backendExecuteCalls !== 1 ||
    result.checkSummary?.passed !== 12 ||
    result.checkSummary?.total !== 12 ||
    result.finalTranscriptSha256 !== EXPECTED_TRANSCRIPT_SHA256 ||
    result.finalTranscriptUtf8Bytes !== EXPECTED_TRANSCRIPT_BYTES.length ||
    result.workerId !== EXPECTED_WORKER_ID
  ) {
    fail(
      result.finalTranscriptSha256 !== EXPECTED_TRANSCRIPT_SHA256 ||
        result.finalTranscriptUtf8Bytes !== EXPECTED_TRANSCRIPT_BYTES.length
        ? "QUALITY_SMOKE_TRANSCRIPT_MISMATCH"
        : "QUALITY_SMOKE_RUN",
    );
  }
  return {
    identity: {
      executionHostSha256: result.executableSha256,
      lockedInputSnapshotSha256: result.lockedInputSnapshotSha256,
      schemaRegistrySha256: result.schemaRegistrySha256,
    },
    record: {
      backend_execute_calls: result.backendExecuteCalls,
      check_summary: {
        passed: result.checkSummary.passed,
        total: result.checkSummary.total,
      },
      conformance_record_sha256: result.conformanceRecordSha256,
      exact_reference_match: true,
      final_transcript_sha256: result.finalTranscriptSha256,
      final_transcript_utf8_bytes: result.finalTranscriptUtf8Bytes,
      fresh_process: true,
      input_snapshot_sha256: result.lockedInputSnapshotSha256,
      run_index: runIndex,
      worker_id: result.workerId,
    },
  };
}

export async function runNativeCandidateQualitySmoke(input, dependencies = {}) {
  const referenceLoader =
    dependencies.referenceLoader ?? prepareQualitySmokeReference;
  const conformanceRunner =
    dependencies.conformanceRunner ?? runReleaseNativeCandidateConformance;
  const publishEvidence =
    dependencies.publishEvidence ?? publishNativeCandidateQualitySmokeEvidence;
  const referenceInput = {
    referenceManifestPath:
      input.referenceManifestPath ?? DEFAULT_REFERENCE_MANIFEST_PATH,
    wavPath: input.wavPath,
  };

  await assertNewFilePath(input.outputEvidencePath, "QUALITY_SMOKE_PARTIAL_OUTPUT");
  const reference = await referenceLoader(referenceInput);
  if (
    reference?.manifestSha256 !== EXPECTED_REFERENCE_MANIFEST_SHA256 ||
    reference?.wavSha256 !== EXPECTED_WAV_SHA256 ||
    !isDeepStrictEqual(reference?.audio, EXPECTED_AUDIO)
  ) {
    fail("QUALITY_SMOKE_REFERENCE_JOIN");
  }

  const runs = [];
  let firstIdentity;
  for (let runIndex = 1; runIndex <= 2; runIndex += 1) {
    await assertNewFilePath(input.outputEvidencePath, "QUALITY_SMOKE_PARTIAL_OUTPUT");
    const result = await conformanceRunner(conformanceInput(input));
    const checked = validateConformanceResult(result, runIndex);
    const postflightReference = await referenceLoader(referenceInput);
    if (
      postflightReference?.manifestSha256 !== reference.manifestSha256 ||
      postflightReference?.wavSha256 !== reference.wavSha256 ||
      !isDeepStrictEqual(postflightReference?.audio, reference.audio)
    ) {
      fail("QUALITY_SMOKE_REFERENCE_POSTFLIGHT");
    }
    if (firstIdentity === undefined) {
      firstIdentity = checked.identity;
    } else if (!isDeepStrictEqual(checked.identity, firstIdentity)) {
      fail("QUALITY_SMOKE_INPUT_DRIFT");
    }
    runs.push(checked.record);
  }

  if (firstIdentity === undefined || runs.length !== 2) {
    fail("QUALITY_SMOKE_INTERNAL");
  }
  const evidence = {
    authority: {
      formal_claims: "none",
      production_evidence: false,
    },
    input_identity: {
      execution_host_sha256: firstIdentity.executionHostSha256,
      locked_input_snapshot_sha256: firstIdentity.lockedInputSnapshotSha256,
      reference_manifest_sha256: reference.manifestSha256,
      schema_registry_sha256: firstIdentity.schemaRegistrySha256,
      wav_sha256: reference.wavSha256,
    },
    kind: EVIDENCE_KIND,
    limitations: [...LIMITATIONS],
    quality_gate_status: "not-assessed",
    redistribution_status: "unresolved",
    reference: {
      audio: { ...EXPECTED_AUDIO },
      manifest_sha256: reference.manifestSha256,
      transcript: {
        match_basis: "sha256-and-utf8-byte-length",
        reference_role: EXPECTED_TRANSCRIPT.reference_role,
        sha256: EXPECTED_TRANSCRIPT.sha256,
        utf8_bytes: EXPECTED_TRANSCRIPT.utf8_bytes,
      },
      upstream_repository_commit: EXPECTED_UPSTREAM_COMMIT,
    },
    runs,
    schema_version: SCHEMA_VERSION,
  };
  const evidenceBytes = Buffer.from(encodeCanonicalJsonLine(evidence), "utf8");
  validateNativeCandidateQualitySmokeEvidenceRecord(evidenceBytes);
  await publishEvidence(input.outputEvidencePath, evidenceBytes);
  return validateNativeCandidateQualitySmokeEvidenceFile(input.outputEvidencePath);
}

async function main(arguments_) {
  const [command, ...rest] = arguments_;
  if (command === "--validate" && rest.length === 1) {
    const result = await validateNativeCandidateQualitySmokeEvidenceFile(rest[0]);
    process.stdout.write(
      `candidate-native-quality-smoke-evidence-file=verified evidence_sha256=${result.evidenceSha256} ` +
        `locked_input_snapshot_sha256=${result.lockedInputSnapshotSha256} runs=${result.runCount} ` +
        "quality_gate_status=not-assessed redistribution_status=unresolved " +
        "formal_claims=none production_evidence=false\n",
    );
    return;
  }
  if (command === "--run" && rest.length === 9) {
    const result = await runNativeCandidateQualitySmoke({
      assetLockPath: rest[6],
      executablePath: rest[1],
      modelPath: rest[3],
      outputEvidencePath: rest[0],
      packageLockPath: rest[7],
      runtimeLibDir: rest[5],
      schemaRegistryPath: rest[2],
      tokensPath: rest[4],
      wavPath: rest[8],
    });
    process.stdout.write(
      `candidate-native-quality-smoke-evidence=verified evidence_sha256=${result.evidenceSha256} ` +
        `locked_input_snapshot_sha256=${result.lockedInputSnapshotSha256} runs=${result.runCount} ` +
        "quality_gate_status=not-assessed redistribution_status=unresolved " +
        "formal_claims=none production_evidence=false\n",
    );
    return;
  }
  fail("QUALITY_SMOKE_USAGE");
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(
      `${error instanceof NativeCandidateQualitySmokeError ? error.code : "QUALITY_SMOKE_INTERNAL"}\n`,
    );
    process.exitCode = 1;
  });
}
