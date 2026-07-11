import { createHash } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { encodeCanonicalJson, encodeCanonicalJsonLine } from "./canonical-json.mjs";

export const FIXTURE_ID = "FX-UND-CAL-001-v1";
export const SAMPLE_RATE_HZ = 16_000;
export const CHANNELS = 1;
export const BITS_PER_SAMPLE = 16;
export const DURATION_MS = 2_000;
export const PULSE_START_SAMPLES = Object.freeze([4_000, 16_000, 28_000]);
export const PULSE_DURATION_SAMPLES = 80;

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(MODULE_DIR, "..", "..");
const PROJECT_FIXTURE_ROOT = path.join(REPOSITORY_ROOT, "test-fixtures");
const SCHEMA_FILE = "manifest.schema.json";
const MANIFEST_FILE = "manifest.json";
const MANIFEST_DIGEST_FILE = "manifest.sha256";
const AUDIO_PATH = `audio/${FIXTURE_ID}/input.wav`;
const REFERENCE_PATH = `audio/${FIXTURE_ID}/reference.json`;
const PROVIDER_SCRIPT_PATH = `events/${FIXTURE_ID}/provider-script.jsonl`;
const FAULT_PLAN_PATH = `faults/${FIXTURE_ID}/fault-plan.json`;
const MAX_U64 = (1n << 64n) - 1n;

const EXPECTED_FILES = Object.freeze(
  [
    SCHEMA_FILE,
    MANIFEST_FILE,
    MANIFEST_DIGEST_FILE,
    AUDIO_PATH,
    REFERENCE_PATH,
    PROVIDER_SCRIPT_PATH,
    FAULT_PLAN_PATH,
  ].sort(),
);

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function buildSyntheticPcm() {
  const sampleCount = (SAMPLE_RATE_HZ * DURATION_MS) / 1_000;
  const pcm = Buffer.alloc(sampleCount * 2);

  for (const pulseStart of PULSE_START_SAMPLES) {
    for (let offset = 0; offset < PULSE_DURATION_SAMPLES; offset += 1) {
      const amplitude = offset < PULSE_DURATION_SAMPLES / 2 ? 12_000 : -12_000;
      pcm.writeInt16LE(amplitude, (pulseStart + offset) * 2);
    }
  }

  return pcm;
}

export function buildPcmWav(pcm) {
  const header = Buffer.alloc(44);
  const byteRate = SAMPLE_RATE_HZ * CHANNELS * (BITS_PER_SAMPLE / 8);
  const blockAlign = CHANNELS * (BITS_PER_SAMPLE / 8);

  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(SAMPLE_RATE_HZ, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(BITS_PER_SAMPLE, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]);
}

function buildReference() {
  return {
    schema_version: "1.0",
    fixture_id: FIXTURE_ID,
    content_class: "calibration-pulse-only",
    contains_speech: false,
    transcript: null,
    timeline_rate: SAMPLE_RATE_HZ,
    pulse_duration_samples: String(PULSE_DURATION_SAMPLES),
    pulse_start_samples: PULSE_START_SAMPLES.map(String),
  };
}

function buildProviderScript() {
  return [
    {
      schema_version: "1.0",
      fixture_id: FIXTURE_ID,
      logical_sequence: "1",
      logical_offset_ns: "0",
      action: "delta",
      chunk: "fixture-token-1",
    },
    {
      schema_version: "1.0",
      fixture_id: FIXTURE_ID,
      logical_sequence: "2",
      logical_offset_ns: "1000000",
      action: "complete",
      chunk: "fixture-token-1 fixture-token-2",
    },
  ];
}

function buildFaultPlan() {
  return {
    schema_version: "1.0",
    fixture_id: FIXTURE_ID,
    seed: "0",
    steps: [],
  };
}

function buildManifest({ audioSha256, pcmSha256, referenceSha256, providerSha256, faultSha256 }) {
  return {
    schema_version: "1.0",
    manifest_revision: 1,
    fixtures: [
      {
        fixture_id: FIXTURE_ID,
        revision: 1,
        purpose: ["harness", "sync", "provider-contract"],
        language: ["und"],
        tier: "calibration",
        provenance: {
          kind: "synthetic",
          generator: "meetingrelay.synthetic-pulse",
          generator_version: "1.0.0",
          license: "project-generated",
          source_url: null,
          consent_record: null,
        },
        privacy_class: "public-safe",
        contains_human_voice: false,
        contains_meeting_content: false,
        contains_personal_data: false,
        created_at: "2026-07-11",
        reviewed_by: ["Engineering"],
        audio: {
          path: AUDIO_PATH,
          sha256: audioSha256,
          pcm_sha256: pcmSha256,
          sample_rate_hz: SAMPLE_RATE_HZ,
          channels: CHANNELS,
          sample_format: "s16le",
          duration_ms: String(DURATION_MS),
          integrated_lufs: null,
          integrated_lufs_status: "not-applicable-calibration-pulse",
        },
        reference: {
          path: REFERENCE_PATH,
          sha256: referenceSha256,
        },
        provider_script: {
          path: PROVIDER_SCRIPT_PATH,
          sha256: providerSha256,
        },
        fault_plan: {
          path: FAULT_PLAN_PATH,
          sha256: faultSha256,
        },
      },
    ],
  };
}

function resolveFixturePath(root, relativePath) {
  if (
    typeof relativePath !== "string" ||
    relativePath.length === 0 ||
    path.isAbsolute(relativePath) ||
    relativePath.includes("\\") ||
    relativePath.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`unsafe fixture path: ${relativePath}`);
  }

  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, ...relativePath.split("/"));
  if (!resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`fixture path escapes root: ${relativePath}`);
  }
  return resolved;
}

async function writeAsset(root, relativePath, bytes) {
  const target = resolveFixturePath(root, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, bytes);
}

export async function generateFixtureTree(root = PROJECT_FIXTURE_ROOT) {
  const resolvedRoot = path.resolve(root);
  await mkdir(resolvedRoot, { recursive: true });

  const schemaSource = path.join(PROJECT_FIXTURE_ROOT, SCHEMA_FILE);
  const schemaTarget = path.join(resolvedRoot, SCHEMA_FILE);
  if (schemaSource !== schemaTarget) {
    await copyFile(schemaSource, schemaTarget);
  } else {
    await readFile(schemaTarget);
  }

  const pcm = buildSyntheticPcm();
  const wav = buildPcmWav(pcm);
  const referenceBytes = Buffer.from(encodeCanonicalJson(buildReference()), "utf8");
  const providerBytes = Buffer.from(
    buildProviderScript().map(encodeCanonicalJsonLine).join(""),
    "utf8",
  );
  const faultBytes = Buffer.from(encodeCanonicalJson(buildFaultPlan()), "utf8");

  await writeAsset(resolvedRoot, AUDIO_PATH, wav);
  await writeAsset(resolvedRoot, REFERENCE_PATH, referenceBytes);
  await writeAsset(resolvedRoot, PROVIDER_SCRIPT_PATH, providerBytes);
  await writeAsset(resolvedRoot, FAULT_PLAN_PATH, faultBytes);

  const manifest = buildManifest({
    audioSha256: sha256(wav),
    pcmSha256: sha256(pcm),
    referenceSha256: sha256(referenceBytes),
    providerSha256: sha256(providerBytes),
    faultSha256: sha256(faultBytes),
  });
  const manifestBytes = Buffer.from(encodeCanonicalJson(manifest), "utf8");
  const manifestDigest = sha256(manifestBytes);
  await writeAsset(resolvedRoot, MANIFEST_FILE, manifestBytes);
  await writeAsset(
    resolvedRoot,
    MANIFEST_DIGEST_FILE,
    Buffer.from(`${manifestDigest}  ${MANIFEST_FILE}\n`, "ascii"),
  );

  return { manifestDigest, fixtureId: FIXTURE_ID };
}

function assertExactKeys(value, expected, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} keys differ: ${actual.join(",")}`);
  }
}

function assertCanonicalU64(value, label) {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`${label} must be a canonical uint64 string`);
  }
  if (BigInt(value) > MAX_U64) {
    throw new Error(`${label} exceeds uint64`);
  }
}

function assertSha256(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
}

async function readCheckedAsset(root, descriptor, label) {
  assertExactKeys(descriptor, ["path", "sha256"], label);
  assertSha256(descriptor.sha256, `${label}.sha256`);
  const target = resolveFixturePath(root, descriptor.path);
  const metadata = await lstat(target);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`${label} must resolve to a regular file`);
  }
  const bytes = await readFile(target);
  if (sha256(bytes) !== descriptor.sha256) {
    throw new Error(`${label} checksum mismatch`);
  }
  return bytes;
}

function validateWav(wav, audio) {
  if (wav.length < 44 || wav.toString("ascii", 0, 4) !== "RIFF") {
    throw new Error("audio is not a RIFF file");
  }
  if (wav.toString("ascii", 8, 12) !== "WAVE" || wav.toString("ascii", 12, 16) !== "fmt ") {
    throw new Error("audio WAV header is invalid");
  }
  if (wav.readUInt32LE(4) !== wav.length - 8 || wav.readUInt32LE(16) !== 16) {
    throw new Error("audio WAV RIFF or fmt chunk size is invalid");
  }
  if (wav.readUInt16LE(20) !== 1 || wav.readUInt16LE(22) !== CHANNELS) {
    throw new Error("audio WAV must be mono PCM");
  }
  if (
    wav.readUInt32LE(24) !== SAMPLE_RATE_HZ ||
    wav.readUInt32LE(28) !== SAMPLE_RATE_HZ * 2 ||
    wav.readUInt16LE(32) !== 2 ||
    wav.readUInt16LE(34) !== BITS_PER_SAMPLE
  ) {
    throw new Error("audio WAV format differs from the manifest contract");
  }
  if (wav.toString("ascii", 36, 40) !== "data" || wav.readUInt32LE(40) !== wav.length - 44) {
    throw new Error("audio WAV data chunk is invalid");
  }
  const pcm = wav.subarray(44);
  if (sha256(pcm) !== audio.pcm_sha256) {
    throw new Error("audio PCM checksum mismatch");
  }
  if ((pcm.length / 2 / SAMPLE_RATE_HZ) * 1_000 !== Number(audio.duration_ms)) {
    throw new Error("audio duration differs from the manifest");
  }
  return pcm;
}

async function listFiles(root, directory = root) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`fixture tree contains symlink: ${absolute}`);
    }
    if (entry.isDirectory()) {
      output.push(...(await listFiles(root, absolute)));
    } else if (entry.isFile()) {
      output.push(path.relative(root, absolute).split(path.sep).join("/"));
    } else {
      throw new Error(`fixture tree contains unsupported entry: ${absolute}`);
    }
  }
  return output.sort();
}

export async function validateFixtureTree(root = PROJECT_FIXTURE_ROOT) {
  const resolvedRoot = path.resolve(root);
  const files = await listFiles(resolvedRoot);
  if (files.length !== EXPECTED_FILES.length || files.some((file, index) => file !== EXPECTED_FILES[index])) {
    throw new Error(`fixture file inventory differs: ${files.join(",")}`);
  }

  const schema = JSON.parse(await readFile(path.join(resolvedRoot, SCHEMA_FILE), "utf8"));
  if (schema.$id !== "https://meetingrelay.local/schemas/fixture-manifest-v1.json") {
    throw new Error("fixture schema ID differs");
  }

  const manifestBytes = await readFile(path.join(resolvedRoot, MANIFEST_FILE));
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (Buffer.from(encodeCanonicalJson(manifest), "utf8").compare(manifestBytes) !== 0) {
    throw new Error("manifest is not canonical JSON");
  }
  const manifestDigest = sha256(manifestBytes);
  const digestSidecar = await readFile(path.join(resolvedRoot, MANIFEST_DIGEST_FILE), "ascii");
  if (digestSidecar !== `${manifestDigest}  ${MANIFEST_FILE}\n`) {
    throw new Error("manifest checksum sidecar differs");
  }

  assertExactKeys(manifest, ["fixtures", "manifest_revision", "schema_version"], "manifest");
  if (manifest.schema_version !== "1.0" || manifest.manifest_revision !== 1) {
    throw new Error("manifest version differs");
  }
  if (!Array.isArray(manifest.fixtures) || manifest.fixtures.length !== 1) {
    throw new Error("WP-0.3.2 requires exactly one calibration fixture");
  }

  const fixture = manifest.fixtures[0];
  assertExactKeys(
    fixture,
    [
      "audio",
      "contains_human_voice",
      "contains_meeting_content",
      "contains_personal_data",
      "created_at",
      "fault_plan",
      "fixture_id",
      "language",
      "privacy_class",
      "provider_script",
      "provenance",
      "purpose",
      "reference",
      "reviewed_by",
      "revision",
      "tier",
    ],
    "fixture",
  );
  if (fixture.fixture_id !== FIXTURE_ID || fixture.revision !== 1) {
    throw new Error("fixture identity differs");
  }
  if (
    fixture.privacy_class !== "public-safe" ||
    fixture.contains_human_voice !== false ||
    fixture.contains_meeting_content !== false ||
    fixture.contains_personal_data !== false
  ) {
    throw new Error("fixture is not consent-safe synthetic data");
  }
  assertExactKeys(
    fixture.provenance,
    ["consent_record", "generator", "generator_version", "kind", "license", "source_url"],
    "provenance",
  );
  if (
    fixture.provenance.kind !== "synthetic" ||
    fixture.provenance.license !== "project-generated" ||
    fixture.provenance.consent_record !== null ||
    fixture.provenance.source_url !== null
  ) {
    throw new Error("fixture provenance differs from the synthetic contract");
  }

  assertExactKeys(
    fixture.audio,
    [
      "channels",
      "duration_ms",
      "integrated_lufs",
      "integrated_lufs_status",
      "path",
      "pcm_sha256",
      "sample_format",
      "sample_rate_hz",
      "sha256",
    ],
    "audio",
  );
  assertCanonicalU64(fixture.audio.duration_ms, "audio.duration_ms");
  assertSha256(fixture.audio.sha256, "audio.sha256");
  assertSha256(fixture.audio.pcm_sha256, "audio.pcm_sha256");
  if (
    fixture.audio.sample_rate_hz !== SAMPLE_RATE_HZ ||
    fixture.audio.channels !== CHANNELS ||
    fixture.audio.sample_format !== "s16le" ||
    fixture.audio.integrated_lufs !== null ||
    fixture.audio.integrated_lufs_status !== "not-applicable-calibration-pulse"
  ) {
    throw new Error("audio manifest format differs");
  }
  const audioTarget = resolveFixturePath(resolvedRoot, fixture.audio.path);
  const audioMetadata = await lstat(audioTarget);
  if (audioMetadata.isSymbolicLink() || !audioMetadata.isFile()) {
    throw new Error("audio must resolve to a regular file");
  }
  const wav = await readFile(audioTarget);
  if (sha256(wav) !== fixture.audio.sha256) {
    throw new Error("audio file checksum mismatch");
  }
  validateWav(wav, fixture.audio);

  const referenceBytes = await readCheckedAsset(resolvedRoot, fixture.reference, "reference");
  const providerBytes = await readCheckedAsset(
    resolvedRoot,
    fixture.provider_script,
    "provider_script",
  );
  const faultBytes = await readCheckedAsset(resolvedRoot, fixture.fault_plan, "fault_plan");
  const reference = JSON.parse(referenceBytes.toString("utf8"));
  if (
    Buffer.from(encodeCanonicalJson(reference), "utf8").compare(referenceBytes) !== 0
  ) {
    throw new Error("reference is not canonical JSON");
  }
  assertExactKeys(
    reference,
    [
      "contains_speech",
      "content_class",
      "fixture_id",
      "pulse_duration_samples",
      "pulse_start_samples",
      "schema_version",
      "timeline_rate",
      "transcript",
    ],
    "reference",
  );
  if (reference.contains_speech !== false || reference.transcript !== null) {
    throw new Error("reference unexpectedly contains speech or transcript content");
  }
  if (
    reference.fixture_id !== FIXTURE_ID ||
    reference.schema_version !== "1.0" ||
    reference.content_class !== "calibration-pulse-only" ||
    reference.timeline_rate !== SAMPLE_RATE_HZ ||
    reference.pulse_duration_samples !== String(PULSE_DURATION_SAMPLES) ||
    JSON.stringify(reference.pulse_start_samples) !== JSON.stringify(PULSE_START_SAMPLES.map(String))
  ) {
    throw new Error("reference calibration points differ");
  }
  for (const value of reference.pulse_start_samples) {
    assertCanonicalU64(value, "reference.pulse_start_samples[]");
  }
  assertCanonicalU64(reference.pulse_duration_samples, "reference.pulse_duration_samples");

  const providerLines = providerBytes
    .toString("utf8")
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
  if (
    Buffer.from(providerLines.map(encodeCanonicalJsonLine).join(""), "utf8").compare(
      providerBytes,
    ) !== 0
  ) {
    throw new Error("provider script is not canonical JSONL");
  }
  if (providerLines.length !== 2) {
    throw new Error("provider script event count differs");
  }
  for (const [index, event] of providerLines.entries()) {
    assertExactKeys(
      event,
      ["action", "chunk", "fixture_id", "logical_offset_ns", "logical_sequence", "schema_version"],
      `provider[${index}]`,
    );
    assertCanonicalU64(event.logical_sequence, "provider.logical_sequence");
    assertCanonicalU64(event.logical_offset_ns, "provider.logical_offset_ns");
    if (event.fixture_id !== FIXTURE_ID || BigInt(event.logical_sequence) !== BigInt(index + 1)) {
      throw new Error("provider script ordering differs");
    }
    if (
      event.schema_version !== "1.0" ||
      (index > 0 &&
        BigInt(event.logical_offset_ns) <= BigInt(providerLines[index - 1].logical_offset_ns))
    ) {
      throw new Error("provider script logical time differs");
    }
  }
  const faultPlan = JSON.parse(faultBytes.toString("utf8"));
  if (Buffer.from(encodeCanonicalJson(faultPlan), "utf8").compare(faultBytes) !== 0) {
    throw new Error("fault plan is not canonical JSON");
  }
  assertExactKeys(faultPlan, ["fixture_id", "schema_version", "seed", "steps"], "fault_plan");
  assertCanonicalU64(faultPlan.seed, "fault_plan.seed");
  if (
    faultPlan.fixture_id !== FIXTURE_ID ||
    faultPlan.schema_version !== "1.0" ||
    !Array.isArray(faultPlan.steps) ||
    faultPlan.steps.length !== 0
  ) {
    throw new Error("fault plan shape differs");
  }

  const textualAssets = Buffer.concat([referenceBytes, providerBytes, faultBytes]).toString("utf8");
  if (
    /(?:api[_-]?key|access[_-]?token|password|secret)["']?\s*[:=]/i.test(textualAssets) ||
    /[A-Za-z]:\\|\\\\/.test(textualAssets) ||
    /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/.test(textualAssets)
  ) {
    throw new Error("fixture text contains a secret, absolute path, or email-like identifier");
  }

  return {
    fixtureId: fixture.fixture_id,
    manifestDigest,
    audioSha256: fixture.audio.sha256,
    pcmSha256: fixture.audio.pcm_sha256,
  };
}

export const fixturePaths = Object.freeze({
  projectRoot: PROJECT_FIXTURE_ROOT,
  expectedFiles: EXPECTED_FILES,
});
