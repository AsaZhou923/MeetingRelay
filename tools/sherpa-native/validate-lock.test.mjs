import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { encodeCanonicalJsonLine } from "../phase0-harness/canonical-json.mjs";

import {
  DEFAULT_LOCK_PATH,
  LockValidationError,
  validateCandidateLockFile,
  validateCargoOfflineGate,
  validateLockFile,
  validateLockObject,
} from "./validate-lock.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../..");
const MATERIALIZER_PATH = path.join(HERE, "materialize.ps1");
const EXPECTED_BUILDER_INPUT_SHA256 =
  "7d9601948653e75c316461e5e2629ded8e5f4f669c909751ff3c1db91c1ca4f2";

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function originalLock() {
  return JSON.parse(await readFile(DEFAULT_LOCK_PATH, "utf8"));
}

function expectCode(code, mutate) {
  return originalLock().then((lock) => {
    mutate(lock);
    assert.throws(
      () => validateLockObject(lock),
      (error) => error instanceof LockValidationError && error.code === code,
    );
  });
}

async function stagedLock() {
  const root = await mkdtemp(path.join(os.tmpdir(), "meetingrelay-sherpa-lock-"));
  await mkdir(path.join(root, "licenses"));
  for (const name of [
    "apache-2.0-sherpa-onnx.txt",
    "funasr-model-license-1.0.txt",
    "funasr-model-license-1.1.txt",
    "mit-onnxruntime-1.27.0.txt",
    "sensevoice-embedded-license-pointer.txt",
  ]) {
    await copyFile(path.join(HERE, "licenses", name), path.join(root, "licenses", name));
  }
  await copyFile(DEFAULT_LOCK_PATH, path.join(root, "assets.lock.json"));
  await copyFile(path.join(HERE, "assets.lock.sha256"), path.join(root, "assets.lock.sha256"));
  return root;
}

test("the committed sherpa native lock and license snapshots validate", async () => {
  const result = await validateLockFile();
  assert.equal(result.lockSha256, "e22adeea2dde27cab1c40fa116b665ef111b7c1b8cf24f7b7a1900a23e263181");
});

test("candidate lock validates from a sealed bundle without the source sidecar or historical licenses", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "meetingrelay-candidate-lock-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const lockDirectory = path.join(root, "assets");
  const licenseDirectory = path.join(root, "licenses");
  await Promise.all([
    mkdir(lockDirectory),
    mkdir(licenseDirectory),
  ]);
  const lockPath = path.join(lockDirectory, "assets.lock.json");
  await copyFile(DEFAULT_LOCK_PATH, lockPath);
  for (const name of [
    "apache-2.0-sherpa-onnx.txt",
    "funasr-model-license-1.1.txt",
    "mit-onnxruntime-1.27.0.txt",
  ]) {
    await copyFile(path.join(HERE, "licenses", name), path.join(licenseDirectory, name));
  }

  const result = await validateCandidateLockFile({
    expectedLockSha256: "e22adeea2dde27cab1c40fa116b665ef111b7c1b8cf24f7b7a1900a23e263181",
    licenseRoot: root,
    lockPath,
  });
  assert.equal(result.lockPath, lockPath);
  assert.equal(result.lockSha256, "e22adeea2dde27cab1c40fa116b665ef111b7c1b8cf24f7b7a1900a23e263181");

  const apachePath = path.join(licenseDirectory, "apache-2.0-sherpa-onnx.txt");
  const tampered = await readFile(apachePath);
  tampered[0] ^= 0xff;
  await writeFile(apachePath, tampered);
  await assert.rejects(
    validateCandidateLockFile({
      expectedLockSha256: result.lockSha256,
      licenseRoot: root,
      lockPath,
    }),
    (error) => error instanceof LockValidationError && error.code === "LOCK_LICENSE_FILE",
  );
});

test("candidate lock requires each current bundle license snapshot", async (t) => {
  const names = [
    "apache-2.0-sherpa-onnx.txt",
    "funasr-model-license-1.1.txt",
    "mit-onnxruntime-1.27.0.txt",
  ];
  for (const missing of names) {
    const root = await mkdtemp(path.join(os.tmpdir(), "meetingrelay-candidate-lock-"));
    t.after(() => rm(root, { force: true, recursive: true }));
    const lockDirectory = path.join(root, "assets");
    const licenseDirectory = path.join(root, "licenses");
    await Promise.all([mkdir(lockDirectory), mkdir(licenseDirectory)]);
    const lockPath = path.join(lockDirectory, "assets.lock.json");
    await copyFile(DEFAULT_LOCK_PATH, lockPath);
    for (const name of names.filter((candidate) => candidate !== missing)) {
      await copyFile(path.join(HERE, "licenses", name), path.join(licenseDirectory, name));
    }

    await assert.rejects(
      validateCandidateLockFile({
        expectedLockSha256: "e22adeea2dde27cab1c40fa116b665ef111b7c1b8cf24f7b7a1900a23e263181",
        licenseRoot: root,
        lockPath,
      }),
      (error) => error instanceof LockValidationError && error.code === "LOCK_LICENSE_FILE",
      `expected the missing ${missing} snapshot to fail`,
    );
  }
});

test("candidate lock is joined to its explicit external digest", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "meetingrelay-candidate-lock-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const lockPath = path.join(root, "assets.lock.json");
  await copyFile(DEFAULT_LOCK_PATH, lockPath);

  await assert.rejects(
    validateCandidateLockFile({
      expectedLockSha256: "f".repeat(64),
      licenseRoot: root,
      lockPath,
    }),
    (error) => error instanceof LockValidationError && error.code === "LOCK_FILE_DIGEST",
  );
});

test("candidate lock rejects a license root that crosses a reparse point", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "meetingrelay-candidate-lock-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const lockDirectory = path.join(root, "assets");
  await mkdir(lockDirectory);
  const lockPath = path.join(lockDirectory, "assets.lock.json");
  await copyFile(DEFAULT_LOCK_PATH, lockPath);
  try {
    await symlink(
      path.join(HERE, "licenses"),
      path.join(root, "licenses"),
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch (error) {
    if (error?.code === "EPERM") {
      t.skip("host cannot create the optional reparse-point fixture");
      return;
    }
    throw error;
  }

  await assert.rejects(
    validateCandidateLockFile({
      expectedLockSha256: "e22adeea2dde27cab1c40fa116b665ef111b7c1b8cf24f7b7a1900a23e263181",
      licenseRoot: root,
      lockPath,
    }),
    (error) => error instanceof LockValidationError && error.code === "LOCK_PATH",
  );
});

test("Rust sherpa builder input is canonical and joined to locked source material", async () => {
  const command = process.platform === "win32" ? "cargo.exe" : "cargo";
  const emitted = spawnSync(
    command,
    [
      "run",
      "--quiet",
      "--locked",
      "--offline",
      "-p",
      "meetingrelay-model-worker-sherpa-native",
      "--bin",
      "emit_sherpa_candidate_builder_input",
      "--no-default-features",
    ],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: { ...process.env, CARGO_TERM_COLOR: "never" },
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  assert.ifError(emitted.error);
  assert.equal(emitted.status, 0, emitted.stderr);
  assert.equal(emitted.stderr, "");

  const parsed = JSON.parse(emitted.stdout);
  assert.equal(emitted.stdout, encodeCanonicalJsonLine(parsed));
  assert.equal(sha256Bytes(Buffer.from(emitted.stdout, "utf8")), EXPECTED_BUILDER_INPUT_SHA256);
  assert.deepEqual(Object.keys(parsed), [
    "candidate_id",
    "claims",
    "deferred_builder_fields",
    "license_input",
    "locked_assets",
    "non_claim_guardrails",
    "projection_kind",
    "projection_schema_version",
    "publishability_status",
    "selection_status",
    "trust_anchor_policy",
    "worker_contract_version",
    "worker_manifest_descriptor_fragment",
    "worker_role",
  ]);
  assert.deepEqual(Object.keys(parsed.worker_manifest_descriptor_fragment), [
    "engine_id",
    "engine_version",
    "execution_provider",
    "languages",
    "model_id",
    "model_license_id",
    "model_manifest_sha256",
    "model_sha256",
    "offline",
    "package_lock_sha256",
    "parameter_sha256",
    "quantization",
    "runtime_id",
    "runtime_sha256",
    "runtime_version",
    "streaming",
  ]);
  assert.equal(parsed.candidate_id, "sherpa-native-sensevoice-int8-2024-07-17-win-x64-cpu");
  assert.deepEqual(parsed.claims, {
    formal_claims: "none",
    formal_metric_ids: [],
    production_claims: [],
    production_evidence: false,
    slo_claims: [],
  });
  assert.deepEqual(parsed.deferred_builder_fields, [
    "artifact-inventory-paths-roles-sizes-and-license-mapping",
    "build-and-source-metadata",
    "candidate-input-envelope-and-seals",
    "contract-wrapper-assets-and-role-digest-joins",
    "executable-worker-build-and-schema-registry-digests",
    "external-expectedContractSha256-value",
    "fixture-hw-run-plan-and-evidence",
    "validator-schema-bridge-for-assets-lock-cargo-lock-and-full-parameters",
    "worker-id",
  ]);
  assert.deepEqual(parsed.non_claim_guardrails, {
    eligibility_status: "not-assessed",
    execution_status: "not-run",
    measurement_status: "not-measured",
    quality_evidence: false,
    ranking_status: "not-ranked",
  });
  assert.equal(parsed.publishability_status, "pending");
  assert.equal(parsed.projection_kind, "sherpa-candidate-builder-input-v1");
  assert.equal(parsed.projection_schema_version, "1.0");
  assert.equal(parsed.selection_status, "not-selected");
  assert.equal(parsed.trust_anchor_policy, "external-expectedContractSha256-required");
  assert.equal(parsed.worker_contract_version, "meetingrelay.model-worker/1.0");
  assert.equal(parsed.worker_role, "native-candidate");
  assert.equal(parsed.artifact_scope, undefined);
  assert.equal(parsed.expectedContractSha256, undefined);

  const assetLockBytes = await readFile(DEFAULT_LOCK_PATH);
  const lock = JSON.parse(assetLockBytes.toString("utf8"));
  const cargoLockBytes = await readFile(path.join(REPO_ROOT, "Cargo.lock"));
  const license = lock.model.current_license_snapshot;
  const licenseBytes = await readFile(path.join(HERE, license.snapshot_path));
  assert.equal(licenseBytes.length, license.size_bytes);
  assert.equal(sha256Bytes(licenseBytes), license.sha256);
  assert.deepEqual(parsed.license_input, {
    distribution_status: license.distribution_status,
    license_id: license.license_id,
    review_scope: "internal-evaluation-only",
    review_source_status: license.review_status,
    review_status: "accepted",
    source_revision: license.source_revision,
    source_url: license.source_url,
    spdx_or_license_ref: license.license_id,
    text_path: license.snapshot_path,
    text_sha256: license.sha256,
    text_size_bytes: String(license.size_bytes),
  });

  const modelInventory = new Map(lock.model.archive.inventory.map((entry) => [entry.path, entry]));
  assert.deepEqual(parsed.locked_assets, {
    asset_lock_sha256: sha256Bytes(assetLockBytes),
    model_license_text_sha256: license.sha256,
    model_sha256: modelInventory.get("model.int8.onnx").sha256,
    package_lock_sha256: sha256Bytes(cargoLockBytes),
    parameter_sha256: lock.parameters.canonical_json_sha256,
    runtime_bundle_sha256: lock.runtime.archive.bundle_sha256,
    tokens_sha256: modelInventory.get("tokens.txt").sha256,
  });
  assert.deepEqual(parsed.worker_manifest_descriptor_fragment, {
    engine_id: "sherpa-onnx",
    engine_version: lock.runtime.rust_crate.version,
    execution_provider: lock.parameters.provider,
    languages: [lock.parameters.language],
    model_id: lock.model.model_id,
    model_license_id: license.license_id,
    model_manifest_sha256: sha256Bytes(assetLockBytes),
    model_sha256: modelInventory.get("model.int8.onnx").sha256,
    offline: true,
    package_lock_sha256: sha256Bytes(cargoLockBytes),
    parameter_sha256: lock.parameters.canonical_json_sha256,
    quantization: "int8",
    runtime_id: "sherpa-onnx-shared-cpu",
    runtime_sha256: lock.runtime.archive.bundle_sha256,
    runtime_version: lock.runtime.onnxruntime_file_version,
    streaming: true,
  });
});

test("unknown fields fail closed", async () => {
  await expectCode("LOCK_UNKNOWN_FIELD", (lock) => {
    lock.scope.unreviewed_override = true;
  });
});

test("Cargo cannot fall through to the upstream implicit downloader", () => {
  const cargoGate = `[env]\nSHERPA_ONNX_LIB_DIR = { value = "target/sherpa-native/extracted/sherpa-onnx-v1.13.4-win-x64-shared-MT-Release-lib/lib", relative = true }\n\n# sherpa-onnx-sys declares \`links = "sherpa-onnx"\`. This target override\n# prevents its upstream convenience build script (and implicit downloader)\n# from running. The MeetingRelay adapter build script performs the sealed\n# inventory verification, link directives, and DLL staging instead.\n[target.x86_64-pc-windows-msvc.sherpa-onnx]\nrustc-link-lib = []\n`;
  assert.doesNotThrow(() => validateCargoOfflineGate(cargoGate));
  assert.throws(
    () => validateCargoOfflineGate("[env]\n"),
    (error) => error instanceof LockValidationError && error.code === "LOCK_CARGO_OFFLINE_GATE",
  );
});

test("explicit archive acquisition uses the HTTPS-only curl path", async () => {
  const materializer = await readFile(MATERIALIZER_PATH, "utf8");
  assert.doesNotMatch(materializer, /\bInvoke-WebRequest\b/);
  assert.doesNotMatch(materializer, /Get-Command\s+curl\.exe/);
  assert.doesNotMatch(materializer, /Get-Command\s+(?:tar|bzip2)(?:\.exe)?/);
  assert.doesNotMatch(materializer, /&\s+tar(?:\.exe)?\b/);
  assert.doesNotMatch(materializer, /&\s+\$archiveTool\.TarPath/);
  assert.match(
    materializer,
    /& \$curlPath `\r?\n\s+--disable `\r?\n\s+--proto '=https'/,
    "--disable must be the first curl argument so curlrc files cannot weaken the transfer policy",
  );
  for (const required of [
    'ValidateSet("curl.exe", "tar.exe")',
    'Resolve-WindowsSystemToolPath -Name "curl.exe"',
    'Resolve-WindowsSystemToolPath -Name "tar.exe"',
    "ArchiveTarPath and ArchiveBzip2Path must be supplied together",
    "Explicit GNU tar and bzip2 must be sibling Git-for-Windows tools",
    "Explicit archive bzip2 must identify as bzip2",
    "Invoke-SanitizedArchiveCommand",
    "--force-local",
    "--use-compress-program=/usr/bin/bzip2",
    'Assert-RegularFile -Path $toolPath -Label "Windows system $Name"',
    "--disable",
    "--proto '=https'",
    "--proto-redir '=https'",
    "--tlsv1.2",
    "--retry 10",
    "--retry-connrefused",
    "--location",
    "--fail",
    "--output $Destination",
  ]) {
    assert.ok(materializer.includes(required), `materializer is missing ${required}`);
  }
  for (const environmentName of ["TAR_OPTIONS", "BZIP2", "BZIP"]) {
    assert.ok(
      materializer.includes(`\"${environmentName}\"`),
      `materializer does not sanitize ${environmentName}`,
    );
  }
});

test("runtime and model archive digest tampering fail closed", async () => {
  await expectCode("LOCK_PIN_MISMATCH", (lock) => {
    lock.runtime.archive.sha256 = "0".repeat(64);
  });
  await expectCode("LOCK_PIN_MISMATCH", (lock) => {
    lock.model.archive.sha256 = "f".repeat(64);
  });
});

test("archive size and URL tampering fail closed", async () => {
  await expectCode("LOCK_PIN_MISMATCH", (lock) => {
    lock.runtime.archive.size_bytes += 1;
  });
  await expectCode("LOCK_PIN_MISMATCH", (lock) => {
    lock.model.archive.url = "https://example.invalid/model.tar.bz2";
  });
});

test("inventory path traversal and duplicate paths fail closed", async () => {
  await expectCode("LOCK_PATH", (lock) => {
    lock.runtime.archive.inventory[0].path = "../onnxruntime.dll";
  });
  await expectCode("LOCK_DUPLICATE", (lock) => {
    lock.model.archive.inventory[1].path = lock.model.archive.inventory[0].path;
  });
});

test("inventory content and order tampering fail closed", async () => {
  await expectCode("LOCK_INVENTORY_PIN", (lock) => {
    lock.model.archive.inventory[3].sha256 = "a".repeat(64);
  });
  await expectCode("LOCK_ORDER", (lock) => {
    [lock.runtime.archive.inventory[0], lock.runtime.archive.inventory[1]] = [
      lock.runtime.archive.inventory[1],
      lock.runtime.archive.inventory[0],
    ];
  });
  await expectCode("LOCK_PIN_MISMATCH", (lock) => {
    lock.runtime.archive.bundle_sha256 = "0".repeat(64);
  });
});

test("license is accepted only for internal evaluation while distribution remains pending", async () => {
  await expectCode("LOCK_PIN_MISMATCH", (lock) => {
    lock.scope.license_review_status = "pending";
  });
  await expectCode("LOCK_PIN_MISMATCH", (lock) => {
    lock.scope.distribution_status = "accepted";
  });
  await expectCode("LOCK_PIN_MISMATCH", (lock) => {
    lock.model.current_license_snapshot.license_id = "LicenseRef-FunASR-Model-1.1-Pending";
  });
  await expectCode("LOCK_PIN_MISMATCH", (lock) => {
    lock.model.current_license_snapshot.distribution_status = "accepted";
  });
  await expectCode("LOCK_PIN_MISMATCH", (lock) => {
    lock.scope.quality_claim = "passed";
  });
});

test("hash crate, ONNX Runtime license, and full parameter pins fail closed", async () => {
  await expectCode("LOCK_PIN_MISMATCH", (lock) => {
    lock.runtime.hash_crate.checksum = "a".repeat(64);
  });
  await expectCode("LOCK_PIN_MISMATCH", (lock) => {
    lock.runtime.onnxruntime_license.license_id = "Apache-2.0";
  });
  await expectCode("LOCK_PIN_MISMATCH", (lock) => {
    lock.parameters.feature_dim = 81;
  });
  await expectCode("LOCK_PIN_MISMATCH", (lock) => {
    lock.parameters.hotwords_file = "hotwords.txt";
  });
  await expectCode("LOCK_UNKNOWN_FIELD", (lock) => {
    lock.parameters.unlocked_beam_width = 8;
  });
});

test("a mutated lock file fails its independent sidecar digest", async (context) => {
  const root = await stagedLock();
  context.after(() => rm(root, { force: true, recursive: true }));
  const lockPath = path.join(root, "assets.lock.json");
  const bytes = await readFile(lockPath);
  bytes[bytes.length - 2] ^= 1;
  await writeFile(lockPath, bytes);
  await assert.rejects(
    validateLockFile(lockPath),
    (error) => error instanceof LockValidationError && error.code === "LOCK_FILE_DIGEST",
  );
});

test("a mutated sealed license snapshot fails independently of the lock", async (context) => {
  const root = await stagedLock();
  context.after(() => rm(root, { force: true, recursive: true }));
  const snapshot = path.join(root, "licenses", "funasr-model-license-1.1.txt");
  await writeFile(snapshot, `${await readFile(snapshot, "utf8")}tampered\n`);
  await assert.rejects(
    validateLockFile(path.join(root, "assets.lock.json")),
    (error) => error instanceof LockValidationError && error.code === "LOCK_LICENSE_FILE",
  );
});
