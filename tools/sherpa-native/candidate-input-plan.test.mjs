import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  canonicalizeJson,
  encodeCanonicalJson,
  encodeCanonicalJsonLine,
} from "../phase0-harness/canonical-json.mjs";
import {
  MEETINGRELAY_UNLICENSED_NOTICE,
  SHERPA_CANDIDATE_ARTIFACT_MAPPING,
  planSherpaCandidateInput,
} from "./candidate-input-plan.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../..");
const PLANNER_PATH = path.join(HERE, "candidate-input-plan.mjs");
const LOCK_PATH = path.join(HERE, "assets.lock.json");
const SCHEMA_PATH = path.join(HERE, "candidate-schema-registry.json");
const NOTICE_PATH = path.join(HERE, "licenses", "meetingrelay-unlicensed-notice.txt");
const SOURCE_COMMIT = "85f44011448cc4a7eed01864ee10d439580b7e25";
const SOURCE_URL = `https://github.com/AsaZhou923/MeetingRelay/commit/${SOURCE_COMMIT}`;
const EXECUTABLE_SHA256 = "1".repeat(64);
const WRONG_RUNTIME_CANONICAL_SHA256 =
  "50e5c1fe21e9886425e7183a0e7ff2be0026a8c6ec1fb639d6516bff6c50eeda";

let baseInputPromise;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function runBuilder() {
  const command = process.platform === "win32" ? "cargo.exe" : "cargo";
  const result = spawnSync(
    command,
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

async function buildBaseInput() {
  const [
    assetsLockBytes,
    cargoLockBytes,
    schemaRegistryBytes,
    meetingrelayNoticeBytes,
    sherpaApacheLicenseBytes,
    onnxruntimeMitLicenseBytes,
    funasrCurrentLicenseBytes,
  ] = await Promise.all([
    readFile(LOCK_PATH),
    readFile(path.join(REPO_ROOT, "Cargo.lock")),
    readFile(SCHEMA_PATH),
    readFile(NOTICE_PATH),
    readFile(path.join(HERE, "licenses", "apache-2.0-sherpa-onnx.txt")),
    readFile(path.join(HERE, "licenses", "mit-onnxruntime-1.27.0.txt")),
    readFile(path.join(HERE, "licenses", "funasr-model-license-1.1.txt")),
  ]);
  const rustBuilderInputBytes = runBuilder();
  const builder = JSON.parse(rustBuilderInputBytes.toString("utf8"));
  const worker = {
    descriptor: builder.worker_manifest_descriptor_fragment,
    executable_sha256: EXECUTABLE_SHA256,
    role: "native-candidate",
    schema_registry_sha256: sha256(schemaRegistryBytes),
    worker_build_sha256: EXECUTABLE_SHA256,
    worker_id: "meetingrelay-sherpa-native-candidate-host-v1",
  };
  return {
    assetsLockBytes,
    cargoLockBytes,
    licenseBytes: {
      funasrCurrentLicenseBytes,
      meetingrelayNoticeBytes,
      onnxruntimeMitLicenseBytes,
      sherpaApacheLicenseBytes,
    },
    releaseWorkerProjectionBytes: Buffer.from(encodeCanonicalJsonLine(worker), "utf8"),
    rustBuilderInputBytes,
    schemaRegistryBytes,
    sourceCommit: SOURCE_COMMIT,
    sourceUrl: SOURCE_URL,
    workerExecutableSizeBytes: "1234567",
  };
}

async function baseInput() {
  baseInputPromise ??= buildBaseInput();
  return cloneInput(await baseInputPromise);
}

function cloneInput(input) {
  return {
    assetsLockBytes: Buffer.from(input.assetsLockBytes),
    cargoLockBytes: Buffer.from(input.cargoLockBytes),
    licenseBytes: {
      funasrCurrentLicenseBytes: Buffer.from(input.licenseBytes.funasrCurrentLicenseBytes),
      meetingrelayNoticeBytes: Buffer.from(input.licenseBytes.meetingrelayNoticeBytes),
      onnxruntimeMitLicenseBytes: Buffer.from(input.licenseBytes.onnxruntimeMitLicenseBytes),
      sherpaApacheLicenseBytes: Buffer.from(input.licenseBytes.sherpaApacheLicenseBytes),
    },
    releaseWorkerProjectionBytes: Buffer.from(input.releaseWorkerProjectionBytes),
    rustBuilderInputBytes: Buffer.from(input.rustBuilderInputBytes),
    schemaRegistryBytes: Buffer.from(input.schemaRegistryBytes),
    sourceCommit: input.sourceCommit,
    sourceUrl: input.sourceUrl,
    workerExecutableSizeBytes: input.workerExecutableSizeBytes,
  };
}

function mutateCompactLine(bytes, mutate) {
  const value = JSON.parse(bytes.toString("utf8"));
  mutate(value);
  return Buffer.from(encodeCanonicalJsonLine(value), "utf8");
}

function mutateLockBytes(bytes, mutate) {
  const value = JSON.parse(bytes.toString("utf8"));
  mutate(value);
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function material(plan, targetPath) {
  const matches = plan.materials.filter((entry) => entry.target_path === targetPath);
  assert.equal(matches.length, 1, targetPath);
  return matches[0];
}

function candidateManifest(plan) {
  const entry = material(plan, "manifests/candidate-manifest.json");
  assert.equal(entry.kind, "document");
  return { bytes: entry.bytes, value: JSON.parse(entry.bytes.toString("utf8")) };
}

function assertFails(input, pattern = /./u) {
  assert.throws(() => planSherpaCandidateInput(input), pattern);
}

test("planner deterministically derives 15 artifacts and a sorted in-memory material plan", async () => {
  const input = await baseInput();
  const left = planSherpaCandidateInput(input);
  const right = planSherpaCandidateInput(await baseInput());

  assert.deepEqual(Object.keys(left), ["kind", "materials", "schema_version"]);
  assert.equal(left.kind, "meetingrelay-sherpa-candidate-input-plan-v1");
  assert.equal(left.schema_version, "1.0");
  assert.equal(left.materials.length, 20);
  assert.equal(left.materials.filter((entry) => entry.kind === "document").length, 3);
  assert.equal(left.materials.filter((entry) => entry.kind === "copy").length, 17);
  assert.deepEqual(
    left.materials.map((entry) => entry.target_path),
    [...left.materials.map((entry) => entry.target_path)].sort(),
  );
  assert.equal(new Set(left.materials.map((entry) => entry.target_path)).size, 20);

  for (const [index, entry] of left.materials.entries()) {
    assert.match(entry.sha256, /^[0-9a-f]{64}$/u);
    assert.match(entry.size_bytes, /^[1-9][0-9]*$/u);
    if (entry.kind === "copy") {
      assert.deepEqual(Object.keys(entry), [
        "kind",
        "sha256",
        "size_bytes",
        "source_relative_path",
        "source_root",
        "target_path",
      ]);
      assert.equal(path.posix.isAbsolute(entry.source_relative_path), false);
      assert.equal(path.win32.isAbsolute(entry.source_relative_path), false);
      assert.doesNotMatch(entry.source_relative_path, /(?:^|\/)\.\.?(?:\/|$)|\\|:/u);
      assert.equal("bytes" in entry, false);
    } else {
      assert.deepEqual(Object.keys(entry), [
        "bytes",
        "kind",
        "sha256",
        "size_bytes",
        "target_path",
      ]);
      assert.ok(Buffer.isBuffer(entry.bytes));
      assert.equal(entry.size_bytes, String(entry.bytes.length));
      assert.equal(entry.sha256, sha256(entry.bytes));
    }
    const other = right.materials[index];
    assert.deepEqual(
      { ...entry, bytes: entry.bytes === undefined ? undefined : [...entry.bytes] },
      { ...other, bytes: other.bytes === undefined ? undefined : [...other.bytes] },
    );
  }

  const manifest = candidateManifest(left);
  assert.equal(manifest.bytes.toString("utf8"), encodeCanonicalJson(manifest.value));
  assert.equal(manifest.value.schema_version, "1.1");
  assert.equal(manifest.value.artifact_scope, "candidate-input");
  assert.equal(manifest.value.artifacts.length, 15);
  assert.deepEqual(
    manifest.value.artifacts.map((entry) => entry.path),
    [...manifest.value.artifacts.map((entry) => entry.path)].sort(),
  );
  assert.equal(new Set(manifest.value.artifacts.map((entry) => entry.artifact_id)).size, 15);
  assert.equal(new Set(manifest.value.artifacts.map((entry) => entry.role)).size, 15);
  assert.equal(manifest.value.publishability_status, "pending");
  assert.equal(manifest.value.selection_status, "not-selected");
  assert.deepEqual(manifest.value.claims, {
    formal_claims: "none",
    formal_metric_ids: [],
    production_claims: [],
    production_evidence: false,
    slo_claims: [],
  });
  assert.deepEqual(manifest.value.source, {
    source_revision: SOURCE_COMMIT,
    source_sha256: EXECUTABLE_SHA256,
    source_url: SOURCE_URL,
  });
});

test("the immutable mapping is the single source for artifact and materialization identities", async () => {
  const plan = planSherpaCandidateInput(await baseInput());
  const candidate = candidateManifest(plan).value;
  assert.equal(Object.isFrozen(SHERPA_CANDIDATE_ARTIFACT_MAPPING), true);
  assert.equal(SHERPA_CANDIDATE_ARTIFACT_MAPPING.length, 15);
  for (const spec of SHERPA_CANDIDATE_ARTIFACT_MAPPING) {
    assert.equal(Object.isFrozen(spec), true);
    const artifact = candidate.artifacts.find((entry) => entry.path === spec.target_path);
    assert.ok(artifact, spec.target_path);
    assert.equal(artifact.artifact_id, spec.artifact_id);
    assert.equal(artifact.role, spec.role);
    const planned = material(plan, spec.target_path);
    assert.equal(artifact.sha256, planned.sha256);
    assert.equal(artifact.size_bytes, planned.size_bytes);
    assert.equal(planned.kind, spec.material_kind);
  }
  assert.throws(() => {
    SHERPA_CANDIDATE_ARTIFACT_MAPPING[0].target_path = "assets/tampered";
  }, TypeError);
});

test("parameters are exact compact no-LF bytes and runtime inventory preserves lock key order", async () => {
  const input = await baseInput();
  const lock = JSON.parse(input.assetsLockBytes.toString("utf8"));
  const plan = planSherpaCandidateInput(input);
  const parameters = material(plan, "assets/parameters.json");
  const expectedParameters = { ...lock.parameters };
  delete expectedParameters.canonical_json_sha256;
  assert.equal(
    parameters.bytes.toString("utf8"),
    JSON.stringify(canonicalizeJson(expectedParameters)),
  );
  assert.doesNotMatch(parameters.bytes.toString("utf8"), /[\r\n]/u);
  assert.equal(parameters.bytes.length, 494);
  assert.equal(
    parameters.sha256,
    "0ac8669e387262648fcf05fd301a9ba798bb2822e56ec952f1e17d6c692f802e",
  );
  assert.equal(parameters.sha256, lock.parameters.canonical_json_sha256);

  const runtime = material(plan, "assets/runtime-inventory.json");
  assert.equal(runtime.bytes.toString("utf8"), JSON.stringify(lock.runtime.archive.inventory));
  assert.equal(runtime.bytes.length, 935);
  assert.equal(
    runtime.sha256,
    "0682618f660a2a9f2278d99decb77624253aadde60e8199a9b07813b8d843317",
  );
  const wronglyCanonicalized = Buffer.from(
    JSON.stringify(canonicalizeJson(lock.runtime.archive.inventory)),
    "utf8",
  );
  assert.equal(wronglyCanonicalized.length, 935);
  assert.equal(sha256(wronglyCanonicalized), WRONG_RUNTIME_CANONICAL_SHA256);
  assert.notEqual(sha256(wronglyCanonicalized), runtime.sha256);
});

test("artifact license mapping and all four internal-only review records are exact", async () => {
  const plan = planSherpaCandidateInput(await baseInput());
  const candidate = candidateManifest(plan).value;
  const byRole = new Map(candidate.artifacts.map((entry) => [entry.role, entry]));
  const projectId = "LicenseRef-MeetingRelay-Unlicensed-Internal-Evaluation";
  const modelId = "LicenseRef-FunASR-Model-1.1-Internal-Evaluation";

  for (const role of [
    "worker-executable",
    "package-lock",
    "model-manifest",
    "schema-registry",
    "parameters",
    "runtime",
  ]) {
    assert.equal(byRole.get(role).license_id, projectId, role);
  }
  assert.equal(byRole.get("model").license_id, modelId);
  assert.equal(byRole.get("tokens").license_id, modelId);
  for (const [role, artifact] of byRole) {
    if (role.startsWith("runtime-file-onnxruntime")) assert.equal(artifact.license_id, "MIT");
    if (role.startsWith("runtime-file-sherpa")) assert.equal(artifact.license_id, "Apache-2.0");
  }
  assert.equal([...byRole.keys()].filter((role) => role.startsWith("runtime-file-onnxruntime")).length, 3);
  assert.equal([...byRole.keys()].filter((role) => role.startsWith("runtime-file-sherpa")).length, 4);

  assert.equal(candidate.licenses.length, 4);
  for (const license of candidate.licenses) {
    assert.equal(license.review_scope, "internal-evaluation-only");
    assert.equal(license.distribution_status, "pending");
  }
  const project = candidate.licenses.find((entry) => entry.license_id === projectId);
  assert.deepEqual(project, {
    distribution_status: "pending",
    license_id: projectId,
    review_scope: "internal-evaluation-only",
    review_source_status: "unlicensed",
    review_status: "rejected",
    source_revision: SOURCE_COMMIT,
    source_url: SOURCE_URL,
    spdx_or_license_ref: projectId,
    text_path: "licenses/meetingrelay-unlicensed-notice.txt",
    text_sha256: sha256(Buffer.from(MEETINGRELAY_UNLICENSED_NOTICE, "utf8")),
    text_size_bytes: String(Buffer.byteLength(MEETINGRELAY_UNLICENSED_NOTICE)),
  });
  for (const license of candidate.licenses.filter((entry) => entry !== project)) {
    assert.equal(license.review_source_status, "accepted-for-internal-evaluation");
    assert.equal(license.review_status, "accepted");
  }
});

test("the committed notice is factual, conservative, and byte-exact", async () => {
  const bytes = await readFile(NOTICE_PATH);
  assert.equal(bytes.toString("utf8"), MEETINGRELAY_UNLICENSED_NOTICE);
  assert.match(MEETINGRELAY_UNLICENSED_NOTICE, /status notice only\. It is not a license/u);
  assert.match(MEETINGRELAY_UNLICENSED_NOTICE, /MeetingRelay-authored portions.*UNLICENSED/u);
  assert.match(
    MEETINGRELAY_UNLICENSED_NOTICE,
    /does not replace, amend, limit, or extend any third-party license terms/u,
  );
  assert.match(
    MEETINGRELAY_UNLICENSED_NOTICE,
    /No rights or permission are granted to copy, modify, redistribute, or publish/u,
  );
  assert.match(MEETINGRELAY_UNLICENSED_NOTICE, /review scope only; it is not authorization/u);
  assert.match(
    MEETINGRELAY_UNLICENSED_NOTICE,
    /compiled worker.*only a conservative non-publishable blocker/u,
  );
  assert.match(
    MEETINGRELAY_UNLICENSED_NOTICE,
    /not a complete dependency license list or SBOM/u,
  );
  for (const pending of ["Release SBOM", "distribution approval", "Legal review", "Product review"]) {
    assert.ok(MEETINGRELAY_UNLICENSED_NOTICE.includes(pending), pending);
  }
  assert.doesNotMatch(MEETINGRELAY_UNLICENSED_NOTICE, /permission is hereby granted|you may|redistribution is permitted/iu);
});

test("input and output Buffers are defensively isolated", async () => {
  const input = await baseInput();
  const snapshots = new Map([
    ["assets", Buffer.from(input.assetsLockBytes)],
    ["cargo", Buffer.from(input.cargoLockBytes)],
    ["schema", Buffer.from(input.schemaRegistryBytes)],
    ["builder", Buffer.from(input.rustBuilderInputBytes)],
    ["worker", Buffer.from(input.releaseWorkerProjectionBytes)],
    ["notice", Buffer.from(input.licenseBytes.meetingrelayNoticeBytes)],
  ]);
  const plan = planSherpaCandidateInput(input);
  assert.ok(input.assetsLockBytes.equals(snapshots.get("assets")));
  assert.ok(input.cargoLockBytes.equals(snapshots.get("cargo")));
  assert.ok(input.schemaRegistryBytes.equals(snapshots.get("schema")));
  assert.ok(input.rustBuilderInputBytes.equals(snapshots.get("builder")));
  assert.ok(input.releaseWorkerProjectionBytes.equals(snapshots.get("worker")));
  assert.ok(input.licenseBytes.meetingrelayNoticeBytes.equals(snapshots.get("notice")));

  const manifest = material(plan, "manifests/candidate-manifest.json");
  const manifestSnapshot = Buffer.from(manifest.bytes);
  input.assetsLockBytes.fill(0);
  input.licenseBytes.meetingrelayNoticeBytes.fill(0);
  assert.ok(manifest.bytes.equals(manifestSnapshot));

  manifest.bytes.fill(0);
  const fresh = planSherpaCandidateInput(await baseInput());
  assert.ok(material(fresh, "manifests/candidate-manifest.json").bytes.equals(manifestSnapshot));
  const parameter = material(fresh, "assets/parameters.json");
  const runtime = material(fresh, "assets/runtime-inventory.json");
  assert.notStrictEqual(parameter.bytes, runtime.bytes);
  assert.notStrictEqual(parameter.bytes, material(plan, "assets/parameters.json").bytes);
});

test("planner has no direct I/O, process, network, cwd, environment, clock, or random dependency", async () => {
  const source = await readFile(PLANNER_PATH, "utf8");
  const nodeImports = [...source.matchAll(/from\s+"(node:[^"]+)"/gu)].map((match) => match[1]);
  assert.deepEqual(nodeImports, ["node:crypto"]);
  assert.doesNotMatch(source, /from\s+"node:(?:fs|child_process|http|https|net|tls|os)\b/gu);
  assert.doesNotMatch(source, /\b(?:fetch|spawn|execFile|readFile|writeFile|current_dir|currentDir)\s*\(/gu);
  assert.doesNotMatch(source, /\bprocess\.(?:cwd|env|hrtime)\b|\bDate\.now\b|\bMath\.random\b/gu);
  assert.doesNotMatch(source, /input\.(?:distribution|bundle|seal|hardware|fixture|runPlan|evidence)/gu);
});

test("compact-line, CRLF, NFC, indented JSON, and unknown fields fail closed", async (context) => {
  const cases = [
    ["builder CRLF", (input) => {
      input.rustBuilderInputBytes = Buffer.from(
        input.rustBuilderInputBytes.toString("utf8").replace(/\n$/u, "\r\n"),
        "utf8",
      );
    }],
    ["worker missing LF", (input) => {
      input.releaseWorkerProjectionBytes = input.releaseWorkerProjectionBytes.subarray(
        0,
        input.releaseWorkerProjectionBytes.length - 1,
      );
    }],
    ["builder unknown field", (input) => {
      input.rustBuilderInputBytes = mutateCompactLine(input.rustBuilderInputBytes, (value) => {
        value.unreviewed = true;
      });
    }],
    ["worker unknown field", (input) => {
      input.releaseWorkerProjectionBytes = mutateCompactLine(
        input.releaseWorkerProjectionBytes,
        (value) => {
          value.unreviewed = true;
        },
      );
    }],
    ["top-level unknown field", (input) => {
      input.distributionStatus = "accepted";
    }],
    ["license input unknown field", (input) => {
      input.licenseBytes.distributionApproval = true;
    }],
    ["decomposed source URL", (input) => {
      input.sourceUrl = "https://example.invalid/cafe\u0301";
    }],
    ["asset lock CRLF", (input) => {
      input.assetsLockBytes = Buffer.from(
        input.assetsLockBytes.toString("utf8").replace(/\n/gu, "\r\n"),
        "utf8",
      );
    }],
    ["schema compact instead of indented", (input) => {
      input.schemaRegistryBytes = Buffer.from(
        encodeCanonicalJsonLine(JSON.parse(input.schemaRegistryBytes.toString("utf8"))),
        "utf8",
      );
    }],
  ];
  for (const [name, mutate] of cases) {
    await context.test(name, async () => {
      const input = await baseInput();
      mutate(input);
      assertFails(input);
    });
  }
});

test("canonical uint64 and path safety guards reject malformed planner inputs", async (context) => {
  for (const value of ["", "0", "01", "-1", "+1", "18446744073709551616"]) {
    await context.test(`worker size ${JSON.stringify(value)}`, async () => {
      const input = await baseInput();
      input.workerExecutableSizeBytes = value;
      assertFails(input);
    });
  }
  const pathCases = [
    "../onnxruntime.dll",
    "C:/onnxruntime.dll",
    "lib/onnxruntime.dll:evil",
    "lib/CON",
  ];
  for (const unsafePath of pathCases) {
    await context.test(`locked path ${unsafePath}`, async () => {
      const input = await baseInput();
      input.assetsLockBytes = mutateLockBytes(input.assetsLockBytes, (lock) => {
        lock.runtime.archive.inventory[0].path = unsafePath;
      });
      assertFails(input);
    });
  }
});

test("builder, worker, source, lock, schema, size, and license joins fail closed", async (context) => {
  const cases = [
    ["Cargo.lock digest", (input) => {
      input.cargoLockBytes = Buffer.concat([input.cargoLockBytes, Buffer.from("tampered")]);
    }],
    ["schema digest", (input) => {
      const schema = JSON.parse(input.schemaRegistryBytes.toString("utf8"));
      schema.schemas.push("unreviewed.v1");
      input.schemaRegistryBytes = Buffer.from(encodeCanonicalJson(schema), "utf8");
    }],
    ["worker schema join", (input) => {
      input.releaseWorkerProjectionBytes = mutateCompactLine(
        input.releaseWorkerProjectionBytes,
        (worker) => {
          worker.schema_registry_sha256 = "2".repeat(64);
        },
      );
    }],
    ["worker build join", (input) => {
      input.releaseWorkerProjectionBytes = mutateCompactLine(
        input.releaseWorkerProjectionBytes,
        (worker) => {
          worker.worker_build_sha256 = "2".repeat(64);
        },
      );
    }],
    ["worker descriptor join", (input) => {
      input.releaseWorkerProjectionBytes = mutateCompactLine(
        input.releaseWorkerProjectionBytes,
        (worker) => {
          worker.descriptor.model_sha256 = "2".repeat(64);
        },
      );
    }],
    ["builder locked tokens join", (input) => {
      input.rustBuilderInputBytes = mutateCompactLine(input.rustBuilderInputBytes, (builder) => {
        builder.locked_assets.tokens_sha256 = "2".repeat(64);
      });
    }],
    ["builder license join", (input) => {
      input.rustBuilderInputBytes = mutateCompactLine(input.rustBuilderInputBytes, (builder) => {
        builder.license_input.review_status = "rejected";
      });
    }],
    ["project commit", (input) => {
      input.sourceCommit = "A".repeat(40);
    }],
    ["project all-zero commit sentinel", (input) => {
      input.sourceCommit = "0".repeat(40);
      input.sourceUrl = `https://github.com/AsaZhou923/MeetingRelay/commit/${input.sourceCommit}`;
    }],
    ["project URL", (input) => {
      input.sourceUrl = "http://example.invalid/source";
    }],
    ["project commit URL SHA mismatch", (input) => {
      input.sourceUrl = `https://github.com/AsaZhou923/MeetingRelay/commit/${"b".repeat(40)}`;
    }],
    ["notice bytes", (input) => {
      input.licenseBytes.meetingrelayNoticeBytes = Buffer.concat([
        input.licenseBytes.meetingrelayNoticeBytes,
        Buffer.from("grant\n"),
      ]);
    }],
    ["FunASR license bytes", (input) => {
      input.licenseBytes.funasrCurrentLicenseBytes[0] ^= 1;
    }],
    ["MIT license bytes", (input) => {
      input.licenseBytes.onnxruntimeMitLicenseBytes[0] ^= 1;
    }],
    ["Apache license bytes", (input) => {
      input.licenseBytes.sherpaApacheLicenseBytes[0] ^= 1;
    }],
  ];
  for (const [name, mutate] of cases) {
    await context.test(name, async () => {
      const input = await baseInput();
      mutate(input);
      assertFails(input);
    });
  }
});

test("every builder and worker descriptor digest join is independently enforced", async (context) => {
  const input = await baseInput();
  const builder = JSON.parse(input.rustBuilderInputBytes.toString("utf8"));
  for (const field of Object.keys(builder.locked_assets)) {
    await context.test(`builder.locked_assets.${field}`, async () => {
      const tampered = await baseInput();
      tampered.rustBuilderInputBytes = mutateCompactLine(
        tampered.rustBuilderInputBytes,
        (value) => {
          value.locked_assets[field] = "2".repeat(64);
        },
      );
      assertFails(tampered);
    });
  }
  for (const field of [
    "model_manifest_sha256",
    "model_sha256",
    "package_lock_sha256",
    "parameter_sha256",
    "runtime_sha256",
  ]) {
    await context.test(`worker.descriptor.${field}`, async () => {
      const tampered = await baseInput();
      const replacement = "2".repeat(64);
      tampered.rustBuilderInputBytes = mutateCompactLine(
        tampered.rustBuilderInputBytes,
        (value) => {
          value.worker_manifest_descriptor_fragment[field] = replacement;
        },
      );
      tampered.releaseWorkerProjectionBytes = mutateCompactLine(
        tampered.releaseWorkerProjectionBytes,
        (value) => {
          value.descriptor[field] = replacement;
        },
      );
      assertFails(tampered);
    });
  }
});

test("tokens and every physical runtime lock entry are joined individually", async (context) => {
  const input = await baseInput();
  const lock = JSON.parse(input.assetsLockBytes.toString("utf8"));
  const paths = [
    lock.entrypoints.tokens_relative_path,
    ...lock.runtime.archive.inventory.map((entry) => entry.path),
  ];
  assert.equal(paths.length, 8);
  for (const relativePath of paths) {
    await context.test(relativePath, async () => {
      const tampered = await baseInput();
      tampered.assetsLockBytes = mutateLockBytes(tampered.assetsLockBytes, (value) => {
        const inventory = relativePath === value.entrypoints.tokens_relative_path
          ? value.model.archive.inventory
          : value.runtime.archive.inventory;
        const entry = inventory.find((candidate) => candidate.path === relativePath);
        assert.ok(entry, relativePath);
        entry.sha256 = "2".repeat(64);
      });
      assertFails(tampered);
    });
  }
});

test("model identity and inventory sizes cannot drift behind matching paths", async (context) => {
  for (const target of ["model", "tokens", "runtime"]) {
    await context.test(target, async () => {
      const input = await baseInput();
      input.assetsLockBytes = mutateLockBytes(input.assetsLockBytes, (lock) => {
        const inventory = target === "runtime"
          ? lock.runtime.archive.inventory
          : lock.model.archive.inventory;
        const relativePath = target === "model"
          ? lock.entrypoints.model_relative_path
          : target === "tokens"
            ? lock.entrypoints.tokens_relative_path
            : lock.runtime.archive.inventory[0].path;
        const entry = inventory.find((candidate) => candidate.path === relativePath);
        assert.ok(entry, relativePath);
        entry.size_bytes += 1;
      });
      assertFails(input);
    });
  }
});

test("the output contains no bundle, seal, hardware, fixture, run, execution, evidence, quality, or performance authority", async () => {
  const plan = planSherpaCandidateInput(await baseInput());
  const candidate = candidateManifest(plan).value;
  const serialized = JSON.stringify({
    ...plan,
    materials: plan.materials.map((entry) => ({ ...entry, bytes: undefined })),
  });
  for (const forbidden of [
    "contract_manifest",
    "expectedContractSha256",
    "bundle_root",
    "hw_ref",
    "fixture_set",
    "run_plan",
    "execution_status",
    "evidence_manifest",
    "quality_evidence",
    "performance_evidence",
    "ranking_status",
    "default-selected",
    "production-ready",
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
  assert.equal("worker_manifest_descriptor_fragment" in candidate, false);
  assert.equal("rust_builder_input" in candidate, false);
  assert.equal(candidate.worker_manifest_projection.descriptor.execution_provider, "cpu");
  assert.equal(candidate.worker_manifest_projection.role, "native-candidate");
});
