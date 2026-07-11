import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  encodeCanonicalJson,
  encodeCanonicalJsonLine,
} from "./canonical-json.mjs";
import { sha256 } from "./fixture-contract.mjs";
import {
  buildSamplingContract,
  collectResourceSeries,
  generateDoubleQueueResourceRun,
  runDeterministicQueueScenario,
  validateQueueResourceBundle,
  validateQueueResourceRun,
} from "./queue-resource-harness.mjs";

function monotonicClock(start = 1_000n, step = 10n) {
  let value = start;
  return () => {
    const current = value;
    value += step;
    return current;
  };
}

function fixedSnapshot(seed = 0) {
  return {
    process_cpu: {
      system_microseconds: 200 + seed,
      user_microseconds: 1_000 + seed,
    },
    process_memory: {
      array_buffers_bytes: 100 + seed,
      external_bytes: 200 + seed,
      heap_total_bytes: 3_000 + seed,
      heap_used_bytes: 2_000 + seed,
      rss_bytes: 5_000 + seed,
    },
    system_memory: {
      free_bytes: 8_000 + seed,
      total_bytes: 16_000 + seed,
    },
    logical_cpu_times: [
      { idle_ms: 10_000 + seed, irq_ms: seed, system_ms: 200 + seed, user_ms: 500 + seed },
      { idle_ms: 11_000 + seed, irq_ms: seed, system_ms: 210 + seed, user_ms: 510 + seed },
    ],
  };
}

function perCoreIndexRegressionReader() {
  let call = 0;
  return () => {
    const snapshot = fixedSnapshot();
    if (call > 0) {
      snapshot.logical_cpu_times[0].idle_ms -= 10;
    }
    call += 1;
    return snapshot;
  };
}

async function withTempRoot(prefix, callback) {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  try {
    return await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function readJsonLines(file) {
  const text = await readFile(file, "utf8");
  return text.trimEnd().split("\n").map(JSON.parse);
}

async function writeJson(file, value) {
  await writeFile(file, encodeCanonicalJson(value), "utf8");
}

async function writeJsonLines(file, records) {
  const bytes = Buffer.from(records.map(encodeCanonicalJsonLine).join(""), "utf8");
  await writeFile(file, bytes);
  return bytes;
}

async function updateRunArtifactDigest(runRoot, field, bytes) {
  const summaryFile = path.join(runRoot, "run-summary.json");
  const summary = await readJson(summaryFile);
  summary[field] = sha256(bytes);
  await writeJson(summaryFile, summary);
}

function smallContract() {
  return buildSamplingContract({ resourceSampleCount: 2 });
}

async function generateInjectedBundle(root, { seedA = 0, seedB = 100 } = {}) {
  return generateDoubleQueueResourceRun(root, {
    contract: smallContract(),
    runA: {
      monotonicNow: monotonicClock(1_000n),
      resourceReader: () => fixedSnapshot(seedA),
    },
    runB: {
      monotonicNow: monotonicClock(2_000n),
      resourceReader: () => fixedSnapshot(seedB),
    },
  });
}

test("scripted queue conserves every item with mutually exclusive outcomes", () => {
  const contract = buildSamplingContract();
  const records = runDeterministicQueueScenario(contract);
  assert.equal(records.length, 11);
  assert.ok(records.every((record) => record.conservation_delta === "0"));
  assert.ok(records.every((record) => BigInt(record.depth) <= 4n));
  assert.deepEqual(
    {
      enqueue: records.at(-1).enqueue_total,
      dequeue: records.at(-1).dequeue_total,
      drop: records.at(-1).drop_total,
      merge: records.at(-1).merge_total,
      cancel: records.at(-1).cancel_total,
      depth: records.at(-1).depth,
      retry: records.at(-1).retry_total,
      full: records.at(-1).full_total,
      high: records.at(-1).high_water_depth,
    },
    {
      enqueue: "5",
      dequeue: "2",
      drop: "1",
      merge: "1",
      cancel: "1",
      depth: "0",
      retry: "1",
      full: "1",
      high: "4",
    },
  );
});

test("scripted queue bytes remain deterministic across independent calls", () => {
  const contract = buildSamplingContract();
  const firstRecords = runDeterministicQueueScenario(contract);
  const first = firstRecords.map(encodeCanonicalJsonLine).join("");
  firstRecords[8].operation.successor.revision = "99";
  const second = runDeterministicQueueScenario(contract).map(encodeCanonicalJsonLine).join("");
  assert.equal(first, second);
  assert.equal(sha256(Buffer.from(first)), sha256(Buffer.from(second)));
});

test("sampling contract rejects invalid capacity and watermark configurations", () => {
  for (const options of [
    { queueCapacity: 0 },
    { queueCapacity: 4, queueHighWatermark: 5 },
    { queueHighWatermark: 3, queueLowWatermark: 3 },
    { queueCapacity: 5, queueHighWatermark: 4, queueLowWatermark: 2 },
    { resourceSampleCount: 0 },
  ]) {
    assert.throws(() => buildSamplingContract(options));
  }
});

test("actual Windows collector writes a nonregressing threshold-free series", () => {
  const records = collectResourceSeries({ runId: "actual-smoke", sampleCount: 4 });
  assert.equal(records.length, 4);
  for (const [index, record] of records.entries()) {
    assert.equal(record.sample_sequence, String(index + 1));
    assert.equal(record.clock_domain_id, "node.hrtime.actual-smoke");
    assert.ok(BigInt(record.observed_end_ns) >= BigInt(record.observed_start_ns));
    assert.equal(record.formal_claims, "none");
  }
});

test("Windows-only pseudo-zero metrics stay null and unsupported", () => {
  const [record] = collectResourceSeries({ runId: "capability-smoke", sampleCount: 1 });
  for (const key of [
    "major_page_faults",
    "voluntary_context_switches",
    "involuntary_context_switches",
    "cpu_nice_ms",
    "load_average_1m",
    "load_average_5m",
    "load_average_15m",
    "gpu_vram_bytes",
  ]) {
    assert.deepEqual(
      {
        value: record.metrics.unsupported[key].value,
        status: record.metrics.unsupported[key].status,
        availability: record.metrics.unsupported[key].availability,
      },
      { value: null, status: "unsupported", availability: "unavailable" },
    );
  }
});

test("per-core snapshot indices do not claim cross-sample monotonic identity", async () => {
  await withTempRoot("meetingrelay-resource-core-index-", async (root) => {
    const comparison = await generateDoubleQueueResourceRun(root, {
      contract: smallContract(),
      runA: {
        monotonicNow: monotonicClock(1_000n),
        resourceReader: perCoreIndexRegressionReader(),
      },
      runB: {
        monotonicNow: monotonicClock(2_000n),
        resourceReader: perCoreIndexRegressionReader(),
      },
    });
    assert.equal(
      comparison.resource_artifacts.stable_capability_projection,
      "sha256-equal",
    );
  });
});

test("resource collector rejects a regressing observation clock", () => {
  const values = [100n, 101n, 99n, 100n];
  assert.throws(
    () =>
      collectResourceSeries({
        runId: "regression",
        sampleCount: 2,
        monotonicNow: () => values.shift(),
        resourceReader: () => fixedSnapshot(),
      }),
    /regressed/,
  );
});

test("double run keeps queue bytes equal and resource equality not required", async () => {
  await withTempRoot("meetingrelay-resource-double-", async (root) => {
    const comparison = await generateInjectedBundle(root);
    assert.equal(comparison.queue_artifacts.comparison, "byte-and-sha256-equal");
    assert.equal(
      comparison.resource_artifacts.runtime_artifact_equality,
      "not-required",
    );
    assert.equal(
      comparison.resource_artifacts.stable_capability_projection,
      "sha256-equal",
    );
    assert.notEqual(comparison.run_a.clock_domain_id, comparison.run_b.clock_domain_id);
    assert.equal(comparison.cross_domain_subtraction, "forbidden");
  });
});

test("queue validator recomputes state after checksum-preserving tamper", async () => {
  await withTempRoot("meetingrelay-resource-queue-tamper-", async (root) => {
    await generateInjectedBundle(root);
    const runRoot = path.join(root, "run-a");
    const queueFile = path.join(runRoot, "queue-samples.jsonl");
    const records = await readJsonLines(queueFile);
    records[0].depth = "2";
    const bytes = await writeJsonLines(queueFile, records);
    await updateRunArtifactDigest(runRoot, "queue_samples_sha256", bytes);
    await assert.rejects(
      validateQueueResourceRun(runRoot, smallContract()),
      /recomputed deterministic scenario/,
    );
  });
});

test("resource validator rejects unsupported metrics forged as zero", async () => {
  await withTempRoot("meetingrelay-resource-fake-zero-", async (root) => {
    await generateInjectedBundle(root);
    const runRoot = path.join(root, "run-a");
    const resourceFile = path.join(runRoot, "resource-samples.jsonl");
    const records = await readJsonLines(resourceFile);
    records[0].metrics.unsupported.major_page_faults.value = "0";
    const bytes = await writeJsonLines(resourceFile, records);
    await updateRunArtifactDigest(runRoot, "resource_samples_sha256", bytes);
    await assert.rejects(
      validateQueueResourceRun(runRoot, smallContract()),
      /null unsupported capability states/,
    );
  });
});

test("resource validator rejects a mixed clock domain after checksum update", async () => {
  await withTempRoot("meetingrelay-resource-domain-tamper-", async (root) => {
    await generateInjectedBundle(root);
    const runRoot = path.join(root, "run-a");
    const resourceFile = path.join(runRoot, "resource-samples.jsonl");
    const records = await readJsonLines(resourceFile);
    records[1].run_id = "other-run";
    records[1].clock_domain_id = "node.hrtime.other-run";
    const bytes = await writeJsonLines(resourceFile, records);
    await updateRunArtifactDigest(runRoot, "resource_samples_sha256", bytes);
    await assert.rejects(
      validateQueueResourceRun(runRoot, smallContract()),
      /changed run or clock domain/,
    );
  });
});

test("run validator rejects a summary not derived from raw artifacts", async () => {
  await withTempRoot("meetingrelay-resource-summary-tamper-", async (root) => {
    await generateInjectedBundle(root);
    const runRoot = path.join(root, "run-a");
    const summaryFile = path.join(runRoot, "run-summary.json");
    const summary = await readJson(summaryFile);
    summary.queue_final.high_water_depth = "3";
    await writeJson(summaryFile, summary);
    await assert.rejects(
      validateQueueResourceRun(runRoot, smallContract()),
      /summary differs/,
    );
  });
});

test("bundle validator rejects a cross-domain comparison policy tamper", async () => {
  await withTempRoot("meetingrelay-resource-comparison-tamper-", async (root) => {
    await generateInjectedBundle(root);
    const comparisonFile = path.join(root, "comparison.json");
    const comparison = await readJson(comparisonFile);
    comparison.cross_domain_subtraction = "allowed";
    await writeJson(comparisonFile, comparison);
    await assert.rejects(
      validateQueueResourceBundle(root),
      /comparison differs/,
    );
  });
});

test("bundle validator rejects unexpected root and run inventory", async () => {
  await withTempRoot("meetingrelay-resource-inventory-", async (root) => {
    await generateInjectedBundle(root);
    await writeFile(path.join(root, "unexpected.txt"), "unexpected", "utf8");
    await assert.rejects(validateQueueResourceBundle(root), /inventory differs/);
  });
});

test("resource evidence rejects formal metric claims", async () => {
  await withTempRoot("meetingrelay-resource-claims-", async (root) => {
    await generateInjectedBundle(root);
    const runRoot = path.join(root, "run-a");
    const resourceFile = path.join(runRoot, "resource-samples.jsonl");
    const records = await readJsonLines(resourceFile);
    records[0].evidence.metric_id = "PERF-MEM-001";
    const bytes = await writeJsonLines(resourceFile, records);
    await updateRunArtifactDigest(runRoot, "resource_samples_sha256", bytes);
    await assert.rejects(validateQueueResourceRun(runRoot, smallContract()));
  });
});

test("resource collection rejects unsafe runtime descriptor values", () => {
  assert.throws(
    () =>
      collectResourceSeries({
        runId: "unsafe-runtime",
        sampleCount: 1,
        monotonicNow: monotonicClock(),
        resourceReader: () => fixedSnapshot(),
        runtime: {
          arch: "x64",
          node_version: "C:\\Users\\Alice\\secret.env",
          platform: "win32",
          uv_version: "host-prod-01",
        },
      }),
    /safe semantic version string/,
  );
});

test("artifact validation rejects a checksum-preserving unsafe runtime value", async () => {
  await withTempRoot("meetingrelay-resource-runtime-value-", async (root) => {
    await generateInjectedBundle(root);
    const runRoot = path.join(root, "run-a");
    const resourceFile = path.join(runRoot, "resource-samples.jsonl");
    const records = await readJsonLines(resourceFile);
    records[0].runtime.node_version = "C:\\Users\\Alice\\secret.env";
    const bytes = await writeJsonLines(resourceFile, records);
    await updateRunArtifactDigest(runRoot, "resource_samples_sha256", bytes);
    await assert.rejects(
      validateQueueResourceRun(runRoot, smallContract()),
      /safe semantic version string/,
    );
  });
});

test("supported resource groups reject unregistered identity fields", async () => {
  await withTempRoot("meetingrelay-resource-group-keys-", async (root) => {
    await generateInjectedBundle(root);
    const runRoot = path.join(root, "run-a");
    const resourceFile = path.join(runRoot, "resource-samples.jsonl");
    const records = await readJsonLines(resourceFile);
    records[0].metrics.process_memory.hostname = "secret-host";
    const bytes = await writeJsonLines(resourceFile, records);
    await updateRunArtifactDigest(runRoot, "resource_samples_sha256", bytes);
    await assert.rejects(
      validateQueueResourceRun(runRoot, smallContract()),
      /keys differ/,
    );
  });
});

test("canonical JSONL validation rejects CRLF even with an updated digest", async () => {
  await withTempRoot("meetingrelay-resource-crlf-", async (root) => {
    await generateInjectedBundle(root);
    const runRoot = path.join(root, "run-a");
    const queueFile = path.join(runRoot, "queue-samples.jsonl");
    const text = await readFile(queueFile, "utf8");
    const bytes = Buffer.from(text.replaceAll("\n", "\r\n"), "utf8");
    await writeFile(queueFile, bytes);
    await updateRunArtifactDigest(runRoot, "queue_samples_sha256", bytes);
    await assert.rejects(
      validateQueueResourceRun(runRoot, smallContract()),
      /canonical JSONL/,
    );
  });
});

test("in-memory generation does not call wall clock timers or network", () => {
  const originalDateNow = Date.now;
  const originalSetTimeout = globalThis.setTimeout;
  const originalSetInterval = globalThis.setInterval;
  const originalFetch = globalThis.fetch;
  const forbidden = () => {
    throw new Error("forbidden runtime API called");
  };
  try {
    Date.now = forbidden;
    globalThis.setTimeout = forbidden;
    globalThis.setInterval = forbidden;
    globalThis.fetch = forbidden;
    runDeterministicQueueScenario(buildSamplingContract());
    collectResourceSeries({
      runId: "no-runtime-api",
      sampleCount: 2,
      monotonicNow: monotonicClock(),
      resourceReader: () => fixedSnapshot(),
    });
  } finally {
    Date.now = originalDateNow;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.setInterval = originalSetInterval;
    globalThis.fetch = originalFetch;
  }
});
