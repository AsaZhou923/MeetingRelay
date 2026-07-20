import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import test from "node:test";

import { encodeCanonicalJsonLine } from "../phase0-harness/canonical-json.mjs";
import {
  QualityHostSourceBuildAttestorError,
  __attestQualityHostSourceBuildForTest,
  __parseGitLsFilesStageZForTest,
  __parsePeIdentityForTest,
  __runQualityHostSourceBuildAttestorCliForTest,
  __verifyQualityHostSourceBuildAttestationLiveForTest,
  attestQualityHostSourceBuild,
  runQualityHostSourceBuildAttestorCli,
  verifyQualityHostSourceBuildAttestationLive,
} from "./quality-host-source-build-attestor.mjs";
import * as shardProfileAttestor from "./quality-host-source-build-attestor.mjs?profile=shard";

const COMMIT = "a".repeat(40);
const QUALITY_HOST = "meetingrelay-sherpa-candidate-quality-host";
const QUALITY_HOST_EXE = `${QUALITY_HOST}.exe`;
const TARGET = "x86_64-pc-windows-msvc";
const CARGO_ARGS = Object.freeze([
  "build",
  "--release",
  "-p",
  "meetingrelay-model-worker-sherpa-native",
  "--no-default-features",
  "--features",
  "native-quality-sample",
  "--bin",
  QUALITY_HOST,
  "--message-format=json",
  "--offline",
  "--locked",
]);
const AUTHORITY = Object.freeze({
  execution_status: "not-run",
  formal_claims: "none",
  materialization_status: "not-run",
  production_evidence: false,
  public_distribution: false,
  quality_gate_status: "not-assessed",
});
const REQUIRED_DLL_CHARACTERISTICS = Object.freeze([
  "DYNAMIC_BASE",
  "GUARD_CF",
  "HIGH_ENTROPY_VA",
  "NX_COMPAT",
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
  importDirectoryRva = 0x1000,
  imports = ["sherpa-onnx-c-api.dll", "KERNEL32.dll"],
  magic = 0x20b,
  machine = 0x8664,
  subsystem = 3,
} = {}) {
  const bytes = Buffer.alloc(2048);
  bytes.write("MZ", 0, "ascii");
  bytes.writeUInt32LE(0x80, 0x3c);
  bytes.write("PE\0\0", 0x80, "ascii");
  bytes.writeUInt16LE(machine, 0x84);
  bytes.writeUInt16LE(1, 0x86);
  bytes.writeUInt16LE(0xf0, 0x94);
  bytes.writeUInt16LE(0x0022, 0x96);
  bytes.writeUInt16LE(magic, 0x98);
  bytes.writeUInt16LE(subsystem, 0x98 + 68);
  bytes.writeUInt16LE(dllCharacteristics, 0x98 + 70);
  bytes.writeUInt32LE(0x200, 0x98 + 60);
  bytes.writeUInt32LE(importDirectoryRva, 0x98 + 120);
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
    features: ["native-quality-sample", "native-sherpa"],
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
      name: QUALITY_HOST,
      src_path: "C:\\repo\\crates\\model-worker-sherpa-native\\src\\bin\\meetingrelay_sherpa_candidate_quality_host.rs",
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
    "quality-host-builds",
    COMMIT,
  );
  const releaseDir = path.win32.join(buildTargetRoot, "release");
  const executablePath = path.win32.join(releaseDir, QUALITY_HOST_EXE);
  const runtimeDir = path.win32.join(
    repoRoot,
    "target",
    "sherpa-native",
    "extracted",
    "sealed-runtime",
    "lib",
  );
  const assetLockPath = path.win32.join(repoRoot, "tools", "sherpa-native", "assets.lock.json");
  const outputPath = path.win32.join(
    repoRoot,
    "target",
    "sherpa-native",
    "formal-run-trust",
    "build-attestations",
    "quality-host-build-attestation.json",
  );
  const inputPath = "C:\\evidence\\attestor-input.json";
  const toolPaths = Object.freeze({
    cargo: "C:\\tools\\rust\\cargo.exe",
    git: "C:\\tools\\git\\git.exe",
    rustc: "C:\\tools\\rust\\rustc.exe",
    where: "C:\\Windows\\System32\\where.exe",
  });
  const runtime = runtimeFixture();
  const inventory = runtime
    .map(([name, bytes]) => ({
      path: `lib/${name}`,
      sha256: sha256(bytes),
      size_bytes: bytes.length,
    }))
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
  files.set(pathKey(toolPaths.where), Buffer.from("where-executable"));
  files.set(pathKey(toolPaths.git), Buffer.from("git-executable"));
  files.set(pathKey(toolPaths.cargo), Buffer.from("cargo-executable"));
  files.set(pathKey(toolPaths.rustc), Buffer.from("rustc-executable"));
  for (const [name, bytes] of runtime) {
    files.set(pathKey(path.win32.join(runtimeDir, name)), bytes);
    if (name.endsWith(".dll")) {
      files.set(pathKey(path.win32.join(releaseDir, name)), bytes);
    }
  }

  const state = {
    buildTargetBindCalls: [],
    buildTargetBindError: undefined,
    buildTargetExists: false,
    buildTargetVerifyCalls: 0,
    buildTargetVerifyError: undefined,
    cargoStdout: `${JSON.stringify(cargoArtifact(executablePath))}\n`,
    commands: [],
    files,
    gitHead: COMMIT,
    inputPath,
    lsFilesCalls: 0,
    outputPath,
    outputEntries: [],
    optionalDirectories: new Map([
      [pathKey(path.win32.join(repoRoot, ".cargo")), [{ kind: "file", name: "config.toml" }]],
    ]),
    postflightBytes: undefined,
    published: new Map(),
    publishError: undefined,
    releaseEntries: [
      { kind: "file", name: QUALITY_HOST_EXE },
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
    trackedMutationAfterBuild: undefined,
    toolPaths,
    closureMutationAfterPublish: undefined,
  };

  const ops = {
    bindBuildTarget: async (request) => {
      state.buildTargetBindCalls.push({ ...request });
      if (state.buildTargetBindError !== undefined) throw state.buildTargetBindError;
      if (pathKey(request.repoRoot) !== pathKey(repoRoot) ||
          pathKey(request.buildTargetRoot) !== pathKey(buildTargetRoot)) {
        throw Object.assign(new Error("unexpected build target"), { code: "EINVAL" });
      }
      if (request.requireAbsent) {
        if (state.buildTargetExists) {
          throw Object.assign(new Error("build target exists"), { code: "EEXIST" });
        }
        state.buildTargetExists = true;
      } else if (!state.buildTargetExists) {
        throw Object.assign(new Error("build target missing"), { code: "ENOENT" });
      }
      return Object.freeze({ token: `binding-${state.buildTargetBindCalls.length}` });
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
    listDirectoryIfExists: async (directory) =>
      state.optionalDirectories.get(pathKey(directory)) ?? null,
    platform: "win32",
    publishCreateNew: async (target, bytes) => {
      if (state.publishError !== undefined) throw state.publishError;
      const key = pathKey(target);
      if (state.published.has(key)) throw Object.assign(new Error("exists"), { code: "EEXIST" });
      state.published.set(key, Buffer.from(bytes));
    },
    readStableFile: async (filePath) => {
      const key = pathKey(filePath);
      if (key === pathKey(outputPath) && state.postflightBytes !== undefined) {
        return Buffer.from(state.postflightBytes);
      }
      if (state.published.has(key)) return Buffer.from(state.published.get(key));
      if (key === pathKey(inputPath)) {
        return Buffer.from(encodeCanonicalJsonLine({
          assetLockPath,
          expectedSourceCommit: COMMIT,
          outputPath,
          runtimeDir,
        }), "utf8");
      }
      const relative = path.win32.relative(repoRoot, filePath).split(path.win32.sep).join("/");
      if (
        state.closureMutationAfterPublish?.pathKey === key &&
        state.published.size > 0 &&
        state.closureMutationAfterPublish.bytes !== undefined
      ) {
        return Buffer.from(state.closureMutationAfterPublish.bytes);
      }
      if (state.trackedMutationAfterBuild?.path === relative && state.commands.some(({ executable, args }) =>
        executableName(executable) === "cargo.exe" && args[0] === "build")) {
        return Buffer.from(state.trackedMutationAfterBuild.bytes);
      }
      const bytes = state.files.get(key);
      if (bytes === undefined) throw Object.assign(new Error(`missing ${filePath}`), { code: "ENOENT" });
      return Buffer.from(bytes);
    },
    readStableFileIdentity: async (filePath) => {
      const bytes = await ops.readStableFile(filePath);
      const key = pathKey(filePath);
      const replacement = state.closureMutationAfterPublish?.pathKey === key && state.published.size > 0;
      return {
        bytes,
        identity: replacement ? `replacement:${key}` : `identity:${key}`,
      };
    },
    runCommand: async (executable, args, options) => {
      state.commands.push({ args: [...args], executable, options });
      const name = executableName(executable);
      if (name === "where.exe") {
        const requested = args[0]?.replace(/\.exe$/iu, "").toLowerCase();
        const resolved = state.toolPaths[requested];
        if (resolved === undefined) {
          return { exitCode: 1, stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) };
        }
        return { exitCode: 0, stderr: Buffer.alloc(0), stdout: Buffer.from(`${resolved}\r\n`) };
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
        const stdout = state.lsFilesCalls++ === 0
          ? state.stageBefore
          : (state.stageAfter ?? state.stageBefore);
        return { exitCode: 0, stderr: Buffer.alloc(0), stdout: Buffer.from(stdout) };
      }
      if (name === "git.exe" && args[0] === "check-ignore") {
        return { exitCode: 0, stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) };
      }
      if (name === "rustc.exe" && args.join(" ") === "-vV") {
        return {
          exitCode: 0,
          stderr: Buffer.alloc(0),
          stdout: Buffer.from(
            "rustc 1.95.0 (000000000 2026-01-01)\n" +
            "binary: rustc\ncommit-hash: 0000000000000000000000000000000000000000\n" +
            "commit-date: 2026-01-01\nhost: x86_64-pc-windows-msvc\n" +
            "release: 1.95.0\nLLVM version: 20.1.0\n",
          ),
        };
      }
      if (name === "cargo.exe" && args.join(" ") === "-V") {
        return {
          exitCode: 0,
          stderr: Buffer.alloc(0),
          stdout: Buffer.from("cargo 1.95.0 (000000000 2026-01-01)\n"),
        };
      }
      if (name === "cargo.exe") {
        return { exitCode: 0, stderr: Buffer.alloc(0), stdout: Buffer.from(state.cargoStdout) };
      }
      throw new Error(`unexpected command: ${executable} ${args.join(" ")}`);
    },
    stdout: {
      write(value) {
        state.stdout += value;
      },
    },
    verifyBuildTargetBinding: async () => {
      state.buildTargetVerifyCalls += 1;
      if (state.buildTargetVerifyError !== undefined) throw state.buildTargetVerifyError;
      return true;
    },
  };
  return {
    assetLockPath,
    buildTargetRoot,
    executablePath,
    input: { assetLockPath, expectedSourceCommit: COMMIT, outputPath, runtimeDir },
    inputPath,
    lock,
    ops,
    outputPath,
    releaseDir,
    repoRoot,
    runtime,
    runtimeDir,
    state,
    tracked,
    toolPaths,
  };
}

async function expectCode(run, code) {
  await assert.rejects(
    run,
    (error) => error instanceof QualityHostSourceBuildAttestorError && error.code === code,
  );
}

test("attestor exports the programmatic, CLI, and deterministic test surfaces", () => {
  assert.equal(typeof attestQualityHostSourceBuild, "function");
  assert.equal(typeof runQualityHostSourceBuildAttestorCli, "function");
  assert.equal(typeof __attestQualityHostSourceBuildForTest, "function");
  assert.equal(typeof __parseGitLsFilesStageZForTest, "function");
  assert.equal(typeof __parsePeIdentityForTest, "function");
  assert.equal(typeof __runQualityHostSourceBuildAttestorCliForTest, "function");
  assert.equal(typeof verifyQualityHostSourceBuildAttestationLive, "function");
  assert.equal(typeof __verifyQualityHostSourceBuildAttestationLiveForTest, "function");
});

test("stage-z parser accepts only regular stage-zero paths and preserves spaces", () => {
  const parsed = __parseGitLsFilesStageZForTest(stageBytes([
    { mode: "100755", path: "tools/a file.mjs" },
    { mode: "100644", path: "src/é.rs" },
  ]));
  assert.deepEqual(parsed.map(({ mode, path: trackedPath, stage }) => ({ mode, path: trackedPath, stage })), [
    { mode: "100644", path: "src/é.rs", stage: 0 },
    { mode: "100755", path: "tools/a file.mjs", stage: 0 },
  ]);
});

test("successful fixture emits the strict formal build attestation without launching the host", async () => {
  const fx = fixture();
  const result = await __attestQualityHostSourceBuildForTest(fx.input, fx.ops);
  assert.deepEqual(result.record.authority, AUTHORITY);
  assert.deepEqual(result.record.cargo.features, ["native-quality-sample", "native-sherpa"]);
  assert.equal(result.record.cargo.profile, "release");
  assert.equal(result.record.executable.filename, QUALITY_HOST_EXE);
  assert.deepEqual(
    {
      pe_format: result.record.executable.pe_format,
      pe_machine: result.record.executable.pe_machine,
      pe_subsystem: result.record.executable.pe_subsystem,
    },
    { pe_format: "PE32+", pe_machine: "amd64", pe_subsystem: "console" },
  );
  assert.deepEqual(result.record.executable.required_dll_characteristics, REQUIRED_DLL_CHARACTERISTICS);
  assert.deepEqual(result.record.executable.imports, ["kernel32.dll", "sherpa-onnx-c-api.dll"]);
  assert.equal(result.record.executable.runtime_bundle_sha256, fx.lock.runtime.archive.bundle_sha256);
  assert.equal(result.record.kind, "meetingrelay-quality-host-source-build-attestation-v1");
  assert.equal(result.record.schema_version, "1.0");
  assert.deepEqual(result.record.source, {
    commit: COMMIT,
    tree_sha256: result.record.source.tree_sha256,
    worktree_status: "clean",
  });
  assert.match(result.record.source.tree_sha256, /^[0-9a-f]{64}$/u);
  assert.equal(result.record.toolchain.target, TARGET);
  assert.equal(
    result.record.toolchain.cargo_v_sha256,
    sha256(Buffer.from("cargo 1.95.0 (000000000 2026-01-01)\n")),
  );
  assert.equal(result.record.toolchain.cargo_executable_sha256, sha256(Buffer.from("cargo-executable")));
  assert.equal(result.record.toolchain.git_executable_sha256, sha256(Buffer.from("git-executable")));
  assert.equal(result.record.toolchain.rustc_executable_sha256, sha256(Buffer.from("rustc-executable")));
  assert.equal(result.bytes.toString("utf8"), encodeCanonicalJsonLine(result.record));
  assert.equal(result.sha256, sha256(result.bytes));
  assert.ok(fx.state.published.get(pathKey(fx.outputPath)).equals(result.bytes));
  assert.deepEqual(
    fx.state.commands.find(({ executable, args }) => executableName(executable) === "cargo.exe" && args[0] === "build")?.args,
    CARGO_ARGS,
  );
  const buildEnvironment = fx.state.commands.find(
    ({ executable, args }) => executableName(executable) === "cargo.exe" && args[0] === "build",
  )?.options.env;
  assert.equal(Object.hasOwn(buildEnvironment, "CARGO_HOME"), false);
  assert.equal(Object.hasOwn(buildEnvironment, "RUSTFLAGS"), false);
  assert.match(buildEnvironment.CARGO_ENCODED_RUSTFLAGS, /control-flow-guard=checks/u);
  assert.equal(buildEnvironment.CARGO_TARGET_DIR, fx.buildTargetRoot);
  assert.equal(buildEnvironment.SHERPA_ONNX_LIB_DIR, fx.runtimeDir);
  assert.equal(fx.state.buildTargetBindCalls.length, 1);
  assert.equal(fx.state.buildTargetBindCalls[0].requireAbsent, true);
  assert.ok(fx.state.buildTargetVerifyCalls >= 4);
  assert.equal(fx.state.commands.some(({ executable }) => pathKey(executable) === pathKey(fx.executablePath)), false);
  assert.deepEqual(
    new Set(fx.state.commands.map(({ executable }) => pathKey(executable))),
    new Set(Object.values(fx.toolPaths).map(pathKey)),
  );
});

test("module profile defaults to sample and explicit shard switches only identity constants", async () => {
  const fx = fixture();
  const shardHost = "meetingrelay-sherpa-candidate-quality-shard-host";
  const shardHostExe = `${shardHost}.exe`;
  const shardBuildTargetRoot = path.win32.join(
    fx.repoRoot,
    "target",
    "sherpa-native",
    "formal-run-trust",
    "quality-shard-host-builds",
    COMMIT,
  );
  const shardReleaseDir = path.win32.join(shardBuildTargetRoot, "release");
  const shardExecutablePath = path.win32.join(shardReleaseDir, shardHostExe);
  fx.state.files.set(pathKey(shardExecutablePath), peFixture());
  for (const [name, bytes] of fx.runtime.filter(([name]) => name.endsWith(".dll"))) {
    fx.state.files.set(pathKey(path.win32.join(shardReleaseDir, name)), bytes);
  }
  fx.state.releaseEntries = [
    { kind: "file", name: shardHostExe },
    ...fx.runtime.filter(([name]) => name.endsWith(".dll")).map(([name]) => ({ kind: "file", name })),
  ];
  fx.state.cargoStdout = `${JSON.stringify(cargoArtifact(shardExecutablePath, {
    executable: shardExecutablePath,
    features: ["native-quality-shard", "native-sherpa"],
    filenames: [shardExecutablePath],
    target: {
      name: shardHost,
      src_path: "C:\\repo\\crates\\model-worker-sherpa-native\\src\\bin\\meetingrelay_sherpa_candidate_quality_shard_host.rs",
    },
  }))}\n`;
  fx.ops.bindBuildTarget = async (request) => {
    fx.state.buildTargetBindCalls.push({ ...request });
    if (pathKey(request.buildTargetRoot) !== pathKey(shardBuildTargetRoot)) {
      throw Object.assign(new Error("unexpected build target"), { code: "EINVAL" });
    }
    if (request.requireAbsent) {
      if (fx.state.buildTargetExists) throw Object.assign(new Error("exists"), { code: "EEXIST" });
      fx.state.buildTargetExists = true;
    } else if (!fx.state.buildTargetExists) {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    }
    return Object.freeze({ token: "shard-binding" });
  };
  const listDirectory = fx.ops.listDirectory;
  fx.ops.listDirectory = async (directory) => {
    if (pathKey(directory) === pathKey(shardReleaseDir)) return fx.state.releaseEntries;
    return listDirectory(directory);
  };
  const result = await shardProfileAttestor.__attestQualityHostSourceBuildForTest(fx.input, fx.ops);
  assert.equal(result.record.kind, "meetingrelay-quality-shard-host-source-build-attestation-v1");
  assert.deepEqual(result.record.cargo.features, ["native-quality-shard", "native-sherpa"]);
  assert.equal(result.record.executable.filename, shardHostExe);
  assert.deepEqual(
    fx.state.commands.find(({ executable, args }) => executableName(executable) === "cargo.exe" && args[0] === "build")?.args,
    [
      "build",
      "--release",
      "-p",
      "meetingrelay-model-worker-sherpa-native",
      "--no-default-features",
      "--features",
      "native-quality-shard",
      "--bin",
      shardHost,
      "--message-format=json",
      "--offline",
      "--locked",
    ],
  );
  assert.equal(fx.state.buildTargetBindCalls[0].buildTargetRoot, shardBuildTargetRoot);
});

test("attestor requires an unused commit-scoped Cargo target before building", async () => {
  const fx = fixture();
  fx.state.buildTargetExists = true;
  await expectCode(
    () => __attestQualityHostSourceBuildForTest(fx.input, fx.ops),
    "QUALITY_HOST_ATTESTOR_BUILD_TARGET_EXISTS",
  );
  assert.equal(
    fx.state.commands.some(({ executable, args }) =>
      executableName(executable) === "cargo.exe" && args[0] === "build"),
    false,
  );
});

test("attestor rejects an unsafe build-target ancestor before Cargo can write", async () => {
  const fx = fixture();
  fx.state.buildTargetBindError = Object.assign(new Error("junction ancestor"), { code: "EINVAL" });
  await expectCode(
    () => __attestQualityHostSourceBuildForTest(fx.input, fx.ops),
    "QUALITY_HOST_ATTESTOR_BUILD_TARGET",
  );
  assert.equal(
    fx.state.commands.some(({ executable, args }) =>
      executableName(executable) === "cargo.exe" && args[0] === "build"),
    false,
  );
});

test("concurrent same-commit attestations have exactly one target reservation winner", async () => {
  const fx = fixture();
  const outcomes = await Promise.allSettled([
    __attestQualityHostSourceBuildForTest(fx.input, fx.ops),
    __attestQualityHostSourceBuildForTest(fx.input, fx.ops),
  ]);
  assert.equal(outcomes.filter(({ status }) => status === "fulfilled").length, 1);
  const rejection = outcomes.find(({ status }) => status === "rejected");
  assert.equal(rejection?.reason?.code, "QUALITY_HOST_ATTESTOR_BUILD_TARGET_EXISTS");
  assert.equal(fx.state.buildTargetBindCalls.length, 2);
});

test("attestor requires an exact clean expected HEAD before and after build", async (t) => {
  await t.test("HEAD mismatch", async () => {
    const fx = fixture();
    fx.state.gitHead = "b".repeat(40);
    await expectCode(() => __attestQualityHostSourceBuildForTest(fx.input, fx.ops), "QUALITY_HOST_ATTESTOR_SOURCE_COMMIT");
  });
  await t.test("dirty before build", async () => {
    const fx = fixture();
    fx.state.statusBefore = Buffer.from("?? local.txt\0");
    await expectCode(() => __attestQualityHostSourceBuildForTest(fx.input, fx.ops), "QUALITY_HOST_ATTESTOR_SOURCE_DIRTY");
  });
  await t.test("dirty after build", async () => {
    const fx = fixture();
    fx.state.statusAfter = Buffer.from(" M Cargo.lock\0");
    await expectCode(() => __attestQualityHostSourceBuildForTest(fx.input, fx.ops), "QUALITY_HOST_ATTESTOR_SOURCE_DIRTY");
  });
});

test("stage-z parser rejects symlinks, submodules, non-stage-zero entries, and malformed records", () => {
  const cases = [
    [stageBytes([{ mode: "120000", path: "link" }]), "QUALITY_HOST_ATTESTOR_SOURCE_MODE"],
    [stageBytes([{ mode: "160000", path: "vendor" }]), "QUALITY_HOST_ATTESTOR_SOURCE_MODE"],
    [stageBytes([{ path: "Cargo.lock", stage: 2 }]), "QUALITY_HOST_ATTESTOR_SOURCE_STAGE"],
    [Buffer.from("not-an-index-record\0"), "QUALITY_HOST_ATTESTOR_SOURCE_INDEX"],
  ];
  for (const [bytes, code] of cases) {
    assert.throws(
      () => __parseGitLsFilesStageZForTest(bytes),
      (error) => error instanceof QualityHostSourceBuildAttestorError && error.code === code,
    );
  }
});

test("stage-z parser rejects Windows case and NFC collisions", () => {
  assert.throws(
    () => __parseGitLsFilesStageZForTest(stageBytes([
      { path: "src/Relay.rs" },
      { path: "src/relay.rs" },
    ])),
    { code: "QUALITY_HOST_ATTESTOR_SOURCE_CASE_CONFLICT" },
  );
  assert.throws(
    () => __parseGitLsFilesStageZForTest(stageBytes([
      { path: "src/café.rs" },
      { path: "src/cafe\u0301.rs" },
    ])),
    { code: "QUALITY_HOST_ATTESTOR_SOURCE_NFC_CONFLICT" },
  );
});

test("tree manifest covers all tracked files and rejects post-build byte or index drift", async (t) => {
  await t.test("tracked bytes drift", async () => {
    const fx = fixture();
    fx.state.trackedMutationAfterBuild = {
      bytes: Buffer.from("pub fn changed() {}\n"),
      path: "crates/model-worker-sherpa-native/src/lib.rs",
    };
    await expectCode(() => __attestQualityHostSourceBuildForTest(fx.input, fx.ops), "QUALITY_HOST_ATTESTOR_SOURCE_DRIFT");
  });
  await t.test("index drift", async () => {
    const fx = fixture();
    fx.state.stageAfter = stageBytes([...fx.tracked.keys()].sort().map((trackedPath, index) => ({
      objectId: index === 0 ? "f".repeat(40) : undefined,
      path: trackedPath,
    })));
    await expectCode(() => __attestQualityHostSourceBuildForTest(fx.input, fx.ops), "QUALITY_HOST_ATTESTOR_SOURCE_DRIFT");
  });
});

test("tree manifest must explicitly bind Cargo.lock and rust-toolchain.toml", async (t) => {
  for (const [name, code] of [
    ["Cargo.lock", "QUALITY_HOST_ATTESTOR_CARGO_LOCK"],
    ["rust-toolchain.toml", "QUALITY_HOST_ATTESTOR_RUST_TOOLCHAIN"],
  ]) {
    await t.test(name, async () => {
      const fx = fixture();
      const paths = [...fx.tracked.keys()].filter((trackedPath) => trackedPath !== name);
      fx.state.stageBefore = stageBytes(paths.map((trackedPath) => ({ path: trackedPath })));
      await expectCode(() => __attestQualityHostSourceBuildForTest(fx.input, fx.ops), code);
    });
  }
});

test("rustc identity must match the pinned toolchain release and Windows MSVC target", async (t) => {
  for (const [label, replacement, code] of [
    ["release", "release: 1.96.0", "QUALITY_HOST_ATTESTOR_RUST_TOOLCHAIN"],
    ["host", "host: aarch64-pc-windows-msvc", "QUALITY_HOST_ATTESTOR_TARGET"],
  ]) {
    await t.test(label, async () => {
      const fx = fixture();
      const original = fx.ops.runCommand;
      fx.ops.runCommand = async (executable, args, options) => {
        const result = await original(executable, args, options);
        if (executableName(executable) === "rustc.exe") {
          const pattern = label === "release" ? /release: 1\.95\.0/u : /host: x86_64-pc-windows-msvc/u;
          result.stdout = Buffer.from(result.stdout.toString("utf8").replace(pattern, replacement));
        }
        return result;
      };
      await expectCode(() => __attestQualityHostSourceBuildForTest(fx.input, fx.ops), code);
    });
  }
});

test("cargo -V identity must match the pinned toolchain and is bound by digest", async () => {
  const fx = fixture();
  const original = fx.ops.runCommand;
  fx.ops.runCommand = async (executable, args, options) => {
    const result = await original(executable, args, options);
    if (executableName(executable) === "cargo.exe" && args.join(" ") === "-V") {
      result.stdout = Buffer.from("cargo 1.96.0 (111111111 2026-02-01)\n");
    }
    return result;
  };
  await expectCode(
    () => __attestQualityHostSourceBuildForTest(fx.input, fx.ops),
    "QUALITY_HOST_ATTESTOR_CARGO",
  );
});

test("ambient compiler, Cargo, rustc, and linker injection variables are rejected", async (t) => {
  for (const variable of [
    "CARGO_HOME",
    "CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_RUSTFLAGS",
    "RUSTC_BOOTSTRAP",
    "RUSTFLAGS",
    "RUSTDOCFLAGS",
    "CC",
    "AR",
    "LINK",
    "CL",
    "SHERPA_ONNX_LIB_DIR",
  ]) {
    await t.test(variable, async () => {
      const fx = fixture();
      fx.ops.environment[variable] = "attacker-controlled";
      await expectCode(
        () => __attestQualityHostSourceBuildForTest(fx.input, fx.ops),
        "QUALITY_HOST_ATTESTOR_ENVIRONMENT",
      );
    });
  }
});

test("tool resolution rejects a non-absolute candidate and binds the selected stable bytes", async () => {
  const fx = fixture();
  const original = fx.ops.runCommand;
  fx.ops.runCommand = async (executable, args, options) => {
    const result = await original(executable, args, options);
    if (executableName(executable) === "where.exe" && args[0] === "cargo.exe") {
      result.stdout = Buffer.from("attacker\\cargo.exe\r\n");
    }
    return result;
  };
  await expectCode(
    () => __attestQualityHostSourceBuildForTest(fx.input, fx.ops),
    "QUALITY_HOST_ATTESTOR_TOOL_RESOLUTION",
  );
});

test("Cargo configuration rejects workspace legacy and external user or ancestor overrides", async (t) => {
  await t.test("workspace legacy config", async () => {
    const fx = fixture();
    fx.state.optionalDirectories.get(pathKey(path.win32.join(fx.repoRoot, ".cargo"))).push({
      kind: "file",
      name: "config",
    });
    await expectCode(
      () => __attestQualityHostSourceBuildForTest(fx.input, fx.ops),
      "QUALITY_HOST_ATTESTOR_CARGO_CONFIG",
    );
  });
  await t.test("ancestor config", async () => {
    const fx = fixture();
    fx.state.optionalDirectories.set(pathKey("C:\\.cargo"), [{ kind: "file", name: "config.toml" }]);
    await expectCode(
      () => __attestQualityHostSourceBuildForTest(fx.input, fx.ops),
      "QUALITY_HOST_ATTESTOR_CARGO_CONFIG",
    );
  });
  await t.test("user config", async () => {
    const fx = fixture();
    fx.state.optionalDirectories.set(pathKey("C:\\Users\\builder\\.cargo"), [{ kind: "file", name: "config" }]);
    await expectCode(
      () => __attestQualityHostSourceBuildForTest(fx.input, fx.ops),
      "QUALITY_HOST_ATTESTOR_CARGO_CONFIG",
    );
  });
});

test("cargo artifact selection requires one exact Release non-test non-debug quality host", async (t) => {
  const mutations = [
    ["duplicate", (fx) => { fx.state.cargoStdout += fx.state.cargoStdout; }],
    ["debug", (fx) => {
      fx.state.cargoStdout = `${JSON.stringify(cargoArtifact(fx.executablePath, { profile: { debug_assertions: true } }))}\n`;
    }],
    ["test", (fx) => {
      fx.state.cargoStdout = `${JSON.stringify(cargoArtifact(fx.executablePath, { profile: { test: true } }))}\n`;
    }],
    ["wrong-path", (fx) => {
      fx.state.cargoStdout = `${JSON.stringify(cargoArtifact("C:\\repo\\target\\debug\\meetingrelay-sherpa-candidate-quality-host.exe"))}\n`;
    }],
  ];
  for (const [label, mutate] of mutations) {
    await t.test(label, async () => {
      const fx = fixture();
      mutate(fx);
      await expectCode(() => __attestQualityHostSourceBuildForTest(fx.input, fx.ops), "QUALITY_HOST_ATTESTOR_ARTIFACT");
    });
  }
});

test("PE parser accepts only PE32+ AMD64 console executables", () => {
  assert.deepEqual(__parsePeIdentityForTest(peFixture()), {
    imports: ["kernel32.dll", "sherpa-onnx-c-api.dll"],
    pe_format: "PE32+",
    pe_machine: "amd64",
    pe_subsystem: "console",
    required_dll_characteristics: REQUIRED_DLL_CHARACTERISTICS,
  });
  for (const bytes of [
    peFixture({ magic: 0x10b }),
    peFixture({ machine: 0x14c }),
    peFixture({ subsystem: 2 }),
    Buffer.from("not-pe"),
  ]) {
    assert.throws(() => __parsePeIdentityForTest(bytes), { code: "QUALITY_HOST_ATTESTOR_PE" });
  }
});

test("PE parser requires every hardening bit and a bounded unique import table", () => {
  for (const bit of [0x0040, 0x0020, 0x0100, 0x4000]) {
    assert.throws(
      () => __parsePeIdentityForTest(peFixture({ dllCharacteristics: 0x4160 & ~bit })),
      { code: "QUALITY_HOST_ATTESTOR_PE_HARDENING" },
    );
  }
  assert.throws(
    () => __parsePeIdentityForTest(peFixture({ imports: ["kernel32.dll", "KERNEL32.DLL"] })),
    { code: "QUALITY_HOST_ATTESTOR_PE_IMPORTS" },
  );
  assert.throws(
    () => __parsePeIdentityForTest(peFixture({ importDirectoryRva: 0x90000000 })),
    { code: "QUALITY_HOST_ATTESTOR_PE_IMPORTS" },
  );
});

test("quality host rejects imports outside the locked-runtime and system allowlists", async () => {
  const fx = fixture();
  fx.state.files.set(
    pathKey(fx.executablePath),
    peFixture({ imports: ["sherpa-onnx-c-api.dll", "attacker.dll"] }),
  );
  await expectCode(
    () => __attestQualityHostSourceBuildForTest(fx.input, fx.ops),
    "QUALITY_HOST_ATTESTOR_PE_IMPORTS",
  );
});

test("runtimeDir must be the exact locked seven-file inventory", async (t) => {
  await t.test("extra entry", async () => {
    const fx = fixture();
    fx.state.runtimeEntries.push({ kind: "file", name: "extra.lib" });
    await expectCode(() => __attestQualityHostSourceBuildForTest(fx.input, fx.ops), "QUALITY_HOST_ATTESTOR_RUNTIME_INVENTORY");
  });
  await t.test("hash drift", async () => {
    const fx = fixture();
    fx.state.files.set(pathKey(path.win32.join(fx.runtimeDir, "onnxruntime.dll")), Buffer.from("tampered"));
    await expectCode(() => __attestQualityHostSourceBuildForTest(fx.input, fx.ops), "QUALITY_HOST_ATTESTOR_RUNTIME_INVENTORY");
  });
  await t.test("non-file entry", async () => {
    const fx = fixture();
    fx.state.runtimeEntries[0] = { kind: "symlink", name: "onnxruntime.dll" };
    await expectCode(() => __attestQualityHostSourceBuildForTest(fx.input, fx.ops), "QUALITY_HOST_ATTESTOR_RUNTIME_INVENTORY");
  });
});

test("Release adjacency must contain exactly the four locked DLL identities", async (t) => {
  await t.test("missing DLL", async () => {
    const fx = fixture();
    fx.state.releaseEntries = fx.state.releaseEntries.filter(({ name }) => name !== "onnxruntime.dll");
    await expectCode(() => __attestQualityHostSourceBuildForTest(fx.input, fx.ops), "QUALITY_HOST_ATTESTOR_RUNTIME_ADJACENCY");
  });
  await t.test("extra DLL", async () => {
    const fx = fixture();
    fx.state.releaseEntries.push({ kind: "file", name: "unsealed.dll" });
    await expectCode(() => __attestQualityHostSourceBuildForTest(fx.input, fx.ops), "QUALITY_HOST_ATTESTOR_RUNTIME_ADJACENCY");
  });
  await t.test("hash drift", async () => {
    const fx = fixture();
    fx.state.files.set(pathKey(path.win32.join(fx.releaseDir, "onnxruntime.dll")), Buffer.from("tampered"));
    await expectCode(() => __attestQualityHostSourceBuildForTest(fx.input, fx.ops), "QUALITY_HOST_ATTESTOR_RUNTIME_ADJACENCY");
  });
});

test("publication is create-new and verifies the persisted canonical bytes", async (t) => {
  await t.test("no replace", async () => {
    const fx = fixture();
    fx.state.publishError = Object.assign(new Error("exists"), { code: "EEXIST" });
    await expectCode(() => __attestQualityHostSourceBuildForTest(fx.input, fx.ops), "QUALITY_HOST_ATTESTOR_OUTPUT_EXISTS");
  });
  await t.test("postflight mismatch", async () => {
    const fx = fixture();
    fx.state.postflightBytes = Buffer.from("replacement");
    await expectCode(() => __attestQualityHostSourceBuildForTest(fx.input, fx.ops), "QUALITY_HOST_ATTESTOR_OUTPUT_POSTFLIGHT");
  });
});

test("asset lock and ignored output paths are fixed to the repository trust subtree", async (t) => {
  await t.test("alternate asset lock", async () => {
    const fx = fixture();
    await expectCode(
      () => __attestQualityHostSourceBuildForTest({
        ...fx.input,
        assetLockPath: "C:\\evidence\\assets.lock.json",
      }, fx.ops),
      "QUALITY_HOST_ATTESTOR_ASSET_LOCK",
    );
  });
  await t.test("output outside ignored subtree", async () => {
    const fx = fixture();
    await expectCode(
      () => __attestQualityHostSourceBuildForTest({
        ...fx.input,
        outputPath: "C:\\evidence\\attestation.json",
      }, fx.ops),
      "QUALITY_HOST_ATTESTOR_OUTPUT_PATH",
    );
  });
  await t.test("post-publication source pollution", async () => {
    const fx = fixture();
    fx.state.statusAfterPublish = Buffer.from("?? target/sherpa-native/formal-run-trust/build-attestations/evidence.json\0");
    await expectCode(
      () => __attestQualityHostSourceBuildForTest(fx.input, fx.ops),
      "QUALITY_HOST_ATTESTOR_SOURCE_DIRTY",
    );
  });
});

test("publication revalidates executable, runtime, and tool file identities", async (t) => {
  await t.test("executable replacement with identical bytes", async () => {
    const fx = fixture();
    fx.state.closureMutationAfterPublish = {
      bytes: fx.state.files.get(pathKey(fx.executablePath)),
      pathKey: pathKey(fx.executablePath),
    };
    await expectCode(
      () => __attestQualityHostSourceBuildForTest(fx.input, fx.ops),
      "QUALITY_HOST_ATTESTOR_ARTIFACT_DRIFT",
    );
  });
  await t.test("runtime replacement with identical bytes", async () => {
    const fx = fixture();
    const runtimePath = path.win32.join(fx.runtimeDir, "onnxruntime.dll");
    fx.state.closureMutationAfterPublish = {
      bytes: fx.state.files.get(pathKey(runtimePath)),
      pathKey: pathKey(runtimePath),
    };
    await expectCode(
      () => __attestQualityHostSourceBuildForTest(fx.input, fx.ops),
      "QUALITY_HOST_ATTESTOR_RUNTIME_DRIFT",
    );
  });
  await t.test("tool replacement with identical bytes", async () => {
    const fx = fixture();
    fx.state.closureMutationAfterPublish = {
      bytes: fx.state.files.get(pathKey(fx.toolPaths.cargo)),
      pathKey: pathKey(fx.toolPaths.cargo),
    };
    await expectCode(
      () => __attestQualityHostSourceBuildForTest(fx.input, fx.ops),
      "QUALITY_HOST_ATTESTOR_TOOL_DRIFT",
    );
  });
});

test("live verifier independently rejoins source, tools, PE, executable, and runtime without a build", async () => {
  const fx = fixture();
  const attested = await __attestQualityHostSourceBuildForTest(fx.input, fx.ops);
  const commandCount = fx.state.commands.length;
  const verified = await __verifyQualityHostSourceBuildAttestationLiveForTest({
    bytes: attested.bytes,
    expectedSourceCommit: COMMIT,
  }, fx.ops);
  assert.equal(verified.sha256, attested.sha256);
  assert.equal(verified.assetLockPath, fx.assetLockPath);
  assert.equal(verified.runtimeDir, fx.runtimeDir);
  const verifierCommands = fx.state.commands.slice(commandCount);
  assert.equal(verifierCommands.some(({ executable, args }) =>
    executableName(executable) === "cargo.exe" && args[0] === "build"), false);
  assert.equal(verifierCommands.some(({ executable }) => pathKey(executable) === pathKey(fx.executablePath)), false);
});

test("live verifier rejects a canonical attestation that self-claims a different executable", async () => {
  const fx = fixture();
  const attested = await __attestQualityHostSourceBuildForTest(fx.input, fx.ops);
  const record = structuredClone(attested.record);
  record.executable.sha256 = "f".repeat(64);
  await expectCode(
    () => __verifyQualityHostSourceBuildAttestationLiveForTest({
      bytes: Buffer.from(encodeCanonicalJsonLine(record), "utf8"),
      expectedSourceCommit: COMMIT,
    }, fx.ops),
    "QUALITY_HOST_ATTESTOR_LIVE_MISMATCH",
  );
});

test("CLI accepts only --attest input-json and emits one text-free marker", async () => {
  const fx = fixture();
  const result = await __runQualityHostSourceBuildAttestorCliForTest(
    ["--attest", fx.inputPath],
    fx.ops,
  );
  assert.equal(fx.state.stdout,
    `QUALITY_HOST_SOURCE_BUILD_ATTESTATION=PASS attestation_sha256=${result.sha256} execution_status=not-run formal_claims=none production_evidence=false\n`);
  assert.doesNotMatch(fx.state.stdout, /transcript|audio|model output|hello/iu);
});

test("CLI rejects every shape other than --attest input-json", async () => {
  const fx = fixture();
  await expectCode(
    () => __runQualityHostSourceBuildAttestorCliForTest(["--run", fx.inputPath], fx.ops),
    "QUALITY_HOST_ATTESTOR_USAGE",
  );
});
