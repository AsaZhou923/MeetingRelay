import path from "node:path";

import {
  clockCalibrationPaths,
  generateDoubleClockCalibration,
} from "./clock-calibration.mjs";
import { cleanOutputDirectory } from "./ledger-contract.mjs";

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error("WP-0.3.5 clock calibration requires the Windows x64 target");
}

const outputRoot = path.resolve(clockCalibrationPaths.defaultOutputRoot);
await cleanOutputDirectory(outputRoot, clockCalibrationPaths.repositoryRoot);
const comparison = await generateDoubleClockCalibration(outputRoot);

console.log(
  JSON.stringify(
    {
      status: "passed",
      artifact_root: "target/wp-0.3/ct-clock-cal-001",
      contract_sha256: comparison.contract_sha256,
      sample_pair_count: String(clockCalibrationPaths.defaultSamplePairCount),
      run_a_status: comparison.run_a.status,
      run_b_status: comparison.run_b.status,
      runtime_artifact_equality: comparison.runtime_artifact_equality,
      cross_domain_subtraction: comparison.cross_domain_subtraction,
      reference_error_status: "unavailable",
      formal_claims: comparison.formal_claims,
    },
    null,
    2,
  ),
);
