import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { encodeCanonicalJson } from "../phase0-harness/canonical-json.mjs";
import {
  EXECUTION_STATUS,
  MAX_CANDIDATE_FILE_BYTES,
  MAX_TOTAL_CANDIDATE_BYTES,
  MEASUREMENT_STATUS,
  PREIMAGE_DOMAIN,
  PUBLIC_EVIDENCE_KIND,
  PUBLIC_EVIDENCE_SCHEMA_PATH,
  REQUIRED_ROLES,
  PreflightError,
  createSyntheticFixture,
  preflightWhisperFallbackCandidate,
  scanForbiddenPublicEvidence,
  sha256Hex,
  validatePublicEvidence,
  validateRelativePath,
} from "./whisper-fallback-candidate-preflight.mjs";

const execFileAsync = promisify(execFile);
const MODULE_PATH = "tools/whisper-native/whisper-fallback-candidate-preflight.mjs";

async function withFixture(fn) {
  const root = await mkdtemp(path.join(tmpdir(), "meetingrelay-whisper-preflight-test-"));
  try {
    const fixture = await createSyntheticFixture(root);
    return await fn(root, fixture);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeManifest(manifestPath, manifest) {
  await writeFile(manifestPath, encodeCanonicalJson(manifest), "utf8");
}

function mutateManifest(fixture, mutate) {
  const clone = JSON.parse(JSON.stringify(fixture.manifest));
  mutate(clone);
  return clone;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

test("preflight consumes synthetic caller bytes and emits deterministic path-free whisper fallback evidence", async () => {
  await withFixture(async (root, fixture) => {
    const left = await preflightWhisperFallbackCandidate(root, fixture.manifestPath);
    const right = await preflightWhisperFallbackCandidate(root, fixture.manifestPath);
    assert.deepEqual(left, right);
    assert.equal(left.kind, PUBLIC_EVIDENCE_KIND);
    assert.equal(left.measurement_status, MEASUREMENT_STATUS);
    assert.equal(left.execution_status, EXECUTION_STATUS);
    assert.equal(left.quality_gate_status, "not-assessed");
    assert.equal(left.formal_claims, "none");
    assert.equal(left.production_evidence, false);
    assert.equal(left.public_distribution, false);
    assert.equal(left.selection_authority, "none");
    assert.equal(left.fallback_authority, "none");
    assert.equal(left.worker_role, "whisper-fallback-candidate");
    assert.deepEqual(left.roles.map((entry) => entry.role), REQUIRED_ROLES);
    assert.equal(left.candidate_descriptor.preimage_domain, PREIMAGE_DOMAIN);
    assert.equal(left.candidate_descriptor.role_count, 7);
    assert.doesNotThrow(() => validatePublicEvidence(left));
    const serialized = JSON.stringify(left);
    for (const forbidden of ["inputs/", "runtime.bytes", "license.txt", root, "synthetic opaque model identity bytes"]) {
      assert.equal(serialized.includes(forbidden), false, forbidden);
    }
  });
});

test("schema parity mirrors validator constants and exact seven roles", async () => {
  const schema = JSON.parse(await readFile(PUBLIC_EVIDENCE_SCHEMA_PATH, "utf8"));
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.kind.const, PUBLIC_EVIDENCE_KIND);
  assert.equal(schema.properties.measurement_status.const, MEASUREMENT_STATUS);
  assert.equal(schema.properties.execution_status.const, EXECUTION_STATUS);
  assert.equal(schema.properties.public_distribution.const, false);
  assert.equal(schema.properties.selection_authority.const, "none");
  assert.equal(schema.properties.fallback_authority.const, "none");
  assert.equal(schema.properties.roles.minItems, 7);
  assert.equal(schema.properties.roles.maxItems, 7);
  assert.equal(schema.properties.roles.items, false);
  assert.equal(schema.properties.limitations.items, false);
  assert.deepEqual(
    schema.properties.roles.prefixItems.map((item) => schema.$defs[item.$ref.replace("#/$defs/", "")].allOf[1].properties.role.const),
    REQUIRED_ROLES,
  );
  assert.equal(schema.$defs.role_row.properties.size_bytes.maximum, MAX_CANDIDATE_FILE_BYTES);
  assert.equal(schema.properties.candidate_descriptor.properties.preimage_domain.const, PREIMAGE_DOMAIN);
});

test("canonical manifests and evidence fail closed on unknown fields and newline drift", async () => {
  await withFixture(async (root, fixture) => {
    const unknown = mutateManifest(fixture, (manifest) => {
      manifest.files[0].unknown = true;
    });
    await writeManifest(fixture.manifestPath, unknown);
    await assert.rejects(() => preflightWhisperFallbackCandidate(root, fixture.manifestPath), /WHISPER_PREFLIGHT_MANIFEST/u);

    await writeFile(fixture.manifestPath, JSON.stringify(fixture.manifest), "utf8");
    await assert.rejects(() => preflightWhisperFallbackCandidate(root, fixture.manifestPath), /WHISPER_PREFLIGHT_MANIFEST_CANONICAL/u);

    await writeManifest(fixture.manifestPath, fixture.manifest);
    const evidence = await preflightWhisperFallbackCandidate(root, fixture.manifestPath);
    assert.throws(() => validatePublicEvidence({ ...evidence, extra: true }), /WHISPER_PREFLIGHT_EVIDENCE_SCHEMA/u);
    const result = await execFileAsync(process.execPath, [MODULE_PATH, "--validate-json", JSON.stringify(evidence)], {
      encoding: "utf8",
      windowsHide: true,
    }).catch((error) => error);
    assert.equal(result.stdout ?? "", "");
    assert.match(result.stderr, /WHISPER_PREFLIGHT_EVIDENCE_CANONICAL/u);
  });
});

test("canonical JSON rejects invalid UTF-8 bytes before parsing", async () => {
  await withFixture(async (root, fixture) => {
    await writeFile(fixture.manifestPath, Buffer.from([0xff, 0x0a]));
    await assert.rejects(
      () => preflightWhisperFallbackCandidate(root, fixture.manifestPath),
      /WHISPER_PREFLIGHT_MANIFEST_CANONICAL/u,
    );
  });
});

test("role set, logical IDs, digests, sizes, and total bytes fail closed", async () => {
  const cases = [
    ["duplicate role", (manifest) => { manifest.files[0].role = manifest.files[1].role; }, /WHISPER_PREFLIGHT_ROLE_SET/u],
    ["duplicate logical id", (manifest) => { manifest.files[0].logical_id = manifest.files[1].logical_id; }, /WHISPER_PREFLIGHT_LOGICAL_ID/u],
    ["uppercase sha", (manifest) => { manifest.files[0].sha256 = "A".repeat(64); }, /WHISPER_PREFLIGHT_DIGEST/u],
    ["zero sha", (manifest) => { manifest.files[0].sha256 = "0".repeat(64); }, /WHISPER_PREFLIGHT_DIGEST/u],
    ["empty size", (manifest) => { manifest.files[0].size_bytes = 0; }, /WHISPER_PREFLIGHT_SIZE/u],
    ["oversized", (manifest) => { manifest.files[0].size_bytes = MAX_CANDIDATE_FILE_BYTES + 1; }, /WHISPER_PREFLIGHT_SIZE/u],
    ["total oversized", (manifest) => {
      manifest.files.forEach((entry) => {
        entry.size_bytes = Math.floor(MAX_TOTAL_CANDIDATE_BYTES / REQUIRED_ROLES.length) + 1;
      });
    }, /WHISPER_PREFLIGHT_SIZE/u],
  ];
  for (const [name, mutate, pattern] of cases) {
    await test(name, async () => {
      await withFixture(async (root, fixture) => {
        const manifest = mutateManifest(fixture, mutate);
        await writeManifest(fixture.manifestPath, manifest);
        await assert.rejects(() => preflightWhisperFallbackCandidate(root, fixture.manifestPath), pattern);
      });
    });
  }
});

test("size drift, same-size hash drift, and over-one-MiB streaming identity are enforced", async () => {
  await withFixture(async (root, fixture) => {
    const model = fixture.manifest.files.find((entry) => entry.role === "model");
    const filePath = path.join(root, ...model.relative_path.split("/"));
    await writeFile(filePath, "changed bytes\n", "utf8");
    await assert.rejects(() => preflightWhisperFallbackCandidate(root, fixture.manifestPath), /WHISPER_PREFLIGHT_(SIZE|HASH)_DRIFT/u);

    await createSyntheticFixture(root);
    await writeFile(filePath, "S".repeat(model.size_bytes), "utf8");
    await assert.rejects(() => preflightWhisperFallbackCandidate(root, fixture.manifestPath), /WHISPER_PREFLIGHT_HASH_DRIFT/u);

    const bytes = Buffer.alloc(1_048_577, 0x5a);
    await writeFile(filePath, bytes);
    model.sha256 = sha256(bytes);
    model.size_bytes = bytes.length;
    await writeManifest(fixture.manifestPath, fixture.manifest);
    const evidence = await preflightWhisperFallbackCandidate(root, fixture.manifestPath);
    assert.equal(evidence.roles.find((entry) => entry.role === "model").sha256, sha256(bytes));
  });
});

test("path attacks, case collisions, and unsafe root or manifest path syntax are rejected", async () => {
  for (const attack of ["../escape.bin", "/absolute.bin", "C:/absolute.bin", "dir\\backslash.bin", "dir/file.txt:ads", "dir/CON", "dir/trailing.", "dir/trailing ", "dir//empty", "dir/cafe\u0301.bin"]) {
    assert.throws(() => validateRelativePath(attack), PreflightError, attack);
  }
  await withFixture(async (root, fixture) => {
    const duplicatePath = mutateManifest(fixture, (manifest) => {
      manifest.files[0].relative_path = "inputs/DUP.bytes";
      manifest.files[1].relative_path = "inputs/dup.bytes";
    });
    await writeManifest(fixture.manifestPath, duplicatePath);
    await assert.rejects(() => preflightWhisperFallbackCandidate(root, fixture.manifestPath), /WHISPER_PREFLIGHT_PATH/u);
    await assert.rejects(() => preflightWhisperFallbackCandidate("relative-root", fixture.manifestPath), /WHISPER_PREFLIGHT_ROOT/u);
    if (process.platform === "win32") {
      await assert.rejects(() => preflightWhisperFallbackCandidate("\\\\server\\share\\root", fixture.manifestPath), /WHISPER_PREFLIGHT_ROOT/u);
      await assert.rejects(() => preflightWhisperFallbackCandidate(root, "\\\\?\\C:\\input-manifest.json"), /WHISPER_PREFLIGHT_MANIFEST_FILE/u);
      await assert.rejects(() => preflightWhisperFallbackCandidate(root, "manifest.json:ads"), /WHISPER_PREFLIGHT_MANIFEST_FILE/u);
    }
  });
});

test("manifest files must appear in exact required role order", async () => {
  await withFixture(async (root, fixture) => {
    const manifest = mutateManifest(fixture, (value) => {
      [value.files[0], value.files[1]] = [value.files[1], value.files[0]];
    });
    await writeManifest(fixture.manifestPath, manifest);
    await assert.rejects(
      () => preflightWhisperFallbackCandidate(root, fixture.manifestPath),
      /WHISPER_PREFLIGHT_ROLE_SET/u,
    );
  });
});

async function createFileSymlinkOrWindowsJunction(linkPath, fileTargetPath) {
  try {
    await symlink(fileTargetPath, linkPath);
    return { relativePath: path.basename(linkPath), mode: "file-symlink" };
  } catch (error) {
    if (process.platform !== "win32" || error.code !== "EPERM") throw error;
  }
  const targetDirectory = `${linkPath}-target`;
  await mkdir(targetDirectory, { recursive: true });
  await writeFile(path.join(targetDirectory, "input-manifest.json"), await readFile(fileTargetPath));
  await symlink(targetDirectory, linkPath, "junction");
  return { relativePath: path.basename(linkPath), mode: "junction-object" };
}

test("manifest and candidate input symlink or junction paths are rejected where supported", async () => {
  await withFixture(async (root, fixture) => {
    const manifestLink = path.join(root, "manifest-link.json");
    const createdManifestLink = await createFileSymlinkOrWindowsJunction(manifestLink, fixture.manifestPath);
    await assert.rejects(() => preflightWhisperFallbackCandidate(root, path.join(root, createdManifestLink.relativePath)), /WHISPER_PREFLIGHT_(MANIFEST_FILE|SPECIAL_FILE)/u);

    const candidateLink = path.join(root, "inputs", "runtime-link.bytes");
    const createdCandidateLink = await createFileSymlinkOrWindowsJunction(candidateLink, path.join(root, "inputs", "runtime.bytes"));
    const manifest = mutateManifest(fixture, (value) => {
      value.files.find((entry) => entry.role === "runtime").relative_path = `inputs/${createdCandidateLink.relativePath}`;
    });
    await writeManifest(fixture.manifestPath, manifest);
    await assert.rejects(() => preflightWhisperFallbackCandidate(root, fixture.manifestPath), /WHISPER_PREFLIGHT_SPECIAL_FILE/u);
  });
});

test("candidate input hardlinks are rejected where the platform reports them", async (context) => {
  await withFixture(async (root, fixture) => {
    const hardlinkPath = path.join(root, "inputs", "runtime-hardlink.bytes");
    try {
      await link(path.join(root, "inputs", "runtime.bytes"), hardlinkPath);
    } catch (error) {
      context.skip(`hardlink creation unavailable: ${error.code ?? error.message}`);
      return;
    }
    const manifest = mutateManifest(fixture, (value) => {
      const runtime = value.files.find((entry) => entry.role === "runtime");
      runtime.relative_path = "inputs/runtime-hardlink.bytes";
    });
    await writeManifest(fixture.manifestPath, manifest);
    await assert.rejects(() => preflightWhisperFallbackCandidate(root, fixture.manifestPath), /WHISPER_PREFLIGHT_SPECIAL_FILE/u);
  });
});

test("Windows junction ancestors are rejected where supported", async (context) => {
  if (process.platform !== "win32") {
    context.skip("Windows junction test");
    return;
  }
  await withFixture(async (root, fixture) => {
    const target = path.join(root, "inputs");
    const junction = path.join(root, "junction-inputs");
    try {
      await symlink(target, junction, "junction");
    } catch (error) {
      context.skip(`junction creation unavailable: ${error.code ?? error.message}`);
      return;
    }
    const manifest = mutateManifest(fixture, (value) => {
      const runtime = value.files.find((entry) => entry.role === "runtime");
      runtime.relative_path = "junction-inputs/runtime.bytes";
    });
    await writeManifest(fixture.manifestPath, manifest);
    await assert.rejects(
      () => preflightWhisperFallbackCandidate(root, fixture.manifestPath),
      /WHISPER_PREFLIGHT_SPECIAL_FILE/u,
    );
  });
});

test("manifest and evidence reject execution, distribution, selection, fallback, and claim overreach", async () => {
  await withFixture(async (root, fixture) => {
    for (const [field, value] of [
      ["measurement_status", "model-selected"],
      ["execution_status", "executed"],
      ["quality_gate_status", "passed"],
      ["formal_claims", "WER-claim"],
      ["production_evidence", true],
      ["public_distribution", true],
      ["selection_authority", "selected"],
      ["fallback_authority", "fallback-selected"],
    ]) {
      const manifest = mutateManifest(fixture, (item) => {
        item[field] = value;
      });
      await writeManifest(fixture.manifestPath, manifest);
      await assert.rejects(() => preflightWhisperFallbackCandidate(root, fixture.manifestPath), /WHISPER_PREFLIGHT_OVERCLAIM/u);
    }
    await writeManifest(fixture.manifestPath, fixture.manifest);
    const evidence = await preflightWhisperFallbackCandidate(root, fixture.manifestPath);
    assert.throws(() => validatePublicEvidence({ ...evidence, public_distribution: true }), /WHISPER_PREFLIGHT_EVIDENCE_OVERCLAIM/u);
    assert.throws(() => validatePublicEvidence({ ...evidence, fallback_authority: "selected" }), /WHISPER_PREFLIGHT_EVIDENCE_OVERCLAIM/u);
  });
});

test("public evidence scanner rejects paths, plaintext, model names, transcripts, and secret markers", () => {
  assert.throws(() => scanForbiddenPublicEvidence({ path: "hidden" }), /WHISPER_PREFLIGHT_EVIDENCE_FORBIDDEN/u);
  assert.throws(() => scanForbiddenPublicEvidence({ safe: "C:\\secret\\model.bin" }), /WHISPER_PREFLIGHT_EVIDENCE_FORBIDDEN/u);
  assert.throws(() => scanForbiddenPublicEvidence({ safe: "BEGIN PRIVATE KEY" }), /WHISPER_PREFLIGHT_EVIDENCE_FORBIDDEN/u);
  assert.throws(() => scanForbiddenPublicEvidence({ safe: "transcript output" }), /WHISPER_PREFLIGHT_EVIDENCE_FORBIDDEN/u);
  assert.throws(() => scanForbiddenPublicEvidence({ safe: "ggml-base.bin" }), /WHISPER_PREFLIGHT_EVIDENCE_FORBIDDEN/u);
});

test("CLI run and validate emit strict deterministic verification markers", async () => {
  const first = await execFileAsync(process.execPath, [MODULE_PATH], { encoding: "utf8", windowsHide: true });
  const second = await execFileAsync(process.execPath, [MODULE_PATH, "--run-synthetic"], { encoding: "utf8", windowsHide: true });
  assert.equal(first.stderr, "");
  assert.equal(second.stderr, "");
  assert.match(
    first.stdout,
    /^whisper-fallback-candidate-preflight=verified evidence_sha256=[0-9a-f]{64} candidate_aggregate_sha256=[0-9a-f]{64} roles=7 measurement_status=whisper-fallback-identity-preflight-only execution_status=not-executed-no-model-no-transcription quality_gate_status=not-assessed formal_claims=none production_evidence=false public_distribution=false selection_authority=none fallback_authority=none\r?\n$/u,
  );
  assert.equal(first.stdout, second.stdout);
});

test("CLI rejects unknown arguments with empty stdout", async () => {
  const result = await execFileAsync(process.execPath, [MODULE_PATH, "--unknown"], {
    encoding: "utf8",
    windowsHide: true,
  }).catch((error) => error);
  assert.equal(result.stdout ?? "", "");
  assert.match(result.stderr, /WHISPER_PREFLIGHT_USAGE: usage: node tools\/whisper-native\/whisper-fallback-candidate-preflight\.mjs/u);
  assert.equal(result.code, 1);
});

test("source, scripts, workflow, and READMEs stay within identity-preflight-only authority", async () => {
  const source = await readFile(MODULE_PATH, "utf8");
  const imports = [...source.matchAll(/from\s+"(node:[^"]+)"/gu)].map((match) => match[1]).sort();
  assert.deepEqual(imports, ["node:crypto", "node:fs", "node:fs/promises", "node:os", "node:path", "node:url", "node:util"]);
  assert.doesNotMatch(source, /node:child_process|node:http|node:https|node:net|node:tls|node:dns/u);
  assert.doesNotMatch(source, /\b(?:spawn|execFile|exec|fetch|importScripts)\s*\(/u);
  assert.doesNotMatch(source, /\bprocess\.env\b|load_model\s*\(|transcribe\s*\(|audio_decode\s*\(|default_candidate\s*=|https?\.request/iu);

  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  assert.equal(packageJson.scripts["phase0:whisper-candidate-preflight:test"], "node --test tools/whisper-native/whisper-fallback-candidate-preflight.test.mjs");
  assert.equal(packageJson.scripts["phase0:whisper-candidate-preflight:validate"], "node tools/whisper-native/whisper-fallback-candidate-preflight.mjs --run-synthetic");
  const workflow = await readFile(".github/workflows/ci.yml", "utf8");
  assert.match(workflow, /phase0:whisper-candidate-preflight:test/u);
  assert.match(workflow, /phase0:whisper-candidate-preflight:validate/u);
  const rootReadme = await readFile("README.md", "utf8");
  assert.match(rootReadme, /README\.phase0-archive\.md/u);
  assert.match(rootReadme, /Optional Hardening \/ Archived Phase 0/u);
  const archivedReadme = await readFile("README.phase0-archive.md", "utf8");
  assert.match(archivedReadme, /WP-0\.4\.5b whisper fallback candidate preflight/u);
  const crateReadme = await readFile("crates/model-worker-whisper-native/README.md", "utf8");
  assert.match(crateReadme, /WP-0\.4\.5b/u);
  assert.equal(sha256(Buffer.from("abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(sha256Hex(Buffer.from("abc")), sha256(Buffer.from("abc")));
});
