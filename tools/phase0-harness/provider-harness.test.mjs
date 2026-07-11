import assert from "node:assert/strict";
import {
  lstat,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  encodeCanonicalJson,
  encodeCanonicalJsonLine,
} from "./canonical-json.mjs";
import {
  fixturePaths,
  generateFixtureTree,
  sha256,
} from "./fixture-contract.mjs";
import {
  createProviderRun,
  generateDoubleProviderRun,
  loadProviderScenario,
  providerPaths,
  runProviderScenario,
  validateProviderArtifacts,
  validateProviderScenario,
} from "./provider-harness.mjs";

const EXPECTED_PROVIDER_SHA =
  "e85f639b68d09f4e27cb6714a8c7c82832deba261a9ee5e531f6d86f322066b5";
const EXPECTED_FAULT_SHA =
  "cbbad16c0dff5b8d5ab2d32cb701a12fce04b075b8006011af0f2694e30f9135";

async function withTempRoot(run) {
  const root = await mkdtemp(path.join(tmpdir(), "meetingrelay-provider-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function committedBytes() {
  return {
    provider: await readFile(
      path.join(
        fixturePaths.projectRoot,
        ...providerPaths.providerRelativePath.split("/"),
      ),
    ),
    fault: await readFile(
      path.join(
        fixturePaths.projectRoot,
        ...providerPaths.faultRelativePath.split("/"),
      ),
    ),
  };
}

function encodeEvents(events) {
  return Buffer.from(events.map(encodeCanonicalJsonLine).join(""), "utf8");
}

function cloneEvents(providerBytes) {
  return providerBytes
    .toString("utf8")
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
}

function cloneFault(faultBytes) {
  return JSON.parse(faultBytes.toString("utf8"));
}

async function replaceFixtureAsset(fixtureRoot, descriptorKey, relativePath, bytes) {
  await writeFile(path.join(fixtureRoot, ...relativePath.split("/")), bytes);
  const manifestFile = path.join(fixtureRoot, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  manifest.fixtures[0][descriptorKey].sha256 = sha256(bytes);
  const manifestBytes = Buffer.from(encodeCanonicalJson(manifest), "utf8");
  await writeFile(manifestFile, manifestBytes);
  await writeFile(
    path.join(fixtureRoot, "manifest.sha256"),
    `${sha256(manifestBytes)}  manifest.json\n`,
    "ascii",
  );
}

test("committed provider scenario executes exactly with virtual logical time", async () => {
  const scenario = await loadProviderScenario();
  const result = runProviderScenario(scenario);
  assert.equal(scenario.providerSha256, EXPECTED_PROVIDER_SHA);
  assert.equal(scenario.faultSha256, EXPECTED_FAULT_SHA);
  assert.equal(result.emittedEvents.compare(scenario.providerBytes), 0);
  assert.equal(result.finalOutput, "fixture-token-1 fixture-token-2");
  assert.equal(result.summary.emitted_event_count, "2");
  assert.equal(result.summary.final_logical_offset_ns, "1000000");
  assert.equal(result.summary.fault_steps_applied, "0");
  assert.equal(result.summary.clock_mode, "virtual-logical");
  assert.equal(result.summary.network_used, false);
  assert.equal(result.summary.real_timer_used, false);
  assert.equal(result.summary.formal_claims, "none");
});

test("two clean provider runs produce byte-identical artifacts", async () => {
  await withTempRoot(async (root) => {
    const comparison = await generateDoubleProviderRun(root);
    assert.equal(comparison.provider_events.comparison, "byte-and-sha256-equal");
    assert.equal(comparison.provider_events.sha256, EXPECTED_PROVIDER_SHA);
    assert.equal(comparison.provider_run.comparison, "byte-and-sha256-equal");
    assert.match(comparison.provider_run.sha256, /^[0-9a-f]{64}$/);
    assert.equal(comparison.fault_steps_applied, "0");
  });
});

test("provider events reject unknown actions and empty chunks", async () => {
  const { provider, fault } = await committedBytes();
  const unknownAction = cloneEvents(provider);
  unknownAction[0].action = "retry";
  assert.throws(
    () => validateProviderScenario(encodeEvents(unknownAction), fault),
    /action must be delta or complete/,
  );

  const emptyChunk = cloneEvents(provider);
  emptyChunk[0].chunk = "";
  assert.throws(
    () => validateProviderScenario(encodeEvents(emptyChunk), fault),
    /chunk must be a non-empty NFC string/,
  );
});

test("provider events reject sequence and logical-offset errors", async () => {
  const { provider, fault } = await committedBytes();
  const badSequence = cloneEvents(provider);
  badSequence[1].logical_sequence = "3";
  assert.throws(
    () => validateProviderScenario(encodeEvents(badSequence), fault),
    /logical_sequence must be 2/,
  );

  const badStart = cloneEvents(provider);
  badStart[0].logical_offset_ns = "1";
  assert.throws(
    () => validateProviderScenario(encodeEvents(badStart), fault),
    /start at logical offset 0/,
  );

  const regression = cloneEvents(provider);
  regression[1].logical_offset_ns = "0";
  assert.throws(
    () => validateProviderScenario(encodeEvents(regression), fault),
    /must strictly increase/,
  );
});

test("provider scripts require one final complete event", async () => {
  const { provider, fault } = await committedBytes();
  const missingTerminal = cloneEvents(provider);
  missingTerminal[1].action = "delta";
  assert.throws(
    () => validateProviderScenario(encodeEvents(missingTerminal), fault),
    /exactly one terminal complete/,
  );

  const afterTerminal = cloneEvents(provider);
  afterTerminal.push({
    ...afterTerminal[0],
    logical_sequence: "3",
    logical_offset_ns: "2000000",
    chunk: "late-delta",
  });
  assert.throws(
    () => validateProviderScenario(encodeEvents(afterTerminal), fault),
    /complete must be the final event/,
  );
});

test("provider event version, fixture, and exact-key contracts fail closed", async () => {
  const { provider, fault } = await committedBytes();
  const wrongFixture = cloneEvents(provider);
  wrongFixture[0].fixture_id = "FX-WRONG";
  assert.throws(
    () => validateProviderScenario(encodeEvents(wrongFixture), fault),
    /version or fixture identity differs/,
  );

  const extraKey = cloneEvents(provider);
  extraKey[0].wall_clock = "forbidden";
  assert.throws(
    () => validateProviderScenario(encodeEvents(extraKey), fault),
    /keys differ/,
  );
});

test("fault plan v1.0 rejects non-empty, malformed, and extended plans", async () => {
  const { provider, fault } = await committedBytes();
  const nonEmpty = cloneFault(fault);
  nonEmpty.steps = [{ action: "drop" }];
  assert.throws(
    () => validateProviderScenario(provider, Buffer.from(encodeCanonicalJson(nonEmpty))),
    /rejects every non-empty or unknown fault step/,
  );

  const badSeed = cloneFault(fault);
  badSeed.seed = "01";
  assert.throws(
    () => validateProviderScenario(provider, Buffer.from(encodeCanonicalJson(badSeed))),
    /canonical uint64/,
  );

  const extended = cloneFault(fault);
  extended.mode = "best-effort";
  assert.throws(
    () => validateProviderScenario(provider, Buffer.from(encodeCanonicalJson(extended))),
    /keys differ/,
  );
});

test("provider scenario rejects non-canonical CRLF before execution", async () => {
  const { provider, fault } = await committedBytes();
  const crlf = Buffer.from(provider.toString("utf8").replaceAll("\n", "\r\n"));
  assert.throws(
    () => validateProviderScenario(crlf, fault),
    /LF-terminated canonical JSONL/,
  );
});

test("fixture checksum failure produces no success artifact", async () => {
  await withTempRoot(async (root) => {
    const fixtureRoot = path.join(root, "fixtures");
    const outputRoot = path.join(root, "output");
    await generateFixtureTree(fixtureRoot);
    const providerFile = path.join(
      fixtureRoot,
      ...providerPaths.providerRelativePath.split("/"),
    );
    await writeFile(providerFile, "{}\n", "utf8");
    await assert.rejects(
      createProviderRun(outputRoot, fixtureRoot),
      /provider_script checksum mismatch/,
    );
    await assert.rejects(lstat(outputRoot), (error) => error.code === "ENOENT");
  });
});

test("semantic provider failure occurs before any success artifact", async () => {
  await withTempRoot(async (root) => {
    const fixtureRoot = path.join(root, "fixtures");
    const outputRoot = path.join(root, "output");
    await generateFixtureTree(fixtureRoot);
    const providerFile = path.join(
      fixtureRoot,
      ...providerPaths.providerRelativePath.split("/"),
    );
    const events = cloneEvents(await readFile(providerFile));
    events[0].action = "retry";
    await replaceFixtureAsset(
      fixtureRoot,
      "provider_script",
      providerPaths.providerRelativePath,
      encodeEvents(events),
    );

    await assert.rejects(
      createProviderRun(outputRoot, fixtureRoot),
      /action must be delta or complete/,
    );
    await assert.rejects(lstat(outputRoot), (error) => error.code === "ENOENT");
  });
});

test("provider execution leaves the committed fixture bytes unchanged", async () => {
  await withTempRoot(async (root) => {
    const { provider: beforeProvider, fault: beforeFault } = await committedBytes();
    await createProviderRun(root);
    const { provider: afterProvider, fault: afterFault } = await committedBytes();
    assert.equal(sha256(afterProvider), sha256(beforeProvider));
    assert.equal(sha256(afterFault), sha256(beforeFault));
  });
});

test("provider artifact validation rejects extra files and altered claims", async () => {
  await withTempRoot(async (root) => {
    const scenario = await loadProviderScenario();
    const inventoryRoot = path.join(root, "inventory");
    await createProviderRun(inventoryRoot);
    await writeFile(path.join(inventoryRoot, "unexpected.json"), "{}\n", "utf8");
    await assert.rejects(
      validateProviderArtifacts(inventoryRoot, scenario),
      /artifact inventory differs/,
    );

    const claimRoot = path.join(root, "claim");
    await createProviderRun(claimRoot);
    const summaryFile = path.join(claimRoot, "provider-run.json");
    const summary = JSON.parse(await readFile(summaryFile, "utf8"));
    summary.formal_claims = "p95";
    await writeFile(summaryFile, encodeCanonicalJson(summary), "utf8");
    await assert.rejects(
      validateProviderArtifacts(claimRoot, scenario),
      /differs from the deterministic harness contract/,
    );
  });
});
