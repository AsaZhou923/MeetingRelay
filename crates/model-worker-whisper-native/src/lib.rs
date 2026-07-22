//! WP-0.4.5a whisper-rs native link/version smoke.
//!
//! This crate intentionally stops before model loading, transcription,
//! model-worker contract integration, quality measurement, or fallback
//! selection. Enabling `native-whisper` only proves that the pinned binding can
//! compile, link, and query the linked whisper.cpp version offline.

/// Documented work-package child represented by this crate.
pub const WORK_PACKAGE: &str = "WP-0.4.5a";
/// Highest measurement claim permitted by this slice.
pub const MEASUREMENT_STATUS: &str = "whisper-native-link-smoke-only";
/// Highest execution claim permitted by this slice.
pub const EXECUTION_STATUS: &str = "binding-version-query-only-no-model-no-transcription";
/// This slice establishes no formal benchmark claim.
pub const FORMAL_CLAIMS: &str = "none";
/// This slice does not constitute production evidence.
pub const PRODUCTION_EVIDENCE: bool = false;
/// This slice has no authority to select a production fallback.
pub const SELECTION_AUTHORITY: &str = "none";

#[cfg(feature = "native-whisper")]
use std::fmt;

#[cfg(feature = "native-whisper")]
pub fn linked_whisper_cpp_version() -> &'static str {
    whisper_rs::get_whisper_version()
}

#[cfg(feature = "native-whisper")]
pub fn whisper_import_smoke() -> Result<&'static str, WhisperImportSmokeError> {
    let version = linked_whisper_cpp_version();
    if version.trim().is_empty() {
        return Err(WhisperImportSmokeError::EmptyLinkedVersion);
    }
    Ok(version)
}

#[cfg(feature = "native-whisper")]
#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub enum WhisperImportSmokeError {
    EmptyLinkedVersion,
}

#[cfg(feature = "native-whisper")]
impl fmt::Display for WhisperImportSmokeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyLinkedVersion => {
                formatter.write_str("whisper-rs reported an empty linked whisper.cpp version")
            }
        }
    }
}

#[cfg(feature = "native-whisper")]
impl std::error::Error for WhisperImportSmokeError {}

#[cfg(test)]
mod tests {
    #[cfg(not(feature = "native-whisper"))]
    #[test]
    fn default_build_keeps_native_link_disabled_and_claims_bounded() {
        assert_eq!(super::WORK_PACKAGE, "WP-0.4.5a");
        assert_eq!(super::MEASUREMENT_STATUS, "whisper-native-link-smoke-only");
        assert_eq!(
            super::EXECUTION_STATUS,
            "binding-version-query-only-no-model-no-transcription"
        );
        assert_eq!(super::FORMAL_CLAIMS, "none");
        assert!(!std::hint::black_box(super::PRODUCTION_EVIDENCE));
        assert_eq!(super::SELECTION_AUTHORITY, "none");
        println!(
            "work_package={} native_whisper=disabled measurement_status={} execution_status={} formal_claims={} production_evidence={} selection_authority={}",
            super::WORK_PACKAGE,
            super::MEASUREMENT_STATUS,
            super::EXECUTION_STATUS,
            super::FORMAL_CLAIMS,
            super::PRODUCTION_EVIDENCE,
            super::SELECTION_AUTHORITY
        );
    }

    #[cfg(feature = "native-whisper")]
    #[test]
    fn whisper_import_smoke_reports_linked_version() {
        let version = super::whisper_import_smoke().expect("linked whisper.cpp version");
        assert!(!version.trim().is_empty());
        assert!(version.chars().any(|ch| ch.is_ascii_digit()));
        assert_eq!(super::FORMAL_CLAIMS, "none");
        assert!(!std::hint::black_box(super::PRODUCTION_EVIDENCE));
        assert_eq!(super::SELECTION_AUTHORITY, "none");
        println!(
            "work_package={} native_whisper=linked linked_whisper_cpp_version={} measurement_status={} execution_status={} formal_claims={} production_evidence={} selection_authority={}",
            super::WORK_PACKAGE,
            version,
            super::MEASUREMENT_STATUS,
            super::EXECUTION_STATUS,
            super::FORMAL_CLAIMS,
            super::PRODUCTION_EVIDENCE,
            super::SELECTION_AUTHORITY
        );
    }
}
