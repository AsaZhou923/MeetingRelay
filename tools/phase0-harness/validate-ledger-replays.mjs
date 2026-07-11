import path from "node:path";

import {
  cleanOutputDirectory,
  generateDoubleReplay,
  ledgerPaths,
} from "./ledger-contract.mjs";

const outputRoot = path.resolve(ledgerPaths.defaultOutputRoot);
await cleanOutputDirectory(outputRoot, ledgerPaths.repositoryRoot);
const comparison = await generateDoubleReplay(outputRoot);

console.log(
  JSON.stringify(
    {
      status: "passed",
      artifact_root: "target/wp-0.3/ct-ledger-001",
      input_sha256: comparison.input_ledger.sha256,
      decision_sha256: comparison.decision_ledger.sha256,
      observation_comparison: comparison.observation_ledger.comparison,
      observation_runtime_bytes_distinct:
        comparison.observation_ledger.distinct_runtime_bytes,
      formal_claims: comparison.formal_claims,
    },
    null,
    2,
  ),
);
