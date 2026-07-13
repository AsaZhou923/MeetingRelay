import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

const SUCCESS_TOKEN = "MEETINGRELAY_DIRECTORY_MOVE_OK_V1";
const SOURCE_ENV = "MEETINGRELAY_DIRECTORY_MOVE_SOURCE";
const DESTINATION_ENV = "MEETINGRELAY_DIRECTORY_MOVE_DESTINATION";
const POWERSHELL_RELATIVE_PATH = path.join(
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);
const POWERSHELL_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  "if($PSVersionTable.PSEdition -ne 'Desktop' -or $PSVersionTable.PSVersion.Major -ne 5 -or -not [Environment]::Is64BitProcess){throw 'unsupported controlled publisher runtime'}",
  `$source=[Environment]::GetEnvironmentVariable('${SOURCE_ENV}','Process')`,
  `$destination=[Environment]::GetEnvironmentVariable('${DESTINATION_ENV}','Process')`,
  "if([String]::IsNullOrEmpty($source)-or[String]::IsNullOrEmpty($destination)){throw 'missing controlled directory-move input'}",
  "[System.IO.Directory]::Move($source,$destination)",
  `[Console]::Out.Write('${SUCCESS_TOKEN}')`,
].join(";");
const ENCODED_COMMAND = Buffer.from(POWERSHELL_SCRIPT, "utf16le").toString(
  "base64",
);

export class WindowsDirectoryPublishError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "WindowsDirectoryPublishError";
    this.code = code;
  }
}

function publishFail(code, message) {
  throw new WindowsDirectoryPublishError(code, message);
}

function pathKey(value) {
  return path.normalize(value).toLowerCase();
}

function assertLocalDrivePath(value, field) {
  if (
    typeof value !== "string" ||
    !path.isAbsolute(value) ||
    value !== value.normalize("NFC") ||
    path.normalize(value) !== value ||
    !/^[A-Za-z]:\\$/u.test(path.parse(value).root)
  ) {
    publishFail(
      "WINDOWS_DIRECTORY_PUBLISH_PATH",
      `${field} must be a normalized local-drive absolute path`,
    );
  }
  const root = path.parse(value).root;
  const reserved = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;
  for (const segment of path.relative(root, value).split(path.sep).filter(Boolean)) {
    if (
      segment.endsWith(".") ||
      segment.endsWith(" ") ||
      /[\u0000-\u001f<>:"|?*]/u.test(segment) ||
      reserved.test(segment)
    ) {
      publishFail(
        "WINDOWS_DIRECTORY_PUBLISH_PATH",
        `${field} contains an unsafe Windows path segment`,
      );
    }
  }
}

async function assertDirectPath(value, finalKind, field) {
  const root = path.parse(value).root;
  const segments = path.relative(root, value).split(path.sep).filter(Boolean);
  let current = root;
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    let stat;
    try {
      stat = await lstat(current);
    } catch {
      publishFail(
        "WINDOWS_DIRECTORY_PUBLISH_PATH",
        `${field} cannot be inspected`,
      );
    }
    const final = index === segments.length - 1;
    if (
      stat.isSymbolicLink() ||
      (!final && !stat.isDirectory()) ||
      (final && finalKind === "directory" && !stat.isDirectory()) ||
      (final && finalKind === "file" && !stat.isFile())
    ) {
      publishFail(
        "WINDOWS_DIRECTORY_PUBLISH_REPARSE",
        `${field} must use a direct non-reparse path`,
      );
    }
  }
  let resolved;
  try {
    resolved = await realpath(value);
  } catch {
    publishFail(
      "WINDOWS_DIRECTORY_PUBLISH_PATH",
      `${field} cannot be resolved`,
    );
  }
  if (pathKey(resolved) !== pathKey(value)) {
    publishFail(
      "WINDOWS_DIRECTORY_PUBLISH_REPARSE",
      `${field} must resolve to its direct path`,
    );
  }
}

function invokeExecFile(execFileImpl, executable, args, options) {
  return new Promise((resolve) => {
    execFileImpl(executable, args, options, (error, stdout, stderr) => {
      resolve({
        error,
        stderr: Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr ?? ""),
        stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? ""),
      });
    });
  });
}

async function publishDirectoryNoReplaceCore(
  { sourceDirectory, destinationDirectory },
  { environment, execFileImpl, platform },
) {
  if (platform !== "win32") {
    publishFail(
      "WINDOWS_DIRECTORY_PUBLISH_PLATFORM",
      "native directory publish is Windows-only",
    );
  }
  assertLocalDrivePath(sourceDirectory, "sourceDirectory");
  assertLocalDrivePath(destinationDirectory, "destinationDirectory");
  if (
    pathKey(path.dirname(sourceDirectory)) !==
    pathKey(path.dirname(destinationDirectory))
  ) {
    publishFail(
      "WINDOWS_DIRECTORY_PUBLISH_VOLUME",
      "source and destination must share one direct parent",
    );
  }

  const systemRoot = environment.SystemRoot ?? environment.SYSTEMROOT;
  assertLocalDrivePath(systemRoot, "SystemRoot");
  const powershell = path.join(systemRoot, POWERSHELL_RELATIVE_PATH);
  await assertDirectPath(powershell, "file", "system PowerShell");
  await assertDirectPath(sourceDirectory, "directory", "sourceDirectory");
  await assertDirectPath(
    path.dirname(destinationDirectory),
    "directory",
    "destination parent",
  );

  const childEnvironment = Object.freeze({
    [DESTINATION_ENV]: destinationDirectory,
    [SOURCE_ENV]: sourceDirectory,
    SystemRoot: systemRoot,
    WINDIR: systemRoot,
  });
  const result = await invokeExecFile(
    execFileImpl,
    powershell,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      ENCODED_COMMAND,
    ],
    {
      encoding: null,
      env: childEnvironment,
      maxBuffer: 64 * 1024,
      shell: false,
      timeout: 30_000,
      windowsHide: true,
    },
  );
  if (result.error !== null) {
    publishFail(
      "WINDOWS_DIRECTORY_PUBLISH_NATIVE",
      "the native no-replace move failed",
    );
  }
  if (
    result.stderr.length !== 0 ||
    !result.stdout.equals(Buffer.from(SUCCESS_TOKEN, "ascii"))
  ) {
    publishFail(
      "WINDOWS_DIRECTORY_PUBLISH_PROTOCOL",
      "the native publisher returned an invalid protocol response",
    );
  }
}

const PRODUCTION_DEPENDENCIES = Object.freeze({
  environment: process.env,
  execFileImpl: execFile,
  platform: process.platform,
});

export async function publishWindowsDirectoryNoReplace(input) {
  return publishDirectoryNoReplaceCore(input, PRODUCTION_DEPENDENCIES);
}

export async function __publishWindowsDirectoryNoReplaceForTest(
  input,
  dependencies,
) {
  return publishDirectoryNoReplaceCore(input, dependencies);
}

export const __WINDOWS_DIRECTORY_PUBLISH_PROTOCOL_FOR_TEST = Object.freeze({
  encodedCommand: ENCODED_COMMAND,
  destinationEnvironmentName: DESTINATION_ENV,
  powershellRelativePath: POWERSHELL_RELATIVE_PATH,
  sourceEnvironmentName: SOURCE_ENV,
  successToken: SUCCESS_TOKEN,
});
