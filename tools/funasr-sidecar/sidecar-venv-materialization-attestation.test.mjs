import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test, { after } from "node:test";
import { promisify } from "node:util";

import { encodeCanonicalJson } from "../phase0-harness/canonical-json.mjs";
import { REQUIRED_ROLES, preflightCandidate } from "./sidecar-candidate-preflight.mjs";
import { normalizePackageName } from "./sidecar-package-lock-attestation.mjs";
import {
  ATTESTOR_SOURCE_PATH,
  PUBLIC_EVIDENCE_KIND,
  PUBLIC_EVIDENCE_SCHEMA_PATH,
  PUBLIC_EVIDENCE_SCHEMA_VERSION,
  attestVenvMaterialization,
  createSyntheticVenvMaterializationFixture,
  validatePublicEvidence,
} from "./sidecar-venv-materialization-attestation.mjs";

const execFileAsync = promisify(execFile);
const MODULE_PATH = "tools/funasr-sidecar/sidecar-venv-materialization-attestation.mjs";
const ZERO_SHA = "0".repeat(64);
const ROOT_REQUIREMENTS = ["funasr==1.3.22", "torch==2.6.0+cpu", "torchaudio==2.6.0+cpu"];
const BUILT_WHEEL_NAMES = ["aliyun-python-sdk-core", "antlr4-python3-runtime", "crcmod", "jieba", "oss2"];
const ownedRoots = new Set();
let sharedPromise;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function lockDistribution(lock, name) {
  const normalized = normalizePackageName(name);
  const distribution = lock.distributions.find((item) => normalizePackageName(item.name) === normalized);
  assert.ok(distribution, `missing distribution ${name}`);
  return distribution;
}

after(async () => {
  await Promise.all([...ownedRoots].map((root) => rm(root, { recursive: true, force: true })));
  ownedRoots.clear();
});

async function sharedPositive() {
  if (sharedPromise === undefined) {
    sharedPromise = (async () => {
      const fixture = await createSyntheticVenvMaterializationFixture();
      ownedRoots.add(fixture.root);
      const evidence = await attestVenvMaterialization(fixture.root, fixture.manifestPath, fixture.venvPython, fixture.aggregate, { syntheticFixtureToken: fixture.syntheticFixtureToken });
      return { evidence, fixture };
    })();
  }
  return await sharedPromise;
}

async function createFreshVenv(root, name) {
  const python = process.env.PYTHON ?? "python";
  const venvRoot = path.join(root, name);
  await execFileAsync(python, ["-I", "-m", "venv", venvRoot], {
    encoding: "utf8",
    timeout: 120_000,
    windowsHide: true,
  });
  return path.join(venvRoot, "Scripts", "python.exe");
}

async function writeManifestForRuntime(root, lock, runtimePython, label) {
  await mkdir(path.join(root, "inputs"), { recursive: true });
  const lockRelative = `inputs/package-lock-${label}.json`;
  const lockBytes = Buffer.from(encodeCanonicalJson(lock), "utf8");
  await writeFile(path.join(root, ...lockRelative.split("/")), lockBytes);
  const files = [];
  for (const role of REQUIRED_ROLES) {
    if (role === "package-lock") {
      files.push({ role, logical_id: `${label}-package-lock`, relative_path: lockRelative, sha256: sha256(lockBytes), size_bytes: lockBytes.length });
    } else if (role === "runtime") {
      const runtimeBytes = readFileSync(runtimePython);
      files.push({ role, logical_id: `${label}-runtime`, relative_path: path.relative(root, runtimePython).replaceAll(path.sep, "/"), sha256: sha256(runtimeBytes), size_bytes: runtimeBytes.length });
    } else {
      const relative = `inputs/${role}.bin`;
      const bytes = readFileSync(path.join(root, ...relative.split("/")));
      files.push({ role, logical_id: `venv-materialization-${role}`, relative_path: relative, sha256: sha256(bytes), size_bytes: bytes.length });
    }
  }
  files.sort((left, right) => left.role.localeCompare(right.role));
  const manifest = {
    kind: "meetingrelay-funasr-sidecar-candidate-preflight-input-v1",
    schema_version: "1.0",
    worker_role: "sidecar-candidate",
    measurement_status: "identity-preflight-only",
    execution_status: "not-executed",
    quality_gate_status: "not-assessed",
    formal_claims: "none",
    production_evidence: false,
    public_distribution: false,
    selection_authority: "none",
    files,
  };
  const manifestPath = path.join(root, `input-manifest-${label}.json`);
  await writeFile(manifestPath, encodeCanonicalJson(manifest), "utf8");
  const preflight = await preflightCandidate(root, manifestPath);
  return { aggregate: preflight.candidate_descriptor.aggregate_sha256, lock, manifestPath, root, venvPython: runtimePython };
}

async function freshSharedFixture({ mutateLock } = {}) {
  const { fixture } = await sharedPositive();
  const label = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const lock = clone(fixture.lock);
  mutateLock?.(lock);
  const venvPython = await createFreshVenv(fixture.root, `fresh-venv-${label}`);
  return await writeManifestForRuntime(fixture.root, lock, venvPython, label);
}

async function listFiles(root) {
  const out = [];
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      if (entry.isFile()) out.push(path.relative(root, absolute).replaceAll(path.sep, "/"));
    }
  }
  await walk(root);
  return out.sort();
}

test("real synthetic positive installs 77 locked wheels offline and emits path-free evidence", async () => {
  const { evidence, fixture } = await sharedPositive();
  assert.equal(evidence.kind, PUBLIC_EVIDENCE_KIND);
  assert.equal(evidence.schema_version, PUBLIC_EVIDENCE_SCHEMA_VERSION);
  assert.equal(evidence.measurement_status, "controlled-wheelhouse-and-venv-materialized-only");
  assert.equal(evidence.execution_status, "offline-install-pip-check-inspect-no-funasr-import");
  assert.equal(evidence.packaging_authority, "controlled-wheelhouse-and-offline-venv-only");
  assert.equal(evidence.environment_materialization_authority, "offline-venv-materialized");
  assert.equal(evidence.package_metadata_authority, "installed-dist-info-record-verified-only");
  assert.equal(evidence.source_build_authority, "none");
  assert.equal(evidence.license_authority, "none");
  assert.equal(evidence.cpython_provenance_authority, "none");
  assert.equal(evidence.import_authority, "none");
  assert.equal(evidence.quality_gate_status, "not-assessed");
  assert.equal(evidence.formal_claims, "none");
  assert.equal(evidence.production_evidence, false);
  assert.equal(evidence.public_distribution, false);
  assert.equal(evidence.selection_authority, "none");
  assert.equal(evidence.input_scope, "synthetic-valid-wheels-no-real-funasr-code");
  assert.equal(evidence.root_requirement_count, 3);
  assert.equal(evidence.distribution_count, 77);
  assert.equal(evidence.wheel_count, 77);
  assert.equal(evidence.built_wheel_count, 5);
  assert.equal(evidence.four_e_before_evidence_sha256, evidence.four_e_after_evidence_sha256);
  assert.ok(validatePublicEvidence(evidence));
  assert.doesNotMatch(encodeCanonicalJson(evidence), new RegExp(`${fixture.root.replaceAll("\\", "\\\\")}|wheelhouse/|inputs/|https?://|\\.whl|==`, "iu"));
});

test("evidence is deterministic for a second clean venv over the same wheelhouse and lock", async () => {
  const { evidence } = await sharedPositive();
  const fresh = await freshSharedFixture();
  const second = await attestVenvMaterialization(fresh.root, fresh.manifestPath, fresh.venvPython, fresh.aggregate);
  assert.equal(second.input_scope, "caller-supplied-controlled-inputs-not-product-approved");
  for (const key of [
    "schema_file_sha256",
    "attestor_source_sha256",
    "package_lock_sha256",
    "four_e_package_lock_role_sha256",
    "built_wheel_declaration_set_sha256",
    "installed_dist_info_contract_sha256",
    "materialized_environment_report_sha256",
    "runtime_target_probe_sha256",
  ]) assert.equal(second[key], evidence[key], key);
  assert.equal(second.validator_limits.pip_install_flags_sha256, evidence.validator_limits.pip_install_flags_sha256);
  assert.notEqual(second.candidate_aggregate_sha256, evidence.candidate_aggregate_sha256);
});

test("lock fixes root pins, +cpu tensor versions, 77 distributions, and the five built declarations", async () => {
  const { fixture } = await sharedPositive();
  assert.deepEqual(fixture.lock.root_requirements, ROOT_REQUIREMENTS);
  assert.equal(fixture.lock.distributions.length, 77);
  assert.equal(lockDistribution(fixture.lock, "torch").version, "2.6.0+cpu");
  assert.equal(lockDistribution(fixture.lock, "torchaudio").version, "2.6.0+cpu");
  assert.equal(lockDistribution(fixture.lock, "torch").wheel.filename.includes("+cpu"), true);
  assert.equal(lockDistribution(fixture.lock, "torchaudio").wheel.filename.includes("+cpu"), true);
  assert.deepEqual(fixture.lock.distributions.filter((item) => item.built_wheel !== undefined).map((item) => normalizePackageName(item.name)).sort(), BUILT_WHEEL_NAMES);
});

test("expected environment report hash mismatch fails at inherited package-lock boundary", async () => {
  const fresh = await freshSharedFixture({ mutateLock: (lock) => { lock.expected_environment_report.expected_sha256 = ZERO_SHA; } });
  await assert.rejects(() => attestVenvMaterialization(fresh.root, fresh.manifestPath, fresh.venvPython, fresh.aggregate), /EXPECTED|REPORT|DIGEST/u);
});

test("resolver version and resolver tool drift fail closed", async () => {
  let fresh = await freshSharedFixture({ mutateLock: (lock) => { lock.resolver_declaration.version = "pip 25.1.1"; } });
  await assert.rejects(() => attestVenvMaterialization(fresh.root, fresh.manifestPath, fresh.venvPython, fresh.aggregate), /RESOLVER/u);
  fresh = await freshSharedFixture({ mutateLock: (lock) => { lock.resolver_declaration.tool = "uv"; } });
  await assert.rejects(() => attestVenvMaterialization(fresh.root, fresh.manifestPath, fresh.venvPython, fresh.aggregate), /RESOLVER/u);
});

test("root, distribution count, +cpu, built-set, and metadata declaration mutations fail closed", async () => {
  const cases = [
    [(lock) => { lock.root_requirements[1] = "torch==2.6.0"; }, /ROOT|MISMATCH|MISSING/u],
    [(lock) => { lock.distributions.pop(); }, /DISTRIBUTION|COUNT|MISSING/u],
    [(lock) => { lockDistribution(lock, "torch").version = "2.6.0"; }, /ROOT|WHEEL|IDENTITY|MISSING/u],
    [(lock) => { delete lockDistribution(lock, "jieba").built_wheel; }, /BUILT|BUILD/u],
    [(lock) => { lockDistribution(lock, "funasr").declared_dist_info_metadata_sha256 = ZERO_SHA; }, /METADATA|DIGEST/u],
  ];
  for (const [mutateLock, pattern] of cases) {
    const fresh = await freshSharedFixture({ mutateLock });
    await assert.rejects(() => attestVenvMaterialization(fresh.root, fresh.manifestPath, fresh.venvPython, fresh.aggregate), pattern);
  }
});

test("bootstrap and install injected failures fail before evidence", async () => {
  let fresh = await freshSharedFixture();
  await assert.rejects(() => attestVenvMaterialization(fresh.root, fresh.manifestPath, fresh.venvPython, fresh.aggregate, { injectProcessFailure: "bootstrap" }), /BOOTSTRAP/u);
  fresh = await freshSharedFixture();
  await assert.rejects(() => attestVenvMaterialization(fresh.root, fresh.manifestPath, fresh.venvPython, fresh.aggregate, { injectProcessFailure: "install" }), /INSTALL/u);
});

test("runtime target mismatch and public option bypasses fail closed", async () => {
  const fresh = await freshSharedFixture();
  await assert.rejects(
    () => attestVenvMaterialization(fresh.root, fresh.manifestPath, fresh.venvPython, fresh.aggregate, { injectRuntimeTargetMismatch: true }),
    /VENV_RUNTIME_TARGET/u,
  );
  const { fixture } = await sharedPositive();
  await assert.rejects(
    () => attestVenvMaterialization(fixture.root, fixture.manifestPath, fixture.venvPython, fixture.aggregate, { synthetic: true }),
    /VENV_ATTEST_OPTIONS/u,
  );
  await assert.rejects(
    () => attestVenvMaterialization(fixture.root, fixture.manifestPath, fixture.venvPython, fixture.aggregate, { syntheticFixtureToken: Object.freeze({}) }),
    /VENV_SYNTHETIC_BINDING/u,
  );
  await assert.rejects(
    () => attestVenvMaterialization(fixture.root, fixture.manifestPath, fixture.venvPython, fixture.aggregate, { skipDeclarationCheck: true }),
    /VENV_ATTEST_OPTIONS/u,
  );
  await assert.rejects(
    () => attestVenvMaterialization(fixture.root, fixture.manifestPath, fixture.venvPython, fixture.aggregate, { maxOutputBytes: 8 * 1024 * 1024 }),
    /VENV_ATTEST_OPTIONS/u,
  );
});

test("check and inspect injected failure, timeout, and oversize paths fail closed", async () => {
  const cases = [
    [{ injectProcessFailure: "check" }, /CHECK/u],
    [{ injectProcessFailure: "inspect" }, /INSPECT/u],
    [{ injectProcessTimeout: "inspect" }, /INSPECT_TIMEOUT/u],
    [{ injectProcessOversize: "check" }, /CHECK_OUTPUT/u],
  ];
  for (const [options, pattern] of cases) {
    const fresh = await freshSharedFixture();
    await assert.rejects(() => attestVenvMaterialization(fresh.root, fresh.manifestPath, fresh.venvPython, fresh.aggregate, options), pattern);
  }
});

test("installed set report has 77 dist-info records and no direct_url evidence", async () => {
  const { evidence, fixture } = await sharedPositive();
  assert.match(evidence.materialized_environment_report_sha256, /^[0-9a-f]{64}$/u);
  assert.match(evidence.installed_dist_info_contract_sha256, /^[0-9a-f]{64}$/u);
  const files = await listFiles(path.join(fixture.root, "attested-venv", "Lib", "site-packages"));
  assert.equal(files.filter((file) => file.endsWith(".dist-info/METADATA")).length >= 77, true);
  assert.equal(files.filter((file) => file.endsWith(".dist-info/RECORD")).length >= 77, true);
  assert.deepEqual(files.filter((file) => file.endsWith("direct_url.json")), []);
});

test("installed METADATA and declared RECORD drift fail against installed dist-info contracts", async () => {
  let fresh = await freshSharedFixture();
  await assert.rejects(() => attestVenvMaterialization(fresh.root, fresh.manifestPath, fresh.venvPython, fresh.aggregate, { afterInstallTamper: "funasr" }), /METADATA_DRIFT/u);
  fresh = await freshSharedFixture({ mutateLock: (lock) => { lockDistribution(lock, "funasr").declared_dist_info_record_sha256 = "f".repeat(64); } });
  await assert.rejects(() => attestVenvMaterialization(fresh.root, fresh.manifestPath, fresh.venvPython, fresh.aggregate), /RECORD|DRIFT|DIGEST/u);
});

test("installed RECORD hardlink aliases fail closed", async () => {
  const fresh = await freshSharedFixture();
  await assert.rejects(
    () => attestVenvMaterialization(fresh.root, fresh.manifestPath, fresh.venvPython, fresh.aggregate, { afterInstallHardlink: "funasr" }),
    /VENV_RECORD_HARDLINK/u,
  );
});

test("runtime identity and path mismatch are rejected against the 4b runtime role", async () => {
  const { fixture } = await sharedPositive();
  const mismatchPython = await createFreshVenv(fixture.root, `runtime-mismatch-${Date.now()}`);
  await assert.rejects(() => attestVenvMaterialization(fixture.root, fixture.manifestPath, mismatchPython, fixture.aggregate), /RUNTIME_ROLE/u);
  await assert.rejects(() => attestVenvMaterialization(fixture.root, fixture.manifestPath, path.join(fixture.root, "missing", "Scripts", "python.exe"), fixture.aggregate), /RUNTIME_ROLE|PYTHON_PATH/u);
});

test("public evidence validator rejects authority overclaims and path/name/text leaks", async () => {
  const { evidence } = await sharedPositive();
  for (const patch of [
    { production_evidence: true },
    { public_distribution: true },
    { selection_authority: "default" },
    { import_authority: "verified" },
    { license_authority: "verified" },
    { cpython_provenance_authority: "verified" },
    { source_build_authority: "verified" },
    { quality_gate_status: "passed" },
  ]) assert.throws(() => validatePublicEvidence({ ...evidence, ...patch }), /OVERCLAIM|SCHEMA/u);
  assert.throws(() => validatePublicEvidence({ ...evidence, package_names: ["funasr"] }), /SCHEMA|FORBIDDEN/u);
  assert.throws(() => validatePublicEvidence({ ...evidence, limitations: ["C:\\secret\\wheelhouse", ...evidence.limitations.slice(1)] }), /FORBIDDEN|SCHEMA/u);
  assert.throws(() => validatePublicEvidence({ ...evidence, target: { ...evidence.target, runtime_origin: "verified" } }), /VENV_EVIDENCE_SCHEMA/u);
  assert.throws(() => validatePublicEvidence({ ...evidence, validator_limits: { ...evidence.validator_limits, os_network_isolation: "verified" } }), /VENV_EVIDENCE_SCHEMA/u);
});

test("schema parity mirrors constants and closes nested evidence shapes", async () => {
  const { evidence } = await sharedPositive();
  const schema = JSON.parse(await readFile(PUBLIC_EVIDENCE_SCHEMA_PATH, "utf8"));
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.kind.const, PUBLIC_EVIDENCE_KIND);
  assert.equal(schema.properties.schema_version.const, PUBLIC_EVIDENCE_SCHEMA_VERSION);
  assert.equal(schema.properties.measurement_status.const, "controlled-wheelhouse-and-venv-materialized-only");
  assert.equal(schema.properties.execution_status.const, "offline-install-pip-check-inspect-no-funasr-import");
  assert.equal(schema.properties.source_build_authority.const, "none");
  assert.equal(schema.properties.import_authority.const, "none");
  assert.equal(schema.properties.runtime_target_probe_sha256.pattern, "^[0-9a-f]{64}$");
  assert.equal(schema.properties.target.additionalProperties, false);
  assert.equal(schema.properties.validator_limits.additionalProperties, false);
  assert.equal(schema.properties.limitations.items, false);
  assert.deepEqual(schema.properties.limitations.prefixItems.map((item) => item.const), evidence.limitations);
  assert.equal(evidence.schema_file_sha256, sha256(readFileSync(PUBLIC_EVIDENCE_SCHEMA_PATH)));
  assert.equal(evidence.attestor_source_sha256, sha256(readFileSync(ATTESTOR_SOURCE_PATH)));
});

test("CLI emits strict synthetic marker, validate-json marker, and usage failure", async () => {
  const run = await execFileAsync(process.execPath, [MODULE_PATH, "--run-synthetic"], { encoding: "utf8", timeout: 240_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true });
  assert.equal(run.stderr, "");
  assert.match(run.stdout, /^funasr-sidecar-venv-materialization-attestation=verified evidence_sha256=[0-9a-f]{64} candidate_aggregate_sha256=[0-9a-f]{64} package_lock_sha256=[0-9a-f]{64} distributions=77 wheels=77 root_requirements=3 built_wheels=5 measurement_status=controlled-wheelhouse-and-venv-materialized-only execution_status=offline-install-pip-check-inspect-no-funasr-import packaging_authority=controlled-wheelhouse-and-offline-venv-only environment_materialization_authority=offline-venv-materialized package_metadata_authority=installed-dist-info-record-verified-only source_build_authority=none license_authority=none cpython_provenance_authority=none import_authority=none quality_gate_status=not-assessed formal_claims=none production_evidence=false public_distribution=false selection_authority=none fixture_scope=synthetic-valid-wheels-no-real-funasr-code\r?\n$/u);
  const { evidence } = await sharedPositive();
  const validated = await execFileAsync(process.execPath, [MODULE_PATH, "--validate-json", encodeCanonicalJson(evidence)], { encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024, windowsHide: true });
  assert.match(validated.stdout, /^funasr-sidecar-venv-materialization-attestation-json=verified evidence_sha256=[0-9a-f]{64}\r?\n$/u);
  await assert.rejects(() => execFileAsync(process.execPath, [MODULE_PATH, "--attest"], { encoding: "utf8", timeout: 30_000, windowsHide: true }), /VENV_ATTEST_USAGE/u);
});

test("attestor source has no prohibited model, audio, network, download, or FunASR import surface", async () => {
  const source = await readFile(MODULE_PATH, "utf8");
  const imports = [...source.matchAll(/from\s+"(node:[^"]+)"/gu)].map((match) => match[1]).sort();
  assert.deepEqual(imports.filter((specifier) => /node:(?:dgram|dns|http|https|net|tls|worker_threads|cluster)/u.test(specifier)), []);
  assert.doesNotMatch(source, /\b(?:fetch|WebSocket)\s*\(/u);
  assert.doesNotMatch(source, /\b(?:AutoModel|soundfile|librosa|requests|urllib\.request|http\.client|import\s+funasr|from\s+funasr)\b/iu);
  assert.match(source, /shell:\s*false/u);
  assert.match(source, /"--no-index"/u);
  assert.match(source, /"--no-deps"/u);
  assert.match(source, /"--require-hashes"/u);
});

test("4a through 4e regression scripts remain wired at the 4f boundary", async () => {
  const scripts = JSON.parse(await readFile("package.json", "utf8")).scripts;
  for (const [script, file] of [
    ["phase0:funasr-sidecar-wire:test", "tools/funasr-sidecar/sidecar-wire-foundation.test.mjs"],
    ["phase0:funasr-sidecar-preflight:test", "tools/funasr-sidecar/sidecar-candidate-preflight.test.mjs"],
    ["phase0:funasr-sidecar-python-launch:test", "tools/funasr-sidecar/sidecar-python-launch.test.mjs"],
    ["phase0:funasr-sidecar-source:test", "tools/funasr-sidecar/sidecar-source-attestation.test.mjs"],
    ["phase0:funasr-sidecar-package-lock:test", "tools/funasr-sidecar/sidecar-package-lock-attestation.test.mjs"],
  ]) {
    assert.equal(existsSync(file), true, file);
    assert.match(scripts[script], new RegExp(file.replaceAll("/", "\\/"), "u"), script);
  }
});

test("evidence hashes bind package lock, schema/source, 4e before/after, and nonzero report digests", async () => {
  const { evidence, fixture } = await sharedPositive();
  const lockBytes = await readFile(path.join(fixture.root, "inputs", "package-lock.json"));
  assert.equal(evidence.package_lock_sha256, sha256(lockBytes));
  assert.equal(evidence.four_e_package_lock_role_sha256, evidence.package_lock_sha256);
  assert.equal(evidence.four_e_before_evidence_sha256, evidence.four_e_after_evidence_sha256);
  for (const value of [
    evidence.candidate_aggregate_sha256,
    evidence.built_wheel_declaration_set_sha256,
    evidence.installed_dist_info_contract_sha256,
    evidence.materialized_environment_report_sha256,
    evidence.runtime_target_probe_sha256,
    evidence.validator_limits.pip_install_flags_sha256,
  ]) {
    assert.match(value, /^[0-9a-f]{64}$/u);
    assert.notEqual(value, ZERO_SHA);
  }
});

test("cleanup remains fail-visible and symlink components are rejected in source", async () => {
  const source = await readFile(MODULE_PATH, "utf8");
  assert.match(source, /await rm\(fixture\.root, \{ recursive: true, force: true \}\)/u);
  assert.match(source, /must not traverse a symlink or junction/u);
});
