import os from "node:os";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  encodeCanonicalJson,
  encodeCanonicalJsonLine,
} from "./canonical-json.mjs";
import {
  FIXTURE_LOGICAL_CLOCK_DOMAIN_ID,
  NODE_HRTIME_SOURCE,
  assertSafeRunId,
  observationClockDomainId,
} from "./clock-domain.mjs";
import { sha256 } from "./fixture-contract.mjs";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(MODULE_DIR, "..", "..");
const DEFAULT_OUTPUT_ROOT = path.join(
  REPOSITORY_ROOT,
  "target",
  "wp-0.3",
  "ct-resource-harness-001",
);
const DEFAULT_RESOURCE_SAMPLE_COUNT = 32;
const MAX_U64 = (1n << 64n) - 1n;
const RUN_FILES = Object.freeze([
  "queue-samples.jsonl",
  "resource-samples.jsonl",
  "run-summary.json",
]);
const BUNDLE_ENTRIES = Object.freeze([
  "comparison.json",
  "run-a",
  "run-b",
  "sampling-contract.json",
]);
const EVIDENCE_KEYS = Object.freeze([
  "candidate_id",
  "metric_id",
  "production_evidence",
  "slo_claims",
  "stage",
]);
const UNSUPPORTED_KEYS = Object.freeze([
  "cpu_nice_ms",
  "disk_latency_ns",
  "disk_queue_depth",
  "gpu_compute_percent",
  "gpu_copy_percent",
  "gpu_power_watts",
  "gpu_temperature_c",
  "gpu_vram_bytes",
  "involuntary_context_switches",
  "load_average_15m",
  "load_average_1m",
  "load_average_5m",
  "major_page_faults",
  "network_bytes",
  "process_commit_bytes",
  "process_handle_count",
  "process_private_bytes",
  "process_thread_count",
  "voluntary_context_switches",
]);

const QUEUE_SCRIPT = Object.freeze([
  Object.freeze({
    action: "enqueue",
    item_id: "interim-a-r1",
    item_kind: "interim",
    coalesce_key: "segment-a",
    revision: "1",
    reason: null,
    replaces_item_id: null,
    successor: null,
  }),
  Object.freeze({
    action: "enqueue",
    item_id: "interim-b-r1",
    item_kind: "interim",
    coalesce_key: "segment-b",
    revision: "1",
    reason: null,
    replaces_item_id: null,
    successor: null,
  }),
  Object.freeze({
    action: "enqueue",
    item_id: "interim-c-r1",
    item_kind: "interim",
    coalesce_key: "segment-c",
    revision: "1",
    reason: null,
    replaces_item_id: null,
    successor: null,
  }),
  Object.freeze({
    action: "enqueue",
    item_id: "interim-d-r1",
    item_kind: "interim",
    coalesce_key: "segment-d",
    revision: "1",
    reason: null,
    replaces_item_id: null,
    successor: null,
  }),
  Object.freeze({
    action: "full_attempt",
    item_id: "interim-e-r1",
    item_kind: "interim",
    coalesce_key: "segment-e",
    revision: "1",
    reason: "capacity_reached",
    replaces_item_id: null,
    successor: null,
  }),
  Object.freeze({
    action: "merge",
    item_id: "interim-a-r2",
    item_kind: "interim",
    coalesce_key: "segment-a",
    revision: "2",
    reason: "superseded_revision",
    replaces_item_id: "interim-a-r1",
    successor: null,
  }),
  Object.freeze({
    action: "dequeue",
    item_id: "interim-b-r1",
    item_kind: "interim",
    coalesce_key: "segment-b",
    revision: "1",
    reason: null,
    replaces_item_id: null,
    successor: null,
  }),
  Object.freeze({
    action: "cancel",
    item_id: "interim-c-r1",
    item_kind: "interim",
    coalesce_key: "segment-c",
    revision: "1",
    reason: "explicit_cancel",
    replaces_item_id: null,
    successor: null,
  }),
  Object.freeze({
    action: "drop",
    item_id: "interim-d-r1",
    item_kind: "interim",
    coalesce_key: "segment-d",
    revision: "1",
    reason: "superseded_revision",
    replaces_item_id: null,
    successor: Object.freeze({
      coalesce_key: "segment-d",
      item_id: "interim-d-r2",
      item_kind: "interim",
      revision: "2",
    }),
  }),
  Object.freeze({
    action: "retry_attempt",
    item_id: "interim-a-r2",
    item_kind: "interim",
    coalesce_key: "segment-a",
    revision: "2",
    reason: "explicit_harness_retry",
    replaces_item_id: null,
    successor: null,
  }),
  Object.freeze({
    action: "dequeue",
    item_id: "interim-a-r2",
    item_kind: "interim",
    coalesce_key: "segment-a",
    revision: "2",
    reason: null,
    replaces_item_id: null,
    successor: null,
  }),
]);

function assertExactKeys(value, expected, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    throw new Error(`${label} keys differ: ${actual.join(",")}`);
  }
}

function assertCanonicalU64(value, label) {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`${label} must be a canonical uint64 string`);
  }
  if (BigInt(value) > MAX_U64) {
    throw new Error(`${label} exceeds uint64`);
  }
}

function toCanonicalU64(value, label) {
  let converted;
  if (typeof value === "bigint") {
    converted = value;
  } else if (Number.isSafeInteger(value) && value >= 0) {
    converted = BigInt(value);
  } else {
    throw new Error(`${label} must be a non-negative safe integer or bigint`);
  }
  if (converted > MAX_U64) {
    throw new Error(`${label} exceeds uint64`);
  }
  return converted.toString();
}

function assertSha256(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
}

function buildEvidence() {
  return {
    candidate_id: null,
    metric_id: null,
    production_evidence: false,
    slo_claims: [],
    stage: "wp0.3_harness_self_test",
  };
}

function validateEvidence(evidence, label) {
  assertExactKeys(evidence, EVIDENCE_KEYS, label);
  if (
    evidence.candidate_id !== null ||
    evidence.metric_id !== null ||
    evidence.production_evidence !== false ||
    !Array.isArray(evidence.slo_claims) ||
    evidence.slo_claims.length !== 0 ||
    evidence.stage !== "wp0.3_harness_self_test"
  ) {
    throw new Error(`${label} contains a metric, SLO, candidate, or production claim`);
  }
}

function assertSamplingParameters(sampleCount, capacity, high, low) {
  if (!Number.isInteger(sampleCount) || sampleCount <= 0 || sampleCount > 10_000) {
    throw new Error("resource_sample_count must be an integer between 1 and 10000");
  }
  if (!Number.isInteger(capacity) || capacity <= 0 || capacity > 1_024) {
    throw new Error("queue capacity must be an integer between 1 and 1024");
  }
  if (!Number.isInteger(high) || high <= 0 || high > capacity) {
    throw new Error("high watermark must be positive and no greater than capacity");
  }
  if (!Number.isInteger(low) || low < 0 || low >= high) {
    throw new Error("low watermark must be non-negative and lower than high watermark");
  }
}

export function buildSamplingContract({
  resourceSampleCount = DEFAULT_RESOURCE_SAMPLE_COUNT,
  queueCapacity = 4,
  queueHighWatermark = 3,
  queueLowWatermark = 1,
} = {}) {
  assertSamplingParameters(
    resourceSampleCount,
    queueCapacity,
    queueHighWatermark,
    queueLowWatermark,
  );
  if (
    queueCapacity !== 4 ||
    queueHighWatermark !== 3 ||
    queueLowWatermark !== 1
  ) {
    throw new Error("Q-HARNESS-COALESCE capacity and watermarks are fixed at 4/3/1");
  }
  return {
    schema_version: "1.0",
    algorithm_version: "meetingrelay.queue-resource-harness.v1",
    test_id: "CT-RESOURCE-HARNESS-001",
    queue: {
      queue_id: "Q-HARNESS-COALESCE",
      queue_kind: "synthetic_harness_only",
      item_schema: "meetingrelay.harness.queue-item.v1",
      capacity: String(queueCapacity),
      high_watermark: String(queueHighWatermark),
      low_watermark: String(queueLowWatermark),
      clock_domain_id: FIXTURE_LOGICAL_CLOCK_DOMAIN_ID,
      conservation_formula:
        "enqueue_total=dequeue_total+drop_total+merge_total+cancel_total+depth",
      attempt_counters_excluded_from_conservation: ["full_total", "retry_total"],
      allowed_reasons: {
        cancel: ["explicit_cancel"],
        drop: ["superseded_revision"],
        full: ["capacity_reached"],
        merge: ["superseded_revision"],
        retry: ["explicit_harness_retry"],
      },
      production_queue: false,
    },
    resources: {
      sample_count: String(resourceSampleCount),
      observation_source: NODE_HRTIME_SOURCE,
      clock_domain_template: "node.hrtime.<run_id>",
      sampling_mode: "back_to_back_no_timer",
      measurement_scope: "collector-call-only",
      logical_cpu_index_semantics:
        "snapshot-order-only-no-cross-sample-identity",
      supported_metrics: [
        "logical_cpu_times_ms",
        "process_cpu_microseconds",
        "process_memory_bytes",
        "system_memory_bytes",
      ],
      unsupported_metrics: [...UNSUPPORTED_KEYS],
    },
    collection_semantics: {
      cadence_claim: "none",
      cross_domain_subtraction: "forbidden",
      network_used: false,
      real_timer_used: false,
      runtime_artifact_equality: "not-required",
      wall_clock_used: false,
    },
    formal_claims: "none",
    evidence: buildEvidence(),
  };
}

function validateSamplingContract(contract) {
  assertExactKeys(
    contract,
    [
      "algorithm_version",
      "collection_semantics",
      "evidence",
      "formal_claims",
      "queue",
      "resources",
      "schema_version",
      "test_id",
    ],
    "sampling contract",
  );
  assertExactKeys(
    contract.queue,
    [
      "allowed_reasons",
      "attempt_counters_excluded_from_conservation",
      "capacity",
      "clock_domain_id",
      "conservation_formula",
      "high_watermark",
      "item_schema",
      "low_watermark",
      "production_queue",
      "queue_id",
      "queue_kind",
    ],
    "sampling contract.queue",
  );
  assertExactKeys(
    contract.resources,
    [
      "clock_domain_template",
      "logical_cpu_index_semantics",
      "measurement_scope",
      "observation_source",
      "sample_count",
      "sampling_mode",
      "supported_metrics",
      "unsupported_metrics",
    ],
    "sampling contract.resources",
  );
  assertExactKeys(
    contract.collection_semantics,
    [
      "cadence_claim",
      "cross_domain_subtraction",
      "network_used",
      "real_timer_used",
      "runtime_artifact_equality",
      "wall_clock_used",
    ],
    "sampling contract.collection_semantics",
  );
  validateEvidence(contract.evidence, "sampling contract.evidence");
  for (const [field, value] of [
    ["queue.capacity", contract.queue.capacity],
    ["queue.high_watermark", contract.queue.high_watermark],
    ["queue.low_watermark", contract.queue.low_watermark],
    ["resources.sample_count", contract.resources.sample_count],
  ]) {
    assertCanonicalU64(value, `sampling contract.${field}`);
  }
  assertSamplingParameters(
    Number(contract.resources.sample_count),
    Number(contract.queue.capacity),
    Number(contract.queue.high_watermark),
    Number(contract.queue.low_watermark),
  );
  const expected = buildSamplingContract({
    resourceSampleCount: Number(contract.resources.sample_count),
  });
  if (encodeCanonicalJson(contract) !== encodeCanonicalJson(expected)) {
    throw new Error("sampling contract differs from the WP-0.3.6 boundary");
  }
}

function queueCounters(state) {
  return {
    cancel_total: String(state.cancelTotal),
    dequeue_total: String(state.dequeueTotal),
    depth: String(state.items.size),
    drop_total: String(state.dropTotal),
    enqueue_total: String(state.enqueueTotal),
    full_total: String(state.fullTotal),
    high_water_depth: String(state.highWaterDepth),
    merge_total: String(state.mergeTotal),
    retry_total: String(state.retryTotal),
  };
}

function cloneQueueOperation(operation) {
  return {
    ...operation,
    successor:
      operation.successor === null ? null : { ...operation.successor },
  };
}

function applyQueueOperation(state, operation, capacity, logicalNs) {
  const current = state.items.get(operation.item_id);
  switch (operation.action) {
    case "enqueue":
      if (state.items.size >= capacity || current) {
        throw new Error("scripted enqueue violates capacity or identity");
      }
      state.items.set(operation.item_id, {
        ...operation,
        enqueued_ns: logicalNs,
      });
      state.enqueueTotal += 1;
      break;
    case "full_attempt":
      if (state.items.size !== capacity || operation.reason !== "capacity_reached") {
        throw new Error("full attempt must observe an already-full queue");
      }
      state.fullTotal += 1;
      break;
    case "merge": {
      const replaced = state.items.get(operation.replaces_item_id);
      if (
        operation.reason !== "superseded_revision" ||
        operation.item_kind !== "interim" ||
        !replaced ||
        replaced.item_kind !== "interim" ||
        replaced.coalesce_key !== operation.coalesce_key ||
        BigInt(operation.revision) <= BigInt(replaced.revision)
      ) {
        throw new Error("merge must replace an older interim revision of the same key");
      }
      state.items.delete(operation.replaces_item_id);
      state.items.set(operation.item_id, {
        ...operation,
        enqueued_ns: logicalNs,
      });
      state.enqueueTotal += 1;
      state.mergeTotal += 1;
      break;
    }
    case "dequeue":
      if (!current) throw new Error("dequeue target is not queued");
      state.items.delete(operation.item_id);
      state.dequeueTotal += 1;
      break;
    case "cancel":
      if (!current || operation.reason !== "explicit_cancel") {
        throw new Error("cancel target or reason differs");
      }
      state.items.delete(operation.item_id);
      state.cancelTotal += 1;
      break;
    case "drop":
      if (
        !current ||
        current.item_kind !== "interim" ||
        operation.reason !== "superseded_revision" ||
        operation.successor === null ||
        operation.successor.item_kind !== "interim" ||
        operation.successor.coalesce_key !== current.coalesce_key ||
        BigInt(operation.successor.revision) <= BigInt(current.revision)
      ) {
        throw new Error("drop target or reason differs");
      }
      state.items.delete(operation.item_id);
      state.dropTotal += 1;
      break;
    case "retry_attempt":
      if (!current || operation.reason !== "explicit_harness_retry") {
        throw new Error("retry target or reason differs");
      }
      state.retryTotal += 1;
      break;
    default:
      throw new Error(`unsupported queue action: ${operation.action}`);
  }
  state.highWaterDepth = Math.max(state.highWaterDepth, state.items.size);
}

export function runDeterministicQueueScenario(
  contract = buildSamplingContract(),
) {
  validateSamplingContract(contract);
  const capacity = Number(contract.queue.capacity);
  const state = {
    items: new Map(),
    enqueueTotal: 0,
    dequeueTotal: 0,
    dropTotal: 0,
    mergeTotal: 0,
    cancelTotal: 0,
    retryTotal: 0,
    fullTotal: 0,
    highWaterDepth: 0,
  };
  return QUEUE_SCRIPT.map((operation, index) => {
    const logicalNs = BigInt(index) * 1_000_000n;
    applyQueueOperation(state, operation, capacity, logicalNs);
    const counters = queueCounters(state);
    const conserved =
      BigInt(counters.dequeue_total) +
      BigInt(counters.drop_total) +
      BigInt(counters.merge_total) +
      BigInt(counters.cancel_total) +
      BigInt(counters.depth);
    const oldest = [...state.items.values()].reduce(
      (value, item) =>
        value === null || item.enqueued_ns < value ? item.enqueued_ns : value,
      null,
    );
    return {
      schema_version: "1.0",
      record_type: "queue.sample",
      queue_id: contract.queue.queue_id,
      sample_sequence: String(index + 1),
      logical_monotonic_ns: logicalNs.toString(),
      clock_domain_id: contract.queue.clock_domain_id,
      operation: cloneQueueOperation(operation),
      capacity: contract.queue.capacity,
      high_watermark: contract.queue.high_watermark,
      low_watermark: contract.queue.low_watermark,
      ...counters,
      oldest_item_age_ns:
        oldest === null ? "0" : (logicalNs - oldest).toString(),
      active_workers: "1",
      pending_workers: "0",
      conservation_delta: (BigInt(counters.enqueue_total) - conserved).toString(),
      formal_claims: "none",
      evidence: buildEvidence(),
    };
  });
}

function canonicalJsonLines(records) {
  return Buffer.from(records.map(encodeCanonicalJsonLine).join(""), "utf8");
}

function runtimeDescriptor() {
  return {
    arch: process.arch,
    node_version: process.version,
    platform: process.platform,
    uv_version: process.versions.uv,
  };
}

function validateRuntimeDescriptor(runtime, label) {
  assertExactKeys(
    runtime,
    ["arch", "node_version", "platform", "uv_version"],
    label,
  );
  if (runtime.platform !== "win32" || runtime.arch !== "x64") {
    throw new Error(`${label} must describe the Windows x64 target`);
  }
  for (const [field, pattern] of [
    ["node_version", /^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/],
    ["uv_version", /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/],
  ]) {
    const value = runtime[field];
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.length > 64 ||
      value !== value.normalize("NFC") ||
      !pattern.test(value)
    ) {
      throw new Error(`${label}.${field} must be a safe semantic version string`);
    }
  }
}

function unsupportedMetric(reason) {
  return {
    availability: "unavailable",
    reason,
    status: "unsupported",
    value: null,
  };
}

function unsupportedMetrics() {
  const reasons = {
    cpu_nice_ms: "windows-nice-counter-is-not-an-observation",
    disk_latency_ns: "node-api-does-not-expose-disk-latency",
    disk_queue_depth: "node-api-does-not-expose-disk-queue-depth",
    gpu_compute_percent: "node-api-does-not-expose-gpu-compute",
    gpu_copy_percent: "node-api-does-not-expose-gpu-copy",
    gpu_power_watts: "node-api-does-not-expose-gpu-power",
    gpu_temperature_c: "node-api-does-not-expose-gpu-temperature",
    gpu_vram_bytes: "node-api-does-not-expose-vram",
    involuntary_context_switches: "node-resource-usage-unsupported-on-windows",
    load_average_15m: "windows-load-average-is-not-supported",
    load_average_1m: "windows-load-average-is-not-supported",
    load_average_5m: "windows-load-average-is-not-supported",
    major_page_faults: "node-resource-usage-unsupported-on-windows",
    network_bytes: "node-api-does-not-expose-process-network-counters",
    process_commit_bytes: "node-api-does-not-expose-windows-commit-bytes",
    process_handle_count: "node-api-does-not-expose-windows-handle-count",
    process_private_bytes: "node-api-does-not-expose-windows-private-bytes",
    process_thread_count: "node-api-does-not-expose-process-thread-count",
    voluntary_context_switches: "node-resource-usage-unsupported-on-windows",
  };
  return Object.fromEntries(
    UNSUPPORTED_KEYS.map((key) => [key, unsupportedMetric(reasons[key])]),
  );
}

export function readNodeResourceSnapshot() {
  const cpu = process.cpuUsage();
  const memory = process.memoryUsage();
  return {
    process_cpu: {
      system_microseconds: cpu.system,
      user_microseconds: cpu.user,
    },
    process_memory: {
      array_buffers_bytes: memory.arrayBuffers,
      external_bytes: memory.external,
      heap_total_bytes: memory.heapTotal,
      heap_used_bytes: memory.heapUsed,
      rss_bytes: memory.rss,
    },
    system_memory: {
      free_bytes: os.freemem(),
      total_bytes: os.totalmem(),
    },
    logical_cpu_times: os.cpus().map((cpuInfo) => ({
      idle_ms: cpuInfo.times.idle,
      irq_ms: cpuInfo.times.irq,
      system_ms: cpuInfo.times.sys,
      user_ms: cpuInfo.times.user,
    })),
  };
}

function normalizeResourceSnapshot(snapshot) {
  assertExactKeys(
    snapshot,
    ["logical_cpu_times", "process_cpu", "process_memory", "system_memory"],
    "resource snapshot",
  );
  assertExactKeys(
    snapshot.process_cpu,
    ["system_microseconds", "user_microseconds"],
    "resource snapshot.process_cpu",
  );
  assertExactKeys(
    snapshot.process_memory,
    [
      "array_buffers_bytes",
      "external_bytes",
      "heap_total_bytes",
      "heap_used_bytes",
      "rss_bytes",
    ],
    "resource snapshot.process_memory",
  );
  assertExactKeys(
    snapshot.system_memory,
    ["free_bytes", "total_bytes"],
    "resource snapshot.system_memory",
  );
  if (!Array.isArray(snapshot.logical_cpu_times) || snapshot.logical_cpu_times.length === 0) {
    throw new Error("resource snapshot.logical_cpu_times must contain at least one core");
  }
  return {
    process_cpu: {
      status: "available",
      unit: "microseconds_cumulative",
      system_microseconds: toCanonicalU64(
        snapshot.process_cpu.system_microseconds,
        "process CPU system",
      ),
      user_microseconds: toCanonicalU64(
        snapshot.process_cpu.user_microseconds,
        "process CPU user",
      ),
    },
    process_memory: {
      status: "available",
      unit: "bytes",
      array_buffers_bytes: toCanonicalU64(
        snapshot.process_memory.array_buffers_bytes,
        "process memory array buffers",
      ),
      external_bytes: toCanonicalU64(
        snapshot.process_memory.external_bytes,
        "process memory external",
      ),
      heap_total_bytes: toCanonicalU64(
        snapshot.process_memory.heap_total_bytes,
        "process memory heap total",
      ),
      heap_used_bytes: toCanonicalU64(
        snapshot.process_memory.heap_used_bytes,
        "process memory heap used",
      ),
      rss_bytes: toCanonicalU64(
        snapshot.process_memory.rss_bytes,
        "process memory RSS",
      ),
    },
    system_memory: {
      status: "available",
      unit: "bytes",
      free_bytes: toCanonicalU64(
        snapshot.system_memory.free_bytes,
        "system free memory",
      ),
      total_bytes: toCanonicalU64(
        snapshot.system_memory.total_bytes,
        "system total memory",
      ),
    },
    logical_cpu_times: {
      status: "available",
      unit: "milliseconds_cumulative",
      core_count: String(snapshot.logical_cpu_times.length),
      cores: snapshot.logical_cpu_times.map((core, index) => {
        assertExactKeys(
          core,
          ["idle_ms", "irq_ms", "system_ms", "user_ms"],
          `resource snapshot.logical_cpu_times[${index}]`,
        );
        return {
          core_index: String(index),
          idle_ms: toCanonicalU64(core.idle_ms, `CPU ${index} idle`),
          irq_ms: toCanonicalU64(core.irq_ms, `CPU ${index} irq`),
          system_ms: toCanonicalU64(core.system_ms, `CPU ${index} system`),
          user_ms: toCanonicalU64(core.user_ms, `CPU ${index} user`),
        };
      }),
    },
    unsupported: unsupportedMetrics(),
  };
}

export function collectResourceSeries({
  runId,
  sampleCount = DEFAULT_RESOURCE_SAMPLE_COUNT,
  monotonicNow = () => process.hrtime.bigint(),
  resourceReader = readNodeResourceSnapshot,
  runtime = runtimeDescriptor(),
} = {}) {
  assertSafeRunId(runId);
  if (!Number.isInteger(sampleCount) || sampleCount <= 0 || sampleCount > 10_000) {
    throw new Error("sampleCount must be an integer between 1 and 10000");
  }
  if (typeof monotonicNow !== "function" || typeof resourceReader !== "function") {
    throw new Error("resource collector requires callable clock and reader functions");
  }
  validateRuntimeDescriptor(runtime, "runtime descriptor");
  let previousEnd = null;
  return Array.from({ length: sampleCount }, (_, index) => {
    const start = monotonicNow();
    const metrics = normalizeResourceSnapshot(resourceReader());
    const end = monotonicNow();
    if (
      typeof start !== "bigint" ||
      typeof end !== "bigint" ||
      end < start ||
      (previousEnd !== null && start < previousEnd)
    ) {
      throw new Error("resource observation clock regressed or returned a non-bigint");
    }
    previousEnd = end;
    return {
      schema_version: "1.0",
      record_type: "resource.sample",
      run_id: runId,
      sample_sequence: String(index + 1),
      clock_domain_id: observationClockDomainId(runId),
      observation_source: NODE_HRTIME_SOURCE,
      observed_start_ns: start.toString(),
      observed_end_ns: end.toString(),
      sample_overhead_ns: (end - start).toString(),
      runtime,
      metrics,
      formal_claims: "none",
      evidence: buildEvidence(),
    };
  });
}

function stableResourceProjection(record) {
  return {
    schema_version: record.schema_version,
    record_type: record.record_type,
    observation_source: record.observation_source,
    runtime: record.runtime,
    supported: {
      logical_cpu_times: {
        core_count: record.metrics.logical_cpu_times.core_count,
        status: record.metrics.logical_cpu_times.status,
        unit: record.metrics.logical_cpu_times.unit,
      },
      process_cpu: {
        status: record.metrics.process_cpu.status,
        unit: record.metrics.process_cpu.unit,
      },
      process_memory: {
        status: record.metrics.process_memory.status,
        unit: record.metrics.process_memory.unit,
      },
      system_memory: {
        status: record.metrics.system_memory.status,
        unit: record.metrics.system_memory.unit,
      },
    },
    unsupported: record.metrics.unsupported,
    evidence: record.evidence,
    formal_claims: record.formal_claims,
  };
}

function queueFinal(records) {
  const last = records.at(-1);
  return {
    cancel_total: last.cancel_total,
    dequeue_total: last.dequeue_total,
    depth: last.depth,
    drop_total: last.drop_total,
    enqueue_total: last.enqueue_total,
    full_total: last.full_total,
    high_water_depth: last.high_water_depth,
    merge_total: last.merge_total,
    retry_total: last.retry_total,
  };
}

function buildRunSummary(contractBytes, queueBytes, resourceBytes, queueRecords, resourceRecords) {
  const first = resourceRecords[0];
  const projectionBytes = Buffer.from(
    encodeCanonicalJson(stableResourceProjection(first)),
    "utf8",
  );
  return {
    schema_version: "1.0",
    test_id: "CT-RESOURCE-HARNESS-001",
    run_id: first.run_id,
    clock_domain_id: first.clock_domain_id,
    contract_sha256: sha256(contractBytes),
    queue_samples_sha256: sha256(queueBytes),
    resource_samples_sha256: sha256(resourceBytes),
    queue_sample_count: String(queueRecords.length),
    resource_sample_count: String(resourceRecords.length),
    queue_final: queueFinal(queueRecords),
    resource_capability_projection_sha256: sha256(projectionBytes),
    runtime_artifact_equality: "not-required",
    formal_claims: "none",
    evidence: buildEvidence(),
  };
}

async function ensureEmptyDirectory(root) {
  await mkdir(root, { recursive: true });
  const metadata = await lstat(root);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`output root must be a real directory: ${root}`);
  }
  const entries = await readdir(root);
  if (entries.length !== 0) {
    throw new Error(`output directory must be empty: ${root}`);
  }
}

async function assertInventory(root, expected, label) {
  const rootMetadata = await lstat(root);
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new Error(`${label} root must be a real directory`);
  }
  const entries = await readdir(root, { withFileTypes: true });
  const names = entries.map((entry) => entry.name).sort();
  const wanted = [...expected].sort();
  if (
    names.length !== wanted.length ||
    names.some((name, index) => name !== wanted[index])
  ) {
    throw new Error(`${label} inventory differs: ${names.join(",")}`);
  }
  for (const entry of entries) {
    const metadata = await lstat(path.join(root, entry.name));
    if (metadata.isSymbolicLink()) {
      throw new Error(`${label} contains a symbolic link or reparse entry: ${entry.name}`);
    }
  }
  return entries;
}

function parseCanonicalJsonLines(bytes, label) {
  const text = bytes.toString("utf8");
  if (!text.endsWith("\n") || text.includes("\r") || text.startsWith("\uFEFF")) {
    throw new Error(`${label} must be LF-terminated canonical JSONL`);
  }
  const lines = text.slice(0, -1).split("\n");
  if (lines.some((line) => line.length === 0)) {
    throw new Error(`${label} contains an empty line`);
  }
  return lines.map((line, index) => {
    const value = JSON.parse(line);
    if (encodeCanonicalJsonLine(value) !== `${line}\n`) {
      throw new Error(`${label} line ${index + 1} is not canonical JSONL`);
    }
    return value;
  });
}

function parseCanonicalJson(bytes, label) {
  const value = JSON.parse(bytes.toString("utf8"));
  if (!Buffer.from(encodeCanonicalJson(value), "utf8").equals(bytes)) {
    throw new Error(`${label} is not canonical JSON`);
  }
  return value;
}

function validateQueueRecords(records, contract) {
  const expected = runDeterministicQueueScenario(contract);
  if (encodeCanonicalJson(expected) !== encodeCanonicalJson(records)) {
    throw new Error("queue records differ from the recomputed deterministic scenario");
  }
  for (const [index, record] of records.entries()) {
    for (const field of [
      "active_workers",
      "cancel_total",
      "capacity",
      "conservation_delta",
      "dequeue_total",
      "depth",
      "drop_total",
      "enqueue_total",
      "full_total",
      "high_water_depth",
      "high_watermark",
      "logical_monotonic_ns",
      "low_watermark",
      "merge_total",
      "oldest_item_age_ns",
      "pending_workers",
      "retry_total",
      "sample_sequence",
    ]) {
      assertCanonicalU64(record[field], `queue record ${index + 1}.${field}`);
    }
    if (record.conservation_delta !== "0") {
      throw new Error(`queue record ${index + 1} violates conservation`);
    }
    validateEvidence(record.evidence, `queue record ${index + 1}.evidence`);
  }
}

function validateUnsupportedMetrics(value, label) {
  assertExactKeys(value, UNSUPPORTED_KEYS, label);
  const expected = unsupportedMetrics();
  if (encodeCanonicalJson(value) !== encodeCanonicalJson(expected)) {
    throw new Error(`${label} must preserve null unsupported capability states`);
  }
}

function validateResourceRecords(records, contract) {
  if (records.length !== Number(contract.resources.sample_count)) {
    throw new Error("resource sample count differs from the contract");
  }
  let previousEnd = null;
  let previousProcessCpu = null;
  let logicalCoreCount = null;
  let projection = null;
  let runId = null;
  let clockDomainId = null;
  for (const [index, record] of records.entries()) {
    assertExactKeys(
      record,
      [
        "clock_domain_id",
        "evidence",
        "formal_claims",
        "metrics",
        "observation_source",
        "observed_end_ns",
        "observed_start_ns",
        "record_type",
        "run_id",
        "runtime",
        "sample_overhead_ns",
        "sample_sequence",
        "schema_version",
      ],
      `resource record ${index + 1}`,
    );
    assertSafeRunId(record.run_id);
    for (const field of [
      "observed_end_ns",
      "observed_start_ns",
      "sample_overhead_ns",
      "sample_sequence",
    ]) {
      assertCanonicalU64(record[field], `resource record ${index + 1}.${field}`);
    }
    if (
      record.schema_version !== "1.0" ||
      record.record_type !== "resource.sample" ||
      record.sample_sequence !== String(index + 1) ||
      record.clock_domain_id !== observationClockDomainId(record.run_id) ||
      record.observation_source !== NODE_HRTIME_SOURCE ||
      record.formal_claims !== "none"
    ) {
      throw new Error(`resource record ${index + 1} identity differs`);
    }
    if (runId === null) {
      runId = record.run_id;
      clockDomainId = record.clock_domain_id;
    } else if (
      record.run_id !== runId ||
      record.clock_domain_id !== clockDomainId
    ) {
      throw new Error(`resource record ${index + 1} changed run or clock domain`);
    }
    const start = BigInt(record.observed_start_ns);
    const end = BigInt(record.observed_end_ns);
    if (end < start || BigInt(record.sample_overhead_ns) !== end - start) {
      throw new Error(`resource record ${index + 1} clock interval differs`);
    }
    if (previousEnd !== null && start < previousEnd) {
      throw new Error(`resource record ${index + 1} clock domain regressed`);
    }
    previousEnd = end;
    validateRuntimeDescriptor(
      record.runtime,
      `resource record ${index + 1}.runtime`,
    );
    assertExactKeys(
      record.metrics,
      [
        "logical_cpu_times",
        "process_cpu",
        "process_memory",
        "system_memory",
        "unsupported",
      ],
      `resource record ${index + 1}.metrics`,
    );
    const snapshot = record.metrics;
    for (const [group, fields, exactKeys] of [
      [
        "process_cpu",
        ["system_microseconds", "user_microseconds"],
        ["status", "system_microseconds", "unit", "user_microseconds"],
      ],
      [
        "process_memory",
        [
          "array_buffers_bytes",
          "external_bytes",
          "heap_total_bytes",
          "heap_used_bytes",
          "rss_bytes",
        ],
        [
          "array_buffers_bytes",
          "external_bytes",
          "heap_total_bytes",
          "heap_used_bytes",
          "rss_bytes",
          "status",
          "unit",
        ],
      ],
      [
        "system_memory",
        ["free_bytes", "total_bytes"],
        ["free_bytes", "status", "total_bytes", "unit"],
      ],
    ]) {
      assertExactKeys(
        snapshot[group],
        exactKeys,
        `resource record ${index + 1}.metrics.${group}`,
      );
      if (snapshot[group].status !== "available") {
        throw new Error(`${group} must be available`);
      }
      for (const field of fields) {
        assertCanonicalU64(snapshot[group][field], `${group}.${field}`);
      }
    }
    if (
      snapshot.process_cpu.unit !== "microseconds_cumulative" ||
      snapshot.process_memory.unit !== "bytes" ||
      snapshot.system_memory.unit !== "bytes"
    ) {
      throw new Error("resource metric units differ");
    }
    if (
      BigInt(snapshot.system_memory.free_bytes) >
      BigInt(snapshot.system_memory.total_bytes)
    ) {
      throw new Error("free system memory exceeds total memory");
    }
    if (previousProcessCpu) {
      for (const field of ["system_microseconds", "user_microseconds"]) {
        if (BigInt(snapshot.process_cpu[field]) < BigInt(previousProcessCpu[field])) {
          throw new Error(`process CPU ${field} regressed`);
        }
      }
    }
    previousProcessCpu = snapshot.process_cpu;
    const logical = snapshot.logical_cpu_times;
    assertExactKeys(
      logical,
      ["core_count", "cores", "status", "unit"],
      `resource record ${index + 1}.metrics.logical_cpu_times`,
    );
    if (
      logical.status !== "available" ||
      logical.unit !== "milliseconds_cumulative" ||
      !Array.isArray(logical.cores) ||
      logical.core_count !== String(logical.cores.length) ||
      logical.cores.length === 0
    ) {
      throw new Error("logical CPU capability differs");
    }
    if (
      logicalCoreCount !== null &&
      logicalCoreCount !== logical.cores.length
    ) {
      throw new Error("logical CPU core count changed within a run");
    }
    for (const [coreIndex, core] of logical.cores.entries()) {
      assertExactKeys(
        core,
        ["core_index", "idle_ms", "irq_ms", "system_ms", "user_ms"],
        `logical CPU ${coreIndex}`,
      );
      if (core.core_index !== String(coreIndex)) {
        throw new Error(`logical CPU ${coreIndex} index differs`);
      }
      for (const field of ["idle_ms", "irq_ms", "system_ms", "user_ms"]) {
        assertCanonicalU64(core[field], `logical CPU ${coreIndex}.${field}`);
      }
    }
    logicalCoreCount = logical.cores.length;
    validateUnsupportedMetrics(
      snapshot.unsupported,
      `resource record ${index + 1}.metrics.unsupported`,
    );
    validateEvidence(record.evidence, `resource record ${index + 1}.evidence`);
    const currentProjection = stableResourceProjection(record);
    if (
      projection !== null &&
      encodeCanonicalJson(projection) !== encodeCanonicalJson(currentProjection)
    ) {
      throw new Error("resource capability projection changed within a run");
    }
    projection = currentProjection;
  }
  return projection;
}

export async function createQueueResourceRun(
  root,
  {
    runId,
    contract = buildSamplingContract(),
    monotonicNow,
    resourceReader,
    runtime,
  } = {},
) {
  validateSamplingContract(contract);
  assertSafeRunId(runId);
  const resolvedRoot = path.resolve(root);
  await ensureEmptyDirectory(resolvedRoot);
  const contractBytes = Buffer.from(encodeCanonicalJson(contract), "utf8");
  const queueRecords = runDeterministicQueueScenario(contract);
  const resourceRecords = collectResourceSeries({
    runId,
    sampleCount: Number(contract.resources.sample_count),
    monotonicNow,
    resourceReader,
    runtime,
  });
  const queueBytes = canonicalJsonLines(queueRecords);
  const resourceBytes = canonicalJsonLines(resourceRecords);
  const summary = buildRunSummary(
    contractBytes,
    queueBytes,
    resourceBytes,
    queueRecords,
    resourceRecords,
  );
  await writeFile(path.join(resolvedRoot, "queue-samples.jsonl"), queueBytes);
  await writeFile(path.join(resolvedRoot, "resource-samples.jsonl"), resourceBytes);
  await writeFile(
    path.join(resolvedRoot, "run-summary.json"),
    encodeCanonicalJson(summary),
    "utf8",
  );
  return validateQueueResourceRun(resolvedRoot, contract);
}

export async function validateQueueResourceRun(root, contract) {
  validateSamplingContract(contract);
  const resolvedRoot = path.resolve(root);
  const entries = await assertInventory(resolvedRoot, RUN_FILES, "resource run");
  if (entries.some((entry) => !entry.isFile())) {
    throw new Error("resource run entries must all be regular files");
  }
  const [queueBytes, resourceBytes, summaryBytes] = await Promise.all([
    readFile(path.join(resolvedRoot, "queue-samples.jsonl")),
    readFile(path.join(resolvedRoot, "resource-samples.jsonl")),
    readFile(path.join(resolvedRoot, "run-summary.json")),
  ]);
  const queueRecords = parseCanonicalJsonLines(queueBytes, "queue samples");
  const resourceRecords = parseCanonicalJsonLines(resourceBytes, "resource samples");
  const summary = parseCanonicalJson(summaryBytes, "run summary");
  validateQueueRecords(queueRecords, contract);
  const projection = validateResourceRecords(resourceRecords, contract);
  const contractBytes = Buffer.from(encodeCanonicalJson(contract), "utf8");
  const expectedSummary = buildRunSummary(
    contractBytes,
    queueBytes,
    resourceBytes,
    queueRecords,
    resourceRecords,
  );
  if (encodeCanonicalJson(summary) !== encodeCanonicalJson(expectedSummary)) {
    throw new Error("run summary differs from recomputed raw artifacts");
  }
  for (const field of [
    "contract_sha256",
    "queue_samples_sha256",
    "resource_capability_projection_sha256",
    "resource_samples_sha256",
  ]) {
    assertSha256(summary[field], `run summary.${field}`);
  }
  validateEvidence(summary.evidence, "run summary.evidence");
  return {
    runId: summary.run_id,
    clockDomainId: summary.clock_domain_id,
    queueBytes,
    queueSha256: summary.queue_samples_sha256,
    resourceBytes,
    resourceSha256: summary.resource_samples_sha256,
    summaryBytes,
    summarySha256: sha256(summaryBytes),
    projection,
    projectionSha256: summary.resource_capability_projection_sha256,
    summary,
  };
}

function buildComparison(contractBytes, runA, runB) {
  if (!runA.queueBytes.equals(runB.queueBytes) || runA.queueSha256 !== runB.queueSha256) {
    throw new Error("deterministic queue artifacts differ across runs");
  }
  if (runA.clockDomainId === runB.clockDomainId) {
    throw new Error("resource runs must use distinct clock domains");
  }
  if (
    encodeCanonicalJson(runA.projection) !== encodeCanonicalJson(runB.projection) ||
    runA.projectionSha256 !== runB.projectionSha256
  ) {
    throw new Error("resource capability projections differ across runs");
  }
  return {
    schema_version: "1.0",
    test_id: "CT-RESOURCE-HARNESS-001",
    contract_sha256: sha256(contractBytes),
    queue_artifacts: {
      comparison: "byte-and-sha256-equal",
      sha256: runA.queueSha256,
    },
    resource_artifacts: {
      comparison: "runtime-validation-only",
      runtime_artifact_equality: "not-required",
      run_a_sha256: runA.resourceSha256,
      run_b_sha256: runB.resourceSha256,
      stable_capability_projection: "sha256-equal",
      projection_sha256: runA.projectionSha256,
    },
    run_a: {
      clock_domain_id: runA.clockDomainId,
      run_id: runA.runId,
      summary_sha256: runA.summarySha256,
    },
    run_b: {
      clock_domain_id: runB.clockDomainId,
      run_id: runB.runId,
      summary_sha256: runB.summarySha256,
    },
    cross_domain_subtraction: "forbidden",
    cadence_claim: "none",
    formal_claims: "none",
    evidence: buildEvidence(),
  };
}

export async function validateQueueResourceBundle(root) {
  const resolvedRoot = path.resolve(root);
  const entries = await assertInventory(resolvedRoot, BUNDLE_ENTRIES, "resource bundle");
  for (const entry of entries) {
    if (
      ((entry.name === "run-a" || entry.name === "run-b") && !entry.isDirectory()) ||
      (entry.name !== "run-a" && entry.name !== "run-b" && !entry.isFile())
    ) {
      throw new Error(`resource bundle entry type differs: ${entry.name}`);
    }
  }
  const contractBytes = await readFile(path.join(resolvedRoot, "sampling-contract.json"));
  const comparisonBytes = await readFile(path.join(resolvedRoot, "comparison.json"));
  const contract = parseCanonicalJson(contractBytes, "sampling contract");
  const comparison = parseCanonicalJson(comparisonBytes, "resource comparison");
  validateSamplingContract(contract);
  const [runA, runB] = await Promise.all([
    validateQueueResourceRun(path.join(resolvedRoot, "run-a"), contract),
    validateQueueResourceRun(path.join(resolvedRoot, "run-b"), contract),
  ]);
  const expected = buildComparison(contractBytes, runA, runB);
  if (encodeCanonicalJson(comparison) !== encodeCanonicalJson(expected)) {
    throw new Error("resource comparison differs from recomputed run artifacts");
  }
  validateEvidence(comparison.evidence, "resource comparison.evidence");
  return comparison;
}

export async function generateDoubleQueueResourceRun(
  outputRoot = DEFAULT_OUTPUT_ROOT,
  {
    contract = buildSamplingContract(),
    runA = {},
    runB = {},
  } = {},
) {
  validateSamplingContract(contract);
  const resolvedRoot = path.resolve(outputRoot);
  await ensureEmptyDirectory(resolvedRoot);
  const contractBytes = Buffer.from(encodeCanonicalJson(contract), "utf8");
  await writeFile(path.join(resolvedRoot, "sampling-contract.json"), contractBytes);
  const validatedA = await createQueueResourceRun(path.join(resolvedRoot, "run-a"), {
    ...runA,
    runId: runA.runId ?? "resource-a",
    contract,
  });
  const validatedB = await createQueueResourceRun(path.join(resolvedRoot, "run-b"), {
    ...runB,
    runId: runB.runId ?? "resource-b",
    contract,
  });
  const comparison = buildComparison(contractBytes, validatedA, validatedB);
  await writeFile(
    path.join(resolvedRoot, "comparison.json"),
    encodeCanonicalJson(comparison),
    "utf8",
  );
  return validateQueueResourceBundle(resolvedRoot);
}

export const queueResourcePaths = Object.freeze({
  defaultOutputRoot: DEFAULT_OUTPUT_ROOT,
  defaultResourceSampleCount: DEFAULT_RESOURCE_SAMPLE_COUNT,
  repositoryRoot: REPOSITORY_ROOT,
});
