import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdtemp,
  open,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { encodeCanonicalJsonLine } from "../phase0-harness/canonical-json.mjs";
import {
  FleursGoldSourceError,
  __buildFleursGoldSourceArtifactsFromTsvBytesForTest,
  __parseFleursTsvBytesForTest,
  __readPinnedFleursDatasetCardForTest,
  __selectFleursRowsForTest,
  buildFleursGoldSourcePolicy,
  buildFleursRightsDecision,
  loadPinnedFleursGoldSource,
  readPinnedFleursGoldSourcePolicy,
  validateFleursGoldPrivateSelectionBytes,
  validateFleursGoldSourcePolicyBytes,
  validateFleursGoldTextFreeProjectionBytes,
  validateFleursRightsDecisionBytes,
} from "./fleurs-gold-source.mjs";

const POLICY_SHA256 = "9a659b87a5c12dacf749226d6c51a7be1edbb98c6fae313293c985cbeda1da2c";
const DATASET_CARD_SHA256 = "688f79f2a5c731af3796e9f683eb02f9b3f09d040decd8c5625d0f37098e71c6";
const CONFIGS = ["en_us", "ja_jp", "cmn_hans_cn"];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value) {
  return Buffer.from(encodeCanonicalJsonLine(value), "utf8");
}

async function policyBytes() {
  return readFile(new URL("./fleurs-gold-source-policy.json", import.meta.url));
}

async function policy() {
  return JSON.parse((await policyBytes()).toString("utf8"));
}

function row({
  characterTokens = "r e f |",
  filename,
  gender = "FEMALE",
  numberSamples = "16000",
  rawTranscription,
  reference,
  sourceId,
}) {
  return [
    sourceId,
    filename,
    rawTranscription ?? `Raw ${reference}`,
    reference,
    characterTokens,
    numberSamples,
    gender,
  ].join("\t");
}

function tsv(rows) {
  return Buffer.from(`${rows.join("\n")}\n`, "utf8");
}

function smallTsvBytes() {
  return {
    en_us: tsv([
      row({ sourceId: "1", filename: "100.wav", reference: "english first a" }),
      row({ sourceId: "1", filename: "200.wav", reference: "english first b" }),
      row({ sourceId: "2", filename: "300.wav", reference: "english second" }),
      row({ sourceId: "9", filename: "900.wav", reference: "english only" }),
    ]),
    ja_jp: tsv([
      row({ sourceId: "1", filename: "110.wav", reference: "日本語一" }),
      row({ sourceId: "2", filename: "210.wav", reference: "日本語二" }),
      row({ sourceId: "8", filename: "810.wav", reference: "日本語のみ" }),
    ]),
    cmn_hans_cn: tsv([
      row({ sourceId: "1", filename: "120.wav", reference: "中文一" }),
      row({ sourceId: "2", filename: "220.wav", reference: "中文二" }),
      row({ sourceId: "7", filename: "720.wav", reference: "仅中文" }),
    ]),
  };
}

function fullTsvBytes() {
  const prefixes = { en_us: "1", ja_jp: "2", cmn_hans_cn: "3" };
  const labels = { en_us: "english", ja_jp: "日本語", cmn_hans_cn: "中文" };
  return Object.fromEntries(CONFIGS.map((config) => {
    const rows = [];
    for (let value = 1000; value < 1320; value += 1) {
      rows.push(row({
        sourceId: String(value),
        filename: `${prefixes[config]}${value}.wav`,
        reference: `${labels[config]} ${value}`,
      }));
    }
    if (config === "en_us") {
      rows.push(row({
        sourceId: "1000",
        filename: "91000.wav",
        reference: "english alternate 1000",
      }));
    }
    return [config, tsv(rows)];
  }));
}

async function temporaryDirectory(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "meetingrelay-fleurs-source-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  return root;
}

test("committed policy is canonical, externally pinnable, and freezes exact upstream identities", async () => {
  const bytes = await policyBytes();
  const parsed = await policy();
  assert.equal(bytes.length, 2384);
  assert.equal(bytes.at(-1), 0x0a);
  assert.equal(bytes.includes(0x0d), false);
  assert.equal(sha256(bytes), POLICY_SHA256);

  const validated = validateFleursGoldSourcePolicyBytes(bytes);
  assert.equal(validated.policySha256, POLICY_SHA256);
  assert.deepEqual(validated.policy, parsed);
  assert.deepEqual(buildFleursGoldSourcePolicy(parsed).bytes, bytes);
  assert.equal(parsed.dataset.dataset_id, "google/fleurs");
  assert.equal(parsed.dataset.revision, "70bb2e84b976b7e960aa89f1c648e09c59f894dd");
  assert.equal(parsed.dataset.split, "test");
  assert.deepEqual(parsed.dataset.dataset_card, {
    repository_path: "README.md",
    sha256: DATASET_CARD_SHA256,
    size_bytes: 385614,
  });
  assert.equal(parsed.source_contract_status, "frozen-source-readiness");
  assert.deepEqual(parsed.sources.map((source) => source.config), CONFIGS);
  assert.deepEqual(parsed.sources.map((source) => source.test_tsv.row_count), [647, 650, 945]);
  assert.deepEqual(parsed.sources.map((source) => source.test_tsv.size_bytes), [367864, 361174, 491487]);
  assert.deepEqual(parsed.sources.map((source) => source.test_archive.size_bytes), [
    289851356, 448762391, 525346466,
  ]);
  assert.deepEqual(parsed.sources.map((source) => source.test_archive.repository_path), [
    "data/en_us/audio/test.tar.gz",
    "data/ja_jp/audio/test.tar.gz",
    "data/cmn_hans_cn/audio/test.tar.gz",
  ]);
});

test("policy canonical JSON, exact fields, frozen revision, source identities, rights, and ceilings fail closed", async () => {
  const bytes = await policyBytes();
  const parsed = await policy();
  const cases = [
    ["pretty", Buffer.from(`${JSON.stringify(parsed, null, 2)}\n`, "utf8")],
    ["missing newline", bytes.subarray(0, -1)],
    ["CRLF", Buffer.from(`${bytes.toString("utf8").trimEnd()}\r\n`, "utf8")],
    ["BOM", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes])],
  ];
  const mutate = (name, callback) => {
    const value = structuredClone(parsed);
    callback(value);
    cases.push([name, canonical(value)]);
  };
  mutate("unknown field", (value) => { value.thresholds = []; });
  mutate("moving revision", (value) => { value.dataset.revision = "main"; });
  mutate("wrong split", (value) => { value.dataset.split = "validation"; });
  mutate("dataset card path", (value) => { value.dataset.dataset_card.repository_path = "CARD.md"; });
  mutate("dataset card digest", (value) => { value.dataset.dataset_card.sha256 = "a".repeat(64); });
  mutate("dataset card size", (value) => { value.dataset.dataset_card.size_bytes = 385613; });
  mutate("quality promotion", (value) => { value.authority.quality_gate_status = "passed"; });
  mutate("production promotion", (value) => { value.authority.production_evidence = true; });
  mutate("distribution promotion", (value) => { value.authority.public_distribution = true; });
  mutate("overlap promotion", (value) => { value.authority.benchmark_overlap = "none"; });
  mutate("legal claim", (value) => { value.rights.legal_review = "performed"; });
  mutate("consent claim", (value) => { value.rights.consent_clearance = "cleared"; });
  mutate("purpose broadening", (value) => { value.rights.allowed_purpose = "all-product-use"; });
  mutate("archive object path", (value) => { value.sources[0].test_archive.repository_path = "test.tar.gz"; });
  mutate("TSV digest", (value) => { value.sources[1].test_tsv.sha256 = "a".repeat(64); });
  mutate("selection count", (value) => { value.selection.common_id_count = 319; });

  for (const [name, invalidBytes] of cases) {
    assert.throws(
      () => validateFleursGoldSourcePolicyBytes(invalidBytes),
      FleursGoldSourceError,
      name,
    );
  }
});

test("pinned policy read requires an external digest and rejects mismatch, relative paths, and reread drift", async (t) => {
  const root = await temporaryDirectory(t);
  const bytes = await policyBytes();
  const policyPath = path.join(root, "policy.json");
  await writeFile(policyPath, bytes, { flag: "wx" });
  const validated = await readPinnedFleursGoldSourcePolicy({
    expectedPolicySha256: POLICY_SHA256,
    policyPath,
  });
  assert.equal(validated.policySha256, POLICY_SHA256);

  await assert.rejects(
    readPinnedFleursGoldSourcePolicy({ expectedPolicySha256: undefined, policyPath }),
    { code: "FGS_POLICY_EXTERNAL_EXPECTED_SHA_REQUIRED" },
  );
  await assert.rejects(
    readPinnedFleursGoldSourcePolicy({ expectedPolicySha256: "a".repeat(64), policyPath }),
    { code: "FGS_POLICY_DIGEST_MISMATCH" },
  );
  await assert.rejects(
    readPinnedFleursGoldSourcePolicy({
      expectedPolicySha256: POLICY_SHA256,
      policyPath: "relative-policy.json",
    }),
    { code: "FGS_POLICY_PATH" },
  );

  const changed = Buffer.from(bytes);
  changed[100] ^= 1;
  const metadata = await lstat(policyPath, { bigint: true });
  let pass = 0;
  await assert.rejects(readPinnedFleursGoldSourcePolicy({
    expectedPolicySha256: POLICY_SHA256,
    policyPath,
  }, {
    openReadFile: async () => ({
      close: async () => {},
      read: async (buffer, offset, length, position) => {
        if (position >= bytes.length) return { buffer, bytesRead: 0 };
        if (position === 0) pass += 1;
        const source = pass === 1 ? bytes : changed;
        const bytesRead = Math.min(length, source.length - position);
        source.copy(buffer, offset, position, position + bytesRead);
        return { buffer, bytesRead };
      },
      stat: async () => metadata,
    }),
  }), { code: "FGS_POLICY_INPUT_CHANGED" });
});

test("file-based dataset card load accepts stable exact bytes and rejects path, size, digest, and reread drift", async (t) => {
  const root = await temporaryDirectory(t);
  const cardBytes = Buffer.from("license: cc-by-4.0\nrevision: frozen\n", "utf8");
  const datasetCardPath = path.join(root, "README.md");
  await writeFile(datasetCardPath, cardBytes, { flag: "wx" });
  const input = {
    datasetCardPath,
    expectedSha256: sha256(cardBytes),
    expectedSizeBytes: cardBytes.length,
  };
  assert.deepEqual(await __readPinnedFleursDatasetCardForTest(input), {
    sha256: sha256(cardBytes),
    sizeBytes: cardBytes.length,
  });
  await assert.rejects(
    __readPinnedFleursDatasetCardForTest({ ...input, datasetCardPath: "README.md" }),
    { code: "FGS_DATASET_CARD_PATH" },
  );
  await assert.rejects(
    __readPinnedFleursDatasetCardForTest({ ...input, expectedSizeBytes: cardBytes.length + 1 }),
    { code: "FGS_DATASET_CARD_SIZE_MISMATCH" },
  );
  await assert.rejects(
    __readPinnedFleursDatasetCardForTest({ ...input, expectedSha256: "a".repeat(64) }),
    { code: "FGS_DATASET_CARD_DIGEST_MISMATCH" },
  );

  const changed = Buffer.from(cardBytes);
  changed[0] ^= 1;
  const metadata = await lstat(datasetCardPath, { bigint: true });
  let pass = 0;
  await assert.rejects(__readPinnedFleursDatasetCardForTest(input, {
    openReadFile: async () => ({
      close: async () => {},
      read: async (buffer, offset, length, position) => {
        if (position >= cardBytes.length) return { buffer, bytesRead: 0 };
        if (position === 0) pass += 1;
        const source = pass === 1 ? cardBytes : changed;
        const bytesRead = Math.min(length, source.length - position);
        source.copy(buffer, offset, position, position + bytesRead);
        return { buffer, bytesRead };
      },
      stat: async () => metadata,
    }),
  }), { code: "FGS_DATASET_CARD_INPUT_CHANGED" });
});

test("file-based source load binds exact TSV size and digest and rejects positional reread drift", async (t) => {
  const root = await temporaryDirectory(t);
  const committedPolicy = await policyBytes();
  const policyPath = path.join(root, "policy.json");
  await writeFile(policyPath, committedPolicy, { flag: "wx" });
  const datasetCardPath = path.join(root, "README.md");
  await writeFile(datasetCardPath, Buffer.from("test-only card\n", "utf8"), { flag: "wx" });
  const validSmall = tsv([row({ sourceId: "1", filename: "100.wav", reference: "ref" })]);
  const tsvPaths = Object.fromEntries(CONFIGS.map((config) => [config, path.join(root, `${config}.tsv`)]));
  for (const filePath of Object.values(tsvPaths)) {
    await writeFile(filePath, validSmall, { flag: "wx" });
  }
  const input = { datasetCardPath, expectedPolicySha256: POLICY_SHA256, policyPath, tsvPaths };
  const cardBypass = {
    datasetCardReader: async () => ({ sha256: DATASET_CARD_SHA256, sizeBytes: 385614 }),
  };
  await assert.rejects(
    loadPinnedFleursGoldSource(input, cardBypass),
    { code: "FGS_TSV_SIZE_MISMATCH" },
  );

  await writeFile(tsvPaths.en_us, Buffer.alloc(367864, 0x61));
  await assert.rejects(
    loadPinnedFleursGoldSource(input, cardBypass),
    { code: "FGS_TSV_DIGEST_MISMATCH" },
  );
  await writeFile(tsvPaths.en_us, validSmall);

  const changed = Buffer.from(validSmall);
  changed[0] = changed[0] === 0x31 ? 0x32 : 0x31;
  const metadata = await lstat(tsvPaths.en_us, { bigint: true });
  let pass = 0;
  await assert.rejects(loadPinnedFleursGoldSource(input, {
    ...cardBypass,
    openReadFile: async (filePath, mode) => {
      if (filePath !== tsvPaths.en_us) return open(filePath, mode);
      return {
        close: async () => {},
        read: async (buffer, offset, length, position) => {
          if (position >= validSmall.length) return { buffer, bytesRead: 0 };
          if (position === 0) pass += 1;
          const source = pass === 1 ? validSmall : changed;
          const bytesRead = Math.min(length, source.length - position);
          source.copy(buffer, offset, position, position + bytesRead);
          return { buffer, bytesRead };
        },
        stat: async () => metadata,
      };
    },
  }), { code: "FGS_TSV_INPUT_CHANGED" });
});

test("rights decision is canonical, copyable, policy-bound, conditional, and explicitly not legal advice", async () => {
  const parsed = await policy();
  const built = buildFleursRightsDecision(parsed, POLICY_SHA256);
  assert.equal(built.record.kind, "meetingrelay-fleurs-rights-decision-v1");
  assert.equal(built.record.decision_status, "approved-with-conditions");
  assert.equal(built.record.allowed_purpose, "asr-quality-component-measurement");
  assert.equal(built.record.attribution_required, true);
  assert.equal(built.record.change_notice_required, true);
  assert.equal(built.record.consent_clearance, "upstream-undocumented");
  assert.equal(built.record.legal_review, "not-performed");
  assert.equal(built.record.decision_scope, "engineering-policy-not-legal-advice");
  assert.equal(built.record.public_distribution, false);
  assert.equal(built.record.dataset_card_sha256, DATASET_CARD_SHA256);
  assert.equal(built.record.dataset_card_size_bytes, 385614);
  assert.equal("dataset_card_repository_path" in built.record, false);
  assert.equal(built.record.policy_sha256, POLICY_SHA256);
  assert.equal(built.bytes.at(-1), 0x0a);
  assert.equal(built.rightsDecisionSha256, sha256(built.bytes));
  assert.deepEqual(validateFleursRightsDecisionBytes(built.bytes, {
    expectedPolicySha256: POLICY_SHA256,
  }).record, built.record);

  const tampered = structuredClone(built.record);
  tampered.legal_review = "performed";
  assert.throws(
    () => validateFleursRightsDecisionBytes(canonical(tampered), {
      expectedPolicySha256: POLICY_SHA256,
    }),
    { code: "FGS_RIGHTS_BINDING" },
  );
});

test("strict TSV parser accepts the seven-column upstream layout and rejects noncanonical or unsafe bytes", () => {
  const valid = tsv([
    row({ sourceId: "1", filename: "100.wav", reference: "normalized reference" }),
    row({ sourceId: "1", filename: "200.wav", reference: "second recording", gender: "MALE" }),
  ]);
  assert.deepEqual(__parseFleursTsvBytesForTest(valid, 2), [
    { filename: "100.wav", numSamples: 16000, reference: "normalized reference", sourceId: "1" },
    { filename: "200.wav", numSamples: 16000, reference: "second recording", sourceId: "1" },
  ]);

  const invalidCases = [
    ["invalid UTF-8", Buffer.from([0xc3, 0x28, 0x0a]), "FGS_TSV_UTF8_INVALID"],
    ["BOM", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), valid]), "FGS_TSV_CANONICAL_INVALID"],
    ["CRLF", Buffer.from(valid.toString("utf8").replaceAll("\n", "\r\n")), "FGS_TSV_CANONICAL_INVALID"],
    ["missing LF", valid.subarray(0, -1), "FGS_TSV_CANONICAL_INVALID"],
    ["blank row", Buffer.from(`${valid.toString("utf8")}\n`), "FGS_TSV_CANONICAL_INVALID"],
    ["header", tsv(["id\tfilename\traw\treference\tchars\tnum_samples\tgender"]), "FGS_TSV_SOURCE_ID"],
    ["bad fields", tsv(["1\t100.wav\tonly-three"]), "FGS_TSV_ROW_FIELDS"],
    ["bad filename", tsv([row({ sourceId: "1", filename: "../100.wav", reference: "ref" })]), "FGS_TSV_FILENAME"],
    ["empty reference", tsv([row({ sourceId: "1", filename: "100.wav", reference: "" })]), "FGS_TSV_REFERENCE"],
    ["bad samples", tsv([row({ sourceId: "1", filename: "100.wav", reference: "ref", numberSamples: "016000" })]), "FGS_TSV_NUM_SAMPLES"],
    ["bad gender", tsv([row({ sourceId: "1", filename: "100.wav", reference: "ref", gender: "UNKNOWN" })]), "FGS_TSV_GENDER"],
    ["duplicate filename", tsv([
      row({ sourceId: "1", filename: "100.wav", reference: "a" }),
      row({ sourceId: "2", filename: "100.wav", reference: "b" }),
    ]), "FGS_TSV_DUPLICATE_FILENAME"],
    ["non-NFC", tsv([row({ sourceId: "1", filename: "100.wav", reference: "e\u0301" })]), "FGS_TSV_CANONICAL_INVALID"],
  ];
  for (const [name, bytes, code] of invalidCases) {
    assert.throws(() => __parseFleursTsvBytesForTest(bytes), { code }, name);
  }
  assert.throws(
    () => __parseFleursTsvBytesForTest(valid, 3),
    { code: "FGS_TSV_ROW_COUNT_MISMATCH" },
  );
});

test("common-ID intersection and per-config filename digest tie-break are deterministic and fail closed", () => {
  const bytes = smallTsvBytes();
  const selected = __selectFleursRowsForTest(bytes, {
    expectedCommonIdCount: 2,
    expectedSelectedUtteranceCount: 6,
  });
  assert.deepEqual(selected.commonIds, ["1", "2"]);
  assert.deepEqual(selected.entries.map((entry) => [entry.config, entry.source_id]), [
    ["en_us", "1"], ["en_us", "2"],
    ["ja_jp", "1"], ["ja_jp", "2"],
    ["cmn_hans_cn", "1"], ["cmn_hans_cn", "2"],
  ]);
  const expectedFilename = ["100.wav", "200.wav"]
    .map((filename) => ({ filename, digest: sha256(Buffer.from(filename, "utf8")) }))
    .sort((left, right) => left.digest.localeCompare(right.digest))[0].filename;
  assert.equal(selected.entries[0].filename, expectedFilename);

  assert.throws(() => __selectFleursRowsForTest(bytes, {
    expectedCommonIdCount: 3,
    expectedSelectedUtteranceCount: 9,
  }), { code: "FGS_COMMON_ID_COUNT_MISMATCH" });
  assert.throws(() => __selectFleursRowsForTest(bytes, {
    expectedCommonIdCount: 2,
    expectedSelectedUtteranceCount: 5,
  }), { code: "FGS_SELECTION_COUNT_MISMATCH" });
  assert.throws(() => __selectFleursRowsForTest(bytes, {
    expectedCommonIdCount: 2,
    expectedSelectedUtteranceCount: 6,
  }, {
    filenameSha256: () => "a".repeat(64),
  }), { code: "FGS_SELECTION_AMBIGUOUS" });
});

test("private selection and separately validated text-free projection freeze 320/960 without claim inflation", async () => {
  const parsed = await policy();
  const built = __buildFleursGoldSourceArtifactsFromTsvBytesForTest({
    policy: parsed,
    policySha256: POLICY_SHA256,
    tsvBytesByConfig: fullTsvBytes(),
  });
  assert.equal(built.privateSelection.record.common_id_count, 320);
  assert.equal(built.privateSelection.record.selected_utterance_count, 960);
  assert.equal(built.privateSelection.record.selections.length, 960);
  assert.equal(built.privateSelection.record.authority.evidence_classification, "internal-descriptive-only");
  assert.equal(built.privateSelection.record.authority.quality_gate_status, "not-assessed");
  assert.equal(built.privateSelection.record.authority.benchmark_overlap, "unknown");
  assert.equal(built.privateSelection.record.authority.production_evidence, false);
  assert.equal(built.privateSelection.record.authority.public_distribution, false);
  assert.equal(built.privateSelection.record.authority.formal_claims, "none");
  assert.equal(built.privateSelection.record.source_contract_status, "frozen-source-readiness");
  assert.equal(built.privateSelection.record.selections[0].num_samples, 16000);
  assert.equal(built.textFreeProjection.record.dataset_card_sha256, DATASET_CARD_SHA256);
  assert.equal(built.textFreeProjection.record.dataset_card_size_bytes, 385614);

  const validatedPrivate = validateFleursGoldPrivateSelectionBytes(
    built.privateSelection.bytes,
    {
      expectedPolicySha256: POLICY_SHA256,
      expectedRightsDecisionSha256: built.rightsDecision.rightsDecisionSha256,
    },
  );
  assert.equal(validatedPrivate.selectionSha256, built.privateSelection.selectionSha256);
  const validatedProjection = validateFleursGoldTextFreeProjectionBytes(
    built.textFreeProjection.bytes,
    {
      expectedPolicySha256: POLICY_SHA256,
      expectedRightsDecisionSha256: built.rightsDecision.rightsDecisionSha256,
      expectedSelectionSha256: built.privateSelection.selectionSha256,
    },
  );
  assert.equal(validatedProjection.projectionSha256, built.textFreeProjection.projectionSha256);

  const privateText = built.privateSelection.bytes.toString("utf8");
  const projectionText = built.textFreeProjection.bytes.toString("utf8").toLowerCase();
  assert.match(privateText, /"filename":/u);
  assert.match(privateText, /"reference":/u);
  for (const forbidden of [
    "filename", "num_samples", "reference", "transcript", "gender", "repository_path", "readme.md", "http://", "https://",
  ]) {
    assert.equal(projectionText.includes(forbidden), false, forbidden);
  }
  assert.deepEqual(Object.keys(built.textFreeProjection.record.sources[0]).sort(), [
    "config",
    "language",
    "selected_utterance_count",
    "test_archive_lfs_sha256",
    "test_archive_size_bytes",
    "test_tsv_row_count",
    "test_tsv_sha256",
    "test_tsv_size_bytes",
  ]);
});

test("private, rights, and projection records reject sensitive-field leakage, broken digests, and authority promotion", async () => {
  const parsed = await policy();
  const built = __buildFleursGoldSourceArtifactsFromTsvBytesForTest({
    policy: parsed,
    policySha256: POLICY_SHA256,
    tsvBytesByConfig: fullTsvBytes(),
  });
  const privateInput = {
    expectedPolicySha256: POLICY_SHA256,
    expectedRightsDecisionSha256: built.rightsDecision.rightsDecisionSha256,
  };
  const projectionInput = {
    ...privateInput,
    expectedSelectionSha256: built.privateSelection.selectionSha256,
  };

  const privateReference = structuredClone(built.privateSelection.record);
  privateReference.selections[0].reference = "tampered reference";
  assert.throws(
    () => validateFleursGoldPrivateSelectionBytes(canonical(privateReference), privateInput),
    { code: "FGS_PRIVATE_ENTRY_REFERENCE" },
  );
  const privateClaim = structuredClone(built.privateSelection.record);
  privateClaim.thresholds = [];
  assert.throws(
    () => validateFleursGoldPrivateSelectionBytes(canonical(privateClaim), privateInput),
    { code: "FGS_PRIVATE_FIELDS" },
  );
  const privateNumSamples = structuredClone(built.privateSelection.record);
  privateNumSamples.selections[0].num_samples = 0;
  assert.throws(
    () => validateFleursGoldPrivateSelectionBytes(canonical(privateNumSamples), privateInput),
    { code: "FGS_PRIVATE_ENTRY_NUM_SAMPLES" },
  );
  const projectionLeak = structuredClone(built.textFreeProjection.record);
  projectionLeak.reference = "forbidden";
  assert.throws(
    () => validateFleursGoldTextFreeProjectionBytes(canonical(projectionLeak), projectionInput),
    { code: "FGS_PROJECTION_FIELDS" },
  );
  const projectionClaim = structuredClone(built.textFreeProjection.record);
  projectionClaim.authority.quality_gate_status = "passed";
  assert.throws(
    () => validateFleursGoldTextFreeProjectionBytes(canonical(projectionClaim), projectionInput),
    { code: "FGS_PROJECTION_AUTHORITY" },
  );
  const projectionCard = structuredClone(built.textFreeProjection.record);
  projectionCard.dataset_card_sha256 = "a".repeat(64);
  assert.throws(
    () => validateFleursGoldTextFreeProjectionBytes(canonical(projectionCard), projectionInput),
    { code: "FGS_PROJECTION_BINDING" },
  );
  assert.throws(
    () => validateFleursGoldTextFreeProjectionBytes(built.textFreeProjection.bytes, {
      ...projectionInput,
      expectedSelectionSha256: "a".repeat(64),
    }),
    { code: "FGS_PROJECTION_BINDING" },
  );
});

test("schema mirrors frozen source-readiness, rights boundaries, and strict no-promotion authority", async () => {
  const schema = JSON.parse(await readFile(new URL("./fleurs-gold-source.schema.json", import.meta.url), "utf8"));
  assert.equal(schema.additionalProperties, false);
  assert.match(schema.title, /source-readiness/iu);
  assert.doesNotMatch(schema.title, /lawful-source/iu);
  assert.match(schema.description, /not legal advice/iu);
  assert.equal(schema.properties.kind.const, "meetingrelay-fleurs-gold-source-policy-v1");
  assert.equal(schema.properties.source_contract_status.const, "frozen-source-readiness");
  assert.equal(schema.$defs.dataset.properties.dataset_card.properties.repository_path.const, "README.md");
  assert.equal(schema.$defs.dataset.properties.dataset_card.properties.sha256.const, DATASET_CARD_SHA256);
  assert.equal(schema.$defs.dataset.properties.dataset_card.properties.size_bytes.const, 385614);
  assert.equal(schema.$defs.authority.properties.quality_gate_status.const, "not-assessed");
  assert.equal(schema.$defs.authority.properties.production_evidence.const, false);
  assert.equal(schema.$defs.authority.properties.public_distribution.const, false);
  assert.equal(schema.$defs.authority.properties.benchmark_overlap.const, "unknown");
  assert.equal(schema.$defs.rights.properties.legal_review.const, "not-performed");
  assert.equal(schema.$defs.rights.properties.consent_clearance.const, "upstream-undocumented");
  assert.equal(schema.$defs.rights.properties.allowed_purpose.const, "asr-quality-component-measurement");
  assert.equal(schema.$defs.rightsDecision.properties.dataset_card_sha256.const, DATASET_CARD_SHA256);
  assert.equal(schema.$defs.rightsDecision.properties.dataset_card_size_bytes.const, 385614);
  assert.equal(schema.$defs.privateSelection.properties.authority.$ref, "#/$defs/authority");
  assert.equal(schema.$defs.privateSelection.properties.selected_utterance_count.const, 960);
  assert.equal(schema.$defs.textFreeProjection.properties.authority.$ref, "#/$defs/authority");
  assert.equal(schema.$defs.textFreeProjection.properties.selected_utterance_count.const, 960);
  assert.equal(schema.$defs.textFreeProjection.properties.dataset_card_sha256.const, DATASET_CARD_SHA256);
  assert.equal(schema.$defs.textFreeProjection.properties.dataset_card_size_bytes.const, 385614);
  assert.equal(schema.$defs.projectionSource.additionalProperties, false);
  assert.equal("reference" in schema.$defs.projectionSource.properties, false);
  assert.equal("repository_path" in schema.$defs.projectionSource.properties, false);
  assert.equal(schema.$defs.enSource.properties.test_archive.allOf[1].properties.repository_path.const,
    "data/en_us/audio/test.tar.gz");
  assert.equal(schema.$defs.enSource.properties.test_tsv.allOf[1].properties.repository_path.const,
    "data/en_us/test.tsv");
});

test("runtime module is dependency-free and has no network client surface", async () => {
  const source = await readFile(new URL("./fleurs-gold-source.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /from\s+["']node:https["']/u);
  assert.doesNotMatch(source, /\bfetch\s*\(/u);
  assert.doesNotMatch(source, /\baxios\b|\bundici\b/u);
  assert.match(source, /from "node:crypto"/u);
  assert.match(source, /from "node:fs\/promises"/u);
});

test("package, CI, and README expose one offline test-only source-readiness surface", async () => {
  const workspacePackage = JSON.parse(
    await readFile(new URL("../../package.json", import.meta.url), "utf8"),
  );
  assert.equal(
    workspacePackage.scripts["phase0:sherpa-fleurs-gold-source:test"],
    "node --test tools/sherpa-native/fleurs-gold-source.test.mjs",
  );
  assert.equal("phase0:sherpa-fleurs-gold-source:run" in workspacePackage.scripts, false);
  assert.equal("phase0:sherpa-fleurs-gold-source:download" in workspacePackage.scripts, false);

  const workflow = await readFile(
    new URL("../../.github/workflows/ci.yml", import.meta.url),
    "utf8",
  );
  assert.equal(
    [...workflow.matchAll(/pnpm phase0:sherpa-fleurs-gold-source:test/gu)].length,
    1,
  );
  const step = workflow.match(
    /- name: Test WP-0\.4 FLEURS frozen-source contract \(offline metadata only\)\n\s+run: pnpm phase0:sherpa-fleurs-gold-source:test\n\s+timeout-minutes: 5/u,
  );
  assert.notEqual(step, null);
  assert.doesNotMatch(step[0], /download|curl|artifact|cache/iu);

  const readme = await readFile(new URL("./README.md", import.meta.url), "utf8");
  assert.match(readme, /`fleurs-gold-source\.mjs` adds a separate offline source-readiness boundary/u);
  assert.match(readme, /pnpm phase0:sherpa-fleurs-gold-source:test/u);
  assert.match(readme, /does not download or materialize a quality corpus/u);
});
