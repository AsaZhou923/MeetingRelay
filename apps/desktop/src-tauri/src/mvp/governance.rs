use std::{
    fs,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};

use super::storage::{now_ms_string, sha256_hex};

const RECOVERY_DIR: &str = "recovery";
const RAW_DIR: &str = "raw";
const DERIVED_DIR: &str = "derived";
const RECOVERY_WINDOW_DAYS: u64 = 1;
const RECOVERY_WINDOW_MS: u64 = RECOVERY_WINDOW_DAYS * 24 * 60 * 60 * 1_000;

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GovernanceFilePreview {
    pub meeting_id: String,
    pub paths: Vec<String>,
    pub entries: Vec<GovernanceFilePreviewEntry>,
    pub total_bytes: u64,
    pub recovery_window_days: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GovernanceFilePreviewEntry {
    pub category: String,
    pub path: String,
    pub byte_length: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GovernanceFileEntry {
    pub category: String,
    pub original_path: String,
    pub recovery_path: String,
    pub byte_length: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GovernanceFileTombstone {
    pub tombstone_id: String,
    pub meeting_id: String,
    pub created_at: String,
    pub expires_at: String,
    pub entries: Vec<GovernanceFileEntry>,
}

impl GovernanceFileTombstone {
    pub fn manifest_json(&self) -> Result<String, String> {
        serde_json::to_string(self).map_err(|_| "GOVERNANCE_MANIFEST_SERIALIZE_FAILED".to_owned())
    }

    pub fn from_manifest_json(manifest: &str) -> Result<Self, String> {
        serde_json::from_str(manifest).map_err(|_| "GOVERNANCE_MANIFEST_INVALID".to_owned())
    }
}

#[derive(Clone, Debug)]
pub struct MeetingFileVault {
    root: PathBuf,
}

impl MeetingFileVault {
    #[must_use]
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn preview(&self, meeting_id: &str) -> Result<GovernanceFilePreview, String> {
        validate_meeting_id(meeting_id)?;
        let mut paths = Vec::new();
        let mut entries = Vec::new();
        let mut total_bytes = 0_u64;
        for category in [RAW_DIR, DERIVED_DIR] {
            let candidate = self.root.join(category).join(meeting_id);
            match fs::symlink_metadata(&candidate) {
                Ok(metadata) => {
                    reject_link(&metadata)?;
                    let byte_length = path_size(&candidate)?;
                    total_bytes = total_bytes
                        .checked_add(byte_length)
                        .ok_or_else(|| "GOVERNANCE_SIZE_OVERFLOW".to_owned())?;
                    let path = candidate.to_string_lossy().into_owned();
                    paths.push(path.clone());
                    entries.push(GovernanceFilePreviewEntry {
                        category: category.to_owned(),
                        path,
                        byte_length,
                    });
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return Err("GOVERNANCE_PREVIEW_FAILED".to_owned()),
            }
        }
        Ok(GovernanceFilePreview {
            meeting_id: meeting_id.to_owned(),
            paths,
            entries,
            total_bytes,
            recovery_window_days: RECOVERY_WINDOW_DAYS,
        })
    }

    #[cfg(test)]
    pub fn stage(&self, meeting_id: &str) -> Result<GovernanceFileTombstone, String> {
        self.stage_selected(meeting_id, true, true)
    }

    pub fn stage_selected(
        &self,
        meeting_id: &str,
        include_raw: bool,
        include_derived: bool,
    ) -> Result<GovernanceFileTombstone, String> {
        let preview = self.preview(meeting_id)?;
        let selected_total_bytes = preview
            .entries
            .iter()
            .filter(|entry| {
                (entry.category == RAW_DIR && include_raw)
                    || (entry.category == DERIVED_DIR && include_derived)
            })
            .try_fold(0_u64, |total, entry| {
                total
                    .checked_add(entry.byte_length)
                    .ok_or_else(|| "GOVERNANCE_SIZE_OVERFLOW".to_owned())
            })?;
        let created_at = now_ms_string();
        let created_ms = created_at
            .parse::<u64>()
            .map_err(|_| "GOVERNANCE_CLOCK_INVALID".to_owned())?;
        let tombstone_id = sha256_hex(
            format!(
                "meetingrelay.governance.v1\n{meeting_id}\n{created_at}\n{}",
                selected_total_bytes
            )
            .as_bytes(),
        );
        let recovery_root = self.recovery_root().join(&tombstone_id);
        let mut tombstone = GovernanceFileTombstone {
            tombstone_id,
            meeting_id: meeting_id.to_owned(),
            created_at,
            expires_at: created_ms.saturating_add(RECOVERY_WINDOW_MS).to_string(),
            entries: Vec::new(),
        };
        if selected_total_bytes == 0 {
            return Ok(tombstone);
        }

        fs::create_dir_all(&recovery_root)
            .map_err(|_| "GOVERNANCE_RECOVERY_DIRECTORY_FAILED".to_owned())?;
        for category in [RAW_DIR, DERIVED_DIR] {
            if (category == RAW_DIR && !include_raw)
                || (category == DERIVED_DIR && !include_derived)
            {
                continue;
            }
            let original = self.root.join(category).join(meeting_id);
            if fs::symlink_metadata(&original).is_err() {
                continue;
            }
            let recovery = recovery_root.join(category);
            let byte_length = path_size(&original)?;
            if let Err(error) = fs::rename(&original, &recovery) {
                let rollback_result = self.restore_entries(&tombstone.entries);
                let _ = remove_empty_directory(&recovery_root);
                return Err(rollback_result
                    .err()
                    .unwrap_or_else(|| map_rename_error(&error)));
            }
            tombstone.entries.push(GovernanceFileEntry {
                category: category.to_owned(),
                original_path: original.to_string_lossy().into_owned(),
                recovery_path: recovery.to_string_lossy().into_owned(),
                byte_length,
            });
        }
        Ok(tombstone)
    }

    pub fn restore(&self, tombstone: &GovernanceFileTombstone) -> Result<(), String> {
        self.validate_tombstone(tombstone)?;
        self.restore_entries(&tombstone.entries)?;
        remove_empty_directory(&self.recovery_root().join(&tombstone.tombstone_id))
    }

    pub fn restage(&self, tombstone: &GovernanceFileTombstone) -> Result<(), String> {
        self.validate_tombstone(tombstone)?;
        let recovery_root = self.recovery_root().join(&tombstone.tombstone_id);
        fs::create_dir_all(&recovery_root)
            .map_err(|_| "GOVERNANCE_RECOVERY_DIRECTORY_FAILED".to_owned())?;
        let mut moved = Vec::new();
        for entry in &tombstone.entries {
            let original = PathBuf::from(&entry.original_path);
            let recovery = PathBuf::from(&entry.recovery_path);
            if !original.exists() && recovery.exists() {
                continue;
            }
            if !original.exists() || recovery.exists() {
                self.restore_entries(&moved)?;
                return Err("GOVERNANCE_RESTAGE_CONFLICT".to_owned());
            }
            if fs::rename(&original, &recovery).is_err() {
                self.restore_entries(&moved)?;
                return Err("GOVERNANCE_RESTAGE_FAILED".to_owned());
            }
            moved.push(entry.clone());
        }
        Ok(())
    }

    pub fn purge(&self, tombstone: &GovernanceFileTombstone) -> Result<(), String> {
        self.validate_tombstone(tombstone)?;
        let recovery_root = self.recovery_root().join(&tombstone.tombstone_id);
        match fs::symlink_metadata(&recovery_root) {
            Ok(metadata) => {
                reject_link(&metadata)?;
                fs::remove_dir_all(recovery_root).map_err(|_| "GOVERNANCE_PURGE_FAILED".to_owned())
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err("GOVERNANCE_PURGE_FAILED".to_owned()),
        }
    }

    fn recovery_root(&self) -> PathBuf {
        self.root.join(RECOVERY_DIR)
    }

    fn restore_entries(&self, entries: &[GovernanceFileEntry]) -> Result<(), String> {
        for entry in entries.iter().rev() {
            let original = PathBuf::from(&entry.original_path);
            let recovery = PathBuf::from(&entry.recovery_path);
            if original.exists() && !recovery.exists() {
                continue;
            }
            if original.exists() || !recovery.exists() {
                return Err("GOVERNANCE_RESTORE_CONFLICT".to_owned());
            }
            let parent = original
                .parent()
                .ok_or_else(|| "GOVERNANCE_MANIFEST_INVALID".to_owned())?;
            fs::create_dir_all(parent)
                .map_err(|_| "GOVERNANCE_RESTORE_DIRECTORY_FAILED".to_owned())?;
            fs::rename(&recovery, &original).map_err(|_| "GOVERNANCE_RESTORE_FAILED".to_owned())?;
        }
        Ok(())
    }

    fn validate_tombstone(&self, tombstone: &GovernanceFileTombstone) -> Result<(), String> {
        validate_meeting_id(&tombstone.meeting_id)?;
        validate_hash(&tombstone.tombstone_id)?;
        let expected_recovery_root = self.recovery_root().join(&tombstone.tombstone_id);
        for entry in &tombstone.entries {
            if !matches!(entry.category.as_str(), RAW_DIR | DERIVED_DIR) {
                return Err("GOVERNANCE_MANIFEST_INVALID".to_owned());
            }
            let original = PathBuf::from(&entry.original_path);
            let recovery = PathBuf::from(&entry.recovery_path);
            if original != self.root.join(&entry.category).join(&tombstone.meeting_id)
                || recovery != expected_recovery_root.join(&entry.category)
            {
                return Err("GOVERNANCE_MANIFEST_SCOPE_REJECTED".to_owned());
            }
        }
        Ok(())
    }
}

fn validate_meeting_id(meeting_id: &str) -> Result<(), String> {
    if meeting_id.is_empty()
        || meeting_id.len() > 128
        || !meeting_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("GOVERNANCE_MEETING_ID_INVALID".to_owned());
    }
    Ok(())
}

fn validate_hash(value: &str) -> Result<(), String> {
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("GOVERNANCE_MANIFEST_INVALID".to_owned());
    }
    Ok(())
}

fn path_size(path: &Path) -> Result<u64, String> {
    let metadata =
        fs::symlink_metadata(path).map_err(|_| "GOVERNANCE_PREVIEW_FAILED".to_owned())?;
    if metadata.file_type().is_symlink() {
        return Ok(0);
    }
    if metadata.is_file() {
        return Ok(metadata.len());
    }
    if !metadata.is_dir() {
        return Ok(0);
    }
    fs::read_dir(path)
        .map_err(|_| "GOVERNANCE_PREVIEW_FAILED".to_owned())?
        .try_fold(0_u64, |total, entry| {
            let entry = entry.map_err(|_| "GOVERNANCE_PREVIEW_FAILED".to_owned())?;
            total
                .checked_add(path_size(&entry.path())?)
                .ok_or_else(|| "GOVERNANCE_SIZE_OVERFLOW".to_owned())
        })
}

fn reject_link(metadata: &fs::Metadata) -> Result<(), String> {
    if metadata.file_type().is_symlink() || is_windows_reparse_point(metadata) {
        Err("GOVERNANCE_REPARSE_REJECTED".to_owned())
    } else {
        Ok(())
    }
}

#[cfg(windows)]
fn is_windows_reparse_point(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;

    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
const fn is_windows_reparse_point(_metadata: &fs::Metadata) -> bool {
    false
}

fn remove_empty_directory(path: &Path) -> Result<(), String> {
    match fs::remove_dir(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("GOVERNANCE_RECOVERY_CLEANUP_FAILED".to_owned()),
    }
}

fn map_rename_error(error: &std::io::Error) -> String {
    if error.kind() == std::io::ErrorKind::NotFound {
        "GOVERNANCE_SOURCE_MISSING".to_owned()
    } else {
        "GOVERNANCE_STAGE_FAILED".to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_root(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "meetingrelay-governance-{name}-{}",
            now_ms_string()
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn preview_stage_restore_and_purge_are_bounded() {
        let root = test_root("round-trip");
        let raw = root.join(RAW_DIR).join("meeting-1");
        let derived = root.join(DERIVED_DIR).join("meeting-1");
        fs::create_dir_all(&raw).unwrap();
        fs::create_dir_all(&derived).unwrap();
        fs::write(raw.join("system.wav"), b"raw").unwrap();
        fs::write(derived.join("manifest.json"), b"derived").unwrap();
        let vault = MeetingFileVault::new(&root);

        let preview = vault.preview("meeting-1").unwrap();
        assert_eq!(preview.paths.len(), 2);
        assert_eq!(preview.total_bytes, 10);
        let tombstone = vault.stage("meeting-1").unwrap();
        assert!(!raw.exists());
        assert!(!derived.exists());
        assert_eq!(tombstone.entries.len(), 2);

        vault.restore(&tombstone).unwrap();
        assert_eq!(fs::read(raw.join("system.wav")).unwrap(), b"raw");
        assert_eq!(fs::read(derived.join("manifest.json")).unwrap(), b"derived");
        vault.restage(&tombstone).unwrap();
        vault.purge(&tombstone).unwrap();
        assert!(
            !root
                .join(RECOVERY_DIR)
                .join(tombstone.tombstone_id)
                .exists()
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn selected_stage_leaves_excluded_categories_untouched() {
        let root = test_root("selected");
        let raw = root.join(RAW_DIR).join("meeting-1");
        let derived = root.join(DERIVED_DIR).join("meeting-1");
        fs::create_dir_all(&raw).unwrap();
        fs::create_dir_all(&derived).unwrap();
        fs::write(raw.join("system.wav"), b"raw").unwrap();
        fs::write(derived.join("summary.json"), b"derived").unwrap();
        let vault = MeetingFileVault::new(&root);

        let tombstone = vault.stage_selected("meeting-1", false, true).unwrap();
        assert!(raw.exists());
        assert!(!derived.exists());
        assert_eq!(tombstone.entries.len(), 1);
        assert_eq!(tombstone.entries[0].category, DERIVED_DIR);

        vault.restore(&tombstone).unwrap();
        assert_eq!(fs::read(raw.join("system.wav")).unwrap(), b"raw");
        assert_eq!(fs::read(derived.join("summary.json")).unwrap(), b"derived");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn manifest_cannot_escape_the_data_root() {
        let root = test_root("scope");
        let vault = MeetingFileVault::new(&root);
        let tombstone = GovernanceFileTombstone {
            tombstone_id: "a".repeat(64),
            meeting_id: "meeting-1".to_owned(),
            created_at: "1".to_owned(),
            expires_at: "2".to_owned(),
            entries: vec![GovernanceFileEntry {
                category: RAW_DIR.to_owned(),
                original_path: root.join("outside").to_string_lossy().into_owned(),
                recovery_path: root.join("also-outside").to_string_lossy().into_owned(),
                byte_length: 0,
            }],
        };
        assert_eq!(
            vault.restore(&tombstone).unwrap_err(),
            "GOVERNANCE_MANIFEST_SCOPE_REJECTED"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn invalid_meeting_id_is_rejected_before_filesystem_access() {
        let root = test_root("invalid-id");
        let vault = MeetingFileVault::new(&root);
        assert_eq!(
            vault.preview("../escape").unwrap_err(),
            "GOVERNANCE_MEETING_ID_INVALID"
        );
        let _ = fs::remove_dir_all(root);
    }
}
