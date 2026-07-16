import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { encodeCanonicalJson } from "../phase0-harness/canonical-json.mjs";

const LANGUAGES = new Set(["en", "ja", "zh"]);
const TIERS = new Set(["tier-1"]);
const IDENTIFIER = /^[A-Za-z0-9._-]{1,128}$/u;
const MAX_TEXT_UTF8_BYTES = 16_384;
const MAX_NORMALIZED_UNITS = 4_096;
const MAX_AGGREGATE_SCORES = 10_000;
const MAX_AGGREGATE_RATE_DECIMAL_DIGITS = 4_096;
const REQUIRED_RUNTIME_IDENTITY = Object.freeze({
  icu: "77.1",
  node: "24.13.0",
  unicode: "16.0",
});
const PROFILE_BYTES = readFileSync(new URL("./asr-scorer-profile.json", import.meta.url));
const PROFILE = JSON.parse(PROFILE_BYTES.toString("utf8"));
if (encodeCanonicalJson(PROFILE) !== PROFILE_BYTES.toString("utf8")) {
  throw new TypeError("ASR_SCORE_PROFILE_CANONICAL");
}
const ACTUAL_RUNTIME_IDENTITY = {
  icu: process.versions.icu,
  node: process.versions.node,
  unicode: process.versions.unicode,
};
if (
  encodeCanonicalJson(PROFILE.runtime) !== encodeCanonicalJson(REQUIRED_RUNTIME_IDENTITY) ||
  encodeCanonicalJson(ACTUAL_RUNTIME_IDENTITY) !== encodeCanonicalJson(REQUIRED_RUNTIME_IDENTITY)
) {
  throw new TypeError("ASR_SCORE_RUNTIME_IDENTITY");
}
const SCORER_PROFILE = Object.freeze({
  profile_id: PROFILE.kind,
  profile_sha256: createHash("sha256")
    .update(PROFILE_BYTES)
    .digest("hex"),
});
const PUNCTUATION = new Set(PROFILE.mapping.punctuation_code_points.map((value) => Number.parseInt(value.slice(2), 16)));
const WHITESPACE = new Set(PROFILE.mapping.whitespace_code_points.map((value) => Number.parseInt(value.slice(2), 16)));

function fail(code) {
  throw new TypeError(code);
}

function normalizeText(text) {
  if (typeof text !== "string") fail("ASR_SCORE_TEXT");
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) fail("ASR_SCORE_TEXT");
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      fail("ASR_SCORE_TEXT");
    }
  }
  if (text.includes("\0") || text.includes("\ufeff")) fail("ASR_SCORE_TEXT");
  if (Buffer.byteLength(text, "utf8") > MAX_TEXT_UTF8_BYTES) fail("ASR_SCORE_TEXT_LIMIT");
  const normalized = text.normalize("NFC");
  if (Buffer.byteLength(normalized, "utf8") > MAX_TEXT_UTF8_BYTES) fail("ASR_SCORE_TEXT_LIMIT");
  return normalized;
}

export function normalizeAsrUnits(text, language) {
  if (!LANGUAGES.has(language)) fail("ASR_SCORE_LANGUAGE");
  const normalized = normalizeText(text);
  const mapped = [];
  for (const scalar of normalized) {
    let codePoint = scalar.codePointAt(0);
    if (codePoint >= 0xff01 && codePoint <= 0xff5e) codePoint -= 0xfee0;
    if (codePoint >= 0x41 && codePoint <= 0x5a) codePoint += 0x20;
    if (PUNCTUATION.has(codePoint) || WHITESPACE.has(codePoint)) {
      if (language === "en" && mapped.at(-1) !== " ") mapped.push(" ");
      continue;
    }
    mapped.push(String.fromCodePoint(codePoint));
  }
  if (language === "en") {
    const words = mapped
      .join("")
      .trim()
      .split(" ")
      .filter(Boolean);
    if (words.length > MAX_NORMALIZED_UNITS) fail("ASR_SCORE_UNIT_LIMIT");
    return words;
  }
  const units = mapped;
  if (units.length > MAX_NORMALIZED_UNITS) fail("ASR_SCORE_UNIT_LIMIT");
  return units;
}

export function getAsrScorerProfile() {
  return { ...SCORER_PROFILE };
}

export function assertAsrScorerRuntimeIdentity() {
  return { ...REQUIRED_RUNTIME_IDENTITY };
}

function candidate(distance, substitutions, deletions, insertions, priority) {
  return { deletions, distance, insertions, priority, substitutions };
}

function better(left, right) {
  for (const key of ["distance", "priority", "substitutions", "deletions", "insertions"]) {
    if (left[key] !== right[key]) return left[key] < right[key] ? left : right;
  }
  return left;
}

function editDistance(reference, hypothesis) {
  let previous = Array.from({ length: hypothesis.length + 1 }, (_, index) =>
    candidate(index, 0, 0, index, 2)
  );
  for (let referenceIndex = 1; referenceIndex <= reference.length; referenceIndex += 1) {
    const current = [candidate(referenceIndex, 0, referenceIndex, 0, 1)];
    for (let hypothesisIndex = 1; hypothesisIndex <= hypothesis.length; hypothesisIndex += 1) {
      if (reference[referenceIndex - 1] === hypothesis[hypothesisIndex - 1]) {
        const exact = previous[hypothesisIndex - 1];
        current.push(candidate(exact.distance, exact.substitutions, exact.deletions, exact.insertions, 0));
        continue;
      }
      const diagonal = previous[hypothesisIndex - 1];
      const above = previous[hypothesisIndex];
      const left = current[hypothesisIndex - 1];
      const substitution = candidate(diagonal.distance + 1, diagonal.substitutions + 1, diagonal.deletions, diagonal.insertions, 0);
      const deletion = candidate(above.distance + 1, above.substitutions, above.deletions + 1, above.insertions, 1);
      const insertion = candidate(left.distance + 1, left.substitutions, left.deletions, left.insertions + 1, 2);
      current.push(better(better(substitution, deletion), insertion));
    }
    previous = current;
  }
  const result = previous.at(-1);
  return {
    deletions: result.deletions,
    insertions: result.insertions,
    substitutions: result.substitutions,
    total: result.distance,
  };
}

function assertMetadata({ sampleId, scenario, tier }) {
  if (
    typeof sampleId !== "string" ||
    !IDENTIFIER.test(sampleId) ||
    typeof scenario !== "string" ||
    !IDENTIFIER.test(scenario) ||
    !TIERS.has(tier)
  ) {
    fail("ASR_SCORE_METADATA");
  }
}

export function scoreAsrTranscript({
  hypothesis,
  language,
  reference,
  sampleId,
  scenario,
  tier,
}) {
  assertMetadata({ sampleId, scenario, tier });
  const referenceUnits = normalizeAsrUnits(reference, language);
  const hypothesisUnits = normalizeAsrUnits(hypothesis, language);
  const errors = editDistance(referenceUnits, hypothesisUnits);
  const silentHallucination = referenceUnits.length === 0 && hypothesisUnits.length > 0;
  const status = referenceUnits.length > 0
    ? "measured"
    : silentHallucination
      ? "zero-reference-hallucination"
      : "zero-reference-correct";
  return Object.freeze({
    assessment_status: "descriptive-only",
    authority: Object.freeze({ formal_claims: "none", production_evidence: false }),
    errorRate: Object.freeze({
      denominator: String(referenceUnits.length),
      numerator: String(errors.total),
      status,
    }),
    errors: Object.freeze(errors),
    hypothesisUnitCount: hypothesisUnits.length,
    language,
    metric: language === "en" ? "wer" : "cer",
    referenceUnitCount: referenceUnits.length,
    sampleId,
    scenario,
    scorerProfile: SCORER_PROFILE,
    silentHallucination,
    tier,
  });
}

function gcd(left, right) {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

function addFractions(left, right) {
  const denominatorDivisor = gcd(left.denominator, right.denominator);
  const leftScale = right.denominator / denominatorDivisor;
  const rightScale = left.denominator / denominatorDivisor;
  const numerator = left.numerator * leftScale + right.numerator * rightScale;
  const denominator = left.denominator * leftScale;
  const divisor = gcd(numerator, denominator);
  const result = { numerator: numerator / divisor, denominator: denominator / divisor };
  if (
    String(result.numerator).length > MAX_AGGREGATE_RATE_DECIMAL_DIGITS ||
    String(result.denominator).length > MAX_AGGREGATE_RATE_DECIMAL_DIGITS
  ) {
    fail("ASR_SCORE_AGGREGATE_OUTPUT");
  }
  return result;
}

function meanRates(rates) {
  if (rates.length === 0) {
    return { denominator: "0", numerator: "0", status: "not-comparable" };
  }
  let sum = { denominator: 1n, numerator: 0n };
  for (const rate of rates) {
    sum = addFractions(sum, {
      denominator: BigInt(rate.denominator),
      numerator: BigInt(rate.numerator),
    });
  }
  const denominator = sum.denominator * BigInt(rates.length);
  const divisor = gcd(sum.numerator, denominator);
  const result = {
    denominator: String(denominator / divisor),
    numerator: String(sum.numerator / divisor),
    status: "measured",
  };
  if (
    result.numerator.length > MAX_AGGREGATE_RATE_DECIMAL_DIGITS ||
    result.denominator.length > MAX_AGGREGATE_RATE_DECIMAL_DIGITS
  ) {
    fail("ASR_SCORE_AGGREGATE_OUTPUT");
  }
  return result;
}

function compareRates(left, right) {
  const leftScaled = BigInt(left.numerator) * BigInt(right.denominator);
  const rightScaled = BigInt(right.numerator) * BigInt(left.denominator);
  return leftScaled < rightScaled ? -1 : leftScaled > rightScaled ? 1 : 0;
}

function utteranceRateRange(comparable) {
  if (comparable.length === 0) {
    const unavailable = Object.freeze({ denominator: "0", numerator: "0", status: "not-comparable" });
    return Object.freeze({ maximum: unavailable, minimum: unavailable });
  }
  let minimum = comparable[0].errorRate;
  let maximum = comparable[0].errorRate;
  for (const score of comparable.slice(1)) {
    if (compareRates(score.errorRate, minimum) < 0) minimum = score.errorRate;
    if (compareRates(score.errorRate, maximum) > 0) maximum = score.errorRate;
  }
  const copy = (rate) => Object.freeze({
    denominator: rate.denominator,
    numerator: rate.numerator,
    status: "measured",
  });
  return Object.freeze({ maximum: copy(maximum), minimum: copy(minimum) });
}

function errorSums(scores) {
  return Object.freeze({
    deletions: scores.reduce((sum, score) => sum + score.errors.deletions, 0),
    hypothesis_units: scores.reduce((sum, score) => sum + score.hypothesisUnitCount, 0),
    insertions: scores.reduce((sum, score) => sum + score.errors.insertions, 0),
    reference_units: scores.reduce((sum, score) => sum + score.referenceUnitCount, 0),
    substitutions: scores.reduce((sum, score) => sum + score.errors.substitutions, 0),
    total: scores.reduce((sum, score) => sum + score.errors.total, 0),
  });
}

function summarize(key, scores, macroRates) {
  const comparable = scores.filter((score) => score.referenceUnitCount > 0);
  const rates = macroRates ?? comparable.map((score) => score.errorRate);
  const macro = meanRates(rates);
  return Object.freeze({
    comparable_sample_count: comparable.length,
    error_sums: errorSums(scores),
    key,
    macro_error_rate: Object.freeze(macro),
    sample_count: scores.length,
    utterance_error_rate_range: utteranceRateRange(comparable),
    zero_reference_correct: scores.filter((score) => score.errorRate.status === "zero-reference-correct").length,
    zero_reference_hallucinations: scores.filter((score) => score.silentHallucination).length,
  });
}

function languageScenarioGroups(scores) {
  const languages = [...new Set(scores.map((score) => score.language))].sort();
  const entries = [];
  for (const language of languages) {
    const languageScores = scores.filter((score) => score.language === language);
    const scenarios = [...new Set(languageScores.map((score) => score.scenario))].sort();
    for (const scenario of scenarios) {
      entries.push(Object.freeze({
        ...summarize(`${language}/${scenario}`, languageScores.filter((score) => score.scenario === scenario)),
        language,
        scenario,
      }));
    }
  }
  return entries;
}

function languageGroups(scores, languageScenarios) {
  const languages = [...new Set(scores.map((score) => score.language))].sort();
  return languages.map((language) => {
    const scenarioRates = languageScenarios
      .filter((entry) => entry.language === language && entry.macro_error_rate.status === "measured")
      .map((entry) => entry.macro_error_rate);
    return summarize(
      language,
      scores.filter((score) => score.language === language),
      scenarioRates,
    );
  });
}

function exactKeys(value, expected) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("ASR_SCORE_AGGREGATE");
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) fail("ASR_SCORE_AGGREGATE");
}

function validateScore(score) {
  exactKeys(score, [
    "assessment_status", "authority", "errorRate", "errors", "hypothesisUnitCount",
    "language", "metric", "referenceUnitCount", "sampleId", "scenario",
    "scorerProfile", "silentHallucination", "tier",
  ]);
  exactKeys(score.authority, ["formal_claims", "production_evidence"]);
  exactKeys(score.errorRate, ["denominator", "numerator", "status"]);
  exactKeys(score.errors, ["deletions", "insertions", "substitutions", "total"]);
  exactKeys(score.scorerProfile, ["profile_id", "profile_sha256"]);
  assertMetadata(score);
  if (
    score.assessment_status !== "descriptive-only" ||
    score.authority.formal_claims !== "none" ||
    score.authority.production_evidence !== false ||
    !Object.keys(SCORER_PROFILE).every((key) => score.scorerProfile[key] === SCORER_PROFILE[key]) ||
    !LANGUAGES.has(score.language) ||
    score.metric !== (score.language === "en" ? "wer" : "cer") ||
    !Number.isSafeInteger(score.referenceUnitCount) ||
    score.referenceUnitCount < 0 ||
    score.referenceUnitCount > MAX_NORMALIZED_UNITS ||
    !Number.isSafeInteger(score.hypothesisUnitCount) ||
    score.hypothesisUnitCount < 0 ||
    score.hypothesisUnitCount > MAX_NORMALIZED_UNITS ||
    typeof score.silentHallucination !== "boolean"
  ) {
    fail("ASR_SCORE_AGGREGATE");
  }
  for (const value of Object.values(score.errors)) {
    if (!Number.isSafeInteger(value) || value < 0 || value > MAX_NORMALIZED_UNITS * 2) fail("ASR_SCORE_AGGREGATE");
  }
  if (
    score.errors.total !== score.errors.deletions + score.errors.insertions + score.errors.substitutions ||
    score.hypothesisUnitCount !== score.referenceUnitCount - score.errors.deletions + score.errors.insertions ||
    score.errors.deletions + score.errors.substitutions > score.referenceUnitCount ||
    score.errors.insertions + score.errors.substitutions > score.hypothesisUnitCount ||
    score.errors.total > Math.max(score.referenceUnitCount, score.hypothesisUnitCount)
  ) {
    fail("ASR_SCORE_AGGREGATE");
  }
  const expectedStatus = score.referenceUnitCount > 0
    ? "measured"
    : score.hypothesisUnitCount > 0
      ? "zero-reference-hallucination"
      : "zero-reference-correct";
  if (
    score.errorRate.denominator !== String(score.referenceUnitCount) ||
    score.errorRate.numerator !== String(score.errors.total) ||
    score.errorRate.status !== expectedStatus ||
    score.silentHallucination !== (expectedStatus === "zero-reference-hallucination")
  ) {
    fail("ASR_SCORE_AGGREGATE");
  }
}

function validateAggregateRate(rate, allowUnavailable = true) {
  exactKeys(rate, ["denominator", "numerator", "status"]);
  if (
    typeof rate.denominator !== "string" ||
    rate.denominator.length > MAX_AGGREGATE_RATE_DECIMAL_DIGITS ||
    !/^(?:0|[1-9][0-9]*)$/u.test(rate.denominator) ||
    typeof rate.numerator !== "string" ||
    rate.numerator.length > MAX_AGGREGATE_RATE_DECIMAL_DIGITS ||
    !/^(?:0|[1-9][0-9]*)$/u.test(rate.numerator)
  ) {
    fail("ASR_SCORE_AGGREGATE_OUTPUT");
  }
  if (rate.status === "measured") {
    if (rate.denominator === "0") fail("ASR_SCORE_AGGREGATE_OUTPUT");
  } else if (!allowUnavailable || rate.status !== "not-comparable" || rate.denominator !== "0" || rate.numerator !== "0") {
    fail("ASR_SCORE_AGGREGATE_OUTPUT");
  }
}

function validateUtteranceRate(rate) {
  validateAggregateRate(rate);
  if (
    rate.status === "measured" &&
    (BigInt(rate.denominator) > BigInt(MAX_NORMALIZED_UNITS) ||
      BigInt(rate.numerator) > BigInt(MAX_NORMALIZED_UNITS * 2))
  ) {
    fail("ASR_SCORE_AGGREGATE_OUTPUT");
  }
}

function validateSummary(summary, groupField) {
  const languageScenario = groupField === "by_language_scenario";
  exactKeys(summary, [
    "comparable_sample_count", "error_sums", "key", ...(languageScenario ? ["language", "scenario"] : []),
    "macro_error_rate", "sample_count", "utterance_error_rate_range",
    "zero_reference_correct", "zero_reference_hallucinations",
  ]);
  assertMetadata({ sampleId: "aggregate", scenario: languageScenario ? summary.scenario : "aggregate", tier: "tier-1" });
  if (typeof summary.key !== "string" || summary.key.length === 0 || summary.key.length > 257) fail("ASR_SCORE_AGGREGATE_OUTPUT");
  if (languageScenario && (!LANGUAGES.has(summary.language) || summary.key !== `${summary.language}/${summary.scenario}`)) fail("ASR_SCORE_AGGREGATE_OUTPUT");
  if (groupField === "by_language" && !LANGUAGES.has(summary.key)) fail("ASR_SCORE_AGGREGATE_OUTPUT");
  for (const key of ["comparable_sample_count", "sample_count", "zero_reference_correct", "zero_reference_hallucinations"]) {
    if (!Number.isSafeInteger(summary[key]) || summary[key] < 0 || summary[key] > MAX_AGGREGATE_SCORES) fail("ASR_SCORE_AGGREGATE_OUTPUT");
  }
  if (summary.comparable_sample_count > summary.sample_count || summary.zero_reference_correct + summary.zero_reference_hallucinations + summary.comparable_sample_count !== summary.sample_count) fail("ASR_SCORE_AGGREGATE_OUTPUT");
  exactKeys(summary.error_sums, ["deletions", "hypothesis_units", "insertions", "reference_units", "substitutions", "total"]);
  for (const value of Object.values(summary.error_sums)) {
    if (!Number.isSafeInteger(value) || value < 0 || value > MAX_AGGREGATE_SCORES * MAX_NORMALIZED_UNITS * 2) fail("ASR_SCORE_AGGREGATE_OUTPUT");
  }
  if (summary.error_sums.total !== summary.error_sums.deletions + summary.error_sums.insertions + summary.error_sums.substitutions) fail("ASR_SCORE_AGGREGATE_OUTPUT");
  if (
    summary.error_sums.deletions > summary.error_sums.reference_units ||
    summary.error_sums.substitutions > summary.error_sums.reference_units ||
    summary.error_sums.total > summary.error_sums.reference_units + summary.error_sums.hypothesis_units ||
    summary.error_sums.reference_units < summary.comparable_sample_count ||
    summary.error_sums.hypothesis_units < summary.zero_reference_hallucinations
  ) {
    fail("ASR_SCORE_AGGREGATE_OUTPUT");
  }
  validateAggregateRate(summary.macro_error_rate);
  exactKeys(summary.utterance_error_rate_range, ["maximum", "minimum"]);
  validateUtteranceRate(summary.utterance_error_rate_range.minimum);
  validateUtteranceRate(summary.utterance_error_rate_range.maximum);
  if (
    summary.comparable_sample_count === 0 && summary.macro_error_rate.status !== "not-comparable" ||
    summary.comparable_sample_count > 0 && summary.macro_error_rate.status !== "measured" ||
    summary.utterance_error_rate_range.minimum.status !== summary.macro_error_rate.status ||
    summary.utterance_error_rate_range.maximum.status !== summary.macro_error_rate.status ||
    summary.comparable_sample_count > 0 && compareRates(summary.utterance_error_rate_range.minimum, summary.utterance_error_rate_range.maximum) > 0
  ) {
    fail("ASR_SCORE_AGGREGATE_OUTPUT");
  }
}

export function validateDescriptiveAsrAggregate(aggregate, scores) {
  if (!Array.isArray(scores)) fail("ASR_SCORE_AGGREGATE_OUTPUT");
  exactKeys(aggregate, [
    "assessment_status", "authority", "by_language", "by_language_scenario",
    "sample_count", "scorer_profile",
  ]);
  exactKeys(aggregate.authority, ["formal_claims", "production_evidence"]);
  exactKeys(aggregate.scorer_profile, ["profile_id", "profile_sha256"]);
  if (
    aggregate.assessment_status !== "descriptive-only" ||
    aggregate.authority.formal_claims !== "none" || aggregate.authority.production_evidence !== false ||
    !Object.keys(SCORER_PROFILE).every((key) => aggregate.scorer_profile[key] === SCORER_PROFILE[key]) ||
    !Number.isSafeInteger(aggregate.sample_count) || aggregate.sample_count < 1 || aggregate.sample_count > MAX_AGGREGATE_SCORES
  ) {
    fail("ASR_SCORE_AGGREGATE_OUTPUT");
  }
  let expectedDimensionTotals;
  for (const field of ["by_language", "by_language_scenario"]) {
    if (!Array.isArray(aggregate[field]) || aggregate[field].length === 0) fail("ASR_SCORE_AGGREGATE_OUTPUT");
    const keys = new Set();
    let previousKey;
    const dimensionTotals = {
      comparable_sample_count: 0,
      deletions: 0,
      hypothesis_units: 0,
      insertions: 0,
      reference_units: 0,
      sample_count: 0,
      substitutions: 0,
      total: 0,
      zero_reference_correct: 0,
      zero_reference_hallucinations: 0,
    };
    for (const summary of aggregate[field]) {
      validateSummary(summary, field);
      if (keys.has(summary.key)) fail("ASR_SCORE_AGGREGATE_OUTPUT");
      if (previousKey !== undefined && previousKey > summary.key) fail("ASR_SCORE_AGGREGATE_OUTPUT");
      keys.add(summary.key);
      previousKey = summary.key;
      for (const key of ["comparable_sample_count", "sample_count", "zero_reference_correct", "zero_reference_hallucinations"]) {
        dimensionTotals[key] += summary[key];
      }
      for (const key of ["deletions", "hypothesis_units", "insertions", "reference_units", "substitutions", "total"]) {
        dimensionTotals[key] += summary.error_sums[key];
      }
    }
    if (dimensionTotals.sample_count !== aggregate.sample_count) fail("ASR_SCORE_AGGREGATE_OUTPUT");
    if (expectedDimensionTotals === undefined) expectedDimensionTotals = dimensionTotals;
    else if (JSON.stringify(expectedDimensionTotals) !== JSON.stringify(dimensionTotals)) fail("ASR_SCORE_AGGREGATE_OUTPUT");
  }
  for (const language of aggregate.by_language) {
    const scenarioRates = aggregate.by_language_scenario
      .filter((entry) => entry.language === language.key && entry.macro_error_rate.status === "measured")
      .map((entry) => entry.macro_error_rate);
    if (JSON.stringify(meanRates(scenarioRates)) !== JSON.stringify(language.macro_error_rate)) {
      fail("ASR_SCORE_AGGREGATE_OUTPUT");
    }
  }
  try {
    validateScoreRows(scores);
  } catch {
    fail("ASR_SCORE_AGGREGATE_OUTPUT");
  }
  const expected = buildDescriptiveAsrAggregate(scores);
  if (encodeCanonicalJson(aggregate) !== encodeCanonicalJson(expected)) {
    fail("ASR_SCORE_AGGREGATE_OUTPUT");
  }
  return aggregate;
}

function validateScoreRows(scores) {
  if (!Array.isArray(scores) || scores.length === 0 || scores.length > MAX_AGGREGATE_SCORES) fail("ASR_SCORE_AGGREGATE");
  const seen = new Set();
  for (const score of scores) {
    validateScore(score);
    if (seen.has(score.sampleId)) fail("ASR_SCORE_AGGREGATE");
    seen.add(score.sampleId);
  }
}

function buildDescriptiveAsrAggregate(scores) {
  const byLanguageScenario = languageScenarioGroups(scores);
  return Object.freeze({
    assessment_status: "descriptive-only",
    authority: Object.freeze({ formal_claims: "none", production_evidence: false }),
    by_language: Object.freeze(languageGroups(scores, byLanguageScenario)),
    by_language_scenario: Object.freeze(byLanguageScenario),
    scorer_profile: SCORER_PROFILE,
    sample_count: scores.length,
  });
}

export function aggregateDescriptiveAsrScores(scores) {
  validateScoreRows(scores);
  const aggregate = buildDescriptiveAsrAggregate(scores);
  validateDescriptiveAsrAggregate(aggregate, scores);
  return aggregate;
}
