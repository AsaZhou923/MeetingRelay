import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  lstat,
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
  __assertUsableIdentityForTest,
  __materializeSherpaCandidateInputBundleForTest,
  materializeSherpaCandidateInputBundle,
} from "./candidate-input-materializer.mjs";
import { planSherpaCandidateInput } from "./candidate-input-plan.mjs";
import {
  __publishWindowsDirectoryNoReplaceForTest,
  __WINDOWS_DIRECTORY_PUBLISH_PROTOCOL_FOR_TEST,
  WindowsDirectoryPublishError,
} from "./windows-directory-publisher.mjs";

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

async function captureCode(promise, code) {
  try {
    await promise;
  } catch (error) {
    assert.equal(error?.code, code);
    return error;
  }
  assert.fail(`expected ${code}`);
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

test(
  "native publish never replaces a competitor injected after the absence preflight",
  { skip: process.platform !== "win32", timeout: 60_000 },
  async (context) => {
    const competitors = [
      {
        name: "regular file",
        create: async (fixture) => {
          await writeFile(fixture.outputRoot, "attacker-file\n", "utf8");
        },
        verify: async (fixture) => {
          assert.equal(await readFile(fixture.outputRoot, "utf8"), "attacker-file\n");
        },
      },
      {
        name: "valid file symlink",
        optional: true,
        create: async (fixture) => {
          const target = path.join(fixture.temp, "valid-link-target.txt");
          await writeFile(target, "valid-link-target\n", "utf8");
          await symlink(target, fixture.outputRoot, "file");
        },
        verify: async (fixture) => {
          assert.equal(await readFile(fixture.outputRoot, "utf8"), "valid-link-target\n");
        },
      },
      {
        name: "dangling file symlink",
        optional: true,
        create: async (fixture) => {
          await symlink(
            path.join(fixture.temp, "missing-link-target.txt"),
            fixture.outputRoot,
            "file",
          );
        },
      },
      {
        name: "junction",
        create: async (fixture) => {
          const target = path.join(fixture.temp, "junction-target");
          await mkdir(target);
          await writeFile(path.join(target, "sentinel.txt"), "junction\n", "utf8");
          await symlink(target, fixture.outputRoot, "junction");
        },
        verify: async (fixture) => {
          assert.equal(
            await readFile(path.join(fixture.outputRoot, "sentinel.txt"), "utf8"),
            "junction\n",
          );
        },
      },
      {
        name: "directory symlink",
        optional: true,
        create: async (fixture) => {
          const target = path.join(fixture.temp, "directory-link-target");
          await mkdir(target);
          await writeFile(path.join(target, "sentinel.txt"), "directory-link\n", "utf8");
          await symlink(target, fixture.outputRoot, "dir");
        },
        verify: async (fixture) => {
          assert.equal(
            await readFile(path.join(fixture.outputRoot, "sentinel.txt"), "utf8"),
            "directory-link\n",
          );
        },
      },
      {
        name: "empty directory",
        create: async (fixture) => mkdir(fixture.outputRoot),
      },
      {
        name: "nonempty directory",
        create: async (fixture) => {
          await mkdir(fixture.outputRoot);
          await writeFile(
            path.join(fixture.outputRoot, "sentinel.txt"),
            "nonempty\n",
            "utf8",
          );
        },
        verify: async (fixture) => {
          assert.equal(
            await readFile(path.join(fixture.outputRoot, "sentinel.txt"), "utf8"),
            "nonempty\n",
          );
        },
      },
    ];

    const exercisedMandatory = new Set();
    for (const competitor of competitors) {
      await context.test(competitor.name, async (subtest) => {
        await withFixture(async (fixture) => {
          let before;
          let beforeLink = null;
          let capabilityUnavailable = false;
          let injected = false;
          const operation = __materializeSherpaCandidateInputBundleForTest(
            fixture,
            {
              hooks: {
                beforePublishRevalidation: async () => {
                  try {
                    await competitor.create(fixture);
                  } catch (error) {
                    if (
                      competitor.optional &&
                      error?.syscall === "symlink" &&
                      ["EACCES", "EPERM", "UNKNOWN"].includes(error?.code)
                    ) {
                      capabilityUnavailable = true;
                      return;
                    }
                    throw error;
                  }
                  injected = true;
                  before = await lstat(fixture.outputRoot, { bigint: true });
                  if (before.isSymbolicLink()) {
                    beforeLink = await readlink(fixture.outputRoot);
                  }
                },
              },
            },
          );
          let operationError = null;
          try {
            await operation;
          } catch (error) {
            operationError = error;
          }
          if (capabilityUnavailable) {
            assert.equal(operationError, null, competitor.name);
            subtest.skip("host cannot create this optional symbolic link");
            return;
          }
          assert.equal(injected, true, competitor.name);
          assert.equal(
            operationError?.code,
            "BUNDLE_MATERIALIZE_OUTPUT_EXISTS",
            competitor.name,
          );
          const after = await lstat(fixture.outputRoot, { bigint: true });
          assert.equal(after.dev, before.dev, competitor.name);
          assert.equal(after.ino, before.ino, competitor.name);
          if (beforeLink !== null) {
            assert.equal(
              await readlink(fixture.outputRoot),
              beforeLink,
              competitor.name,
            );
          }
          await competitor.verify?.(fixture);
          await assertNoOwnedTemporaryBundle(fixture);
          if (!competitor.optional) {
            exercisedMandatory.add(competitor.name);
          }
        });
      });
    }
    assert.deepEqual(
      [...exercisedMandatory].sort(),
      ["empty directory", "junction", "nonempty directory", "regular file"],
    );
  },
);

test(
  "source identity swaps before open and after read fail closed",
  { skip: process.platform !== "win32", timeout: 30_000 },
  async () => {
    for (const checkpoint of ["beforeSourceOpen", "beforeSourcePostcheck"]) {
      await withFixture(async (fixture) => {
        const selected = fixture.plan.materials.find(
          (entry) => entry.kind === "copy" && entry.target_path === "assets/Cargo.lock",
        );
        assert.ok(selected);
        let swapped = false;
        const hooks = {
          [checkpoint]: async ({ material: current, sourcePath }) => {
            if (swapped || current.target_path !== selected.target_path) return;
            const bytes = await readFile(sourcePath);
            await rename(sourcePath, `${sourcePath}.original`);
            await writeFile(sourcePath, bytes);
            swapped = true;
          },
        };
        await expectCode(
          __materializeSherpaCandidateInputBundleForTest(fixture, { hooks }),
          "BUNDLE_MATERIALIZE_SOURCE_IDENTITY",
        );
        assert.equal(swapped, true, checkpoint);
        await assertNoOwnedTemporaryBundle(fixture);
      });
    }
  },
);

test(
  "parent and temporary bundle identity swaps fail closed",
  { skip: process.platform !== "win32", timeout: 30_000 },
  async () => {
    await withFixture(async (fixture) => {
      let replacementParent;
      const error = await captureCode(
        __materializeSherpaCandidateInputBundleForTest(fixture, {
          hooks: {
            beforePublishRevalidation: async ({ parent }) => {
              replacementParent = parent;
              await rename(parent, `${parent}.displaced`);
              await mkdir(parent);
              await writeFile(path.join(parent, "attacker.txt"), "parent\n", "utf8");
            },
          },
        }),
        "BUNDLE_MATERIALIZE_OUTPUT",
      );
      assert.equal(error.cleanupCompleted, false);
      assert.match(error.cleanupReason, /disappeared|safely removed|identity changed/u);
      assert.equal(
        await readFile(path.join(replacementParent, "attacker.txt"), "utf8"),
        "parent\n",
      );
    });

    await withFixture(async (fixture) => {
      let replacementTemp;
      const error = await captureCode(
        __materializeSherpaCandidateInputBundleForTest(fixture, {
          hooks: {
            beforePublishRevalidation: async ({ tempRoot }) => {
              replacementTemp = tempRoot;
              await rename(tempRoot, `${tempRoot}.displaced`);
              await mkdir(tempRoot);
              await writeFile(path.join(tempRoot, "attacker.txt"), "temp\n", "utf8");
            },
          },
        }),
        "BUNDLE_MATERIALIZE_TEMP_IDENTITY",
      );
      assert.equal(error.cleanupCompleted, false);
      assert.match(error.cleanupReason, /identity changed/u);
      assert.equal(
        await readFile(path.join(replacementTemp, "attacker.txt"), "utf8"),
        "temp\n",
      );
    });
  },
);

test(
  "nested target-parent replacement fails closed without deleting either tree",
  { skip: process.platform !== "win32", timeout: 30_000 },
  async () => {
    await withFixture(async (fixture) => {
      let assetsDirectory;
      const error = await captureCode(
        __materializeSherpaCandidateInputBundleForTest(fixture, {
          hooks: {
            afterInputValidation: async ({ tempRoot }) => {
              assetsDirectory = path.join(tempRoot, "assets");
              await rename(assetsDirectory, `${assetsDirectory}.displaced`);
              await mkdir(assetsDirectory);
              await writeFile(
                path.join(assetsDirectory, "attacker.txt"),
                "nested-parent\n",
                "utf8",
              );
            },
          },
        }),
        "BUNDLE_MATERIALIZE_TEMP_IDENTITY",
      );
      assert.equal(error.cleanupCompleted, false);
      assert.equal(
        await readFile(path.join(assetsDirectory, "attacker.txt"), "utf8"),
        "nested-parent\n",
      );
      assert.equal(
        (await lstat(`${assetsDirectory}.displaced`)).isDirectory(),
        true,
      );
      await assert.rejects(lstat(fixture.outputRoot), { code: "ENOENT" });
    });
  },
);

test(
  "post-validation and post-move tampering cannot return input-valid",
  { skip: process.platform !== "win32", timeout: 30_000 },
  async () => {
    await withFixture(async (fixture) => {
      let publishCalled = false;
      let caught = null;
      try {
        await __materializeSherpaCandidateInputBundleForTest(fixture, {
          hooks: {
            afterInputValidation: async ({ tempRoot }) => {
              const sealPath = path.join(tempRoot, "contract-manifest.sha256");
              const bytes = await readFile(sealPath);
              bytes[0] = bytes[0] === 0x30 ? 0x31 : 0x30;
              await writeFile(sealPath, bytes);
            },
          },
          publishDirectory: async () => {
            publishCalled = true;
          },
        });
      } catch (error) {
        caught = error;
      }
      assert.ok(caught instanceof Error);
      assert.equal(publishCalled, false);
      await assert.rejects(lstat(fixture.outputRoot), { code: "ENOENT" });
      await assertNoOwnedTemporaryBundle(fixture);
    });

    await withFixture(async (fixture) => {
      let tampered = false;
      let caught = null;
      try {
        await __materializeSherpaCandidateInputBundleForTest(fixture, {
          hooks: {
            afterNativePublishBeforeValidation: async ({ output }) => {
              const sealPath = path.join(output, "contract-manifest.sha256");
              const bytes = await readFile(sealPath);
              bytes[0] = bytes[0] === 0x30 ? 0x31 : 0x30;
              await writeFile(sealPath, bytes);
              tampered = true;
            },
          },
        });
      } catch (error) {
        caught = error;
      }
      assert.ok(caught instanceof Error);
      assert.equal(tampered, true);
      assert.equal((await lstat(fixture.outputRoot)).isDirectory(), true);
      await assertNoOwnedTemporaryBundle(fixture);
    });
  },
);

test(
  "cleanup identity swaps before either check never remove attacker trees",
  { skip: process.platform !== "win32", timeout: 30_000 },
  async () => {
    for (const checkpoint of ["beforeCleanup", "beforeCleanupRemove"]) {
      await withFixture(async (fixture) => {
        let replacementTemp;
        const error = await captureCode(
          __materializeSherpaCandidateInputBundleForTest(fixture, {
            hooks: {
              [checkpoint]: async ({ tempRoot }) => {
                replacementTemp = tempRoot;
                await rename(tempRoot, `${tempRoot}.displaced`);
                await mkdir(tempRoot);
                await writeFile(
                  path.join(tempRoot, "attacker.txt"),
                  `${checkpoint}\n`,
                  "utf8",
                );
              },
            },
            publishDirectory: async () => {
              throw new Error("deterministic publish failure");
            },
          }),
          "BUNDLE_MATERIALIZE_PUBLISH",
        );
        assert.equal(error.cleanupCompleted, false);
        assert.match(
          error.cleanupReason,
          /identity changed|safely inspected/u,
        );
        assert.equal(
          await readFile(path.join(replacementTemp, "attacker.txt"), "utf8"),
          `${checkpoint}\n`,
        );
        assert.equal(
          (await lstat(`${replacementTemp}.displaced`)).isDirectory(),
          true,
        );
      });
    }
  },
);

test(
  "ambiguous publisher states never return success or delete uncertain output",
  { skip: process.platform !== "win32", timeout: 30_000 },
  async () => {
    await withFixture(async (fixture) => {
      await captureCode(
        __materializeSherpaCandidateInputBundleForTest(fixture, {
          publishDirectory: async () => {
            throw new Error("failed before move");
          },
        }),
        "BUNDLE_MATERIALIZE_PUBLISH",
      );
      await assert.rejects(lstat(fixture.outputRoot), { code: "ENOENT" });
      await assertNoOwnedTemporaryBundle(fixture);
    });

    await withFixture(async (fixture) => {
      await captureCode(
        __materializeSherpaCandidateInputBundleForTest(fixture, {
          publishDirectory: async ({
            destinationDirectory,
            sourceDirectory,
          }) => {
            await rename(sourceDirectory, destinationDirectory);
            throw new Error("move completed before protocol failure");
          },
        }),
        "BUNDLE_MATERIALIZE_PUBLISH",
      );
      assert.equal((await lstat(fixture.outputRoot)).isDirectory(), true);
      await assertNoOwnedTemporaryBundle(fixture);
    });

    await withFixture(async (fixture) => {
      await captureCode(
        __materializeSherpaCandidateInputBundleForTest(fixture, {
          publishDirectory: async () => {},
        }),
        "BUNDLE_MATERIALIZE_PUBLISH_VERIFY",
      );
      await assert.rejects(lstat(fixture.outputRoot), { code: "ENOENT" });
      const prefix = `.${path.basename(fixture.outputRoot)}.meetingrelay-tmp-`;
      assert.equal(
        (await readdir(fixture.publishParent)).filter((entry) =>
          entry.startsWith(prefix)
        ).length,
        1,
      );
    });
  },
);

test("zero, missing, and non-bigint identities fail closed", () => {
  assert.doesNotThrow(() =>
    __assertUsableIdentityForTest({ dev: 1n, ino: 1n }),
  );
  for (const stat of [
    {},
    { dev: 0n, ino: 1n },
    { dev: 1n, ino: 0n },
    { dev: 1, ino: 1n },
    { dev: 1n, ino: 1 },
  ]) {
    assert.throws(
      () => __assertUsableIdentityForTest(stat),
      (error) =>
        error instanceof CandidateInputMaterializeError &&
        error.code === "BUNDLE_MATERIALIZE_IDENTITY_UNAVAILABLE",
    );
  }
});

test(
  "PowerShell publisher uses a static encoded protocol and ignores PATH",
  { skip: process.platform !== "win32" },
  async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "meetingrelay-publisher-"));
    try {
      const sourceDirectory = path.join(temp, "source");
      const destinationDirectory = path.join(temp, "destination");
      await mkdir(sourceDirectory);
      let invocation;
      const protocol = __WINDOWS_DIRECTORY_PUBLISH_PROTOCOL_FOR_TEST;
      await __publishWindowsDirectoryNoReplaceForTest(
        { destinationDirectory, sourceDirectory },
        {
          environment: {
            PATH: path.join(temp, "attacker-path"),
            SystemRoot: process.env.SystemRoot,
          },
          execFileImpl: (executable, args, options, callback) => {
            invocation = { args, executable, options };
            callback(null, Buffer.from(protocol.successToken, "ascii"), Buffer.alloc(0));
          },
          platform: "win32",
        },
      );
      assert.equal(
        invocation.executable.toLowerCase(),
        path.join(process.env.SystemRoot, protocol.powershellRelativePath).toLowerCase(),
      );
      assert.equal(invocation.options.shell, false);
      assert.equal("PATH" in invocation.options.env, false);
      assert.deepEqual(Object.keys(invocation.options.env).sort(), [
        protocol.destinationEnvironmentName,
        protocol.sourceEnvironmentName,
        "SystemRoot",
        "WINDIR",
      ].sort());
      assert.equal(
        invocation.options.env[protocol.sourceEnvironmentName],
        sourceDirectory,
      );
      assert.equal(
        invocation.options.env[protocol.destinationEnvironmentName],
        destinationDirectory,
      );
      assert.equal(invocation.options.env.SystemRoot, process.env.SystemRoot);
      assert.equal(invocation.options.env.WINDIR, process.env.SystemRoot);
      assert.deepEqual(invocation.args, [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        protocol.encodedCommand,
      ]);
      assert.equal(invocation.options.encoding, null);
      assert.equal(invocation.options.maxBuffer, 64 * 1024);
      assert.equal(invocation.options.timeout, 30_000);
      assert.equal(invocation.options.windowsHide, true);
      const script = Buffer.from(protocol.encodedCommand, "base64").toString("utf16le");
      assert.equal(
        script,
        [
          "$ErrorActionPreference='Stop'",
          "if($PSVersionTable.PSEdition -ne 'Desktop' -or $PSVersionTable.PSVersion.Major -ne 5 -or -not [Environment]::Is64BitProcess){throw 'unsupported controlled publisher runtime'}",
          `$source=[Environment]::GetEnvironmentVariable('${protocol.sourceEnvironmentName}','Process')`,
          `$destination=[Environment]::GetEnvironmentVariable('${protocol.destinationEnvironmentName}','Process')`,
          "if([String]::IsNullOrEmpty($source)-or[String]::IsNullOrEmpty($destination)){throw 'missing controlled directory-move input'}",
          "[System.IO.Directory]::Move($source,$destination)",
          `[Console]::Out.Write('${protocol.successToken}')`,
        ].join(";"),
      );
      assert.equal(script.includes(sourceDirectory), false);
      assert.equal(script.includes(destinationDirectory), false);
      assert.equal((script.match(/\[System\.IO\.Directory\]::Move/gu) ?? []).length, 1);

      const failures = [
        {
          code: "WINDOWS_DIRECTORY_PUBLISH_NATIVE",
          invoke: (callback) => callback(new Error("spawn failed")),
          label: "exec error",
        },
        {
          code: "WINDOWS_DIRECTORY_PUBLISH_PROTOCOL",
          invoke: (callback) =>
            callback(
              null,
              Buffer.from(protocol.successToken, "ascii"),
              Buffer.from("unexpected stderr", "ascii"),
            ),
          label: "stderr",
        },
        ...["", "wrong-token", `${protocol.successToken}extra`].map(
          (stdout) => ({
            code: "WINDOWS_DIRECTORY_PUBLISH_PROTOCOL",
            invoke: (callback) =>
              callback(null, Buffer.from(stdout, "ascii"), Buffer.alloc(0)),
            label: `stdout ${JSON.stringify(stdout)}`,
          }),
        ),
      ];
      for (const failure of failures) {
        await assert.rejects(
          __publishWindowsDirectoryNoReplaceForTest(
            { destinationDirectory, sourceDirectory },
            {
              environment: { SystemRoot: process.env.SystemRoot },
              execFileImpl: (_executable, _args, _options, callback) => {
                failure.invoke(callback);
              },
              platform: "win32",
            },
          ),
          (error) =>
            error instanceof WindowsDirectoryPublishError &&
            error.code === failure.code &&
            !error.message.includes(sourceDirectory) &&
            !error.message.includes(destinationDirectory),
          failure.label,
        );
      }
    } finally {
      await rm(temp, { force: true, recursive: true });
    }
  },
);
