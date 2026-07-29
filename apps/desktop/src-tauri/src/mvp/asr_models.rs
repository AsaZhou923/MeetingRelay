#[cfg(windows)]
pub const DEFAULT_ASR_MODEL_ID: &str = meetingrelay_model_worker_sherpa_native::MODEL_ID;
#[cfg(not(windows))]
pub const DEFAULT_ASR_MODEL_ID: &str = "sensevoice-zh-en-ja-ko-yue-int8-2024-07-17";

#[cfg(windows)]
const DEFAULT_MODEL_SHA256: &str = meetingrelay_model_worker_sherpa_native::LOCKED_MODEL_SHA256_HEX;
#[cfg(not(windows))]
const DEFAULT_MODEL_SHA256: &str =
    "c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51";

#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AsrModelProfile {
    pub model_id: String,
    pub label: String,
    pub tier: String,
    pub engine: String,
    pub engine_version: String,
    pub runtime_version: String,
    pub model_revision: String,
    pub model_sha256: String,
    pub quantization: String,
    pub execution_provider: String,
    pub native_streaming: bool,
    pub supported_languages: Vec<String>,
    pub model_size_bytes: String,
    pub recommended_memory_mb: u32,
    pub license_id: String,
    pub install_state: String,
    pub benchmark_status: String,
    pub selectable: bool,
}

impl AsrModelProfile {
    pub fn meeting_label(&self, language: &str) -> String {
        format!(
            "{} · {} · {} · local [engine={}@{};runtime={};model={};revision={};sha256={};quantization={};native_streaming={}]",
            self.label,
            language,
            self.execution_provider,
            self.engine,
            self.engine_version,
            self.runtime_version,
            self.model_id,
            self.model_revision,
            self.model_sha256,
            self.quantization,
            self.native_streaming
        )
    }
}

pub fn asr_model_profiles() -> Vec<AsrModelProfile> {
    let mut profiles = Vec::new();
    #[cfg(windows)]
    {
        use super::cohere_asr::{self, CohereInstallState};

        let install_state = cohere_asr::installation_state();
        profiles.push(AsrModelProfile {
            model_id: cohere_asr::MODEL_ID.to_owned(),
            label: cohere_asr::MODEL_LABEL.to_owned(),
            tier: "high-quality-default".to_owned(),
            engine: cohere_asr::ENGINE_ID.to_owned(),
            engine_version: cohere_asr::ENGINE_VERSION.to_owned(),
            runtime_version: cohere_asr::RUNTIME_VERSION.to_owned(),
            model_revision: cohere_asr::MODEL_REVISION.to_owned(),
            model_sha256: cohere_asr::MODEL_SHA256.to_owned(),
            quantization: cohere_asr::QUANTIZATION.to_owned(),
            execution_provider: "CUDA".to_owned(),
            native_streaming: false,
            supported_languages: ["zh", "ja", "en"].map(str::to_owned).to_vec(),
            model_size_bytes: cohere_asr::MODEL_SIZE_BYTES.to_string(),
            recommended_memory_mb: 8_192,
            license_id: cohere_asr::MODEL_LICENSE_ID.to_owned(),
            install_state: match install_state {
                CohereInstallState::Verified => "verified",
                CohereInstallState::Missing => "missing",
                CohereInstallState::Invalid => "invalid",
            }
            .to_owned(),
            benchmark_status: "local-smoke-verified".to_owned(),
            selectable: install_state == CohereInstallState::Verified,
        });
    }
    profiles.push(AsrModelProfile {
        model_id: DEFAULT_ASR_MODEL_ID.to_owned(),
        label: "SenseVoice Small".to_owned(),
        tier: "stable-default".to_owned(),
        engine: "sherpa-onnx".to_owned(),
        engine_version: "1.13.4".to_owned(),
        runtime_version: "1.27.0".to_owned(),
        model_revision: "2024-07-17".to_owned(),
        model_sha256: DEFAULT_MODEL_SHA256.to_owned(),
        quantization: "int8".to_owned(),
        execution_provider: "CPU".to_owned(),
        native_streaming: false,
        supported_languages: ["zh", "ja", "en"].map(str::to_owned).to_vec(),
        model_size_bytes: "239233841".to_owned(),
        recommended_memory_mb: 1024,
        license_id: "LicenseRef-FunASR-Model-1.1-Internal-Evaluation".to_owned(),
        install_state: "verified".to_owned(),
        benchmark_status: "baseline-locked".to_owned(),
        selectable: true,
    });
    profiles
}

pub fn resolve_asr_model(
    model_id: Option<&str>,
    language: &str,
) -> Result<AsrModelProfile, String> {
    let requested = model_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_ASR_MODEL_ID);
    let profile = asr_model_profiles()
        .into_iter()
        .find(|profile| profile.model_id == requested)
        .ok_or_else(|| "ASR_MODEL_NOT_FOUND".to_owned())?;
    if !profile.selectable || profile.install_state != "verified" {
        return Err("ASR_MODEL_NOT_READY".to_owned());
    }
    if !profile
        .supported_languages
        .iter()
        .any(|supported| supported == language)
    {
        return Err("ASR_MODEL_LANGUAGE_UNSUPPORTED".to_owned());
    }
    Ok(profile)
}

pub fn resolve_asr_model_from_label(
    model_label: &str,
    language: &str,
) -> Result<AsrModelProfile, String> {
    let profiles = asr_model_profiles();
    let model_id = profiles
        .iter()
        .find(|profile| model_label.contains(&profile.model_id))
        .map(|profile| profile.model_id.as_str());
    // Legacy meetings predate structured model identity and can only have used
    // the sealed default model.
    resolve_asr_model(model_id, language)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_resolves_the_locked_default_and_rejects_unknown_models() {
        let profile = resolve_asr_model(None, "zh").unwrap();
        assert_eq!(profile.model_id, DEFAULT_ASR_MODEL_ID);
        assert_eq!(profile.model_sha256.len(), 64);
        assert!(profile.meeting_label("zh").contains("sha256=c71f0ce00bec"));
        assert_eq!(
            resolve_asr_model(Some("missing"), "zh").unwrap_err(),
            "ASR_MODEL_NOT_FOUND"
        );
    }

    #[cfg(windows)]
    #[test]
    fn registry_exposes_the_cohere_gpu_profile_before_the_cpu_fallback() {
        let profiles = asr_model_profiles();
        assert_eq!(profiles[0].model_id, super::super::cohere_asr::MODEL_ID);
        assert_eq!(profiles[0].execution_provider, "CUDA");
        assert!(!profiles[0].native_streaming);
        assert_eq!(profiles[1].model_id, DEFAULT_ASR_MODEL_ID);
    }

    #[test]
    fn registry_rejects_languages_not_declared_by_the_model() {
        assert_eq!(
            resolve_asr_model(None, "ko").unwrap_err(),
            "ASR_MODEL_LANGUAGE_UNSUPPORTED"
        );
    }

    #[cfg(windows)]
    #[test]
    fn registry_identity_matches_the_sealed_sherpa_backend() {
        let profile = resolve_asr_model(None, "en").unwrap();
        assert_eq!(
            profile.engine,
            meetingrelay_model_worker_sherpa_native::ENGINE_ID
        );
        assert_eq!(
            profile.engine_version,
            meetingrelay_model_worker_sherpa_native::ENGINE_VERSION
        );
        assert_eq!(
            profile.runtime_version,
            meetingrelay_model_worker_sherpa_native::RUNTIME_VERSION
        );
        assert_eq!(
            profile.license_id,
            meetingrelay_model_worker_sherpa_native::MODEL_LICENSE_ID
        );
        assert_eq!(
            profile.quantization,
            meetingrelay_model_worker_sherpa_native::QUANTIZATION
        );
    }
}
