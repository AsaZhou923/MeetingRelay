import path from "node:path";

import {
  generateDoubleQueueResourceRun,
  queueResourcePaths,
} from "./queue-resource-harness.mjs";
import { cleanOutputDirectory } from "./ledger-contract.mjs";

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error("WP-0.3.6 queue/resource harness requires the Windows x64 target");
}

const outputRoot = path.resolve(queueResourcePaths.defaultOutputRoot);
await cleanOutputDirectory(outputRoot, queueResourcePaths.repositoryRoot);
const comparison = await generateDoubleQueueResourceRun(outputRoot);

console.log(
  JSON.stringify(
    {
      status: "passed",
      artifact_root: "target/wp-0.3/ct-resource-harness-001",
      contract_sha256: comparison.contract_sha256,
      resource_sample_count: String(
        queueResourcePaths.defaultResourceSampleCount,
      ),
      queue_artifact_equality: comparison.queue_artifacts.comparison,
      queue_sha256: comparison.queue_artifacts.sha256,
      runtime_artifact_equality:
        comparison.resource_artifacts.runtime_artifact_equality,
      resource_capability_projection:
        comparison.resource_artifacts.stable_capability_projection,
      capability_projection_sha256:
        comparison.resource_artifacts.projection_sha256,
      cross_domain_subtraction: comparison.cross_domain_subtraction,
      cadence_claim: comparison.cadence_claim,
      formal_claims: comparison.formal_claims,
    },
    null,
    2,
  ),
);
