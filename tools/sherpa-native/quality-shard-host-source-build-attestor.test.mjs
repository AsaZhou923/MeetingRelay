import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { encodeCanonicalJsonLine } from "../phase0-harness/canonical-json.mjs";
import {
  QualityShardHostSourceBuildAttestorError,
  __attestQualityShardHostSourceBuildForTest,
  __runQualityShardHostSourceBuildAttestorCliForTest,
  __verifyQualityShardHostSourceBuildAttestationLiveForTest,
  readPinnedQualityShardHostSourceBuildAttestation,
  runQualityShardHostSourceBuildAttestorCli,
  validateQualityShardHostSourceBuildAttestationBytes,
  verifyQualityShardHostSourceBuildAttestationLive,
} from "./quality-shard-host-source-build-attestor.mjs";

const SOURCE_COMMIT = "a".repeat(40);
const EXECUTABLE_SHA256 = "b".repeat(64);
const QUALITY_SHARD_HOST = "meetingrelay-sherpa-candidate-quality-shard-host";
const QUALITY_SHARD_HOST_EXE = `${QUALITY_SHARD_HOST}.exe`;
const SHARD_BUILD_TARGET_LEAF = "shard-host-builds";
const SHARD_FEATURES = Object.freeze(["native-quality-sample", "native-quality-shard", "native-sherpa"]);
const TARGET = "x86_64-pc-windows-msvc";
const CARGO_ARGS = Object.freeze([
  "build",
  "--release",
  "-p",
  "meetingrelay-model-worker-sherpa-native",
  "--no-default-features",
  "--features",
  "native-quality-shard",
  "--bin",
  QUALITY_SHARD_HOST,
  "--message-format=json",
  "--offline",
  "--locked",
]);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function stageBytes(entries) {
  return Buffer.concat(entries.map((entry, index) => Buffer.from(
    `${entry.mode ?? "100644"} ${entry.objectId ?? String(index + 1).padStart(40, "0")} ${entry.stage ?? 0}\t${entry.path}\0`,
    "utf8",
  )));
}

function peFixture({
  dllCharacteristics = 0x4160,
  imports = ["sherpa-onnx-c-api.dll", "KERNEL32.dll"],
} = {}) {
  const bytes = Buffer.alloc(2048);
  bytes.write("MZ", 0, "ascii");
  bytes.writeUInt32LE(0x80, 0x3c);
  bytes.write("PE\0\0", 0x80, "ascii");
  bytes.writeUInt16LE(0x8664, 0x84);
  bytes.writeUInt16LE(1, 0x86);
  bytes.writeUInt16LE(0xf0, 0x94);
  bytes.writeUInt16LE(0x0022, 0x96);
  bytes.writeUInt16LE(0x20b, 0x98);
  bytes.writeUInt16LE(3, 0x98 + 68);
  bytes.writeUInt16LE(dllCharacteristics, 0x98 + 70);
  bytes.writeUInt32LE(0x200, 0x98 + 60);
  bytes.writeUInt32LE(0x1000, 0x98 + 120);
  bytes.writeUInt32LE((imports.length + 1) * 20, 0x98 + 124);
  const section = 0x98 + 0xf0;
  bytes.write(".rdata\0\0", section, "ascii");
  bytes.writeUInt32LE(0x500, section + 8);
  bytes.writeUInt32LE(0x1000, section + 12);
  bytes.writeUInt32LE(0x600, section + 16);
  bytes.writeUInt32LE(0x200, section + 20);
  imports.forEach((name, index) => {
    const descriptor = 0x200 + index * 20;
    const nameOffset = 0x300 + index * 64;
    const nameRva = 0x1000 + (nameOffset - 0x200);
    bytes.writeUInt32LE(0x1400 + index * 16, descriptor);
    bytes.writeUInt32LE(nameRva, descriptor + 12);
    bytes.writeUInt32LE(0x1500 + index * 16, descriptor + 16);
    bytes.write(`${name}\0`, nameOffset, "ascii");
  });
  return bytes;
}

function runtimeFixture() {
  return [
    ["onnxruntime.dll", Buffer.from("onnxruntime")],
    ["onnxruntime.lib", Buffer.from("onnxruntime-lib")],
    ["onnxruntime_providers_shared.dll", Buffer.from("providers")],
    ["sherpa-onnx-c-api.dll", Buffer.from("c-api")],
    ["sherpa-onnx-c-api.lib", Buffer.from("c-api-lib")],
    ["sherpa-onnx-cxx-api.dll", Buffer.from("cxx-api")],
    ["sherpa-onnx-cxx-api.lib", Buffer.from("cxx-api-lib")],
  ];
}

function cargoArtifact(executablePath, overrides = {}) {
  const record = {
    executable: executablePath,
    features: SHARD_FEATURES,
    filenames: [executablePath],
    fresh: false,
    package_id: "path+file:///C:/repo/crates/model-worker-sherpa-native#meetingrelay-model-worker-sherpa-native@0.1.0",
    profile: {
      debug_assertions: false,
      debuginfo: 0,
      opt_level: "3",
      overflow_checks: false,
      test: false,
    },
    reason: "compiler-artifact",
    target: {
      crate_types: ["bin"],
      doc: true,
      doctest: false,
      edition: "2021",
      kind: ["bin"],
      name: QUALITY_SHARD_HOST,
      src_path: "C:\\repo\\crates\\model-worker-sherpa-native\\src\\bin\\meetingrelay_sherpa_candidate_quality_shard_host.rs",
      test: false,
    },
  };
  return {
    ...record,
    ...overrides,
    profile: { ...record.profile, ...overrides.profile },
    target: { ...record.target, ...overrides.target },
  };
}

function pathKey(value) {
  return path.win32.normalize(value).toLowerCase();
}

function executableName(value) {
  return path.win32.basename(value).toLowerCase();
}

function fixture() {
  const repoRoot = "C:\\repo";
  const buildTargetRoot = path.win32.join(
    repoRoot,
    "target",
    "sherpa-native",
    "formal-run-trust",
    SHARD_BUILD_TARGET_LEAF,
    SOURCE_COMMIT,
  );
  const releaseDir = path.win32.join(buildTargetRoot, "release");
  const executablePath = path.win32.join(releaseDir, QUALITY_SHARD_HOST_EXE);
  const runtimeDir = path.win32.join(repoRoot, "target", "sherpa-native", "extracted", "sealed-runtime", "lib");
  const assetLockPath = path.win32.join(repoRoot, "tools", "sherpa-native", "assets.lock.json");
  const outputPath = path.win32.join(
    repoRoot,
    "target",
    "sherpa-native",
    "formal-run-trust",
    "build-attestations",
    "quality-shard-host-build-attestation.json",
  );
  const inputPath = "C:\\evidence\\shard-attestor-input.json";
  const toolPaths = Object.freeze({
    cargo: "C:\\tools\\rust\\cargo.exe",
    git: "C:\\tools\\git\\git.exe",
    rustc: "C:\\tools\\rust\\rustc.exe",
    where: "C:\\Windows\\System32\\where.exe",
  });
  const runtime = runtimeFixture();
  const inventory = runtime
    .map(([name, bytes]) => ({ path: `lib/${name}`, sha256: sha256(bytes), size_bytes: bytes.length }))
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const lock = {
    runtime: {
      archive: {
        bundle_sha256: sha256(Buffer.from(JSON.stringify(inventory), "utf8")),
        extracted_directory: "sealed-runtime",
        inventory,
      },
    },
  };
  const tracked = new Map([
    [".cargo/config.toml", Buffer.from("[env]\nSHERPA_ONNX_LIB_DIR = { value = \"target/sherpa-native/extracted/sealed-runtime/lib\", relative = true }\n")],
    [".gitignore", Buffer.from("target/\n")],
    ["Cargo.lock", Buffer.from("cargo-lock\n")],
    ["crates/model-worker-sherpa-native/src/lib.rs", Buffer.from("pub fn sealed() {}\n")],
    ["rust-toolchain.toml", Buffer.from("[toolchain]\nchannel = \"1.95.0\"\n")],
    ["tools/sherpa-native/assets.lock.json", Buffer.from(JSON.stringify(lock), "utf8")],
  ]);
  const files = new Map();
  for (const [relativePath, bytes] of tracked) {
    files.set(pathKey(path.win32.join(repoRoot, ...relativePath.split("/"))), bytes);
  }
  files.set(pathKey(executablePath), peFixture());
  for (const [name, bytes] of runtime) {
    files.set(pathKey(path.win32.join(runtimeDir, name)), bytes);
    if (name.endsWith(".dll")) files.set(pathKey(path.win32.join(releaseDir, name)), bytes);
  }
  for (const [name, toolPath] of Object.entries(toolPaths)) {
    if (name !== "where") files.set(pathKey(toolPath), Buffer.from(`${name}-executable`));
  }
  files.set(pathKey(toolPaths.where), Buffer.from("where-executable"));

  const state = {
    buildTargetBindCalls: [],
    buildTargetExists: false,
    buildTargetVerifyCalls: 0,
    cargoStdout: `${JSON.stringify(cargoArtifact(executablePath))}\n`,
    commands: [],
    files,
    gitHead: SOURCE_COMMIT,
    inputPath,
    lsFilesCalls: 0,
    optionalDirectories: new Map([[pathKey(path.win32.join(repoRoot, ".cargo")), [{ kind: "file", name: "config.toml" }]]]),
    outputEntries: [],
    postflightBytes: undefined,
    published: new Map(),
    publishError: undefined,
    releaseEntries: [
      { kind: "file", name: QUALITY_SHARD_HOST_EXE },
      ...runtime.filter(([name]) => name.endsWith(".dll")).map(([name]) => ({ kind: "file", name })),
    ],
    runtimeEntries: runtime.map(([name]) => ({ kind: "file", name })),
    stageAfter: undefined,
    stageBefore: stageBytes([...tracked.keys()].sort().map((trackedPath) => ({ path: trackedPath }))),
    statusAfter: Buffer.alloc(0),
    statusAfterPublish: Buffer.alloc(0),
    statusBefore: Buffer.alloc(0),
    statusCalls: 0,
    stdout: "",
    toolPaths,
    trackedMutationAfterBuild: undefined,
  };
  const ops = {
    bindBuildTarget: async (request) => {
      state.buildTargetBindCalls.push({ ...request });
      if (pathKey(request.buildTargetRoot) !== pathKey(buildTargetRoot)) {
        throw Object.assign(new Error("unexpected build target"), { code: "EINVAL" });
      }
      if (request.requireAbsent) {
        if (state.buildTargetExists) throw Object.assign(new Error("exists"), { code: "EEXIST" });
        state.buildTargetExists = true;
      } else if (!state.buildTargetExists) {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      }
      return Object.freeze({ token: "binding" });
    },
    cwd: repoRoot,
    environment: {
      Path: "C:\\tools\\git;C:\\tools\\rust;C:\\Windows\\System32",
      SystemRoot: "C:\\Windows",
      TEMP: "C:\\Temp",
      TMP: "C:\\Temp",
      USERPROFILE: "C:\\Users\\builder",
    },
    listDirectory: async (directory) => {
      if (pathKey(directory) === pathKey(runtimeDir)) return state.runtimeEntries;
      if (pathKey(directory) === pathKey(releaseDir)) return state.releaseEntries;
      if (pathKey(directory) === pathKey(path.win32.dirname(outputPath))) return state.outputEntries;
      throw Object.assign(new Error("unexpected directory"), { code: "ENOENT" });
    },
    listDirectoryIfExists: async (directory) => state.optionalDirectories.get(pathKey(directory)) ?? null,
    platform: "win32",
    publishCreateNew: async (target, bytes) => {
      if (state.publishError !== undefined) throw state.publishError;
      const key = pathKey(target);
      if (state.published.has(key)) throw Object.assign(new Error("exists"), { code: "EEXIST" });
      state.published.set(key, Buffer.from(bytes));
    },
    readStableFile: async (filePath) => {
      const key = pathKey(filePath);
      if (key === pathKey(outputPath) && state.postflightBytes !== undefined) return Buffer.from(state.postflightBytes);
      if (state.published.has(key)) return Buffer.from(state.published.get(key));
      if (key === pathKey(inputPath)) return Buffer.from(encodeCanonicalJsonLine({
        assetLockPath,
        expectedSourceCommit: SOURCE_COMMIT,
        outputPath,
        runtimeDir,
      }), "utf8");
      const relative = path.win32.relative(repoRoot, filePath).split(path.win32.sep).join("/");
      if (
        state.trackedMutationAfterBuild?.path === relative &&
        state.commands.some(({ executable, args }) => executableName(executable) === "cargo.exe" && args[0] === "build")
      ) {
        return Buffer.from(state.trackedMutationAfterBuild.bytes);
      }
      const bytes = state.files.get(key);
      if (bytes === undefined) throw Object.assign(new Error(`missing ${filePath}`), { code: "ENOENT" });
      return Buffer.from(bytes);
    },
    readStableFileIdentity: async (filePath) => {
      const bytes = await ops.readStableFile(filePath);
      return { bytes, identity: `identity:${pathKey(filePath)}` };
    },
    runCommand: async (executable, args, options) => {
      state.commands.push({ args: [...args], executable, options });
      const name = executableName(executable);
      if (name === "where.exe") {
        const requested = args[0]?.replace(/\.exe$/iu, "").toLowerCase();
        const resolved = state.toolPaths[requested];
        return resolved === undefined
          ? { exitCode: 1, stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) }
          : { exitCode: 0, stderr: Buffer.alloc(0), stdout: Buffer.from(`${resolved}\r\n`) };
      }
      if (name === "git.exe" && args.join(" ") === "rev-parse --show-toplevel") {
        return { exitCode: 0, stderr: Buffer.alloc(0), stdout: Buffer.from(`${repoRoot}\n`) };
      }
      if (name === "git.exe" && args.join(" ") === "rev-parse --verify HEAD") {
        return { exitCode: 0, stderr: Buffer.alloc(0), stdout: Buffer.from(`${state.gitHead}\n`) };
      }
      if (name === "git.exe" && args[0] === "status") {
        const stdout = [state.statusBefore, state.statusAfter, state.statusAfterPublish][state.statusCalls++] ?? state.statusAfterPublish;
        return { exitCode: 0, stderr: Buffer.alloc(0), stdout: Buffer.from(stdout) };
      }
      if (name === "git.exe" && args.join(" ") === "ls-files --stage -z") {
        return {
          exitCode: 0,
          stderr: Buffer.alloc(0),
          stdout: Buffer.from(state.lsFilesCalls++ === 0 ? state.stageBefore : (state.stageAfter ?? state.stageBefore)),
        };
      }
      if (name === "git.exe" && args[0] === "check-ignore") return { exitCode: 0, stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) };
      if (name === "rustc.exe" && args.join(" ") === "-vV") {
        return {
          exitCode: 0,
          stderr: Buffer.alloc(0),
          stdout: Buffer.from("rustc 1.95.0 (000000000 2026-01-01)\nbinary: rustc\ncommit-hash: 0000000000000000000000000000000000000000\ncommit-date: 2026-01-01\nhost: x86_64-pc-windows-msvc\nrelease: 1.95.0\nLLVM version: 20.1.0\n"),
        };
      }
      if (name === "cargo.exe" && args.join(" ") === "-V") {
        return { exitCode: 0, stderr: Buffer.alloc(0), stdout: Buffer.from("cargo 1.95.0 (000000000 2026-01-01)\n") };
      }
      if (name === "cargo.exe") return { exitCode: 0, stderr: Buffer.alloc(0), stdout: Buffer.from(state.cargoStdout) };
      throw new Error(`unexpected command: ${executable} ${args.join(" ")}`);
    },
    stdout: {
      write(value) {
        state.stdout += value;
      },
    },
    verifyBuildTargetBinding: async () => {
      state.buildTargetVerifyCalls += 1;
      return true;
    },
  };
  return { executablePath, input: { assetLockPath, expectedSourceCommit: SOURCE_COMMIT, outputPath, runtimeDir }, inputPath, lock, ops, outputPath, runtimeDir, state };
}

function attestation(overrides = {}) {
  return {
    authority: {
      execution_status: "not-run",
      formal_claims: "none",
      materialization_status: "not-run",
      production_evidence: false,
      public_distribution: false,
      quality_gate_status: "not-assessed",
    },
    cargo: {
      features: SHARD_FEATURES,
      lock_sha256: "c".repeat(64),
      profile: "release",
    },
    executable: {
      filename: process.platform === "win32"
        ? "meetingrelay-sherpa-candidate-quality-shard-host.exe"
        : "meetingrelay-sherpa-candidate-quality-shard-host",
      imports: ["kernel32.dll", "sherpa-onnx-c-api.dll"],
      pe_format: "PE32+",
      pe_machine: "amd64",
      pe_subsystem: "console",
      required_dll_characteristics: [
        "DYNAMIC_BASE", "GUARD_CF", "HIGH_ENTROPY_VA", "NX_COMPAT",
      ],
      runtime_bundle_sha256: "d".repeat(64),
      sha256: EXECUTABLE_SHA256,
      size_bytes: 12345,
    },
    kind: "meetingrelay-quality-shard-host-source-build-attestation-v1",
    schema_version: "1.0",
    source: {
      commit: SOURCE_COMMIT,
      tree_sha256: "e".repeat(64),
      worktree_status: "clean",
    },
    toolchain: {
      cargo_executable_sha256: "1".repeat(64),
      cargo_v_sha256: "2".repeat(64),
      git_executable_sha256: "3".repeat(64),
      rustc_executable_sha256: "4".repeat(64),
      rustc_vv_sha256: "5".repeat(64),
      target: "x86_64-pc-windows-msvc",
    },
    ...overrides,
  };
}

async function expectCode(operation, code) {
  await assert.rejects(operation, (error) =>
    error instanceof QualityShardHostSourceBuildAttestorError && error.code === code);
}

test("shard-host attestor exports production attest CLI and live verification surfaces", () => {
  assert.equal(typeof __attestQualityShardHostSourceBuildForTest, "function");
  assert.equal(typeof __runQualityShardHostSourceBuildAttestorCliForTest, "function");
  assert.equal(typeof __verifyQualityShardHostSourceBuildAttestationLiveForTest, "function");
  assert.equal(typeof runQualityShardHostSourceBuildAttestorCli, "function");
  assert.equal(typeof verifyQualityShardHostSourceBuildAttestationLive, "function");
});

test("attest path performs a clean-source isolated offline Release shard-host build", async () => {
  const fx = fixture();
  const result = await __attestQualityShardHostSourceBuildForTest(fx.input, fx.ops);
  assert.equal(result.record.kind, "meetingrelay-quality-shard-host-source-build-attestation-v1");
  assert.deepEqual(result.record.authority, {
    execution_status: "not-run",
    formal_claims: "none",
    materialization_status: "not-run",
    production_evidence: false,
    public_distribution: false,
    quality_gate_status: "not-assessed",
  });
  assert.deepEqual(result.record.cargo.features, SHARD_FEATURES);
  assert.equal(result.record.executable.filename, QUALITY_SHARD_HOST_EXE);
  assert.deepEqual(result.record.executable.required_dll_characteristics, [
    "DYNAMIC_BASE", "GUARD_CF", "HIGH_ENTROPY_VA", "NX_COMPAT",
  ]);
  assert.deepEqual(result.record.executable.imports, ["kernel32.dll", "sherpa-onnx-c-api.dll"]);
  assert.equal(result.record.executable.runtime_bundle_sha256, fx.lock.runtime.archive.bundle_sha256);
  assert.equal(result.record.toolchain.target, TARGET);
  assert.equal(result.bytes.toString("utf8"), encodeCanonicalJsonLine(result.record));
  assert.ok(fx.state.published.get(pathKey(fx.outputPath)).equals(result.bytes));
  assert.deepEqual(
    fx.state.commands.find(({ executable, args }) => executableName(executable) === "cargo.exe" && args[0] === "build")?.args,
    CARGO_ARGS,
  );
  const buildEnvironment = fx.state.commands.find(
    ({ executable, args }) => executableName(executable) === "cargo.exe" && args[0] === "build",
  )?.options.env;
  assert.equal(buildEnvironment.CARGO_NET_OFFLINE, "true");
  assert.equal(buildEnvironment.CARGO_TARGET_DIR.endsWith(`${SHARD_BUILD_TARGET_LEAF}\\${SOURCE_COMMIT}`), true);
  assert.equal(buildEnvironment.SHERPA_ONNX_LIB_DIR, fx.runtimeDir);
  assert.equal(fx.state.buildTargetBindCalls[0].requireAbsent, true);
  assert.equal(fx.state.commands.some(({ executable }) => pathKey(executable) === pathKey(fx.executablePath)), false);
});

test("attest path rejects dirty source, ambient overrides, preexisting target, build failure, wrong artifact, and publish replacement", async (t) => {
  await t.test("dirty source before build", async () => {
    const fx = fixture();
    fx.state.statusBefore = Buffer.from("?? local.txt\0");
    await expectCode(() => __attestQualityShardHostSourceBuildForTest(fx.input, fx.ops), "QUALITY_SHARD_HOST_ATTESTOR_SOURCE_DIRTY");
    assert.equal(fx.state.commands.some(({ executable, args }) => executableName(executable) === "cargo.exe" && args[0] === "build"), false);
  });
  await t.test("ambient compiler override before build", async () => {
    const fx = fixture();
    fx.ops.environment.RUSTFLAGS = "-Ctarget-cpu=native";
    await expectCode(() => __attestQualityShardHostSourceBuildForTest(fx.input, fx.ops), "QUALITY_SHARD_HOST_ATTESTOR_ENVIRONMENT");
    assert.equal(fx.state.commands.some(({ executable, args }) => executableName(executable) === "cargo.exe" && args[0] === "build"), false);
  });
  await t.test("preexisting commit target", async () => {
    const fx = fixture();
    fx.state.buildTargetExists = true;
    await expectCode(() => __attestQualityShardHostSourceBuildForTest(fx.input, fx.ops), "QUALITY_SHARD_HOST_ATTESTOR_BUILD_TARGET_EXISTS");
  });
  await t.test("cargo build failure", async () => {
    const fx = fixture();
    const original = fx.ops.runCommand;
    fx.ops.runCommand = async (executable, args, options) => {
      if (executableName(executable) === "cargo.exe" && args[0] === "build") {
        return { exitCode: 101, stderr: Buffer.from("compile failed"), stdout: Buffer.alloc(0) };
      }
      return original(executable, args, options);
    };
    await expectCode(() => __attestQualityShardHostSourceBuildForTest(fx.input, fx.ops), "QUALITY_SHARD_HOST_ATTESTOR_BUILD");
  });
  await t.test("missing transitive sample feature", async () => {
    const fx = fixture();
    fx.state.cargoStdout = `${JSON.stringify(cargoArtifact(fx.executablePath, {
      features: ["native-quality-shard", "native-sherpa"],
    }))}\n`;
    await expectCode(() => __attestQualityShardHostSourceBuildForTest(fx.input, fx.ops), "QUALITY_SHARD_HOST_ATTESTOR_ARTIFACT");
  });
  await t.test("publication competitor is preserved", async () => {
    const fx = fixture();
    fx.state.publishError = Object.assign(new Error("exists"), { code: "EEXIST" });
    await expectCode(() => __attestQualityShardHostSourceBuildForTest(fx.input, fx.ops), "QUALITY_SHARD_HOST_ATTESTOR_OUTPUT_EXISTS");
  });
});

test("attest path rejects PE/runtime/source postflight drift", async (t) => {
  await t.test("wrong PE hardening", async () => {
    const fx = fixture();
    fx.state.files.set(pathKey(fx.executablePath), peFixture({ dllCharacteristics: 0x4160 & ~0x4000 }));
    await expectCode(() => __attestQualityShardHostSourceBuildForTest(fx.input, fx.ops), "QUALITY_SHARD_HOST_ATTESTOR_PE_HARDENING");
  });
  await t.test("runtime adjacency drift", async () => {
    const fx = fixture();
    fx.state.releaseEntries = fx.state.releaseEntries.filter(({ name }) => name !== "onnxruntime.dll");
    await expectCode(() => __attestQualityShardHostSourceBuildForTest(fx.input, fx.ops), "QUALITY_SHARD_HOST_ATTESTOR_RUNTIME_ADJACENCY");
  });
  await t.test("tracked source drift after build", async () => {
    const fx = fixture();
    fx.state.trackedMutationAfterBuild = {
      bytes: Buffer.from("pub fn changed() {}\n"),
      path: "crates/model-worker-sherpa-native/src/lib.rs",
    };
    await expectCode(() => __attestQualityShardHostSourceBuildForTest(fx.input, fx.ops), "QUALITY_SHARD_HOST_ATTESTOR_SOURCE_DRIFT");
  });
});

test("CLI attest emits the shard marker and live verifier revalidates without rebuilding", async () => {
  const fx = fixture();
  const result = await __runQualityShardHostSourceBuildAttestorCliForTest(["--attest", fx.inputPath], fx.ops);
  assert.equal(fx.state.stdout,
    `QUALITY_SHARD_HOST_SOURCE_BUILD_ATTESTATION=PASS attestation_sha256=${result.sha256} execution_status=not-run formal_claims=none production_evidence=false\n`);
  const commandCount = fx.state.commands.length;
  const verified = await __verifyQualityShardHostSourceBuildAttestationLiveForTest({
    bytes: result.bytes,
    expectedSourceCommit: SOURCE_COMMIT,
  }, fx.ops);
  assert.equal(verified.sha256, result.sha256);
  const verifierCommands = fx.state.commands.slice(commandCount);
  assert.equal(verifierCommands.some(({ executable, args }) => executableName(executable) === "cargo.exe" && args[0] === "build"), false);
});

test("shard-host attestation binds the separate shard binary and source closure", () => {
  const bytes = Buffer.from(encodeCanonicalJsonLine(attestation()), "utf8");
  const result = validateQualityShardHostSourceBuildAttestationBytes(bytes, {
    expectedExecutableSha256: EXECUTABLE_SHA256,
    expectedSourceCommit: SOURCE_COMMIT,
  });
  assert.equal(result.sha256, sha256(bytes));
  assert.deepEqual(result.record.cargo.features, SHARD_FEATURES);
  assert.equal(result.record.authority.execution_status, "not-run");
});

test("shard-host attestation requires the exact transitive Cargo feature closure", async () => {
  for (const features of [
    ["native-quality-shard", "native-sherpa"],
    ["native-quality-sample", "native-sherpa"],
    [...SHARD_FEATURES, "native-extra"],
  ]) {
    const record = attestation({
      cargo: { ...attestation().cargo, features },
    });
    await expectCode(
      async () => validateQualityShardHostSourceBuildAttestationBytes(
        Buffer.from(encodeCanonicalJsonLine(record), "utf8"),
      ),
      "QUALITY_SHARD_HOST_CARGO",
    );
  }
});

test("pinned attestation reader requires external digest executable and source commit anchors", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "meetingrelay-shard-attest-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const attestationPath = path.join(root, "attestation.json");
  const bytes = Buffer.from(encodeCanonicalJsonLine(attestation()), "utf8");
  await writeFile(attestationPath, bytes, { flag: "wx" });
  const result = await readPinnedQualityShardHostSourceBuildAttestation({
    attestationPath,
    expectedAttestationSha256: sha256(bytes),
    expectedExecutableSha256: EXECUTABLE_SHA256,
    expectedSourceCommit: SOURCE_COMMIT,
  });
  assert.deepEqual(result.bytes, await readFile(attestationPath));

  await expectCode(
    () => readPinnedQualityShardHostSourceBuildAttestation({
      attestationPath,
      expectedAttestationSha256: "f".repeat(64),
      expectedExecutableSha256: EXECUTABLE_SHA256,
      expectedSourceCommit: SOURCE_COMMIT,
    }),
    "QUALITY_SHARD_HOST_ATTESTATION_DIGEST",
  );
});
