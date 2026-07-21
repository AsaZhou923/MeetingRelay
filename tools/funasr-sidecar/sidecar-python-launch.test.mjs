import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import { promisify } from "node:util";

import { encodeCanonicalJson } from "../phase0-harness/canonical-json.mjs";
import { REQUIRED_ROLES, preflightCandidate, sha256Hex } from "./sidecar-candidate-preflight.mjs";
import {
  FIXED_ARGS,
  FIXED_PROBE_SHA256,
  FIXED_PROBE_SOURCE,
  PUBLIC_EVIDENCE_KIND,
  PUBLIC_EVIDENCE_SCHEMA_PATH,
  launchPythonCandidate,
  pathsEqualForPlatform,
  validatePublicEvidence,
} from "./sidecar-python-launch.mjs";
import { encodeFrame } from "./sidecar-wire-foundation.mjs";

const execFileAsync = promisify(execFile);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function discoverHostPython() {
  const candidates =
    process.platform === "win32"
      ? [
          { command: "python", prefix: [] },
          { command: "py", prefix: ["-3"] },
        ]
      : [
          { command: "python3", prefix: [] },
          { command: "python", prefix: [] },
        ];
  for (const candidate of candidates) {
    const result = await execFileAsync(candidate.command, [...candidate.prefix, "-c", "import sys; raise SystemExit(0 if sys.version_info >= (3,8) else 1)"], {
      encoding: "utf8",
      windowsHide: true,
    }).catch(() => undefined);
    if (result) return candidate;
  }
  throw new Error("host Python 3.8+ is required for the WP-0.4.4c positive launch test");
}

async function writeCanonicalManifest(root, files) {
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
  manifest.files.sort((a, b) => a.role.localeCompare(b.role));
  const manifestPath = path.join(root, "input-manifest.json");
  await writeFile(manifestPath, encodeCanonicalJson(manifest), "utf8");
  return { manifest, manifestPath };
}

async function addManifestFile(root, files, role, relativePath, bytes) {
  const absolute = path.join(root, ...relativePath.split("/"));
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, bytes);
  files.push({
    role,
    logical_id: `launch-${role}`,
    relative_path: relativePath,
    sha256: sha256(bytes),
    size_bytes: bytes.length,
  });
  return absolute;
}

async function withSyntheticExecutableFixture(fn) {
  const root = await mkdtemp(path.join(tmpdir(), "meetingrelay-python-launch-fixture-"));
  try {
    const files = [];
    for (const role of REQUIRED_ROLES) {
      if (role === "runtime") continue;
      await addManifestFile(root, files, role, `inputs/${role}.bin`, Buffer.from(`synthetic ${role} bytes\n`, "utf8"));
    }
    const executablePath = await addManifestFile(root, files, "runtime", "venv/Scripts/python.exe", Buffer.from("synthetic executable bytes\n", "utf8"));
    const fixture = await writeCanonicalManifest(root, files);
    const preflight = await preflightCandidate(root, fixture.manifestPath);
    return await fn(root, { ...fixture, executablePath, aggregate: preflight.candidate_descriptor.aggregate_sha256 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function withVenvFixture(fn) {
  const root = await mkdtemp(path.join(tmpdir(), "meetingrelay-python-launch-venv-"));
  try {
    const host = await discoverHostPython();
    const venvRoot = path.join(root, "venv");
    await execFileAsync(host.command, [...host.prefix, "-m", "venv", venvRoot], { encoding: "utf8", windowsHide: true });
    const executablePath = process.platform === "win32" ? path.join(venvRoot, "Scripts", "python.exe") : path.join(venvRoot, "bin", "python");
    const runtimeBytes = await readFile(executablePath);
    const files = [];
    for (const role of REQUIRED_ROLES) {
      if (role === "runtime") continue;
      await addManifestFile(root, files, role, `inputs/${role}.bin`, Buffer.from(`synthetic ${role} bytes\n`, "utf8"));
    }
    files.push({
      role: "runtime",
      logical_id: "launch-runtime",
      relative_path: process.platform === "win32" ? "venv/Scripts/python.exe" : "venv/bin/python",
      sha256: sha256(runtimeBytes),
      size_bytes: runtimeBytes.length,
    });
    const fixture = await writeCanonicalManifest(root, files);
    const preflight = await preflightCandidate(root, fixture.manifestPath);
    return await fn(root, { ...fixture, executablePath, aggregate: preflight.candidate_descriptor.aggregate_sha256 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function fakeChild({ stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), code = 0, delayClose = false } = {}) {
  const child = new EventEmitter();
  child.stdin = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    if (!delayClose) {
      queueMicrotask(() => {
        child.emit("exit", null, "SIGTERM");
        child.emit("close");
      });
    }
    return true;
  };
  queueMicrotask(() => {
    if (stdout.length) child.stdout.write(stdout);
    if (stderr.length) child.stderr.write(stderr);
    if (!delayClose) {
      child.emit("exit", code, null);
      child.emit("close");
    }
  });
  return child;
}

function goodResponseBytes() {
  return encodeFrame({ type: "hello_ok", sequence: 1, role: "sidecar-candidate", transport: "isolated-process" }, Buffer.alloc(0), {
    maxPayloadBytes: 0,
  });
}

test("actual venv Python launch emits deterministic path-free public evidence", async () => {
  await withVenvFixture(async (root, fixture) => {
    const left = await launchPythonCandidate(root, fixture.manifestPath, fixture.executablePath, fixture.aggregate);
    const right = await launchPythonCandidate(root, fixture.manifestPath, fixture.executablePath, fixture.aggregate);
    assert.deepEqual(left, right);
    assert.equal(left.kind, PUBLIC_EVIDENCE_KIND);
    assert.equal(left.measurement_status, "python-launch-probe-only");
    assert.equal(left.execution_status, "interpreter-launched-no-funasr");
    assert.equal(left.quality_gate_status, "not-assessed");
    assert.equal(left.formal_claims, "none");
    assert.equal(left.production_evidence, false);
    assert.equal(left.public_distribution, false);
    assert.equal(left.selection_authority, "none");
    assert.equal(left.packaging_authority, "none");
    assert.equal(left.probe.fixed_probe_sha256, FIXED_PROBE_SHA256);
    assert.equal(left.process_contract.shell, false);
    assert.equal(left.process_contract.windowsHide, true);
    assert.equal(left.process_contract.detached, false);
    assert.equal(left.process_contract.root_before_after_identity_match, true);
    assert.doesNotThrow(() => validatePublicEvidence(left));
    const serialized = JSON.stringify(left);
    for (const forbidden of [root, "inputs/", "runtime.bin", "python.exe", "synthetic model bytes"]) {
      assert.equal(serialized.includes(forbidden), false, forbidden);
    }
  });
});

test("CLI launch emits strict marker and rejects usage drift", async () => {
  const synthetic = await execFileAsync(process.execPath, ["tools/funasr-sidecar/sidecar-python-launch.mjs", "--run-synthetic"], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(synthetic.stderr, "");
  assert.match(
    synthetic.stdout,
    /^funasr-sidecar-python-launch=verified evidence_sha256=[0-9a-f]{64} candidate_aggregate_sha256=[0-9a-f]{64} runtime_sha256=[0-9a-f]{64} fixed_probe_sha256=[0-9a-f]{64} one_frame_transcript_sha256=[0-9a-f]{64} measurement_status=python-launch-probe-only execution_status=interpreter-launched-no-funasr quality_gate_status=not-assessed formal_claims=none production_evidence=false public_distribution=false selection_authority=none packaging_authority=none fixture_scope=test-only-venv-not-packaging-choice\r?\n$/u,
  );
  await withVenvFixture(async (root, fixture) => {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["tools/funasr-sidecar/sidecar-python-launch.mjs", "--launch", root, fixture.manifestPath, fixture.executablePath, fixture.aggregate],
      { encoding: "utf8", windowsHide: true },
    );
    assert.equal(stderr, "");
    assert.match(
      stdout,
      /^funasr-sidecar-python-launch=verified evidence_sha256=[0-9a-f]{64} candidate_aggregate_sha256=[0-9a-f]{64} runtime_sha256=[0-9a-f]{64} fixed_probe_sha256=[0-9a-f]{64} one_frame_transcript_sha256=[0-9a-f]{64} measurement_status=python-launch-probe-only execution_status=interpreter-launched-no-funasr quality_gate_status=not-assessed formal_claims=none production_evidence=false public_distribution=false selection_authority=none packaging_authority=none\r?\n$/u,
    );
  });
  const result = await execFileAsync(process.execPath, ["tools/funasr-sidecar/sidecar-python-launch.mjs", "--launch"], {
    encoding: "utf8",
    windowsHide: true,
  }).catch((error) => error);
  assert.equal(result.stdout ?? "", "");
  assert.match(result.stderr, /PYTHON_LAUNCH_USAGE/u);
  const noArgs = await execFileAsync(process.execPath, ["tools/funasr-sidecar/sidecar-python-launch.mjs"], {
    encoding: "utf8",
    windowsHide: true,
  }).catch((error) => error);
  assert.equal(noArgs.stdout ?? "", "");
  assert.match(noArgs.stderr, /PYTHON_LAUNCH_USAGE/u);
});

test("aggregate, manifest hash, executable root, wrong path, and runtime drift fail closed", async () => {
  await withSyntheticExecutableFixture(async (root, fixture) => {
    await assert.rejects(() => launchPythonCandidate(root, fixture.manifestPath, fixture.executablePath, "f".repeat(64), { spawnImpl: () => fakeChild({ stdout: goodResponseBytes() }) }), /PYTHON_LAUNCH_AGGREGATE/u);
    const outsideRoot = await mkdtemp(path.join(tmpdir(), "meetingrelay-outside-python-"));
    try {
      const outside = path.join(outsideRoot, "python.exe");
      await writeFile(outside, "outside\n", "utf8");
      await assert.rejects(() => launchPythonCandidate(root, fixture.manifestPath, outside, fixture.aggregate, { spawnImpl: () => fakeChild({ stdout: goodResponseBytes() }) }), /PYTHON_LAUNCH_EXECUTABLE_MISMATCH/u);
    } finally {
      await rm(outsideRoot, { recursive: true, force: true });
    }
    const wrong = path.join(root, "inputs", "model.bin");
    await assert.rejects(() => launchPythonCandidate(root, fixture.manifestPath, wrong, fixture.aggregate, { spawnImpl: () => fakeChild({ stdout: goodResponseBytes() }) }), /PYTHON_LAUNCH_EXECUTABLE_MISMATCH/u);
    await writeFile(fixture.executablePath, "changed executable bytes\n", "utf8");
    await assert.rejects(() => launchPythonCandidate(root, fixture.manifestPath, fixture.executablePath, fixture.aggregate, { spawnImpl: () => fakeChild({ stdout: goodResponseBytes() }) }), /IDENTITY_PREFLIGHT_(SIZE|HASH)_DRIFT/u);
  });
});

test("post-spawn runtime and controlled-root drift fail closed", async () => {
  await withSyntheticExecutableFixture(async (root, fixture) => {
    await assert.rejects(
      () =>
        launchPythonCandidate(root, fixture.manifestPath, fixture.executablePath, fixture.aggregate, {
          spawnImpl: () => {
            writeFileSync(fixture.executablePath, Buffer.alloc(fixture.manifest.files.find((entry) => entry.role === "runtime").size_bytes, 0x41));
            return fakeChild({ stdout: goodResponseBytes() });
          },
        }),
      /PYTHON_LAUNCH_RUNTIME_DRIFT/u,
    );
  });
  await withSyntheticExecutableFixture(async (root, fixture) => {
    const originalBytes = readFileSync(fixture.executablePath);
    await assert.rejects(
      () =>
        launchPythonCandidate(root, fixture.manifestPath, fixture.executablePath, fixture.aggregate, {
          spawnImpl: () => {
            rmSync(fixture.executablePath, { force: true });
            writeFileSync(fixture.executablePath, originalBytes);
            return fakeChild({ stdout: goodResponseBytes() });
          },
        }),
      /PYTHON_LAUNCH_RUNTIME_DRIFT/u,
    );
  });
  await withSyntheticExecutableFixture(async (root, fixture) => {
    await assert.rejects(
      () =>
        launchPythonCandidate(root, fixture.manifestPath, fixture.executablePath, fixture.aggregate, {
          spawnImpl: () => {
            rmSync(root, { recursive: true, force: true });
            mkdirSync(root, { recursive: true });
            return fakeChild({ stdout: goodResponseBytes() });
          },
        }),
      /PYTHON_LAUNCH_ROOT_DRIFT/u,
    );
  });
});

test("symlink or junction executable paths are rejected where available", async () => {
  await withSyntheticExecutableFixture(async (root, fixture) => {
    const link = path.join(root, "venv", "Scripts", "python-link.exe");
    let linkRelative = "venv/Scripts/python-link.exe";
    try {
      await symlink(fixture.executablePath, link);
    } catch (error) {
      if (process.platform !== "win32" || error.code !== "EPERM") throw error;
      const junction = path.join(root, "junction-venv");
      await symlink(path.join(root, "venv"), junction, "junction");
      linkRelative = "junction-venv/Scripts/python.exe";
    }
    const manifest = JSON.parse(JSON.stringify(fixture.manifest));
    const runtime = manifest.files.find((entry) => entry.role === "runtime");
    runtime.relative_path = linkRelative;
    await writeFile(fixture.manifestPath, encodeCanonicalJson(manifest), "utf8");
    await assert.rejects(() => preflightCandidate(root, fixture.manifestPath), /IDENTITY_PREFLIGHT_SPECIAL_FILE/u);
  });
});

test("process failures are stable through test-only spawn injection", async () => {
  await withSyntheticExecutableFixture(async (root, fixture) => {
    const cases = [
      ["nonzero", () => fakeChild({ stdout: goodResponseBytes(), code: 3 }), /PYTHON_LAUNCH_NONZERO_EXIT/u],
      ["stderr", () => fakeChild({ stdout: goodResponseBytes(), stderr: Buffer.from("err") }), /PYTHON_LAUNCH_STDERR_NONEMPTY/u],
      ["stdout overflow", () => fakeChild({ stdout: Buffer.alloc(32, 0x41) }), /PYTHON_LAUNCH_STDOUT_OVERFLOW/u, { maxStdoutBytes: 8 }],
      ["malformed", () => fakeChild({ stdout: Buffer.from("bad") }), /SIDECAR_WIRE_FRAME_TOO_SHORT/u],
      ["extra response", () => fakeChild({ stdout: Buffer.concat([goodResponseBytes(), goodResponseBytes()]) }), /PYTHON_LAUNCH_RESPONSE_COUNT/u],
      ["timeout cleanup", () => fakeChild({ delayClose: true }), /PYTHON_LAUNCH_DIRECT_CHILD_CLOSE_TIMEOUT/u, { timeoutMs: 10, cleanupTimeoutMs: 10 }],
    ];
    for (const [name, spawnImpl, pattern, options = {}] of cases) {
      await assert.rejects(
        () => launchPythonCandidate(root, fixture.manifestPath, fixture.executablePath, fixture.aggregate, { ...options, spawnImpl }),
        pattern,
        name,
      );
    }
  });
});

test("schema mirrors validator constants and evidence rejects overclaim or forbidden public material", async () => {
  assert.equal(pathsEqualForPlatform("venv/bin/python", "venv/bin/Python", "linux"), false);
  assert.equal(pathsEqualForPlatform("venv\\Scripts\\python.exe", "venv\\Scripts\\PYTHON.exe", "win32"), true);
  const schema = JSON.parse(await readFile(PUBLIC_EVIDENCE_SCHEMA_PATH, "utf8"));
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.kind.const, PUBLIC_EVIDENCE_KIND);
  assert.equal(schema.properties.measurement_status.const, "python-launch-probe-only");
  assert.equal(schema.properties.execution_status.const, "interpreter-launched-no-funasr");
  assert.equal(schema.properties.quality_gate_status.const, "not-assessed");
  assert.equal(schema.properties.formal_claims.const, "none");
  assert.equal(schema.properties.production_evidence.const, false);
  assert.equal(schema.properties.public_distribution.const, false);
  assert.equal(schema.properties.selection_authority.const, "none");
  assert.equal(schema.properties.packaging_authority.const, "none");
  assert.equal(schema.properties.process_contract.properties.root_before_after_identity_match.const, true);
  assert.equal(schema.properties.limitations.minItems, 6);
  await withSyntheticExecutableFixture(async (root, fixture) => {
    const evidence = await launchPythonCandidate(root, fixture.manifestPath, fixture.executablePath, fixture.aggregate, {
      spawnImpl: (command, args, options) => {
        assert.equal(command, fixture.executablePath);
        assert.deepEqual(args, [...FIXED_ARGS, FIXED_PROBE_SOURCE]);
        assert.equal(options.shell, false);
        assert.equal(options.windowsHide, true);
        assert.equal(options.detached, false);
        assert.equal(options.cwd, root);
        assert.deepEqual(Object.keys(options.env).sort(), process.platform === "win32" ? ["PATH", "SystemRoot", "WINDIR"] : ["PATH"]);
        assert.equal("PYTHONPATH" in options.env, false);
        assert.equal("PYTHONHOME" in options.env, false);
        assert.equal("PIP_CACHE_DIR" in options.env, false);
        assert.equal("HTTP_PROXY" in options.env, false);
        return fakeChild({ stdout: goodResponseBytes() });
      },
    });
    assert.throws(() => validatePublicEvidence({ ...evidence, production_evidence: true }), /PYTHON_LAUNCH_EVIDENCE_OVERCLAIM/u);
    assert.throws(
      () => validatePublicEvidence({ ...evidence, probe: { ...evidence.probe, request_frame_sha256: "f".repeat(64) } }),
      /PYTHON_LAUNCH_EVIDENCE_SCHEMA/u,
    );
    assert.equal(evidence.limitations.some((item) => item.includes("FunASR import") && item.includes("ranking")), true);
    assert.throws(() => validatePublicEvidence({ ...evidence, executable_path: "C:\\secret\\python.exe" }), /PYTHON_LAUNCH_EVIDENCE_SCHEMA/u);
    assert.throws(() => validatePublicEvidence({ ...evidence, limitations: ["C:\\secret\\python.exe", ...evidence.limitations.slice(1)] }), /PYTHON_LAUNCH_EVIDENCE_SCHEMA|PYTHON_LAUNCH_EVIDENCE_FORBIDDEN/u);
    const canonical = encodeCanonicalJson(evidence);
    const { stdout } = await execFileAsync(process.execPath, ["tools/funasr-sidecar/sidecar-python-launch.mjs", "--validate-json", canonical], {
      encoding: "utf8",
      windowsHide: true,
    });
    assert.match(stdout, /^funasr-sidecar-python-launch-json=verified evidence_sha256=[0-9a-f]{64}\r?\n$/u);
  });
  if (process.platform === "win32") {
    await withSyntheticExecutableFixture(async (root, fixture) => {
      const originalSystemRoot = process.env.SystemRoot;
      try {
        process.env.SystemRoot = "C:\\Windows;relative-escape";
        await assert.rejects(
          () =>
            launchPythonCandidate(root, fixture.manifestPath, fixture.executablePath, fixture.aggregate, {
              spawnImpl: () => fakeChild({ stdout: goodResponseBytes() }),
            }),
          /PYTHON_LAUNCH_ENV/u,
        );
      } finally {
        if (originalSystemRoot === undefined) delete process.env.SystemRoot;
        else process.env.SystemRoot = originalSystemRoot;
      }
    });
  }
});

test("fixed probe source stays Python stdlib hello-only with no product surfaces", async () => {
  assert.deepEqual(FIXED_ARGS, ["-I", "-S", "-B", "-c"]);
  assert.match(FIXED_PROBE_SOURCE, /^import sys,struct,json\b/u);
  assert.doesNotMatch(FIXED_PROBE_SOURCE, /\b(?:os|subprocess|socket|urllib|requests|funasr|AutoModel|prepare|audio|model|flush|network)\b/iu);
  const source = await readFile("tools/funasr-sidecar/sidecar-python-launch.mjs", "utf8");
  assert.doesNotMatch(source, /MEETINGRELAY_.*FAULT|process\.argv\.slice\(2\).*timeout|--env|--args|--fault/u);
  assert.doesNotMatch(source, /node:http|node:https|node:net|node:tls|node:dns/u);
  assert.equal(sha256Hex(Buffer.from(FIXED_PROBE_SOURCE, "utf8")), FIXED_PROBE_SHA256);
});
