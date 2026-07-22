#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { encodeCanonicalJson } from "../phase0-harness/canonical-json.mjs";
import { preflightCandidate } from "./sidecar-candidate-preflight.mjs";
import { attestArtifactPack, validatePublicEvidence as validateArtifactPackEvidence } from "./sidecar-artifact-pack-attestation.mjs";
import { attestPackageLock, normalizePackageName, readPackageLockFromCanonicalBytes, validatePublicEvidence as validatePackageLockEvidence } from "./sidecar-package-lock-attestation.mjs";
import { createSyntheticVenvMaterializationFixture } from "./sidecar-venv-materialization-attestation.mjs";

const execFileAsync = promisify(execFile);

export const PUBLIC_EVIDENCE_KIND = "meetingrelay-funasr-sidecar-install-scheme-record-attestation-v1";
export const PUBLIC_EVIDENCE_SCHEMA_VERSION = "1.0";
export const PUBLIC_EVIDENCE_SCHEMA_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "sidecar-install-scheme-record-attestation.schema.json",
);
export const ATTESTOR_SOURCE_PATH = fileURLToPath(import.meta.url);

const ZERO_SHA = "0".repeat(64);
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const MAX_PROCESS_TIMEOUT_MS = 120_000;
const MAX_PROCESS_OUTPUT_BYTES = 1024 * 1024;
const ROOT_REQUIREMENTS = Object.freeze(["funasr==1.3.22", "torch==2.6.0+cpu", "torchaudio==2.6.0+cpu"]);
const BUILT_WHEEL_NAMES = Object.freeze(["aliyun-python-sdk-core", "antlr4-python3-runtime", "crcmod", "jieba", "oss2"]);
const TARGET = Object.freeze({
  os: "windows",
  arch: "amd64",
  cpython_version_family: "3.12.x",
  python_abi: "cp312",
  platform_tag: "win_amd64",
  accelerator_profile: "cpu-baseline",
});
const LIMITATIONS = Object.freeze([
  "install-scheme-record-closure-only: this validates a caller-supplied existing 4b-bound virtual environment by offline installing local wheels and checking installed RECORD targets against bound runtime sysconfig roots; it is not CPython provenance or OS network isolation authority",
  "direct wheel-spread script and constrained data targets are allowed only when installed bytes equal their exact wheel data member and RECORD binds those bytes; generated launchers and package imports are not authorized by this slice",
  "artifact-pack bytes are re-attested before and after install-scheme verification, but source builds, license approval, resolver semantics, and report semantics are not replayed",
  "synthetic CI wheels contain no real FunASR, PyTorch, model, audio, network, or product package code; they exercise install-scheme mechanics only",
  "public evidence intentionally omits filesystem paths, artifact filenames, package names, requirement text, URLs, license text, report text, host identity, timings, and plaintext",
]);
const ALLOWED_PUBLIC_STRINGS = new Set([
  PUBLIC_EVIDENCE_KIND,
  PUBLIC_EVIDENCE_SCHEMA_VERSION,
  "controlled-wheelhouse-install-scheme-record-closure-only",
  "offline-install-pip-check-inspect-record-closure-no-funasr-import",
  "artifact-pack-and-install-scheme-byte-closure-only",
  "offline-venv-materialized",
  "installed-dist-info-record-and-allowlisted-scheme-files-verified-only",
  "bound-runtime-sysconfig-observed-only",
  "source-archive-and-build-record-target-bytes-bound-only",
  "license-set-target-bytes-verified-not-legal-approval",
  "target-record-bytes-bound-only",
  "expected-projection-target-bytes-bound-only",
  "target-bytes-bound-no-import",
  "none",
  "not-assessed",
  "sidecar-candidate",
  "windows",
  "amd64",
  "3.12.x",
  "cp312",
  "win_amd64",
  "cpu-baseline",
  "synthetic-install-scheme-record-contract-only",
  "caller-supplied-controlled-inputs-not-product-approved",
  "disabled-by-no-index-and-sanitized-env",
  "path-url-name-text-free",
  ...LIMITATIONS,
]);
const FORBIDDEN_PUBLIC_KEYS = new Set(["absolute_path", "artifact", "content", "dependency", "direct_url", "file_path", "filename", "license_text", "package", "path", "requirement", "root", "source", "text", "url", "wheel_url"]);
const FORBIDDEN_PUBLIC_VALUE_RE = /(?:[A-Za-z]:\\|\\\\|\/tmp\/|\/home\/|\/Users\/|wheelhouse\/|artifacts\/|inputs\/|site-packages|https?:\/\/|file:\/\/|funasr|torch|torchaudio|jieba|oss2|crcmod|aliyun|antlr|==|\.whl|\.tar\.gz)/iu;

export class InstallSchemeRecordAttestationError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "InstallSchemeRecordAttestationError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new InstallSchemeRecordAttestationError(code, message);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function assertPlainObject(value, code, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(code, `${label} must be an object`);
}

function assertAllowedKeys(value, allowed, code, label) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(code, `${label} has unknown field ${key}`);
}

function assertSha256(value, code, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value) || value === ZERO_SHA) fail(code, `${label} must be non-zero lowercase sha256`);
}

function rejectUnsafeAbsolute(inputPath, code, label) {
  if (typeof inputPath !== "string" || inputPath.length === 0 || inputPath.includes("\0") || /[\r\n]/u.test(inputPath)) fail(code, `${label} must be a safe path`);
  if (inputPath.startsWith("\\\\") || inputPath.startsWith("//") || /^\\\\[.?]\\|^\/\/[.?]\//u.test(inputPath)) fail(code, `${label} must not use UNC or device syntax`);
  const colonIndexes = [...inputPath.matchAll(/:/gu)].map((match) => match.index);
  const hasDriveColon = colonIndexes.length === 1 && colonIndexes[0] === 1 && /^[A-Za-z]:[\\/]/u.test(inputPath);
  if ((colonIndexes.length > 0 && !hasDriveColon) || /^[A-Za-z]:(?![\\/])/u.test(inputPath) || !path.isAbsolute(inputPath)) fail(code, `${label} must be absolute local path without ADS or drive-relative syntax`);
  return path.resolve(inputPath);
}

function ensureAbsoluteInsideRoot(root, absolutePath, code, label) {
  const resolvedRoot = path.resolve(root);
  const resolved = rejectUnsafeAbsolute(absolutePath, code, label);
  const prefix = resolvedRoot.endsWith(path.sep) ? resolvedRoot : `${resolvedRoot}${path.sep}`;
  const comparablePrefix = process.platform === "win32" ? prefix.toLowerCase() : prefix;
  const comparableResolved = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  if (resolved === resolvedRoot || !comparableResolved.startsWith(comparablePrefix)) fail(code, `${label} escaped controlled root`);
  return resolved;
}

function validateRelativePath(relativePath, code, label) {
  if (typeof relativePath !== "string" || relativePath.length === 0 || relativePath.length > 512 || relativePath !== relativePath.normalize("NFC")) fail(code, `${label} must be a bounded NFC relative path`);
  if (relativePath.includes("\\") || relativePath.includes("\0") || relativePath.startsWith("/") || path.posix.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath)) fail(code, `${label} must not contain absolute, UNC, or backslash syntax`);
  if (relativePath.includes(":")) fail(code, `${label} must not contain Windows drive, ADS, or URL syntax`);
  for (const segment of relativePath.split("/")) {
    if (segment === "" || segment === "." || segment.endsWith(" ") || segment.endsWith(".") || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(segment)) fail(code, `${label} contains reserved or unsafe segment`);
  }
  return relativePath;
}

function ensureInside(root, relativePath, code, label) {
  validateRelativePath(relativePath, code, label);
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, ...relativePath.split("/"));
  const prefix = resolvedRoot.endsWith(path.sep) ? resolvedRoot : `${resolvedRoot}${path.sep}`;
  const comparablePrefix = process.platform === "win32" ? prefix.toLowerCase() : prefix;
  const comparableResolved = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  if (resolved === resolvedRoot || !comparableResolved.startsWith(comparablePrefix)) fail(code, `${label} escaped controlled root`);
  return resolved;
}

function assertNoSymlinkComponents(root, absolutePath, code, label) {
  const resolvedRoot = path.resolve(root);
  const resolved = ensureAbsoluteInsideRoot(resolvedRoot, absolutePath, code, label);
  const relative = path.relative(resolvedRoot, resolved);
  let current = resolvedRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = lstatSync(current, { bigint: true });
    if (stat.isSymbolicLink()) fail(code, `${label} must not traverse a symlink or junction`);
  }
  return resolved;
}

async function readCanonicalJsonFile(filePath, maxBytes, code, label) {
  const bytes = await readFile(filePath);
  if (bytes.length < 1 || bytes.length > maxBytes) fail(code, `${label} size outside limit`);
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail(code, `${label} must be valid UTF-8`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    fail(code, `${label} must parse as JSON: ${error.message}`);
  }
  if (encodeCanonicalJson(parsed) !== text) fail(code, `${label} must be canonical JSON`);
  return { bytes, parsed, sha256: sha256(bytes), size_bytes: bytes.length };
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
  const roles = manifest.files?.filter((entry) => entry.role === "runtime") ?? [];
  if (roles.length !== 1) fail("INSTALL_SCHEME_RUNTIME_ROLE", "input manifest must contain exactly one runtime role");
  const role = roles[0];
  const rolePath = ensureInside(controlledRoot, role.relative_path, "INSTALL_SCHEME_RUNTIME_ROLE", "runtime role");
  const requested = rejectUnsafeAbsolute(venvPythonPath, "INSTALL_SCHEME_PYTHON_PATH", "venv python");
  const comparable = (value) => (process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value));
  if (comparable(rolePath) !== comparable(requested)) fail("INSTALL_SCHEME_RUNTIME_ROLE", "caller venv python must be the 4b-bound runtime role");
  assertNoSymlinkComponents(controlledRoot, rolePath, "INSTALL_SCHEME_RUNTIME_ROLE", "runtime role");
  const bytes = readFileSync(rolePath);
  if (sha256(bytes) !== role.sha256 || bytes.length !== role.size_bytes) fail("INSTALL_SCHEME_RUNTIME_ROLE_DRIFT", "runtime role bytes drifted from input manifest");
  return { absolute: rolePath, identity: fileIdentity(rolePath, "INSTALL_SCHEME_RUNTIME_ROLE", "runtime role") };
}

async function runProcess(executable, args, label, options = {}) {
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
    return await execFileAsync(executable, args, {
      windowsHide: true,
      shell: false,
      detached: false,
      timeout: options.timeoutMs ?? MAX_PROCESS_TIMEOUT_MS,
      maxBuffer: options.maxOutputBytes ?? MAX_PROCESS_OUTPUT_BYTES,
      cwd: options.cwd,
      env,
    });
  } catch (error) {
    if (error.killed || error.signal === "SIGTERM") fail(`INSTALL_SCHEME_PROCESS_${label.toUpperCase()}_TIMEOUT`, `${label} timed out`);
    if (/maxBuffer/iu.test(String(error.message))) fail(`INSTALL_SCHEME_PROCESS_${label.toUpperCase()}_OUTPUT`, `${label} output exceeded limit`);
    fail(`INSTALL_SCHEME_PROCESS_${label.toUpperCase()}`, `${label} failed: ${String(error.stderr || error.message).slice(0, 2000)}`);
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
  }).catch(() => fail("INSTALL_SCHEME_HOST_PYTHON", "could not resolve host Python 3.12"));
  const lines = probe.stdout.trim().split(/\r?\n/u);
  if (lines[1] !== "3.12") fail("INSTALL_SCHEME_HOST_PYTHON", "host Python must be CPython 3.12");
  return lines[0];
}

async function createFixtureVenv(root, name) {
  const hostPython = await resolveHostPython({ cwd: root, tempDir: root });
  const venvRoot = path.join(root, name);
  await runProcess(hostPython, ["-I", "-m", "venv", venvRoot], "fixture_venv", { cwd: root, tempDir: root });
  return path.join(venvRoot, "Scripts", "python.exe");
}

function validateVenvPythonPath(controlledRoot, venvPythonPath) {
  const absolute = ensureAbsoluteInsideRoot(controlledRoot, rejectUnsafeAbsolute(venvPythonPath, "INSTALL_SCHEME_PYTHON_PATH", "venv python"), "INSTALL_SCHEME_PYTHON_PATH", "venv python");
  assertNoSymlinkComponents(controlledRoot, absolute, "INSTALL_SCHEME_PYTHON_PATH", "venv python");
  const scriptDir = path.basename(path.dirname(absolute)).toLowerCase();
  const exeName = path.basename(absolute).toLowerCase();
  if (process.platform === "win32") {
    if (scriptDir !== "scripts" || exeName !== "python.exe") fail("INSTALL_SCHEME_PYTHON_PATH", "Windows venv python must be Scripts/python.exe");
  } else if (scriptDir !== "bin" || exeName !== "python") {
    fail("INSTALL_SCHEME_PYTHON_PATH", "POSIX venv python must be bin/python");
  }
  const venvRoot = path.dirname(path.dirname(absolute));
  if (path.resolve(venvRoot) === path.resolve(controlledRoot)) fail("INSTALL_SCHEME_PYTHON_PATH", "venv root must not equal controlled root");
  const stat = lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) fail("INSTALL_SCHEME_PYTHON_PATH", "venv python must be an existing regular file");
  const cfgPath = path.join(venvRoot, "pyvenv.cfg");
  assertNoSymlinkComponents(controlledRoot, cfgPath, "INSTALL_SCHEME_VENV_CONFIG", "venv configuration");
  const cfg = readFileSync(cfgPath, "utf8");
  if (!/^include-system-site-packages\s*=\s*false\s*$/imu.test(cfg)) fail("INSTALL_SCHEME_VENV_CONFIG", "venv must disable system site packages");
  return { absolute, venvRoot };
}

async function queryBoundRuntimeSysconfig(venvPython, options = {}) {
  const script = [
    "import json, os, platform, struct, sys, sysconfig",
    "keys=['purelib','platlib','scripts','data']",
    "value={'cache_tag':sys.implementation.cache_tag,'implementation':sys.implementation.name,'machine':platform.machine(),'os_name':os.name,'pointer_bits':struct.calcsize('P')*8,'sys_platform':sys.platform,'sysconfig_platform':sysconfig.get_platform(),'version':[sys.version_info.major,sys.version_info.minor],'paths':{k:sysconfig.get_path(k) for k in keys}}",
    "print(json.dumps(value,sort_keys=True,separators=(',',':')))",
  ].join("\n");
  const result = await runProcess(venvPython, ["-I", "-B", "-c", script], "runtime_sysconfig", options);
  let observed;
  try {
    observed = JSON.parse(result.stdout);
  } catch {
    fail("INSTALL_SCHEME_SYSCONFIG", "runtime sysconfig probe must return JSON");
  }
  const machine = typeof observed.machine === "string" ? observed.machine.toLowerCase().replaceAll("_", "-") : "";
  if (
    observed.implementation !== "cpython"
    || observed.cache_tag !== "cpython-312"
    || JSON.stringify(observed.version) !== "[3,12]"
    || observed.os_name !== "nt"
    || observed.sys_platform !== "win32"
    || (machine !== "" && !["amd64", "x86-64"].includes(machine))
    || observed.pointer_bits !== 64
    || observed.sysconfig_platform !== "win-amd64"
  ) fail("INSTALL_SCHEME_SYSCONFIG_TARGET", `bound runtime does not match Windows AMD64 CPython 3.12 target: ${JSON.stringify({
    cache_tag: observed.cache_tag,
    implementation: observed.implementation,
    machine: observed.machine,
    os_name: observed.os_name,
    pointer_bits: observed.pointer_bits,
    sys_platform: observed.sys_platform,
    sysconfig_platform: observed.sysconfig_platform,
    version: observed.version,
  })}`);
  for (const key of ["purelib", "platlib", "scripts", "data"]) rejectUnsafeAbsolute(observed.paths?.[key], "INSTALL_SCHEME_SYSCONFIG_PATH", `${key} sysconfig path`);
  return observed;
}

async function verifyBootstrapOnly(venvPython, options = {}) {
  const script = "import importlib.metadata as m, json; print(json.dumps(sorted(d.metadata['Name'].lower().replace('_','-') for d in m.distributions())))";
  const result = await runProcess(venvPython, ["-I", "-B", "-c", script], "bootstrap", options);
  const installed = JSON.parse(result.stdout);
  for (const name of installed) if (!["pip", "setuptools", "wheel"].includes(name)) fail("INSTALL_SCHEME_BOOTSTRAP", "venv must contain only bootstrap packages before materialization");
}

async function queryPipVersion(venvPython, options = {}) {
  const result = await runProcess(venvPython, ["-I", "-B", "-c", "import pip; print(pip.__version__)"], "resolver", options);
  const version = result.stdout.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._+!-]{0,127}$/u.test(version)) fail("INSTALL_SCHEME_RESOLVER_VERSION", "pip version output is invalid");
  return version;
}

function directWheelSpreadKey(distributionIndex, kind, relativePath) {
  return `${distributionIndex}\0${kind}\0${relativePath.toLowerCase()}`;
}

async function queryDirectWheelSpread(controlledRoot, lock, venvPython, options = {}) {
  const wheels = lock.distributions.map((distribution, distributionIndex) => {
    const wheelPath = ensureInside(controlledRoot, distribution.wheel.relative_path, "INSTALL_SCHEME_DIRECT_WHEEL_PATH", "wheel");
    const filename = path.basename(wheelPath);
    const filenameParts = filename.endsWith(".whl") ? filename.slice(0, -4).split("-") : [];
    if (filenameParts.length < 5) fail("INSTALL_SCHEME_DIRECT_WHEEL_PATH", "wheel filename cannot define a wheel data directory");
    return {
      data_root: `${filenameParts[0]}-${filenameParts[1]}.data`,
      distribution_index: distributionIndex,
      wheel_path: wheelPath,
    };
  });
  const specPath = path.join(controlledRoot, "inputs", "install-scheme-direct-wheel-spread.json");
  await mkdir(path.dirname(specPath), { recursive: true });
  await writeFile(specPath, encodeCanonicalJson(wheels), "utf8");
  const script = [
    "import hashlib, json, pathlib, stat, sys, zipfile",
    "spec=json.loads(pathlib.Path(sys.argv[1]).read_text(encoding='utf-8'))",
    "out=[]; total_bytes=0",
    "for wheel in spec:",
    " with zipfile.ZipFile(wheel['wheel_path'],'r') as archive:",
    "  seen=set()",
    "  for info in archive.infolist():",
    "   name=info.filename",
    "   if info.is_dir(): continue",
    "   parts=name.split('/')",
    "   kind=None; relative=None",
    "   if len(parts)>=3 and parts[0]==wheel['data_root'] and parts[1]=='scripts': kind='scripts'; relative='/'.join(parts[2:])",
    "   elif len(parts)>=5 and parts[0]==wheel['data_root'] and parts[1:4]==['data','share','meetingrelay-sidecar-artifacts']: kind='constrained-data'; relative='/'.join(parts[4:])",
    "   if kind is None: continue",
    "   key=(kind,relative.casefold())",
    "   if key in seen: raise RuntimeError('direct wheel-spread path collision')",
    "   seen.add(key)",
    "   if info.flag_bits & 1: raise RuntimeError('encrypted direct wheel-spread entry')",
    "   if stat.S_IFMT(info.external_attr >> 16)==stat.S_IFLNK: raise RuntimeError('symlink direct wheel-spread entry')",
    "   if info.file_size>67108864: raise RuntimeError('direct wheel-spread entry exceeds size limit')",
    "   total_bytes+=info.file_size",
    "   if total_bytes>268435456: raise RuntimeError('direct wheel-spread total exceeds size limit')",
    "   data=archive.read(info)",
    "   out.append({'distribution_index':wheel['distribution_index'],'kind':kind,'relative_path':relative,'sha256':hashlib.sha256(data).hexdigest(),'size_bytes':len(data)})",
    "print(json.dumps(out,sort_keys=True,separators=(',',':')))",
  ].join("\n");
  const result = await runProcess(venvPython, ["-I", "-B", "-c", script, specPath], "direct_wheel_spread", options);
  let observed;
  try {
    observed = JSON.parse(result.stdout);
  } catch {
    fail("INSTALL_SCHEME_DIRECT_WHEEL_SPREAD", "direct wheel-spread projection must be JSON");
  }
  if (!Array.isArray(observed) || observed.length > 4096) fail("INSTALL_SCHEME_DIRECT_WHEEL_SPREAD", "direct wheel-spread projection count is invalid");
  const byKey = new Map();
  for (const entry of observed) {
    assertPlainObject(entry, "INSTALL_SCHEME_DIRECT_WHEEL_SPREAD", "direct wheel-spread entry");
    assertAllowedKeys(entry, new Set(["distribution_index", "kind", "relative_path", "sha256", "size_bytes"]), "INSTALL_SCHEME_DIRECT_WHEEL_SPREAD", "direct wheel-spread entry");
    if (!Number.isSafeInteger(entry.distribution_index) || entry.distribution_index < 0 || entry.distribution_index >= lock.distributions.length) fail("INSTALL_SCHEME_DIRECT_WHEEL_SPREAD", "direct wheel-spread distribution index is invalid");
    if (!new Set(["scripts", "constrained-data"]).has(entry.kind)) fail("INSTALL_SCHEME_DIRECT_WHEEL_SPREAD", "direct wheel-spread kind is invalid");
    validateRelativePath(entry.relative_path, "INSTALL_SCHEME_DIRECT_WHEEL_SPREAD", "direct wheel-spread path");
    assertSha256(entry.sha256, "INSTALL_SCHEME_DIRECT_WHEEL_SPREAD", "direct wheel-spread sha256");
    if (!Number.isSafeInteger(entry.size_bytes) || entry.size_bytes < 0 || entry.size_bytes > 64 * 1024 * 1024) fail("INSTALL_SCHEME_DIRECT_WHEEL_SPREAD", "direct wheel-spread size is invalid");
    const key = directWheelSpreadKey(entry.distribution_index, entry.kind, entry.relative_path);
    if (byKey.has(key)) fail("INSTALL_SCHEME_DIRECT_WHEEL_SPREAD", "direct wheel-spread projection contains a case collision");
    byKey.set(key, entry);
  }
  return byKey;
}

async function offlineInstallAndInspect(controlledRoot, lock, venvPythonPath, options = {}) {
  const { absolute: venvPython } = validateVenvPythonPath(controlledRoot, venvPythonPath);
  const processTemp = path.join(controlledRoot, "tmp", `install-scheme-${sha256(venvPython).slice(0, 16)}`);
  await mkdir(processTemp, { recursive: true });
  const processOptions = { ...options, controlledRoot, cwd: controlledRoot, tempDir: processTemp };
  await verifyBootstrapOnly(venvPython, processOptions);
  const runtime = await queryBoundRuntimeSysconfig(venvPython, processOptions);
  const resolverVersion = await queryPipVersion(venvPython, processOptions);
  if (resolverVersion !== lock.resolver_declaration.version) fail("INSTALL_SCHEME_RESOLVER_VERSION", "venv pip version drifted from lock resolver declaration");
  const directWheelSpread = await queryDirectWheelSpread(controlledRoot, lock, venvPython, processOptions);
  const requirements = lock.distributions.map((item) => `${item.name}==${item.version} --hash=sha256:${item.wheel.sha256}`).join("\n") + "\n";
  const requirementsPath = path.join(controlledRoot, "inputs", "install-scheme-requirements.txt");
  await mkdir(path.dirname(requirementsPath), { recursive: true });
  await writeFile(requirementsPath, requirements, "utf8");
  const flags = [
    "-I",
    "-B",
    "-m",
    "pip",
    "install",
    "--isolated",
    "--require-virtualenv",
    "--no-index",
    "--find-links",
    path.join(controlledRoot, "wheelhouse"),
    "--only-binary",
    ":all:",
    "--no-deps",
    "--require-hashes",
    "--no-compile",
    "--disable-pip-version-check",
    "-r",
    requirementsPath,
  ];
  await runProcess(venvPython, flags, "install", processOptions);
  await runProcess(venvPython, ["-I", "-B", "-m", "pip", "check", "--disable-pip-version-check"], "check", processOptions);
  const inspect = await runProcess(venvPython, ["-I", "-B", "-m", "pip", "inspect", "--local"], "inspect", processOptions);
  if (Buffer.byteLength(inspect.stdout, "utf8") > MAX_JSON_BYTES) fail("INSTALL_SCHEME_INSPECT_OUTPUT", "pip inspect JSON exceeded limit");
  const inspectJson = JSON.parse(inspect.stdout);
  const locked = new Map(lock.distributions.map((item) => [normalizePackageName(item.name), item.version]));
  const projected = [];
  for (const item of Array.isArray(inspectJson.installed) ? inspectJson.installed : []) {
    const metadata = item.metadata ?? {};
    const normalized = normalizePackageName(metadata.name ?? "");
    if (locked.has(normalized)) {
      if (metadata.version !== locked.get(normalized)) fail("INSTALL_SCHEME_INSPECT_SET", "pip inspect version mismatch");
      if (item.download_info !== undefined || item.direct_url !== undefined) fail("INSTALL_SCHEME_DIRECT_URL", "offline wheel install must not create direct URL evidence");
      projected.push({ name_sha256: sha256(normalized), version_sha256: sha256(metadata.version) });
    } else if (!["pip", "setuptools", "wheel"].includes(normalized)) {
      fail("INSTALL_SCHEME_INSPECT_SET", "pip inspect installed set mismatch");
    }
  }
  if (projected.length !== lock.distributions.length) fail("INSTALL_SCHEME_INSPECT_SET", "pip inspect locked distribution count mismatch");
  projected.sort((left, right) => left.name_sha256.localeCompare(right.name_sha256));
  return {
    pip_install_flags_sha256: sha256(Buffer.from(encodeCanonicalJson(flags.map((arg) => (path.isAbsolute(arg) ? "<absolute>" : arg))), "utf8")),
    directWheelSpread,
    runtime,
    materialized_environment_report_sha256: sha256(Buffer.from(encodeCanonicalJson(projected), "utf8")),
  };
}

function parseCsvRecordLine(line) {
  const cells = [];
  let index = 0;
  while (true) {
    let current = "";
    if (line[index] === "\"") {
      index += 1;
      let closed = false;
      while (index < line.length) {
        if (line[index] !== "\"") {
          current += line[index];
          index += 1;
        } else if (line[index + 1] === "\"") {
          current += "\"";
          index += 2;
        } else {
          closed = true;
          index += 1;
          break;
        }
      }
      if (!closed) fail("INSTALL_SCHEME_RECORD_CSV", "RECORD line has unterminated quote");
      if (index < line.length && line[index] !== ",") fail("INSTALL_SCHEME_RECORD_CSV", "RECORD quoted field has trailing characters");
    } else {
      while (index < line.length && line[index] !== ",") {
        if (line[index] === "\"") fail("INSTALL_SCHEME_RECORD_CSV", "RECORD unquoted field contains a quote");
        current += line[index];
        index += 1;
      }
    }
    cells.push(current);
    if (index === line.length) break;
    index += 1;
    if (cells.length === 3) fail("INSTALL_SCHEME_RECORD_CSV", "RECORD must have exactly three columns");
    if (index === line.length) {
      cells.push("");
      break;
    }
  }
  if (cells.length !== 3) fail("INSTALL_SCHEME_RECORD_CSV", "RECORD must have exactly three columns");
  return cells;
}

function resolveRecordTarget(recordPath, distInfoPath, schemeRoots) {
  if (typeof recordPath !== "string" || recordPath.length === 0 || recordPath.includes("\0") || /[\r\n]/u.test(recordPath)) fail("INSTALL_SCHEME_RECORD_PATH", "RECORD path must be safe");
  let absolute;
  if (path.win32.isAbsolute(recordPath) || path.posix.isAbsolute(recordPath)) {
    absolute = rejectUnsafeAbsolute(recordPath, "INSTALL_SCHEME_RECORD_PATH", "absolute RECORD path");
  } else {
    if (recordPath.includes("\\") || recordPath.includes(":")) fail("INSTALL_SCHEME_RECORD_PATH", "relative RECORD path must use safe POSIX syntax");
    for (const segment of recordPath.split("/")) {
      if (segment === "" || segment === "." || (segment !== ".." && (segment.endsWith(" ") || segment.endsWith(".") || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(segment)))) fail("INSTALL_SCHEME_RECORD_PATH", "RECORD path contains unsafe segment");
    }
    absolute = path.resolve(path.dirname(distInfoPath), ...recordPath.split("/"));
  }
  const roots = [schemeRoots.library, schemeRoots.scripts, schemeRoots.constrainedData];
  const inside = roots.some((root) => {
    const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
    const comparablePrefix = process.platform === "win32" ? prefix.toLowerCase() : prefix;
    const comparableAbsolute = process.platform === "win32" ? absolute.toLowerCase() : absolute;
    return comparableAbsolute.startsWith(comparablePrefix);
  });
  if (!inside) fail("INSTALL_SCHEME_RECORD_ROOT", "RECORD target escaped allowlisted install scheme roots");
  return absolute;
}

function classifyRecordTarget(absolute, distInfoPath, schemeRoots) {
  const cmp = (value) => (process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value));
  const value = cmp(absolute);
  const distInfo = cmp(distInfoPath);
  const constrainedData = cmp(schemeRoots.constrainedData);
  const scripts = cmp(schemeRoots.scripts);
  const library = cmp(schemeRoots.library);
  if (value === distInfo || value.startsWith(`${distInfo}${path.sep}`)) return "dist-info";
  if (value.startsWith(`${constrainedData}${path.sep}`)) return "constrained-data";
  if (value.startsWith(`${scripts}${path.sep}`)) return "scripts";
  if (value.startsWith(`${library}${path.sep}`)) return "library";
  fail("INSTALL_SCHEME_RECORD_CLASSIFICATION", "RECORD target has no allowlisted classification");
}

function verifyRecordHashAndSize(absolute, digest, sizeText, ownRecord) {
  const stat = lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) fail("INSTALL_SCHEME_RECORD_FILE", "RECORD target must be a regular non-symlink file");
  if (stat.nlink !== 1) fail("INSTALL_SCHEME_RECORD_HARDLINK", "RECORD target must not be a hardlink alias");
  if (digest === "" || sizeText === "") {
    if (!ownRecord || digest !== "" || sizeText !== "") fail("INSTALL_SCHEME_RECORD_HASH_SIZE", "only the owning RECORD may omit both hash and size");
    return;
  }
  const match = /^sha256=([A-Za-z0-9_-]+)$/u.exec(digest);
  if (!match) fail("INSTALL_SCHEME_RECORD_HASH", "RECORD hash must be sha256 urlsafe base64");
  if (!/^(?:0|[1-9][0-9]*)$/u.test(sizeText)) fail("INSTALL_SCHEME_RECORD_SIZE", "RECORD size must be decimal bytes");
  const observed = createHash("sha256").update(readFileSync(absolute)).digest("base64url").replace(/=+$/u, "");
  if (observed !== match[1]) fail("INSTALL_SCHEME_RECORD_HASH_DRIFT", "RECORD file hash drift");
  if (Number(sizeText) !== stat.size) fail("INSTALL_SCHEME_RECORD_SIZE_DRIFT", "RECORD file size drift");
}

async function queryInstalledDistInfo(venvPython, lock, purelib, options = {}) {
  const names = lock.distributions.map((item) => normalizePackageName(item.name));
  const namesPath = path.join(options.controlledRoot, "inputs", "install-scheme-query-names.json");
  await mkdir(path.dirname(namesPath), { recursive: true });
  await writeFile(namesPath, encodeCanonicalJson(names), "utf8");
  const script = [
    "import importlib.metadata as m, json, pathlib, re, sys",
    "names=json.loads(pathlib.Path(sys.argv[1]).read_text(encoding='utf-8'))",
    "site=pathlib.Path(sys.argv[2]).resolve()",
    "found={}",
    "for d in m.distributions(path=[str(site)]):",
    " key=re.sub(r'[-_.]+','-',d.metadata['Name']).lower()",
    " if key in names:",
    "  found[key]={'name':d.metadata['Name'],'version':d.version,'path':str(pathlib.Path(d._path).resolve())}",
    "out=[]",
    "for name in names:",
    " if name not in found: raise RuntimeError('locked distribution missing')",
    " out.append(found[name])",
    "print(json.dumps(out,sort_keys=True,separators=(',',':')))",
  ].join("\n");
  const result = await runProcess(venvPython, ["-I", "-B", "-c", script, namesPath, purelib], "dist_info_query", options);
  return JSON.parse(result.stdout);
}

async function verifyInstalledSchemeRecords(controlledRoot, lock, venvPythonPath, runtime, directWheelSpread, options = {}) {
  const { absolute: venvPython, venvRoot } = validateVenvPythonPath(controlledRoot, venvPythonPath);
  const purelib = assertNoSymlinkComponents(controlledRoot, ensureAbsoluteInsideRoot(controlledRoot, runtime.paths.purelib, "INSTALL_SCHEME_PURELIB", "purelib"), "INSTALL_SCHEME_PURELIB", "purelib");
  const platlib = assertNoSymlinkComponents(controlledRoot, ensureAbsoluteInsideRoot(controlledRoot, runtime.paths.platlib, "INSTALL_SCHEME_PLATLIB", "platlib"), "INSTALL_SCHEME_PLATLIB", "platlib");
  const scripts = assertNoSymlinkComponents(controlledRoot, ensureAbsoluteInsideRoot(controlledRoot, runtime.paths.scripts, "INSTALL_SCHEME_SCRIPTS", "scripts"), "INSTALL_SCHEME_SCRIPTS", "scripts");
  const data = assertNoSymlinkComponents(controlledRoot, ensureAbsoluteInsideRoot(controlledRoot, runtime.paths.data, "INSTALL_SCHEME_DATA", "data"), "INSTALL_SCHEME_DATA", "data");
  const library = path.resolve(purelib).toLowerCase() === path.resolve(platlib).toLowerCase() ? purelib : fail("INSTALL_SCHEME_PLATLIB", "purelib and platlib must dedupe physically in this wheel-only slice");
  const constrainedData = path.join(data, "share", "meetingrelay-sidecar-artifacts");
  const schemeRoots = { library, scripts, constrainedData };
  const distInfos = await queryInstalledDistInfo(venvPython, lock, purelib, { ...options, controlledRoot, cwd: controlledRoot, tempDir: options.tempDir ?? controlledRoot });
  const targets = new Set();
  const caseTargets = new Set();
  const targetIdentities = new Set();
  const observedDirectWheelSpread = new Set();
  const contracts = [];
  const classificationCounts = { "constrained-data": 0, "dist-info": 0, library: 0, scripts: 0 };
  for (const [index, info] of distInfos.entries()) {
    const expected = lock.distributions[index];
    if (normalizePackageName(info.name) !== normalizePackageName(expected.name) || info.version !== expected.version) fail("INSTALL_SCHEME_DIST_INFO_SET", "installed dist-info identity mismatch");
    const distInfoPath = assertNoSymlinkComponents(controlledRoot, ensureAbsoluteInsideRoot(controlledRoot, info.path, "INSTALL_SCHEME_DIST_INFO_PATH", "dist-info"), "INSTALL_SCHEME_DIST_INFO_PATH", "dist-info");
    if (path.dirname(distInfoPath).toLowerCase() !== library.toLowerCase()) fail("INSTALL_SCHEME_DIST_INFO_PATH", "dist-info must be a direct library child");
    const metadataPath = path.join(distInfoPath, "METADATA");
    const recordPath = path.join(distInfoPath, "RECORD");
    const metadata = readFileSync(metadataPath);
    const recordBytes = readFileSync(recordPath);
    let record;
    try {
      record = new TextDecoder("utf-8", { fatal: true }).decode(recordBytes);
    } catch {
      fail("INSTALL_SCHEME_RECORD_CSV", "RECORD must be valid UTF-8");
    }
    if (sha256(metadata) !== expected.declared_dist_info_metadata_sha256 || sha256(recordBytes) !== expected.declared_dist_info_record_sha256) fail("INSTALL_SCHEME_DIST_INFO_DRIFT", "locked dist-info METADATA/RECORD drifted");
    if (!record.endsWith("\n")) fail("INSTALL_SCHEME_RECORD_CSV", "RECORD must end with a newline");
    const newlineCount = record.match(/\n/gu)?.length ?? 0;
    const crlfCount = record.match(/\r\n/gu)?.length ?? 0;
    if ((crlfCount > 0 && crlfCount !== newlineCount) || record.replaceAll("\r\n", "").includes("\r")) fail("INSTALL_SCHEME_RECORD_CSV", "RECORD must use consistent LF or CRLF line endings");
    const normalizedRecord = record.replaceAll("\r\n", "\n");
    const recordLines = normalizedRecord.slice(0, -1).split("\n");
    if (recordLines.length < 2) fail("INSTALL_SCHEME_RECORD", "RECORD must contain installed files");
    for (const line of recordLines) {
      if (line.length === 0) fail("INSTALL_SCHEME_RECORD_CSV", "RECORD must not contain blank rows");
      const [relative, digest, sizeText] = parseCsvRecordLine(line);
      const absolute = resolveRecordTarget(relative, distInfoPath, schemeRoots);
      assertNoSymlinkComponents(controlledRoot, absolute, "INSTALL_SCHEME_RECORD_PATH", "RECORD target");
      const targetId = path.resolve(absolute);
      const folded = targetId.toLowerCase();
      if (targets.has(targetId)) fail("INSTALL_SCHEME_RECORD_DUPLICATE", "RECORD target is declared more than once");
      if (caseTargets.has(folded) && !targets.has(targetId)) fail("INSTALL_SCHEME_RECORD_CASE_COLLISION", "RECORD target case collision");
      targets.add(targetId);
      caseTargets.add(folded);
      const ownRecord = path.resolve(absolute).toLowerCase() === path.resolve(recordPath).toLowerCase();
      verifyRecordHashAndSize(absolute, digest, sizeText, ownRecord);
      const classification = classifyRecordTarget(absolute, distInfoPath, schemeRoots);
      classificationCounts[classification] += 1;
      const identityRoot = classification === "constrained-data"
        ? constrainedData
        : classification === "scripts"
          ? scripts
          : library;
      const relativeIdentity = path.relative(identityRoot, absolute).replaceAll(path.sep, "/");
      targetIdentities.add(`${classification}:${relativeIdentity}`);
      if (classification === "scripts" || classification === "constrained-data") {
        const directKey = directWheelSpreadKey(index, classification, relativeIdentity);
        const expectedDirect = directWheelSpread.get(directKey);
        if (expectedDirect === undefined) fail("INSTALL_SCHEME_GENERATED_LAUNCHER", "scheme target is not an exact direct wheel-spread payload");
        const installedBytes = readFileSync(absolute);
        if (installedBytes.length !== expectedDirect.size_bytes || sha256(installedBytes) !== expectedDirect.sha256) fail("INSTALL_SCHEME_DIRECT_WHEEL_SPREAD_DRIFT", "direct wheel-spread target bytes drifted during installation");
        observedDirectWheelSpread.add(directKey);
      }
    }
    contracts.push({
      metadata_sha256: sha256(metadata),
      name_sha256: sha256(normalizePackageName(expected.name)),
      record_sha256: sha256(recordBytes),
      version_sha256: sha256(expected.version),
    });
  }
  if (observedDirectWheelSpread.size !== directWheelSpread.size) fail("INSTALL_SCHEME_DIRECT_WHEEL_SPREAD_MISSING", "direct wheel-spread payload was not represented by installed RECORD closure");
  contracts.sort((left, right) => left.name_sha256.localeCompare(right.name_sha256));
  const normalizedRuntime = {
    cache_tag: runtime.cache_tag,
    implementation: runtime.implementation,
    target_arch: "amd64",
    os_name: runtime.os_name,
    paths: Object.fromEntries(
      ["purelib", "platlib", "scripts", "data"].map((key) => [
        key,
        path.relative(venvRoot, runtime.paths[key]).replaceAll(path.sep, "/") || ".",
      ]),
    ),
    pointer_bits: runtime.pointer_bits,
    sys_platform: runtime.sys_platform,
    sysconfig_platform: runtime.sysconfig_platform,
    version: runtime.version,
  };
  return {
    classification_counts_sha256: sha256(Buffer.from(encodeCanonicalJson(classificationCounts), "utf8")),
    installed_dist_info_contract_sha256: sha256(Buffer.from(encodeCanonicalJson(contracts), "utf8")),
    record_target_count: targets.size,
    record_target_set_sha256: sha256(Buffer.from(encodeCanonicalJson([...targetIdentities].sort()), "utf8")),
    runtime_sysconfig_sha256: sha256(Buffer.from(encodeCanonicalJson(normalizedRuntime), "utf8")),
  };
}

function assertTarget(target, code) {
  assertPlainObject(target, code, "target");
  assertAllowedKeys(target, new Set(["os", "arch", "cpython_version_family", "python_abi", "platform_tag", "accelerator_profile"]), code, "target");
  for (const [key, expected] of Object.entries(TARGET)) if (target[key] !== expected) fail(code, `target ${key} mismatch`);
}

function validateLockForInstallScheme(lock) {
  assertPlainObject(lock, "INSTALL_SCHEME_LOCK", "package lock");
  assertTarget(lock.target, "INSTALL_SCHEME_LOCK_TARGET");
  if (encodeCanonicalJson(lock.root_requirements) !== encodeCanonicalJson([...ROOT_REQUIREMENTS])) fail("INSTALL_SCHEME_LOCK_ROOTS", "root requirements drifted");
  if (!Array.isArray(lock.distributions) || lock.distributions.length !== 77) fail("INSTALL_SCHEME_LOCK_DISTRIBUTIONS", "distribution count must be 77");
  const built = lock.distributions.filter((item) => item.built_wheel !== undefined).map((item) => normalizePackageName(item.name));
  if (encodeCanonicalJson(built) !== encodeCanonicalJson([...BUILT_WHEEL_NAMES])) fail("INSTALL_SCHEME_LOCK_BUILT", "built wheel declaration set mismatch");
}

async function readLockFromManifest(controlledRoot, inputManifestPath) {
  const input = await readCanonicalJsonFile(inputManifestPath, MAX_JSON_BYTES, "INSTALL_SCHEME_INPUT_MANIFEST", "input manifest");
  const role = input.parsed.files?.find((entry) => entry.role === "package-lock");
  if (!role) fail("INSTALL_SCHEME_INPUT_MANIFEST", "package-lock role missing");
  const lockPath = ensureInside(controlledRoot, role.relative_path, "INSTALL_SCHEME_LOCK_PATH", "package lock");
  const lockFile = await readFile(lockPath);
  if (sha256(lockFile) !== role.sha256 || lockFile.length !== role.size_bytes) fail("INSTALL_SCHEME_LOCK_DRIFT", "package lock drifted from input manifest");
  return { envelope: readPackageLockFromCanonicalBytes(lockFile), inputManifest: input.parsed };
}

async function schemaBytesForEvidence() {
  return await readFile(PUBLIC_EVIDENCE_SCHEMA_PATH);
}

export async function attestInstallSchemeRecordClosure(controlledRoot, inputManifestPath, artifactPackManifestPath, venvPythonPath, expectedAggregateSha256, options = {}) {
  assertPlainObject(options, "INSTALL_SCHEME_OPTIONS", "attestation options");
  assertAllowedKeys(options, new Set(["inputScope"]), "INSTALL_SCHEME_OPTIONS", "attestation options");
  assertSha256(expectedAggregateSha256, "INSTALL_SCHEME_AGGREGATE", "expected aggregate");
  const root = rejectUnsafeAbsolute(controlledRoot, "INSTALL_SCHEME_ROOT", "controlled root");
  const preflight = await preflightCandidate(root, inputManifestPath);
  if (preflight.candidate_descriptor.aggregate_sha256 !== expectedAggregateSha256) fail("INSTALL_SCHEME_FOUR_B_DRIFT", "4b candidate aggregate mismatch");
  const fourEBefore = await attestPackageLock(root, inputManifestPath, expectedAggregateSha256);
  validatePackageLockEvidence(fourEBefore);
  const fourGBefore = await attestArtifactPack(root, inputManifestPath, artifactPackManifestPath, expectedAggregateSha256);
  validateArtifactPackEvidence(fourGBefore);
  const { envelope, inputManifest } = await readLockFromManifest(root, inputManifestPath);
  const lock = envelope.parsed;
  validateLockForInstallScheme(lock);
  const runtimeBinding = bindRuntimeRole(root, inputManifest, venvPythonPath);
  validateVenvPythonPath(root, runtimeBinding.absolute);
  const materialized = await offlineInstallAndInspect(root, lock, venvPythonPath, { controlledRoot: root, cwd: root, tempDir: root });
  if (materialized.materialized_environment_report_sha256 !== lock.expected_environment_report.expected_sha256) fail("INSTALL_SCHEME_EXPECTED_REPORT_DRIFT", "materialized environment projection drifted from expected report declaration");
  const records = await verifyInstalledSchemeRecords(root, lock, venvPythonPath, materialized.runtime, materialized.directWheelSpread, { controlledRoot: root, cwd: root, tempDir: root });
  if (!sameIdentity(runtimeBinding.identity, fileIdentity(runtimeBinding.absolute, "INSTALL_SCHEME_RUNTIME_ROLE_DRIFT", "runtime role"))) fail("INSTALL_SCHEME_RUNTIME_ROLE_DRIFT", "runtime role identity drifted during materialization");
  const fourEAfter = await attestPackageLock(root, inputManifestPath, expectedAggregateSha256);
  if (encodeCanonicalJson(fourEBefore) !== encodeCanonicalJson(fourEAfter)) fail("INSTALL_SCHEME_FOUR_E_DRIFT", "4e evidence drifted across install-scheme attestation");
  const fourGAfter = await attestArtifactPack(root, inputManifestPath, artifactPackManifestPath, expectedAggregateSha256);
  if (encodeCanonicalJson(fourGBefore) !== encodeCanonicalJson(fourGAfter)) fail("INSTALL_SCHEME_FOUR_G_DRIFT", "4g evidence drifted across install-scheme attestation");
  const schemaBytes = await schemaBytesForEvidence();
  const evidence = {
    kind: PUBLIC_EVIDENCE_KIND,
    schema_version: PUBLIC_EVIDENCE_SCHEMA_VERSION,
    schema_file_sha256: sha256(schemaBytes),
    attestor_source_sha256: sha256(await readFile(ATTESTOR_SOURCE_PATH)),
    four_g_before_evidence_sha256: sha256(Buffer.from(encodeCanonicalJson(fourGBefore), "utf8")),
    four_g_after_evidence_sha256: sha256(Buffer.from(encodeCanonicalJson(fourGAfter), "utf8")),
    candidate_aggregate_sha256: expectedAggregateSha256,
    package_lock_sha256: envelope.sha256,
    artifact_pack_manifest_sha256: fourGBefore.artifact_pack_manifest_sha256,
    measurement_status: "controlled-wheelhouse-install-scheme-record-closure-only",
    execution_status: "offline-install-pip-check-inspect-record-closure-no-funasr-import",
    packaging_authority: "artifact-pack-and-install-scheme-byte-closure-only",
    environment_materialization_authority: "offline-venv-materialized",
    package_metadata_authority: "installed-dist-info-record-and-allowlisted-scheme-files-verified-only",
    install_scheme_authority: "bound-runtime-sysconfig-observed-only",
    source_build_authority: "source-archive-and-build-record-target-bytes-bound-only",
    license_authority: "license-set-target-bytes-verified-not-legal-approval",
    resolver_report_authority: "target-record-bytes-bound-only",
    environment_report_authority: "expected-projection-target-bytes-bound-only",
    import_map_authority: "target-bytes-bound-no-import",
    cpython_provenance_authority: "none",
    import_authority: "none",
    quality_gate_status: "not-assessed",
    formal_claims: "none",
    production_evidence: false,
    public_distribution: false,
    selection_authority: "none",
    worker_role: "sidecar-candidate",
    input_scope: options.inputScope ?? "caller-supplied-controlled-inputs-not-product-approved",
    target: { ...TARGET },
    root_requirement_count: lock.root_requirements.length,
    distribution_count: lock.distributions.length,
    wheel_count: lock.distributions.length,
    artifact_pack_verified_artifact_count: fourGBefore.verified_artifact_count,
    record_target_count: records.record_target_count,
    installed_dist_info_contract_sha256: records.installed_dist_info_contract_sha256,
    record_target_set_sha256: records.record_target_set_sha256,
    record_classification_counts_sha256: records.classification_counts_sha256,
    runtime_sysconfig_sha256: records.runtime_sysconfig_sha256,
    materialized_environment_report_sha256: materialized.materialized_environment_report_sha256,
    pip_install_flags_sha256: materialized.pip_install_flags_sha256,
    validator_limits: {
      pip_index_access: "disabled-by-no-index-and-sanitized-env",
      max_process_timeout_ms: MAX_PROCESS_TIMEOUT_MS,
      max_process_output_bytes: MAX_PROCESS_OUTPUT_BYTES,
      public_evidence: "path-url-name-text-free",
    },
    limitations: [...LIMITATIONS],
  };
  validatePublicEvidence(evidence);
  return evidence;
}

function scanForbiddenPublicEvidence(value, segments = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanForbiddenPublicEvidence(item, [...segments, String(index)]));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (FORBIDDEN_PUBLIC_KEYS.has(key)) fail("INSTALL_SCHEME_EVIDENCE_FORBIDDEN", `forbidden public evidence key ${[...segments, key].join(".")}`);
      scanForbiddenPublicEvidence(item, [...segments, key]);
    }
    return;
  }
  if (typeof value === "string" && !ALLOWED_PUBLIC_STRINGS.has(value) && FORBIDDEN_PUBLIC_VALUE_RE.test(value)) fail("INSTALL_SCHEME_EVIDENCE_FORBIDDEN", `forbidden public evidence value at ${segments.join(".")}`);
}

export function validatePublicEvidence(evidence) {
  assertPlainObject(evidence, "INSTALL_SCHEME_EVIDENCE_SCHEMA", "evidence");
  assertAllowedKeys(evidence, new Set(["kind", "schema_version", "schema_file_sha256", "attestor_source_sha256", "four_g_before_evidence_sha256", "four_g_after_evidence_sha256", "candidate_aggregate_sha256", "package_lock_sha256", "artifact_pack_manifest_sha256", "measurement_status", "execution_status", "packaging_authority", "environment_materialization_authority", "package_metadata_authority", "install_scheme_authority", "source_build_authority", "license_authority", "resolver_report_authority", "environment_report_authority", "import_map_authority", "cpython_provenance_authority", "import_authority", "quality_gate_status", "formal_claims", "production_evidence", "public_distribution", "selection_authority", "worker_role", "input_scope", "target", "root_requirement_count", "distribution_count", "wheel_count", "artifact_pack_verified_artifact_count", "record_target_count", "installed_dist_info_contract_sha256", "record_target_set_sha256", "record_classification_counts_sha256", "runtime_sysconfig_sha256", "materialized_environment_report_sha256", "pip_install_flags_sha256", "validator_limits", "limitations"]), "INSTALL_SCHEME_EVIDENCE_SCHEMA", "evidence");
  if (evidence.kind !== PUBLIC_EVIDENCE_KIND || evidence.schema_version !== PUBLIC_EVIDENCE_SCHEMA_VERSION) fail("INSTALL_SCHEME_EVIDENCE_SCHEMA", "bad evidence identity");
  for (const key of ["schema_file_sha256", "attestor_source_sha256", "four_g_before_evidence_sha256", "four_g_after_evidence_sha256", "candidate_aggregate_sha256", "package_lock_sha256", "artifact_pack_manifest_sha256", "installed_dist_info_contract_sha256", "record_target_set_sha256", "record_classification_counts_sha256", "runtime_sysconfig_sha256", "materialized_environment_report_sha256", "pip_install_flags_sha256"]) assertSha256(evidence[key], "INSTALL_SCHEME_EVIDENCE_SCHEMA", key);
  if (evidence.attestor_source_sha256 !== sha256(readFileSync(ATTESTOR_SOURCE_PATH))) fail("INSTALL_SCHEME_EVIDENCE_SCHEMA", "source digest mismatch");
  if (evidence.schema_file_sha256 !== sha256(readFileSync(PUBLIC_EVIDENCE_SCHEMA_PATH))) fail("INSTALL_SCHEME_EVIDENCE_SCHEMA", "schema digest mismatch");
  if (evidence.four_g_before_evidence_sha256 !== evidence.four_g_after_evidence_sha256) fail("INSTALL_SCHEME_EVIDENCE_SCHEMA", "4g before/after evidence digest mismatch");
  if (evidence.measurement_status !== "controlled-wheelhouse-install-scheme-record-closure-only" || evidence.execution_status !== "offline-install-pip-check-inspect-record-closure-no-funasr-import" || evidence.packaging_authority !== "artifact-pack-and-install-scheme-byte-closure-only" || evidence.environment_materialization_authority !== "offline-venv-materialized" || evidence.package_metadata_authority !== "installed-dist-info-record-and-allowlisted-scheme-files-verified-only" || evidence.install_scheme_authority !== "bound-runtime-sysconfig-observed-only" || evidence.source_build_authority !== "source-archive-and-build-record-target-bytes-bound-only" || evidence.license_authority !== "license-set-target-bytes-verified-not-legal-approval" || evidence.resolver_report_authority !== "target-record-bytes-bound-only" || evidence.environment_report_authority !== "expected-projection-target-bytes-bound-only" || evidence.import_map_authority !== "target-bytes-bound-no-import" || evidence.cpython_provenance_authority !== "none" || evidence.import_authority !== "none" || evidence.quality_gate_status !== "not-assessed" || evidence.formal_claims !== "none" || evidence.production_evidence !== false || evidence.public_distribution !== false || evidence.selection_authority !== "none" || evidence.worker_role !== "sidecar-candidate") fail("INSTALL_SCHEME_EVIDENCE_OVERCLAIM", "authority field overclaim");
  if (!["synthetic-install-scheme-record-contract-only", "caller-supplied-controlled-inputs-not-product-approved"].includes(evidence.input_scope)) fail("INSTALL_SCHEME_EVIDENCE_SCHEMA", "bad input scope");
  assertTarget(evidence.target, "INSTALL_SCHEME_EVIDENCE_SCHEMA");
  if (evidence.root_requirement_count !== 3 || evidence.distribution_count !== 77 || evidence.wheel_count !== 77 || evidence.artifact_pack_verified_artifact_count !== 90) fail("INSTALL_SCHEME_EVIDENCE_SCHEMA", "count mismatch");
  if (!Number.isSafeInteger(evidence.record_target_count) || evidence.record_target_count < 77 * 3) fail("INSTALL_SCHEME_EVIDENCE_SCHEMA", "record target count mismatch");
  assertPlainObject(evidence.validator_limits, "INSTALL_SCHEME_EVIDENCE_SCHEMA", "validator_limits");
  assertAllowedKeys(evidence.validator_limits, new Set(["pip_index_access", "max_process_timeout_ms", "max_process_output_bytes", "public_evidence"]), "INSTALL_SCHEME_EVIDENCE_SCHEMA", "validator_limits");
  if (evidence.validator_limits.pip_index_access !== "disabled-by-no-index-and-sanitized-env" || evidence.validator_limits.max_process_timeout_ms !== MAX_PROCESS_TIMEOUT_MS || evidence.validator_limits.max_process_output_bytes !== MAX_PROCESS_OUTPUT_BYTES || evidence.validator_limits.public_evidence !== "path-url-name-text-free") fail("INSTALL_SCHEME_EVIDENCE_SCHEMA", "bad validator limits");
  if (!Array.isArray(evidence.limitations) || encodeCanonicalJson(evidence.limitations) !== encodeCanonicalJson([...LIMITATIONS])) fail("INSTALL_SCHEME_EVIDENCE_SCHEMA", "limitations mismatch");
  scanForbiddenPublicEvidence(evidence);
  return evidence;
}

async function updateInputManifestPackageLock(root, manifestPath, lockBytes) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const lockPath = path.join(root, "inputs", "package-lock.json");
  await writeFile(lockPath, lockBytes);
  for (const file of manifest.files) {
    if (file.role === "package-lock") {
      file.sha256 = sha256(lockBytes);
      file.size_bytes = lockBytes.length;
    } else {
      const bytes = readFileSync(path.join(root, ...file.relative_path.split("/")));
      file.sha256 = sha256(bytes);
      file.size_bytes = bytes.length;
    }
  }
  await writeFile(manifestPath, encodeCanonicalJson(manifest), "utf8");
  const preflight = await preflightCandidate(root, manifestPath);
  return preflight.candidate_descriptor.aggregate_sha256;
}

async function patchSyntheticWheelWithPayloads(root, lock, normalizedName, options = {}) {
  const distribution = lock.distributions.find((item) => normalizePackageName(item.name) === normalizedName);
  if (!distribution) fail("INSTALL_SCHEME_FIXTURE_WHEEL", "synthetic payload distribution missing");
  const wheelPath = path.join(root, ...distribution.wheel.relative_path.split("/"));
  const payloads = [
    { relative_path: `${distribution.name.replaceAll("-", "_")}/install_scheme_payload.py`, content: "VALUE = 'library payload'\\n" },
    { relative_path: `${distribution.name.replaceAll("-", "_")}-${distribution.version}.data/scripts/meetingrelay-sidecar-direct-script.py`, content: "print('direct script payload')\\n" },
    { relative_path: `${distribution.name.replaceAll("-", "_")}-${distribution.version}.data/data/share/meetingrelay-sidecar-artifacts/direct-data.txt`, content: "direct constrained data payload\\n" },
  ];
  if (options.includeGeneratedLauncher === true) {
    payloads.push({
      relative_path: `${distribution.name.replaceAll("-", "_")}-${distribution.version}.dist-info/entry_points.txt`,
      content: `[console_scripts]\nmeetingrelay-generated-launcher=${distribution.name.replaceAll("-", "_")}:main\n`,
    });
  }
  const specPath = path.join(root, "inputs", "install-scheme-wheel-payloads.json");
  await writeFile(specPath, encodeCanonicalJson({ wheel_path: wheelPath, payloads }), "utf8");
  const script = [
    "import base64, csv, hashlib, io, json, pathlib, zipfile, sys, tempfile, shutil",
    "spec=json.loads(pathlib.Path(sys.argv[1]).read_text(encoding='utf-8'))",
    "wheel=pathlib.Path(spec['wheel_path'])",
    "tmp=wheel.with_suffix('.tmp.whl')",
    "def b64(data): return base64.urlsafe_b64encode(hashlib.sha256(data).digest()).decode().rstrip('=')",
    "with zipfile.ZipFile(wheel,'r') as zin:",
    " files={i.filename:zin.read(i.filename) for i in zin.infolist() if not i.is_dir() and not i.filename.endswith('.dist-info/RECORD')}",
    " record_name=[i.filename for i in zin.infolist() if i.filename.endswith('.dist-info/RECORD')][0]",
    "for payload in spec['payloads']:",
    " files[payload['relative_path']]=payload['content'].encode('utf-8')",
    "rows=[]",
    "for p,d in sorted(files.items()): rows.append([p,'sha256='+b64(d),str(len(d))])",
    "rows.append([record_name,'',''])",
    "rec=io.StringIO(); csv.writer(rec, lineterminator='\\n').writerows(rows); files[record_name]=rec.getvalue().encode()",
    "with zipfile.ZipFile(tmp,'w',compression=zipfile.ZIP_DEFLATED) as zout:",
    " for p,d in sorted(files.items()):",
    "  info=zipfile.ZipInfo(p,(1980,1,1,0,0,0)); info.compress_type=zipfile.ZIP_DEFLATED; info.external_attr=0o644 << 16; zout.writestr(info,d)",
    "tmp.replace(wheel)",
    "data=wheel.read_bytes()",
    "print(json.dumps({'sha256':hashlib.sha256(data).hexdigest(),'size_bytes':len(data)},sort_keys=True,separators=(',',':')))",
  ].join("\n");
  const hostPython = await resolveHostPython({ cwd: root, tempDir: root });
  const result = await execFileAsync(hostPython, ["-I", "-B", "-c", script, specPath], {
    windowsHide: true,
    shell: false,
    detached: false,
    timeout: MAX_PROCESS_TIMEOUT_MS,
    maxBuffer: MAX_PROCESS_OUTPUT_BYTES,
    cwd: root,
    env: { SystemRoot: process.env.SystemRoot ?? "C:\\Windows", TEMP: root, TMP: root, PYTHONIOENCODING: "utf-8", PYTHONDONTWRITEBYTECODE: "1", PYTHONNOUSERSITE: "1" },
  }).catch((error) => fail("INSTALL_SCHEME_FIXTURE_WHEEL", `wheel payload patch failed: ${String(error.stderr || error.message).slice(0, 2000)}`));
  const patched = JSON.parse(result.stdout);
  distribution.wheel.sha256 = patched.sha256;
  distribution.wheel.size_bytes = patched.size_bytes;
}

async function collectInstalledMetadataForLock(root, lock) {
  const probePython = await createFixtureVenv(root, "install-scheme-probe-venv");
  const materialized = await offlineInstallAndInspect(root, lock, probePython, { controlledRoot: root, cwd: root, tempDir: root });
  const runtime = materialized.runtime;
  const distInfos = await queryInstalledDistInfo(probePython, lock, runtime.paths.purelib, { controlledRoot: root, cwd: root, tempDir: root });
  for (const [index, info] of distInfos.entries()) {
    const distribution = lock.distributions[index];
    const distInfoPath = info.path;
    distribution.declared_dist_info_metadata_sha256 = sha256(readFileSync(path.join(distInfoPath, "METADATA")));
    distribution.declared_dist_info_record_sha256 = sha256(readFileSync(path.join(distInfoPath, "RECORD")));
  }
  lock.expected_environment_report.expected_sha256 = materialized.materialized_environment_report_sha256;
  await rm(path.join(root, "install-scheme-probe-venv"), { recursive: true, force: true });
}

async function writeArtifact(root, relativePath, bytes) {
  await mkdir(path.dirname(path.join(root, relativePath)), { recursive: true });
  await writeFile(path.join(root, relativePath), bytes);
  return { relative_path: relativePath, sha256: sha256(bytes), size_bytes: bytes.length };
}

async function writeArtifactPackForLock(root, lock, aggregate) {
  const artifacts = { license_sets: [], source_archives: [], build_records: [], resolver_report: undefined, expected_environment_report: undefined, top_level_import_map: undefined };
  const resolverBytes = Buffer.from(encodeCanonicalJson({ kind: "meetingrelay-funasr-sidecar-resolver-report-v1", tool: "pip", version: lock.resolver_declaration.version, distribution_count: 77 }), "utf8");
  artifacts.resolver_report = await writeArtifact(root, "artifacts/resolver-report.json", resolverBytes);
  lock.resolver_declaration.declared_report_sha256 = artifacts.resolver_report.sha256;
  const expectedBytes = Buffer.from(encodeCanonicalJson([]), "utf8");
  await writeArtifact(root, "artifacts/placeholder.json", expectedBytes);
  const importMapBytes = Buffer.from("funasr=>funasr\n", "utf8");
  artifacts.top_level_import_map = await writeArtifact(root, "artifacts/import-map.txt", importMapBytes);
  lock.expected_environment_report.expected_top_level_import_map_sha256 = artifacts.top_level_import_map.sha256;
  for (const distribution of lock.distributions) {
    const normalized = normalizePackageName(distribution.name);
    const license = await writeArtifact(root, `artifacts/licenses/${normalized}/LICENSE.txt`, Buffer.from(`synthetic license bytes ${normalized}\n`, "utf8"));
    const aggregateSha = sha256(Buffer.from(encodeCanonicalJson([{ sha256: license.sha256, size_bytes: license.size_bytes }]), "utf8"));
    distribution.declared_license_files_aggregate_sha256 = aggregateSha;
    artifacts.license_sets.push({ distribution: distribution.name, aggregate_sha256: aggregateSha, files: [license] });
  }
  for (const distribution of lock.distributions.filter((item) => item.built_wheel !== undefined)) {
    const normalized = normalizePackageName(distribution.name);
    const sourceBytes = Buffer.from(`synthetic source archive ${normalized}\n`, "utf8");
    const source = await writeArtifact(root, `artifacts/sources/${normalized}-${distribution.version}.tar.gz`, sourceBytes);
    distribution.built_wheel.source_archive.declared_sha256 = source.sha256;
    distribution.built_wheel.source_archive.declared_size_bytes = source.size_bytes;
    artifacts.source_archives.push({ distribution: distribution.name, ...source });
    const record = {
      kind: "meetingrelay-funasr-sidecar-build-record-v1",
      schema_version: "1.0",
      distribution: distribution.name,
      version: distribution.version,
      wheel_sha256: distribution.wheel.sha256,
      source_archive_sha256: source.sha256,
      target: { ...TARGET },
      execution_status: "target-wheel-built-record-only",
    };
    const build = await writeArtifact(root, `artifacts/build-records/${normalized}.json`, Buffer.from(encodeCanonicalJson(record), "utf8"));
    distribution.built_wheel.declared_build_attestation_sha256 = build.sha256;
    artifacts.build_records.push({ distribution: distribution.name, ...build });
  }
  const projected = lock.distributions
    .map((item) => ({ name_sha256: sha256(normalizePackageName(item.name)), version_sha256: sha256(item.version) }))
    .sort((left, right) => left.name_sha256.localeCompare(right.name_sha256));
  artifacts.expected_environment_report = await writeArtifact(root, "artifacts/expected-environment.json", Buffer.from(encodeCanonicalJson(projected), "utf8"));
  lock.expected_environment_report.expected_sha256 = artifacts.expected_environment_report.sha256;
  const artifactManifest = {
    kind: "meetingrelay-funasr-sidecar-artifact-pack-v1",
    schema_version: "1.0",
    worker_role: "sidecar-candidate",
    input_scope: "synthetic-artifact-pack-contract-only",
    target: { ...TARGET },
    package_lock_sha256: ZERO_SHA,
    candidate_aggregate_sha256: aggregate,
    artifacts,
  };
  return artifactManifest;
}

export async function createSyntheticInstallSchemeRecordFixture(options = {}) {
  assertPlainObject(options, "INSTALL_SCHEME_FIXTURE_OPTIONS", "fixture options");
  assertAllowedKeys(options, new Set(["afterCreate", "includeGeneratedLauncher"]), "INSTALL_SCHEME_FIXTURE_OPTIONS", "fixture options");
  const fixture = await createSyntheticVenvMaterializationFixture();
  let owned = true;
  try {
    const root = fixture.root;
    const lock = structuredClone(fixture.lock);
    await patchSyntheticWheelWithPayloads(root, lock, "mr-synthetic-01", options);
    const initialArtifactManifest = await writeArtifactPackForLock(root, lock, fixture.aggregate);
    await collectInstalledMetadataForLock(root, lock);
    let lockBytes = Buffer.from(encodeCanonicalJson(lock), "utf8");
    let aggregate = await updateInputManifestPackageLock(root, fixture.manifestPath, lockBytes);
    const artifactManifest = { ...initialArtifactManifest, package_lock_sha256: sha256(lockBytes), candidate_aggregate_sha256: aggregate };
    await writeFile(path.join(root, "artifact-pack-manifest.json"), Buffer.from(encodeCanonicalJson(artifactManifest), "utf8"));
    aggregate = await updateInputManifestPackageLock(root, fixture.manifestPath, lockBytes);
    artifactManifest.candidate_aggregate_sha256 = aggregate;
    await writeFile(path.join(root, "artifact-pack-manifest.json"), Buffer.from(encodeCanonicalJson(artifactManifest), "utf8"));
    const result = { root, manifestPath: fixture.manifestPath, artifactPackManifestPath: path.join(root, "artifact-pack-manifest.json"), aggregate, lock, artifactManifest, venvPython: fixture.venvPython };
    if (typeof options.afterCreate === "function") await options.afterCreate(result);
    owned = false;
    return result;
  } finally {
    if (owned) await rm(fixture.root, { recursive: true, force: true });
  }
}

async function runSyntheticValidation() {
  const fixture = await createSyntheticInstallSchemeRecordFixture();
  try {
    return await attestInstallSchemeRecordClosure(fixture.root, fixture.manifestPath, fixture.artifactPackManifestPath, fixture.venvPython, fixture.aggregate, { inputScope: "synthetic-install-scheme-record-contract-only" });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length === 1 && argv[0] === "--run-synthetic") {
    const evidence = await runSyntheticValidation();
    const text = encodeCanonicalJson(evidence);
    process.stdout.write(`funasr-sidecar-install-scheme-record-attestation=verified evidence_sha256=${sha256(Buffer.from(text, "utf8"))} candidate_aggregate_sha256=${evidence.candidate_aggregate_sha256} package_lock_sha256=${evidence.package_lock_sha256} artifact_pack_manifest_sha256=${evidence.artifact_pack_manifest_sha256} distributions=77 wheels=77 root_requirements=3 verified_artifacts=90 record_targets=${evidence.record_target_count} measurement_status=${evidence.measurement_status} execution_status=${evidence.execution_status} packaging_authority=${evidence.packaging_authority} environment_materialization_authority=${evidence.environment_materialization_authority} package_metadata_authority=${evidence.package_metadata_authority} install_scheme_authority=${evidence.install_scheme_authority} source_build_authority=${evidence.source_build_authority} license_authority=${evidence.license_authority} cpython_provenance_authority=none import_authority=none quality_gate_status=not-assessed formal_claims=none production_evidence=false public_distribution=false selection_authority=none fixture_scope=synthetic-install-scheme-record-contract-only\n`);
    return;
  }
  if (argv.length === 6 && argv[0] === "--attest") {
    const evidence = await attestInstallSchemeRecordClosure(argv[1], argv[2], argv[3], argv[4], argv[5]);
    process.stdout.write(`${encodeCanonicalJson(evidence)}`);
    return;
  }
  if (argv.length === 2 && argv[0] === "--validate-json") {
    const file = await readCanonicalJsonFile(argv[1], MAX_JSON_BYTES, "INSTALL_SCHEME_EVIDENCE_FILE", "public evidence");
    validatePublicEvidence(file.parsed);
    process.stdout.write(`funasr-sidecar-install-scheme-record-attestation-json=verified evidence_sha256=${sha256(Buffer.from(encodeCanonicalJson(file.parsed), "utf8"))}\n`);
    return;
  }
  fail("INSTALL_SCHEME_USAGE", "usage: install-scheme attestor expects --run-synthetic, --attest <controlled-root> <input-manifest> <artifact-pack-manifest> <absolute-venv-python> <aggregate>, or --validate-json <canonical-evidence-file>");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
