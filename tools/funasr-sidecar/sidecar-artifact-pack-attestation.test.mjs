import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { link, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { encodeCanonicalJson } from "../phase0-harness/canonical-json.mjs";
import {
  attestArtifactPack,
  createSyntheticArtifactPackFixture,
  validatePublicEvidence,
} from "./sidecar-artifact-pack-attestation.mjs";
import { preflightCandidate } from "./sidecar-candidate-preflight.mjs";

const execFileAsync = promisify(execFile);
const MODULE_PATH = "tools/funasr-sidecar/sidecar-artifact-pack-attestation.mjs";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function withFixture(fn, options = {}) {
  const fixture = await createSyntheticArtifactPackFixture(options);
  try {
    return await fn(fixture);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
}

async function readManifest(fixture) {
  return JSON.parse(await readFile(fixture.artifactPackManifestPath, "utf8"));
}

async function writeManifest(fixture, manifest) {
  await writeFile(fixture.artifactPackManifestPath, encodeCanonicalJson(manifest), "utf8");
}

async function rewriteInputManifest(fixture, manifest) {
  await writeFile(fixture.manifestPath, encodeCanonicalJson(manifest), "utf8");
}

async function expectReject(mutator, pattern) {
  await withFixture(async (fixture) => {
    await mutator(fixture);
    await assert.rejects(
      () => attestArtifactPack(fixture.root, fixture.manifestPath, fixture.artifactPackManifestPath, fixture.aggregate),
      pattern,
    );
  });
}

async function rebindPackageLockFixture(fixture) {
  const bytes = encodeCanonicalJson(fixture.lock);
  await writeFile(path.join(fixture.root, "inputs/package-lock.json"), bytes, "utf8");
  const input = JSON.parse(await readFile(fixture.manifestPath, "utf8"));
  const role = input.files.find((file) => file.role === "package-lock");
  role.sha256 = sha256(bytes);
  role.size_bytes = Buffer.byteLength(bytes);
  await rewriteInputManifest(fixture, input);
  const preflight = await preflightCandidate(fixture.root, fixture.manifestPath);
  const manifest = await readManifest(fixture);
  manifest.package_lock_sha256 = role.sha256;
  manifest.candidate_aggregate_sha256 = preflight.candidate_descriptor.aggregate_sha256;
  await writeManifest(fixture, manifest);
  return preflight.candidate_descriptor.aggregate_sha256;
}

test("positive artifact-pack evidence is deterministic, scoped, and path-free", async () => {
  await withFixture(async (fixture) => {
    const first = await attestArtifactPack(fixture.root, fixture.manifestPath, fixture.artifactPackManifestPath, fixture.aggregate);
    const second = await attestArtifactPack(fixture.root, fixture.manifestPath, fixture.artifactPackManifestPath, fixture.aggregate);
    const relativeManifest = await attestArtifactPack(fixture.root, fixture.manifestPath, "artifact-pack-manifest.json", fixture.aggregate);
    assert.deepEqual(first, second);
    assert.deepEqual(first, relativeManifest);
    assert.equal(first.measurement_status, "artifact-pack-target-byte-attestation-only");
    assert.equal(first.execution_status, "artifact-target-bytes-verified-no-install-no-import");
    assert.equal(first.packaging_authority, "artifact-pack-byte-identity-only");
    assert.equal(first.source_build_authority, "source-archive-and-build-record-target-bytes-bound-only");
    assert.equal(first.license_authority, "license-set-target-bytes-verified-not-legal-approval");
    assert.equal(first.resolver_report_authority, "target-record-bytes-bound-only");
    assert.equal(first.environment_report_authority, "expected-projection-target-bytes-bound-only");
    assert.equal(first.import_map_authority, "target-bytes-bound-no-import");
    assert.equal(first.package_metadata_authority, "none");
    assert.equal(first.environment_materialization_authority, "none");
    assert.equal(first.cpython_provenance_authority, "none");
    assert.equal(first.import_authority, "none");
    assert.equal(first.input_scope, "synthetic-artifact-pack-contract-only");
    assert.equal(first.distribution_count, 77);
    assert.equal(first.verified_artifact_count, 90);
    assert.doesNotMatch(encodeCanonicalJson(first), /[A-Za-z]:\\|wheelhouse\/|artifacts\/|inputs\/|https?:\/\/|funasr==|torch==|torchaudio==|\.whl|\.tar\.gz|LICENSE/u);
  });
});

test("CLI run-synthetic marker and validate-json succeed", async () => {
  const run = await execFileAsync(process.execPath, [MODULE_PATH, "--run-synthetic"], {
    cwd: process.cwd(),
    windowsHide: true,
    timeout: 120_000,
  });
  assert.match(run.stdout, /^funasr-sidecar-artifact-pack-attestation=verified evidence_sha256=[0-9a-f]{64} candidate_aggregate_sha256=[0-9a-f]{64} package_lock_sha256=[0-9a-f]{64} artifact_pack_manifest_sha256=[0-9a-f]{64} distributions=77 wheels=77 root_requirements=3 license_sets=77 source_archives=5 build_records=5 verified_artifacts=90 measurement_status=artifact-pack-target-byte-attestation-only execution_status=artifact-target-bytes-verified-no-install-no-import packaging_authority=artifact-pack-byte-identity-only source_build_authority=source-archive-and-build-record-target-bytes-bound-only license_authority=license-set-target-bytes-verified-not-legal-approval resolver_report_authority=target-record-bytes-bound-only environment_report_authority=expected-projection-target-bytes-bound-only import_map_authority=target-bytes-bound-no-import package_metadata_authority=none environment_materialization_authority=none cpython_provenance_authority=none import_authority=none quality_gate_status=not-assessed formal_claims=none production_evidence=false public_distribution=false selection_authority=none fixture_scope=synthetic-artifact-pack-contract-only\r?\n$/u);

  await withFixture(async (fixture) => {
    const evidence = await attestArtifactPack(fixture.root, fixture.manifestPath, fixture.artifactPackManifestPath, fixture.aggregate);
    const evidencePath = path.join(fixture.root, "evidence.json");
    await writeFile(evidencePath, encodeCanonicalJson(evidence), "utf8");
    const validated = await execFileAsync(process.execPath, [MODULE_PATH, "--validate-json", evidencePath], {
      cwd: process.cwd(),
      windowsHide: true,
      timeout: 30_000,
    });
    assert.match(validated.stdout, /^funasr-sidecar-artifact-pack-attestation-json=verified evidence_sha256=[0-9a-f]{64}\r?\n$/u);

    const prettyPath = path.join(fixture.root, "evidence-pretty.json");
    await writeFile(prettyPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    await assert.rejects(
      () => execFileAsync(process.execPath, [MODULE_PATH, "--validate-json", prettyPath], { cwd: process.cwd(), windowsHide: true, timeout: 30_000 }),
      /canonical JSON/u,
    );

    const invalidUtf8Path = path.join(fixture.root, "evidence-invalid-utf8.json");
    await writeFile(invalidUtf8Path, Buffer.from([0xff, 0xfe, 0x0a]));
    await assert.rejects(
      () => execFileAsync(process.execPath, [MODULE_PATH, "--validate-json", invalidUtf8Path], { cwd: process.cwd(), windowsHide: true, timeout: 30_000 }),
      /UTF-8/u,
    );
  });
});

test("4b aggregate and 4e package-lock drift fail closed", async () => {
  await withFixture(async (fixture) => {
    await assert.rejects(
      () => attestArtifactPack(fixture.root, fixture.manifestPath, fixture.artifactPackManifestPath, "1".repeat(64)),
      /FOUR_B|AGGREGATE/u,
    );
  });
  await expectReject(async (fixture) => {
    const input = JSON.parse(await readFile(fixture.manifestPath, "utf8"));
    input.files.find((file) => file.role === "package-lock").size_bytes += 1;
    await rewriteInputManifest(fixture, input);
  }, /PACKAGE_LOCK|PREFLIGHT|DRIFT|SIZE/u);
});

test("artifact manifest and package-lock bindings fail closed on digest drift", async () => {
  await expectReject(async (fixture) => {
    const manifest = await readManifest(fixture);
    manifest.package_lock_sha256 = "1".repeat(64);
    await writeManifest(fixture, manifest);
  }, /MANIFEST_BINDING|LOCK_BINDING/u);
  await expectReject(async (fixture) => {
    const input = JSON.parse(await readFile(fixture.manifestPath, "utf8"));
    input.files.find((file) => file.role === "package-lock").sha256 = "1".repeat(64);
    await rewriteInputManifest(fixture, input);
  }, /INPUT_MANIFEST|PREFLIGHT|LOCK|DIGEST|DRIFT/u);
});

test("manifest canonical shape, counts, order, duplicates, scope, and target are enforced", async () => {
  await expectReject(async (fixture) => {
    await writeFile(fixture.artifactPackManifestPath, `${JSON.stringify(await readManifest(fixture))}\n`, "utf8");
  }, /canonical/i);
  await expectReject(async (fixture) => {
    await writeFile(fixture.artifactPackManifestPath, Buffer.from([0xff, 0xfe, 0x0a]));
  }, /UTF-8/u);
  await expectReject(async (fixture) => {
    const manifest = await readManifest(fixture);
    manifest.unknown = true;
    await writeManifest(fixture, manifest);
  }, /unknown field/u);
  await expectReject(async (fixture) => {
    const manifest = await readManifest(fixture);
    manifest.input_scope = "product-approved";
    await writeManifest(fixture, manifest);
  }, /SCOPE/u);
  await expectReject(async (fixture) => {
    const manifest = await readManifest(fixture);
    manifest.target.platform_tag = "manylinux";
    await writeManifest(fixture, manifest);
  }, /TARGET/u);
  await expectReject(async (fixture) => {
    const manifest = await readManifest(fixture);
    manifest.artifacts.license_sets.pop();
    await writeManifest(fixture, manifest);
  }, /LICENSE_COUNT/u);
  await expectReject(async (fixture) => {
    const manifest = await readManifest(fixture);
    [manifest.artifacts.source_archives[0], manifest.artifacts.source_archives[1]] = [manifest.artifacts.source_archives[1], manifest.artifacts.source_archives[0]];
    await writeManifest(fixture, manifest);
  }, /SOURCE_ORDER|SOURCE_BINDING/u);
  await expectReject(async (fixture) => {
    const manifest = await readManifest(fixture);
    manifest.artifacts.license_sets[1].files[0].relative_path = manifest.artifacts.license_sets[0].files[0].relative_path;
    await writeManifest(fixture, manifest);
  }, /duplicate artifact path/u);
});

test("path escape, reserved names, case collision, target tamper, size and hash drift fail", async () => {
  await expectReject(async (fixture) => {
    const manifest = await readManifest(fixture);
    manifest.artifacts.resolver_report.relative_path = "../resolver.json";
    await writeManifest(fixture, manifest);
  }, /traversal|relative path|escaped/u);
  await expectReject(async (fixture) => {
    const manifest = await readManifest(fixture);
    manifest.artifacts.resolver_report.relative_path = "artifacts/CON";
    await writeManifest(fixture, manifest);
  }, /reserved|unsafe/u);
  await expectReject(async (fixture) => {
    const manifest = await readManifest(fixture);
    manifest.artifacts.license_sets[1].files[0].relative_path = manifest.artifacts.license_sets[0].files[0].relative_path.toUpperCase();
    await writeManifest(fixture, manifest);
  }, /case-insensitive duplicate/u);
  await expectReject(async (fixture) => {
    const manifest = await readManifest(fixture);
    manifest.artifacts.resolver_report.sha256 = "1".repeat(64);
    await writeManifest(fixture, manifest);
  }, /DRIFT|HASH/u);
  await expectReject(async (fixture) => {
    const manifest = await readManifest(fixture);
    manifest.artifacts.resolver_report.size_bytes += 1;
    await writeManifest(fixture, manifest);
  }, /DRIFT/u);
  await expectReject(async (fixture) => {
    const manifest = await readManifest(fixture);
    manifest.artifacts.resolver_report.size_bytes = 4 * 1024 * 1024 + 1;
    await writeManifest(fixture, manifest);
  }, /RESOLVER_REPORT.*size|size.*limit/u);
});

test("declared total artifact budget fails before artifact reads", async () => {
  await expectReject(async (fixture) => {
    const manifest = await readManifest(fixture);
    for (const set of manifest.artifacts.license_sets) {
      set.files[0].size_bytes = 1024 * 1024 * 1024;
    }
    await writeManifest(fixture, manifest);
  }, /ARTIFACT_PACK_TOTAL_SIZE/u);
});

test("symlink and hardlink artifact aliases are rejected when the platform supports them", async () => {
  await withFixture(async (fixture) => {
    const manifest = await readManifest(fixture);
    const original = path.join(fixture.root, manifest.artifacts.resolver_report.relative_path);
    const aliasRelative = "artifacts/resolver-hardlink.json";
    const alias = path.join(fixture.root, aliasRelative);
    try {
      await link(original, alias);
    } catch {
      return;
    }
    manifest.artifacts.resolver_report.relative_path = aliasRelative;
    await writeManifest(fixture, manifest);
    await assert.rejects(() => attestArtifactPack(fixture.root, fixture.manifestPath, fixture.artifactPackManifestPath, fixture.aggregate), /hardlink/u);
  });

  await withFixture(async (fixture) => {
    const manifest = await readManifest(fixture);
    const original = path.join(fixture.root, manifest.artifacts.resolver_report.relative_path);
    const aliasRelative = "artifacts/resolver-symlink.json";
    const alias = path.join(fixture.root, aliasRelative);
    try {
      await symlink(original, alias);
    } catch {
      return;
    }
    manifest.artifacts.resolver_report.relative_path = aliasRelative;
    await writeManifest(fixture, manifest);
    await assert.rejects(() => attestArtifactPack(fixture.root, fixture.manifestPath, fixture.artifactPackManifestPath, fixture.aggregate), /symlink|regular/u);
  });
});

test("license, source, resolver, environment, import-map, and build-record bindings are enforced", async () => {
  await expectReject(async (fixture) => {
    const manifest = await readManifest(fixture);
    manifest.artifacts.license_sets[0].aggregate_sha256 = "1".repeat(64);
    await writeManifest(fixture, manifest);
  }, /LICENSE_AGGREGATE/u);
  await expectReject(async (fixture) => {
    const manifest = await readManifest(fixture);
    manifest.artifacts.source_archives[0].sha256 = "1".repeat(64);
    await writeManifest(fixture, manifest);
  }, /SOURCE.*DRIFT|SOURCE_BINDING/u);
  await expectReject(async (fixture) => {
    const manifest = await readManifest(fixture);
    manifest.artifacts.resolver_report.sha256 = "1".repeat(64);
    await writeManifest(fixture, manifest);
  }, /RESOLVER_REPORT/u);
  await expectReject(async (fixture) => {
    const manifest = await readManifest(fixture);
    manifest.artifacts.expected_environment_report.sha256 = "1".repeat(64);
    await writeManifest(fixture, manifest);
  }, /ENVIRONMENT_REPORT/u);
  await expectReject(async (fixture) => {
    const manifest = await readManifest(fixture);
    manifest.artifacts.top_level_import_map.sha256 = "1".repeat(64);
    await writeManifest(fixture, manifest);
  }, /IMPORT_MAP/u);
  await expectReject(async (fixture) => {
    const manifest = await readManifest(fixture);
    const record = manifest.artifacts.build_records[0];
    const absolute = path.join(fixture.root, record.relative_path);
    const parsed = JSON.parse(await readFile(absolute, "utf8"));
    parsed.wheel_sha256 = "1".repeat(64);
    const bytes = encodeCanonicalJson(parsed);
    await writeFile(absolute, bytes, "utf8");
    record.sha256 = "1".repeat(64);
    record.size_bytes = Buffer.byteLength(bytes);
    await writeManifest(fixture, manifest);
  }, /BUILD_RECORD_BINDING|BUILD_RECORD_DRIFT/u);
});

test("lock invariant drift fails with stable artifact-pack errors", async () => {
  await withFixture(async (fixture) => {
    fixture.lock.root_requirements = ["funasr==1.3.22", "torch==2.6.0+cpu"];
    const aggregate = await rebindPackageLockFixture(fixture);
    await assert.rejects(() => attestArtifactPack(fixture.root, fixture.manifestPath, fixture.artifactPackManifestPath, aggregate), /LOCK_ROOTS|PACKAGE_LOCK_ROOT/u);
  });
  await withFixture(async (fixture) => {
    fixture.lock.distributions.pop();
    const aggregate = await rebindPackageLockFixture(fixture);
    await assert.rejects(() => attestArtifactPack(fixture.root, fixture.manifestPath, fixture.artifactPackManifestPath, aggregate), /LOCK_DISTRIBUTIONS|PACKAGE_LOCK/u);
  });
});

test("source archive basename must match the package-lock source declaration", async () => {
  await expectReject(async (fixture) => {
    const manifest = await readManifest(fixture);
    const source = manifest.artifacts.source_archives[0];
    const renamed = "artifacts/sources/wrong-name.tar.gz";
    await writeFile(path.join(fixture.root, renamed), await readFile(path.join(fixture.root, source.relative_path)));
    source.relative_path = renamed;
    await writeManifest(fixture, manifest);
  }, /SOURCE_FILENAME/u);
});

test("public evidence overclaims and leakage are rejected", async () => {
  await withFixture(async (fixture) => {
    const evidence = await attestArtifactPack(fixture.root, fixture.manifestPath, fixture.artifactPackManifestPath, fixture.aggregate);
    assert.throws(() => validatePublicEvidence({ ...evidence, production_evidence: true }), /OVERCLAIM/u);
    assert.throws(() => validatePublicEvidence({ ...evidence, packaging_authority: "install-approved" }), /OVERCLAIM/u);
    assert.throws(() => validatePublicEvidence({ ...evidence, limitations: ["C:\\secret\\wheelhouse", ...evidence.limitations.slice(1)] }), /FORBIDDEN|SCHEMA/u);
    assert.throws(() => validatePublicEvidence({ ...evidence, artifact_path: "artifacts/resolver-report.json" }), /unknown field/u);
  });
});

test("schema constants and package wiring mention the artifact-pack boundary", async () => {
  const schema = JSON.parse(await readFile("tools/funasr-sidecar/sidecar-artifact-pack-attestation.schema.json", "utf8"));
  assert.equal(schema.properties.measurement_status.const, "artifact-pack-target-byte-attestation-only");
  assert.equal(schema.properties.environment_materialization_authority.const, "none");
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  assert.equal(packageJson.scripts["phase0:funasr-sidecar-artifact-pack:test"], "node --test tools/funasr-sidecar/sidecar-artifact-pack-attestation.test.mjs");
  assert.equal(packageJson.scripts["phase0:funasr-sidecar-artifact-pack:validate"], "node tools/funasr-sidecar/sidecar-artifact-pack-attestation.mjs --run-synthetic");
});

test("static surface streams artifacts, enforces total budget, and does not execute install/import/network APIs", async () => {
  const source = await readFile(MODULE_PATH, "utf8");
  assert.doesNotMatch(source, /child_process|execFile|spawn\(|\bpip\s+install\b|-m\s+venv|python\.exe|import\s+["']funasr|https?\.request|fetch\(|net\.|tls\./u);
  assert.match(source, /MAX_TOTAL_ARTIFACT_BYTES = 16 \* 1024 \* 1024 \* 1024/u);
  assert.match(source, /hashStableRegularFile/u);
  assert.match(source, /openedFile\.handle\.read/u);
  assert.doesNotMatch(source, /readFileSync\(inputManifestPath|readFileSync\(lockPath|function inspectRegularFile/u);
});
