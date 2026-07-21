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
import { encodeFrame } from "./sidecar-wire-foundation.mjs";
import {
  BOUNDARY_SOURCE_PATH,
  FIXED_SOURCE_AUDITOR,
  FIXED_SOURCE_AUDITOR_SHA256,
  bindExactManifestRuntime,
  getBoundRuntimeSnapshot,
  postflightExactRuntimeRootIdentity,
  runFixedHelloProbe,
  runFixedSourceParseCompileAuditor,
} from "./sidecar-python-probe-boundary.mjs";
import {
  PUBLIC_EVIDENCE_KIND,
  PUBLIC_EVIDENCE_SCHEMA_PATH,
  REFERENCE_SOURCE_PATH,
  attestSidecarSource,
  validatePublicEvidence,
} from "./sidecar-source-attestation.mjs";

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
  throw new Error("host Python 3.8+ is required for the WP-0.4.4d positive test");
}

async function addManifestFile(root, files, role, relativePath, bytes) {
  const absolute = path.join(root, ...relativePath.split("/"));
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, bytes);
  files.push({
    role,
    logical_id: `source-${role}`,
    relative_path: relativePath,
    sha256: sha256(bytes),
    size_bytes: bytes.length,
  });
  return absolute;
}

async function writeManifest(root, files) {
  files.sort((a, b) => a.role.localeCompare(b.role));
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

async function withFixture(fn, { actualVenv = false, sourceBytes = readFileSync(REFERENCE_SOURCE_PATH), sourceRelativePath = "inputs/sidecar-source.py" } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "meetingrelay-source-attest-test-"));
  try {
    const files = [];
    let executablePath;
    if (actualVenv) {
      const host = await discoverHostPython();
      const venvRoot = path.join(root, "venv");
      await execFileAsync(host.command, [...host.prefix, "-m", "venv", venvRoot], { encoding: "utf8", windowsHide: true });
      executablePath = process.platform === "win32" ? path.join(venvRoot, "Scripts", "python.exe") : path.join(venvRoot, "bin", "python");
      const runtimeBytes = await readFile(executablePath);
      files.push({
        role: "runtime",
        logical_id: "source-runtime",
        relative_path: process.platform === "win32" ? "venv/Scripts/python.exe" : "venv/bin/python",
        sha256: sha256(runtimeBytes),
        size_bytes: runtimeBytes.length,
      });
    } else {
      executablePath = await addManifestFile(root, files, "runtime", "venv/Scripts/python.exe", Buffer.from("synthetic executable bytes\n", "utf8"));
    }
    for (const role of REQUIRED_ROLES) {
      if (role === "runtime" || role === "sidecar-source") continue;
      await addManifestFile(root, files, role, `inputs/${role}.bin`, Buffer.from(`synthetic ${role} bytes\n`, "utf8"));
    }
    const sourcePath = await addManifestFile(root, files, "sidecar-source", sourceRelativePath, sourceBytes);
    const fixture = await writeManifest(root, files);
    const preflight = await preflightCandidate(root, fixture.manifestPath);
    return await fn(root, {
      ...fixture,
      executablePath,
      sourcePath,
      aggregate: preflight.candidate_descriptor.aggregate_sha256,
      sourceBytes,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function fakeChild({ stdout = Buffer.from('{"module_count":1,"ok":true,"top_level_statement_count":3}\n'), stderr = Buffer.alloc(0), code = 0, delayClose = false } = {}) {
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
    if (!delayClose) queueMicrotask(() => child.emit("close"));
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

test("actual venv positive path emits strict source-attestation-only evidence", async () => {
  await withFixture(
    async (root, fixture) => {
      const evidence = await attestSidecarSource(root, fixture.manifestPath, fixture.executablePath, fixture.aggregate);
      assert.equal(evidence.kind, PUBLIC_EVIDENCE_KIND);
      assert.equal(evidence.measurement_status, "source-attestation-only");
      assert.equal(evidence.execution_status, "source-parse-compile-only-no-import");
      assert.equal(evidence.source_binding_scope, "fixed-file-byte-match-only");
      assert.equal(evidence.git_provenance_authority, "none");
      assert.equal(evidence.cpython_provenance_authority, "none");
      assert.equal(evidence.packaging_authority, "none");
      assert.equal(evidence.quality_gate_status, "not-assessed");
      assert.equal(evidence.formal_claims, "none");
      assert.equal(evidence.production_evidence, false);
      assert.equal(evidence.public_distribution, false);
      assert.equal(evidence.selection_authority, "none");
      assert.equal(evidence.reference_source_sha256, sha256Hex(await readFile(REFERENCE_SOURCE_PATH)));
      assert.equal(evidence.auditor.fixed_auditor_sha256, FIXED_SOURCE_AUDITOR_SHA256);
      assert.doesNotThrow(() => validatePublicEvidence(evidence));
      const serialized = JSON.stringify(evidence);
      for (const forbidden of [root, "inputs/", "sidecar-source.py", "meetingrelay_funasr_sidecar.py", "describe_sidecar_contract", "Traceback"]) {
        assert.equal(serialized.includes(forbidden), false, forbidden);
      }
    },
    { actualVenv: true },
  );
});

test("CLI marker, validate-json, and usage are explicit", async () => {
  const synthetic = await execFileAsync(process.execPath, ["tools/funasr-sidecar/sidecar-source-attestation.mjs", "--run-synthetic"], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(synthetic.stderr, "");
  assert.match(
    synthetic.stdout,
    /^funasr-sidecar-source-attestation=verified evidence_sha256=[0-9a-f]{64} candidate_aggregate_sha256=[0-9a-f]{64} reference_source_sha256=[0-9a-f]{64} auditor_source_sha256=[0-9a-f]{64} measurement_status=source-attestation-only execution_status=source-parse-compile-only-no-import source_binding_scope=fixed-file-byte-match-only git_provenance_authority=none cpython_provenance_authority=none packaging_authority=none quality_gate_status=not-assessed formal_claims=none production_evidence=false public_distribution=false selection_authority=none fixture_scope=test-only-venv-not-packaging-choice\r?\n$/u,
  );
  await withFixture(
    async (root, fixture) => {
      const evidence = await attestSidecarSource(root, fixture.manifestPath, fixture.executablePath, fixture.aggregate);
      const canonical = encodeCanonicalJson(evidence);
      const validated = await execFileAsync(process.execPath, ["tools/funasr-sidecar/sidecar-source-attestation.mjs", "--validate-json", canonical], {
        encoding: "utf8",
        windowsHide: true,
      });
      assert.match(validated.stdout, /^funasr-sidecar-source-attestation-json=verified evidence_sha256=[0-9a-f]{64}\r?\n$/u);
    },
    { actualVenv: true },
  );
  const usage = await execFileAsync(process.execPath, ["tools/funasr-sidecar/sidecar-source-attestation.mjs", "--attest"], {
    encoding: "utf8",
    windowsHide: true,
  }).catch((error) => error);
  assert.match(usage.stderr, /SOURCE_ATTEST_USAGE/u);
});

test("wrong aggregate, manifest drift, source tamper, and same-size reference drift fail closed", async () => {
  await withFixture(async (root, fixture) => {
    await assert.rejects(() => attestSidecarSource(root, fixture.manifestPath, fixture.executablePath, "f".repeat(64), { spawnImpl: () => fakeChild() }), /AGGREGATE/u);
    const manifest = JSON.parse(readFileSync(fixture.manifestPath, "utf8"));
    manifest.files.find((entry) => entry.role === "sidecar-source").sha256 = "f".repeat(64);
    await writeFile(fixture.manifestPath, encodeCanonicalJson(manifest), "utf8");
    await assert.rejects(() => attestSidecarSource(root, fixture.manifestPath, fixture.executablePath, fixture.aggregate, { spawnImpl: () => fakeChild() }), /AGGREGATE|HASH_DRIFT/u);
  });
  await withFixture(async (root, fixture) => {
    const tampered = Buffer.from(fixture.sourceBytes);
    tampered[tampered.length - 2] = tampered[tampered.length - 2] === 0x41 ? 0x42 : 0x41;
    await writeFile(fixture.sourcePath, tampered);
    await assert.rejects(() => attestSidecarSource(root, fixture.manifestPath, fixture.executablePath, fixture.aggregate, { spawnImpl: () => fakeChild() }), /HASH_DRIFT/u);
  });
  const sameSizeReferenceTamper = Buffer.from(readFileSync(REFERENCE_SOURCE_PATH));
  sameSizeReferenceTamper[sameSizeReferenceTamper.length - 2] = sameSizeReferenceTamper[sameSizeReferenceTamper.length - 2] === 0x41 ? 0x42 : 0x41;
  await withFixture(async (root, fixture) => {
    await assert.rejects(() => attestSidecarSource(root, fixture.manifestPath, fixture.executablePath, fixture.aggregate, { spawnImpl: () => fakeChild() }), /SOURCE_ATTEST_REFERENCE_DRIFT/u);
  }, { sourceBytes: sameSizeReferenceTamper });
  await assert.rejects(
    () => runFixedHelloProbe({ root: tmpdir(), runtime_absolute: process.execPath }, { spawnImpl: () => fakeChild() }),
    /PYTHON_PROBE_BOUNDARY_UNBOUND_RUNTIME/u,
  );
  await assert.rejects(
    () => runFixedSourceParseCompileAuditor({ root: tmpdir(), runtime_absolute: process.execPath }, Buffer.from("x=1\n"), { spawnImpl: () => fakeChild() }),
    /PYTHON_PROBE_BOUNDARY_UNBOUND_RUNTIME/u,
  );
  await assert.rejects(() => postflightExactRuntimeRootIdentity({ root: tmpdir(), runtime_absolute: process.execPath }), /PYTHON_PROBE_BOUNDARY_UNBOUND_RUNTIME/u);
  await withFixture(async (root, fixture) => {
    const token = await bindExactManifestRuntime(root, fixture.manifestPath, fixture.executablePath, fixture.aggregate);
    for (const [key, value] of [
      ["root", "C:/Fake"],
      ["runtime_absolute", "C:/Fake/python.exe"],
      ["manifest", { files: [] }],
      ["runtime_manifest", { relative_path: "fake/python.exe" }],
    ]) {
      assert.throws(() => {
        token[key] = value;
      }, /Cannot add property|object is not extensible|read only/u);
    }
    const snapshot = getBoundRuntimeSnapshot(token);
    assert.throws(() => {
      snapshot.runtime_manifest.relative_path = "fake/python.exe";
    }, /Cannot assign to read only property|read only/u);
    const probe = await runFixedHelloProbe(token, {
      spawnImpl: (command, args, options) => {
        assert.equal(command, fixture.executablePath);
        assert.equal(options.cwd, root);
        return fakeChild({ stdout: goodResponseBytes() });
      },
    });
    assert.equal(probe.responseFrames.length, 1);
    await assert.rejects(
      () =>
        bindExactManifestRuntime(root, fixture.manifestPath, fixture.executablePath, fixture.aggregate, {
          beforeRuntimeOpenForTest: async (absolute) => {
            await writeFile(absolute, Buffer.alloc(fixture.manifest.files.find((entry) => entry.role === "runtime").size_bytes, 0x52));
          },
        }),
      /PYTHON_PROBE_BOUNDARY_RUNTIME_DRIFT/u,
    );
  });
  await withFixture(async (root, fixture) => {
    await assert.rejects(
      () =>
        attestSidecarSource(root, fixture.manifestPath, fixture.executablePath, fixture.aggregate, {
          afterSourceOpenForTest: async (absolute) => {
            await writeFile(absolute, Buffer.alloc(fixture.sourceBytes.length, 0x53));
          },
          spawnImpl: () => fakeChild(),
        }),
      /SOURCE_ATTEST_FILE_DRIFT/u,
    );
  });
  const originalReference = readFileSync(REFERENCE_SOURCE_PATH);
  await withFixture(async (root, fixture) => {
    await assert.rejects(
      () =>
        attestSidecarSource(root, fixture.manifestPath, fixture.executablePath, fixture.aggregate, {
          beforeReferenceOpenForTest: async (absolute) => {
            await writeFile(absolute, Buffer.alloc(originalReference.length, 0x54));
            await writeFile(absolute, originalReference);
          },
          spawnImpl: () => fakeChild(),
        }),
      /SOURCE_ATTEST_FILE_DRIFT/u,
    );
  });
});

test("unsafe source envelope variants fail before public evidence", async () => {
  const variants = [
    ["invalid utf8", Buffer.from([0xff, 0x0a]), /UTF8|HASH_DRIFT/u],
    ["bom", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), readFileSync(REFERENCE_SOURCE_PATH)]), /BOM|HASH_DRIFT/u],
    ["cr", Buffer.from("print('x')\r\n", "utf8"), /CR|HASH_DRIFT/u],
    ["nul", Buffer.from("x=1\0\n", "utf8"), /NUL|HASH_DRIFT/u],
    ["non-nfc", Buffer.from("e\u0301=1\n", "utf8"), /NFC|HASH_DRIFT/u],
    ["missing terminal lf", Buffer.from("x=1", "utf8"), /TERMINAL_LF|HASH_DRIFT/u],
    ["multiple terminal lf", Buffer.from("x=1\n\n", "utf8"), /TERMINAL_LF|HASH_DRIFT/u],
    ["oversize", Buffer.concat([Buffer.alloc(262144, 0x61), Buffer.from("\n")]), /SOURCE_ATTEST_SOURCE_(SIZE|FILE)/u],
  ];
  for (const [name, sourceBytes, pattern] of variants) {
    await withFixture(async (root, fixture) => {
      await assert.rejects(() => attestSidecarSource(root, fixture.manifestPath, fixture.executablePath, fixture.aggregate, { spawnImpl: () => fakeChild() }), pattern, name);
    }, { sourceBytes });
  }
});

test("symlink source and runtime special paths are rejected where observable", async () => {
  await withFixture(async (root, fixture) => {
    const link = path.join(root, "inputs", "source-link.py");
    try {
      await symlink(fixture.sourcePath, link);
    } catch (error) {
      if (process.platform === "win32" && error.code === "EPERM") return;
      throw error;
    }
    const manifest = JSON.parse(readFileSync(fixture.manifestPath, "utf8"));
    manifest.files.find((entry) => entry.role === "sidecar-source").relative_path = "inputs/source-link.py";
    await writeFile(fixture.manifestPath, encodeCanonicalJson(manifest), "utf8");
    await assert.rejects(() => preflightCandidate(root, fixture.manifestPath), /IDENTITY_PREFLIGHT_SPECIAL_FILE/u);
  });
});

test("auditor syntax and child failures are stable and source-text-free", async () => {
  await withFixture(async (root, fixture) => {
    const cases = [
      ["syntax", () => fakeChild({ stdout: Buffer.from('{"error":"SYNTAX_ERROR","ok":false}\n') }), /SYNTAX_ERROR/u],
      ["stderr", () => fakeChild({ stderr: Buffer.from("Traceback source leak") }), /STDERR_NONEMPTY/u],
      ["nonzero", () => fakeChild({ code: 2 }), /NONZERO_EXIT/u],
      ["timeout", () => fakeChild({ delayClose: true }), /DIRECT_CHILD_CLOSE_TIMEOUT/u, { timeoutMs: 5, cleanupTimeoutMs: 5 }],
      ["malformed", () => fakeChild({ stdout: Buffer.from("{bad\n") }), /AUDITOR_RESPONSE/u],
    ];
    for (const [name, spawnImpl, pattern, options = {}] of cases) {
      const error = await attestSidecarSource(root, fixture.manifestPath, fixture.executablePath, fixture.aggregate, { ...options, spawnImpl }).catch((caught) => caught);
      assert.match(String(error.message), pattern, name);
      assert.equal(String(error.message).includes("describe_sidecar_contract"), false);
      assert.equal(String(error.message).includes(fixture.sourcePath), false);
    }
  });
});

test("forbidden auditor APIs/imports and public overclaims are rejected", async () => {
  assert.match(FIXED_SOURCE_AUDITOR, /\bast\.parse\b/u);
  assert.match(FIXED_SOURCE_AUDITOR, /\bcompile\b/u);
  assert.doesNotMatch(FIXED_SOURCE_AUDITOR, /\b(?:eval|py_compile|compileall|runpy|importlib|funasr|AutoModel|socket|urllib|requests|download|audio|model)\b/iu);
  await withFixture(async (root, fixture) => {
    const evidence = await attestSidecarSource(root, fixture.manifestPath, fixture.executablePath, fixture.aggregate, { spawnImpl: () => fakeChild() });
    assert.throws(() => validatePublicEvidence({ ...evidence, production_evidence: true }), /OVERCLAIM/u);
    assert.throws(() => validatePublicEvidence({ ...evidence, git_provenance_authority: "git" }), /OVERCLAIM/u);
    assert.throws(() => validatePublicEvidence({ ...evidence, source_text: "def leaked(): pass\n" }), /SOURCE_ATTEST_EVIDENCE_SCHEMA/u);
    assert.throws(() => validatePublicEvidence({ ...evidence, limitations: ["C:\\secret\\sidecar.py", ...evidence.limitations.slice(1)] }), /SOURCE_ATTEST_EVIDENCE_FORBIDDEN|SOURCE_ATTEST_EVIDENCE_SCHEMA/u);
  });
});

test("schema parity covers constants and additionalProperties", async () => {
  const schema = JSON.parse(await readFile(PUBLIC_EVIDENCE_SCHEMA_PATH, "utf8"));
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.kind.const, PUBLIC_EVIDENCE_KIND);
  assert.equal(schema.properties.measurement_status.const, "source-attestation-only");
  assert.equal(schema.properties.execution_status.const, "source-parse-compile-only-no-import");
  assert.equal(schema.properties.source_binding_scope.const, "fixed-file-byte-match-only");
  assert.equal(schema.properties.git_provenance_authority.const, "none");
  assert.equal(schema.properties.cpython_provenance_authority.const, "none");
  assert.equal(schema.properties.packaging_authority.const, "none");
  assert.equal(schema.properties.quality_gate_status.const, "not-assessed");
  assert.equal(schema.properties.formal_claims.const, "none");
  assert.equal(schema.properties.production_evidence.const, false);
  assert.equal(schema.properties.public_distribution.const, false);
  assert.equal(schema.properties.selection_authority.const, "none");
  assert.equal(schema.properties.source.additionalProperties, false);
  assert.equal(schema.properties.runtime.additionalProperties, false);
  assert.equal(schema.properties.auditor.additionalProperties, false);
  assert.equal(schema.properties.limitations.minItems, 5);
  assert.equal(schema.properties.limitations.maxItems, 5);
  assert.equal(schema.properties.limitations.items, false);
  assert.equal(schema.properties.limitations.prefixItems.length, 5);
  const evidence = await withFixture(
    (root, fixture) => attestSidecarSource(root, fixture.manifestPath, fixture.executablePath, fixture.aggregate, { spawnImpl: () => fakeChild() }),
  );
  assert.deepEqual(
    schema.properties.limitations.prefixItems.map((item) => item.const),
    evidence.limitations,
  );
  assert.equal(evidence.python_probe_boundary_source_sha256, sha256Hex(readFileSync(BOUNDARY_SOURCE_PATH)));
});

test("4a, 4b, and 4c regression scripts remain executable", async () => {
  const commands = [
    ["tools/funasr-sidecar/sidecar-wire-foundation.test.mjs"],
    ["tools/funasr-sidecar/sidecar-candidate-preflight.test.mjs"],
    ["tools/funasr-sidecar/sidecar-python-launch.test.mjs"],
  ];
  for (const [file] of commands) {
    const result = await execFileAsync(process.execPath, ["--test", file], { encoding: "utf8", windowsHide: true });
    assert.equal(result.stderr.includes("fail"), false, file);
  }
});
