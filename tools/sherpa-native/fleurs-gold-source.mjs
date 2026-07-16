import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { encodeCanonicalJsonLine } from "../phase0-harness/canonical-json.mjs";

const POLICY_KIND = "meetingrelay-fleurs-gold-source-policy-v1";
const PRIVATE_KIND = "meetingrelay-fleurs-gold-source-private-selection-v1";
const PROJECTION_KIND = "meetingrelay-fleurs-gold-source-text-free-projection-v1";
const RIGHTS_KIND = "meetingrelay-fleurs-rights-decision-v1";
const SCHEMA_VERSION = "1.0";
const MAX_POLICY_BYTES = 64 * 1024;
const MAX_DATASET_CARD_BYTES = 1024 * 1024;
const MAX_TSV_BYTES = 2 * 1024 * 1024;
const MAX_PRIVATE_BYTES = 4 * 1024 * 1024;
const MAX_PROJECTION_BYTES = 64 * 1024;
const MAX_REFERENCE_BYTES = 64 * 1024;
const DIGEST = /^(?!0{64}$)[0-9a-f]{64}$/u;
const SOURCE_ID = /^[1-9][0-9]{0,19}$/u;
const WAV_FILENAME = /^[1-9][0-9]{0,19}\.wav$/u;
const POSITIVE_DECIMAL = /^[1-9][0-9]{0,8}$/u;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;

const AUTHORITY = Object.freeze({
  benchmark_overlap: "unknown",
  evidence_classification: "internal-descriptive-only",
  formal_claims: "none",
  production_evidence: false,
  public_distribution: false,
  quality_gate_status: "not-assessed",
});
const DATASET = Object.freeze({
  dataset_card: Object.freeze({
    repository_path: "README.md",
    sha256: "688f79f2a5c731af3796e9f683eb02f9b3f09d040decd8c5625d0f37098e71c6",
    size_bytes: 385614,
  }),
  dataset_id: "google/fleurs",
  revision: "70bb2e84b976b7e960aa89f1c648e09c59f894dd",
  split: "test",
});
const RIGHTS = Object.freeze({
  allowed_purpose: "asr-quality-component-measurement",
  attribution_required: true,
  attribution_url: "https://huggingface.co/datasets/google/fleurs",
  change_notice_required: true,
  citation_url: "https://arxiv.org/abs/2205.12446",
  consent_clearance: "upstream-undocumented",
  decision_scope: "engineering-policy-not-legal-advice",
  decision_status: "approved-with-conditions",
  legal_review: "not-performed",
  license: "CC-BY-4.0",
  license_url: "https://creativecommons.org/licenses/by/4.0/",
  public_distribution: false,
});
const SELECTION = Object.freeze({
  common_id_count: 320,
  filename_tie_breaker: "sha256-utf8-lexicographic-ascending",
  selected_utterance_count: 960,
});
const SOURCES = Object.freeze([
  Object.freeze({
    config: "en_us",
    language: "en",
    test_archive: Object.freeze({
      lfs_sha256: "d9c2e37b41aacd41bc283554a0a82b5476b36887049774ecb2819dcaaa55a356",
      repository_path: "data/en_us/audio/test.tar.gz",
      size_bytes: 289851356,
    }),
    test_tsv: Object.freeze({
      repository_path: "data/en_us/test.tsv",
      row_count: 647,
      sha256: "74c046239374deeb60fa63f258f907388093a32bcaa3140965f70ef05c79f7ca",
      size_bytes: 367864,
    }),
  }),
  Object.freeze({
    config: "ja_jp",
    language: "ja",
    test_archive: Object.freeze({
      lfs_sha256: "5de465fa7aaafc4e2c13aba44771550b8cd2dd29bb9b265daeb6d92ca8e0c136",
      repository_path: "data/ja_jp/audio/test.tar.gz",
      size_bytes: 448762391,
    }),
    test_tsv: Object.freeze({
      repository_path: "data/ja_jp/test.tsv",
      row_count: 650,
      sha256: "5dd9643511437414681ad3f23508596c621cdf78978724a09f1f06fefe9d300b",
      size_bytes: 361174,
    }),
  }),
  Object.freeze({
    config: "cmn_hans_cn",
    language: "zh",
    test_archive: Object.freeze({
      lfs_sha256: "09d19ad18f5d7e91076880807e866cd16abd924c7052b55f71cdae91714fc166",
      repository_path: "data/cmn_hans_cn/audio/test.tar.gz",
      size_bytes: 525346466,
    }),
    test_tsv: Object.freeze({
      repository_path: "data/cmn_hans_cn/test.tsv",
      row_count: 945,
      sha256: "5734461648f816181d7dab5fc79204b18c4b9bc2cd5138225b25c72d18385d21",
      size_bytes: 491487,
    }),
  }),
]);
const CONFIGS = Object.freeze(SOURCES.map((source) => source.config));
const SOURCE_BY_CONFIG = new Map(SOURCES.map((source) => [source.config, source]));

const POLICY_ROOT_KEYS = Object.freeze([
  "authority",
  "dataset",
  "kind",
  "rights",
  "schema_version",
  "selection",
  "source_contract_status",
  "sources",
]);
const SOURCE_KEYS = Object.freeze(["config", "language", "test_archive", "test_tsv"]);
const ARCHIVE_KEYS = Object.freeze(["lfs_sha256", "repository_path", "size_bytes"]);
const TSV_IDENTITY_KEYS = Object.freeze(["repository_path", "row_count", "sha256", "size_bytes"]);
const PRIVATE_ROOT_KEYS = Object.freeze([
  "authority",
  "common_id_count",
  "dataset",
  "kind",
  "policy_sha256",
  "rights_decision_sha256",
  "schema_version",
  "selected_utterance_count",
  "selections",
  "source_contract_status",
]);
const PRIVATE_ENTRY_KEYS = Object.freeze([
  "config",
  "filename",
  "filename_sha256",
  "language",
  "num_samples",
  "reference",
  "reference_sha256",
  "reference_utf8_bytes",
  "sequence",
  "source_id",
]);
const PROJECTION_ROOT_KEYS = Object.freeze([
  "authority",
  "common_id_count",
  "dataset_card_sha256",
  "dataset_card_size_bytes",
  "kind",
  "policy_sha256",
  "rights_decision_sha256",
  "schema_version",
  "selected_utterance_count",
  "selection_sha256",
  "source_contract_status",
  "sources",
]);
const PROJECTION_SOURCE_KEYS = Object.freeze([
  "config",
  "language",
  "selected_utterance_count",
  "test_archive_lfs_sha256",
  "test_archive_size_bytes",
  "test_tsv_row_count",
  "test_tsv_sha256",
  "test_tsv_size_bytes",
]);
const RIGHTS_DECISION_KEYS = Object.freeze([
  "allowed_purpose",
  "attribution_required",
  "attribution_url",
  "change_notice_required",
  "citation_url",
  "consent_clearance",
  "dataset_card_sha256",
  "dataset_card_size_bytes",
  "dataset_id",
  "dataset_revision",
  "decision_scope",
  "decision_status",
  "kind",
  "legal_review",
  "license",
  "license_url",
  "policy_sha256",
  "public_distribution",
  "schema_version",
  "source_contract_status",
]);

export class FleursGoldSourceError extends Error {
  constructor(code, options = {}) {
    super(code, options);
    this.name = "FleursGoldSourceError";
    this.code = code;
  }
}

function fail(code, options = {}) {
  throw new FleursGoldSourceError(code, options);
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

function assertExactObject(value, expected, code) {
  exactKeys(value, Object.keys(expected), code);
  if (!isDeepStrictEqual(value, expected)) fail(code);
}

function parseCanonicalJsonLine(bytes, maximumBytes, code) {
  if (
    !Buffer.isBuffer(bytes) || bytes.length < 2 || bytes.length > maximumBytes ||
    bytes.at(-1) !== 0x0a || bytes.subarray(0, -1).includes(0x0a) ||
    bytes.includes(0x0d) ||
    (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
  ) {
    fail(code);
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail(code);
  }
  if (text.includes("\ufeff") || !Buffer.from(text, "utf8").equals(bytes)) fail(code);
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    fail(code);
  }
  if (encodeCanonicalJsonLine(value) !== text) fail(code);
  return value;
}

function validatePolicyObject(policy) {
  exactKeys(policy, POLICY_ROOT_KEYS, "FGS_POLICY_FIELDS");
  assertExactObject(policy.authority, AUTHORITY, "FGS_POLICY_AUTHORITY");
  assertExactObject(policy.dataset, DATASET, "FGS_POLICY_DATASET");
  assertExactObject(policy.rights, RIGHTS, "FGS_POLICY_RIGHTS");
  assertExactObject(policy.selection, SELECTION, "FGS_POLICY_SELECTION");
  if (policy.kind !== POLICY_KIND || policy.schema_version !== SCHEMA_VERSION) {
    fail("FGS_POLICY_SCOPE");
  }
  if (policy.source_contract_status !== "frozen-source-readiness") {
    fail("FGS_POLICY_SCOPE");
  }
  if (!Array.isArray(policy.sources) || policy.sources.length !== SOURCES.length) {
    fail("FGS_POLICY_SOURCES");
  }
  policy.sources.forEach((source, index) => {
    exactKeys(source, SOURCE_KEYS, "FGS_POLICY_SOURCE_FIELDS");
    exactKeys(source.test_archive, ARCHIVE_KEYS, "FGS_POLICY_ARCHIVE_FIELDS");
    exactKeys(source.test_tsv, TSV_IDENTITY_KEYS, "FGS_POLICY_TSV_FIELDS");
    if (!isDeepStrictEqual(source, SOURCES[index])) fail("FGS_POLICY_SOURCE_IDENTITY");
  });
}

export function validateFleursGoldSourcePolicyBytes(bytes) {
  const policy = parseCanonicalJsonLine(bytes, MAX_POLICY_BYTES, "FGS_POLICY_CANONICAL_JSON_REQUIRED");
  validatePolicyObject(policy);
  return { policy, policySha256: sha256(bytes) };
}

export function buildFleursGoldSourcePolicy(policy) {
  validatePolicyObject(policy);
  const bytes = Buffer.from(encodeCanonicalJsonLine(policy), "utf8");
  return { bytes, ...validateFleursGoldSourcePolicyBytes(bytes) };
}

function buildRightsDecisionRecord(policy, policySha256) {
  validatePolicyObject(policy);
  assertDigest(policySha256, "FGS_RIGHTS_POLICY_DIGEST");
  return {
    allowed_purpose: policy.rights.allowed_purpose,
    attribution_required: policy.rights.attribution_required,
    attribution_url: policy.rights.attribution_url,
    change_notice_required: policy.rights.change_notice_required,
    citation_url: policy.rights.citation_url,
    consent_clearance: policy.rights.consent_clearance,
    dataset_card_sha256: policy.dataset.dataset_card.sha256,
    dataset_card_size_bytes: policy.dataset.dataset_card.size_bytes,
    dataset_id: policy.dataset.dataset_id,
    dataset_revision: policy.dataset.revision,
    decision_scope: policy.rights.decision_scope,
    decision_status: policy.rights.decision_status,
    kind: RIGHTS_KIND,
    legal_review: policy.rights.legal_review,
    license: policy.rights.license,
    license_url: policy.rights.license_url,
    policy_sha256: policySha256,
    public_distribution: policy.rights.public_distribution,
    schema_version: SCHEMA_VERSION,
    source_contract_status: policy.source_contract_status,
  };
}

function validateRightsDecisionObject(record, expectedPolicySha256) {
  exactKeys(record, RIGHTS_DECISION_KEYS, "FGS_RIGHTS_FIELDS");
  assertDigest(expectedPolicySha256, "FGS_RIGHTS_TRUST_REQUIRED");
  const expected = buildRightsDecisionRecord({
    authority: { ...AUTHORITY },
    dataset: { ...DATASET },
    kind: POLICY_KIND,
    rights: { ...RIGHTS },
    schema_version: SCHEMA_VERSION,
    selection: { ...SELECTION },
    source_contract_status: "frozen-source-readiness",
    sources: structuredClone(SOURCES),
  }, expectedPolicySha256);
  if (!isDeepStrictEqual(record, expected)) fail("FGS_RIGHTS_BINDING");
}

export function validateFleursRightsDecisionBytes(bytes, input) {
  exactKeys(input, ["expectedPolicySha256"], "FGS_RIGHTS_INPUT_FIELDS");
  const record = parseCanonicalJsonLine(bytes, MAX_POLICY_BYTES, "FGS_RIGHTS_CANONICAL_JSON_REQUIRED");
  validateRightsDecisionObject(record, input.expectedPolicySha256);
  return { record, rightsDecisionSha256: sha256(bytes) };
}

export function buildFleursRightsDecision(policy, policySha256) {
  const record = buildRightsDecisionRecord(policy, policySha256);
  const bytes = Buffer.from(encodeCanonicalJsonLine(record), "utf8");
  return { bytes, ...validateFleursRightsDecisionBytes(bytes, { expectedPolicySha256: policySha256 }) };
}

function assertCanonicalText(value, code, maximumBytes = MAX_REFERENCE_BYTES) {
  if (
    typeof value !== "string" || value.length === 0 || value !== value.normalize("NFC") ||
    value.includes("\ufeff") || CONTROL_CHARACTER.test(value) ||
    Buffer.byteLength(value, "utf8") > maximumBytes
  ) {
    fail(code);
  }
}

function parseStrictFleursTsv(bytes, expectedRowCount = undefined) {
  if (
    !Buffer.isBuffer(bytes) || bytes.length < 2 || bytes.length > MAX_TSV_BYTES ||
    bytes.at(-1) !== 0x0a || bytes.includes(0x0d) || bytes.includes(0x00) ||
    (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
  ) {
    fail("FGS_TSV_CANONICAL_INVALID");
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("FGS_TSV_UTF8_INVALID");
  }
  if (!Buffer.from(text, "utf8").equals(bytes)) fail("FGS_TSV_UTF8_INVALID");
  if (text.includes("\ufeff") || text !== text.normalize("NFC")) {
    fail("FGS_TSV_CANONICAL_INVALID");
  }
  const body = text.slice(0, -1);
  if (body.length === 0 || body.endsWith("\n") || body.includes("\n\n")) {
    fail("FGS_TSV_CANONICAL_INVALID");
  }
  const lines = body.split("\n");
  if (expectedRowCount !== undefined && lines.length !== expectedRowCount) {
    fail("FGS_TSV_ROW_COUNT_MISMATCH");
  }
  const seenFilenames = new Set();
  const rows = lines.map((line) => {
    const fields = line.split("\t");
    if (fields.length !== 7) fail("FGS_TSV_ROW_FIELDS");
    const [sourceId, filename, rawTranscription, reference, characterTokens, numberSamples, gender] = fields;
    if (!SOURCE_ID.test(sourceId)) fail("FGS_TSV_SOURCE_ID");
    if (!WAV_FILENAME.test(filename) || filename !== filename.normalize("NFC")) {
      fail("FGS_TSV_FILENAME");
    }
    if (seenFilenames.has(filename)) fail("FGS_TSV_DUPLICATE_FILENAME");
    seenFilenames.add(filename);
    assertCanonicalText(rawTranscription, "FGS_TSV_RAW_TRANSCRIPTION");
    assertCanonicalText(reference, "FGS_TSV_REFERENCE");
    assertCanonicalText(characterTokens, "FGS_TSV_CHARACTER_TOKENS");
    if (!POSITIVE_DECIMAL.test(numberSamples) || Number(numberSamples) > 100_000_000) {
      fail("FGS_TSV_NUM_SAMPLES");
    }
    if (gender !== "FEMALE" && gender !== "MALE") fail("FGS_TSV_GENDER");
    return Object.freeze({
      filename,
      numSamples: Number(numberSamples),
      reference,
      sourceId,
    });
  });
  return Object.freeze(rows);
}

function validateBoundTsv(bytes, source) {
  if (bytes.length !== source.test_tsv.size_bytes) fail("FGS_TSV_SIZE_MISMATCH");
  if (sha256(bytes) !== source.test_tsv.sha256) fail("FGS_TSV_DIGEST_MISMATCH");
  return parseStrictFleursTsv(bytes, source.test_tsv.row_count);
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function selectCommonRows(
  rowsByConfig,
  expectedCommonIdCount,
  expectedSelectedUtteranceCount,
  filenameDigest = (filename) => sha256(Buffer.from(filename, "utf8")),
) {
  const rowsById = new Map();
  for (const config of CONFIGS) {
    const rows = rowsByConfig[config];
    if (!Array.isArray(rows)) fail("FGS_SELECTION_INPUT");
    const grouped = new Map();
    for (const row of rows) {
      const values = grouped.get(row.sourceId) ?? [];
      values.push(row);
      grouped.set(row.sourceId, values);
    }
    rowsById.set(config, grouped);
  }
  const first = rowsById.get(CONFIGS[0]);
  const commonIds = [...first.keys()]
    .filter((sourceId) => CONFIGS.every((config) => rowsById.get(config).has(sourceId)))
    .sort(compareUtf8);
  if (commonIds.length !== expectedCommonIdCount) fail("FGS_COMMON_ID_COUNT_MISMATCH");

  const entries = [];
  for (const source of SOURCES) {
    const grouped = rowsById.get(source.config);
    for (const sourceId of commonIds) {
      const ranked = grouped.get(sourceId).map((row) => {
        const filenameSha256 = filenameDigest(row.filename);
        assertDigest(filenameSha256, "FGS_SELECTION_FILENAME_DIGEST");
        return { ...row, filenameSha256 };
      }).sort((left, right) => {
        const byDigest = compareUtf8(left.filenameSha256, right.filenameSha256);
        return byDigest === 0 ? compareUtf8(left.filename, right.filename) : byDigest;
      });
      if (
        ranked.length > 1 && ranked[0].filenameSha256 === ranked[1].filenameSha256 &&
        ranked[0].filename !== ranked[1].filename
      ) {
        fail("FGS_SELECTION_AMBIGUOUS");
      }
      const selected = ranked[0];
      const referenceBytes = Buffer.from(selected.reference, "utf8");
      entries.push({
        config: source.config,
        filename: selected.filename,
        filename_sha256: selected.filenameSha256,
        language: source.language,
        num_samples: selected.numSamples,
        reference: selected.reference,
        reference_sha256: sha256(referenceBytes),
        reference_utf8_bytes: referenceBytes.length,
        sequence: entries.length + 1,
        source_id: sourceId,
      });
    }
  }
  if (entries.length !== expectedSelectedUtteranceCount) {
    fail("FGS_SELECTION_COUNT_MISMATCH");
  }
  return { commonIds, entries };
}

function validatePrivateSelectionObject(record, expectedPolicySha256, expectedRightsDecisionSha256) {
  exactKeys(record, PRIVATE_ROOT_KEYS, "FGS_PRIVATE_FIELDS");
  assertDigest(expectedPolicySha256, "FGS_PRIVATE_TRUST_REQUIRED");
  assertDigest(expectedRightsDecisionSha256, "FGS_PRIVATE_TRUST_REQUIRED");
  assertExactObject(record.authority, AUTHORITY, "FGS_PRIVATE_AUTHORITY");
  assertExactObject(record.dataset, DATASET, "FGS_PRIVATE_DATASET");
  if (
    record.kind !== PRIVATE_KIND || record.schema_version !== SCHEMA_VERSION ||
    record.policy_sha256 !== expectedPolicySha256 ||
    record.rights_decision_sha256 !== expectedRightsDecisionSha256 ||
    record.source_contract_status !== "frozen-source-readiness"
  ) {
    fail("FGS_PRIVATE_BINDING");
  }
  if (
    record.common_id_count !== SELECTION.common_id_count ||
    record.selected_utterance_count !== SELECTION.selected_utterance_count ||
    !Array.isArray(record.selections) || record.selections.length !== SELECTION.selected_utterance_count
  ) {
    fail("FGS_PRIVATE_COUNT");
  }

  const idsByConfig = [];
  const filenamesByConfig = new Map(CONFIGS.map((config) => [config, new Set()]));
  record.selections.forEach((entry, index) => {
    exactKeys(entry, PRIVATE_ENTRY_KEYS, "FGS_PRIVATE_ENTRY_FIELDS");
    const sourceIndex = Math.floor(index / SELECTION.common_id_count);
    const source = SOURCES[sourceIndex];
    if (
      source === undefined || entry.sequence !== index + 1 ||
      entry.config !== source.config || entry.language !== source.language
    ) {
      fail("FGS_PRIVATE_ENTRY_ORDER");
    }
    if (!SOURCE_ID.test(entry.source_id)) fail("FGS_PRIVATE_ENTRY_IDENTITY");
    if (
      !Number.isSafeInteger(entry.num_samples) || entry.num_samples < 1 ||
      entry.num_samples > 100_000_000
    ) {
      fail("FGS_PRIVATE_ENTRY_NUM_SAMPLES");
    }
    if (!WAV_FILENAME.test(entry.filename) || entry.filename !== entry.filename.normalize("NFC")) {
      fail("FGS_PRIVATE_ENTRY_IDENTITY");
    }
    const seenFilenames = filenamesByConfig.get(entry.config);
    if (seenFilenames.has(entry.filename)) fail("FGS_PRIVATE_ENTRY_IDENTITY");
    seenFilenames.add(entry.filename);
    assertDigest(entry.filename_sha256, "FGS_PRIVATE_ENTRY_IDENTITY");
    if (entry.filename_sha256 !== sha256(Buffer.from(entry.filename, "utf8"))) {
      fail("FGS_PRIVATE_ENTRY_IDENTITY");
    }
    assertCanonicalText(entry.reference, "FGS_PRIVATE_ENTRY_REFERENCE");
    const referenceBytes = Buffer.from(entry.reference, "utf8");
    assertDigest(entry.reference_sha256, "FGS_PRIVATE_ENTRY_REFERENCE");
    if (
      entry.reference_sha256 !== sha256(referenceBytes) ||
      entry.reference_utf8_bytes !== referenceBytes.length
    ) {
      fail("FGS_PRIVATE_ENTRY_REFERENCE");
    }
    const withinConfigIndex = index % SELECTION.common_id_count;
    if (withinConfigIndex > 0) {
      const previous = record.selections[index - 1];
      if (compareUtf8(previous.source_id, entry.source_id) >= 0) fail("FGS_PRIVATE_ENTRY_ORDER");
    }
    if (sourceIndex === 0) {
      idsByConfig[withinConfigIndex] = entry.source_id;
    } else if (idsByConfig[withinConfigIndex] !== entry.source_id) {
      fail("FGS_PRIVATE_COMMON_IDS");
    }
  });
}

export function validateFleursGoldPrivateSelectionBytes(bytes, input) {
  exactKeys(
    input,
    ["expectedPolicySha256", "expectedRightsDecisionSha256"],
    "FGS_PRIVATE_INPUT_FIELDS",
  );
  const record = parseCanonicalJsonLine(bytes, MAX_PRIVATE_BYTES, "FGS_PRIVATE_CANONICAL_JSON_REQUIRED");
  validatePrivateSelectionObject(
    record,
    input.expectedPolicySha256,
    input.expectedRightsDecisionSha256,
  );
  return { record, selectionSha256: sha256(bytes) };
}

function projectionSource(source) {
  return {
    config: source.config,
    language: source.language,
    selected_utterance_count: SELECTION.common_id_count,
    test_archive_lfs_sha256: source.test_archive.lfs_sha256,
    test_archive_size_bytes: source.test_archive.size_bytes,
    test_tsv_row_count: source.test_tsv.row_count,
    test_tsv_sha256: source.test_tsv.sha256,
    test_tsv_size_bytes: source.test_tsv.size_bytes,
  };
}

function validateTextFreeProjectionObject(record, input) {
  exactKeys(record, PROJECTION_ROOT_KEYS, "FGS_PROJECTION_FIELDS");
  for (const key of [
    "expectedPolicySha256",
    "expectedRightsDecisionSha256",
    "expectedSelectionSha256",
  ]) {
    assertDigest(input[key], "FGS_PROJECTION_TRUST_REQUIRED");
  }
  assertExactObject(record.authority, AUTHORITY, "FGS_PROJECTION_AUTHORITY");
  if (
    record.kind !== PROJECTION_KIND || record.schema_version !== SCHEMA_VERSION ||
    record.common_id_count !== SELECTION.common_id_count ||
    record.selected_utterance_count !== SELECTION.selected_utterance_count ||
    record.dataset_card_sha256 !== DATASET.dataset_card.sha256 ||
    record.dataset_card_size_bytes !== DATASET.dataset_card.size_bytes ||
    record.policy_sha256 !== input.expectedPolicySha256 ||
    record.rights_decision_sha256 !== input.expectedRightsDecisionSha256 ||
    record.selection_sha256 !== input.expectedSelectionSha256 ||
    record.source_contract_status !== "frozen-source-readiness"
  ) {
    fail("FGS_PROJECTION_BINDING");
  }
  if (!Array.isArray(record.sources) || record.sources.length !== SOURCES.length) {
    fail("FGS_PROJECTION_SOURCES");
  }
  record.sources.forEach((source, index) => {
    exactKeys(source, PROJECTION_SOURCE_KEYS, "FGS_PROJECTION_SOURCE_FIELDS");
    if (!isDeepStrictEqual(source, projectionSource(SOURCES[index]))) {
      fail("FGS_PROJECTION_SOURCE_BINDING");
    }
  });
}

export function validateFleursGoldTextFreeProjectionBytes(bytes, input) {
  exactKeys(
    input,
    ["expectedPolicySha256", "expectedRightsDecisionSha256", "expectedSelectionSha256"],
    "FGS_PROJECTION_INPUT_FIELDS",
  );
  const record = parseCanonicalJsonLine(bytes, MAX_PROJECTION_BYTES, "FGS_PROJECTION_CANONICAL_JSON_REQUIRED");
  validateTextFreeProjectionObject(record, input);
  return { projectionSha256: sha256(bytes), record };
}

function buildSelectionArtifacts(policy, policySha256, rowsByConfig) {
  validatePolicyObject(policy);
  assertDigest(policySha256, "FGS_POLICY_TRUST_REQUIRED");
  const rightsDecision = buildFleursRightsDecision(policy, policySha256);
  const selected = selectCommonRows(
    rowsByConfig,
    policy.selection.common_id_count,
    policy.selection.selected_utterance_count,
  );
  const privateRecord = {
    authority: { ...policy.authority },
    common_id_count: selected.commonIds.length,
    dataset: { ...policy.dataset },
    kind: PRIVATE_KIND,
    policy_sha256: policySha256,
    rights_decision_sha256: rightsDecision.rightsDecisionSha256,
    schema_version: SCHEMA_VERSION,
    selected_utterance_count: selected.entries.length,
    selections: selected.entries,
    source_contract_status: policy.source_contract_status,
  };
  const privateBytes = Buffer.from(encodeCanonicalJsonLine(privateRecord), "utf8");
  const privateSelection = validateFleursGoldPrivateSelectionBytes(privateBytes, {
    expectedPolicySha256: policySha256,
    expectedRightsDecisionSha256: rightsDecision.rightsDecisionSha256,
  });
  const projectionRecord = {
    authority: { ...policy.authority },
    common_id_count: selected.commonIds.length,
    dataset_card_sha256: policy.dataset.dataset_card.sha256,
    dataset_card_size_bytes: policy.dataset.dataset_card.size_bytes,
    kind: PROJECTION_KIND,
    policy_sha256: policySha256,
    rights_decision_sha256: rightsDecision.rightsDecisionSha256,
    schema_version: SCHEMA_VERSION,
    selected_utterance_count: selected.entries.length,
    selection_sha256: privateSelection.selectionSha256,
    source_contract_status: policy.source_contract_status,
    sources: policy.sources.map(projectionSource),
  };
  const projectionBytes = Buffer.from(encodeCanonicalJsonLine(projectionRecord), "utf8");
  const textFreeProjection = validateFleursGoldTextFreeProjectionBytes(projectionBytes, {
    expectedPolicySha256: policySha256,
    expectedRightsDecisionSha256: rightsDecision.rightsDecisionSha256,
    expectedSelectionSha256: privateSelection.selectionSha256,
  });
  return {
    policy: { policy, policySha256 },
    privateSelection: { bytes: privateBytes, ...privateSelection },
    rightsDecision,
    textFreeProjection: { bytes: projectionBytes, ...textFreeProjection },
  };
}

function isCanonicalLocalAbsolutePath(value) {
  if (
    typeof value !== "string" || value.length === 0 || value.includes("\0") ||
    /^[\\/]{2}/u.test(value) || !path.isAbsolute(value) ||
    path.normalize(value) !== value || path.resolve(value) !== value ||
    value.normalize("NFC") !== value
  ) {
    return false;
  }
  return !value.slice(path.parse(value).root.length).includes(":");
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

async function assertDirectFilePath(inputPath, code, operations) {
  if (!isCanonicalLocalAbsolutePath(inputPath)) fail(code);
  const lstatImpl = operations.lstatImpl ?? lstat;
  const root = path.parse(inputPath).root;
  const segments = path.relative(root, inputPath).split(path.sep).filter(Boolean);
  let current = root;
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    const metadata = await lstatImpl(current, { bigint: true }).catch(() => fail(code));
    const final = index === segments.length - 1;
    if (
      metadata.isSymbolicLink() || (!final && !metadata.isDirectory()) ||
      (final && !metadata.isFile())
    ) {
      fail(code);
    }
  }
  return inputPath;
}

async function readHandleBytes(handle, size, maximumBytes, code) {
  if (typeof size !== "bigint" || size < 1n || size > BigInt(maximumBytes)) fail(code);
  const bytes = Buffer.alloc(Number(size));
  let offset = 0;
  while (offset < bytes.length) {
    const result = await handle.read(bytes, offset, bytes.length - offset, offset)
      .catch(() => fail(code));
    if (
      result === null || typeof result !== "object" ||
      !Number.isSafeInteger(result.bytesRead) || result.bytesRead <= 0 ||
      result.bytesRead > bytes.length - offset
    ) {
      fail(code);
    }
    offset += result.bytesRead;
  }
  const probe = Buffer.alloc(1);
  const end = await handle.read(probe, 0, 1, bytes.length).catch(() => fail(code));
  if (end === null || typeof end !== "object" || end.bytesRead !== 0) fail(code);
  return bytes;
}

async function readStableDirectFile(filePath, inputKind, maximumBytes, operations) {
  const codes = inputKind === "policy"
    ? ["FGS_POLICY_PATH", "FGS_POLICY_INPUT", "FGS_POLICY_INPUT_CHANGED"]
    : inputKind === "dataset-card"
      ? ["FGS_DATASET_CARD_PATH", "FGS_DATASET_CARD_INPUT", "FGS_DATASET_CARD_INPUT_CHANGED"]
      : ["FGS_TSV_PATH", "FGS_TSV_INPUT", "FGS_TSV_INPUT_CHANGED"];
  const [pathCode, inputCode, changedCode] = codes;
  const canonicalPath = await assertDirectFilePath(filePath, pathCode, operations);
  const lstatImpl = operations.lstatImpl ?? lstat;
  const realpathImpl = operations.realpathImpl ?? realpath;
  const openFile = operations.openReadFile ?? open;
  const [pathBefore, realpathBefore] = await Promise.all([
    lstatImpl(canonicalPath, { bigint: true }),
    realpathImpl(canonicalPath),
  ]).catch(() => fail(inputCode));
  if (!pathBefore.isFile() || pathBefore.isSymbolicLink()) fail(inputCode);

  let handle;
  let firstBytes;
  let secondBytes;
  let handleBefore;
  let handleMiddle;
  let handleAfter;
  try {
    handle = await openFile(canonicalPath, "r");
    handleBefore = await handle.stat({ bigint: true });
    if (!handleBefore.isFile() || !sameStableFile(pathBefore, handleBefore)) fail(inputCode);
    firstBytes = await readHandleBytes(handle, handleBefore.size, maximumBytes, inputCode);
    handleMiddle = await handle.stat({ bigint: true });
    secondBytes = await readHandleBytes(handle, handleBefore.size, maximumBytes, inputCode);
    handleAfter = await handle.stat({ bigint: true });
  } catch (error) {
    if (error instanceof FleursGoldSourceError) throw error;
    fail(inputCode, { cause: error });
  } finally {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch {
        fail(inputCode);
      }
    }
  }
  if (!firstBytes.equals(secondBytes)) fail(changedCode);
  const [pathAfter, realpathAfter] = await Promise.all([
    lstatImpl(canonicalPath, { bigint: true }),
    realpathImpl(canonicalPath),
  ]).catch(() => fail(inputCode));
  if (
    !sameStableFile(pathBefore, pathAfter) ||
    !sameStableFile(handleBefore, handleMiddle) ||
    !sameStableFile(handleMiddle, handleAfter) ||
    !sameStableFile(handleAfter, pathAfter) ||
    realpathBefore !== realpathAfter || BigInt(firstBytes.length) !== pathAfter.size
  ) {
    fail(changedCode);
  }
  return firstBytes;
}

export async function readPinnedFleursGoldSourcePolicy(input, operations = {}) {
  exactKeys(input, ["expectedPolicySha256", "policyPath"], "FGS_POLICY_INPUT_FIELDS");
  assertDigest(input.expectedPolicySha256, "FGS_POLICY_EXTERNAL_EXPECTED_SHA_REQUIRED");
  const bytes = await readStableDirectFile(input.policyPath, "policy", MAX_POLICY_BYTES, operations);
  const validated = validateFleursGoldSourcePolicyBytes(bytes);
  if (validated.policySha256 !== input.expectedPolicySha256) {
    fail("FGS_POLICY_DIGEST_MISMATCH");
  }
  return validated;
}

function validateBoundDatasetCard(bytes, identity) {
  if (bytes.length !== identity.size_bytes) fail("FGS_DATASET_CARD_SIZE_MISMATCH");
  if (sha256(bytes) !== identity.sha256) fail("FGS_DATASET_CARD_DIGEST_MISMATCH");
  return Object.freeze({
    sha256: identity.sha256,
    sizeBytes: identity.size_bytes,
  });
}

async function readPinnedDatasetCard(datasetCardPath, identity, operations) {
  const bytes = await readStableDirectFile(
    datasetCardPath,
    "dataset-card",
    MAX_DATASET_CARD_BYTES,
    operations,
  );
  return validateBoundDatasetCard(bytes, identity);
}

export async function loadPinnedFleursGoldSource(input, operations = {}) {
  exactKeys(
    input,
    ["datasetCardPath", "expectedPolicySha256", "policyPath", "tsvPaths"],
    "FGS_INPUT_FIELDS",
  );
  exactKeys(input.tsvPaths, CONFIGS, "FGS_TSV_PATHS");
  const pinnedPolicy = await readPinnedFleursGoldSourcePolicy({
    expectedPolicySha256: input.expectedPolicySha256,
    policyPath: input.policyPath,
  }, operations);
  const datasetCardReader = operations.datasetCardReader ?? readPinnedDatasetCard;
  const [datasetCard, ...tsvBytes] = await Promise.all([
    datasetCardReader(
      input.datasetCardPath,
      pinnedPolicy.policy.dataset.dataset_card,
      operations,
    ),
    ...SOURCES.map((source) =>
      readStableDirectFile(input.tsvPaths[source.config], "tsv", MAX_TSV_BYTES, operations)),
  ]);
  const rowsByConfig = Object.fromEntries(SOURCES.map((source, index) => [
    source.config,
    validateBoundTsv(tsvBytes[index], source),
  ]));
  const artifacts = buildSelectionArtifacts(
    pinnedPolicy.policy,
    pinnedPolicy.policySha256,
    rowsByConfig,
  );
  return { ...artifacts, datasetCard };
}

export function __parseFleursTsvBytesForTest(bytes, expectedRowCount = undefined) {
  return parseStrictFleursTsv(bytes, expectedRowCount);
}

export async function __readPinnedFleursDatasetCardForTest(input, operations = {}) {
  exactKeys(
    input,
    ["datasetCardPath", "expectedSha256", "expectedSizeBytes"],
    "FGS_DATASET_CARD_TEST_INPUT",
  );
  assertDigest(input.expectedSha256, "FGS_DATASET_CARD_TEST_INPUT");
  if (!Number.isSafeInteger(input.expectedSizeBytes) || input.expectedSizeBytes < 1) {
    fail("FGS_DATASET_CARD_TEST_INPUT");
  }
  return readPinnedDatasetCard(input.datasetCardPath, {
    sha256: input.expectedSha256,
    size_bytes: input.expectedSizeBytes,
  }, operations);
}

export function __selectFleursRowsForTest(tsvBytesByConfig, input, operations = {}) {
  exactKeys(tsvBytesByConfig, CONFIGS, "FGS_SELECTION_INPUT");
  exactKeys(
    input,
    ["expectedCommonIdCount", "expectedSelectedUtteranceCount"],
    "FGS_SELECTION_INPUT",
  );
  const rowsByConfig = Object.fromEntries(CONFIGS.map((config) => [
    config,
    parseStrictFleursTsv(tsvBytesByConfig[config]),
  ]));
  return selectCommonRows(
    rowsByConfig,
    input.expectedCommonIdCount,
    input.expectedSelectedUtteranceCount,
    operations.filenameSha256,
  );
}

export function __buildFleursGoldSourceArtifactsFromTsvBytesForTest(input) {
  exactKeys(
    input,
    ["policy", "policySha256", "tsvBytesByConfig"],
    "FGS_TEST_BUILD_INPUT",
  );
  exactKeys(input.tsvBytesByConfig, CONFIGS, "FGS_TEST_BUILD_INPUT");
  const rowsByConfig = Object.fromEntries(CONFIGS.map((config) => [
    config,
    parseStrictFleursTsv(input.tsvBytesByConfig[config]),
  ]));
  return buildSelectionArtifacts(input.policy, input.policySha256, rowsByConfig);
}
