import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  encodeCanonicalJson,
  encodeCanonicalJsonLine,
} from "./canonical-json.mjs";
import {
  FIXTURE_ID,
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
  "provider-harness",
);
const PROVIDER_RELATIVE_PATH = `events/${FIXTURE_ID}/provider-script.jsonl`;
const FAULT_RELATIVE_PATH = `faults/${FIXTURE_ID}/fault-plan.json`;
const MAX_U64 = (1n << 64n) - 1n;
const PROVIDER_EVENT_KEYS = Object.freeze([
  "action",
  "chunk",
  "fixture_id",
  "logical_offset_ns",
  "logical_sequence",
  "schema_version",
]);
const FAULT_PLAN_KEYS = Object.freeze([
  "fixture_id",
  "schema_version",
  "seed",
  "steps",
]);
const RUN_SUMMARY_KEYS = Object.freeze([
  "clock_mode",
  "emitted_event_count",
  "emitted_events_sha256",
  "fault_plan_sha256",
  "fault_seed",
  "fault_steps_applied",
  "final_logical_offset_ns",
  "fixture_id",
  "formal_claims",
  "network_used",
  "provider_script_sha256",
  "real_timer_used",
  "schema_version",
  "status",
  "terminal_action",
]);
const ARTIFACT_FILES = Object.freeze([
  "provider-events.jsonl",
  "provider-run.json",
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

function assertSha256(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
}

function assertCanonicalBytes(bytes, label, encoder, parsed) {
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) {
    throw new Error(`${label} contains invalid UTF-8`);
  }
  if (!Buffer.from(encoder(parsed), "utf8").equals(bytes)) {
    throw new Error(`${label} is not canonical`);
  }
}

function parseProviderEvents(providerBytes) {
  if (
    providerBytes.length === 0 ||
    providerBytes[providerBytes.length - 1] !== 0x0a ||
    providerBytes.includes(0x0d)
  ) {
    throw new Error("provider script must be LF-terminated canonical JSONL");
  }
  const text = providerBytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(providerBytes)) {
    throw new Error("provider script contains invalid UTF-8");
  }
  const lines = text.slice(0, -1).split("\n");
  if (lines.some((line) => line.length === 0)) {
    throw new Error("provider script contains an empty line or extra trailing LF");
  }
  const events = lines.map((line, index) => {
    let event;
    try {
      event = JSON.parse(line);
    } catch (error) {
      throw new Error(`provider event ${index + 1} is invalid JSON: ${error.message}`);
    }
    if (encodeCanonicalJsonLine(event) !== `${line}\n`) {
      throw new Error(`provider event ${index + 1} is not canonical JSONL`);
    }
    return event;
  });
  return events;
}

function validateProviderEvents(providerBytes, fixtureId) {
  const events = parseProviderEvents(providerBytes);
  if (events.length === 0) {
    throw new Error("provider script must contain at least one event");
  }

  let previousOffset = null;
  let terminalCount = 0;
  events.forEach((event, index) => {
    const label = `provider event ${index + 1}`;
    assertExactKeys(event, PROVIDER_EVENT_KEYS, label);
    if (event.schema_version !== "1.0" || event.fixture_id !== fixtureId) {
      throw new Error(`${label} version or fixture identity differs`);
    }
    assertCanonicalU64(event.logical_sequence, `${label}.logical_sequence`);
    assertCanonicalU64(event.logical_offset_ns, `${label}.logical_offset_ns`);
    if (event.logical_sequence !== String(index + 1)) {
      throw new Error(`${label}.logical_sequence must be ${index + 1}`);
    }
    const offset = BigInt(event.logical_offset_ns);
    if (index === 0 && offset !== 0n) {
      throw new Error("provider script must start at logical offset 0");
    }
    if (previousOffset !== null && offset <= previousOffset) {
      throw new Error(`${label}.logical_offset_ns must strictly increase`);
    }
    previousOffset = offset;
    if (event.action !== "delta" && event.action !== "complete") {
      throw new Error(`${label}.action must be delta or complete`);
    }
    if (
      typeof event.chunk !== "string" ||
      event.chunk.length === 0 ||
      event.chunk !== event.chunk.normalize("NFC")
    ) {
      throw new Error(`${label}.chunk must be a non-empty NFC string`);
    }
    if (event.action === "complete") {
      terminalCount += 1;
      if (index !== events.length - 1) {
        throw new Error("provider complete must be the final event");
      }
    }
  });
  if (terminalCount !== 1) {
    throw new Error("provider script must contain exactly one terminal complete event");
  }
  return events;
}

function parseFaultPlan(faultBytes) {
  let faultPlan;
  try {
    faultPlan = JSON.parse(faultBytes.toString("utf8"));
  } catch (error) {
    throw new Error(`fault plan is invalid JSON: ${error.message}`);
  }
  assertCanonicalBytes(faultBytes, "fault plan", encodeCanonicalJson, faultPlan);
  return faultPlan;
}

export function validateProviderScenario(
  providerBytes,
  faultBytes,
  fixtureId = FIXTURE_ID,
) {
  if (fixtureId !== FIXTURE_ID) {
    throw new Error(`provider harness only accepts the committed fixture ${FIXTURE_ID}`);
  }
  const normalizedProviderBytes = Buffer.from(providerBytes);
  const normalizedFaultBytes = Buffer.from(faultBytes);
  const events = validateProviderEvents(normalizedProviderBytes, fixtureId);
  const faultPlan = parseFaultPlan(normalizedFaultBytes);
  assertExactKeys(faultPlan, FAULT_PLAN_KEYS, "fault plan");
  assertCanonicalU64(faultPlan.seed, "fault plan.seed");
  if (
    faultPlan.schema_version !== "1.0" ||
    faultPlan.fixture_id !== fixtureId ||
    !Array.isArray(faultPlan.steps)
  ) {
    throw new Error("fault plan version, fixture, or steps shape differs");
  }
  if (faultPlan.steps.length !== 0) {
    throw new Error("fault plan v1.0 rejects every non-empty or unknown fault step");
  }
  return {
    fixtureId,
    events,
    faultPlan,
    providerBytes: normalizedProviderBytes,
    faultBytes: normalizedFaultBytes,
    providerSha256: sha256(normalizedProviderBytes),
    faultSha256: sha256(normalizedFaultBytes),
  };
}

async function readProviderScenario(fixtureRoot) {
  const providerBytes = await readFile(
    path.join(fixtureRoot, ...PROVIDER_RELATIVE_PATH.split("/")),
  );
  const faultBytes = await readFile(
    path.join(fixtureRoot, ...FAULT_RELATIVE_PATH.split("/")),
  );
  return validateProviderScenario(providerBytes, faultBytes);
}

export async function loadProviderScenario(fixtureRoot = fixturePaths.projectRoot) {
  const resolvedFixtureRoot = path.resolve(fixtureRoot);
  const preflight = await validateFixtureTree(resolvedFixtureRoot);
  const scenario = await readProviderScenario(resolvedFixtureRoot);
  const postflight = await validateFixtureTree(resolvedFixtureRoot);
  if (JSON.stringify(preflight) !== JSON.stringify(postflight)) {
    throw new Error("fixture validation changed while loading the provider scenario");
  }
  return scenario;
}

export function runProviderScenario(scenario) {
  const validated = validateProviderScenario(
    scenario.providerBytes,
    scenario.faultBytes,
    scenario.fixtureId,
  );
  let finalOutput = null;
  let finalLogicalOffsetNs = "0";
  for (const event of validated.events) {
    finalLogicalOffsetNs = event.logical_offset_ns;
    if (event.action === "complete") {
      finalOutput = event.chunk;
    }
  }
  if (finalOutput === null) {
    throw new Error("provider scenario ended without a complete output");
  }
  const emittedEvents = Buffer.from(
    validated.events.map(encodeCanonicalJsonLine).join(""),
    "utf8",
  );
  const summary = {
    schema_version: "1.0",
    fixture_id: validated.fixtureId,
    status: "completed",
    emitted_event_count: String(validated.events.length),
    emitted_events_sha256: sha256(emittedEvents),
    provider_script_sha256: validated.providerSha256,
    fault_plan_sha256: validated.faultSha256,
    fault_seed: validated.faultPlan.seed,
    fault_steps_applied: "0",
    terminal_action: "complete",
    clock_mode: "virtual-logical",
    final_logical_offset_ns: finalLogicalOffsetNs,
    network_used: false,
    real_timer_used: false,
    formal_claims: "none",
  };
  return {
    emittedEvents,
    summary,
    summaryBytes: Buffer.from(encodeCanonicalJson(summary), "utf8"),
    finalOutput,
  };
}

async function ensureEmptyDirectory(root) {
  await mkdir(root, { recursive: true });
  const entries = await readdir(root);
  if (entries.length !== 0) {
    throw new Error(`provider output directory must be empty: ${root}`);
  }
}

async function writeProviderArtifacts(root, result) {
  await ensureEmptyDirectory(root);
  await writeFile(path.join(root, "provider-events.jsonl"), result.emittedEvents);
  await writeFile(path.join(root, "provider-run.json"), result.summaryBytes);
}

async function assertArtifactInventory(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const names = entries.map((entry) => entry.name).sort();
  if (
    names.length !== ARTIFACT_FILES.length ||
    names.some((name, index) => name !== ARTIFACT_FILES[index])
  ) {
    throw new Error(`provider artifact inventory differs: ${names.join(",")}`);
  }
  for (const entry of entries) {
    const metadata = await lstat(path.join(root, entry.name));
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error(`provider artifact must be a regular file: ${entry.name}`);
    }
  }
}

export async function validateProviderArtifacts(root, expectedScenario) {
  if (expectedScenario === null || expectedScenario === undefined) {
    throw new Error("provider artifact validation requires its committed scenario");
  }
  const resolvedRoot = path.resolve(root);
  await assertArtifactInventory(resolvedRoot);
  const providerBytes = await readFile(path.join(resolvedRoot, "provider-events.jsonl"));
  const events = validateProviderEvents(providerBytes, FIXTURE_ID);
  const summaryBytes = await readFile(path.join(resolvedRoot, "provider-run.json"));
  let summary;
  try {
    summary = JSON.parse(summaryBytes.toString("utf8"));
  } catch (error) {
    throw new Error(`provider run summary is invalid JSON: ${error.message}`);
  }
  assertCanonicalBytes(summaryBytes, "provider run summary", encodeCanonicalJson, summary);
  assertExactKeys(summary, RUN_SUMMARY_KEYS, "provider run summary");
  for (const field of [
    "emitted_event_count",
    "fault_seed",
    "fault_steps_applied",
    "final_logical_offset_ns",
  ]) {
    assertCanonicalU64(summary[field], `provider run summary.${field}`);
  }
  for (const field of [
    "emitted_events_sha256",
    "provider_script_sha256",
    "fault_plan_sha256",
  ]) {
    assertSha256(summary[field], `provider run summary.${field}`);
  }
  const terminal = events.at(-1);
  if (
    summary.schema_version !== "1.0" ||
    summary.fixture_id !== FIXTURE_ID ||
    summary.status !== "completed" ||
    summary.emitted_event_count !== String(events.length) ||
    summary.emitted_events_sha256 !== sha256(providerBytes) ||
    summary.provider_script_sha256 !== sha256(providerBytes) ||
    summary.fault_steps_applied !== "0" ||
    summary.terminal_action !== "complete" ||
    summary.clock_mode !== "virtual-logical" ||
    summary.final_logical_offset_ns !== terminal.logical_offset_ns ||
    summary.network_used !== false ||
    summary.real_timer_used !== false ||
    summary.formal_claims !== "none"
  ) {
    throw new Error("provider run summary differs from the deterministic harness contract");
  }
  if (
    summary.provider_script_sha256 !== expectedScenario.providerSha256 ||
    summary.fault_plan_sha256 !== expectedScenario.faultSha256 ||
    summary.fault_seed !== expectedScenario.faultPlan.seed
  ) {
    throw new Error("provider run summary does not match its committed scenario");
  }
  return {
    providerBytes,
    summaryBytes,
    providerSha256: sha256(providerBytes),
    summarySha256: sha256(summaryBytes),
    summary,
    finalOutput: terminal.chunk,
  };
}

export async function createProviderRun(
  outputRoot,
  fixtureRoot = fixturePaths.projectRoot,
) {
  const resolvedFixtureRoot = path.resolve(fixtureRoot);
  const preflight = await validateFixtureTree(resolvedFixtureRoot);
  const scenario = await readProviderScenario(resolvedFixtureRoot);
  const result = runProviderScenario(scenario);
  const postflight = await validateFixtureTree(resolvedFixtureRoot);
  if (JSON.stringify(preflight) !== JSON.stringify(postflight)) {
    throw new Error("fixture validation changed across provider execution");
  }
  const resolvedOutputRoot = path.resolve(outputRoot);
  await writeProviderArtifacts(resolvedOutputRoot, result);
  const artifact = await validateProviderArtifacts(resolvedOutputRoot, scenario);
  return { artifact, scenario };
}

export async function compareProviderRuns(runA, runB, expectedScenario) {
  const a = await validateProviderArtifacts(runA, expectedScenario);
  const b = await validateProviderArtifacts(runB, expectedScenario);
  if (
    a.providerBytes.compare(b.providerBytes) !== 0 ||
    a.providerSha256 !== b.providerSha256
  ) {
    throw new Error("provider event artifacts are not byte-for-byte deterministic");
  }
  if (a.summaryBytes.compare(b.summaryBytes) !== 0 || a.summarySha256 !== b.summarySha256) {
    throw new Error("provider run summaries are not byte-for-byte deterministic");
  }
  return {
    schema_version: "1.0",
    fixture_id: FIXTURE_ID,
    provider_events: {
      comparison: "byte-and-sha256-equal",
      sha256: a.providerSha256,
    },
    provider_run: {
      comparison: "byte-and-sha256-equal",
      sha256: a.summarySha256,
    },
    fault_steps_applied: "0",
    clock_mode: "virtual-logical",
    formal_claims: "none",
  };
}

export async function generateDoubleProviderRun(outputRoot = DEFAULT_OUTPUT_ROOT) {
  const resolvedRoot = path.resolve(outputRoot);
  await ensureEmptyDirectory(resolvedRoot);
  const runA = path.join(resolvedRoot, "run-a");
  const runB = path.join(resolvedRoot, "run-b");
  const a = await createProviderRun(runA);
  const b = await createProviderRun(runB);
  if (
    a.scenario.providerSha256 !== b.scenario.providerSha256 ||
    a.scenario.faultSha256 !== b.scenario.faultSha256
  ) {
    throw new Error("provider scenario changed between clean runs");
  }
  const comparison = await compareProviderRuns(runA, runB, a.scenario);
  await writeFile(
    path.join(resolvedRoot, "comparison.json"),
    Buffer.from(encodeCanonicalJson(comparison), "utf8"),
  );
  return comparison;
}

export const providerPaths = Object.freeze({
  defaultOutputRoot: DEFAULT_OUTPUT_ROOT,
  repositoryRoot: REPOSITORY_ROOT,
  providerRelativePath: PROVIDER_RELATIVE_PATH,
  faultRelativePath: FAULT_RELATIVE_PATH,
  artifactFiles: ARTIFACT_FILES,
});
