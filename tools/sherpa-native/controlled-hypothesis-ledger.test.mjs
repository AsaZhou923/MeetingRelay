import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  lstat,
  link,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildControlledHypothesisLedger,
  projectControlledHypothesisLedgerTextFree,
  publishControlledHypothesisLedger,
  readControlledHypothesisLedger,
  validateControlledHypothesisLedgerRecord,
} from "./controlled-hypothesis-ledger.mjs";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function joins(suffix = "a") {
  return {
    candidate_identity_sha256: sha256(`candidate-${suffix}`),
    corpus_manifest_sha256: sha256(`corpus-manifest-${suffix}`),
    corpus_snapshot_sha256: sha256(`corpus-snapshot-${suffix}`),
    execution_host_sha256: sha256(`execution-host-${suffix}`),
    hardware_evidence_sha256: sha256(`hardware-evidence-${suffix}`),
    scorer_manifest_sha256: sha256(`scorer-manifest-${suffix}`),
    scorer_profile_sha256: sha256(`scorer-profile-${suffix}`),
    source_commit: sha256(`source-commit-${suffix}`).slice(0, 40),
    source_evidence_sha256: sha256(`source-evidence-${suffix}`),
  };
}

function entry({
  finalTranscript,
  language,
  sampleId,
  scenario,
  sequence,
  split,
  tier = "tier-1",
}) {
  const bytes = Buffer.from(finalTranscript, "utf8");
  return {
    attempt: 1,
    component_record_sha256: sha256(`component-record-${sampleId}`),
    final_transcript: finalTranscript,
    final_transcript_sha256: sha256(bytes),
    final_transcript_utf8_bytes: String(bytes.length),
    language,
    sample_id: sampleId,
    sample_identity_sha256: sha256(`sample-identity-${sampleId}`),
    scenario,
    sequence,
    split,
    tier,
  };
}

function fixture(suffix = "a") {
  const secret = "private C:\\controlled\\speaker-A e\u0301 hypothesis";
  return buildControlledHypothesisLedger({
    entries: [
      entry({
        finalTranscript: "会议现在开始。",
        language: "zh",
        sampleId: `01-zh-${suffix}`,
        scenario: "quiet-room",
        sequence: 1,
        split: "calibration",
      }),
      entry({
        finalTranscript: "",
        language: "ja",
        sampleId: `02-ja-${suffix}`,
        scenario: "empty-hypothesis",
        sequence: 2,
        split: "dev",
      }),
      entry({
        finalTranscript: secret,
        language: "en",
        sampleId: `03-en-${suffix}`,
        scenario: "playback-plus-mic",
        sequence: 3,
        split: "blind",
      }),
    ],
    joins: joins(suffix),
  });
}

async function temporaryDirectory(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "meetingrelay-ledger-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  return root;
}

test("build and validate preserve exact multilingual hypotheses including empty and NFD", () => {
  const built = fixture();
  assert.equal(built.bytes.at(-1), 0x0a);
  assert.equal(built.bytes.includes(0x0d), false);
  assert.equal(built.ledgerSha256, sha256(built.bytes));

  const validated = validateControlledHypothesisLedgerRecord(built.bytes);
  assert.deepEqual(validated.record, built.record);
  assert.equal(validated.ledgerSha256, built.ledgerSha256);
  assert.equal(validated.record.entries[1].final_transcript, "");
  assert.equal(validated.record.entries[2].final_transcript, "private C:\\controlled\\speaker-A e\u0301 hypothesis");
  assert.notEqual(validated.record.entries[2].final_transcript, validated.record.entries[2].final_transcript.normalize("NFC"));
  assert.deepEqual(validated.record.authority, {
    formal_claims: "none",
    privacy_class: "controlled",
    production_evidence: false,
    public_distribution: false,
  });
});

test("canonical bytes, exact fields, joins, hashes, counts, and ordering fail closed", () => {
  const built = fixture();
  const cases = [];
  const mutate = (name, callback) => {
    const value = structuredClone(built.record);
    callback(value);
    cases.push([name, Buffer.from(`${JSON.stringify(value)}\n`, "utf8")]);
  };

  cases.push(["pretty JSON", Buffer.from(`${JSON.stringify(built.record, null, 2)}\n`, "utf8")]);
  mutate("unknown root key", (value) => { value.unknown = true; });
  mutate("unknown authority key", (value) => { value.authority.unknown = true; });
  mutate("unknown join key", (value) => { value.joins.unknown = sha256("unknown"); });
  mutate("unknown entry key", (value) => { value.entries[0].unknown = true; });
  mutate("zero join", (value) => { value.joins.execution_host_sha256 = "0".repeat(64); });
  mutate("zero component record join", (value) => { value.entries[0].component_record_sha256 = "0".repeat(64); });
  mutate("forged transcript hash", (value) => { value.entries[0].final_transcript_sha256 = sha256("forged"); });
  mutate("forged transcript byte count", (value) => { value.entries[0].final_transcript_utf8_bytes = "999"; });
  mutate("duplicate sample id", (value) => { value.entries[1].sample_id = value.entries[0].sample_id; });
  mutate("reordered entries", (value) => { value.entries = [value.entries[1], value.entries[0], value.entries[2]]; });
  mutate("sample id order independent of sequence", (value) => {
    value.entries = [...value.entries].reverse();
    value.entries.forEach((entryValue, index) => { entryValue.sequence = index + 1; });
  });
  mutate("sequence gap", (value) => { value.entries[1].sequence = 3; });
  mutate("second attempt", (value) => { value.entries[0].attempt = 2; });
  mutate("unknown language", (value) => { value.entries[0].language = "fr"; });
  mutate("unknown split", (value) => { value.entries[0].split = "train"; });
  mutate("noncanonical decimal", (value) => { value.entries[0].final_transcript_utf8_bytes = "01"; });
  mutate("zero source commit", (value) => { value.joins.source_commit = "0".repeat(40); });
  mutate("unpaired surrogate", (value) => {
    value.entries[0].final_transcript = "bad\ud800";
    value.entries[0].final_transcript_sha256 = sha256(Buffer.from(value.entries[0].final_transcript, "utf8"));
    value.entries[0].final_transcript_utf8_bytes = String(Buffer.byteLength(value.entries[0].final_transcript));
  });
  mutate("NUL", (value) => {
    value.entries[0].final_transcript = "bad\0text";
    value.entries[0].final_transcript_sha256 = sha256(Buffer.from(value.entries[0].final_transcript, "utf8"));
    value.entries[0].final_transcript_utf8_bytes = String(Buffer.byteLength(value.entries[0].final_transcript));
  });

  for (const [name, bytes] of cases) {
    assert.throws(() => validateControlledHypothesisLedgerRecord(bytes), undefined, name);
  }
});

test("text, record, and entry-count limits are enforced before publication", () => {
  const oversizedText = "a".repeat(16_385);
  assert.throws(() => buildControlledHypothesisLedger({
    entries: [entry({
      finalTranscript: oversizedText,
      language: "en",
      sampleId: "oversized-text",
      scenario: "quiet-room",
      sequence: 1,
      split: "dev",
    })],
    joins: joins(),
  }));

  const repeated = entry({
    finalTranscript: "",
    language: "en",
    sampleId: "sample",
    scenario: "quiet-room",
    sequence: 1,
    split: "dev",
  });
  assert.throws(() => buildControlledHypothesisLedger({
    entries: Array.from({ length: 10_001 }, (_, index) => ({
      ...repeated,
      sample_id: `sample-${String(index).padStart(5, "0")}`,
      sample_identity_sha256: sha256(`identity-${index}`),
      sequence: index + 1,
    })),
    joins: joins(),
  }));
  assert.throws(() => validateControlledHypothesisLedgerRecord(Buffer.alloc(4 * 1024 * 1024 + 2, 0x61)));
});

test("text-free controlled-derived projection contains only digests, joins, counts, and classifications", () => {
  const built = fixture();
  const projected = projectControlledHypothesisLedgerTextFree(built.bytes);
  assert.equal(projected.projection.ledger_sha256, built.ledgerSha256);
  assert.equal(projected.projection.entry_count, 3);
  assert.deepEqual(projected.projection.joins, built.record.joins);
  assert.equal(projected.projection.entries[1].final_transcript_utf8_bytes, "0");
  assert.equal(projected.projection.entries[1].attempt, 1);
  assert.equal(
    projected.projection.entries[1].component_record_sha256,
    built.record.entries[1].component_record_sha256,
  );

  const publicText = projected.bytes.toString("utf8");
  for (const forbidden of [
    "private C:\\controlled\\speaker-A",
    "会议现在开始",
    "final_transcript\"",
    "consent",
    "speaker_identity",
    "raw_log",
  ]) {
    assert.equal(publicText.includes(forbidden), false, forbidden);
  }
  assert.deepEqual(Object.keys(projected.projection).sort(), ["entries", "entry_count", "joins", "ledger_sha256"]);
});

test("atomic create-new publication is readable, never overwrites, and retains auditable staging", async (t) => {
  const root = await temporaryDirectory(t);
  await mkdir(path.join(root, "runs"));
  const built = fixture();
  const output = await publishControlledHypothesisLedger(root, path.join("runs", "ledger.jsonl"), built.bytes);
  assert.equal(output, path.join(root, "runs", "ledger.jsonl"));
  assert.deepEqual((await readControlledHypothesisLedger(root, path.join("runs", "ledger.jsonl"))).record, built.record);

  const competitor = await readFile(output);
  await assert.rejects(publishControlledHypothesisLedger(root, path.join("runs", "ledger.jsonl"), fixture("other").bytes));
  assert.deepEqual(await readFile(output), competitor);
  const names = (await readdir(path.join(root, "runs"))).sort();
  assert.equal(names.includes("ledger.jsonl"), true);
  const stagingName = names.find((name) => name.endsWith(".staging"));
  assert.match(stagingName, /^\.ledger\.jsonl\.[0-9a-f]{32}\.staging$/u);
  assert.deepEqual(await readFile(path.join(root, "runs", stagingName)), built.bytes);
});

test("concurrent publishers have exactly one winner and preserve a complete valid record", async (t) => {
  const root = await temporaryDirectory(t);
  const left = fixture("left");
  const right = fixture("right");
  const results = await Promise.allSettled([
    publishControlledHypothesisLedger(root, "race.jsonl", left.bytes),
    publishControlledHypothesisLedger(root, "race.jsonl", right.bytes),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  const persisted = await readFile(path.join(root, "race.jsonl"));
  assert.equal(persisted.equals(left.bytes) || persisted.equals(right.bytes), true);
  validateControlledHypothesisLedgerRecord(persisted);
  const raceNames = (await readdir(root)).sort();
  assert.equal(raceNames.includes("race.jsonl"), true);
  const raceResidues = raceNames.filter((name) => name !== "race.jsonl");
  assert.equal(raceResidues.length, 2);
  for (const residue of raceResidues) {
    assert.match(residue, /^\.race\.jsonl\.[0-9a-f]{32}\.staging$/u);
    const residueBytes = await readFile(path.join(root, residue));
    assert.equal(residueBytes.equals(left.bytes) || residueBytes.equals(right.bytes), true);
  }
});

test("post-link target replacement fails without deleting the valid competitor", async (t) => {
  const root = await temporaryDirectory(t);
  const built = fixture("owned");
  const competitor = fixture("competitor");
  const target = path.join(root, "replaced.jsonl");

  await assert.rejects(publishControlledHypothesisLedger(root, "replaced.jsonl", built.bytes, {
    linkFile: async (stagingPath, targetPath) => {
      await link(stagingPath, targetPath);
      await rm(targetPath);
      await writeFile(targetPath, competitor.bytes, { flag: "wx" });
    },
  }), /LEDGER_PUBLICATION/u);

  assert.deepEqual(await readFile(target), competitor.bytes);
  const names = await readdir(root);
  const residue = names.find((name) => name.endsWith(".staging"));
  assert.equal(names.includes("replaced.jsonl"), true);
  assert.equal(typeof residue, "string");
  assert.deepEqual(await readFile(path.join(root, residue)), built.bytes);
});

test("post-link staging replacement fails without deleting the valid competitor", async (t) => {
  const root = await temporaryDirectory(t);
  const built = fixture("owned-staging");
  const competitor = fixture("staging-competitor");
  const target = path.join(root, "staging-replaced.jsonl");

  await assert.rejects(publishControlledHypothesisLedger(root, "staging-replaced.jsonl", built.bytes, {
    linkFile: async (stagingPath, targetPath) => {
      await link(stagingPath, targetPath);
      await rm(stagingPath);
      await writeFile(stagingPath, competitor.bytes, { flag: "wx" });
    },
  }), /LEDGER_PUBLICATION/u);

  assert.deepEqual(await readFile(target), built.bytes);
  const remaining = await readdir(root);
  assert.equal(remaining.length, 2);
  const stagingName = remaining.find((name) => name.endsWith(".staging"));
  assert.match(stagingName, /^\.staging-replaced\.jsonl\.[0-9a-f]{32}\.staging$/u);
  assert.deepEqual(await readFile(path.join(root, stagingName)), competitor.bytes);
});

test("partial staging writes and reread drift fail without publishing", async (t) => {
  const root = await temporaryDirectory(t);
  const built = fixture();
  const openPartial = async (...arguments_) => {
    const handle = await open(...arguments_);
    return {
      close: () => handle.close(),
      stat: (...values) => handle.stat(...values),
      sync: () => handle.sync(),
      writeFile: (bytes) => handle.writeFile(bytes.subarray(0, bytes.length - 1)),
    };
  };
  await assert.rejects(publishControlledHypothesisLedger(root, "partial.jsonl", built.bytes, { openFile: openPartial }));
  await assert.rejects(lstat(path.join(root, "partial.jsonl")), { code: "ENOENT" });
  const partialResidues = await readdir(root);
  assert.equal(partialResidues.length, 1);
  assert.match(partialResidues[0], /^\.partial\.jsonl\.[0-9a-f]{32}\.staging$/u);
  await rm(path.join(root, partialResidues[0]));

  await assert.rejects(publishControlledHypothesisLedger(root, "drift.jsonl", built.bytes, {
    readFileBytes: async (filePath) => {
      const bytes = await readFile(filePath);
      return Buffer.concat([bytes, Buffer.from("x")]);
    },
  }));
  await assert.rejects(lstat(path.join(root, "drift.jsonl")), { code: "ENOENT" });
  const driftResidues = await readdir(root);
  assert.equal(driftResidues.length, 1);
  assert.match(driftResidues[0], /^\.drift\.jsonl\.[0-9a-f]{32}\.staging$/u);
  await rm(path.join(root, driftResidues[0]));

  const linkedFailurePath = path.join(root, "linked-failure.jsonl");
  await assert.rejects(publishControlledHypothesisLedger(root, "linked-failure.jsonl", built.bytes, {
    readFileBytes: async (filePath) => {
      const persisted = await readFile(filePath);
      return filePath === linkedFailurePath
        ? Buffer.concat([persisted, Buffer.from("post-link drift")])
        : persisted;
    },
  }));
  assert.deepEqual(await readFile(linkedFailurePath), built.bytes);
  const linkedNames = await readdir(root);
  const linkedResidue = linkedNames.find((name) => name.endsWith(".staging"));
  assert.equal(linkedNames.includes("linked-failure.jsonl"), true);
  assert.equal(typeof linkedResidue, "string");
  await rm(linkedFailurePath);
  await rm(path.join(root, linkedResidue));

  const retainedPath = path.join(root, "retained-staging.jsonl");
  let unlinkCalls = 0;
  await publishControlledHypothesisLedger(root, "retained-staging.jsonl", built.bytes, {
    unlinkFile: async () => { unlinkCalls += 1; },
  });
  assert.equal(unlinkCalls, 0);
  assert.deepEqual(await readFile(retainedPath), built.bytes);
  const retainedNames = (await readdir(root)).filter((name) => name.startsWith(".retained-staging.jsonl."));
  assert.equal(retainedNames.length, 1);
  assert.deepEqual(await readFile(path.join(root, retainedNames[0])), built.bytes);
});

test("stable reads compare two positional handle reads and reject zero file identities", async (t) => {
  const root = await temporaryDirectory(t);
  const first = fixture("a");
  const second = fixture("b");
  assert.equal(first.bytes.length, second.bytes.length);
  await publishControlledHypothesisLedger(root, "ledger.jsonl", first.bytes);
  const target = path.join(root, "ledger.jsonl");

  await assert.rejects(readControlledHypothesisLedger(root, "ledger.jsonl", {
    openReadFile: async () => {
      const metadata = await lstat(target, { bigint: true });
      let pass = 0;
      return {
        close: async () => {},
        read: async (buffer, offset, length, position) => {
          if (position >= first.bytes.length) return { buffer, bytesRead: 0 };
          if (position === 0) pass += 1;
          const source = pass === 1 ? first.bytes : second.bytes;
          const bytesRead = Math.min(length, source.length - position);
          source.copy(buffer, offset, position, position + bytesRead);
          return { buffer, bytesRead };
        },
        stat: async () => metadata,
      };
    },
  }));

  const zeroIdentity = (metadata) => new Proxy(metadata, {
    get(targetMetadata, property, receiver) {
      if (property === "dev" || property === "ino") return 0n;
      const value = Reflect.get(targetMetadata, property, receiver);
      return typeof value === "function" ? value.bind(targetMetadata) : value;
    },
  });
  await assert.rejects(readControlledHypothesisLedger(root, "ledger.jsonl", {
    lstatImpl: async (...arguments_) => zeroIdentity(await lstat(...arguments_)),
  }));
});

test("Windows DOS device names and extensions are rejected as pure path syntax", async (t) => {
  const root = await temporaryDirectory(t);
  const built = fixture();
  const reservedPaths = [
    "CON",
    "prn.jsonl",
    "AuX.log",
    "nul.txt",
    "COM1.jsonl",
    "com9",
    "LPT1.tmp",
    "lpt9",
    path.join("safe", "NUL.hypotheses"),
  ];
  for (const relativePath of reservedPaths) {
    let fileSystemCalls = 0;
    await assert.rejects(
      publishControlledHypothesisLedger(root, relativePath, built.bytes, {
        lstatImpl: async () => {
          fileSystemCalls += 1;
          throw new Error("path syntax validation touched the file system");
        },
      }),
      { code: "LEDGER_RELATIVE_PATH" },
      relativePath,
    );
    assert.equal(fileSystemCalls, 0, relativePath);
  }
});

test("Windows UNC and device-namespace controlled roots are rejected before I/O", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows-only root namespace contract");
    return;
  }
  const built = fixture();
  const forbiddenRoots = [
    "\\\\server\\share",
    "//server/share",
    "\\\\?\\C:\\controlled",
    "\\\\.\\C:\\controlled",
    "\\\\?\\UNC\\server\\share",
  ];
  for (const controlledRoot of forbiddenRoots) {
    let fileSystemCalls = 0;
    await assert.rejects(
      publishControlledHypothesisLedger(controlledRoot, "ledger.jsonl", built.bytes, {
        lstatImpl: async () => {
          fileSystemCalls += 1;
          throw new Error("root namespace validation touched the file system");
        },
      }),
      { code: "LEDGER_CONTROLLED_ROOT" },
      controlledRoot,
    );
    assert.equal(fileSystemCalls, 0, controlledRoot);
  }
});

test("path escape and symlink or junction ancestors are rejected", async (t) => {
  const root = await temporaryDirectory(t);
  const outside = await temporaryDirectory(t);
  const built = fixture();
  const escapedName = `escaped-${path.basename(root)}.jsonl`;
  await assert.rejects(publishControlledHypothesisLedger(root, path.join("..", escapedName), built.bytes));
  await assert.rejects(lstat(path.join(path.dirname(root), escapedName)), { code: "ENOENT" });

  const linked = path.join(root, "linked");
  try {
    await symlink(outside, linked, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (["EPERM", "EACCES", "ENOSYS"].includes(error?.code)) {
      t.skip(`symlink unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  await assert.rejects(publishControlledHypothesisLedger(root, path.join("linked", "escaped.jsonl"), built.bytes));
  await assert.rejects(lstat(path.join(outside, "escaped.jsonl")), { code: "ENOENT" });
});

test("schema is strict JSON Schema and binds the private authority constants", async () => {
  const schema = JSON.parse(await readFile(new URL("./controlled-hypothesis-ledger.schema.json", import.meta.url), "utf8"));
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.kind.const, "meetingrelay-controlled-hypothesis-ledger-v1");
  assert.equal(schema.properties.schema_version.const, "1.0");
  assert.equal(schema.properties.authority.properties.privacy_class.const, "controlled");
  assert.equal(schema.properties.authority.properties.public_distribution.const, false);
  assert.equal(schema.properties.entries.maxItems, 10_000);
  assert.equal(schema.properties.entries.items.additionalProperties, false);
  assert.equal(schema.properties.entries.items.required.includes("component_record_sha256"), true);
  assert.match(schema.properties.entries.items.properties.final_transcript.description, /authoritative runtime validator.*UTF-8 bytes/iu);
  const digestPattern = new RegExp(schema.$defs.nonzeroSha256.pattern, "u");
  assert.equal(digestPattern.test("0".repeat(64)), false);
  assert.equal(digestPattern.test("a".repeat(64)), true);
});
