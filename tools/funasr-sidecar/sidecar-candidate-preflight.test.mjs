import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { encodeCanonicalJson } from "../phase0-harness/canonical-json.mjs";
import {
  createSyntheticFixture,
  MAX_CANDIDATE_FILE_BYTES,
  MAX_TOTAL_CANDIDATE_BYTES,
  PREIMAGE_DOMAIN,
  PUBLIC_EVIDENCE_KIND,
  PUBLIC_EVIDENCE_SCHEMA_PATH,
  REQUIRED_ROLES,
  PreflightError,
  preflightCandidate,
  scanForbiddenPublicEvidence,
  sha256Hex,
  validatePublicEvidence,
  validateRelativePath,
} from "./sidecar-candidate-preflight.mjs";

const execFileAsync = promisify(execFile);

async function withFixture(fn) {
  const root = await mkdtemp(path.join(tmpdir(), "meetingrelay-preflight-test-"));
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

test("preflight consumes synthetic controlled-root bytes and emits deterministic path-free public evidence", async () => {
  await withFixture(async (root, fixture) => {
    const left = await preflightCandidate(root, fixture.manifestPath);
    const right = await preflightCandidate(root, fixture.manifestPath);
    assert.deepEqual(left, right);
    assert.equal(left.kind, PUBLIC_EVIDENCE_KIND);
    assert.equal(left.measurement_status, "identity-preflight-only");
    assert.equal(left.execution_status, "not-executed");
    assert.equal(left.quality_gate_status, "not-assessed");
    assert.equal(left.formal_claims, "none");
    assert.equal(left.production_evidence, false);
    assert.equal(left.public_distribution, false);
    assert.equal(left.selection_authority, "none");
    assert.equal(left.worker_role, "sidecar-candidate");
    assert.deepEqual(left.roles.map((entry) => entry.role), REQUIRED_ROLES);
    assert.equal(left.candidate_descriptor.preimage_domain, PREIMAGE_DOMAIN);
    assert.equal(left.candidate_descriptor.role_count, 7);
    assert.doesNotThrow(() => validatePublicEvidence(left));
    const serialized = JSON.stringify(left);
    for (const forbidden of ["inputs/", "runtime.bin", "license.txt", root, "synthetic model bytes"]) {
      assert.equal(serialized.includes(forbidden), false, forbidden);
    }
  });
});

test("schema parity mirrors manual validator constants", async () => {
  const schema = JSON.parse(await readFile(PUBLIC_EVIDENCE_SCHEMA_PATH, "utf8"));
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.kind.const, PUBLIC_EVIDENCE_KIND);
  assert.equal(schema.properties.schema_version.const, "1.0");
  assert.equal(schema.properties.measurement_status.const, "identity-preflight-only");
  assert.equal(schema.properties.execution_status.const, "not-executed");
  assert.equal(schema.properties.quality_gate_status.const, "not-assessed");
  assert.equal(schema.properties.formal_claims.const, "none");
  assert.equal(schema.properties.production_evidence.const, false);
  assert.equal(schema.properties.public_distribution.const, false);
  assert.equal(schema.properties.selection_authority.const, "none");
  assert.equal(schema.properties.roles.minItems, 7);
  assert.equal(schema.properties.roles.maxItems, 7);
  assert.equal(schema.properties.roles.items, false);
  assert.deepEqual(
    schema.properties.roles.prefixItems.map((item) => schema.$defs[item.$ref.replace("#/$defs/", "")].allOf[1].properties.role.const),
    REQUIRED_ROLES,
  );
  assert.equal(schema.$defs.role_row.additionalProperties, false);
  assert.deepEqual(schema.$defs.role_row.required, ["role", "logical_id_sha256", "sha256", "size_bytes"]);
  assert.equal(schema.$defs.role_row.properties.size_bytes.maximum, MAX_CANDIDATE_FILE_BYTES);
  assert.equal(schema.properties.candidate_descriptor.properties.preimage_domain.const, PREIMAGE_DOMAIN);
  assert.equal(schema.properties.limitations.minItems, 4);
});

test("canonical manifest and evidence JSON fail closed on unknown fields and newline drift", async () => {
  await withFixture(async (root, fixture) => {
    const unknown = mutateManifest(fixture, (manifest) => {
      manifest.files[0].unknown = true;
    });
    await writeManifest(fixture.manifestPath, unknown);
    await assert.rejects(() => preflightCandidate(root, fixture.manifestPath), /IDENTITY_PREFLIGHT_MANIFEST/u);

    const good = mutateManifest(fixture, () => {});
    await writeFile(fixture.manifestPath, JSON.stringify(good), "utf8");
    await assert.rejects(() => preflightCandidate(root, fixture.manifestPath), /IDENTITY_PREFLIGHT_MANIFEST_CANONICAL/u);

    await writeManifest(fixture.manifestPath, good);
    const evidence = await preflightCandidate(root, fixture.manifestPath);
    const compact = JSON.stringify(evidence);
    assert.throws(
      () => validatePublicEvidence({ ...evidence, extra: true }),
      /IDENTITY_PREFLIGHT_EVIDENCE_SCHEMA/u,
    );
    const { stderr, stdout } = await execFileAsync(
      process.execPath,
      ["tools/funasr-sidecar/sidecar-candidate-preflight.mjs", "--validate-json", compact],
      { encoding: "utf8", windowsHide: true },
    ).catch((error) => error);
    assert.equal(stdout ?? "", "");
    assert.match(stderr, /IDENTITY_PREFLIGHT_EVIDENCE_CANONICAL/u);
  });
});

test("canonical JSON rejects invalid UTF-8 bytes before parsing", async () => {
  await withFixture(async (root, fixture) => {
    await writeFile(fixture.manifestPath, Buffer.from([0xff, 0x0a]));
    await assert.rejects(() => preflightCandidate(root, fixture.manifestPath), /IDENTITY_PREFLIGHT_MANIFEST_CANONICAL/u);
  });
});

test("role set, logical IDs, uppercase or zero digests, empty and oversized inputs fail closed", async () => {
  const cases = [
    ["duplicate role", (manifest) => { manifest.files[0].role = manifest.files[1].role; }, /IDENTITY_PREFLIGHT_ROLE_SET/u],
    ["duplicate logical id", (manifest) => { manifest.files[0].logical_id = manifest.files[1].logical_id; }, /IDENTITY_PREFLIGHT_LOGICAL_ID/u],
    ["uppercase sha", (manifest) => { manifest.files[0].sha256 = "A".repeat(64); }, /IDENTITY_PREFLIGHT_DIGEST/u],
    ["zero sha", (manifest) => { manifest.files[0].sha256 = "0".repeat(64); }, /IDENTITY_PREFLIGHT_DIGEST/u],
    ["empty size", (manifest) => { manifest.files[0].size_bytes = 0; }, /IDENTITY_PREFLIGHT_SIZE/u],
    ["oversized", (manifest) => { manifest.files[0].size_bytes = MAX_CANDIDATE_FILE_BYTES + 1; }, /IDENTITY_PREFLIGHT_SIZE/u],
    ["total oversized", (manifest) => {
      manifest.files.forEach((entry) => {
        entry.size_bytes = Math.floor(MAX_TOTAL_CANDIDATE_BYTES / REQUIRED_ROLES.length) + 1;
      });
    }, /IDENTITY_PREFLIGHT_SIZE/u],
  ];
  for (const [name, mutate, pattern] of cases) {
    await test(name, async () => {
      await withFixture(async (root, fixture) => {
        const manifest = mutateManifest(fixture, mutate);
        await writeManifest(fixture.manifestPath, manifest);
        await assert.rejects(() => preflightCandidate(root, fixture.manifestPath), pattern);
      });
    });
  }
});

test("size and hash drift fail closed by re-reading caller-provided bytes", async () => {
  await withFixture(async (root, fixture) => {
    const drift = path.join(root, "inputs", "model.bin");
    await writeFile(drift, "changed bytes\n", "utf8");
    await assert.rejects(() => preflightCandidate(root, fixture.manifestPath), /IDENTITY_PREFLIGHT_(SIZE|HASH)_DRIFT/u);
  });
});

test("same-size byte tamper fails with hash drift", async () => {
  await withFixture(async (root, fixture) => {
    const entry = fixture.manifest.files.find((candidate) => candidate.role === "model");
    const filePath = path.join(root, ...entry.relative_path.split("/"));
    await writeFile(filePath, "S".repeat(entry.size_bytes), "utf8");
    await assert.rejects(() => preflightCandidate(root, fixture.manifestPath), /IDENTITY_PREFLIGHT_HASH_DRIFT/u);
  });
});

test("streaming hash supports candidate files over one MiB without whole-file readFile", async () => {
  await withFixture(async (root, fixture) => {
    const entry = fixture.manifest.files.find((candidate) => candidate.role === "model");
    const bytes = Buffer.alloc(1_048_577, 0x5a);
    const filePath = path.join(root, ...entry.relative_path.split("/"));
    await writeFile(filePath, bytes);
    entry.sha256 = sha256(bytes);
    entry.size_bytes = bytes.length;
    await writeManifest(fixture.manifestPath, fixture.manifest);
    const evidence = await preflightCandidate(root, fixture.manifestPath);
    const model = evidence.roles.find((candidate) => candidate.role === "model");
    assert.equal(model.size_bytes, bytes.length);
    assert.equal(model.sha256, sha256(bytes));
    assert.throws(
      () => validatePublicEvidence({ ...evidence, roles: [evidence.roles[1], evidence.roles[0], ...evidence.roles.slice(2)] }),
      /IDENTITY_PREFLIGHT_EVIDENCE_SCHEMA/u,
    );
    assert.throws(
      () => validatePublicEvidence({ ...evidence, roles: [evidence.roles[0], evidence.roles[0], ...evidence.roles.slice(2)] }),
      /IDENTITY_PREFLIGHT_EVIDENCE_SCHEMA/u,
    );
  });
});

test("path attacks and duplicate case-insensitive paths are rejected before content identity", async () => {
  const attacks = [
    "../escape.bin",
    "/absolute.bin",
    "C:/absolute.bin",
    "dir\\backslash.bin",
    "dir/file.txt:ads",
    "dir/CON",
    "dir/trailing.",
    "dir/trailing ",
    "dir//empty",
    "dir/cafe\u0301.bin",
  ];
  for (const attack of attacks) {
    assert.throws(() => validateRelativePath(attack), PreflightError, attack);
  }
  await withFixture(async (root, fixture) => {
    const manifest = mutateManifest(fixture, (value) => {
      value.files[0].relative_path = "inputs/DUP.bin";
      value.files[1].relative_path = "inputs/dup.bin";
    });
    await writeManifest(fixture.manifestPath, manifest);
    await assert.rejects(() => preflightCandidate(root, fixture.manifestPath), /IDENTITY_PREFLIGHT_PATH/u);
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

test("manifest file rejects direct symlink-or-junction reparse paths", async () => {
  await withFixture(async (root, fixture) => {
    const link = path.join(root, "manifest-link.json");
    const created = await createFileSymlinkOrWindowsJunction(link, fixture.manifestPath);
    await assert.rejects(() => preflightCandidate(root, path.join(root, created.relativePath)), /IDENTITY_PREFLIGHT_(MANIFEST_FILE|SPECIAL_FILE)/u);
    assert.match(created.mode, /^(file-symlink|junction-object)$/u);
  });
});

test("manifest files must appear in exact required role order", async () => {
  await withFixture(async (root, fixture) => {
    const manifest = mutateManifest(fixture, (value) => {
      [value.files[0], value.files[1]] = [value.files[1], value.files[0]];
    });
    await writeManifest(fixture.manifestPath, manifest);
    await assert.rejects(() => preflightCandidate(root, fixture.manifestPath), /IDENTITY_PREFLIGHT_ROLE_SET/u);
  });
});

test("controlled root must be absolute local syntax", async () => {
  await withFixture(async (_root, fixture) => {
    await assert.rejects(() => preflightCandidate("relative-root", fixture.manifestPath), /IDENTITY_PREFLIGHT_ROOT/u);
    if (process.platform === "win32") {
      await assert.rejects(() => preflightCandidate("\\\\server\\share\\root", fixture.manifestPath), /IDENTITY_PREFLIGHT_ROOT/u);
      await assert.rejects(() => preflightCandidate("\\\\?\\C:\\root", fixture.manifestPath), /IDENTITY_PREFLIGHT_ROOT/u);
    }
  });
});

test("manifest path may be relative but rejects UNC and device syntax", async () => {
  await withFixture(async (root, fixture) => {
    const relativeManifest = path.relative(process.cwd(), fixture.manifestPath);
    const evidence = await preflightCandidate(root, relativeManifest);
    assert.equal(evidence.roles.length, 7);
    if (process.platform === "win32") {
      await assert.rejects(() => preflightCandidate(root, "\\\\server\\share\\input-manifest.json"), /IDENTITY_PREFLIGHT_MANIFEST_FILE/u);
      await assert.rejects(() => preflightCandidate(root, "\\\\?\\C:\\input-manifest.json"), /IDENTITY_PREFLIGHT_MANIFEST_FILE/u);
      await assert.rejects(() => preflightCandidate(root, "C:input-manifest.json"), /IDENTITY_PREFLIGHT_MANIFEST_FILE/u);
      await assert.rejects(() => preflightCandidate(root, "manifest.json:ads"), /IDENTITY_PREFLIGHT_MANIFEST_FILE/u);
    }
  });
});

test("controlled root rejects drive-relative and ADS-like syntax while allowing normal absolute drive paths", async () => {
  await withFixture(async (root, fixture) => {
    if (process.platform !== "win32") return;
    await assert.rejects(() => preflightCandidate("C:relative-root", fixture.manifestPath), /IDENTITY_PREFLIGHT_ROOT/u);
    await assert.rejects(() => preflightCandidate(`${root}:ads`, fixture.manifestPath), /IDENTITY_PREFLIGHT_ROOT/u);
    const evidence = await preflightCandidate(root, fixture.manifestPath);
    assert.equal(evidence.roles.length, 7);
  });
});

test("candidate inputs reject direct symlink-or-junction reparse paths", async () => {
  await withFixture(async (root, fixture) => {
    const linkPath = path.join(root, "inputs", "runtime-link.bin");
    const created = await createFileSymlinkOrWindowsJunction(linkPath, path.join(root, "inputs", "runtime.bin"));
    const manifest = mutateManifest(fixture, (value) => {
      const runtime = value.files.find((entry) => entry.role === "runtime");
      runtime.relative_path = `inputs/${created.relativePath}`;
    });
    await writeManifest(fixture.manifestPath, manifest);
    await assert.rejects(() => preflightCandidate(root, fixture.manifestPath), /IDENTITY_PREFLIGHT_SPECIAL_FILE/u);
    assert.match(created.mode, /^(file-symlink|junction-object)$/u);
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
      runtime.relative_path = "junction-inputs/runtime.bin";
    });
    await writeManifest(fixture.manifestPath, manifest);
    await assert.rejects(() => preflightCandidate(root, fixture.manifestPath), /IDENTITY_PREFLIGHT_SPECIAL_FILE/u);
  });
});

test("manifest and public evidence reject execution, distribution, license, and selection overclaims", async () => {
  await withFixture(async (root, fixture) => {
    for (const [field, value] of [
      ["execution_status", "executed"],
      ["quality_gate_status", "passed"],
      ["formal_claims", "PERF-1"],
      ["production_evidence", true],
      ["public_distribution", true],
      ["selection_authority", "default"],
    ]) {
      const manifest = mutateManifest(fixture, (item) => {
        item[field] = value;
      });
      await writeManifest(fixture.manifestPath, manifest);
      await assert.rejects(() => preflightCandidate(root, fixture.manifestPath), /IDENTITY_PREFLIGHT_OVERCLAIM/u);
    }
    await writeManifest(fixture.manifestPath, fixture.manifest);
    const evidence = await preflightCandidate(root, fixture.manifestPath);
    assert.throws(() => validatePublicEvidence({ ...evidence, public_distribution: true }), /IDENTITY_PREFLIGHT_EVIDENCE_OVERCLAIM/u);
    assert.throws(() => validatePublicEvidence({ ...evidence, selection_authority: "default" }), /IDENTITY_PREFLIGHT_EVIDENCE_OVERCLAIM/u);
  });
});

test("public evidence scanner rejects paths, plaintext, transcript, and secret markers", () => {
  assert.throws(() => scanForbiddenPublicEvidence({ path: "hidden" }), /IDENTITY_PREFLIGHT_EVIDENCE_FORBIDDEN/u);
  assert.throws(() => scanForbiddenPublicEvidence({ safe: "C:\\secret\\model.bin" }), /IDENTITY_PREFLIGHT_EVIDENCE_FORBIDDEN/u);
  assert.throws(() => scanForbiddenPublicEvidence({ safe: "BEGIN PRIVATE KEY" }), /IDENTITY_PREFLIGHT_EVIDENCE_FORBIDDEN/u);
  assert.throws(() => scanForbiddenPublicEvidence({ safe: "transcript output" }), /IDENTITY_PREFLIGHT_EVIDENCE_FORBIDDEN/u);
});

test("CLI run and validate emit strict deterministic verification markers", async () => {
  const first = await execFileAsync(process.execPath, ["tools/funasr-sidecar/sidecar-candidate-preflight.mjs"], {
    encoding: "utf8",
    windowsHide: true,
  });
  const second = await execFileAsync(process.execPath, ["tools/funasr-sidecar/sidecar-candidate-preflight.mjs", "--run-synthetic"], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(first.stderr, "");
  assert.equal(second.stderr, "");
  assert.match(
    first.stdout,
    /^funasr-sidecar-candidate-preflight=verified evidence_sha256=[0-9a-f]{64} candidate_aggregate_sha256=[0-9a-f]{64} roles=7 measurement_status=identity-preflight-only execution_status=not-executed quality_gate_status=not-assessed formal_claims=none production_evidence=false public_distribution=false selection_authority=none\r?\n$/u,
  );
  assert.equal(first.stdout, second.stdout);
});

test("CLI rejects unknown arguments with empty stdout", async () => {
  const result = await execFileAsync(
    process.execPath,
    ["tools/funasr-sidecar/sidecar-candidate-preflight.mjs", "--unknown"],
    { encoding: "utf8", windowsHide: true },
  ).catch((error) => error);
  assert.equal(result.stdout ?? "", "");
  assert.match(result.stderr, /IDENTITY_PREFLIGHT_USAGE: usage: node tools\/funasr-sidecar\/sidecar-candidate-preflight\.mjs/u);
  assert.equal(result.code, 1);
});

test("source stays Node-stdlib identity preflight only with no execution or network surface", async () => {
  const source = await readFile("tools/funasr-sidecar/sidecar-candidate-preflight.mjs", "utf8");
  const imports = [...source.matchAll(/from\s+"(node:[^"]+)"/gu)].map((match) => match[1]).sort();
  assert.deepEqual(imports, [
    "node:crypto",
    "node:fs",
    "node:fs/promises",
    "node:os",
    "node:path",
    "node:url",
    "node:util",
  ]);
  assert.doesNotMatch(source, /node:child_process|node:http|node:https|node:net|node:tls|node:dns/u);
  assert.doesNotMatch(source, /\b(?:spawn|execFile|exec|fetch|importScripts)\s*\(/u);
  assert.doesNotMatch(source, /\bprocess\.env\b|python(?:\.exe)?\s+tools|funasr\.AutoModel|from\s+funasr|import\s+funasr/iu);
  assert.equal(sha256(Buffer.from("abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(sha256Hex(Buffer.from("abc")), sha256(Buffer.from("abc")));
});
