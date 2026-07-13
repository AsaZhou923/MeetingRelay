import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { encodeCanonicalJson } from "./canonical-json.mjs";
import {
  Wp04ArtifactContractError,
  assertDigest,
  candidateArtifactPaths,
  generateCandidateArtifactBundle,
  validateArtifactPath,
  validateCandidateArtifactBundle,
  validateCandidateArtifactInputBundle,
} from "./candidate-artifact-contract.mjs";
import { sha256 } from "./fixture-contract.mjs";

const FULL_SHERPA_PARAMETERS_BYTES = Buffer.from(
  "{\"blank_penalty\":0,\"bpe_vocab\":null,\"channels\":1,\"debug\":false," +
    "\"decoding_method\":\"greedy_search\",\"feature_dim\":80," +
    "\"homophone_lexicon\":null,\"homophone_rule_fsts\":null," +
    "\"hotwords_file\":null,\"hotwords_score\":0,\"language\":\"zh\"," +
    "\"lm_model\":null,\"lm_scale\":1,\"max_active_paths\":4," +
    "\"max_input_bytes\":67108864,\"model_family\":\"sense_voice\"," +
    "\"model_type\":null,\"modeling_unit\":null,\"num_threads\":1," +
    "\"provider\":\"cpu\",\"rule_fars\":null,\"rule_fsts\":null," +
    "\"sample_rate_hz\":16000,\"telespeech_ctc\":null,\"use_itn\":true}",
  "utf8",
);

async function withBundle(run) {
  const temp = await mkdtemp(path.join(os.tmpdir(), "meetingrelay-wp04-artifact-"));
  const root = path.join(temp, "bundle");
  try {
    await generateCandidateArtifactBundle(root);
    return await run(root, temp);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

async function expectCode(promise, code) {
  await assert.rejects(
    promise,
    (error) =>
      error instanceof Wp04ArtifactContractError &&
      error.code === code,
    "expected " + code,
  );
}

async function readJson(root, relativePath) {
  return JSON.parse(await readFile(path.join(root, ...relativePath.split("/")), "utf8"));
}

async function writeCanonical(root, relativePath, value) {
  const bytes = Buffer.from(encodeCanonicalJson(value), "utf8");
  await writeFile(path.join(root, ...relativePath.split("/")), bytes);
  return bytes;
}

async function resealContractManifest(root, contract) {
  const bytes = await writeCanonical(root, "contract-manifest.json", contract);
  await writeFile(
    path.join(root, "contract-manifest.sha256"),
    sha256(bytes) + "  contract-manifest.json\n",
    "ascii",
  );
}

async function resealContractEntry(root, relativePath) {
  const bytes = await readFile(path.join(root, ...relativePath.split("/")));
  const contract = await readJson(root, "contract-manifest.json");
  const entry = contract.entries.find((value) => value.path === relativePath);
  assert.ok(entry, relativePath);
  entry.sha256 = sha256(bytes);
  entry.size_bytes = String(bytes.length);
  await resealContractManifest(root, contract);
}

async function addContractFile(root, relativePath, bytes) {
  const target = path.join(root, ...relativePath.split("/"));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, bytes);
  const contract = await readJson(root, "contract-manifest.json");
  contract.entries.push({
    path: relativePath,
    sha256: sha256(bytes),
    size_bytes: String(bytes.length),
  });
  contract.entries.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  await resealContractManifest(root, contract);
}

async function replaceContractFile(root, previousPath, relativePath, bytes) {
  const previousTarget = path.join(root, ...previousPath.split("/"));
  const target = path.join(root, ...relativePath.split("/"));
  if (previousPath !== relativePath) {
    await rm(previousTarget);
  }
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, bytes);
  const contract = await readJson(root, "contract-manifest.json");
  const entry = contract.entries.find((value) => value.path === previousPath);
  assert.ok(entry, previousPath);
  entry.path = relativePath;
  entry.sha256 = sha256(bytes);
  entry.size_bytes = String(bytes.length);
  contract.entries.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  await resealContractManifest(root, contract);
}

async function mutateContractJson(root, relativePath, mutate) {
  const value = await readJson(root, relativePath);
  mutate(value);
  await writeCanonical(root, relativePath, value);
  await resealContractEntry(root, relativePath);
}

async function refreshCandidateAssetDigests(root) {
  const candidate = await readJson(root, "manifests/candidate-manifest.json");
  for (const artifact of candidate.artifacts) {
    const bytes = await readFile(path.join(root, ...artifact.path.split("/")));
    artifact.sha256 = sha256(bytes);
    artifact.size_bytes = String(bytes.length);
  }
  const byRole = new Map(candidate.artifacts.map((artifact) => [artifact.role, artifact]));
  const projection = candidate.worker_manifest_projection;
  projection.worker_build_sha256 = byRole.get("worker-executable").sha256;
  projection.executable_sha256 = byRole.get("worker-executable").sha256;
  projection.schema_registry_sha256 = byRole.get("schema-registry").sha256;
  projection.descriptor.runtime_sha256 = byRole.get("runtime").sha256;
  projection.descriptor.package_lock_sha256 = byRole.get("package-lock").sha256;
  projection.descriptor.model_sha256 = byRole.get("model").sha256;
  projection.descriptor.model_manifest_sha256 = byRole.get("model-manifest").sha256;
  projection.descriptor.parameter_sha256 = byRole.get("parameters").sha256;
  candidate.source.source_sha256 = byRole.get("worker-executable").sha256;
  await writeCanonical(root, "manifests/candidate-manifest.json", candidate);
  await resealContractEntry(root, "manifests/candidate-manifest.json");
}

async function mutateEvidence(root, mutate) {
  const relativePath = "evidence/evidence-manifest.json";
  const value = await readJson(root, relativePath);
  mutate(value);
  const bytes = await writeCanonical(root, relativePath, value);
  await writeFile(
    path.join(root, "evidence", "evidence-manifest.sha256"),
    sha256(bytes) + "  evidence-manifest.json\n",
    "ascii",
  );
}

async function rebindEvidenceToCurrentContract(root) {
  const contractBytes = await readFile(path.join(root, "contract-manifest.json"));
  const expectedContractSha256 = sha256(contractBytes);
  await mutateEvidence(root, (evidence) => {
    evidence.contract_manifest_sha256 = expectedContractSha256;
  });
  return expectedContractSha256;
}

async function convertToCandidateRunBundle(root, role) {
  const suffix = role.replace("-candidate", "");
  const candidateId = "candidate-" + suffix + "-001";
  const fixtureSetId = "fixture-set-" + suffix + "-001";
  const hwRefId = "hw-ref-" + suffix + "-001";
  const runPlanId = "run-plan-" + suffix + "-001";
  const evidenceId = "evidence-" + suffix + "-001";
  const sourceCommit = "a".repeat(40);
  const noticeBytes = Buffer.from("candidate notice fixture\n", "utf8");
  const noticeLicenseBytes = Buffer.from("candidate notice license fixture\n", "utf8");

  await addContractFile(root, "assets/notice.txt", noticeBytes);
  await addContractFile(root, "licenses/notice.txt", noticeLicenseBytes);

  await mutateContractJson(root, "manifests/candidate-manifest.json", (candidate) => {
    candidate.artifact_scope = "candidate-input";
    candidate.candidate_id = candidateId;
    candidate.build.toolchain = "rust-1.95.0";
    candidate.publishability_status = "accepted";
    candidate.schema_version = "1.1";
    candidate.source.source_revision = sourceCommit;
    candidate.source.source_url = "https://example.invalid/source";
    candidate.worker_manifest_projection.role = role;
    candidate.worker_manifest_projection.descriptor.execution_provider = "cpu";
    candidate.artifacts.push({
      artifact_id: "artifact-notice",
      license_id: "license-notice",
      path: "assets/notice.txt",
      role: "notice",
      sha256: sha256(noticeBytes),
      size_bytes: String(noticeBytes.length),
    });
    candidate.artifacts.sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    );
    candidate.licenses[0].distribution_status = "accepted";
    candidate.licenses[0].review_scope = "distribution";
    candidate.licenses[0].review_source_status = "accepted";
    candidate.licenses[0].review_status = "accepted";
    candidate.licenses[0].source_revision = "project-license-rev-1";
    candidate.licenses[0].source_url = "https://example.invalid/project-license";
    candidate.licenses.push({
      distribution_status: "accepted",
      license_id: "license-notice",
      review_scope: "distribution",
      review_source_status: "accepted",
      review_status: "accepted",
      source_revision: "notice-license-rev-1",
      source_url: "https://example.invalid/notice-license",
      spdx_or_license_ref: "LicenseRef-Notice",
      text_path: "licenses/notice.txt",
      text_sha256: sha256(noticeLicenseBytes),
      text_size_bytes: String(noticeLicenseBytes.length),
    });
  });

  for (const relativePath of [
    "assets/model-manifest.json",
    "assets/package.lock",
    "assets/parameters.json",
    "assets/schema-registry.json",
    "assets/vad-endpoint-plan.json",
    "assets/warmup-plan.json",
  ]) {
    await mutateContractJson(root, relativePath, (asset) => {
      asset.artifact_scope = "candidate-input";
    });
  }
  await refreshCandidateAssetDigests(root);

  const candidateAfterRefresh = await readJson(
    root,
    "manifests/candidate-manifest.json",
  );
  const descriptorAfterRefresh =
    candidateAfterRefresh.worker_manifest_projection.descriptor;
  const digestOf = async (relativePath) =>
    sha256(await readFile(path.join(root, ...relativePath.split("/"))));
  const schemaRegistryDigest = await digestOf("assets/schema-registry.json");
  const coreHarnessDigest = await digestOf("assets/core-harness.bin");
  const uiHarnessDigest = await digestOf("assets/ui-harness.bin");
  const vadEndpointDigest = await digestOf("assets/vad-endpoint-plan.json");
  const warmupPlanDigest = await digestOf("assets/warmup-plan.json");

  await mutateContractJson(root, "manifests/fixture-set-manifest.json", (fixtureSet) => {
    fixtureSet.artifact_scope = "candidate-run-input";
    fixtureSet.fixture_set_id = fixtureSetId;
  });

  await mutateContractJson(root, "manifests/hw-ref.json", (hardware) => {
    hardware.capture_scope = "measured";
    hardware.captured_at = "2026-07-12T00:00:00Z";
    hardware.hw_ref_id = hwRefId;
    hardware.measurement_status = "captured";
    hardware.privacy_class = "internal-benchmark-metadata";
    hardware.collector.version = "meetingrelay-hw-ref-collector-v1";
    hardware.environment.audio_devices[0].driver_version = "1.0.0";
    hardware.environment.audio_devices[0].logical_role = "loopback";
    hardware.environment.audio_devices[0].model = "Fixture Audio";
    hardware.environment.audio_devices[0].signature_status = "signed";
    hardware.environment.audio_devices[0].vendor = "FixtureVendor";
    hardware.collector.sha256 = schemaRegistryDigest;
    hardware.environment.bios.release_date = "2026-01-01";
    hardware.environment.bios.vendor = "FixtureVendor";
    hardware.environment.bios.version = "1.0.0";
    hardware.environment.cooling.ambient_celsius = "23.0";
    hardware.environment.cooling.mode = "active";
    hardware.environment.cpu.logical_processor_count = "16";
    hardware.environment.cpu.physical_core_count = "8";
    hardware.environment.cpu.model = "Fixture CPU";
    hardware.environment.cpu.vendor = "FixtureVendor";
    hardware.environment.gpus[0].driver_version = "1.0.0";
    hardware.environment.gpus[0].execution_providers = [];
    hardware.environment.gpus[0].model = "Fixture GPU";
    hardware.environment.gpus[0].vendor = "FixtureVendor";
    hardware.environment.gpus[0].vram_bytes = "8589934592";
    hardware.environment.memory.total_bytes = "17179869184";
    hardware.environment.operating_system.build = "26100";
    hardware.environment.operating_system.ubr = "1";
    hardware.environment.operating_system.version = "11";
    hardware.environment.power.plan = `balanced@${"a".repeat(64)}`;
    hardware.environment.power.source = "ac";
    hardware.environment.storage[0].capacity_bytes = "1000000000000";
    hardware.environment.storage[0].driver_version = "1.0.0";
    hardware.environment.storage[0].filesystem = "NTFS";
    hardware.environment.storage[0].medium = "ssd";
    hardware.environment.storage[0].model = "Fixture Storage";
    hardware.environment.storage[0].vendor = "FixtureVendor";
  });

  await mutateContractJson(root, "manifests/run-plan.json", (runPlan) => {
    runPlan.candidate_ids = [candidateId];
    runPlan.evidence_manifest_id = evidenceId;
    runPlan.execution_status = "planned";
    runPlan.fixture_set_id = fixtureSetId;
    runPlan.hw_ref_id = hwRefId;
    runPlan.run_plan_id = runPlanId;
    runPlan.scope = "candidate-run";
    runPlan.source_commit = sourceCommit;
    runPlan.same_condition_contract.cooling_mode = "active";
    runPlan.same_condition_contract.execution_provider = "cpu";
    runPlan.same_condition_contract.endpoint_parameters.sha256 =
      vadEndpointDigest;
    runPlan.same_condition_contract.model_sha256 =
      descriptorAfterRefresh.model_sha256;
    runPlan.same_condition_contract.parameter_sha256 =
      descriptorAfterRefresh.parameter_sha256;
    runPlan.same_condition_contract.power_plan = `balanced@${"a".repeat(64)}`;
    runPlan.same_condition_contract.vad_parameters.sha256 =
      vadEndpointDigest;
    runPlan.same_condition_contract.warmup_plan.sha256 = warmupPlanDigest;
    runPlan.harness.core.sha256 = coreHarnessDigest;
    runPlan.harness.lockfile.sha256 =
      descriptorAfterRefresh.package_lock_sha256;
    runPlan.harness.ui.sha256 = uiHarnessDigest;
  });

  const contract = await readJson(root, "contract-manifest.json");
  contract.contract_id = "contract-" + suffix + "-001";
  await resealContractManifest(root, contract);
  const contractBytes = await readFile(path.join(root, "contract-manifest.json"));
  const contractDigest = sha256(contractBytes);

  const outputBytes = Buffer.from(
    encodeCanonicalJson({
      formal_claims: "none",
      observation_scope: "candidate-run-raw",
      production_evidence: false,
      schema_version: "1.0",
    }),
    "utf8",
  );
  const outputPath = "evidence/artifacts/raw-observation.json";
  const outputTarget = path.join(root, ...outputPath.split("/"));
  await mkdir(path.dirname(outputTarget), { recursive: true });
  await writeFile(outputTarget, outputBytes);

  await mutateEvidence(root, (evidence) => {
    evidence.candidate_ids = [candidateId];
    evidence.command_exit_code = 0;
    evidence.contract_manifest_sha256 = contractDigest;
    evidence.ended_at = "2026-07-12T00:00:02Z";
    evidence.evidence_manifest_id = evidenceId;
    evidence.execution_status = "completed";
    evidence.fixture_set_id = fixtureSetId;
    evidence.hw_ref_id = hwRefId;
    evidence.observation_scope = "candidate-run-raw";
    evidence.output_artifacts = [
      {
        artifact_id: "artifact-raw-observation",
        path: outputPath,
        role: "raw-observation",
        sha256: sha256(outputBytes),
        size_bytes: String(outputBytes.length),
      },
    ];
    evidence.run_id = "run-" + suffix + "-001";
    evidence.run_plan_id = runPlanId;
    evidence.source_commit = sourceCommit;
    evidence.started_at = "2026-07-12T00:00:01Z";
  });

  const candidateForApprovals = await readJson(
    root,
    "manifests/candidate-manifest.json",
  );
  return {
    approvedLicenseSha256s: candidateForApprovals.licenses.map(
      (license) => license.text_sha256,
    ),
    expectedContractSha256: contractDigest,
  };
}

async function removeEvidencePhase(root) {
  await rm(path.join(root, "evidence"), { recursive: true, force: true });
}

async function currentInputTrust(root) {
  const candidate = await readJson(root, "manifests/candidate-manifest.json");
  const contractBytes = await readFile(path.join(root, "contract-manifest.json"));
  return {
    approvedLicenseSha256s: candidate.licenses.map((license) => license.text_sha256),
    expectedContractSha256: sha256(contractBytes),
  };
}

async function convertToRawCandidateInputBundle(root) {
  await convertToCandidateRunBundle(root, "native-candidate");
  const assetLockBytes = await readFile(
    path.join(candidateArtifactPaths.repositoryRoot, "tools", "sherpa-native", "assets.lock.json"),
  );
  const cargoLockBytes = await readFile(
    path.join(candidateArtifactPaths.repositoryRoot, "Cargo.lock"),
  );
  const materials = new Map([
    [
      "model-manifest",
      {
        bytes: assetLockBytes,
        path: "assets/assets.lock.json",
        previousPath: "assets/model-manifest.json",
      },
    ],
    [
      "package-lock",
      {
        bytes: cargoLockBytes,
        path: "assets/Cargo.lock",
        previousPath: "assets/package.lock",
      },
    ],
    [
      "parameters",
      {
        bytes: FULL_SHERPA_PARAMETERS_BYTES,
        path: "assets/parameters.json",
        previousPath: "assets/parameters.json",
      },
    ],
  ]);

  for (const material of materials.values()) {
    await replaceContractFile(
      root,
      material.previousPath,
      material.path,
      material.bytes,
    );
  }

  await mutateContractJson(root, "manifests/candidate-manifest.json", (candidate) => {
    candidate.publishability_status = "pending";
    for (const license of candidate.licenses) {
      license.distribution_status = "pending";
    }
    const byRole = new Map(candidate.artifacts.map((artifact) => [artifact.role, artifact]));
    for (const [role, material] of materials) {
      const artifact = byRole.get(role);
      assert.ok(artifact, role);
      artifact.path = material.path;
      artifact.sha256 = sha256(material.bytes);
      artifact.size_bytes = String(material.bytes.length);
    }
    candidate.artifacts.sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    );
    const descriptor = candidate.worker_manifest_projection.descriptor;
    descriptor.model_manifest_sha256 = byRole.get("model-manifest").sha256;
    descriptor.package_lock_sha256 = byRole.get("package-lock").sha256;
    descriptor.parameter_sha256 = byRole.get("parameters").sha256;
  });

  await mutateContractJson(root, "manifests/run-plan.json", (runPlan) => {
    const cargoLock = materials.get("package-lock");
    runPlan.harness.lockfile.path = cargoLock.path;
    runPlan.harness.lockfile.sha256 = sha256(cargoLock.bytes);
    runPlan.same_condition_contract.parameter_sha256 = sha256(
      materials.get("parameters").bytes,
    );
  });
  await removeEvidencePhase(root);
  return currentInputTrust(root);
}

test("CT-WORKER-ARTIFACT-001 validates the generated sealed contract fixture", async () => {
  await withBundle(async (root) => {
    const result = await validateCandidateArtifactBundle(root);
    assert.equal(result.contractTestId, "CT-WORKER-ARTIFACT-001");
    assert.equal(result.candidateId, "candidate-contract-fixture-001");
    assert.match(result.contractManifestSha256, /^[0-9a-f]{64}$/);
    assert.match(result.evidenceManifestSha256, /^[0-9a-f]{64}$/);
    assert.match(result.fixtureManifestSha256, /^[0-9a-f]{64}$/);
    assert.equal(result.formalClaims, "none");
    assert.equal(result.productionEvidence, false);
    assert.equal(result.status, "passed");
  });
});

test("JSON worker projection field names stay aligned with the Rust semantic source", async () => {
  await withBundle(async (root) => {
    const candidate = await readJson(root, "manifests/candidate-manifest.json");
    const rust = await readFile(
      path.join(
        candidateArtifactPaths.repositoryRoot,
        "crates",
        "model-worker-contract",
        "src",
        "protocol.rs",
      ),
      "utf8",
    );
    const fields = (structName) => {
      const match = new RegExp(
        "pub struct " + structName + " \\{([\\s\\S]*?)\\n\\}",
      ).exec(rust);
      assert.ok(match, structName);
      return [...match[1].matchAll(/^\s*pub\s+([a-z0-9_]+):/gm)]
        .map((entry) => entry[1])
        .sort();
    };
    assert.deepEqual(
      Object.keys(candidate.worker_manifest_projection).sort(),
      fields("WorkerManifest"),
    );
    assert.deepEqual(
      Object.keys(candidate.worker_manifest_projection.descriptor).sort(),
      fields("EngineDescriptor"),
    );
  });
});

test("two independent contract fixtures are byte-for-byte deterministic", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "meetingrelay-wp04-determinism-"));
  const left = path.join(temp, "left");
  const right = path.join(temp, "right");
  try {
    await generateCandidateArtifactBundle(left);
    await generateCandidateArtifactBundle(right);
    for (const relativePath of candidateArtifactPaths.expectedFiles) {
      const leftBytes = await readFile(path.join(left, ...relativePath.split("/")));
      const rightBytes = await readFile(path.join(right, ...relativePath.split("/")));
      assert.equal(leftBytes.compare(rightBytes), 0, relativePath);
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("generic contract accepts native, sidecar, and fallback candidate-run profiles", async () => {
  for (const role of [
    "native-candidate",
    "sidecar-candidate",
    "fallback-candidate",
  ]) {
    await withBundle(async (root) => {
      const trust = await convertToCandidateRunBundle(root, role);
      const result = await validateCandidateArtifactBundle(root, trust);
      assert.equal(result.status, "passed");
      assert.equal(result.formalClaims, "none");
      assert.equal(result.productionEvidence, false);
      assert.match(result.candidateId, /^candidate-/);
    });
  }
});

test("candidate schema 1.1 carries license review provenance without upgrading the 1.0 fixture", async () => {
  await withBundle(async (root) => {
    const candidate = await readJson(root, "manifests/candidate-manifest.json");
    assert.equal(candidate.artifact_scope, "contract-fixture-only");
    assert.equal(candidate.schema_version, "1.0");
    assert.equal("review_scope" in candidate.licenses[0], false);
    assert.equal("review_source_status" in candidate.licenses[0], false);
  });
  await withBundle(async (root) => {
    const trust = await convertToRawCandidateInputBundle(root);
    const candidate = await readJson(root, "manifests/candidate-manifest.json");
    assert.equal(candidate.artifact_scope, "candidate-input");
    assert.equal(candidate.schema_version, "1.1");
    assert.ok(candidate.licenses.length > 1);
    for (const license of candidate.licenses) {
      assert.equal(license.review_scope, "distribution");
      assert.equal(license.review_source_status, "accepted");
    }
    assert.equal(
      (await validateCandidateArtifactInputBundle(root, trust)).status,
      "input-valid",
    );
  });
  await withBundle(async (root) => {
    await mutateContractJson(root, "manifests/candidate-manifest.json", (candidate) => {
      candidate.schema_version = "1.1";
    });
    await expectCode(validateCandidateArtifactBundle(root), "ART_SCHEMA_VALUE");
  });
  await withBundle(async (root) => {
    await convertToRawCandidateInputBundle(root);
    await mutateContractJson(root, "manifests/candidate-manifest.json", (candidate) => {
      candidate.schema_version = "1.0";
    });
    await expectCode(
      validateCandidateArtifactInputBundle(root, await currentInputTrust(root)),
      "ART_SCHEMA_VALUE",
    );
  });
});

test("candidate license review scopes and source statuses fail closed on loss or contradiction", async () => {
  await withBundle(async (root) => {
    await convertToRawCandidateInputBundle(root);
    await mutateContractJson(root, "manifests/candidate-manifest.json", (candidate) => {
      for (const license of candidate.licenses) {
        license.distribution_status = "pending";
        license.review_scope = "internal-evaluation-only";
        license.review_source_status = "accepted-for-internal-evaluation";
        license.review_status = "accepted";
      }
    });
    assert.equal(
      (
        await validateCandidateArtifactInputBundle(
          root,
          await currentInputTrust(root),
        )
      ).status,
      "input-valid",
    );
  });
  await withBundle(async (root) => {
    await convertToRawCandidateInputBundle(root);
    await mutateContractJson(root, "manifests/candidate-manifest.json", (candidate) => {
      const license = candidate.licenses[0];
      license.distribution_status = "pending";
      license.review_scope = "internal-evaluation-only";
      license.review_source_status = "unlicensed";
      license.review_status = "rejected";
    });
    assert.equal(
      (
        await validateCandidateArtifactInputBundle(
          root,
          await currentInputTrust(root),
        )
      ).status,
      "input-valid",
    );
  });
  await withBundle(async (root) => {
    await convertToRawCandidateInputBundle(root);
    await mutateContractJson(root, "manifests/candidate-manifest.json", (candidate) => {
      delete candidate.licenses[0].review_scope;
    });
    await expectCode(
      validateCandidateArtifactInputBundle(root, await currentInputTrust(root)),
      "ART_SCHEMA_KEYS",
    );
  });
  for (const mutateLicense of [
    (license) => {
      license.review_source_status = "unknown";
    },
    (license) => {
      license.review_source_status = "pending";
    },
    (license) => {
      license.review_status = "accepted-for-internal-evaluation";
    },
    (license) => {
      license.review_status = "pending";
    },
  ]) {
    await withBundle(async (root) => {
      await convertToRawCandidateInputBundle(root);
      await mutateContractJson(root, "manifests/candidate-manifest.json", (candidate) => {
        const license = candidate.licenses[0];
        license.distribution_status = "pending";
        license.review_scope = "internal-evaluation-only";
        license.review_source_status = "accepted-for-internal-evaluation";
        license.review_status = "accepted";
        mutateLicense(license);
      });
      await expectCode(
        validateCandidateArtifactInputBundle(root, await currentInputTrust(root)),
        "ART_LICENSE_REFERENCE",
      );
    });
  }
});

test("candidate license review rejects cross-scope status contradictions", async (context) => {
  const cases = [
    {
      name: "internal evaluation cannot accept distribution",
      mutate(license) {
        license.distribution_status = "accepted";
        license.review_scope = "internal-evaluation-only";
        license.review_source_status = "accepted-for-internal-evaluation";
        license.review_status = "accepted";
      },
    },
    {
      name: "unlicensed source cannot normalize to accepted",
      mutate(license) {
        license.distribution_status = "pending";
        license.review_scope = "internal-evaluation-only";
        license.review_source_status = "unlicensed";
        license.review_status = "accepted";
      },
    },
    {
      name: "unlicensed source cannot normalize to pending",
      mutate(license) {
        license.distribution_status = "pending";
        license.review_scope = "internal-evaluation-only";
        license.review_source_status = "unlicensed";
        license.review_status = "pending";
      },
    },
    {
      name: "distribution source and normalized review must agree",
      mutate(license) {
        license.distribution_status = "pending";
        license.review_scope = "distribution";
        license.review_source_status = "pending";
        license.review_status = "accepted";
      },
    },
  ];
  for (const case_ of cases) {
    await context.test(case_.name, async () => {
      await withBundle(async (root) => {
        await convertToRawCandidateInputBundle(root);
        await mutateContractJson(
          root,
          "manifests/candidate-manifest.json",
          (candidate) => case_.mutate(candidate.licenses[0]),
        );
        await expectCode(
          validateCandidateArtifactInputBundle(
            root,
            await currentInputTrust(root),
          ),
          "ART_LICENSE_REFERENCE",
        );
      });
    });
  }
});

test("descriptor model license binds only the model while model-manifest keeps a resolved license", async () => {
  await withBundle(async (root) => {
    await convertToRawCandidateInputBundle(root);
    await mutateContractJson(root, "manifests/candidate-manifest.json", (candidate) => {
      candidate.artifacts.find(
        (artifact) => artifact.role === "model-manifest",
      ).license_id = "license-notice";
    });
    assert.equal(
      (
        await validateCandidateArtifactInputBundle(
          root,
          await currentInputTrust(root),
        )
      ).status,
      "input-valid",
    );
  });
  await withBundle(async (root) => {
    await convertToRawCandidateInputBundle(root);
    await mutateContractJson(root, "manifests/candidate-manifest.json", (candidate) => {
      candidate.artifacts.find((artifact) => artifact.role === "model").license_id =
        "license-notice";
    });
    await expectCode(
      validateCandidateArtifactInputBundle(root, await currentInputTrust(root)),
      "ART_LICENSE_REFERENCE",
    );
  });
});

test("candidate input validates without evidence while combined validation still requires it", async () => {
  await withBundle(async (root) => {
    const trust = await convertToRawCandidateInputBundle(root);

    const result = await validateCandidateArtifactInputBundle(root, {
      expectedContractSha256: trust.expectedContractSha256,
    });
    assert.deepEqual(Object.keys(result).sort(), [
      "bundleRoot",
      "candidateId",
      "contractManifestSha256",
      "contractTestId",
      "fixtureManifestSha256",
      "formalClaims",
      "productionEvidence",
      "status",
      "validationPhase",
    ]);
    assert.equal(result.status, "input-valid");
    assert.equal(result.validationPhase, "input-only");
    assert.equal(result.formalClaims, "none");
    assert.equal(result.productionEvidence, false);
    assert.equal("evidenceManifestSha256" in result, false);
    await expectCode(
      validateCandidateArtifactBundle(root, trust),
      "ART_INVENTORY_MISMATCH",
    );
  });
});

test("candidate-run source commit must join the sealed candidate source revision", async () => {
  await withBundle(async (root) => {
    await convertToRawCandidateInputBundle(root);
    await mutateContractJson(root, "manifests/run-plan.json", (runPlan) => {
      runPlan.source_commit = "b".repeat(40);
    });
    await expectCode(
      validateCandidateArtifactInputBundle(root, await currentInputTrust(root)),
      "ART_JOIN_MISMATCH",
    );
  });
});

test("candidate input treats assets lock, Cargo lock, and full compact parameters as descriptor-bound bytes", async () => {
  await withBundle(async (root) => {
    const trust = await convertToRawCandidateInputBundle(root);
    const assetsLock = await readFile(path.join(root, "assets", "assets.lock.json"), "utf8");
    const cargoLock = await readFile(path.join(root, "assets", "Cargo.lock"), "utf8");
    const parameters = await readFile(path.join(root, "assets", "parameters.json"), "utf8");

    assert.match(assetsLock, /\n  \"schema_version\"/);
    assert.match(cargoLock, /^# This file is automatically @generated by Cargo\./);
    assert.equal(parameters, FULL_SHERPA_PARAMETERS_BYTES.toString("utf8"));
    assert.equal(JSON.parse(parameters).num_threads, 1);
    assert.equal("batch_size" in JSON.parse(parameters), false);
    const result = await validateCandidateArtifactInputBundle(root, trust);
    assert.equal(result.status, "input-valid");
  });
});

test("candidate input streams a model artifact without parsing it from a JSON-looking path", async () => {
  await withBundle(async (root) => {
    await convertToRawCandidateInputBundle(root);
    const modelBytes = await readFile(path.join(root, "assets", "contract-model.bin"));
    await replaceContractFile(
      root,
      "assets/contract-model.bin",
      "assets/model.json",
      modelBytes,
    );
    await mutateContractJson(root, "manifests/candidate-manifest.json", (candidate) => {
      const model = candidate.artifacts.find((artifact) => artifact.role === "model");
      model.path = "assets/model.json";
      candidate.artifacts.sort((left, right) =>
        left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
      );
    });
    const candidate = await readJson(root, "manifests/candidate-manifest.json");
    const contract = await readJson(root, "contract-manifest.json");
    const model = candidate.artifacts.find((artifact) => artifact.role === "model");
    const contractEntry = contract.entries.find((entry) => entry.path === model.path);
    assert.equal(model.sha256, sha256(modelBytes));
    assert.equal(model.size_bytes, String(modelBytes.length));
    assert.equal(contractEntry.sha256, model.sha256);
    assert.equal(contractEntry.size_bytes, model.size_bytes);
    assert.equal(
      candidate.worker_manifest_projection.descriptor.model_sha256,
      model.sha256,
    );

    const result = await validateCandidateArtifactInputBundle(
      root,
      await currentInputTrust(root),
    );
    assert.equal(result.status, "input-valid");
  });
});

test("candidate input rejects raw Cargo lock, assets lock whitespace, and compact parameter byte drift", async () => {
  for (const [relativePath, suffix] of [
    ["assets/Cargo.lock", Buffer.from("# drift\n", "utf8")],
    ["assets/assets.lock.json", Buffer.from(" \n", "utf8")],
    ["assets/parameters.json", Buffer.from("\n", "utf8")],
  ]) {
    await withBundle(async (root) => {
      const trust = await convertToRawCandidateInputBundle(root);
      const target = path.join(root, ...relativePath.split("/"));
      await writeFile(target, Buffer.concat([await readFile(target), suffix]));
      await expectCode(
        validateCandidateArtifactInputBundle(root, trust),
        "ART_DIGEST_MISMATCH",
      );
    });
  }
});

test("candidate input rejects descriptor role size and path joins that diverge from sealed raw assets", async () => {
  await withBundle(async (root) => {
    await convertToRawCandidateInputBundle(root);
    await mutateContractJson(root, "manifests/candidate-manifest.json", (candidate) => {
      const cargoLock = candidate.artifacts.find((artifact) => artifact.role === "package-lock");
      cargoLock.size_bytes = String(Number(cargoLock.size_bytes) + 1);
    });
    await expectCode(
      validateCandidateArtifactInputBundle(root, await currentInputTrust(root)),
      "ART_JOIN_MISMATCH",
    );
  });
  await withBundle(async (root) => {
    await convertToRawCandidateInputBundle(root);
    await mutateContractJson(root, "manifests/candidate-manifest.json", (candidate) => {
      const assetsLock = candidate.artifacts.find(
        (artifact) => artifact.role === "model-manifest",
      );
      assetsLock.path = "assets/Cargo.lock";
    });
    await expectCode(
      validateCandidateArtifactInputBundle(root, await currentInputTrust(root)),
      "ART_JOIN_MISMATCH",
    );
  });
});

test("candidate input keeps external trust, accepted-license approval, claim, and exact-inventory gates", async () => {
  await withBundle(async (root) => {
    await convertToRawCandidateInputBundle(root);
    await expectCode(
      validateCandidateArtifactInputBundle(root),
      "ART_TRUST_ANCHOR_REQUIRED",
    );
  });
  await withBundle(async (root) => {
    const trust = await convertToRawCandidateInputBundle(root);
    await expectCode(
      validateCandidateArtifactInputBundle(root, {
        expectedContractSha256: "1".repeat(64),
      }),
      "ART_JOIN_CONTRACT_MISMATCH",
    );
    assert.notEqual(trust.expectedContractSha256, "1".repeat(64));
  });
  await withBundle(async (root) => {
    await convertToRawCandidateInputBundle(root);
    await mutateContractJson(root, "manifests/candidate-manifest.json", (candidate) => {
      candidate.publishability_status = "accepted";
      for (const license of candidate.licenses) {
        license.distribution_status = "accepted";
      }
    });
    const trust = await currentInputTrust(root);
    await expectCode(
      validateCandidateArtifactInputBundle(root, {
        expectedContractSha256: trust.expectedContractSha256,
      }),
      "ART_LICENSE_APPROVAL_REQUIRED",
    );
    assert.ok(trust.approvedLicenseSha256s.length > 1);
    await expectCode(
      validateCandidateArtifactInputBundle(root, {
        approvedLicenseSha256s: [trust.approvedLicenseSha256s[0]],
        expectedContractSha256: trust.expectedContractSha256,
      }),
      "ART_LICENSE_APPROVAL_REQUIRED",
    );
    assert.equal(
      (await validateCandidateArtifactInputBundle(root, trust)).status,
      "input-valid",
    );
  });
  await withBundle(async (root) => {
    await convertToRawCandidateInputBundle(root);
    await mutateContractJson(root, "manifests/candidate-manifest.json", (candidate) => {
      candidate.claims.formal_metric_ids = ["PERF-RT-001"];
    });
    await expectCode(
      validateCandidateArtifactInputBundle(root, await currentInputTrust(root)),
      "ART_CLAIM_UNSUPPORTED",
    );
  });
  await withBundle(async (root) => {
    const trust = await convertToRawCandidateInputBundle(root);
    await writeFile(path.join(root, "extra.txt"), "extra\n");
    await expectCode(
      validateCandidateArtifactInputBundle(root, trust),
      "ART_INVENTORY_MISMATCH",
    );
  });
  await withBundle(async (root) => {
    const trust = await convertToRawCandidateInputBundle(root);
    await mkdir(path.join(root, "evidence"), { recursive: true });
    await writeFile(
      path.join(root, "evidence", "evidence-manifest.sha256"),
      "1".repeat(64) + "  evidence-manifest.json\n",
      "ascii",
    );
    await expectCode(
      validateCandidateArtifactInputBundle(root, trust),
      "ART_INVENTORY_MISMATCH",
    );
  });
});

test("candidate-run bundles require an external trust anchor and seal raw outputs", async () => {
  await withBundle(async (root) => {
    const trust = await convertToCandidateRunBundle(
      root,
      "native-candidate",
    );
    await expectCode(
      validateCandidateArtifactBundle(root),
      "ART_TRUST_ANCHOR_REQUIRED",
    );
    await expectCode(
      validateCandidateArtifactBundle(root, {
        expectedContractSha256: "1".repeat(64),
        approvedLicenseSha256s: trust.approvedLicenseSha256s,
      }),
      "ART_JOIN_CONTRACT_MISMATCH",
    );
    await expectCode(
      validateCandidateArtifactBundle(root, {
        expectedContractSha256: trust.expectedContractSha256,
      }),
      "ART_LICENSE_APPROVAL_REQUIRED",
    );
    const target = path.join(
      root,
      "evidence",
      "artifacts",
      "raw-observation.json",
    );
    const bytes = await readFile(target);
    bytes[0] ^= 0xff;
    await writeFile(target, bytes);
    await expectCode(
      validateCandidateArtifactBundle(root, trust),
      "ART_DIGEST_MISMATCH",
    );
  });
});

test("generic candidate license, HW, timestamp, and raw-output semantics fail closed", async () => {
  await withBundle(async (root) => {
    const initialTrust = await convertToCandidateRunBundle(
      root,
      "native-candidate",
    );
    await mutateContractJson(root, "manifests/candidate-manifest.json", (candidate) => {
      candidate.artifacts.find((artifact) => artifact.role === "model").license_id =
        "license-notice";
    });
    const expectedContractSha256 = await rebindEvidenceToCurrentContract(root);
    await expectCode(
      validateCandidateArtifactBundle(root, {
        approvedLicenseSha256s: initialTrust.approvedLicenseSha256s,
        expectedContractSha256,
      }),
      "ART_LICENSE_REFERENCE",
    );
  });

  await withBundle(async (root) => {
    const initialTrust = await convertToCandidateRunBundle(
      root,
      "native-candidate",
    );
    const relativePath = "licenses/project-generated.txt";
    const maliciousBytes = Buffer.from("UNLICENSED REAL MODEL BYTES\n", "utf8");
    await writeFile(path.join(root, ...relativePath.split("/")), maliciousBytes);
    await resealContractEntry(root, relativePath);
    await mutateContractJson(root, "manifests/candidate-manifest.json", (candidate) => {
      const license = candidate.licenses.find(
        (entry) => entry.license_id === "license-project-generated",
      );
      license.text_sha256 = sha256(maliciousBytes);
      license.text_size_bytes = String(maliciousBytes.length);
    });
    const expectedContractSha256 = await rebindEvidenceToCurrentContract(root);
    await expectCode(
      validateCandidateArtifactBundle(root, {
        approvedLicenseSha256s: [
          sha256(maliciousBytes),
          initialTrust.approvedLicenseSha256s[1],
        ],
        expectedContractSha256,
      }),
      "ART_LICENSE_REFERENCE",
    );
  });

  await withBundle(async (root) => {
    const initialTrust = await convertToCandidateRunBundle(
      root,
      "native-candidate",
    );
    await mutateContractJson(root, "manifests/hw-ref.json", (hardware) => {
      hardware.environment.bios.vendor = null;
    });
    const expectedContractSha256 = await rebindEvidenceToCurrentContract(root);
    await expectCode(
      validateCandidateArtifactBundle(root, {
        approvedLicenseSha256s: initialTrust.approvedLicenseSha256s,
        expectedContractSha256,
      }),
      "ART_SCHEMA_VALUE",
    );
  });

  await withBundle(async (root) => {
    const trust = await convertToCandidateRunBundle(root, "native-candidate");
    await mutateEvidence(root, (evidence) => {
      evidence.started_at = "2026-07-12T00:00:01.900000000Z";
      evidence.ended_at = "2026-07-12T00:00:01Z";
    });
    await expectCode(
      validateCandidateArtifactBundle(root, trust),
      "ART_SCHEMA_VALUE",
    );
  });

  for (const invalidTimestamp of [
    "2026-02-30T00:00:00Z",
    "2025-02-29T00:00:00Z",
    "2026-13-01T00:00:00Z",
    "2026-07-12T24:00:00Z",
  ]) {
    await withBundle(async (root) => {
      const trust = await convertToCandidateRunBundle(root, "native-candidate");
      await mutateEvidence(root, (evidence) => {
        evidence.started_at = invalidTimestamp;
        evidence.ended_at = invalidTimestamp;
      });
      await expectCode(
        validateCandidateArtifactBundle(root, trust),
        "ART_SCHEMA_VALUE",
      );
    });
  }

  await withBundle(async (root) => {
    const initialTrust = await convertToCandidateRunBundle(
      root,
      "native-candidate",
    );
    await mutateContractJson(root, "manifests/candidate-manifest.json", (candidate) => {
      candidate.build.target = "x86_64-unknown-linux-gnu";
    });
    const expectedContractSha256 = await rebindEvidenceToCurrentContract(root);
    await expectCode(
      validateCandidateArtifactBundle(root, {
        approvedLicenseSha256s: initialTrust.approvedLicenseSha256s,
        expectedContractSha256,
      }),
      "ART_SCHEMA_VALUE",
    );
  });

  await withBundle(async (root) => {
    const trust = await convertToCandidateRunBundle(root, "native-candidate");
    const outputPath = "evidence/artifacts/raw-observation.json";
    const output = await readJson(root, outputPath);
    output.formal_claims = "PERF-RT-001 passed";
    output.production_evidence = true;
    const bytes = await writeCanonical(root, outputPath, output);
    await mutateEvidence(root, (evidence) => {
      evidence.output_artifacts[0].sha256 = sha256(bytes);
      evidence.output_artifacts[0].size_bytes = String(bytes.length);
    });
    await expectCode(
      validateCandidateArtifactBundle(root, trust),
      "ART_CLAIM_UNSUPPORTED",
    );
  });
});

test("digest primitives reject missing, zero, uppercase, Pending, and short values", () => {
  const cases = [
    [undefined, "ART_DIGEST_MISSING"],
    ["", "ART_DIGEST_MISSING"],
    ["0".repeat(64), "ART_DIGEST_ZERO"],
    ["A".repeat(64), "ART_DIGEST_FORMAT"],
    ["Pending", "ART_DIGEST_FORMAT"],
    ["a".repeat(63), "ART_DIGEST_FORMAT"],
  ];
  for (const [value, code] of cases) {
    assert.throws(
      () => assertDigest(value, "test.digest"),
      (error) => error instanceof Wp04ArtifactContractError && error.code === code,
    );
  }
});

test("artifact paths reject traversal, absolute, drive, UNC, backslash, ADS, and reserved names", () => {
  const cases = [
    ["../model.bin", "ART_PATH_TRAVERSAL"],
    ["assets/./model.bin", "ART_PATH_TRAVERSAL"],
    ["/assets/model.bin", "ART_PATH_ABSOLUTE"],
    ["C:\\models\\model.bin", "ART_PATH_ABSOLUTE"],
    ["C:models/model.bin", "ART_PATH_ABSOLUTE"],
    ["\\\\server\\share\\model.bin", "ART_PATH_UNC"],
    ["//server/share/model.bin", "ART_PATH_UNC"],
    ["assets\\model.bin", "ART_PATH_SEPARATOR"],
    ["assets/model.bin:Zone.Identifier", "ART_PATH_ADS"],
    ["assets/NUL.txt", "ART_PATH_RESERVED"],
  ];
  for (const [value, code] of cases) {
    assert.throws(
      () => validateArtifactPath(value),
      (error) => error instanceof Wp04ArtifactContractError && error.code === code,
      value,
    );
  }
});

test("asset tampering fails before semantic validation", async () => {
  await withBundle(async (root) => {
    const target = path.join(root, "assets", "contract-model.bin");
    const bytes = await readFile(target);
    bytes[0] ^= 0xff;
    await writeFile(target, bytes);
    await expectCode(validateCandidateArtifactBundle(root), "ART_DIGEST_MISMATCH");
  });
});

test("contract and evidence seals reject checksum-preserving manifest rewrites", async () => {
  await withBundle(async (root) => {
    const contract = await readJson(root, "contract-manifest.json");
    contract.formal_claims = "unsupported";
    await writeCanonical(root, "contract-manifest.json", contract);
    await expectCode(validateCandidateArtifactBundle(root), "ART_DIGEST_SEAL_MISMATCH");
  });
  await withBundle(async (root) => {
    const evidence = await readJson(root, "evidence/evidence-manifest.json");
    evidence.selection_status = "default-selected";
    await writeCanonical(root, "evidence/evidence-manifest.json", evidence);
    await expectCode(validateCandidateArtifactBundle(root), "ART_DIGEST_SEAL_MISMATCH");
  });
});

test("exact inventory rejects extra and missing files", async () => {
  await withBundle(async (root) => {
    await writeFile(path.join(root, "extra.txt"), "extra\n");
    await expectCode(validateCandidateArtifactBundle(root), "ART_INVENTORY_MISMATCH");
  });
  await withBundle(async (root) => {
    await rm(path.join(root, "evidence", "evidence-manifest.sha256"));
    await expectCode(validateCandidateArtifactBundle(root), "ART_INVENTORY_MISMATCH");
  });
});

test("canonical JSON rejects CRLF even after every enclosing digest is updated", async () => {
  await withBundle(async (root) => {
    const relativePath = "manifests/candidate-manifest.json";
    const target = path.join(root, ...relativePath.split("/"));
    const text = await readFile(target, "utf8");
    await writeFile(target, text.replaceAll("\n", "\r\n"), "utf8");
    await resealContractEntry(root, relativePath);
    await expectCode(validateCandidateArtifactBundle(root), "ART_CANONICAL_JSON");
  });
});

test("candidate required digests fail closed after a valid reseal", async () => {
  await withBundle(async (root) => {
    await mutateContractJson(root, "manifests/candidate-manifest.json", (candidate) => {
      candidate.worker_manifest_projection.worker_build_sha256 = "";
    });
    await expectCode(validateCandidateArtifactBundle(root), "ART_DIGEST_MISSING");
  });
  await withBundle(async (root) => {
    await mutateContractJson(root, "manifests/candidate-manifest.json", (candidate) => {
      candidate.worker_manifest_projection.descriptor.model_sha256 = "0".repeat(64);
    });
    await expectCode(validateCandidateArtifactBundle(root), "ART_DIGEST_ZERO");
  });
});

test("missing and unresolved candidate licenses fail closed", async () => {
  await withBundle(async (root) => {
    await mutateContractJson(root, "manifests/candidate-manifest.json", (candidate) => {
      candidate.artifacts[0].license_id = "";
    });
    await expectCode(validateCandidateArtifactBundle(root), "ART_LICENSE_MISSING");
  });
  await withBundle(async (root) => {
    await mutateContractJson(root, "manifests/candidate-manifest.json", (candidate) => {
      candidate.worker_manifest_projection.descriptor.model_license_id =
        "license-does-not-exist";
    });
    await expectCode(validateCandidateArtifactBundle(root), "ART_LICENSE_REFERENCE");
  });
});

test("candidate and evidence cannot claim eligibility, selection, PERF, SLO, or production", async () => {
  await withBundle(async (root) => {
    await mutateContractJson(root, "manifests/candidate-manifest.json", (candidate) => {
      candidate.publishability_status = "accepted";
    });
    await expectCode(validateCandidateArtifactBundle(root), "ART_CLAIM_UNSUPPORTED");
  });
  await withBundle(async (root) => {
    await mutateContractJson(root, "manifests/candidate-manifest.json", (candidate) => {
      candidate.claims.formal_metric_ids = ["PERF-RT-001"];
    });
    await expectCode(validateCandidateArtifactBundle(root), "ART_CLAIM_UNSUPPORTED");
  });
  await withBundle(async (root) => {
    await mutateEvidence(root, (evidence) => {
      evidence.slo_claims = ["MR-PER-001 Pass"];
      evidence.production_evidence = true;
    });
    await expectCode(validateCandidateArtifactBundle(root), "ART_CLAIM_UNSUPPORTED");
  });
  await withBundle(async (root) => {
    await mutateEvidence(root, (evidence) => {
      evidence.selection_status = "default-selected";
    });
    await expectCode(validateCandidateArtifactBundle(root), "ART_CLAIM_UNSUPPORTED");
  });
});

test("fully resealed JSON-asset overclaims and contradictory license text are rejected", async () => {
  await withBundle(async (root) => {
    await mutateContractJson(root, "assets/model-manifest.json", (modelManifest) => {
      modelManifest.formal_claims = "PERF-RT-001 passed";
    });
    await expectCode(validateCandidateArtifactBundle(root), "ART_CLAIM_UNSUPPORTED");
  });
  await withBundle(async (root) => {
    const relativePath = "licenses/project-generated.txt";
    await writeFile(
      path.join(root, ...relativePath.split("/")),
      "UNLICENSED REAL MODEL BYTES\n",
      "utf8",
    );
    await resealContractEntry(root, relativePath);
    const candidate = await readJson(root, "manifests/candidate-manifest.json");
    const bytes = await readFile(path.join(root, ...relativePath.split("/")));
    candidate.licenses[0].text_sha256 = sha256(bytes);
    candidate.licenses[0].text_size_bytes = String(bytes.length);
    await writeCanonical(root, "manifests/candidate-manifest.json", candidate);
    await resealContractEntry(root, "manifests/candidate-manifest.json");
    await expectCode(validateCandidateArtifactBundle(root), "ART_DIGEST_MISMATCH");
  });
});

test("checksum-valid unsafe candidate paths still fail closed", async () => {
  await withBundle(async (root) => {
    await mutateContractJson(root, "manifests/candidate-manifest.json", (candidate) => {
      candidate.artifacts[0].path = "../contract-worker.bin";
    });
    await expectCode(validateCandidateArtifactBundle(root), "ART_PATH_TRAVERSAL");
  });
});

test("fixture and run-plan joins cannot diverge from sealed inputs", async () => {
  await withBundle(async (root) => {
    await mutateContractJson(root, "manifests/fixture-set-manifest.json", (fixtureSet) => {
      fixtureSet.registry.sha256 = "1".repeat(64);
    });
    await expectCode(validateCandidateArtifactBundle(root), "ART_JOIN_MISMATCH");
  });
  await withBundle(async (root) => {
    await mutateContractJson(root, "manifests/run-plan.json", (runPlan) => {
      runPlan.candidate_ids = ["candidate-unknown"];
    });
    await expectCode(validateCandidateArtifactBundle(root), "ART_JOIN_MISMATCH");
  });
  await withBundle(async (root) => {
    await mutateContractJson(root, "manifests/run-plan.json", (runPlan) => {
      runPlan.same_condition_contract.model_sha256 = "1".repeat(64);
    });
    await expectCode(validateCandidateArtifactBundle(root), "ART_JOIN_MISMATCH");
  });
});

test("evidence must reference the exact sealed input contract and IDs", async () => {
  await withBundle(async (root) => {
    await mutateEvidence(root, (evidence) => {
      evidence.contract_manifest_sha256 = "1".repeat(64);
    });
    await expectCode(validateCandidateArtifactBundle(root), "ART_JOIN_CONTRACT_MISMATCH");
  });
  await withBundle(async (root) => {
    await mutateEvidence(root, (evidence) => {
      evidence.candidate_ids = ["candidate-unknown"];
    });
    await expectCode(validateCandidateArtifactBundle(root), "ART_JOIN_CONTRACT_MISMATCH");
  });
});

test("HW-REF rejects stable identifiers, email-like values, and local absolute paths", async () => {
  const mutations = [
    (hardware) => {
      hardware.environment.hostname = "benchmark-host";
    },
    (hardware) => {
      hardware.environment.bios.serial_number = "SERIAL-123";
    },
    (hardware) => {
      hardware.environment.storage[0].pnp_device_id =
        "forbidden-even-before-value-validation";
    },
    (hardware) => {
      hardware.environment.storage[0].model = "owner@example.test";
    },
    (hardware) => {
      hardware.environment.power.plan = "C:\\Users\\owner\\power.txt";
    },
    (hardware) => {
      hardware.environment.bios.version = "550e8400-e29b-41d4-a716-446655440000";
    },
    (hardware) => {
      hardware.environment.audio_devices[0].model =
        "HDAUDIO\\FUNC_01&VEN_10EC&DEV_0295";
    },
    (hardware) => {
      hardware.environment.gpus[0].model = "PCI\\VEN_10DE&DEV_2D58";
    },
    (hardware) => {
      hardware.environment.storage[0].model = "USBSTOR\\DISK&VEN_FIXTURE";
    },
    (hardware) => {
      hardware.environment.audio_devices[0].model =
        "BTHENUM\\DEV_001122334455";
    },
  ];
  for (const mutate of mutations) {
    await withBundle(async (root) => {
      await mutateContractJson(root, "manifests/hw-ref.json", mutate);
      await expectCode(
        validateCandidateArtifactBundle(root),
        "ART_PRIVACY_UNSAFE_IDENTIFIER",
      );
    });
  }
});

test("sealed candidate validation still requires the HW collector artifact join", async () => {
  await withBundle(async (root) => {
    const contract = await readJson(root, "contract-manifest.json");
    const alternate = contract.entries.find(
      (entry) => entry.path === "assets/package.lock",
    );
    assert.ok(alternate);
    await mutateContractJson(root, "manifests/hw-ref.json", (hardware) => {
      hardware.collector.sha256 = alternate.sha256;
    });
    await resealContractEntry(root, "manifests/hw-ref.json");
    await expectCode(validateCandidateArtifactBundle(root), "ART_JOIN_MISMATCH");
  });
});

test("run-plan sequence, seed, cold/warm bounds, and duplicate IDs fail closed", async () => {
  await withBundle(async (root) => {
    await mutateContractJson(root, "manifests/run-plan.json", (runPlan) => {
      runPlan.steps[2].kind = "warm";
    });
    await expectCode(validateCandidateArtifactBundle(root), "ART_RUN_PLAN_ORDER");
  });
  await withBundle(async (root) => {
    await mutateContractJson(root, "manifests/run-plan.json", (runPlan) => {
      runPlan.seed = 42;
    });
    await expectCode(validateCandidateArtifactBundle(root), "ART_SCHEMA_U64");
  });
  await withBundle(async (root) => {
    await mutateContractJson(root, "manifests/run-plan.json", (runPlan) => {
      runPlan.sampling.cold_runs = "9";
    });
    await expectCode(validateCandidateArtifactBundle(root), "ART_SCHEMA_BOUND");
  });
  await withBundle(async (root) => {
    await mutateContractJson(root, "manifests/run-plan.json", (runPlan) => {
      runPlan.sampling.warm_samples_per_scenario = "29";
    });
    await expectCode(validateCandidateArtifactBundle(root), "ART_SCHEMA_BOUND");
  });
  await withBundle(async (root) => {
    await mutateContractJson(root, "manifests/run-plan.json", (runPlan) => {
      runPlan.candidate_ids = [
        "candidate-contract-fixture-001",
        "candidate-contract-fixture-001",
      ];
    });
    await expectCode(validateCandidateArtifactBundle(root), "ART_SCHEMA_DUPLICATE_ID");
  });
  await withBundle(async (root) => {
    await mutateContractJson(root, "manifests/run-plan.json", (runPlan) => {
      runPlan.same_condition_contract.translation_fixture_ids = ["fixture-not-in-registry"];
    });
    await expectCode(validateCandidateArtifactBundle(root), "ART_JOIN_MISMATCH");
  });
  await withBundle(async (root) => {
    await mutateContractJson(root, "manifests/run-plan.json", (runPlan) => {
      runPlan.same_condition_contract.log_level = 123;
    });
    await expectCode(validateCandidateArtifactBundle(root), "ART_SCHEMA_VALUE");
  });
  await withBundle(async (root) => {
    await mutateContractJson(root, "manifests/run-plan.json", (runPlan) => {
      runPlan.same_condition_contract.batch_size = "18446744073709551615";
      runPlan.same_condition_contract.thread_count = "18446744073709551615";
    });
    await expectCode(validateCandidateArtifactBundle(root), "ART_JOIN_MISMATCH");
  });
});

test("contract manifest rejects missing child digests even when its own seal is valid", async () => {
  await withBundle(async (root) => {
    const contract = await readJson(root, "contract-manifest.json");
    contract.entries[0].sha256 = "";
    await resealContractManifest(root, contract);
    await expectCode(validateCandidateArtifactBundle(root), "ART_DIGEST_MISSING");
  });
});

test("symbolic-link or junction ancestors are rejected before file hashing", async (context) => {
  await withBundle(async (root, temp) => {
    const assets = path.join(root, "assets");
    const outside = path.join(temp, "outside-assets");
    await rename(assets, outside);
    try {
      await symlink(outside, assets, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (error?.code === "EPERM" || error?.code === "EACCES") {
        context.skip("host does not permit a test symlink or junction");
        return;
      }
      throw error;
    }
    await expectCode(validateCandidateArtifactBundle(root), "ART_PATH_REPARSE_POINT");
  });
});

test("generation refuses a non-empty destination instead of deleting caller data", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "meetingrelay-wp04-nonempty-"));
  try {
    await mkdir(path.join(temp, "bundle"));
    await writeFile(path.join(temp, "bundle", "keep.txt"), "keep\n");
    await expectCode(
      generateCandidateArtifactBundle(path.join(temp, "bundle")),
      "ART_INVENTORY_MISMATCH",
    );
    assert.equal(await readFile(path.join(temp, "bundle", "keep.txt"), "utf8"), "keep\n");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
