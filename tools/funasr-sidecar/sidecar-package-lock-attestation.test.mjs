import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { encodeCanonicalJson } from "../phase0-harness/canonical-json.mjs";
import { REQUIRED_ROLES, preflightCandidate, sha256Hex } from "./sidecar-candidate-preflight.mjs";

const execFileAsync = promisify(execFile);
const MODULE_PATH = "./sidecar-package-lock-attestation.mjs";
const TEST_MODULE_SOURCE_PATH = "tools/funasr-sidecar/sidecar-package-lock-attestation.mjs";
const SCHEMA_KIND = "meetingrelay-funasr-sidecar-package-lock-v1";
const EVIDENCE_KIND = "meetingrelay-funasr-sidecar-package-lock-attestation-v1";
const ZERO_SHA = "0".repeat(64);
const VALID_SHA = "a".repeat(64);
const CPYTHON_REPORT_SHA = "b".repeat(64);
const EXPECTED_ENVIRONMENT_REPORT_SHA = "c".repeat(64);
const FUNASR_VERSION = "1.3.22";
const TORCH_VERSION = "2.6.0";

async function loadModule() {
  return await import(MODULE_PATH);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function writeBytes(root, relativePath, bytes) {
  const absolute = path.join(root, ...relativePath.split("/"));
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, bytes);
  return {
    absolute,
    relative_path: relativePath,
    sha256: sha256(bytes),
    size_bytes: bytes.length,
  };
}

function wheelBytes(name) {
  return Buffer.from(`synthetic wheel bytes for ${name}\n`, "utf8");
}

function distribution({
  name,
  version,
  filename,
  relativePath,
  sha,
  size,
  dependencies = [],
  topLevelImports = [],
  sourceUrl,
  builtWheel,
}) {
  const wheelTag = filename.endsWith(".whl")
    ? filename.slice(0, -4).split("-").slice(-3).join("-")
    : "cp312-cp312-win_amd64";
  return {
    name,
    version,
    wheel: {
      filename,
      relative_path: relativePath,
      sha256: sha,
      size_bytes: size,
      declared_source_url: sourceUrl ?? `https://files.pythonhosted.org/packages/synthetic/${filename}`,
      tags: [wheelTag],
    },
    dependencies,
    declared_top_level_imports: topLevelImports,
    declared_dist_info_metadata_sha256: sha256(`${name}-${version}-metadata\n`),
    declared_dist_info_record_sha256: sha256(`${name}-${version}-record\n`),
    declared_license_files_aggregate_sha256: sha256(`${name}-${version}-license\n`),
    ...(builtWheel === undefined ? {} : { built_wheel: builtWheel }),
  };
}

function basePackageLock(wheels) {
  return {
    kind: SCHEMA_KIND,
    schema_version: "1.0",
    worker_role: "sidecar-candidate",
    target: {
      os: "windows",
      arch: "amd64",
      cpython_version_family: "3.12.x",
      python_abi: "cp312",
      platform_tag: "win_amd64",
      accelerator_profile: "cpu-baseline",
    },
    resolver_declaration: {
      tool: "pip",
      version: "25.1.1",
      declared_report_sha256: CPYTHON_REPORT_SHA,
    },
    materialization_policy: {
      wheelhouse_scope: "local-controlled-root-only",
      network: "disabled",
      index_access: "disabled",
      package_forms: ["wheel"],
      require_hashes: true,
      install_no_deps: true,
      allow_sdist: false,
      allow_editable: false,
      allow_vcs: false,
      allow_user_site: false,
      allow_global_site: false,
      allow_direct_url: false,
    },
    root_requirements: [`funasr==${FUNASR_VERSION}`, `torch==${TORCH_VERSION}`, `torchaudio==${TORCH_VERSION}`],
    distributions: [
      distribution({
        name: "funasr",
        version: FUNASR_VERSION,
        filename: "funasr-1.3.22-py3-none-any.whl",
        relativePath: wheels.funasr.relative_path,
        sha: wheels.funasr.sha256,
        size: wheels.funasr.size_bytes,
        dependencies: [`torch==${TORCH_VERSION}`, `torchaudio==${TORCH_VERSION}`],
        topLevelImports: ["funasr"],
      }),
      distribution({
        name: "torch",
        version: TORCH_VERSION,
        filename: "torch-2.6.0-cp312-cp312-win_amd64.whl",
        relativePath: wheels.torch.relative_path,
        sha: wheels.torch.sha256,
        size: wheels.torch.size_bytes,
      }),
      distribution({
        name: "torchaudio",
        version: TORCH_VERSION,
        filename: "torchaudio-2.6.0-cp312-cp312-win_amd64.whl",
        relativePath: wheels.torchaudio.relative_path,
        sha: wheels.torchaudio.sha256,
        size: wheels.torchaudio.size_bytes,
        dependencies: [`torch==${TORCH_VERSION}`],
      }),
    ],
    expected_environment_report: {
      report_kind: "pip-inspect-v1",
      expected_sha256: EXPECTED_ENVIRONMENT_REPORT_SHA,
      expected_distribution_count: 3,
      expected_top_level_import_map_sha256: sha256("funasr=>funasr\n"),
      verification_status: "not-materialized-not-verified",
    },
  };
}

async function writeManifest(root, packageLockPath, packageLockBytes) {
  const files = [];
  for (const role of REQUIRED_ROLES) {
    if (role === "package-lock") {
      files.push({
        role,
        logical_id: "package-lock",
        relative_path: packageLockPath,
        sha256: sha256(packageLockBytes),
        size_bytes: packageLockBytes.length,
      });
      continue;
    }
    const written = await writeBytes(root, `inputs/${role}.bin`, Buffer.from(`synthetic ${role} bytes\n`, "utf8"));
    files.push({
      role,
      logical_id: `package-lock-${role}`,
      relative_path: written.relative_path,
      sha256: written.sha256,
      size_bytes: written.size_bytes,
    });
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
  const manifestPath = path.join(root, "input-manifest.json");
  await writeFile(manifestPath, encodeCanonicalJson(manifest), "utf8");
  return { manifest, manifestPath };
}

async function withPackageLockFixture(fn, options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "meetingrelay-package-lock-attest-"));
  try {
    const wheels = {
      funasr: await writeBytes(root, "wheelhouse/funasr-1.3.22-py3-none-any.whl", wheelBytes("funasr")),
      torch: await writeBytes(root, "wheelhouse/torch-2.6.0-cp312-cp312-win_amd64.whl", wheelBytes("torch")),
      torchaudio: await writeBytes(root, "wheelhouse/torchaudio-2.6.0-cp312-cp312-win_amd64.whl", wheelBytes("torchaudio")),
    };
    const lock = options.lock ?? basePackageLock(wheels);
    options.mutateLock?.(lock, wheels, root);
    const packageLockBytes = options.packageLockBytes ?? Buffer.from(encodeCanonicalJson(lock), "utf8");
    const packageLockRelativePath = options.packageLockRelativePath ?? "inputs/package-lock.json";
    const packageLockAbsolute = path.join(root, ...packageLockRelativePath.split("/"));
    await mkdir(path.dirname(packageLockAbsolute), { recursive: true });
    await writeFile(packageLockAbsolute, packageLockBytes);
    const fixture = await writeManifest(root, packageLockRelativePath, packageLockBytes);
    const preflight = await preflightCandidate(root, fixture.manifestPath);
    return await fn(root, {
      ...fixture,
      aggregate: preflight.candidate_descriptor.aggregate_sha256,
      lock,
      packageLockAbsolute,
      packageLockBytes,
      wheels,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function assertAttestRejects(mutateLock, pattern, packageLockBytes) {
  await withPackageLockFixture(async (root, fixture) => {
    const { attestPackageLock } = await loadModule();
    await assert.rejects(
      () => attestPackageLock(root, fixture.manifestPath, fixture.aggregate),
      pattern,
    );
  }, { mutateLock, packageLockBytes });
}

test("package lock attestation emits deterministic path-free digest-only evidence", async () => {
  await withPackageLockFixture(async (root, fixture) => {
    const { PUBLIC_EVIDENCE_KIND, attestPackageLock, validatePublicEvidence } = await loadModule();
    const left = await attestPackageLock(root, fixture.manifestPath, fixture.aggregate);
    const right = await attestPackageLock(root, fixture.manifestPath, fixture.aggregate);
    assert.deepEqual(left, right);
    assert.equal(PUBLIC_EVIDENCE_KIND, EVIDENCE_KIND);
    assert.equal(left.kind, EVIDENCE_KIND);
    assert.equal(left.schema_version, "1.0");
    assert.equal(left.worker_role, "sidecar-candidate");
    assert.equal(left.lock_kind, SCHEMA_KIND);
    assert.equal(left.lock_schema_version, "1.0");
    assert.equal(left.measurement_status, "package-lock-attestation-only");
    assert.equal(left.execution_status, "lock-contract-and-wheel-byte-identity-only-no-install-no-import");
    assert.equal(left.package_lock_binding_scope, "four-b-package-lock-role-byte-match-only");
    assert.equal(left.wheel_binding_scope, "controlled-root-referenced-wheel-byte-match-only");
    assert.equal(left.declaration_binding_scope, "lock-fields-bound-only-target-bytes-unverified");
    assert.equal(left.packaging_authority, "lock-contract-only");
    assert.equal(left.source_build_authority, "none");
    assert.equal(left.environment_materialization_authority, "none");
    assert.equal(left.cpython_provenance_authority, "none");
    assert.equal(left.package_metadata_authority, "none");
    assert.equal(left.license_authority, "none");
    assert.equal(left.import_authority, "none");
    assert.equal(left.quality_gate_status, "not-assessed");
    assert.equal(left.formal_claims, "none");
    assert.equal(left.production_evidence, false);
    assert.equal(left.public_distribution, false);
    assert.equal(left.selection_authority, "none");
    assert.equal(left.target.os, "windows");
    assert.equal(left.target.arch, "amd64");
    assert.equal(left.target.cpython_version_family, "3.12.x");
    assert.equal(left.target.python_abi, "cp312");
    assert.equal(left.target.platform_tag, "win_amd64");
    assert.equal(left.target.accelerator_profile, "cpu-baseline");
    assert.equal(left.root_requirement_count, 3);
    assert.equal(left.distribution_count, 3);
    assert.equal(left.wheel_count, 3);
    assert.equal(left.declared_top_level_import_map_count, 1);
    assert.equal(left.wheel_total_size_bytes, Object.values(fixture.wheels).reduce((sum, wheel) => sum + wheel.size_bytes, 0));
    assert.match(left.declared_dependency_graph_sha256, /^[0-9a-f]{64}$/u);
    assert.match(left.declared_metadata_contract_sha256, /^[0-9a-f]{64}$/u);
    assert.match(left.wheel_artifact_set_sha256, /^[0-9a-f]{64}$/u);
    assert.match(left.expected_environment_report_declaration_sha256, /^[0-9a-f]{64}$/u);
    assert.equal(left.package_lock_role.sha256, sha256(fixture.packageLockBytes));
    assert.doesNotThrow(() => validatePublicEvidence(left));

    const serialized = JSON.stringify(left);
    for (const forbidden of [
      root,
      "wheelhouse/",
      "inputs/",
      "funasr-1.3.22",
      "torch-2.6.0",
      "torchaudio-2.6.0",
      "https://files.pythonhosted.org",
      "funasr==",
      "torch==",
      "torchaudio==",
      "site-packages",
      "direct_url",
    ]) {
      assert.equal(serialized.includes(forbidden), false, forbidden);
    }
  });
});

test("4b aggregate, manifest drift, package-lock role drift, and same-size package-lock tamper fail closed", async () => {
  await withPackageLockFixture(async (root, fixture) => {
    const { attestPackageLock } = await loadModule();
    await assert.rejects(() => attestPackageLock(root, fixture.manifestPath, "f".repeat(64)), /AGGREGATE/u);
    const manifest = JSON.parse(readFileSync(fixture.manifestPath, "utf8"));
    manifest.files.find((entry) => entry.role === "package-lock").sha256 = "f".repeat(64);
    await writeFile(fixture.manifestPath, encodeCanonicalJson(manifest), "utf8");
    await assert.rejects(() => attestPackageLock(root, fixture.manifestPath, fixture.aggregate), /AGGREGATE|PACKAGE_LOCK|HASH_DRIFT/u);
  });
  await withPackageLockFixture(async (root, fixture) => {
    const { attestPackageLock } = await loadModule();
    const tampered = Buffer.from(fixture.packageLockBytes);
    tampered[tampered.length - 2] = tampered[tampered.length - 2] === 0x41 ? 0x42 : 0x41;
    await writeFile(fixture.packageLockAbsolute, tampered);
    await assert.rejects(() => attestPackageLock(root, fixture.manifestPath, fixture.aggregate), /HASH_DRIFT|PACKAGE_LOCK/u);
  });
});

test("canonical package-lock envelope rejects UTF-8, NFC, LF, BOM, NUL, CR, and size violations", async () => {
  const cases = [
    ["compact json", (lock) => Buffer.from(JSON.stringify(lock), "utf8"), /CANONICAL|PACKAGE_LOCK/u],
    ["bom", (lock) => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(encodeCanonicalJson(lock), "utf8")]), /BOM|UTF|CANONICAL|PACKAGE_LOCK/u],
    ["invalid utf8", () => Buffer.from([0xff, 0x0a]), /UTF|PACKAGE_LOCK/u],
    ["nul", () => Buffer.from("{\"kind\":\"x\\u0000\"}\n", "utf8"), /NUL|PACKAGE_LOCK/u],
    ["crlf", (lock) => Buffer.from(encodeCanonicalJson(lock).replaceAll("\n", "\r\n"), "utf8"), /CR|LF|CANONICAL|PACKAGE_LOCK/u],
    ["missing terminal lf", (lock) => Buffer.from(encodeCanonicalJson(lock).trimEnd(), "utf8"), /TERMINAL_LF|CANONICAL|PACKAGE_LOCK/u],
    ["multiple terminal lf", (lock) => Buffer.from(`${encodeCanonicalJson(lock)}\n`, "utf8"), /TERMINAL_LF|CANONICAL|PACKAGE_LOCK/u],
    ["non nfc", (lock) => Buffer.from(encodeCanonicalJson({ ...lock, resolver_declaration: { ...lock.resolver_declaration, version: "25.1.1-e\u0301" } }), "utf8"), /NFC|PACKAGE_LOCK/u],
    ["oversize", () => Buffer.concat([Buffer.alloc(4 * 1024 * 1024, 0x20), Buffer.from("\n")]), /SIZE|PACKAGE_LOCK/u],
  ];
  for (const [name, buildBytes, pattern] of cases) {
    await withPackageLockFixture(async (root, fixture) => {
      const { attestPackageLock } = await loadModule();
      await assert.rejects(() => attestPackageLock(root, fixture.manifestPath, fixture.aggregate), pattern, name);
    }, { packageLockBytes: buildBytes(basePackageLock({
      funasr: { relative_path: "wheelhouse/funasr-1.3.22-py3-none-any.whl", sha256: VALID_SHA, size_bytes: 1 },
      torch: { relative_path: "wheelhouse/torch-2.6.0-cp312-cp312-win_amd64.whl", sha256: VALID_SHA, size_bytes: 1 },
      torchaudio: { relative_path: "wheelhouse/torchaudio-2.6.0-cp312-cp312-win_amd64.whl", sha256: VALID_SHA, size_bytes: 1 },
    })) });
  }
});

test("root requirements are sorted unique exact pins and include FunASR plus matching torch and torchaudio", async () => {
  const cases = [
    ["missing funasr", (lock) => { lock.root_requirements = [`torch==${TORCH_VERSION}`, `torchaudio==${TORCH_VERSION}`]; }, /ROOT|funasr/u],
    ["unversioned torch", (lock) => { lock.root_requirements[1] = "torch"; }, /ROOT|PIN|torch/u],
    ["torch torchaudio mismatch", (lock) => { lock.root_requirements[2] = "torchaudio==2.5.1"; lock.distributions[2].version = "2.5.1"; }, /TORCH|MISMATCH|torchaudio/u],
    ["unsorted roots", (lock) => { lock.root_requirements = [`torch==${TORCH_VERSION}`, `funasr==${FUNASR_VERSION}`, `torchaudio==${TORCH_VERSION}`]; }, /SORT|ROOT/u],
    ["duplicate roots", (lock) => { lock.root_requirements.push(`funasr==${FUNASR_VERSION}`); }, /DUPLICATE|ROOT/u],
  ];
  for (const [name, mutate, pattern] of cases) await assertAttestRejects(mutate, pattern, undefined, name);
});

test("distribution closure rejects missing, extra, unreachable, duplicate, and dependency-drift distributions", async () => {
  const cases = [
    ["missing dependency distribution", (lock) => { lock.distributions = lock.distributions.filter((item) => item.name !== "torchaudio"); }, /MISSING|DEPEND/u],
    ["extra unreachable distribution", (lock) => { lock.distributions.push(distribution({ name: "unused", version: "1.0.0", filename: "unused-1.0.0-cp312-cp312-win_amd64.whl", relativePath: "wheelhouse/unused-1.0.0-cp312-cp312-win_amd64.whl", sha: VALID_SHA, size: 1 })); }, /UNREACHABLE|EXTRA/u],
    ["duplicate normalized distribution", (lock) => { lock.distributions.push({ ...lock.distributions[1], name: "Torch" }); }, /DUPLICATE|DISTRIBUTION/u],
    ["unsorted distributions", (lock) => { lock.distributions.reverse(); }, /SORT|DISTRIBUTION/u],
    ["missing exact dependency edge", (lock) => { lock.distributions[0].dependencies = [`torch==${TORCH_VERSION}`]; }, /DEPEND|torchaudio/u],
    ["extras are forbidden", (lock) => { lock.distributions[0].dependencies = [`torch[vision]==${TORCH_VERSION}`, `torchaudio==${TORCH_VERSION}`]; }, /EXTRA|DEPEND/u],
  ];
  for (const [name, mutate, pattern] of cases) await assertAttestRejects(mutate, pattern, undefined, name);
});

test("wheel artifact validation rejects fake forms, incompatible tags, URL/path attacks, duplicates, zero hashes, and same-size byte drift", async () => {
  const cases = [
    ["sdist", (lock) => { lock.distributions[0].wheel.filename = "funasr-1.3.22.tar.gz"; }, /WHEEL|SDIST/u],
    ["editable", (lock) => { lock.distributions[0].wheel.filename = "-e funasr"; }, /WHEEL|EDITABLE/u],
    ["vcs", (lock) => { lock.distributions[0].wheel.declared_source_url = "git+https://github.com/modelscope/FunASR"; }, /VCS|URL/u],
    ["incompatible abi", (lock) => { lock.distributions[1].wheel.filename = "torch-2.6.0-cp311-cp311-win_amd64.whl"; lock.distributions[1].wheel.relative_path = "wheelhouse/torch-2.6.0-cp311-cp311-win_amd64.whl"; lock.distributions[1].wheel.declared_source_url = "https://files.pythonhosted.org/packages/synthetic/torch-2.6.0-cp311-cp311-win_amd64.whl"; lock.distributions[1].wheel.tags = ["cp311-cp311-win_amd64"]; }, /TAG|ABI/u],
    ["incompatible platform", (lock) => { lock.distributions[1].wheel.filename = "torch-2.6.0-cp312-cp312-manylinux_x86_64.whl"; lock.distributions[1].wheel.relative_path = "wheelhouse/torch-2.6.0-cp312-cp312-manylinux_x86_64.whl"; lock.distributions[1].wheel.declared_source_url = "https://files.pythonhosted.org/packages/synthetic/torch-2.6.0-cp312-cp312-manylinux_x86_64.whl"; lock.distributions[1].wheel.tags = ["cp312-cp312-manylinux_x86_64"]; }, /TAG|PLATFORM/u],
    ["declared tag mismatch", (lock) => { lock.distributions[0].wheel.tags = ["cp312-cp312-win_amd64"]; }, /TAG|FILENAME/u],
    ["duplicate filename", (lock) => { lock.distributions[2].wheel.filename = lock.distributions[1].wheel.filename; lock.distributions[2].wheel.relative_path = lock.distributions[1].wheel.relative_path; }, /DUPLICATE|FILENAME|IDENTITY/u],
    ["non-official artifact origin", (lock) => { lock.distributions[0].wheel.declared_source_url = "https://example.invalid/funasr-1.3.22-py3-none-any.whl"; }, /HOST|URL/u],
    ["URL filename mismatch", (lock) => { lock.distributions[0].wheel.declared_source_url = "https://files.pythonhosted.org/packages/synthetic/other-1.0-py3-none-any.whl"; }, /BASENAME|FILENAME|URL/u],
    ["local path url", (lock) => { lock.distributions[0].wheel.declared_source_url = "file:///C:/secret/funasr.whl"; }, /URL|PATH/u],
    ["zero hash", (lock) => { lock.distributions[0].wheel.sha256 = ZERO_SHA; }, /SHA|DIGEST/u],
  ];
  for (const [name, mutate, pattern] of cases) await assertAttestRejects(mutate, pattern, undefined, name);

  await withPackageLockFixture(async (root, fixture) => {
    const { attestPackageLock } = await loadModule();
    await writeFile(fixture.wheels.funasr.absolute, Buffer.from("synthetic wheel bytes for funasX\n", "utf8"));
    await assert.rejects(() => attestPackageLock(root, fixture.manifestPath, fixture.aggregate), /WHEEL|HASH_DRIFT/u);
  });
});

test("declared metadata, RECORD, license, and import-map bindings reject zero, missing, or conflicting values", async () => {
  const cases = [
    ["missing metadata hash", (lock) => { delete lock.distributions[0].declared_dist_info_metadata_sha256; }, /METADATA/u],
    ["zero record hash", (lock) => { lock.distributions[0].declared_dist_info_record_sha256 = ZERO_SHA; }, /RECORD|DIGEST/u],
    ["missing license hash", (lock) => { delete lock.distributions[0].declared_license_files_aggregate_sha256; }, /LICENSE/u],
    ["funasr missing import", (lock) => { lock.distributions[0].declared_top_level_imports = []; }, /IMPORT|funasr/u],
    ["import mapping conflict", (lock) => { lock.distributions[1].declared_top_level_imports = ["funasr"]; }, /IMPORT|CONFLICT/u],
    ["extra top-level import", (lock) => { lock.distributions[0].declared_top_level_imports = ["funasr", "funasr_extra"]; }, /IMPORT|EXTRA/u],
  ];
  for (const [name, mutate, pattern] of cases) await assertAttestRejects(mutate, pattern, undefined, name);
});

test("built-wheel distributions bind source archive metadata and nonzero build attestation while retaining no source-build authority", async () => {
  await withPackageLockFixture(async (root, fixture) => {
    const { attestPackageLock } = await loadModule();
    fixture.lock.distributions[0].built_wheel = {
      source_archive: {
        filename: "funasr-1.3.22.tar.gz",
        declared_source_url: "https://files.pythonhosted.org/packages/source/f/funasr/funasr-1.3.22.tar.gz",
        declared_sha256: "c".repeat(64),
        declared_size_bytes: 123,
      },
      declared_build_attestation_sha256: "d".repeat(64),
    };
    await writeFile(fixture.packageLockAbsolute, encodeCanonicalJson(fixture.lock), "utf8");
    const manifest = JSON.parse(readFileSync(fixture.manifestPath, "utf8"));
    const packageLock = manifest.files.find((entry) => entry.role === "package-lock");
    packageLock.sha256 = sha256(encodeCanonicalJson(fixture.lock));
    packageLock.size_bytes = Buffer.byteLength(encodeCanonicalJson(fixture.lock));
    await writeFile(fixture.manifestPath, encodeCanonicalJson(manifest), "utf8");
    const preflight = await preflightCandidate(root, fixture.manifestPath);
    const evidence = await attestPackageLock(root, fixture.manifestPath, preflight.candidate_descriptor.aggregate_sha256);
    assert.equal(evidence.built_wheel_count, 1);
    assert.equal(evidence.source_build_authority, "none");
  });

  const cases = [
    ["missing source archive", (lock) => { lock.distributions[0].built_wheel = { declared_build_attestation_sha256: "d".repeat(64) }; }, /BUILD|SOURCE_ARCHIVE/u],
    ["missing build digest", (lock) => { lock.distributions[0].built_wheel = { source_archive: { filename: "funasr-1.3.22.tar.gz", declared_source_url: "https://files.pythonhosted.org/packages/source/f/funasr/funasr-1.3.22.tar.gz", declared_sha256: "c".repeat(64), declared_size_bytes: 123 } }; }, /BUILD|ATTESTATION/u],
    ["zero build digest", (lock) => { lock.distributions[0].built_wheel = { source_archive: { filename: "funasr-1.3.22.tar.gz", declared_source_url: "https://files.pythonhosted.org/packages/source/f/funasr/funasr-1.3.22.tar.gz", declared_sha256: "c".repeat(64), declared_size_bytes: 123 }, declared_build_attestation_sha256: ZERO_SHA }; }, /BUILD|DIGEST/u],
    ["source archive traversal name", (lock) => { lock.distributions[0].built_wheel = { source_archive: { filename: "../funasr-1.3.22.tar.gz", declared_source_url: "https://files.pythonhosted.org/packages/source/f/funasr/funasr-1.3.22.tar.gz", declared_sha256: "c".repeat(64), declared_size_bytes: 123 }, declared_build_attestation_sha256: "d".repeat(64) }; }, /BUILD|PATH|SOURCE_ARCHIVE/u],
    ["source archive ADS name", (lock) => { lock.distributions[0].built_wheel = { source_archive: { filename: "funasr-1.3.22.tar.gz:stream.tar.gz", declared_source_url: "https://files.pythonhosted.org/packages/source/f/funasr/funasr-1.3.22.tar.gz", declared_sha256: "c".repeat(64), declared_size_bytes: 123 }, declared_build_attestation_sha256: "d".repeat(64) }; }, /BUILD|PATH|SOURCE_ARCHIVE/u],
    ["source archive non-official origin", (lock) => { lock.distributions[0].built_wheel = { source_archive: { filename: "funasr-1.3.22.tar.gz", declared_source_url: "https://example.invalid/funasr-1.3.22.tar.gz", declared_sha256: "c".repeat(64), declared_size_bytes: 123 }, declared_build_attestation_sha256: "d".repeat(64) }; }, /HOST|URL/u],
    ["source archive URL mismatch", (lock) => { lock.distributions[0].built_wheel = { source_archive: { filename: "funasr-1.3.22.tar.gz", declared_source_url: "https://files.pythonhosted.org/packages/source/f/funasr/other-1.0.tar.gz", declared_sha256: "c".repeat(64), declared_size_bytes: 123 }, declared_build_attestation_sha256: "d".repeat(64) }; }, /BASENAME|FILENAME|URL/u],
  ];
  for (const [name, mutate, pattern] of cases) await assertAttestRejects(mutate, pattern, undefined, name);
});

test("materialization policy rejects network, index, no-hash, deps install, direct-url, user/global, and nonwheel allowances", async () => {
  const cases = [
    ["network enabled", (lock) => { lock.materialization_policy.network = "enabled"; }, /NETWORK|POLICY/u],
    ["index enabled", (lock) => { lock.materialization_policy.index_access = "enabled"; }, /INDEX|POLICY/u],
    ["missing hashes", (lock) => { lock.materialization_policy.require_hashes = false; }, /HASH|POLICY/u],
    ["install deps", (lock) => { lock.materialization_policy.install_no_deps = false; }, /NO_DEPS|POLICY/u],
    ["sdist allowed", (lock) => { lock.materialization_policy.allow_sdist = true; }, /SDIST|POLICY/u],
    ["direct url allowed", (lock) => { lock.materialization_policy.allow_direct_url = true; }, /DIRECT_URL|POLICY/u],
    ["user site allowed", (lock) => { lock.materialization_policy.allow_user_site = true; }, /USER|POLICY/u],
    ["global site allowed", (lock) => { lock.materialization_policy.allow_global_site = true; }, /GLOBAL|POLICY/u],
  ];
  for (const [name, mutate, pattern] of cases) await assertAttestRejects(mutate, pattern, undefined, name);
});

test("target, resolver declaration, and expected report reject unsupported or inconsistent declarations", async () => {
  const cases = [
    ["linux target", (lock) => { lock.target.os = "linux"; }, /TARGET|windows/u],
    ["arm64 target", (lock) => { lock.target.arch = "arm64"; }, /TARGET|amd64/u],
    ["python 3.11", (lock) => { lock.target.cpython_version_family = "3.11.x"; lock.target.python_abi = "cp311"; }, /CPYTHON|cp312/u],
    ["invalid accelerator", (lock) => { lock.target.accelerator_profile = "directml"; }, /ACCELERATOR/u],
    ["unsupported resolver", (lock) => { lock.resolver_declaration.tool = "uv"; }, /RESOLVER|pip/u],
    ["zero report hash", (lock) => { lock.resolver_declaration.declared_report_sha256 = ZERO_SHA; }, /REPORT|DIGEST/u],
    ["expected report count drift", (lock) => { lock.expected_environment_report.expected_distribution_count = 4; }, /EXPECTED|REPORT/u],
    ["expected report overclaim", (lock) => { lock.expected_environment_report.verification_status = "verified"; }, /EXPECTED|REPORT|VERIFICATION/u],
  ];
  for (const [name, mutate, pattern] of cases) await assertAttestRejects(mutate, pattern, undefined, name);
});

test("bounded counts and sizes reject too many roots, distributions, wheels, and invalid sizes", async () => {
  const cases = [
    ["too many roots", (lock) => { lock.root_requirements = Array.from({ length: 129 }, (_, index) => `pkg${index}==1.0.0`); }, /ROOT|COUNT|LIMIT/u],
    ["too many distributions", (lock) => { lock.distributions = Array.from({ length: 513 }, (_, index) => distribution({ name: `pkg${index}`, version: "1.0.0", filename: `pkg${index}-1.0.0-cp312-cp312-win_amd64.whl`, relativePath: `wheelhouse/pkg${index}.whl`, sha: "e".repeat(64), size: 1 })); }, /DISTRIBUTION|COUNT|LIMIT/u],
    ["zero wheel size", (lock) => { lock.distributions[0].wheel.size_bytes = 0; }, /SIZE|WHEEL/u],
    ["unsafe integer wheel size", (lock) => { lock.distributions[0].wheel.size_bytes = Number.MAX_SAFE_INTEGER + 1; }, /SIZE|WHEEL/u],
  ];
  for (const [name, mutate, pattern] of cases) await assertAttestRejects(mutate, pattern, undefined, name);
});

test("wheel paths reject traversal, UNC/device/drive syntax, symlink/junction, and hardlink alias overclaims", async (context) => {
  const pathCases = [
    ["traversal", (lock) => { lock.distributions[0].wheel.relative_path = "../funasr.whl"; }, /PATH|TRAVERSAL/u],
    ["absolute drive", (lock) => { lock.distributions[0].wheel.relative_path = "C:/secret/funasr.whl"; }, /PATH|LOCAL/u],
    ["UNC", (lock) => { lock.distributions[0].wheel.relative_path = "//server/share/funasr.whl"; }, /PATH|UNC/u],
    ["ADS", (lock) => { lock.distributions[0].wheel.relative_path = "wheelhouse/funasr.whl:stream"; }, /PATH|ADS/u],
  ];
  for (const [name, mutate, pattern] of pathCases) await assertAttestRejects(mutate, pattern, undefined, name);

  await withPackageLockFixture(async (root, fixture) => {
    const { attestPackageLock } = await loadModule();
    const link = path.join(root, "wheelhouse", "funasr-link.whl");
    try {
      await symlink(fixture.wheels.funasr.absolute, link);
    } catch (error) {
      if (process.platform === "win32" && error.code === "EPERM") return;
      throw error;
    }
    fixture.lock.distributions[0].wheel.relative_path = "wheelhouse/funasr-link.whl";
    fixture.lock.distributions[0].wheel.filename = "funasr-link.whl";
    await writeFile(fixture.packageLockAbsolute, encodeCanonicalJson(fixture.lock), "utf8");
    const manifest = JSON.parse(readFileSync(fixture.manifestPath, "utf8"));
    const packageLock = manifest.files.find((entry) => entry.role === "package-lock");
    packageLock.sha256 = sha256(encodeCanonicalJson(fixture.lock));
    packageLock.size_bytes = Buffer.byteLength(encodeCanonicalJson(fixture.lock));
    await writeFile(fixture.manifestPath, encodeCanonicalJson(manifest), "utf8");
    const preflight = await preflightCandidate(root, fixture.manifestPath);
    await assert.rejects(() => attestPackageLock(root, fixture.manifestPath, preflight.candidate_descriptor.aggregate_sha256), /SPECIAL|SYMLINK|REPARSE/u);
  });

  await withPackageLockFixture(async (root, fixture) => {
    const { attestPackageLock } = await loadModule();
    const original = fixture.wheels.funasr.absolute;
    const alias = path.join(root, "wheelhouse", "funasr-hardlink.whl");
    try {
      await link(original, alias);
    } catch (error) {
      if (["EPERM", "ENOTSUP", "EOPNOTSUPP"].includes(error.code)) return;
      throw error;
    }
    await assert.rejects(() => attestPackageLock(root, fixture.manifestPath, fixture.aggregate), /HARDLINK|ALIAS/u);
  });

  if (process.platform !== "win32") context.skip("Windows junction coverage is enforced by implementation policy on Windows CI");
});

test("public evidence validator rejects authority overclaims and forbidden public material", async () => {
  await withPackageLockFixture(async (root, fixture) => {
    const { attestPackageLock, validatePublicEvidence } = await loadModule();
    const evidence = await attestPackageLock(root, fixture.manifestPath, fixture.aggregate);
    const overclaims = [
      { production_evidence: true },
      { public_distribution: true },
      { selection_authority: "default" },
      { execution_status: "installed-and-imported" },
      { packaging_authority: "production-package-approved" },
      { source_build_authority: "verified" },
      { environment_materialization_authority: "verified" },
      { cpython_provenance_authority: "verified" },
      { package_metadata_authority: "verified" },
      { license_authority: "verified" },
      { import_authority: "verified" },
      { quality_gate_status: "passed" },
    ];
    for (const overclaim of overclaims) assert.throws(() => validatePublicEvidence({ ...evidence, ...overclaim }), /OVERCLAIM|SCHEMA/u);
    assert.throws(() => validatePublicEvidence({ ...evidence, lock_text: encodeCanonicalJson(fixture.lock) }), /SCHEMA|FORBIDDEN/u);
    assert.throws(() => validatePublicEvidence({ ...evidence, wheel_url: "https://files.pythonhosted.org/packages/funasr.whl" }), /SCHEMA|FORBIDDEN/u);
    assert.throws(() => validatePublicEvidence({ ...evidence, limitations: ["C:\\secret\\wheelhouse", ...evidence.limitations.slice(1)] }), /SCHEMA|FORBIDDEN/u);
  });
});

test("schema parity mirrors constants and closes all object shapes", async () => {
  const {
    PUBLIC_EVIDENCE_KIND,
    PUBLIC_EVIDENCE_SCHEMA_PATH,
    PUBLIC_EVIDENCE_SCHEMA_VERSION,
    validatePublicEvidence,
    attestPackageLock,
  } = await loadModule();
  const schema = JSON.parse(await readFile(PUBLIC_EVIDENCE_SCHEMA_PATH, "utf8"));
  assert.equal(PUBLIC_EVIDENCE_KIND, EVIDENCE_KIND);
  assert.equal(PUBLIC_EVIDENCE_SCHEMA_VERSION, "1.0");
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.kind.const, EVIDENCE_KIND);
  assert.equal(schema.properties.schema_version.const, "1.0");
  assert.equal(schema.properties.measurement_status.const, "package-lock-attestation-only");
  assert.equal(schema.properties.execution_status.const, "lock-contract-and-wheel-byte-identity-only-no-install-no-import");
  assert.equal(schema.properties.package_lock_binding_scope.const, "four-b-package-lock-role-byte-match-only");
  assert.equal(schema.properties.wheel_binding_scope.const, "controlled-root-referenced-wheel-byte-match-only");
  assert.equal(schema.properties.declaration_binding_scope.const, "lock-fields-bound-only-target-bytes-unverified");
  assert.equal(schema.properties.packaging_authority.const, "lock-contract-only");
  assert.equal(schema.properties.source_build_authority.const, "none");
  assert.equal(schema.properties.environment_materialization_authority.const, "none");
  assert.equal(schema.properties.cpython_provenance_authority.const, "none");
  assert.equal(schema.properties.package_metadata_authority.const, "none");
  assert.equal(schema.properties.license_authority.const, "none");
  assert.equal(schema.properties.import_authority.const, "none");
  assert.equal(schema.properties.quality_gate_status.const, "not-assessed");
  assert.equal(schema.properties.formal_claims.const, "none");
  assert.equal(schema.properties.production_evidence.const, false);
  assert.equal(schema.properties.public_distribution.const, false);
  assert.equal(schema.properties.selection_authority.const, "none");
  assert.equal(schema.properties.target.additionalProperties, false);
  assert.equal(schema.properties.package_lock_role.additionalProperties, false);
  assert.equal(schema.properties.resolver_declaration.additionalProperties, false);
  assert.equal(schema.properties.limitations.items, false);

  await withPackageLockFixture(async (root, fixture) => {
    const evidence = await attestPackageLock(root, fixture.manifestPath, fixture.aggregate);
    assert.doesNotThrow(() => validatePublicEvidence(evidence));
    assert.deepEqual(schema.properties.limitations.prefixItems.map((item) => item.const), evidence.limitations);
  });
});

test("attestor source imports no process/network execution modules and invokes no execution surface", async () => {
  const source = await readFile(TEST_MODULE_SOURCE_PATH, "utf8");
  const imports = [...source.matchAll(/from\s+"(node:[^"]+)"/gu)].map((match) => match[1]).sort();
  const forbiddenImports = imports.filter((specifier) => /node:(?:child_process|cluster|dgram|dns|http|https|net|tls|worker_threads)/u.test(specifier));
  assert.deepEqual(forbiddenImports, []);
  assert.doesNotMatch(source, /(?<!\.)\b(?:spawn|execFile|exec|fork|fetch|WebSocket)\s*\(/u);
});

test("CLI emits strict package-lock marker, validate-json marker, and usage failures", async () => {
  const run = await execFileAsync(process.execPath, ["tools/funasr-sidecar/sidecar-package-lock-attestation.mjs", "--run-synthetic"], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(run.stderr, "");
  assert.match(
    run.stdout,
    /^funasr-sidecar-package-lock-attestation=verified evidence_sha256=[0-9a-f]{64} candidate_aggregate_sha256=[0-9a-f]{64} package_lock_sha256=[0-9a-f]{64} distributions=3 wheels=3 root_requirements=3 target=windows-amd64-cp312-win_amd64 accelerator_profile=(cpu-baseline|cuda) measurement_status=package-lock-attestation-only execution_status=lock-contract-and-wheel-byte-identity-only-no-install-no-import packaging_authority=lock-contract-only source_build_authority=none environment_materialization_authority=none cpython_provenance_authority=none package_metadata_authority=none license_authority=none import_authority=none quality_gate_status=not-assessed formal_claims=none production_evidence=false public_distribution=false selection_authority=none fixture_scope=synthetic-lock-no-install-no-import\r?\n$/u,
  );

  await withPackageLockFixture(async (root, fixture) => {
    const { attestPackageLock } = await loadModule();
    const evidence = await attestPackageLock(root, fixture.manifestPath, fixture.aggregate);
    const validated = await execFileAsync(
      process.execPath,
      ["tools/funasr-sidecar/sidecar-package-lock-attestation.mjs", "--validate-json", encodeCanonicalJson(evidence)],
      { encoding: "utf8", windowsHide: true },
    );
    assert.match(validated.stdout, /^funasr-sidecar-package-lock-attestation-json=verified evidence_sha256=[0-9a-f]{64}\r?\n$/u);
  });

  const usage = await execFileAsync(process.execPath, ["tools/funasr-sidecar/sidecar-package-lock-attestation.mjs", "--attest"], {
    encoding: "utf8",
    windowsHide: true,
  }).catch((error) => error);
  assert.match(usage.stderr, /PACKAGE_LOCK_ATTEST_USAGE/u);
  assert.equal(usage.stdout, "");
});

test("4a, 4b, 4c, and 4d regression scripts remain executable", async () => {
  const commands = [
    "tools/funasr-sidecar/sidecar-wire-foundation.test.mjs",
    "tools/funasr-sidecar/sidecar-candidate-preflight.test.mjs",
    "tools/funasr-sidecar/sidecar-python-launch.test.mjs",
    "tools/funasr-sidecar/sidecar-source-attestation.test.mjs",
  ];
  for (const file of commands) {
    const result = await execFileAsync(process.execPath, ["--test", file], { encoding: "utf8", windowsHide: true });
    assert.equal(result.stderr.includes("fail"), false, file);
  }
});
