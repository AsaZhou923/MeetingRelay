import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  encodeCanonicalJson,
  encodeCanonicalJsonLine,
} from "./canonical-json.mjs";
import {
  DURATION_MS,
  FIXTURE_ID,
  SAMPLE_RATE_HZ,
  fixturePaths,
  sha256,
  validateFixtureTree,
} from "./fixture-contract.mjs";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(MODULE_DIR, "..", "..");
const DEFAULT_OUTPUT_ROOT = path.join(
  REPOSITORY_ROOT,
  "target",
  "wp-0.3",
  "ct-ledger-001",
);
const MAX_U64 = (1n << 64n) - 1n;
const MAX_U32 = 2 ** 32 - 1;
const ROOT_CAUSE_ID = "cmd_meetingrelay_fixture_replay_v1";
const CLOCK_DOMAIN_ID = "meetingrelay.fixture.logical.v1";
const SCRIPTED_COMMIT_ENDPOINT = "meetingrelay.harness.scripted-commit.v1";
const TRACE_ID = `harness_trace_${FIXTURE_ID}_1`;
const MEETING_ID = `harness_mtg_${FIXTURE_ID}`;
const SEGMENT_ID = `harness_seg_${FIXTURE_ID}_1`;
const CAPTURE_EPOCH_ID = `harness_epoch_${FIXTURE_ID}_1`;
const LEDGER_FILES = Object.freeze([
  "decision-ledger.jsonl",
  "input-ledger.jsonl",
  "observation-ledger.jsonl",
]);
const RUNTIME_ONLY_FIELDS = Object.freeze([
  "absolute_path",
  "hostname",
  "observed_monotonic_ns",
  "pid",
  "resource_sample",
  "run_id",
  "wall_clock",
]);
const JOIN_FIELDS = Object.freeze([
  "trace_id",
  "meeting_id",
  "segment_id",
  "transcript_generation",
  "revision",
  "sequence",
]);
const EVIDENCE_KEYS = Object.freeze([
  "candidate_id",
  "metric_id",
  "production_evidence",
  "slo_claims",
  "stage",
]);
const DETERMINISTIC_KEYS = Object.freeze([
  "causation_id",
  "clock_domain_id",
  "event_id",
  "event_type",
  "evidence",
  "fixture_id",
  "ledger_kind",
  "ledger_sequence",
  "logical_monotonic_ns",
  "meeting_id",
  "payload",
  "payload_sha256",
  "revision",
  "schema_version",
  "segment_id",
  "sequence",
  "trace_id",
  "trace_point",
  "transcript_generation",
]);
const OBSERVATION_KEYS = Object.freeze([
  "causation_id",
  "clock_domain_id",
  "evidence",
  "fixture_id",
  "ledger_kind",
  "ledger_sequence",
  "meeting_id",
  "observation_id",
  "observation_type",
  "observed_monotonic_ns",
  "payload",
  "payload_sha256",
  "revision",
  "run_id",
  "schema_version",
  "segment_id",
  "sequence",
  "source_event_id",
  "source_ledger_kind",
  "source_ledger_sequence",
  "trace_id",
  "trace_point",
  "transcript_generation",
]);
const INPUT_PAYLOAD_KEYS = Object.freeze([
  "audio_sha256",
  "audio_source",
  "capture_epoch_ids",
  "fixture_revision",
  "last_voiced_sample",
  "manifest_sha256",
  "media_end_sample",
  "media_start_sample",
  "pcm_sha256",
  "timeline_rate",
]);
const DECISION_PAYLOAD_KEYS = Object.freeze([
  "decision",
  "durable",
  "endpoint_version",
  "source_event_id",
  "source_event_sha256",
]);
const OBSERVATION_PAYLOAD_KEYS = Object.freeze([
  "endpoint_semantics",
  "source_event_sha256",
  "source_payload_sha256",
]);

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

function assertUInt32(value, label) {
  if (!Number.isInteger(value) || value < 0 || value > MAX_U32) {
    throw new Error(`${label} must be a uint32 number`);
  }
}

function assertSha256(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
}

function assertNonEmptyString(value, label) {
  if (typeof value !== "string" || value.length === 0 || value !== value.normalize("NFC")) {
    throw new Error(`${label} must be a non-empty NFC string`);
  }
}

function assertLedgerSequence(records, label) {
  records.forEach((record, index) => {
    assertCanonicalU64(record.ledger_sequence, `${label} line ${index + 1}.ledger_sequence`);
    const expected = String(index + 1);
    if (record.ledger_sequence !== expected) {
      throw new Error(`${label} ledger_sequence: expected ${expected}, got ${record.ledger_sequence}`);
    }
  });
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

function canonicalValueSha256(value) {
  return sha256(Buffer.from(encodeCanonicalJsonLine(value), "utf8"));
}

export function deriveDeterministicEventId(event, prefix) {
  const material = { ...event };
  delete material.event_id;
  return `${prefix}_${canonicalValueSha256(material)}`;
}

function attachPayloadSha256(event) {
  return { ...event, payload_sha256: canonicalValueSha256(event.payload) };
}

function attachEventId(event, prefix) {
  const withPayloadDigest = attachPayloadSha256(event);
  return {
    ...withPayloadDigest,
    event_id: deriveDeterministicEventId(withPayloadDigest, prefix),
  };
}

function buildInput(fixture) {
  return attachEventId(
    {
      schema_version: "1.0",
      ledger_kind: "input",
      ledger_sequence: "1",
      event_type: "harness.fixture_window_ingress",
      fixture_id: FIXTURE_ID,
      trace_id: TRACE_ID,
      causation_id: ROOT_CAUSE_ID,
      meeting_id: MEETING_ID,
      segment_id: SEGMENT_ID,
      transcript_generation: 0,
      revision: 0,
      sequence: "1",
      logical_monotonic_ns: "0",
      clock_domain_id: CLOCK_DOMAIN_ID,
      trace_point: "capture.ingress",
      evidence: buildEvidence(),
      payload: {
        fixture_revision: 1,
        manifest_sha256: fixture.manifestDigest,
        audio_sha256: fixture.audioSha256,
        pcm_sha256: fixture.pcmSha256,
        media_start_sample: "0",
        media_end_sample: String((SAMPLE_RATE_HZ * DURATION_MS) / 1_000),
        last_voiced_sample: null,
        timeline_rate: SAMPLE_RATE_HZ,
        audio_source: "fixture",
        capture_epoch_ids: [CAPTURE_EPOCH_ID],
      },
    },
    "inp",
  );
}

function buildDecision(input) {
  const inputBytes = Buffer.from(encodeCanonicalJsonLine(input), "utf8");
  return attachEventId(
    {
      schema_version: "1.0",
      ledger_kind: "decision",
      ledger_sequence: "1",
      event_type: "harness.scripted_commit_decision",
      fixture_id: FIXTURE_ID,
      trace_id: input.trace_id,
      causation_id: input.event_id,
      meeting_id: input.meeting_id,
      segment_id: input.segment_id,
      transcript_generation: input.transcript_generation,
      revision: input.revision,
      sequence: input.sequence,
      logical_monotonic_ns: String(DURATION_MS * 1_000_000),
      clock_domain_id: CLOCK_DOMAIN_ID,
      trace_point: "commit.ack",
      evidence: buildEvidence(),
      payload: {
        decision: "accepted",
        source_event_id: input.event_id,
        source_event_sha256: sha256(inputBytes),
        endpoint_version: SCRIPTED_COMMIT_ENDPOINT,
        durable: false,
      },
    },
    "dec",
  );
}

function buildObservation(source, sourceLedgerKind, ledgerSequence, runId, observedMonotonicNs) {
  const sourceBytes = Buffer.from(encodeCanonicalJsonLine(source), "utf8");
  const payload = {
    source_event_sha256: sha256(sourceBytes),
    source_payload_sha256: source.payload_sha256,
    endpoint_semantics:
      sourceLedgerKind === "input" ? "synthetic_fixture_ingress" : "scripted_non_durable",
  };
  return {
    schema_version: "1.0",
    ledger_kind: "observation",
    ledger_sequence: ledgerSequence,
    observation_id: `obs_${runId}_${ledgerSequence}`,
    observation_type: "harness.trace_observation",
    run_id: runId,
    source_ledger_kind: sourceLedgerKind,
    source_ledger_sequence: source.ledger_sequence,
    source_event_id: source.event_id,
    fixture_id: FIXTURE_ID,
    trace_id: source.trace_id,
    causation_id: source.event_id,
    meeting_id: source.meeting_id,
    segment_id: source.segment_id,
    transcript_generation: source.transcript_generation,
    revision: source.revision,
    sequence: source.sequence,
    observed_monotonic_ns: String(observedMonotonicNs),
    clock_domain_id: `node.hrtime.${runId}`,
    trace_point: source.trace_point,
    evidence: buildEvidence(),
    payload,
    payload_sha256: canonicalValueSha256(payload),
  };
}

function canonicalLedgerBytes(records) {
  return Buffer.from(records.map(encodeCanonicalJsonLine).join(""), "utf8");
}

async function ensureEmptyDirectory(root) {
  await mkdir(root, { recursive: true });
  const entries = await readdir(root);
  if (entries.length !== 0) {
    throw new Error(`output directory must be empty: ${root}`);
  }
}

function isPathWithin(root, candidate, allowEqual = false) {
  const relative = path.relative(root, candidate);
  if (relative === "") {
    return allowEqual;
  }
  return (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function comparablePath(value) {
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export async function cleanOutputDirectory(target, allowedRepositoryRoot) {
  const resolvedRoot = path.resolve(allowedRepositoryRoot);
  const resolvedTarget = path.resolve(target);
  if (!isPathWithin(resolvedRoot, resolvedTarget)) {
    throw new Error(`refusing to clean a path outside the repository: ${resolvedTarget}`);
  }

  const rootMetadata = await lstat(resolvedRoot);
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new Error(`repository root must be a real directory: ${resolvedRoot}`);
  }
  const realRoot = await realpath(resolvedRoot);
  const components = path.relative(resolvedRoot, resolvedTarget).split(path.sep);
  let current = resolvedRoot;

  for (let index = 0; index < components.length; index += 1) {
    current = path.join(current, components[index]);
    let metadata;
    try {
      metadata = await lstat(current);
    } catch (error) {
      if (error?.code === "ENOENT") {
        break;
      }
      throw error;
    }
    if (metadata.isSymbolicLink()) {
      throw new Error(`refusing to clean through a symbolic link or junction: ${current}`);
    }
    if (!metadata.isDirectory()) {
      throw new Error(`cleanup path component must be a directory: ${current}`);
    }

    const realCurrent = await realpath(current);
    if (!isPathWithin(realRoot, realCurrent, true)) {
      throw new Error(`cleanup path resolves outside the repository: ${current}`);
    }
    const expectedRealPath = path.resolve(
      realRoot,
      path.relative(resolvedRoot, current),
    );
    if (comparablePath(realCurrent) !== comparablePath(expectedRealPath)) {
      throw new Error(`refusing to clean through a reparse point: ${current}`);
    }
  }

  await rm(resolvedTarget, { recursive: true, force: true });
}

async function writeLedger(root, fileName, records) {
  await writeFile(path.join(root, fileName), canonicalLedgerBytes(records));
}

export async function createReplay(
  root,
  { runId = randomUUID(), monotonicNow = () => process.hrtime.bigint() } = {},
) {
  assertNonEmptyString(runId, "run_id");
  if (!/^[A-Za-z0-9-]+$/.test(runId)) {
    throw new Error("run_id contains an unsafe character");
  }
  const resolvedRoot = path.resolve(root);
  await ensureEmptyDirectory(resolvedRoot);
  const fixture = await validateFixtureTree(fixturePaths.projectRoot);
  const input = buildInput(fixture);
  const decision = buildDecision(input);
  const firstObserved = monotonicNow();
  const secondObserved = monotonicNow();
  const observations = [
    buildObservation(input, "input", "1", runId, firstObserved),
    buildObservation(decision, "decision", "2", runId, secondObserved),
  ];

  await writeLedger(resolvedRoot, "input-ledger.jsonl", [input]);
  await writeLedger(resolvedRoot, "decision-ledger.jsonl", [decision]);
  await writeLedger(resolvedRoot, "observation-ledger.jsonl", observations);
  return validateReplay(resolvedRoot);
}

async function assertLedgerInventory(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const names = entries.map((entry) => entry.name).sort();
  if (names.length !== LEDGER_FILES.length || names.some((name, index) => name !== LEDGER_FILES[index])) {
    throw new Error(`ledger file inventory differs: ${names.join(",")}`);
  }
  for (const entry of entries) {
    const metadata = await lstat(path.join(root, entry.name));
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error(`ledger entry must be a regular file: ${entry.name}`);
    }
  }
}

async function readCanonicalJsonLines(root, fileName) {
  const bytes = await readFile(path.join(root, fileName));
  const label = fileName;
  if (bytes.length === 0 || bytes[bytes.length - 1] !== 0x0a) {
    throw new Error(`${label} must end with exactly one LF`);
  }
  if (bytes.includes(0x0d) || (bytes.length >= 3 && bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])))) {
    throw new Error(`${label} must be UTF-8 canonical JSONL without BOM or CRLF`);
  }
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) {
    throw new Error(`${label} contains invalid UTF-8`);
  }
  const lines = text.slice(0, -1).split("\n");
  if (lines.some((line) => line.length === 0)) {
    throw new Error(`${label} contains an empty line or extra trailing LF`);
  }
  const records = lines.map((line, index) => {
    let record;
    try {
      record = JSON.parse(line);
    } catch (error) {
      throw new Error(`${label} line ${index + 1} is invalid JSON: ${error.message}`);
    }
    if (encodeCanonicalJsonLine(record) !== `${line}\n`) {
      throw new Error(`${label} line ${index + 1} is not canonical JSONL`);
    }
    return record;
  });
  return { bytes, records };
}

function validateCommonRecord(record, label) {
  if (record.schema_version !== "1.0" || record.fixture_id !== FIXTURE_ID) {
    throw new Error(`${label} version or fixture identity differs`);
  }
  for (const field of ["trace_id", "meeting_id", "segment_id", "causation_id", "trace_point"]) {
    assertNonEmptyString(record[field], `${label}.${field}`);
  }
  assertCanonicalU64(record.sequence, `${label}.sequence`);
  assertUInt32(record.transcript_generation, `${label}.transcript_generation`);
  assertUInt32(record.revision, `${label}.revision`);
  validateEvidence(record.evidence, `${label}.evidence`);
  if (record.trace_point.endsWith(".paint")) {
    throw new Error(`${label} cannot contain a production paint trace point`);
  }
  assertSha256(record.payload_sha256, `${label}.payload_sha256`);
  const actualPayloadDigest = canonicalValueSha256(record.payload);
  if (record.payload_sha256 !== actualPayloadDigest) {
    throw new Error(`${label}.payload_sha256 mismatch`);
  }
}

function validateDeterministicBoundary(record, label) {
  for (const field of RUNTIME_ONLY_FIELDS) {
    if (Object.hasOwn(record, field)) {
      throw new Error(`${label} contains runtime-only field ${field}`);
    }
  }
}

function validateDeterministicRecord(record, label, kind, prefix) {
  validateDeterministicBoundary(record, label);
  assertExactKeys(record, DETERMINISTIC_KEYS, label);
  validateCommonRecord(record, label);
  if (record.ledger_kind !== kind) {
    throw new Error(`${label}.ledger_kind must be ${kind}`);
  }
  assertCanonicalU64(record.logical_monotonic_ns, `${label}.logical_monotonic_ns`);
  if (record.clock_domain_id !== CLOCK_DOMAIN_ID) {
    throw new Error(`${label}.clock_domain_id differs`);
  }
  assertNonEmptyString(record.event_id, `${label}.event_id`);
  const expectedEventId = deriveDeterministicEventId(record, prefix);
  if (record.event_id !== expectedEventId) {
    throw new Error(`${label}.event_id is not content-derived`);
  }
}

function assertJoinEqual(actual, expected, label) {
  for (const field of JOIN_FIELDS) {
    if (actual[field] !== expected[field]) {
      throw new Error(`${label} join field ${field} does not match its source`);
    }
  }
}

function validateInput(input, fixture) {
  const label = "input-ledger.jsonl line 1";
  validateDeterministicRecord(input, label, "input", "inp");
  if (
    input.ledger_sequence !== "1" ||
    input.event_type !== "harness.fixture_window_ingress" ||
    input.causation_id !== ROOT_CAUSE_ID ||
    input.trace_id !== TRACE_ID ||
    input.meeting_id !== MEETING_ID ||
    input.segment_id !== SEGMENT_ID ||
    input.transcript_generation !== 0 ||
    input.revision !== 0 ||
    input.sequence !== "1" ||
    input.logical_monotonic_ns !== "0" ||
    input.trace_point !== "capture.ingress"
  ) {
    throw new Error(`${label} stable identity or trace boundary differs`);
  }
  assertExactKeys(input.payload, INPUT_PAYLOAD_KEYS, `${label}.payload`);
  const expectedEnd = String((SAMPLE_RATE_HZ * DURATION_MS) / 1_000);
  if (
    input.payload.fixture_revision !== 1 ||
    input.payload.manifest_sha256 !== fixture.manifestDigest ||
    input.payload.audio_sha256 !== fixture.audioSha256 ||
    input.payload.pcm_sha256 !== fixture.pcmSha256 ||
    input.payload.media_start_sample !== "0" ||
    input.payload.media_end_sample !== expectedEnd ||
    input.payload.last_voiced_sample !== null ||
    input.payload.timeline_rate !== SAMPLE_RATE_HZ ||
    input.payload.audio_source !== "fixture" ||
    JSON.stringify(input.payload.capture_epoch_ids) !== JSON.stringify([CAPTURE_EPOCH_ID])
  ) {
    throw new Error(`${label}.payload differs from the committed fixture`);
  }
  for (const field of ["media_start_sample", "media_end_sample"]) {
    assertCanonicalU64(input.payload[field], `${label}.payload.${field}`);
  }
}

function validateDecision(decision, input) {
  const label = "decision-ledger.jsonl line 1";
  validateDeterministicRecord(decision, label, "decision", "dec");
  assertJoinEqual(decision, input, label);
  if (
    decision.ledger_sequence !== "1" ||
    decision.event_type !== "harness.scripted_commit_decision" ||
    decision.causation_id !== input.event_id ||
    decision.logical_monotonic_ns !== String(DURATION_MS * 1_000_000) ||
    decision.trace_point !== "commit.ack"
  ) {
    throw new Error(`${label} scripted decision boundary differs`);
  }
  assertExactKeys(decision.payload, DECISION_PAYLOAD_KEYS, `${label}.payload`);
  const inputDigest = sha256(Buffer.from(encodeCanonicalJsonLine(input), "utf8"));
  if (
    decision.payload.decision !== "accepted" ||
    decision.payload.source_event_id !== input.event_id ||
    decision.payload.source_event_sha256 !== inputDigest ||
    decision.payload.endpoint_version !== SCRIPTED_COMMIT_ENDPOINT ||
    decision.payload.durable !== false
  ) {
    throw new Error(`${label}.payload violates the non-durable scripted commit contract`);
  }
}

function validateObservation(observation, source, sourceKind, expectedSequence) {
  const label = `observation-ledger.jsonl line ${expectedSequence}`;
  assertExactKeys(observation, OBSERVATION_KEYS, label);
  validateCommonRecord(observation, label);
  if (
    observation.ledger_kind !== "observation" ||
    observation.ledger_sequence !== String(expectedSequence) ||
    observation.observation_type !== "harness.trace_observation" ||
    observation.source_ledger_kind !== sourceKind ||
    observation.source_ledger_sequence !== source.ledger_sequence ||
    observation.source_event_id !== source.event_id ||
    observation.causation_id !== source.event_id ||
    observation.trace_point !== source.trace_point
  ) {
    throw new Error(`${label} source or causation reference differs`);
  }
  assertNonEmptyString(observation.run_id, `${label}.run_id`);
  if (!/^[A-Za-z0-9-]+$/.test(observation.run_id)) {
    throw new Error(`${label}.run_id contains an unsafe character`);
  }
  if (
    observation.observation_id !== `obs_${observation.run_id}_${observation.ledger_sequence}` ||
    observation.clock_domain_id !== `node.hrtime.${observation.run_id}`
  ) {
    throw new Error(`${label} observation or clock-domain identity differs`);
  }
  assertCanonicalU64(observation.observed_monotonic_ns, `${label}.observed_monotonic_ns`);
  assertJoinEqual(observation, source, label);
  assertExactKeys(observation.payload, OBSERVATION_PAYLOAD_KEYS, `${label}.payload`);
  const sourceDigest = sha256(Buffer.from(encodeCanonicalJsonLine(source), "utf8"));
  const expectedSemantics =
    sourceKind === "input" ? "synthetic_fixture_ingress" : "scripted_non_durable";
  if (
    observation.payload.source_event_sha256 !== sourceDigest ||
    observation.payload.source_payload_sha256 !== source.payload_sha256 ||
    observation.payload.endpoint_semantics !== expectedSemantics
  ) {
    throw new Error(`${label}.payload does not match its deterministic source`);
  }
}

export async function validateReplay(root) {
  const resolvedRoot = path.resolve(root);
  await assertLedgerInventory(resolvedRoot);
  const fixture = await validateFixtureTree(fixturePaths.projectRoot);
  const inputLedger = await readCanonicalJsonLines(resolvedRoot, "input-ledger.jsonl");
  const decisionLedger = await readCanonicalJsonLines(resolvedRoot, "decision-ledger.jsonl");
  const observationLedger = await readCanonicalJsonLines(resolvedRoot, "observation-ledger.jsonl");
  if (inputLedger.records.length !== 1 || decisionLedger.records.length !== 1) {
    throw new Error("WP-0.3.3 requires exactly one input and one decision record");
  }
  if (observationLedger.records.length !== 2) {
    throw new Error("WP-0.3.3 requires exactly two observation records");
  }
  assertLedgerSequence(inputLedger.records, "input-ledger.jsonl");
  assertLedgerSequence(decisionLedger.records, "decision-ledger.jsonl");
  assertLedgerSequence(observationLedger.records, "observation-ledger.jsonl");
  const [input] = inputLedger.records;
  const [decision] = decisionLedger.records;
  validateInput(input, fixture);
  validateDecision(decision, input);
  const [inputObservation, decisionObservation] = observationLedger.records;
  validateObservation(inputObservation, input, "input", 1);
  validateObservation(decisionObservation, decision, "decision", 2);
  if (
    inputObservation.run_id !== decisionObservation.run_id ||
    inputObservation.clock_domain_id !== decisionObservation.clock_domain_id
  ) {
    throw new Error("observation records must share one run and clock domain");
  }
  if (
    BigInt(decisionObservation.observed_monotonic_ns) <
    BigInt(inputObservation.observed_monotonic_ns)
  ) {
    throw new Error("observed_monotonic_ns regressed within clock_domain_id");
  }
  if (input.event_id === decision.event_id) {
    throw new Error("deterministic event_id is duplicated");
  }
  return {
    inputSha256: sha256(inputLedger.bytes),
    decisionSha256: sha256(decisionLedger.bytes),
    observationSha256: sha256(observationLedger.bytes),
    runId: inputObservation.run_id,
    records: { input, decision, observations: observationLedger.records },
  };
}

function stableObservationProjection(records) {
  return records.map((record) => ({
    ledger_sequence: record.ledger_sequence,
    source_ledger_kind: record.source_ledger_kind,
    source_ledger_sequence: record.source_ledger_sequence,
    source_event_id: record.source_event_id,
    fixture_id: record.fixture_id,
    trace_id: record.trace_id,
    causation_id: record.causation_id,
    meeting_id: record.meeting_id,
    segment_id: record.segment_id,
    transcript_generation: record.transcript_generation,
    revision: record.revision,
    sequence: record.sequence,
    trace_point: record.trace_point,
    evidence: record.evidence,
    payload: record.payload,
    payload_sha256: record.payload_sha256,
  }));
}

export async function compareReplays(runA, runB) {
  const a = await validateReplay(runA);
  const b = await validateReplay(runB);
  const inputA = await readFile(path.join(runA, "input-ledger.jsonl"));
  const inputB = await readFile(path.join(runB, "input-ledger.jsonl"));
  const decisionA = await readFile(path.join(runA, "decision-ledger.jsonl"));
  const decisionB = await readFile(path.join(runB, "decision-ledger.jsonl"));
  const observationA = await readFile(path.join(runA, "observation-ledger.jsonl"));
  const observationB = await readFile(path.join(runB, "observation-ledger.jsonl"));
  if (inputA.compare(inputB) !== 0 || a.inputSha256 !== b.inputSha256) {
    throw new Error("input ledgers are not byte-for-byte deterministic");
  }
  if (decisionA.compare(decisionB) !== 0 || a.decisionSha256 !== b.decisionSha256) {
    throw new Error("decision ledgers are not byte-for-byte deterministic");
  }
  if (observationA.compare(observationB) === 0 || a.observationSha256 === b.observationSha256) {
    throw new Error("observation ledgers must retain distinct runtime observations");
  }
  if (
    encodeCanonicalJsonLine(stableObservationProjection(a.records.observations)) !==
    encodeCanonicalJsonLine(stableObservationProjection(b.records.observations))
  ) {
    throw new Error("observation stable join projections differ across replays");
  }
  return {
    schema_version: "1.0",
    input_ledger: { comparison: "byte-and-sha256-equal", sha256: a.inputSha256 },
    decision_ledger: { comparison: "byte-and-sha256-equal", sha256: a.decisionSha256 },
    observation_ledger: {
      comparison: "not-required",
      distinct_runtime_bytes: true,
      stable_join_projection_equal: true,
      run_a_sha256: a.observationSha256,
      run_b_sha256: b.observationSha256,
    },
    formal_claims: "none",
  };
}

export async function generateDoubleReplay(outputRoot = DEFAULT_OUTPUT_ROOT) {
  const resolvedRoot = path.resolve(outputRoot);
  await ensureEmptyDirectory(resolvedRoot);
  const runA = path.join(resolvedRoot, "run-a");
  const runB = path.join(resolvedRoot, "run-b");
  await createReplay(runA);
  await createReplay(runB);
  const comparison = await compareReplays(runA, runB);
  await writeFile(
    path.join(resolvedRoot, "comparison.json"),
    Buffer.from(encodeCanonicalJson(comparison), "utf8"),
  );
  return comparison;
}

export const ledgerPaths = Object.freeze({
  defaultOutputRoot: DEFAULT_OUTPUT_ROOT,
  repositoryRoot: REPOSITORY_ROOT,
  ledgerFiles: LEDGER_FILES,
});
