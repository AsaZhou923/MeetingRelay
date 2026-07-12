use std::process::Command;

use meetingrelay_model_worker_contract::ExecutionProvider;
use meetingrelay_model_worker_sherpa_native::{
    LOCKED_ASSET_LOCK_SHA256_HEX, LOCKED_CANDIDATE_BUILDER_INPUT_SHA256_HEX, LOCKED_CANDIDATE_ID,
    LOCKED_MODEL_LICENSE_TEXT_SHA256_HEX, LOCKED_MODEL_SHA256_HEX, LOCKED_PACKAGE_LOCK_SHA256_HEX,
    LOCKED_PARAMETER_SHA256_HEX, LOCKED_RUNTIME_BUNDLE_SHA256_HEX, LOCKED_TOKENS_SHA256_HEX,
    locked_candidate_builder_input_json_bytes, locked_engine_descriptor,
};
use sha2::{Digest, Sha256};

const EXPECTED_DESCRIPTOR_JSON: &str = concat!(
    "{\"engine_id\":\"sherpa-onnx\",\"engine_version\":\"1.13.4\",",
    "\"execution_provider\":\"cpu\",\"languages\":[\"zh\"],",
    "\"model_id\":\"sensevoice-zh-en-ja-ko-yue-int8-2024-07-17\",",
    "\"model_license_id\":\"LicenseRef-FunASR-Model-1.1-Internal-Evaluation\",",
    "\"model_manifest_sha256\":\"e22adeea2dde27cab1c40fa116b665ef111b7c1b8cf24f7b7a1900a23e263181\",",
    "\"model_sha256\":\"c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51\",",
    "\"offline\":true,",
    "\"package_lock_sha256\":\"02efd2bae11eb162ed59526ac3ddadd73b8537ac4c98423b38cf3eed1208989d\",",
    "\"parameter_sha256\":\"0ac8669e387262648fcf05fd301a9ba798bb2822e56ec952f1e17d6c692f802e\",",
    "\"quantization\":\"int8\",\"runtime_id\":\"sherpa-onnx-shared-cpu\",",
    "\"runtime_sha256\":\"0682618f660a2a9f2278d99decb77624253aadde60e8199a9b07813b8d843317\",",
    "\"runtime_version\":\"1.27.0\",\"streaming\":true}"
);

#[test]
fn candidate_builder_input_bytes_are_deterministic_and_golden_locked() {
    let first = locked_candidate_builder_input_json_bytes();
    let second = locked_candidate_builder_input_json_bytes();

    assert_eq!(first, second);
    assert!(first.ends_with(b"\n"));
    assert!(!first.contains(&b'\r'));
    assert_eq!(
        hex_sha256(&first),
        LOCKED_CANDIDATE_BUILDER_INPUT_SHA256_HEX,
        "candidate builder-input byte drift requires an explicit golden update"
    );
}

#[test]
fn descriptor_fragment_is_exactly_the_production_descriptor() {
    let actual = String::from_utf8(locked_candidate_builder_input_json_bytes())
        .expect("candidate builder input must be UTF-8 JSON");
    let descriptor = locked_engine_descriptor();

    assert_eq!(descriptor.engine_id.as_str(), "sherpa-onnx");
    assert_eq!(descriptor.engine_version.as_str(), "1.13.4");
    assert_eq!(descriptor.runtime_id.as_str(), "sherpa-onnx-shared-cpu");
    assert_eq!(descriptor.runtime_version.as_str(), "1.27.0");
    assert_eq!(
        descriptor.model_id.as_str(),
        "sensevoice-zh-en-ja-ko-yue-int8-2024-07-17"
    );
    assert_eq!(
        descriptor.model_license_id.as_str(),
        "LicenseRef-FunASR-Model-1.1-Internal-Evaluation"
    );
    assert_eq!(descriptor.execution_provider, ExecutionProvider::Cpu);
    assert_eq!(descriptor.quantization.as_str(), "int8");
    assert_eq!(descriptor.languages.len(), 1);
    assert_eq!(descriptor.languages[0].as_str(), "zh");
    assert!(descriptor.streaming);
    assert!(descriptor.offline);
    assert_eq!(
        descriptor.model_sha256.to_lower_hex(),
        LOCKED_MODEL_SHA256_HEX
    );
    assert_eq!(
        descriptor.model_manifest_sha256.to_lower_hex(),
        LOCKED_ASSET_LOCK_SHA256_HEX
    );
    assert_eq!(
        descriptor.package_lock_sha256.to_lower_hex(),
        LOCKED_PACKAGE_LOCK_SHA256_HEX
    );
    assert_eq!(
        descriptor.parameter_sha256.to_lower_hex(),
        LOCKED_PARAMETER_SHA256_HEX
    );
    assert_eq!(
        descriptor.runtime_sha256.to_lower_hex(),
        LOCKED_RUNTIME_BUNDLE_SHA256_HEX
    );
    assert!(actual.contains(&format!(
        "\"worker_manifest_descriptor_fragment\":{EXPECTED_DESCRIPTOR_JSON}"
    )));
    assert_eq!(
        actual
            .matches("\"worker_manifest_descriptor_fragment\":")
            .count(),
        1
    );
}

#[test]
fn builder_input_has_locked_assets_license_and_non_claim_status() {
    let actual = String::from_utf8(locked_candidate_builder_input_json_bytes())
        .expect("candidate builder input must be UTF-8 JSON");

    for required in [
        LOCKED_CANDIDATE_ID,
        LOCKED_MODEL_SHA256_HEX,
        LOCKED_MODEL_LICENSE_TEXT_SHA256_HEX,
        LOCKED_TOKENS_SHA256_HEX,
        LOCKED_ASSET_LOCK_SHA256_HEX,
        LOCKED_PACKAGE_LOCK_SHA256_HEX,
        LOCKED_PARAMETER_SHA256_HEX,
        LOCKED_RUNTIME_BUNDLE_SHA256_HEX,
        "\"eligibility_status\":\"not-assessed\"",
        "\"execution_status\":\"not-run\"",
        "\"measurement_status\":\"not-measured\"",
        "\"quality_evidence\":false",
        "\"ranking_status\":\"not-ranked\"",
        "\"selection_status\":\"not-selected\"",
        "\"publishability_status\":\"pending\"",
        "\"distribution_status\":\"pending\"",
        "\"review_scope\":\"internal-evaluation-only\"",
        "\"review_source_status\":\"accepted-for-internal-evaluation\"",
        "\"review_status\":\"accepted\"",
        "\"spdx_or_license_ref\":\"LicenseRef-FunASR-Model-1.1-Internal-Evaluation\"",
        "\"source_revision\":\"b1a7283d97b61ddeef25d13f3b56b62a896ee3bb\"",
        "\"text_path\":\"licenses/funasr-model-license-1.1.txt\"",
        "\"text_size_bytes\":\"5306\"",
        "\"projection_kind\":\"sherpa-candidate-builder-input-v1\"",
        "\"projection_schema_version\":\"1.0\"",
        "\"trust_anchor_policy\":\"external-expectedContractSha256-required\"",
        "\"worker_contract_version\":\"meetingrelay.model-worker/1.0\"",
        "\"worker_role\":\"native-candidate\"",
        "\"candidate-input-envelope-and-seals\"",
        "\"contract-wrapper-assets-and-role-digest-joins\"",
        "\"executable-worker-build-and-schema-registry-digests\"",
        "\"validator-schema-bridge-for-assets-lock-cargo-lock-and-full-parameters\"",
    ] {
        assert!(
            actual.contains(required),
            "missing locked field: {required}"
        );
    }
}

#[test]
fn builder_input_contains_no_claim_or_fabricated_bundle_material() {
    let actual = String::from_utf8(locked_candidate_builder_input_json_bytes())
        .expect("candidate builder input must be UTF-8 JSON");

    for required in [
        "\"formal_claims\":\"none\"",
        "\"formal_metric_ids\":[]",
        "\"production_claims\":[]",
        "\"production_evidence\":false",
        "\"slo_claims\":[]",
    ] {
        assert!(
            actual.contains(required),
            "missing no-claim field: {required}"
        );
    }
    for forbidden in [
        "PERF-",
        "SLO-",
        "passed",
        "default-selected",
        "production-ready",
        "quality_evidence\":true",
        "production_evidence\":true",
        "captured_at",
        "timestamp",
        "hostname",
        "host_id",
        "C:\\\\",
        "/Users/",
        "model_path",
        "tokens_path",
        "runtime_lib_dir",
        "model_weights",
        "\"artifact_scope\":\"candidate-input\"",
        "\"expected_contract_sha256\":",
        "\"expectedContractSha256\":",
        "\"trust_anchor_sha256\":",
        "\"artifacts\":",
        "\"build\":",
        "\"executable_sha256\":",
        "\"schema_registry_sha256\":",
        "\"source\":",
        "\"worker_build_sha256\":",
        "\"worker_id\":",
        LOCKED_CANDIDATE_BUILDER_INPUT_SHA256_HEX,
    ] {
        assert!(
            !actual.contains(forbidden),
            "forbidden material: {forbidden}"
        );
    }
}

#[test]
fn emitter_stdout_is_exactly_the_library_builder_input() {
    let output = Command::new(env!("CARGO_BIN_EXE_emit_sherpa_candidate_builder_input"))
        .output()
        .expect("run candidate builder-input emitter");

    assert!(output.status.success());
    assert!(output.stderr.is_empty());
    assert_eq!(output.stdout, locked_candidate_builder_input_json_bytes());
}

fn hex_sha256(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut output = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write as _;
        write!(&mut output, "{byte:02x}").expect("write to String");
    }
    output
}
