import { createHash } from "node:crypto";
import { lstat, open, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { encodeCanonicalJsonLine } from "../phase0-harness/canonical-json.mjs";
import * as delegate from "./quality-host-source-build-attestor.mjs?profile=shard";

const KIND = "meetingrelay-quality-shard-host-source-build-attestation-v1";
const SCHEMA_VERSION = "1.0";
const TARGET = "x86_64-pc-windows-msvc";
const DIGEST = /^(?!0{64}$)[0-9a-f]{64}$/u;
const COMMIT = /^(?!0{40}$)[0-9a-f]{40}$/u;
const MAX_BYTES = 1024 * 1024;
const AUTHORITY = Object.freeze({
  execution_status: "not-run",
  formal_claims: "none",
  materialization_status: "not-run",
  production_evidence: false,
  public_distribution: false,
  quality_gate_status: "not-assessed",
});
const EXPECTED_FEATURES = Object.freeze(["native-quality-shard", "native-sherpa"]);
const EXPECTED_FILENAME = process.platform === "win32"
  ? "meetingrelay-sherpa-candidate-quality-shard-host.exe"
  : "meetingrelay-sherpa-candidate-quality-shard-host";

export class QualityShardHostSourceBuildAttestorError extends Error {
  constructor(code, options = {}) {
    super(code, options);
    this.name = "QualityShardHostSourceBuildAttestorError";
    this.code = code;
  }
}

function fail(code, options = {}) {
  throw new QualityShardHostSourceBuildAttestorError(code, options);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function rethrowShardError(error) {
  if (error instanceof QualityShardHostSourceBuildAttestorError) throw error;
  const code = typeof error?.code === "string"
    ? error.code.replaceAll("QUALITY_HOST", "QUALITY_SHARD_HOST")
    : "QUALITY_SHARD_HOST_INTERNAL";
  fail(code, { cause: error });
}

function exactKeys(value, expected, code) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(code);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(code);
  }
}

function assertDigest(value, code) {
  if (typeof value !== "string" || !DIGEST.test(value)) fail(code);
}

function assertCommit(value, code) {
  if (typeof value !== "string" || !COMMIT.test(value)) fail(code);
}

function parseCanonicalJsonLine(bytes, code) {
  if (
    !Buffer.isBuffer(bytes) || bytes.length < 2 || bytes.length > MAX_BYTES ||
    bytes.at(-1) !== 0x0a || bytes.subarray(0, -1).includes(0x0a) ||
    bytes.includes(0x0d)
  ) fail(code);
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes) || encodeCanonicalJsonLine(JSON.parse(text)) !== text) {
    fail(code);
  }
  return JSON.parse(text);
}

function validateRecord(record, options = {}) {
  exactKeys(record, ["authority", "cargo", "executable", "kind", "schema_version", "source", "toolchain"], "QUALITY_SHARD_HOST_ATTESTATION");
  if (
    record.kind !== KIND || record.schema_version !== SCHEMA_VERSION ||
    !isDeepStrictEqual(record.authority, AUTHORITY)
  ) fail("QUALITY_SHARD_HOST_ATTESTATION");
  exactKeys(record.source, ["commit", "tree_sha256", "worktree_status"], "QUALITY_SHARD_HOST_SOURCE");
  assertCommit(record.source.commit, "QUALITY_SHARD_HOST_SOURCE");
  assertDigest(record.source.tree_sha256, "QUALITY_SHARD_HOST_SOURCE");
  if (record.source.worktree_status !== "clean") fail("QUALITY_SHARD_HOST_SOURCE_DIRTY");
  if (options.expectedSourceCommit !== undefined && record.source.commit !== options.expectedSourceCommit) {
    fail("QUALITY_SHARD_HOST_SOURCE_COMMIT");
  }

  exactKeys(record.cargo, ["features", "lock_sha256", "profile"], "QUALITY_SHARD_HOST_CARGO");
  if (
    record.cargo.profile !== "release" ||
    !isDeepStrictEqual(record.cargo.features, EXPECTED_FEATURES)
  ) fail("QUALITY_SHARD_HOST_CARGO");
  assertDigest(record.cargo.lock_sha256, "QUALITY_SHARD_HOST_CARGO");

  exactKeys(record.toolchain, [
    "cargo_executable_sha256", "cargo_v_sha256", "git_executable_sha256",
    "rustc_executable_sha256", "rustc_vv_sha256", "target",
  ], "QUALITY_SHARD_HOST_TOOLCHAIN");
  for (const [key, value] of Object.entries(record.toolchain)) {
    if (key === "target") {
      if (value !== TARGET) fail("QUALITY_SHARD_HOST_TOOLCHAIN");
    } else {
      assertDigest(value, "QUALITY_SHARD_HOST_TOOLCHAIN");
    }
  }

  exactKeys(record.executable, [
    "filename", "imports", "pe_format", "pe_machine", "pe_subsystem",
    "required_dll_characteristics", "runtime_bundle_sha256", "sha256", "size_bytes",
  ], "QUALITY_SHARD_HOST_EXECUTABLE");
  assertDigest(record.executable.sha256, "QUALITY_SHARD_HOST_EXECUTABLE");
  assertDigest(record.executable.runtime_bundle_sha256, "QUALITY_SHARD_HOST_EXECUTABLE");
  if (
    record.executable.filename !== EXPECTED_FILENAME ||
    record.executable.pe_format !== "PE32+" ||
    record.executable.pe_machine !== "amd64" ||
    record.executable.pe_subsystem !== "console" ||
    !Number.isSafeInteger(record.executable.size_bytes) ||
    record.executable.size_bytes < 1 ||
    !isDeepStrictEqual(record.executable.required_dll_characteristics, [
      "DYNAMIC_BASE", "GUARD_CF", "HIGH_ENTROPY_VA", "NX_COMPAT",
    ]) ||
    !Array.isArray(record.executable.imports) ||
    !record.executable.imports.includes("sherpa-onnx-c-api.dll") ||
    !isDeepStrictEqual(record.executable.imports, [...record.executable.imports].sort())
  ) fail("QUALITY_SHARD_HOST_EXECUTABLE");
  if (options.expectedExecutableSha256 !== undefined && record.executable.sha256 !== options.expectedExecutableSha256) {
    fail("QUALITY_SHARD_HOST_EXECUTABLE_DIGEST");
  }
  return record;
}

export function validateQualityShardHostSourceBuildAttestationBytes(bytes, options = {}) {
  const record = parseCanonicalJsonLine(bytes, "QUALITY_SHARD_HOST_ATTESTATION_CANONICAL");
  validateRecord(record, options);
  return { bytes, record, sha256: sha256(bytes) };
}

async function readStableFile(inputPath, code) {
  if (typeof inputPath !== "string" || !path.isAbsolute(inputPath)) fail(code);
  const before = await lstat(inputPath, { bigint: true }).catch((error) => fail(code, { cause: error }));
  if (!before.isFile() || before.isSymbolicLink() || before.size < 1n || before.size > BigInt(MAX_BYTES)) fail(code);
  const handle = await open(inputPath, "r").catch((error) => fail(code, { cause: error }));
  try {
    const opened = await handle.stat({ bigint: true });
    const bytes = await handle.readFile();
    const after = await lstat(inputPath, { bigint: true });
    if (
      before.dev !== opened.dev || opened.dev !== after.dev ||
      before.ino !== opened.ino || opened.ino !== after.ino ||
      opened.size !== BigInt(bytes.length) || opened.mtimeNs !== after.mtimeNs
    ) fail(code);
    return bytes;
  } finally {
    await handle.close().catch(() => fail(code));
  }
}

export async function readPinnedQualityShardHostSourceBuildAttestation(input) {
  exactKeys(input, [
    "attestationPath", "expectedAttestationSha256", "expectedExecutableSha256",
    "expectedSourceCommit",
  ], "QUALITY_SHARD_HOST_ATTESTATION_INPUT");
  assertDigest(input.expectedAttestationSha256, "QUALITY_SHARD_HOST_ATTESTATION_DIGEST");
  assertDigest(input.expectedExecutableSha256, "QUALITY_SHARD_HOST_EXECUTABLE_DIGEST");
  assertCommit(input.expectedSourceCommit, "QUALITY_SHARD_HOST_SOURCE_COMMIT");
  const bytes = await readStableFile(input.attestationPath, "QUALITY_SHARD_HOST_ATTESTATION_READ");
  if (sha256(bytes) !== input.expectedAttestationSha256) fail("QUALITY_SHARD_HOST_ATTESTATION_DIGEST");
  return validateQualityShardHostSourceBuildAttestationBytes(bytes, {
    expectedExecutableSha256: input.expectedExecutableSha256,
    expectedSourceCommit: input.expectedSourceCommit,
  });
}

export async function attestQualityShardHostSourceBuild(input) {
  try {
    const result = await delegate.attestQualityHostSourceBuild(input);
    validateQualityShardHostSourceBuildAttestationBytes(result.bytes, {
      expectedSourceCommit: input.expectedSourceCommit,
    });
    return result;
  } catch (error) {
    rethrowShardError(error);
  }
}

export async function __attestQualityShardHostSourceBuildForTest(input, ops) {
  try {
    const result = await delegate.__attestQualityHostSourceBuildForTest(input, ops);
    validateQualityShardHostSourceBuildAttestationBytes(result.bytes, {
      expectedSourceCommit: input.expectedSourceCommit,
    });
    return result;
  } catch (error) {
    rethrowShardError(error);
  }
}

export async function verifyQualityShardHostSourceBuildAttestationLive(input) {
  try {
    const result = await delegate.verifyQualityHostSourceBuildAttestationLive(input);
    validateQualityShardHostSourceBuildAttestationBytes(input.bytes, {
      expectedSourceCommit: input.expectedSourceCommit,
    });
    return result;
  } catch (error) {
    rethrowShardError(error);
  }
}

export async function __verifyQualityShardHostSourceBuildAttestationLiveForTest(input, ops) {
  try {
    const result = await delegate.__verifyQualityHostSourceBuildAttestationLiveForTest(input, ops);
    validateQualityShardHostSourceBuildAttestationBytes(input.bytes, {
      expectedSourceCommit: input.expectedSourceCommit,
    });
    return result;
  } catch (error) {
    rethrowShardError(error);
  }
}

export async function runQualityShardHostSourceBuildAttestorCli(args = process.argv.slice(2)) {
  return __runQualityShardHostSourceBuildAttestorCliForTest(args, undefined);
}

export async function __runQualityShardHostSourceBuildAttestorCliForTest(args, ops) {
  if (!Array.isArray(args) || args.length !== 2) fail("QUALITY_SHARD_HOST_USAGE");
  if (args[0] === "--attest") {
    try {
      const inputJsonPath = path.resolve(args[1]);
      const inputBytes = ops === undefined
        ? await readStableFile(inputJsonPath, "QUALITY_SHARD_HOST_CLI_INPUT")
        : await ops.readStableFile(inputJsonPath);
      const input = parseCanonicalJsonLine(inputBytes, "QUALITY_SHARD_HOST_CLI_INPUT");
      const result = ops === undefined
        ? await attestQualityShardHostSourceBuild(input)
        : await __attestQualityShardHostSourceBuildForTest(input, ops);
      const stdout = ops?.stdout ?? process.stdout;
      stdout.write(
        `QUALITY_SHARD_HOST_SOURCE_BUILD_ATTESTATION=PASS attestation_sha256=${result.sha256} execution_status=not-run formal_claims=none production_evidence=false\n`,
      );
      return result;
    } catch (error) {
      rethrowShardError(error);
    }
  }
  if (args[0] !== "--validate") fail("QUALITY_SHARD_HOST_USAGE");
  const bytes = await readFile(path.resolve(args[1]));
  const result = validateQualityShardHostSourceBuildAttestationBytes(bytes);
  const stdout = ops?.stdout ?? process.stdout;
  stdout.write(
    `QUALITY_SHARD_HOST_SOURCE_BUILD_ATTESTATION=PASS attestation_sha256=${result.sha256} executable_sha256=${result.record.executable.sha256} execution_status=not-run formal_claims=none production_evidence=false\n`,
  );
  return result;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runQualityShardHostSourceBuildAttestorCli().catch((error) => {
    process.stderr.write(`${error instanceof QualityShardHostSourceBuildAttestorError ? error.code : "QUALITY_SHARD_HOST_INTERNAL"}\n`);
    process.exitCode = 1;
  });
}
