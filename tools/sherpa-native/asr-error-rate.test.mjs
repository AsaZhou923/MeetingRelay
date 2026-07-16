import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { encodeCanonicalJson } from "../phase0-harness/canonical-json.mjs";

import {
  aggregateDescriptiveAsrScores,
  getAsrScorerProfile,
  normalizeAsrUnits,
  scoreAsrTranscript,
  validateDescriptiveAsrAggregate,
} from "./asr-error-rate.mjs";

test("zh and ja CER plus en WER use deterministic Unicode normalization", () => {
  assert.deepEqual(normalizeAsrUnits(" ＡＢ，Ｃ！ ", "zh"), ["a", "b", "c"]);
  assert.deepEqual(normalizeAsrUnits("カタカナ。 テスト", "ja"), [..."カタカナテスト"]);
  assert.deepEqual(normalizeAsrUnits("  Hello，  WORLD!  ", "en"), ["hello", "world"]);
  assert.deepEqual(normalizeAsrUnits("Cafe\u0301", "en"), ["café"]);
  assert.deepEqual(normalizeAsrUnits("カ\u3099", "ja"), ["ガ"]);
  assert.throws(() => normalizeAsrUnits("\ud800", "zh"), /ASR_SCORE_TEXT/u);
  assert.throws(() => normalizeAsrUnits("x\0y", "zh"), /ASR_SCORE_TEXT/u);
  assert.throws(() => normalizeAsrUnits("\ufeffx", "zh"), /ASR_SCORE_TEXT/u);
  assert.throws(() => normalizeAsrUnits("x", "fr"), /ASR_SCORE_LANGUAGE/u);
});

test("scorer profile binds explicit NFC mappings to committed canonical bytes", async () => {
  const profile = getAsrScorerProfile();
  const bytes = await readFile(new URL("./asr-scorer-profile.json", import.meta.url));
  const manifest = JSON.parse(bytes.toString("utf8"));
  assert.equal(profile.profile_id, "meetingrelay-asr-scorer-profile-v1");
  assert.equal(profile.profile_sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.equal(encodeCanonicalJson(manifest), bytes.toString("utf8"));
  assert.equal(manifest.normalization, "NFC");
  assert.deepEqual(manifest.runtime, { icu: "77.1", node: "24.13.0", unicode: "16.0" });
  assert.deepEqual(manifest.runtime, {
    icu: process.versions.icu,
    node: process.versions.node,
    unicode: process.versions.unicode,
  });
  assert.equal(manifest.aggregation.cross_language_or_metric_macro, "none");
  assert.deepEqual(manifest.tie_break, ["match", "substitution", "deletion", "insertion"]);
  const source = await readFile(new URL("./asr-error-rate.mjs", import.meta.url), "utf8");
  for (const forbidden of ["toLowerCase(", "normalize(\"NFKC\")", "\\p{"]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
  for (const field of ["node", "icu", "unicode"]) {
    const moduleUrl = new URL(`./asr-error-rate.mjs?runtime-mismatch-${field}`, import.meta.url).href;
    const program = [
      `Object.defineProperty(process.versions, ${JSON.stringify(field)}, { value: \"mismatch\" });`,
      `await import(${JSON.stringify(moduleUrl)});`,
    ].join("\n");
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", program], {
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0, field);
    assert.match(result.stderr, /ASR_SCORE_RUNTIME_IDENTITY/u, field);
  }
});

test("scoring and aggregate bounds reject quadratic or forged BigInt inputs", () => {
  assert.throws(
    () => scoreAsrTranscript({ language: "zh", hypothesis: "甲".repeat(4_097), reference: "甲", sampleId: "large", scenario: "clean", tier: "tier-1" }),
    /ASR_SCORE_UNIT_LIMIT/u,
  );
  assert.throws(
    () => scoreAsrTranscript({ language: "en", hypothesis: "x".repeat(16_385), reference: "x", sampleId: "bytes", scenario: "clean", tier: "tier-1" }),
    /ASR_SCORE_TEXT_LIMIT/u,
  );
  const valid = scoreAsrTranscript({ language: "en", hypothesis: "a", reference: "a", sampleId: "valid", scenario: "clean", tier: "tier-1" });
  const forged = structuredClone(valid);
  forged.errorRate.denominator = "9".repeat(100_000);
  assert.throws(() => aggregateDescriptiveAsrScores([forged]), /ASR_SCORE_AGGREGATE/u);

  const imbalanced = structuredClone(valid);
  imbalanced.hypothesisUnitCount = 0;
  assert.throws(() => aggregateDescriptiveAsrScores([imbalanced]), /ASR_SCORE_AGGREGATE/u);

  const nonminimal = structuredClone(scoreAsrTranscript({
    language: "en",
    hypothesis: "a b",
    reference: "a b",
    sampleId: "nonminimal",
    scenario: "clean",
    tier: "tier-1",
  }));
  nonminimal.errors = { deletions: 1, insertions: 1, substitutions: 1, total: 3 };
  nonminimal.errorRate.numerator = "3";
  assert.throws(() => aggregateDescriptiveAsrScores([nonminimal]), /ASR_SCORE_AGGREGATE/u);

  const infeasible = structuredClone(valid);
  infeasible.errors = { deletions: 1, insertions: 1, substitutions: 1, total: 3 };
  infeasible.errorRate.numerator = "3";
  assert.throws(() => aggregateDescriptiveAsrScores([infeasible]), /ASR_SCORE_AGGREGATE/u);
  assert.throws(() => aggregateDescriptiveAsrScores(Array(10_001).fill(valid)), /ASR_SCORE_AGGREGATE/u);
});

test("foundation scorer accepts only tier-1 rows", () => {
  assert.throws(
    () => scoreAsrTranscript({
      hypothesis: "one",
      language: "en",
      reference: "one",
      sampleId: "best-effort",
      scenario: "clean",
      tier: "best-effort",
    }),
    /ASR_SCORE_METADATA/u,
  );
});

test("edit distance reports substitutions deletions and insertions without floats", () => {
  const substitution = scoreAsrTranscript({ language: "en", hypothesis: "a x c", reference: "a b c", sampleId: "s1", scenario: "clean", tier: "tier-1" });
  assert.deepEqual(substitution.errors, { deletions: 0, insertions: 0, substitutions: 1, total: 1 });
  assert.deepEqual(substitution.errorRate, { denominator: "3", numerator: "1", status: "measured" });
  const deletion = scoreAsrTranscript({ language: "zh", hypothesis: "甲丙", reference: "甲乙丙", sampleId: "s2", scenario: "clean", tier: "tier-1" });
  assert.deepEqual(deletion.errors, { deletions: 1, insertions: 0, substitutions: 0, total: 1 });
  const insertion = scoreAsrTranscript({ language: "ja", hypothesis: "甲乙丙", reference: "甲丙", sampleId: "s3", scenario: "noise", tier: "tier-1" });
  assert.deepEqual(insertion.errors, { deletions: 0, insertions: 1, substitutions: 0, total: 1 });
  for (const score of [substitution, deletion, insertion]) {
    assert.equal(score.authority.formal_claims, "none");
    assert.equal(score.authority.production_evidence, false);
    assert.equal(score.assessment_status, "descriptive-only");
  }
});

test("empty output is all deletions and nonempty silence output is an explicit hallucination", () => {
  const empty = scoreAsrTranscript({ language: "en", hypothesis: "", reference: "one two", sampleId: "empty", scenario: "clean", tier: "tier-1" });
  assert.deepEqual(empty.errors, { deletions: 2, insertions: 0, substitutions: 0, total: 2 });
  assert.deepEqual(empty.errorRate, { denominator: "2", numerator: "2", status: "measured" });
  const hallucination = scoreAsrTranscript({ language: "zh", hypothesis: "幻觉", reference: "", sampleId: "silence", scenario: "silence", tier: "tier-1" });
  assert.equal(hallucination.silentHallucination, true);
  assert.deepEqual(hallucination.errorRate, { denominator: "0", numerator: "2", status: "zero-reference-hallucination" });
  const quiet = scoreAsrTranscript({ language: "ja", hypothesis: "", reference: "", sampleId: "quiet", scenario: "silence", tier: "tier-1" });
  assert.equal(quiet.silentHallucination, false);
  assert.equal(quiet.errorRate.status, "zero-reference-correct");
});

test("aggregation exposes only same-metric language and language-scenario macros", () => {
  const rows = [
    ["zh", "clean", "tier-1", "甲乙", "甲乙"],
    ["zh", "noise", "tier-1", "甲乙", "甲"],
    ["ja", "clean", "tier-1", "甲乙", "甲丙"],
    ["en", "clean", "tier-1", "one two", "one two three"],
    ["en", "clean", "tier-1", "one", "bad"],
    ["zh", "silence", "tier-1", "", "幻"],
  ].map(([language, scenario, tier, reference, hypothesis], index) => scoreAsrTranscript({
    hypothesis,
    language,
    reference,
    sampleId: `sample-${index}`,
    scenario,
    tier,
  }));
  const aggregate = aggregateDescriptiveAsrScores(rows);
  assert.equal(aggregate.assessment_status, "descriptive-only");
  assert.deepEqual(aggregate.by_language.map((entry) => entry.key), ["en", "ja", "zh"]);
  assert.deepEqual(aggregate.by_language_scenario.map((entry) => entry.key), ["en/clean", "ja/clean", "zh/clean", "zh/noise", "zh/silence"]);
  assert.equal("by_scenario" in aggregate, false);
  assert.equal("by_tier" in aggregate, false);
  assert.equal("overall" in aggregate, false);
  const zh = aggregate.by_language.find((entry) => entry.key === "zh");
  assert.equal(zh.zero_reference_hallucinations, 1);
  assert.deepEqual(zh.error_sums, {
    deletions: 1,
    hypothesis_units: 4,
    insertions: 1,
    reference_units: 4,
    substitutions: 0,
    total: 2,
  });
  assert.deepEqual(zh.utterance_error_rate_range, {
    maximum: { denominator: "2", numerator: "1", status: "measured" },
    minimum: { denominator: "2", numerator: "0", status: "measured" },
  });
  const forgedSum = structuredClone(aggregate);
  forgedSum.by_language[0].error_sums.total += 1;
  assert.throws(() => validateDescriptiveAsrAggregate(forgedSum, rows), /ASR_SCORE_AGGREGATE_OUTPUT/u);

  const forgedMacro = structuredClone(aggregate);
  forgedMacro.by_language.find((entry) => entry.key === "en").macro_error_rate = {
    denominator: "2",
    numerator: "1",
    status: "measured",
  };
  forgedMacro.by_language_scenario.find((entry) => entry.key === "en/clean").macro_error_rate = {
    denominator: "2",
    numerator: "1",
    status: "measured",
  };
  assert.throws(() => validateDescriptiveAsrAggregate(forgedMacro, rows), /ASR_SCORE_AGGREGATE_OUTPUT/u);

  const forgedRange = structuredClone(aggregate);
  forgedRange.by_language[0].utterance_error_rate_range.minimum =
    forgedRange.by_language[0].utterance_error_rate_range.maximum;
  assert.throws(() => validateDescriptiveAsrAggregate(forgedRange, rows), /ASR_SCORE_AGGREGATE_OUTPUT/u);

  const forgedCount = structuredClone(aggregate);
  forgedCount.by_language[0].sample_count += 1;
  assert.throws(() => validateDescriptiveAsrAggregate(forgedCount, rows), /ASR_SCORE_AGGREGATE_OUTPUT/u);

  const forgedFloat = structuredClone(aggregate);
  forgedFloat.by_language[0].error_sums.insertions = 0.5;
  assert.throws(() => validateDescriptiveAsrAggregate(forgedFloat, rows), /ASR_SCORE_AGGREGATE_OUTPUT/u);
  assert.throws(() => validateDescriptiveAsrAggregate(aggregate), /ASR_SCORE_AGGREGATE_OUTPUT/u);
  assert.throws(() => validateDescriptiveAsrAggregate(aggregate, rows.slice(1)), /ASR_SCORE_AGGREGATE_OUTPUT/u);
  assert.equal(JSON.stringify(aggregate).includes("passed"), false);
  assert.equal(JSON.stringify(aggregate).includes("threshold"), false);
});

test("language macro weights nonempty scenario macros equally instead of masking by sample count", () => {
  const rows = [
    ["clean-1", "clean", "甲", "甲"],
    ["clean-2", "clean", "乙", "乙"],
    ["clean-3", "clean", "丙", "丙"],
    ["noise-1", "noise", "丁", "错"],
  ].map(([sampleId, scenario, reference, hypothesis]) => scoreAsrTranscript({
    hypothesis,
    language: "zh",
    reference,
    sampleId,
    scenario,
    tier: "tier-1",
  }));
  const aggregate = aggregateDescriptiveAsrScores(rows);
  assert.deepEqual(aggregate.by_language_scenario.map((entry) => entry.macro_error_rate), [
    { denominator: "1", numerator: "0", status: "measured" },
    { denominator: "1", numerator: "1", status: "measured" },
  ]);
  assert.deepEqual(aggregate.by_language[0].macro_error_rate, {
    denominator: "2",
    numerator: "1",
    status: "measured",
  });
});

test("exact macro supports LCM denominators larger than machine-sized decimal fields", () => {
  const primeLengths = [11, 13, 17, 19, 23, 29, 31, 37, 41, 43];
  const rows = primeLengths.map((length, index) => {
    const units = Array.from({ length }, (_, unitIndex) => `w${index}_${unitIndex}`);
    return scoreAsrTranscript({
      hypothesis: units.slice(1).join(" "),
      language: "en",
      reference: units.join(" "),
      sampleId: `prime-${length}`,
      scenario: "clean",
      tier: "tier-1",
    });
  });
  const aggregate = aggregateDescriptiveAsrScores(rows);
  assert.ok(aggregate.by_language_scenario[0].macro_error_rate.denominator.length > 9);
  assert.doesNotThrow(() => validateDescriptiveAsrAggregate(aggregate, rows));

  const forged = structuredClone(aggregate);
  forged.by_language_scenario[0].macro_error_rate.denominator = "9".repeat(100_000);
  assert.throws(() => validateDescriptiveAsrAggregate(forged, rows), /ASR_SCORE_AGGREGATE_OUTPUT/u);
});
