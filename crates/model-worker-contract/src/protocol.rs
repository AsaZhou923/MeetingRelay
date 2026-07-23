use crate::{ContractError, Identifier, LanguageCode, Sha256Digest};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ExecutionProvider {
    FixtureCpu,
    Cpu,
    Cuda,
    DirectMl,
    OpenVino,
}

impl TryFrom<&str> for ExecutionProvider {
    type Error = ContractError;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        match value {
            "fixture-cpu" => Ok(Self::FixtureCpu),
            "cpu" => Ok(Self::Cpu),
            "cuda" => Ok(Self::Cuda),
            "directml" => Ok(Self::DirectMl),
            "openvino" => Ok(Self::OpenVino),
            _ => Err(ContractError::UnknownExecutionProvider),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EngineDescriptor {
    pub engine_id: Identifier,
    pub engine_version: Identifier,
    pub runtime_id: Identifier,
    pub runtime_version: Identifier,
    pub runtime_sha256: Sha256Digest,
    pub package_lock_sha256: Sha256Digest,
    pub model_id: Identifier,
    pub model_sha256: Sha256Digest,
    pub model_manifest_sha256: Sha256Digest,
    pub model_license_id: Identifier,
    pub parameter_sha256: Sha256Digest,
    pub execution_provider: ExecutionProvider,
    pub quantization: Identifier,
    pub languages: Vec<LanguageCode>,
    pub streaming: bool,
    pub offline: bool,
}

impl EngineDescriptor {
    pub const MAX_LANGUAGES: usize = 64;

    pub fn validate(&self) -> Result<(), ContractError> {
        if self.runtime_sha256.is_zero()
            || self.package_lock_sha256.is_zero()
            || self.model_sha256.is_zero()
            || self.model_manifest_sha256.is_zero()
            || self.parameter_sha256.is_zero()
        {
            return Err(ContractError::InvalidSha256);
        }
        if self.languages.len() > Self::MAX_LANGUAGES {
            return Err(ContractError::LanguageListTooLarge);
        }
        if self.languages.is_empty()
            || self
                .languages
                .windows(2)
                .any(|pair| pair[0].as_str() >= pair[1].as_str())
        {
            return Err(ContractError::LanguageMismatch);
        }
        if !self.streaming {
            return Err(ContractError::StreamingRequired);
        }
        if !self.offline {
            return Err(ContractError::OfflineRequired);
        }
        Ok(())
    }
}
