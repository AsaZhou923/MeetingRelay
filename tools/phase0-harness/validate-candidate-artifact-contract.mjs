import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  candidateArtifactPaths,
  generateCandidateArtifactBundle,
  validateCandidateArtifactBundle,
} from "./candidate-artifact-contract.mjs";
import { cleanOutputDirectory } from "./ledger-contract.mjs";

export async function main(arguments_) {
  const validateExisting = arguments_[0] === "--existing";
  if (validateExisting) {
    if (!arguments_[1] || !arguments_[2]) {
      throw new Error(
        "--existing requires a bundle root and independently supplied contract SHA-256",
      );
    }
    const result = await validateCandidateArtifactBundle(
      path.resolve(arguments_[1]),
      {
        approvedLicenseSha256s: arguments_.slice(3),
        expectedContractSha256: arguments_[2],
      },
    );
    writeSummary(result);
    return;
  }
  const customRoot = arguments_[0] ? path.resolve(arguments_[0]) : null;
  const root = customRoot ?? candidateArtifactPaths.defaultBundleRoot;

  if (customRoot === null) {
    await cleanOutputDirectory(root, candidateArtifactPaths.repositoryRoot);
  }

  const result = await generateCandidateArtifactBundle(root);
  writeSummary(result);
}

function writeSummary(result) {
  process.stdout.write(
    JSON.stringify({
      artifact_root: path.relative(candidateArtifactPaths.repositoryRoot, result.bundleRoot)
        .split(path.sep)
        .join("/"),
      candidate_id: result.candidateId,
      contract_manifest_sha256: result.contractManifestSha256,
      contract_test_id: result.contractTestId,
      evidence_manifest_sha256: result.evidenceManifestSha256,
      fixture_manifest_sha256: result.fixtureManifestSha256,
      formal_claims: result.formalClaims,
      production_evidence: result.productionEvidence,
      status: result.status,
    }) + "\n",
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write((error.stack ?? error) + "\n");
    process.exitCode = 1;
  });
}
