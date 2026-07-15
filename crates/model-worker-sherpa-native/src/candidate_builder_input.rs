use meetingrelay_model_worker_contract::{
    EngineDescriptor, ExecutionProvider, Identifier, LanguageCode, WORKER_PROTOCOL_NAME,
    WORKER_PROTOCOL_V1,
};

use super::{
    ENGINE_ID, ENGINE_VERSION, LOCKED_ASSET_LOCK_SHA256_HEX, LOCKED_MODEL_SHA256_HEX,
    LOCKED_PACKAGE_LOCK_SHA256_HEX, LOCKED_PARAMETER_SHA256_HEX, LOCKED_RUNTIME_BUNDLE_SHA256_HEX,
    LOCKED_TOKENS_SHA256_HEX, MODEL_ID, MODEL_LICENSE_ID, QUANTIZATION, RUNTIME_ID,
    RUNTIME_VERSION, locked_digest,
};

/// Stable identity of the first locked native sherpa candidate.
pub const LOCKED_CANDIDATE_ID: &str = "sherpa-native-sensevoice-int8-2024-07-17-win-x64-cpu";

/// SHA-256 drift golden for [`locked_candidate_builder_input_json_bytes`].
///
/// Any semantic or byte-level edit must update the projection and this digest
/// together. This digest is not an authenticity or bundle trust anchor;
/// candidate-bundle validation still requires an independently supplied
/// `expectedContractSha256` value outside the bundle.
pub const LOCKED_CANDIDATE_BUILDER_INPUT_SHA256_HEX: &str =
    "7d9601948653e75c316461e5e2629ded8e5f4f669c909751ff3c1db91c1ca4f2";

/// SHA-256 of the locked FunASR model-license snapshot consumed by bundling.
pub const LOCKED_MODEL_LICENSE_TEXT_SHA256_HEX: &str =
    "7dba975a2069691db4992b0592d70828b330d2f8a30a71450f4e152a554e84f8";

const LOCKED_LANGUAGE: &str = "zh";
const LICENSE_DISTRIBUTION_STATUS: &str = "pending";
const LICENSE_REVIEW_SCOPE: &str = "internal-evaluation-only";
const LICENSE_REVIEW_SOURCE_STATUS: &str = "accepted-for-internal-evaluation";
const LICENSE_REVIEW_STATUS: &str = "accepted";
const LICENSE_SOURCE_REVISION: &str = "b1a7283d97b61ddeef25d13f3b56b62a896ee3bb";
const LICENSE_SOURCE_URL: &str = concat!(
    "https://github.com/modelscope/FunASR/blob/",
    "b1a7283d97b61ddeef25d13f3b56b62a896ee3bb/MODEL_LICENSE"
);
const LICENSE_TEXT_PATH: &str = "licenses/funasr-model-license-1.1.txt";
const LICENSE_TEXT_SIZE_BYTES: &str = "5306";

/// Returns the exact descriptor accepted by the production candidate gate.
///
/// Paths and build-specific worker hashes intentionally do not belong here.
/// The returned value is the shared semantic source for native validation and
/// the descriptor fragment consumed by later candidate bundling.
#[must_use]
pub fn locked_engine_descriptor() -> EngineDescriptor {
    EngineDescriptor {
        engine_id: locked_identifier(ENGINE_ID),
        engine_version: locked_identifier(ENGINE_VERSION),
        runtime_id: locked_identifier(RUNTIME_ID),
        runtime_version: locked_identifier(RUNTIME_VERSION),
        runtime_sha256: locked_digest(LOCKED_RUNTIME_BUNDLE_SHA256_HEX),
        package_lock_sha256: locked_digest(LOCKED_PACKAGE_LOCK_SHA256_HEX),
        model_id: locked_identifier(MODEL_ID),
        model_sha256: locked_digest(LOCKED_MODEL_SHA256_HEX),
        model_manifest_sha256: locked_digest(LOCKED_ASSET_LOCK_SHA256_HEX),
        model_license_id: locked_identifier(MODEL_LICENSE_ID),
        parameter_sha256: locked_digest(LOCKED_PARAMETER_SHA256_HEX),
        execution_provider: ExecutionProvider::Cpu,
        quantization: locked_identifier(QUANTIZATION),
        languages: vec![locked_language(LOCKED_LANGUAGE)],
        streaming: true,
        offline: true,
    }
}

/// Emits one canonical compact JSON line containing locked bundle-builder input.
///
/// Keys are recursively sorted. The fragment contains no local paths,
/// timestamps, host identity, model weights, run observations, rankings, or
/// quality/performance claims. Build-specific worker/executable/schema digests,
/// artifact inventory, wrapper assets, source/build metadata, run evidence,
/// seals, and the exact `candidate-input` envelope are deferred to a later
/// builder. Consequently this fragment does not claim `artifact_scope`, is not
/// a full `worker_manifest_projection`, and is not accepted directly by the
/// current candidate-artifact validator.
#[must_use]
pub fn locked_candidate_builder_input_json_bytes() -> Vec<u8> {
    let descriptor = locked_engine_descriptor();
    let runtime_sha256 = descriptor.runtime_sha256.to_lower_hex();
    let package_lock_sha256 = descriptor.package_lock_sha256.to_lower_hex();
    let model_sha256 = descriptor.model_sha256.to_lower_hex();
    let model_manifest_sha256 = descriptor.model_manifest_sha256.to_lower_hex();
    let parameter_sha256 = descriptor.parameter_sha256.to_lower_hex();

    let mut output = String::with_capacity(4_096);
    output.push_str("{\"candidate_id\":\"");
    output.push_str(LOCKED_CANDIDATE_ID);
    output.push_str(concat!(
        "\",\"claims\":{\"formal_claims\":\"none\",\"formal_metric_ids\":[],",
        "\"production_claims\":[],\"production_evidence\":false,\"slo_claims\":[]},",
        "\"deferred_builder_fields\":[",
        "\"artifact-inventory-paths-roles-sizes-and-license-mapping\",",
        "\"build-and-source-metadata\",\"candidate-input-envelope-and-seals\",",
        "\"contract-wrapper-assets-and-role-digest-joins\",",
        "\"executable-worker-build-and-schema-registry-digests\",",
        "\"external-expectedContractSha256-value\",",
        "\"fixture-hw-run-plan-and-evidence\",",
        "\"validator-schema-bridge-for-assets-lock-cargo-lock-and-full-parameters\",",
        "\"worker-id\"],",
        "\"license_input\":{\"distribution_status\":\"",
    ));
    output.push_str(LICENSE_DISTRIBUTION_STATUS);
    output.push_str("\",\"license_id\":\"");
    output.push_str(descriptor.model_license_id.as_str());
    output.push_str("\",\"review_scope\":\"");
    output.push_str(LICENSE_REVIEW_SCOPE);
    output.push_str("\",\"review_source_status\":\"");
    output.push_str(LICENSE_REVIEW_SOURCE_STATUS);
    output.push_str("\",\"review_status\":\"");
    output.push_str(LICENSE_REVIEW_STATUS);
    output.push_str("\",\"source_revision\":\"");
    output.push_str(LICENSE_SOURCE_REVISION);
    output.push_str("\",\"source_url\":\"");
    output.push_str(LICENSE_SOURCE_URL);
    output.push_str("\",\"spdx_or_license_ref\":\"");
    output.push_str(descriptor.model_license_id.as_str());
    output.push_str("\",\"text_path\":\"");
    output.push_str(LICENSE_TEXT_PATH);
    output.push_str("\",\"text_sha256\":\"");
    output.push_str(LOCKED_MODEL_LICENSE_TEXT_SHA256_HEX);
    output.push_str("\",\"text_size_bytes\":\"");
    output.push_str(LICENSE_TEXT_SIZE_BYTES);
    output.push_str("\"},\"locked_assets\":{\"asset_lock_sha256\":\"");
    output.push_str(&model_manifest_sha256);
    output.push_str("\",\"model_license_text_sha256\":\"");
    output.push_str(LOCKED_MODEL_LICENSE_TEXT_SHA256_HEX);
    output.push_str("\",\"model_sha256\":\"");
    output.push_str(&model_sha256);
    output.push_str("\",\"package_lock_sha256\":\"");
    output.push_str(&package_lock_sha256);
    output.push_str("\",\"parameter_sha256\":\"");
    output.push_str(&parameter_sha256);
    output.push_str("\",\"runtime_bundle_sha256\":\"");
    output.push_str(&runtime_sha256);
    output.push_str("\",\"tokens_sha256\":\"");
    output.push_str(LOCKED_TOKENS_SHA256_HEX);
    output.push_str(concat!(
        "\"},\"non_claim_guardrails\":{\"eligibility_status\":\"not-assessed\",",
        "\"execution_status\":\"not-run\",\"measurement_status\":\"not-measured\",",
        "\"quality_evidence\":false,\"ranking_status\":\"not-ranked\"},",
        "\"projection_kind\":\"sherpa-candidate-builder-input-v1\",",
        "\"projection_schema_version\":\"1.0\",\"publishability_status\":\"pending\",",
        "\"selection_status\":\"not-selected\",",
        "\"trust_anchor_policy\":\"external-expectedContractSha256-required\",",
        "\"worker_contract_version\":\"",
    ));
    output.push_str(WORKER_PROTOCOL_NAME);
    output.push('/');
    output.push_str(&WORKER_PROTOCOL_V1.major.to_string());
    output.push('.');
    output.push_str(&WORKER_PROTOCOL_V1.minor.to_string());
    output.push_str("\",\"worker_manifest_descriptor_fragment\":");
    push_descriptor_json(&mut output, &descriptor);
    output.push_str(",\"worker_role\":\"native-candidate\"}\n");
    output.into_bytes()
}

pub(crate) fn push_descriptor_json(output: &mut String, descriptor: &EngineDescriptor) {
    output.push_str("{\"engine_id\":\"");
    output.push_str(descriptor.engine_id.as_str());
    output.push_str("\",\"engine_version\":\"");
    output.push_str(descriptor.engine_version.as_str());
    output.push_str("\",\"execution_provider\":\"");
    output.push_str(locked_execution_provider_id(descriptor.execution_provider));
    output.push_str("\",\"languages\":[\"");
    output.push_str(descriptor.languages[0].as_str());
    output.push_str("\"],\"model_id\":\"");
    output.push_str(descriptor.model_id.as_str());
    output.push_str("\",\"model_license_id\":\"");
    output.push_str(descriptor.model_license_id.as_str());
    output.push_str("\",\"model_manifest_sha256\":\"");
    output.push_str(&descriptor.model_manifest_sha256.to_lower_hex());
    output.push_str("\",\"model_sha256\":\"");
    output.push_str(&descriptor.model_sha256.to_lower_hex());
    output.push_str("\",\"offline\":");
    output.push_str(json_bool(descriptor.offline));
    output.push_str(",\"package_lock_sha256\":\"");
    output.push_str(&descriptor.package_lock_sha256.to_lower_hex());
    output.push_str("\",\"parameter_sha256\":\"");
    output.push_str(&descriptor.parameter_sha256.to_lower_hex());
    output.push_str("\",\"quantization\":\"");
    output.push_str(descriptor.quantization.as_str());
    output.push_str("\",\"runtime_id\":\"");
    output.push_str(descriptor.runtime_id.as_str());
    output.push_str("\",\"runtime_sha256\":\"");
    output.push_str(&descriptor.runtime_sha256.to_lower_hex());
    output.push_str("\",\"runtime_version\":\"");
    output.push_str(descriptor.runtime_version.as_str());
    output.push_str("\",\"streaming\":");
    output.push_str(json_bool(descriptor.streaming));
    output.push('}');
}

fn locked_execution_provider_id(provider: ExecutionProvider) -> &'static str {
    match provider {
        ExecutionProvider::Cpu => "cpu",
        _ => panic!("locked sherpa descriptor must use the CPU execution provider"),
    }
}

const fn json_bool(value: bool) -> &'static str {
    if value { "true" } else { "false" }
}

fn locked_identifier(value: &str) -> Identifier {
    Identifier::new(value).expect("committed sherpa identity is constant-valid")
}

fn locked_language(value: &str) -> LanguageCode {
    LanguageCode::new(value).expect("committed sherpa language is constant-valid")
}
