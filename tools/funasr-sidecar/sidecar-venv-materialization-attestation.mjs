#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { link, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { encodeCanonicalJson } from "../phase0-harness/canonical-json.mjs";
import { REQUIRED_ROLES, preflightCandidate } from "./sidecar-candidate-preflight.mjs";
import {
  attestPackageLock,
  normalizePackageName,
  readPackageLockFromCanonicalBytes,
  validatePublicEvidence as validatePackageLockEvidence,
} from "./sidecar-package-lock-attestation.mjs";

const execFileAsync = promisify(execFile);

export const PUBLIC_EVIDENCE_KIND = "meetingrelay-funasr-sidecar-venv-materialization-attestation-v1";
export const PUBLIC_EVIDENCE_SCHEMA_VERSION = "1.0";
export const PUBLIC_EVIDENCE_SCHEMA_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "sidecar-venv-materialization-attestation.schema.json",
);
export const ATTESTOR_SOURCE_PATH = fileURLToPath(import.meta.url);
export const MAX_PROCESS_TIMEOUT_MS = 120_000;
export const MAX_PROCESS_OUTPUT_BYTES = 1024 * 1024;
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const ZERO_SHA = "0".repeat(64);
const FIXTURE_PROBE_TOKEN = Symbol("meetingrelay-venv-fixture-probe");
const SYNTHETIC_FIXTURE_BINDINGS = new WeakMap();
const BUILT_WHEEL_NAMES = Object.freeze([
  "aliyun-python-sdk-core",
  "antlr4-python3-runtime",
  "crcmod",
  "jieba",
  "oss2",
]);
const ROOT_REQUIREMENTS = Object.freeze(["funasr==1.3.22", "torch==2.6.0+cpu", "torchaudio==2.6.0+cpu"]);
const LIMITATIONS = Object.freeze([
  "controlled-wheelhouse-and-venv-materialized-only: this validates a caller-supplied existing 4b-bound virtual environment by installing from a local wheelhouse with pip --no-index and checking installed metadata surfaces; it is not CPython provenance or OS-level network isolation authority",
  "runtime target compatibility is limited to the bound interpreter self-reporting CPython 3.12 on 64-bit Windows AMD64 with a win-amd64 platform; binary origin, signature, and CPython provenance remain unverified",
  "synthetic CI wheels contain no real FunASR, PyTorch, model, audio, network, or product package code; they exercise materialization mechanics only",
  "source_build_authority=none: sdist-derived declarations are checked as a fixed declared set, but source archives and build attestations are not opened, parsed, or replayed",
  "license_authority=none and import_authority=none: license target bytes and package imports are not verified by this slice",
  "installed RECORD entries must remain inside site-packages in this slice; console-script or data-scheme entries outside site-packages fail closed and are not validated",
  "public evidence intentionally omits filesystem paths, artifact filenames, package names, requirement text, URLs, pip output, environment values, timings, host identity, and plaintext",
]);
const ALLOWED_PUBLIC_STRINGS = new Set([
  PUBLIC_EVIDENCE_KIND,
  PUBLIC_EVIDENCE_SCHEMA_VERSION,
  "controlled-wheelhouse-and-venv-materialized-only",
  "offline-install-pip-check-inspect-no-funasr-import",
  "controlled-wheelhouse-and-offline-venv-only",
  "offline-venv-materialized",
  "installed-dist-info-record-verified-only",
  "none",
  "not-assessed",
  "sidecar-candidate",
  "windows",
  "amd64",
  "3.12.x",
  "cp312",
  "win_amd64",
  "cpu-baseline",
  "synthetic-valid-wheels-no-real-funasr-code",
  "disabled-by-no-index-and-sanitized-env",
  "caller-supplied-controlled-inputs-not-product-approved",
  "disabled",
  "path-url-name-text-free",
  ...LIMITATIONS,
]);
const FORBIDDEN_PUBLIC_KEYS = new Set([
  "absolute_path",
  "artifact",
  "content",
  "dependency",
  "direct_url",
  "file_path",
  "filename",
  "lock_text",
  "package",
  "path",
  "requirement",
  "root",
  "source",
  "text",
  "url",
  "wheel_url",
]);
const FORBIDDEN_PUBLIC_VALUE_RE = /(?:[A-Za-z]:\\|\\\\|\/tmp\/|\/home\/|\/Users\/|wheelhouse\/|inputs\/|site-packages|https?:\/\/|file:\/\/|funasr|torch|torchaudio|jieba|oss2|crcmod|aliyun|antlr|==|\.whl|\.dist-info)/iu;

export class VenvMaterializationAttestationError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "VenvMaterializationAttestationError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new VenvMaterializationAttestationError(code, message);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function assertSha256(value, code, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value) || value === ZERO_SHA) fail(code, `${label} must be non-zero lowercase sha256`);
}

function assertPlainObject(value, code, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(code, `${label} must be an object`);
}

function assertAllowedKeys(value, allowed, code, label) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(code, `${label} has unknown field ${key}`);
}

function ensureInside(root, absolute, code, label) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(absolute);
  const prefix = resolvedRoot.endsWith(path.sep) ? resolvedRoot : `${resolvedRoot}${path.sep}`;
  const comparablePrefix = process.platform === "win32" ? prefix.toLowerCase() : prefix;
  const comparableResolved = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  if (resolved === resolvedRoot || comparableResolved.startsWith(comparablePrefix)) return resolved;
  fail(code, `${label} escaped controlled root`);
}

function assertNoSymlinkComponents(root, absolute, code, label) {
  const resolvedRoot = path.resolve(root);
  const resolved = ensureInside(resolvedRoot, absolute, code, label);
  const relative = path.relative(resolvedRoot, resolved);
  let current = resolvedRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let stat;
    try {
      stat = lstatSync(current);
    } catch (error) {
      fail(code, `${label} path component could not be inspected: ${error.code ?? error.message}`);
    }
    if (stat.isSymbolicLink()) fail(code, `${label} must not traverse a symlink or junction`);
  }
  return resolved;
}

function rejectUnsafeAbsolute(inputPath, code, label) {
  if (typeof inputPath !== "string" || inputPath.length === 0 || inputPath.includes("\0") || /[\r\n]/u.test(inputPath)) fail(code, `${label} must be a safe path`);
  if (inputPath.startsWith("\\\\") || inputPath.startsWith("//") || /^\\\\[.?]\\|^\/\/[.?]\//u.test(inputPath)) fail(code, `${label} must not use UNC or device syntax`);
  const colonIndexes = [...inputPath.matchAll(/:/gu)].map((match) => match.index);
  const hasDriveColon = colonIndexes.length === 1 && colonIndexes[0] === 1 && /^[A-Za-z]:[\\/]/u.test(inputPath);
  if ((colonIndexes.length > 0 && !hasDriveColon) || /^[A-Za-z]:(?![\\/])/u.test(inputPath) || !path.isAbsolute(inputPath)) fail(code, `${label} must be absolute local path without ADS or drive-relative syntax`);
  return path.resolve(inputPath);
}

async function readCanonicalJsonFile(filePath, maxBytes, code, label) {
  const bytes = await readFile(filePath);
  if (bytes.length === 0 || bytes.length > maxBytes) fail(code, `${label} size outside limit`);
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    fail(code, `${label} must parse as JSON: ${error.message}`);
  }
  if (encodeCanonicalJson(parsed) !== bytes.toString("utf8")) fail(code, `${label} must be canonical JSON`);
  return { bytes, parsed, sha256: sha256(bytes), size_bytes: bytes.length };
}

async function readPackageLock(controlledRoot, manifestPath) {
  const manifest = (await readCanonicalJsonFile(manifestPath, 64 * 1024, "VENV_MANIFEST", "input manifest")).parsed;
  const role = manifest.files?.find((entry) => entry.role === "package-lock");
  if (!role) fail("VENV_MANIFEST", "package-lock role missing");
  const lockPath = ensureInside(controlledRoot, path.resolve(controlledRoot, ...role.relative_path.split("/")), "VENV_LOCK_PATH", "package lock");
  const bytes = await readFile(lockPath);
  const envelope = readPackageLockFromCanonicalBytes(bytes);
  if (envelope.sha256 !== role.sha256 || envelope.size_bytes !== role.size_bytes) fail("VENV_LOCK_DRIFT", "package lock drifted from manifest");
  return { ...envelope, manifest };
}

function fileIdentity(filePath, code, label) {
  const stat = lstatSync(filePath, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink()) fail(code, `${label} must be a regular non-symlink file`);
  if (stat.nlink !== 1n) fail(code, `${label} must not be a hardlink alias`);
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs, birthtimeNs: stat.birthtimeNs, sha256: sha256(readFileSync(filePath)) };
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs && left.birthtimeNs === right.birthtimeNs && left.sha256 === right.sha256;
}

function bindRuntimeRole(controlledRoot, manifest, venvPythonPath) {
  const role = manifest.files?.find((entry) => entry.role === "runtime");
  if (!role) fail("VENV_RUNTIME_ROLE", "runtime role missing");
  const rolePath = ensureInside(controlledRoot, path.resolve(controlledRoot, ...role.relative_path.split("/")), "VENV_RUNTIME_ROLE", "runtime role");
  const requested = rejectUnsafeAbsolute(venvPythonPath, "VENV_PYTHON_PATH", "venv python");
  const roleComparable = process.platform === "win32" ? rolePath.toLowerCase() : rolePath;
  const requestedComparable = process.platform === "win32" ? requested.toLowerCase() : requested;
  if (roleComparable !== requestedComparable) fail("VENV_RUNTIME_ROLE", "caller venv python must be the 4b-bound runtime role");
  assertNoSymlinkComponents(controlledRoot, rolePath, "VENV_RUNTIME_ROLE", "runtime role");
  const bytes = readFileSync(rolePath);
  if (sha256(bytes) !== role.sha256 || bytes.length !== role.size_bytes) fail("VENV_RUNTIME_ROLE_DRIFT", "runtime role bytes drifted");
  return { absolute: rolePath, identity: fileIdentity(rolePath, "VENV_RUNTIME_ROLE", "runtime role") };
}

function validateVenvPythonPath(controlledRoot, venvPythonPath) {
  const absolute = ensureInside(controlledRoot, rejectUnsafeAbsolute(venvPythonPath, "VENV_PYTHON_PATH", "venv python"), "VENV_PYTHON_PATH", "venv python");
  assertNoSymlinkComponents(controlledRoot, absolute, "VENV_PYTHON_PATH", "venv python");
  const scriptDir = path.basename(path.dirname(absolute)).toLowerCase();
  const exeName = path.basename(absolute).toLowerCase();
  if (process.platform === "win32") {
    if (scriptDir !== "scripts" || exeName !== "python.exe") fail("VENV_PYTHON_PATH", "Windows venv python must be Scripts/python.exe");
  } else if (scriptDir !== "bin" || exeName !== "python") {
    fail("VENV_PYTHON_PATH", "POSIX venv python must be bin/python");
  }
  const venvRoot = path.dirname(path.dirname(absolute));
  if (path.resolve(venvRoot) === path.resolve(controlledRoot)) fail("VENV_PYTHON_PATH", "venv root must not equal controlled root");
  const stat = lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) fail("VENV_PYTHON_PATH", "venv python must be an existing regular file");
  const cfgPath = path.join(venvRoot, "pyvenv.cfg");
  assertNoSymlinkComponents(controlledRoot, cfgPath, "VENV_CONFIG", "venv configuration");
  const cfg = readFileSync(cfgPath, "utf8");
  if (!/^include-system-site-packages\s*=\s*false\s*$/imu.test(cfg)) fail("VENV_CONFIG", "venv must disable system site packages");
  return { absolute, venvRoot };
}

async function runProcess(executable, args, label, options = {}) {
  if (options.injectProcessFailure === label) fail(`VENV_PROCESS_${label.toUpperCase()}`, `injected ${label} failure`);
  if (options.injectProcessTimeout === label) fail(`VENV_PROCESS_${label.toUpperCase()}_TIMEOUT`, `injected ${label} timeout`);
  if (options.injectProcessOversize === label) fail(`VENV_PROCESS_${label.toUpperCase()}_OUTPUT`, `injected ${label} output limit`);
  const env = {
    NO_COLOR: "1",
    PIP_CONFIG_FILE: os.platform() === "win32" ? "NUL" : "/dev/null",
    PIP_DISABLE_PIP_VERSION_CHECK: "1",
    PIP_NO_CACHE_DIR: "1",
    PIP_NO_INDEX: "1",
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONIOENCODING: "utf-8",
    PYTHONNOUSERSITE: "1",
    SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
    TEMP: options.tempDir ?? os.tmpdir(),
    TMP: options.tempDir ?? os.tmpdir(),
  };
  try {
    const result = await execFileAsync(executable, args, {
      windowsHide: true,
      shell: false,
      detached: false,
      timeout: options.timeoutMs ?? MAX_PROCESS_TIMEOUT_MS,
      maxBuffer: options.maxOutputBytes ?? MAX_PROCESS_OUTPUT_BYTES,
      cwd: options.cwd,
      env,
    });
    return { stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    if (error.killed || error.signal === "SIGTERM") fail(`VENV_PROCESS_${label.toUpperCase()}_TIMEOUT`, `${label} timed out`);
    if (/maxBuffer/iu.test(String(error.message))) fail(`VENV_PROCESS_${label.toUpperCase()}_OUTPUT`, `${label} output exceeded limit`);
    fail(`VENV_PROCESS_${label.toUpperCase()}`, `${label} failed: ${String(error.stderr || error.message).slice(0, 2000)}`);
  }
}

async function resolveHostPython(options = {}) {
  if (options.hostPython) return options.hostPython;
  const probe = await execFileAsync("python", ["-c", "import sys; print(sys.executable); print(f'{sys.version_info.major}.{sys.version_info.minor}')"], {
    windowsHide: true,
    shell: false,
    detached: false,
    timeout: 10_000,
    maxBuffer: 8192,
    cwd: options.cwd,
    env: {
      SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
      PATH: process.env.PATH ?? "",
      TEMP: options.tempDir ?? os.tmpdir(),
      TMP: options.tempDir ?? os.tmpdir(),
      PYTHONIOENCODING: "utf-8",
      PYTHONNOUSERSITE: "1",
      PYTHONDONTWRITEBYTECODE: "1",
      PIP_CONFIG_FILE: os.platform() === "win32" ? "NUL" : "/dev/null",
    },
  }).catch(() => fail("VENV_HOST_PYTHON", "could not resolve host Python 3.12"));
  const lines = probe.stdout.trim().split(/\r?\n/u);
  if (lines[1] !== "3.12") fail("VENV_HOST_PYTHON", "host Python must be CPython 3.12");
  return lines[0];
}

function validateLockForMaterialization(lock) {
  if (lock.target.os !== "windows" || lock.target.arch !== "amd64" || lock.target.cpython_version_family !== "3.12.x" || lock.target.python_abi !== "cp312" || lock.target.platform_tag !== "win_amd64" || lock.target.accelerator_profile !== "cpu-baseline") fail("VENV_TARGET", "4f requires Windows AMD64 CPython 3.12 CPU baseline");
  if (JSON.stringify(lock.root_requirements) !== JSON.stringify(ROOT_REQUIREMENTS)) fail("VENV_ROOTS", "4f root pins must be exact");
  if (lock.distributions.length !== 77) fail("VENV_DISTRIBUTION_COUNT", "4f requires exactly 77 distributions");
  const built = lock.distributions.filter((item) => item.built_wheel !== undefined).map((item) => normalizePackageName(item.name)).sort();
  if (JSON.stringify(built) !== JSON.stringify([...BUILT_WHEEL_NAMES])) fail("VENV_BUILT_SET", "sdist-derived built wheel declaration set mismatch");
  for (const item of lock.distributions) {
    if (item.declared_dist_info_metadata_sha256 === ZERO_SHA || item.declared_dist_info_record_sha256 === ZERO_SHA) fail("VENV_METADATA_DECLARATION", "installed metadata declarations must be nonzero");
  }
}

function normalizeRecordPath(recordPath) {
  if (typeof recordPath !== "string" || recordPath.length === 0 || recordPath.includes("\\") || recordPath.includes("\0") || recordPath.startsWith("/") || recordPath.includes(":")) fail("VENV_RECORD_PATH", "RECORD path must be safe relative POSIX syntax");
  for (const segment of recordPath.split("/")) if (segment === "" || segment === "." || segment === ".." || segment.endsWith(" ") || segment.endsWith(".")) fail("VENV_RECORD_PATH", "RECORD path contains unsafe segment");
  return recordPath;
}

function normalizeDistInfoBasename(value) {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 255
    || /[<>:"/\\|?*\u0000-\u001f]/u.test(value)
    || value === "."
    || value === ".."
    || value.endsWith(" ")
    || value.endsWith(".")
    || path.win32.basename(value) !== value
    || path.posix.basename(value) !== value
    || !value.endsWith(".dist-info")
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(value)
  ) fail("VENV_DIST_INFO_PATH", "metadata path must be one safe dist-info basename");
  return value;
}

function parseCsvRecordLine(line) {
  const cells = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const ch = line[index];
    if (quoted) {
      if (ch === "\"" && line[index + 1] === "\"") {
        current += "\"";
        index += 1;
      } else if (ch === "\"") {
        quoted = false;
      } else {
        current += ch;
      }
    } else if (ch === ",") {
      cells.push(current);
      current = "";
    } else if (ch === "\"") {
      quoted = true;
    } else {
      current += ch;
    }
  }
  cells.push(current);
  if (cells.length !== 3) fail("VENV_RECORD", "RECORD must have exactly three columns");
  return cells;
}

async function verifyInstalledDistInfo(venvRoot, lock, options = {}) {
  const sitePackages = path.join(venvRoot, "Lib", "site-packages");
  const controlledRoot = options.controlledRoot ?? venvRoot;
  const script = [
    "import importlib.metadata as m, json, pathlib, re, sys, sysconfig",
    "names=json.loads(pathlib.Path(sys.argv[1]).read_text(encoding='utf-8'))",
    "site=pathlib.Path(sysconfig.get_path('purelib')).resolve()",
    "wanted=set(names)",
    "found={}",
    "out=[]",
    "for d in m.distributions(path=[str(site)]):",
    " key=re.sub(r'[-_.]+','-',d.metadata['Name']).lower()",
    " if key not in wanted: continue",
    " relative=pathlib.Path(d._path).resolve().relative_to(site)",
    " if len(relative.parts) != 1: raise RuntimeError('distribution metadata must be a direct purelib child')",
    " if key in found: raise RuntimeError('duplicate distribution metadata')",
    " found[key]={'name': d.metadata['Name'], 'version': d.version, 'dist_info_basename': relative.parts[0]}",
    "for name in names:",
    " if name not in found: raise RuntimeError('locked distribution metadata missing from purelib')",
    " out.append(found[name])",
    "print(json.dumps(out, sort_keys=True, separators=(',', ':')))",
  ].join("\n");
  const names = lock.distributions.map((item) => normalizePackageName(item.name));
  const namesPath = path.join(options.controlledRoot ?? venvRoot, "inputs", "installed-query-names.json");
  await mkdir(path.dirname(namesPath), { recursive: true });
  await writeFile(namesPath, encodeCanonicalJson(names), "utf8");
  const proc = await execFileAsync(path.join(venvRoot, "Scripts", "python.exe"), ["-I", "-B", "-c", script, namesPath], {
    windowsHide: true,
    shell: false,
    detached: false,
    timeout: options.timeoutMs ?? MAX_PROCESS_TIMEOUT_MS,
    maxBuffer: options.maxOutputBytes ?? MAX_PROCESS_OUTPUT_BYTES,
    cwd: options.cwd,
    env: {
      PYTHONDONTWRITEBYTECODE: "1",
      PYTHONIOENCODING: "utf-8",
      PYTHONNOUSERSITE: "1",
      SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
      TEMP: options.tempDir ?? os.tmpdir(),
      TMP: options.tempDir ?? os.tmpdir(),
    },
  }).catch((error) => fail("VENV_IMPORTLIB_METADATA", `installed distribution metadata query failed: ${String(error.stderr || error.message).slice(0, 2000)}`));
  let rows;
  try {
    rows = JSON.parse(proc.stdout);
  } catch {
    fail("VENV_IMPORTLIB_METADATA", "metadata query did not return JSON");
  }
  if (!Array.isArray(rows) || rows.length !== lock.distributions.length) fail("VENV_INSTALLED_SET", "metadata query installed set count mismatch");
  const byName = new Map(lock.distributions.map((item) => [normalizePackageName(item.name), item]));
  const seen = new Set();
  const contracts = [];
  for (const row of rows) {
    assertPlainObject(row, "VENV_INSTALLED_SET", "installed distribution metadata");
    assertAllowedKeys(row, new Set(["name", "version", "dist_info_basename"]), "VENV_INSTALLED_SET", "installed distribution metadata");
    if (typeof row.name !== "string" || typeof row.version !== "string") fail("VENV_INSTALLED_SET", "installed name and version must be strings");
    const normalized = normalizePackageName(row.name);
    const expected = byName.get(normalized);
    if (!expected || row.version !== expected.version) fail("VENV_INSTALLED_SET", "installed set/version mismatch");
    if (seen.has(normalized)) fail("VENV_INSTALLED_SET", "installed distribution metadata must be unique");
    seen.add(normalized);
    const distInfoBasename = normalizeDistInfoBasename(row.dist_info_basename);
    const distInfo = ensureInside(sitePackages, path.join(sitePackages, distInfoBasename), "VENV_DIST_INFO_PATH", "dist-info");
    assertNoSymlinkComponents(controlledRoot, distInfo, "VENV_DIST_INFO_PATH", "dist-info");
    const metadataPath = path.join(distInfo, "METADATA");
    const recordPath = path.join(distInfo, "RECORD");
    if (options.afterInstallTamper === normalized) await writeFile(metadataPath, "Metadata-Version: 2.1\nName: drift\nVersion: 0\n", "utf8");
    if (options.afterInstallHardlink === normalized) await link(metadataPath, path.join(distInfo, ".meetingrelay-hardlink-probe"));
    assertNoSymlinkComponents(controlledRoot, metadataPath, "VENV_METADATA_PATH", "installed METADATA");
    assertNoSymlinkComponents(controlledRoot, recordPath, "VENV_RECORD_PATH", "installed RECORD");
    const metadata = await readFile(metadataPath);
    const record = await readFile(recordPath);
    const fixtureProbe = options.fixtureProbeToken === FIXTURE_PROBE_TOKEN;
    if (!fixtureProbe && sha256(metadata) !== expected.declared_dist_info_metadata_sha256) fail("VENV_METADATA_DRIFT", "installed METADATA drifted from lock declaration");
    if (!fixtureProbe && sha256(record) !== expected.declared_dist_info_record_sha256) fail("VENV_RECORD_DRIFT", "installed RECORD drifted from lock declaration");
    const recordLines = record.toString("utf8").trimEnd().split(/\r?\n/u);
    if (recordLines.length < 2) fail("VENV_RECORD", "RECORD must contain installed files");
    for (const line of recordLines) {
      const [relative, digest, sizeText] = parseCsvRecordLine(line);
      normalizeRecordPath(relative);
      const absolute = ensureInside(sitePackages, path.resolve(sitePackages, ...relative.split("/")), "VENV_RECORD_PATH", "RECORD entry");
      assertNoSymlinkComponents(controlledRoot, absolute, "VENV_RECORD_PATH", "RECORD entry");
      const stat = lstatSync(absolute);
      if (!stat.isFile() || stat.isSymbolicLink()) fail("VENV_RECORD_FILE", "RECORD entry must be a regular file");
      if (stat.nlink !== 1) fail("VENV_RECORD_HARDLINK", "RECORD entry must not be a hardlink alias");
      if (digest !== "") {
        const match = /^sha256=([A-Za-z0-9_-]+)$/u.exec(digest);
        if (!match) fail("VENV_RECORD_HASH", "RECORD hash must be sha256 urlsafe base64");
        const observed = createHash("sha256").update(readFileSync(absolute)).digest("base64url").replace(/=+$/u, "");
        if (observed !== match[1]) fail("VENV_RECORD_HASH_DRIFT", "RECORD file hash drift");
      }
      if (sizeText !== "" && Number(sizeText) !== stat.size) fail("VENV_RECORD_SIZE_DRIFT", "RECORD file size drift");
    }
    contracts.push({
      metadata_sha256: sha256(metadata),
      name_sha256: sha256(normalized),
      record_sha256: sha256(record),
      version_sha256: sha256(expected.version),
    });
  }
  contracts.sort((left, right) => left.name_sha256.localeCompare(right.name_sha256));
  if (contracts.length !== lock.distributions.length) fail("VENV_INSTALLED_SET", "installed contract count mismatch");
  return { contract_sha256: sha256(Buffer.from(encodeCanonicalJson(contracts), "utf8")) };
}

async function materializeAndInspect(controlledRoot, lock, venvPythonPath, options = {}) {
  const { absolute: venvPython, venvRoot } = validateVenvPythonPath(controlledRoot, venvPythonPath);
  const processTemp = path.join(controlledRoot, "tmp", `venv-materialization-${sha256(venvPython).slice(0, 16)}`);
  await mkdir(processTemp, { recursive: true });
  const processOptions = { ...options, controlledRoot, cwd: controlledRoot, tempDir: processTemp };
  await verifyBootstrapOnly(venvPython, processOptions);
  const runtimeTargetProbeSha256 = await verifyRuntimeTarget(venvPython, processOptions);
  const resolverVersion = await queryPipVersion(venvPython, processOptions);
  if (resolverVersion !== lock.resolver_declaration.version) fail("VENV_RESOLVER_VERSION", "venv pip version drifted from lock resolver declaration");
  const requirements = lock.distributions.map((item) => `${item.name}==${item.version} --hash=sha256:${item.wheel.sha256}`).join("\n") + "\n";
  const requirementsPath = path.join(controlledRoot, "inputs", "venv-materialization-requirements.txt");
  await mkdir(path.dirname(requirementsPath), { recursive: true });
  await writeFile(requirementsPath, requirements, "utf8");
  const wheelhouse = path.join(controlledRoot, "wheelhouse");
  const pipInstallFlags = [
    "-I",
    "-B",
    "-m",
    "pip",
    "install",
    "--isolated",
    "--require-virtualenv",
    "--no-index",
    "--find-links",
    wheelhouse,
    "--only-binary",
    ":all:",
    "--no-deps",
    "--require-hashes",
    "--no-compile",
    "--disable-pip-version-check",
    "-r",
    requirementsPath,
  ];
  await runProcess(venvPython, pipInstallFlags, "install", processOptions);
  await runProcess(venvPython, ["-I", "-B", "-m", "pip", "check", "--disable-pip-version-check"], "check", processOptions);
  const inspect = await runProcess(venvPython, ["-I", "-B", "-m", "pip", "inspect", "--local"], "inspect", processOptions);
  if (Buffer.byteLength(inspect.stdout, "utf8") > MAX_JSON_BYTES) fail("VENV_INSPECT_OUTPUT", "pip inspect JSON exceeded limit");
  let inspectJson;
  try {
    inspectJson = JSON.parse(inspect.stdout);
  } catch {
    fail("VENV_INSPECT_JSON", "pip inspect output must be JSON");
  }
  const installed = Array.isArray(inspectJson.installed) ? inspectJson.installed : [];
  const locked = new Map(lock.distributions.map((item) => [normalizePackageName(item.name), item.version]));
  const projected = [];
  const unexpected = [];
  for (const item of installed) {
    const metadata = item.metadata ?? {};
    const normalized = normalizePackageName(metadata.name ?? "");
    if (locked.has(normalized)) {
      if (metadata.version !== locked.get(normalized)) fail("VENV_INSPECT_SET", "pip inspect version mismatch");
      if (item.download_info !== undefined || item.direct_url !== undefined) fail("VENV_DIRECT_URL", "offline wheel install must not create direct URL evidence");
      projected.push({ name_sha256: sha256(normalized), version_sha256: sha256(metadata.version) });
    } else if (!["pip", "setuptools", "wheel"].includes(normalized)) {
      unexpected.push(normalized);
    }
  }
  if (unexpected.length > 0 || projected.length !== lock.distributions.length) fail("VENV_INSPECT_SET", "pip inspect installed set mismatch");
  projected.sort((left, right) => left.name_sha256.localeCompare(right.name_sha256));
  const inspectReportHash = sha256(Buffer.from(encodeCanonicalJson(projected), "utf8"));
  const distInfo = await verifyInstalledDistInfo(venvRoot, lock, processOptions);
  if (options.fixtureProbeToken !== FIXTURE_PROBE_TOKEN && inspectReportHash !== lock.expected_environment_report.expected_sha256) fail("VENV_EXPECTED_REPORT_DRIFT", "materialized environment projection drifted from expected report declaration");
  return {
    dist_info_contract_sha256: distInfo.contract_sha256,
    pip_install_flags_sha256: sha256(Buffer.from(encodeCanonicalJson(pipInstallFlags.map((arg) => (path.isAbsolute(arg) ? "<absolute>" : arg))), "utf8")),
    report_sha256: inspectReportHash,
    runtime_target_probe_sha256: runtimeTargetProbeSha256,
  };
}

async function verifyRuntimeTarget(venvPython, options = {}) {
  const script = [
    "import json, os, platform, struct, sys, sysconfig",
    "value={'cache_tag':sys.implementation.cache_tag,'implementation':sys.implementation.name,'machine':platform.machine(),'os_name':os.name,'pointer_bits':struct.calcsize('P')*8,'sys_platform':sys.platform,'sysconfig_platform':sysconfig.get_platform(),'version':[sys.version_info.major,sys.version_info.minor]}",
    "print(json.dumps(value,sort_keys=True,separators=(',',':')))",
  ].join("\n");
  const result = await runProcess(venvPython, ["-I", "-B", "-c", script], "runtime_target", options);
  let observed;
  try {
    observed = JSON.parse(result.stdout);
  } catch {
    fail("VENV_RUNTIME_TARGET", "runtime target probe must return JSON");
  }
  if (options.injectRuntimeTargetMismatch === true) observed = { ...observed, machine: "ARM64" };
  const machine = typeof observed.machine === "string" ? observed.machine.toLowerCase().replaceAll("_", "-") : "";
  if (
    observed.implementation !== "cpython"
    || observed.cache_tag !== "cpython-312"
    || JSON.stringify(observed.version) !== "[3,12]"
    || observed.os_name !== "nt"
    || observed.sys_platform !== "win32"
    || !["amd64", "x86-64"].includes(machine)
    || observed.pointer_bits !== 64
    || observed.sysconfig_platform !== "win-amd64"
  ) fail("VENV_RUNTIME_TARGET", "bound runtime does not match Windows AMD64 CPython 3.12 target");
  return sha256(Buffer.from(encodeCanonicalJson(observed), "utf8"));
}

async function queryPipVersion(venvPython, options = {}) {
  const result = await runProcess(venvPython, ["-I", "-B", "-c", "import pip; print(pip.__version__)"], "resolver", options);
  const version = result.stdout.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._+!-]{0,127}$/u.test(version)) fail("VENV_RESOLVER_VERSION", "pip version output is invalid");
  return version;
}

async function verifyBootstrapOnly(venvPython, options = {}) {
  const script = "import importlib.metadata as m, json; print(json.dumps(sorted(d.metadata['Name'].lower().replace('_','-') for d in m.distributions())))";
  const result = await runProcess(venvPython, ["-I", "-B", "-c", script], "bootstrap", options);
  let installed;
  try {
    installed = JSON.parse(result.stdout);
  } catch {
    fail("VENV_BOOTSTRAP", "bootstrap package query must be JSON");
  }
  const allowed = new Set(["pip", "setuptools", "wheel"]);
  for (const name of installed) if (!allowed.has(name)) fail("VENV_BOOTSTRAP", "venv must contain only bootstrap packages before materialization");
}

function scanForbiddenPublicEvidence(value, segments = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanForbiddenPublicEvidence(item, [...segments, String(index)]));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (FORBIDDEN_PUBLIC_KEYS.has(key)) fail("VENV_EVIDENCE_FORBIDDEN", `forbidden public evidence key ${[...segments, key].join(".")}`);
      scanForbiddenPublicEvidence(item, [...segments, key]);
    }
    return;
  }
  if (typeof value === "string" && !ALLOWED_PUBLIC_STRINGS.has(value) && FORBIDDEN_PUBLIC_VALUE_RE.test(value)) fail("VENV_EVIDENCE_FORBIDDEN", `forbidden public evidence value at ${segments.join(".")}`);
}

export function validatePublicEvidence(evidence) {
  assertPlainObject(evidence, "VENV_EVIDENCE_SCHEMA", "evidence");
  assertAllowedKeys(evidence, new Set(["kind", "schema_version", "schema_file_sha256", "attestor_source_sha256", "four_e_before_evidence_sha256", "four_e_after_evidence_sha256", "candidate_aggregate_sha256", "package_lock_sha256", "four_e_package_lock_role_sha256", "measurement_status", "execution_status", "packaging_authority", "environment_materialization_authority", "package_metadata_authority", "source_build_authority", "license_authority", "cpython_provenance_authority", "import_authority", "quality_gate_status", "formal_claims", "production_evidence", "public_distribution", "selection_authority", "worker_role", "input_scope", "target", "root_requirement_count", "distribution_count", "wheel_count", "built_wheel_count", "built_wheel_declaration_set_sha256", "installed_dist_info_contract_sha256", "materialized_environment_report_sha256", "runtime_target_probe_sha256", "validator_limits", "limitations"]), "VENV_EVIDENCE_SCHEMA", "evidence");
  if (evidence.kind !== PUBLIC_EVIDENCE_KIND || evidence.schema_version !== PUBLIC_EVIDENCE_SCHEMA_VERSION) fail("VENV_EVIDENCE_SCHEMA", "bad evidence kind or schema version");
  for (const key of ["schema_file_sha256", "attestor_source_sha256", "four_e_before_evidence_sha256", "four_e_after_evidence_sha256", "candidate_aggregate_sha256", "package_lock_sha256", "four_e_package_lock_role_sha256", "built_wheel_declaration_set_sha256", "installed_dist_info_contract_sha256", "materialized_environment_report_sha256", "runtime_target_probe_sha256"]) assertSha256(evidence[key], "VENV_EVIDENCE_SCHEMA", key);
  if (evidence.schema_file_sha256 !== sha256(readFileSync(PUBLIC_EVIDENCE_SCHEMA_PATH)) || evidence.attestor_source_sha256 !== sha256(readFileSync(ATTESTOR_SOURCE_PATH))) fail("VENV_EVIDENCE_SCHEMA", "source or schema digest mismatch");
  if (evidence.measurement_status !== "controlled-wheelhouse-and-venv-materialized-only" || evidence.execution_status !== "offline-install-pip-check-inspect-no-funasr-import" || evidence.packaging_authority !== "controlled-wheelhouse-and-offline-venv-only" || evidence.environment_materialization_authority !== "offline-venv-materialized" || evidence.package_metadata_authority !== "installed-dist-info-record-verified-only" || evidence.source_build_authority !== "none" || evidence.license_authority !== "none" || evidence.cpython_provenance_authority !== "none" || evidence.import_authority !== "none" || evidence.quality_gate_status !== "not-assessed" || evidence.formal_claims !== "none" || evidence.production_evidence !== false || evidence.public_distribution !== false || evidence.selection_authority !== "none" || evidence.worker_role !== "sidecar-candidate") fail("VENV_EVIDENCE_OVERCLAIM", "authority field overclaim");
  if (evidence.root_requirement_count !== 3 || evidence.distribution_count !== 77 || evidence.wheel_count !== 77 || evidence.built_wheel_count !== 5) fail("VENV_EVIDENCE_SCHEMA", "count mismatch");
  if (!["synthetic-valid-wheels-no-real-funasr-code", "caller-supplied-controlled-inputs-not-product-approved"].includes(evidence.input_scope)) fail("VENV_EVIDENCE_SCHEMA", "bad input scope");
  assertPlainObject(evidence.target, "VENV_EVIDENCE_SCHEMA", "target");
  assertAllowedKeys(evidence.target, new Set(["os", "arch", "cpython_version_family", "python_abi", "platform_tag", "accelerator_profile"]), "VENV_EVIDENCE_SCHEMA", "target");
  if (evidence.target.os !== "windows" || evidence.target.arch !== "amd64" || evidence.target.cpython_version_family !== "3.12.x" || evidence.target.python_abi !== "cp312" || evidence.target.platform_tag !== "win_amd64" || evidence.target.accelerator_profile !== "cpu-baseline") fail("VENV_EVIDENCE_SCHEMA", "bad target");
  assertPlainObject(evidence.validator_limits, "VENV_EVIDENCE_SCHEMA", "validator_limits");
  assertAllowedKeys(evidence.validator_limits, new Set(["pip_index_access", "max_process_timeout_ms", "max_process_output_bytes", "pip_install_flags_sha256", "public_evidence"]), "VENV_EVIDENCE_SCHEMA", "validator_limits");
  if (evidence.validator_limits.pip_index_access !== "disabled-by-no-index-and-sanitized-env" || evidence.validator_limits.max_process_timeout_ms !== MAX_PROCESS_TIMEOUT_MS || evidence.validator_limits.max_process_output_bytes !== MAX_PROCESS_OUTPUT_BYTES || evidence.validator_limits.public_evidence !== "path-url-name-text-free") fail("VENV_EVIDENCE_SCHEMA", "bad validator limits");
  assertSha256(evidence.validator_limits.pip_install_flags_sha256, "VENV_EVIDENCE_SCHEMA", "pip flags");
  if (!Array.isArray(evidence.limitations) || evidence.limitations.length !== LIMITATIONS.length) fail("VENV_EVIDENCE_SCHEMA", "limitations mismatch");
  for (const [index, item] of LIMITATIONS.entries()) if (evidence.limitations[index] !== item) fail("VENV_EVIDENCE_SCHEMA", "limitation drift");
  scanForbiddenPublicEvidence(evidence);
  return true;
}

export async function attestVenvMaterialization(controlledRoot, inputManifestPath, venvPythonPath, expectedAggregateSha256, options = {}) {
  assertPlainObject(options, "VENV_ATTEST_OPTIONS", "attestation options");
  assertAllowedKeys(options, new Set(["syntheticFixtureToken", "injectProcessFailure", "injectProcessTimeout", "injectProcessOversize", "injectRuntimeTargetMismatch", "afterInstallTamper", "afterInstallHardlink"]), "VENV_ATTEST_OPTIONS", "attestation options");
  assertSha256(expectedAggregateSha256, "VENV_AGGREGATE", "expected aggregate");
  const root = rejectUnsafeAbsolute(controlledRoot, "VENV_ROOT", "controlled root");
  let syntheticFixture = false;
  if (options.syntheticFixtureToken !== undefined) {
    const binding = SYNTHETIC_FIXTURE_BINDINGS.get(options.syntheticFixtureToken);
    const comparable = (value) => (process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value));
    if (
      binding === undefined
      || comparable(binding.root) !== comparable(root)
      || comparable(binding.manifestPath) !== comparable(inputManifestPath)
      || comparable(binding.venvPython) !== comparable(venvPythonPath)
      || binding.aggregate !== expectedAggregateSha256
    ) fail("VENV_SYNTHETIC_BINDING", "synthetic scope token is not bound to these exact fixture inputs");
    syntheticFixture = true;
  }
  const before = await attestPackageLock(root, inputManifestPath, expectedAggregateSha256);
  validatePackageLockEvidence(before);
  const lockEnvelope = await readPackageLock(root, inputManifestPath);
  const runtimeBinding = bindRuntimeRole(root, lockEnvelope.manifest, venvPythonPath);
  const lock = lockEnvelope.parsed;
  validateLockForMaterialization(lock);
  const materialized = await materializeAndInspect(root, lock, venvPythonPath, options);
  if (!sameIdentity(runtimeBinding.identity, fileIdentity(runtimeBinding.absolute, "VENV_RUNTIME_ROLE_DRIFT", "runtime role"))) fail("VENV_RUNTIME_ROLE_DRIFT", "runtime role identity drifted during materialization");
  const after = await attestPackageLock(root, inputManifestPath, expectedAggregateSha256);
  if (encodeCanonicalJson(before) !== encodeCanonicalJson(after)) fail("VENV_FOUR_E_DRIFT", "4e attestation changed across venv materialization");
  const schemaBytes = readFileSync(PUBLIC_EVIDENCE_SCHEMA_PATH);
  const attestorBytes = readFileSync(ATTESTOR_SOURCE_PATH);
  const builtSet = lock.distributions
    .filter((item) => item.built_wheel !== undefined)
    .map((item) => ({
      build_attestation_sha256: item.built_wheel.declared_build_attestation_sha256,
      name_sha256: sha256(normalizePackageName(item.name)),
      source_archive_sha256: item.built_wheel.source_archive.declared_sha256,
      source_archive_size_bytes: item.built_wheel.source_archive.declared_size_bytes,
      version_sha256: sha256(item.version),
    }))
    .sort((left, right) => left.name_sha256.localeCompare(right.name_sha256));
  const evidence = {
    kind: PUBLIC_EVIDENCE_KIND,
    schema_version: PUBLIC_EVIDENCE_SCHEMA_VERSION,
    schema_file_sha256: sha256(schemaBytes),
    attestor_source_sha256: sha256(attestorBytes),
    four_e_before_evidence_sha256: sha256(Buffer.from(encodeCanonicalJson(before), "utf8")),
    four_e_after_evidence_sha256: sha256(Buffer.from(encodeCanonicalJson(after), "utf8")),
    candidate_aggregate_sha256: before.candidate_aggregate_sha256,
    package_lock_sha256: lockEnvelope.sha256,
    four_e_package_lock_role_sha256: before.package_lock_role.sha256,
    measurement_status: "controlled-wheelhouse-and-venv-materialized-only",
    execution_status: "offline-install-pip-check-inspect-no-funasr-import",
    packaging_authority: "controlled-wheelhouse-and-offline-venv-only",
    environment_materialization_authority: "offline-venv-materialized",
    package_metadata_authority: "installed-dist-info-record-verified-only",
    source_build_authority: "none",
    license_authority: "none",
    cpython_provenance_authority: "none",
    import_authority: "none",
    quality_gate_status: "not-assessed",
    formal_claims: "none",
    production_evidence: false,
    public_distribution: false,
    selection_authority: "none",
    worker_role: "sidecar-candidate",
    input_scope: syntheticFixture ? "synthetic-valid-wheels-no-real-funasr-code" : "caller-supplied-controlled-inputs-not-product-approved",
    target: lock.target,
    root_requirement_count: lock.root_requirements.length,
    distribution_count: lock.distributions.length,
    wheel_count: lock.distributions.length,
    built_wheel_count: builtSet.length,
    built_wheel_declaration_set_sha256: sha256(Buffer.from(encodeCanonicalJson(builtSet), "utf8")),
    installed_dist_info_contract_sha256: materialized.dist_info_contract_sha256,
    materialized_environment_report_sha256: materialized.report_sha256,
    runtime_target_probe_sha256: materialized.runtime_target_probe_sha256,
    validator_limits: {
      pip_index_access: "disabled-by-no-index-and-sanitized-env",
      max_process_timeout_ms: MAX_PROCESS_TIMEOUT_MS,
      max_process_output_bytes: MAX_PROCESS_OUTPUT_BYTES,
      pip_install_flags_sha256: materialized.pip_install_flags_sha256,
      public_evidence: "path-url-name-text-free",
    },
    limitations: [...LIMITATIONS],
  };
  validatePublicEvidence(evidence);
  return evidence;
}

function versionForName(name) {
  const fixed = new Map([
    ["funasr", "1.3.22"],
    ["torch", "2.6.0+cpu"],
    ["torchaudio", "2.6.0+cpu"],
    ["aliyun-python-sdk-core", "2.16.0"],
    ["antlr4-python3-runtime", "4.9.3"],
    ["crcmod", "1.7"],
    ["jieba", "0.42.1"],
    ["oss2", "2.19.1"],
  ]);
  return fixed.get(name) ?? `0.0.${Number(name.split("-").at(-1))}`;
}

function syntheticNames() {
  const generated = Array.from({ length: 69 }, (_, index) => `mr-synthetic-${String(index + 1).padStart(2, "0")}`);
  return [...new Set(["funasr", "torch", "torchaudio", ...BUILT_WHEEL_NAMES, ...generated])].sort((left, right) => normalizePackageName(left).localeCompare(normalizePackageName(right)));
}

function wheelFilename(name, version) {
  return `${name.replaceAll("-", "_")}-${version}-py3-none-any.whl`;
}

async function buildSyntheticWheels(root, metadataOverrides = new Map()) {
  const names = syntheticNames();
  const specs = names.map((name) => {
    const version = versionForName(name);
    const normalized = normalizePackageName(name);
    const dependencies = normalized === "funasr"
      ? names.filter((candidate) => candidate !== "funasr").map((candidate) => `${candidate}==${versionForName(candidate)}`).sort()
      : [];
    return { name, normalized, version, dependencies, filename: wheelFilename(name, version) };
  });
  const builder = [
    "import base64, csv, hashlib, io, json, pathlib, zipfile, sys",
    "root=pathlib.Path(sys.argv[1]); specs=json.loads(pathlib.Path(sys.argv[2]).read_text(encoding='utf-8')); wheelhouse=root/'wheelhouse'; wheelhouse.mkdir(parents=True, exist_ok=True)",
    "def b64(data): return base64.urlsafe_b64encode(hashlib.sha256(data).digest()).decode().rstrip('=')",
    "out=[]",
    "for s in specs:",
    " dist=s['name'].replace('-','_'); ver=s['version']; di=f'{dist}-{ver}.dist-info'; rows=[]; files={}",
    " meta=['Metadata-Version: 2.1', f'Name: {s[\"name\"]}', f'Version: {ver}']+[f'Requires-Dist: {d}' for d in s['dependencies']]",
    " files[f'{di}/METADATA']=('\\n'.join(meta)+'\\n').encode()",
    " files[f'{di}/WHEEL']=(f'Wheel-Version: 1.0\\nGenerator: meetingrelay-synthetic\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n').encode()",
    " files[f'{di}/top_level.txt']=b''",
    " for p,d in sorted(files.items()): rows.append([p, 'sha256='+b64(d), str(len(d))])",
    " rows.append([f'{di}/RECORD','',''])",
    " rec=io.StringIO(); csv.writer(rec, lineterminator='\\n').writerows(rows); files[f'{di}/RECORD']=rec.getvalue().encode()",
    " whl=wheelhouse/s['filename']",
    " with zipfile.ZipFile(whl,'w',compression=zipfile.ZIP_DEFLATED) as z:",
    "  for p,d in sorted(files.items()):",
    "   info=zipfile.ZipInfo(p, (1980,1,1,0,0,0)); info.compress_type=zipfile.ZIP_DEFLATED; info.external_attr=0o644 << 16; z.writestr(info,d)",
    " data=whl.read_bytes(); out.append({'name':s['name'],'normalized':s['normalized'],'version':ver,'dependencies':s['dependencies'],'filename':s['filename'],'relative_path':'wheelhouse/'+s['filename'],'sha256':hashlib.sha256(data).hexdigest(),'size_bytes':len(data)})",
    "print(json.dumps(out, sort_keys=True, separators=(',', ':')))",
  ].join("\n");
  const hostPython = await resolveHostPython({ cwd: root, tempDir: root });
  const specsPath = path.join(root, "inputs", "synthetic-wheel-specs.json");
  await mkdir(path.dirname(specsPath), { recursive: true });
  await writeFile(specsPath, encodeCanonicalJson(specs), "utf8");
  const result = await execFileAsync(hostPython, ["-I", "-B", "-c", builder, root, specsPath], {
    windowsHide: true,
    shell: false,
    detached: false,
    timeout: MAX_PROCESS_TIMEOUT_MS,
    maxBuffer: MAX_PROCESS_OUTPUT_BYTES,
    cwd: root,
    env: { SystemRoot: process.env.SystemRoot ?? "C:\\Windows", TEMP: root, TMP: root, PYTHONIOENCODING: "utf-8", PYTHONDONTWRITEBYTECODE: "1", PYTHONNOUSERSITE: "1" },
  }).catch((error) => fail("VENV_SYNTHETIC_WHEEL_BUILD", `synthetic wheel build failed: ${String(error.stderr || error.message).slice(0, 2000)}`));
  const wheels = JSON.parse(result.stdout);
  return wheels.map((wheel) => {
    const metadata = metadataOverrides.get(wheel.normalized);
    return {
      name: wheel.name,
      version: wheel.version,
      wheel: {
        filename: wheel.filename,
        relative_path: wheel.relative_path,
        sha256: wheel.sha256,
        size_bytes: wheel.size_bytes,
        declared_source_url: `https://files.pythonhosted.org/packages/synthetic/${wheel.filename}`,
        tags: ["py3-none-any"],
      },
      dependencies: wheel.dependencies,
      declared_top_level_imports: wheel.normalized === "funasr" ? ["funasr"] : [],
      declared_dist_info_metadata_sha256: metadata?.metadata_sha256 ?? "a".repeat(64),
      declared_dist_info_record_sha256: metadata?.record_sha256 ?? "b".repeat(64),
      declared_license_files_aggregate_sha256: sha256(`${wheel.normalized}-${wheel.version}-license\n`),
      ...(BUILT_WHEEL_NAMES.includes(wheel.normalized)
        ? {
            built_wheel: {
              source_archive: {
                filename: `${wheel.name}-${wheel.version}.tar.gz`,
                declared_source_url: `https://files.pythonhosted.org/packages/source/${wheel.name[0]}/${wheel.name}/${wheel.name}-${wheel.version}.tar.gz`,
                declared_sha256: sha256(`${wheel.normalized}-${wheel.version}-source\n`),
                declared_size_bytes: 1000 + wheel.normalized.length,
              },
              declared_build_attestation_sha256: sha256(`${wheel.normalized}-${wheel.version}-build\n`),
            },
          }
        : {}),
    };
  });
}

function buildLock(distributions, options = {}) {
  const importMapSha = sha256("funasr=>funasr\n");
  return {
    kind: "meetingrelay-funasr-sidecar-package-lock-v1",
    schema_version: "1.0",
    worker_role: "sidecar-candidate",
    target: { os: "windows", arch: "amd64", cpython_version_family: "3.12.x", python_abi: "cp312", platform_tag: "win_amd64", accelerator_profile: "cpu-baseline" },
    resolver_declaration: { tool: "pip", version: options.resolverVersion ?? "25.1.1", declared_report_sha256: "c".repeat(64) },
    materialization_policy: { wheelhouse_scope: "local-controlled-root-only", network: "disabled", index_access: "disabled", package_forms: ["wheel"], require_hashes: true, install_no_deps: true, allow_sdist: false, allow_editable: false, allow_vcs: false, allow_user_site: false, allow_global_site: false, allow_direct_url: false },
    root_requirements: [...ROOT_REQUIREMENTS],
    distributions,
    expected_environment_report: { report_kind: "pip-inspect-v1", expected_sha256: options.expectedReportSha256 ?? "d".repeat(64), expected_distribution_count: 77, expected_top_level_import_map_sha256: importMapSha, verification_status: "not-materialized-not-verified" },
  };
}

async function createFixtureVenv(root, name) {
  const hostPython = await resolveHostPython({ cwd: root, tempDir: root });
  const venvRoot = path.join(root, name);
  await runProcess(hostPython, ["-I", "-m", "venv", venvRoot], "fixture_venv", { cwd: root, tempDir: root });
  return path.join(venvRoot, "Scripts", "python.exe");
}

function relativeFromRoot(root, absolutePath) {
  const absolute = ensureInside(root, absolutePath, "VENV_FIXTURE_PATH", "fixture path");
  const relative = path.relative(root, absolute).replaceAll(path.sep, "/");
  if (relative.startsWith("../") || relative === ".." || relative.length === 0) fail("VENV_FIXTURE_PATH", "fixture path escaped root");
  return relative;
}

async function writeManifest(root, lockBytes, runtimePythonPath) {
  const files = [];
  await mkdir(path.join(root, "inputs"), { recursive: true });
  await writeFile(path.join(root, "inputs", "package-lock.json"), lockBytes);
  for (const role of REQUIRED_ROLES) {
    if (role === "package-lock") {
      files.push({ role, logical_id: "package-lock", relative_path: "inputs/package-lock.json", sha256: sha256(lockBytes), size_bytes: lockBytes.length });
    } else if (role === "runtime") {
      const bytes = readFileSync(runtimePythonPath);
      files.push({ role, logical_id: "venv-materialization-runtime", relative_path: relativeFromRoot(root, runtimePythonPath), sha256: sha256(bytes), size_bytes: bytes.length });
    } else {
      const bytes = Buffer.from(`synthetic ${role} bytes\n`, "utf8");
      const relative = `inputs/${role}.bin`;
      await writeFile(path.join(root, ...relative.split("/")), bytes);
      files.push({ role, logical_id: `venv-materialization-${role}`, relative_path: relative, sha256: sha256(bytes), size_bytes: bytes.length });
    }
  }
  files.sort((left, right) => left.role.localeCompare(right.role));
  const manifest = { kind: "meetingrelay-funasr-sidecar-candidate-preflight-input-v1", schema_version: "1.0", worker_role: "sidecar-candidate", measurement_status: "identity-preflight-only", execution_status: "not-executed", quality_gate_status: "not-assessed", formal_claims: "none", production_evidence: false, public_distribution: false, selection_authority: "none", files };
  const manifestPath = path.join(root, "input-manifest.json");
  await writeFile(manifestPath, encodeCanonicalJson(manifest), "utf8");
  return manifestPath;
}

async function collectInstalledDeclarations(root, lock, manifestPath, aggregate) {
  const probeVenvPython = await createFixtureVenv(root, "probe-venv");
  const materialized = await materializeAndInspect(root, lock, probeVenvPython, { fixtureProbeToken: FIXTURE_PROBE_TOKEN });
  const metadata = new Map();
  for (const distribution of lock.distributions) {
    const normalized = normalizePackageName(distribution.name);
    const distInfo = path.join(root, "probe-venv", "Lib", "site-packages", `${distribution.name.replaceAll("-", "_")}-${distribution.version}.dist-info`);
    metadata.set(normalized, {
      metadata_sha256: sha256(readFileSync(path.join(distInfo, "METADATA"))),
      record_sha256: sha256(readFileSync(path.join(distInfo, "RECORD"))),
    });
  }
  await rm(path.join(root, "probe-venv"), { recursive: true, force: true });
  await attestPackageLock(root, manifestPath, aggregate);
  return { metadata, expectedReportSha256: materialized.report_sha256 };
}

export async function createSyntheticVenvMaterializationFixture(options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "meetingrelay-venv-materialize-"));
  let owned = true;
  try {
    const venvPython = await createFixtureVenv(root, "attested-venv");
    const resolverVersion = await queryPipVersion(venvPython, { cwd: root, tempDir: root });
    let distributions = await buildSyntheticWheels(root);
    let lock = buildLock(distributions, { resolverVersion });
    let lockBytes = Buffer.from(encodeCanonicalJson(lock), "utf8");
    let manifestPath = await writeManifest(root, lockBytes, venvPython);
    let preflight = await preflightCandidate(root, manifestPath);
    const declarations = await collectInstalledDeclarations(root, lock, manifestPath, preflight.candidate_descriptor.aggregate_sha256);
    distributions = await buildSyntheticWheels(root, declarations.metadata);
    lock = buildLock(distributions, { resolverVersion, expectedReportSha256: declarations.expectedReportSha256 });
    options.mutateLock?.(lock);
    lockBytes = Buffer.from(encodeCanonicalJson(lock), "utf8");
    manifestPath = await writeManifest(root, lockBytes, venvPython);
    preflight = await preflightCandidate(root, manifestPath);
    const syntheticFixtureToken = Object.freeze({});
    SYNTHETIC_FIXTURE_BINDINGS.set(syntheticFixtureToken, {
      aggregate: preflight.candidate_descriptor.aggregate_sha256,
      manifestPath,
      root,
      venvPython,
    });
    owned = false;
    return { aggregate: preflight.candidate_descriptor.aggregate_sha256, lock, manifestPath, root, syntheticFixtureToken, venvPython };
  } finally {
    if (owned) await rm(root, { recursive: true, force: true });
  }
}

async function runSyntheticValidation() {
  const fixture = await createSyntheticVenvMaterializationFixture();
  try {
    return await attestVenvMaterialization(fixture.root, fixture.manifestPath, fixture.venvPython, fixture.aggregate, { syntheticFixtureToken: fixture.syntheticFixtureToken });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length === 1 && argv[0] === "--run-synthetic") {
    const evidence = await runSyntheticValidation();
    const text = encodeCanonicalJson(evidence);
    process.stdout.write(`funasr-sidecar-venv-materialization-attestation=verified evidence_sha256=${sha256(Buffer.from(text, "utf8"))} candidate_aggregate_sha256=${evidence.candidate_aggregate_sha256} package_lock_sha256=${evidence.package_lock_sha256} distributions=77 wheels=77 root_requirements=3 built_wheels=5 measurement_status=${evidence.measurement_status} execution_status=${evidence.execution_status} packaging_authority=${evidence.packaging_authority} environment_materialization_authority=${evidence.environment_materialization_authority} package_metadata_authority=${evidence.package_metadata_authority} source_build_authority=none license_authority=none cpython_provenance_authority=none import_authority=none quality_gate_status=not-assessed formal_claims=none production_evidence=false public_distribution=false selection_authority=none fixture_scope=synthetic-valid-wheels-no-real-funasr-code\n`);
    return;
  }
  if (argv.length === 5 && argv[0] === "--attest") {
    const evidence = await attestVenvMaterialization(argv[1], argv[2], argv[3], argv[4]);
    const text = encodeCanonicalJson(evidence);
    process.stdout.write(`funasr-sidecar-venv-materialization-attestation=verified evidence_sha256=${sha256(Buffer.from(text, "utf8"))} candidate_aggregate_sha256=${evidence.candidate_aggregate_sha256} package_lock_sha256=${evidence.package_lock_sha256} distributions=77 wheels=77 root_requirements=3 built_wheels=5 measurement_status=${evidence.measurement_status} execution_status=${evidence.execution_status} packaging_authority=${evidence.packaging_authority} environment_materialization_authority=${evidence.environment_materialization_authority} package_metadata_authority=${evidence.package_metadata_authority} source_build_authority=none license_authority=none cpython_provenance_authority=none import_authority=none quality_gate_status=not-assessed formal_claims=none production_evidence=false public_distribution=false selection_authority=none\n`);
    return;
  }
  if (argv.length === 2 && argv[0] === "--validate-json") {
    let evidence;
    try {
      evidence = JSON.parse(argv[1]);
    } catch (error) {
      fail("VENV_EVIDENCE_JSON", `evidence must parse as JSON: ${error.message}`);
    }
    if (encodeCanonicalJson(evidence) !== argv[1]) fail("VENV_EVIDENCE_CANONICAL", "evidence must be canonical JSON");
    validatePublicEvidence(evidence);
    process.stdout.write(`funasr-sidecar-venv-materialization-attestation-json=verified evidence_sha256=${sha256(Buffer.from(encodeCanonicalJson(evidence), "utf8"))}\n`);
    return;
  }
  fail("VENV_ATTEST_USAGE", "usage: venv attestor expects --run-synthetic, --attest <controlled-root> <manifest> <absolute-venv-python> <aggregate>, or --validate-json <canonical-json>");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.code ?? "VENV_ATTEST_FAILED"}: ${error.message}\n`);
    process.exitCode = 1;
  });
}
