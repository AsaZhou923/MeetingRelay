//! Offline sherpa-onnx backend for the MeetingRelay model-worker contract.
//!
//! `Prepare` is the readiness boundary: it verifies every sealed local asset
//! and constructs the recognizer before the session may report Ready. Backend
//! execution therefore performs only canonical audio validation and inference;
//! it never hides cold initialization behind an admitted action.

use std::fmt;
#[cfg(feature = "native-sherpa")]
use std::fs;
use std::fs::File;
#[cfg(any(feature = "native-sherpa", test))]
use std::fs::OpenOptions;
use std::io::Read;
#[cfg(all(windows, any(feature = "native-sherpa", test)))]
use std::os::windows::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

use meetingrelay_model_worker_contract::{
    AudioChunk, AudioPayload, BackendAction, BackendFailure, BackendOutcome, EngineDescriptor,
    ExecutionProvider, Identifier, LanguageCode, ModelBackend, SanitizedText, Sha256Digest,
    TranscriptProvenance, TranscriptResult, TranscriptText,
};
use sha2::{Digest, Sha256};

mod candidate_builder_input;
#[cfg(feature = "native-sherpa")]
mod candidate_execution;
#[cfg(feature = "native-fault-fixture")]
mod candidate_fault;
#[cfg(feature = "native-quality-sample")]
mod candidate_quality_sample;
#[cfg(feature = "native-quality-shard")]
mod candidate_quality_shard;
mod realtime;
mod worker_provenance;

pub use candidate_builder_input::{
    LOCKED_CANDIDATE_BUILDER_INPUT_SHA256_HEX, LOCKED_CANDIDATE_ID,
    LOCKED_MODEL_LICENSE_TEXT_SHA256_HEX, locked_candidate_builder_input_json_bytes,
    locked_engine_descriptor,
};
#[cfg(feature = "native-sherpa")]
pub use candidate_execution::{
    LOCKED_CONFORMANCE_WAV_SHA256_HEX, NativeCandidateExecutionError,
    NativeCandidateExecutionInput, run_locked_native_candidate_conformance,
};
#[cfg(all(feature = "native-sherpa", feature = "native-fault-fixture"))]
pub use candidate_fault::run_locked_native_candidate_fault;
#[cfg(feature = "native-fault-fixture")]
pub use candidate_fault::{NATIVE_CANDIDATE_FAULT_CHECKPOINT_KIND, NativeCandidateFaultMode};
#[cfg(feature = "native-quality-sample")]
pub use candidate_quality_sample::{
    NativeCandidateQualitySampleError, NativeCandidateQualitySampleIdentity,
    NativeCandidateQualitySampleInput, run_locked_native_candidate_quality_sample,
};
#[cfg(feature = "native-quality-shard")]
pub use candidate_quality_shard::{
    NativeCandidateQualityShardError, NativeCandidateQualityShardInput,
    run_locked_native_candidate_quality_shard,
};
pub use realtime::{
    LOCKED_REALTIME_MAX_PCM16_BYTES, LOCKED_REALTIME_SAMPLE_RATE_HZ, LockedSherpaRealtime,
    LockedSherpaRealtimeError, LockedSherpaRealtimePaths,
};
pub use worker_provenance::{
    LOCKED_SCHEMA_REGISTRY_BYTES, LOCKED_WORKER_ID, MAX_SCHEMA_REGISTRY_BYTES,
    WorkerProvenanceError, locked_schema_registry_sha256, locked_worker_manifest,
    locked_worker_manifest_projection_json_bytes,
};

const REQUIRED_SAMPLE_RATE_HZ: u32 = 16_000;
const REQUIRED_CHANNELS: u16 = 1;
const MAX_BACKEND_INPUT_BYTES: u64 = 268_435_456;
const ENGINE_ID: &str = "sherpa-onnx";
const ENGINE_VERSION: &str = "1.13.4";
const RUNTIME_ID: &str = "sherpa-onnx-shared-cpu";
const RUNTIME_VERSION: &str = "1.27.0";
const MODEL_ID: &str = "sensevoice-zh-en-ja-ko-yue-int8-2024-07-17";
const MODEL_LICENSE_ID: &str = "LicenseRef-FunASR-Model-1.1-Internal-Evaluation";
const QUANTIZATION: &str = "int8";

pub const LOCKED_MODEL_SHA256_HEX: &str =
    "c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51";
pub const LOCKED_TOKENS_SHA256_HEX: &str =
    "f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc";
// Kept in one place because every intentional assets.lock.json edit changes it.
pub const LOCKED_ASSET_LOCK_SHA256_HEX: &str =
    "e22adeea2dde27cab1c40fa116b665ef111b7c1b8cf24f7b7a1900a23e263181";
pub const LOCKED_PACKAGE_LOCK_SHA256_HEX: &str =
    "3510ddfa99e3eabd022954fa71c23515abaa6a0411d8555844efe49d64b29acf";
pub const LOCKED_RUNTIME_BUNDLE_SHA256_HEX: &str =
    "0682618f660a2a9f2278d99decb77624253aadde60e8199a9b07813b8d843317";

/// Canonical JSON material hashed by the sealed Phase-0 parameter lock.
pub const LOCKED_PARAMETER_CANONICAL_JSON: &str = concat!(
    "{\"blank_penalty\":0,\"bpe_vocab\":null,\"channels\":1,",
    "\"debug\":false,\"decoding_method\":\"greedy_search\",\"feature_dim\":80,",
    "\"homophone_lexicon\":null,\"homophone_rule_fsts\":null,",
    "\"hotwords_file\":null,\"hotwords_score\":0,\"language\":\"zh\",",
    "\"lm_model\":null,\"lm_scale\":1,\"max_active_paths\":4,",
    "\"max_input_bytes\":67108864,\"model_family\":\"sense_voice\",",
    "\"model_type\":null,\"modeling_unit\":null,\"num_threads\":1,",
    "\"provider\":\"cpu\",\"rule_fars\":null,\"rule_fsts\":null,",
    "\"sample_rate_hz\":16000,\"telespeech_ctc\":null,\"use_itn\":true}"
);
pub const LOCKED_PARAMETER_SHA256_HEX: &str =
    "0ac8669e387262648fcf05fd301a9ba798bb2822e56ec952f1e17d6c692f802e";

#[cfg(feature = "native-sherpa")]
const RUNTIME_INVENTORY_CANONICAL_JSON: &str = concat!(
    "[{\"path\":\"lib/onnxruntime.dll\",\"size_bytes\":17363968,",
    "\"sha256\":\"daa77083a45bf525da0dde9e87f85d8eb146f58f9c9aa7124ca84545e1c0f148\"},",
    "{\"path\":\"lib/onnxruntime.lib\",\"size_bytes\":2124,",
    "\"sha256\":\"b9fc3cd678257d88a111b0773ede4bfceaf0fe95daab4379f2b2b37348a68781\"},",
    "{\"path\":\"lib/onnxruntime_providers_shared.dll\",\"size_bytes\":104960,",
    "\"sha256\":\"190d10767c321f324d3785368a0b752d9c5a9e06cb5d4d97bb176f58bdb652f3\"},",
    "{\"path\":\"lib/sherpa-onnx-c-api.dll\",\"size_bytes\":4544512,",
    "\"sha256\":\"3db688ca9e6408c958f45986adc68ed9158522e28c7567b7ffee9312a553c777\"},",
    "{\"path\":\"lib/sherpa-onnx-c-api.lib\",\"size_bytes\":75298,",
    "\"sha256\":\"21513d9d053ea39956081f5d421d610cd512b076032bf550b9907d2c7b6a52fb\"},",
    "{\"path\":\"lib/sherpa-onnx-cxx-api.dll\",\"size_bytes\":258048,",
    "\"sha256\":\"3e8b308e9235a3e7398b2c89b43ebb7f813f216aade661b2f246d42656517777\"},",
    "{\"path\":\"lib/sherpa-onnx-cxx-api.lib\",\"size_bytes\":224022,",
    "\"sha256\":\"9b754db267f88e928f77b39afcc9875985e7d51063d0839162e01fb681dd9faf\"}]"
);

#[cfg(feature = "native-sherpa")]
struct RuntimeAsset {
    name: &'static str,
    size_bytes: u64,
    sha256: &'static str,
}

#[cfg(feature = "native-sherpa")]
const RUNTIME_ASSETS: [RuntimeAsset; 7] = [
    RuntimeAsset {
        name: "onnxruntime.dll",
        size_bytes: 17_363_968,
        sha256: "daa77083a45bf525da0dde9e87f85d8eb146f58f9c9aa7124ca84545e1c0f148",
    },
    RuntimeAsset {
        name: "onnxruntime.lib",
        size_bytes: 2_124,
        sha256: "b9fc3cd678257d88a111b0773ede4bfceaf0fe95daab4379f2b2b37348a68781",
    },
    RuntimeAsset {
        name: "onnxruntime_providers_shared.dll",
        size_bytes: 104_960,
        sha256: "190d10767c321f324d3785368a0b752d9c5a9e06cb5d4d97bb176f58bdb652f3",
    },
    RuntimeAsset {
        name: "sherpa-onnx-c-api.dll",
        size_bytes: 4_544_512,
        sha256: "3db688ca9e6408c958f45986adc68ed9158522e28c7567b7ffee9312a553c777",
    },
    RuntimeAsset {
        name: "sherpa-onnx-c-api.lib",
        size_bytes: 75_298,
        sha256: "21513d9d053ea39956081f5d421d610cd512b076032bf550b9907d2c7b6a52fb",
    },
    RuntimeAsset {
        name: "sherpa-onnx-cxx-api.dll",
        size_bytes: 258_048,
        sha256: "3e8b308e9235a3e7398b2c89b43ebb7f813f216aade661b2f246d42656517777",
    },
    RuntimeAsset {
        name: "sherpa-onnx-cxx-api.lib",
        size_bytes: 224_022,
        sha256: "9b754db267f88e928f77b39afcc9875985e7d51063d0839162e01fb681dd9faf",
    },
];

const ASSET_MISMATCH: &str = "SHERPA_ASSET_MISMATCH";
const NOT_PREPARED: &str = "SHERPA_NOT_PREPARED";
const UNSUPPORTED_AUDIO: &str = "SHERPA_UNSUPPORTED_AUDIO";
const INPUT_TOO_LARGE: &str = "SHERPA_INPUT_TOO_LARGE";
const INIT_FAILED: &str = "SHERPA_INIT_FAILED";
const RESULT_UNAVAILABLE: &str = "SHERPA_RESULT_UNAVAILABLE";
const EMPTY_RESULT: &str = "SHERPA_EMPTY_RESULT";

/// Complete, offline-only configuration for one SenseVoice backend instance.
///
/// Every expected provenance digest must match its descriptor field. Production
/// construction additionally pins the official candidate digests and requires
/// absolute model/tokens paths; `Prepare` resolves and verifies the actual
/// local bytes before creating the recognizer. `execution_provider` is
/// restricted to [`ExecutionProvider::Cpu`].
#[derive(Clone)]
pub struct SherpaNativeConfig {
    pub descriptor: EngineDescriptor,
    pub model_path: PathBuf,
    pub expected_model_sha256: Sha256Digest,
    pub tokens_path: PathBuf,
    pub expected_tokens_sha256: Sha256Digest,
    pub runtime_lib_dir: PathBuf,
    pub expected_runtime_sha256: Sha256Digest,
    pub asset_lock_path: PathBuf,
    pub expected_asset_lock_sha256: Sha256Digest,
    pub package_lock_path: PathBuf,
    pub expected_package_lock_sha256: Sha256Digest,
    pub normalized_language: LanguageCode,
    pub execution_provider: ExecutionProvider,
    pub num_threads: u32,
    pub use_itn: bool,
    pub max_input_bytes: u64,
}

impl SherpaNativeConfig {
    /// Validates adapter-owned structure without reading local assets.
    pub fn validate(&self) -> Result<(), SherpaConfigError> {
        if self.model_path.as_os_str().is_empty()
            || self.tokens_path.as_os_str().is_empty()
            || self.runtime_lib_dir.as_os_str().is_empty()
            || self.asset_lock_path.as_os_str().is_empty()
            || self.package_lock_path.as_os_str().is_empty()
        {
            return Err(SherpaConfigError::EmptyAssetPath);
        }
        if self.expected_model_sha256.is_zero()
            || self.expected_tokens_sha256.is_zero()
            || self.expected_runtime_sha256.is_zero()
            || self.expected_asset_lock_sha256.is_zero()
            || self.expected_package_lock_sha256.is_zero()
        {
            return Err(SherpaConfigError::ZeroAssetDigest);
        }
        if self.expected_model_sha256 != self.descriptor.model_sha256 {
            return Err(SherpaConfigError::ModelDigestConflict);
        }
        if self.expected_runtime_sha256 != self.descriptor.runtime_sha256 {
            return Err(SherpaConfigError::RuntimeDigestConflict);
        }
        if self.expected_asset_lock_sha256 != self.descriptor.model_manifest_sha256 {
            return Err(SherpaConfigError::AssetLockDigestConflict);
        }
        if self.expected_package_lock_sha256 != self.descriptor.package_lock_sha256 {
            return Err(SherpaConfigError::PackageLockDigestConflict);
        }
        if self.descriptor.engine_id.as_str() != ENGINE_ID
            || self.descriptor.engine_version.as_str() != ENGINE_VERSION
            || self.descriptor.runtime_id.as_str() != RUNTIME_ID
            || self.descriptor.runtime_version.as_str() != RUNTIME_VERSION
            || self.descriptor.model_id.as_str() != MODEL_ID
            || self.descriptor.model_license_id.as_str() != MODEL_LICENSE_ID
            || self.descriptor.quantization.as_str() != QUANTIZATION
        {
            return Err(SherpaConfigError::CandidateIdentityConflict);
        }
        if self.execution_provider != ExecutionProvider::Cpu
            || self.descriptor.execution_provider != ExecutionProvider::Cpu
        {
            return Err(SherpaConfigError::UnsupportedExecutionProvider);
        }
        if self.descriptor.runtime_sha256.is_zero()
            || self.descriptor.package_lock_sha256.is_zero()
            || self.descriptor.model_manifest_sha256.is_zero()
            || self.descriptor.parameter_sha256.is_zero()
            || self.descriptor.languages.is_empty()
            || self.descriptor.languages.len() > EngineDescriptor::MAX_LANGUAGES
            || self
                .descriptor
                .languages
                .windows(2)
                .any(|pair| pair[0].as_str() >= pair[1].as_str())
            || !self.descriptor.streaming
            || !self.descriptor.offline
        {
            return Err(SherpaConfigError::InvalidEngineDescriptor);
        }
        if self
            .descriptor
            .languages
            .binary_search(&self.normalized_language)
            .is_err()
        {
            return Err(SherpaConfigError::LanguageNotDeclared);
        }
        if self.num_threads == 0 || self.num_threads > i32::MAX as u32 {
            return Err(SherpaConfigError::InvalidThreadCount);
        }
        if self.max_input_bytes == 0 || self.max_input_bytes > MAX_BACKEND_INPUT_BYTES {
            return Err(SherpaConfigError::InvalidInputBound);
        }
        if self.descriptor.parameter_sha256 != self.parameter_sha256() {
            return Err(SherpaConfigError::ParameterDigestConflict);
        }
        Ok(())
    }

    /// Returns the canonical SHA-256 identity for adapter-owned inference
    /// parameters. The field order and JSON representation are frozen by the
    /// external asset lock and intentionally require no serialization crate.
    #[must_use]
    pub fn parameter_canonical_json(&self) -> String {
        format!(
            concat!(
                "{{\"blank_penalty\":0,\"bpe_vocab\":null,\"channels\":1,",
                "\"debug\":false,\"decoding_method\":\"greedy_search\",",
                "\"feature_dim\":80,\"homophone_lexicon\":null,",
                "\"homophone_rule_fsts\":null,\"hotwords_file\":null,",
                "\"hotwords_score\":0,\"language\":\"{}\",\"lm_model\":null,",
                "\"lm_scale\":1,\"max_active_paths\":4,\"max_input_bytes\":{},",
                "\"model_family\":\"sense_voice\",\"model_type\":null,",
                "\"modeling_unit\":null,\"num_threads\":{},\"provider\":\"cpu\",",
                "\"rule_fars\":null,\"rule_fsts\":null,\"sample_rate_hz\":16000,",
                "\"telespeech_ctc\":null,\"use_itn\":{}}}"
            ),
            self.normalized_language.as_str(),
            self.max_input_bytes,
            self.num_threads,
            self.use_itn,
        )
    }

    #[must_use]
    pub fn parameter_sha256(&self) -> Sha256Digest {
        Sha256Digest::from_bytes(Sha256::digest(self.parameter_canonical_json().as_bytes()).into())
    }

    #[cfg(any(feature = "native-sherpa", test))]
    fn validate_locked_candidate(&self) -> Result<(), SherpaConfigError> {
        self.validate()?;
        let locked_descriptor = locked_engine_descriptor();
        if self.descriptor != locked_descriptor
            || self.expected_model_sha256 != locked_descriptor.model_sha256
            || self.expected_tokens_sha256 != locked_digest(LOCKED_TOKENS_SHA256_HEX)
            || self.expected_runtime_sha256 != locked_descriptor.runtime_sha256
            || self.expected_asset_lock_sha256 != locked_descriptor.model_manifest_sha256
            || self.expected_package_lock_sha256 != locked_descriptor.package_lock_sha256
            || self.parameter_canonical_json() != LOCKED_PARAMETER_CANONICAL_JSON
            || !self.model_path.is_absolute()
            || !self.tokens_path.is_absolute()
        {
            return Err(SherpaConfigError::LockedCandidateConflict);
        }
        Ok(())
    }

    #[cfg(feature = "native-quality-sample")]
    fn validate_locked_quality_candidate(&self) -> Result<(), SherpaConfigError> {
        self.validate()?;
        let locked_descriptor = locked_engine_descriptor();
        let mut base_descriptor = self.descriptor.clone();
        base_descriptor.parameter_sha256 = locked_descriptor.parameter_sha256;
        base_descriptor.languages = locked_descriptor.languages.clone();
        if base_descriptor != locked_descriptor
            || self.expected_model_sha256 != locked_descriptor.model_sha256
            || self.expected_tokens_sha256 != locked_digest(LOCKED_TOKENS_SHA256_HEX)
            || self.expected_runtime_sha256 != locked_descriptor.runtime_sha256
            || self.expected_asset_lock_sha256 != locked_descriptor.model_manifest_sha256
            || self.expected_package_lock_sha256 != locked_descriptor.package_lock_sha256
            || !matches!(self.normalized_language.as_str(), "zh" | "ja" | "en")
            || self.descriptor.languages.len() != 1
            || self.descriptor.languages[0] != self.normalized_language
            || self.num_threads != 1
            || !self.use_itn
            || self.max_input_bytes != 64 * 1024 * 1024
            || !self.model_path.is_absolute()
            || !self.tokens_path.is_absolute()
        {
            return Err(SherpaConfigError::LockedCandidateConflict);
        }
        Ok(())
    }
}

/// Configuration error that does not expose local asset paths.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SherpaConfigError {
    NativeFeatureDisabled,
    EmptyAssetPath,
    ZeroAssetDigest,
    ModelDigestConflict,
    RuntimeDigestConflict,
    AssetLockDigestConflict,
    PackageLockDigestConflict,
    CandidateIdentityConflict,
    UnsupportedExecutionProvider,
    InvalidEngineDescriptor,
    LanguageNotDeclared,
    InvalidThreadCount,
    InvalidInputBound,
    ParameterDigestConflict,
    LockedCandidateConflict,
}

impl fmt::Display for SherpaConfigError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::NativeFeatureDisabled => "the native-sherpa feature is disabled",
            Self::EmptyAssetPath => "a local asset path is empty",
            Self::ZeroAssetDigest => "an expected asset digest is zero",
            Self::ModelDigestConflict => "model digest conflicts with the engine descriptor",
            Self::RuntimeDigestConflict => "runtime digest conflicts with the engine descriptor",
            Self::AssetLockDigestConflict => {
                "asset-lock digest conflicts with the engine descriptor"
            }
            Self::PackageLockDigestConflict => {
                "package-lock digest conflicts with the engine descriptor"
            }
            Self::CandidateIdentityConflict => {
                "engine, runtime, model, license, or quantization identity differs from the lock"
            }
            Self::UnsupportedExecutionProvider => "only the CPU execution provider is supported",
            Self::InvalidEngineDescriptor => "the engine descriptor violates backend constraints",
            Self::LanguageNotDeclared => "the configured language is not declared by the engine",
            Self::InvalidThreadCount => "the native thread count is outside the supported range",
            Self::InvalidInputBound => "the backend input bound is outside the supported range",
            Self::ParameterDigestConflict => "adapter parameters differ from the descriptor digest",
            Self::LockedCandidateConflict => "configuration differs from the sealed candidate",
        })
    }
}

impl std::error::Error for SherpaConfigError {}

/// Prepared, offline SenseVoice adapter implementing the model-worker seam.
pub struct SherpaNativeBackend {
    config: SherpaNativeConfig,
    port: Box<dyn InferencePort>,
    assets_verified: bool,
    initialized: bool,
    verification: VerificationMode,
    sealed_model_assets: Option<SealedModelAssets>,
}

struct SealedModelAssets {
    _model: File,
    _tokens: File,
}

#[derive(Clone, Copy)]
enum VerificationMode {
    #[cfg(feature = "native-sherpa")]
    LockedProduction,
    #[cfg(feature = "native-sherpa")]
    LocalMvp,
    #[cfg(test)]
    StructuralTest,
}

impl SherpaNativeBackend {
    pub fn new(config: SherpaNativeConfig) -> Result<Self, SherpaConfigError> {
        #[cfg(not(feature = "native-sherpa"))]
        {
            let _ = config;
            Err(SherpaConfigError::NativeFeatureDisabled)
        }
        #[cfg(feature = "native-sherpa")]
        {
            config.validate_locked_candidate()?;
            Ok(Self {
                config,
                port: default_inference_port(),
                assets_verified: false,
                initialized: false,
                verification: VerificationMode::LockedProduction,
                sealed_model_assets: None,
            })
        }
    }

    #[cfg(feature = "native-sherpa")]
    fn new_local_mvp(config: SherpaNativeConfig) -> Result<Self, SherpaConfigError> {
        config.validate()?;
        Ok(Self {
            config,
            port: default_inference_port(),
            assets_verified: false,
            initialized: false,
            verification: VerificationMode::LocalMvp,
            sealed_model_assets: None,
        })
    }

    #[cfg(feature = "native-quality-sample")]
    fn new_quality_sample(config: SherpaNativeConfig) -> Result<Self, SherpaConfigError> {
        config.validate_locked_quality_candidate()?;
        Ok(Self {
            config,
            port: default_inference_port(),
            assets_verified: false,
            initialized: false,
            verification: VerificationMode::LockedProduction,
            sealed_model_assets: None,
        })
    }

    fn process(&mut self, chunks: &[AudioChunk]) -> Result<TranscriptResult, AdapterFailure> {
        let text = self.recognize_text(chunks)?;
        if text.trim().is_empty() {
            return Err(AdapterFailure::EmptyResult);
        }
        let original_transcript =
            TranscriptText::new(&text).map_err(|_| AdapterFailure::ResultUnavailable)?;
        let raw_language = SanitizedText::new(self.config.normalized_language.as_str())
            .map_err(|_| AdapterFailure::ResultUnavailable)?;
        Ok(TranscriptResult {
            original_transcript,
            raw_language,
            normalized_language: self.config.normalized_language.clone(),
            confidence: None,
            provenance: TranscriptProvenance::from_descriptor(&self.config.descriptor),
        })
    }

    fn recognize_text(&mut self, chunks: &[AudioChunk]) -> Result<String, AdapterFailure> {
        if !self.initialized {
            return Err(AdapterFailure::NotPrepared);
        }
        let samples = canonical_samples(chunks, self.config.max_input_bytes)?;
        self.port
            .recognize(&samples)
            .map_err(|_| AdapterFailure::ResultUnavailable)?
            .ok_or(AdapterFailure::ResultUnavailable)
    }

    #[cfg(feature = "native-quality-sample")]
    fn recognize_quality_sample_text(
        &mut self,
        chunks: &[AudioChunk],
    ) -> Result<String, AdapterFailure> {
        self.recognize_text(chunks)
    }

    #[cfg(test)]
    fn with_port(
        config: SherpaNativeConfig,
        port: impl InferencePort + 'static,
    ) -> Result<Self, SherpaConfigError> {
        config.validate()?;
        Ok(Self {
            config,
            port: Box::new(port),
            assets_verified: false,
            initialized: false,
            verification: VerificationMode::StructuralTest,
            sealed_model_assets: None,
        })
    }

    fn prepare_recognizer(&mut self) -> Result<(), AdapterFailure> {
        if self.initialized {
            return Ok(());
        }
        #[cfg(feature = "native-sherpa")]
        if matches!(
            self.verification,
            VerificationMode::LockedProduction | VerificationMode::LocalMvp
        ) {
            resolve_production_model_paths(&mut self.config)?;
        }
        let sealed_model_assets = verify_configured_assets(&self.config, self.verification)?;
        self.assets_verified = true;
        if self.port.initialize(&self.config).is_err() {
            return Err(AdapterFailure::InitFailed);
        }
        self.sealed_model_assets = sealed_model_assets;
        self.initialized = true;
        Ok(())
    }
}

#[cfg(any(feature = "native-sherpa", test))]
fn resolve_production_model_paths(config: &mut SherpaNativeConfig) -> Result<(), AdapterFailure> {
    if !config.model_path.is_absolute() || !config.tokens_path.is_absolute() {
        return Err(AdapterFailure::AssetMismatch);
    }
    let model =
        std::fs::canonicalize(&config.model_path).map_err(|_| AdapterFailure::AssetMismatch)?;
    let tokens =
        std::fs::canonicalize(&config.tokens_path).map_err(|_| AdapterFailure::AssetMismatch)?;
    if !model.is_absolute() || !tokens.is_absolute() {
        return Err(AdapterFailure::AssetMismatch);
    }
    config.model_path = model;
    config.tokens_path = tokens;
    Ok(())
}

impl fmt::Debug for SherpaNativeBackend {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SherpaNativeBackend")
            .field("assets_verified", &self.assets_verified)
            .field("initialized", &self.initialized)
            .field("model_assets_sealed", &self.sealed_model_assets.is_some())
            .finish_non_exhaustive()
    }
}

impl ModelBackend for SherpaNativeBackend {
    fn prepare(&mut self) -> Result<(), BackendFailure> {
        self.prepare_recognizer()
            .map_err(AdapterFailure::backend_failure)
    }

    fn execute(&mut self, action: &BackendAction) -> BackendOutcome {
        match self.process(action.audio_chunks()) {
            Ok(result) => action.completed(result),
            Err(failure) => action.failed(failure.backend_failure()),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum AdapterFailure {
    AssetMismatch,
    NotPrepared,
    UnsupportedAudio,
    InputTooLarge,
    InitFailed,
    ResultUnavailable,
    EmptyResult,
}

impl AdapterFailure {
    const fn code(self) -> &'static str {
        match self {
            Self::AssetMismatch => ASSET_MISMATCH,
            Self::NotPrepared => NOT_PREPARED,
            Self::UnsupportedAudio => UNSUPPORTED_AUDIO,
            Self::InputTooLarge => INPUT_TOO_LARGE,
            Self::InitFailed => INIT_FAILED,
            Self::ResultUnavailable => RESULT_UNAVAILABLE,
            Self::EmptyResult => EMPTY_RESULT,
        }
    }

    fn backend_failure(self) -> BackendFailure {
        BackendFailure::new(
            Identifier::new(self.code()).expect("stable sherpa failure code is constant-valid"),
            false,
            None,
        )
    }
}

fn canonical_samples(
    chunks: &[AudioChunk],
    max_input_bytes: u64,
) -> Result<Vec<f32>, AdapterFailure> {
    let first_format = chunks
        .first()
        .map(|chunk| chunk.format)
        .ok_or(AdapterFailure::UnsupportedAudio)?;
    if first_format.sample_rate_hz != REQUIRED_SAMPLE_RATE_HZ
        || first_format.channels != REQUIRED_CHANNELS
    {
        return Err(AdapterFailure::UnsupportedAudio);
    }

    let mut total_bytes = 0_u64;
    let mut samples = Vec::new();
    for chunk in chunks {
        if chunk.format != first_format
            || chunk.timeline_rate != REQUIRED_SAMPLE_RATE_HZ
            || chunk.format.sample_rate_hz != REQUIRED_SAMPLE_RATE_HZ
            || chunk.format.channels != REQUIRED_CHANNELS
        {
            return Err(AdapterFailure::UnsupportedAudio);
        }
        let payload = chunk
            .payload
            .as_ref()
            .ok_or(AdapterFailure::UnsupportedAudio)?;
        if payload.sample_format() != chunk.format.sample_format {
            return Err(AdapterFailure::UnsupportedAudio);
        }
        let expected_digest = chunk
            .payload_sha256
            .ok_or(AdapterFailure::UnsupportedAudio)?;
        let canonical_bytes = payload
            .payload_bytes()
            .map_err(|_| AdapterFailure::UnsupportedAudio)?;
        if canonical_bytes == 0 || canonical_bytes != chunk.payload_bytes {
            return Err(AdapterFailure::UnsupportedAudio);
        }
        total_bytes = total_bytes
            .checked_add(canonical_bytes)
            .ok_or(AdapterFailure::InputTooLarge)?;
        if total_bytes > max_input_bytes {
            return Err(AdapterFailure::InputTooLarge);
        }

        let mut hasher = Sha256::new();
        match payload {
            AudioPayload::PcmS16Le(chunk_samples) => {
                samples.reserve(chunk_samples.len());
                for sample in chunk_samples.iter().copied() {
                    hasher.update(sample.to_le_bytes());
                    samples.push(f32::from(sample) / 32_768.0);
                }
            }
            AudioPayload::PcmF32Le(chunk_samples) => {
                samples.reserve(chunk_samples.len());
                for sample in chunk_samples.iter().copied() {
                    if !sample.is_finite() || !(-1.0..=1.0).contains(&sample) {
                        return Err(AdapterFailure::UnsupportedAudio);
                    }
                    hasher.update(sample.to_bits().to_le_bytes());
                    samples.push(sample);
                }
            }
        }
        if Sha256Digest::from_bytes(hasher.finalize().into()) != expected_digest {
            return Err(AdapterFailure::UnsupportedAudio);
        }
    }
    Ok(samples)
}

fn verify_asset(path: &Path, expected: Sha256Digest) -> Result<(), AdapterFailure> {
    let actual = sha256_file(path).map_err(|_| AdapterFailure::AssetMismatch)?;
    if actual == expected {
        Ok(())
    } else {
        Err(AdapterFailure::AssetMismatch)
    }
}

fn verify_configured_assets(
    config: &SherpaNativeConfig,
    verification: VerificationMode,
) -> Result<Option<SealedModelAssets>, AdapterFailure> {
    verify_asset(&config.asset_lock_path, config.expected_asset_lock_sha256)?;
    verify_asset(
        &config.package_lock_path,
        config.expected_package_lock_sha256,
    )?;
    match verification {
        #[cfg(feature = "native-sherpa")]
        VerificationMode::LockedProduction => {
            verify_locked_runtime(&config.runtime_lib_dir)?;
            open_and_verify_model_assets(config).map(Some)
        }
        #[cfg(feature = "native-sherpa")]
        VerificationMode::LocalMvp => {
            verify_locked_runtime(&config.runtime_lib_dir)?;
            open_and_verify_model_assets(config).map(Some)
        }
        #[cfg(test)]
        VerificationMode::StructuralTest => {
            verify_asset(&config.model_path, config.expected_model_sha256)?;
            verify_asset(&config.tokens_path, config.expected_tokens_sha256)?;
            verify_asset(
                &config.runtime_lib_dir.join("runtime.bundle.fixture"),
                config.expected_runtime_sha256,
            )?;
            Ok(None)
        }
    }
}

#[cfg(any(feature = "native-sherpa", test))]
fn open_and_verify_model_assets(
    config: &SherpaNativeConfig,
) -> Result<SealedModelAssets, AdapterFailure> {
    let mut model = open_sealed_read(&config.model_path)?;
    let mut tokens = open_sealed_read(&config.tokens_path)?;
    verify_open_asset(&mut model, config.expected_model_sha256)?;
    verify_open_asset(&mut tokens, config.expected_tokens_sha256)?;
    Ok(SealedModelAssets {
        _model: model,
        _tokens: tokens,
    })
}

#[cfg(all(windows, any(feature = "native-sherpa", test)))]
fn open_sealed_read(path: &Path) -> Result<File, AdapterFailure> {
    const FILE_SHARE_READ: u32 = 0x0000_0001;
    OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ)
        .open(path)
        .map_err(|_| AdapterFailure::AssetMismatch)
}

#[cfg(all(not(windows), any(feature = "native-sherpa", test)))]
fn open_sealed_read(path: &Path) -> Result<File, AdapterFailure> {
    OpenOptions::new()
        .read(true)
        .open(path)
        .map_err(|_| AdapterFailure::AssetMismatch)
}

#[cfg(any(feature = "native-sherpa", test))]
fn verify_open_asset(file: &mut File, expected: Sha256Digest) -> Result<(), AdapterFailure> {
    let actual = sha256_reader(file).map_err(|_| AdapterFailure::AssetMismatch)?;
    if actual == expected {
        Ok(())
    } else {
        Err(AdapterFailure::AssetMismatch)
    }
}

#[cfg(feature = "native-sherpa")]
fn verify_locked_runtime(runtime_lib_dir: &Path) -> Result<(), AdapterFailure> {
    let entries = fs::read_dir(runtime_lib_dir).map_err(|_| AdapterFailure::AssetMismatch)?;
    let mut entry_count = 0_usize;
    for entry in entries {
        let entry = entry.map_err(|_| AdapterFailure::AssetMismatch)?;
        entry_count = entry_count
            .checked_add(1)
            .ok_or(AdapterFailure::AssetMismatch)?;
        let file_type = entry
            .file_type()
            .map_err(|_| AdapterFailure::AssetMismatch)?;
        let file_name = entry
            .file_name()
            .into_string()
            .map_err(|_| AdapterFailure::AssetMismatch)?;
        if !file_type.is_file() || !RUNTIME_ASSETS.iter().any(|asset| asset.name == file_name) {
            return Err(AdapterFailure::AssetMismatch);
        }
    }
    if entry_count != RUNTIME_ASSETS.len() {
        return Err(AdapterFailure::AssetMismatch);
    }

    for asset in &RUNTIME_ASSETS {
        let path = runtime_lib_dir.join(asset.name);
        let metadata = fs::symlink_metadata(&path).map_err(|_| AdapterFailure::AssetMismatch)?;
        if !metadata.file_type().is_file() || metadata.len() != asset.size_bytes {
            return Err(AdapterFailure::AssetMismatch);
        }
        verify_asset(&path, locked_digest(asset.sha256))?;
    }

    let inventory_digest = Sha256Digest::from_bytes(
        Sha256::digest(RUNTIME_INVENTORY_CANONICAL_JSON.as_bytes()).into(),
    );
    if inventory_digest != locked_digest(LOCKED_RUNTIME_BUNDLE_SHA256_HEX) {
        return Err(AdapterFailure::AssetMismatch);
    }
    Ok(())
}

fn locked_digest(value: &str) -> Sha256Digest {
    Sha256Digest::from_lower_hex(value).expect("committed locked SHA-256 is constant-valid")
}

/// Computes a local file digest without interpreting its contents.
pub fn sha256_file(path: &Path) -> std::io::Result<Sha256Digest> {
    sha256_reader(File::open(path)?)
}

fn sha256_reader(mut reader: impl Read) -> std::io::Result<Sha256Digest> {
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = reader.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(Sha256Digest::from_bytes(hasher.finalize().into()))
}

trait InferencePort: Send {
    fn initialize(&mut self, config: &SherpaNativeConfig) -> Result<(), InferenceError>;
    fn recognize(&mut self, samples: &[f32]) -> Result<Option<String>, InferenceError>;
}

#[derive(Clone, Copy, Debug)]
struct InferenceError;

#[cfg(feature = "native-sherpa")]
#[derive(Default)]
struct OfficialSherpaPort {
    recognizer: Option<sherpa_onnx::OfflineRecognizer>,
}

#[cfg(feature = "native-sherpa")]
impl InferencePort for OfficialSherpaPort {
    fn initialize(&mut self, config: &SherpaNativeConfig) -> Result<(), InferenceError> {
        use sherpa_onnx::{OfflineRecognizerConfig, OfflineSenseVoiceModelConfig};

        let model = config
            .model_path
            .to_str()
            .map(str::to_owned)
            .ok_or(InferenceError)?;
        let tokens = config
            .tokens_path
            .to_str()
            .map(str::to_owned)
            .ok_or(InferenceError)?;
        let mut native = OfflineRecognizerConfig::default();
        native.feat_config.sample_rate = REQUIRED_SAMPLE_RATE_HZ as i32;
        native.feat_config.feature_dim = 80;
        native.model_config.sense_voice = OfflineSenseVoiceModelConfig {
            model: Some(model),
            language: Some(config.normalized_language.as_str().to_owned()),
            use_itn: config.use_itn,
        };
        native.model_config.tokens = Some(tokens);
        native.model_config.num_threads =
            i32::try_from(config.num_threads).map_err(|_| InferenceError)?;
        native.model_config.debug = false;
        native.model_config.provider = Some("cpu".to_owned());
        native.model_config.model_type = None;
        native.model_config.modeling_unit = None;
        native.model_config.bpe_vocab = None;
        native.model_config.telespeech_ctc = None;
        native.lm_config.model = None;
        native.lm_config.scale = 1.0;
        native.decoding_method = Some("greedy_search".to_owned());
        native.max_active_paths = 4;
        native.hotwords_file = None;
        native.hotwords_score = 0.0;
        native.rule_fsts = None;
        native.rule_fars = None;
        native.blank_penalty = 0.0;
        native.hr.lexicon = None;
        native.hr.rule_fsts = None;
        self.recognizer = sherpa_onnx::OfflineRecognizer::create(&native);
        if self.recognizer.is_some() {
            Ok(())
        } else {
            Err(InferenceError)
        }
    }

    fn recognize(&mut self, samples: &[f32]) -> Result<Option<String>, InferenceError> {
        let recognizer = self.recognizer.as_ref().ok_or(InferenceError)?;
        let stream = recognizer.create_stream();
        stream.accept_waveform(REQUIRED_SAMPLE_RATE_HZ as i32, samples);
        recognizer.decode(&stream);
        Ok(stream.get_result().map(|result| result.text))
    }
}

#[cfg(feature = "native-sherpa")]
fn default_inference_port() -> Box<dyn InferencePort> {
    Box::<OfficialSherpaPort>::default()
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{Arc, Mutex};

    use meetingrelay_model_worker_contract::{AudioFormat, AudioSource, SourceRange};

    use super::*;

    static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(1);

    #[derive(Clone, Copy)]
    enum FakeRecognition {
        Text(&'static str),
        Unavailable,
        Error,
    }

    #[derive(Default, Debug)]
    struct Calls {
        initialize: usize,
        recognize: usize,
        observed_samples: Vec<f32>,
    }

    struct FakePort {
        calls: Arc<Mutex<Calls>>,
        init_fails: bool,
        recognition: FakeRecognition,
    }

    impl InferencePort for FakePort {
        fn initialize(&mut self, _config: &SherpaNativeConfig) -> Result<(), InferenceError> {
            self.calls.lock().expect("calls lock").initialize += 1;
            if self.init_fails {
                Err(InferenceError)
            } else {
                Ok(())
            }
        }

        fn recognize(&mut self, samples: &[f32]) -> Result<Option<String>, InferenceError> {
            let mut calls = self.calls.lock().expect("calls lock");
            calls.recognize += 1;
            calls.observed_samples = samples.to_vec();
            match self.recognition {
                FakeRecognition::Text(text) => Ok(Some(text.to_owned())),
                FakeRecognition::Unavailable => Ok(None),
                FakeRecognition::Error => Err(InferenceError),
            }
        }
    }

    struct TestAssets {
        directory: PathBuf,
        model: PathBuf,
        tokens: PathBuf,
        runtime_lib_dir: PathBuf,
        runtime_bundle: PathBuf,
        asset_lock: PathBuf,
        package_lock: PathBuf,
    }

    impl TestAssets {
        fn new() -> Self {
            let sequence = NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed);
            let directory = std::env::temp_dir().join(format!(
                "meetingrelay-sherpa-native-{}-{sequence}",
                std::process::id()
            ));
            fs::create_dir_all(&directory).expect("create test asset directory");
            let model = directory.join("model.onnx");
            let tokens = directory.join("tokens.txt");
            let runtime_lib_dir = directory.join("runtime");
            fs::create_dir_all(&runtime_lib_dir).expect("create test runtime directory");
            let runtime_bundle = runtime_lib_dir.join("runtime.bundle.fixture");
            let asset_lock = directory.join("assets.lock.json");
            let package_lock = directory.join("Cargo.lock");
            fs::write(&model, b"test-model").expect("write model fixture");
            fs::write(&tokens, b"test-tokens").expect("write tokens fixture");
            fs::write(&runtime_bundle, b"test-runtime").expect("write runtime fixture");
            fs::write(&asset_lock, b"test-asset-lock").expect("write asset-lock fixture");
            fs::write(&package_lock, b"test-package-lock").expect("write package-lock fixture");
            Self {
                directory,
                model,
                tokens,
                runtime_lib_dir,
                runtime_bundle,
                asset_lock,
                package_lock,
            }
        }
    }

    impl Drop for TestAssets {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.directory);
        }
    }

    fn id(value: &str) -> Identifier {
        Identifier::new(value).expect("valid fixture identifier")
    }

    fn language(value: &str) -> LanguageCode {
        LanguageCode::new(value).expect("valid fixture language")
    }

    fn digest(byte: u8) -> Sha256Digest {
        Sha256Digest::from_bytes([byte; 32])
    }

    fn descriptor(model_sha256: Sha256Digest) -> EngineDescriptor {
        EngineDescriptor {
            engine_id: id(ENGINE_ID),
            engine_version: id(ENGINE_VERSION),
            runtime_id: id(RUNTIME_ID),
            runtime_version: id(RUNTIME_VERSION),
            runtime_sha256: digest(1),
            package_lock_sha256: digest(2),
            model_id: id(MODEL_ID),
            model_sha256,
            model_manifest_sha256: digest(3),
            model_license_id: id(MODEL_LICENSE_ID),
            parameter_sha256: digest(4),
            execution_provider: ExecutionProvider::Cpu,
            quantization: id("int8"),
            languages: vec![language("en")],
            streaming: true,
            offline: true,
        }
    }

    fn config(assets: &TestAssets) -> SherpaNativeConfig {
        let model_sha256 = sha256_file(&assets.model).expect("hash model fixture");
        let runtime_sha256 = sha256_file(&assets.runtime_bundle).expect("hash runtime fixture");
        let asset_lock_sha256 = sha256_file(&assets.asset_lock).expect("hash asset-lock fixture");
        let package_lock_sha256 =
            sha256_file(&assets.package_lock).expect("hash package-lock fixture");
        let mut config = SherpaNativeConfig {
            descriptor: descriptor(model_sha256),
            model_path: assets.model.clone(),
            expected_model_sha256: model_sha256,
            tokens_path: assets.tokens.clone(),
            expected_tokens_sha256: sha256_file(&assets.tokens).expect("hash tokens fixture"),
            runtime_lib_dir: assets.runtime_lib_dir.clone(),
            expected_runtime_sha256: runtime_sha256,
            asset_lock_path: assets.asset_lock.clone(),
            expected_asset_lock_sha256: asset_lock_sha256,
            package_lock_path: assets.package_lock.clone(),
            expected_package_lock_sha256: package_lock_sha256,
            normalized_language: language("en"),
            execution_provider: ExecutionProvider::Cpu,
            num_threads: 2,
            use_itn: true,
            max_input_bytes: 4_096,
        };
        config.descriptor.runtime_sha256 = runtime_sha256;
        config.descriptor.model_manifest_sha256 = asset_lock_sha256;
        config.descriptor.package_lock_sha256 = package_lock_sha256;
        config.descriptor.parameter_sha256 = config.parameter_sha256();
        config
    }

    fn locked_config(assets: &TestAssets) -> SherpaNativeConfig {
        let mut config = config(assets);
        config.expected_model_sha256 = locked_digest(LOCKED_MODEL_SHA256_HEX);
        config.descriptor.model_sha256 = config.expected_model_sha256;
        config.expected_tokens_sha256 = locked_digest(LOCKED_TOKENS_SHA256_HEX);
        config.expected_runtime_sha256 = locked_digest(LOCKED_RUNTIME_BUNDLE_SHA256_HEX);
        config.descriptor.runtime_sha256 = config.expected_runtime_sha256;
        config.expected_asset_lock_sha256 = locked_digest(LOCKED_ASSET_LOCK_SHA256_HEX);
        config.descriptor.model_manifest_sha256 = config.expected_asset_lock_sha256;
        config.expected_package_lock_sha256 = locked_digest(LOCKED_PACKAGE_LOCK_SHA256_HEX);
        config.descriptor.package_lock_sha256 = config.expected_package_lock_sha256;
        config.normalized_language = language("zh");
        config.descriptor.languages = vec![language("zh")];
        config.num_threads = 1;
        config.max_input_bytes = 64 * 1024 * 1024;
        config.descriptor.parameter_sha256 = config.parameter_sha256();
        config
    }

    fn payload_digest(payload: &AudioPayload) -> Sha256Digest {
        let mut hasher = Sha256::new();
        match payload {
            AudioPayload::PcmS16Le(samples) => {
                for sample in samples.iter() {
                    hasher.update(sample.to_le_bytes());
                }
            }
            AudioPayload::PcmF32Le(samples) => {
                for sample in samples.iter() {
                    hasher.update(sample.to_bits().to_le_bytes());
                }
            }
        }
        Sha256Digest::from_bytes(hasher.finalize().into())
    }

    fn chunk(payload: AudioPayload) -> AudioChunk {
        let sample_format = payload.sample_format();
        let payload_bytes = payload.payload_bytes().expect("fixture payload bytes");
        let sample_count = u64::try_from(payload.sample_count()).expect("fixture sample count");
        let epoch = id("test-epoch");
        AudioChunk {
            sequence: 1,
            media_start_sample: 0,
            media_end_sample: sample_count,
            timeline_rate: REQUIRED_SAMPLE_RATE_HZ,
            format: AudioFormat {
                sample_rate_hz: REQUIRED_SAMPLE_RATE_HZ,
                channels: REQUIRED_CHANNELS,
                sample_format,
            },
            capture_epoch_ids: vec![epoch.clone()],
            source_ranges: vec![SourceRange {
                audio_source: AudioSource::System,
                capture_epoch_id: epoch,
                device_start_sample: 0,
                device_end_sample: sample_count,
                meeting_start_sample: 0,
                meeting_end_sample: sample_count,
                sample_rate_hz: REQUIRED_SAMPLE_RATE_HZ,
            }],
            payload_bytes,
            payload_sha256: Some(payload_digest(&payload)),
            payload: Some(payload),
        }
    }

    fn backend(
        config: SherpaNativeConfig,
        init_fails: bool,
        recognition: FakeRecognition,
    ) -> (SherpaNativeBackend, Arc<Mutex<Calls>>) {
        let calls = Arc::new(Mutex::new(Calls::default()));
        let backend = SherpaNativeBackend::with_port(
            config,
            FakePort {
                calls: Arc::clone(&calls),
                init_fails,
                recognition,
            },
        )
        .expect("valid test backend");
        (backend, calls)
    }

    fn realtime_paths(assets: &TestAssets) -> LockedSherpaRealtimePaths {
        LockedSherpaRealtimePaths {
            model_path: assets.model.clone(),
            tokens_path: assets.tokens.clone(),
            runtime_lib_dir: assets.runtime_lib_dir.clone(),
            asset_lock_path: assets.asset_lock.clone(),
            package_lock_path: assets.package_lock.clone(),
        }
    }

    #[test]
    fn canonical_s16_hash_and_conversion_are_little_endian() {
        let assets = TestAssets::new();
        let (mut backend, calls) =
            backend(config(&assets), false, FakeRecognition::Text("recognized"));
        let audio = chunk(AudioPayload::PcmS16Le(Arc::from([
            i16::MIN,
            -1,
            0,
            1,
            i16::MAX,
        ])));
        assert_eq!(
            audio.payload_sha256.expect("fixture digest").to_lower_hex(),
            "556753b4da9b39610600e40b9673205bc62e4df0f649c9957c6282bd59ab42a0"
        );

        backend.prepare_recognizer().expect("prepare recognizer");
        backend.process(&[audio]).expect("valid s16 audio");

        let calls = calls.lock().expect("calls lock");
        assert_eq!(calls.observed_samples[0], -1.0);
        assert_eq!(calls.observed_samples[1], -1.0 / 32_768.0);
        assert_eq!(calls.observed_samples[2], 0.0);
        assert_eq!(calls.observed_samples[3], 1.0 / 32_768.0);
        assert_eq!(calls.observed_samples[4], 32_767.0 / 32_768.0);
    }

    #[test]
    fn canonical_f32_hash_preserves_bits_and_rejects_malformed_values() {
        let payload = AudioPayload::PcmF32Le(Arc::from([-1.0_f32, -0.0, 0.25, 1.0]));
        assert_eq!(
            payload_digest(&payload).to_lower_hex(),
            "484f70623e30298109ae30916b0b440ecd7cc2489832fecd95c9cbdd32ce8743"
        );
        for invalid in [f32::NAN, f32::INFINITY, -1.000_001, 1.000_001] {
            let error = canonical_samples(
                &[chunk(AudioPayload::PcmF32Le(Arc::from([invalid])))],
                4_096,
            )
            .expect_err("invalid f32 must fail");
            assert_eq!(error, AdapterFailure::UnsupportedAudio);
        }
    }

    #[test]
    fn caller_pcm_digest_is_recomputed_before_inference() {
        let assets = TestAssets::new();
        let (mut backend, calls) =
            backend(config(&assets), false, FakeRecognition::Text("recognized"));
        let mut audio = chunk(AudioPayload::PcmS16Le(Arc::from([1_i16, 2, 3])));
        audio.payload_sha256 = Some(digest(99));
        backend.prepare_recognizer().expect("prepare recognizer");

        let error = backend
            .process(&[audio])
            .expect_err("digest mismatch must fail");

        assert_eq!(error, AdapterFailure::UnsupportedAudio);
        assert_eq!(calls.lock().expect("calls lock").initialize, 1);
    }

    #[test]
    fn model_or_tokens_digest_mismatch_fails_before_initialization() {
        for mismatch in ["model", "tokens"] {
            let assets = TestAssets::new();
            let mut invalid = config(&assets);
            if mismatch == "model" {
                invalid.expected_model_sha256 = digest(77);
                invalid.descriptor.model_sha256 = digest(77);
            } else {
                invalid.expected_tokens_sha256 = digest(77);
            }
            let (mut backend, calls) = backend(invalid, false, FakeRecognition::Text("recognized"));

            let error = backend
                .prepare_recognizer()
                .expect_err("asset mismatch must fail");

            assert_eq!(error.code(), ASSET_MISMATCH, "{mismatch} mismatch");
            assert_eq!(
                calls.lock().expect("calls lock").initialize,
                0,
                "{mismatch} mismatch"
            );
        }
    }

    #[test]
    fn aggregate_input_bound_is_checked_after_prepare_without_reinitialization() {
        let assets = TestAssets::new();
        let mut bounded = config(&assets);
        bounded.max_input_bytes = 3;
        bounded.descriptor.parameter_sha256 = bounded.parameter_sha256();
        let (mut backend, calls) = backend(bounded, false, FakeRecognition::Text("recognized"));
        backend.prepare_recognizer().expect("prepare recognizer");

        let error = backend
            .process(&[chunk(AudioPayload::PcmS16Le(Arc::from([1_i16, 2])))])
            .expect_err("oversized input must fail");

        assert_eq!(error.code(), INPUT_TOO_LARGE);
        assert_eq!(calls.lock().expect("calls lock").initialize, 1);
    }

    #[test]
    fn init_result_and_empty_failures_have_stable_sanitized_codes() {
        let assets = TestAssets::new();
        let (mut failing_backend, _) =
            backend(config(&assets), true, FakeRecognition::Text("unused"));
        let failure = failing_backend
            .prepare_recognizer()
            .expect_err("planned initialization failure");
        let mapped = failure.backend_failure();
        assert_eq!(failure.code(), INIT_FAILED);
        assert!(!mapped.retryable);
        assert!(mapped.sanitized_detail.is_none());
        #[cfg(windows)]
        assert!(
            OpenOptions::new().write(true).open(&assets.model).is_ok(),
            "failed initialization must release sealed handles for recovery"
        );

        let cases = [
            (FakeRecognition::Unavailable, RESULT_UNAVAILABLE),
            (FakeRecognition::Error, RESULT_UNAVAILABLE),
            (FakeRecognition::Text("  "), EMPTY_RESULT),
        ];
        for (recognition, expected_code) in cases {
            let assets = TestAssets::new();
            let (mut backend, _) = backend(config(&assets), false, recognition);
            backend.prepare_recognizer().expect("prepare recognizer");
            let failure = backend
                .process(&[chunk(AudioPayload::PcmS16Le(Arc::from([1_i16])))])
                .expect_err("planned backend failure");
            let mapped = failure.backend_failure();
            assert_eq!(failure.code(), expected_code);
            assert!(!mapped.retryable);
            assert!(mapped.sanitized_detail.is_none());
        }
    }

    #[test]
    fn success_has_explicit_language_no_confidence_and_full_provenance() {
        let assets = TestAssets::new();
        let config = config(&assets);
        let expected_provenance = TranscriptProvenance::from_descriptor(&config.descriptor);
        let (mut backend, _) = backend(config, false, FakeRecognition::Text("meeting transcript"));
        backend.prepare_recognizer().expect("prepare recognizer");

        let result = backend
            .process(&[chunk(AudioPayload::PcmF32Le(Arc::from([0.25_f32])))])
            .expect("successful inference mapping");

        assert_eq!(result.original_transcript.as_str(), "meeting transcript");
        assert_eq!(result.raw_language.as_str(), "en");
        assert_eq!(result.normalized_language.as_str(), "en");
        assert_eq!(result.confidence, None);
        assert_eq!(result.provenance, expected_provenance);
    }

    #[test]
    fn prepare_initializes_once_and_execute_never_initializes() {
        let assets = TestAssets::new();
        let (mut backend, calls) =
            backend(config(&assets), false, FakeRecognition::Text("recognized"));
        assert_eq!(calls.lock().expect("calls lock").initialize, 0);
        let audio = chunk(AudioPayload::PcmS16Le(Arc::from([1_i16, 2])));

        ModelBackend::prepare(&mut backend).expect("first prepare");
        ModelBackend::prepare(&mut backend).expect("idempotent prepare");
        assert_eq!(calls.lock().expect("calls lock").initialize, 1);
        backend
            .process(std::slice::from_ref(&audio))
            .expect("first action");
        backend.process(&[audio]).expect("second action");

        let calls = calls.lock().expect("calls lock");
        assert_eq!(calls.initialize, 1);
        assert_eq!(calls.recognize, 2);
    }

    #[test]
    fn realtime_locked_config_is_the_exact_zh_cpu_candidate() {
        let assets = TestAssets::new();
        let config = realtime::locked_zh_cpu_config(&realtime_paths(&assets))
            .expect("locked realtime config");

        assert_eq!(config.descriptor, locked_engine_descriptor());
        assert_eq!(config.normalized_language.as_str(), "zh");
        assert_eq!(config.execution_provider, ExecutionProvider::Cpu);
        assert_eq!(config.num_threads, 1);
        assert!(config.use_itn);
        assert_eq!(config.max_input_bytes, LOCKED_REALTIME_MAX_PCM16_BYTES);
        assert_eq!(
            config.expected_tokens_sha256,
            locked_digest(LOCKED_TOKENS_SHA256_HEX)
        );
        assert_eq!(config.validate_locked_candidate(), Ok(()));
    }

    #[test]
    fn realtime_prepares_once_and_reuses_the_backend_for_repeated_segments() {
        let assets = TestAssets::new();
        let (backend, calls) = backend(config(&assets), false, FakeRecognition::Text("recognized"));
        let mut realtime =
            LockedSherpaRealtime::from_test_backend(backend).expect("prepare realtime backend");

        let first = realtime
            .transcribe_mono_16khz_pcm16(Arc::from([1_i16, -2]))
            .expect("first segment");
        let second = realtime
            .transcribe_mono_16khz_pcm16(Arc::from([3_i16, -4, 5]))
            .expect("second segment");

        assert_eq!(first.original_transcript.as_str(), "recognized");
        assert_eq!(second.original_transcript.as_str(), "recognized");
        let calls = calls.lock().expect("calls lock");
        assert_eq!(calls.initialize, 1);
        assert_eq!(calls.recognize, 2);
        assert_eq!(
            calls.observed_samples,
            vec![3.0 / 32_768.0, -4.0 / 32_768.0, 5.0 / 32_768.0]
        );
    }

    #[test]
    fn realtime_rejects_empty_and_oversized_segments_before_inference() {
        let assets = TestAssets::new();
        let mut bounded = config(&assets);
        bounded.max_input_bytes = 3;
        bounded.descriptor.parameter_sha256 = bounded.parameter_sha256();
        let (backend, calls) = backend(bounded, false, FakeRecognition::Text("unused"));
        let mut realtime = LockedSherpaRealtime::from_test_backend(backend)
            .expect("prepare bounded realtime backend");

        assert_eq!(
            realtime
                .transcribe_mono_16khz_pcm16(Arc::<[i16]>::from([]))
                .map(|_| ()),
            Err(LockedSherpaRealtimeError::EmptySegment)
        );
        assert_eq!(
            realtime
                .transcribe_mono_16khz_pcm16(Arc::from([1_i16, 2]))
                .map(|_| ()),
            Err(LockedSherpaRealtimeError::SegmentTooLarge)
        );

        let calls = calls.lock().expect("calls lock");
        assert_eq!(calls.initialize, 1);
        assert_eq!(calls.recognize, 0);
    }

    #[test]
    fn realtime_rejects_relative_paths_with_a_stable_path_free_code() {
        let relative = PathBuf::from("relative");
        let paths = LockedSherpaRealtimePaths {
            model_path: relative.join("model.int8.onnx"),
            tokens_path: relative.join("tokens.txt"),
            runtime_lib_dir: relative.join("runtime"),
            asset_lock_path: relative.join("assets.lock.json"),
            package_lock_path: relative.join("Cargo.lock"),
        };

        let error = LockedSherpaRealtime::prepare(paths)
            .map(|_| ())
            .expect_err("relative paths must fail before native construction");
        assert_eq!(error, LockedSherpaRealtimeError::InvalidAssetPaths);
        assert_eq!(error.code(), "SHERPA_REALTIME_INVALID_ASSET_PATHS");
        assert_eq!(error.to_string(), error.code());
    }

    #[test]
    fn execute_before_prepare_fails_without_initializing() {
        let assets = TestAssets::new();
        let (mut backend, calls) =
            backend(config(&assets), false, FakeRecognition::Text("recognized"));

        let failure = backend
            .process(&[chunk(AudioPayload::PcmS16Le(Arc::from([1_i16])))])
            .expect_err("execute must not hide cold initialization");

        assert_eq!(failure, AdapterFailure::NotPrepared);
        let calls = calls.lock().expect("calls lock");
        assert_eq!(calls.initialize, 0);
        assert_eq!(calls.recognize, 0);
    }

    #[cfg(windows)]
    #[test]
    fn sealed_model_handles_reject_existing_and_new_writers() {
        let assets = TestAssets::new();
        let config = config(&assets);
        let sealed = open_and_verify_model_assets(&config).expect("seal model fixtures");

        assert!(
            File::open(&assets.model).is_ok(),
            "read sharing stays enabled"
        );
        assert!(
            OpenOptions::new().write(true).open(&assets.model).is_err(),
            "a new writer must not enter after verification"
        );
        drop(sealed);
        let writer = OpenOptions::new()
            .write(true)
            .open(&assets.tokens)
            .expect("writer opens after sealed handles are released");
        assert_eq!(
            open_and_verify_model_assets(&config).map(|_| ()),
            Err(AdapterFailure::AssetMismatch),
            "prepare must reject an already-open writer"
        );
        drop(writer);
        open_and_verify_model_assets(&config).expect("sealing recovers after writer closes");
    }

    #[test]
    fn lock_package_and_runtime_provenance_fail_closed() {
        for mismatch in ["asset-lock", "package-lock", "runtime"] {
            let assets = TestAssets::new();
            let config = config(&assets);
            match mismatch {
                "asset-lock" => fs::write(&assets.asset_lock, b"tampered").expect("tamper lock"),
                "package-lock" => {
                    fs::remove_file(&assets.package_lock).expect("remove package lock")
                }
                "runtime" => {
                    fs::write(&assets.runtime_bundle, b"tampered").expect("tamper runtime fixture")
                }
                _ => unreachable!(),
            }
            let (mut backend, calls) = backend(config, false, FakeRecognition::Text("recognized"));

            let failure = backend
                .prepare_recognizer()
                .expect_err("provenance mismatch must fail");

            assert_eq!(failure, AdapterFailure::AssetMismatch, "{mismatch}");
            assert_eq!(calls.lock().expect("calls lock").initialize, 0);
        }
    }

    #[test]
    fn parameter_material_covers_every_explicit_native_setting() {
        let assets = TestAssets::new();
        let config = locked_config(&assets);

        assert_eq!(
            config.parameter_canonical_json(),
            LOCKED_PARAMETER_CANONICAL_JSON
        );
        assert_eq!(
            config.parameter_sha256(),
            locked_digest(LOCKED_PARAMETER_SHA256_HEX)
        );
    }

    #[cfg(feature = "native-sherpa")]
    #[test]
    fn runtime_inventory_material_has_the_locked_bundle_digest() {
        assert_eq!(
            Sha256Digest::from_bytes(
                Sha256::digest(RUNTIME_INVENTORY_CANONICAL_JSON.as_bytes()).into()
            ),
            locked_digest(LOCKED_RUNTIME_BUNDLE_SHA256_HEX)
        );
    }

    #[test]
    fn production_lock_rejects_caller_selected_provenance() {
        let assets = TestAssets::new();
        let locked = locked_config(&assets);
        assert_eq!(locked.validate_locked_candidate(), Ok(()));

        let mut caller_selected = locked;
        caller_selected.expected_asset_lock_sha256 = digest(77);
        caller_selected.descriptor.model_manifest_sha256 = digest(77);
        assert_eq!(caller_selected.validate(), Ok(()));
        assert_eq!(
            caller_selected.validate_locked_candidate(),
            Err(SherpaConfigError::LockedCandidateConflict)
        );

        let mut relative = locked_config(&assets);
        relative.model_path = PathBuf::from("model.int8.onnx");
        assert_eq!(
            relative.validate_locked_candidate(),
            Err(SherpaConfigError::LockedCandidateConflict)
        );
    }

    #[test]
    fn production_model_paths_resolve_to_stable_absolute_targets() {
        let assets = TestAssets::new();
        let mut config = config(&assets);

        resolve_production_model_paths(&mut config).expect("resolve production paths");

        assert!(config.model_path.is_absolute());
        assert!(config.tokens_path.is_absolute());
        assert_eq!(
            config.model_path,
            std::fs::canonicalize(&assets.model).expect("canonical model fixture")
        );
        assert_eq!(
            config.tokens_path,
            std::fs::canonicalize(&assets.tokens).expect("canonical tokens fixture")
        );
    }

    #[cfg(not(feature = "native-sherpa"))]
    #[test]
    fn production_constructor_fails_immediately_without_native_feature() {
        let assets = TestAssets::new();
        let error = SherpaNativeBackend::new(config(&assets))
            .expect_err("disabled native feature must reject production construction");
        assert_eq!(error, SherpaConfigError::NativeFeatureDisabled);
    }

    #[test]
    fn candidate_identity_and_parameter_drift_are_rejected() {
        let assets = TestAssets::new();
        let mut identity_drift = config(&assets);
        identity_drift.descriptor.runtime_version = id("1.17.1");
        assert_eq!(
            identity_drift.validate(),
            Err(SherpaConfigError::CandidateIdentityConflict)
        );

        let mut stale_license = config(&assets);
        stale_license.descriptor.model_license_id = id("LicenseRef-FunASR-Model-1.1-Pending");
        assert_eq!(
            stale_license.validate(),
            Err(SherpaConfigError::CandidateIdentityConflict)
        );

        let mut parameter_drift = config(&assets);
        parameter_drift.num_threads += 1;
        assert_eq!(
            parameter_drift.validate(),
            Err(SherpaConfigError::ParameterDigestConflict)
        );
    }
}
