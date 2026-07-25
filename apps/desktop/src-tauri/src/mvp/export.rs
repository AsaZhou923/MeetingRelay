use std::{
    fs::{self, File},
    io::Write,
    path::{Component, Path, PathBuf},
};

#[cfg(test)]
use std::cell::{Cell, RefCell};

use super::document_export::{DocumentModel, Section, render_docx, render_pdf};
use super::storage::{
    CompletedExport, MeetingSnapshot, MvpStorage, MvpStorageWriter, now_ms_string, sha256_hex,
};

#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportArtifact {
    pub format: String,
    pub path: String,
    pub byte_length: usize,
    pub sha256: String,
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub meeting_id: String,
    pub snapshot_id: String,
    pub final_count: usize,
    pub artifacts: Vec<ExportArtifact>,
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportOptions {
    pub formats: Vec<String>,
    #[serde(default)]
    pub include_original: bool,
    #[serde(default)]
    pub include_translation: bool,
    #[serde(default)]
    pub bilingual: bool,
    #[serde(default)]
    pub include_speaker: bool,
    #[serde(default)]
    pub include_summary: bool,
    #[serde(default)]
    pub include_timestamp: bool,
    #[serde(default)]
    pub summary_version: Option<u32>,
    #[serde(default)]
    pub summary: Option<ExportSummary>,
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSummary {
    #[serde(default)]
    pub version: Option<u32>,
    #[serde(default)]
    pub sections: Vec<ExportSummarySection>,
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSummarySection {
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub heading: Option<String>,
    pub text: String,
    #[serde(default)]
    pub citation_segment_ids: Vec<String>,
}

impl ExportOptions {
    fn legacy() -> Self {
        Self {
            formats: vec!["json".to_owned(), "markdown".to_owned(), "txt".to_owned()],
            include_original: true,
            include_translation: true,
            bilingual: true,
            include_speaker: false,
            include_summary: false,
            include_timestamp: true,
            summary_version: None,
            summary: None,
        }
    }

    fn is_legacy_projection(&self) -> bool {
        self.formats.len() == 3
            && self.formats[0] == "json"
            && self.formats[1] == "markdown"
            && self.formats[2] == "txt"
            && self.include_original
            && self.include_translation
            && self.bilingual
            && !self.include_speaker
            && !self.include_summary
            && self.include_timestamp
            && self.summary_version.is_none()
            && self.summary.is_none()
    }
}

/// Returns a complete, storage-backed transcript suitable for the clipboard.
///
/// Unlike the bounded public snapshot used by the live UI, this reads every
/// committed final from SQLite so a long meeting is never copied partially.
pub fn transcript_text(storage: &MvpStorage, meeting_id: &str) -> Result<String, String> {
    let snapshot = storage.snapshot(meeting_id)?;
    if snapshot.meeting.state == "recording" {
        return Err("MVP_COPY_RECORDING_NOT_ALLOWED".to_owned());
    }
    if let Some(error) = snapshot.meeting.completion_error.as_deref() {
        return Err(format!("MVP_COPY_INCOMPLETE:{error}"));
    }
    if snapshot.finals.is_empty() {
        return Err("MVP_COPY_EMPTY".to_owned());
    }
    Ok(render_transcript_text(&snapshot))
}

pub fn export_meeting(
    storage: &MvpStorage,
    writer: &MvpStorageWriter,
    meeting_id: &str,
    target_dir: impl AsRef<Path>,
) -> Result<ExportResult, String> {
    export_meeting_with_options(
        storage,
        writer,
        meeting_id,
        target_dir,
        ExportOptions::legacy(),
    )
}

pub fn export_meeting_with_options(
    storage: &MvpStorage,
    writer: &MvpStorageWriter,
    meeting_id: &str,
    target_dir: impl AsRef<Path>,
    options: ExportOptions,
) -> Result<ExportResult, String> {
    validate_export_options(&options)?;
    let snapshot = storage.snapshot(meeting_id)?;
    if snapshot.meeting.state == "recording" {
        return Err("MVP_EXPORT_RECORDING_NOT_ALLOWED".to_owned());
    }
    if let Some(error) = snapshot.meeting.completion_error.as_deref() {
        return Err(format!("MVP_EXPORT_INCOMPLETE:{error}"));
    }
    let export_root = storage.default_export_dir();
    reject_reparse_path_chain(&export_root)?;
    fs::create_dir_all(&export_root).map_err(|_| "MVP_EXPORT_TARGET_UNAVAILABLE".to_owned())?;
    reject_reparse_path_chain(&export_root)?;
    let export_root = export_root
        .canonicalize()
        .map_err(|_| "MVP_EXPORT_TARGET_UNAVAILABLE".to_owned())?;
    reject_reparse_path_chain(&export_root)?;
    validate_existing_dir_non_reparse(&export_root)?;
    let target_dir = resolve_target_dir(&export_root, target_dir.as_ref())?;
    reject_reparse_path_chain(&target_dir)?;
    fs::create_dir_all(&target_dir).map_err(|_| "MVP_EXPORT_TARGET_UNAVAILABLE".to_owned())?;
    reject_reparse_path_chain(&target_dir)?;
    let target_dir = target_dir
        .canonicalize()
        .map_err(|_| "MVP_EXPORT_TARGET_UNAVAILABLE".to_owned())?;
    reject_reparse_path_chain(&target_dir)?;
    if !target_dir.starts_with(&export_root) {
        return Err("MVP_EXPORT_TARGET_SCOPE_REJECTED".to_owned());
    }
    validate_existing_dir_non_reparse(&target_dir)?;

    let renders = render_exports(&snapshot, &options)?;
    let staging_dir = create_staging_dir(&snapshot, &target_dir)?;
    let mut staged = Vec::new();
    for render in renders {
        validate_rendered_export(&render)?;
        let staged_export = match stage_export(
            &snapshot,
            &render.format,
            &export_root,
            &target_dir,
            &staging_dir,
            &render.bytes,
            &render.manifest_json,
        ) {
            Ok(staged_export) => staged_export,
            Err(error) => {
                return Err(cleanup_staging_dir(&export_root, &staging_dir, &staged)
                    .err()
                    .unwrap_or(error));
            }
        };
        staged.push(staged_export);
    }
    let completed = publish_staged_exports(staged, &export_root, &staging_dir)?;
    let record_exports = record_exports_for_test(completed.clone());
    if let Err(error) = writer.record_export_snapshot(snapshot.clone(), record_exports) {
        return Err(
            cleanup_after_publish_failure(&completed, &export_root, &staging_dir, &[])
                .err()
                .unwrap_or(error),
        );
    }
    cleanup_empty_staging_dir(&export_root, &staging_dir)?;
    Ok(ExportResult {
        meeting_id: snapshot.meeting.id,
        snapshot_id: snapshot.snapshot_id,
        final_count: snapshot.finals.len(),
        artifacts: completed
            .into_iter()
            .map(|artifact| ExportArtifact {
                format: artifact.format,
                path: artifact.target_path.display().to_string(),
                byte_length: artifact.byte_length,
                sha256: artifact.sha256,
            })
            .collect(),
    })
}

#[derive(Clone, Debug)]
struct StagedExport {
    completed: CompletedExport,
    staging_path: PathBuf,
}

#[derive(Clone, Debug)]
struct RenderedExport {
    format: String,
    bytes: Vec<u8>,
    manifest_json: String,
    text_kind: bool,
}

fn resolve_target_dir(export_root: &Path, requested: &Path) -> Result<PathBuf, String> {
    if requested.is_absolute() {
        return Err("MVP_EXPORT_TARGET_SCOPE_REJECTED".to_owned());
    }
    let mut resolved = export_root.to_path_buf();
    for component in requested.components() {
        match component {
            Component::Normal(part) => resolved.push(part),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err("MVP_EXPORT_TARGET_SCOPE_REJECTED".to_owned());
            }
        }
    }
    Ok(resolved)
}

fn reject_reparse_path_chain(path: &Path) -> Result<(), String> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|_| "MVP_EXPORT_TARGET_UNAVAILABLE".to_owned())?
            .join(path)
    };
    for component in absolute.ancestors() {
        match fs::symlink_metadata(component) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() || is_windows_reparse_point(&metadata) {
                    return Err("MVP_EXPORT_TARGET_REPARSE_REJECTED".to_owned());
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("MVP_EXPORT_TARGET_UNAVAILABLE".to_owned()),
        }
    }
    Ok(())
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

fn validate_existing_dir_non_reparse(path: &Path) -> Result<(), String> {
    let metadata =
        fs::symlink_metadata(path).map_err(|_| "MVP_EXPORT_TARGET_UNAVAILABLE".to_owned())?;
    if metadata.file_type().is_symlink() || is_windows_reparse_point(&metadata) {
        return Err("MVP_EXPORT_TARGET_REPARSE_REJECTED".to_owned());
    }
    if !metadata.is_dir() {
        return Err("MVP_EXPORT_TARGET_UNAVAILABLE".to_owned());
    }
    Ok(())
}

fn validate_existing_file_non_reparse(path: &Path) -> Result<fs::Metadata, String> {
    let metadata =
        fs::symlink_metadata(path).map_err(|_| "MVP_EXPORT_TARGET_UNAVAILABLE".to_owned())?;
    if metadata.file_type().is_symlink() || is_windows_reparse_point(&metadata) {
        return Err("MVP_EXPORT_TARGET_REPARSE_REJECTED".to_owned());
    }
    if !metadata.is_file() {
        return Err("MVP_EXPORT_TARGET_UNAVAILABLE".to_owned());
    }
    Ok(metadata)
}

fn ensure_existing_path_inside_export_root(
    export_root: &Path,
    path: &Path,
) -> Result<PathBuf, String> {
    reject_reparse_path_chain(path)?;
    let canonical = path
        .canonicalize()
        .map_err(|_| "MVP_EXPORT_TARGET_UNAVAILABLE".to_owned())?;
    reject_reparse_path_chain(&canonical)?;
    if !canonical.starts_with(export_root) {
        return Err("MVP_EXPORT_TARGET_SCOPE_REJECTED".to_owned());
    }
    Ok(canonical)
}

fn ensure_new_file_path_inside_export_root(export_root: &Path, path: &Path) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "MVP_EXPORT_TARGET_UNAVAILABLE".to_owned())?;
    let canonical_parent = ensure_existing_path_inside_export_root(export_root, parent)?;
    validate_existing_dir_non_reparse(&canonical_parent)?;
    if fs::symlink_metadata(path).is_ok() {
        return Err("MVP_EXPORT_TARGET_EXISTS".to_owned());
    }
    Ok(())
}

fn create_staging_dir(snapshot: &MeetingSnapshot, target_dir: &Path) -> Result<PathBuf, String> {
    let safe_meeting = safe_file_component(&snapshot.meeting.id);
    let safe_snapshot = safe_file_component(&snapshot.snapshot_id[..16]);
    for attempt in 0..100 {
        let staging = target_dir.join(format!(
            ".meetingrelay-{safe_meeting}-{safe_snapshot}-{}-{attempt}.staging",
            now_ms_string()
        ));
        match fs::create_dir(&staging) {
            Ok(()) => {
                reject_reparse_path_chain(&staging)?;
                validate_existing_dir_non_reparse(&staging)?;
                return Ok(staging);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => return Err("MVP_EXPORT_TEMP_CREATE_FAILED".to_owned()),
        }
    }
    Err("MVP_EXPORT_TEMP_CREATE_FAILED".to_owned())
}

fn stage_export(
    snapshot: &MeetingSnapshot,
    format: &str,
    export_root: &Path,
    target_dir: &Path,
    staging_dir: &Path,
    bytes: &[u8],
    manifest_json: &str,
) -> Result<StagedExport, String> {
    let extension = match format {
        "json" => "json",
        "markdown" => "md",
        "txt" => "txt",
        "docx" => "docx",
        "pdf" => "pdf",
        _ => return Err("MVP_EXPORT_FORMAT_UNSUPPORTED".to_owned()),
    };
    let safe_meeting = safe_file_component(&snapshot.meeting.id);
    let safe_snapshot = safe_file_component(&snapshot.snapshot_id[..16]);
    let target = target_dir.join(format!(
        "meetingrelay-{safe_meeting}-{safe_snapshot}.{extension}"
    ));
    let temp = staging_dir.join(format!("{format}.{extension}.tmp"));
    let sha256 = sha256_hex(bytes);
    {
        let mut file =
            File::create_new(&temp).map_err(|_| "MVP_EXPORT_TEMP_CREATE_FAILED".to_owned())?;
        if file.write_all(bytes).is_err() {
            return Err(cleanup_file(export_root, &temp, bytes.len(), &sha256)
                .err()
                .unwrap_or_else(|| "MVP_EXPORT_TEMP_WRITE_FAILED".to_owned()));
        }
        if file.flush().is_err() || file.sync_all().is_err() {
            return Err(cleanup_file(export_root, &temp, bytes.len(), &sha256)
                .err()
                .unwrap_or_else(|| "MVP_EXPORT_TEMP_FLUSH_FAILED".to_owned()));
        }
    }
    validate_existing_file_non_reparse(&temp)?;
    let written = match fs::read(&temp) {
        Ok(written) => written,
        Err(_) => {
            return Err(cleanup_file(export_root, &temp, bytes.len(), &sha256)
                .err()
                .unwrap_or_else(|| "MVP_EXPORT_TEMP_VALIDATE_FAILED".to_owned()));
        }
    };
    if written != bytes {
        return Err(cleanup_file(export_root, &temp, bytes.len(), &sha256)
            .err()
            .unwrap_or_else(|| "MVP_EXPORT_TEMP_VALIDATE_FAILED".to_owned()));
    }
    let completed_at = now_ms_string();
    let export_id = sha256_hex(
        format!(
            "{}\n{}\n{}\n{}\n{}",
            snapshot.snapshot_id,
            format,
            target.display(),
            bytes.len(),
            sha256
        )
        .as_bytes(),
    );
    Ok(StagedExport {
        completed: CompletedExport {
            export_id,
            format: format.to_owned(),
            target_path: target,
            byte_length: bytes.len(),
            sha256: sha256.clone(),
            completed_at,
            validation_manifest_json: manifest_with_integrity(manifest_json, &sha256, bytes.len()),
        },
        staging_path: temp,
    })
}

fn publish_staged_exports(
    staged: Vec<StagedExport>,
    export_root: &Path,
    staging_dir: &Path,
) -> Result<Vec<CompletedExport>, String> {
    let mut completed = Vec::with_capacity(staged.len());
    let mut remaining = staged;
    while !remaining.is_empty() {
        let staged_export = remaining.remove(0);
        reject_reparse_path_chain(export_root)?;
        validate_existing_dir_non_reparse(export_root)?;
        reject_reparse_path_chain(staging_dir)?;
        validate_existing_dir_non_reparse(staging_dir)?;
        ensure_existing_path_inside_export_root(export_root, &staged_export.staging_path)?;
        validate_existing_file_non_reparse(&staged_export.staging_path)?;
        match fs::symlink_metadata(&staged_export.completed.target_path) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() || is_windows_reparse_point(&metadata) {
                    remaining.insert(0, staged_export);
                    return Err(cleanup_after_publish_failure(
                        &completed,
                        export_root,
                        staging_dir,
                        &remaining,
                    )
                    .err()
                    .unwrap_or_else(|| "MVP_EXPORT_TARGET_REPARSE_REJECTED".to_owned()));
                }
                remaining.insert(0, staged_export);
                return Err(cleanup_after_publish_failure(
                    &completed,
                    export_root,
                    staging_dir,
                    &remaining,
                )
                .err()
                .unwrap_or_else(|| "MVP_EXPORT_TARGET_EXISTS".to_owned()));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => {
                remaining.insert(0, staged_export);
                return Err(cleanup_after_publish_failure(
                    &completed,
                    export_root,
                    staging_dir,
                    &remaining,
                )
                .err()
                .unwrap_or_else(|| "MVP_EXPORT_TARGET_UNAVAILABLE".to_owned()));
            }
        }
        if let Err(error) = ensure_new_file_path_inside_export_root(
            export_root,
            &staged_export.completed.target_path,
        ) {
            remaining.insert(0, staged_export);
            return Err(cleanup_after_publish_failure(
                &completed,
                export_root,
                staging_dir,
                &remaining,
            )
            .err()
            .unwrap_or(error));
        }
        #[cfg(test)]
        if let Err(error) = maybe_fail_publish_for_test(&staged_export.completed.format) {
            remaining.insert(0, staged_export);
            return Err(cleanup_after_publish_failure(
                &completed,
                export_root,
                staging_dir,
                &remaining,
            )
            .err()
            .unwrap_or(error));
        }
        match fs::rename(
            &staged_export.staging_path,
            &staged_export.completed.target_path,
        ) {
            Ok(()) => {}
            Err(_) => {
                remaining.insert(0, staged_export);
                return Err(cleanup_after_publish_failure(
                    &completed,
                    export_root,
                    staging_dir,
                    &remaining,
                )
                .err()
                .unwrap_or_else(|| "MVP_EXPORT_ATOMIC_PUBLISH_FAILED".to_owned()));
            }
        }
        ensure_existing_path_inside_export_root(export_root, &staged_export.completed.target_path)?;
        validate_existing_file_non_reparse(&staged_export.completed.target_path)?;
        let target_bytes = match fs::read(&staged_export.completed.target_path) {
            Ok(bytes) => bytes,
            Err(_) => {
                let current = staged_export.completed;
                completed.push(current);
                return Err(cleanup_after_publish_failure(
                    &completed,
                    export_root,
                    staging_dir,
                    &remaining,
                )
                .err()
                .unwrap_or_else(|| "MVP_EXPORT_PUBLISHED_VALIDATE_FAILED".to_owned()));
            }
        };
        if sha256_hex(&target_bytes) != staged_export.completed.sha256 {
            let current = staged_export.completed;
            completed.push(current);
            return Err(cleanup_after_publish_failure(
                &completed,
                export_root,
                staging_dir,
                &remaining,
            )
            .err()
            .unwrap_or_else(|| "MVP_EXPORT_PUBLISHED_VALIDATE_FAILED".to_owned()));
        }
        completed.push(staged_export.completed);
    }
    Ok(completed)
}

fn cleanup_after_publish_failure(
    completed: &[CompletedExport],
    export_root: &Path,
    staging_dir: &Path,
    remaining: &[StagedExport],
) -> Result<(), String> {
    cleanup_completed_exports(export_root, completed)?;
    cleanup_staging_dir(export_root, staging_dir, remaining)
}

fn cleanup_completed_exports(
    export_root: &Path,
    exports: &[CompletedExport],
) -> Result<(), String> {
    for export in exports {
        cleanup_file(
            export_root,
            &export.target_path,
            export.byte_length,
            &export.sha256,
        )?;
    }
    Ok(())
}

fn cleanup_staging_dir(
    export_root: &Path,
    staging_dir: &Path,
    staged: &[StagedExport],
) -> Result<(), String> {
    for staged_export in staged {
        cleanup_file(
            export_root,
            &staged_export.staging_path,
            staged_export.completed.byte_length,
            &staged_export.completed.sha256,
        )?;
    }
    cleanup_empty_staging_dir(export_root, staging_dir)
}

fn cleanup_empty_staging_dir(export_root: &Path, staging_dir: &Path) -> Result<(), String> {
    ensure_existing_path_inside_export_root(export_root, staging_dir)?;
    validate_existing_dir_non_reparse(staging_dir)?;
    match fs::remove_dir(staging_dir) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("MVP_EXPORT_CLEANUP_FAILED".to_owned()),
    }
}

fn cleanup_file(
    export_root: &Path,
    path: &Path,
    expected_byte_length: usize,
    expected_sha256: &str,
) -> Result<(), String> {
    #[cfg(test)]
    maybe_fail_cleanup_file_for_test()?;
    #[cfg(test)]
    maybe_replace_cleanup_file_for_test(path);
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || is_windows_reparse_point(&metadata) {
                return Err("MVP_EXPORT_CLEANUP_FAILED".to_owned());
            }
            if !metadata.is_file() {
                return Err("MVP_EXPORT_CLEANUP_FAILED".to_owned());
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err("MVP_EXPORT_CLEANUP_FAILED".to_owned()),
    }
    let canonical = ensure_existing_path_inside_export_root(export_root, path)
        .map_err(|_| "MVP_EXPORT_CLEANUP_FAILED".to_owned())?;
    let bytes = fs::read(&canonical).map_err(|_| "MVP_EXPORT_CLEANUP_FAILED".to_owned())?;
    if bytes.len() != expected_byte_length || sha256_hex(&bytes) != expected_sha256 {
        return Err("MVP_EXPORT_CLEANUP_FAILED".to_owned());
    }
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("MVP_EXPORT_CLEANUP_FAILED".to_owned()),
    }
}

#[cfg(test)]
thread_local! {
    static PUBLISH_FAIL_AFTER_FOR_TEST: Cell<usize> = const { Cell::new(0) };
    static DB_RECORD_FAIL_FOR_TEST: Cell<bool> = const { Cell::new(false) };
    static CLEANUP_FILE_FAIL_FOR_TEST: Cell<bool> = const { Cell::new(false) };
    static CLEANUP_FILE_REPLACEMENT_FOR_TEST: RefCell<Option<Vec<u8>>> = const { RefCell::new(None) };
}

#[cfg(test)]
fn fail_publish_after_for_test(count: usize) {
    PUBLISH_FAIL_AFTER_FOR_TEST.with(|remaining| remaining.set(count));
}

#[cfg(test)]
fn fail_db_record_for_test(enabled: bool) {
    DB_RECORD_FAIL_FOR_TEST.with(|fail| fail.set(enabled));
}

#[cfg(test)]
fn fail_cleanup_file_for_test(enabled: bool) {
    CLEANUP_FILE_FAIL_FOR_TEST.with(|fail| fail.set(enabled));
}

#[cfg(test)]
fn replace_first_cleanup_file_with_for_test(bytes: Vec<u8>) {
    CLEANUP_FILE_REPLACEMENT_FOR_TEST.with(|replacement| {
        replacement.replace(Some(bytes));
    });
}

#[cfg(test)]
fn maybe_fail_publish_for_test(_format: &str) -> Result<(), String> {
    PUBLISH_FAIL_AFTER_FOR_TEST.with(|remaining| {
        let value = remaining.get();
        if value == 0 {
            return Ok(());
        }
        remaining.set(value - 1);
        if value == 1 {
            return Err("MVP_EXPORT_ATOMIC_PUBLISH_FAILED".to_owned());
        }
        Ok(())
    })
}

#[cfg(test)]
fn maybe_fail_cleanup_file_for_test() -> Result<(), String> {
    CLEANUP_FILE_FAIL_FOR_TEST.with(|fail| {
        if fail.replace(false) {
            Err("MVP_EXPORT_CLEANUP_FAILED".to_owned())
        } else {
            Ok(())
        }
    })
}

#[cfg(test)]
fn maybe_replace_cleanup_file_for_test(path: &Path) {
    CLEANUP_FILE_REPLACEMENT_FOR_TEST.with(|replacement| {
        if let Some(bytes) = replacement.borrow_mut().take()
            && fs::symlink_metadata(path).is_ok()
        {
            let _ = fs::write(path, bytes);
        }
    });
}

#[cfg(test)]
fn record_exports_for_test(mut completed: Vec<CompletedExport>) -> Vec<CompletedExport> {
    DB_RECORD_FAIL_FOR_TEST.with(|fail| {
        if fail.replace(false) && completed.len() > 1 {
            completed[1].export_id = completed[0].export_id.clone();
        }
    });
    completed
}

#[cfg(not(test))]
fn record_exports_for_test(completed: Vec<CompletedExport>) -> Vec<CompletedExport> {
    completed
}

fn validate_export_options(options: &ExportOptions) -> Result<(), String> {
    if options.formats.is_empty() {
        return Err("MVP_EXPORT_FORMAT_REQUIRED".to_owned());
    }
    let mut seen = Vec::<&str>::new();
    for format in &options.formats {
        if !matches!(
            format.as_str(),
            "json" | "markdown" | "txt" | "docx" | "pdf"
        ) {
            return Err("MVP_EXPORT_FORMAT_UNSUPPORTED".to_owned());
        }
        if seen.contains(&format.as_str()) {
            return Err("MVP_EXPORT_FORMAT_DUPLICATE".to_owned());
        }
        seen.push(format);
    }
    if !options.include_original && !options.include_translation && !options.include_summary {
        return Err("MVP_EXPORT_EMPTY_PROJECTION".to_owned());
    }
    Ok(())
}

fn render_exports(
    snapshot: &MeetingSnapshot,
    options: &ExportOptions,
) -> Result<Vec<RenderedExport>, String> {
    let mut renders = Vec::with_capacity(options.formats.len());
    for format in &options.formats {
        let projection = projection_id(options);
        let manifest_json = validation_manifest_base(snapshot, format, options, &projection);
        let (bytes, text_kind) = match format.as_str() {
            "json" if options.is_legacy_projection() => (render_json(snapshot).into_bytes(), true),
            "markdown" if options.is_legacy_projection() => {
                (render_markdown(snapshot).into_bytes(), true)
            }
            "txt" if options.is_legacy_projection() => (render_txt(snapshot).into_bytes(), true),
            "json" => (
                render_json_with_options(snapshot, options).into_bytes(),
                true,
            ),
            "markdown" => (
                render_markdown_with_options(snapshot, options).into_bytes(),
                true,
            ),
            "txt" => (
                render_txt_with_options(snapshot, options).into_bytes(),
                true,
            ),
            "docx" => (
                render_docx(&document_model(snapshot, options))
                    .map_err(|_| "MVP_EXPORT_DOCUMENT_RENDER_FAILED".to_owned())?,
                false,
            ),
            "pdf" => (
                render_pdf(&document_model(snapshot, options))
                    .map_err(|_| "MVP_EXPORT_DOCUMENT_RENDER_FAILED".to_owned())?,
                false,
            ),
            _ => return Err("MVP_EXPORT_FORMAT_UNSUPPORTED".to_owned()),
        };
        renders.push(RenderedExport {
            format: format.clone(),
            bytes,
            manifest_json,
            text_kind,
        });
    }
    Ok(renders)
}

fn validate_rendered_export(render: &RenderedExport) -> Result<(), String> {
    if render.text_kind {
        let content = std::str::from_utf8(&render.bytes)
            .map_err(|_| "MVP_EXPORT_UTF8_REQUIRED".to_owned())?;
        validate_render(&render.format, content)?;
        return Ok(());
    }
    if render.bytes.is_empty() {
        return Err("MVP_EXPORT_EMPTY_BINARY".to_owned());
    }
    match render.format.as_str() {
        "docx" if render.bytes.starts_with(b"PK\x03\x04") => Ok(()),
        "pdf" if render.bytes.starts_with(b"%PDF-") => Ok(()),
        "docx" | "pdf" => Err("MVP_EXPORT_BINARY_SIGNATURE_INVALID".to_owned()),
        _ => Err("MVP_EXPORT_FORMAT_UNSUPPORTED".to_owned()),
    }
}

fn validate_render(format: &str, content: &str) -> Result<(), String> {
    if !matches!(format, "json" | "markdown" | "txt") {
        return Err("MVP_EXPORT_FORMAT_UNSUPPORTED".to_owned());
    }
    if content.as_bytes().contains(&b'\r') {
        return Err("MVP_EXPORT_CRLF_REJECTED".to_owned());
    }
    if !content.ends_with('\n') {
        return Err("MVP_EXPORT_LF_TERMINATOR_REQUIRED".to_owned());
    }
    Ok(())
}

fn render_json_with_options(snapshot: &MeetingSnapshot, options: &ExportOptions) -> String {
    let mut output = String::new();
    output.push_str("{\n");
    output.push_str("  \"schemaVersion\": 3,\n");
    output.push_str("  \"contractVersion\": \"meetingrelay.mvp.export.v3\",\n");
    output.push_str(&format!(
        "  \"meetingId\": {},\n  \"snapshotId\": {},\n  \"state\": {},\n  \"finalCount\": {},\n  \"semanticSha256\": {},\n",
        json_string(&snapshot.meeting.id),
        json_string(&snapshot.snapshot_id),
        json_string(&snapshot.meeting.state),
        snapshot.finals.len(),
        json_string(&snapshot.semantic_sha256)
    ));
    output.push_str(&format!(
        "  \"projection\": {},\n",
        json_string(&projection_id(options))
    ));
    output.push_str("  \"segments\": [\n");
    for (index, final_segment) in snapshot.finals.iter().enumerate() {
        output.push_str("    {\n");
        output.push_str(&format!(
            "      \"sequence\": {},\n      \"segmentId\": {},\n",
            final_segment.sequence,
            json_string(&final_segment.segment_id)
        ));
        if options.include_timestamp {
            output.push_str(&format!(
                "      \"startedAtMs\": {},\n      \"endedAtMs\": {},\n",
                json_string(&final_segment.started_at_ms),
                json_string(&final_segment.ended_at_ms)
            ));
        }
        if options.include_speaker {
            output.push_str("      \"speaker\": null,\n");
        }
        if options.include_original {
            output.push_str(&format!(
                "      \"original\": {},\n",
                json_string(&final_segment.text)
            ));
        }
        if options.include_translation || options.bilingual {
            output.push_str(&format!(
                "      \"translationTarget\": {},\n      \"translationText\": {},\n",
                json_nullable(final_segment.translation_target.as_deref()),
                json_nullable(final_segment.translation_text.as_deref())
            ));
        }
        trim_trailing_json_comma(&mut output);
        output.push_str(if index + 1 == snapshot.finals.len() {
            "    }\n"
        } else {
            "    },\n"
        });
    }
    output.push_str("  ]");
    if options.include_summary {
        output.push_str(",\n  \"summary\": ");
        push_summary_json(&mut output, options.summary.as_ref());
    }
    output.push_str("\n}\n");
    output
}

fn render_markdown_with_options(snapshot: &MeetingSnapshot, options: &ExportOptions) -> String {
    let mut output = String::new();
    output.push_str("# MeetingRelay Export\n\n");
    output.push_str(&format!(
        "- Meeting ID: `{}`\n- Snapshot ID: `{}`\n- State: `{}`\n- Final count: `{}`\n- Projection: `{}`\n\n",
        escape_markdown_inline(&snapshot.meeting.id),
        escape_markdown_inline(&snapshot.snapshot_id),
        escape_markdown_inline(&snapshot.meeting.state),
        snapshot.finals.len(),
        escape_markdown_inline(&projection_id(options))
    ));
    if options.include_summary {
        push_summary_markdown(&mut output, options.summary.as_ref());
    }
    output.push_str("## Transcript\n\n");
    for final_segment in &snapshot.finals {
        let mut prefix = final_segment.sequence.to_string();
        if options.include_timestamp {
            prefix.push_str(&format!(
                " [{}-{} ms]",
                sanitize_plain(&final_segment.started_at_ms),
                sanitize_plain(&final_segment.ended_at_ms)
            ));
        }
        if options.include_speaker {
            prefix.push_str(" [speaker: unassigned]");
        }
        if options.include_original {
            output.push_str(&format!(
                "{prefix} {}\n\n",
                escape_markdown_text(&final_segment.text)
            ));
        }
        if (options.include_translation || options.bilingual)
            && let Some(translation) = final_segment.translation_text.as_deref()
        {
            output.push_str(&format!(
                "{prefix} Translation ({}): {}\n\n",
                escape_markdown_inline(
                    final_segment
                        .translation_target
                        .as_deref()
                        .unwrap_or("unknown")
                ),
                escape_markdown_text(translation)
            ));
        }
    }
    output
}

fn render_txt_with_options(snapshot: &MeetingSnapshot, options: &ExportOptions) -> String {
    let mut output = String::new();
    output.push_str("MeetingRelay Export\n");
    output.push_str(&format!(
        "Meeting ID: {}\n",
        sanitize_plain(&snapshot.meeting.id)
    ));
    output.push_str(&format!(
        "Snapshot ID: {}\n",
        sanitize_plain(&snapshot.snapshot_id)
    ));
    output.push_str(&format!(
        "State: {}\n",
        sanitize_plain(&snapshot.meeting.state)
    ));
    output.push_str(&format!("Final count: {}\n", snapshot.finals.len()));
    output.push_str(&format!("Projection: {}\n\n", projection_id(options)));
    if options.include_summary {
        push_summary_txt(&mut output, options.summary.as_ref());
    }
    output.push_str("Transcript\n");
    for final_segment in &snapshot.finals {
        let mut prefix = final_segment.sequence.to_string();
        if options.include_timestamp {
            prefix.push_str(&format!(
                " [{}-{} ms]",
                sanitize_plain(&final_segment.started_at_ms),
                sanitize_plain(&final_segment.ended_at_ms)
            ));
        }
        if options.include_speaker {
            prefix.push_str(" [speaker: unassigned]");
        }
        if options.include_original {
            output.push_str(&format!(
                "{prefix} {}\n",
                sanitize_plain(&final_segment.text)
            ));
        }
        if (options.include_translation || options.bilingual)
            && let Some(translation) = final_segment.translation_text.as_deref()
        {
            output.push_str(&format!(
                "{prefix} Translation ({}): {}\n",
                sanitize_plain(
                    final_segment
                        .translation_target
                        .as_deref()
                        .unwrap_or("unknown")
                ),
                sanitize_plain(translation)
            ));
        }
    }
    output
}

fn document_model(snapshot: &MeetingSnapshot, options: &ExportOptions) -> DocumentModel {
    let mut document = DocumentModel::new(format!("MeetingRelay {}", snapshot.meeting.id));
    let metadata = Section::new("Manifest")
        .with_paragraph(format!("Meeting ID: {}", snapshot.meeting.id))
        .with_paragraph(format!("Snapshot ID: {}", snapshot.snapshot_id))
        .with_paragraph(format!("State: {}", snapshot.meeting.state))
        .with_paragraph(format!("Projection: {}", projection_id(options)));
    document = document.with_section(metadata);
    if options.include_summary {
        document = document.with_section(summary_document_section(options.summary.as_ref()));
    }
    let mut transcript = Section::new("Transcript");
    for final_segment in &snapshot.finals {
        if options.include_original {
            transcript = transcript.with_paragraph(projected_segment_line(
                final_segment.sequence,
                options,
                &final_segment.started_at_ms,
                &final_segment.ended_at_ms,
                "Original",
                &final_segment.text,
            ));
        }
        if (options.include_translation || options.bilingual)
            && let Some(translation) = final_segment.translation_text.as_deref()
        {
            transcript = transcript.with_paragraph(projected_segment_line(
                final_segment.sequence,
                options,
                &final_segment.started_at_ms,
                &final_segment.ended_at_ms,
                &format!(
                    "Translation ({})",
                    final_segment
                        .translation_target
                        .as_deref()
                        .unwrap_or("unknown")
                ),
                translation,
            ));
        }
    }
    document.with_section(transcript)
}

fn projected_segment_line(
    sequence: u64,
    options: &ExportOptions,
    started_at_ms: &str,
    ended_at_ms: &str,
    label: &str,
    text: &str,
) -> String {
    let mut prefix = format!("#{sequence}");
    if options.include_timestamp {
        prefix.push_str(&format!(" [{started_at_ms}-{ended_at_ms} ms]"));
    }
    if options.include_speaker {
        prefix.push_str(" [speaker: unassigned]");
    }
    format!("{prefix} {label}: {text}")
}

fn summary_document_section(summary: Option<&ExportSummary>) -> Section {
    let mut section = Section::new("Summary");
    match summary {
        Some(summary) if !summary.sections.is_empty() => {
            for item in &summary.sections {
                section = section.with_paragraph(summary_line(item));
            }
        }
        _ => {
            section = section.with_paragraph(
                "Summary requested but no completed summary version is linked to this export.",
            );
        }
    }
    section
}

fn push_summary_json(output: &mut String, summary: Option<&ExportSummary>) {
    match summary {
        Some(summary) => {
            output.push_str("{\"version\":");
            match summary.version {
                Some(version) => output.push_str(&version.to_string()),
                None => output.push_str("null"),
            }
            output.push_str(",\"sections\":[");
            for (index, section) in summary.sections.iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                output.push_str("{\"kind\":");
                output.push_str(&json_nullable(section.kind.as_deref()));
                output.push_str(",\"heading\":");
                output.push_str(&json_nullable(section.heading.as_deref()));
                output.push_str(",\"text\":");
                output.push_str(&json_string(&section.text));
                output.push_str(",\"citationSegmentIds\":[");
                for (citation_index, segment_id) in section.citation_segment_ids.iter().enumerate()
                {
                    if citation_index > 0 {
                        output.push(',');
                    }
                    output.push_str(&json_string(segment_id));
                }
                output.push_str("]}");
            }
            output.push_str("]}");
        }
        None => output.push_str(
            "{\"version\":null,\"sections\":[{\"kind\":\"unlinked\",\"heading\":\"Summary\",\"text\":\"Summary requested but no completed summary version is linked to this export.\",\"citationSegmentIds\":[]}]}",
        ),
    }
}

fn push_summary_markdown(output: &mut String, summary: Option<&ExportSummary>) {
    output.push_str("## Summary\n\n");
    match summary {
        Some(summary) if !summary.sections.is_empty() => {
            for section in &summary.sections {
                output.push_str(&format!(
                    "- {}{}\n",
                    escape_markdown_text(
                        section
                            .heading
                            .as_deref()
                            .or(section.kind.as_deref())
                            .unwrap_or("Summary")
                    ),
                    summary_text_with_citations(section, true)
                ));
            }
        }
        _ => output.push_str(
            "- Summary requested but no completed summary version is linked to this export.\n",
        ),
    }
    output.push('\n');
}

fn push_summary_txt(output: &mut String, summary: Option<&ExportSummary>) {
    output.push_str("Summary\n");
    match summary {
        Some(summary) if !summary.sections.is_empty() => {
            for section in &summary.sections {
                output.push_str(&format!(
                    "- {}{}\n",
                    sanitize_plain(
                        section
                            .heading
                            .as_deref()
                            .or(section.kind.as_deref())
                            .unwrap_or("Summary")
                    ),
                    summary_text_with_citations(section, false)
                ));
            }
        }
        _ => output.push_str(
            "- Summary requested but no completed summary version is linked to this export.\n",
        ),
    }
    output.push('\n');
}

fn summary_line(section: &ExportSummarySection) -> String {
    format!(
        "{}{}",
        section
            .heading
            .as_deref()
            .or(section.kind.as_deref())
            .unwrap_or("Summary"),
        summary_text_with_citations(section, false)
    )
}

fn summary_text_with_citations(section: &ExportSummarySection, markdown: bool) -> String {
    let text = if markdown {
        escape_markdown_text(&section.text)
    } else {
        sanitize_plain(&section.text)
    };
    if section.citation_segment_ids.is_empty() {
        format!(": {text} (unlinked)")
    } else {
        format!(
            ": {text} [segments: {}]",
            section
                .citation_segment_ids
                .iter()
                .map(|id| {
                    if markdown {
                        escape_markdown_inline(id)
                    } else {
                        sanitize_plain(id)
                    }
                })
                .collect::<Vec<_>>()
                .join(", ")
        )
    }
}

fn trim_trailing_json_comma(output: &mut String) {
    if output.ends_with(",\n") {
        output.truncate(output.len() - 2);
        output.push('\n');
    }
}

fn projection_id(options: &ExportOptions) -> String {
    let mut parts = Vec::new();
    if options.include_original {
        parts.push("original");
    }
    if options.include_translation {
        parts.push("translation");
    }
    if options.bilingual {
        parts.push("bilingual");
    }
    if options.include_speaker {
        parts.push("speaker");
    }
    if options.include_summary {
        parts.push("summary");
    }
    if options.include_timestamp {
        parts.push("timestamp");
    }
    parts.join("+")
}

fn validation_manifest_base(
    snapshot: &MeetingSnapshot,
    format: &str,
    options: &ExportOptions,
    projection: &str,
) -> String {
    let summary_version = options
        .summary
        .as_ref()
        .and_then(|summary| summary.version)
        .or(options.summary_version);
    format!(
        "{{\"format\":{},\"renderer\":\"meetingrelay.export.v4\",\"snapshotId\":{},\"meetingId\":{},\"semanticSha256\":{},\"projection\":{},\"summaryVersion\":{}}}",
        json_string(format),
        json_string(&snapshot.snapshot_id),
        json_string(&snapshot.meeting.id),
        json_string(&snapshot.semantic_sha256),
        json_string(projection),
        summary_version.map_or_else(|| "null".to_owned(), |version| version.to_string())
    )
}

fn manifest_with_integrity(manifest_json: &str, sha256: &str, byte_length: usize) -> String {
    let mut manifest = manifest_json.trim_end().to_owned();
    if manifest.ends_with('}') {
        manifest.pop();
        manifest.push_str(&format!(
            ",\"sha256\":{},\"byteLength\":{byte_length}}}",
            json_string(sha256)
        ));
        manifest
    } else {
        format!(
            "{{\"renderer\":\"meetingrelay.export.v4\",\"sha256\":{},\"byteLength\":{byte_length}}}",
            json_string(sha256)
        )
    }
}

fn render_json(snapshot: &MeetingSnapshot) -> String {
    let mut output = String::new();
    output.push_str("{\n");
    output.push_str("  \"schemaVersion\": 2,\n");
    output.push_str("  \"contractVersion\": \"meetingrelay.mvp.durable.v2\",\n");
    output.push_str(&format!(
        "  \"meetingId\": {},\n  \"snapshotId\": {},\n  \"state\": {},\n  \"finalCount\": {},\n",
        json_string(&snapshot.meeting.id),
        json_string(&snapshot.snapshot_id),
        json_string(&snapshot.meeting.state),
        snapshot.finals.len()
    ));
    output.push_str(&format!(
        "  \"semanticSha256\": {},\n  \"finals\": [\n",
        json_string(&snapshot.semantic_sha256)
    ));
    for (index, final_segment) in snapshot.finals.iter().enumerate() {
        output.push_str("    {\n");
        output.push_str(&format!(
            "      \"sequence\": {},\n      \"segmentId\": {},\n      \"revision\": {},\n      \"startedAtMs\": {},\n      \"endedAtMs\": {},\n      \"committedAt\": {},\n      \"commitId\": {},\n      \"text\": {},\n      \"translationStatus\": {},\n      \"translationTarget\": {},\n      \"translationText\": {},\n      \"translationError\": {}\n",
            final_segment.sequence,
            json_string(&final_segment.segment_id),
            final_segment.revision,
            json_string(&final_segment.started_at_ms),
            json_string(&final_segment.ended_at_ms),
            json_string(&final_segment.committed_at),
            json_string(&final_segment.commit_id),
            json_string(&final_segment.text),
            json_string(&final_segment.translation_status),
            json_nullable(final_segment.translation_target.as_deref()),
            json_nullable(final_segment.translation_text.as_deref()),
            json_nullable(final_segment.translation_error.as_deref())
        ));
        output.push_str(if index + 1 == snapshot.finals.len() {
            "    }\n"
        } else {
            "    },\n"
        });
    }
    output.push_str("  ]\n}\n");
    output
}

fn render_markdown(snapshot: &MeetingSnapshot) -> String {
    let mut output = String::new();
    output.push_str("# MeetingRelay MVP Transcript\n\n");
    output.push_str(&format!(
        "- Meeting ID: `{}`\n- Snapshot ID: `{}`\n- State: `{}`\n- Final count: `{}`\n\n",
        escape_markdown_inline(&snapshot.meeting.id),
        escape_markdown_inline(&snapshot.snapshot_id),
        escape_markdown_inline(&snapshot.meeting.state),
        snapshot.finals.len()
    ));
    output.push_str("## Transcript\n\n");
    for final_segment in &snapshot.finals {
        output.push_str(&format!(
            "{}. [{}-{} ms] {}\n\n",
            final_segment.sequence,
            escape_markdown_inline(&final_segment.started_at_ms),
            escape_markdown_inline(&final_segment.ended_at_ms),
            escape_markdown_text(&final_segment.text)
        ));
        if let Some(translation) = final_segment.translation_text.as_deref() {
            output.push_str(&format!(
                "   - Translation ({})：{}\n\n",
                escape_markdown_inline(
                    final_segment
                        .translation_target
                        .as_deref()
                        .unwrap_or("unknown")
                ),
                escape_markdown_text(translation)
            ));
        } else if final_segment.translation_status == "failed" {
            output.push_str(&format!(
                "   - Translation failed: `{}`\n\n",
                escape_markdown_inline(
                    final_segment
                        .translation_error
                        .as_deref()
                        .unwrap_or("TRANSLATION_FAILED")
                )
            ));
        }
    }
    output
}

fn render_txt(snapshot: &MeetingSnapshot) -> String {
    let mut output = String::new();
    output.push_str("MeetingRelay MVP Transcript\n");
    output.push_str(&format!(
        "Meeting ID: {}\n",
        sanitize_plain(&snapshot.meeting.id)
    ));
    output.push_str(&format!(
        "Snapshot ID: {}\n",
        sanitize_plain(&snapshot.snapshot_id)
    ));
    output.push_str(&format!(
        "State: {}\n",
        sanitize_plain(&snapshot.meeting.state)
    ));
    output.push_str(&format!("Final count: {}\n\n", snapshot.finals.len()));
    for final_segment in &snapshot.finals {
        output.push_str(&format!(
            "{} [{}-{} ms] {}\n",
            final_segment.sequence,
            sanitize_plain(&final_segment.started_at_ms),
            sanitize_plain(&final_segment.ended_at_ms),
            sanitize_plain(&final_segment.text)
        ));
        if let Some(translation) = final_segment.translation_text.as_deref() {
            output.push_str(&format!(
                "  Translation ({}): {}\n",
                sanitize_plain(
                    final_segment
                        .translation_target
                        .as_deref()
                        .unwrap_or("unknown")
                ),
                sanitize_plain(translation)
            ));
        } else if final_segment.translation_status == "failed" {
            output.push_str(&format!(
                "  Translation failed: {}\n",
                sanitize_plain(
                    final_segment
                        .translation_error
                        .as_deref()
                        .unwrap_or("TRANSLATION_FAILED")
                )
            ));
        }
    }
    output
}

fn render_transcript_text(snapshot: &MeetingSnapshot) -> String {
    let mut output = String::new();
    output.push_str("MeetingRelay 转写记录\n");
    output.push_str(&format!("会议 ID: {}\n", snapshot.meeting.id));
    output.push_str(&format!("状态: {}\n", snapshot.meeting.state));
    output.push_str(&format!("已保存片段: {}\n\n", snapshot.finals.len()));
    for final_segment in &snapshot.finals {
        output.push_str(&format!(
            "[{}] {}\n",
            final_segment.sequence, final_segment.text
        ));
        if let Some(translation) = final_segment.translation_text.as_deref() {
            output.push_str(&format!(
                "    译文 ({}): {}\n",
                final_segment
                    .translation_target
                    .as_deref()
                    .unwrap_or("unknown"),
                translation
            ));
        }
    }
    output
}

fn json_string(value: &str) -> String {
    let mut output = String::from("\"");
    for character in value.chars() {
        match character {
            '"' => output.push_str("\\\""),
            '\\' => output.push_str("\\\\"),
            '\n' => output.push_str("\\n"),
            '\r' => output.push_str("\\r"),
            '\t' => output.push_str("\\t"),
            c if c.is_control() => output.push_str(&format!("\\u{:04x}", c as u32)),
            c => output.push(c),
        }
    }
    output.push('"');
    output
}

fn json_nullable(value: Option<&str>) -> String {
    value.map_or_else(|| "null".to_owned(), json_string)
}

fn escape_markdown_inline(value: &str) -> String {
    sanitize_plain(value).replace('`', "'")
}

fn escape_markdown_text(value: &str) -> String {
    sanitize_plain(value)
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('[', "\\[")
        .replace(']', "\\]")
}

fn sanitize_plain(value: &str) -> String {
    value
        .chars()
        .map(|character| match character {
            '\r' | '\n' | '\t' => ' ',
            c if c.is_control() => ' ',
            c => c,
        })
        .collect()
}

fn safe_file_component(value: &str) -> String {
    let safe = value
        .chars()
        .map(|character| match character {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '-' | '_' => character,
            _ => '-',
        })
        .take(80)
        .collect::<String>();
    if safe.is_empty() {
        "unknown".to_owned()
    } else {
        safe
    }
}

#[cfg(test)]
mod tests {
    use std::env;
    use std::path::PathBuf;

    use super::*;
    use crate::mvp::storage::{FinalCandidate, MvpStorage, MvpStorageWriter};

    fn temp_root(test_name: &str) -> PathBuf {
        let root = env::temp_dir().join(format!(
            "meetingrelay-export-{test_name}-{}",
            now_ms_string()
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn seed_meeting(writer: &MvpStorageWriter) -> String {
        let meeting = writer.start_meeting(true, "test model").unwrap();
        for sequence in 1..=3 {
            writer
                .commit_final(FinalCandidate {
                    meeting_id: meeting.id.clone(),
                    segment_id: format!("segment-{sequence}"),
                    sequence,
                    revision: 1,
                    text: if sequence == 2 {
                        "<script>alert('x')</script> ../secret\r\nline".to_owned()
                    } else {
                        format!("line {sequence}")
                    },
                    started_at_ms: (sequence * 10).to_string(),
                    ended_at_ms: (sequence * 10 + 5).to_string(),
                    meeting_sample_start: sequence.saturating_mul(160),
                    meeting_sample_end: sequence.saturating_mul(160).saturating_add(80),
                    timeline_revision: 1,
                })
                .unwrap();
        }
        writer.complete_meeting(&meeting.id).unwrap();
        meeting.id
    }

    fn snapshot_for_options() -> MeetingSnapshot {
        MeetingSnapshot {
            meeting: crate::mvp::storage::MeetingRecord {
                id: "meeting-options".to_owned(),
                state: "completed".to_owned(),
                started_at: "2026-07-25T00:00:00Z".to_owned(),
                ended_at: Some("2026-07-25T01:00:00Z".to_owned()),
                last_final_sequence: 2,
                completion_error: None,
            },
            finals: vec![
                crate::mvp::storage::DurableFinal {
                    meeting_id: "meeting-options".to_owned(),
                    segment_id: "segment-1".to_owned(),
                    sequence: 1,
                    revision: 1,
                    text: "中文记录 English line".to_owned(),
                    started_at_ms: "0".to_owned(),
                    ended_at_ms: "1000".to_owned(),
                    content_sha256: sha256_hex("中文记录 English line".as_bytes()),
                    committed_at: "2026-07-25T00:00:01Z".to_owned(),
                    commit_id: "commit-1".to_owned(),
                    meeting_sample_start: 0,
                    meeting_sample_end: 16_000,
                    timeline_revision: 1,
                    translation_status: "completed".to_owned(),
                    translation_target: Some("ja".to_owned()),
                    translation_text: Some("日本語の翻訳 English".to_owned()),
                    translation_error: None,
                },
                crate::mvp::storage::DurableFinal {
                    meeting_id: "meeting-options".to_owned(),
                    segment_id: "segment-2".to_owned(),
                    sequence: 2,
                    revision: 1,
                    text: "long ".repeat(200),
                    started_at_ms: "1000".to_owned(),
                    ended_at_ms: "2000".to_owned(),
                    content_sha256: sha256_hex("long".as_bytes()),
                    committed_at: "2026-07-25T00:00:02Z".to_owned(),
                    commit_id: "commit-2".to_owned(),
                    meeting_sample_start: 16_000,
                    meeting_sample_end: 32_000,
                    timeline_revision: 1,
                    translation_status: "pending".to_owned(),
                    translation_target: None,
                    translation_text: None,
                    translation_error: None,
                },
            ],
            snapshot_id: "snapshot-options".to_owned(),
            snapshot_generation: 1,
            semantic_sha256: sha256_hex("snapshot-options".as_bytes()),
        }
    }

    fn rich_export_options() -> ExportOptions {
        ExportOptions {
            formats: vec![
                "json".to_owned(),
                "markdown".to_owned(),
                "txt".to_owned(),
                "docx".to_owned(),
                "pdf".to_owned(),
            ],
            include_original: true,
            include_translation: true,
            bilingual: true,
            include_speaker: true,
            include_summary: true,
            include_timestamp: true,
            summary_version: Some(7),
            summary: Some(ExportSummary {
                version: Some(7),
                sections: vec![ExportSummarySection {
                    kind: Some("decision".to_owned()),
                    heading: Some("决定".to_owned()),
                    text: "采用本地优先导出，并保留引用。".to_owned(),
                    citation_segment_ids: vec!["segment-1".to_owned()],
                }],
            }),
        }
    }

    #[test]
    fn selected_exports_render_text_docx_pdf_with_projection_manifest_and_cjk() {
        let snapshot = snapshot_for_options();
        let options = rich_export_options();
        let renders = render_exports(&snapshot, &options).unwrap();
        assert_eq!(renders.len(), 5);
        for render in &renders {
            validate_rendered_export(render).unwrap();
            assert!(
                render
                    .manifest_json
                    .contains("\"renderer\":\"meetingrelay.export.v4\"")
            );
            assert!(render.manifest_json.contains("\"projection\""));
            assert!(render.manifest_json.contains("\"summaryVersion\":7"));
        }
        let json = renders
            .iter()
            .find(|render| render.format == "json")
            .unwrap();
        let json_text = String::from_utf8(json.bytes.clone()).unwrap();
        assert!(json_text.contains("\"speaker\": null"));
        assert!(json_text.contains("segment-1"));
        assert!(json_text.contains("中文记录"));

        let docx = renders
            .iter()
            .find(|render| render.format == "docx")
            .unwrap();
        assert!(docx.bytes.starts_with(b"PK\x03\x04"));
        let docx_text = String::from_utf8_lossy(&docx.bytes);
        assert!(docx_text.contains("MeetingRelay"));
        assert!(docx_text.contains("segment-1"));

        let pdf = renders
            .iter()
            .find(|render| render.format == "pdf")
            .unwrap();
        assert!(pdf.bytes.starts_with(b"%PDF-"));
        let pdf_text = String::from_utf8_lossy(&pdf.bytes);
        assert!(pdf_text.contains("source-manifest.json"));
        assert!(pdf_text.contains("segment-1"));
    }

    #[test]
    fn export_writes_json_markdown_txt_from_one_snapshot_with_lf_utf8() {
        let root = temp_root("same-snapshot");
        let storage = MvpStorage::open_at(root.join("db.sqlite3")).unwrap();
        let writer = MvpStorageWriter::start(storage.clone()).unwrap();
        let meeting_id = seed_meeting(&writer);
        let export = export_meeting(&storage, &writer, &meeting_id, "out").unwrap();
        assert_eq!(export.final_count, 3);
        assert_eq!(export.artifacts.len(), 3);
        for artifact in &export.artifacts {
            let bytes = fs::read(&artifact.path).unwrap();
            assert_eq!(artifact.byte_length, bytes.len());
            assert_eq!(artifact.sha256, sha256_hex(&bytes));
            let text = String::from_utf8(bytes).unwrap();
            assert!(text.ends_with('\n'));
            assert!(!text.contains('\r'));
            assert!(text.contains(&meeting_id));
            assert!(text.contains(&export.snapshot_id));
            if artifact.format == "json" {
                let tauri::ipc::InvokeBody::Json(parsed) =
                    tauri::ipc::InvokeBody::Json(text.parse().unwrap())
                else {
                    panic!("JSON parser returned a raw body");
                };
                assert_eq!(
                    parsed.get("meetingId").and_then(|value| value.as_str()),
                    Some(meeting_id.as_str())
                );
                assert_eq!(
                    parsed.get("snapshotId").and_then(|value| value.as_str()),
                    Some(export.snapshot_id.as_str())
                );
                assert_eq!(
                    parsed.get("finalCount").and_then(|value| value.as_u64()),
                    Some(3)
                );
                assert_eq!(
                    parsed
                        .get("finals")
                        .and_then(|value| value.as_array())
                        .map(Vec::len),
                    Some(3)
                );
            }
        }
        let snapshot_mentions = export
            .artifacts
            .iter()
            .map(|artifact| {
                let text = fs::read_to_string(&artifact.path).unwrap();
                text.contains(&export.snapshot_id)
            })
            .collect::<Vec<_>>();
        assert_eq!(snapshot_mentions, vec![true, true, true]);
    }

    #[test]
    fn export_refuses_recording_meeting() {
        let root = temp_root("recording");
        let storage = MvpStorage::open_at(root.join("db.sqlite3")).unwrap();
        let writer = MvpStorageWriter::start(storage.clone()).unwrap();
        let meeting = writer.start_meeting(true, "test model").unwrap();
        assert_eq!(
            export_meeting(&storage, &writer, &meeting.id, "out").unwrap_err(),
            "MVP_EXPORT_RECORDING_NOT_ALLOWED"
        );
    }

    #[test]
    fn incomplete_meeting_cannot_export_or_copy_without_a_data_loss_warning() {
        let root = temp_root("incomplete");
        let storage = MvpStorage::open_at(root.join("db.sqlite3")).unwrap();
        let writer = MvpStorageWriter::start(storage.clone()).unwrap();
        let meeting = writer.start_meeting(true, "test model").unwrap();
        writer
            .commit_final(FinalCandidate {
                meeting_id: meeting.id.clone(),
                segment_id: "segment-1".to_owned(),
                sequence: 1,
                revision: 1,
                text: "saved before overload".to_owned(),
                started_at_ms: "0".to_owned(),
                ended_at_ms: "1000".to_owned(),
                meeting_sample_start: 0,
                meeting_sample_end: 16_000,
                timeline_revision: 1,
            })
            .unwrap();
        writer
            .incomplete_meeting(&meeting.id, "ASR_FINAL_OVERLOAD")
            .unwrap();

        assert_eq!(
            export_meeting(&storage, &writer, &meeting.id, "out").unwrap_err(),
            "MVP_EXPORT_INCOMPLETE:ASR_FINAL_OVERLOAD"
        );
        assert_eq!(
            transcript_text(&storage, &meeting.id).unwrap_err(),
            "MVP_COPY_INCOMPLETE:ASR_FINAL_OVERLOAD"
        );
    }

    #[test]
    fn clipboard_text_reads_every_committed_final_from_storage() {
        let root = temp_root("clipboard-complete");
        let storage = MvpStorage::open_at(root.join("db.sqlite3")).unwrap();
        let writer = MvpStorageWriter::start(storage.clone()).unwrap();
        let meeting = writer.start_meeting(true, "test model").unwrap();
        for sequence in 1..=70 {
            writer
                .commit_final(FinalCandidate {
                    meeting_id: meeting.id.clone(),
                    segment_id: format!("segment-{sequence}"),
                    sequence,
                    revision: 1,
                    text: format!("完整片段 {sequence}"),
                    started_at_ms: sequence.to_string(),
                    ended_at_ms: (sequence + 1).to_string(),
                    meeting_sample_start: sequence.saturating_mul(16),
                    meeting_sample_end: sequence.saturating_add(1).saturating_mul(16),
                    timeline_revision: 1,
                })
                .unwrap();
        }
        writer.complete_meeting(&meeting.id).unwrap();

        let text = transcript_text(&storage, &meeting.id).unwrap();

        assert!(text.contains("已保存片段: 70"));
        assert!(text.contains("[1] 完整片段 1"));
        assert!(text.contains("[70] 完整片段 70"));
    }

    #[test]
    fn clipboard_text_rejects_recording_and_empty_meetings() {
        let root = temp_root("clipboard-invalid");
        let storage = MvpStorage::open_at(root.join("db.sqlite3")).unwrap();
        let writer = MvpStorageWriter::start(storage.clone()).unwrap();
        let meeting = writer.start_meeting(true, "test model").unwrap();
        assert_eq!(
            transcript_text(&storage, &meeting.id).unwrap_err(),
            "MVP_COPY_RECORDING_NOT_ALLOWED"
        );
        writer.complete_meeting(&meeting.id).unwrap();
        assert_eq!(
            transcript_text(&storage, &meeting.id).unwrap_err(),
            "MVP_COPY_EMPTY"
        );
    }

    #[test]
    fn failed_target_directory_does_not_publish_half_file() {
        let root = temp_root("failed-target");
        let storage = MvpStorage::open_at(root.join("db.sqlite3")).unwrap();
        let writer = MvpStorageWriter::start(storage.clone()).unwrap();
        let meeting_id = seed_meeting(&writer);
        let not_dir = storage.default_export_dir().join("not-dir");
        fs::create_dir_all(storage.default_export_dir()).unwrap();
        fs::write(&not_dir, b"not a directory").unwrap();
        assert_eq!(
            export_meeting(&storage, &writer, &meeting_id, "not-dir").unwrap_err(),
            "MVP_EXPORT_TARGET_UNAVAILABLE"
        );
        let published = fs::read_dir(storage.default_export_dir())
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .contains("meetingrelay-")
            })
            .count();
        assert_eq!(published, 0);
    }

    fn export_rows(storage: &MvpStorage) -> (i64, i64) {
        let connection = rusqlite::Connection::open(
            storage
                .default_export_dir()
                .parent()
                .unwrap()
                .join("db.sqlite3"),
        )
        .unwrap();
        let snapshots = connection
            .query_row("SELECT COUNT(*) FROM mvp_export_snapshots", [], |row| {
                row.get(0)
            })
            .unwrap();
        let exports = connection
            .query_row("SELECT COUNT(*) FROM mvp_exports", [], |row| row.get(0))
            .unwrap();
        (snapshots, exports)
    }

    fn final_artifacts(root: &Path) -> Vec<PathBuf> {
        fs::read_dir(root)
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| path.is_file())
            .filter(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with("meetingrelay-"))
            })
            .collect()
    }

    fn staging_dirs(root: &Path) -> Vec<PathBuf> {
        fs::read_dir(root)
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| path.is_dir())
            .filter(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.ends_with(".staging"))
            })
            .collect()
    }

    #[test]
    fn second_format_publish_failure_removes_this_bundle_and_records_no_db_rows() {
        let root = temp_root("publish-failure");
        let storage = MvpStorage::open_at(root.join("db.sqlite3")).unwrap();
        let writer = MvpStorageWriter::start(storage.clone()).unwrap();
        let meeting_id = seed_meeting(&writer);
        fail_publish_after_for_test(2);
        assert_eq!(
            export_meeting(&storage, &writer, &meeting_id, "out").unwrap_err(),
            "MVP_EXPORT_ATOMIC_PUBLISH_FAILED"
        );
        assert!(final_artifacts(&storage.default_export_dir().join("out")).is_empty());
        assert_eq!(export_rows(&storage), (0, 0));
        let retry = export_meeting(&storage, &writer, &meeting_id, "out").unwrap();
        assert_eq!(retry.artifacts.len(), 3);
        assert_eq!(export_rows(&storage), (1, 3));
    }

    #[test]
    fn db_record_failure_removes_this_bundle_preserves_old_files_and_retry_succeeds() {
        let root = temp_root("db-record-failure");
        let storage = MvpStorage::open_at(root.join("db.sqlite3")).unwrap();
        let writer = MvpStorageWriter::start(storage.clone()).unwrap();
        let meeting_id = seed_meeting(&writer);
        let first = export_meeting(&storage, &writer, &meeting_id, "out").unwrap();
        let old_paths = first
            .artifacts
            .iter()
            .map(|artifact| artifact.path.clone())
            .collect::<Vec<_>>();
        fail_db_record_for_test(true);
        assert_eq!(
            export_meeting(&storage, &writer, &meeting_id, "out").unwrap_err(),
            "MVP_STORAGE_EXPORT_RECORD_FAILED"
        );
        for path in &old_paths {
            assert!(Path::new(path).exists());
        }
        assert_eq!(export_rows(&storage), (1, 3));
        let retry = export_meeting(&storage, &writer, &meeting_id, "out").unwrap();
        assert_eq!(retry.artifacts.len(), 3);
        assert_eq!(export_rows(&storage), (2, 6));
    }

    #[test]
    fn export_refuses_existing_target_without_overwriting_old_file() {
        let root = temp_root("target-exists");
        let storage = MvpStorage::open_at(root.join("db.sqlite3")).unwrap();
        let writer = MvpStorageWriter::start(storage.clone()).unwrap();
        let meeting_id = seed_meeting(&writer);
        let snapshot = storage.snapshot(&meeting_id).unwrap();
        let out_dir = storage.default_export_dir().join("out");
        fs::create_dir_all(&out_dir).unwrap();
        let existing_target = out_dir.join(format!(
            "meetingrelay-{}-{}.json",
            safe_file_component(&meeting_id),
            safe_file_component(&snapshot.snapshot_id[..16])
        ));
        fs::write(&existing_target, b"old export bytes").unwrap();

        assert_eq!(
            export_meeting(&storage, &writer, &meeting_id, "out").unwrap_err(),
            "MVP_EXPORT_TARGET_EXISTS"
        );
        assert_eq!(fs::read(&existing_target).unwrap(), b"old export bytes");
        assert!(staging_dirs(&out_dir).is_empty());
        assert_eq!(export_rows(&storage), (0, 0));
    }

    #[test]
    fn cleanup_failure_after_db_record_failure_returns_cleanup_error_and_keeps_old_files() {
        let root = temp_root("cleanup-failure");
        let storage = MvpStorage::open_at(root.join("db.sqlite3")).unwrap();
        let writer = MvpStorageWriter::start(storage.clone()).unwrap();
        let meeting_id = seed_meeting(&writer);
        let first = export_meeting(&storage, &writer, &meeting_id, "out").unwrap();
        let old_paths = first
            .artifacts
            .iter()
            .map(|artifact| artifact.path.clone())
            .collect::<Vec<_>>();

        fail_db_record_for_test(true);
        fail_cleanup_file_for_test(true);
        assert_eq!(
            export_meeting(&storage, &writer, &meeting_id, "out").unwrap_err(),
            "MVP_EXPORT_CLEANUP_FAILED"
        );
        fail_cleanup_file_for_test(false);
        for path in &old_paths {
            assert!(Path::new(path).exists());
        }
        assert_eq!(export_rows(&storage), (1, 3));
    }

    #[test]
    fn cleanup_replacement_during_publish_failure_fails_closed() {
        let root = temp_root("cleanup-replacement");
        let storage = MvpStorage::open_at(root.join("db.sqlite3")).unwrap();
        let writer = MvpStorageWriter::start(storage.clone()).unwrap();
        let meeting_id = seed_meeting(&writer);

        fail_publish_after_for_test(2);
        replace_first_cleanup_file_with_for_test(b"attacker replacement".to_vec());
        assert_eq!(
            export_meeting(&storage, &writer, &meeting_id, "out").unwrap_err(),
            "MVP_EXPORT_CLEANUP_FAILED"
        );
        assert_eq!(export_rows(&storage), (0, 0));
        assert!(
            final_artifacts(&storage.default_export_dir().join("out"))
                .iter()
                .any(|path| fs::read(path).unwrap() == b"attacker replacement")
        );
    }

    #[test]
    fn cleanup_refuses_paths_outside_export_root() {
        let root = temp_root("cleanup-scope");
        let export_root = root.join("exports");
        let outside = root.join("outside.txt");
        fs::create_dir_all(&export_root).unwrap();
        fs::write(&outside, b"owned bytes").unwrap();
        assert_eq!(
            cleanup_file(
                &export_root,
                &outside,
                b"owned bytes".len(),
                &sha256_hex(b"owned bytes")
            )
            .unwrap_err(),
            "MVP_EXPORT_CLEANUP_FAILED"
        );
        assert_eq!(fs::read(&outside).unwrap(), b"owned bytes");
    }

    #[test]
    fn export_rejects_absolute_or_parent_relative_targets() {
        let root = temp_root("scope");
        let storage = MvpStorage::open_at(root.join("db.sqlite3")).unwrap();
        let writer = MvpStorageWriter::start(storage.clone()).unwrap();
        let meeting_id = seed_meeting(&writer);
        assert_eq!(
            export_meeting(&storage, &writer, &meeting_id, root.join("absolute")).unwrap_err(),
            "MVP_EXPORT_TARGET_SCOPE_REJECTED"
        );
        assert_eq!(
            export_meeting(&storage, &writer, &meeting_id, "..\\outside").unwrap_err(),
            "MVP_EXPORT_TARGET_SCOPE_REJECTED"
        );
    }

    #[test]
    fn export_rejects_symlink_escape_when_platform_supports_it() {
        let root = temp_root("symlink");
        let storage = MvpStorage::open_at(root.join("db.sqlite3")).unwrap();
        let writer = MvpStorageWriter::start(storage.clone()).unwrap();
        let meeting_id = seed_meeting(&writer);
        let outside = root.join("outside");
        fs::create_dir_all(&outside).unwrap();
        let exports = storage.default_export_dir();
        fs::create_dir_all(&exports).unwrap();
        let link = exports.join("link-out");
        if create_dir_symlink(&outside, &link).is_err() {
            return;
        }
        assert_eq!(
            export_meeting(&storage, &writer, &meeting_id, "link-out").unwrap_err(),
            "MVP_EXPORT_TARGET_REPARSE_REJECTED"
        );
    }

    #[cfg(windows)]
    fn create_dir_symlink(target: &Path, link: &Path) -> std::io::Result<()> {
        let output = std::process::Command::new("cmd.exe")
            .args(["/d", "/c", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .output()?;
        if output.status.success() {
            Ok(())
        } else {
            Err(std::io::Error::other("mklink /J failed"))
        }
    }

    #[cfg(unix)]
    fn create_dir_symlink(target: &Path, link: &Path) -> std::io::Result<()> {
        std::os::unix::fs::symlink(target, link)
    }

    #[cfg(not(any(windows, unix)))]
    fn create_dir_symlink(_target: &Path, _link: &Path) -> std::io::Result<()> {
        Err(std::io::Error::other("directory symlinks unsupported"))
    }
}
