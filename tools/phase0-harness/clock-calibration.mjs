import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  encodeCanonicalJson,
  encodeCanonicalJsonLine,
} from "./canonical-json.mjs";
import {
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
  "ct-clock-cal-001",
);
const DEFAULT_SAMPLE_PAIR_COUNT = 1_024;
const MAX_U64 = (1n << 64n) - 1n;
const SAMPLE_FILES = Object.freeze([
  "clock-calibration.json",
  "clock-samples.jsonl",
]);
const BUNDLE_ENTRIES = Object.freeze([
  "calibration-contract.json",
  "comparison.json",
  "run-a",
  "run-b",
]);
const SAMPLE_KEYS = Object.freeze([
  "clock_domain_id",
  "delta_ns",
  "end_ns",
  "run_id",
  "schema_version",
  "sequence",
  "source",
  "start_ns",
]);
const EVIDENCE_KEYS = Object.freeze([
  "candidate_id",
  "metric_id",
  "production_evidence",
  "slo_claims",
  "stage",
]);
const CONTRACT_KEYS = Object.freeze([
  "algorithm_version",
  "clock_domain_template",
  "cross_domain_subtraction",
  "evidence",
  "formal_claims",
  "measurement_overhead_scope",
  "percentile_method",
  "reference_error_semantics",
  "runtime_artifact_equality",
  "sample_pair_count",
  "schema_version",
  "source",
  "unit",
]);
const SUMMARY_KEYS = Object.freeze([
  "capability_gaps",
  "clock_domain_id",
  "contract_sha256",
  "evidence",
  "observed_quantization",
  "observed_resolution",
  "positive_delta_count",
  "read_overhead_ns",
  "reference_error",
  "run_id",
  "runtime",
  "sample_pair_count",
  "samples_sha256",
  "schema_version",
  "source",
  "status",
  "unit",
  "unsupported_reason",
  "zero_delta_count",
]);
const STATS_KEYS = Object.freeze(["max", "min", "p50", "p95"]);
const CAPABILITY_KEYS = Object.freeze(["reason", "status", "value_ns"]);
const RUNTIME_KEYS = Object.freeze([
  "arch",
  "node_version",
  "platform",
  "uv_version",
]);
const RUN_COMPARISON_KEYS = Object.freeze([
  "clock_domain_id",
  "samples_sha256",
  "status",
  "summary_sha256",
]);
const COMPARISON_KEYS = Object.freeze([
  "contract_sha256",
  "cross_domain_subtraction",
  "formal_claims",
  "run_a",
  "run_b",
  "runtime_artifact_equality",
  "schema_version",
]);
const DEFAULT_CLOCK_READ =
  typeof process.hrtime?.bigint === "function"
    ? () => process.hrtime.bigint()
    : null;

function assertExactKeys(value, expected, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
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

function assertSamplePairCount(value) {
  if (!Number.isInteger(value) || value <= 0 || value > 100_000) {
    throw new Error("sample_pair_count must be an integer between 1 and 100000");
  }
}

export function buildCalibrationContract(
  samplePairCount = DEFAULT_SAMPLE_PAIR_COUNT,
) {
  assertSamplePairCount(samplePairCount);
  return {
    schema_version: "1.0",
    algorithm_version: "meetingrelay.clock-read-pairs.v1",
    source: NODE_HRTIME_SOURCE,
    clock_domain_template: "node.hrtime.<run_id>",
    unit: "ns",
    sample_pair_count: String(samplePairCount),
    percentile_method: "nearest-rank",
    cross_domain_subtraction: "forbidden",
    runtime_artifact_equality: "not-required",
    measurement_overhead_scope: "clock-read-pair-only",
    reference_error_semantics: "no-independent-reference-bound",
    formal_claims: "none",
    evidence: buildEvidence(),
  };
}

function validateContract(contract) {
  assertExactKeys(contract, CONTRACT_KEYS, "calibration contract");
  validateEvidence(contract.evidence, "calibration contract.evidence");
  assertCanonicalU64(
    contract.sample_pair_count,
    "calibration contract.sample_pair_count",
  );
  if (
    contract.schema_version !== "1.0" ||
    contract.algorithm_version !== "meetingrelay.clock-read-pairs.v1" ||
    contract.source !== NODE_HRTIME_SOURCE ||
    contract.clock_domain_template !== "node.hrtime.<run_id>" ||
    contract.unit !== "ns" ||
    contract.percentile_method !== "nearest-rank" ||
    contract.cross_domain_subtraction !== "forbidden" ||
    contract.runtime_artifact_equality !== "not-required" ||
    contract.measurement_overhead_scope !== "clock-read-pair-only" ||
    contract.reference_error_semantics !== "no-independent-reference-bound" ||
    contract.formal_claims !== "none"
  ) {
    throw new Error("calibration contract differs from the WP-0.3.5 boundary");
  }
}

function runtimeDescriptor() {
  return {
    platform: process.platform,
    arch: process.arch,
    node_version: process.version,
    uv_version: process.versions.uv,
  };
}

function availableCapabilityGaps() {
  return [
    "cross-domain-mapping-not-established",
    "no-independent-reference-clock",
    "underlying-os-counter-not-introspected",
  ];
}

function unsupportedCapabilityGaps() {
  return ["clock-api-unavailable", ...availableCapabilityGaps()];
}

function nearestRank(sorted, percentile) {
  const index = Math.max(0, Math.ceil(percentile * sorted.length) - 1);
  return sorted[index];
}

function gcd(left, right) {
  let a = left;
  let b = right;
  while (b !== 0n) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a;
}

function deriveDiagnostics(deltas) {
  const sorted = [...deltas].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  const positive = sorted.filter((value) => value > 0n);
  const zeroCount = sorted.length - positive.length;
  const minimumPositive = positive.length === 0 ? null : positive[0];
  const observedGcd =
    positive.length === 0
      ? null
      : positive.slice(1).reduce((value, next) => gcd(value, next), positive[0]);
  return {
    zero_delta_count: String(zeroCount),
    positive_delta_count: String(positive.length),
    read_overhead_ns: {
      min: String(sorted[0]),
      p50: String(nearestRank(sorted, 0.5)),
      p95: String(nearestRank(sorted, 0.95)),
      max: String(sorted.at(-1)),
    },
    observed_resolution: {
      status: minimumPositive === null ? "unavailable" : "descriptive",
      value_ns: minimumPositive === null ? null : String(minimumPositive),
      reason: minimumPositive === null ? "no-positive-delta" : null,
    },
    observed_quantization: {
      status: observedGcd === null ? "unavailable" : "descriptive",
      value_ns: observedGcd === null ? null : String(observedGcd),
      reason: observedGcd === null ? "no-positive-delta" : null,
    },
  };
}

function canonicalEqual(left, right) {
  return encodeCanonicalJsonLine(left) === encodeCanonicalJsonLine(right);
}

function samplesBytes(records) {
  return Buffer.from(records.map(encodeCanonicalJsonLine).join(""), "utf8");
}

function referenceError() {
  return {
    status: "unavailable",
    value_ns: null,
    reason: "no-independent-reference-clock",
  };
}

function buildUnsupportedResult(runId, contract, contractBytes) {
  const rawSamples = Buffer.alloc(0);
  const summary = {
    schema_version: "1.0",
    status: "unsupported",
    unsupported_reason: "api-unavailable",
    source: NODE_HRTIME_SOURCE,
    run_id: runId,
    clock_domain_id: null,
    unit: null,
    contract_sha256: sha256(contractBytes),
    samples_sha256: sha256(rawSamples),
    sample_pair_count: "0",
    zero_delta_count: null,
    positive_delta_count: null,
    read_overhead_ns: null,
    observed_resolution: {
      status: "unsupported",
      value_ns: null,
      reason: "api-unavailable",
    },
    observed_quantization: {
      status: "unsupported",
      value_ns: null,
      reason: "api-unavailable",
    },
    reference_error: referenceError(),
    capability_gaps: unsupportedCapabilityGaps(),
    runtime: runtimeDescriptor(),
    evidence: buildEvidence(),
  };
  return {
    contract,
    contractBytes,
    records: [],
    samplesBytes: rawSamples,
    summary,
    summaryBytes: Buffer.from(encodeCanonicalJson(summary), "utf8"),
  };
}

function readClockValue(clockRead, label) {
  const value = clockRead();
  if (typeof value !== "bigint" || value < 0n || value > MAX_U64) {
    throw new Error(`${label} must return a uint64 BigInt`);
  }
  return value;
}

export function collectClockCalibration({
  clockRead = DEFAULT_CLOCK_READ,
  runId = randomUUID(),
  samplePairCount = DEFAULT_SAMPLE_PAIR_COUNT,
  contract = buildCalibrationContract(samplePairCount),
} = {}) {
  assertSafeRunId(runId);
  assertSamplePairCount(samplePairCount);
  validateContract(contract);
  if (contract.sample_pair_count !== String(samplePairCount)) {
    throw new Error("calibration contract sample count differs from the run plan");
  }
  const contractBytes = Buffer.from(encodeCanonicalJson(contract), "utf8");
  if (typeof clockRead !== "function") {
    return buildUnsupportedResult(runId, contract, contractBytes);
  }

  const clockDomainId = observationClockDomainId(runId);
  const records = [];
  let previous = null;
  for (let index = 0; index < samplePairCount; index += 1) {
    const start = readClockValue(clockRead, "clock start");
    const end = readClockValue(clockRead, "clock end");
    if (previous !== null && start < previous) {
      throw new Error("monotonic clock regressed between read pairs");
    }
    if (end < start) {
      throw new Error("monotonic clock regressed within a read pair");
    }
    const delta = end - start;
    records.push({
      schema_version: "1.0",
      sequence: String(index + 1),
      run_id: runId,
      clock_domain_id: clockDomainId,
      source: NODE_HRTIME_SOURCE,
      start_ns: String(start),
      end_ns: String(end),
      delta_ns: String(delta),
    });
    previous = end;
  }

  const rawSamples = samplesBytes(records);
  const diagnostics = deriveDiagnostics(
    records.map((record) => BigInt(record.delta_ns)),
  );
  const summary = {
    schema_version: "1.0",
    status: "available",
    unsupported_reason: null,
    source: NODE_HRTIME_SOURCE,
    run_id: runId,
    clock_domain_id: clockDomainId,
    unit: "ns",
    contract_sha256: sha256(contractBytes),
    samples_sha256: sha256(rawSamples),
    sample_pair_count: String(records.length),
    zero_delta_count: diagnostics.zero_delta_count,
    positive_delta_count: diagnostics.positive_delta_count,
    read_overhead_ns: diagnostics.read_overhead_ns,
    observed_resolution: diagnostics.observed_resolution,
    observed_quantization: diagnostics.observed_quantization,
    reference_error: referenceError(),
    capability_gaps: availableCapabilityGaps(),
    runtime: runtimeDescriptor(),
    evidence: buildEvidence(),
  };
  return {
    contract,
    contractBytes,
    records,
    samplesBytes: rawSamples,
    summary,
    summaryBytes: Buffer.from(encodeCanonicalJson(summary), "utf8"),
  };
}

async function ensureEmptyDirectory(root) {
  await mkdir(root, { recursive: true });
  const entries = await readdir(root);
  if (entries.length !== 0) {
    throw new Error(`clock calibration output directory must be empty: ${root}`);
  }
}

async function assertRunInventory(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const names = entries.map((entry) => entry.name).sort();
  if (
    names.length !== SAMPLE_FILES.length ||
    names.some((name, index) => name !== SAMPLE_FILES[index])
  ) {
    throw new Error(`clock calibration file inventory differs: ${names.join(",")}`);
  }
  for (const entry of entries) {
    const metadata = await lstat(path.join(root, entry.name));
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error(`clock calibration artifact must be a regular file: ${entry.name}`);
    }
  }
}

function parseCanonicalSamples(bytes) {
  if (bytes.length === 0) {
    return [];
  }
  if (bytes[bytes.length - 1] !== 0x0a || bytes.includes(0x0d)) {
    throw new Error("clock samples must be LF-terminated canonical JSONL");
  }
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) {
    throw new Error("clock samples contain invalid UTF-8");
  }
  const lines = text.slice(0, -1).split("\n");
  if (lines.some((line) => line.length === 0)) {
    throw new Error("clock samples contain an empty line or extra trailing LF");
  }
  return lines.map((line, index) => {
    const record = JSON.parse(line);
    if (encodeCanonicalJsonLine(record) !== `${line}\n`) {
      throw new Error(`clock sample ${index + 1} is not canonical JSONL`);
    }
    return record;
  });
}

function parseCanonicalJson(bytes, label) {
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) {
    throw new Error(`${label} contains invalid UTF-8`);
  }
  const value = JSON.parse(text);
  if (!Buffer.from(encodeCanonicalJson(value), "utf8").equals(bytes)) {
    throw new Error(`${label} is not canonical JSON`);
  }
  return value;
}

function validateRuntime(runtime) {
  assertExactKeys(runtime, RUNTIME_KEYS, "clock calibration runtime");
  if (
    runtime.platform !== process.platform ||
    runtime.arch !== process.arch ||
    runtime.node_version !== process.version ||
    runtime.uv_version !== process.versions.uv
  ) {
    throw new Error("clock calibration runtime descriptor differs from this process");
  }
}

function validateCapability(value, label) {
  assertExactKeys(value, CAPABILITY_KEYS, label);
  if (value.value_ns !== null) {
    assertCanonicalU64(value.value_ns, `${label}.value_ns`);
  }
}

function validateReferenceError(value) {
  validateCapability(value, "clock calibration reference_error");
  if (
    value.status !== "unavailable" ||
    value.value_ns !== null ||
    value.reason !== "no-independent-reference-clock"
  ) {
    throw new Error("reference error must remain unavailable without an independent clock");
  }
}

function validateAvailableRecords(records, summary, contract) {
  if (records.length !== Number(contract.sample_pair_count)) {
    throw new Error("clock sample count differs from the calibration contract");
  }
  const expectedDomain = observationClockDomainId(summary.run_id);
  let previous = null;
  records.forEach((record, index) => {
    const label = `clock sample ${index + 1}`;
    assertExactKeys(record, SAMPLE_KEYS, label);
    for (const field of ["sequence", "start_ns", "end_ns", "delta_ns"]) {
      assertCanonicalU64(record[field], `${label}.${field}`);
    }
    if (
      record.schema_version !== "1.0" ||
      record.sequence !== String(index + 1) ||
      record.run_id !== summary.run_id ||
      record.clock_domain_id !== expectedDomain ||
      record.source !== NODE_HRTIME_SOURCE
    ) {
      throw new Error(`${label} identity, domain, source, or sequence differs`);
    }
    const start = BigInt(record.start_ns);
    const end = BigInt(record.end_ns);
    if (previous !== null && start < previous) {
      throw new Error(`${label} regressed between read pairs`);
    }
    if (end < start || BigInt(record.delta_ns) !== end - start) {
      throw new Error(`${label} delta or monotonic order differs`);
    }
    previous = end;
  });
}

function validateAvailableSummary(summary, records) {
  if (
    summary.status !== "available" ||
    summary.unsupported_reason !== null ||
    summary.source !== NODE_HRTIME_SOURCE ||
    summary.clock_domain_id !== observationClockDomainId(summary.run_id) ||
    summary.unit !== "ns" ||
    summary.sample_pair_count !== String(records.length) ||
    JSON.stringify(summary.capability_gaps) !==
      JSON.stringify(availableCapabilityGaps())
  ) {
    throw new Error("available clock calibration summary shape differs");
  }
  const diagnostics = deriveDiagnostics(
    records.map((record) => BigInt(record.delta_ns)),
  );
  assertExactKeys(summary.read_overhead_ns, STATS_KEYS, "read_overhead_ns");
  for (const field of STATS_KEYS) {
    assertCanonicalU64(summary.read_overhead_ns[field], `read_overhead_ns.${field}`);
  }
  validateCapability(summary.observed_resolution, "observed_resolution");
  validateCapability(summary.observed_quantization, "observed_quantization");
  if (
    summary.zero_delta_count !== diagnostics.zero_delta_count ||
    summary.positive_delta_count !== diagnostics.positive_delta_count ||
    !canonicalEqual(summary.read_overhead_ns, diagnostics.read_overhead_ns) ||
    !canonicalEqual(summary.observed_resolution, diagnostics.observed_resolution) ||
    !canonicalEqual(summary.observed_quantization, diagnostics.observed_quantization)
  ) {
    throw new Error("clock calibration summary statistics do not match raw samples");
  }
}

function validateUnsupportedSummary(summary, records) {
  validateCapability(summary.observed_resolution, "observed_resolution");
  validateCapability(summary.observed_quantization, "observed_quantization");
  if (
    records.length !== 0 ||
    summary.status !== "unsupported" ||
    summary.unsupported_reason !== "api-unavailable" ||
    summary.source !== NODE_HRTIME_SOURCE ||
    summary.clock_domain_id !== null ||
    summary.unit !== null ||
    summary.sample_pair_count !== "0" ||
    summary.zero_delta_count !== null ||
    summary.positive_delta_count !== null ||
    summary.read_overhead_ns !== null ||
    summary.observed_resolution.status !== "unsupported" ||
    summary.observed_resolution.value_ns !== null ||
    summary.observed_resolution.reason !== "api-unavailable" ||
    summary.observed_quantization.status !== "unsupported" ||
    summary.observed_quantization.value_ns !== null ||
    summary.observed_quantization.reason !== "api-unavailable" ||
    JSON.stringify(summary.capability_gaps) !==
      JSON.stringify(unsupportedCapabilityGaps())
  ) {
    throw new Error("unsupported clock calibration must preserve null capability gaps");
  }
}

export async function validateClockRun(root, contract) {
  const resolvedRoot = path.resolve(root);
  await assertRunInventory(resolvedRoot);
  validateContract(contract);
  const contractBytes = Buffer.from(encodeCanonicalJson(contract), "utf8");
  const rawSamples = await readFile(path.join(resolvedRoot, "clock-samples.jsonl"));
  const records = parseCanonicalSamples(rawSamples);
  const summaryBytes = await readFile(
    path.join(resolvedRoot, "clock-calibration.json"),
  );
  const summary = parseCanonicalJson(summaryBytes, "clock calibration summary");
  assertExactKeys(summary, SUMMARY_KEYS, "clock calibration summary");
  assertSafeRunId(summary.run_id);
  assertSha256(summary.contract_sha256, "clock calibration contract_sha256");
  assertSha256(summary.samples_sha256, "clock calibration samples_sha256");
  if (
    summary.contract_sha256 !== sha256(contractBytes) ||
    summary.samples_sha256 !== sha256(rawSamples)
  ) {
    throw new Error("clock calibration contract or sample checksum differs");
  }
  validateEvidence(summary.evidence, "clock calibration summary.evidence");
  validateRuntime(summary.runtime);
  validateReferenceError(summary.reference_error);
  if (summary.status === "available") {
    validateAvailableRecords(records, summary, contract);
    validateAvailableSummary(summary, records);
  } else if (summary.status === "unsupported") {
    validateUnsupportedSummary(summary, records);
  } else {
    throw new Error("clock calibration status must be available or unsupported");
  }
  return {
    records,
    summary,
    samplesSha256: sha256(rawSamples),
    summarySha256: sha256(summaryBytes),
  };
}

export async function createClockRun(
  outputRoot,
  {
    clockRead = DEFAULT_CLOCK_READ,
    runId = randomUUID(),
    samplePairCount = DEFAULT_SAMPLE_PAIR_COUNT,
    contract = buildCalibrationContract(samplePairCount),
  } = {},
) {
  const result = collectClockCalibration({
    clockRead,
    runId,
    samplePairCount,
    contract,
  });
  const resolvedRoot = path.resolve(outputRoot);
  await ensureEmptyDirectory(resolvedRoot);
  await writeFile(path.join(resolvedRoot, "clock-samples.jsonl"), result.samplesBytes);
  await writeFile(
    path.join(resolvedRoot, "clock-calibration.json"),
    result.summaryBytes,
  );
  return validateClockRun(resolvedRoot, contract);
}

function runComparison(result) {
  return {
    status: result.summary.status,
    clock_domain_id: result.summary.clock_domain_id,
    samples_sha256: result.samplesSha256,
    summary_sha256: result.summarySha256,
  };
}

function buildComparison(contractBytes, runA, runB) {
  return {
    schema_version: "1.0",
    contract_sha256: sha256(contractBytes),
    runtime_artifact_equality: "not-required",
    cross_domain_subtraction: "forbidden",
    formal_claims: "none",
    run_a: runComparison(runA),
    run_b: runComparison(runB),
  };
}

async function assertBundleInventory(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const names = entries.map((entry) => entry.name).sort();
  if (
    names.length !== BUNDLE_ENTRIES.length ||
    names.some((name, index) => name !== BUNDLE_ENTRIES[index])
  ) {
    throw new Error(`clock calibration bundle inventory differs: ${names.join(",")}`);
  }
  for (const entry of entries) {
    const metadata = await lstat(path.join(root, entry.name));
    if (metadata.isSymbolicLink()) {
      throw new Error(`clock calibration bundle contains a symlink: ${entry.name}`);
    }
    const shouldBeDirectory = entry.name === "run-a" || entry.name === "run-b";
    if (
      (shouldBeDirectory && !metadata.isDirectory()) ||
      (!shouldBeDirectory && !metadata.isFile())
    ) {
      throw new Error(`clock calibration bundle entry type differs: ${entry.name}`);
    }
  }
}

export async function validateClockCalibrationBundle(root) {
  const resolvedRoot = path.resolve(root);
  await assertBundleInventory(resolvedRoot);
  const contractBytes = await readFile(
    path.join(resolvedRoot, "calibration-contract.json"),
  );
  const contract = parseCanonicalJson(contractBytes, "calibration contract");
  validateContract(contract);
  const runA = await validateClockRun(path.join(resolvedRoot, "run-a"), contract);
  const runB = await validateClockRun(path.join(resolvedRoot, "run-b"), contract);
  if (runA.summary.run_id === runB.summary.run_id) {
    throw new Error("clock calibration runs must use distinct run IDs");
  }
  if (
    runA.summary.clock_domain_id !== null &&
    runA.summary.clock_domain_id === runB.summary.clock_domain_id
  ) {
    throw new Error("clock calibration runs must use distinct clock domains");
  }
  const comparisonBytes = await readFile(path.join(resolvedRoot, "comparison.json"));
  const comparison = parseCanonicalJson(
    comparisonBytes,
    "clock calibration comparison",
  );
  assertExactKeys(comparison, COMPARISON_KEYS, "clock calibration comparison");
  assertExactKeys(comparison.run_a, RUN_COMPARISON_KEYS, "comparison.run_a");
  assertExactKeys(comparison.run_b, RUN_COMPARISON_KEYS, "comparison.run_b");
  const expected = buildComparison(contractBytes, runA, runB);
  if (!canonicalEqual(comparison, expected)) {
    throw new Error("clock calibration comparison does not match the validated runs");
  }
  return { contract, comparison, runA, runB };
}

export async function generateDoubleClockCalibration(
  outputRoot = DEFAULT_OUTPUT_ROOT,
  {
    clockRead = DEFAULT_CLOCK_READ,
    samplePairCount = DEFAULT_SAMPLE_PAIR_COUNT,
  } = {},
) {
  const resolvedRoot = path.resolve(outputRoot);
  await ensureEmptyDirectory(resolvedRoot);
  const contract = buildCalibrationContract(samplePairCount);
  const contractBytes = Buffer.from(encodeCanonicalJson(contract), "utf8");
  await writeFile(path.join(resolvedRoot, "calibration-contract.json"), contractBytes);
  const runA = await createClockRun(path.join(resolvedRoot, "run-a"), {
    clockRead,
    samplePairCount,
    contract,
  });
  const runB = await createClockRun(path.join(resolvedRoot, "run-b"), {
    clockRead,
    samplePairCount,
    contract,
  });
  if (runA.summary.run_id === runB.summary.run_id) {
    throw new Error("clock calibration runs must use distinct run IDs");
  }
  if (
    runA.summary.clock_domain_id !== null &&
    runA.summary.clock_domain_id === runB.summary.clock_domain_id
  ) {
    throw new Error("clock calibration runs must use distinct clock domains");
  }
  const comparison = buildComparison(contractBytes, runA, runB);
  assertExactKeys(comparison.run_a, RUN_COMPARISON_KEYS, "comparison.run_a");
  assertExactKeys(comparison.run_b, RUN_COMPARISON_KEYS, "comparison.run_b");
  await writeFile(
    path.join(resolvedRoot, "comparison.json"),
    Buffer.from(encodeCanonicalJson(comparison), "utf8"),
  );
  return (await validateClockCalibrationBundle(resolvedRoot)).comparison;
}

export const clockCalibrationPaths = Object.freeze({
  defaultOutputRoot: DEFAULT_OUTPUT_ROOT,
  repositoryRoot: REPOSITORY_ROOT,
  defaultSamplePairCount: DEFAULT_SAMPLE_PAIR_COUNT,
});
