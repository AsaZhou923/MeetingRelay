import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { link, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { promisify } from "node:util";

import { encodeCanonicalJson } from "../phase0-harness/canonical-json.mjs";
import {
  BUILD_OUTPUT_IDENTITY_ATTESTATION,
  EXECUTION_STATUS,
  LAUNCH_BINDING_STATUS,
  MEASUREMENT_STATUS,
  PUBLIC_EVIDENCE_KIND,
  PUBLIC_EVIDENCE_SCHEMA_PATH,
  attestWhisperCiBuildOutputRuntimeIdentity,
  bindExecutionToolPaths,
  makeSyntheticPe,
  observeToolFileBytes,
  parsePe,
  scanForbiddenPublicEvidence,
  selectCargoExecutable,
  sha256Hex,
  validateAmbientEnvironment,
  validatePublicEvidence,
} from "./whisper-fallback-ci-build-output-runtime-identity-attestation.mjs";

const execFileAsync = promisify(execFile);
const MODULE_PATH = "tools/whisper-native/whisper-fallback-ci-build-output-runtime-identity-attestation.mjs";
const HEAD = "0123456789abcdef0123456789abcdef01234567";
const EXE_NAME = process.platform === "win32" ? "meetingrelay-whisper-runtime-version-probe.exe" : "meetingrelay-whisper-runtime-version-probe";
const GOOD_MARKER =
  "meetingrelay-whisper-runtime-version-probe-v1 linked_whisper_cpp_version=1.8.3 measurement_status=whisper-runtime-version-marker-path-observation-only execution_status=runtime-path-launched-fixed-version-marker-observed-no-model-no-transcription quality_gate_status=not-assessed formal_claims=none production_evidence=false public_distribution=false selection_authority=none fallback_authority=none loaded_image_attestation=false network_isolation_authority=none\n";

function hashCanonical(value) {
  return sha256Hex(Buffer.from(encodeCanonicalJson(value), "utf8"));
}

function fakeSpawn(stdoutText = GOOD_MARKER, options = {}) {
  return () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const listeners = new Map();
    const child = {
      killed: false,
      stdout,
      stderr,
      kill: () => {
        child.killed = true;
      },
      on: (event, handler) => {
        if (!listeners.has(event)) listeners.set(event, []);
        listeners.get(event).push(handler);
        return child;
      },
    };
    queueMicrotask(() => {
      stdout.end(stdoutText);
      stderr.end(options.stderr ?? "");
      for (const handler of listeners.get("exit") ?? []) handler(options.code ?? 0, null);
      for (const handler of listeners.get("close") ?? []) handler(options.code ?? 0, null);
    });
    return child;
  };
}

function gitState(label = "tree") {
  return {
    head: HEAD,
    repo_root_identity_sha256: sha256Hex(Buffer.from("root-id", "utf8")),
    repo_root_realpath_sha256: sha256Hex(Buffer.from("root-realpath", "utf8")),
    tracked_tree: { digest_sha256: sha256Hex(Buffer.from(label, "utf8")), entry_count: 5 },
  };
}

function toolObservations() {
  const tools = ["cargo", "rustc", "git", "cmake", "clang", "libclang"].map((name) => ({
    bytes_sha256: sha256Hex(Buffer.from(`${name}-bytes`, "utf8")),
    name_sha256: sha256Hex(Buffer.from(name, "utf8")),
    size_bytes: 19,
    version_output_sha256: sha256Hex(Buffer.from(`${name}-version`, "utf8")),
  }));
  return { aggregate_sha256: sha256Hex(Buffer.from(encodeCanonicalJson(tools), "utf8")), tool_count: 6, toolchain_provenance_authority: "observed-tool-bytes-only", tools };
}

async function fixture(fn) {
  const root = await mkdtemp(path.join(tmpdir(), "meetingrelay-whisper-ci-5d-test-"));
  try {
    const repo = path.join(root, "repo");
    const targetRoot = path.join(repo, "target", "whisper-native", "wp-0.4.5d", HEAD);
    await mkdir(path.join(repo, ".cargo"), { recursive: true });
    await mkdir(path.join(repo, "crates", "model-worker-whisper-native"), { recursive: true });
    await mkdir(path.join(targetRoot, "release", "deps"), { recursive: true });
    await writeFile(path.join(repo, "Cargo.toml"), "[workspace]\n", "utf8");
    await writeFile(path.join(repo, ".cargo", "config.toml"), "[env]\n", "utf8");
    await writeFile(path.join(repo, "rust-toolchain.toml"), "[toolchain]\nchannel = \"1.95.0\"\n", "utf8");
    await writeFile(path.join(repo, "crates", "model-worker-whisper-native", "Cargo.toml"), "[package]\nname = \"meetingrelay-model-worker-whisper-native\"\n", "utf8");
    await writeFile(
      path.join(repo, "Cargo.lock"),
      '[[package]]\nname = "whisper-rs"\nversion = "0.16.0"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "2088172d00f936c348d6a72f488dc2660ab3f507263a195df308a3c2383229f6"\n\n[[package]]\nname = "whisper-rs-sys"\nversion = "0.15.0"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "6986c0fe081241d391f09b9a071fbcbb59720c3563628c3c829057cf69f2a56f"\n',
      "utf8",
    );
    const exe = path.join(targetRoot, "release", EXE_NAME);
    const depsExe = path.join(targetRoot, "release", "deps", `meetingrelay_whisper_runtime_version_probe-synthetic${process.platform === "win32" ? ".exe" : ""}`);
    await writeFile(depsExe, makeSyntheticPe(), { mode: 0o700 });
    await link(depsExe, exe);
    assert.equal((await stat(exe, { bigint: true })).nlink, 2n, "fixture must mirror Cargo's release/deps hardlink layout");
    const message = {
      executable: exe,
      profile: { opt_level: "3", test: false },
      reason: "compiler-artifact",
      target: { kind: ["bin"], name: "meetingrelay-whisper-runtime-version-probe" },
    };
    return await fn({ repo, targetRoot, exe, message });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function attestFixture(overrides = {}) {
  return await fixture(async ({ repo, targetRoot, message }) =>
    attestWhisperCiBuildOutputRuntimeIdentity(HEAD, repo, {
      cargoMessagesForTest: [message],
      env: {},
      gitStateAfterForTest: gitState(),
      gitStateBeforeForTest: gitState(),
      gitStateFinalForTest: gitState(),
      isolatedTargetRootSha256ForTest: sha256Hex(Buffer.from("synthetic-target-root", "utf8")),
      observationScopeForTest: "synthetic-injected-harness",
      peForTest: parsePe(makeSyntheticPe()),
      probeOptionsForTest: { spawnImpl: fakeSpawn() },
      selectedRuntimeIdentitySha256ForTest: sha256Hex(Buffer.from("synthetic-runtime-identity", "utf8")),
      targetRootForTest: targetRoot,
      toolObservationsForTest: toolObservations(),
      ...overrides,
    }),
  );
}

test("positive deterministic injected flow joins build executable SHA through 5b and 5c", async () => {
  const left = await attestFixture();
  const right = await attestFixture();
  assert.deepEqual(left, right);
  assert.equal(left.kind, PUBLIC_EVIDENCE_KIND);
  assert.equal(left.observation_scope, "synthetic-injected-harness");
  assert.equal(left.measurement_status, MEASUREMENT_STATUS);
  assert.equal(left.execution_status, EXECUTION_STATUS);
  assert.equal(left.build_output_identity_attestation, BUILD_OUTPUT_IDENTITY_ATTESTATION);
  assert.equal(left.source_build_provenance_authority, "none");
  assert.equal(left.registry_source_byte_closure, false);
  assert.equal(left.toolchain_provenance_authority, "observed-tool-bytes-only");
  assert.equal(left.loaded_image_attestation, false);
  assert.equal(left.network_isolation_authority, "none");
  assert.equal(left.quality_gate_status, "not-assessed");
  assert.equal(left.formal_claims, "none");
  assert.equal(left.production_evidence, false);
  assert.equal(left.public_distribution, false);
  assert.equal(left.selection_authority, "none");
  assert.equal(left.fallback_authority, "none");
  assert.equal(left.launch_binding_status, LAUNCH_BINDING_STATUS);
  assert.equal(left.selected_runtime.sha256, left.five_b_preflight.runtime_role_sha256);
  assert.equal(left.selected_runtime.sha256, left.five_c_probe.runtime_sha256);
  assert.equal(left.selected_runtime.copied_runtime_sha256, left.selected_runtime.sha256);
  assert.equal(left.cargo_build.pdb_publication, false);
  assert.equal(left.selected_runtime.pe.architecture, "amd64");
  assert.equal(left.selected_runtime.pe.optional_header, "pe32plus");
  assert.equal(left.selected_runtime.pe.subsystem, "console");
  assert.equal("import_name_count" in left.selected_runtime.pe, false);
  assert.equal("import_names_sha256" in left.selected_runtime.pe, false);
  validatePublicEvidence(left);
  const serialized = JSON.stringify(left);
  for (const forbidden of ["target/", "inputs/", ".pdb", "linked_whisper_cpp_version", "1.8.3", "C:\\"]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test("schema parity mirrors 5d authority constants", async () => {
  const schema = JSON.parse(await readFile(PUBLIC_EVIDENCE_SCHEMA_PATH, "utf8"));
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.kind.const, PUBLIC_EVIDENCE_KIND);
  assert.deepEqual(schema.properties.observation_scope.enum, ["windows-ci-clean-exact-head-build-output", "synthetic-injected-harness"]);
  assert.equal(schema.properties.schema_version.const, "1.0");
  assert.equal(schema.properties.measurement_status.const, MEASUREMENT_STATUS);
  assert.equal(schema.properties.execution_status.const, EXECUTION_STATUS);
  assert.equal(schema.properties.build_output_identity_attestation.const, true);
  assert.equal(schema.properties.source_build_provenance_authority.const, "none");
  assert.equal(schema.properties.registry_source_byte_closure.const, false);
  assert.equal(schema.properties.toolchain_provenance_authority.const, "observed-tool-bytes-only");
  assert.equal(schema.properties.loaded_image_attestation.const, false);
  assert.equal(schema.properties.network_isolation_authority.const, "none");
  assert.equal(schema.properties.launch_binding_status.const, LAUNCH_BINDING_STATUS);
  assert.equal(schema.properties.source_materials.properties.files.prefixItems.length, 5);
  assert.equal(schema.properties.cargo_registry_lock.properties.packages.prefixItems.length, 2);
  assert.equal(schema.properties.tool_observations.properties.tools.prefixItems.length, 6);
  assert.equal(schema.properties.cargo_build.properties.command_sha256.const, "3ebc466b8abf710a3c708c6dbb3284dd31cbabed6c4a95d5fc281f5e97ca1b66");
});

test("environment override policy accepts required CI values and rejects build-affecting overrides", () => {
  assert.doesNotThrow(() => validateAmbientEnvironment({ CARGO_HOME: "kept", CARGO_INCREMENTAL: "0", CARGO_NET_OFFLINE: "true", LIBCLANG_PATH: "kept", PATH: "kept" }));
  for (const env of [
    { CARGO_NET_OFFLINE: "false" },
    { CARGO_INCREMENTAL: "1" },
    { RUSTFLAGS: "-Ctarget-cpu=native" },
    { rustflags: "-Ctarget-cpu=native" },
    { RUSTC: "rustc.exe" },
    { RUSTDOCFLAGS: "-Dwarnings" },
    { RUSTC_BOOTSTRAP: "1" },
    { CARGO_ENCODED_RUSTFLAGS: "-Ctarget-feature=+avx" },
    { CARGO_PROFILE_RELEASE_LTO: "thin" },
    { RUSTC_WRAPPER: "sccache" },
    { CARGO_BUILD_TARGET: "x86_64-pc-windows-msvc" },
    { CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER: "link.exe" },
    { CMAKE: "cmake.exe" },
    { CMAKE_GENERATOR: "Ninja" },
    { BINDGEN_EXTRA_CLANG_ARGS_X86_64_PC_WINDOWS_MSVC: "--target=other" },
    { CLANG_PATH: "other-clang.exe" },
    { WHISPER_NO_AVX: "1" },
    { GGML_NATIVE: "1" },
  ]) {
    assert.throws(() => validateAmbientEnvironment(env), /WHISPER_CI_ATTEST_ENV/u);
  }
});

test("tool-byte observation accepts rustup-style hardlinks", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "meetingrelay-whisper-ci-5d-tool-test-"));
  try {
    const original = path.join(root, "rustup-proxy.exe");
    const cargo = path.join(root, "cargo.exe");
    const bytes = Buffer.from("synthetic rustup proxy bytes\n", "utf8");
    await writeFile(original, bytes);
    await link(original, cargo);
    const observed = await observeToolFileBytes(cargo);
    assert.equal(observed.sha256, sha256Hex(bytes));
    assert.equal(observed.size_bytes, bytes.length);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("configured Cargo and Git paths are bound to both observation and execution", async () => {
  const root = path.resolve(process.cwd());
  const cargo = path.join(root, "synthetic-tools", "cargo.exe");
  const git = path.join(root, "synthetic-tools", "git.exe");
  const bound = await bindExecutionToolPaths(root, {
    env: {
      MEETINGRELAY_WHISPER_CARGO_PATH: cargo,
      MEETINGRELAY_WHISPER_GIT_PATH: git,
    },
  });
  assert.equal(bound.cargoCommand, cargo);
  assert.equal(bound.gitCommand, git);
  assert.equal(bound.toolResolver.cargo, cargo);
  assert.equal(bound.toolResolver.git, git);
});

test("injected observations cannot request real Windows CI scope", async () => {
  await assert.rejects(
    () => attestFixture({ observationScopeForTest: "windows-ci-clean-exact-head-build-output" }),
    /WHISPER_CI_ATTEST_SCOPE/u,
  );
});

test("Cargo artifact selection fails on ambiguity, wrong path, debug profile, tests, and wrong target", async () => {
  await fixture(async ({ targetRoot, message }) => {
    assert.equal(selectCargoExecutable({ messages: [message] }, targetRoot), message.executable);
    assert.throws(() => selectCargoExecutable({ messages: [message, { ...message }] }, targetRoot), /WHISPER_CI_ATTEST_ARTIFACT_AMBIGUITY/u);
    assert.throws(() => selectCargoExecutable({ messages: [{ ...message, executable: path.join(targetRoot, "debug", EXE_NAME) }] }, targetRoot), /WHISPER_CI_ATTEST_ARTIFACT_TARGET/u);
    assert.throws(() => selectCargoExecutable({ messages: [{ ...message, profile: { opt_level: "0", test: false } }] }, targetRoot), /WHISPER_CI_ATTEST_ARTIFACT_AMBIGUITY/u);
    assert.throws(() => selectCargoExecutable({ messages: [{ ...message, profile: { opt_level: "3", test: true } }] }, targetRoot), /WHISPER_CI_ATTEST_ARTIFACT_AMBIGUITY/u);
    assert.throws(() => selectCargoExecutable({ messages: [{ ...message, target: { kind: ["lib"], name: "meetingrelay-whisper-runtime-version-probe" } }] }, targetRoot), /WHISPER_CI_ATTEST_ARTIFACT_AMBIGUITY/u);
  });
});

test("PE shape rejects non-MZ, non-AMD64, non-PE32+, and non-console executables", () => {
  assert.doesNotThrow(() => parsePe(makeSyntheticPe()));
  const cases = [
    [0, 0x00, /MZ/u],
    [0x84, 0x4c, /AMD64/u],
    [0x98, 0x0b, /PE32\+/u],
    [0xdc, 0x02, /console/u],
    [0x86, 0x00, /section count/u],
    [0x94, 0x10, /optional header size/u],
  ];
  for (const [offset, value, pattern] of cases) {
    const bytes = makeSyntheticPe();
    if (offset === 0) bytes[offset] = value;
    else bytes.writeUInt16LE(value, offset);
    assert.throws(() => parsePe(bytes), pattern);
  }
});

test("runtime drift and 5c mismatch fail closed", async () => {
  await assert.rejects(
    () => attestFixture({ probeOptionsForTest: { spawnImpl: fakeSpawn("unexpected\n") } }),
    /WHISPER_RUNTIME_PROBE_STDOUT_AMBIGUOUS/u,
  );
  await fixture(async ({ repo, targetRoot, message }) => {
    const otherExe = path.join(targetRoot, "release", `other-${EXE_NAME}`);
    await writeFile(otherExe, Buffer.from("not the build exe\n"), { mode: 0o700 });
    const mismatchedMessage = { ...message, executable: otherExe };
    await assert.rejects(
      () =>
        attestWhisperCiBuildOutputRuntimeIdentity(HEAD, repo, {
          cargoMessagesForTest: [mismatchedMessage],
          env: {},
          gitStateAfterForTest: gitState(),
          gitStateBeforeForTest: gitState(),
          gitStateFinalForTest: gitState(),
          isolatedTargetRootSha256ForTest: sha256Hex(Buffer.from("synthetic-target-root", "utf8")),
          observationScopeForTest: "synthetic-injected-harness",
          peForTest: parsePe(makeSyntheticPe()),
          probeOptionsForTest: { spawnImpl: fakeSpawn() },
          selectedRuntimeIdentitySha256ForTest: sha256Hex(Buffer.from("synthetic-runtime-identity", "utf8")),
          targetRootForTest: targetRoot,
          toolObservationsForTest: toolObservations(),
        }),
      /WHISPER_CI_ATTEST_ARTIFACT_TARGET/u,
    );
  });
});

test("public evidence scanner and validator reject leakage and authority overclaims", async () => {
  const evidence = await attestFixture();
  assert.throws(() => scanForbiddenPublicEvidence({ path: "hidden" }), /WHISPER_CI_ATTEST_EVIDENCE_FORBIDDEN/u);
  assert.throws(() => scanForbiddenPublicEvidence({ safe: "C:\\temp\\runtime.exe" }), /WHISPER_CI_ATTEST_EVIDENCE_FORBIDDEN/u);
  assert.throws(() => scanForbiddenPublicEvidence({ safe: "target\\whisper-native\\x.pdb" }), /WHISPER_CI_ATTEST_EVIDENCE_FORBIDDEN/u);
  assert.throws(() => validatePublicEvidence({ ...evidence, loaded_image_attestation: true }), /WHISPER_CI_ATTEST_EVIDENCE_OVERCLAIM/u);
  assert.throws(() => validatePublicEvidence({ ...evidence, source_build_provenance_authority: "source-provenance" }), /WHISPER_CI_ATTEST_EVIDENCE_OVERCLAIM/u);
  assert.throws(() => validatePublicEvidence({ ...evidence, repository: { ...evidence.repository, after_sha256: sha256Hex(Buffer.from("changed", "utf8")) } }), /repository before\/after digest mismatch/u);
  assert.throws(() => validatePublicEvidence({ ...evidence, five_c_probe: { ...evidence.five_c_probe, runtime_sha256: sha256Hex(Buffer.from("changed", "utf8")) } }), /runtime SHA joins must match/u);
  assert.throws(() => validatePublicEvidence({ ...evidence, joins: { ...evidence.joins, join_sha256: sha256Hex(Buffer.from("changed", "utf8")) } }), /join digest mismatch/u);
  assert.throws(() => validatePublicEvidence({ ...evidence, source_materials: { ...evidence.source_materials, aggregate_sha256: sha256Hex(Buffer.from("changed", "utf8")) } }), /source materials aggregate mismatch/u);
  assert.throws(() => validatePublicEvidence({ ...evidence, cargo_registry_lock: { ...evidence.cargo_registry_lock, packages: [{ ...evidence.cargo_registry_lock.packages[0], checksum: "not-a-sha" }, evidence.cargo_registry_lock.packages[1]] } }), /package identity, order, source, version, or checksum mismatch/u);
  assert.throws(() => validatePublicEvidence({ ...evidence, tool_observations: { ...evidence.tool_observations, aggregate_sha256: sha256Hex(Buffer.from("changed", "utf8")) } }), /tool aggregate mismatch/u);
  assert.throws(() => validatePublicEvidence({ ...evidence, cargo_build: { ...evidence.cargo_build, build_observation_sha256: sha256Hex(Buffer.from("changed", "utf8")) } }), /cargo build observation digest mismatch/u);

  const wrongSource = structuredClone(evidence);
  wrongSource.source_materials.files[0].relative_path_sha256 = sha256Hex(Buffer.from("wrong-source", "utf8"));
  wrongSource.source_materials.aggregate_sha256 = hashCanonical(wrongSource.source_materials.files);
  assert.throws(() => validatePublicEvidence(wrongSource), /source material identity or order mismatch/u);

  const duplicatePackage = structuredClone(evidence);
  duplicatePackage.cargo_registry_lock.packages[1] = structuredClone(duplicatePackage.cargo_registry_lock.packages[0]);
  duplicatePackage.cargo_registry_lock.aggregate_sha256 = hashCanonical(duplicatePackage.cargo_registry_lock.packages);
  assert.throws(() => validatePublicEvidence(duplicatePackage), /package identity, order, source, version, or checksum mismatch/u);

  const reorderedTools = structuredClone(evidence);
  [reorderedTools.tool_observations.tools[0], reorderedTools.tool_observations.tools[1]] = [
    reorderedTools.tool_observations.tools[1],
    reorderedTools.tool_observations.tools[0],
  ];
  reorderedTools.tool_observations.aggregate_sha256 = hashCanonical(reorderedTools.tool_observations.tools);
  assert.throws(() => validatePublicEvidence(reorderedTools), /tool identity or order mismatch/u);

  const wrongCargoCommand = structuredClone(evidence);
  wrongCargoCommand.cargo_build.command_sha256 = sha256Hex(Buffer.from("wrong-command", "utf8"));
  wrongCargoCommand.cargo_build.build_observation_sha256 = hashCanonical({
    command_sha256: wrongCargoCommand.cargo_build.command_sha256,
    stderr_sha256: wrongCargoCommand.cargo_build.stderr_sha256,
    message_count: wrongCargoCommand.cargo_build.message_count,
  });
  assert.throws(() => validatePublicEvidence(wrongCargoCommand), /Cargo command or feature identity mismatch/u);
});

test("CLI synthetic and validate-json are deterministic and path-free", async () => {
  const first = await execFileAsync(process.execPath, [MODULE_PATH, "--run-synthetic"], { encoding: "utf8", windowsHide: true });
  const second = await execFileAsync(process.execPath, [MODULE_PATH], { encoding: "utf8", windowsHide: true });
  assert.equal(first.stderr, "");
  assert.equal(second.stderr, "");
  assert.equal(first.stdout, second.stdout);
  assert.match(
    first.stdout,
    /^whisper-fallback-ci-build-output-runtime-identity-attestation=verified evidence_sha256=[0-9a-f]{64} runtime_sha256=[0-9a-f]{64} candidate_aggregate_sha256=[0-9a-f]{64} five_c_runtime_sha256=[0-9a-f]{64} observation_scope=synthetic-injected-harness measurement_status=whisper-ci-build-output-runtime-identity-attestation-only execution_status=ci-built-runtime-path-launched-fixed-version-marker-observed-no-model-no-transcription build_output_identity_attestation=true source_build_provenance_authority=none registry_source_byte_closure=false toolchain_provenance_authority=observed-tool-bytes-only loaded_image_attestation=false network_isolation_authority=none quality_gate_status=not-assessed formal_claims=none production_evidence=false public_distribution=false selection_authority=none fallback_authority=none launch_binding_status=preflight-prespawn-postflight-path-identity-observed-spawn-reopen-window-not-eliminated fixture_scope=synthetic-ci-build-output-runtime-identity-attestation-no-model-no-transcription\r?\n$/u,
  );
});

test("source, package scripts, workflow, and READMEs stay within 5d authority", async () => {
  const source = await readFile(MODULE_PATH, "utf8");
  const imports = [...source.matchAll(/from\s+"(node:[^"]+)"/gu)].map((match) => match[1]).sort();
  assert.deepEqual(imports, [
    "node:child_process",
    "node:crypto",
    "node:fs",
    "node:fs/promises",
    "node:os",
    "node:path",
    "node:stream",
    "node:url",
    "node:util",
  ]);
  assert.doesNotMatch(source, /node:http|node:https|node:net|node:tls|node:dns|\bfetch\s*\(/u);
  assert.match(source, /registry_source_byte_closure: false/u);
  assert.match(source, /source_build_provenance_authority: "none"/u);
  assert.doesNotMatch(source, /\b(?:load_model|transcribe|audio_decode|default_candidate|quality_gate)\s*\(/iu);

  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  assert.equal(packageJson.scripts["phase0:whisper-ci-build-output-runtime-identity:test"], "node --test tools/whisper-native/whisper-fallback-ci-build-output-runtime-identity-attestation.test.mjs");
  assert.equal(packageJson.scripts["phase0:whisper-ci-build-output-runtime-identity:validate"], "node tools/whisper-native/whisper-fallback-ci-build-output-runtime-identity-attestation.mjs --run-synthetic");
  assert.equal(packageJson.scripts["phase0:whisper-ci-build-output-runtime-identity:run"], "node tools/whisper-native/whisper-fallback-ci-build-output-runtime-identity-attestation.mjs --attest");
  const workflow = await readFile(".github/workflows/ci.yml", "utf8");
  assert.match(workflow, /phase0:whisper-ci-build-output-runtime-identity:test/u);
  assert.match(workflow, /phase0:whisper-ci-build-output-runtime-identity:run \$env:GITHUB_SHA \$repositoryRoot/u);
  assert.match(workflow, /observation_scope=windows-ci-clean-exact-head-build-output/u);
  const rootReadme = await readFile("README.md", "utf8");
  assert.match(rootReadme, /WP-0\.4\.5d whisper fallback CI build-output runtime identity attestation/u);
  const toolsReadme = await readFile("tools/whisper-native/README.md", "utf8");
  assert.match(toolsReadme, /WP-0\.4\.5d whisper fallback CI build-output runtime identity attestation/u);
  const crateReadme = await readFile("crates/model-worker-whisper-native/README.md", "utf8");
  assert.match(crateReadme, /build-output runtime identity attestation/u);
});
