import path from "node:path";

import { cleanOutputDirectory } from "./ledger-contract.mjs";
import {
  generateDoubleProviderRun,
  providerPaths,
} from "./provider-harness.mjs";

const outputRoot = path.resolve(providerPaths.defaultOutputRoot);
await cleanOutputDirectory(outputRoot, providerPaths.repositoryRoot);
const comparison = await generateDoubleProviderRun(outputRoot);

console.log(
  JSON.stringify(
    {
      status: "passed",
      artifact_root: "target/wp-0.3/provider-harness",
      provider_events_sha256: comparison.provider_events.sha256,
      provider_run_sha256: comparison.provider_run.sha256,
      fault_steps_applied: comparison.fault_steps_applied,
      clock_mode: comparison.clock_mode,
      formal_claims: comparison.formal_claims,
    },
    null,
    2,
  ),
);
