import assert from "node:assert/strict";
import {
  lstat,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  encodeCanonicalJson,
  encodeCanonicalJsonLine,
} from "./canonical-json.mjs";
import {
  buildCalibrationContract,
  collectClockCalibration,
  createClockRun,
  generateDoubleClockCalibration,
  validateClockCalibrationBundle,
  validateClockRun,
} from "./clock-calibration.mjs";
import { sha256 } from "./fixture-contract.mjs";

async function withTempRoot(run) {
  const root = await mkdtemp(path.join(tmpdir(), "meetingrelay-clock-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function sequenceReader(values) {
  let index = 0;
  return () => {
    if (index >= values.length) {
      throw new Error("test clock sequence exhausted");
    }
    const value = values[index];
    index += 1;
    return value;
  };
}

function fixedContract(samplePairCount) {
  return buildCalibrationContract(samplePairCount);
}

test("actual process clock writes one valid nondecreasing-domain artifact", async () => {
  await withTempRoot(async (root) => {
    const contract = fixedContract(1_024);
    const result = await createClockRun(root, {
      samplePairCount: 1_024,
      contract,
    });
    assert.equal(result.summary.status, "available");
    assert.equal(result.records.length, 1_024);
    assert.equal(result.summary.sample_pair_count, "1024");
    assert.match(result.summary.clock_domain_id, /^node\.hrtime\./);
    assert.equal(result.summary.reference_error.status, "unavailable");
    assert.equal(result.summary.reference_error.value_ns, null);
  });
});

test("regressing clock fails before a success artifact is written", async () => {
  await withTempRoot(async (root) => {
    const outputRoot = path.join(root, "output");
    const contract = fixedContract(2);
    await assert.rejects(
      createClockRun(outputRoot, {
        clockRead: sequenceReader([100n, 101n, 99n, 102n]),
        runId: "regression-run",
        samplePairCount: 2,
        contract,
      }),
      /regressed between read pairs/,
    );
    await assert.rejects(lstat(outputRoot), (error) => error.code === "ENOENT");
  });
});

test("mixed clock domains are rejected after sample checksum recomputation", async () => {
  await withTempRoot(async (root) => {
    const contract = fixedContract(2);
    await createClockRun(root, {
      clockRead: sequenceReader([100n, 101n, 102n, 103n]),
      runId: "domain-run",
      samplePairCount: 2,
      contract,
    });
    const samplesFile = path.join(root, "clock-samples.jsonl");
    const records = (await readFile(samplesFile, "utf8"))
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    records[1].clock_domain_id = "node.hrtime.other-run";
    const sampleBytes = Buffer.from(
      records.map(encodeCanonicalJsonLine).join(""),
      "utf8",
    );
    await writeFile(samplesFile, sampleBytes);
    const summaryFile = path.join(root, "clock-calibration.json");
    const summary = JSON.parse(await readFile(summaryFile, "utf8"));
    summary.samples_sha256 = sha256(sampleBytes);
    await writeFile(summaryFile, encodeCanonicalJson(summary), "utf8");
    await assert.rejects(
      validateClockRun(root, contract),
      /identity, domain, source, or sequence differs/,
    );
  });
});

test("known read pairs produce exact nearest-rank diagnostic statistics", () => {
  const result = collectClockCalibration({
    clockRead: sequenceReader([100n, 100n, 101n, 103n, 104n, 108n, 109n, 115n]),
    runId: "known-run",
    samplePairCount: 4,
    contract: fixedContract(4),
  });
  assert.deepEqual(result.summary.read_overhead_ns, {
    min: "0",
    p50: "2",
    p95: "6",
    max: "6",
  });
  assert.equal(result.summary.zero_delta_count, "1");
  assert.equal(result.summary.positive_delta_count, "3");
  assert.deepEqual(result.summary.observed_resolution, {
    status: "descriptive",
    value_ns: "2",
    reason: null,
  });
  assert.deepEqual(result.summary.observed_quantization, {
    status: "descriptive",
    value_ns: "2",
    reason: null,
  });
});

test("non-advancing observations preserve unavailable resolution as null", () => {
  const result = collectClockCalibration({
    clockRead: sequenceReader(Array(8).fill(100n)),
    runId: "zero-run",
    samplePairCount: 4,
    contract: fixedContract(4),
  });
  assert.equal(result.summary.status, "available");
  assert.equal(result.summary.positive_delta_count, "0");
  assert.deepEqual(result.summary.observed_resolution, {
    status: "unavailable",
    value_ns: null,
    reason: "no-positive-delta",
  });
  assert.deepEqual(result.summary.observed_quantization, {
    status: "unavailable",
    value_ns: null,
    reason: "no-positive-delta",
  });
});

test("unsupported clock records null capability gaps", async () => {
  await withTempRoot(async (root) => {
    const contract = fixedContract(4);
    const result = await createClockRun(root, {
      clockRead: null,
      runId: "unsupported-run",
      samplePairCount: 4,
      contract,
    });
    assert.equal(result.summary.status, "unsupported");
    assert.equal(result.records.length, 0);
    assert.equal(result.summary.clock_domain_id, null);
    assert.equal(result.summary.unit, null);
    assert.equal(result.summary.read_overhead_ns, null);
    assert.equal(result.summary.observed_resolution.value_ns, null);
    assert.equal(result.summary.observed_quantization.value_ns, null);
  });
});

test("validator recomputes diagnostic statistics instead of trusting summary", async () => {
  await withTempRoot(async (root) => {
    const contract = fixedContract(4);
    await createClockRun(root, {
      clockRead: sequenceReader([100n, 100n, 101n, 103n, 104n, 108n, 109n, 115n]),
      runId: "tamper-run",
      samplePairCount: 4,
      contract,
    });
    const summaryFile = path.join(root, "clock-calibration.json");
    const summary = JSON.parse(await readFile(summaryFile, "utf8"));
    summary.read_overhead_ns.p95 = "5";
    await writeFile(summaryFile, encodeCanonicalJson(summary), "utf8");
    await assert.rejects(
      validateClockRun(root, contract),
      /summary statistics do not match raw samples/,
    );
  });
});

test("clock calibration rejects formal metric and production claims", async () => {
  await withTempRoot(async (root) => {
    const contract = fixedContract(2);
    await createClockRun(root, {
      clockRead: sequenceReader([100n, 101n, 102n, 103n]),
      runId: "claim-run",
      samplePairCount: 2,
      contract,
    });
    const summaryFile = path.join(root, "clock-calibration.json");
    const summary = JSON.parse(await readFile(summaryFile, "utf8"));
    summary.evidence.metric_id = "PERF-RT-001";
    summary.evidence.production_evidence = true;
    await writeFile(summaryFile, encodeCanonicalJson(summary), "utf8");
    await assert.rejects(
      validateClockRun(root, contract),
      /metric, SLO, candidate, or production claim/,
    );
  });
});

test("bundle validator rejects a tampered cross-run comparison", async () => {
  await withTempRoot(async (root) => {
    await generateDoubleClockCalibration(root, {
      clockRead: sequenceReader([100n, 101n, 102n, 103n, 104n, 105n, 106n, 107n]),
      samplePairCount: 2,
    });
    const comparisonFile = path.join(root, "comparison.json");
    const comparison = JSON.parse(await readFile(comparisonFile, "utf8"));
    comparison.cross_domain_subtraction = "allowed";
    await writeFile(comparisonFile, encodeCanonicalJson(comparison), "utf8");
    await assert.rejects(
      validateClockCalibrationBundle(root),
      /comparison does not match the validated runs/,
    );
  });
});
