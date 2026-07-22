import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { link, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { promisify } from "node:util";

import { encodeCanonicalJson } from "../phase0-harness/canonical-json.mjs";
import {
  FIXED_ARGS,
  EXECUTION_STATUS,
  LAUNCH_BINDING_STATUS,
  MEASUREMENT_STATUS,
  PUBLIC_EVIDENCE_KIND,
  PUBLIC_EVIDENCE_SCHEMA_PATH,
  createSyntheticRuntimeFixture,
  probeWhisperFallbackRuntimeVersion,
  scanForbiddenPublicEvidence,
  sha256Hex,
  validatePublicEvidence,
} from "./whisper-fallback-runtime-version-probe.mjs";
import { preflightWhisperFallbackCandidate, sha256Hex as preflightSha256Hex } from "./whisper-fallback-candidate-preflight.mjs";

const execFileAsync = promisify(execFile);
const MODULE_PATH = "tools/whisper-native/whisper-fallback-runtime-version-probe.mjs";
const GOOD_MARKER =
  "meetingrelay-whisper-runtime-version-probe-v1 linked_whisper_cpp_version=1.8.3 measurement_status=whisper-runtime-version-marker-path-observation-only execution_status=runtime-path-launched-fixed-version-marker-observed-no-model-no-transcription quality_gate_status=not-assessed formal_claims=none production_evidence=false public_distribution=false selection_authority=none fallback_authority=none loaded_image_attestation=false network_isolation_authority=none\n";

async function withFixture(fn) {
  const root = await mkdtemp(path.join(tmpdir(), "meetingrelay-whisper-runtime-probe-test-"));
  try {
    const fixture = await createSyntheticRuntimeFixture(root);
    return await fn(root, fixture);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function fakeSpawn(stdoutText = GOOD_MARKER, options = {}) {
  return (_command, _args, _spawnOptions) => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();
    const listeners = new Map();
    const child = {
      killed: false,
      stdout,
      stderr,
      stdin,
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
      if (options.error) {
        for (const handler of listeners.get("error") ?? []) handler(options.error);
        return;
      }
      stdout.end(stdoutText);
      stderr.end(options.stderr ?? "");
      for (const handler of listeners.get("exit") ?? []) handler(options.code ?? 0, options.signal ?? null);
      for (const handler of listeners.get("close") ?? []) handler(options.code ?? 0, options.signal ?? null);
    });
    return child;
  };
}

function hangingSpawn({ closeOnKill }) {
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
        if (closeOnKill) {
          queueMicrotask(() => {
            stdout.end();
            stderr.end();
            for (const handler of listeners.get("exit") ?? []) handler(null, "SIGTERM");
            for (const handler of listeners.get("close") ?? []) handler(null, "SIGTERM");
          });
        }
        return true;
      },
      on: (event, handler) => {
        if (!listeners.has(event)) listeners.set(event, []);
        listeners.get(event).push(handler);
        return child;
      },
    };
    return child;
  };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function writeManifest(manifestPath, manifest) {
  await writeFile(manifestPath, encodeCanonicalJson(manifest), "utf8");
}

test("runtime probe joins 5b preflight aggregate to manifest runtime identity and deterministic version marker digests", async () => {
  await withFixture(async (root, fixture) => {
    const left = await probeWhisperFallbackRuntimeVersion(root, fixture.manifestPath, fixture.executablePath, fixture.candidateAggregateSha256, {
      spawnImpl: fakeSpawn(),
    });
    const right = await probeWhisperFallbackRuntimeVersion(root, fixture.manifestPath, fixture.executablePath, fixture.candidateAggregateSha256, {
      spawnImpl: fakeSpawn(),
    });
    assert.deepEqual(left, right);
    assert.equal(left.kind, PUBLIC_EVIDENCE_KIND);
    assert.equal(left.measurement_status, MEASUREMENT_STATUS);
    assert.equal(left.execution_status, EXECUTION_STATUS);
    assert.equal(left.quality_gate_status, "not-assessed");
    assert.equal(left.formal_claims, "none");
    assert.equal(left.production_evidence, false);
    assert.equal(left.public_distribution, false);
    assert.equal(left.selection_authority, "none");
    assert.equal(left.fallback_authority, "none");
    assert.equal(left.launch_binding_status, LAUNCH_BINDING_STATUS);
    assert.equal(left.loaded_image_attestation, false);
    assert.equal(left.network_isolation_authority, "none");
    assert.equal(left.worker_role, "whisper-fallback-candidate");
    assert.equal(left.runtime.role, "runtime");
    assert.equal(left.runtime.sha256, fixture.manifest.files.find((entry) => entry.role === "runtime").sha256);
    assert.equal(left.runtime.before_after_identity_match, true);
    assert.equal(left.process_contract.spawn_path_reopen_window_eliminated, false);
    assert.equal(left.probe.fixed_arguments_sha256, sha256(Buffer.from(encodeCanonicalJson(FIXED_ARGS), "utf8")));
    assert.equal(left.probe.stdout_marker_sha256, sha256(Buffer.from(GOOD_MARKER, "utf8")));
    assert.equal(left.probe.linked_version_sha256, sha256(Buffer.from("1.8.3", "utf8")));
    assert.doesNotThrow(() => validatePublicEvidence(left));
    const serialized = JSON.stringify(left);
    for (const forbidden of [root, "inputs/", "runtime-probe", "linked_whisper_cpp_version", "1.8.3"]) {
      assert.equal(serialized.includes(forbidden), false, forbidden);
    }
  });
});

test("schema parity mirrors runtime probe validator constants", async () => {
  const schema = JSON.parse(await readFile(PUBLIC_EVIDENCE_SCHEMA_PATH, "utf8"));
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.kind.const, PUBLIC_EVIDENCE_KIND);
  assert.equal(schema.properties.measurement_status.const, MEASUREMENT_STATUS);
  assert.equal(schema.properties.execution_status.const, EXECUTION_STATUS);
  assert.equal(schema.properties.public_distribution.const, false);
  assert.equal(schema.properties.selection_authority.const, "none");
  assert.equal(schema.properties.fallback_authority.const, "none");
  assert.equal(schema.properties.launch_binding_status.const, LAUNCH_BINDING_STATUS);
  assert.equal(schema.properties.loaded_image_attestation.const, false);
  assert.equal(schema.properties.network_isolation_authority.const, "none");
  assert.equal(schema.properties.worker_role.const, "whisper-fallback-candidate");
  assert.equal(schema.properties.probe.properties.fixed_argument_count.const, 1);
  assert.equal(schema.properties.probe.properties.fixed_arguments_sha256.const, sha256(Buffer.from(encodeCanonicalJson(FIXED_ARGS), "utf8")));
  assert.equal(schema.properties.runtime.properties.size_bytes.maximum, 8 * 1024 * 1024 * 1024);
});

test("expected aggregate mismatch fails before launch", async () => {
  await withFixture(async (root, fixture) => {
    let launched = false;
    await assert.rejects(
      () =>
        probeWhisperFallbackRuntimeVersion(root, fixture.manifestPath, fixture.executablePath, "f".repeat(64), {
          spawnImpl: () => {
            launched = true;
            return fakeSpawn()();
          },
        }),
      /WHISPER_RUNTIME_PROBE_AGGREGATE/u,
    );
    assert.equal(launched, false);
  });
});

test("explicit executable must exactly match manifest runtime role file", async () => {
  await withFixture(async (root, fixture) => {
    const other = path.join(root, "inputs", "other-runtime.cmd");
    await writeFile(other, GOOD_MARKER, "utf8");
    await assert.rejects(
      () => probeWhisperFallbackRuntimeVersion(root, fixture.manifestPath, other, fixture.candidateAggregateSha256, { spawnImpl: fakeSpawn() }),
      /WHISPER_RUNTIME_PROBE_EXECUTABLE_MISMATCH/u,
    );
  });
});

test("runtime size or hash drift fails closed before launch", async () => {
  await withFixture(async (root, fixture) => {
    await writeFile(fixture.executablePath, "changed-runtime-bytes\n", "utf8");
    await assert.rejects(
      () => probeWhisperFallbackRuntimeVersion(root, fixture.manifestPath, fixture.executablePath, fixture.candidateAggregateSha256, { spawnImpl: fakeSpawn() }),
      /WHISPER_PREFLIGHT_(SIZE|HASH)_DRIFT/u,
    );
  });
});

test("runtime hashing remains streaming for inputs larger than one MiB", async () => {
  await withFixture(async (root, fixture) => {
    const bytes = Buffer.alloc(1024 * 1024 + 17, 0x61);
    await writeFile(fixture.executablePath, bytes);
    const runtime = fixture.manifest.files.find((entry) => entry.role === "runtime");
    runtime.sha256 = preflightSha256Hex(bytes);
    runtime.size_bytes = bytes.length;
    await writeManifest(fixture.manifestPath, fixture.manifest);
    const preflight = await preflightWhisperFallbackCandidate(root, fixture.manifestPath);
    const evidence = await probeWhisperFallbackRuntimeVersion(
      root,
      fixture.manifestPath,
      fixture.executablePath,
      preflight.candidate_descriptor.aggregate_sha256,
      { spawnImpl: fakeSpawn() },
    );
    assert.equal(evidence.runtime.size_bytes, bytes.length);
    assert.equal(evidence.runtime.sha256, runtime.sha256);
  });
});

test("drift before the immediate pre-spawn check fails before launch", async () => {
  await withFixture(async (root, fixture) => {
    let launched = false;
    await assert.rejects(
      () =>
        probeWhisperFallbackRuntimeVersion(root, fixture.manifestPath, fixture.executablePath, fixture.candidateAggregateSha256, {
          beforePreSpawnCheckForTest: async () => writeFile(fixture.executablePath, "pre-spawn-drift\n", "utf8"),
          spawnImpl: () => {
            launched = true;
            return fakeSpawn()();
          },
        }),
      /WHISPER_RUNTIME_PROBE_RUNTIME_DRIFT/u,
    );
    assert.equal(launched, false);
  });
});

test("the disclosed spawn reopen window still fails postflight when the path changes", async () => {
  await withFixture(async (root, fixture) => {
    let launched = false;
    await assert.rejects(
      () =>
        probeWhisperFallbackRuntimeVersion(root, fixture.manifestPath, fixture.executablePath, fixture.candidateAggregateSha256, {
          afterPreSpawnCheckForTest: async () => writeFile(fixture.executablePath, "spawn-window-drift\n", "utf8"),
          spawnImpl: (...args) => {
            launched = true;
            return fakeSpawn()(...args);
          },
        }),
      /WHISPER_RUNTIME_PROBE_RUNTIME_DRIFT/u,
    );
    assert.equal(launched, true);
  });
});

test("runtime hardlinks are rejected where the platform reports them", async (context) => {
  await withFixture(async (root, fixture) => {
    const hardlinkPath = path.join(root, "inputs", "runtime-hardlink");
    try {
      await link(fixture.executablePath, hardlinkPath);
    } catch (error) {
      context.skip(`hardlink creation unavailable: ${error.code ?? error.message}`);
      return;
    }
    const manifest = JSON.parse(JSON.stringify(fixture.manifest));
    const runtime = manifest.files.find((entry) => entry.role === "runtime");
    const bytes = await readFile(hardlinkPath);
    runtime.relative_path = "inputs/runtime-hardlink";
    runtime.sha256 = preflightSha256Hex(bytes);
    runtime.size_bytes = bytes.length;
    await writeManifest(fixture.manifestPath, manifest);
    const preflight = await preflightWhisperFallbackCandidate(root, fixture.manifestPath).catch((error) => error);
    if (preflight instanceof Error) {
      assert.match(preflight.message, /WHISPER_PREFLIGHT_SPECIAL_FILE/u);
      return;
    }
    await assert.rejects(
      () => probeWhisperFallbackRuntimeVersion(root, fixture.manifestPath, hardlinkPath, preflight.candidate_descriptor.aggregate_sha256, { spawnImpl: fakeSpawn() }),
      /WHISPER_RUNTIME_PROBE_SPECIAL_FILE/u,
    );
  });
});

test("a hardlink added after the runtime handle opens is rejected", async (context) => {
  await withFixture(async (root, fixture) => {
    const hardlinkPath = path.join(root, "inputs", "runtime-after-open-hardlink");
    try {
      await link(fixture.executablePath, hardlinkPath);
      await rm(hardlinkPath);
    } catch (error) {
      context.skip(`hardlink creation unavailable: ${error.code ?? error.message}`);
      return;
    }
    let launched = false;
    await assert.rejects(
      () =>
        probeWhisperFallbackRuntimeVersion(root, fixture.manifestPath, fixture.executablePath, fixture.candidateAggregateSha256, {
          afterRuntimeOpenForTest: async (absolute) => link(absolute, hardlinkPath),
          spawnImpl: () => {
            launched = true;
            return fakeSpawn()();
          },
        }),
      /WHISPER_RUNTIME_PROBE_SPECIAL_FILE|WHISPER_RUNTIME_PROBE_RUNTIME_DRIFT/u,
    );
    assert.equal(launched, false);
  });
});

test("runtime symlink or junction paths are rejected where supported", async (context) => {
  await withFixture(async (root, fixture) => {
    const linkPath = path.join(root, "inputs", "runtime-link");
    try {
      await symlink(fixture.executablePath, linkPath);
    } catch (error) {
      context.skip(`symlink creation unavailable: ${error.code ?? error.message}`);
      return;
    }
    const manifest = JSON.parse(JSON.stringify(fixture.manifest));
    const runtime = manifest.files.find((entry) => entry.role === "runtime");
    runtime.relative_path = "inputs/runtime-link";
    await writeManifest(fixture.manifestPath, manifest);
    await assert.rejects(
      () => probeWhisperFallbackRuntimeVersion(root, fixture.manifestPath, linkPath, fixture.candidateAggregateSha256, { spawnImpl: fakeSpawn() }),
      /WHISPER_(PREFLIGHT|RUNTIME_PROBE)_SPECIAL_FILE|WHISPER_RUNTIME_PROBE_AGGREGATE/u,
    );
  });
});

test("ambiguous stdout, stderr, nonzero exit, and overflow are rejected", async () => {
  const cases = [
    ["bad stdout", "unexpected\n", {}, /WHISPER_RUNTIME_PROBE_STDOUT_AMBIGUOUS/u],
    ["duplicate stdout", `${GOOD_MARKER}${GOOD_MARKER}`, {}, /WHISPER_RUNTIME_PROBE_STDOUT_AMBIGUOUS/u],
    ["stderr", GOOD_MARKER, { stderr: "warn\n" }, /WHISPER_RUNTIME_PROBE_STDERR_NONEMPTY/u],
    ["nonzero", GOOD_MARKER, { code: 2 }, /WHISPER_RUNTIME_PROBE_NONZERO_EXIT/u],
    ["overflow", "x".repeat(5000), {}, /WHISPER_RUNTIME_PROBE_STDOUT_OVERFLOW/u],
  ];
  for (const [name, stdout, options, pattern] of cases) {
    await test(name, async () => {
      await withFixture(async (root, fixture) => {
        await assert.rejects(
          () =>
            probeWhisperFallbackRuntimeVersion(root, fixture.manifestPath, fixture.executablePath, fixture.candidateAggregateSha256, {
              spawnImpl: fakeSpawn(stdout, options),
            }),
          pattern,
        );
      });
    });
  }
});

test("timeouts terminate a closing child and fail closed when cleanup cannot observe close", async () => {
  await withFixture(async (root, fixture) => {
    await assert.rejects(
      () =>
        probeWhisperFallbackRuntimeVersion(root, fixture.manifestPath, fixture.executablePath, fixture.candidateAggregateSha256, {
          spawnImpl: hangingSpawn({ closeOnKill: true }),
          timeoutMs: 5,
          cleanupTimeoutMs: 50,
        }),
      /WHISPER_RUNTIME_PROBE_TIMEOUT/u,
    );
    await assert.rejects(
      () =>
        probeWhisperFallbackRuntimeVersion(root, fixture.manifestPath, fixture.executablePath, fixture.candidateAggregateSha256, {
          spawnImpl: hangingSpawn({ closeOnKill: false }),
          timeoutMs: 5,
          cleanupTimeoutMs: 10,
        }),
      /WHISPER_RUNTIME_PROBE_DIRECT_CHILD_CLOSE_TIMEOUT/u,
    );
  });
});

test("manifest and evidence reject execution, distribution, fallback, and claim overreach", async () => {
  await withFixture(async (root, fixture) => {
    const manifest = JSON.parse(JSON.stringify(fixture.manifest));
    manifest.public_distribution = true;
    await writeManifest(fixture.manifestPath, manifest);
    await assert.rejects(
      () => probeWhisperFallbackRuntimeVersion(root, fixture.manifestPath, fixture.executablePath, fixture.candidateAggregateSha256, { spawnImpl: fakeSpawn() }),
      /WHISPER_PREFLIGHT_OVERCLAIM/u,
    );
    const fresh = await createSyntheticRuntimeFixture(root);
    const evidence = await probeWhisperFallbackRuntimeVersion(root, fresh.manifestPath, fresh.executablePath, fresh.candidateAggregateSha256, { spawnImpl: fakeSpawn() });
    assert.throws(() => validatePublicEvidence({ ...evidence, public_distribution: true }), /WHISPER_RUNTIME_PROBE_EVIDENCE_OVERCLAIM/u);
    assert.throws(() => validatePublicEvidence({ ...evidence, execution_status: "model-loaded" }), /WHISPER_RUNTIME_PROBE_EVIDENCE_OVERCLAIM/u);
  });
});

test("public evidence scanner rejects paths, stdout text, versions, transcripts, and secret markers", () => {
  assert.throws(() => scanForbiddenPublicEvidence({ path: "hidden" }), /WHISPER_RUNTIME_PROBE_EVIDENCE_FORBIDDEN/u);
  assert.throws(() => scanForbiddenPublicEvidence({ safe: "C:\\secret\\runtime.exe" }), /WHISPER_RUNTIME_PROBE_EVIDENCE_FORBIDDEN/u);
  assert.throws(() => scanForbiddenPublicEvidence({ safe: "BEGIN PRIVATE KEY" }), /WHISPER_RUNTIME_PROBE_EVIDENCE_FORBIDDEN/u);
  assert.throws(() => scanForbiddenPublicEvidence({ safe: "transcript output" }), /WHISPER_RUNTIME_PROBE_EVIDENCE_FORBIDDEN/u);
  assert.throws(() => scanForbiddenPublicEvidence({ linked_whisper_cpp_version: "1.8.3" }), /WHISPER_RUNTIME_PROBE_EVIDENCE_FORBIDDEN/u);
});

test("CLI run and validate emit strict deterministic synthetic markers", async () => {
  const first = await execFileAsync(process.execPath, [MODULE_PATH], { encoding: "utf8", windowsHide: true });
  const second = await execFileAsync(process.execPath, [MODULE_PATH, "--run-synthetic"], { encoding: "utf8", windowsHide: true });
  assert.equal(first.stderr, "");
  assert.equal(second.stderr, "");
  assert.match(
    first.stdout,
    /^whisper-fallback-runtime-version-probe=verified evidence_sha256=[0-9a-f]{64} candidate_aggregate_sha256=[0-9a-f]{64} runtime_sha256=[0-9a-f]{64} stdout_marker_sha256=[0-9a-f]{64} linked_version_sha256=[0-9a-f]{64} measurement_status=whisper-runtime-version-marker-path-observation-only execution_status=runtime-path-launched-fixed-version-marker-observed-no-model-no-transcription quality_gate_status=not-assessed formal_claims=none production_evidence=false public_distribution=false selection_authority=none fallback_authority=none launch_binding_status=preflight-prespawn-postflight-path-identity-observed-spawn-reopen-window-not-eliminated loaded_image_attestation=false network_isolation_authority=none fixture_scope=synthetic-runtime-version-marker-path-observation-no-model-no-transcription\r?\n$/u,
  );
  assert.equal(first.stdout, second.stdout);
});

test("CLI rejects unknown arguments with empty stdout", async () => {
  const result = await execFileAsync(process.execPath, [MODULE_PATH, "--unknown"], {
    encoding: "utf8",
    windowsHide: true,
  }).catch((error) => error);
  assert.equal(result.stdout ?? "", "");
  assert.match(result.stderr, /WHISPER_RUNTIME_PROBE_USAGE: WHISPER_RUNTIME_PROBE_USAGE/u);
  assert.equal(result.code, 1);
});

test("source, package scripts, workflow, and READMEs stay within runtime-version-probe authority", async () => {
  const source = await readFile(MODULE_PATH, "utf8");
  const imports = [...source.matchAll(/from\s+"(node:[^"]+)"/gu)].map((match) => match[1]).sort();
  assert.deepEqual(imports, ["node:child_process", "node:crypto", "node:fs", "node:fs/promises", "node:os", "node:path", "node:stream", "node:url", "node:util"]);
  assert.doesNotMatch(source, /node:http|node:https|node:net|node:tls|node:dns/u);
  assert.doesNotMatch(source, /\b(?:execFile|fetch|importScripts)\s*\(/u);
  assert.doesNotMatch(source, /\b(?:load_model|transcribe|audio_decode|default_candidate|quality_gate|WER|CER)\s*\(/iu);
  const runtimeHasher = source.slice(source.indexOf("async function hashRegularFileNoLinks"), source.indexOf("function minimalEnv"));
  assert.match(runtimeHasher, /STREAM_CHUNK_BYTES/u);
  assert.doesNotMatch(runtimeHasher, /handle\.readFile/u);

  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  assert.equal(packageJson.scripts["phase0:whisper-runtime-version-probe:test"], "node --test tools/whisper-native/whisper-fallback-runtime-version-probe.test.mjs");
  assert.equal(packageJson.scripts["phase0:whisper-runtime-version-probe:validate"], "node tools/whisper-native/whisper-fallback-runtime-version-probe.mjs --run-synthetic");
  const workflow = await readFile(".github/workflows/ci.yml", "utf8");
  assert.match(workflow, /phase0:whisper-runtime-version-probe:test/u);
  assert.match(workflow, /meetingrelay-whisper-runtime-version-probe/u);
  const rootReadme = await readFile("README.md", "utf8");
  assert.match(rootReadme, /README\.phase0-archive\.md/u);
  assert.match(rootReadme, /Optional Hardening \/ Archived Phase 0/u);
  const archivedReadme = await readFile("README.phase0-archive.md", "utf8");
  assert.match(archivedReadme, /WP-0\.4\.5c whisper fallback runtime version probe/u);
  const crateReadme = await readFile("crates/model-worker-whisper-native/README.md", "utf8");
  assert.match(crateReadme, /meetingrelay-whisper-runtime-version-probe/u);
  assert.equal(sha256Hex(Buffer.from("abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("Rust probe source exposes only the fixed version-probe argument and bounded authority strings", async () => {
  const source = await readFile("crates/model-worker-whisper-native/src/bin/meetingrelay_whisper_runtime_version_probe.rs", "utf8");
  assert.match(source, /--meetingrelay-whisper-runtime-version-probe-v1/u);
  assert.match(source, /linked_whisper_cpp_version/u);
  assert.match(source, /runtime-path-launched-fixed-version-marker-observed-no-model-no-transcription/u);
  assert.match(source, /loaded_image_attestation=false network_isolation_authority=none/u);
  assert.doesNotMatch(source, /\b(?:load_model|transcribe|audio_decode|ModelBackend|download|fetch)\b/iu);
});
