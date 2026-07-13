import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  encodeCanonicalJson,
  encodeCanonicalJsonLine,
} from "../phase0-harness/canonical-json.mjs";
import {
  fixturePaths,
  validateFixtureTree,
} from "../phase0-harness/fixture-contract.mjs";
import { buildSherpaCandidateInputBundlePlan } from "./candidate-input-bundle-plan.mjs";
import {
  CandidateInputMaterializeError,
  materializeSherpaCandidateInputBundle,
} from "./candidate-input-materializer.mjs";
import { planSherpaCandidateInput } from "./candidate-input-plan.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../..");
const SOURCE_COMMIT = "122b1d930188fcc773d1086a0f7c4a5c63adb7e4";
const SOURCE_URL = `https://github.com/AsaZhou923/MeetingRelay/commit/${SOURCE_COMMIT}`;
const SOURCE_ROOT_NAMES = [
  "repository",
  "rust-target",
  "sherpa-model-extraction",
  "sherpa-runtime-extraction",
];
let basePlanPromise;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function runBuilder() {
  const result = spawnSync(
    process.platform === "win32" ? "cargo.exe" : "cargo",
    [
      "run",
      "--quiet",
      "--locked",
      "--offline",
      "-p",
      "meetingrelay-model-worker-sherpa-native",
      "--bin",
      "emit_sherpa_candidate_builder_input",
      "--no-default-features",
    ],
    {
      cwd: REPO_ROOT,
      encoding: null,
      env: { ...process.env, CARGO_TERM_COLOR: "never" },
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr?.toString("utf8"));
  assert.equal(result.stderr?.length ?? 0, 0);
  return Buffer.from(result.stdout);
}

async function buildRealPlan() {
  const [
    assetsLockBytes,
    cargoLockBytes,
    schemaRegistryBytes,
    meetingrelayNoticeBytes,
    sherpaApacheLicenseBytes,
    onnxruntimeMitLicenseBytes,
    funasrCurrentLicenseBytes,
    fixtureManifestBytes,
    validatedFixture,
  ] = await Promise.all([
    readFile(path.join(HERE, "assets.lock.json")),
    readFile(path.join(REPO_ROOT, "Cargo.lock")),
    readFile(path.join(HERE, "candidate-schema-registry.json")),
    readFile(path.join(HERE, "licenses", "meetingrelay-unlicensed-notice.txt")),
    readFile(path.join(HERE, "licenses", "apache-2.0-sherpa-onnx.txt")),
    readFile(path.join(HERE, "licenses", "mit-onnxruntime-1.27.0.txt")),
    readFile(path.join(HERE, "licenses", "funasr-model-license-1.1.txt")),
    readFile(path.join(fixturePaths.projectRoot, "manifest.json")),
    validateFixtureTree(),
  ]);
  const rustBuilderInputBytes = runBuilder();
  const builder = JSON.parse(rustBuilderInputBytes.toString("utf8"));
  const worker = {
    descriptor: builder.worker_manifest_descriptor_fragment,
    executable_sha256: "1".repeat(64),
    role: "native-candidate",
    schema_registry_sha256: sha256(schemaRegistryBytes),
    worker_build_sha256: "1".repeat(64),
    worker_id: "meetingrelay-sherpa-native-candidate-host-v1",
  };
  const candidatePlan = planSherpaCandidateInput({
    assetsLockBytes,
    cargoLockBytes,
    licenseBytes: {
      funasrCurrentLicenseBytes,
      meetingrelayNoticeBytes,
      onnxruntimeMitLicenseBytes,
      sherpaApacheLicenseBytes,
    },
    releaseWorkerProjectionBytes: Buffer.from(
      encodeCanonicalJsonLine(worker),
      "utf8",
    ),
    rustBuilderInputBytes,
    schemaRegistryBytes,
    sourceCommit: SOURCE_COMMIT,
    sourceUrl: SOURCE_URL,
    workerExecutableSizeBytes: "1234567",
  });
  const manifest = JSON.parse(fixtureManifestBytes.toString("utf8"));
  const fixtures = manifest.fixtures.map((fixture) => ({
    audioPath: fixture.audio.path,
    audioSha256: fixture.audio.sha256,
    fixtureId: fixture.fixture_id,
    pcmSha256: fixture.audio.pcm_sha256,
    referenceSha256: fixture.reference.sha256,
  }));
  return buildSherpaCandidateInputBundlePlan({
    candidatePlan,
    fixtureRegistryProjection: {
      ...fixtures[0],
      fixtures,
      manifestSha256: validatedFixture.manifestDigest,
    },
  });
}

function clonePlan(plan) {
  return {
    kind: plan.kind,
    materials: plan.materials.map((material) =>
      material.kind === "document"
        ? { ...material, bytes: Buffer.from(material.bytes) }
        : { ...material },
    ),
    proposedContractSha256: plan.proposedContractSha256,
    schema_version: plan.schema_version,
  };
}

function material(plan, targetPath) {
  const found = plan.materials.find((entry) => entry.target_path === targetPath);
  assert.ok(found, targetPath);
  return found;
}

function readPlanJson(plan, targetPath) {
  return JSON.parse(material(plan, targetPath).bytes.toString("utf8"));
}

function setPlanJson(plan, targetPath, value) {
  const entry = material(plan, targetPath);
  const bytes = Buffer.from(encodeCanonicalJson(value), "utf8");
  entry.bytes = bytes;
  entry.sha256 = sha256(bytes);
  entry.size_bytes = String(bytes.length);
}

function rebuildContract(plan) {
  const sealed = plan.materials.filter(
    (entry) =>
      entry.target_path !== "contract-manifest.json" &&
      entry.target_path !== "contract-manifest.sha256",
  );
  const contract = readPlanJson(plan, "contract-manifest.json");
  contract.entries = sealed.map((entry) => ({
    path: entry.target_path,
    sha256: entry.sha256,
    size_bytes: entry.size_bytes,
  }));
  setPlanJson(plan, "contract-manifest.json", contract);
  plan.proposedContractSha256 = material(
    plan,
    "contract-manifest.json",
  ).sha256;
  const seal = material(plan, "contract-manifest.sha256");
  seal.bytes = Buffer.from(
    `${plan.proposedContractSha256}  contract-manifest.json\n`,
    "ascii",
  );
  seal.sha256 = sha256(seal.bytes);
  seal.size_bytes = String(seal.bytes.length);
}

async function makeFixture() {
  const temp = await mkdtemp(
    path.join(os.tmpdir(), "meetingrelay-candidate-materializer-"),
  );
  const repositoryRoot = path.join(temp, "sources", "repository");
  const sourceRoots = {
    repository: repositoryRoot,
    "rust-target": path.join(repositoryRoot, "target"),
    "sherpa-model-extraction": path.join(repositoryRoot, "target", "model"),
    "sherpa-runtime-extraction": path.join(repositoryRoot, "target", "runtime"),
  };
  await Promise.all(
    Object.values(sourceRoots).map((root) => mkdir(root, { recursive: true })),
  );
  const plan = clonePlan(
    await (basePlanPromise ??= buildRealPlan()),
  );

  for (const entry of plan.materials.filter((value) => value.kind === "copy")) {
    const bytes = entry.target_path === "assets/candidate-schema-registry.json"
      ? await readFile(path.join(HERE, "candidate-schema-registry.json"))
      : Buffer.from(`fixture bytes for ${entry.target_path}\n`, "utf8");
    const target = path.join(
      sourceRoots[entry.source_root],
      ...entry.source_relative_path.split("/"),
    );
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes);
    entry.sha256 = sha256(bytes);
    entry.size_bytes = String(bytes.length);
  }

  const candidate = readPlanJson(plan, "manifests/candidate-manifest.json");
  const byRole = new Map(candidate.artifacts.map((entry) => [entry.role, entry]));
  for (const artifact of candidate.artifacts) {
    const entry = material(plan, artifact.path);
    artifact.sha256 = entry.sha256;
    artifact.size_bytes = entry.size_bytes;
  }
  for (const license of candidate.licenses) {
    const entry = material(plan, license.text_path);
    license.text_sha256 = entry.sha256;
    license.text_size_bytes = entry.size_bytes;
  }
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
  setPlanJson(plan, "manifests/candidate-manifest.json", candidate);

  const hardware = readPlanJson(plan, "manifests/hw-ref.json");
  hardware.collector.sha256 = byRole.get("schema-registry").sha256;
  setPlanJson(plan, "manifests/hw-ref.json", hardware);

  const runPlan = readPlanJson(plan, "manifests/run-plan.json");
  runPlan.harness.lockfile.sha256 = byRole.get("package-lock").sha256;
  runPlan.same_condition_contract.model_sha256 = byRole.get("model").sha256;
  runPlan.same_condition_contract.parameter_sha256 = byRole.get("parameters").sha256;
  setPlanJson(plan, "manifests/run-plan.json", runPlan);
  rebuildContract(plan);

  const publishParent = path.join(temp, "publish");
  await mkdir(publishParent);
  return {
    expectedContractSha256: plan.proposedContractSha256,
    outputRoot: path.join(publishParent, "candidate-input"),
    plan,
    publishParent,
    sourceRoots,
    temp,
  };
}

async function withFixture(run) {
  const fixture = await makeFixture();
  try {
    return await run(fixture);
  } finally {
    await rm(fixture.temp, { force: true, recursive: true });
  }
}

async function expectCode(promise, code) {
  await assert.rejects(
    promise,
    (error) =>
      (error instanceof CandidateInputMaterializeError ||
        typeof error?.code === "string") &&
      error.code === code,
    `expected ${code}`,
  );
}

async function assertNoOwnedTemporaryBundle(fixture) {
  const prefix = `.${path.basename(fixture.outputRoot)}.meetingrelay-tmp-`;
  assert.equal(
    (await readdir(fixture.publishParent)).some((name) => name.startsWith(prefix)),
    false,
  );
}

async function listFiles(root, directory = root) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(root, target)));
    } else {
      files.push(path.relative(root, target).split(path.sep).join("/"));
    }
  }
  return files.sort();
}

function resealHarnessOverclaim(plan) {
  const harness = readPlanJson(plan, "assets/input-only-harness-plan.json");
  harness.core.execution_status = "authorized";
  setPlanJson(plan, "assets/input-only-harness-plan.json", harness);
  const harnessSha256 = material(
    plan,
    "assets/input-only-harness-plan.json",
  ).sha256;
  const runPlan = readPlanJson(plan, "manifests/run-plan.json");
  runPlan.harness.core.sha256 = harnessSha256;
  runPlan.harness.ui.sha256 = harnessSha256;
  setPlanJson(plan, "manifests/run-plan.json", runPlan);
  rebuildContract(plan);
}

test(
  "materializes a real f3a1 plan and returns only input-validation authority",
  { skip: process.platform !== "win32" },
  async () => {
    await withFixture(async (fixture) => {
      const result = await materializeSherpaCandidateInputBundle(fixture);
      const candidate = readPlanJson(fixture.plan, "manifests/candidate-manifest.json");
      const contract = readPlanJson(fixture.plan, "contract-manifest.json");
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
      assert.equal(result.bundleRoot, path.resolve(fixture.outputRoot));
      assert.equal(result.candidateId, candidate.candidate_id);
      assert.equal(result.contractManifestSha256, fixture.expectedContractSha256);
      assert.equal(result.contractTestId, contract.contract_id);
      assert.equal(
        result.fixtureManifestSha256,
        readPlanJson(fixture.plan, "manifests/fixture-set-manifest.json").registry
          .sha256,
      );
      assert.equal(result.formalClaims, "none");
      assert.equal(result.productionEvidence, false);
      assert.equal(result.status, "input-valid");
      assert.equal(result.validationPhase, "input-only");
      assert.deepEqual(
        await listFiles(fixture.outputRoot),
        fixture.plan.materials.map((entry) => entry.target_path),
      );
    });
  },
);

test(
  "requires an independently supplied contract digest before writing",
  { skip: process.platform !== "win32" },
  async () => {
    await withFixture(async (fixture) => {
      await expectCode(
        materializeSherpaCandidateInputBundle({
          ...fixture,
          expectedContractSha256: undefined,
        }),
        "BUNDLE_MATERIALIZE_TRUST_REQUIRED",
      );
      assert.deepEqual(await readdir(fixture.publishParent), []);
    });
  },
);

test(
  "rejects a mismatched external digest before inspecting source roots",
  { skip: process.platform !== "win32" },
  async () => {
    await withFixture(async (fixture) => {
      const mismatch = fixture.expectedContractSha256 === "f".repeat(64)
        ? "e".repeat(64)
        : "f".repeat(64);
      await expectCode(
        materializeSherpaCandidateInputBundle({
          ...fixture,
          expectedContractSha256: mismatch,
          sourceRoots: {
            ...fixture.sourceRoots,
            repository: path.join(fixture.temp, "missing-source-root"),
          },
        }),
        "BUNDLE_MATERIALIZE_TRUST_MISMATCH",
      );
      assert.deepEqual(await readdir(fixture.publishParent), []);
    });
  },
);

test(
  "rejects a high-bit ASCII seal alias before filesystem access",
  { skip: process.platform !== "win32" },
  async () => {
    await withFixture(async (fixture) => {
      const seal = material(fixture.plan, "contract-manifest.sha256");
      seal.bytes[0] |= 0x80;
      seal.sha256 = sha256(seal.bytes);
      await expectCode(
        materializeSherpaCandidateInputBundle(fixture),
        "BUNDLE_MATERIALIZE_PLAN",
      );
      assert.deepEqual(await readdir(fixture.publishParent), []);
    });
  },
);

test(
  "rejects fully resealed candidate source drift before filesystem access",
  { skip: process.platform !== "win32" },
  async () => {
    await withFixture(async (fixture) => {
      const candidate = readPlanJson(
        fixture.plan,
        "manifests/candidate-manifest.json",
      );
      candidate.source.source_url =
        `https://github.com/example/MeetingRelay/commit/${candidate.source.source_revision}`;
      setPlanJson(
        fixture.plan,
        "manifests/candidate-manifest.json",
        candidate,
      );
      rebuildContract(fixture.plan);
      fixture.expectedContractSha256 = fixture.plan.proposedContractSha256;
      await expectCode(
        materializeSherpaCandidateInputBundle(fixture),
        "BUNDLE_MATERIALIZE_PLAN",
      );
      assert.deepEqual(await readdir(fixture.publishParent), []);
    });

    await withFixture(async (fixture) => {
      const candidate = readPlanJson(
        fixture.plan,
        "manifests/candidate-manifest.json",
      );
      candidate.source.source_revision = "0".repeat(40);
      candidate.source.source_url =
        `https://github.com/AsaZhou923/MeetingRelay/commit/${"0".repeat(40)}`;
      setPlanJson(
        fixture.plan,
        "manifests/candidate-manifest.json",
        candidate,
      );
      const runPlan = readPlanJson(fixture.plan, "manifests/run-plan.json");
      runPlan.source_commit = "0".repeat(40);
      setPlanJson(fixture.plan, "manifests/run-plan.json", runPlan);
      rebuildContract(fixture.plan);
      fixture.expectedContractSha256 = fixture.plan.proposedContractSha256;
      await expectCode(
        materializeSherpaCandidateInputBundle(fixture),
        "BUNDLE_MATERIALIZE_PLAN",
      );
      assert.deepEqual(await readdir(fixture.publishParent), []);
    });
  },
);

test(
  "rejects rooted-without-drive output and source paths before filesystem access",
  { skip: process.platform !== "win32" },
  async () => {
    await withFixture(async (fixture) => {
      const rootedWithoutDrive = `${path.sep}meetingrelay-rooted-without-drive`;
      await expectCode(
        materializeSherpaCandidateInputBundle({
          ...fixture,
          outputRoot: rootedWithoutDrive,
        }),
        "BUNDLE_MATERIALIZE_PATH",
      );
      await expectCode(
        materializeSherpaCandidateInputBundle({
          ...fixture,
          sourceRoots: {
            ...fixture.sourceRoots,
            repository: rootedWithoutDrive,
          },
        }),
        "BUNDLE_MATERIALIZE_PATH",
      );
      assert.deepEqual(await readdir(fixture.publishParent), []);
    });
  },
);

test(
  "rejects an output equal to, above, or below a source root before writing",
  { skip: process.platform !== "win32" },
  async () => {
    await withFixture(async (fixture) => {
      await mkdir(path.join(fixture.sourceRoots.repository, "..output"));
      for (const outputRoot of [
        fixture.sourceRoots.repository,
        path.dirname(fixture.sourceRoots.repository),
        path.join(fixture.sourceRoots.repository, "output"),
        path.join(fixture.sourceRoots.repository, "..output", "bundle"),
      ]) {
        await expectCode(
          materializeSherpaCandidateInputBundle({ ...fixture, outputRoot }),
          "BUNDLE_MATERIALIZE_PATH_OVERLAP",
        );
      }
      await assertNoOwnedTemporaryBundle(fixture);
    });
  },
);

test(
  "refuses to replace an existing output and preserves caller data",
  { skip: process.platform !== "win32" },
  async () => {
    await withFixture(async (fixture) => {
      await mkdir(fixture.outputRoot);
      const keep = path.join(fixture.outputRoot, "keep.txt");
      await writeFile(keep, "keep\n", "utf8");
      await expectCode(
        materializeSherpaCandidateInputBundle(fixture),
        "BUNDLE_MATERIALIZE_OUTPUT_EXISTS",
      );
      assert.equal(await readFile(keep, "utf8"), "keep\n");
      await assertNoOwnedTemporaryBundle(fixture);
    });
  },
);

test(
  "rejects changed source size and removes its owned temporary bundle",
  { skip: process.platform !== "win32" },
  async () => {
    await withFixture(async (fixture) => {
      const cargo = fixture.plan.materials.find(
        (entry) => entry.kind === "copy" && entry.target_path === "assets/Cargo.lock",
      );
      assert.ok(cargo);
      const source = path.join(
        fixture.sourceRoots[cargo.source_root],
        ...cargo.source_relative_path.split("/"),
      );
      await writeFile(source, Buffer.concat([await readFile(source), Buffer.from("x")]));
      await expectCode(
        materializeSherpaCandidateInputBundle(fixture),
        "BUNDLE_MATERIALIZE_SIZE",
      );
      assert.deepEqual(await readdir(fixture.publishParent), []);
    });
  },
);

test(
  "rejects same-size source tampering and removes its owned temporary bundle",
  { skip: process.platform !== "win32" },
  async () => {
    await withFixture(async (fixture) => {
      const cargo = fixture.plan.materials.find(
        (entry) => entry.kind === "copy" && entry.target_path === "assets/Cargo.lock",
      );
      assert.ok(cargo);
      const source = path.join(
        fixture.sourceRoots[cargo.source_root],
        ...cargo.source_relative_path.split("/"),
      );
      const bytes = await readFile(source);
      bytes[0] ^= 0xff;
      await writeFile(source, bytes);
      await expectCode(
        materializeSherpaCandidateInputBundle(fixture),
        "BUNDLE_MATERIALIZE_DIGEST",
      );
      assert.equal(await readFile(source).then((value) => value.length), bytes.length);
      assert.deepEqual(await readdir(fixture.publishParent), []);
    });
  },
);

test(
  "rejects a fully resealed harness overclaim and removes its owned temporary bundle",
  { skip: process.platform !== "win32" },
  async () => {
    await withFixture(async (fixture) => {
      resealHarnessOverclaim(fixture.plan);
      fixture.expectedContractSha256 = fixture.plan.proposedContractSha256;
      await expectCode(
        materializeSherpaCandidateInputBundle(fixture),
        "BUNDLE_MATERIALIZE_HARNESS",
      );
      assert.deepEqual(await readdir(fixture.publishParent), []);
    });
  },
);

test(
  "rejects a Windows junction used as a named source root",
  { skip: process.platform !== "win32" },
  async (context) => {
    await withFixture(async (fixture) => {
      const junction = path.join(fixture.temp, "repository-junction");
      try {
        await symlink(fixture.sourceRoots.repository, junction, "junction");
      } catch (error) {
        if (["EPERM", "EACCES", "UNKNOWN"].includes(error?.code)) {
          context.skip("host does not permit a test junction");
          return;
        }
        throw error;
      }
      await expectCode(
        materializeSherpaCandidateInputBundle({
          ...fixture,
          sourceRoots: { ...fixture.sourceRoots, repository: junction },
        }),
        "BUNDLE_MATERIALIZE_SOURCE_REPARSE",
      );
      assert.deepEqual(await readdir(fixture.publishParent), []);
    });
  },
);
