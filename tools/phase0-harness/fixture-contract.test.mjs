import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  fixturePaths,
  generateFixtureTree,
  sha256,
  validateFixtureTree,
} from "./fixture-contract.mjs";
import { encodeCanonicalJson } from "./canonical-json.mjs";

async function withGeneratedFixture(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "meetingrelay-fixture-"));
  try {
    await generateFixtureTree(root);
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("CT-FIXTURE-001 validates the committed consent-safe fixture", async () => {
  const result = await validateFixtureTree();
  assert.equal(result.fixtureId, "FX-UND-CAL-001-v1");
  assert.match(result.manifestDigest, /^[0-9a-f]{64}$/);
  assert.match(result.audioSha256, /^[0-9a-f]{64}$/);
  assert.match(result.pcmSha256, /^[0-9a-f]{64}$/);
});

test("CT-FIXTURE-001 regeneration is byte-for-byte deterministic", async () => {
  await withGeneratedFixture(async (root) => {
    await validateFixtureTree(root);
    for (const relativePath of fixturePaths.expectedFiles) {
      const committed = await readFile(path.join(fixturePaths.projectRoot, ...relativePath.split("/")));
      const regenerated = await readFile(path.join(root, ...relativePath.split("/")));
      assert.equal(regenerated.compare(committed), 0, relativePath);
    }
  });
});

test("CT-FIXTURE-001 rejects a tampered audio asset", async () => {
  await withGeneratedFixture(async (root) => {
    const audioPath = path.join(root, "audio", "FX-UND-CAL-001-v1", "input.wav");
    const audio = await readFile(audioPath);
    audio[audio.length - 1] ^= 0xff;
    await writeFile(audioPath, audio);
    await assert.rejects(validateFixtureTree(root), /audio file checksum mismatch/);
  });
});

test("CT-FIXTURE-001 independently verifies decoded PCM", async () => {
  await withGeneratedFixture(async (root) => {
    const audioPath = path.join(root, "audio", "FX-UND-CAL-001-v1", "input.wav");
    const manifestPath = path.join(root, "manifest.json");
    const audio = await readFile(audioPath);
    audio[audio.length - 1] ^= 0xff;
    await writeFile(audioPath, audio);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.fixtures[0].audio.sha256 = sha256(audio);
    const bytes = Buffer.from(encodeCanonicalJson(manifest), "utf8");
    await writeFile(manifestPath, bytes);
    await writeFile(
      path.join(root, "manifest.sha256"),
      `${sha256(bytes)}  manifest.json\n`,
      "ascii",
    );
    await assert.rejects(validateFixtureTree(root), /audio PCM checksum mismatch/);
  });
});

test("CT-FIXTURE-001 rejects unsafe paths even with a valid manifest sidecar", async () => {
  await withGeneratedFixture(async (root) => {
    const manifestPath = path.join(root, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.fixtures[0].reference.path = "../outside.json";
    const bytes = Buffer.from(encodeCanonicalJson(manifest), "utf8");
    await writeFile(manifestPath, bytes);
    await writeFile(
      path.join(root, "manifest.sha256"),
      `${sha256(bytes)}  manifest.json\n`,
      "ascii",
    );
    await assert.rejects(validateFixtureTree(root), /unsafe fixture path/);
  });
});

test("CT-FIXTURE-001 rejects a fixture that claims human or meeting content", async () => {
  await withGeneratedFixture(async (root) => {
    const manifestPath = path.join(root, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.fixtures[0].contains_human_voice = true;
    manifest.fixtures[0].contains_meeting_content = true;
    const bytes = Buffer.from(encodeCanonicalJson(manifest), "utf8");
    await writeFile(manifestPath, bytes);
    await writeFile(
      path.join(root, "manifest.sha256"),
      `${sha256(bytes)}  manifest.json\n`,
      "ascii",
    );
    await assert.rejects(validateFixtureTree(root), /not consent-safe synthetic data/);
  });
});

test("CT-FIXTURE-001 rejects Pending or malformed asset checksums", async () => {
  await withGeneratedFixture(async (root) => {
    const manifestPath = path.join(root, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.fixtures[0].reference.sha256 = "Pending";
    const bytes = Buffer.from(encodeCanonicalJson(manifest), "utf8");
    await writeFile(manifestPath, bytes);
    await writeFile(
      path.join(root, "manifest.sha256"),
      `${sha256(bytes)}  manifest.json\n`,
      "ascii",
    );
    await assert.rejects(validateFixtureTree(root), /lowercase SHA-256 digest/);
  });
});
