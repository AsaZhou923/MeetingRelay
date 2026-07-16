import { createHash, randomBytes } from "node:crypto";
import { link, lstat, open, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

const KIND = "meetingrelay-controlled-hypothesis-ledger-v1";
const SEAL_KIND = "meetingrelay-controlled-hypothesis-ledger-seal-v1";
const SCHEMA_VERSION = "1.0";
const AUTHORITY = Object.freeze({
  formal_claims: "none",
  privacy_class: "controlled",
  production_evidence: false,
  public_distribution: false,
});
const ROOT_KEYS = Object.freeze(["authority", "entries", "joins", "kind", "schema_version"]);
const SEAL_AUTHORITY = Object.freeze({
  formal_claims: "none",
  privacy_class: "controlled-derived",
  public_distribution: false,
});
const SEAL_ROOT_KEYS = Object.freeze([
  "authority", "kind", "private_ledger", "schema_version", "text_free_projection",
]);
const SEAL_LEDGER_KEYS = Object.freeze(["entry_count", "kind", "schema_version", "sha256", "size_bytes"]);
const SEAL_PROJECTION_KEYS = Object.freeze(["entry_count", "sha256", "size_bytes"]);
const JOIN_KEYS = Object.freeze([
  "candidate_identity_sha256",
  "corpus_manifest_sha256",
  "corpus_snapshot_sha256",
  "execution_host_sha256",
  "hardware_evidence_sha256",
  "scorer_manifest_sha256",
  "scorer_profile_sha256",
  "source_commit",
  "source_evidence_sha256",
]);
const ENTRY_KEYS = Object.freeze([
  "attempt",
  "component_record_sha256",
  "final_transcript",
  "final_transcript_sha256",
  "final_transcript_utf8_bytes",
  "language",
  "sample_id",
  "sample_identity_sha256",
  "scenario",
  "sequence",
  "split",
  "tier",
]);
const PROJECTION_ROOT_KEYS = Object.freeze(["entries", "entry_count", "joins", "ledger_sha256"]);
const PROJECTION_ENTRY_KEYS = Object.freeze([
  "attempt",
  "component_record_sha256",
  "final_transcript_sha256",
  "final_transcript_utf8_bytes",
  "language",
  "sample_id",
  "sample_identity_sha256",
  "scenario",
  "sequence",
  "split",
  "tier",
]);
const DIGEST = /^(?!0{64}$)[0-9a-f]{64}$/u;
const COMMIT = /^(?!0{40}$)[0-9a-f]{40}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/u;
const LANGUAGES = Object.freeze(["en", "ja", "zh"]);
const SPLITS = Object.freeze(["blind", "calibration", "dev"]);
const TIERS = Object.freeze(["tier-1"]);
const MAX_ENTRIES = 10_000;
const MAX_TRANSCRIPT_UTF8_BYTES = 16_384;
const MAX_RECORD_BYTES = 4 * 1024 * 1024;
const MAX_RELATIVE_PATH_BYTES = 1_024;
const WINDOWS_DOS_DEVICE = /^(?:AUX|CON|NUL|PRN|COM[1-9]|LPT[1-9])(?:\.|$)/iu;

export class ControlledHypothesisLedgerError extends Error {
  constructor(code, options = {}) {
    super(code, options);
    this.name = "ControlledHypothesisLedgerError";
    this.code = code;
  }
}

function fail(code, options = {}) {
  throw new ControlledHypothesisLedgerError(code, options);
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

function sortJsonWithoutStringNormalization(value) {
  if (Array.isArray(value)) return value.map(sortJsonWithoutStringNormalization);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, sortJsonWithoutStringNormalization(value[key])]),
    );
  }
  if (
    value === null || typeof value === "string" || typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  fail("LEDGER_CANONICAL_JSON");
}

function encodeCanonicalJsonLine(value) {
  return `${JSON.stringify(sortJsonWithoutStringNormalization(value))}\n`;
}

function assertDigest(value, code) {
  if (typeof value !== "string" || !DIGEST.test(value)) fail(code);
}

function assertIdentifier(value, code) {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) fail(code);
}

function hasUnpairedSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const following = value.charCodeAt(index + 1);
      if (!(following >= 0xdc00 && following <= 0xdfff)) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function validateAuthority(authority) {
  exactKeys(authority, Object.keys(AUTHORITY), "LEDGER_AUTHORITY");
  if (!isDeepStrictEqual(authority, AUTHORITY)) fail("LEDGER_AUTHORITY");
}

function validateJoins(joins) {
  exactKeys(joins, JOIN_KEYS, "LEDGER_JOINS");
  for (const key of JOIN_KEYS.filter((key) => key.endsWith("sha256"))) {
    assertDigest(joins[key], "LEDGER_JOINS");
  }
  if (typeof joins.source_commit !== "string" || !COMMIT.test(joins.source_commit)) fail("LEDGER_JOINS");
}

function validateTranscript(entry) {
  if (
    typeof entry.final_transcript !== "string" ||
    entry.final_transcript.includes("\0") ||
    hasUnpairedSurrogate(entry.final_transcript)
  ) {
    fail("LEDGER_TRANSCRIPT");
  }
  const transcriptBytes = Buffer.from(entry.final_transcript, "utf8");
  if (transcriptBytes.length > MAX_TRANSCRIPT_UTF8_BYTES) fail("LEDGER_TRANSCRIPT");
  if (
    typeof entry.final_transcript_utf8_bytes !== "string" ||
    !DECIMAL.test(entry.final_transcript_utf8_bytes) ||
    entry.final_transcript_utf8_bytes !== String(transcriptBytes.length)
  ) {
    fail("LEDGER_TRANSCRIPT_COUNT");
  }
  assertDigest(entry.final_transcript_sha256, "LEDGER_TRANSCRIPT_DIGEST");
  if (entry.final_transcript_sha256 !== sha256(transcriptBytes)) fail("LEDGER_TRANSCRIPT_DIGEST");
}

function validateEntry(entry, index, seenSampleIds, previousSampleId) {
  exactKeys(entry, ENTRY_KEYS, "LEDGER_ENTRY_FIELDS");
  if (entry.attempt !== 1) fail("LEDGER_ENTRY_ATTEMPT");
  assertDigest(entry.component_record_sha256, "LEDGER_ENTRY_COMPONENT_JOIN");
  if (!Number.isSafeInteger(entry.sequence) || entry.sequence !== index + 1) fail("LEDGER_ENTRY_SEQUENCE");
  assertIdentifier(entry.sample_id, "LEDGER_ENTRY_SAMPLE");
  if (seenSampleIds.has(entry.sample_id)) fail("LEDGER_ENTRY_DUPLICATE");
  if (previousSampleId !== undefined && previousSampleId >= entry.sample_id) fail("LEDGER_ENTRY_ORDER");
  seenSampleIds.add(entry.sample_id);
  assertDigest(entry.sample_identity_sha256, "LEDGER_ENTRY_SAMPLE");
  if (!LANGUAGES.includes(entry.language)) fail("LEDGER_ENTRY_CLASSIFICATION");
  assertIdentifier(entry.scenario, "LEDGER_ENTRY_CLASSIFICATION");
  if (!SPLITS.includes(entry.split) || !TIERS.includes(entry.tier)) fail("LEDGER_ENTRY_CLASSIFICATION");
  validateTranscript(entry);
}

function validateRecordObject(record) {
  exactKeys(record, ROOT_KEYS, "LEDGER_FIELDS");
  validateAuthority(record.authority);
  validateJoins(record.joins);
  if (record.kind !== KIND || record.schema_version !== SCHEMA_VERSION) fail("LEDGER_SCOPE");
  if (!Array.isArray(record.entries) || record.entries.length < 1 || record.entries.length > MAX_ENTRIES) {
    fail("LEDGER_ENTRIES");
  }
  const seenSampleIds = new Set();
  let previousSampleId;
  record.entries.forEach((entry, index) => {
    validateEntry(entry, index, seenSampleIds, previousSampleId);
    previousSampleId = entry.sample_id;
  });
}

function parseCanonicalRecord(bytes) {
  if (
    !Buffer.isBuffer(bytes) || bytes.length < 2 || bytes.length > MAX_RECORD_BYTES ||
    bytes.at(-1) !== 0x0a || bytes.subarray(0, -1).includes(0x0a) || bytes.includes(0x0d)
  ) {
    fail("LEDGER_CANONICAL_JSON");
  }
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) fail("LEDGER_CANONICAL_JSON");
  let record;
  try {
    record = JSON.parse(text);
  } catch {
    fail("LEDGER_CANONICAL_JSON");
  }
  if (encodeCanonicalJsonLine(record) !== text) fail("LEDGER_CANONICAL_JSON");
  validateRecordObject(record);
  return record;
}

export function validateControlledHypothesisLedgerRecord(bytes) {
  const record = parseCanonicalRecord(bytes);
  return { ledgerSha256: sha256(bytes), record };
}

export function buildControlledHypothesisLedger(input) {
  exactKeys(input, ["entries", "joins"], "LEDGER_BUILD_INPUT");
  const record = {
    authority: { ...AUTHORITY },
    entries: structuredClone(input.entries),
    joins: structuredClone(input.joins),
    kind: KIND,
    schema_version: SCHEMA_VERSION,
  };
  validateRecordObject(record);
  const bytes = Buffer.from(encodeCanonicalJsonLine(record), "utf8");
  return { bytes, ...validateControlledHypothesisLedgerRecord(bytes) };
}

function validateProjection(projection) {
  exactKeys(projection, PROJECTION_ROOT_KEYS, "LEDGER_TEXT_FREE_PROJECTION");
  assertDigest(projection.ledger_sha256, "LEDGER_TEXT_FREE_PROJECTION");
  validateJoins(projection.joins);
  if (!Number.isSafeInteger(projection.entry_count) || projection.entry_count < 1 || projection.entry_count > MAX_ENTRIES) {
    fail("LEDGER_TEXT_FREE_PROJECTION");
  }
  if (!Array.isArray(projection.entries) || projection.entries.length !== projection.entry_count) {
    fail("LEDGER_TEXT_FREE_PROJECTION");
  }
  const seenSampleIds = new Set();
  let previousSampleId;
  projection.entries.forEach((entry, index) => {
    exactKeys(entry, PROJECTION_ENTRY_KEYS, "LEDGER_TEXT_FREE_PROJECTION");
    if (entry.attempt !== 1) fail("LEDGER_TEXT_FREE_PROJECTION");
    if (!Number.isSafeInteger(entry.sequence) || entry.sequence !== index + 1) fail("LEDGER_TEXT_FREE_PROJECTION");
    assertIdentifier(entry.sample_id, "LEDGER_TEXT_FREE_PROJECTION");
    if (seenSampleIds.has(entry.sample_id)) fail("LEDGER_TEXT_FREE_PROJECTION");
    if (previousSampleId !== undefined && previousSampleId >= entry.sample_id) fail("LEDGER_TEXT_FREE_PROJECTION");
    seenSampleIds.add(entry.sample_id);
    previousSampleId = entry.sample_id;
    for (const key of ["final_transcript_sha256", "sample_identity_sha256"]) {
      assertDigest(entry[key], "LEDGER_TEXT_FREE_PROJECTION");
    }
    assertDigest(entry.component_record_sha256, "LEDGER_TEXT_FREE_PROJECTION");
    if (typeof entry.final_transcript_utf8_bytes !== "string" || !DECIMAL.test(entry.final_transcript_utf8_bytes)) {
      fail("LEDGER_TEXT_FREE_PROJECTION");
    }
    if (!LANGUAGES.includes(entry.language)) fail("LEDGER_TEXT_FREE_PROJECTION");
    assertIdentifier(entry.scenario, "LEDGER_TEXT_FREE_PROJECTION");
    if (!SPLITS.includes(entry.split) || !TIERS.includes(entry.tier)) fail("LEDGER_TEXT_FREE_PROJECTION");
  });
}

export function projectControlledHypothesisLedgerTextFree(bytes) {
  const ledgerBytes = Buffer.isBuffer(bytes) ? Buffer.from(bytes) : bytes;
  const validated = validateControlledHypothesisLedgerRecord(ledgerBytes);
  const projection = {
    entries: validated.record.entries.map((entry) => ({
      attempt: entry.attempt,
      component_record_sha256: entry.component_record_sha256,
      final_transcript_sha256: entry.final_transcript_sha256,
      final_transcript_utf8_bytes: entry.final_transcript_utf8_bytes,
      language: entry.language,
      sample_id: entry.sample_id,
      sample_identity_sha256: entry.sample_identity_sha256,
      scenario: entry.scenario,
      sequence: entry.sequence,
      split: entry.split,
      tier: entry.tier,
    })),
    entry_count: validated.record.entries.length,
    joins: structuredClone(validated.record.joins),
    ledger_sha256: validated.ledgerSha256,
  };
  validateProjection(projection);
  return { bytes: Buffer.from(encodeCanonicalJsonLine(projection), "utf8"), projection };
}

function validateSealCount(value, code) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_ENTRIES) fail(code);
}

function validateSealSize(value, code) {
  if (
    typeof value !== "string" ||
    value.length > String(MAX_RECORD_BYTES).length ||
    !DECIMAL.test(value)
  ) {
    fail(code);
  }
  const parsed = BigInt(value);
  if (parsed < 1n || parsed > BigInt(MAX_RECORD_BYTES)) fail(code);
}

function validateSealRecordObject(record) {
  exactKeys(record, SEAL_ROOT_KEYS, "LEDGER_SEAL_FIELDS");
  exactKeys(record.authority, Object.keys(SEAL_AUTHORITY), "LEDGER_SEAL_AUTHORITY");
  if (!isDeepStrictEqual(record.authority, SEAL_AUTHORITY)) fail("LEDGER_SEAL_AUTHORITY");
  if (record.kind !== SEAL_KIND || record.schema_version !== SCHEMA_VERSION) fail("LEDGER_SEAL_SCOPE");

  exactKeys(record.private_ledger, SEAL_LEDGER_KEYS, "LEDGER_SEAL_LEDGER_IDENTITY");
  if (
    record.private_ledger.kind !== KIND ||
    record.private_ledger.schema_version !== SCHEMA_VERSION
  ) {
    fail("LEDGER_SEAL_LEDGER_IDENTITY");
  }
  assertDigest(record.private_ledger.sha256, "LEDGER_SEAL_LEDGER_IDENTITY");
  validateSealCount(record.private_ledger.entry_count, "LEDGER_SEAL_LEDGER_IDENTITY");
  validateSealSize(record.private_ledger.size_bytes, "LEDGER_SEAL_LEDGER_IDENTITY");

  exactKeys(record.text_free_projection, SEAL_PROJECTION_KEYS, "LEDGER_SEAL_PROJECTION");
  assertDigest(record.text_free_projection.sha256, "LEDGER_SEAL_PROJECTION");
  validateSealCount(record.text_free_projection.entry_count, "LEDGER_SEAL_PROJECTION");
  validateSealSize(record.text_free_projection.size_bytes, "LEDGER_SEAL_PROJECTION");
  if (record.text_free_projection.entry_count !== record.private_ledger.entry_count) {
    fail("LEDGER_SEAL_PROJECTION");
  }
}

function parseCanonicalSealRecord(bytes) {
  if (
    !Buffer.isBuffer(bytes) || bytes.length < 2 || bytes.length > MAX_RECORD_BYTES ||
    bytes.at(-1) !== 0x0a || bytes.subarray(0, -1).includes(0x0a) || bytes.includes(0x0d)
  ) {
    fail("LEDGER_SEAL_CANONICAL_JSON");
  }
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) fail("LEDGER_SEAL_CANONICAL_JSON");
  let record;
  try {
    record = JSON.parse(text);
  } catch {
    fail("LEDGER_SEAL_CANONICAL_JSON");
  }
  if (encodeCanonicalJsonLine(record) !== text) fail("LEDGER_SEAL_CANONICAL_JSON");
  validateSealRecordObject(record);
  return record;
}

export function validateControlledHypothesisLedgerSealRecord(bytes) {
  const record = parseCanonicalSealRecord(bytes);
  return { record, sealSha256: sha256(bytes) };
}

function expectedSealIdentity(ledgerBytes) {
  const privateLedgerBytes = Buffer.isBuffer(ledgerBytes) ? Buffer.from(ledgerBytes) : ledgerBytes;
  const ledger = validateControlledHypothesisLedgerRecord(privateLedgerBytes);
  const projected = projectControlledHypothesisLedgerTextFree(privateLedgerBytes);
  return {
    ledger,
    privateLedgerBytes,
    projected,
    private_ledger: {
      entry_count: ledger.record.entries.length,
      kind: KIND,
      schema_version: SCHEMA_VERSION,
      sha256: ledger.ledgerSha256,
      size_bytes: String(privateLedgerBytes.length),
    },
    text_free_projection: {
      entry_count: projected.projection.entry_count,
      sha256: sha256(projected.bytes),
      size_bytes: String(projected.bytes.length),
    },
  };
}

function validateSealBindingRecord(record, ledgerBytes) {
  const expected = expectedSealIdentity(ledgerBytes);
  if (
    !isDeepStrictEqual(record.private_ledger, expected.private_ledger) ||
    !isDeepStrictEqual(record.text_free_projection, expected.text_free_projection)
  ) {
    fail("LEDGER_SEAL_BINDING");
  }
  return expected;
}

export function validateControlledHypothesisLedgerSealBinding(sealBytes, ledgerBytes) {
  const seal = validateControlledHypothesisLedgerSealRecord(sealBytes);
  const expected = validateSealBindingRecord(seal.record, ledgerBytes);
  return {
    ledgerSha256: expected.ledger.ledgerSha256,
    projectionSha256: expected.text_free_projection.sha256,
    record: seal.record,
    sealSha256: seal.sealSha256,
  };
}

export function buildControlledHypothesisLedgerSeal(ledgerBytes) {
  const expected = expectedSealIdentity(ledgerBytes);
  const record = {
    authority: { ...SEAL_AUTHORITY },
    kind: SEAL_KIND,
    private_ledger: expected.private_ledger,
    schema_version: SCHEMA_VERSION,
    text_free_projection: expected.text_free_projection,
  };
  validateSealRecordObject(record);
  const bytes = Buffer.from(encodeCanonicalJsonLine(record), "utf8");
  const validated = validateControlledHypothesisLedgerSealBinding(bytes, expected.privateLedgerBytes);
  return {
    bytes,
    ledgerSha256: validated.ledgerSha256,
    projectionBytes: expected.projected.bytes,
    projectionSha256: validated.projectionSha256,
    record: validated.record,
    sealSha256: validated.sealSha256,
  };
}

function sameIdentity(left, right) {
  const usable = (value) =>
    value !== null && typeof value === "object" &&
    typeof value.dev === "bigint" && value.dev > 0n &&
    typeof value.ino === "bigint" && value.ino > 0n &&
    typeof value.mode === "bigint";
  return usable(left) && usable(right) &&
    left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}

function sameStableFile(left, right) {
  return sameIdentity(left, right) && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function assertDirectPathChain(inputPath, finalKind, code, operations) {
  const lstatImpl = operations.lstatImpl ?? lstat;
  const absolute = path.resolve(inputPath);
  const root = path.parse(absolute).root;
  const segments = path.relative(root, absolute).split(path.sep).filter(Boolean);
  if (segments.length === 0) {
    const metadata = await lstatImpl(root, { bigint: true }).catch(() => fail(code));
    if (
      metadata.isSymbolicLink() ||
      (finalKind === "directory" && !metadata.isDirectory()) ||
      (finalKind === "file" && !metadata.isFile())
    ) {
      fail(code);
    }
    return absolute;
  }
  let current = root;
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    const metadata = await lstatImpl(current, { bigint: true }).catch(() => fail(code));
    const final = index === segments.length - 1;
    if (
      metadata.isSymbolicLink() || (!final && !metadata.isDirectory()) ||
      (final && finalKind === "directory" && !metadata.isDirectory()) ||
      (final && finalKind === "file" && !metadata.isFile())
    ) {
      fail(code);
    }
  }
  return absolute;
}

function validateControlledLocation(controlledRoot, relativePath) {
  if (
    typeof controlledRoot !== "string" || controlledRoot.length === 0 ||
    /^[\\/]{2}/u.test(controlledRoot) ||
    !path.isAbsolute(controlledRoot) || path.normalize(controlledRoot) !== controlledRoot
  ) {
    fail("LEDGER_CONTROLLED_ROOT");
  }
  if (
    typeof relativePath !== "string" || relativePath.length === 0 ||
    Buffer.byteLength(relativePath, "utf8") > MAX_RELATIVE_PATH_BYTES ||
    path.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath) || path.posix.isAbsolute(relativePath) ||
    relativePath.includes("\0") || relativePath.includes(":")
  ) {
    fail("LEDGER_RELATIVE_PATH");
  }
  const segments = relativePath.split(/[\\/]/u);
  if (
    segments.length === 0 || segments.some((segment) =>
      segment.length === 0 || segment === "." || segment === ".." ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(segment) ||
      segment.endsWith(".") || WINDOWS_DOS_DEVICE.test(segment)
    ) || segments.join(path.sep) !== relativePath
  ) {
    fail("LEDGER_RELATIVE_PATH");
  }
  const root = path.resolve(controlledRoot);
  const target = path.resolve(root, ...segments);
  if (target === root || !isWithin(root, target)) fail("LEDGER_RELATIVE_PATH");
  return { parent: path.dirname(target), root, target };
}

async function inspectControlledLocation(controlledRoot, relativePath, targetKind, operations = {}) {
  const lstatImpl = operations.lstatImpl ?? lstat;
  const realpathImpl = operations.realpathImpl ?? realpath;
  const location = validateControlledLocation(controlledRoot, relativePath);
  await assertDirectPathChain(location.root, "directory", "LEDGER_CONTROLLED_ROOT", operations);
  await assertDirectPathChain(location.parent, "directory", "LEDGER_RELATIVE_PATH", operations);
  const [rootStat, parentStat, rootRealpath, parentRealpath] = await Promise.all([
    lstatImpl(location.root, { bigint: true }),
    lstatImpl(location.parent, { bigint: true }),
    realpathImpl(location.root),
    realpathImpl(location.parent),
  ]).catch(() => fail("LEDGER_RELATIVE_PATH"));
  if (!rootStat.isDirectory() || !parentStat.isDirectory() || !isWithin(rootRealpath, parentRealpath)) {
    fail("LEDGER_RELATIVE_PATH");
  }
  if (targetKind === "new") {
    try {
      await lstatImpl(location.target, { bigint: true });
    } catch (error) {
      if (error?.code === "ENOENT") {
        return { ...location, parentStat, rootStat };
      }
      fail("LEDGER_PUBLICATION");
    }
    fail("LEDGER_PUBLICATION");
  }
  await assertDirectPathChain(location.target, "file", "LEDGER_INPUT", operations);
  const targetRealpath = await realpathImpl(location.target).catch(() => fail("LEDGER_INPUT"));
  if (!isWithin(rootRealpath, targetRealpath)) fail("LEDGER_INPUT");
  return { ...location, parentStat, rootStat };
}

async function assertLocationIdentity(snapshot, targetKind, operations) {
  const current = await inspectControlledLocation(
    snapshot.root,
    path.relative(snapshot.root, snapshot.target),
    targetKind,
    operations,
  );
  if (!sameIdentity(snapshot.rootStat, current.rootStat) || !sameIdentity(snapshot.parentStat, current.parentStat)) {
    fail(targetKind === "new" ? "LEDGER_PUBLICATION" : "LEDGER_INPUT");
  }
  return current;
}

async function readHandleBytesAtPosition(handle, size, code) {
  if (typeof size !== "bigint" || size < 0n || size > BigInt(MAX_RECORD_BYTES)) fail(code);
  const length = Number(size);
  const bytes = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const result = await handle.read(bytes, offset, length - offset, offset).catch(() => fail(code));
    if (
      result === null || typeof result !== "object" || !Number.isSafeInteger(result.bytesRead) ||
      result.bytesRead <= 0 || result.bytesRead > length - offset
    ) {
      fail(code);
    }
    offset += result.bytesRead;
  }
  const probe = Buffer.alloc(1);
  const end = await handle.read(probe, 0, 1, length).catch(() => fail(code));
  if (end === null || typeof end !== "object" || end.bytesRead !== 0) fail(code);
  return bytes;
}

async function readStableFile(filePath, code, operations = {}) {
  const lstatImpl = operations.lstatImpl ?? lstat;
  const realpathImpl = operations.realpathImpl ?? realpath;
  const openFile = operations.openReadFile ?? open;
  const beforePath = await lstatImpl(filePath, { bigint: true }).catch(() => fail(code));
  const beforeRealpath = await realpathImpl(filePath).catch(() => fail(code));
  if (!beforePath.isFile() || beforePath.isSymbolicLink()) fail(code);
  let handle;
  let firstBytes;
  let secondBytes;
  let beforeHandle;
  let middleHandle;
  let afterHandle;
  try {
    handle = await openFile(filePath, "r");
    beforeHandle = await handle.stat({ bigint: true });
    if (!beforeHandle.isFile() || !sameStableFile(beforePath, beforeHandle)) fail(code);
    firstBytes = await readHandleBytesAtPosition(handle, beforeHandle.size, code);
    middleHandle = await handle.stat({ bigint: true });
    secondBytes = await readHandleBytesAtPosition(handle, beforeHandle.size, code);
    afterHandle = await handle.stat({ bigint: true });
  } catch (error) {
    if (error instanceof ControlledHypothesisLedgerError) throw error;
    fail(code, { cause: error });
  } finally {
    if (handle !== undefined) {
      try { await handle.close(); } catch { fail(code); }
    }
  }
  const [afterPath, afterRealpath] = await Promise.all([
    lstatImpl(filePath, { bigint: true }),
    realpathImpl(filePath),
  ]).catch(() => fail(code));
  if (
    !Buffer.isBuffer(firstBytes) || !Buffer.isBuffer(secondBytes) || !firstBytes.equals(secondBytes) ||
    !sameStableFile(beforePath, afterPath) || !sameStableFile(beforeHandle, middleHandle) ||
    !sameStableFile(middleHandle, afterHandle) || beforeRealpath !== afterRealpath ||
    BigInt(firstBytes.length) !== afterPath.size
  ) {
    fail(code);
  }
  return { bytes: firstBytes, stat: afterPath };
}

async function readControlledRecordMaterial(
  controlledRoot,
  relativePath,
  validateRecord,
  operations = {},
) {
  const snapshot = await inspectControlledLocation(controlledRoot, relativePath, "file", operations);
  const stable = await readStableFile(snapshot.target, "LEDGER_INPUT", operations);
  const validated = validateRecord(stable.bytes);
  await assertLocationIdentity(snapshot, "file", operations);
  const after = await (operations.lstatImpl ?? lstat)(snapshot.target, { bigint: true }).catch(() => fail("LEDGER_INPUT"));
  if (!sameStableFile(stable.stat, after)) fail("LEDGER_INPUT");
  return { bytes: stable.bytes, stat: after, target: snapshot.target, validated };
}

export async function readControlledHypothesisLedger(controlledRoot, relativePath, operations = {}) {
  const material = await readControlledRecordMaterial(
    controlledRoot,
    relativePath,
    validateControlledHypothesisLedgerRecord,
    operations,
  );
  return material.validated;
}

async function publishControlledRecord(
  controlledRoot,
  relativePath,
  bytes,
  validateRecord,
  operations = {},
) {
  const expectedBytes = Buffer.isBuffer(bytes) ? Buffer.from(bytes) : bytes;
  validateRecord(expectedBytes);
  const snapshot = await inspectControlledLocation(controlledRoot, relativePath, "new", operations);
  const suffix = (operations.randomSuffix ?? (() => randomBytes(16).toString("hex")))();
  if (typeof suffix !== "string" || !/^[0-9a-f]{32}$/u.test(suffix)) fail("LEDGER_PUBLICATION");
  const stagingPath = path.join(snapshot.parent, `.${path.basename(snapshot.target)}.${suffix}.staging`);
  const openFile = operations.openFile ?? open;
  const linkFile = operations.linkFile ?? link;
  const readFileBytes = operations.readFileBytes ?? readFile;
  const lstatImpl = operations.lstatImpl ?? lstat;
  let handle;
  let ownedIdentity;
  let completed = false;
  let failure = false;
  try {
    handle = await openFile(stagingPath, "wx", 0o600);
    ownedIdentity = await handle.stat({ bigint: true });
    if (!ownedIdentity.isFile()) fail("LEDGER_PUBLICATION");
    await handle.writeFile(expectedBytes);
    await handle.sync();
    const handleStat = await handle.stat({ bigint: true });
    await handle.close();
    handle = undefined;
    const stagedBefore = await lstatImpl(stagingPath, { bigint: true });
    if (!handleStat.isFile() || !sameStableFile(handleStat, stagedBefore)) fail("LEDGER_PUBLICATION");
    const stagedBytes = await readFileBytes(stagingPath);
    const stagedAfter = await lstatImpl(stagingPath, { bigint: true });
    if (
      !Buffer.isBuffer(stagedBytes) || !stagedBytes.equals(expectedBytes) ||
      !sameStableFile(stagedBefore, stagedAfter) || BigInt(stagedBytes.length) !== stagedAfter.size
    ) {
      fail("LEDGER_PUBLICATION");
    }
    validateRecord(stagedBytes);
    await assertLocationIdentity(snapshot, "new", operations);
    await linkFile(stagingPath, snapshot.target);
    const linkedTarget = await lstatImpl(snapshot.target, { bigint: true });
    const linkedStaging = await lstatImpl(stagingPath, { bigint: true });
    if (
      !sameIdentity(ownedIdentity, stagedAfter) ||
      !sameIdentity(ownedIdentity, linkedStaging) ||
      !sameStableFile(linkedStaging, linkedTarget)
    ) {
      fail("LEDGER_PUBLICATION");
    }
    const persistedBytes = await readFileBytes(snapshot.target);
    const persistedAfter = await lstatImpl(snapshot.target, { bigint: true });
    if (
      !Buffer.isBuffer(persistedBytes) || !persistedBytes.equals(expectedBytes) ||
      !sameStableFile(linkedTarget, persistedAfter) || BigInt(persistedBytes.length) !== persistedAfter.size
    ) {
      fail("LEDGER_PUBLICATION");
    }
    validateRecord(persistedBytes);
    const current = await inspectControlledLocation(controlledRoot, relativePath, "file", operations);
    const finalTarget = await lstatImpl(snapshot.target, { bigint: true });
    if (
      !sameIdentity(snapshot.rootStat, current.rootStat) ||
      !sameIdentity(snapshot.parentStat, current.parentStat) ||
      !sameStableFile(persistedAfter, finalTarget)
    ) {
      fail("LEDGER_PUBLICATION");
    }
    // Never delete a staging pathname inside this API. A pathname can be
    // replaced between an identity check and unlink, which would let a
    // successful publication delete a competitor. Lifecycle cleanup must use
    // a handle/file-ID-bound primitive or re-establish ownership out of band.
    completed = true;
  } catch {
    failure = true;
  } finally {
    if (handle !== undefined) {
      try { await handle.close(); } catch { failure = true; }
    }
  }
  if (failure || !completed) fail("LEDGER_PUBLICATION");
  return snapshot.target;
}

export async function publishControlledHypothesisLedger(
  controlledRoot,
  relativePath,
  bytes,
  operations = {},
) {
  return publishControlledRecord(
    controlledRoot,
    relativePath,
    bytes,
    validateControlledHypothesisLedgerRecord,
    operations,
  );
}

function assertDistinctControlledTargets(controlledRoot, sealRelativePath, ledgerRelativePath) {
  const sealLocation = validateControlledLocation(controlledRoot, sealRelativePath);
  const ledgerLocation = validateControlledLocation(controlledRoot, ledgerRelativePath);
  const targetKey = (value) => process.platform === "win32" ? value.toLowerCase() : value;
  if (targetKey(sealLocation.target) === targetKey(ledgerLocation.target)) fail("LEDGER_SEAL_PATH");
}

function assertSameLedgerMaterial(before, after) {
  if (!sameStableFile(before.stat, after.stat) || !before.bytes.equals(after.bytes)) {
    fail("LEDGER_SEAL_LEDGER_CHANGED");
  }
}

export async function readControlledHypothesisLedgerSeal(
  controlledRoot,
  sealRelativePath,
  ledgerRelativePath,
  operations = {},
) {
  assertDistinctControlledTargets(controlledRoot, sealRelativePath, ledgerRelativePath);
  const ledgerBefore = await readControlledRecordMaterial(
    controlledRoot,
    ledgerRelativePath,
    validateControlledHypothesisLedgerRecord,
    operations,
  );
  const seal = await readControlledRecordMaterial(
    controlledRoot,
    sealRelativePath,
    validateControlledHypothesisLedgerSealRecord,
    operations,
  );
  const binding = validateControlledHypothesisLedgerSealBinding(seal.bytes, ledgerBefore.bytes);
  const ledgerAfter = await readControlledRecordMaterial(
    controlledRoot,
    ledgerRelativePath,
    validateControlledHypothesisLedgerRecord,
    operations,
  );
  assertSameLedgerMaterial(ledgerBefore, ledgerAfter);
  return binding;
}

export async function publishControlledHypothesisLedgerSeal(
  controlledRoot,
  sealRelativePath,
  ledgerRelativePath,
  bytes,
  operations = {},
) {
  assertDistinctControlledTargets(controlledRoot, sealRelativePath, ledgerRelativePath);
  const expectedBytes = Buffer.isBuffer(bytes) ? Buffer.from(bytes) : bytes;
  const ledgerBefore = await readControlledRecordMaterial(
    controlledRoot,
    ledgerRelativePath,
    validateControlledHypothesisLedgerRecord,
    operations,
  );
  validateControlledHypothesisLedgerSealBinding(expectedBytes, ledgerBefore.bytes);
  const target = await publishControlledRecord(
    controlledRoot,
    sealRelativePath,
    expectedBytes,
    validateControlledHypothesisLedgerSealRecord,
    operations,
  );
  const [sealAfter, ledgerAfter] = await Promise.all([
    readControlledRecordMaterial(
      controlledRoot,
      sealRelativePath,
      validateControlledHypothesisLedgerSealRecord,
      operations,
    ),
    readControlledRecordMaterial(
      controlledRoot,
      ledgerRelativePath,
      validateControlledHypothesisLedgerRecord,
      operations,
    ),
  ]);
  assertSameLedgerMaterial(ledgerBefore, ledgerAfter);
  if (!sealAfter.bytes.equals(expectedBytes)) fail("LEDGER_SEAL_PUBLICATION");
  validateControlledHypothesisLedgerSealBinding(sealAfter.bytes, ledgerAfter.bytes);
  return target;
}
