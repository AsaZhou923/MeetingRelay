import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  lstat,
  readFile,
  rename,
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
import {
  buildMeasuredHardwareReference,
  HW_REF_COLLECTOR_VERSION,
  WINDOWS_COLLECTOR_ASSET_PATH,
} from "../phase0-harness/hw-ref-collector.mjs";
import {
  __materializeMeasuredCloseoutForTest,
  __proposeMeasuredCloseoutForTest,
  materializeMeasuredSherpaCandidateInputCloseout,
  measuredCloseoutPaths,
  MeasuredCandidateCloseoutError,
  proposeMeasuredSherpaCandidateInputCloseout,
} from "./candidate-input-measured-closeout.mjs";
import { planSherpaCandidateInput } from "./candidate-input-plan.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROPOSED_CONTRACT_SHA256 = "b".repeat(64);
const ALTERNATE_CONTRACT_SHA256 = "c".repeat(64);
const CANDIDATE_PLAN = Object.freeze({ candidate_id: "synthetic-candidate" });
const FIXTURE_REGISTRY = Object.freeze({ fixture_id: "synthetic-fixture" });
const SOURCE_COMMIT = "95e91317142b1475f6d79eec13851ab95f9f70ff";
const SOURCE_URL =
  `https://github.com/AsaZhou923/MeetingRelay/commit/${SOURCE_COMMIT}`;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function runCandidateBuilder() {
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
      cwd: measuredCloseoutPaths.repositoryRoot,
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

async function productionProposalInput(hardwarePath) {
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
    readFile(path.join(measuredCloseoutPaths.repositoryRoot, "Cargo.lock")),
    readFile(path.join(HERE, "candidate-schema-registry.json")),
    readFile(path.join(HERE, "licenses", "meetingrelay-unlicensed-notice.txt")),
    readFile(path.join(HERE, "licenses", "apache-2.0-sherpa-onnx.txt")),
    readFile(path.join(HERE, "licenses", "mit-onnxruntime-1.27.0.txt")),
    readFile(path.join(HERE, "licenses", "funasr-model-license-1.1.txt")),
    readFile(path.join(fixturePaths.projectRoot, "manifest.json")),
    validateFixtureTree(),
  ]);
  const rustBuilderInputBytes = runCandidateBuilder();
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
  const fixtureManifest = JSON.parse(fixtureManifestBytes.toString("utf8"));
  const fixtures = fixtureManifest.fixtures.map((fixture) => ({
    audioPath: fixture.audio.path,
    audioSha256: fixture.audio.sha256,
    fixtureId: fixture.fixture_id,
    pcmSha256: fixture.audio.pcm_sha256,
    referenceSha256: fixture.reference.sha256,
  }));
  return {
    candidatePlan,
    fixtureRegistryProjection: {
      ...fixtures[0],
      fixtures,
      manifestSha256: validatedFixture.manifestDigest,
    },
    measuredHardwareReferencePath: hardwarePath,
  };
}

function syntheticRawFacts() {
  return {
    audio_devices: [
      {
        driver_version: "10.0.26100.1",
        logical_role: "synthetic-test-audio-path",
        model: "Synthetic Test Audio",
        signature_status: "signed",
        vendor: "SyntheticTestVendor",
      },
    ],
    background_process_allowlist: [],
    bios: {
      release_date: "2026-01-01",
      vendor: "SyntheticTestVendor",
      version: "1.0.0-test",
    },
    cooling: { ambient_celsius: "23.5", mode: "synthetic-test-active" },
    cpu: {
      logical_processor_count: "16",
      model: "Synthetic Test CPU",
      physical_core_count: "8",
      vendor: "SyntheticTestVendor",
    },
    gpus: [
      {
        driver_version: "32.0.15.7283",
        execution_providers: [],
        model: "Synthetic Test GPU",
        vendor: "SyntheticTestVendor",
        vram_bytes: "8589934592",
      },
    ],
    memory: { total_bytes: "34359738368" },
    operating_system: {
      architecture: "x64",
      build: "26100",
      product: "Windows 11 Pro Synthetic Test",
      ubr: "4652",
      version: "24H2-test",
    },
    power: { plan: `balanced@${"a".repeat(64)}`, source: "ac" },
    storage: [
      {
        capacity_bytes: "1000202273280",
        driver_version: "10.0.26100.1",
        filesystem: "NTFS",
        medium: "ssd",
        model: "Synthetic Test Storage",
        vendor: "SyntheticTestVendor",
      },
    ],
  };
}

function measuredPlan(digest = PROPOSED_CONTRACT_SHA256) {
  return {
    materials: Array.from({ length: 29 }, (_, index) => ({
      kind: index < 18 ? "copy" : "document",
      target_path: `synthetic/material-${String(index).padStart(2, "0")}`,
    })),
    proposedContractSha256: digest,
    schema_version: "1.1",
  };
}

function proposalInput(hardwarePath) {
  return {
    candidatePlan: CANDIDATE_PLAN,
    fixtureRegistryProjection: FIXTURE_REGISTRY,
    measuredHardwareReferencePath: hardwarePath,
  };
}

function materializeInput(hardwarePath, expectedContractSha256) {
  return {
    candidatePlan: CANDIDATE_PLAN,
    expectedContractSha256,
    fixtureRegistryProjection: FIXTURE_REGISTRY,
    measuredHardwareReferencePath: hardwarePath,
    outputRoot: path.join(path.dirname(hardwarePath), "candidate-input-bundle"),
    sourceRoots: { repository: measuredCloseoutPaths.repositoryRoot },
  };
}

function isStrictDescendant(root, value) {
  const relative = path.relative(root, value);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

async function createFixture({ collectorSha256 } = {}) {
  await mkdir(measuredCloseoutPaths.targetRoot, { recursive: true });
  const root = await mkdtemp(
    path.join(measuredCloseoutPaths.targetRoot, "measured-closeout-test-"),
  );
  const collectorBytes = await readFile(measuredCloseoutPaths.collectorSourcePath);
  const actualCollectorSha256 = sha256(collectorBytes);
  const hardware = buildMeasuredHardwareReference({
    capturedAt: "2026-07-13T01:02:03.456Z",
    collector: {
      path: WINDOWS_COLLECTOR_ASSET_PATH,
      sha256: collectorSha256 ?? actualCollectorSha256,
      version: HW_REF_COLLECTOR_VERSION,
    },
    hwRefId: "hw-ref-synthetic-closeout-test-001",
    rawFacts: syntheticRawFacts(),
  });
  const hardwareBytes = Buffer.from(encodeCanonicalJson(hardware), "utf8");
  const hardwarePath = path.join(root, "hw-ref.json");
  await writeFile(hardwarePath, hardwareBytes, { flag: "wx" });
  return {
    actualCollectorSha256,
    collectorBytes,
    hardware,
    hardwareBytes,
    hardwarePath,
    root,
  };
}

async function removeFixture(root) {
  assert.equal(isStrictDescendant(measuredCloseoutPaths.targetRoot, root), true);
  await rm(root, { force: true, recursive: true });
}

async function withFixture(run, options) {
  const fixture = await createFixture(options);
  try {
    return await run(fixture);
  } finally {
    await removeFixture(fixture.root);
  }
}

async function expectCode(run, code) {
  await assert.rejects(run, (error) => {
    assert.ok(error instanceof MeasuredCandidateCloseoutError);
    assert.equal(error.code, code);
    return true;
  });
}

test("proposal is deterministic, source-joined, and input-only", async () => {
  await withFixture(async (fixture) => {
    const builderInputs = [];
    const buildPlan = (input) => {
      builderInputs.push(input);
      return measuredPlan();
    };
    const first = await __proposeMeasuredCloseoutForTest(
      proposalInput(fixture.hardwarePath),
      { buildPlan },
    );
    const second = await __proposeMeasuredCloseoutForTest(
      proposalInput(fixture.hardwarePath),
      { buildPlan },
    );

    assert.deepEqual(first, second);
    assert.deepEqual(Object.keys(first).sort(), [
      "formalClaims",
      "plan",
      "productionEvidence",
      "proposedContractSha256",
      "status",
      "validationPhase",
    ]);
    assert.equal(first.status, "proposed");
    assert.equal(first.validationPhase, "input-only-proposal");
    assert.equal(first.formalClaims, "none");
    assert.equal(first.productionEvidence, false);
    assert.equal(first.proposedContractSha256, PROPOSED_CONTRACT_SHA256);
    assert.equal(first.plan.schema_version, "1.1");
    assert.equal(first.plan.materials.length, 29);
    assert.equal(builderInputs.length, 2);

    const sourceRelativePath = path
      .relative(measuredCloseoutPaths.repositoryRoot, fixture.hardwarePath)
      .split(path.sep)
      .join("/");
    for (const builderInput of builderInputs) {
      assert.strictEqual(builderInput.candidatePlan, CANDIDATE_PLAN);
      assert.strictEqual(builderInput.fixtureRegistryProjection, FIXTURE_REGISTRY);
      assert.deepEqual(builderInput.collectorSource, {
        path: "tools/phase0-harness/hw-ref-collector.mjs",
        sha256: fixture.actualCollectorSha256,
        size_bytes: String(fixture.collectorBytes.length),
      });
      assert.deepEqual(builderInput.measuredHardwareReference, fixture.hardware);
      assert.deepEqual(builderInput.measuredHardwareReferenceSource, {
        path: sourceRelativePath,
        sha256: sha256(fixture.hardwareBytes),
        size_bytes: String(fixture.hardwareBytes.length),
      });
    }
  });
});

test("public API composes the production planner before enforcing external trust", async () => {
  await withFixture(async (fixture) => {
    const input = await productionProposalInput(fixture.hardwarePath);
    const proposal = await proposeMeasuredSherpaCandidateInputCloseout(input);
    assert.equal(proposal.status, "proposed");
    assert.equal(proposal.validationPhase, "input-only-proposal");
    assert.equal(proposal.formalClaims, "none");
    assert.equal(proposal.productionEvidence, false);
    assert.equal(proposal.plan.schema_version, "1.1");
    assert.equal(proposal.plan.materials.length, 29);
    assert.equal(
      proposal.plan.materials.filter((material) => material.kind === "copy")
        .length,
      18,
    );
    assert.equal(
      proposal.plan.materials.filter((material) => material.kind === "document")
        .length,
      11,
    );

    await expectCode(
      () =>
        materializeMeasuredSherpaCandidateInputCloseout({
          ...input,
          expectedContractSha256: ALTERNATE_CONTRACT_SHA256,
          outputRoot: path.join(fixture.root, "public-materialize-output"),
          sourceRoots: {},
        }),
      "MEASURED_CLOSEOUT_TRUST_MISMATCH",
    );

    const outputRoot = path.join(fixture.root, "public-materializer-binding");
    await assert.rejects(
      () =>
        materializeMeasuredSherpaCandidateInputCloseout({
          ...input,
          expectedContractSha256: proposal.proposedContractSha256,
          outputRoot,
          sourceRoots: {},
        }),
      (error) => error?.code === "BUNDLE_MATERIALIZE_KEYS",
    );
    await assert.rejects(lstat(outputRoot), { code: "ENOENT" });
  });
});

test("external digest is mandatory and rejected before any measured input read", async (context) => {
  const missingHardwarePath = path.join(
    measuredCloseoutPaths.targetRoot,
    "missing-closeout-input",
    "hw-ref.json",
  );
  let buildCalls = 0;
  let materializeCalls = 0;
  const dependencies = {
    buildPlan() {
      buildCalls += 1;
      return measuredPlan();
    },
    async materialize() {
      materializeCalls += 1;
      return null;
    },
  };
  const cases = [
    { code: "MEASURED_CLOSEOUT_KEYS", label: "missing key", omit: true },
    { code: "MEASURED_CLOSEOUT_DIGEST", label: "undefined", value: undefined },
    { code: "MEASURED_CLOSEOUT_DIGEST", label: "malformed", value: "a".repeat(63) },
    { code: "MEASURED_CLOSEOUT_DIGEST", label: "uppercase", value: "A".repeat(64) },
    { code: "MEASURED_CLOSEOUT_DIGEST", label: "all zero", value: "0".repeat(64) },
  ];

  for (const testCase of cases) {
    await context.test(testCase.label, async () => {
      const input = materializeInput(missingHardwarePath, testCase.value);
      if (testCase.omit) delete input.expectedContractSha256;
      await expectCode(
        () => __materializeMeasuredCloseoutForTest(input, dependencies),
        testCase.code,
      );
      assert.equal(buildCalls, 0);
      assert.equal(materializeCalls, 0);
    });
  }
});

test("external digest mismatch never reaches materialization", async () => {
  await withFixture(async (fixture) => {
    let materializeCalls = 0;
    await expectCode(
      () =>
        __materializeMeasuredCloseoutForTest(
          materializeInput(fixture.hardwarePath, ALTERNATE_CONTRACT_SHA256),
          {
            buildPlan: () => measuredPlan(PROPOSED_CONTRACT_SHA256),
            async materialize() {
              materializeCalls += 1;
              return null;
            },
          },
        ),
      "MEASURED_CLOSEOUT_TRUST_MISMATCH",
    );
    assert.equal(materializeCalls, 0);
  });
});

test("successful materialization preserves the input-only authority boundary", async () => {
  await withFixture(async (fixture) => {
    const expected = materializeInput(
      fixture.hardwarePath,
      PROPOSED_CONTRACT_SHA256,
    );
    const materializerResult = Object.freeze({
      formalClaims: "none",
      productionEvidence: false,
      status: "input-valid",
      validationPhase: "input-only",
    });
    let received;
    const result = await __materializeMeasuredCloseoutForTest(expected, {
      buildPlan: () => measuredPlan(),
      async materialize(input) {
        received = input;
        return materializerResult;
      },
    });

    assert.strictEqual(result, materializerResult);
    assert.deepEqual(received, {
      expectedContractSha256: PROPOSED_CONTRACT_SHA256,
      outputRoot: expected.outputRoot,
      plan: measuredPlan(),
      sourceRoots: expected.sourceRoots,
    });
  });
});

test("non-canonical measured HW JSON fails before plan construction", async () => {
  await withFixture(async (fixture) => {
    await writeFile(
      fixture.hardwarePath,
      Buffer.concat([fixture.hardwareBytes, Buffer.from("\n", "utf8")]),
    );
    let buildCalls = 0;
    await expectCode(
      () =>
        __proposeMeasuredCloseoutForTest(proposalInput(fixture.hardwarePath), {
          buildPlan() {
            buildCalls += 1;
            return measuredPlan();
          },
        }),
      "MEASURED_CLOSEOUT_HW_CANONICAL",
    );
    assert.equal(buildCalls, 0);
  });
});

test("measured HW outside the ignored target tree is rejected before read", async () => {
  await withFixture(async (fixture) => {
    const outsideRoot = await mkdtemp(
      path.join(os.tmpdir(), "meetingrelay-closeout-outside-"),
    );
    try {
      const outsidePath = path.join(outsideRoot, "hw-ref.json");
      await writeFile(outsidePath, fixture.hardwareBytes, { flag: "wx" });
      let buildCalls = 0;
      await expectCode(
        () =>
          __proposeMeasuredCloseoutForTest(proposalInput(outsidePath), {
            buildPlan() {
              buildCalls += 1;
              return measuredPlan();
            },
          }),
        "MEASURED_CLOSEOUT_PATH",
      );
      assert.equal(buildCalls, 0);
    } finally {
      await rm(outsideRoot, { force: true, recursive: true });
    }
  });
});

test(
  "NTFS alternate-stream measured HW is rejected before input read",
  { skip: process.platform !== "win32" },
  async () => {
    await withFixture(async (fixture) => {
      const alternateStreamPath = `${fixture.hardwarePath}:alternate-hw-ref`;
      await writeFile(alternateStreamPath, fixture.hardwareBytes, { flag: "wx" });
      let buildCalls = 0;
      await expectCode(
        () =>
          __proposeMeasuredCloseoutForTest(
            proposalInput(alternateStreamPath),
            {
              buildPlan() {
                buildCalls += 1;
                return measuredPlan();
              },
            },
          ),
        "MEASURED_CLOSEOUT_PATH",
      );
      assert.equal(buildCalls, 0);
    });
  },
);

test("reparse ancestor below target is rejected", async (context) => {
  await withFixture(async (fixture) => {
    const actualDirectory = path.join(fixture.root, "actual");
    const reparseDirectory = path.join(fixture.root, "reparse");
    await mkdir(actualDirectory);
    const actualHardwarePath = path.join(actualDirectory, "hw-ref.json");
    await writeFile(actualHardwarePath, fixture.hardwareBytes, { flag: "wx" });
    try {
      await symlink(
        actualDirectory,
        reparseDirectory,
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch (error) {
      if (["EACCES", "ENOSYS", "EPERM"].includes(error?.code)) {
        context.skip("host does not permit a test directory reparse point");
        return;
      }
      throw error;
    }
    let buildCalls = 0;
    await expectCode(
      () =>
        __proposeMeasuredCloseoutForTest(
          proposalInput(path.join(reparseDirectory, "hw-ref.json")),
          {
            buildPlan() {
              buildCalls += 1;
              return measuredPlan();
            },
          },
        ),
      "MEASURED_CLOSEOUT_REPARSE",
    );
    assert.equal(buildCalls, 0);
  });
});

test("measured HW identity replacement during read fails closed", async () => {
  await withFixture(async (fixture) => {
    let swapped = false;
    let buildCalls = 0;
    await expectCode(
      () =>
        __proposeMeasuredCloseoutForTest(proposalInput(fixture.hardwarePath), {
          buildPlan() {
            buildCalls += 1;
            return measuredPlan();
          },
          hooks: {
            async afterHwReadBeforePostcheck({ field, filePath }) {
              assert.equal(field, "measuredHardwareReferencePath");
              assert.equal(filePath, fixture.hardwarePath);
              const bytes = await readFile(filePath);
              await rename(filePath, `${filePath}.original`);
              await writeFile(filePath, bytes, { flag: "wx" });
              swapped = true;
            },
          },
        }),
      "MEASURED_CLOSEOUT_IDENTITY",
    );
    assert.equal(swapped, true);
    assert.equal(buildCalls, 0);
  });
});

test("same-size in-place measured HW mutation during read fails closed", async () => {
  await withFixture(async (fixture) => {
    let mutated = false;
    let buildCalls = 0;
    await expectCode(
      () =>
        __proposeMeasuredCloseoutForTest(proposalInput(fixture.hardwarePath), {
          buildPlan() {
            buildCalls += 1;
            return measuredPlan();
          },
          hooks: {
            async afterHwReadBeforePostcheck({ filePath }) {
              const bytes = await readFile(filePath);
              const replacement = Buffer.from(bytes);
              replacement[replacement.length - 2] ^= 0x01;
              await writeFile(filePath, replacement);
              assert.equal(replacement.length, bytes.length);
              mutated = true;
            },
          },
        }),
      "MEASURED_CLOSEOUT_IDENTITY",
    );
    assert.equal(mutated, true);
    assert.equal(buildCalls, 0);
  });
});

test("collector digest join mismatch fails before plan construction", async () => {
  const collectorBytes = await readFile(measuredCloseoutPaths.collectorSourcePath);
  const actual = sha256(collectorBytes);
  const mismatched = `${actual[0] === "f" ? "e" : "f"}${actual.slice(1)}`;
  await withFixture(
    async (fixture) => {
      let buildCalls = 0;
      await expectCode(
        () =>
          __proposeMeasuredCloseoutForTest(proposalInput(fixture.hardwarePath), {
            buildPlan() {
              buildCalls += 1;
              return measuredPlan();
            },
          }),
        "MEASURED_CLOSEOUT_COLLECTOR_JOIN",
      );
      assert.equal(buildCalls, 0);
    },
    { collectorSha256: mismatched },
  );
});

test("beforeMaterialize hook failure prevents materializer invocation", async () => {
  await withFixture(async (fixture) => {
    const sentinel = new Error("synthetic beforeMaterialize failure");
    let materializeCalls = 0;
    await assert.rejects(
      () =>
        __materializeMeasuredCloseoutForTest(
          materializeInput(fixture.hardwarePath, PROPOSED_CONTRACT_SHA256),
          {
            buildPlan: () => measuredPlan(),
            hooks: {
              beforeMaterialize() {
                throw sentinel;
              },
            },
            async materialize() {
              materializeCalls += 1;
              return null;
            },
          },
        ),
      (error) => error === sentinel,
    );
    assert.equal(materializeCalls, 0);
  });
});

test("unsupported materializer authority is rejected", async (context) => {
  const supported = {
    formalClaims: "none",
    productionEvidence: false,
    status: "input-valid",
    validationPhase: "input-only",
  };
  const cases = [
    ["status", { status: "validated" }],
    ["validation phase", { validationPhase: "execution" }],
    ["formal claims", { formalClaims: "verified" }],
    ["production evidence", { productionEvidence: true }],
  ];

  for (const [label, unsupported] of cases) {
    await context.test(label, async () => {
      await withFixture(async (fixture) => {
        await expectCode(
          () =>
            __materializeMeasuredCloseoutForTest(
              materializeInput(fixture.hardwarePath, PROPOSED_CONTRACT_SHA256),
              {
                buildPlan: () => measuredPlan(),
                async materialize() {
                  return { ...supported, ...unsupported };
                },
              },
            ),
          "MEASURED_CLOSEOUT_AUTHORITY",
        );
      });
    });
  }
});

test("unknown proposal and materialize input keys fail closed before work", async (context) => {
  await withFixture(async (fixture) => {
    let buildCalls = 0;
    let materializeCalls = 0;
    const dependencies = {
      buildPlan() {
        buildCalls += 1;
        return measuredPlan();
      },
      async materialize() {
        materializeCalls += 1;
        return null;
      },
    };

    await context.test("proposal", async () => {
      await expectCode(
        () =>
          __proposeMeasuredCloseoutForTest(
            { ...proposalInput(fixture.hardwarePath), unexpected: true },
            dependencies,
          ),
        "MEASURED_CLOSEOUT_KEYS",
      );
    });
    await context.test("materialize", async () => {
      await expectCode(
        () =>
          __materializeMeasuredCloseoutForTest(
            {
              ...materializeInput(
                fixture.hardwarePath,
                PROPOSED_CONTRACT_SHA256,
              ),
              unexpected: true,
            },
            dependencies,
          ),
        "MEASURED_CLOSEOUT_KEYS",
      );
    });
    assert.equal(buildCalls, 0);
    assert.equal(materializeCalls, 0);
  });
});
