use core::fmt;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ContractError {
    InvalidIdentifier,
    InvalidLanguageCode,
    InvalidSanitizedText,
    InvalidTranscriptText,
    InvalidSha256,
    UnknownExecutionProvider,
    LanguageMismatch,
    LanguageListTooLarge,
    StreamingRequired,
    OfflineRequired,
    AudioPayloadLengthMismatch,
    InvalidConfidence,
    InvalidBackendAction,
}

impl fmt::Display for ContractError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidIdentifier => "identifier is not valid contract ASCII",
            Self::InvalidLanguageCode => "language code is invalid",
            Self::InvalidSanitizedText => {
                "sanitized detail must be bounded printable text without controls"
            }
            Self::InvalidTranscriptText => {
                "transcript text must be non-empty and within its explicit byte bound"
            }
            Self::InvalidSha256 => "SHA-256 must be 64 lowercase hexadecimal characters",
            Self::UnknownExecutionProvider => "execution provider is unknown",
            Self::LanguageMismatch => "language capability differs",
            Self::LanguageListTooLarge => {
                "engine language capability list exceeds the fixed contract bound"
            }
            Self::StreamingRequired => "streaming capability is required",
            Self::OfflineRequired => "offline operation is required",
            Self::AudioPayloadLengthMismatch => {
                "audio payload length differs from its declared media range"
            }
            Self::InvalidConfidence => {
                "fixed-point confidence exceeds one million parts per million"
            }
            Self::InvalidBackendAction => "backend action is empty or has inconsistent audio",
        })
    }
}

impl std::error::Error for ContractError {}
