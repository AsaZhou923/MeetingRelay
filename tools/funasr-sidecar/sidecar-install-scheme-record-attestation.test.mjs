import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test, { after } from "node:test";
import { promisify } from "node:util";

import { encodeCanonicalJson } from "../phase0-harness/canonical-json.mjs";
import {
  ATTESTOR_SOURCE_PATH,
  PUBLIC_EVIDENCE_KIND,
  PUBLIC_EVIDENCE_SCHEMA_PATH,
  PUBLIC_EVIDENCE_SCHEMA_VERSION,
  attestInstallSchemeRecordClosure,
  createSyntheticInstallSchemeRecordFixture,
  validatePublicEvidence,
} from "./sidecar-install-scheme-record-attestation.mjs";

const execFileAsync = promisify(execFile);
const MODULE_PATH = "tools/funasr-sidecar/sidecar-install-scheme-record-attestation.mjs";
const ZERO_SHA = "0".repeat(64);
const ownedRoots = new Set();
let sharedPromise;
let secondaryPromise;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalClone(value) {
  return JSON.parse(JSON.stringify(value));
}

after(async () => {
  await Promise.all([...ownedRoots].map((root) => rm(root, { recursive: true, force: true })));
  ownedRoots.clear();
});

async function createFixture(options = {}) {
  const fixture = await createSyntheticInstallSchemeRecordFixture(options);
  ownedRoots.add(fixture.root);
  return fixture;
}

async function sharedPositive() {
  if (sharedPromise === undefined) {
    sharedPromise = (async () => {
      const fixture = await createFixture();
      const evidence = await attestInstallSchemeRecordClosure(
        fixture.root,
        fixture.manifestPath,
        fixture.artifactPackManifestPath,
        fixture.venvPython,
        fixture.aggregate,
        { inputScope: "synthetic-install-scheme-record-contract-only" },
      );
      return { evidence, fixture };
    })();
  }
  return await sharedPromise;
}

async function freshPositive(options = {}) {
  const fixture = await createFixture(options);
  const evidence = await attestInstallSchemeRecordClosure(
    fixture.root,
    fixture.manifestPath,
    fixture.artifactPackManifestPath,
    fixture.venvPython,
    fixture.aggregate,
    { inputScope: "synthetic-install-scheme-record-contract-only" },
  );
  return { evidence, fixture };
}

async function secondaryPositive() {
  if (secondaryPromise === undefined) secondaryPromise = freshPositive();
  return await secondaryPromise;
}

async function readArtifactManifest(fixture) {
  return JSON.parse(await readFile(fixture.artifactPackManifestPath, "utf8"));
}

async function writeArtifactManifest(fixture, manifest) {
  await writeFile(fixture.artifactPackManifestPath, encodeCanonicalJson(manifest), "utf8");
}

async function expectReject(mutator, pattern) {
  const fixture = await createFixture();
  await mutator(fixture);
  await assert.rejects(
    () => attestInstallSchemeRecordClosure(fixture.root, fixture.manifestPath, fixture.artifactPackManifestPath, fixture.venvPython, fixture.aggregate),
    pattern,
  );
}

test("synthetic positive evidence is deterministic, path-free, and public-authority scoped", async () => {
  const { evidence } = await sharedPositive();
  const { evidence: second } = await secondaryPositive();

  assert.deepEqual(evidence, second);
  assert.equal(evidence.kind, PUBLIC_EVIDENCE_KIND);
  assert.equal(evidence.schema_version, PUBLIC_EVIDENCE_SCHEMA_VERSION);
  assert.equal(evidence.measurement_status, "controlled-wheelhouse-install-scheme-record-closure-only");
  assert.equal(evidence.execution_status, "offline-install-pip-check-inspect-record-closure-no-funasr-import");
  assert.equal(evidence.packaging_authority, "artifact-pack-and-install-scheme-byte-closure-only");
  assert.equal(evidence.source_build_authority, "source-archive-and-build-record-target-bytes-bound-only");
  assert.equal(evidence.license_authority, "license-set-target-bytes-verified-not-legal-approval");
  assert.equal(evidence.resolver_report_authority, "target-record-bytes-bound-only");
  assert.equal(evidence.environment_report_authority, "expected-projection-target-bytes-bound-only");
  assert.equal(evidence.import_map_authority, "target-bytes-bound-no-import");
  assert.equal(evidence.package_metadata_authority, "installed-dist-info-record-and-allowlisted-scheme-files-verified-only");
  assert.equal(evidence.environment_materialization_authority, "offline-venv-materialized");
  assert.equal(evidence.install_scheme_authority, "bound-runtime-sysconfig-observed-only");
  assert.equal(evidence.cpython_provenance_authority, "none");
  assert.equal(evidence.import_authority, "none");
  assert.equal(evidence.quality_gate_status, "not-assessed");
  assert.equal(evidence.formal_claims, "none");
  assert.equal(evidence.production_evidence, false);
  assert.equal(evidence.public_distribution, false);
  assert.equal(evidence.selection_authority, "none");
  assert.equal(evidence.distribution_count, 77);
  assert.equal(evidence.wheel_count, 77);
  assert.equal(evidence.artifact_pack_verified_artifact_count, 90);
  assert.ok(evidence.record_target_count >= 231);
  assert.ok(validatePublicEvidence(evidence));
  assert.doesNotMatch(encodeCanonicalJson(evidence), /[A-Za-z]:\\|\\\\|\/tmp\/|\/home\/|\/Users\/|wheelhouse\/|artifacts\/|inputs\/|site-packages|Scripts\/|https?:\/\/|file:\/\/|\.whl|\.dist-info|==/iu);
});

test("schema parity mirrors constants, closes nested shapes, and binds evidence digests", async () => {
  const { evidence } = await sharedPositive();
  const schema = JSON.parse(await readFile(PUBLIC_EVIDENCE_SCHEMA_PATH, "utf8"));
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.kind.const, PUBLIC_EVIDENCE_KIND);
  assert.equal(schema.properties.schema_version.const, PUBLIC_EVIDENCE_SCHEMA_VERSION);
  assert.equal(schema.properties.measurement_status.const, "controlled-wheelhouse-install-scheme-record-closure-only");
  assert.equal(schema.properties.execution_status.const, "offline-install-pip-check-inspect-record-closure-no-funasr-import");
  assert.equal(schema.properties.packaging_authority.const, "artifact-pack-and-install-scheme-byte-closure-only");
  assert.equal(schema.properties.source_build_authority.const, "source-archive-and-build-record-target-bytes-bound-only");
  assert.equal(schema.properties.license_authority.const, "license-set-target-bytes-verified-not-legal-approval");
  assert.equal(schema.properties.resolver_report_authority.const, "target-record-bytes-bound-only");
  assert.equal(schema.properties.environment_report_authority.const, "expected-projection-target-bytes-bound-only");
  assert.equal(schema.properties.import_map_authority.const, "target-bytes-bound-no-import");
  assert.equal(schema.properties.package_metadata_authority.const, "installed-dist-info-record-and-allowlisted-scheme-files-verified-only");
  assert.equal(schema.properties.install_scheme_authority.const, "bound-runtime-sysconfig-observed-only");
  assert.equal(schema.properties.validator_limits.additionalProperties, false);
  assert.equal(schema.properties.limitations.items, false);
  assert.deepEqual(schema.properties.limitations.prefixItems.map((item) => item.const), evidence.limitations);
  assert.equal(evidence.schema_file_sha256, sha256(readFileSync(PUBLIC_EVIDENCE_SCHEMA_PATH)));
  assert.equal(evidence.attestor_source_sha256, sha256(readFileSync(ATTESTOR_SOURCE_PATH)));
});

test("CLI run-synthetic marker, canonical validate-json, and invalid UTF-8 failure are strict", async () => {
  const run = await execFileAsync(process.execPath, [MODULE_PATH, "--run-synthetic"], {
    encoding: "utf8",
    timeout: 240_000,
    maxBuffer: 2 * 1024 * 1024,
    windowsHide: true,
  });
  assert.equal(run.stderr, "");
  assert.match(run.stdout, /^funasr-sidecar-install-scheme-record-attestation=verified evidence_sha256=[0-9a-f]{64} candidate_aggregate_sha256=[0-9a-f]{64} package_lock_sha256=[0-9a-f]{64} artifact_pack_manifest_sha256=[0-9a-f]{64} distributions=77 wheels=77 root_requirements=3 verified_artifacts=90 record_targets=[1-9][0-9]* measurement_status=controlled-wheelhouse-install-scheme-record-closure-only execution_status=offline-install-pip-check-inspect-record-closure-no-funasr-import packaging_authority=artifact-pack-and-install-scheme-byte-closure-only environment_materialization_authority=offline-venv-materialized package_metadata_authority=installed-dist-info-record-and-allowlisted-scheme-files-verified-only install_scheme_authority=bound-runtime-sysconfig-observed-only source_build_authority=source-archive-and-build-record-target-bytes-bound-only license_authority=license-set-target-bytes-verified-not-legal-approval cpython_provenance_authority=none import_authority=none quality_gate_status=not-assessed formal_claims=none production_evidence=false public_distribution=false selection_authority=none fixture_scope=synthetic-install-scheme-record-contract-only\r?\n$/u);

  const { evidence, fixture } = await sharedPositive();
  const evidencePath = path.join(fixture.root, "install-scheme-record-evidence.json");
  await writeFile(evidencePath, encodeCanonicalJson(evidence), "utf8");
  const validated = await execFileAsync(process.execPath, [MODULE_PATH, "--validate-json", evidencePath], {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
  assert.match(validated.stdout, /^funasr-sidecar-install-scheme-record-attestation-json=verified evidence_sha256=[0-9a-f]{64}\r?\n$/u);

  const prettyPath = path.join(fixture.root, "install-scheme-record-evidence-pretty.json");
  await writeFile(prettyPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  await assert.rejects(
    () => execFileAsync(process.execPath, [MODULE_PATH, "--validate-json", prettyPath], { encoding: "utf8", timeout: 30_000, windowsHide: true }),
    /canonical JSON/u,
  );

  const invalidUtf8Path = path.join(fixture.root, "install-scheme-record-evidence-invalid-utf8.json");
  await writeFile(invalidUtf8Path, Buffer.from([0xff, 0xfe, 0x0a]));
  await assert.rejects(
    () => execFileAsync(process.execPath, [MODULE_PATH, "--validate-json", invalidUtf8Path], { encoding: "utf8", timeout: 30_000, windowsHide: true }),
    /UTF-8/u,
  );
});

test("4g aggregate and before/after artifact-pack binding drift fail closed", async () => {
  const { fixture } = await sharedPositive();
  await assert.rejects(
    () => attestInstallSchemeRecordClosure(fixture.root, fixture.manifestPath, fixture.artifactPackManifestPath, fixture.venvPython, "1".repeat(64)),
    /FOUR_B|FOUR_G|ARTIFACT_PACK|AGGREGATE/u,
  );
  await expectReject(async (mutableFixture) => {
    const manifest = await readArtifactManifest(mutableFixture);
    manifest.candidate_aggregate_sha256 = "1".repeat(64);
    await writeArtifactManifest(mutableFixture, manifest);
  }, /FOUR_G|ARTIFACT_PACK|AGGREGATE|BINDING/u);
  await assert.rejects(
    () => attestInstallSchemeRecordClosure(
      fixture.root,
      fixture.manifestPath,
      fixture.artifactPackManifestPath,
      fixture.venvPython,
      fixture.aggregate,
      { unexpectedOption: true },
    ),
    /INSTALL_SCHEME_OPTIONS/u,
  );
});

test("scheme path resolver accepts library scripts constrained-data positives and purelib platlib dedup", async () => {
  const { evidence } = await secondaryPositive();
  assert.equal(evidence.artifact_pack_verified_artifact_count, 90);
  assert.ok(evidence.record_target_count >= 231);
  assert.match(evidence.record_classification_counts_sha256, /^[0-9a-f]{64}$/u);
  assert.match(evidence.record_target_set_sha256, /^[0-9a-f]{64}$/u);
  assert.notEqual(evidence.record_classification_counts_sha256, ZERO_SHA);
});

test("generated console launchers are not accepted as direct wheel-spread scheme files", async () => {
  const fixture = await createFixture({ includeGeneratedLauncher: true });
  await assert.rejects(
    () => attestInstallSchemeRecordClosure(
      fixture.root,
      fixture.manifestPath,
      fixture.artifactPackManifestPath,
      fixture.venvPython,
      fixture.aggregate,
      { inputScope: "synthetic-install-scheme-record-contract-only" },
    ),
    /INSTALL_SCHEME_(?:DIST_INFO_DRIFT|GENERATED_LAUNCHER)/u,
  );
});

test("scheme path resolver statically covers path escapes namespaces unsafe syntax malformed CSV and aliasing", async () => {
  const source = await readFile(MODULE_PATH, "utf8");
  for (const code of [
    "INSTALL_SCHEME_RECORD_ROOT",
    "INSTALL_SCHEME_RECORD_PATH",
    "INSTALL_SCHEME_RECORD_CSV",
    "INSTALL_SCHEME_RECORD_FILE",
    "INSTALL_SCHEME_RECORD_HASH_DRIFT",
    "INSTALL_SCHEME_RECORD_SIZE_DRIFT",
    "INSTALL_SCHEME_RECORD_HARDLINK",
    "INSTALL_SCHEME_RECORD_DUPLICATE",
    "INSTALL_SCHEME_RECORD_CASE_COLLISION",
    "INSTALL_SCHEME_DIRECT_WHEEL_SPREAD_DRIFT",
    "INSTALL_SCHEME_DIRECT_WHEEL_SPREAD_MISSING",
    "INSTALL_SCHEME_GENERATED_LAUNCHER",
  ]) assert.match(source, new RegExp(code, "u"), code);
  assert.match(source, /constrainedData/u);
  assert.match(source, /purelib and platlib must dedupe physically/u);
  assert.match(source, /assertNoSymlinkComponents/u);
});

test("runtime sysconfig target and drift checks are statically wired", async () => {
  const source = await readFile(MODULE_PATH, "utf8");
  assert.match(source, /queryBoundRuntimeSysconfig/u);
  assert.match(source, /INSTALL_SCHEME_SYSCONFIG_TARGET/u);
  assert.match(source, /runtime_sysconfig_sha256/u);
  assert.match(source, /caller venv python must be the 4b-bound runtime role/u);
  assert.match(source, /venv must disable system site packages/u);
  assert.match(source, /INSTALL_SCHEME_RUNTIME_ROLE_DRIFT/u);
  assert.match(source, /dist_info_basename/u);
  assert.match(source, /relative_to\(site\)/u);
});

test("public evidence validator rejects overclaims and leaks", async () => {
  const { evidence } = await sharedPositive();
  for (const patch of [
    { production_evidence: true },
    { public_distribution: true },
    { selection_authority: "default" },
    { import_authority: "verified" },
    { cpython_provenance_authority: "verified" },
    { quality_gate_status: "passed" },
    { packaging_authority: "wheel-spread-product-approved" },
    { install_scheme_authority: "runtime-origin-verified" },
    { source_build_authority: "build-replayed" },
    { license_authority: "approved" },
    { resolver_report_authority: "expanded" },
    { environment_report_authority: "expanded" },
    { import_map_authority: "imported" },
  ]) assert.throws(() => validatePublicEvidence({ ...evidence, ...patch }), /OVERCLAIM|SCHEMA/u);
  assert.throws(() => validatePublicEvidence({ ...evidence, package_names: ["funasr"] }), /SCHEMA|FORBIDDEN/u);
  assert.throws(() => validatePublicEvidence({ ...evidence, record_path: "Lib/site-packages/funasr-1.3.22.dist-info/RECORD" }), /SCHEMA|FORBIDDEN/u);
  assert.throws(() => validatePublicEvidence({ ...evidence, limitations: ["C:\\secret\\wheelhouse", ...evidence.limitations.slice(1)] }), /FORBIDDEN|SCHEMA/u);
  assert.throws(() => validatePublicEvidence({ ...evidence, schema_file_sha256: "1".repeat(64) }), /SCHEMA/u);
  assert.throws(() => validatePublicEvidence({ ...evidence, four_g_after_evidence_sha256: "1".repeat(64) }), /SCHEMA/u);
  assert.throws(() => validatePublicEvidence({ ...evidence, target: { ...evidence.target, runtime_origin: "verified" } }), /SCHEMA/u);
  assert.throws(() => validatePublicEvidence({ ...evidence, validator_limits: { ...evidence.validator_limits, generated_launcher_authority: "verified" } }), /SCHEMA|OVERCLAIM/u);
});

test("attestor source is static-safe and direct wheel-spread-only", async () => {
  const source = await readFile(MODULE_PATH, "utf8");
  assert.doesNotMatch(source, /\b(?:AutoModel|soundfile|librosa|requests|urllib\.request|http\.client|import\s+funasr|from\s+funasr|fetch|WebSocket)\b/iu);
  assert.doesNotMatch(source, /FORBIDDEN_PUBLIC_VALUE_RE\s*=\s*\/[^;\n]*(?:\|LICENSE\|METADATA\|RECORD|\|METADATA\|RECORD|\|RECORD|RECORD\|METADATA)/u);
  assert.match(source, /direct wheel-spread|DIRECT_WHEEL_SPREAD|directWheelSpread/u);
  assert.doesNotMatch(source, /\b(?:child_process|spawn\(|execFile\().*(?:launcher|console-script)/iu);
});

test("4f and 4g regression scripts plus 4h package wiring remain wired", async () => {
  const scripts = JSON.parse(await readFile("package.json", "utf8")).scripts;
  for (const [script, file] of [
    ["phase0:funasr-sidecar-venv-materialization:test", "tools/funasr-sidecar/sidecar-venv-materialization-attestation.test.mjs"],
    ["phase0:funasr-sidecar-venv-materialization:validate", "tools/funasr-sidecar/sidecar-venv-materialization-attestation.mjs --run-synthetic"],
    ["phase0:funasr-sidecar-artifact-pack:test", "tools/funasr-sidecar/sidecar-artifact-pack-attestation.test.mjs"],
    ["phase0:funasr-sidecar-artifact-pack:validate", "tools/funasr-sidecar/sidecar-artifact-pack-attestation.mjs --run-synthetic"],
    ["phase0:funasr-sidecar-install-scheme-record:test", "tools/funasr-sidecar/sidecar-install-scheme-record-attestation.test.mjs"],
    ["phase0:funasr-sidecar-install-scheme-record:validate", "tools/funasr-sidecar/sidecar-install-scheme-record-attestation.mjs --run-synthetic"],
  ]) {
    assert.equal(scripts[script].includes(file), true, script);
  }
  assert.equal(existsSync("tools/funasr-sidecar/sidecar-install-scheme-record-attestation.schema.json"), true);
});

test("schema and evidence remain path-free after clone mutation attempts", async () => {
  const { evidence } = await sharedPositive();
  const clone = canonicalClone(evidence);
  clone.validator_limits.public_evidence = "path-url-name-text-free";
  assert.deepEqual(clone, evidence);
  assert.throws(() => validatePublicEvidence({ ...evidence, install_scheme_records: [{ path: "Scripts/tool.exe" }] }), /SCHEMA|FORBIDDEN/u);
});
