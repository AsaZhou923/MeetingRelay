import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  open,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  AsrQualityRunPolicyError,
  buildAsrQualityRunPolicy,
  readPinnedAsrQualityRunPolicy,
  validateAsrQualityRunPolicyBytes,
  validateAsrQualityRunPolicyCoverage,
} from "./asr-quality-run-policy.mjs";

const FIXTURE_SHA256 = "dd64f5de123bd07a4d2d5d9a93f5012fe53aa691f8116b5f212d127388a649a8";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function fixtureBytes() {
  return readFile(new URL("./asr-quality-run-policy.json", import.meta.url));
}

async function fixturePolicy() {
  return JSON.parse((await fixtureBytes()).toString("utf8"));
}

function corpus(samples = [
  ["01-en", "en", "synthetic-non-speech", "tier-1"],
  ["02-ja", "ja", "synthetic-non-speech", "tier-1"],
  ["03-zh", "zh", "synthetic-non-speech", "tier-1"],
]) {
  return {
    samples: samples.map(([sampleId, language, scenario, tier]) => ({
      language,
      sampleId,
      scenario,
      tier,
    })),
  };
}

async function temporaryDirectory(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "meetingrelay-run-policy-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  return root;
}

function canonicalBytes(policy) {
  return Buffer.from(`${JSON.stringify(policy)}\n`, "utf8");
}

test("committed policy is canonical, externally digest-pinned, and builder-identical", async () => {
  const bytes = await fixtureBytes();
  const policy = await fixturePolicy();
  assert.equal(bytes.at(-1), 0x0a);
  assert.equal(bytes.includes(0x0d), false);
  assert.equal(bytes.length, 421);
  assert.equal(sha256(bytes), FIXTURE_SHA256);

  const validated = validateAsrQualityRunPolicyBytes(bytes);
  assert.equal(validated.policySha256, FIXTURE_SHA256);
  assert.deepEqual(validated.policy, policy);
  const built = buildAsrQualityRunPolicy(policy);
  assert.deepEqual(built.bytes, bytes);
  assert.equal(built.policySha256, FIXTURE_SHA256);
  assert.deepEqual(Object.keys(policy).sort(), [
    "coverage_scope",
    "exclusion_policy",
    "kind",
    "max_attempts",
    "quality_gate_status",
    "required_slices",
    "schema_version",
  ]);
  assert.deepEqual(policy.required_slices.map((slice) => slice.language), ["en", "ja", "zh"]);
});

test("canonical JSON, exact fields, fixed scope, and authority ceilings fail closed", async () => {
  const bytes = await fixtureBytes();
  const policy = await fixturePolicy();
  const cases = [
    ["pretty", Buffer.from(`${JSON.stringify(policy, null, 2)}\n`, "utf8")],
    ["missing newline", bytes.subarray(0, -1)],
    ["CRLF", Buffer.from(`${bytes.toString("utf8").trimEnd()}\r\n`, "utf8")],
    ["BOM", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes])],
  ];
  const mutate = (name, callback) => {
    const value = structuredClone(policy);
    callback(value);
    cases.push([name, canonicalBytes(value)]);
  };
  mutate("missing required field", (value) => { delete value.exclusion_policy; });
  mutate("unknown field", (value) => { value.thresholds = []; });
  mutate("kind", (value) => { value.kind = "meetingrelay-asr-quality-run-policy-v2"; });
  mutate("schema", (value) => { value.schema_version = "2.0"; });
  mutate("coverage authority", (value) => { value.coverage_scope = "real-quality"; });
  mutate("attempt inflation", (value) => { value.max_attempts = 2; });
  mutate("exclusion inflation", (value) => { value.exclusion_policy = "drop-failures"; });
  mutate("quality promotion", (value) => { value.quality_gate_status = "passed"; });
  for (const field of [
    "default_status",
    "formal_claims",
    "pass",
    "production_evidence",
    "publishability_status",
    "ranking_status",
    "threshold_manifest",
  ]) {
    mutate(`forbidden ${field}`, (value) => { value[field] = "forbidden"; });
  }

  for (const [name, invalidBytes] of cases) {
    assert.throws(
      () => validateAsrQualityRunPolicyBytes(invalidBytes),
      AsrQualityRunPolicyError,
      name,
    );
  }
  assert.throws(() => buildAsrQualityRunPolicy({ required_slices: policy.required_slices }));
});

test("slice fields, tier/language, identifiers, duplicate keys, and canonical order fail closed", async () => {
  const policy = await fixturePolicy();
  const mutate = (callback) => {
    const value = structuredClone(policy);
    callback(value);
    return canonicalBytes(value);
  };
  const cases = [
    mutate((value) => { value.required_slices = []; }),
    mutate((value) => { value.required_slices[0].unknown = true; }),
    mutate((value) => { value.required_slices[0].language = "fr"; }),
    mutate((value) => { value.required_slices[0].tier = "best-effort"; }),
    mutate((value) => { value.required_slices[0].scenario = "not NFC e\u0301"; }),
    mutate((value) => { value.required_slices[0].scenario = "bad/scenario"; }),
    mutate((value) => { value.required_slices[1] = structuredClone(value.required_slices[0]); }),
    mutate((value) => { value.required_slices.reverse(); }),
  ];
  for (const invalidBytes of cases) {
    assert.throws(() => validateAsrQualityRunPolicyBytes(invalidBytes));
  }
});

test("coverage requires an exact observed language-scenario-tier slice set", async () => {
  const policy = await fixturePolicy();
  const result = validateAsrQualityRunPolicyCoverage(policy, corpus());
  assert.deepEqual(result, {
    observedSliceCount: 3,
    requiredSliceCount: 3,
    sampleCount: 3,
    sliceKeys: [
      "en/synthetic-non-speech/tier-1",
      "ja/synthetic-non-speech/tier-1",
      "zh/synthetic-non-speech/tier-1",
    ],
  });

  assert.throws(
    () => validateAsrQualityRunPolicyCoverage(policy, corpus([
      ["01-en", "en", "synthetic-non-speech", "tier-1"],
      ["02-ja", "ja", "synthetic-non-speech", "tier-1"],
    ])),
    { code: "ASR_RUN_POLICY_COVERAGE" },
  );
  assert.throws(
    () => validateAsrQualityRunPolicyCoverage(policy, corpus([
      ["01-en", "en", "synthetic-non-speech", "tier-1"],
      ["02-ja", "ja", "synthetic-non-speech", "tier-1"],
      ["03-zh", "zh", "synthetic-non-speech", "tier-1"],
      ["04-zh-extra", "zh", "synthetic-extra", "tier-1"],
    ])),
    { code: "ASR_RUN_POLICY_COVERAGE" },
  );
  const duplicateSliceResult = validateAsrQualityRunPolicyCoverage(policy, corpus([
    ["01-en", "en", "synthetic-non-speech", "tier-1"],
    ["02-en", "en", "synthetic-non-speech", "tier-1"],
    ["03-ja", "ja", "synthetic-non-speech", "tier-1"],
    ["04-zh", "zh", "synthetic-non-speech", "tier-1"],
  ]));
  assert.equal(duplicateSliceResult.sampleCount, 4);
  assert.equal(duplicateSliceResult.observedSliceCount, 3);
  assert.throws(
    () => validateAsrQualityRunPolicyCoverage(policy, corpus([
      ["02-en", "en", "synthetic-non-speech", "tier-1"],
      ["01-ja", "ja", "synthetic-non-speech", "tier-1"],
      ["03-zh", "zh", "synthetic-non-speech", "tier-1"],
    ])),
    { code: "ASR_RUN_POLICY_CORPUS_SAMPLE" },
  );
});

test("pinned file read requires an external digest and stable path/handle identity", async (t) => {
  const root = await temporaryDirectory(t);
  const policyPath = path.join(root, "policy.json");
  const bytes = await fixtureBytes();
  await writeFile(policyPath, bytes, { flag: "wx" });

  const read = await readPinnedAsrQualityRunPolicy({
    expectedPolicySha256: FIXTURE_SHA256,
    policyPath,
  });
  assert.equal(read.policySha256, FIXTURE_SHA256);
  assert.equal(read.policy.quality_gate_status, "not-assessed");
  await assert.rejects(readPinnedAsrQualityRunPolicy({
    expectedPolicySha256: sha256("caller-guessed-wrong"),
    policyPath,
  }), { code: "ASR_RUN_POLICY_TRUST_MISMATCH" });
  await assert.rejects(readPinnedAsrQualityRunPolicy({
    expectedPolicySha256: "0".repeat(64),
    policyPath,
  }), { code: "ASR_RUN_POLICY_TRUST_REQUIRED" });
  await assert.rejects(readPinnedAsrQualityRunPolicy({
    expectedPolicySha256: FIXTURE_SHA256,
    policyPath: "relative-policy.json",
  }), { code: "ASR_RUN_POLICY_PATH" });

  const alternatePolicy = await fixturePolicy();
  alternatePolicy.required_slices[0].scenario = "synthetic-non-speecx";
  const alternateBytes = buildAsrQualityRunPolicy(alternatePolicy).bytes;
  assert.equal(alternateBytes.length, bytes.length);
  await assert.rejects(readPinnedAsrQualityRunPolicy({
    expectedPolicySha256: FIXTURE_SHA256,
    policyPath,
  }, {
    openReadFile: async () => {
      const metadataHandle = await open(policyPath, "r");
      const metadata = await metadataHandle.stat({ bigint: true });
      await metadataHandle.close();
      let pass = 0;
      return {
        close: async () => {},
        read: async (buffer, offset, length, position) => {
          if (position >= bytes.length) return { buffer, bytesRead: 0 };
          if (position === 0) pass += 1;
          const source = pass === 1 ? bytes : alternateBytes;
          const bytesRead = Math.min(length, source.length - position);
          source.copy(buffer, offset, position, position + bytesRead);
          return { buffer, bytesRead };
        },
        stat: async () => metadata,
      };
    },
  }), { code: "ASR_RUN_POLICY_TRUST_MISMATCH" });
});

test("pinned file postflight rejects pathname replacement after stable reads", async (t) => {
  const root = await temporaryDirectory(t);
  const policyPath = path.join(root, "policy.json");
  const bytes = await fixtureBytes();
  const alternatePolicy = await fixturePolicy();
  alternatePolicy.required_slices[0].scenario = "synthetic-non-speecx";
  const alternateBytes = buildAsrQualityRunPolicy(alternatePolicy).bytes;
  await writeFile(policyPath, bytes, { flag: "wx" });

  await assert.rejects(readPinnedAsrQualityRunPolicy({
    expectedPolicySha256: FIXTURE_SHA256,
    policyPath,
  }, {
    openReadFile: async (...arguments_) => {
      const handle = await open(...arguments_);
      return {
        close: async () => {
          await handle.close();
          await rm(policyPath);
          await writeFile(policyPath, alternateBytes, { flag: "wx" });
        },
        read: (...values) => handle.read(...values),
        stat: (...values) => handle.stat(...values),
      };
    },
  }), { code: "ASR_RUN_POLICY_INPUT_CHANGED" });
  assert.deepEqual(await readFile(policyPath), alternateBytes);
});

test("schema and fixture freeze the same strict non-authoritative contract", async () => {
  const schema = JSON.parse(await readFile(new URL("./asr-quality-run-policy.schema.json", import.meta.url), "utf8"));
  const fixture = await fixturePolicy();
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.kind.const, fixture.kind);
  assert.equal(schema.properties.schema_version.const, fixture.schema_version);
  assert.equal(schema.properties.coverage_scope.const, "synthetic-mechanics-only");
  assert.equal(schema.properties.exclusion_policy.const, "none");
  assert.equal(schema.properties.max_attempts.const, 1);
  assert.equal(schema.properties.quality_gate_status.const, "not-assessed");
  assert.equal(schema.properties.required_slices.items.$ref, "#/$defs/slice");
  assert.equal(schema.$defs.slice.additionalProperties, false);
  assert.deepEqual(schema.$defs.slice.properties.language.enum, ["en", "ja", "zh"]);
  assert.equal(schema.$defs.slice.properties.tier.const, "tier-1");
  assert.deepEqual([...schema.required].sort(), Object.keys(fixture).sort());
  for (const forbidden of [
    "default_status",
    "formal_claims",
    "pass",
    "production_evidence",
    "publishability_status",
    "ranking_status",
    "thresholds",
  ]) {
    assert.equal(Object.hasOwn(schema.properties, forbidden), false, forbidden);
    assert.equal(Object.hasOwn(fixture, forbidden), false, forbidden);
  }
});
