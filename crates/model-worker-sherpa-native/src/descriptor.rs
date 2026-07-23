use meetingrelay_model_worker_contract::{
    EngineDescriptor, ExecutionProvider, Identifier, LanguageCode,
};

use super::{
    ENGINE_ID, ENGINE_VERSION, LOCKED_ASSET_LOCK_SHA256_HEX, LOCKED_MODEL_SHA256_HEX,
    LOCKED_PACKAGE_LOCK_SHA256_HEX, LOCKED_PARAMETER_SHA256_HEX, LOCKED_RUNTIME_BUNDLE_SHA256_HEX,
    MODEL_ID, MODEL_LICENSE_ID, QUANTIZATION, RUNTIME_ID, RUNTIME_VERSION, locked_digest,
};

/// Stable descriptor for the local Sherpa/SenseVoice realtime engine.
#[must_use]
pub(crate) fn locked_engine_descriptor() -> EngineDescriptor {
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
        languages: vec![
            locked_language("en"),
            locked_language("ja"),
            locked_language("zh"),
        ],
        streaming: true,
        offline: true,
    }
}

fn locked_identifier(value: &str) -> Identifier {
    Identifier::new(value).expect("committed sherpa identity is constant-valid")
}

fn locked_language(value: &str) -> LanguageCode {
    LanguageCode::new(value).expect("committed sherpa language is constant-valid")
}
