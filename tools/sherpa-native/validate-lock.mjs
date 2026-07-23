import { createHash } from "node:crypto";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_LOCK_PATH = path.join(HERE, "assets.lock.json");
const CARGO_OFFLINE_GATE = `[env]\nSHERPA_ONNX_LIB_DIR = { value = "target/sherpa-native/extracted/sherpa-onnx-v1.13.4-win-x64-shared-MT-Release-lib/lib", relative = true }\n\n# sherpa-onnx-sys declares \`links = "sherpa-onnx"\`. This target override\n# prevents its upstream convenience build script (and implicit downloader)\n# from running. The MeetingRelay adapter build script performs the sealed\n# inventory verification, link directives, and DLL staging instead.\n[target.x86_64-pc-windows-msvc.sherpa-onnx]\nrustc-link-lib = []\n`;

const HEX_64 = /^[0-9a-f]{64}$/u;
const SAFE_RELATIVE_PATH = /^(?!\/)(?!.*\\)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._/-]+$/u;

const RUNTIME_INVENTORY = new Map([
  ["lib/onnxruntime.dll", [17_363_968, "daa77083a45bf525da0dde9e87f85d8eb146f58f9c9aa7124ca84545e1c0f148"]],
  ["lib/onnxruntime.lib", [2_124, "b9fc3cd678257d88a111b0773ede4bfceaf0fe95daab4379f2b2b37348a68781"]],
  ["lib/onnxruntime_providers_shared.dll", [104_960, "190d10767c321f324d3785368a0b752d9c5a9e06cb5d4d97bb176f58bdb652f3"]],
  ["lib/sherpa-onnx-c-api.dll", [4_544_512, "3db688ca9e6408c958f45986adc68ed9158522e28c7567b7ffee9312a553c777"]],
  ["lib/sherpa-onnx-c-api.lib", [75_298, "21513d9d053ea39956081f5d421d610cd512b076032bf550b9907d2c7b6a52fb"]],
  ["lib/sherpa-onnx-cxx-api.dll", [258_048, "3e8b308e9235a3e7398b2c89b43ebb7f813f216aade661b2f246d42656517777"]],
  ["lib/sherpa-onnx-cxx-api.lib", [224_022, "9b754db267f88e928f77b39afcc9875985e7d51063d0839162e01fb681dd9faf"]],
]);

const MODEL_INVENTORY = new Map([
  ["LICENSE", [71, "221c6df10b0931a5629adad671ea48fb7747e034c414b6d2bfa275bc3dd4ea17"]],
  ["README.md", [104, "763991a00edaea534ab36bf1b7cf89e61e911666dcfabbba71f91f9f7c593a63"]],
  ["export-onnx.py", [5_905, "c97f6a33f9d7135efd4d55b3e24e288c47d925f3b4f04b8b3418c2821c0a89ce"]],
  ["model.int8.onnx", [239_233_841, "c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51"]],
  ["test_wavs/en.wav", [228_908, "eb1eb008904465b74c304aad8342e8c7d3c6e61ffe9f66adcaca9cf0f76a93f4"]],
  ["test_wavs/ja.wav", [230_444, "460bd8dccb0d2a5f4e29c628f837be4082d13defc64c3fc21dd1b6bb0e119095"]],
  ["test_wavs/ko.wav", [147_500, "0dc797a5c81ed30fc339d91f3da718ab02854e17ffa37cb93c4c039ac5c6bb9c"]],
  ["test_wavs/yue.wav", [164_780, "0960b2db54ae202071d250e6462fbf74a3c863f0e3e7f01273e4939c996875a0"]],
  ["test_wavs/zh.wav", [178_988, "b77f1794fe374a0ba1ee1dc458bfaf9349496cbbfc32780c50ba3c5a7ad8e373"]],
  ["tokens.txt", [315_894, "f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc"]],
]);

const SNAPSHOTS = new Map([
  ["licenses/apache-2.0-sherpa-onnx.txt", [11_358, "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30"]],
  ["licenses/sensevoice-embedded-license-pointer.txt", [71, "221c6df10b0931a5629adad671ea48fb7747e034c414b6d2bfa275bc3dd4ea17"]],
  ["licenses/funasr-model-license-1.0.txt", [4_085, "80f5bff3bc3f1b4ba7128e07a7bf94ac10ca260b64059dfdc66e83202bcae50e"]],
  ["licenses/funasr-model-license-1.1.txt", [5_306, "7dba975a2069691db4992b0592d70828b330d2f8a30a71450f4e152a554e84f8"]],
  ["licenses/mit-onnxruntime-1.27.0.txt", [1_073, "2f07c72751aed99790b8a4869cf2311df85a860b22ded05fa22803587a48922c"]],
]);

export class LockValidationError extends Error {
  constructor(code, message, field) {
    super(`${code}: ${message} (${field})`);
    this.name = "LockValidationError";
    this.code = code;
    this.field = field;
  }
}

function fail(code, message, field) {
  throw new LockValidationError(code, message, field);
}

function object(value, field) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("LOCK_SCHEMA", "expected an object", field);
  }
  return value;
}

function exactKeys(value, expected, field) {
  object(value, field);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail("LOCK_UNKNOWN_FIELD", `expected keys ${wanted.join(",")}, got ${actual.join(",")}`, field);
  }
}

function exact(value, expected, field) {
  if (value !== expected) {
    fail("LOCK_PIN_MISMATCH", `expected ${JSON.stringify(expected)}`, field);
  }
}

function digest(value, field) {
  if (typeof value !== "string" || !HEX_64.test(value)) {
    fail("LOCK_DIGEST", "expected lowercase SHA-256", field);
  }
}

function positiveSafeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail("LOCK_SIZE", "expected a positive safe integer", field);
  }
}

function relativePath(value, field) {
  if (typeof value !== "string" || !SAFE_RELATIVE_PATH.test(value) || path.posix.isAbsolute(value)) {
    fail("LOCK_PATH", "expected a safe POSIX relative path", field);
  }
}

function validateInventory(actual, expected, field) {
  if (!Array.isArray(actual) || actual.length !== expected.size) {
    fail("LOCK_INVENTORY", `expected ${expected.size} entries`, field);
  }
  const seen = new Set();
  let prior = "";
  for (const [index, entry] of actual.entries()) {
    const label = `${field}[${index}]`;
    exactKeys(entry, ["path", "sha256", "size_bytes"], label);
    relativePath(entry.path, `${label}.path`);
    positiveSafeInteger(entry.size_bytes, `${label}.size_bytes`);
    digest(entry.sha256, `${label}.sha256`);
    if (seen.has(entry.path)) {
      fail("LOCK_DUPLICATE", "duplicate inventory path", `${label}.path`);
    }
    if (entry.path <= prior) {
      fail("LOCK_ORDER", "inventory must be strictly path-sorted", `${label}.path`);
    }
    seen.add(entry.path);
    prior = entry.path;
    const pin = expected.get(entry.path);
    if (pin === undefined || entry.size_bytes !== pin[0] || entry.sha256 !== pin[1]) {
      fail("LOCK_INVENTORY_PIN", "inventory entry differs from verified extraction", label);
    }
  }
}

function validateArchive(archive, pins, inventory, field, bundleSha256 = null) {
  const keys = ["extracted_directory", "inventory", "name", "sha256", "size_bytes", "url"];
  if (bundleSha256 !== null) keys.push("bundle_sha256");
  exactKeys(archive, keys, field);
  for (const key of ["name", "url", "size_bytes", "sha256", "extracted_directory"]) {
    exact(archive[key], pins[key], `${field}.${key}`);
  }
  digest(archive.sha256, `${field}.sha256`);
  positiveSafeInteger(archive.size_bytes, `${field}.size_bytes`);
  relativePath(archive.extracted_directory, `${field}.extracted_directory`);
  validateInventory(archive.inventory, inventory, `${field}.inventory`);
  if (bundleSha256 !== null) {
    exact(archive.bundle_sha256, bundleSha256, `${field}.bundle_sha256`);
    exact(
      sha256(Buffer.from(JSON.stringify(archive.inventory), "utf8")),
      bundleSha256,
      `${field}.inventory`,
    );
  }
}

function validateSnapshot(record, expectedKeys, pins, field) {
  exactKeys(record, expectedKeys, field);
  relativePath(record.snapshot_path, `${field}.snapshot_path`);
  const expected = SNAPSHOTS.get(record.snapshot_path);
  if (expected === undefined || record.size_bytes !== expected[0] || record.sha256 !== expected[1]) {
    fail("LOCK_LICENSE_PIN", "license snapshot identity differs", field);
  }
  for (const [key, value] of Object.entries(pins)) {
    exact(record[key], value, `${field}.${key}`);
  }
}

export function validateLockObject(lock) {
  exactKeys(lock, ["entrypoints", "lock_id", "model", "parameters", "runtime", "schema_version", "scope"], "lock");
  exact(lock.schema_version, "1.0", "lock.schema_version");
  exact(lock.lock_id, "sherpa-onnx-1.13.4-sensevoice-int8-2024-07-17-win-x64-cpu", "lock.lock_id");

  exactKeys(lock.scope, ["distribution_status", "evaluation", "license_review_status", "network_policy", "performance_claim", "quality_claim"], "lock.scope");
  const scopePins = {
    evaluation: "internal-phase0-only",
    network_policy: "offline-by-default-download-opt-in",
    quality_claim: "not-authorized",
    performance_claim: "not-authorized",
    license_review_status: "accepted-for-internal-evaluation",
    distribution_status: "pending",
  };
  for (const [key, value] of Object.entries(scopePins)) exact(lock.scope[key], value, `lock.scope.${key}`);

  exactKeys(lock.runtime, ["archive", "hash_crate", "license", "onnxruntime_file_version", "onnxruntime_license", "rust_crate", "rust_sys_crate", "upstream_commit", "upstream_repository", "upstream_tag"], "lock.runtime");
  exact(lock.runtime.upstream_repository, "https://github.com/k2-fsa/sherpa-onnx", "lock.runtime.upstream_repository");
  exact(lock.runtime.upstream_tag, "v1.13.4", "lock.runtime.upstream_tag");
  exact(lock.runtime.upstream_commit, "142807252687d81b40d6315f23470a1512a00de3", "lock.runtime.upstream_commit");
  exact(lock.runtime.onnxruntime_file_version, "1.27.0", "lock.runtime.onnxruntime_file_version");
  exactKeys(lock.runtime.rust_crate, ["checksum", "features", "name", "version"], "lock.runtime.rust_crate");
  exact(lock.runtime.rust_crate.name, "sherpa-onnx", "lock.runtime.rust_crate.name");
  exact(lock.runtime.rust_crate.version, "1.13.4", "lock.runtime.rust_crate.version");
  exact(lock.runtime.rust_crate.checksum, "0b142d3f255cb4e4b7808ea25869db6f5714e0a3550da355234483b4db552055", "lock.runtime.rust_crate.checksum");
  if (!Array.isArray(lock.runtime.rust_crate.features) || lock.runtime.rust_crate.features.length !== 1 || lock.runtime.rust_crate.features[0] !== "shared") {
    fail("LOCK_PIN_MISMATCH", "only the shared feature is allowed", "lock.runtime.rust_crate.features");
  }
  exactKeys(lock.runtime.rust_sys_crate, ["checksum", "name", "version"], "lock.runtime.rust_sys_crate");
  exact(lock.runtime.rust_sys_crate.name, "sherpa-onnx-sys", "lock.runtime.rust_sys_crate.name");
  exact(lock.runtime.rust_sys_crate.version, "1.13.4", "lock.runtime.rust_sys_crate.version");
  exact(lock.runtime.rust_sys_crate.checksum, "ffc951af03dc0653c0622158ca8a585a6f2bc43b7b06048cf0e5b5020005c227", "lock.runtime.rust_sys_crate.checksum");
  exactKeys(lock.runtime.hash_crate, ["checksum", "license", "name", "version"], "lock.runtime.hash_crate");
  exact(lock.runtime.hash_crate.name, "sha2", "lock.runtime.hash_crate.name");
  exact(lock.runtime.hash_crate.version, "0.10.9", "lock.runtime.hash_crate.version");
  exact(lock.runtime.hash_crate.checksum, "a7507d819769d01a365ab707794a4084392c824f54a7a6a7862f8c3d0892b283", "lock.runtime.hash_crate.checksum");
  exact(lock.runtime.hash_crate.license, "MIT OR Apache-2.0", "lock.runtime.hash_crate.license");
  validateArchive(lock.runtime.archive, {
    name: "sherpa-onnx-v1.13.4-win-x64-shared-MT-Release-lib.tar.bz2",
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.4/sherpa-onnx-v1.13.4-win-x64-shared-MT-Release-lib.tar.bz2",
    size_bytes: 7_849_655,
    sha256: "f923e5eacb6bca83914d89cb31afa579e11eeaff9af39f8ead82ad19f44b2c9f",
    extracted_directory: "sherpa-onnx-v1.13.4-win-x64-shared-MT-Release-lib",
  }, RUNTIME_INVENTORY, "lock.runtime.archive", "0682618f660a2a9f2278d99decb77624253aadde60e8199a9b07813b8d843317");
  validateSnapshot(lock.runtime.license, ["distribution_status", "license_id", "review_status", "sha256", "size_bytes", "snapshot_path", "source_revision", "source_url"], {
    license_id: "Apache-2.0",
    source_revision: "142807252687d81b40d6315f23470a1512a00de3",
    source_url: "https://github.com/k2-fsa/sherpa-onnx/blob/142807252687d81b40d6315f23470a1512a00de3/LICENSE",
    review_status: "accepted-for-internal-evaluation",
    distribution_status: "pending",
  }, "lock.runtime.license");
  validateSnapshot(lock.runtime.onnxruntime_license, ["distribution_status", "license_id", "review_status", "sha256", "size_bytes", "snapshot_path", "source_revision", "source_url"], {
    license_id: "MIT",
    source_revision: "8f0278c77bf44b0cc83c098c6c722b92a36ac4b5",
    source_url: "https://github.com/microsoft/onnxruntime/blob/8f0278c77bf44b0cc83c098c6c722b92a36ac4b5/LICENSE",
    review_status: "accepted-for-internal-evaluation",
    distribution_status: "pending",
  }, "lock.runtime.onnxruntime_license");

  exactKeys(lock.model, ["archive", "current_license_snapshot", "embedded_license_pointer", "license_at_model_release", "model_id", "upstream_repository", "upstream_revision"], "lock.model");
  exact(lock.model.model_id, "sensevoice-zh-en-ja-ko-yue-int8-2024-07-17", "lock.model.model_id");
  exact(lock.model.upstream_repository, "https://github.com/FunAudioLLM/SenseVoice", "lock.model.upstream_repository");
  exact(lock.model.upstream_revision, "05ecb6ef037640b57851d8b32403a7ffb81b019c", "lock.model.upstream_revision");
  validateArchive(lock.model.archive, {
    name: "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2",
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2",
    size_bytes: 163_002_883,
    sha256: "7d1efa2138a65b0b488df37f8b89e3d91a60676e416f515b952358d83dfd347e",
    extracted_directory: "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17",
  }, MODEL_INVENTORY, "lock.model.archive");
  validateSnapshot(lock.model.embedded_license_pointer, ["sha256", "size_bytes", "snapshot_path"], {}, "lock.model.embedded_license_pointer");
  validateSnapshot(lock.model.license_at_model_release, ["license_id", "sha256", "size_bytes", "snapshot_path", "source_revision", "source_url"], {
    license_id: "LicenseRef-FunASR-Model-1.0",
    source_revision: "75ddde7acd49cb6940de339cf7de24297f0826c2",
    source_url: "https://github.com/modelscope/FunASR/blob/75ddde7acd49cb6940de339cf7de24297f0826c2/MODEL_LICENSE",
  }, "lock.model.license_at_model_release");
  validateSnapshot(lock.model.current_license_snapshot, ["distribution_status", "license_id", "review_status", "sha256", "size_bytes", "snapshot_path", "source_revision", "source_url"], {
    license_id: "LicenseRef-FunASR-Model-1.1-Internal-Evaluation",
    source_revision: "b1a7283d97b61ddeef25d13f3b56b62a896ee3bb",
    source_url: "https://github.com/modelscope/FunASR/blob/b1a7283d97b61ddeef25d13f3b56b62a896ee3bb/MODEL_LICENSE",
    review_status: "accepted-for-internal-evaluation",
    distribution_status: "pending",
  }, "lock.model.current_license_snapshot");

  exactKeys(lock.parameters, [
    "blank_penalty",
    "bpe_vocab",
    "canonical_json_sha256",
    "channels",
    "debug",
    "decoding_method",
    "feature_dim",
    "homophone_lexicon",
    "homophone_rule_fsts",
    "hotwords_file",
    "hotwords_score",
    "languages",
    "lm_model",
    "lm_scale",
    "max_active_paths",
    "max_input_bytes",
    "model_family",
    "model_type",
    "modeling_unit",
    "num_threads",
    "provider",
    "rule_fars",
    "rule_fsts",
    "sample_rate_hz",
    "telespeech_ctc",
    "use_itn",
  ], "lock.parameters");
  const parameterMaterial = {
    blank_penalty: 0,
    bpe_vocab: null,
    channels: 1,
    debug: false,
    decoding_method: "greedy_search",
    feature_dim: 80,
    homophone_lexicon: null,
    homophone_rule_fsts: null,
    hotwords_file: null,
    hotwords_score: 0,
    languages: ["en", "ja", "zh"],
    lm_model: null,
    lm_scale: 1,
    max_active_paths: 4,
    max_input_bytes: 67_108_864,
    model_family: "sense_voice",
    model_type: null,
    modeling_unit: null,
    num_threads: 1,
    provider: "cpu",
    rule_fars: null,
    rule_fsts: null,
    sample_rate_hz: 16_000,
    telespeech_ctc: null,
    use_itn: true,
  };
  for (const [key, value] of Object.entries(parameterMaterial)) {
    if (key !== "languages") exact(lock.parameters[key], value, `lock.parameters.${key}`);
  }
  if (
    !Array.isArray(lock.parameters.languages) ||
    lock.parameters.languages.length !== parameterMaterial.languages.length ||
    lock.parameters.languages.some(
      (language, index) => language !== parameterMaterial.languages[index],
    )
  ) {
    fail(
      "LOCK_PIN_MISMATCH",
      `expected ${JSON.stringify(parameterMaterial.languages)}`,
      "lock.parameters.languages",
    );
  }
  const parameterHash = createHash("sha256").update(JSON.stringify(parameterMaterial)).digest("hex");
  exact(lock.parameters.canonical_json_sha256, parameterHash, "lock.parameters.canonical_json_sha256");

  exactKeys(lock.entrypoints, ["model_relative_path", "runtime_lib_relative_path", "smoke_wav_relative_path", "tokens_relative_path"], "lock.entrypoints");
  const entrypointPins = {
    runtime_lib_relative_path: "lib",
    model_relative_path: "model.int8.onnx",
    tokens_relative_path: "tokens.txt",
    smoke_wav_relative_path: "test_wavs/zh.wav",
  };
  for (const [key, value] of Object.entries(entrypointPins)) {
    exact(lock.entrypoints[key], value, `lock.entrypoints.${key}`);
    relativePath(lock.entrypoints[key], `lock.entrypoints.${key}`);
  }
  return lock;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseCanonicalLock(bytes, absoluteLock) {
  let lock;
  try {
    lock = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    fail("LOCK_JSON", error instanceof Error ? error.message : "invalid JSON", absoluteLock);
  }
  const canonical = `${JSON.stringify(lock, null, 2)}\n`;
  if (!bytes.equals(Buffer.from(canonical, "utf8"))) {
    fail("LOCK_CANONICAL_JSON", "lock JSON must use canonical two-space formatting and LF", absoluteLock);
  }
  validateLockObject(lock);
  return lock;
}

function pathKey(value) {
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function sameFileSnapshot(left, right) {
  return (
    typeof left?.dev === "bigint" &&
    typeof left?.ino === "bigint" &&
    left.dev > 0n &&
    left.ino > 0n &&
    left.dev === right?.dev &&
    left.ino === right?.ino &&
    left.size === right?.size &&
    left.mtimeNs === right?.mtimeNs &&
    left.ctimeNs === right?.ctimeNs
  );
}

async function assertDirectPathChain(inputPath, missingCode, field) {
  const resolved = path.resolve(inputPath);
  let current = resolved;
  while (true) {
    let metadata;
    let actualMetadata;
    let actual;
    try {
      [metadata, actual] = await Promise.all([
        lstat(current, { bigint: true }),
        realpath(current),
      ]);
      actualMetadata = await lstat(actual, { bigint: true });
    } catch {
      fail(missingCode, "required candidate path is missing", field);
    }
    if (
      metadata.isSymbolicLink() ||
      metadata.dev !== actualMetadata.dev ||
      metadata.ino !== actualMetadata.ino
    ) {
      fail("LOCK_PATH", "candidate path cannot cross a reparse point", field);
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return resolved;
}

async function rereadHandleBytes(handle, expectedLength, field) {
  const bytes = Buffer.allocUnsafe(expectedLength);
  let offset = 0;
  while (offset < expectedLength) {
    const { bytesRead } = await handle.read(bytes, offset, expectedLength - offset, offset);
    if (bytesRead === 0) fail("LOCK_PATH", "candidate file changed while reading", field);
    offset += bytesRead;
  }
  const trailing = Buffer.allocUnsafe(1);
  const { bytesRead } = await handle.read(trailing, 0, 1, expectedLength);
  if (bytesRead !== 0) fail("LOCK_PATH", "candidate file changed while reading", field);
  return bytes;
}

async function readDirectRegularFile(inputPath, missingCode, field) {
  const resolved = await assertDirectPathChain(inputPath, missingCode, field);
  const resolvedBefore = await realpath(resolved).catch(() => {
    fail(missingCode, "required candidate file is missing", field);
  });
  const handle = await open(resolved, "r").catch(() => {
    fail(missingCode, "required candidate file cannot be opened", field);
  });
  let failure;
  try {
    const [beforePath, beforeHandle] = await Promise.all([
      lstat(resolved, { bigint: true }),
      handle.stat({ bigint: true }),
    ]);
    if (
      !beforePath.isFile() ||
      beforePath.isSymbolicLink() ||
      !beforeHandle.isFile() ||
      !sameFileSnapshot(beforePath, beforeHandle)
    ) {
      fail("LOCK_PATH", "candidate input must be one direct regular file", field);
    }
    const bytes = await handle.readFile();
    const [afterPath, afterHandle, resolvedAfter, verificationBytes] = await Promise.all([
      lstat(resolved, { bigint: true }).catch(() => null),
      handle.stat({ bigint: true }),
      realpath(resolved).catch(() => null),
      rereadHandleBytes(handle, bytes.length, field),
    ]);
    await assertDirectPathChain(resolved, missingCode, field);
    if (
      afterPath === null ||
      resolvedAfter === null ||
      !sameFileSnapshot(beforeHandle, afterHandle) ||
      !sameFileSnapshot(beforeHandle, afterPath) ||
      pathKey(resolvedAfter) !== pathKey(resolvedBefore) ||
      BigInt(bytes.length) !== beforeHandle.size ||
      !verificationBytes.equals(bytes)
    ) {
      fail("LOCK_PATH", "candidate file changed while reading", field);
    }
    return bytes;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try {
      await handle.close();
    } catch (error) {
      if (failure === undefined) {
        fail("LOCK_PATH", "candidate file handle did not close cleanly", field);
      }
    }
  }
}

async function validateSnapshotFile(root, record) {
  const relative = record.snapshot_path;
  const target = path.resolve(root, relative);
  const boundary = path.relative(root, target);
  if (boundary.startsWith("..") || path.isAbsolute(boundary)) {
    fail("LOCK_PATH", "license snapshot escapes license root", relative);
  }
  const snapshot = await readDirectRegularFile(target, "LOCK_LICENSE_FILE", relative);
  if (snapshot.length !== record.size_bytes || sha256(snapshot) !== record.sha256) {
    fail("LOCK_LICENSE_FILE", "license snapshot bytes differ", relative);
  }
}

export function validateCargoOfflineGate(contents) {
  if (contents !== CARGO_OFFLINE_GATE) {
    fail(
      "LOCK_CARGO_OFFLINE_GATE",
      "Cargo must bypass the upstream downloader and use the project-verified local library directory",
      ".cargo/config.toml",
    );
  }
}

export async function validateLockFile(lockPath = DEFAULT_LOCK_PATH) {
  const absoluteLock = path.resolve(lockPath);
  const lockDirectory = path.dirname(absoluteLock);
  const bytes = await readFile(absoluteLock);
  const checksumPath = path.join(lockDirectory, "assets.lock.sha256");
  const checksum = await readFile(checksumPath, "utf8");
  const match = /^([0-9a-f]{64})  assets\.lock\.json\n$/u.exec(checksum);
  if (match === null || match[1] !== sha256(bytes)) {
    fail("LOCK_FILE_DIGEST", "lock file differs from its committed digest", checksumPath);
  }
  const lock = parseCanonicalLock(bytes, absoluteLock);
  for (const [relative, [size, expectedHash]] of SNAPSHOTS) {
    const target = path.resolve(lockDirectory, relative);
    if (path.relative(lockDirectory, target).startsWith("..")) {
      fail("LOCK_PATH", "license snapshot escapes lock directory", relative);
    }
    const snapshot = await readFile(target);
    if (snapshot.length !== size || sha256(snapshot) !== expectedHash) {
      fail("LOCK_LICENSE_FILE", "license snapshot bytes differ", relative);
    }
  }
  if (absoluteLock === path.resolve(DEFAULT_LOCK_PATH)) {
    const cargoConfig = await readFile(path.resolve(lockDirectory, "../../.cargo/config.toml"), "utf8");
    validateCargoOfflineGate(cargoConfig);
  }
  return { lock, lockPath: absoluteLock, lockSha256: sha256(bytes) };
}

export async function validateCandidateLockFile(input) {
  exactKeys(input, ["expectedLockSha256", "licenseRoot", "lockPath"], "candidateLock");
  digest(input.expectedLockSha256, "candidateLock.expectedLockSha256");
  if (input.expectedLockSha256 === "0".repeat(64)) {
    fail("LOCK_DIGEST", "expected a nonzero external digest", "candidateLock.expectedLockSha256");
  }
  if (typeof input.licenseRoot !== "string" || input.licenseRoot.length === 0) {
    fail("LOCK_PATH", "expected an explicit license root", "candidateLock.licenseRoot");
  }
  if (typeof input.lockPath !== "string" || input.lockPath.length === 0) {
    fail("LOCK_PATH", "expected an explicit lock path", "candidateLock.lockPath");
  }

  const absoluteLock = path.resolve(input.lockPath);
  const licenseRoot = await assertDirectPathChain(
    input.licenseRoot,
    "LOCK_PATH",
    "candidateLock.licenseRoot",
  );
  const licenseRootStatus = await lstat(licenseRoot);
  if (!licenseRootStatus.isDirectory() || licenseRootStatus.isSymbolicLink()) {
    fail("LOCK_PATH", "license root must be one direct directory", "candidateLock.licenseRoot");
  }
  const bytes = await readDirectRegularFile(
    absoluteLock,
    "LOCK_FILE_DIGEST",
    "candidateLock.lockPath",
  );
  const lockSha256 = sha256(bytes);
  if (lockSha256 !== input.expectedLockSha256) {
    fail("LOCK_FILE_DIGEST", "candidate lock differs from its external digest", absoluteLock);
  }
  const lock = parseCanonicalLock(bytes, absoluteLock);
  for (const record of [
    lock.runtime.license,
    lock.runtime.onnxruntime_license,
    lock.model.current_license_snapshot,
  ]) {
    await validateSnapshotFile(licenseRoot, record);
  }
  return { lock, lockPath: absoluteLock, lockSha256 };
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const requested = process.argv[2] ?? DEFAULT_LOCK_PATH;
  validateLockFile(requested)
    .then(({ lockSha256 }) => {
      process.stdout.write(`sherpa-native-lock=valid sha256=${lockSha256}\n`);
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
