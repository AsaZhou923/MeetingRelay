import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { encodeCanonicalJson } from "../phase0-harness/canonical-json.mjs";
import {
  HW_REF_ID,
  validateArtifactPath,
} from "../phase0-harness/candidate-artifact-contract.mjs";

const KIND = "meetingrelay-sherpa-same-machine-runner-schedule-v1";
const SCHEMA_VERSION = "1.0";
const CLOCK_DOMAIN = "logical-dry-run-sequence-v1";
const NETWORK_POLICY = "offline-only";
const ORDER_POLICY = "seeded-round-robin-v1";
const SEED = "42";
const MAX_CANDIDATES = 16;
const MAX_FIXTURES = 32;
const MAX_RECORD_BYTES = 32 * 1024 * 1024;
const DIGEST = /^(?!0{64}$)[0-9a-f]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SAFE_VALUE = /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,255}$/u;

const AUTHORITY = Object.freeze({
  cold_warm_sample_status: "planned-not-measured",
  confidence_interval: "not-computed",
  default: "none",
  execution_status:
    "offline-dry-run-scheduler-validation-only-no-model-no-audio-no-transcription",
  fallback: "none",
  formal_claims: "none",
  measurement_status: "same-machine-runner-plan-contract-only",
  production_evidence: false,
  public_distribution: false,
  quality: "not-assessed",
  ranking: "none",
  rotation_order_status: "deterministic-dry-run-order-validated",
  same_machine_runner_status: "schedule-contract-validated",
  selection: "none",
  statistics: "not-computed",
});

const SAMPLING = Object.freeze({
  cold_runs: "10",
  final_event_count: "10000",
  soak_durations_seconds: Object.freeze(["1800", "7200", "14400"]),
  warm_samples_per_scenario: "30",
  warmup_runs: "1",
});

const STAGE_SPECS = Object.freeze([
  Object.freeze({ kind: "preflight", repetitions: 1 }),
  Object.freeze({ kind: "publishability", repetitions: 1 }),
  Object.freeze({ kind: "contract", repetitions: 1 }),
  Object.freeze({ kind: "quality", repetitions: 1 }),
  Object.freeze({ kind: "cold", repetitions: 10 }),
  Object.freeze({ kind: "warmup", repetitions: 1 }),
  Object.freeze({ kind: "warm", repetitions: 30 }),
  Object.freeze({ kind: "soak-fault", repetitions: 1 }),
  Object.freeze({ kind: "postflight", repetitions: 1 }),
]);

const ROOT_KEYS = Object.freeze([
  "authority",
  "contract",
  "kind",
  "ledger",
  "sampling",
  "schema_version",
  "stages",
]);
const CONTRACT_KEYS = Object.freeze([
  "candidate_bindings",
  "clock_domain",
  "fixture_bindings",
  "hw_ref_id",
  "network_policy",
  "order_policy",
  "same_condition_contract_sha256",
  "seed",
]);
const CANDIDATE_KEYS = Object.freeze([
  "candidate_id",
  "candidate_manifest_sha256",
  "role",
]);
const FIXTURE_KEYS = Object.freeze([
  "audio_sha256",
  "fixture_id",
  "pcm_sha256",
  "reference_sha256",
  "scenario_id",
]);
const STAGE_KEYS = Object.freeze(["kind", "planned_entry_count", "sequence"]);
const ENTRY_KEYS = Object.freeze([
  "candidate_id",
  "clock_domain",
  "fixture_id",
  "lane",
  "planned_sample_index",
  "scenario_id",
  "sequence",
  "stage",
  "stage_sequence",
]);
const CONDITION_KEYS = Object.freeze([
  "audio_playback_path",
  "batch_size",
  "cooling_mode",
  "endpoint_parameters",
  "execution_provider",
  "log_level",
  "model_sha256",
  "parameter_sha256",
  "pcm_sha256",
  "power_plan",
  "quantization",
  "thread_count",
  "translation_fixture_ids",
  "vad_parameters",
  "warmup_plan",
]);
const REFERENCE_KEYS = Object.freeze(["path", "sha256"]);
const CANDIDATE_ROLES = Object.freeze([
  "fallback-candidate",
  "native-candidate",
  "oracle-only",
  "sidecar-candidate",
]);

export class SameMachineRunnerScheduleError extends Error {
  constructor(code, field = null) {
    super(`${code}${field === null ? "" : ` (${field})`}`);
    this.name = "SameMachineRunnerScheduleError";
    this.code = code;
    this.field = field;
  }
}

function fail(code, field = null) {
  throw new SameMachineRunnerScheduleError(code, field);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function exactKeys(value, expected, code, field) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(code, field);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    fail(code, field);
  }
}

function assertDigest(value, code, field) {
  if (typeof value !== "string" || !DIGEST.test(value)) fail(code, field);
}

function assertIdentifier(value, code, field) {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) fail(code, field);
}

function assertSafeValue(value, field) {
  if (typeof value !== "string" || !SAFE_VALUE.test(value)) {
    fail("SCHEDULE_CONDITION", field);
  }
}

function assertCanonicalPositiveDecimal(value, field) {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/u.test(value)) {
    fail("SCHEDULE_CONDITION", field);
  }
}

function compareIdentifiers(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function seededRoundRobinOrder(participantIds, seed, round = 0) {
  if (
    !Array.isArray(participantIds) ||
    participantIds.length < 1 ||
    participantIds.length > MAX_FIXTURES ||
    typeof seed !== "string" ||
    !/^(0|[1-9][0-9]*)$/u.test(seed) ||
    !Number.isSafeInteger(round) ||
    round < 0
  ) {
    fail("SCHEDULE_ROTATION", "participants");
  }
  const sorted = [...participantIds];
  const seen = new Set();
  for (const [index, participantId] of sorted.entries()) {
    assertIdentifier(
      participantId,
      "SCHEDULE_ROTATION",
      `participants[${index}]`,
    );
    if (seen.has(participantId)) fail("SCHEDULE_ROTATION", "participants");
    seen.add(participantId);
  }
  sorted.sort(compareIdentifiers);
  const offset = Number(
    (BigInt(seed) + BigInt(round)) % BigInt(sorted.length),
  );
  return Object.freeze([...sorted.slice(offset), ...sorted.slice(0, offset)]);
}

function validateReference(reference, field) {
  exactKeys(
    reference,
    REFERENCE_KEYS,
    "SCHEDULE_CONDITION_FIELDS",
    field,
  );
  validateArtifactPath(reference.path, `${field}.path`);
  assertDigest(reference.sha256, "SCHEDULE_CONDITION", `${field}.sha256`);
}

function validateSameConditionContract(value) {
  exactKeys(
    value,
    CONDITION_KEYS,
    "SCHEDULE_CONDITION_FIELDS",
    "same_condition_contract",
  );
  validateArtifactPath(
    value.audio_playback_path,
    "same_condition_contract.audio_playback_path",
  );
  assertCanonicalPositiveDecimal(
    value.batch_size,
    "same_condition_contract.batch_size",
  );
  assertCanonicalPositiveDecimal(
    value.thread_count,
    "same_condition_contract.thread_count",
  );
  for (const key of ["model_sha256", "parameter_sha256", "pcm_sha256"]) {
    assertDigest(
      value[key],
      "SCHEDULE_CONDITION",
      `same_condition_contract.${key}`,
    );
  }
  for (const key of ["endpoint_parameters", "vad_parameters", "warmup_plan"]) {
    validateReference(value[key], `same_condition_contract.${key}`);
  }
  for (const key of [
    "cooling_mode",
    "execution_provider",
    "log_level",
    "power_plan",
    "quantization",
  ]) {
    assertSafeValue(value[key], `same_condition_contract.${key}`);
  }
  if (!Array.isArray(value.translation_fixture_ids)) {
    fail(
      "SCHEDULE_CONDITION",
      "same_condition_contract.translation_fixture_ids",
    );
  }
  const translationIds = new Set();
  for (const [index, fixtureId] of value.translation_fixture_ids.entries()) {
    assertIdentifier(
      fixtureId,
      "SCHEDULE_CONDITION",
      `same_condition_contract.translation_fixture_ids[${index}]`,
    );
    if (translationIds.has(fixtureId)) {
      fail(
        "SCHEDULE_CONDITION",
        "same_condition_contract.translation_fixture_ids",
      );
    }
    translationIds.add(fixtureId);
  }
}

function normalizeCandidates(value) {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > MAX_CANDIDATES
  ) {
    fail("SCHEDULE_CANDIDATES", "candidate_bindings");
  }
  const seen = new Set();
  const candidates = value.map((candidate, index) => {
    const field = `candidate_bindings[${index}]`;
    exactKeys(candidate, CANDIDATE_KEYS, "SCHEDULE_CANDIDATE_FIELDS", field);
    assertIdentifier(
      candidate.candidate_id,
      "SCHEDULE_CANDIDATES",
      `${field}.candidate_id`,
    );
    assertDigest(
      candidate.candidate_manifest_sha256,
      "SCHEDULE_CANDIDATES",
      `${field}.candidate_manifest_sha256`,
    );
    if (!CANDIDATE_ROLES.includes(candidate.role)) {
      fail("SCHEDULE_CANDIDATES", `${field}.role`);
    }
    if (seen.has(candidate.candidate_id)) {
      fail("SCHEDULE_CANDIDATE_DUPLICATE", `${field}.candidate_id`);
    }
    seen.add(candidate.candidate_id);
    return { ...candidate };
  });
  return candidates.sort((left, right) =>
    compareIdentifiers(left.candidate_id, right.candidate_id)
  );
}

function normalizeFixtures(value) {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > MAX_FIXTURES
  ) {
    fail("SCHEDULE_FIXTURES", "fixture_bindings");
  }
  const seenIds = new Set();
  const seenIdentities = new Set();
  const seenScenarios = new Set();
  const fixtures = value.map((fixture, index) => {
    const field = `fixture_bindings[${index}]`;
    exactKeys(fixture, FIXTURE_KEYS, "SCHEDULE_FIXTURE_FIELDS", field);
    assertIdentifier(
      fixture.fixture_id,
      "SCHEDULE_FIXTURES",
      `${field}.fixture_id`,
    );
    assertIdentifier(
      fixture.scenario_id,
      "SCHEDULE_FIXTURES",
      `${field}.scenario_id`,
    );
    for (const key of ["audio_sha256", "pcm_sha256", "reference_sha256"]) {
      assertDigest(
        fixture[key],
        "SCHEDULE_FIXTURES",
        `${field}.${key}`,
      );
    }
    const identity = [
      fixture.audio_sha256,
      fixture.pcm_sha256,
      fixture.reference_sha256,
    ].join(":");
    if (
      seenIds.has(fixture.fixture_id) ||
      seenIdentities.has(identity) ||
      seenScenarios.has(fixture.scenario_id)
    ) {
      fail("SCHEDULE_FIXTURE_DUPLICATE", field);
    }
    seenIds.add(fixture.fixture_id);
    seenIdentities.add(identity);
    seenScenarios.add(fixture.scenario_id);
    return { ...fixture };
  });
  return fixtures.sort((left, right) =>
    compareIdentifiers(left.fixture_id, right.fixture_id)
  );
}

function buildExpectedStagesAndLedger(contract) {
  const candidates = contract.candidate_bindings;
  const fixtures = contract.fixture_bindings;
  const candidatesById = new Map(
    candidates.map((candidate) => [candidate.candidate_id, candidate]),
  );
  const fixturesById = new Map(
    fixtures.map((fixture) => [fixture.fixture_id, fixture]),
  );
  const ledger = [];
  const stages = [];
  let sequence = 1;
  for (const [stageIndex, spec] of STAGE_SPECS.entries()) {
    const plannedEntryCount = spec.repetitions * candidates.length * fixtures.length;
    stages.push({
      kind: spec.kind,
      planned_entry_count: String(plannedEntryCount),
      sequence: String(stageIndex + 1),
    });
    for (let iteration = 0; iteration < spec.repetitions; iteration += 1) {
      const round = stageIndex + iteration;
      const candidateOrder = seededRoundRobinOrder(
        candidates.map((candidate) => candidate.candidate_id),
        contract.seed,
        round,
      );
      const fixtureOrder = seededRoundRobinOrder(
        fixtures.map((fixture) => fixture.fixture_id),
        contract.seed,
        round,
      );
      for (const fixtureId of fixtureOrder) {
        const fixture = fixturesById.get(fixtureId);
        for (const candidateId of candidateOrder) {
          const candidate = candidatesById.get(candidateId);
          ledger.push({
            candidate_id: candidate.candidate_id,
            clock_domain: contract.clock_domain,
            fixture_id: fixture.fixture_id,
            lane: candidate.role === "oracle-only" ? "oracle" : "ranking",
            planned_sample_index: String(iteration + 1),
            scenario_id: fixture.scenario_id,
            sequence: String(sequence),
            stage: spec.kind,
            stage_sequence: String(stageIndex + 1),
          });
          sequence += 1;
        }
      }
    }
    if (ledger.length !== stages.reduce(
      (total, stage) => total + Number(stage.planned_entry_count),
      0,
    )) {
      fail("SCHEDULE_COUNT", `stages[${stageIndex}]`);
    }
  }
  return { ledger, stages };
}

function validateAuthority(value) {
  exactKeys(value, Object.keys(AUTHORITY), "SCHEDULE_AUTHORITY_FIELDS", "authority");
  if (!isDeepStrictEqual(value, AUTHORITY)) fail("SCHEDULE_AUTHORITY", "authority");
}

function validateContract(value) {
  exactKeys(value, CONTRACT_KEYS, "SCHEDULE_CONTRACT_FIELDS", "contract");
  const candidates = normalizeCandidates(value.candidate_bindings);
  const fixtures = normalizeFixtures(value.fixture_bindings);
  if (
    !isDeepStrictEqual(candidates, value.candidate_bindings) ||
    !isDeepStrictEqual(fixtures, value.fixture_bindings)
  ) {
    fail("SCHEDULE_CONTRACT_ORDER", "contract");
  }
  assertDigest(
    value.same_condition_contract_sha256,
    "SCHEDULE_CONTRACT",
    "contract.same_condition_contract_sha256",
  );
  if (
    value.clock_domain !== CLOCK_DOMAIN ||
    value.hw_ref_id !== HW_REF_ID ||
    value.network_policy !== NETWORK_POLICY ||
    value.order_policy !== ORDER_POLICY ||
    value.seed !== SEED
  ) {
    fail("SCHEDULE_CONTRACT", "contract");
  }
}

function validateSampling(value) {
  exactKeys(value, Object.keys(SAMPLING), "SCHEDULE_SAMPLING_FIELDS", "sampling");
  if (!isDeepStrictEqual(value, SAMPLING)) fail("SCHEDULE_SAMPLING", "sampling");
}

function validateStagesAndLedger(record) {
  if (!Array.isArray(record.stages) || record.stages.length !== STAGE_SPECS.length) {
    fail("SCHEDULE_STAGE_ORDER", "stages");
  }
  for (const [index, stage] of record.stages.entries()) {
    exactKeys(stage, STAGE_KEYS, "SCHEDULE_STAGE_FIELDS", `stages[${index}]`);
  }
  if (!Array.isArray(record.ledger)) fail("SCHEDULE_LEDGER", "ledger");
  for (const [index, entry] of record.ledger.entries()) {
    exactKeys(entry, ENTRY_KEYS, "SCHEDULE_ENTRY_FIELDS", `ledger[${index}]`);
    if (entry.clock_domain !== record.contract.clock_domain) {
      fail("SCHEDULE_CLOCK_DOMAIN", `ledger[${index}].clock_domain`);
    }
    const candidate = record.contract.candidate_bindings.find(
      (binding) => binding.candidate_id === entry.candidate_id,
    );
    if (candidate?.role === "oracle-only" && entry.lane === "ranking") {
      fail("SCHEDULE_ORACLE_LANE", `ledger[${index}].lane`);
    }
  }
  const expected = buildExpectedStagesAndLedger(record.contract);
  if (!isDeepStrictEqual(record.stages, expected.stages)) {
    fail("SCHEDULE_STAGE_ORDER", "stages");
  }
  if (record.ledger.length !== expected.ledger.length) {
    fail("SCHEDULE_COUNT", "ledger");
  }
  if (!isDeepStrictEqual(record.ledger, expected.ledger)) {
    fail("SCHEDULE_DRIFT", "ledger");
  }
}

function validateRecordObject(record) {
  exactKeys(record, ROOT_KEYS, "SCHEDULE_FIELDS", "record");
  if (record.kind !== KIND || record.schema_version !== SCHEMA_VERSION) {
    fail("SCHEDULE_SCOPE", "record");
  }
  validateAuthority(record.authority);
  validateContract(record.contract);
  validateSampling(record.sampling);
  validateStagesAndLedger(record);
}

function parseCanonicalRecord(bytes) {
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length < 2 ||
    bytes.length > MAX_RECORD_BYTES
  ) {
    fail("SCHEDULE_CANONICAL_JSON", "bytes");
  }
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) {
    fail("SCHEDULE_CANONICAL_JSON", "bytes");
  }
  let record;
  try {
    record = JSON.parse(text);
  } catch {
    fail("SCHEDULE_CANONICAL_JSON", "bytes");
  }
  if (encodeCanonicalJson(record) !== text) {
    fail("SCHEDULE_CANONICAL_JSON", "bytes");
  }
  validateRecordObject(record);
  return record;
}

function buildContract(input) {
  exactKeys(
    input,
    [
      "candidate_bindings",
      "fixture_bindings",
      "hw_ref_id",
      "same_condition_contract",
    ],
    "SCHEDULE_BUILD_INPUT",
    "input",
  );
  if (input.hw_ref_id !== HW_REF_ID) fail("SCHEDULE_CONTRACT", "input.hw_ref_id");
  const candidates = normalizeCandidates(input.candidate_bindings);
  const fixtures = normalizeFixtures(input.fixture_bindings);
  validateSameConditionContract(input.same_condition_contract);
  return {
    candidate_bindings: candidates,
    clock_domain: CLOCK_DOMAIN,
    fixture_bindings: fixtures,
    hw_ref_id: HW_REF_ID,
    network_policy: NETWORK_POLICY,
    order_policy: ORDER_POLICY,
    same_condition_contract_sha256: sha256(
      Buffer.from(encodeCanonicalJson(input.same_condition_contract), "utf8"),
    ),
    seed: SEED,
  };
}

export function validateSameMachineRunnerScheduleRecord(bytes, expectedInput = null) {
  const record = parseCanonicalRecord(bytes);
  if (expectedInput !== null) {
    const expectedContract = buildContract(expectedInput);
    if (!isDeepStrictEqual(record.contract, expectedContract)) {
      fail("SCHEDULE_BINDING", "contract");
    }
  }
  return Object.freeze({
    record: deepFreeze(record),
    scheduleSha256: sha256(bytes),
  });
}

export function buildSameMachineRunnerSchedule(input) {
  const contract = buildContract(input);
  const expected = buildExpectedStagesAndLedger(contract);
  const record = {
    authority: { ...AUTHORITY },
    contract,
    kind: KIND,
    ledger: expected.ledger,
    sampling: {
      ...SAMPLING,
      soak_durations_seconds: [...SAMPLING.soak_durations_seconds],
    },
    schema_version: SCHEMA_VERSION,
    stages: expected.stages,
  };
  validateRecordObject(record);
  const bytes = Buffer.from(encodeCanonicalJson(record), "utf8");
  const validated = validateSameMachineRunnerScheduleRecord(bytes, input);
  return Object.freeze({ bytes, ...validated });
}

export const sameMachineRunnerScheduleContract = Object.freeze({
  authority: AUTHORITY,
  clockDomain: CLOCK_DOMAIN,
  hwRefId: HW_REF_ID,
  kind: KIND,
  networkPolicy: NETWORK_POLICY,
  orderPolicy: ORDER_POLICY,
  sampling: SAMPLING,
  schemaVersion: SCHEMA_VERSION,
  seed: SEED,
  stageKinds: Object.freeze(STAGE_SPECS.map((stage) => stage.kind)),
});
