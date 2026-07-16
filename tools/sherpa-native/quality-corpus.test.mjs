import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { encodeCanonicalJson } from "../phase0-harness/canonical-json.mjs";
import {
  QualityCorpusError,
  __materializeQualityCorpusForTest,
  materializeQualityCorpus,
  validateQualityCorpusManifestBytes,
} from "./quality-corpus.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PURPOSE = "asr-quality-component-measurement";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function wav(sampleValue, frames = 160) {
  const pcm = Buffer.alloc(frames * 2);
  for (let index = 0; index < frames; index += 1) {
    pcm.writeInt16LE(index % 2 === 0 ? sampleValue : -sampleValue, index * 2);
  }
  const bytes = Buffer.alloc(44 + pcm.length);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVE", 8, "ascii");
  bytes.write("fmt ", 12, "ascii");
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16_000, 24);
  bytes.writeUInt32LE(32_000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36, "ascii");
  bytes.writeUInt32LE(pcm.length, 40);
  pcm.copy(bytes, 44);
  return { bytes, pcm };
}

function nonHumanConsent() {
  return {
    allowed_purposes: [],
    expires_on: null,
    record_path: null,
    record_sha256: null,
    record_size_bytes: null,
    status: "not-required-non-human",
    withdrawn: false,
  };
}

function sample({
  language,
  ordinal,
  referenceBytes,
  rightsBytes,
  scenario = "clean",
  split = "blind",
  wavBytes,
  pcmBytes,
}) {
  const id = `FX-${language.toUpperCase()}-${String(ordinal).padStart(3, "0")}-v1`;
  return {
    language,
    leakage_group_id: `LG-${id}`,
    purpose: PURPOSE,
    reference: {
      path: `references/${id}.txt`,
      sha256: sha256(referenceBytes),
      size_bytes: referenceBytes.length,
    },
    rights: {
      allowed_purposes: [PURPOSE],
      consent: nonHumanConsent(),
      license: {
        path: `rights/${id}.license.txt`,
        sha256: sha256(rightsBytes),
        size_bytes: rightsBytes.length,
      },
      retention: { expires_on: null, status: "active" },
      source_kind: "synthetic",
      source_url: null,
      status: "verified",
    },
    sample_id: id,
    scenario,
    split,
    tier: "tier-1",
    wav: {
      bits_per_sample: 16,
      channel_count: 1,
      duration_samples: pcmBytes.length / 2,
      path: `audio/${id}.wav`,
      pcm_sha256: sha256(pcmBytes),
      sample_format: "pcm-s16le",
      sample_rate_hz: 16_000,
      sha256: sha256(wavBytes),
      size_bytes: wavBytes.length,
    },
  };
}

async function fixture(t, { human = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "meetingrelay-quality-corpus-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  await Promise.all([
    mkdir(path.join(root, "audio")),
    mkdir(path.join(root, "references")),
    mkdir(path.join(root, "rights")),
  ]);
  const specifications = [
    { language: "zh", ordinal: 1, text: "合成中文参考", value: 11 },
    { language: "ja", ordinal: 2, text: "合成日本語参照", value: 22 },
    { language: "en", ordinal: 3, text: "synthetic english reference", value: 33 },
  ];
  const samples = [];
  for (const specification of specifications) {
    const id = `FX-${specification.language.toUpperCase()}-${String(specification.ordinal).padStart(3, "0")}-v1`;
    const audio = wav(specification.value);
    const referenceBytes = Buffer.from(specification.text, "utf8");
    const rightsBytes = Buffer.from(`project-generated synthetic fixture ${id}\n`, "utf8");
    await Promise.all([
      writeFile(path.join(root, "audio", `${id}.wav`), audio.bytes),
      writeFile(path.join(root, "references", `${id}.txt`), referenceBytes),
      writeFile(path.join(root, "rights", `${id}.license.txt`), rightsBytes),
    ]);
    samples.push(sample({
      ...specification,
      pcmBytes: audio.pcm,
      referenceBytes,
      rightsBytes,
      wavBytes: audio.bytes,
    }));
  }
  if (human) {
    const selected = samples[0];
    const consentBytes = Buffer.from("controlled-test-consent-record-body\n", "utf8");
    await writeFile(path.join(root, "rights", "human-consent.bin"), consentBytes);
    selected.rights.source_kind = "human-consented";
    selected.rights.consent = {
      allowed_purposes: [PURPOSE],
      expires_on: "2099-12-31",
      record_path: "rights/human-consent.bin",
      record_sha256: sha256(consentBytes),
      record_size_bytes: consentBytes.length,
      status: "verified",
      withdrawn: false,
    };
  }
  samples.sort((left, right) => left.sample_id < right.sample_id ? -1 : left.sample_id > right.sample_id ? 1 : 0);
  const manifest = {
    corpus_id: "meetingrelay-synthetic-contract-corpus-v1",
    kind: "meetingrelay-asr-quality-corpus-v1",
    revision: 1,
    samples,
    schema_version: "1.0",
  };
  const manifestBytes = Buffer.from(encodeCanonicalJson(manifest), "utf8");
  const manifestPath = path.join(root, "corpus-manifest.json");
  await writeFile(manifestPath, manifestBytes);
  return {
    expectedManifestSha256: sha256(manifestBytes),
    manifest,
    manifestBytes,
    manifestPath,
    root,
  };
}

async function expectCode(operation, code) {
  await assert.rejects(operation, (error) =>
    error instanceof QualityCorpusError && error.code === code
  );
}

test("external digest-sealed corpus materializes ordered raw/PCM/reference/rights identities", async (t) => {
  const f = await fixture(t, { human: true });
  const result = await materializeQualityCorpus({
    corpusRoot: f.root,
    expectedManifestSha256: f.expectedManifestSha256,
    manifestPath: f.manifestPath,
    validationDate: "2026-07-16",
  });
  assert.equal(result.manifestSha256, f.expectedManifestSha256);
  assert.match(result.snapshotSha256, /^[0-9a-f]{64}$/u);
  assert.equal(result.validationDate, "2026-07-16");
  assert.equal(result.publicProjection.validation_date, "2026-07-16");
  assert.deepEqual(result.samples.map((entry) => entry.sampleId), f.manifest.samples.map((entry) => entry.sample_id));
  assert.equal(result.samples[0].wavBytes.equals(await readFile(path.join(f.root, f.manifest.samples[0].wav.path))), true);
  const zh = result.samples.find((entry) => entry.language === "zh");
  assert.equal(zh.referenceText, "合成中文参考");
  assert.equal(zh.consentBytes.toString("utf8"), "controlled-test-consent-record-body\n");
  assert.equal(result.samples.find((entry) => entry.language === "ja").consentBytes, null);

  const projectionText = JSON.stringify(result.publicProjection);
  for (const secret of ["合成中文参考", "synthetic english reference", "audio/", "references/", "rights/", "controlled-test-consent", "source_url", "consent", "path"]) {
    assert.equal(projectionText.includes(secret), false, secret);
  }
  assert.deepEqual(Object.keys(result.publicProjection), ["corpus_id", "languages", "manifest_sha256", "sample_count", "scenario_counts", "split_counts", "tier_counts", "validation_date"]);
  const nextDay = await materializeQualityCorpus({
    corpusRoot: f.root,
    expectedManifestSha256: f.expectedManifestSha256,
    manifestPath: f.manifestPath,
    validationDate: "2026-07-17",
  });
  assert.notEqual(nextDay.snapshotSha256, result.snapshotSha256);
});

test("manifest parser is canonical, strict, rights-aware, and fail closed", async (t) => {
  const f = await fixture(t);
  assert.doesNotThrow(() => validateQualityCorpusManifestBytes(f.manifestBytes, { validationDate: "2026-07-16" }));
  const cases = [
    ["CORPUS_RIGHTS_STATUS", (record) => { record.samples[0].rights.status = "denied"; }],
    ["CORPUS_RIGHTS_PURPOSE", (record) => { record.samples[0].rights.allowed_purposes = ["training"]; }],
    ["CORPUS_RETENTION", (record) => { record.samples[0].rights.retention = { expires_on: "2026-07-15", status: "active" }; }],
    ["CORPUS_CONSENT", (record) => { record.samples[0].rights.consent.status = "verified"; }],
    ["CORPUS_CONSENT", (record) => { record.samples[0].rights.consent.withdrawn = true; }],
    ["CORPUS_CONSENT", (record) => { record.samples[0].rights.source_kind = "public-corpus"; }],
    ["CORPUS_SAMPLE_DUPLICATE", (record) => { record.samples[1].sample_id = record.samples[0].sample_id; }],
    ["CORPUS_SAMPLE_ORDER", (record) => { record.samples.reverse(); }],
    ["CORPUS_SPLIT_LEAKAGE", (record) => { record.samples[1].split = "calibration"; record.samples[1].leakage_group_id = record.samples[0].leakage_group_id; }],
    ["CORPUS_SAMPLE_DUPLICATE", (record) => { record.samples[1].wav.sha256 = record.samples[0].wav.sha256; record.samples[1].wav.pcm_sha256 = record.samples[0].wav.pcm_sha256; }],
    ["CORPUS_PATH_COLLISION", (record) => { record.samples[1].reference.path = record.samples[0].reference.path.toLowerCase(); }],
    ["CORPUS_PATH", (record) => { record.samples[0].wav.path = "audio/CON.wav"; }],
    ["CORPUS_PATH", (record) => { record.samples[0].reference.path = "references/trailing."; }],
    ["CORPUS_PATH", (record) => { record.samples[0].rights.license.path = "rights/non canonical.txt"; }],
    ["CORPUS_WAV_FIELDS", (record) => { record.samples[0].wav.size_bytes = 67_108_865; }],
    ["CORPUS_WAV_FIELDS", (record) => { record.samples[0].wav.duration_samples += 1; }],
    ["CORPUS_MANIFEST_FIELDS", (record) => { record.quality_status = "passed"; }],
  ];
  for (const [code, mutate] of cases) {
    const record = structuredClone(f.manifest);
    mutate(record);
    assert.throws(
      () => validateQualityCorpusManifestBytes(Buffer.from(encodeCanonicalJson(record), "utf8"), { validationDate: "2026-07-16" }),
      (error) => error instanceof QualityCorpusError && error.code === code,
      code,
    );
  }
  assert.throws(
    () => validateQualityCorpusManifestBytes(Buffer.from(JSON.stringify(f.manifest), "utf8"), { validationDate: "2026-07-16" }),
    (error) => error instanceof QualityCorpusError && error.code === "CORPUS_MANIFEST_CANONICAL",
  );
  const repeatedReference = structuredClone(f.manifest);
  repeatedReference.samples[1].reference.sha256 = repeatedReference.samples[0].reference.sha256;
  repeatedReference.samples[1].reference.size_bytes = repeatedReference.samples[0].reference.size_bytes;
  assert.doesNotThrow(() => validateQualityCorpusManifestBytes(
    Buffer.from(encodeCanonicalJson(repeatedReference), "utf8"),
    { validationDate: "2026-07-16" },
  ));
  const publicCorpus = structuredClone(f.manifest);
  publicCorpus.samples[0].rights.source_kind = "public-corpus";
  publicCorpus.samples[0].rights.consent = {
    allowed_purposes: [PURPOSE],
    expires_on: null,
    record_path: "rights/public-license-decision.json",
    record_sha256: "a".repeat(64),
    record_size_bytes: 128,
    status: "not-required-public-license",
    withdrawn: false,
  };
  assert.doesNotThrow(() => validateQualityCorpusManifestBytes(
    Buffer.from(encodeCanonicalJson(publicCorpus), "utf8"),
    { validationDate: "2026-07-16" },
  ));
  for (const invalidDate of ["2026-02-30", "2026-13-01", "2025-02-29"] ) {
    assert.throws(
      () => validateQualityCorpusManifestBytes(f.manifestBytes, { validationDate: invalidDate }),
      (error) => error instanceof QualityCorpusError && error.code === "CORPUS_VALIDATION_DATE",
      invalidDate,
    );
  }
  const leap = structuredClone(f.manifest);
  leap.samples[0].rights.retention.expires_on = "2024-02-29";
  assert.throws(
    () => validateQualityCorpusManifestBytes(Buffer.from(encodeCanonicalJson(leap), "utf8"), { validationDate: "2026-07-16" }),
    (error) => error instanceof QualityCorpusError && error.code === "CORPUS_RETENTION",
  );
});

test("external trust anchor, referenced bytes, PCM framing, and postflight identity are mandatory", async (t) => {
  const f = await fixture(t);
  await expectCode(materializeQualityCorpus({
    corpusRoot: f.root,
    expectedManifestSha256: "a".repeat(64),
    manifestPath: f.manifestPath,
    validationDate: "2026-07-16",
  }), "CORPUS_MANIFEST_TRUST_MISMATCH");

  const referencePath = path.join(f.root, f.manifest.samples[0].reference.path);
  await writeFile(referencePath, "tampered", "utf8");
  await expectCode(materializeQualityCorpus({
    corpusRoot: f.root,
    expectedManifestSha256: f.expectedManifestSha256,
    manifestPath: f.manifestPath,
    validationDate: "2026-07-16",
  }), "CORPUS_REFERENCE_IDENTITY");

  await writeFile(referencePath, Buffer.from("合成中文参考", "utf8"));
  const wavPath = path.join(f.root, f.manifest.samples[0].wav.path);
  const wavBytes = await readFile(wavPath);
  wavBytes.writeUInt16LE(2, 22);
  await writeFile(wavPath, wavBytes);
  await expectCode(materializeQualityCorpus({
    corpusRoot: f.root,
    expectedManifestSha256: f.expectedManifestSha256,
    manifestPath: f.manifestPath,
    validationDate: "2026-07-16",
  }), "CORPUS_WAV_IDENTITY");
});

test("declared cumulative material cap fails before any referenced material read", async (t) => {
  const f = await fixture(t);
  const oversized = structuredClone(f.manifest);
  oversized.samples[0].wav.size_bytes = 67_108_864;
  oversized.samples[0].wav.duration_samples = 33_554_410;
  oversized.samples[0].reference.size_bytes = 300 * 1024 * 1024;
  oversized.samples[0].rights.license.size_bytes = 200 * 1024 * 1024;
  const bytes = Buffer.from(encodeCanonicalJson(oversized), "utf8");
  await writeFile(f.manifestPath, bytes);
  await expectCode(materializeQualityCorpus({
    corpusRoot: f.root,
    expectedManifestSha256: sha256(bytes),
    manifestPath: f.manifestPath,
    validationDate: "2026-07-16",
  }), "CORPUS_TOTAL_MATERIAL_LIMIT");
});

test("reference material rejects embedded NUL before native execution", async (t) => {
  const f = await fixture(t);
  const referenceBytes = Buffer.from("synthetic\0reference", "utf8");
  const changed = structuredClone(f.manifest);
  changed.samples[0].reference.sha256 = sha256(referenceBytes);
  changed.samples[0].reference.size_bytes = referenceBytes.length;
  const manifestBytes = Buffer.from(encodeCanonicalJson(changed), "utf8");
  await Promise.all([
    writeFile(path.join(f.root, changed.samples[0].reference.path), referenceBytes),
    writeFile(f.manifestPath, manifestBytes),
  ]);
  await expectCode(materializeQualityCorpus({
    corpusRoot: f.root,
    expectedManifestSha256: sha256(manifestBytes),
    manifestPath: f.manifestPath,
    validationDate: "2026-07-16",
  }), "CORPUS_REFERENCE_IDENTITY");
});

test("path escape and symlink or junction paths are rejected before materialization", async (t) => {
  const f = await fixture(t);
  const escaped = structuredClone(f.manifest);
  escaped.samples[0].reference.path = "../outside.txt";
  const escapedBytes = Buffer.from(encodeCanonicalJson(escaped), "utf8");
  await writeFile(f.manifestPath, escapedBytes);
  await expectCode(materializeQualityCorpus({
    corpusRoot: f.root,
    expectedManifestSha256: sha256(escapedBytes),
    manifestPath: f.manifestPath,
    validationDate: "2026-07-16",
  }), "CORPUS_PATH");

  const outsideManifest = path.join(path.dirname(f.root), `${path.basename(f.root)}-outside.json`);
  await writeFile(outsideManifest, f.manifestBytes);
  t.after(() => rm(outsideManifest, { force: true }));
  await expectCode(materializeQualityCorpus({
    corpusRoot: f.root,
    expectedManifestSha256: f.expectedManifestSha256,
    manifestPath: outsideManifest,
    validationDate: "2026-07-16",
  }), "CORPUS_MANIFEST_PATH");

  if (process.platform === "win32") {
    const target = path.join(f.root, "audio");
    const link = path.join(f.root, "audio-link");
    await symlink(target, link, "junction");
    const linked = structuredClone(f.manifest);
    linked.samples[0].wav.path = `audio-link/${path.basename(linked.samples[0].wav.path)}`;
    const linkedBytes = Buffer.from(encodeCanonicalJson(linked), "utf8");
    await writeFile(f.manifestPath, linkedBytes);
    await expectCode(materializeQualityCorpus({
      corpusRoot: f.root,
      expectedManifestSha256: sha256(linkedBytes),
      manifestPath: f.manifestPath,
      validationDate: "2026-07-16",
    }), "CORPUS_PATH_REPARSE");
  }
});

test("corpus root and manifest reject UNC, device namespace, and ADS paths", async (t) => {
  const f = await fixture(t);
  for (const override of [
    { corpusRoot: "\\\\server\\share\\corpus" },
    { manifestPath: "\\\\?\\C:\\corpus\\manifest.json" },
    { corpusRoot: "C:\\corpus:stream" },
    { manifestPath: "C:\\corpus\\manifest.json:stream" },
  ]) {
    await expectCode(materializeQualityCorpus({
      corpusRoot: f.root,
      expectedManifestSha256: f.expectedManifestSha256,
      manifestPath: f.manifestPath,
      validationDate: "2026-07-16",
      ...override,
    }), "CORPUS_PATH");
  }
});

test("input mutation after initial reads fails postflight and yields no valid materialization", async (t) => {
  const f = await fixture(t);
  let mutated = false;
  await expectCode(__materializeQualityCorpusForTest({
    corpusRoot: f.root,
    expectedManifestSha256: f.expectedManifestSha256,
    manifestPath: f.manifestPath,
    validationDate: "2026-07-16",
  }, {
    hooks: {
      beforePostflight: async ({ samples }) => {
        await writeFile(samples[0].referencePath, "changed after read", "utf8");
        mutated = true;
      },
    },
  }), "CORPUS_INPUT_CHANGED");
  assert.equal(mutated, true);
});

test("committed corpus schema freezes exact rights and consent authority", async () => {
  const schema = JSON.parse(await readFile(path.join(HERE, "quality-corpus.schema.json"), "utf8"));
  assert.equal(schema.properties.kind.const, "meetingrelay-asr-quality-corpus-v1");
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.$defs.sample.additionalProperties, false);
  assert.equal(schema.$defs.rights.additionalProperties, false);
  assert.equal(schema.$defs.nonHumanConsent.properties.status.const, "not-required-non-human");
  assert.equal(schema.$defs.publicLicenseDecision.properties.status.const, "not-required-public-license");
  const digestPattern = new RegExp(schema.$defs.digest.pattern, "u");
  const pathPattern = new RegExp(schema.$defs.relativePath.pattern, "u");
  assert.equal(digestPattern.test("0".repeat(64)), false);
  assert.equal(digestPattern.test("a".repeat(64)), true);
  for (const accepted of ["audio/sample.wav", "rights/decision.json"]) assert.equal(pathPattern.test(accepted), true, accepted);
  for (const rejected of ["audio//sample.wav", "audio/sample.wav/", "audio/../sample.wav", "audio/CON.wav", "audio/con.wav", "audio/trailing.", "audio/not canonical.wav"]) {
    assert.equal(pathPattern.test(rejected), false, rejected);
  }
  assert.equal(JSON.stringify(schema).includes('"quality_status"'), false);
  assert.equal(JSON.stringify(schema).includes('"passed"'), false);
});
