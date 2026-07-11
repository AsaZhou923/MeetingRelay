import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { encodeCanonicalJsonLine } from "./canonical-json.mjs";
import { sha256 } from "./fixture-contract.mjs";
import {
  compareReplays,
  cleanOutputDirectory,
  createReplay,
  deriveDeterministicEventId,
  generateDoubleReplay,
  validateReplay,
} from "./ledger-contract.mjs";

async function withTempRoot(run) {
  const root = await mkdtemp(path.join(tmpdir(), "meetingrelay-ledger-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function readRecords(file) {
  return (await readFile(file, "utf8"))
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
}

async function writeRecords(file, records) {
  await writeFile(file, records.map(encodeCanonicalJsonLine).join(""), "utf8");
}

function payloadSha256(payload) {
  return sha256(Buffer.from(encodeCanonicalJsonLine(payload), "utf8"));
}

function rebuildDeterministic(record, prefix) {
  record.payload_sha256 = payloadSha256(record.payload);
  record.event_id = deriveDeterministicEventId(record, prefix);
}

test("two clean replays produce identical input and decision ledgers", async () => {
  await withTempRoot(async (root) => {
    const comparison = await generateDoubleReplay(root);
    assert.equal(comparison.input_ledger.comparison, "byte-and-sha256-equal");
    assert.equal(comparison.decision_ledger.comparison, "byte-and-sha256-equal");
    assert.match(comparison.input_ledger.sha256, /^[0-9a-f]{64}$/);
    assert.match(comparison.decision_ledger.sha256, /^[0-9a-f]{64}$/);
    assert.equal(comparison.formal_claims, "none");
  });
});

test("observation ledgers retain runtime differences while stable joins match", async () => {
  await withTempRoot(async (root) => {
    const runA = path.join(root, "a");
    const runB = path.join(root, "b");
    const valuesA = [100n, 101n];
    const valuesB = [200n, 201n];
    await createReplay(runA, {
      runId: "00000000-0000-4000-8000-000000000001",
      monotonicNow: () => valuesA.shift(),
    });
    await createReplay(runB, {
      runId: "00000000-0000-4000-8000-000000000002",
      monotonicNow: () => valuesB.shift(),
    });
    const comparison = await compareReplays(runA, runB);
    assert.equal(comparison.observation_ledger.comparison, "not-required");
    assert.equal(comparison.observation_ledger.distinct_runtime_bytes, true);
    assert.equal(comparison.observation_ledger.stable_join_projection_equal, true);
  });
});

test("canonical JSONL validation rejects CRLF", async () => {
  await withTempRoot(async (root) => {
    await createReplay(root);
    const file = path.join(root, "input-ledger.jsonl");
    const text = await readFile(file, "utf8");
    await writeFile(file, text.replaceAll("\n", "\r\n"), "utf8");
    await assert.rejects(validateReplay(root), /without BOM or CRLF/);
  });
});

test("canonical uint64 validation rejects a leading zero", async () => {
  await withTempRoot(async (root) => {
    await createReplay(root);
    const file = path.join(root, "input-ledger.jsonl");
    const records = await readRecords(file);
    records[0].ledger_sequence = "01";
    await writeRecords(file, records);
    await assert.rejects(validateReplay(root), /must be a canonical uint64 string/);
  });
});

test("ledger ordering rejects a sequence gap", async () => {
  await withTempRoot(async (root) => {
    await createReplay(root);
    const file = path.join(root, "observation-ledger.jsonl");
    const records = await readRecords(file);
    records[1].ledger_sequence = "3";
    await writeRecords(file, records);
    await assert.rejects(validateReplay(root), /expected 2, got 3/);
  });
});

test("deterministic ledgers reject runtime-only fields", async () => {
  await withTempRoot(async (root) => {
    await createReplay(root);
    const file = path.join(root, "decision-ledger.jsonl");
    const records = await readRecords(file);
    records[0].run_id = "runtime-leak";
    await writeRecords(file, records);
    await assert.rejects(validateReplay(root), /contains runtime-only field run_id/);
  });
});

test("payload integrity rejects content changed without its digest", async () => {
  await withTempRoot(async (root) => {
    await createReplay(root);
    const file = path.join(root, "decision-ledger.jsonl");
    const records = await readRecords(file);
    records[0].payload.decision = "rejected";
    await writeRecords(file, records);
    await assert.rejects(validateReplay(root), /payload_sha256 mismatch/);
  });
});

test("deterministic event IDs must remain content-derived", async () => {
  await withTempRoot(async (root) => {
    await createReplay(root);
    const file = path.join(root, "input-ledger.jsonl");
    const records = await readRecords(file);
    records[0].event_id = `inp_${"0".repeat(64)}`;
    await writeRecords(file, records);
    await assert.rejects(validateReplay(root), /event_id is not content-derived/);
  });
});

test("observation causation and join fields must resolve to their source", async () => {
  await withTempRoot(async (root) => {
    await createReplay(root);
    const file = path.join(root, "observation-ledger.jsonl");
    const records = await readRecords(file);
    records[1].segment_id = "harness_seg_wrong";
    await writeRecords(file, records);
    await assert.rejects(validateReplay(root), /join field segment_id does not match its source/);
  });
});

test("observation source hashes must match deterministic ledger bytes", async () => {
  await withTempRoot(async (root) => {
    await createReplay(root);
    const file = path.join(root, "observation-ledger.jsonl");
    const records = await readRecords(file);
    records[0].payload.source_event_sha256 = "0".repeat(64);
    records[0].payload_sha256 = payloadSha256(records[0].payload);
    await writeRecords(file, records);
    await assert.rejects(validateReplay(root), /payload does not match its deterministic source/);
  });
});

test("observation monotonic time cannot regress within one clock domain", async () => {
  await withTempRoot(async (root) => {
    await createReplay(root);
    const file = path.join(root, "observation-ledger.jsonl");
    const records = await readRecords(file);
    records[1].observed_monotonic_ns = "0";
    await writeRecords(file, records);
    await assert.rejects(validateReplay(root), /observed_monotonic_ns regressed/);
  });
});

test("scripted commit decisions cannot claim durability", async () => {
  await withTempRoot(async (root) => {
    await createReplay(root);
    const file = path.join(root, "decision-ledger.jsonl");
    const records = await readRecords(file);
    records[0].payload.durable = true;
    rebuildDeterministic(records[0], "dec");
    await writeRecords(file, records);
    await assert.rejects(validateReplay(root), /non-durable scripted commit contract/);
  });
});

test("harness ledgers reject formal metric claims and paint trace points", async () => {
  await withTempRoot(async (root) => {
    const metricRoot = path.join(root, "metric");
    await createReplay(metricRoot);
    const metricFile = path.join(metricRoot, "input-ledger.jsonl");
    const metricRecords = await readRecords(metricFile);
    metricRecords[0].evidence.metric_id = "PERF-RT-001";
    await writeRecords(metricFile, metricRecords);
    await assert.rejects(validateReplay(metricRoot), /metric, SLO, candidate, or production claim/);

    const paintRoot = path.join(root, "paint");
    await createReplay(paintRoot);
    const paintFile = path.join(paintRoot, "input-ledger.jsonl");
    const paintRecords = await readRecords(paintFile);
    paintRecords[0].trace_point = "original.final.paint";
    await writeRecords(paintFile, paintRecords);
    await assert.rejects(validateReplay(paintRoot), /production paint trace point/);
  });
});

test("replay validation rejects extra inventory", async () => {
  await withTempRoot(async (root) => {
    await createReplay(root);
    await writeFile(path.join(root, "unexpected.json"), "{}\n", "utf8");
    await assert.rejects(validateReplay(root), /ledger file inventory differs/);
  });
});

test("artifact cleanup rejects an escaping symlink or junction ancestor", async () => {
  await withTempRoot(async (sandbox) => {
    const repository = path.join(sandbox, "repository");
    const outside = path.join(sandbox, "outside");
    const targetLink = path.join(repository, "target");
    const redirectedOutput = path.join(targetLink, "wp-0.3", "ct-ledger-001");
    const sentinel = path.join(outside, "wp-0.3", "ct-ledger-001", "sentinel.txt");
    await mkdir(path.dirname(sentinel), { recursive: true });
    await mkdir(repository);
    await writeFile(sentinel, "preserve\n", "utf8");
    await symlink(outside, targetLink, process.platform === "win32" ? "junction" : "dir");

    await assert.rejects(
      cleanOutputDirectory(redirectedOutput, repository),
      /symbolic link or junction|reparse point|resolves outside/,
    );
    assert.equal(await readFile(sentinel, "utf8"), "preserve\n");
  });
});
