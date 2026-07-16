import { createHash } from "node:crypto";
import { lstat, open } from "node:fs/promises";
import path from "node:path";

import { encodeCanonicalJson, encodeCanonicalJsonLine } from "../phase0-harness/canonical-json.mjs";
import { assertAsrScorerRuntimeIdentity } from "./asr-error-rate.mjs";
import { inspectPcmS16leWave } from "./native-candidate-quality-smoke.mjs";

// Corpus/reference NFC acceptance must be pinned to the same Unicode runtime
// as scoring, even when the materializer is imported without the scorer API.
assertAsrScorerRuntimeIdentity();

const KIND = "meetingrelay-asr-quality-corpus-v1";
const VERSION = "1.0";
const PURPOSE = "asr-quality-component-measurement";
const DIGEST = /^[0-9a-f]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9._-]{1,128}$/u;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_WAV_BYTES = 64 * 1024 * 1024;
const MAX_MATERIAL_BYTES = MAX_WAV_BYTES;
const MAX_CORPUS_MATERIAL_BYTES = 512n * 1024n * 1024n;
const MAX_CORPUS_SAMPLES = 1_000;
const LANGUAGES = new Set(["en", "ja", "zh"]);
const TIERS = new Set(["tier-1"]);
const SPLITS = new Set(["blind", "calibration", "dev"]);
const PATH_SEGMENT = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9_-])?$/u;
const WINDOWS_DOS_DEVICE = /^(?:AUX|CON|NUL|PRN|COM[1-9]|LPT[1-9])(?:\.|$)/iu;

const ROOT_KEYS = ["corpus_id", "kind", "revision", "samples", "schema_version"];
const SAMPLE_KEYS = ["language", "leakage_group_id", "purpose", "reference", "rights", "sample_id", "scenario", "split", "tier", "wav"];
const REFERENCE_KEYS = ["path", "sha256", "size_bytes"];
const WAV_KEYS = ["bits_per_sample", "channel_count", "duration_samples", "path", "pcm_sha256", "sample_format", "sample_rate_hz", "sha256", "size_bytes"];
const RIGHTS_KEYS = ["allowed_purposes", "consent", "license", "retention", "source_kind", "source_url", "status"];
const LICENSE_KEYS = ["path", "sha256", "size_bytes"];
const RETENTION_KEYS = ["expires_on", "status"];
const CONSENT_KEYS = ["allowed_purposes", "expires_on", "record_path", "record_sha256", "record_size_bytes", "status", "withdrawn"];

export class QualityCorpusError extends Error {
  constructor(code, options = {}) {
    super(code, options);
    this.name = "QualityCorpusError";
    this.code = code;
  }
}

function fail(code, options = {}) {
  throw new QualityCorpusError(code, options);
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

function assertPositiveInteger(value, code) {
  if (!Number.isSafeInteger(value) || value <= 0) fail(code);
}

function assertDate(value, code) {
  if (typeof value !== "string" || !DATE.test(value)) fail(code);
  const instant = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(instant.getTime()) || instant.toISOString().slice(0, 10) !== value) fail(code);
}

function assertRelativePath(value) {
  const segments = typeof value === "string" ? value.split("/") : [];
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    value !== value.normalize("NFC") ||
    value.includes("\\") ||
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    value.includes(":") ||
    segments.some((segment) => !PATH_SEGMENT.test(segment) || WINDOWS_DOS_DEVICE.test(segment))
  ) {
    fail("CORPUS_PATH");
  }
  return value;
}

function validateConsent(consent, sourceKind, validationDate) {
  exactKeys(consent, CONSENT_KEYS, "CORPUS_CONSENT");
  if (sourceKind === "human-consented") {
    if (
      consent.status !== "verified" ||
      consent.withdrawn !== false ||
      !Array.isArray(consent.allowed_purposes) ||
      consent.allowed_purposes.length !== 1 ||
      consent.allowed_purposes[0] !== PURPOSE ||
      consent.expires_on === null ||
      consent.expires_on < validationDate
    ) {
      fail("CORPUS_CONSENT");
    }
    assertDate(consent.expires_on, "CORPUS_CONSENT");
    assertRelativePath(consent.record_path);
    assertDigest(consent.record_sha256, "CORPUS_CONSENT");
    assertPositiveInteger(consent.record_size_bytes, "CORPUS_CONSENT");
    return;
  }
  if (sourceKind === "public-corpus") {
    if (
      consent.status !== "not-required-public-license" ||
      consent.withdrawn !== false ||
      consent.expires_on !== null ||
      !Array.isArray(consent.allowed_purposes) ||
      consent.allowed_purposes.length !== 1 ||
      consent.allowed_purposes[0] !== PURPOSE
    ) {
      fail("CORPUS_CONSENT");
    }
    assertRelativePath(consent.record_path);
    assertDigest(consent.record_sha256, "CORPUS_CONSENT");
    assertPositiveInteger(consent.record_size_bytes, "CORPUS_CONSENT");
    return;
  }
  const expected = {
    allowed_purposes: [],
    expires_on: null,
    record_path: null,
    record_sha256: null,
    record_size_bytes: null,
    status: "not-required-non-human",
    withdrawn: false,
  };
  if (encodeCanonicalJsonLine(consent) !== encodeCanonicalJsonLine(expected)) fail("CORPUS_CONSENT");
}

function validateRights(rights, validationDate) {
  exactKeys(rights, RIGHTS_KEYS, "CORPUS_RIGHTS_FIELDS");
  if (
    rights.status !== "verified" ||
    !["human-consented", "public-corpus", "synthetic"].includes(rights.source_kind) ||
    rights.source_url !== null ||
    !Array.isArray(rights.allowed_purposes) ||
    rights.allowed_purposes.length !== 1 ||
    rights.allowed_purposes[0] !== PURPOSE
  ) {
    fail(rights.status !== "verified" ? "CORPUS_RIGHTS_STATUS" : "CORPUS_RIGHTS_PURPOSE");
  }
  exactKeys(rights.license, LICENSE_KEYS, "CORPUS_LICENSE");
  assertRelativePath(rights.license.path);
  assertDigest(rights.license.sha256, "CORPUS_LICENSE");
  assertPositiveInteger(rights.license.size_bytes, "CORPUS_LICENSE");
  exactKeys(rights.retention, RETENTION_KEYS, "CORPUS_RETENTION");
  if (rights.retention.status !== "active") fail("CORPUS_RETENTION");
  if (rights.retention.expires_on !== null) {
    assertDate(rights.retention.expires_on, "CORPUS_RETENTION");
    if (rights.retention.expires_on < validationDate) fail("CORPUS_RETENTION");
  }
  validateConsent(rights.consent, rights.source_kind, validationDate);
}

function validateSample(sample) {
  exactKeys(sample, SAMPLE_KEYS, "CORPUS_SAMPLE_FIELDS");
  assertIdentifier(sample.sample_id, "CORPUS_SAMPLE_ID");
  assertIdentifier(sample.leakage_group_id, "CORPUS_LEAKAGE_GROUP");
  assertIdentifier(sample.scenario, "CORPUS_SCENARIO");
  if (!LANGUAGES.has(sample.language) || !TIERS.has(sample.tier) || !SPLITS.has(sample.split)) fail("CORPUS_SAMPLE_CLASSIFICATION");
  if (sample.purpose !== PURPOSE) fail("CORPUS_RIGHTS_PURPOSE");
  exactKeys(sample.reference, REFERENCE_KEYS, "CORPUS_REFERENCE_FIELDS");
  assertRelativePath(sample.reference.path);
  assertDigest(sample.reference.sha256, "CORPUS_REFERENCE_FIELDS");
  assertPositiveInteger(sample.reference.size_bytes, "CORPUS_REFERENCE_FIELDS");
  exactKeys(sample.wav, WAV_KEYS, "CORPUS_WAV_FIELDS");
  assertRelativePath(sample.wav.path);
  assertDigest(sample.wav.sha256, "CORPUS_WAV_FIELDS");
  assertDigest(sample.wav.pcm_sha256, "CORPUS_WAV_FIELDS");
  for (const field of ["duration_samples", "size_bytes"]) assertPositiveInteger(sample.wav[field], "CORPUS_WAV_FIELDS");
  if (
    sample.wav.bits_per_sample !== 16 ||
    sample.wav.channel_count !== 1 ||
    sample.wav.sample_format !== "pcm-s16le" ||
    sample.wav.sample_rate_hz !== 16_000 ||
    sample.wav.size_bytes > MAX_WAV_BYTES ||
    sample.wav.duration_samples > (MAX_WAV_BYTES - 44) / 2 ||
    sample.wav.size_bytes !== 44 + sample.wav.duration_samples * 2
  ) {
    fail("CORPUS_WAV_FIELDS");
  }
}

function detectDuplicatesAndLeakage(samples) {
  const identifiers = new Set();
  const paths = new Set();
  const wavIdentities = new Map();
  const pcmIdentities = new Map();
  const leakageGroups = new Map();
  const windowsMaterialPaths = new Map();
  let previousSampleId;
  for (const sample of samples) {
    if (identifiers.has(sample.sample_id)) fail("CORPUS_SAMPLE_DUPLICATE");
    if (previousSampleId !== undefined && previousSampleId > sample.sample_id) fail("CORPUS_SAMPLE_ORDER");
    identifiers.add(sample.sample_id);
    previousSampleId = sample.sample_id;
    const priorGroupSplit = leakageGroups.get(sample.leakage_group_id);
    if (priorGroupSplit !== undefined && priorGroupSplit !== sample.split) fail("CORPUS_SPLIT_LEAKAGE");
    leakageGroups.set(sample.leakage_group_id, sample.split);
    for (const candidatePath of [sample.wav.path, sample.reference.path]) {
      if (paths.has(candidatePath)) fail("CORPUS_SAMPLE_DUPLICATE");
      paths.add(candidatePath);
    }
    const materialPaths = [sample.wav.path, sample.reference.path, sample.rights.license.path];
    if (sample.rights.consent.record_path !== null) materialPaths.push(sample.rights.consent.record_path);
    for (const candidatePath of materialPaths) {
      const windowsKey = candidatePath.toUpperCase();
      const priorPath = windowsMaterialPaths.get(windowsKey);
      if (priorPath !== undefined && priorPath !== candidatePath) fail("CORPUS_PATH_COLLISION");
      windowsMaterialPaths.set(windowsKey, candidatePath);
    }
    for (const [identity, map] of [
      [sample.wav.sha256, wavIdentities],
      [sample.wav.pcm_sha256, pcmIdentities],
    ]) {
      const prior = map.get(identity);
      if (prior !== undefined && prior !== sample.split) fail("CORPUS_SPLIT_LEAKAGE");
      if (prior !== undefined) fail("CORPUS_SAMPLE_DUPLICATE");
      map.set(identity, sample.split);
    }
  }
}

function assertDeclaredMaterialBudget(samples) {
  let total = 0n;
  for (const sample of samples) {
    total += BigInt(sample.wav.size_bytes);
    total += BigInt(sample.reference.size_bytes);
    total += BigInt(sample.rights.license.size_bytes);
    if (sample.rights.consent.record_size_bytes !== null) {
      total += BigInt(sample.rights.consent.record_size_bytes);
    }
    if (total > MAX_CORPUS_MATERIAL_BYTES) fail("CORPUS_TOTAL_MATERIAL_LIMIT");
  }
  return total;
}

export function validateQualityCorpusManifestBytes(bytes, { validationDate }) {
  assertDate(validationDate, "CORPUS_VALIDATION_DATE");
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length === 0 ||
    bytes.length > MAX_MANIFEST_BYTES ||
    bytes.at(-1) !== 0x0a ||
    bytes.includes(0x0d)
  ) {
    fail("CORPUS_MANIFEST_CANONICAL");
  }
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) fail("CORPUS_MANIFEST_CANONICAL");
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch {
    fail("CORPUS_MANIFEST_CANONICAL");
  }
  if (encodeCanonicalJson(manifest) !== text) fail("CORPUS_MANIFEST_CANONICAL");
  exactKeys(manifest, ROOT_KEYS, "CORPUS_MANIFEST_FIELDS");
  if (manifest.kind !== KIND || manifest.schema_version !== VERSION || !Number.isSafeInteger(manifest.revision) || manifest.revision <= 0) fail("CORPUS_MANIFEST_FIELDS");
  assertIdentifier(manifest.corpus_id, "CORPUS_MANIFEST_FIELDS");
  if (!Array.isArray(manifest.samples) || manifest.samples.length < 1 || manifest.samples.length > MAX_CORPUS_SAMPLES) fail("CORPUS_MANIFEST_FIELDS");
  for (const sample of manifest.samples) {
    validateSample(sample);
    validateRights(sample.rights, validationDate);
  }
  detectDuplicatesAndLeakage(manifest.samples);
  assertDeclaredMaterialBudget(manifest.samples);
  return structuredClone(manifest);
}

function sameIdentity(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino && typeof left?.dev === "bigint" && typeof left?.ino === "bigint" && left.dev > 0n && left.ino > 0n;
}

function sameSnapshot(left, right) {
  return sameIdentity(left, right) && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

async function assertDirectPathChain(value, finalKind) {
  const absolute = path.resolve(value);
  const root = path.parse(absolute).root;
  const segments = path.relative(root, absolute).split(path.sep).filter(Boolean);
  let current = root;
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    let metadata;
    try {
      metadata = await lstat(current);
    } catch {
      fail("CORPUS_PATH");
    }
    const final = index === segments.length - 1;
    if (
      metadata.isSymbolicLink() ||
      (!final && !metadata.isDirectory()) ||
      (final && finalKind === "file" && !metadata.isFile()) ||
      (final && finalKind === "directory" && !metadata.isDirectory())
    ) {
      fail("CORPUS_PATH_REPARSE");
    }
  }
  return absolute;
}

async function readStableFile(inputPath, { code, maxBytes = MAX_MATERIAL_BYTES } = {}) {
  const absolute = await assertDirectPathChain(inputPath, "file");
  const handle = await open(absolute, "r").catch(() => fail(code));
  try {
    const [pathBefore, handleBefore] = await Promise.all([
      lstat(absolute, { bigint: true }),
      handle.stat({ bigint: true }),
    ]);
    if (!pathBefore.isFile() || pathBefore.isSymbolicLink() || !handleBefore.isFile() || !sameSnapshot(pathBefore, handleBefore) || handleBefore.size <= 0n || handleBefore.size > BigInt(maxBytes)) fail(code);
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
    if (pathAfter === null || !sameSnapshot(handleBefore, handleAfter) || !sameSnapshot(handleBefore, pathAfter) || BigInt(bytes.length) !== handleBefore.size || !verification.equals(bytes)) fail(code);
    return { bytes, path: absolute, snapshot: handleBefore };
  } finally {
    await handle.close().catch(() => fail(code));
  }
}

function resolveMaterial(root, relativePath) {
  assertRelativePath(relativePath);
  const absolute = path.resolve(root, ...relativePath.split("/"));
  const relative = path.relative(root, absolute);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fail("CORPUS_PATH");
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

function validateMaterialIdentity(material, expected, code) {
  if (material.bytes.length !== expected.size_bytes || sha256(material.bytes) !== expected.sha256) fail(code);
}

function validateReferenceBytes(bytes) {
  if (bytes.length === 0 || bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) fail("CORPUS_REFERENCE_IDENTITY");
  const text = bytes.toString("utf8");
  if (
    !Buffer.from(text, "utf8").equals(bytes)
    || text !== text.normalize("NFC")
    || text.includes("\0")
    || text.includes("\r")
    || text.includes("\n")
  ) fail("CORPUS_REFERENCE_IDENTITY");
  return text;
}

function counts(values) {
  return Object.fromEntries([...new Set(values)].sort().map((value) => [value, values.filter((candidate) => candidate === value).length]));
}

async function revalidateMaterial(material, code) {
  const current = await readStableFile(material.path, { code });
  if (!sameSnapshot(material.snapshot, current.snapshot) || !material.bytes.equals(current.bytes)) fail("CORPUS_INPUT_CHANGED");
}

async function materializeCore(input, { hooks = {} } = {}) {
  exactKeys(input, ["corpusRoot", "expectedManifestSha256", "manifestPath", "validationDate"], "CORPUS_INPUT");
  assertDate(input.validationDate, "CORPUS_VALIDATION_DATE");
  assertDigest(input.expectedManifestSha256, "CORPUS_MANIFEST_TRUST_REQUIRED");
  for (const value of [input.corpusRoot, input.manifestPath]) {
    if (!isCanonicalLocalAbsolutePath(value)) fail("CORPUS_PATH");
  }
  const root = await assertDirectPathChain(input.corpusRoot, "directory");
  const manifestAbsolute = path.resolve(input.manifestPath);
  const manifestRelative = path.relative(root, manifestAbsolute);
  if (
    manifestRelative === "" ||
    manifestRelative === ".." ||
    manifestRelative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(manifestRelative)
  ) {
    fail("CORPUS_MANIFEST_PATH");
  }
  const manifestMaterial = await readStableFile(manifestAbsolute, { code: "CORPUS_MANIFEST_INPUT", maxBytes: MAX_MANIFEST_BYTES });
  if (sha256(manifestMaterial.bytes) !== input.expectedManifestSha256) fail("CORPUS_MANIFEST_TRUST_MISMATCH");
  const manifest = validateQualityCorpusManifestBytes(manifestMaterial.bytes, { validationDate: input.validationDate });
  const samples = [];
  const allMaterials = [manifestMaterial];
  let actualMaterialBytes = 0n;
  for (const sample of manifest.samples) {
    const wavMaterial = await readStableFile(resolveMaterial(root, sample.wav.path), { code: "CORPUS_WAV_IDENTITY" });
    validateMaterialIdentity(wavMaterial, sample.wav, "CORPUS_WAV_IDENTITY");
    let wave;
    try {
      wave = inspectPcmS16leWave(wavMaterial.bytes);
    } catch (error) {
      fail("CORPUS_WAV_IDENTITY", { cause: error });
    }
    const pcmBytes = wavMaterial.bytes.subarray(44);
    if (
      wave.bitsPerSample !== sample.wav.bits_per_sample ||
      wave.channelCount !== sample.wav.channel_count ||
      wave.sampleFrames !== sample.wav.duration_samples ||
      wave.sampleRateHz !== sample.wav.sample_rate_hz ||
      sha256(pcmBytes) !== sample.wav.pcm_sha256
    ) {
      fail("CORPUS_WAV_IDENTITY");
    }
    const referenceMaterial = await readStableFile(resolveMaterial(root, sample.reference.path), { code: "CORPUS_REFERENCE_IDENTITY" });
    validateMaterialIdentity(referenceMaterial, sample.reference, "CORPUS_REFERENCE_IDENTITY");
    const referenceText = validateReferenceBytes(referenceMaterial.bytes);
    const licenseMaterial = await readStableFile(resolveMaterial(root, sample.rights.license.path), { code: "CORPUS_LICENSE_IDENTITY" });
    validateMaterialIdentity(licenseMaterial, sample.rights.license, "CORPUS_LICENSE_IDENTITY");
    let consentMaterial = null;
    if (sample.rights.source_kind !== "synthetic") {
      consentMaterial = await readStableFile(resolveMaterial(root, sample.rights.consent.record_path), { code: "CORPUS_CONSENT_IDENTITY" });
      validateMaterialIdentity(consentMaterial, {
        sha256: sample.rights.consent.record_sha256,
        size_bytes: sample.rights.consent.record_size_bytes,
      }, "CORPUS_CONSENT_IDENTITY");
    }
    allMaterials.push(wavMaterial, referenceMaterial, licenseMaterial, ...(consentMaterial === null ? [] : [consentMaterial]));
    for (const material of [wavMaterial, referenceMaterial, licenseMaterial, ...(consentMaterial === null ? [] : [consentMaterial])]) {
      actualMaterialBytes += BigInt(material.bytes.length);
      if (actualMaterialBytes > MAX_CORPUS_MATERIAL_BYTES) fail("CORPUS_TOTAL_MATERIAL_LIMIT");
    }
    samples.push(Object.freeze({
      consentBytes: consentMaterial?.bytes ?? null,
      durationSamples: sample.wav.duration_samples,
      language: sample.language,
      leakageGroupId: sample.leakage_group_id,
      licenseBytes: licenseMaterial.bytes,
      pcmSha256: sample.wav.pcm_sha256,
      referencePath: referenceMaterial.path,
      referenceSha256: sample.reference.sha256,
      referenceText,
      sampleId: sample.sample_id,
      sampleRateHz: sample.wav.sample_rate_hz,
      scenario: sample.scenario,
      split: sample.split,
      tier: sample.tier,
      wavBytes: wavMaterial.bytes,
      wavPath: wavMaterial.path,
      wavSha256: sample.wav.sha256,
      wavSizeBytes: sample.wav.size_bytes,
    }));
  }
  await hooks.beforePostflight?.({ manifest, samples });
  for (const material of allMaterials) await revalidateMaterial(material, "CORPUS_INPUT_CHANGED");
  const snapshotSha256 = sha256(Buffer.from(encodeCanonicalJsonLine({
    manifest_sha256: input.expectedManifestSha256,
    samples: manifest.samples.map((sample) => ({
      consent_sha256: sample.rights.consent.record_sha256,
      license_sha256: sample.rights.license.sha256,
      pcm_sha256: sample.wav.pcm_sha256,
      reference_sha256: sample.reference.sha256,
      sample_id: sample.sample_id,
      wav_sha256: sample.wav.sha256,
    })),
    validation_date: input.validationDate,
  }), "utf8"));
  const publicProjection = Object.freeze({
    corpus_id: manifest.corpus_id,
    languages: Object.freeze([...new Set(samples.map((sample) => sample.language))].sort()),
    manifest_sha256: input.expectedManifestSha256,
    sample_count: samples.length,
    scenario_counts: Object.freeze(counts(samples.map((sample) => sample.scenario))),
    split_counts: Object.freeze(counts(samples.map((sample) => sample.split))),
    tier_counts: Object.freeze(counts(samples.map((sample) => sample.tier))),
    validation_date: input.validationDate,
  });
  return Object.freeze({
    manifestSha256: input.expectedManifestSha256,
    publicProjection,
    samples: Object.freeze(samples),
    snapshotSha256,
    validationDate: input.validationDate,
  });
}

export async function materializeQualityCorpus(input) {
  return materializeCore(input);
}

export async function __materializeQualityCorpusForTest(input, dependencies) {
  return materializeCore(input, dependencies);
}
