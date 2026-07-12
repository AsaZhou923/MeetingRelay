import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_LOCK_PATH,
  LockValidationError,
  validateCargoOfflineGate,
  validateLockFile,
  validateLockObject,
} from "./validate-lock.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MATERIALIZER_PATH = path.join(HERE, "materialize.ps1");

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
  assert.match(
    materializer,
    /& \$curl\.Source `\r?\n\s+--disable `\r?\n\s+--proto '=https'/,
    "--disable must be the first curl argument so curlrc files cannot weaken the transfer policy",
  );
  for (const required of [
    "Get-Command curl.exe",
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
