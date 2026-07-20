import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { createGunzip } from "node:zlib";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";

import { encodeCanonicalJson, encodeCanonicalJsonLine } from "../phase0-harness/canonical-json.mjs";
import { inspectPcmS16leWave } from "./native-candidate-quality-smoke.mjs";
import { loadPinnedFleursGoldSource } from "./fleurs-gold-source.mjs";
import { materializeQualityCorpus, validateQualityCorpusManifestBytes } from "./quality-corpus.mjs";
import { publishWindowsDirectoryNoReplace } from "./windows-directory-publisher.mjs";

const KIND = "meetingrelay-fleurs-materialized-corpus-v1";
const SCHEMA_VERSION = "1.0";
const CORPUS_KIND = "meetingrelay-asr-quality-corpus-v1";
const PURPOSE = "asr-quality-component-measurement";
const MAX_ARCHIVE_BYTES = 2n * 1024n * 1024n * 1024n;
const MAX_WAV_BYTES = 64 * 1024 * 1024;
const MAX_ARCHIVE_MEMBER_BYTES = 128 * 1024 * 1024;
const DIGEST = /^(?!0{64}$)[0-9a-f]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9._-]{1,128}$/u;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const TAR_PATH_SEGMENT = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9_-])?$/u;
const WINDOWS_DOS_DEVICE = /^(?:AUX|CON|NUL|PRN|COM[1-9]|LPT[1-9])(?:\.|$)/iu;
const CONFIGS = Object.freeze(["en_us", "ja_jp", "cmn_hans_cn"]);
const LANGUAGES = Object.freeze({ cmn_hans_cn: "zh", en_us: "en", ja_jp: "ja" });
const SOURCE_CONTRACT_STATUS = "frozen-source-readiness";
const MATERIALIZATION_AUTHORITY = Object.freeze({
  execution_status: "not-run",
  formal_claims: "none",
  materialization_status: "materialized",
  production_evidence: false,
  public_distribution: false,
  quality_gate_status: "not-assessed",
});
const EVIDENCE_KEYS = Object.freeze([
  "archive_sha256_by_config",
  "authority",
  "corpus_manifest_sha256",
  "corpus_snapshot_sha256",
  "kind",
  "language_counts",
  "materialized_sample_count",
  "policy_sha256",
  "schema_version",
  "selection_sha256",
  "source_contract_status",
  "validation_date",
]);
const MAX_INPUT_JSON_BYTES = 64 * 1024;

export class FleursMaterializedCorpusError extends Error {
  constructor(code, options = {}) {
    super(code, options);
    this.name = "FleursMaterializedCorpusError";
    this.code = code;
  }
}

function fail(code, options = {}) {
  throw new FleursMaterializedCorpusError(code, options);
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
  if (typeof value !== "string" || !DIGEST.test(value)) fail(code);
}

function assertDate(value, code) {
  if (typeof value !== "string" || !DATE.test(value)) fail(code);
  const instant = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(instant.getTime()) || instant.toISOString().slice(0, 10) !== value) fail(code);
}

function assertIdentifier(value, code) {
  if (typeof value !== "string" || !IDENTIFIER.test(value) || value !== value.normalize("NFC")) fail(code);
}

function isCanonicalLocalAbsolutePath(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.includes("\0") &&
    !/^[\\/]{2}/u.test(value) &&
    path.isAbsolute(value) &&
    path.normalize(value) === value &&
    path.resolve(value) === value &&
    value.normalize("NFC") === value &&
    !value.slice(path.parse(value).root.length).includes(":")
  );
}

async function assertDirectPathChain(inputPath, finalKind, code) {
  if (!isCanonicalLocalAbsolutePath(inputPath)) fail(code);
  const root = path.parse(inputPath).root;
  const segments = path.relative(root, inputPath).split(path.sep).filter(Boolean);
  let current = root;
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    const metadata = await lstat(current, { bigint: true }).catch(() => fail(code));
    const final = index === segments.length - 1;
    if (
      metadata.isSymbolicLink() ||
      (!final && !metadata.isDirectory()) ||
      (final && finalKind === "file" && !metadata.isFile()) ||
      (final && finalKind === "directory" && !metadata.isDirectory())
    ) {
      fail(code);
    }
  }
  return inputPath;
}

function assertSafeRelativeMaterialPath(value, code) {
  const segments = typeof value === "string" ? value.split("/") : [];
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    value !== value.normalize("NFC") ||
    value.includes("\\") ||
    value.includes(":") ||
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    segments.some((segment) => !TAR_PATH_SEGMENT.test(segment) || WINDOWS_DOS_DEVICE.test(segment))
  ) {
    fail(code);
  }
  return value;
}

function resolveInside(root, relativePath, code) {
  assertSafeRelativeMaterialPath(relativePath, code);
  const absolute = path.resolve(root, ...relativePath.split("/"));
  const relative = path.relative(root, absolute);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail(code);
  }
  return absolute;
}

function tarString(block, start, length) {
  const slice = block.subarray(start, start + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? slice.length : end).toString("utf8");
}

function parseTarOctal(block, start, length) {
  const raw = tarString(block, start, length).trim();
  if (!/^[0-7]*$/u.test(raw)) fail("FMC_TAR_HEADER");
  return raw === "" ? 0 : Number.parseInt(raw, 8);
}

function checksumTarHeader(block) {
  let sum = 0;
  for (let index = 0; index < 512; index += 1) {
    sum += index >= 148 && index < 156 ? 0x20 : block[index];
  }
  return sum;
}

function tarPathFromHeader(block) {
  const name = tarString(block, 0, 100);
  const prefix = tarString(block, 345, 155);
  const joined = prefix === "" ? name : `${prefix}/${name}`;
  if (!Buffer.from(joined, "utf8").equals(Buffer.from(joined.normalize("NFC"), "utf8"))) fail("FMC_TAR_PATH");
  return joined.normalize("NFC");
}

function validateTarHeader(block) {
  if (block.every((byte) => byte === 0)) return null;
  const expectedChecksum = parseTarOctal(block, 148, 8);
  if (checksumTarHeader(block) !== expectedChecksum) fail("FMC_TAR_HEADER");
  const typeflag = block[156] === 0 ? "0" : String.fromCharCode(block[156]);
  const memberPath = tarPathFromHeader(block);
  if (
    memberPath === "" ||
    memberPath.includes("\0") ||
    memberPath.includes(":") ||
    memberPath.includes("\\") ||
    memberPath.split("/").some((segment) => segment === "." || segment === ".." || segment === "")
  ) {
    fail("FMC_TAR_PATH");
  }
  for (const segment of memberPath.replace(/\/$/u, "").split("/")) {
    if (!TAR_PATH_SEGMENT.test(segment) || WINDOWS_DOS_DEVICE.test(segment)) fail("FMC_TAR_PATH");
  }
  const size = parseTarOctal(block, 124, 12);
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_ARCHIVE_MEMBER_BYTES) fail("FMC_TAR_SIZE");
  if (typeflag === "5") {
    if (size !== 0 || !memberPath.endsWith("/")) fail("FMC_TAR_DIRECTORY");
    return { memberPath, size, typeflag };
  }
  if (typeflag !== "0") fail("FMC_TAR_UNSAFE_MEMBER");
  if (memberPath.endsWith("/")) fail("FMC_TAR_PATH");
  return { memberPath, size, typeflag };
}

class SelectedTarExtractor extends Transform {
  constructor(expectedByFilename, publishRoot) {
    super();
    this.expectedByFilename = expectedByFilename;
    this.publishRoot = publishRoot;
    this.buffer = Buffer.alloc(0);
    this.state = "header";
    this.current = null;
    this.remaining = 0;
    this.padding = 0;
    this.sawZeroBlock = false;
    this.memberPaths = new Set();
    this.selectedByFilename = new Map();
    this.pending = Promise.resolve();
  }

  _transform(chunk, _encoding, callback) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this.pending = this.pending.then(() => this.drain());
    this.pending.then(() => callback(), callback);
  }

  _flush(callback) {
    this.pending = this.pending.then(async () => {
      await this.drain();
      if (this.state !== "header" || this.buffer.length !== 0 || !this.sawZeroBlock) fail("FMC_TAR_TRUNCATED");
      for (const filename of this.expectedByFilename.keys()) {
        if (!this.selectedByFilename.has(filename)) fail("FMC_ARCHIVE_SELECTED_MISSING");
      }
    });
    this.pending.then(() => callback(), callback);
  }

  async drain() {
    while (true) {
      if (this.state === "header") {
        if (this.buffer.length < 512) return;
        const block = this.buffer.subarray(0, 512);
        this.buffer = this.buffer.subarray(512);
        const header = validateTarHeader(block);
        if (header === null) {
          this.sawZeroBlock = true;
          if (this.buffer.length >= 512 && this.buffer.subarray(0, 512).every((byte) => byte === 0)) {
            this.buffer = this.buffer.subarray(512);
          }
          if (this.buffer.length !== 0 && !this.buffer.every((byte) => byte === 0)) fail("FMC_TAR_TRAILING_BYTES");
          this.buffer = Buffer.alloc(0);
          return;
        }
        if (this.sawZeroBlock) fail("FMC_TAR_TRAILING_BYTES");
        if (this.memberPaths.has(header.memberPath)) fail("FMC_TAR_DUPLICATE_MEMBER");
        this.memberPaths.add(header.memberPath);
        const filename = path.posix.basename(header.memberPath);
        const expected = header.typeflag === "0" ? this.expectedByFilename.get(filename) : undefined;
        if (expected !== undefined && this.selectedByFilename.has(filename)) fail("FMC_ARCHIVE_SELECTED_DUPLICATE");
        this.current = expected === undefined ? null : { chunks: [], expected, filename };
        this.remaining = header.size;
        this.padding = (512 - (header.size % 512)) % 512;
        this.state = "body";
      }
      if (this.state === "body") {
        if (this.buffer.length < this.remaining) return;
        const body = this.buffer.subarray(0, this.remaining);
        this.buffer = this.buffer.subarray(this.remaining);
        if (this.current !== null) {
          const bytes = Buffer.from(body);
          const wav = inspectPcmS16leWave(bytes);
          if (
            wav.channelCount !== 1 ||
            wav.bitsPerSample !== 16 ||
            wav.sampleRateHz !== 16_000 ||
            wav.sampleFrames !== this.current.expected.num_samples
          ) {
            fail("FMC_WAV_FORMAT");
          }
          const relativePath = `wav/${this.current.expected.config}/${this.current.filename}`;
          const absolutePath = resolveInside(this.publishRoot, relativePath, "FMC_OUTPUT_PATH");
          await mkdir(path.dirname(absolutePath), { recursive: true });
          await writeFile(absolutePath, bytes, { flag: "wx" }).catch((error) => fail("FMC_OUTPUT_WRITE", { cause: error }));
          this.selectedByFilename.set(this.current.filename, {
            path: relativePath,
            pcmSha256: sha256(bytes.subarray(44)),
            sha256: sha256(bytes),
            sizeBytes: bytes.length,
          });
        }
        this.current = null;
        this.state = "padding";
      }
      if (this.state === "padding") {
        if (this.buffer.length < this.padding) return;
        if (!this.buffer.subarray(0, this.padding).every((byte) => byte === 0)) fail("FMC_TAR_PADDING");
        this.buffer = this.buffer.subarray(this.padding);
        this.padding = 0;
        this.state = "header";
      }
    }
  }
}

async function hashArchiveAndValidate(archivePath, expected) {
  await assertDirectPathChain(archivePath, "file", "FMC_ARCHIVE_PATH");
  const [before, realBefore] = await Promise.all([lstat(archivePath, { bigint: true }), realpath(archivePath)]);
  if (!before.isFile() || before.isSymbolicLink() || before.size <= 0n || before.size > MAX_ARCHIVE_BYTES) fail("FMC_ARCHIVE_INPUT");
  if (before.size !== BigInt(expected.sizeBytes)) fail("FMC_ARCHIVE_SIZE");
  const digest = createHash("sha256");
  let observedBytes = 0n;
  for await (const chunk of createReadStream(archivePath)) {
    observedBytes += BigInt(chunk.length);
    if (observedBytes > MAX_ARCHIVE_BYTES) fail("FMC_ARCHIVE_INPUT");
    digest.update(chunk);
  }
  const [after, realAfter] = await Promise.all([lstat(archivePath, { bigint: true }), realpath(archivePath)]);
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || realBefore !== realAfter) {
    fail("FMC_ARCHIVE_CHANGED");
  }
  if (observedBytes !== before.size || digest.digest("hex") !== expected.sha256) fail("FMC_ARCHIVE_SHA256");
}

async function extractSelectedArchive(input) {
  const { archivePath, expected, expectedByFilename, publishRoot } = input;
  await hashArchiveAndValidate(archivePath, expected);
  const extractor = new SelectedTarExtractor(expectedByFilename, publishRoot);
  await pipeline(createReadStream(archivePath), createGunzip(), extractor).catch((error) => {
    if (error instanceof FleursMaterializedCorpusError) throw error;
    fail("FMC_ARCHIVE_EXTRACT", { cause: error });
  });
  return extractor.selectedByFilename;
}

function publicCorpusRights(licenseMaterial, consentMaterial) {
  return {
    allowed_purposes: [PURPOSE],
    consent: {
      allowed_purposes: [PURPOSE],
      expires_on: null,
      record_path: consentMaterial.path,
      record_sha256: consentMaterial.sha256,
      record_size_bytes: consentMaterial.sizeBytes,
      status: "not-required-public-license",
      withdrawn: false,
    },
    license: {
      path: licenseMaterial.path,
      sha256: licenseMaterial.sha256,
      size_bytes: licenseMaterial.sizeBytes,
    },
    retention: {
      expires_on: null,
      status: "active",
    },
    source_kind: "public-corpus",
    source_url: null,
    status: "verified",
  };
}

async function writeMaterial(root, relativePath, bytes) {
  const absolutePath = resolveInside(root, relativePath, "FMC_OUTPUT_PATH");
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, bytes, { flag: "wx" }).catch((error) => fail("FMC_OUTPUT_WRITE", { cause: error }));
  return { path: relativePath, sha256: sha256(bytes), sizeBytes: bytes.length };
}

function assertNoTextLeak(value) {
  const text = JSON.stringify(value);
  if (
    /(?:[A-Za-z]:\\|\\\\|\/|https?:\/\/|\.wav\b|\b[1-9][0-9]{0,19}\.wav\b)/iu.test(text) ||
    /(?:reference|transcript|transcription|filename|path|url|secret|token|password|apikey)/iu.test(text)
  ) {
    fail("FMC_PUBLIC_TEXT_LEAK");
  }
}

function languageCounts(samples) {
  const counts = {};
  for (const sample of samples) counts[sample.language] = (counts[sample.language] ?? 0) + 1;
  return Object.fromEntries(Object.keys(counts).sort().map((key) => [key, counts[key]]));
}

function validateArchiveIdentities(input, policy) {
  exactKeys(input, CONFIGS, "FMC_ARCHIVE_IDENTITIES");
  const byConfig = new Map(policy.sources.map((source) => [source.config, source]));
  return Object.fromEntries(CONFIGS.map((config) => {
    const identity = input[config];
    exactKeys(identity, ["sha256", "sizeBytes"], "FMC_ARCHIVE_IDENTITY");
    assertDigest(identity.sha256, "FMC_ARCHIVE_IDENTITY");
    if (!Number.isSafeInteger(identity.sizeBytes) || identity.sizeBytes < 1) fail("FMC_ARCHIVE_IDENTITY");
    const source = byConfig.get(config);
    if (source === undefined || identity.sha256 !== source.test_archive.lfs_sha256 || identity.sizeBytes !== source.test_archive.size_bytes) {
      fail("FMC_ARCHIVE_POLICY_BINDING");
    }
    return [config, identity];
  }));
}

function validateArchivePaths(archivePaths) {
  exactKeys(archivePaths, CONFIGS, "FMC_ARCHIVE_PATHS");
  return Object.fromEntries(CONFIGS.map((config) => {
    if (!isCanonicalLocalAbsolutePath(archivePaths[config])) fail("FMC_ARCHIVE_PATH");
    return [config, archivePaths[config]];
  }));
}

function buildSample(entry, wavMaterial, referenceMaterial, rights) {
  const sampleId = `fleurs-${entry.config}-${entry.source_id}`;
  assertIdentifier(sampleId, "FMC_SAMPLE_ID");
  return {
    language: entry.language,
    leakage_group_id: `fleurs-${entry.source_id}`,
    purpose: PURPOSE,
    reference: {
      path: referenceMaterial.path,
      sha256: referenceMaterial.sha256,
      size_bytes: referenceMaterial.sizeBytes,
    },
    rights,
    sample_id: sampleId,
    scenario: "fleurs-public-corpus",
    split: "blind",
    tier: "tier-1",
    wav: {
      bits_per_sample: 16,
      channel_count: 1,
      duration_samples: entry.num_samples,
      path: wavMaterial.path,
      pcm_sha256: wavMaterial.pcmSha256,
      sample_format: "pcm-s16le",
      sample_rate_hz: 16_000,
      sha256: wavMaterial.sha256,
      size_bytes: wavMaterial.sizeBytes,
    },
  };
}

async function materializeCore(input, operations = {}) {
  exactKeys(
    input,
    [
      "archiveIdentities",
      "archivePaths",
      "controlledRoot",
      "datasetCardPath",
      "expectedPolicySha256",
      "policyPath",
      "snapshotId",
      "tsvPaths",
      "validationDate",
    ],
    "FMC_INPUT_FIELDS",
  );
  assertDigest(input.expectedPolicySha256, "FMC_POLICY_SHA256");
  assertDate(input.validationDate, "FMC_VALIDATION_DATE");
  assertIdentifier(input.snapshotId, "FMC_SNAPSHOT_ID");
  const controlledRoot = await assertDirectPathChain(input.controlledRoot, "directory", "FMC_CONTROLLED_ROOT");
  const archivePaths = validateArchivePaths(input.archivePaths);
  const sourceLoader = operations.goldSourceLoader ?? loadPinnedFleursGoldSource;
  const source = await sourceLoader({
    datasetCardPath: input.datasetCardPath,
    expectedPolicySha256: input.expectedPolicySha256,
    policyPath: input.policyPath,
    tsvPaths: input.tsvPaths,
  });
  if (source.policy.policySha256 !== input.expectedPolicySha256) fail("FMC_POLICY_SHA256");
  if (source.policy.policy.source_contract_status !== SOURCE_CONTRACT_STATUS) fail("FMC_SOURCE_STATUS");
  const archiveIdentities = validateArchiveIdentities(input.archiveIdentities, source.policy.policy);
  const publishDirectory = operations.publishDirectory ?? publishWindowsDirectoryNoReplace;
  const selections = source.privateSelection.record.selections;
  const expectedCount = source.privateSelection.record.selected_utterance_count;
  if (!Array.isArray(selections) || selections.length !== expectedCount) fail("FMC_SELECTIONS");

  const snapshotsRoot = path.join(controlledRoot, "snapshots");
  const finalRoot = path.join(snapshotsRoot, input.snapshotId);
  const tempRoot = path.join(snapshotsRoot, `.${input.snapshotId}.tmp-${process.pid}-${Date.now()}`);
  const publishLockPath = path.join(snapshotsRoot, `.${input.snapshotId}.publish-lock`);
  if (await stat(finalRoot).then(() => true, () => false)) fail("FMC_SNAPSHOT_EXISTS");
  if (await stat(tempRoot).then(() => true, () => false)) fail("FMC_SNAPSHOT_EXISTS");
  await mkdir(snapshotsRoot, { recursive: true });
  await assertDirectPathChain(snapshotsRoot, "directory", "FMC_SNAPSHOTS_ROOT");
  await mkdir(tempRoot, { recursive: false });
  try {
    const licenseMaterial = await writeMaterial(tempRoot, "rights/fleurs-rights-decision.json", source.rightsDecision.bytes);
    const consentBytes = Buffer.from(encodeCanonicalJson({
      consent_clearance: source.rightsDecision.record.consent_clearance,
      decision_scope: source.rightsDecision.record.decision_scope,
      legal_review: source.rightsDecision.record.legal_review,
      public_distribution: false,
      source_contract_status: SOURCE_CONTRACT_STATUS,
    }), "utf8");
    const consentMaterial = await writeMaterial(tempRoot, "rights/fleurs-consent-clearance.json", consentBytes);
    const rights = publicCorpusRights(licenseMaterial, consentMaterial);

    const selectedByConfig = new Map(CONFIGS.map((config) => [config, new Map()]));
    for (const entry of selections) {
      const byFilename = selectedByConfig.get(entry.config);
      if (byFilename === undefined || entry.language !== LANGUAGES[entry.config]) fail("FMC_SELECTIONS");
      if (byFilename.has(entry.filename)) fail("FMC_SELECTIONS");
      byFilename.set(entry.filename, entry);
    }
    const wavBySequence = new Map();
    for (const config of CONFIGS) {
      const extracted = await extractSelectedArchive({
        archivePath: archivePaths[config],
        expected: archiveIdentities[config],
        expectedByFilename: selectedByConfig.get(config),
        publishRoot: tempRoot,
      });
      for (const [filename, material] of extracted.entries()) {
        wavBySequence.set(selectedByConfig.get(config).get(filename).sequence, material);
      }
    }

    const samples = [];
    for (const entry of selections) {
      const referenceMaterial = await writeMaterial(
        tempRoot,
        `references/${entry.config}/${entry.source_id}.txt`,
        Buffer.from(entry.reference, "utf8"),
      );
      const wavMaterial = wavBySequence.get(entry.sequence);
      if (wavMaterial === undefined) fail("FMC_ARCHIVE_SELECTED_MISSING");
      samples.push(buildSample(entry, wavMaterial, referenceMaterial, rights));
    }
    samples.sort((left, right) => (left.sample_id < right.sample_id ? -1 : left.sample_id > right.sample_id ? 1 : 0));
    const manifest = {
      corpus_id: "meetingrelay-fleurs-960-corpus-v1",
      kind: CORPUS_KIND,
      revision: 1,
      samples,
      schema_version: SCHEMA_VERSION,
    };
    const manifestBytes = Buffer.from(encodeCanonicalJson(manifest), "utf8");
    validateQualityCorpusManifestBytes(manifestBytes, { validationDate: input.validationDate });
    const manifestMaterial = await writeMaterial(tempRoot, "corpus-manifest.json", manifestBytes);
    const corpus = await materializeQualityCorpus({
      corpusRoot: tempRoot,
      expectedManifestSha256: manifestMaterial.sha256,
      manifestPath: path.join(tempRoot, "corpus-manifest.json"),
      validationDate: input.validationDate,
    });
    const archiveSha256ByConfig = Object.fromEntries(CONFIGS.map((config) => [config, archiveIdentities[config].sha256]));
    const publicEvidence = {
      archive_sha256_by_config: archiveSha256ByConfig,
      authority: { ...MATERIALIZATION_AUTHORITY },
      corpus_manifest_sha256: manifestMaterial.sha256,
      corpus_snapshot_sha256: corpus.snapshotSha256,
      kind: KIND,
      language_counts: languageCounts(samples),
      materialized_sample_count: samples.length,
      policy_sha256: source.policy.policySha256,
      schema_version: SCHEMA_VERSION,
      selection_sha256: source.privateSelection.selectionSha256,
      source_contract_status: SOURCE_CONTRACT_STATUS,
      validation_date: input.validationDate,
    };
    exactKeys(publicEvidence, EVIDENCE_KEYS, "FMC_PUBLIC_EVIDENCE_FIELDS");
    assertNoTextLeak(publicEvidence);
    const evidenceBytes = Buffer.from(encodeCanonicalJson(publicEvidence), "utf8");
    const evidenceMaterial = await writeMaterial(tempRoot, "materialization-public-evidence.json", evidenceBytes);
    await writeFile(path.join(tempRoot, "materialization-public-evidence.sha256"), `${evidenceMaterial.sha256}  materialization-public-evidence.json\n`, { flag: "wx" });
    await operations.beforePublish?.({ controlledRoot, finalRoot, publishLockPath, snapshotsRoot, tempRoot });
    await assertDirectPathChain(controlledRoot, "directory", "FMC_CONTROLLED_ROOT");
    await assertDirectPathChain(snapshotsRoot, "directory", "FMC_SNAPSHOTS_ROOT");
    await assertDirectPathChain(tempRoot, "directory", "FMC_STAGING_ROOT");
    if (await stat(finalRoot).then(() => true, () => false)) fail("FMC_SNAPSHOT_EXISTS");
    await writeFile(publishLockPath, `${process.pid}\n`, { flag: "wx" }).catch((error) => fail("FMC_PUBLISH_LOCK", { cause: error }));
    await assertDirectPathChain(controlledRoot, "directory", "FMC_CONTROLLED_ROOT");
    await assertDirectPathChain(snapshotsRoot, "directory", "FMC_SNAPSHOTS_ROOT");
    await assertDirectPathChain(tempRoot, "directory", "FMC_STAGING_ROOT");
    if (await stat(finalRoot).then(() => true, () => false)) fail("FMC_SNAPSHOT_EXISTS");
    await operations.beforeNativePublish?.({ controlledRoot, finalRoot, publishLockPath, snapshotsRoot, tempRoot });
    await publishDirectory({
      destinationDirectory: finalRoot,
      sourceDirectory: tempRoot,
    }).catch((error) => fail("FMC_PUBLISH", { cause: error }));
    return Object.freeze({
      corpusManifestSha256: manifestMaterial.sha256,
      corpusSnapshotSha256: corpus.snapshotSha256,
      finalRoot,
      materializedSampleCount: samples.length,
      publicEvidence,
      publicEvidenceSha256: evidenceMaterial.sha256,
    });
  } catch (error) {
    if (error instanceof FleursMaterializedCorpusError) throw error;
    fail("FMC_MATERIALIZE", { cause: error });
  }
}

export async function materializePinnedFleursCorpus(input) {
  return materializeCore(input);
}

export async function __materializePinnedFleursCorpusForTest(input, operations = {}) {
  return materializeCore(input, operations);
}

export function validateFleursMaterializedPublicEvidenceBytes(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > 64 * 1024 || bytes.at(-1) !== 0x0a || bytes.includes(0x0d)) {
    fail("FMC_PUBLIC_EVIDENCE_CANONICAL");
  }
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("FMC_PUBLIC_EVIDENCE_CANONICAL");
  }
  if (encodeCanonicalJson(value) !== bytes.toString("utf8")) fail("FMC_PUBLIC_EVIDENCE_CANONICAL");
  exactKeys(value, EVIDENCE_KEYS, "FMC_PUBLIC_EVIDENCE_FIELDS");
  if (value.kind !== KIND || value.schema_version !== SCHEMA_VERSION || value.source_contract_status !== SOURCE_CONTRACT_STATUS) fail("FMC_PUBLIC_EVIDENCE_FIELDS");
  if (JSON.stringify(value.authority) !== JSON.stringify(MATERIALIZATION_AUTHORITY)) fail("FMC_PUBLIC_EVIDENCE_AUTHORITY");
  for (const digest of [
    value.corpus_manifest_sha256,
    value.corpus_snapshot_sha256,
    value.policy_sha256,
    value.selection_sha256,
    ...Object.values(value.archive_sha256_by_config ?? {}),
  ]) {
    assertDigest(digest, "FMC_PUBLIC_EVIDENCE_DIGEST");
  }
  assertDate(value.validation_date, "FMC_VALIDATION_DATE");
  assertNoTextLeak(value);
  return { publicEvidence: value, publicEvidenceSha256: sha256(bytes) };
}

function parseCanonicalInput(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_INPUT_JSON_BYTES || bytes.includes(0x0d)) {
    fail("FMC_INPUT_CANONICAL");
  }
  const text = bytes.toString("utf8");
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    fail("FMC_INPUT_CANONICAL");
  }
  if (encodeCanonicalJsonLine(value) !== text) fail("FMC_INPUT_CANONICAL");
  return value;
}

async function main(args) {
  if (args.length === 2 && args[0] === "--materialize") {
    const input = parseCanonicalInput(await readFile(path.resolve(args[1])));
    const result = await materializePinnedFleursCorpus(input);
    process.stdout.write(
      `fleurs-materialized-corpus=verified corpus_snapshot_sha256=${result.corpusSnapshotSha256} materialized_sample_count=${result.materializedSampleCount} public_evidence_sha256=${result.publicEvidenceSha256}\n`,
    );
    return;
  }
  fail("FMC_USAGE");
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof FleursMaterializedCorpusError ? error.code : "FMC_INTERNAL"}\n`);
    process.exitCode = 1;
  });
}
