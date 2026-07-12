import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  encodeCanonicalJson,
  encodeCanonicalJsonLine,
} from "../phase0-harness/canonical-json.mjs";
import {
  CANDIDATE_HOST_FILE_NAME,
  DEFAULT_SCHEMA_REGISTRY_PATH,
  WorkerProvenanceValidationError,
  validateWorkerProvenanceProjection,
} from "./validate-worker-provenance.mjs";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function descriptor() {
  return {
    engine_id: "sherpa-onnx",
    engine_version: "1.13.4",
    execution_provider: "cpu",
    languages: ["zh"],
    model_id: "sensevoice-zh-en-ja-ko-yue-int8-2024-07-17",
    model_license_id: "LicenseRef-FunASR-Model-1.1-Internal-Evaluation",
    model_manifest_sha256: "1".repeat(64),
    model_sha256: "2".repeat(64),
    offline: true,
    package_lock_sha256: "3".repeat(64),
    parameter_sha256: "4".repeat(64),
    quantization: "int8",
    runtime_id: "sherpa-onnx-shared-cpu",
    runtime_sha256: "5".repeat(64),
    runtime_version: "1.27.0",
    streaming: true,
  };
}

async function withFixture(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "meetingrelay-worker-provenance-"));
  const release = path.join(root, "release");
  const executablePath = path.join(release, CANDIDATE_HOST_FILE_NAME);
  const schemaRegistryPath = path.join(root, "candidate-schema-registry.json");
  const executableBytes = Buffer.from("synthetic candidate host executable\n", "utf8");
  try {
    await mkdir(release, { recursive: true });
    await writeFile(executablePath, executableBytes);
    await copyFile(DEFAULT_SCHEMA_REGISTRY_PATH, schemaRegistryPath);
    const schemaBytes = await readFile(schemaRegistryPath);
    const manifest = {
      descriptor: descriptor(),
      executable_sha256: sha256(executableBytes),
      role: "native-candidate",
      schema_registry_sha256: sha256(schemaBytes),
      worker_build_sha256: sha256(executableBytes),
      worker_id: "meetingrelay-sherpa-native-candidate-host-v1",
    };
    const fixture = {
      builderInputBytes: Buffer.from(
        encodeCanonicalJsonLine({
          worker_manifest_descriptor_fragment: descriptor(),
        }),
        "utf8",
      ),
      executableBytes,
      executablePath,
      manifest,
      projectionBytes: Buffer.from(encodeCanonicalJsonLine(manifest), "utf8"),
      root,
      schemaBytes,
      schemaRegistryPath,
    };
    await run(fixture);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

async function expectCode(promise, code) {
  await assert.rejects(
    promise,
    (error) =>
      error instanceof WorkerProvenanceValidationError && error.code === code,
    `expected ${code}`,
  );
}

test("Cargo exposes exactly one candidate host gated by the native-sherpa feature", () => {
  const cargo = process.platform === "win32" ? "cargo.exe" : "cargo";
  const result = spawnSync(
    cargo,
    ["metadata", "--format-version", "1", "--no-deps", "--offline", "--locked"],
    {
      cwd: path.resolve(path.dirname(DEFAULT_SCHEMA_REGISTRY_PATH), "../.."),
      encoding: "utf8",
      env: { ...process.env, CARGO_TERM_COLOR: "never" },
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const metadata = JSON.parse(result.stdout);
  const package_ = metadata.packages.find(
    (value) => value.name === "meetingrelay-model-worker-sherpa-native",
  );
  assert.ok(package_);
  const targets = package_.targets.filter(
    (target) => target.name === "meetingrelay-sherpa-candidate-host",
  );
  assert.equal(targets.length, 1);
  assert.deepEqual(targets[0].kind, ["bin"]);
  assert.deepEqual(targets[0]["required-features"], ["native-sherpa"]);
});

test("schema registry uses sorted two-space canonical JSON and provenance uses compact JSON lines", async () => {
  const schema = {
    artifact_scope: "candidate-input",
    formal_claims: "none",
    schema_version: "1.0",
    schemas: ["meetingrelay.model-worker.v1"],
  };
  assert.equal(
    await readFile(DEFAULT_SCHEMA_REGISTRY_PATH, "utf8"),
    encodeCanonicalJson(schema),
  );
  await withFixture(async (fixture) => {
    assert.equal(
      fixture.projectionBytes.toString("utf8"),
      encodeCanonicalJsonLine(fixture.manifest),
    );
  });
});

test("synthetic Release candidate-host projection validates exact executable and schema bytes", async () => {
  await withFixture(async (fixture) => {
    const result = await validateWorkerProvenanceProjection(fixture);
    assert.deepEqual(Object.keys(result).sort(), [
      "executableSha256",
      "executableSizeBytes",
      "schemaRegistrySha256",
      "workerId",
    ]);
    assert.equal(result.executableSha256, sha256(fixture.executableBytes));
    assert.equal(result.executableSizeBytes, String(fixture.executableBytes.length));
    assert.match(result.executableSizeBytes, /^[1-9][0-9]*$/u);
    assert.equal(result.schemaRegistrySha256, sha256(fixture.schemaBytes));
    assert.equal(result.workerId, fixture.manifest.worker_id);
  });
});

test("projection must be compact canonical JSON with exactly six sorted keys", async () => {
  await withFixture(async (fixture) => {
    const noncanonical = Buffer.from(
      `${JSON.stringify(fixture.manifest, null, 2)}\n`,
      "utf8",
    );
    await expectCode(
      validateWorkerProvenanceProjection({ ...fixture, projectionBytes: noncanonical }),
      "PROV_CANONICAL_JSON",
    );
    const forbidden = { ...fixture.manifest, execution_status: "completed" };
    await expectCode(
      validateWorkerProvenanceProjection({
        ...fixture,
        projectionBytes: Buffer.from(encodeCanonicalJsonLine(forbidden), "utf8"),
      }),
      "PROV_SCHEMA_KEYS",
    );
  });
});

test("projection descriptor must equal the Rust candidate builder descriptor fragment", async () => {
  await withFixture(async (fixture) => {
    const builder = JSON.parse(fixture.builderInputBytes.toString("utf8"));
    builder.worker_manifest_descriptor_fragment.runtime_version = "unexpected";
    await expectCode(
      validateWorkerProvenanceProjection({
        ...fixture,
        builderInputBytes: Buffer.from(encodeCanonicalJsonLine(builder), "utf8"),
      }),
      "PROV_DESCRIPTOR_MISMATCH",
    );
  });
});

test("worker identity drift cannot pass cross-language provenance validation", async () => {
  await withFixture(async (fixture) => {
    const drifted = { ...fixture.manifest, worker_id: "another-valid-worker-id" };
    await expectCode(
      validateWorkerProvenanceProjection({
        ...fixture,
        projectionBytes: Buffer.from(encodeCanonicalJsonLine(drifted), "utf8"),
      }),
      "PROV_WORKER_ID",
    );
  });
});

test("schema registry digest drift fails even when it is valid lowercase SHA-256", async () => {
  await withFixture(async (fixture) => {
    const drifted = {
      ...fixture.manifest,
      schema_registry_sha256: "6".repeat(64),
    };
    await expectCode(
      validateWorkerProvenanceProjection({
        ...fixture,
        projectionBytes: Buffer.from(encodeCanonicalJsonLine(drifted), "utf8"),
      }),
      "PROV_SCHEMA_DIGEST",
    );
  });
});

test("worker build digest drift fails even when executable digest remains exact", async () => {
  await withFixture(async (fixture) => {
    const drifted = {
      ...fixture.manifest,
      worker_build_sha256: "7".repeat(64),
    };
    await expectCode(
      validateWorkerProvenanceProjection({
        ...fixture,
        projectionBytes: Buffer.from(encodeCanonicalJsonLine(drifted), "utf8"),
      }),
      "PROV_EXECUTABLE_DIGEST",
    );
  });
});

test("worker role drift cannot become a candidate-host provenance claim", async () => {
  await withFixture(async (fixture) => {
    const drifted = { ...fixture.manifest, role: "fallback-candidate" };
    await expectCode(
      validateWorkerProvenanceProjection({
        ...fixture,
        projectionBytes: Buffer.from(encodeCanonicalJsonLine(drifted), "utf8"),
      }),
      "PROV_ROLE",
    );
  });
});

test("zero provenance digests fail the lowercase nonzero SHA-256 grammar", async () => {
  await withFixture(async (fixture) => {
    const drifted = { ...fixture.manifest, executable_sha256: "0".repeat(64) };
    await expectCode(
      validateWorkerProvenanceProjection({
        ...fixture,
        projectionBytes: Buffer.from(encodeCanonicalJsonLine(drifted), "utf8"),
      }),
      "PROV_DIGEST_FORMAT",
    );
  });
});

test("uppercase provenance digests fail the lowercase SHA-256 grammar", async () => {
  await withFixture(async (fixture) => {
    const drifted = { ...fixture.manifest, executable_sha256: "A".repeat(64) };
    await expectCode(
      validateWorkerProvenanceProjection({
        ...fixture,
        projectionBytes: Buffer.from(encodeCanonicalJsonLine(drifted), "utf8"),
      }),
      "PROV_DIGEST_FORMAT",
    );
  });
});

test("schema tampering and oversize bytes fail before digest acceptance", async () => {
  await withFixture(async (fixture) => {
    await writeFile(
      fixture.schemaRegistryPath,
      Buffer.concat([fixture.schemaBytes, Buffer.from(" ", "utf8")]),
    );
    await expectCode(
      validateWorkerProvenanceProjection(fixture),
      "PROV_SCHEMA_BYTES",
    );
  });
  await withFixture(async (fixture) => {
    await writeFile(fixture.schemaRegistryPath, Buffer.alloc(65_537, 0x61));
    await expectCode(
      validateWorkerProvenanceProjection(fixture),
      "PROV_SCHEMA_SIZE",
    );
  });
});

test("schema reparse ancestors fail closed without exposing their target", async (context) => {
  await withFixture(async (fixture) => {
    const targetDirectory = path.join(fixture.root, "schema-target");
    const linkedDirectory = path.join(fixture.root, "schema-link");
    await mkdir(targetDirectory);
    await writeFile(
      path.join(targetDirectory, "candidate-schema-registry.json"),
      fixture.schemaBytes,
    );
    try {
      await symlink(
        targetDirectory,
        linkedDirectory,
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch (error) {
      if (error?.code === "EPERM" || error?.code === "EACCES") {
        if (process.env.CI) {
          throw error;
        }
        context.skip("host does not permit file symlinks");
        return;
      }
      throw error;
    }
    await expectCode(
      validateWorkerProvenanceProjection({
        ...fixture,
        schemaRegistryPath: path.join(
          linkedDirectory,
          "candidate-schema-registry.json",
        ),
      }),
      "PROV_PATH_REPARSE",
    );
  });
});

test("Debug paths and emitter identities cannot be accepted as the candidate host", async () => {
  await withFixture(async (fixture) => {
    const debugDirectory = path.join(fixture.root, "debug");
    const debugPath = path.join(debugDirectory, CANDIDATE_HOST_FILE_NAME);
    await mkdir(debugDirectory);
    await writeFile(debugPath, fixture.executableBytes);
    await expectCode(
      validateWorkerProvenanceProjection({ ...fixture, executablePath: debugPath }),
      "PROV_RELEASE_REQUIRED",
    );

    const emitterPath = path.join(
      path.dirname(fixture.executablePath),
      process.platform === "win32"
        ? "emit_sherpa_candidate_builder_input.exe"
        : "emit_sherpa_candidate_builder_input",
    );
    await writeFile(emitterPath, fixture.executableBytes);
    await expectCode(
      validateWorkerProvenanceProjection({ ...fixture, executablePath: emitterPath }),
      "PROV_EXECUTABLE_IDENTITY",
    );
  });
});

test("wrong executable bytes cannot satisfy self build and executable joins", async () => {
  await withFixture(async (fixture) => {
    await writeFile(fixture.executablePath, "different executable bytes\n", "utf8");
    await expectCode(
      validateWorkerProvenanceProjection(fixture),
      "PROV_EXECUTABLE_DIGEST",
    );
  });
});
