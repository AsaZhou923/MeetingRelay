import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { encodeCanonicalJson } from "../phase0-harness/canonical-json.mjs";
import {
  SameMachineRunnerScheduleError,
  buildSameMachineRunnerSchedule,
  seededRoundRobinOrder,
  sameMachineRunnerScheduleContract,
  validateSameMachineRunnerScheduleRecord,
} from "./same-machine-runner-schedule.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHA = (digit) => digit.repeat(64);

function inputFixture() {
  return {
    candidate_bindings: [
      {
        candidate_id: "candidate-zeta",
        candidate_manifest_sha256: SHA("1"),
        role: "sidecar-candidate",
      },
      {
        candidate_id: "candidate-alpha",
        candidate_manifest_sha256: SHA("2"),
        role: "native-candidate",
      },
      {
        candidate_id: "quality-oracle",
        candidate_manifest_sha256: SHA("3"),
        role: "oracle-only",
      },
    ],
    fixture_bindings: [
      {
        audio_sha256: SHA("4"),
        fixture_id: "fixture-ja-meeting",
        pcm_sha256: SHA("5"),
        reference_sha256: SHA("6"),
        scenario_id: "meeting-ja",
      },
      {
        audio_sha256: SHA("7"),
        fixture_id: "fixture-en-meeting",
        pcm_sha256: SHA("8"),
        reference_sha256: SHA("9"),
        scenario_id: "meeting-en",
      },
    ],
    hw_ref_id: "hw-ref-contract-fixture-001",
    same_condition_contract: {
      audio_playback_path: "test-fixtures/calibration.wav",
      batch_size: "1",
      cooling_mode: "not-measured",
      endpoint_parameters: {
        path: "assets/vad-endpoint-plan.json",
        sha256: SHA("a"),
      },
      execution_provider: "cpu",
      log_level: "info",
      model_sha256: SHA("b"),
      parameter_sha256: SHA("c"),
      pcm_sha256: SHA("d"),
      power_plan: "not-measured",
      quantization: "int8",
      thread_count: "1",
      translation_fixture_ids: [],
      vad_parameters: {
        path: "assets/vad-endpoint-plan.json",
        sha256: SHA("a"),
      },
      warmup_plan: {
        path: "assets/warmup-plan.json",
        sha256: SHA("e"),
      },
    },
  };
}

function clone(value) {
  return structuredClone(value);
}

function encodedMutation(built, mutate) {
  const record = clone(built.record);
  mutate(record);
  return Buffer.from(encodeCanonicalJson(record), "utf8");
}

function assertScheduleError(bytes, code, expectedInput = null) {
  assert.throws(
    () => validateSameMachineRunnerScheduleRecord(bytes, expectedInput),
    (error) =>
      error instanceof SameMachineRunnerScheduleError && error.code === code,
  );
}

test("builder emits a canonical path-free deterministic seeded round-robin ledger", () => {
  const firstInput = inputFixture();
  const secondInput = inputFixture();
  secondInput.candidate_bindings.reverse();
  secondInput.fixture_bindings.reverse();
  const first = buildSameMachineRunnerSchedule(firstInput);
  const second = buildSameMachineRunnerSchedule(secondInput);

  assert.deepEqual(first.bytes, second.bytes);
  assert.equal(first.scheduleSha256, second.scheduleSha256);
  assert.equal(first.record.ledger.length, 282);
  assert.deepEqual(
    first.record.contract.candidate_bindings.map((entry) => entry.candidate_id),
    ["candidate-alpha", "candidate-zeta", "quality-oracle"],
  );
  assert.deepEqual(
    first.record.contract.fixture_bindings.map((entry) => entry.fixture_id),
    ["fixture-en-meeting", "fixture-ja-meeting"],
  );
  assert.deepEqual(
    first.record.stages.map((stage) => [stage.kind, stage.planned_entry_count]),
    [
      ["preflight", "6"],
      ["publishability", "6"],
      ["contract", "6"],
      ["quality", "6"],
      ["cold", "60"],
      ["warmup", "6"],
      ["warm", "180"],
      ["soak-fault", "6"],
      ["postflight", "6"],
    ],
  );
  assert.equal(
    first.record.ledger.every(
      (entry, index) => entry.sequence === String(index + 1),
    ),
    true,
  );
  const oracleEntries = first.record.ledger.filter(
    (entry) => entry.candidate_id === "quality-oracle",
  );
  assert.equal(oracleEntries.length, 94);
  assert.equal(oracleEntries.every((entry) => entry.lane === "oracle"), true);
  assert.equal(
    first.record.ledger
      .filter((entry) => entry.stage === "warm")
      .every((entry) => Number(entry.planned_sample_index) <= 30),
    true,
  );
  const serialized = first.bytes.toString("utf8");
  assert.doesNotMatch(serialized, /test-fixtures|assets\/|\\/u);
  assert.doesNotMatch(serialized, /"path"\s*:/u);
  assert.deepEqual(
    validateSameMachineRunnerScheduleRecord(first.bytes, firstInput).record,
    first.record,
  );
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.record), true);
  assert.equal(Object.isFrozen(first.record.ledger), true);
  assert.equal(Object.isFrozen(first.record.ledger[0]), true);
});

test("seeded round-robin helper is input-order invariant and fair for two through four participants", () => {
  for (let count = 2; count <= 4; count += 1) {
    const participants = Array.from(
      { length: count },
      (_, index) => `participant-${index + 1}`,
    );
    const reversed = [...participants].reverse();
    const rounds = Array.from({ length: count }, (_, round) =>
      seededRoundRobinOrder(participants, "42", round)
    );
    assert.deepEqual(
      rounds,
      Array.from({ length: count }, (_, round) =>
        seededRoundRobinOrder(reversed, "42", round)
      ),
    );
    for (let position = 0; position < count; position += 1) {
      assert.deepEqual(
        new Set(rounds.map((order) => order[position])),
        new Set(participants),
      );
    }
    assert.equal(rounds.every((order) => Object.isFrozen(order)), true);
  }
});

test("record authority is plan-only and sampling values are constraints, not results", () => {
  const record = buildSameMachineRunnerSchedule(inputFixture()).record;
  assert.deepEqual(record.authority, sameMachineRunnerScheduleContract.authority);
  assert.deepEqual(record.sampling, {
    cold_runs: "10",
    final_event_count: "10000",
    soak_durations_seconds: ["1800", "7200", "14400"],
    warm_samples_per_scenario: "30",
    warmup_runs: "1",
  });
  assert.equal(record.authority.statistics, "not-computed");
  assert.equal(record.authority.confidence_interval, "not-computed");
  assert.equal(record.authority.quality, "not-assessed");
  assert.equal(record.authority.formal_claims, "none");
  assert.equal(record.authority.production_evidence, false);
  assert.equal(record.authority.public_distribution, false);
  for (const status of ["selection", "ranking", "default", "fallback"]) {
    assert.equal(record.authority[status], "none");
  }
  assert.equal(
    record.ledger.some((entry) =>
      Object.keys(entry).some((key) =>
        /statistics|confidence|quality_pass|rank|default|selection/u.test(key)
      )
    ),
    false,
  );
});

test("JSON schema root shape and constants stay in parity with the runtime contract", async () => {
  const schema = JSON.parse(
    await readFile(
      path.join(HERE, "same-machine-runner-schedule.schema.json"),
      "utf8",
    ),
  );
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual([...schema.required].sort(), [
    "authority",
    "contract",
    "kind",
    "ledger",
    "sampling",
    "schema_version",
    "stages",
  ]);
  assert.equal(schema.properties.kind.const, sameMachineRunnerScheduleContract.kind);
  assert.equal(
    schema.properties.schema_version.const,
    sameMachineRunnerScheduleContract.schemaVersion,
  );
  assert.equal(
    schema.properties.contract.properties.hw_ref_id.const,
    sameMachineRunnerScheduleContract.hwRefId,
  );
  assert.equal(
    schema.properties.contract.properties.clock_domain.const,
    sameMachineRunnerScheduleContract.clockDomain,
  );
  assert.equal(
    schema.properties.contract.properties.network_policy.const,
    sameMachineRunnerScheduleContract.networkPolicy,
  );
  assert.equal(
    schema.properties.contract.properties.order_policy.const,
    sameMachineRunnerScheduleContract.orderPolicy,
  );
  assert.deepEqual(
    schema.properties.stages.prefixItems.map((entry) =>
      schema.$defs[entry.$ref.split("/").at(-1)].allOf[1].properties.kind.const
    ),
    sameMachineRunnerScheduleContract.stageKinds,
  );
  for (const [key, value] of Object.entries(
    sameMachineRunnerScheduleContract.authority,
  )) {
    assert.deepEqual(schema.properties.authority.properties[key].const, value);
  }
  for (const [key, value] of Object.entries(
    sameMachineRunnerScheduleContract.sampling,
  )) {
    assert.deepEqual(schema.properties.sampling.properties[key].const, value);
  }
});

test("stage omissions, reordering, count drift, and schedule drift fail closed", async (context) => {
  const built = buildSameMachineRunnerSchedule(inputFixture());
  const cases = [
    {
      code: "SCHEDULE_STAGE_ORDER",
      name: "missing stage",
      mutate(record) {
        record.stages.pop();
      },
    },
    {
      code: "SCHEDULE_STAGE_ORDER",
      name: "reordered stages",
      mutate(record) {
        [record.stages[4], record.stages[5]] = [
          record.stages[5],
          record.stages[4],
        ];
      },
    },
    {
      code: "SCHEDULE_STAGE_ORDER",
      name: "cold count drift",
      mutate(record) {
        record.stages[4].planned_entry_count = "59";
      },
    },
    {
      code: "SCHEDULE_COUNT",
      name: "missing ledger entry",
      mutate(record) {
        record.ledger.pop();
      },
    },
    {
      code: "SCHEDULE_DRIFT",
      name: "duplicate ledger entry",
      mutate(record) {
        record.ledger[1] = clone(record.ledger[0]);
      },
    },
    {
      code: "SCHEDULE_DRIFT",
      name: "fixture omission from a planned slot",
      mutate(record) {
        record.ledger[0].fixture_id = record.contract.fixture_bindings.find(
          (fixture) => fixture.fixture_id !== record.ledger[0].fixture_id,
        ).fixture_id;
      },
    },
  ];
  for (const case_ of cases) {
    await context.test(case_.name, () => {
      assertScheduleError(encodedMutation(built, case_.mutate), case_.code);
    });
  }
});

test("candidate and fixture binding duplicates or omissions fail closed", async (context) => {
  const built = buildSameMachineRunnerSchedule(inputFixture());
  const cases = [
    {
      code: "SCHEDULE_CANDIDATE_DUPLICATE",
      name: "duplicate candidate ID",
      mutate(record) {
        record.contract.candidate_bindings[1].candidate_id =
          record.contract.candidate_bindings[0].candidate_id;
      },
    },
    {
      code: "SCHEDULE_FIXTURE_DUPLICATE",
      name: "duplicate fixture ID",
      mutate(record) {
        record.contract.fixture_bindings[1].fixture_id =
          record.contract.fixture_bindings[0].fixture_id;
      },
    },
    {
      code: "SCHEDULE_FIXTURE_DUPLICATE",
      name: "duplicate warm-sampling scenario",
      mutate(record) {
        record.contract.fixture_bindings[1].scenario_id =
          record.contract.fixture_bindings[0].scenario_id;
      },
    },
    {
      code: "SCHEDULE_STAGE_ORDER",
      name: "candidate binding omitted",
      mutate(record) {
        record.contract.candidate_bindings.pop();
      },
    },
    {
      code: "SCHEDULE_STAGE_ORDER",
      name: "fixture binding omitted",
      mutate(record) {
        record.contract.fixture_bindings.pop();
      },
    },
  ];
  for (const case_ of cases) {
    await context.test(case_.name, () => {
      assertScheduleError(encodedMutation(built, case_.mutate), case_.code);
    });
  }
});

test("oracle-lane mixing and clock-domain drift fail closed", async (context) => {
  const built = buildSameMachineRunnerSchedule(inputFixture());
  await context.test("oracle inserted into ranking lane", () => {
    assertScheduleError(
      encodedMutation(built, (record) => {
        record.ledger.find(
          (entry) => entry.candidate_id === "quality-oracle",
        ).lane = "ranking";
      }),
      "SCHEDULE_ORACLE_LANE",
    );
  });
  await context.test("entry clock domain differs", () => {
    assertScheduleError(
      encodedMutation(built, (record) => {
        record.ledger[0].clock_domain = "wall-clock";
      }),
      "SCHEDULE_CLOCK_DOMAIN",
    );
  });
  await context.test("contract clock domain differs", () => {
    assertScheduleError(
      encodedMutation(built, (record) => {
        record.contract.clock_domain = "wall-clock";
      }),
      "SCHEDULE_CONTRACT",
    );
  });
});

test("unknown fields and result-like statistics, CI, quality, rank, default, or selection fields fail closed", async (context) => {
  const built = buildSameMachineRunnerSchedule(inputFixture());
  const cases = [
    ["unknown root field", (record) => { record.unexpected = true; }, "SCHEDULE_FIELDS"],
    ["statistics result", (record) => { record.statistics = {}; }, "SCHEDULE_FIELDS"],
    ["confidence interval result", (record) => { record.confidence_interval = {}; }, "SCHEDULE_FIELDS"],
    ["quality pass result", (record) => { record.ledger[0].quality_pass = true; }, "SCHEDULE_ENTRY_FIELDS"],
    ["rank result", (record) => { record.ledger[0].rank = 1; }, "SCHEDULE_ENTRY_FIELDS"],
    ["default result", (record) => { record.default_candidate_id = "candidate-alpha"; }, "SCHEDULE_FIELDS"],
    ["selection result", (record) => { record.ledger[0].selection = "winner"; }, "SCHEDULE_ENTRY_FIELDS"],
    ["unknown fixture field", (record) => { record.contract.fixture_bindings[0].path = "fixture.wav"; }, "SCHEDULE_FIXTURE_FIELDS"],
  ];
  for (const [name, mutate, code] of cases) {
    await context.test(name, () => {
      assertScheduleError(encodedMutation(built, mutate), code);
    });
  }
});

test("authority escalation and sampling-result drift fail closed", async (context) => {
  const built = buildSameMachineRunnerSchedule(inputFixture());
  const cases = [
    ["production evidence", (record) => { record.authority.production_evidence = true; }, "SCHEDULE_AUTHORITY"],
    ["public distribution", (record) => { record.authority.public_distribution = true; }, "SCHEDULE_AUTHORITY"],
    ["formal claim", (record) => { record.authority.formal_claims = "eligible"; }, "SCHEDULE_AUTHORITY"],
    ["computed statistics", (record) => { record.authority.statistics = "computed"; }, "SCHEDULE_AUTHORITY"],
    ["assessed quality", (record) => { record.authority.quality = "passed"; }, "SCHEDULE_AUTHORITY"],
    ["selected candidate", (record) => { record.authority.selection = "selected"; }, "SCHEDULE_AUTHORITY"],
    ["cold result drift", (record) => { record.sampling.cold_runs = "9"; }, "SCHEDULE_SAMPLING"],
    ["warm result drift", (record) => { record.sampling.warm_samples_per_scenario = "29"; }, "SCHEDULE_SAMPLING"],
    ["soak constraint drift", (record) => { record.sampling.soak_durations_seconds[0] = "1799"; }, "SCHEDULE_SAMPLING"],
    ["final event constraint drift", (record) => { record.sampling.final_event_count = "9999"; }, "SCHEDULE_SAMPLING"],
  ];
  for (const [name, mutate, code] of cases) {
    await context.test(name, () => {
      assertScheduleError(encodedMutation(built, mutate), code);
    });
  }
});

test("candidate, fixture hash, same-condition, and HW-REF joins are verified against expected input", async (context) => {
  const input = inputFixture();
  const built = buildSameMachineRunnerSchedule(input);
  const cases = [
    ["candidate hash drift", (expected) => { expected.candidate_bindings[0].candidate_manifest_sha256 = SHA("f"); }],
    ["fixture hash drift", (expected) => { expected.fixture_bindings[0].audio_sha256 = SHA("f"); }],
    ["same-condition drift", (expected) => { expected.same_condition_contract.thread_count = "2"; }],
  ];
  for (const [name, mutate] of cases) {
    await context.test(name, () => {
      const expected = inputFixture();
      mutate(expected);
      assertScheduleError(built.bytes, "SCHEDULE_BINDING", expected);
    });
  }
  await context.test("HW-REF drift", () => {
    const expected = inputFixture();
    expected.hw_ref_id = "hw-ref-other";
    assertScheduleError(built.bytes, "SCHEDULE_CONTRACT", expected);
  });
});

test("seed, canonical UTF-8 LF bytes, schedule order, and digest identity fail closed", async (context) => {
  const input = inputFixture();
  const built = buildSameMachineRunnerSchedule(input);
  await context.test("seed 42 to 43 drift", () => {
    assertScheduleError(
      encodedMutation(built, (record) => {
        record.contract.seed = "43";
      }),
      "SCHEDULE_CONTRACT",
    );
  });
  await context.test("ledger reorder", () => {
    assertScheduleError(
      encodedMutation(built, (record) => {
        [record.ledger[0], record.ledger[1]] = [
          record.ledger[1],
          record.ledger[0],
        ];
      }),
      "SCHEDULE_DRIFT",
    );
  });
  await context.test("compact noncanonical JSON", () => {
    assertScheduleError(
      Buffer.from(`${JSON.stringify(built.record)}\n`, "utf8"),
      "SCHEDULE_CANONICAL_JSON",
    );
  });
  await context.test("CRLF encoding", () => {
    assertScheduleError(
      Buffer.from(built.bytes.toString("utf8").replaceAll("\n", "\r\n"), "utf8"),
      "SCHEDULE_CANONICAL_JSON",
    );
  });
  await context.test("same-condition change changes schedule digest identity", () => {
    const changed = inputFixture();
    changed.same_condition_contract.thread_count = "2";
    const rebuilt = buildSameMachineRunnerSchedule(changed);
    assert.notEqual(rebuilt.scheduleSha256, built.scheduleSha256);
    assert.notEqual(
      rebuilt.record.contract.same_condition_contract_sha256,
      built.record.contract.same_condition_contract_sha256,
    );
  });
});

test("builder rejects duplicate source identities and remains offline-pure", async () => {
  const duplicateCandidate = inputFixture();
  duplicateCandidate.candidate_bindings[1].candidate_id =
    duplicateCandidate.candidate_bindings[0].candidate_id;
  assert.throws(
    () => buildSameMachineRunnerSchedule(duplicateCandidate),
    (error) => error?.code === "SCHEDULE_CANDIDATE_DUPLICATE",
  );

  const duplicateFixture = inputFixture();
  duplicateFixture.fixture_bindings[1] = clone(
    duplicateFixture.fixture_bindings[0],
  );
  duplicateFixture.fixture_bindings[1].fixture_id = "another-fixture-id";
  assert.throws(
    () => buildSameMachineRunnerSchedule(duplicateFixture),
    (error) => error?.code === "SCHEDULE_FIXTURE_DUPLICATE",
  );

  const source = await readFile(
    path.join(HERE, "same-machine-runner-schedule.mjs"),
    "utf8",
  );
  assert.doesNotMatch(source, /node:(?:fs|child_process|os|process|worker_threads)/u);
  assert.doesNotMatch(
    source,
    /\b(?:spawn|execFile|readFile|createReadStream|Date\.|performance\.|Math\.random|process\.)/u,
  );
});
