import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const [script, ...scriptArguments] = process.argv.slice(2);
if (!script) {
  console.error("MEETINGRELAY_POWERSHELL_SCRIPT_REQUIRED");
  process.exit(2);
}

const scriptPath = resolve(script);
if (!existsSync(scriptPath)) {
  console.error(`MEETINGRELAY_POWERSHELL_SCRIPT_MISSING path=${scriptPath}`);
  process.exit(2);
}

const childEnvironment = { ...process.env };
for (const name of Object.keys(childEnvironment)) {
  if (name.toLowerCase() === "psmodulepath") {
    delete childEnvironment[name];
  }
}

const result = spawnSync(
  "powershell.exe",
  [
    "-NoLogo",
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    scriptPath,
    ...scriptArguments,
  ],
  {
    env: childEnvironment,
    stdio: "inherit",
    windowsHide: true,
  },
);

if (result.error) {
  console.error(`MEETINGRELAY_POWERSHELL_LAUNCH_FAILED message=${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
