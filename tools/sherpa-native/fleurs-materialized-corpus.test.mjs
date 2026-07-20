import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";

import { encodeCanonicalJson, encodeCanonicalJsonLine } from "../phase0-harness/canonical-json.mjs";
import {
  __materializePinnedFleursCorpusForTest,
  validateFleursMaterializedPublicEvidenceBytes,
} from "./fleurs-materialized-corpus.mjs";

const CONFIGS = ["en_us", "ja_jp", "cmn_hans_cn"];
const LANGUAGES = { cmn_hans_cn: "zh", en_us: "en", ja_jp: "ja" };
const POLICY_SHA = "1".repeat(64);
const SELECTION_SHA = "2".repeat(64);
const execFileAsync = promisify(execFile);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function tmpdir(t) {
  const root = path.join(os.tmpdir(), `meetingrelay-fleurs-materializer-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(root, { recursive: true });
  t.after(async () => {
    await rm(root, { force: true, recursive: true });
  });
  return path.resolve(root);
}

function wav(samples, seed = 1, overrides = {}) {
  const channelCount = overrides.channelCount ?? 1;
  const sampleRate = overrides.sampleRate ?? 16_000;
  const bits = overrides.bits ?? 16;
  const bytesPerSample = bits / 8;
  const dataBytes = samples * channelCount * bytesPerSample;
  const out = Buffer.alloc(44 + dataBytes);
  out.write("RIFF", 0, "ascii");
  out.writeUInt32LE(out.length - 8, 4);
  out.write("WAVE", 8, "ascii");
  out.write("fmt ", 12, "ascii");
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(channelCount, 22);
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate * channelCount * bytesPerSample, 28);
  out.writeUInt16LE(channelCount * bytesPerSample, 32);
  out.writeUInt16LE(bits, 34);
  out.write("data", 36, "ascii");
  out.writeUInt32LE(dataBytes, 40);
  for (let index = 0; index < dataBytes; index += 1) out[44 + index] = (seed + index) % 251;
  return out;
}

function tarHeader(name, size, typeflag = "0") {
  const block = Buffer.alloc(512, 0);
  block.write(name, 0, 100, "utf8");
  block.write("0000644\0", 100, 8, "ascii");
  block.write("0000000\0", 108, 8, "ascii");
  block.write("0000000\0", 116, 8, "ascii");
  block.write(size.toString(8).padStart(11, "0") + "\0", 124, 12, "ascii");
  block.write("00000000000\0", 136, 12, "ascii");
  block.fill(0x20, 148, 156);
  block.write(typeflag, 156, 1, "ascii");
  block.write("ustar\0", 257, 6, "ascii");
  block.write("00", 263, 2, "ascii");
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  return block;
}

function tarGz(entries) {
  const chunks = [];
  for (const entry of entries) {
    const body = entry.body ?? Buffer.alloc(0);
    chunks.push(tarHeader(entry.name, body.length, entry.typeflag ?? "0"));
    chunks.push(body);
    const padding = (512 - (body.length % 512)) % 512;
    if (padding > 0) chunks.push(Buffer.alloc(padding, 0));
  }
  chunks.push(Buffer.alloc(1024, 0));
  return gzipSync(Buffer.concat(chunks), { mtime: 0 });
}

async function writeArchive(root, config, entries) {
  const bytes = tarGz(entries);
  const archivePath = path.resolve(root, `${config}-test.tar.gz`);
  await writeFile(archivePath, bytes);
  return { path: archivePath, sha256: sha256(bytes), sizeBytes: bytes.length };
}

function sourceFixture(archiveIdentities, { duplicateSelection = false, sampleCount = 3 } = {}) {
  const selections = [];
  for (const config of CONFIGS) {
    for (let id = 1; id <= sampleCount; id += 1) {
      const filename = `${duplicateSelection && id === 2 ? 1 : id}.wav`;
      const reference = `Reference ${config} ${id}`;
      selections.push({
        config,
        filename,
        filename_sha256: sha256(Buffer.from(filename, "utf8")),
        language: LANGUAGES[config],
        num_samples: 8 + id,
        reference,
        reference_sha256: sha256(Buffer.from(reference, "utf8")),
        reference_utf8_bytes: Buffer.byteLength(reference, "utf8"),
        sequence: selections.length + 1,
        source_id: String(id),
      });
    }
  }
  return {
    datasetCard: { sha256: "3".repeat(64), sizeBytes: 123 },
    policy: {
      policy: {
        source_contract_status: "frozen-source-readiness",
        sources: CONFIGS.map((config) => ({
          config,
          language: LANGUAGES[config],
          test_archive: {
            lfs_sha256: archiveIdentities[config].sha256,
            repository_path: `data/${config}/audio/test.tar.gz`,
            size_bytes: archiveIdentities[config].sizeBytes,
          },
          test_tsv: {
            repository_path: `data/${config}/test.tsv`,
            row_count: 3,
            sha256: "4".repeat(64),
            size_bytes: 10,
          },
        })),
      },
      policySha256: POLICY_SHA,
    },
    privateSelection: {
      record: {
        selected_utterance_count: selections.length,
        selections,
      },
      selectionSha256: SELECTION_SHA,
    },
    rightsDecision: {
      bytes: Buffer.from(encodeCanonicalJsonLine({
        consent_clearance: "upstream-undocumented",
        decision_scope: "engineering-policy-not-legal-advice",
        legal_review: "not-performed",
        public_distribution: false,
      }), "utf8"),
      record: {
        consent_clearance: "upstream-undocumented",
        decision_scope: "engineering-policy-not-legal-advice",
        legal_review: "not-performed",
      },
    },
    textFreeProjection: {
      projectionSha256: "5".repeat(64),
    },
  };
}

async function fixture(t, options = {}) {
  const root = await tmpdir(t);
  const controlledRoot = path.resolve(root, "controlled");
  await mkdir(controlledRoot);
  const archiveByConfig = {};
  for (const config of CONFIGS) {
    const entries = [];
    for (let id = 1; id <= 3; id += 1) {
      entries.push({ body: wav(8 + id, CONFIGS.indexOf(config) * 20 + id), name: `test/${id}.wav` });
    }
    entries.push({ body: wav(99, 99), name: "test/999.wav" });
    archiveByConfig[config] = await writeArchive(root, config, options.entries?.[config] ?? entries);
  }
  const archiveIdentities = Object.fromEntries(CONFIGS.map((config) => [
    config,
    { sha256: archiveByConfig[config].sha256, sizeBytes: archiveByConfig[config].sizeBytes },
  ]));
  const source = sourceFixture(archiveIdentities, options.source ?? {});
  const input = {
    archiveIdentities,
    archivePaths: Object.fromEntries(CONFIGS.map((config) => [config, archiveByConfig[config].path])),
    controlledRoot,
    datasetCardPath: path.resolve(root, "README.md"),
    expectedPolicySha256: POLICY_SHA,
    policyPath: path.resolve(root, "fleurs-policy.json"),
    snapshotId: options.snapshotId ?? "fleurs-snapshot",
    tsvPaths: Object.fromEntries(CONFIGS.map((config) => [config, path.resolve(root, `${config}.tsv`)])),
    validationDate: "2026-07-21",
  };
  await writeFile(input.datasetCardPath, "dataset card\n");
  await writeFile(input.policyPath, "{}\n");
  for (const tsvPath of Object.values(input.tsvPaths)) await writeFile(tsvPath, "tsv\n");
  return { archiveByConfig, archiveIdentities, controlledRoot, input, root, source };
}

async function materialize(f, overrides = {}) {
  return __materializePinnedFleursCorpusForTest(
    { ...f.input, ...overrides.input },
    {
      beforeNativePublish: overrides.beforeNativePublish,
      beforePublish: overrides.beforePublish,
      goldSourceLoader: async () => overrides.source ?? f.source,
      publishDirectory: overrides.publishDirectory,
    },
  );
}

test("materializes selected FLEURS WAVs into an accepted corpus manifest and text-free public evidence", async (t) => {
  const f = await fixture(t);
  const result = await materialize(f);
  assert.equal(result.materializedSampleCount, 9);
  const manifestPath = path.join(result.finalRoot, "corpus-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.equal(sha256(Buffer.from(encodeCanonicalJson(manifest), "utf8")), result.corpusManifestSha256);
  assert.equal(manifest.samples.length, 9);
  assert.deepEqual(
    manifest.samples.map((sample) => sample.sample_id),
    [...manifest.samples.map((sample) => sample.sample_id)].sort(),
  );
  assert.equal(manifest.samples.every((sample) => sample.rights.source_kind === "public-corpus"), true);
  assert.equal(manifest.samples.every((sample) => sample.wav.sample_rate_hz === 16_000), true);
  assert.equal(await readFile(path.join(result.finalRoot, "references", "en_us", "1.txt"), "utf8"), "Reference en_us 1");
  assert.match(await readFile(path.join(result.finalRoot, "rights", "fleurs-consent-clearance.json"), "utf8"), /upstream-undocumented/u);
  assert.equal(await stat(path.join(result.finalRoot, "wav", "en_us", "999.wav")).then(() => true, () => false), false);
  const evidenceBytes = await readFile(path.join(result.finalRoot, "materialization-public-evidence.json"));
  const evidence = validateFleursMaterializedPublicEvidenceBytes(evidenceBytes);
  assert.equal(evidence.publicEvidence.materialized_sample_count, 9);
  assert.deepEqual(evidence.publicEvidence.language_counts, { en: 3, ja: 3, zh: 3 });
  assert.doesNotMatch(evidenceBytes.toString("utf8"), /Reference|\.wav|test\/|https?:|[A-Za-z]:\\/u);
});

test("joins exact policy archive identities and rejects drift before publish", async (t) => {
  const f = await fixture(t);
  const drifted = structuredClone(f.input.archiveIdentities);
  drifted.en_us.sha256 = "a".repeat(64);
  await assert.rejects(() => materialize(f, { input: { archiveIdentities: drifted } }), { code: "FMC_ARCHIVE_POLICY_BINDING" });
  assert.equal(await stat(path.join(f.controlledRoot, "snapshots", f.input.snapshotId)).then(() => true, () => false), false);
});

test("rejects missing and duplicate selected archive members", async (t) => {
  const missing = await fixture(t, {
    entries: { en_us: [{ body: wav(9, 1), name: "test/1.wav" }, { body: wav(10, 2), name: "test/2.wav" }] },
  });
  await assert.rejects(() => materialize(missing), { code: "FMC_ARCHIVE_SELECTED_MISSING" });

  const duplicate = await fixture(t, {
    entries: {
      en_us: [
        { body: wav(9, 1), name: "a/1.wav" },
        { body: wav(9, 2), name: "b/1.wav" },
        { body: wav(10, 3), name: "test/2.wav" },
        { body: wav(11, 4), name: "test/3.wav" },
      ],
    },
  });
  await assert.rejects(() => materialize(duplicate), { code: "FMC_ARCHIVE_SELECTED_DUPLICATE" });
});

test("rejects traversal, absolute-like, duplicate-path, and special tar members", async (t) => {
  for (const [name, entries, code] of [
    ["traversal", [{ body: wav(9), name: "../1.wav" }], "FMC_TAR_PATH"],
    ["backslash", [{ body: wav(9), name: "bad\\1.wav" }], "FMC_TAR_PATH"],
    ["tar-option-injection", [{ body: wav(9), name: "--checkpoint-action=exec=calc" }], "FMC_TAR_PATH"],
    ["duplicate-path", [{ body: wav(9), name: "test/1.wav" }, { body: wav(9), name: "test/1.wav" }], "FMC_TAR_DUPLICATE_MEMBER"],
    ["symlink", [{ name: "test/link.wav", typeflag: "2" }], "FMC_TAR_UNSAFE_MEMBER"],
  ]) {
    await test(name, async (tt) => {
      const f = await fixture(tt, { entries: { en_us: entries } });
      await assert.rejects(() => materialize(f), { code });
    });
  }
});

test("rejects wrong WAV format or sample count", async (t) => {
  const wrongFormat = await fixture(t, {
    entries: {
      en_us: [
        { body: wav(9, 1, { channelCount: 2 }), name: "test/1.wav" },
        { body: wav(10, 2), name: "test/2.wav" },
        { body: wav(11, 3), name: "test/3.wav" },
      ],
    },
  });
  await assert.rejects(() => materialize(wrongFormat), { code: "FMC_WAV_FORMAT" });

  const wrongCount = await fixture(t, {
    entries: {
      en_us: [
        { body: wav(8, 1), name: "test/1.wav" },
        { body: wav(10, 2), name: "test/2.wav" },
        { body: wav(11, 3), name: "test/3.wav" },
      ],
    },
  });
  await assert.rejects(() => materialize(wrongCount), { code: "FMC_WAV_FORMAT" });
});

test("rejects archive path namespaces and byte drift against policy identity", async (t) => {
  const f = await fixture(t);
  for (const archivePath of ["\\\\server\\share\\test.tar.gz", "\\\\?\\C:\\test.tar.gz", `${f.input.archivePaths.en_us}:stream`]) {
    const archivePaths = { ...f.input.archivePaths, en_us: archivePath };
    await assert.rejects(() => materialize(f, { input: { archivePaths } }), { code: "FMC_ARCHIVE_PATH" });
  }

  await writeFile(f.input.archivePaths.en_us, Buffer.concat([await readFile(f.input.archivePaths.en_us), Buffer.from("drift")]));
  await assert.rejects(() => materialize(f), { code: "FMC_ARCHIVE_SIZE" });
});

test("keeps publish create-new and retains failure staging residue for audit cleanup", async (t) => {
  const existing = await fixture(t);
  const finalRoot = path.join(existing.controlledRoot, "snapshots", existing.input.snapshotId);
  await mkdir(finalRoot, { recursive: true });
  await writeFile(path.join(finalRoot, "keep.txt"), "competitor");
  await assert.rejects(() => materialize(existing), { code: "FMC_SNAPSHOT_EXISTS" });
  assert.equal(await readFile(path.join(finalRoot, "keep.txt"), "utf8"), "competitor");

  const failed = await fixture(t, {
    entries: {
      en_us: [
        { body: wav(8, 1), name: "test/1.wav" },
        { body: wav(10, 2), name: "test/2.wav" },
        { body: wav(11, 3), name: "test/3.wav" },
      ],
    },
  });
  await assert.rejects(() => materialize(failed), { code: "FMC_WAV_FORMAT" });
  const snapshots = await readdir(path.join(failed.controlledRoot, "snapshots")).catch(() => []);
  assert.equal(snapshots.some((entry) => entry === failed.input.snapshotId), false);
  assert.equal(snapshots.some((entry) => entry.startsWith(`.${failed.input.snapshotId}.tmp-`)), true);
});

test("publish fails closed when an empty competitor snapshot appears after the last existence check", async (t) => {
  const f = await fixture(t);
  const finalRoot = path.join(f.controlledRoot, "snapshots", f.input.snapshotId);
  await assert.rejects(
    () => materialize(f, {
      beforeNativePublish: async ({ finalRoot: liveFinalRoot }) => {
        await mkdir(liveFinalRoot);
      },
    }),
    { code: "FMC_PUBLISH" },
  );
  assert.deepEqual(await readdir(finalRoot), []);
  assert.equal(await stat(path.join(finalRoot, "corpus-manifest.json")).then(() => true, () => false), false);
  const snapshots = await readdir(path.dirname(finalRoot));
  assert.equal(snapshots.some((entry) => entry.startsWith(`.${f.input.snapshotId}.tmp-`)), true);
});

test("revalidates controlled snapshot chains immediately before publish", async (t) => {
  const f = await fixture(t);
  const snapshotsRoot = path.join(f.controlledRoot, "snapshots");
  const replacement = path.join(f.root, "snapshots-replacement");
  const probeTarget = path.join(f.root, "symlink-probe-target");
  const probeLink = path.join(f.root, "symlink-probe-link");
  await mkdir(probeTarget);
  try {
    await symlink(probeTarget, probeLink, "dir");
  } catch {
    return;
  }
  await assert.rejects(
    () => materialize(f, {
      beforePublish: async ({ snapshotsRoot: liveSnapshotsRoot }) => {
        await rename(liveSnapshotsRoot, replacement);
        await symlink(replacement, liveSnapshotsRoot, "dir");
      },
    }),
    { code: "FMC_SNAPSHOTS_ROOT" },
  );
  assert.equal(await stat(path.join(snapshotsRoot, f.input.snapshotId)).then(() => true, () => false), false);
});

test("rejects duplicate selected source filenames and public evidence authority escalation", async (t) => {
  const f = await fixture(t, { source: { duplicateSelection: true } });
  await assert.rejects(() => materialize(f), { code: "FMC_SELECTIONS" });

  const good = await fixture(t);
  const result = await materialize(good);
  const evidence = JSON.parse(await readFile(path.join(result.finalRoot, "materialization-public-evidence.json"), "utf8"));
  evidence.authority.quality_gate_status = "passed";
  assert.throws(
    () => validateFleursMaterializedPublicEvidenceBytes(Buffer.from(encodeCanonicalJson(evidence), "utf8")),
    { code: "FMC_PUBLIC_EVIDENCE_AUTHORITY" },
  );
  evidence.authority.quality_gate_status = "not-assessed";
  evidence.extra = true;
  assert.throws(
    () => validateFleursMaterializedPublicEvidenceBytes(Buffer.from(encodeCanonicalJson(evidence), "utf8")),
    { code: "FMC_PUBLIC_EVIDENCE_FIELDS" },
  );
});

test("public evidence validator rejects filenames paths urls and secret-like text", () => {
  const base = {
    archive_sha256_by_config: { cmn_hans_cn: "a".repeat(64), en_us: "b".repeat(64), ja_jp: "c".repeat(64) },
    authority: {
      execution_status: "not-run",
      formal_claims: "none",
      materialization_status: "materialized",
      production_evidence: false,
      public_distribution: false,
      quality_gate_status: "not-assessed",
    },
    corpus_manifest_sha256: "d".repeat(64),
    corpus_snapshot_sha256: "e".repeat(64),
    kind: "meetingrelay-fleurs-materialized-corpus-v1",
    language_counts: { en: 3, ja: 3, zh: 3 },
    materialized_sample_count: 9,
    policy_sha256: "f".repeat(64),
    schema_version: "1.0",
    selection_sha256: "1".repeat(64),
    source_contract_status: "frozen-source-readiness",
    validation_date: "2026-07-21",
  };
  for (const leak of ["1.wav", "C:\\tmp\\x", "https://example.invalid", "secret"]) {
    const copy = structuredClone(base);
    copy.language_counts = { [leak]: 1 };
    assert.throws(
      () => validateFleursMaterializedPublicEvidenceBytes(Buffer.from(encodeCanonicalJson(copy), "utf8")),
      { code: "FMC_PUBLIC_TEXT_LEAK" },
    );
  }
});

test("rejects symlink controlled roots when platform supports them", async (t) => {
  const f = await fixture(t);
  const link = path.join(f.root, "controlled-link");
  try {
    await symlink(f.controlledRoot, link, "dir");
  } catch {
    return;
  }
  await assert.rejects(() => materialize(f, { input: { controlledRoot: path.resolve(link) } }), { code: "FMC_CONTROLLED_ROOT" });
});

test("operator CLI requires canonical materialization input and exposes stable failure codes", async (t) => {
  const f = await fixture(t);
  const inputPath = path.join(f.root, "materialize-input.json");
  await writeFile(inputPath, encodeCanonicalJson({ bad: "input" }), "utf8");
  await assert.rejects(
    () => execFileAsync(process.execPath, ["tools/sherpa-native/fleurs-materialized-corpus.mjs", "--materialize", inputPath], {
      cwd: path.resolve("."),
      windowsHide: true,
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.equal(error.stderr, "FMC_INPUT_CANONICAL\n");
      return true;
    },
  );

  await writeFile(inputPath, encodeCanonicalJsonLine({ bad: "input" }), "utf8");
  await assert.rejects(
    () => execFileAsync(process.execPath, ["tools/sherpa-native/fleurs-materialized-corpus.mjs", "--materialize", inputPath], {
      cwd: path.resolve("."),
      windowsHide: true,
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.equal(error.stderr, "FMC_INPUT_FIELDS\n");
      return true;
    },
  );
});
