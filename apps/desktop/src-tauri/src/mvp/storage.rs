use std::{
    env, fs, io,
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc::{Receiver, SyncSender, TrySendError, sync_channel},
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use rusqlite::{
    Connection, OptionalExtension, Transaction, params, params_from_iter, types::Value,
};

use super::contract::{MAX_FINAL_SEGMENTS, MVP_CONTRACT_VERSION, TranscriptSegment};

const MVP_SCHEMA_V1_CHECKSUM: &str =
    "meetingrelay.mvp.sqlite.v1:meetings/finals/events/export-snapshots/exports";
const MVP_SCHEMA_V2_CHECKSUM: &str =
    "meetingrelay.mvp.sqlite.v2:meetings/finals/translations/events/export-snapshots/exports";
const MVP_SCHEMA_V3_CHECKSUM: &str =
    "meetingrelay.mvp.sqlite.v3:durable-same-language-translation-status";
const MVP_SCHEMA_V4_CHECKSUM: &str =
    "meetingrelay.mvp.sqlite.v4:translation-attempt-provenance-diagnostics";
pub const MVP_SCHEMA_VERSION: i64 = 5;
pub const MVP_SCHEMA_CHECKSUM: &str =
    "meetingrelay.mvp.sqlite.v5:meeting-library-tags-provider-profiles-summary-delete";
pub const STORAGE_QUEUE_DEPTH: usize = 8;
const STORAGE_PAGE_LIMIT_MAX: usize = 100;
const STORAGE_SEARCH_LIMIT_MAX: usize = 100;
#[allow(dead_code)]
const TRANSLATION_PROMPT_VERSION: &str = "meetingrelay.translation.prompt.v1";
#[allow(dead_code)]
const TRANSLATION_REQUEST_SCHEMA_VERSION: &str = "openai.chat.completions.v1";
#[allow(dead_code)]
const TRANSLATION_CONFIG_VERSION_UNKNOWN: &str = "unknown";
#[allow(dead_code)]
const TRANSLATION_PROVIDER_UNKNOWN: &str = "unknown";

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MvpStorage {
    db_path: PathBuf,
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingRecord {
    pub id: String,
    pub state: String,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub last_final_sequence: u64,
    pub completion_error: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InterruptedMeetingRecord {
    pub meeting_id: String,
    pub started_at: String,
    pub updated_at: String,
    pub saved_final_count: String,
    pub pending_final_count: String,
    pub translation_failed_count: usize,
    pub reason: Option<String>,
    pub recommended_action: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DurableFinal {
    pub meeting_id: String,
    pub segment_id: String,
    pub sequence: u64,
    pub revision: u32,
    pub text: String,
    pub started_at_ms: String,
    pub ended_at_ms: String,
    pub content_sha256: String,
    pub committed_at: String,
    pub commit_id: String,
    pub meeting_sample_start: u64,
    pub meeting_sample_end: u64,
    pub timeline_revision: u32,
    pub translation_status: String,
    pub translation_target: Option<String>,
    pub translation_text: Option<String>,
    pub translation_error: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FinalCandidate {
    pub meeting_id: String,
    pub segment_id: String,
    pub sequence: u64,
    pub revision: u32,
    pub text: String,
    pub started_at_ms: String,
    pub ended_at_ms: String,
    pub meeting_sample_start: u64,
    pub meeting_sample_end: u64,
    pub timeline_revision: u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[allow(dead_code)]
pub enum RecoveryActionKind {
    Recover,
    Finalize,
    KeepInterrupted,
}

impl RecoveryActionKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Recover => "recover",
            Self::Finalize => "finalize",
            Self::KeepInterrupted => "keep_interrupted",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RecoveryActionRecord {
    pub action_id: String,
    pub meeting_id: String,
    pub action: String,
    pub result_state: String,
    pub created_at: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TranslationCandidate {
    pub meeting_id: String,
    pub segment_id: String,
    pub source_revision: u32,
    pub target_language: String,
    pub model: String,
    pub provider: String,
    pub config_version: String,
    pub endpoint_origin: Option<String>,
    pub endpoint_hash: String,
    pub prompt_version: String,
    pub request_schema_version: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TranslationCompletion {
    pub meeting_id: String,
    pub segment_id: String,
    pub source_revision: u32,
    pub target_language: String,
    pub attempt: u32,
    pub translated_text: Option<String>,
    pub error_code: Option<String>,
    pub retryable: bool,
    pub skipped_same_language: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TranslationAttemptRecord {
    pub meeting_id: String,
    pub segment_id: String,
    pub source_revision: u32,
    pub target_language: String,
    pub attempt: u32,
    pub provider: String,
    pub config_version: String,
    pub endpoint_origin: Option<String>,
    pub endpoint_hash: String,
    pub model: String,
    pub prompt_version: String,
    pub request_schema_version: String,
    pub status: String,
    pub error_code: Option<String>,
    pub retryable: bool,
    pub requested_at: String,
    pub completed_at: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[allow(dead_code)]
pub struct FailedTranslationRetryItem {
    pub meeting_id: String,
    pub segment_id: String,
    pub source_revision: u32,
    pub target_language: String,
    pub model: String,
    pub last_error_code: String,
    pub last_attempt: u32,
    pub retryable: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[allow(dead_code)]
pub struct TranslationRetryPlan {
    pub meeting_id: String,
    pub total: usize,
    pub retryable: usize,
    pub non_retryable: usize,
    pub items: Vec<FailedTranslationRetryItem>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[allow(dead_code)]
pub struct DiskCheck {
    pub code: String,
    pub interrupted_only: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticBundle {
    pub app_contract_version: String,
    pub schema_version: i64,
    pub schema_checksum: String,
    pub model_label: Option<String>,
    pub provider_versions: Vec<String>,
    pub storage_queue_depth: usize,
    pub translation_queue_depth: usize,
    pub disk_code: Option<String>,
    pub error_codes: Vec<String>,
}

impl TranslationCandidate {
    #[allow(dead_code)]
    pub fn legacy(
        meeting_id: String,
        segment_id: String,
        source_revision: u32,
        target_language: String,
        model: String,
    ) -> Self {
        Self {
            meeting_id,
            segment_id,
            source_revision,
            target_language,
            model,
            provider: TRANSLATION_PROVIDER_UNKNOWN.to_owned(),
            config_version: TRANSLATION_CONFIG_VERSION_UNKNOWN.to_owned(),
            endpoint_origin: None,
            endpoint_hash: String::new(),
            prompt_version: TRANSLATION_PROMPT_VERSION.to_owned(),
            request_schema_version: TRANSLATION_REQUEST_SCHEMA_VERSION.to_owned(),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CommitAck {
    pub final_segment: DurableFinal,
    pub duplicate: bool,
    pub latency_micros: u128,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MeetingSnapshot {
    pub meeting: MeetingRecord,
    pub finals: Vec<DurableFinal>,
    pub snapshot_id: String,
    pub snapshot_generation: u64,
    pub semantic_sha256: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[allow(dead_code)]
pub struct CommitMetrics {
    pub committed: usize,
    pub duplicate: usize,
    pub rejected: usize,
    pub p95_micros: u128,
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingLibraryItem {
    pub meeting_id: String,
    pub title: String,
    pub state: String,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub duration_ms: Option<u64>,
    pub language: String,
    pub final_count: usize,
    pub translation_count: usize,
    pub translation_failed_count: usize,
    pub export_count: usize,
    pub summary_job_count: usize,
    pub summary_status: String,
    pub tags: Vec<TagRecord>,
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingLibraryPage {
    pub items: Vec<MeetingLibraryItem>,
    pub next_cursor: Option<String>,
    pub total: usize,
    pub page_size: usize,
    pub elapsed_ms: u128,
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingLibraryQuery {
    pub query: String,
    pub tags: Vec<String>,
    pub cursor: Option<String>,
    pub page_size: usize,
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SegmentSearchQuery {
    pub text: Option<String>,
    pub scopes: Vec<String>,
    pub meeting_id: Option<String>,
    pub tag_ids: Vec<String>,
    pub limit: usize,
    pub cursor: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SegmentSearchHit {
    pub meeting_id: String,
    pub segment_id: String,
    pub sequence: u64,
    pub source_revision: u32,
    pub scope: String,
    pub text: String,
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SegmentSearchPage {
    pub hits: Vec<SegmentSearchHit>,
    pub next_cursor: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagRecord {
    pub tag_id: String,
    pub name: String,
    pub color: Option<String>,
    pub created_at: String,
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderProfileInput {
    pub profile_id: Option<String>,
    pub label: String,
    #[serde(rename = "class")]
    pub provider_class: String,
    pub base_url: Option<String>,
    pub model: String,
    pub endpoint_hash: String,
    pub data_flow: String,
    pub policy_url: Option<String>,
    pub config_version: u32,
    pub secret_state: String,
    pub last_test_at: Option<String>,
    pub last_test_status: Option<String>,
    pub last_error: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderProfileRecord {
    pub profile_id: String,
    pub version: u32,
    pub label: String,
    #[serde(rename = "class")]
    pub provider_class: String,
    pub base_url: Option<String>,
    pub model: String,
    pub endpoint_hash: String,
    pub data_flow: String,
    pub policy_url: Option<String>,
    pub config_version: u32,
    pub secret_state: String,
    pub last_test_at: Option<String>,
    pub last_test_status: Option<String>,
    pub last_error: Option<String>,
    pub created_at: String,
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SummaryJobInput {
    pub meeting_id: String,
    pub provider_profile_id: Option<String>,
    pub prompt_version: String,
    pub request_schema_version: String,
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SummaryJobRecord {
    pub job_id: String,
    pub meeting_id: String,
    pub parent_job_id: Option<String>,
    pub attempt: u32,
    pub status: String,
    pub provider_profile_id: Option<String>,
    pub prompt_version: String,
    pub request_schema_version: String,
    pub error_code: Option<String>,
    pub retryable: bool,
    pub requested_at: String,
    pub completed_at: Option<String>,
    pub cancelled_at: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SummaryChunkInput {
    pub job_id: String,
    pub chunk_index: u32,
    pub source_segment_ids: Vec<String>,
    pub text: String,
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SummaryResultInput {
    pub job_id: String,
    pub section_kind: String,
    pub section_index: u32,
    pub heading: String,
    pub text: String,
    pub citation_segment_ids: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SummaryResultRecord {
    pub job_id: String,
    pub section_kind: String,
    pub section_index: u32,
    pub heading: String,
    pub text: String,
    pub citation_segment_ids: Vec<String>,
    pub created_at: String,
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SummaryProgressRecord {
    pub job: SummaryJobRecord,
    pub chunk_count: usize,
    pub result_count: usize,
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeletePreview {
    pub meeting_id: String,
    pub final_count: usize,
    pub translation_count: usize,
    pub export_count: usize,
    pub summary_job_count: usize,
    pub tombstone_id: Option<String>,
    pub deleted_at: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteTombstoneRecord {
    pub tombstone_id: String,
    pub meeting_id: String,
    pub deleted_at: String,
    pub file_manifest_json: String,
    pub restored_at: Option<String>,
    pub purged_at: Option<String>,
}

impl MvpStorage {
    pub fn open_default() -> Result<Self, String> {
        Self::open_at(default_data_root()?.join("meetingrelay-mvp.sqlite3"))
    }

    pub fn open_at(db_path: impl Into<PathBuf>) -> Result<Self, String> {
        let db_path = db_path.into();
        if let Some(parent) = db_path.parent() {
            fs::create_dir_all(parent).map_err(|_| "MVP_STORAGE_ROOT_UNAVAILABLE".to_owned())?;
        }
        Ok(Self { db_path })
    }

    pub fn default_export_dir(&self) -> PathBuf {
        self.db_path
            .parent()
            .map(|parent| parent.join("exports"))
            .unwrap_or_else(|| PathBuf::from("exports"))
    }

    pub fn recent_meeting(&self) -> Result<Option<MeetingRecord>, String> {
        self.with_read_connection(|connection| {
            connection
                .query_row(
                    "SELECT id, state, started_at, ended_at, last_final_sequence,
                            (
                                SELECT causation_id
                                FROM mvp_events
                                WHERE meeting_id=mvp_meetings.id
                                  AND event_type='meeting.incomplete'
                                ORDER BY event_sequence DESC
                                LIMIT 1
                            )
                     FROM mvp_meetings
                     WHERE deleted_at IS NULL
                     ORDER BY CAST(last_opened_at AS INTEGER) DESC, CAST(started_at AS INTEGER) DESC
                     LIMIT 1",
                    [],
                    meeting_from_row,
                )
                .optional()
                .map_err(|_| "MVP_STORAGE_RECENT_QUERY_FAILED".to_owned())
        })
    }

    pub fn snapshot(&self, meeting_id: &str) -> Result<MeetingSnapshot, String> {
        self.with_read_connection(|connection| snapshot_from_connection(connection, meeting_id))
    }

    pub fn meeting_model_label(&self, meeting_id: &str) -> Result<String, String> {
        self.with_read_connection(|connection| {
            connection
                .query_row(
                    "SELECT model_label FROM mvp_meetings WHERE id=?1",
                    params![meeting_id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|_| "MVP_STORAGE_MEETING_QUERY_FAILED".to_owned())?
                .ok_or_else(|| "MVP_STORAGE_MEETING_NOT_FOUND".to_owned())
        })
    }

    pub fn interrupted_meetings(&self) -> Result<Vec<InterruptedMeetingRecord>, String> {
        self.with_read_connection(|connection| {
            let mut statement = connection
                .prepare(
                    "SELECT m.id, m.started_at, COALESCE(m.ended_at, m.last_opened_at),
                            m.last_final_sequence,
                            SUM(CASE WHEN t.status='failed' THEN 1 ELSE 0 END),
                            m.completion_error
                     FROM mvp_meetings m
                     LEFT JOIN mvp_translations t ON t.meeting_id=m.id
                     WHERE m.state='interrupted'
                     GROUP BY m.id
                     ORDER BY m.started_at DESC
                     LIMIT 128",
                )
                .map_err(|_| "MVP_STORAGE_INTERRUPTED_QUERY_FAILED".to_owned())?;
            let rows = statement
                .query_map([], |row| {
                    let saved: i64 = row.get(3)?;
                    let failed: i64 = row.get(4)?;
                    let reason: Option<String> = row.get(5)?;
                    Ok(InterruptedMeetingRecord {
                        meeting_id: row.get(0)?,
                        started_at: row.get(1)?,
                        updated_at: row.get(2)?,
                        saved_final_count: u64::try_from(saved).unwrap_or(0).to_string(),
                        pending_final_count: "0".to_owned(),
                        translation_failed_count: usize::try_from(failed).unwrap_or(0),
                        recommended_action: if reason.is_some() {
                            "recover".to_owned()
                        } else {
                            "finalize".to_owned()
                        },
                        reason,
                    })
                })
                .map_err(|_| "MVP_STORAGE_INTERRUPTED_QUERY_FAILED".to_owned())?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|_| "MVP_STORAGE_INTERRUPTED_QUERY_FAILED".to_owned())
        })
    }

    #[allow(dead_code)]
    pub fn failed_translation_retry_plan(
        &self,
        meeting_id: &str,
        cost_confirmed: bool,
    ) -> Result<TranslationRetryPlan, String> {
        if !cost_confirmed {
            return Err("TRANSLATION_RETRY_COST_CONFIRMATION_REQUIRED".to_owned());
        }
        self.with_read_connection(|connection| {
            failed_translation_retry_plan_on_connection(connection, meeting_id)
        })
    }

    #[allow(dead_code)]
    pub fn meeting_library_page(
        &self,
        cursor: Option<&str>,
        limit: usize,
    ) -> Result<MeetingLibraryPage, String> {
        let started = Instant::now();
        let limit = bounded_limit(limit, STORAGE_PAGE_LIMIT_MAX);
        let (cursor_started_at, cursor_id) = parse_library_cursor(cursor);
        self.with_read_connection(|connection| {
            let total: i64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM mvp_meetings WHERE deleted_at IS NULL",
                    [],
                    |row| row.get(0),
                )
                .map_err(|_| "MVP_STORAGE_LIBRARY_QUERY_FAILED".to_owned())?;
            let mut statement = connection
                .prepare(
                    "SELECT m.id, m.title, m.state, m.started_at, m.ended_at, m.language,
                            COUNT(DISTINCT f.segment_id),
                            COUNT(DISTINCT t.segment_id || ':' || t.source_revision),
                            COUNT(DISTINCT e.export_id),
                            COUNT(DISTINCT sj.job_id),
                            COUNT(DISTINCT CASE WHEN t.status='failed'
                                THEN t.segment_id || ':' || t.source_revision END),
                            COALESCE((
                                SELECT latest.status
                                FROM mvp_summary_jobs latest
                                WHERE latest.meeting_id=m.id
                                ORDER BY CAST(latest.requested_at AS INTEGER) DESC, latest.job_id DESC
                                LIMIT 1
                            ), 'idle')
                     FROM mvp_meetings m
                     LEFT JOIN mvp_final_segments f ON f.meeting_id=m.id
                     LEFT JOIN mvp_translations t ON t.meeting_id=m.id
                     LEFT JOIN mvp_export_snapshots es ON es.meeting_id=m.id
                     LEFT JOIN mvp_exports e ON e.snapshot_id=es.snapshot_id
                     LEFT JOIN mvp_summary_jobs sj ON sj.meeting_id=m.id
                     WHERE m.deleted_at IS NULL
                       AND (?1='' OR (CAST(m.started_at AS INTEGER) < CAST(?1 AS INTEGER))
                            OR (m.started_at=?1 AND m.id < ?2))
                     GROUP BY m.id
                     ORDER BY CAST(m.started_at AS INTEGER) DESC, m.id DESC
                     LIMIT ?3",
                )
                .map_err(|_| "MVP_STORAGE_LIBRARY_QUERY_FAILED".to_owned())?;
            let rows = statement
                .query_map(
                    params![cursor_started_at, cursor_id, limit as i64 + 1],
                    meeting_library_item_from_row,
                )
                .map_err(|_| "MVP_STORAGE_LIBRARY_QUERY_FAILED".to_owned())?;
            let mut items = Vec::new();
            for row in rows {
                let mut item = row.map_err(|_| "MVP_STORAGE_LIBRARY_QUERY_FAILED".to_owned())?;
                item.tags = tags_for_meeting(connection, &item.meeting_id)?;
                items.push(item);
            }
            let next_cursor = if items.len() > limit {
                items.pop();
                items
                    .last()
                    .map(|item| format!("{}:{}", item.started_at, item.meeting_id))
            } else {
                None
            };
            Ok(MeetingLibraryPage {
                items,
                next_cursor,
                total: usize::try_from(total).unwrap_or(0),
                page_size: limit,
                elapsed_ms: started.elapsed().as_millis(),
            })
        })
    }

    pub fn list_meetings(&self, query: MeetingLibraryQuery) -> Result<MeetingLibraryPage, String> {
        let started = Instant::now();
        let limit = bounded_limit(query.page_size, STORAGE_PAGE_LIMIT_MAX);
        let (cursor_started_at, cursor_id) = parse_library_cursor(query.cursor.as_deref());
        self.with_read_connection(|connection| {
            let mut where_sql = String::from("m.deleted_at IS NULL");
            let mut values = Vec::<Value>::new();
            if !query.query.is_empty() {
                where_sql.push_str(
                    " AND (m.title LIKE ? ESCAPE '\\'
                       OR EXISTS (SELECT 1 FROM mvp_final_segments sf WHERE sf.meeting_id=m.id AND sf.text LIKE ? ESCAPE '\\')
                       OR EXISTS (SELECT 1 FROM mvp_translations st WHERE st.meeting_id=m.id AND st.translated_text LIKE ? ESCAPE '\\')
                       OR EXISTS (
                            SELECT 1 FROM mvp_summary_jobs sjq
                            JOIN mvp_summary_results srq ON srq.job_id=sjq.job_id
                            WHERE sjq.meeting_id=m.id AND srq.text LIKE ? ESCAPE '\\'
                       ))",
                );
                let pattern = like_pattern(&query.query);
                for _ in 0..4 {
                    values.push(Value::Text(pattern.clone()));
                }
            }
            for tag in &query.tags {
                where_sql.push_str(
                    " AND EXISTS (
                        SELECT 1 FROM mvp_meeting_tags mt
                        JOIN mvp_tags tg ON tg.tag_id=mt.tag_id
                        WHERE mt.meeting_id=m.id AND (mt.tag_id=? OR tg.name=?)
                    )",
                );
                values.push(Value::Text(tag.clone()));
                values.push(Value::Text(tag.clone()));
            }
            let count_sql = format!("SELECT COUNT(*) FROM mvp_meetings m WHERE {where_sql}");
            let total: i64 = connection
                .query_row(&count_sql, params_from_iter(values.clone()), |row| row.get(0))
                .map_err(|_| "MVP_STORAGE_LIBRARY_QUERY_FAILED".to_owned())?;
            where_sql.push_str(
                " AND (?='' OR (CAST(m.started_at AS INTEGER) < CAST(? AS INTEGER))
                    OR (m.started_at=? AND m.id < ?))",
            );
            values.push(Value::Text(cursor_started_at.to_owned()));
            values.push(Value::Text(cursor_started_at.to_owned()));
            values.push(Value::Text(cursor_started_at.to_owned()));
            values.push(Value::Text(cursor_id.to_owned()));
            values.push(Value::Integer(i64::try_from(limit + 1).unwrap_or(i64::MAX)));
            let sql = format!(
                "SELECT m.id, m.title, m.state, m.started_at, m.ended_at, m.language,
                        COUNT(DISTINCT f.segment_id),
                        COUNT(DISTINCT t.segment_id || ':' || t.source_revision),
                        COUNT(DISTINCT e.export_id),
                        COUNT(DISTINCT sj.job_id),
                        COUNT(DISTINCT CASE WHEN t.status='failed' THEN t.segment_id || ':' || t.source_revision END),
                        COALESCE((SELECT latest.status FROM mvp_summary_jobs latest
                                  WHERE latest.meeting_id=m.id
                                  ORDER BY CAST(latest.requested_at AS INTEGER) DESC, latest.job_id DESC
                                  LIMIT 1), 'idle')
                 FROM mvp_meetings m
                 LEFT JOIN mvp_final_segments f ON f.meeting_id=m.id
                 LEFT JOIN mvp_translations t ON t.meeting_id=m.id
                 LEFT JOIN mvp_export_snapshots es ON es.meeting_id=m.id
                 LEFT JOIN mvp_exports e ON e.snapshot_id=es.snapshot_id
                 LEFT JOIN mvp_summary_jobs sj ON sj.meeting_id=m.id
                 WHERE {where_sql}
                 GROUP BY m.id
                 ORDER BY CAST(m.started_at AS INTEGER) DESC, m.id DESC
                 LIMIT ?"
            );
            let mut statement = connection
                .prepare(&sql)
                .map_err(|_| "MVP_STORAGE_LIBRARY_QUERY_FAILED".to_owned())?;
            let rows = statement
                .query_map(params_from_iter(values), meeting_library_item_from_row)
                .map_err(|_| "MVP_STORAGE_LIBRARY_QUERY_FAILED".to_owned())?;
            let mut items = Vec::new();
            for row in rows {
                let mut item = row.map_err(|_| "MVP_STORAGE_LIBRARY_QUERY_FAILED".to_owned())?;
                item.tags = tags_for_meeting(connection, &item.meeting_id)?;
                items.push(item);
            }
            let next_cursor = if items.len() > limit {
                items.pop();
                items.last().map(|item| format!("{}:{}", item.started_at, item.meeting_id))
            } else {
                None
            };
            Ok(MeetingLibraryPage {
                items,
                next_cursor,
                total: usize::try_from(total).unwrap_or(0),
                page_size: limit,
                elapsed_ms: started.elapsed().as_millis(),
            })
        })
    }

    pub fn meeting_library_item(
        &self,
        meeting_id: &str,
    ) -> Result<Option<MeetingLibraryItem>, String> {
        self.with_read_connection(|connection| {
            let mut item = connection
                .query_row(
                    "SELECT m.id, m.title, m.state, m.started_at, m.ended_at, m.language,
                            COUNT(DISTINCT f.segment_id),
                            COUNT(DISTINCT t.segment_id || ':' || t.source_revision),
                            COUNT(DISTINCT e.export_id),
                            COUNT(DISTINCT sj.job_id),
                            COUNT(DISTINCT CASE WHEN t.status='failed'
                                THEN t.segment_id || ':' || t.source_revision END),
                            COALESCE((
                                SELECT latest.status
                                FROM mvp_summary_jobs latest
                                WHERE latest.meeting_id=m.id
                                ORDER BY CAST(latest.requested_at AS INTEGER) DESC, latest.job_id DESC
                                LIMIT 1
                            ), 'idle')
                     FROM mvp_meetings m
                     LEFT JOIN mvp_final_segments f ON f.meeting_id=m.id
                     LEFT JOIN mvp_translations t ON t.meeting_id=m.id
                     LEFT JOIN mvp_export_snapshots es ON es.meeting_id=m.id
                     LEFT JOIN mvp_exports e ON e.snapshot_id=es.snapshot_id
                     LEFT JOIN mvp_summary_jobs sj ON sj.meeting_id=m.id
                     WHERE m.id=?1 AND m.deleted_at IS NULL
                     GROUP BY m.id",
                    params![meeting_id],
                    meeting_library_item_from_row,
                )
                .optional()
                .map_err(|_| "MVP_STORAGE_LIBRARY_QUERY_FAILED".to_owned())?;
            if let Some(item) = item.as_mut() {
                item.tags = tags_for_meeting(connection, &item.meeting_id)?;
            }
            Ok(item)
        })
    }

    pub fn search_segments(&self, query: SegmentSearchQuery) -> Result<SegmentSearchPage, String> {
        let limit = bounded_limit(query.limit, STORAGE_SEARCH_LIMIT_MAX);
        validate_segment_search_query(&query)?;
        self.with_read_connection(|connection| {
            search_segments_on_connection(connection, query, limit)
        })
    }

    pub fn diagnostic_health(&self) -> Result<String, String> {
        self.with_read_connection(|connection| {
            let result = connection
                .query_row("PRAGMA quick_check(1)", [], |row| row.get::<_, String>(0))
                .map_err(|_| "MVP_STORAGE_DIAGNOSTIC_QUERY_FAILED".to_owned())?;
            if result.eq_ignore_ascii_case("ok") {
                Ok("ok".to_owned())
            } else {
                Err("MVP_STORAGE_INTEGRITY_CHECK_FAILED".to_owned())
            }
        })
    }

    pub fn tags(&self) -> Result<Vec<TagRecord>, String> {
        self.with_read_connection(|connection| {
            let mut statement = connection
                .prepare("SELECT tag_id, name, color, created_at FROM mvp_tags ORDER BY name ASC")
                .map_err(|_| "MVP_STORAGE_TAG_QUERY_FAILED".to_owned())?;
            let rows = statement
                .query_map([], tag_from_row)
                .map_err(|_| "MVP_STORAGE_TAG_QUERY_FAILED".to_owned())?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|_| "MVP_STORAGE_TAG_QUERY_FAILED".to_owned())
        })
    }

    pub fn provider_profile_history(
        &self,
        profile_id: &str,
    ) -> Result<Vec<ProviderProfileRecord>, String> {
        self.with_read_connection(|connection| {
            let mut statement = connection
                .prepare(
                    "SELECT profile_id, version, label, provider_class, base_url,
                            model, endpoint_hash, data_flow, policy_url, config_version_number,
                            secret_state, last_test_at, last_test_status, last_error, created_at
                     FROM mvp_provider_profiles
                     WHERE profile_id=?1
                     ORDER BY version ASC",
                )
                .map_err(|_| "MVP_STORAGE_PROVIDER_QUERY_FAILED".to_owned())?;
            let rows = statement
                .query_map(params![profile_id], provider_profile_from_row)
                .map_err(|_| "MVP_STORAGE_PROVIDER_QUERY_FAILED".to_owned())?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|_| "MVP_STORAGE_PROVIDER_QUERY_FAILED".to_owned())
        })
    }

    pub fn provider_profiles_latest(&self) -> Result<Vec<ProviderProfileRecord>, String> {
        self.with_read_connection(|connection| {
            let mut statement = connection
                .prepare(
                    "SELECT p.profile_id, p.version, p.label, p.provider_class, p.base_url,
                            p.model, p.endpoint_hash, p.data_flow, p.policy_url,
                            p.config_version_number, p.secret_state,
                            p.last_test_at, p.last_test_status, p.last_error, p.created_at
                     FROM mvp_provider_profiles p
                     JOIN (
                        SELECT profile_id, MAX(version) AS version
                        FROM mvp_provider_profiles
                        GROUP BY profile_id
                     ) latest ON latest.profile_id=p.profile_id AND latest.version=p.version
                     ORDER BY p.label ASC, p.profile_id ASC",
                )
                .map_err(|_| "MVP_STORAGE_PROVIDER_QUERY_FAILED".to_owned())?;
            let rows = statement
                .query_map([], provider_profile_from_row)
                .map_err(|_| "MVP_STORAGE_PROVIDER_QUERY_FAILED".to_owned())?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|_| "MVP_STORAGE_PROVIDER_QUERY_FAILED".to_owned())
        })
    }

    pub fn provider_profile_latest(
        &self,
        profile_id: &str,
    ) -> Result<Option<ProviderProfileRecord>, String> {
        self.with_read_connection(|connection| {
            connection
                .query_row(
                    "SELECT profile_id, version, label, provider_class, base_url,
                            model, endpoint_hash, data_flow, policy_url, config_version_number,
                            secret_state, last_test_at, last_test_status, last_error, created_at
                     FROM mvp_provider_profiles
                     WHERE profile_id=?1
                     ORDER BY version DESC
                     LIMIT 1",
                    params![profile_id],
                    provider_profile_from_row,
                )
                .optional()
                .map_err(|_| "MVP_STORAGE_PROVIDER_QUERY_FAILED".to_owned())
        })
    }

    pub fn summary_job(&self, job_id: &str) -> Result<Option<SummaryJobRecord>, String> {
        self.with_read_connection(|connection| summary_job_by_id_optional(connection, job_id))
    }

    pub fn latest_summary_job_for_meeting(
        &self,
        meeting_id: &str,
    ) -> Result<Option<SummaryJobRecord>, String> {
        self.with_read_connection(|connection| {
            latest_summary_job_for_meeting(connection, meeting_id)
        })
    }

    #[allow(dead_code)]
    pub fn summary_job_for_meeting_version(
        &self,
        meeting_id: &str,
        attempt: u32,
    ) -> Result<Option<SummaryJobRecord>, String> {
        self.with_read_connection(|connection| {
            summary_job_for_meeting_version(connection, meeting_id, attempt)
        })
    }

    pub fn summary_results(&self, job_id: &str) -> Result<Vec<SummaryResultRecord>, String> {
        self.with_read_connection(|connection| summary_results_on_connection(connection, job_id))
    }

    pub fn summary_progress(&self, job_id: &str) -> Result<Option<SummaryProgressRecord>, String> {
        self.with_read_connection(|connection| {
            let Some(job) = summary_job_by_id_optional(connection, job_id)? else {
                return Ok(None);
            };
            Ok(Some(SummaryProgressRecord {
                chunk_count: count_by_job(connection, "mvp_summary_chunks", job_id)?,
                result_count: count_by_job(connection, "mvp_summary_results", job_id)?,
                job,
            }))
        })
    }

    pub fn delete_preview(&self, meeting_id: &str) -> Result<DeletePreview, String> {
        self.with_read_connection(|connection| delete_preview_on_connection(connection, meeting_id))
    }

    pub fn tombstone_by_meeting(
        &self,
        meeting_id: &str,
    ) -> Result<Option<DeleteTombstoneRecord>, String> {
        self.with_read_connection(|connection| {
            delete_tombstone_by_meeting_optional(connection, meeting_id)
        })
    }

    #[allow(dead_code)]
    pub fn tombstone_by_id(
        &self,
        tombstone_id: &str,
    ) -> Result<Option<DeleteTombstoneRecord>, String> {
        self.with_read_connection(|connection| {
            delete_tombstone_by_id_optional(connection, tombstone_id)
        })
    }

    fn with_read_connection<T>(
        &self,
        work: impl FnOnce(&Connection) -> Result<T, String>,
    ) -> Result<T, String> {
        let connection =
            Connection::open(&self.db_path).map_err(|_| "MVP_STORAGE_OPEN_FAILED".to_owned())?;
        configure_read_connection(&connection)?;
        validate_schema(&connection)?;
        work(&connection)
    }
}

pub struct MvpStorageWriter {
    sender: Option<SyncSender<StorageRequest>>,
    join: Option<JoinHandle<()>>,
}

impl MvpStorageWriter {
    pub fn start(storage: MvpStorage) -> Result<Self, String> {
        let (sender, receiver) = sync_channel(STORAGE_QUEUE_DEPTH);
        let (ready_sender, ready_receiver) = sync_channel(1);
        let join = thread::Builder::new()
            .name("meetingrelay-storage-writer".to_owned())
            .spawn(move || storage_writer_loop(storage, receiver, ready_sender))
            .map_err(|_| "MVP_STORAGE_WRITER_START_FAILED".to_owned())?;
        ready_receiver
            .recv()
            .map_err(|_| "MVP_STORAGE_WRITER_START_FAILED".to_owned())??;
        Ok(Self {
            sender: Some(sender),
            join: Some(join),
        })
    }

    pub fn recover_interrupted(&self) -> Result<usize, String> {
        self.request(StorageRequest::RecoverInterrupted)
    }

    #[allow(dead_code)]
    pub fn record_recovery_action(
        &self,
        meeting_id: &str,
        action: RecoveryActionKind,
    ) -> Result<RecoveryActionRecord, String> {
        self.request(|reply| StorageRequest::RecordRecoveryAction {
            meeting_id: meeting_id.to_owned(),
            action,
            reply,
        })
    }

    #[cfg(test)]
    pub fn start_meeting(
        &self,
        consent_accepted: bool,
        model_label: &str,
    ) -> Result<MeetingRecord, String> {
        self.request(|reply| StorageRequest::StartMeeting {
            consent_accepted,
            model_label: model_label.to_owned(),
            reply,
        })
    }

    pub fn start_meeting_with_metadata(
        &self,
        consent_accepted: bool,
        model_label: &str,
        title: &str,
        language: &str,
    ) -> Result<MeetingRecord, String> {
        validate_meeting_metadata(title, language)?;
        self.request(|reply| StorageRequest::StartMeetingWithMetadata {
            consent_accepted,
            model_label: model_label.to_owned(),
            title: title.to_owned(),
            language: language.to_owned(),
            reply,
        })
    }

    pub fn update_meeting_metadata(
        &self,
        meeting_id: &str,
        title: &str,
        language: &str,
    ) -> Result<(), String> {
        validate_meeting_metadata(title, language)?;
        self.request(|reply| StorageRequest::UpdateMeetingMetadata {
            meeting_id: meeting_id.to_owned(),
            title: title.to_owned(),
            language: language.to_owned(),
            reply,
        })
    }

    pub fn complete_meeting(&self, meeting_id: &str) -> Result<MeetingRecord, String> {
        self.finish_meeting(meeting_id, "completed", None)
    }

    pub fn interrupt_meeting(&self, meeting_id: &str) -> Result<MeetingRecord, String> {
        self.finish_meeting(meeting_id, "interrupted", None)
    }

    pub fn incomplete_meeting(
        &self,
        meeting_id: &str,
        completion_error: &str,
    ) -> Result<MeetingRecord, String> {
        self.finish_meeting(meeting_id, "interrupted", Some(completion_error))
    }

    fn finish_meeting(
        &self,
        meeting_id: &str,
        state: &str,
        completion_error: Option<&str>,
    ) -> Result<MeetingRecord, String> {
        if completion_error.is_some_and(|error| {
            error.is_empty() || error.len() > 128 || error.chars().any(char::is_control)
        }) {
            return Err("MVP_STORAGE_COMPLETION_ERROR_INVALID".to_owned());
        }
        self.request(|reply| StorageRequest::FinishMeeting {
            meeting_id: meeting_id.to_owned(),
            state: state.to_owned(),
            completion_error: completion_error.map(str::to_owned),
            reply,
        })
    }

    pub fn open_meeting(&self, meeting_id: &str) -> Result<MeetingSnapshot, String> {
        self.request(|reply| StorageRequest::OpenMeeting {
            meeting_id: meeting_id.to_owned(),
            reply,
        })
    }

    pub fn commit_final(&self, candidate: FinalCandidate) -> Result<CommitAck, String> {
        self.request(|reply| StorageRequest::CommitFinal(candidate, reply))
    }

    pub fn begin_translation(
        &self,
        candidate: TranslationCandidate,
    ) -> Result<TranslationAttemptRecord, String> {
        self.request(|reply| StorageRequest::BeginTranslation(candidate, reply))
    }

    pub fn finish_translation(&self, completion: TranslationCompletion) -> Result<(), String> {
        self.request(|reply| StorageRequest::FinishTranslation(completion, reply))
    }

    pub fn record_export_snapshot(
        &self,
        snapshot: MeetingSnapshot,
        exports: Vec<CompletedExport>,
    ) -> Result<(), String> {
        self.request(|reply| StorageRequest::RecordExportSnapshot {
            snapshot,
            exports,
            reply,
        })
    }

    pub fn create_tag(&self, name: &str, color: Option<&str>) -> Result<TagRecord, String> {
        validate_tag(name, color)?;
        self.request(|reply| StorageRequest::CreateTag {
            name: name.to_owned(),
            color: color.map(str::to_owned),
            reply,
        })
    }

    pub fn delete_tag(&self, tag_id: &str) -> Result<(), String> {
        self.request(|reply| StorageRequest::DeleteTag {
            tag_id: tag_id.to_owned(),
            reply,
        })
    }

    pub fn assign_tag(&self, meeting_id: &str, tag_id: &str) -> Result<(), String> {
        self.request(|reply| StorageRequest::AssignTag {
            meeting_id: meeting_id.to_owned(),
            tag_id: tag_id.to_owned(),
            reply,
        })
    }

    pub fn unassign_tag(&self, meeting_id: &str, tag_id: &str) -> Result<(), String> {
        self.request(|reply| StorageRequest::UnassignTag {
            meeting_id: meeting_id.to_owned(),
            tag_id: tag_id.to_owned(),
            reply,
        })
    }

    pub fn replace_meeting_tags(
        &self,
        meeting_id: &str,
        names: Vec<String>,
    ) -> Result<Vec<TagRecord>, String> {
        for name in &names {
            validate_tag(name, None)?;
        }
        self.request(|reply| StorageRequest::ReplaceMeetingTags {
            meeting_id: meeting_id.to_owned(),
            names,
            reply,
        })
    }

    pub fn save_provider_profile(
        &self,
        input: ProviderProfileInput,
    ) -> Result<ProviderProfileRecord, String> {
        validate_provider_profile(&input)?;
        self.request(|reply| StorageRequest::SaveProviderProfile(input, reply))
    }

    pub fn start_summary_job(&self, input: SummaryJobInput) -> Result<SummaryJobRecord, String> {
        validate_summary_job_input(&input)?;
        self.request(|reply| StorageRequest::StartSummaryJob {
            input,
            parent_job_id: None,
            reply,
        })
    }

    pub fn retry_summary_job(
        &self,
        parent_job_id: &str,
        input: SummaryJobInput,
    ) -> Result<SummaryJobRecord, String> {
        validate_summary_job_input(&input)?;
        self.request(|reply| StorageRequest::StartSummaryJob {
            input,
            parent_job_id: Some(parent_job_id.to_owned()),
            reply,
        })
    }

    pub fn append_summary_chunk(&self, input: SummaryChunkInput) -> Result<(), String> {
        validate_summary_chunk(&input)?;
        self.request(|reply| StorageRequest::AppendSummaryChunk(input, reply))
    }

    pub fn append_summary_result(&self, input: SummaryResultInput) -> Result<(), String> {
        validate_summary_result(&input)?;
        self.request(|reply| StorageRequest::AppendSummaryResult(input, reply))
    }

    pub fn finish_summary_job(&self, job_id: &str) -> Result<SummaryJobRecord, String> {
        self.request(|reply| StorageRequest::FinishSummaryJob {
            job_id: job_id.to_owned(),
            error_code: None,
            retryable: false,
            cancel: false,
            reply,
        })
    }

    pub fn fail_summary_job(
        &self,
        job_id: &str,
        error_code: &str,
        retryable: bool,
    ) -> Result<SummaryJobRecord, String> {
        if error_code.is_empty()
            || error_code.len() > 128
            || error_code.chars().any(char::is_control)
        {
            return Err("MVP_STORAGE_SUMMARY_ERROR_INVALID".to_owned());
        }
        self.request(|reply| StorageRequest::FinishSummaryJob {
            job_id: job_id.to_owned(),
            error_code: Some(error_code.to_owned()),
            retryable,
            cancel: false,
            reply,
        })
    }

    pub fn cancel_summary_job(&self, job_id: &str) -> Result<SummaryJobRecord, String> {
        self.request(|reply| StorageRequest::FinishSummaryJob {
            job_id: job_id.to_owned(),
            error_code: None,
            retryable: true,
            cancel: true,
            reply,
        })
    }

    pub fn soft_delete_meeting(
        &self,
        meeting_id: &str,
        file_manifest_json: &str,
    ) -> Result<DeleteTombstoneRecord, String> {
        validate_manifest_json(file_manifest_json)?;
        self.request(|reply| StorageRequest::SoftDeleteMeeting {
            meeting_id: meeting_id.to_owned(),
            file_manifest_json: file_manifest_json.to_owned(),
            reply,
        })
    }

    pub fn restore_meeting(&self, meeting_id: &str) -> Result<DeleteTombstoneRecord, String> {
        self.request(|reply| StorageRequest::RestoreMeeting {
            meeting_id: meeting_id.to_owned(),
            reply,
        })
    }

    pub fn purge_meeting_metadata(
        &self,
        meeting_id: &str,
    ) -> Result<DeleteTombstoneRecord, String> {
        self.request(|reply| StorageRequest::PurgeMeetingMetadata {
            meeting_id: meeting_id.to_owned(),
            reply,
        })
    }

    #[allow(dead_code)]
    pub fn synthetic_commit_metrics(
        &self,
        meeting_id: &str,
        count: usize,
    ) -> Result<CommitMetrics, String> {
        let mut latencies = Vec::with_capacity(count);
        let mut duplicate = 0;
        let mut rejected = 0;
        for sequence in 1..=count {
            let candidate = FinalCandidate {
                meeting_id: meeting_id.to_owned(),
                segment_id: format!("synthetic-{sequence}"),
                sequence: sequence as u64,
                revision: 1,
                text: format!("synthetic transcript {sequence}"),
                started_at_ms: (sequence * 10).to_string(),
                ended_at_ms: (sequence * 10 + 5).to_string(),
                meeting_sample_start: u64::try_from(sequence * 160).unwrap_or(u64::MAX),
                meeting_sample_end: u64::try_from(sequence * 160 + 80).unwrap_or(u64::MAX),
                timeline_revision: 1,
            };
            match self.commit_final(candidate) {
                Ok(ack) => {
                    if ack.duplicate {
                        duplicate += 1;
                    }
                    latencies.push(ack.latency_micros);
                }
                Err(_) => rejected += 1,
            }
        }
        latencies.sort_unstable();
        let p95_micros = if latencies.is_empty() {
            0
        } else {
            latencies[(latencies.len() * 95 / 100).min(latencies.len() - 1)]
        };
        Ok(CommitMetrics {
            committed: latencies.len(),
            duplicate,
            rejected,
            p95_micros,
        })
    }

    pub fn shutdown_before(&mut self, timeout: Duration) -> Result<(), String> {
        self.sender.take();
        let deadline = Instant::now() + timeout;
        let Some(join) = self.join.take() else {
            return Ok(());
        };
        while !join.is_finished() {
            if Instant::now() >= deadline {
                self.join = Some(join);
                return Err("MVP_STORAGE_WRITER_SHUTDOWN_TIMEOUT".to_owned());
            }
            thread::sleep(Duration::from_millis(2));
        }
        join.join()
            .map_err(|_| "MVP_STORAGE_WRITER_PANIC".to_owned())
    }

    fn request<T>(
        &self,
        build: impl FnOnce(SyncSender<Result<T, String>>) -> StorageRequest,
    ) -> Result<T, String> {
        let sender = self
            .sender
            .as_ref()
            .ok_or_else(|| "MVP_STORAGE_WRITER_STOPPED".to_owned())?;
        let (reply, receiver) = sync_channel(1);
        sender.try_send(build(reply)).map_err(|error| match error {
            TrySendError::Full(_) => "MVP_STORAGE_QUEUE_FULL".to_owned(),
            TrySendError::Disconnected(_) => "MVP_STORAGE_WRITER_STOPPED".to_owned(),
        })?;
        receiver
            .recv()
            .map_err(|_| "MVP_STORAGE_WRITER_STOPPED".to_owned())?
    }

    #[cfg(test)]
    fn block_for_test(&self) -> SyncSender<()> {
        let (release_sender, release_receiver) = sync_channel(1);
        let (ready_sender, ready_receiver) = sync_channel(1);
        self.sender
            .as_ref()
            .expect("writer is active")
            .try_send(StorageRequest::Block(release_receiver, ready_sender))
            .expect("block request enters writer");
        ready_receiver.recv().expect("writer entered block request");
        release_sender
    }

    #[cfg(test)]
    fn try_enqueue_noop_for_test(&self) -> Result<(), String> {
        self.sender
            .as_ref()
            .expect("writer is active")
            .try_send(StorageRequest::Noop)
            .map_err(|error| match error {
                TrySendError::Full(_) => "MVP_STORAGE_QUEUE_FULL".to_owned(),
                TrySendError::Disconnected(_) => "MVP_STORAGE_WRITER_STOPPED".to_owned(),
            })
    }
}

impl Drop for MvpStorageWriter {
    fn drop(&mut self) {
        let _ = self.shutdown_before(Duration::from_secs(2));
    }
}

enum StorageRequest {
    RecoverInterrupted(SyncSender<Result<usize, String>>),
    #[allow(dead_code)]
    RecordRecoveryAction {
        meeting_id: String,
        action: RecoveryActionKind,
        reply: SyncSender<Result<RecoveryActionRecord, String>>,
    },
    #[cfg(test)]
    StartMeeting {
        consent_accepted: bool,
        model_label: String,
        reply: SyncSender<Result<MeetingRecord, String>>,
    },
    StartMeetingWithMetadata {
        consent_accepted: bool,
        model_label: String,
        title: String,
        language: String,
        reply: SyncSender<Result<MeetingRecord, String>>,
    },
    UpdateMeetingMetadata {
        meeting_id: String,
        title: String,
        language: String,
        reply: SyncSender<Result<(), String>>,
    },
    FinishMeeting {
        meeting_id: String,
        state: String,
        completion_error: Option<String>,
        reply: SyncSender<Result<MeetingRecord, String>>,
    },
    OpenMeeting {
        meeting_id: String,
        reply: SyncSender<Result<MeetingSnapshot, String>>,
    },
    CommitFinal(FinalCandidate, SyncSender<Result<CommitAck, String>>),
    BeginTranslation(
        TranslationCandidate,
        SyncSender<Result<TranslationAttemptRecord, String>>,
    ),
    FinishTranslation(TranslationCompletion, SyncSender<Result<(), String>>),
    RecordExportSnapshot {
        snapshot: MeetingSnapshot,
        exports: Vec<CompletedExport>,
        reply: SyncSender<Result<(), String>>,
    },
    CreateTag {
        name: String,
        color: Option<String>,
        reply: SyncSender<Result<TagRecord, String>>,
    },
    DeleteTag {
        tag_id: String,
        reply: SyncSender<Result<(), String>>,
    },
    AssignTag {
        meeting_id: String,
        tag_id: String,
        reply: SyncSender<Result<(), String>>,
    },
    UnassignTag {
        meeting_id: String,
        tag_id: String,
        reply: SyncSender<Result<(), String>>,
    },
    ReplaceMeetingTags {
        meeting_id: String,
        names: Vec<String>,
        reply: SyncSender<Result<Vec<TagRecord>, String>>,
    },
    SaveProviderProfile(
        ProviderProfileInput,
        SyncSender<Result<ProviderProfileRecord, String>>,
    ),
    StartSummaryJob {
        input: SummaryJobInput,
        parent_job_id: Option<String>,
        reply: SyncSender<Result<SummaryJobRecord, String>>,
    },
    AppendSummaryChunk(SummaryChunkInput, SyncSender<Result<(), String>>),
    AppendSummaryResult(SummaryResultInput, SyncSender<Result<(), String>>),
    FinishSummaryJob {
        job_id: String,
        error_code: Option<String>,
        retryable: bool,
        cancel: bool,
        reply: SyncSender<Result<SummaryJobRecord, String>>,
    },
    SoftDeleteMeeting {
        meeting_id: String,
        file_manifest_json: String,
        reply: SyncSender<Result<DeleteTombstoneRecord, String>>,
    },
    RestoreMeeting {
        meeting_id: String,
        reply: SyncSender<Result<DeleteTombstoneRecord, String>>,
    },
    PurgeMeetingMetadata {
        meeting_id: String,
        reply: SyncSender<Result<DeleteTombstoneRecord, String>>,
    },
    #[cfg(test)]
    Block(Receiver<()>, SyncSender<()>),
    #[cfg(test)]
    Noop,
}

fn storage_writer_loop(
    storage: MvpStorage,
    receiver: Receiver<StorageRequest>,
    ready_sender: SyncSender<Result<(), String>>,
) {
    let mut connection = match open_writer_connection(&storage.db_path) {
        Ok(connection) => {
            let _ = ready_sender.send(Ok(()));
            connection
        }
        Err(error) => {
            let _ = ready_sender.send(Err(error));
            return;
        }
    };
    while let Ok(request) = receiver.recv() {
        match request {
            StorageRequest::RecoverInterrupted(reply) => {
                let _ = reply.send(recover_interrupted_on_writer(&mut connection));
            }
            StorageRequest::RecordRecoveryAction {
                meeting_id,
                action,
                reply,
            } => {
                let _ = reply.send(record_recovery_action_on_writer(
                    &mut connection,
                    &meeting_id,
                    action,
                ));
            }
            #[cfg(test)]
            StorageRequest::StartMeeting {
                consent_accepted,
                model_label,
                reply,
            } => {
                let _ = reply.send(start_meeting_on_writer(
                    &mut connection,
                    consent_accepted,
                    &model_label,
                ));
            }
            StorageRequest::StartMeetingWithMetadata {
                consent_accepted,
                model_label,
                title,
                language,
                reply,
            } => {
                let _ = reply.send(start_meeting_with_metadata_on_writer(
                    &mut connection,
                    consent_accepted,
                    &model_label,
                    &title,
                    &language,
                ));
            }
            StorageRequest::UpdateMeetingMetadata {
                meeting_id,
                title,
                language,
                reply,
            } => {
                let _ = reply.send(update_meeting_metadata_on_writer(
                    &mut connection,
                    &meeting_id,
                    &title,
                    &language,
                ));
            }
            StorageRequest::FinishMeeting {
                meeting_id,
                state,
                completion_error,
                reply,
            } => {
                let _ = reply.send(finish_meeting_on_writer(
                    &mut connection,
                    &meeting_id,
                    &state,
                    completion_error.as_deref(),
                ));
            }
            StorageRequest::OpenMeeting { meeting_id, reply } => {
                let _ = reply.send(open_meeting_on_writer(&mut connection, &meeting_id));
            }
            StorageRequest::CommitFinal(candidate, reply) => {
                let _ = reply.send(commit_final_on_writer(&mut connection, candidate));
            }
            StorageRequest::BeginTranslation(candidate, reply) => {
                let _ = reply.send(begin_translation_on_writer(&mut connection, candidate));
            }
            StorageRequest::FinishTranslation(completion, reply) => {
                let _ = reply.send(finish_translation_on_writer(&mut connection, completion));
            }
            StorageRequest::RecordExportSnapshot {
                snapshot,
                exports,
                reply,
            } => {
                let _ = reply.send(record_export_snapshot_on_writer(
                    &mut connection,
                    &snapshot,
                    &exports,
                ));
            }
            StorageRequest::CreateTag { name, color, reply } => {
                let _ = reply.send(create_tag_on_writer(
                    &mut connection,
                    &name,
                    color.as_deref(),
                ));
            }
            StorageRequest::DeleteTag { tag_id, reply } => {
                let _ = reply.send(delete_tag_on_writer(&mut connection, &tag_id));
            }
            StorageRequest::AssignTag {
                meeting_id,
                tag_id,
                reply,
            } => {
                let _ = reply.send(assign_tag_on_writer(&mut connection, &meeting_id, &tag_id));
            }
            StorageRequest::UnassignTag {
                meeting_id,
                tag_id,
                reply,
            } => {
                let _ = reply.send(unassign_tag_on_writer(
                    &mut connection,
                    &meeting_id,
                    &tag_id,
                ));
            }
            StorageRequest::ReplaceMeetingTags {
                meeting_id,
                names,
                reply,
            } => {
                let _ = reply.send(replace_meeting_tags_on_writer(
                    &mut connection,
                    &meeting_id,
                    names,
                ));
            }
            StorageRequest::SaveProviderProfile(input, reply) => {
                let _ = reply.send(save_provider_profile_on_writer(&mut connection, input));
            }
            StorageRequest::StartSummaryJob {
                input,
                parent_job_id,
                reply,
            } => {
                let _ = reply.send(start_summary_job_on_writer(
                    &mut connection,
                    input,
                    parent_job_id.as_deref(),
                ));
            }
            StorageRequest::AppendSummaryChunk(input, reply) => {
                let _ = reply.send(append_summary_chunk_on_writer(&mut connection, input));
            }
            StorageRequest::AppendSummaryResult(input, reply) => {
                let _ = reply.send(append_summary_result_on_writer(&mut connection, input));
            }
            StorageRequest::FinishSummaryJob {
                job_id,
                error_code,
                retryable,
                cancel,
                reply,
            } => {
                let _ = reply.send(finish_summary_job_on_writer(
                    &mut connection,
                    &job_id,
                    error_code.as_deref(),
                    retryable,
                    cancel,
                ));
            }
            StorageRequest::SoftDeleteMeeting {
                meeting_id,
                file_manifest_json,
                reply,
            } => {
                let _ = reply.send(soft_delete_meeting_on_writer(
                    &mut connection,
                    &meeting_id,
                    &file_manifest_json,
                ));
            }
            StorageRequest::RestoreMeeting { meeting_id, reply } => {
                let _ = reply.send(restore_meeting_on_writer(&mut connection, &meeting_id));
            }
            StorageRequest::PurgeMeetingMetadata { meeting_id, reply } => {
                let _ = reply.send(purge_meeting_metadata_on_writer(
                    &mut connection,
                    &meeting_id,
                ));
            }
            #[cfg(test)]
            StorageRequest::Block(release, ready) => {
                let _ = ready.send(());
                let _ = release.recv();
            }
            #[cfg(test)]
            StorageRequest::Noop => {}
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CompletedExport {
    pub export_id: String,
    pub format: String,
    pub target_path: PathBuf,
    pub byte_length: usize,
    pub sha256: String,
    pub completed_at: String,
    pub validation_manifest_json: String,
}

pub fn segment_from_durable(final_segment: &DurableFinal) -> TranscriptSegment {
    TranscriptSegment {
        segment_id: final_segment.segment_id.clone(),
        sequence: final_segment.sequence.to_string(),
        revision: final_segment.revision,
        is_final: true,
        saved: true,
        text: final_segment.text.clone(),
        started_at_ms: final_segment.started_at_ms.clone(),
        ended_at_ms: Some(final_segment.ended_at_ms.clone()),
        committed_at: Some(final_segment.committed_at.clone()),
        commit_id: Some(final_segment.commit_id.clone()),
        meeting_sample_start: final_segment.meeting_sample_start.to_string(),
        meeting_sample_end: final_segment.meeting_sample_end.to_string(),
        timeline_revision: final_segment.timeline_revision,
        translation_status: final_segment.translation_status.clone(),
        translation_target: final_segment.translation_target.clone(),
        translation_text: final_segment.translation_text.clone(),
        translation_error: final_segment.translation_error.clone(),
    }
}

pub fn visible_window_start_sequence(total_final_count: usize) -> String {
    if total_final_count <= MAX_FINAL_SEGMENTS {
        "1".to_owned()
    } else {
        (total_final_count - MAX_FINAL_SEGMENTS + 1).to_string()
    }
}

#[allow(dead_code)]
pub fn disk_check_from_io_error(error: &io::Error) -> DiskCheck {
    let code = if matches!(error.raw_os_error(), Some(28 | 112)) {
        "MVP_DISK_FULL"
    } else {
        match error.kind() {
            io::ErrorKind::PermissionDenied => "MVP_DISK_PERMISSION_DENIED",
            io::ErrorKind::NotFound => "MVP_STORAGE_ROOT_UNAVAILABLE",
            _ => "MVP_DISK_CHECK_FAILED",
        }
    };
    DiskCheck {
        code: code.to_owned(),
        interrupted_only: true,
    }
}

#[allow(dead_code)]
pub fn disk_preflight_with(probe: impl FnOnce() -> io::Result<()>) -> Result<DiskCheck, DiskCheck> {
    probe()
        .map(|_| DiskCheck {
            code: "MVP_DISK_OK".to_owned(),
            interrupted_only: false,
        })
        .map_err(|error| disk_check_from_io_error(&error))
}

#[allow(dead_code)]
pub fn sanitized_diagnostic_bundle(
    model_label: Option<&str>,
    provider_versions: &[&str],
    storage_queue_depth: usize,
    translation_queue_depth: usize,
    disk_code: Option<&str>,
    error_codes: &[&str],
) -> DiagnosticBundle {
    DiagnosticBundle {
        app_contract_version: MVP_CONTRACT_VERSION.to_owned(),
        schema_version: MVP_SCHEMA_VERSION,
        schema_checksum: MVP_SCHEMA_CHECKSUM.to_owned(),
        model_label: model_label.map(sanitize_diagnostic_value),
        provider_versions: provider_versions
            .iter()
            .map(|value| sanitize_diagnostic_value(value))
            .collect(),
        storage_queue_depth,
        translation_queue_depth,
        disk_code: disk_code.map(sanitize_diagnostic_value),
        error_codes: error_codes
            .iter()
            .map(|value| sanitize_diagnostic_value(value))
            .collect(),
    }
}

fn open_writer_connection(db_path: &PathBuf) -> Result<Connection, String> {
    let mut connection =
        Connection::open(db_path).map_err(|_| "MVP_STORAGE_OPEN_FAILED".to_owned())?;
    validate_user_version_not_newer(&connection)?;
    configure_writer_connection(&mut connection)?;
    migrate(&mut connection)?;
    ensure_search_index(&mut connection)?;
    Ok(connection)
}

fn configure_read_connection(connection: &Connection) -> Result<(), String> {
    connection
        .busy_timeout(Duration::from_millis(250))
        .map_err(|_| "MVP_STORAGE_BUSY_TIMEOUT_FAILED".to_owned())?;
    connection
        .pragma_update(None, "foreign_keys", "ON")
        .map_err(|_| "MVP_STORAGE_PRAGMA_FAILED".to_owned())?;
    Ok(())
}

fn configure_writer_connection(connection: &mut Connection) -> Result<(), String> {
    configure_read_connection(connection)?;
    connection
        .pragma_update(None, "journal_mode", "WAL")
        .map_err(|_| "MVP_STORAGE_PRAGMA_FAILED".to_owned())?;
    connection
        .pragma_update(None, "synchronous", "FULL")
        .map_err(|_| "MVP_STORAGE_PRAGMA_FAILED".to_owned())?;
    Ok(())
}

fn user_version(connection: &Connection) -> Result<i64, String> {
    connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|_| "MVP_STORAGE_SCHEMA_QUERY_FAILED".to_owned())
}

fn validate_user_version_not_newer(connection: &Connection) -> Result<(), String> {
    let user_version = user_version(connection)?;
    if user_version > MVP_SCHEMA_VERSION {
        return Err("MVP_STORAGE_SCHEMA_TOO_NEW".to_owned());
    }
    Ok(())
}

fn validate_schema(connection: &Connection) -> Result<(), String> {
    let user_version: i64 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|_| "MVP_STORAGE_SCHEMA_QUERY_FAILED".to_owned())?;
    if user_version > MVP_SCHEMA_VERSION {
        return Err("MVP_STORAGE_SCHEMA_TOO_NEW".to_owned());
    }
    if user_version != MVP_SCHEMA_VERSION {
        return Err("MVP_STORAGE_SCHEMA_UNINITIALIZED".to_owned());
    }
    validate_schema_checksum(connection)?;
    Ok(())
}

fn migrate(connection: &mut Connection) -> Result<(), String> {
    validate_user_version_not_newer(connection)?;
    let current = user_version(connection)?;
    if current == MVP_SCHEMA_VERSION {
        return validate_schema_checksum(connection);
    }
    if current == 4 {
        validate_schema_checksum_version(connection, 4, MVP_SCHEMA_V4_CHECKSUM)?;
        let tx = connection
            .transaction()
            .map_err(|_| "MVP_STORAGE_TX_BEGIN_FAILED".to_owned())?;
        add_v5_schema(&tx)?;
        tx.execute(
            "INSERT OR IGNORE INTO mvp_schema_migrations(version, checksum, applied_at)
             VALUES (?1, ?2, ?3)",
            params![MVP_SCHEMA_VERSION, MVP_SCHEMA_CHECKSUM, now_ms_string()],
        )
        .map_err(|_| "MVP_STORAGE_MIGRATION_FAILED".to_owned())?;
        tx.commit()
            .map_err(|_| "MVP_STORAGE_COMMIT_FAILED".to_owned())?;
        return validate_schema_checksum(connection);
    }
    if current == 1 {
        validate_schema_checksum_version(connection, 1, MVP_SCHEMA_V1_CHECKSUM)?;
        let tx = connection
            .transaction()
            .map_err(|_| "MVP_STORAGE_TX_BEGIN_FAILED".to_owned())?;
        add_final_timeline_columns(&tx)?;
        tx.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS mvp_translations (
                meeting_id TEXT NOT NULL,
                segment_id TEXT NOT NULL,
                source_revision INTEGER NOT NULL,
                target_language TEXT NOT NULL CHECK (target_language IN ('zh','ja','en')),
                model TEXT NOT NULL,
                status TEXT NOT NULL CHECK (status IN ('pending','completed','failed','skipped')),
                translated_text TEXT,
                error_code TEXT,
                requested_at TEXT NOT NULL,
                completed_at TEXT,
                PRIMARY KEY (meeting_id, segment_id, source_revision),
                FOREIGN KEY (meeting_id) REFERENCES mvp_meetings(id) ON DELETE RESTRICT
            );
            CREATE TABLE IF NOT EXISTS mvp_translation_attempts (
                meeting_id TEXT NOT NULL,
                segment_id TEXT NOT NULL,
                source_revision INTEGER NOT NULL,
                target_language TEXT NOT NULL CHECK (target_language IN ('zh','ja','en')),
                attempt INTEGER NOT NULL,
                provider TEXT NOT NULL,
                config_version TEXT NOT NULL,
                endpoint_origin TEXT,
                endpoint_hash TEXT NOT NULL,
                model TEXT NOT NULL,
                prompt_version TEXT NOT NULL,
                request_schema_version TEXT NOT NULL,
                status TEXT NOT NULL CHECK (status IN ('pending','completed','failed','skipped')),
                translated_text TEXT,
                error_code TEXT,
                retryable INTEGER NOT NULL CHECK (retryable IN (0,1)),
                requested_at TEXT NOT NULL,
                completed_at TEXT,
                PRIMARY KEY (meeting_id, segment_id, source_revision, target_language, attempt),
                FOREIGN KEY (meeting_id) REFERENCES mvp_meetings(id) ON DELETE RESTRICT
            );
            CREATE TABLE IF NOT EXISTS mvp_recovery_actions (
                action_id TEXT PRIMARY KEY,
                meeting_id TEXT NOT NULL,
                action TEXT NOT NULL CHECK (action IN ('recover','finalize','keep_interrupted')),
                result_state TEXT NOT NULL CHECK (result_state IN ('completed','interrupted')),
                created_at TEXT NOT NULL,
                UNIQUE (meeting_id, action),
                FOREIGN KEY (meeting_id) REFERENCES mvp_meetings(id) ON DELETE RESTRICT
            );
            ",
        )
        .map_err(|_| "MVP_STORAGE_MIGRATION_FAILED".to_owned())?;
        add_v5_schema(&tx)?;
        tx.execute(
            "INSERT OR IGNORE INTO mvp_schema_migrations(version, checksum, applied_at)
             VALUES (?1, ?2, ?3)",
            params![MVP_SCHEMA_VERSION, MVP_SCHEMA_CHECKSUM, now_ms_string()],
        )
        .map_err(|_| "MVP_STORAGE_MIGRATION_FAILED".to_owned())?;
        tx.commit()
            .map_err(|_| "MVP_STORAGE_COMMIT_FAILED".to_owned())?;
        return validate_schema_checksum(connection);
    }
    if current == 2 {
        validate_schema_checksum_version(connection, 2, MVP_SCHEMA_V2_CHECKSUM)?;
        let tx = connection
            .transaction()
            .map_err(|_| "MVP_STORAGE_TX_BEGIN_FAILED".to_owned())?;
        add_final_timeline_columns(&tx)?;
        tx.execute_batch(
            "
            ALTER TABLE mvp_translations RENAME TO mvp_translations_v2;
            CREATE TABLE mvp_translations (
                meeting_id TEXT NOT NULL,
                segment_id TEXT NOT NULL,
                source_revision INTEGER NOT NULL,
                target_language TEXT NOT NULL CHECK (target_language IN ('zh','ja','en')),
                model TEXT NOT NULL,
                status TEXT NOT NULL CHECK (status IN ('pending','completed','failed','skipped')),
                translated_text TEXT,
                error_code TEXT,
                requested_at TEXT NOT NULL,
                completed_at TEXT,
                PRIMARY KEY (meeting_id, segment_id, source_revision),
                FOREIGN KEY (meeting_id) REFERENCES mvp_meetings(id) ON DELETE RESTRICT
            );
            INSERT INTO mvp_translations (
                meeting_id, segment_id, source_revision, target_language, model,
                status, translated_text, error_code, requested_at, completed_at
            )
            SELECT meeting_id, segment_id, source_revision, target_language, model,
                   status, translated_text, error_code, requested_at, completed_at
            FROM mvp_translations_v2;
            DROP TABLE mvp_translations_v2;
            CREATE TABLE IF NOT EXISTS mvp_translation_attempts (
                meeting_id TEXT NOT NULL,
                segment_id TEXT NOT NULL,
                source_revision INTEGER NOT NULL,
                target_language TEXT NOT NULL CHECK (target_language IN ('zh','ja','en')),
                attempt INTEGER NOT NULL,
                provider TEXT NOT NULL,
                config_version TEXT NOT NULL,
                endpoint_origin TEXT,
                endpoint_hash TEXT NOT NULL,
                model TEXT NOT NULL,
                prompt_version TEXT NOT NULL,
                request_schema_version TEXT NOT NULL,
                status TEXT NOT NULL CHECK (status IN ('pending','completed','failed','skipped')),
                translated_text TEXT,
                error_code TEXT,
                retryable INTEGER NOT NULL CHECK (retryable IN (0,1)),
                requested_at TEXT NOT NULL,
                completed_at TEXT,
                PRIMARY KEY (meeting_id, segment_id, source_revision, target_language, attempt),
                FOREIGN KEY (meeting_id) REFERENCES mvp_meetings(id) ON DELETE RESTRICT
            );
            INSERT OR IGNORE INTO mvp_translation_attempts (
                meeting_id, segment_id, source_revision, target_language, attempt,
                provider, config_version, endpoint_origin, endpoint_hash, model,
                prompt_version, request_schema_version, status, translated_text, error_code, retryable,
                requested_at, completed_at
            )
            SELECT meeting_id, segment_id, source_revision, target_language, 1,
                   'unknown', 'unknown', NULL, '', model,
                   'meetingrelay.translation.prompt.v1', 'openai.chat.completions.v1',
                   status, translated_text, error_code,
                   CASE WHEN status='failed' THEN 0 ELSE 0 END,
                   requested_at, completed_at
            FROM mvp_translations;
            CREATE TABLE IF NOT EXISTS mvp_recovery_actions (
                action_id TEXT PRIMARY KEY,
                meeting_id TEXT NOT NULL,
                action TEXT NOT NULL CHECK (action IN ('recover','finalize','keep_interrupted')),
                result_state TEXT NOT NULL CHECK (result_state IN ('completed','interrupted')),
                created_at TEXT NOT NULL,
                UNIQUE (meeting_id, action),
                FOREIGN KEY (meeting_id) REFERENCES mvp_meetings(id) ON DELETE RESTRICT
            );
            ",
        )
        .map_err(|_| "MVP_STORAGE_MIGRATION_FAILED".to_owned())?;
        add_v5_schema(&tx)?;
        tx.execute(
            "INSERT OR IGNORE INTO mvp_schema_migrations(version, checksum, applied_at)
             VALUES (?1, ?2, ?3)",
            params![MVP_SCHEMA_VERSION, MVP_SCHEMA_CHECKSUM, now_ms_string()],
        )
        .map_err(|_| "MVP_STORAGE_MIGRATION_FAILED".to_owned())?;
        tx.commit()
            .map_err(|_| "MVP_STORAGE_COMMIT_FAILED".to_owned())?;
        return validate_schema_checksum(connection);
    }
    if current == 3 {
        validate_schema_checksum_version(connection, 3, MVP_SCHEMA_V3_CHECKSUM)?;
        let tx = connection
            .transaction()
            .map_err(|_| "MVP_STORAGE_TX_BEGIN_FAILED".to_owned())?;
        add_final_timeline_columns(&tx)?;
        tx.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS mvp_translation_attempts (
                meeting_id TEXT NOT NULL,
                segment_id TEXT NOT NULL,
                source_revision INTEGER NOT NULL,
                target_language TEXT NOT NULL CHECK (target_language IN ('zh','ja','en')),
                attempt INTEGER NOT NULL,
                provider TEXT NOT NULL,
                config_version TEXT NOT NULL,
                endpoint_origin TEXT,
                endpoint_hash TEXT NOT NULL,
                model TEXT NOT NULL,
                prompt_version TEXT NOT NULL,
                request_schema_version TEXT NOT NULL,
                status TEXT NOT NULL CHECK (status IN ('pending','completed','failed','skipped')),
                translated_text TEXT,
                error_code TEXT,
                retryable INTEGER NOT NULL CHECK (retryable IN (0,1)),
                requested_at TEXT NOT NULL,
                completed_at TEXT,
                PRIMARY KEY (meeting_id, segment_id, source_revision, target_language, attempt),
                FOREIGN KEY (meeting_id) REFERENCES mvp_meetings(id) ON DELETE RESTRICT
            );
            INSERT OR IGNORE INTO mvp_translation_attempts (
                meeting_id, segment_id, source_revision, target_language, attempt,
                provider, config_version, endpoint_origin, endpoint_hash, model,
                prompt_version, request_schema_version, status, translated_text, error_code, retryable,
                requested_at, completed_at
            )
            SELECT meeting_id, segment_id, source_revision, target_language, 1,
                   'unknown', 'unknown', NULL, '', model,
                   'meetingrelay.translation.prompt.v1', 'openai.chat.completions.v1',
                   status, translated_text, error_code,
                   CASE WHEN status='failed' THEN 0 ELSE 0 END,
                   requested_at, completed_at
            FROM mvp_translations;
            CREATE TABLE IF NOT EXISTS mvp_recovery_actions (
                action_id TEXT PRIMARY KEY,
                meeting_id TEXT NOT NULL,
                action TEXT NOT NULL CHECK (action IN ('recover','finalize','keep_interrupted')),
                result_state TEXT NOT NULL CHECK (result_state IN ('completed','interrupted')),
                created_at TEXT NOT NULL,
                UNIQUE (meeting_id, action),
                FOREIGN KEY (meeting_id) REFERENCES mvp_meetings(id) ON DELETE RESTRICT
            );
            ",
        )
        .map_err(|_| "MVP_STORAGE_MIGRATION_FAILED".to_owned())?;
        add_v5_schema(&tx)?;
        tx.execute(
            "INSERT OR IGNORE INTO mvp_schema_migrations(version, checksum, applied_at)
             VALUES (?1, ?2, ?3)",
            params![MVP_SCHEMA_VERSION, MVP_SCHEMA_CHECKSUM, now_ms_string()],
        )
        .map_err(|_| "MVP_STORAGE_MIGRATION_FAILED".to_owned())?;
        tx.commit()
            .map_err(|_| "MVP_STORAGE_COMMIT_FAILED".to_owned())?;
        return validate_schema_checksum(connection);
    }
    if current != 0 {
        return Err("MVP_STORAGE_SCHEMA_UNSUPPORTED".to_owned());
    }
    let tx = connection
        .transaction()
        .map_err(|_| "MVP_STORAGE_TX_BEGIN_FAILED".to_owned())?;
    tx
        .execute_batch(
            "
            CREATE TABLE IF NOT EXISTS mvp_schema_migrations (
                version INTEGER PRIMARY KEY,
                checksum TEXT NOT NULL,
                applied_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS mvp_meetings (
                id TEXT PRIMARY KEY,
                schema_version INTEGER NOT NULL,
                state TEXT NOT NULL CHECK (state IN ('recording','completed','interrupted')),
                started_at TEXT NOT NULL,
                ended_at TEXT,
                last_opened_at TEXT NOT NULL,
                state_version INTEGER NOT NULL,
                last_final_sequence INTEGER NOT NULL,
                last_event_sequence INTEGER NOT NULL,
                consent_accepted INTEGER NOT NULL CHECK (consent_accepted IN (0,1)),
                model_label TEXT NOT NULL,
                app_contract_version TEXT NOT NULL,
                title TEXT NOT NULL DEFAULT '',
                language TEXT NOT NULL DEFAULT 'unknown',
                deleted_at TEXT,
                delete_tombstone_id TEXT
            );
            CREATE TABLE IF NOT EXISTS mvp_final_segments (
                meeting_id TEXT NOT NULL,
                segment_id TEXT NOT NULL,
                sequence INTEGER NOT NULL,
                revision INTEGER NOT NULL,
                transcript_generation INTEGER NOT NULL DEFAULT 1,
                source_revision INTEGER NOT NULL,
                text TEXT NOT NULL,
                started_at_ms TEXT NOT NULL,
                ended_at_ms TEXT NOT NULL,
                content_sha256 TEXT NOT NULL,
                committed_at TEXT NOT NULL,
                commit_id TEXT NOT NULL,
                meeting_sample_start INTEGER NOT NULL,
                meeting_sample_end INTEGER NOT NULL,
                timeline_revision INTEGER NOT NULL,
                PRIMARY KEY (meeting_id, segment_id, transcript_generation, source_revision),
                UNIQUE (meeting_id, sequence),
                FOREIGN KEY (meeting_id) REFERENCES mvp_meetings(id) ON DELETE RESTRICT
            );
            CREATE TABLE IF NOT EXISTS mvp_translations (
                meeting_id TEXT NOT NULL,
                segment_id TEXT NOT NULL,
                source_revision INTEGER NOT NULL,
                target_language TEXT NOT NULL CHECK (target_language IN ('zh','ja','en')),
                model TEXT NOT NULL,
                status TEXT NOT NULL CHECK (status IN ('pending','completed','failed','skipped')),
                translated_text TEXT,
                error_code TEXT,
                requested_at TEXT NOT NULL,
                completed_at TEXT,
                PRIMARY KEY (meeting_id, segment_id, source_revision),
                FOREIGN KEY (meeting_id) REFERENCES mvp_meetings(id) ON DELETE RESTRICT
            );
            CREATE TABLE IF NOT EXISTS mvp_translation_attempts (
                meeting_id TEXT NOT NULL,
                segment_id TEXT NOT NULL,
                source_revision INTEGER NOT NULL,
                target_language TEXT NOT NULL CHECK (target_language IN ('zh','ja','en')),
                attempt INTEGER NOT NULL,
                provider TEXT NOT NULL,
                config_version TEXT NOT NULL,
                endpoint_origin TEXT,
                endpoint_hash TEXT NOT NULL,
                model TEXT NOT NULL,
                prompt_version TEXT NOT NULL,
                request_schema_version TEXT NOT NULL,
                status TEXT NOT NULL CHECK (status IN ('pending','completed','failed','skipped')),
                translated_text TEXT,
                error_code TEXT,
                retryable INTEGER NOT NULL CHECK (retryable IN (0,1)),
                requested_at TEXT NOT NULL,
                completed_at TEXT,
                PRIMARY KEY (meeting_id, segment_id, source_revision, target_language, attempt),
                FOREIGN KEY (meeting_id) REFERENCES mvp_meetings(id) ON DELETE RESTRICT
            );
            CREATE TABLE IF NOT EXISTS mvp_recovery_actions (
                action_id TEXT PRIMARY KEY,
                meeting_id TEXT NOT NULL,
                action TEXT NOT NULL CHECK (action IN ('recover','finalize','keep_interrupted')),
                result_state TEXT NOT NULL CHECK (result_state IN ('completed','interrupted')),
                created_at TEXT NOT NULL,
                UNIQUE (meeting_id, action),
                FOREIGN KEY (meeting_id) REFERENCES mvp_meetings(id) ON DELETE RESTRICT
            );
            CREATE TABLE IF NOT EXISTS mvp_events (
                meeting_id TEXT,
                event_sequence INTEGER NOT NULL,
                event_type TEXT NOT NULL,
                causation_id TEXT NOT NULL CHECK (length(causation_id) > 0),
                occurred_at TEXT NOT NULL,
                PRIMARY KEY (meeting_id, event_sequence),
                FOREIGN KEY (meeting_id) REFERENCES mvp_meetings(id) ON DELETE RESTRICT
            );
            CREATE TABLE IF NOT EXISTS mvp_export_snapshots (
                snapshot_id TEXT PRIMARY KEY,
                meeting_id TEXT NOT NULL,
                snapshot_generation INTEGER NOT NULL,
                input_projection_generation INTEGER NOT NULL,
                semantic_sha256 TEXT NOT NULL,
                final_count INTEGER NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY (meeting_id) REFERENCES mvp_meetings(id) ON DELETE RESTRICT
            );
            CREATE TABLE IF NOT EXISTS mvp_exports (
                export_id TEXT PRIMARY KEY,
                snapshot_id TEXT NOT NULL,
                format TEXT NOT NULL CHECK (format IN ('json','markdown','txt')),
                target_path TEXT NOT NULL,
                byte_length INTEGER NOT NULL,
                sha256 TEXT NOT NULL,
                completed_at TEXT NOT NULL,
                validation_manifest_json TEXT NOT NULL,
                FOREIGN KEY (snapshot_id) REFERENCES mvp_export_snapshots(snapshot_id) ON DELETE RESTRICT
            );
            ",
        )
        .map_err(|_| "MVP_STORAGE_MIGRATION_FAILED".to_owned())?;
    add_v5_schema(&tx)?;
    tx.execute(
        "INSERT OR IGNORE INTO mvp_schema_migrations(version, checksum, applied_at)
             VALUES (?1, ?2, ?3)",
        params![MVP_SCHEMA_VERSION, MVP_SCHEMA_CHECKSUM, now_ms_string()],
    )
    .map_err(|_| "MVP_STORAGE_MIGRATION_FAILED".to_owned())?;
    tx.commit()
        .map_err(|_| "MVP_STORAGE_COMMIT_FAILED".to_owned())?;
    validate_schema_checksum(connection)
}

fn validate_schema_checksum(connection: &Connection) -> Result<(), String> {
    validate_schema_checksum_version(connection, MVP_SCHEMA_VERSION, MVP_SCHEMA_CHECKSUM)
}

fn validate_schema_checksum_version(
    connection: &Connection,
    version: i64,
    expected: &str,
) -> Result<(), String> {
    let checksum = connection
        .query_row(
            "SELECT checksum FROM mvp_schema_migrations WHERE version=?1",
            params![version],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|_| "MVP_STORAGE_SCHEMA_QUERY_FAILED".to_owned())?
        .ok_or_else(|| "MVP_STORAGE_SCHEMA_CHECKSUM_MISSING".to_owned())?;
    if checksum != expected {
        return Err("MVP_STORAGE_SCHEMA_CHECKSUM_MISMATCH".to_owned());
    }
    Ok(())
}

fn add_final_timeline_columns(tx: &Transaction<'_>) -> Result<(), String> {
    for (name, ddl) in [
        (
            "meeting_sample_start",
            "ALTER TABLE mvp_final_segments ADD COLUMN meeting_sample_start INTEGER NOT NULL DEFAULT 0",
        ),
        (
            "meeting_sample_end",
            "ALTER TABLE mvp_final_segments ADD COLUMN meeting_sample_end INTEGER NOT NULL DEFAULT 0",
        ),
        (
            "timeline_revision",
            "ALTER TABLE mvp_final_segments ADD COLUMN timeline_revision INTEGER NOT NULL DEFAULT 1",
        ),
    ] {
        if !table_has_column(tx, "mvp_final_segments", name)? {
            tx.execute(ddl, [])
                .map_err(|_| "MVP_STORAGE_MIGRATION_FAILED".to_owned())?;
        }
    }
    tx.execute(
        "UPDATE mvp_final_segments
         SET meeting_sample_start=CAST(started_at_ms AS INTEGER) * 16,
             meeting_sample_end=CAST(ended_at_ms AS INTEGER) * 16,
             timeline_revision=COALESCE(NULLIF(timeline_revision, 0), 1)",
        [],
    )
    .map_err(|_| "MVP_STORAGE_MIGRATION_FAILED".to_owned())?;
    Ok(())
}

fn add_v5_schema(tx: &Transaction<'_>) -> Result<(), String> {
    if !table_has_column(tx, "mvp_meetings", "title")? {
        tx.execute(
            "ALTER TABLE mvp_meetings ADD COLUMN title TEXT NOT NULL DEFAULT ''",
            [],
        )
        .map_err(|_| "MVP_STORAGE_MIGRATION_FAILED".to_owned())?;
    }
    if !table_has_column(tx, "mvp_meetings", "language")? {
        tx.execute(
            "ALTER TABLE mvp_meetings ADD COLUMN language TEXT NOT NULL DEFAULT 'unknown'",
            [],
        )
        .map_err(|_| "MVP_STORAGE_MIGRATION_FAILED".to_owned())?;
    }
    if !table_has_column(tx, "mvp_meetings", "deleted_at")? {
        tx.execute("ALTER TABLE mvp_meetings ADD COLUMN deleted_at TEXT", [])
            .map_err(|_| "MVP_STORAGE_MIGRATION_FAILED".to_owned())?;
    }
    if !table_has_column(tx, "mvp_meetings", "delete_tombstone_id")? {
        tx.execute(
            "ALTER TABLE mvp_meetings ADD COLUMN delete_tombstone_id TEXT",
            [],
        )
        .map_err(|_| "MVP_STORAGE_MIGRATION_FAILED".to_owned())?;
    }
    tx.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS mvp_tags (
            tag_id TEXT PRIMARY KEY,
            name TEXT NOT NULL UNIQUE,
            color TEXT,
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS mvp_meeting_tags (
            meeting_id TEXT NOT NULL,
            tag_id TEXT NOT NULL,
            assigned_at TEXT NOT NULL,
            PRIMARY KEY (meeting_id, tag_id),
            FOREIGN KEY (meeting_id) REFERENCES mvp_meetings(id) ON DELETE RESTRICT,
            FOREIGN KEY (tag_id) REFERENCES mvp_tags(tag_id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS mvp_provider_profiles (
            profile_id TEXT NOT NULL,
            version INTEGER NOT NULL,
            name TEXT NOT NULL,
            provider_kind TEXT NOT NULL CHECK (provider_kind IN ('Local','LAN','Cloud')),
            endpoint_origin TEXT,
            endpoint_hash TEXT NOT NULL,
            data_flow TEXT NOT NULL,
            policy_url TEXT,
            config_version TEXT NOT NULL,
            label TEXT NOT NULL DEFAULT '',
            provider_class TEXT NOT NULL DEFAULT 'local',
            base_url TEXT,
            model TEXT NOT NULL DEFAULT '',
            config_version_number INTEGER NOT NULL DEFAULT 1,
            secret_state TEXT NOT NULL DEFAULT 'missing',
            last_error TEXT,
            last_test_at TEXT,
            last_test_status TEXT,
            created_at TEXT NOT NULL,
            PRIMARY KEY (profile_id, version)
        );
        CREATE TABLE IF NOT EXISTS mvp_summary_jobs (
            job_id TEXT PRIMARY KEY,
            meeting_id TEXT NOT NULL,
            parent_job_id TEXT,
            attempt INTEGER NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('pending','completed','failed','cancelled')),
            provider_profile_id TEXT,
            prompt_version TEXT NOT NULL,
            request_schema_version TEXT NOT NULL,
            error_code TEXT,
            retryable INTEGER NOT NULL CHECK (retryable IN (0,1)),
            requested_at TEXT NOT NULL,
            completed_at TEXT,
            cancelled_at TEXT,
            FOREIGN KEY (meeting_id) REFERENCES mvp_meetings(id) ON DELETE RESTRICT
        );
        CREATE TABLE IF NOT EXISTS mvp_summary_chunks (
            job_id TEXT NOT NULL,
            chunk_index INTEGER NOT NULL,
            source_segment_ids TEXT NOT NULL,
            text TEXT NOT NULL,
            created_at TEXT NOT NULL,
            PRIMARY KEY (job_id, chunk_index),
            FOREIGN KEY (job_id) REFERENCES mvp_summary_jobs(job_id) ON DELETE RESTRICT
        );
        CREATE TABLE IF NOT EXISTS mvp_summary_results (
            job_id TEXT NOT NULL,
            section_kind TEXT NOT NULL,
            section_index INTEGER NOT NULL,
            heading TEXT NOT NULL,
            text TEXT NOT NULL,
            citation_segment_ids TEXT NOT NULL,
            created_at TEXT NOT NULL,
            PRIMARY KEY (job_id, section_kind, section_index),
            FOREIGN KEY (job_id) REFERENCES mvp_summary_jobs(job_id) ON DELETE RESTRICT
        );
        CREATE TABLE IF NOT EXISTS mvp_meeting_delete_tombstones (
            tombstone_id TEXT PRIMARY KEY,
            meeting_id TEXT NOT NULL,
            deleted_at TEXT NOT NULL,
            file_manifest_json TEXT NOT NULL,
            restored_at TEXT,
            purged_at TEXT,
            FOREIGN KEY (meeting_id) REFERENCES mvp_meetings(id) ON DELETE RESTRICT
        );
        CREATE INDEX IF NOT EXISTS idx_mvp_meetings_library
            ON mvp_meetings(deleted_at, started_at, id);
        CREATE INDEX IF NOT EXISTS idx_mvp_final_segments_search
            ON mvp_final_segments(meeting_id, sequence);
        CREATE INDEX IF NOT EXISTS idx_mvp_meeting_tags_tag
            ON mvp_meeting_tags(tag_id, meeting_id);
        CREATE INDEX IF NOT EXISTS idx_mvp_summary_jobs_meeting
            ON mvp_summary_jobs(meeting_id, requested_at);
        PRAGMA user_version = 5;
        ",
    )
    .map_err(|_| "MVP_STORAGE_MIGRATION_FAILED".to_owned())?;
    seed_default_provider_profiles(tx)
}

fn seed_default_provider_profiles(tx: &Transaction<'_>) -> Result<(), String> {
    let now = now_ms_string();
    for (profile_id, label, class, secret_state) in [
        ("provider-local-default", "Local", "local", "not_required"),
        ("provider-lan-default", "LAN", "lan", "missing"),
        ("provider-cloud-default", "Cloud", "cloud", "missing"),
    ] {
        tx.execute(
            "INSERT OR IGNORE INTO mvp_provider_profiles (
                profile_id, version, name, provider_kind, endpoint_origin, endpoint_hash,
                data_flow, policy_url, config_version, label, provider_class, base_url,
                model, config_version_number, secret_state, last_error,
                last_test_at, last_test_status, created_at
             ) VALUES (?1, 1, ?2, ?3, NULL, '', ?4, NULL, '1', ?2, ?5, NULL,
                       '', 1, ?6, NULL, NULL, 'untested', ?7)",
            params![
                profile_id,
                label,
                match class {
                    "local" => "Local",
                    "lan" => "LAN",
                    _ => "Cloud",
                },
                match class {
                    "local" => "local processing; no network egress",
                    "lan" => "LAN endpoint; configure base URL and secret before use",
                    _ => "Cloud endpoint; configure base URL and secret before use",
                },
                class,
                secret_state,
                now
            ],
        )
        .map_err(|_| "MVP_STORAGE_MIGRATION_FAILED".to_owned())?;
    }
    Ok(())
}

fn ensure_search_index(connection: &mut Connection) -> Result<(), String> {
    let tx = connection
        .transaction()
        .map_err(|_| "MVP_STORAGE_TX_BEGIN_FAILED".to_owned())?;
    tx.execute_batch(
        "
        CREATE VIRTUAL TABLE IF NOT EXISTS mvp_search_fts USING fts5(
            meeting_id UNINDEXED,
            segment_id UNINDEXED,
            sequence UNINDEXED,
            source_revision UNINDEXED,
            scope UNINDEXED,
            text,
            tokenize='unicode61 remove_diacritics 2'
        );

        CREATE TRIGGER IF NOT EXISTS mvp_search_final_ai
        AFTER INSERT ON mvp_final_segments BEGIN
            INSERT INTO mvp_search_fts(meeting_id, segment_id, sequence, source_revision, scope, text)
            VALUES (NEW.meeting_id, NEW.segment_id, NEW.sequence, NEW.source_revision, 'original', NEW.text);
            INSERT INTO mvp_search_fts(meeting_id, segment_id, sequence, source_revision, scope, text)
            VALUES (NEW.meeting_id, NEW.segment_id, NEW.sequence, NEW.source_revision, 'speaker', NEW.text);
        END;
        CREATE TRIGGER IF NOT EXISTS mvp_search_final_ad
        AFTER DELETE ON mvp_final_segments BEGIN
            DELETE FROM mvp_search_fts
            WHERE meeting_id=OLD.meeting_id AND segment_id=OLD.segment_id
              AND source_revision=OLD.source_revision AND scope IN ('original','speaker');
        END;
        CREATE TRIGGER IF NOT EXISTS mvp_search_final_au
        AFTER UPDATE OF text, sequence, source_revision ON mvp_final_segments BEGIN
            DELETE FROM mvp_search_fts
            WHERE meeting_id=OLD.meeting_id AND segment_id=OLD.segment_id
              AND source_revision=OLD.source_revision AND scope IN ('original','speaker');
            INSERT INTO mvp_search_fts(meeting_id, segment_id, sequence, source_revision, scope, text)
            VALUES (NEW.meeting_id, NEW.segment_id, NEW.sequence, NEW.source_revision, 'original', NEW.text);
            INSERT INTO mvp_search_fts(meeting_id, segment_id, sequence, source_revision, scope, text)
            VALUES (NEW.meeting_id, NEW.segment_id, NEW.sequence, NEW.source_revision, 'speaker', NEW.text);
        END;

        CREATE TRIGGER IF NOT EXISTS mvp_search_translation_ai
        AFTER INSERT ON mvp_translations WHEN NEW.translated_text IS NOT NULL BEGIN
            INSERT INTO mvp_search_fts(meeting_id, segment_id, sequence, source_revision, scope, text)
            SELECT NEW.meeting_id, NEW.segment_id, f.sequence, NEW.source_revision,
                   'translation', NEW.translated_text
            FROM mvp_final_segments f
            WHERE f.meeting_id=NEW.meeting_id AND f.segment_id=NEW.segment_id
              AND f.source_revision=NEW.source_revision;
        END;
        CREATE TRIGGER IF NOT EXISTS mvp_search_translation_ad
        AFTER DELETE ON mvp_translations BEGIN
            DELETE FROM mvp_search_fts
            WHERE meeting_id=OLD.meeting_id AND segment_id=OLD.segment_id
              AND source_revision=OLD.source_revision AND scope='translation';
        END;
        CREATE TRIGGER IF NOT EXISTS mvp_search_translation_au
        AFTER UPDATE OF translated_text, source_revision ON mvp_translations BEGIN
            DELETE FROM mvp_search_fts
            WHERE meeting_id=OLD.meeting_id AND segment_id=OLD.segment_id
              AND source_revision=OLD.source_revision AND scope='translation';
            INSERT INTO mvp_search_fts(meeting_id, segment_id, sequence, source_revision, scope, text)
            SELECT NEW.meeting_id, NEW.segment_id, f.sequence, NEW.source_revision,
                   'translation', NEW.translated_text
            FROM mvp_final_segments f
            WHERE NEW.translated_text IS NOT NULL
              AND f.meeting_id=NEW.meeting_id AND f.segment_id=NEW.segment_id
              AND f.source_revision=NEW.source_revision;
        END;

        CREATE TRIGGER IF NOT EXISTS mvp_search_summary_ai
        AFTER INSERT ON mvp_summary_results BEGIN
            INSERT INTO mvp_search_fts(meeting_id, segment_id, sequence, source_revision, scope, text)
            SELECT sj.meeting_id, 'summary:' || NEW.job_id || ':' || NEW.section_kind,
                   NEW.section_index, 1, 'summary', NEW.text
            FROM mvp_summary_jobs sj WHERE sj.job_id=NEW.job_id;
        END;
        CREATE TRIGGER IF NOT EXISTS mvp_search_summary_ad
        AFTER DELETE ON mvp_summary_results BEGIN
            DELETE FROM mvp_search_fts
            WHERE segment_id='summary:' || OLD.job_id || ':' || OLD.section_kind
              AND sequence=OLD.section_index AND scope='summary';
        END;
        CREATE TRIGGER IF NOT EXISTS mvp_search_summary_au
        AFTER UPDATE OF text, section_kind, section_index ON mvp_summary_results BEGIN
            DELETE FROM mvp_search_fts
            WHERE segment_id='summary:' || OLD.job_id || ':' || OLD.section_kind
              AND sequence=OLD.section_index AND scope='summary';
            INSERT INTO mvp_search_fts(meeting_id, segment_id, sequence, source_revision, scope, text)
            SELECT sj.meeting_id, 'summary:' || NEW.job_id || ':' || NEW.section_kind,
                   NEW.section_index, 1, 'summary', NEW.text
            FROM mvp_summary_jobs sj WHERE sj.job_id=NEW.job_id;
        END;
        ",
    )
    .map_err(|_| "MVP_STORAGE_SEARCH_INDEX_FAILED".to_owned())?;
    let trigram_available = ensure_trigram_search_index(&tx)?;
    let indexed: i64 = tx
        .query_row("SELECT COUNT(*) FROM mvp_search_fts", [], |row| row.get(0))
        .map_err(|_| "MVP_STORAGE_SEARCH_INDEX_FAILED".to_owned())?;
    if indexed == 0 {
        tx.execute_batch(
            "
            INSERT INTO mvp_search_fts(meeting_id, segment_id, sequence, source_revision, scope, text)
            SELECT meeting_id, segment_id, sequence, source_revision, 'original', text
            FROM mvp_final_segments;
            INSERT INTO mvp_search_fts(meeting_id, segment_id, sequence, source_revision, scope, text)
            SELECT meeting_id, segment_id, sequence, source_revision, 'speaker', text
            FROM mvp_final_segments;
            INSERT INTO mvp_search_fts(meeting_id, segment_id, sequence, source_revision, scope, text)
            SELECT t.meeting_id, t.segment_id, f.sequence, t.source_revision,
                   'translation', t.translated_text
            FROM mvp_translations t
            JOIN mvp_final_segments f ON f.meeting_id=t.meeting_id
              AND f.segment_id=t.segment_id AND f.source_revision=t.source_revision
            WHERE t.translated_text IS NOT NULL;
            INSERT INTO mvp_search_fts(meeting_id, segment_id, sequence, source_revision, scope, text)
            SELECT sj.meeting_id, 'summary:' || sr.job_id || ':' || sr.section_kind,
                   sr.section_index, 1, 'summary', sr.text
            FROM mvp_summary_results sr
            JOIN mvp_summary_jobs sj ON sj.job_id=sr.job_id;
            ",
        )
        .map_err(|_| "MVP_STORAGE_SEARCH_INDEX_FAILED".to_owned())?;
    }
    if trigram_available {
        let trigram_indexed: i64 = tx
            .query_row("SELECT COUNT(*) FROM mvp_search_trigram_fts", [], |row| {
                row.get(0)
            })
            .map_err(|_| "MVP_STORAGE_SEARCH_INDEX_FAILED".to_owned())?;
        if trigram_indexed == 0 {
            tx.execute_batch(
                "
                INSERT INTO mvp_search_trigram_fts(meeting_id, segment_id, sequence, source_revision, scope, text)
                SELECT meeting_id, segment_id, sequence, source_revision, scope, text
                FROM mvp_search_fts;
                ",
            )
            .map_err(|_| "MVP_STORAGE_SEARCH_INDEX_FAILED".to_owned())?;
        }
    }
    tx.commit()
        .map_err(|_| "MVP_STORAGE_COMMIT_FAILED".to_owned())
}

fn ensure_trigram_search_index(tx: &Transaction<'_>) -> Result<bool, String> {
    if tx
        .execute_batch(
            "
            CREATE VIRTUAL TABLE IF NOT EXISTS mvp_search_trigram_fts USING fts5(
                meeting_id UNINDEXED,
                segment_id UNINDEXED,
                sequence UNINDEXED,
                source_revision UNINDEXED,
                scope UNINDEXED,
                text,
                tokenize='trigram'
            );

            CREATE TRIGGER IF NOT EXISTS mvp_search_trigram_final_ai
            AFTER INSERT ON mvp_final_segments BEGIN
                INSERT INTO mvp_search_trigram_fts(meeting_id, segment_id, sequence, source_revision, scope, text)
                VALUES (NEW.meeting_id, NEW.segment_id, NEW.sequence, NEW.source_revision, 'original', NEW.text);
                INSERT INTO mvp_search_trigram_fts(meeting_id, segment_id, sequence, source_revision, scope, text)
                VALUES (NEW.meeting_id, NEW.segment_id, NEW.sequence, NEW.source_revision, 'speaker', NEW.text);
            END;
            CREATE TRIGGER IF NOT EXISTS mvp_search_trigram_final_ad
            AFTER DELETE ON mvp_final_segments BEGIN
                DELETE FROM mvp_search_trigram_fts
                WHERE meeting_id=OLD.meeting_id AND segment_id=OLD.segment_id
                  AND source_revision=OLD.source_revision AND scope IN ('original','speaker');
            END;
            CREATE TRIGGER IF NOT EXISTS mvp_search_trigram_final_au
            AFTER UPDATE OF text, sequence, source_revision ON mvp_final_segments BEGIN
                DELETE FROM mvp_search_trigram_fts
                WHERE meeting_id=OLD.meeting_id AND segment_id=OLD.segment_id
                  AND source_revision=OLD.source_revision AND scope IN ('original','speaker');
                INSERT INTO mvp_search_trigram_fts(meeting_id, segment_id, sequence, source_revision, scope, text)
                VALUES (NEW.meeting_id, NEW.segment_id, NEW.sequence, NEW.source_revision, 'original', NEW.text);
                INSERT INTO mvp_search_trigram_fts(meeting_id, segment_id, sequence, source_revision, scope, text)
                VALUES (NEW.meeting_id, NEW.segment_id, NEW.sequence, NEW.source_revision, 'speaker', NEW.text);
            END;

            CREATE TRIGGER IF NOT EXISTS mvp_search_trigram_translation_ai
            AFTER INSERT ON mvp_translations WHEN NEW.translated_text IS NOT NULL BEGIN
                INSERT INTO mvp_search_trigram_fts(meeting_id, segment_id, sequence, source_revision, scope, text)
                SELECT NEW.meeting_id, NEW.segment_id, f.sequence, NEW.source_revision,
                       'translation', NEW.translated_text
                FROM mvp_final_segments f
                WHERE f.meeting_id=NEW.meeting_id AND f.segment_id=NEW.segment_id
                  AND f.source_revision=NEW.source_revision;
            END;
            CREATE TRIGGER IF NOT EXISTS mvp_search_trigram_translation_ad
            AFTER DELETE ON mvp_translations BEGIN
                DELETE FROM mvp_search_trigram_fts
                WHERE meeting_id=OLD.meeting_id AND segment_id=OLD.segment_id
                  AND source_revision=OLD.source_revision AND scope='translation';
            END;
            CREATE TRIGGER IF NOT EXISTS mvp_search_trigram_translation_au
            AFTER UPDATE OF translated_text, source_revision ON mvp_translations BEGIN
                DELETE FROM mvp_search_trigram_fts
                WHERE meeting_id=OLD.meeting_id AND segment_id=OLD.segment_id
                  AND source_revision=OLD.source_revision AND scope='translation';
                INSERT INTO mvp_search_trigram_fts(meeting_id, segment_id, sequence, source_revision, scope, text)
                SELECT NEW.meeting_id, NEW.segment_id, f.sequence, NEW.source_revision,
                       'translation', NEW.translated_text
                FROM mvp_final_segments f
                WHERE NEW.translated_text IS NOT NULL
                  AND f.meeting_id=NEW.meeting_id AND f.segment_id=NEW.segment_id
                  AND f.source_revision=NEW.source_revision;
            END;

            CREATE TRIGGER IF NOT EXISTS mvp_search_trigram_summary_ai
            AFTER INSERT ON mvp_summary_results BEGIN
                INSERT INTO mvp_search_trigram_fts(meeting_id, segment_id, sequence, source_revision, scope, text)
                SELECT sj.meeting_id, 'summary:' || NEW.job_id || ':' || NEW.section_kind,
                       NEW.section_index, 1, 'summary', NEW.text
                FROM mvp_summary_jobs sj WHERE sj.job_id=NEW.job_id;
            END;
            CREATE TRIGGER IF NOT EXISTS mvp_search_trigram_summary_ad
            AFTER DELETE ON mvp_summary_results BEGIN
                DELETE FROM mvp_search_trigram_fts
                WHERE segment_id='summary:' || OLD.job_id || ':' || OLD.section_kind
                  AND sequence=OLD.section_index AND scope='summary';
            END;
            CREATE TRIGGER IF NOT EXISTS mvp_search_trigram_summary_au
            AFTER UPDATE OF text, section_kind, section_index ON mvp_summary_results BEGIN
                DELETE FROM mvp_search_trigram_fts
                WHERE segment_id='summary:' || OLD.job_id || ':' || OLD.section_kind
                  AND sequence=OLD.section_index AND scope='summary';
                INSERT INTO mvp_search_trigram_fts(meeting_id, segment_id, sequence, source_revision, scope, text)
                SELECT sj.meeting_id, 'summary:' || NEW.job_id || ':' || NEW.section_kind,
                       NEW.section_index, 1, 'summary', NEW.text
                FROM mvp_summary_jobs sj WHERE sj.job_id=NEW.job_id;
            END;
            ",
        )
        .is_err()
    {
        return Ok(false);
    }
    Ok(true)
}

fn table_has_column(tx: &Transaction<'_>, table: &str, column: &str) -> Result<bool, String> {
    let mut statement = tx
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|_| "MVP_STORAGE_SCHEMA_QUERY_FAILED".to_owned())?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|_| "MVP_STORAGE_SCHEMA_QUERY_FAILED".to_owned())?;
    for row in rows {
        if row.map_err(|_| "MVP_STORAGE_SCHEMA_QUERY_FAILED".to_owned())? == column {
            return Ok(true);
        }
    }
    Ok(false)
}

fn recover_interrupted_on_writer(connection: &mut Connection) -> Result<usize, String> {
    let now = now_ms_string();
    let tx = connection
        .transaction()
        .map_err(|_| "MVP_STORAGE_TX_BEGIN_FAILED".to_owned())?;
    let mut statement = tx
        .prepare("SELECT id FROM mvp_meetings WHERE state='recording' ORDER BY started_at ASC")
        .map_err(|_| "MVP_STORAGE_RECOVERY_FAILED".to_owned())?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|_| "MVP_STORAGE_RECOVERY_FAILED".to_owned())?;
    let mut ids = Vec::new();
    for row in rows {
        ids.push(row.map_err(|_| "MVP_STORAGE_RECOVERY_FAILED".to_owned())?);
    }
    drop(statement);
    for id in &ids {
        tx.execute(
            "UPDATE mvp_meetings
             SET state='interrupted', ended_at=COALESCE(ended_at, ?2), state_version=state_version+1
             WHERE id=?1",
            params![id, now],
        )
        .map_err(|_| "MVP_STORAGE_RECOVERY_FAILED".to_owned())?;
        insert_event(
            &tx,
            Some(id),
            "meeting.recovered_interrupted",
            "startup",
            &now,
        )?;
    }
    tx.execute(
        "UPDATE mvp_translations
         SET status='failed', translated_text=NULL,
             error_code='TRANSLATION_INTERRUPTED', completed_at=?1
         WHERE status='pending'",
        params![now],
    )
    .map_err(|_| "MVP_STORAGE_RECOVERY_FAILED".to_owned())?;
    tx.execute(
        "UPDATE mvp_translation_attempts
         SET status='failed', translated_text=NULL,
             error_code='TRANSLATION_INTERRUPTED', retryable=1, completed_at=?1
         WHERE status='pending'",
        params![now],
    )
    .map_err(|_| "MVP_STORAGE_RECOVERY_FAILED".to_owned())?;
    tx.commit()
        .map_err(|_| "MVP_STORAGE_COMMIT_FAILED".to_owned())?;
    Ok(ids.len())
}

fn start_meeting_on_writer(
    connection: &mut Connection,
    consent_accepted: bool,
    model_label: &str,
) -> Result<MeetingRecord, String> {
    let id = next_id("meeting");
    let now = now_ms_string();
    let tx = connection
        .transaction()
        .map_err(|_| "MVP_STORAGE_TX_BEGIN_FAILED".to_owned())?;
    tx.execute(
        "INSERT INTO mvp_meetings (
            id, schema_version, state, started_at, ended_at, last_opened_at,
            state_version, last_final_sequence, last_event_sequence,
            consent_accepted, model_label, app_contract_version
        ) VALUES (?1, ?2, 'recording', ?3, NULL, ?3, 1, 0, 0, ?4, ?5, ?6)",
        params![
            id,
            MVP_SCHEMA_VERSION,
            now,
            i64::from(consent_accepted),
            model_label,
            MVP_CONTRACT_VERSION
        ],
    )
    .map_err(|_| "MVP_STORAGE_MEETING_START_FAILED".to_owned())?;
    insert_event(&tx, Some(&id), "meeting.started", &id, &now)?;
    tx.commit()
        .map_err(|_| "MVP_STORAGE_COMMIT_FAILED".to_owned())?;
    meeting_on_connection(connection, &id)?
        .ok_or_else(|| "MVP_STORAGE_MEETING_NOT_FOUND".to_owned())
}

fn finish_meeting_on_writer(
    connection: &mut Connection,
    meeting_id: &str,
    state: &str,
    completion_error: Option<&str>,
) -> Result<MeetingRecord, String> {
    if !matches!(state, "completed" | "interrupted") {
        return Err("MVP_STORAGE_MEETING_STATE_INVALID".to_owned());
    }
    if completion_error.is_some() && state != "interrupted" {
        return Err("MVP_STORAGE_MEETING_STATE_INVALID".to_owned());
    }
    let now = now_ms_string();
    let tx = connection
        .transaction()
        .map_err(|_| "MVP_STORAGE_TX_BEGIN_FAILED".to_owned())?;
    let changed = tx
        .execute(
            "UPDATE mvp_meetings
             SET state=?2, ended_at=?3, state_version=state_version+1
             WHERE id=?1",
            params![meeting_id, state, now],
        )
        .map_err(|_| "MVP_STORAGE_MEETING_FINISH_FAILED".to_owned())?;
    if changed != 1 {
        return Err("MVP_STORAGE_MEETING_NOT_FOUND".to_owned());
    }
    insert_event(
        &tx,
        Some(meeting_id),
        &format!("meeting.{state}"),
        meeting_id,
        &now,
    )?;
    if let Some(completion_error) = completion_error {
        insert_event(
            &tx,
            Some(meeting_id),
            "meeting.incomplete",
            completion_error,
            &now,
        )?;
    }
    tx.commit()
        .map_err(|_| "MVP_STORAGE_COMMIT_FAILED".to_owned())?;
    meeting_on_connection(connection, meeting_id)?
        .ok_or_else(|| "MVP_STORAGE_MEETING_NOT_FOUND".to_owned())
}

fn open_meeting_on_writer(
    connection: &mut Connection,
    meeting_id: &str,
) -> Result<MeetingSnapshot, String> {
    let now = now_ms_string();
    let tx = connection
        .transaction()
        .map_err(|_| "MVP_STORAGE_TX_BEGIN_FAILED".to_owned())?;
    let changed = tx
        .execute(
            "UPDATE mvp_meetings SET last_opened_at=?2 WHERE id=?1",
            params![meeting_id, now],
        )
        .map_err(|_| "MVP_STORAGE_OPEN_FAILED".to_owned())?;
    if changed != 1 {
        return Err("MVP_STORAGE_MEETING_NOT_FOUND".to_owned());
    }
    let snapshot = snapshot_from_transaction(&tx, meeting_id)?;
    tx.commit()
        .map_err(|_| "MVP_STORAGE_COMMIT_FAILED".to_owned())?;
    Ok(snapshot)
}

fn commit_final_on_writer(
    connection: &mut Connection,
    candidate: FinalCandidate,
) -> Result<CommitAck, String> {
    let started = Instant::now();
    let tx = connection
        .transaction()
        .map_err(|_| "MVP_STORAGE_TX_BEGIN_FAILED".to_owned())?;
    let existing = select_final_by_key(
        &tx,
        &candidate.meeting_id,
        &candidate.segment_id,
        1,
        candidate.revision,
    )?;
    if let Some(existing) = existing {
        if existing.sequence == candidate.sequence
            && existing.text == candidate.text
            && existing.started_at_ms == candidate.started_at_ms
            && existing.ended_at_ms == candidate.ended_at_ms
            && existing.meeting_sample_start == candidate.meeting_sample_start
            && existing.meeting_sample_end == candidate.meeting_sample_end
            && existing.timeline_revision == candidate.timeline_revision
        {
            tx.commit()
                .map_err(|_| "MVP_STORAGE_COMMIT_FAILED".to_owned())?;
            return Ok(CommitAck {
                final_segment: existing,
                duplicate: true,
                latency_micros: started.elapsed().as_micros(),
            });
        }
        return Err("MVP_STORAGE_DUPLICATE_FINAL_CONFLICT".to_owned());
    }

    let last: i64 = tx
        .query_row(
            "SELECT last_final_sequence FROM mvp_meetings WHERE id=?1",
            params![candidate.meeting_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| "MVP_STORAGE_MEETING_QUERY_FAILED".to_owned())?
        .ok_or_else(|| "MVP_STORAGE_MEETING_NOT_FOUND".to_owned())?;
    let expected = u64::try_from(last).unwrap_or(0).saturating_add(1);
    if candidate.sequence != expected {
        return Err("MVP_STORAGE_FINAL_SEQUENCE_GAP_OR_REORDER".to_owned());
    }

    let committed_at = now_ms_string();
    let content_sha256 = sha256_hex(candidate.text.as_bytes());
    let commit_id = sha256_hex(
        format!(
            "{}\n{}\n{}\n{}\n{}",
            candidate.meeting_id,
            candidate.segment_id,
            candidate.sequence,
            candidate.revision,
            content_sha256
        )
        .as_bytes(),
    );
    tx.execute(
        "INSERT INTO mvp_final_segments (
            meeting_id, segment_id, sequence, revision, transcript_generation,
            source_revision, text, started_at_ms, ended_at_ms,
            content_sha256, committed_at, commit_id, meeting_sample_start,
            meeting_sample_end, timeline_revision
        ) VALUES (?1, ?2, ?3, ?4, 1, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        params![
            candidate.meeting_id,
            candidate.segment_id,
            i64::try_from(candidate.sequence)
                .map_err(|_| "MVP_STORAGE_SEQUENCE_OVERFLOW".to_owned())?,
            i64::from(candidate.revision),
            candidate.text,
            candidate.started_at_ms,
            candidate.ended_at_ms,
            content_sha256,
            committed_at,
            commit_id,
            i64::try_from(candidate.meeting_sample_start).unwrap_or(i64::MAX),
            i64::try_from(candidate.meeting_sample_end).unwrap_or(i64::MAX),
            i64::from(candidate.timeline_revision)
        ],
    )
    .map_err(|_| "MVP_STORAGE_FINAL_INSERT_FAILED".to_owned())?;
    tx.execute(
        "UPDATE mvp_meetings
         SET last_final_sequence=?2, state_version=state_version+1
         WHERE id=?1",
        params![
            candidate.meeting_id,
            i64::try_from(candidate.sequence).unwrap_or(i64::MAX)
        ],
    )
    .map_err(|_| "MVP_STORAGE_MEETING_UPDATE_FAILED".to_owned())?;
    insert_event(
        &tx,
        Some(&candidate.meeting_id),
        "segment.final_durable",
        &commit_id,
        &committed_at,
    )?;
    let durable = select_final_by_sequence(&tx, &candidate.meeting_id, candidate.sequence)?
        .ok_or_else(|| "MVP_STORAGE_FINAL_ACK_MISSING".to_owned())?;
    tx.commit()
        .map_err(|_| "MVP_STORAGE_COMMIT_FAILED".to_owned())?;
    Ok(CommitAck {
        final_segment: durable,
        duplicate: false,
        latency_micros: started.elapsed().as_micros(),
    })
}

fn begin_translation_on_writer(
    connection: &mut Connection,
    candidate: TranslationCandidate,
) -> Result<TranslationAttemptRecord, String> {
    validate_translation_identity(
        &candidate.meeting_id,
        &candidate.segment_id,
        candidate.source_revision,
        &candidate.target_language,
    )?;
    validate_translation_provenance(&candidate)?;
    let now = now_ms_string();
    let tx = connection
        .transaction()
        .map_err(|_| "MVP_STORAGE_TX_BEGIN_FAILED".to_owned())?;
    let final_exists = tx
        .query_row(
            "SELECT 1 FROM mvp_final_segments
             WHERE meeting_id=?1 AND segment_id=?2 AND source_revision=?3",
            params![
                candidate.meeting_id,
                candidate.segment_id,
                i64::from(candidate.source_revision)
            ],
            |_| Ok(()),
        )
        .optional()
        .map_err(|_| "MVP_STORAGE_FINAL_QUERY_FAILED".to_owned())?
        .is_some();
    if !final_exists {
        return Err("MVP_STORAGE_TRANSLATION_FINAL_MISSING".to_owned());
    }
    let attempt = next_translation_attempt(&tx, &candidate)?;
    tx.execute(
        "INSERT INTO mvp_translations (
            meeting_id, segment_id, source_revision, target_language, model,
            status, translated_text, error_code, requested_at, completed_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, 'pending', NULL, NULL, ?6, NULL)
         ON CONFLICT(meeting_id, segment_id, source_revision) DO UPDATE SET
            target_language=excluded.target_language,
            model=excluded.model,
            status='pending',
            translated_text=NULL,
            error_code=NULL,
            requested_at=excluded.requested_at,
            completed_at=NULL",
        params![
            candidate.meeting_id,
            candidate.segment_id,
            i64::from(candidate.source_revision),
            candidate.target_language,
            candidate.model,
            now
        ],
    )
    .map_err(|_| "MVP_STORAGE_TRANSLATION_BEGIN_FAILED".to_owned())?;
    tx.execute(
        "INSERT INTO mvp_translation_attempts (
            meeting_id, segment_id, source_revision, target_language, attempt,
            provider, config_version, endpoint_origin, endpoint_hash, model,
            prompt_version, request_schema_version, status, translated_text, error_code, retryable,
            requested_at, completed_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
                   'pending', NULL, NULL, 0, ?13, NULL)",
        params![
            candidate.meeting_id,
            candidate.segment_id,
            i64::from(candidate.source_revision),
            candidate.target_language,
            i64::from(attempt),
            candidate.provider,
            candidate.config_version,
            candidate.endpoint_origin,
            candidate.endpoint_hash,
            candidate.model,
            candidate.prompt_version,
            candidate.request_schema_version,
            now
        ],
    )
    .map_err(|_| "MVP_STORAGE_TRANSLATION_BEGIN_FAILED".to_owned())?;
    insert_event(
        &tx,
        Some(&candidate.meeting_id),
        "translation.started",
        &format!(
            "{}:{}:{}:{}",
            candidate.segment_id, candidate.source_revision, candidate.target_language, attempt
        ),
        &now,
    )?;
    tx.commit()
        .map_err(|_| "MVP_STORAGE_COMMIT_FAILED".to_owned())?;
    Ok(TranslationAttemptRecord {
        meeting_id: candidate.meeting_id,
        segment_id: candidate.segment_id,
        source_revision: candidate.source_revision,
        target_language: candidate.target_language,
        attempt,
        provider: candidate.provider,
        config_version: candidate.config_version,
        endpoint_origin: candidate.endpoint_origin,
        endpoint_hash: candidate.endpoint_hash,
        model: candidate.model,
        prompt_version: candidate.prompt_version,
        request_schema_version: candidate.request_schema_version,
        status: "pending".to_owned(),
        error_code: None,
        retryable: false,
        requested_at: now,
        completed_at: None,
    })
}

fn finish_translation_on_writer(
    connection: &mut Connection,
    completion: TranslationCompletion,
) -> Result<(), String> {
    validate_translation_identity(
        &completion.meeting_id,
        &completion.segment_id,
        completion.source_revision,
        &completion.target_language,
    )?;
    match (
        completion.translated_text.as_deref(),
        completion.error_code.as_deref(),
        completion.skipped_same_language,
    ) {
        (Some(text), None, false)
            if !text.is_empty()
                && text.len() <= 16_384
                && !text.contains('\0')
                && !text.chars().any(|character| character == '\r') => {}
        (None, Some(error), false)
            if !error.is_empty() && error.len() <= 128 && !error.chars().any(char::is_control) => {}
        (None, None, true) => {}
        _ => return Err("MVP_STORAGE_TRANSLATION_RESULT_INVALID".to_owned()),
    }
    let status = if completion.skipped_same_language {
        "skipped"
    } else if completion.translated_text.is_some() {
        "completed"
    } else {
        "failed"
    };
    let translated_text = completion.translated_text.as_deref();
    let error_code = completion.error_code.as_deref();
    let now = now_ms_string();
    let tx = connection
        .transaction()
        .map_err(|_| "MVP_STORAGE_TX_BEGIN_FAILED".to_owned())?;
    let changed = tx
        .execute(
            "UPDATE mvp_translation_attempts
             SET status=?5, translated_text=?6, error_code=?7, completed_at=?8
             WHERE meeting_id=?1 AND segment_id=?2 AND source_revision=?3
               AND target_language=?4 AND attempt=?9 AND status='pending'",
            params![
                completion.meeting_id,
                completion.segment_id,
                i64::from(completion.source_revision),
                completion.target_language,
                status,
                translated_text,
                error_code,
                now,
                i64::from(completion.attempt)
            ],
        )
        .map_err(|_| "MVP_STORAGE_TRANSLATION_FINISH_FAILED".to_owned())?;
    if changed != 1 {
        return Err("MVP_STORAGE_TRANSLATION_PENDING_MISSING".to_owned());
    }
    tx.execute(
        "UPDATE mvp_translation_attempts
         SET retryable=?6
         WHERE meeting_id=?1 AND segment_id=?2 AND source_revision=?3
           AND target_language=?4 AND attempt=?5",
        params![
            completion.meeting_id,
            completion.segment_id,
            i64::from(completion.source_revision),
            completion.target_language,
            i64::from(completion.attempt),
            i64::from(completion.retryable)
        ],
    )
    .map_err(|_| "MVP_STORAGE_TRANSLATION_FINISH_FAILED".to_owned())?;
    tx.execute(
        "UPDATE mvp_translations
         SET status=?5, translated_text=?6, error_code=?7, completed_at=?8
         WHERE meeting_id=?1 AND segment_id=?2 AND source_revision=?3
           AND target_language=?4",
        params![
            completion.meeting_id,
            completion.segment_id,
            i64::from(completion.source_revision),
            completion.target_language,
            status,
            translated_text,
            error_code,
            now
        ],
    )
    .map_err(|_| "MVP_STORAGE_TRANSLATION_FINISH_FAILED".to_owned())?;
    insert_event(
        &tx,
        Some(&completion.meeting_id),
        if status == "completed" {
            "translation.completed"
        } else {
            "translation.failed"
        },
        &format!(
            "{}:{}:{}:{}",
            completion.segment_id,
            completion.source_revision,
            completion.target_language,
            completion.attempt
        ),
        &now,
    )?;
    tx.commit()
        .map_err(|_| "MVP_STORAGE_COMMIT_FAILED".to_owned())
}

fn validate_translation_identity(
    meeting_id: &str,
    segment_id: &str,
    source_revision: u32,
    target_language: &str,
) -> Result<(), String> {
    if meeting_id.is_empty()
        || meeting_id.len() > 128
        || segment_id.is_empty()
        || segment_id.len() > 128
        || source_revision == 0
        || !matches!(target_language, "zh" | "ja" | "en")
        || meeting_id.chars().any(char::is_control)
        || segment_id.chars().any(char::is_control)
    {
        return Err("MVP_STORAGE_TRANSLATION_IDENTITY_INVALID".to_owned());
    }
    Ok(())
}

fn validate_translation_provenance(candidate: &TranslationCandidate) -> Result<(), String> {
    for value in [
        candidate.model.as_str(),
        candidate.provider.as_str(),
        candidate.config_version.as_str(),
        candidate.endpoint_hash.as_str(),
        candidate.prompt_version.as_str(),
        candidate.request_schema_version.as_str(),
    ] {
        if value.len() > 256 || value.chars().any(char::is_control) {
            return Err("MVP_STORAGE_TRANSLATION_PROVENANCE_INVALID".to_owned());
        }
    }
    if candidate.model.is_empty() {
        return Err("MVP_STORAGE_TRANSLATION_MODEL_INVALID".to_owned());
    }
    if candidate.provider.is_empty()
        || candidate.config_version.is_empty()
        || candidate.prompt_version.is_empty()
        || candidate.request_schema_version.is_empty()
    {
        return Err("MVP_STORAGE_TRANSLATION_PROVENANCE_INVALID".to_owned());
    }
    if let Some(origin) = candidate.endpoint_origin.as_deref()
        && (origin.len() > 256
            || origin.contains('@')
            || origin.contains('?')
            || origin.contains('#')
            || origin.chars().any(char::is_control))
    {
        return Err("MVP_STORAGE_TRANSLATION_PROVENANCE_INVALID".to_owned());
    }
    if !candidate.endpoint_hash.is_empty()
        && (candidate.endpoint_hash.len() != 64
            || !candidate
                .endpoint_hash
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit()))
    {
        return Err("MVP_STORAGE_TRANSLATION_PROVENANCE_INVALID".to_owned());
    }
    Ok(())
}

fn next_translation_attempt(
    tx: &Transaction<'_>,
    candidate: &TranslationCandidate,
) -> Result<u32, String> {
    let next: i64 = tx
        .query_row(
            "SELECT COALESCE(MAX(attempt), 0) + 1
             FROM mvp_translation_attempts
             WHERE meeting_id=?1 AND segment_id=?2 AND source_revision=?3 AND target_language=?4",
            params![
                candidate.meeting_id,
                candidate.segment_id,
                i64::from(candidate.source_revision),
                candidate.target_language
            ],
            |row| row.get(0),
        )
        .map_err(|_| "MVP_STORAGE_TRANSLATION_ATTEMPT_QUERY_FAILED".to_owned())?;
    u32::try_from(next).map_err(|_| "MVP_STORAGE_TRANSLATION_ATTEMPT_OVERFLOW".to_owned())
}

#[allow(dead_code)]
fn failed_translation_retry_plan_on_connection(
    connection: &Connection,
    meeting_id: &str,
) -> Result<TranslationRetryPlan, String> {
    let mut statement = connection
        .prepare(
            "SELECT t.meeting_id, t.segment_id, t.source_revision, t.target_language, t.model,
                    COALESCE(t.error_code, 'TRANSLATION_FAILED'),
                    COALESCE(a.attempt, 0),
                    COALESCE(a.retryable, 0)
             FROM mvp_translations t
             LEFT JOIN mvp_translation_attempts a
               ON a.meeting_id=t.meeting_id AND a.segment_id=t.segment_id
              AND a.source_revision=t.source_revision AND a.target_language=t.target_language
              AND a.attempt=(
                  SELECT MAX(last.attempt)
                  FROM mvp_translation_attempts last
                  WHERE last.meeting_id=t.meeting_id AND last.segment_id=t.segment_id
                    AND last.source_revision=t.source_revision
                    AND last.target_language=t.target_language
              )
             WHERE t.meeting_id=?1 AND t.status='failed'
             ORDER BY t.segment_id ASC",
        )
        .map_err(|_| "MVP_STORAGE_TRANSLATION_RETRY_QUERY_FAILED".to_owned())?;
    let rows = statement
        .query_map(params![meeting_id], failed_retry_item_from_row)
        .map_err(|_| "MVP_STORAGE_TRANSLATION_RETRY_QUERY_FAILED".to_owned())?;
    let mut items = Vec::new();
    for row in rows {
        items.push(row.map_err(|_| "MVP_STORAGE_TRANSLATION_RETRY_QUERY_FAILED".to_owned())?);
    }
    let retryable = items.iter().filter(|item| item.retryable).count();
    Ok(TranslationRetryPlan {
        meeting_id: meeting_id.to_owned(),
        total: items.len(),
        retryable,
        non_retryable: items.len().saturating_sub(retryable),
        items,
    })
}

#[allow(dead_code)]
fn failed_retry_item_from_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<FailedTranslationRetryItem> {
    let source_revision: i64 = row.get(2)?;
    let last_attempt: i64 = row.get(6)?;
    let retryable: i64 = row.get(7)?;
    Ok(FailedTranslationRetryItem {
        meeting_id: row.get(0)?,
        segment_id: row.get(1)?,
        source_revision: u32::try_from(source_revision).unwrap_or(0),
        target_language: row.get(3)?,
        model: row.get(4)?,
        last_error_code: row.get(5)?,
        last_attempt: u32::try_from(last_attempt).unwrap_or(0),
        retryable: retryable == 1,
    })
}

#[allow(dead_code)]
fn record_recovery_action_on_writer(
    connection: &mut Connection,
    meeting_id: &str,
    action: RecoveryActionKind,
) -> Result<RecoveryActionRecord, String> {
    let now = now_ms_string();
    let action = action.as_str();
    let result_state = if action == "finalize" {
        "completed"
    } else {
        "interrupted"
    };
    let action_id = sha256_hex(format!("{meeting_id}\n{action}").as_bytes());
    let tx = connection
        .transaction()
        .map_err(|_| "MVP_STORAGE_TX_BEGIN_FAILED".to_owned())?;
    let meeting_state = tx
        .query_row(
            "SELECT state FROM mvp_meetings WHERE id=?1",
            params![meeting_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|_| "MVP_STORAGE_MEETING_QUERY_FAILED".to_owned())?
        .ok_or_else(|| "MVP_STORAGE_MEETING_NOT_FOUND".to_owned())?;
    if meeting_state != "interrupted" && action != "finalize" {
        return Err("MVP_STORAGE_RECOVERY_ACTION_STATE_INVALID".to_owned());
    }
    tx.execute(
        "INSERT OR IGNORE INTO mvp_recovery_actions(
            action_id, meeting_id, action, result_state, created_at
         ) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![action_id, meeting_id, action, result_state, now],
    )
    .map_err(|_| "MVP_STORAGE_RECOVERY_ACTION_FAILED".to_owned())?;
    if action == "finalize" {
        tx.execute(
            "UPDATE mvp_meetings
             SET state='completed', ended_at=COALESCE(ended_at, ?2), state_version=state_version+1
             WHERE id=?1 AND state='interrupted'",
            params![meeting_id, now],
        )
        .map_err(|_| "MVP_STORAGE_RECOVERY_ACTION_FAILED".to_owned())?;
    }
    let record = tx
        .query_row(
            "SELECT action_id, meeting_id, action, result_state, created_at
             FROM mvp_recovery_actions WHERE action_id=?1",
            params![action_id],
            recovery_action_from_row,
        )
        .map_err(|_| "MVP_STORAGE_RECOVERY_ACTION_FAILED".to_owned())?;
    tx.commit()
        .map_err(|_| "MVP_STORAGE_COMMIT_FAILED".to_owned())?;
    Ok(record)
}

#[allow(dead_code)]
fn recovery_action_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<RecoveryActionRecord> {
    Ok(RecoveryActionRecord {
        action_id: row.get(0)?,
        meeting_id: row.get(1)?,
        action: row.get(2)?,
        result_state: row.get(3)?,
        created_at: row.get(4)?,
    })
}

fn record_export_snapshot_on_writer(
    connection: &mut Connection,
    snapshot: &MeetingSnapshot,
    exports: &[CompletedExport],
) -> Result<(), String> {
    let tx = connection
        .transaction()
        .map_err(|_| "MVP_STORAGE_TX_BEGIN_FAILED".to_owned())?;
    tx.execute(
        "INSERT OR IGNORE INTO mvp_export_snapshots (
            snapshot_id, meeting_id, snapshot_generation, input_projection_generation,
            semantic_sha256, final_count, created_at
        ) VALUES (?1, ?2, ?3, 1, ?4, ?5, ?6)",
        params![
            snapshot.snapshot_id,
            snapshot.meeting.id,
            i64::try_from(snapshot.snapshot_generation)
                .map_err(|_| "MVP_STORAGE_EXPORT_OVERFLOW".to_owned())?,
            snapshot.semantic_sha256,
            i64::try_from(snapshot.finals.len())
                .map_err(|_| "MVP_STORAGE_EXPORT_OVERFLOW".to_owned())?,
            now_ms_string()
        ],
    )
    .map_err(|_| "MVP_STORAGE_EXPORT_SNAPSHOT_FAILED".to_owned())?;
    for export in exports {
        tx.execute(
            "INSERT INTO mvp_exports (
                export_id, snapshot_id, format, target_path, byte_length, sha256,
                completed_at, validation_manifest_json
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                export.export_id,
                snapshot.snapshot_id,
                export.format,
                export.target_path.display().to_string(),
                i64::try_from(export.byte_length)
                    .map_err(|_| "MVP_STORAGE_EXPORT_OVERFLOW".to_owned())?,
                export.sha256,
                export.completed_at,
                export.validation_manifest_json
            ],
        )
        .map_err(|_| "MVP_STORAGE_EXPORT_RECORD_FAILED".to_owned())?;
    }
    tx.commit()
        .map_err(|_| "MVP_STORAGE_COMMIT_FAILED".to_owned())
}

fn start_meeting_with_metadata_on_writer(
    connection: &mut Connection,
    consent_accepted: bool,
    model_label: &str,
    title: &str,
    language: &str,
) -> Result<MeetingRecord, String> {
    let meeting = start_meeting_on_writer(connection, consent_accepted, model_label)?;
    update_meeting_metadata_on_writer(connection, &meeting.id, title, language)?;
    meeting_on_connection(connection, &meeting.id)?
        .ok_or_else(|| "MVP_STORAGE_MEETING_NOT_FOUND".to_owned())
}

fn update_meeting_metadata_on_writer(
    connection: &mut Connection,
    meeting_id: &str,
    title: &str,
    language: &str,
) -> Result<(), String> {
    let changed = connection
        .execute(
            "UPDATE mvp_meetings
             SET title=?2, language=?3, state_version=state_version+1
             WHERE id=?1 AND deleted_at IS NULL",
            params![meeting_id, title, language],
        )
        .map_err(|_| "MVP_STORAGE_MEETING_UPDATE_FAILED".to_owned())?;
    if changed != 1 {
        return Err("MVP_STORAGE_MEETING_NOT_FOUND".to_owned());
    }
    Ok(())
}

fn create_tag_on_writer(
    connection: &mut Connection,
    name: &str,
    color: Option<&str>,
) -> Result<TagRecord, String> {
    let tag_id = next_id("tag");
    let now = now_ms_string();
    connection
        .execute(
            "INSERT INTO mvp_tags(tag_id, name, color, created_at) VALUES (?1, ?2, ?3, ?4)",
            params![tag_id, name, color, now],
        )
        .map_err(|_| "MVP_STORAGE_TAG_CREATE_FAILED".to_owned())?;
    Ok(TagRecord {
        tag_id,
        name: name.to_owned(),
        color: color.map(str::to_owned),
        created_at: now,
    })
}

fn delete_tag_on_writer(connection: &mut Connection, tag_id: &str) -> Result<(), String> {
    let changed = connection
        .execute("DELETE FROM mvp_tags WHERE tag_id=?1", params![tag_id])
        .map_err(|_| "MVP_STORAGE_TAG_DELETE_FAILED".to_owned())?;
    if changed != 1 {
        return Err("MVP_STORAGE_TAG_NOT_FOUND".to_owned());
    }
    Ok(())
}

fn assign_tag_on_writer(
    connection: &mut Connection,
    meeting_id: &str,
    tag_id: &str,
) -> Result<(), String> {
    connection
        .execute(
            "INSERT OR IGNORE INTO mvp_meeting_tags(meeting_id, tag_id, assigned_at)
             VALUES (?1, ?2, ?3)",
            params![meeting_id, tag_id, now_ms_string()],
        )
        .map_err(|_| "MVP_STORAGE_TAG_ASSIGN_FAILED".to_owned())?;
    Ok(())
}

fn unassign_tag_on_writer(
    connection: &mut Connection,
    meeting_id: &str,
    tag_id: &str,
) -> Result<(), String> {
    connection
        .execute(
            "DELETE FROM mvp_meeting_tags WHERE meeting_id=?1 AND tag_id=?2",
            params![meeting_id, tag_id],
        )
        .map_err(|_| "MVP_STORAGE_TAG_ASSIGN_FAILED".to_owned())?;
    Ok(())
}

fn replace_meeting_tags_on_writer(
    connection: &mut Connection,
    meeting_id: &str,
    names: Vec<String>,
) -> Result<Vec<TagRecord>, String> {
    let tx = connection
        .transaction()
        .map_err(|_| "MVP_STORAGE_TX_BEGIN_FAILED".to_owned())?;
    let meeting_exists = tx
        .query_row(
            "SELECT 1 FROM mvp_meetings WHERE id=?1 AND deleted_at IS NULL",
            params![meeting_id],
            |_| Ok(()),
        )
        .optional()
        .map_err(|_| "MVP_STORAGE_MEETING_QUERY_FAILED".to_owned())?
        .is_some();
    if !meeting_exists {
        return Err("MVP_STORAGE_MEETING_NOT_FOUND".to_owned());
    }
    tx.execute(
        "DELETE FROM mvp_meeting_tags WHERE meeting_id=?1",
        params![meeting_id],
    )
    .map_err(|_| "MVP_STORAGE_TAG_ASSIGN_FAILED".to_owned())?;
    let mut records = Vec::new();
    for name in names {
        let now = now_ms_string();
        let tag_id = tx
            .query_row(
                "SELECT tag_id FROM mvp_tags WHERE name=?1",
                params![name],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|_| "MVP_STORAGE_TAG_QUERY_FAILED".to_owned())?
            .unwrap_or_else(|| next_id("tag"));
        tx.execute(
            "INSERT OR IGNORE INTO mvp_tags(tag_id, name, color, created_at)
             VALUES (?1, ?2, NULL, ?3)",
            params![tag_id, name, now],
        )
        .map_err(|_| "MVP_STORAGE_TAG_CREATE_FAILED".to_owned())?;
        tx.execute(
            "INSERT OR IGNORE INTO mvp_meeting_tags(meeting_id, tag_id, assigned_at)
             VALUES (?1, ?2, ?3)",
            params![meeting_id, tag_id, now],
        )
        .map_err(|_| "MVP_STORAGE_TAG_ASSIGN_FAILED".to_owned())?;
        records.push(
            tx.query_row(
                "SELECT tag_id, name, color, created_at FROM mvp_tags WHERE tag_id=?1",
                params![tag_id],
                tag_from_row,
            )
            .map_err(|_| "MVP_STORAGE_TAG_QUERY_FAILED".to_owned())?,
        );
    }
    tx.commit()
        .map_err(|_| "MVP_STORAGE_COMMIT_FAILED".to_owned())?;
    Ok(records)
}

fn save_provider_profile_on_writer(
    connection: &mut Connection,
    input: ProviderProfileInput,
) -> Result<ProviderProfileRecord, String> {
    let profile_id = input.profile_id.unwrap_or_else(|| next_id("provider"));
    let label = input.label;
    let provider_class = input.provider_class;
    let base_url = input.base_url;
    let model = input.model;
    let endpoint_hash = input.endpoint_hash;
    let data_flow = input.data_flow;
    let policy_url = input.policy_url;
    let config_version = input.config_version;
    let secret_state = input.secret_state;
    let last_test_at = input.last_test_at;
    let last_test_status = input.last_test_status;
    let last_error = input.last_error;
    let version: i64 = connection
        .query_row(
            "SELECT COALESCE(MAX(version), 0) + 1 FROM mvp_provider_profiles WHERE profile_id=?1",
            params![profile_id],
            |row| row.get(0),
        )
        .map_err(|_| "MVP_STORAGE_PROVIDER_QUERY_FAILED".to_owned())?;
    let now = now_ms_string();
    connection
        .execute(
            "INSERT INTO mvp_provider_profiles (
                profile_id, version, name, provider_kind, endpoint_origin, endpoint_hash,
                data_flow, policy_url, config_version, label, provider_class, base_url,
                model, config_version_number, secret_state, last_error,
                last_test_at, last_test_status, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
                       ?13, ?14, ?15, ?16, ?17, ?18, ?19)",
            params![
                profile_id,
                version,
                label,
                provider_kind_from_class(&provider_class),
                base_url,
                endpoint_hash,
                data_flow,
                policy_url,
                config_version.to_string(),
                label,
                provider_class,
                base_url,
                model,
                i64::from(config_version),
                secret_state,
                last_error,
                last_test_at,
                last_test_status,
                now
            ],
        )
        .map_err(|_| "MVP_STORAGE_PROVIDER_SAVE_FAILED".to_owned())?;
    Ok(ProviderProfileRecord {
        profile_id,
        version: u32::try_from(version).unwrap_or(0),
        label,
        provider_class,
        base_url,
        model,
        endpoint_hash,
        data_flow,
        policy_url,
        config_version,
        secret_state,
        last_test_at,
        last_test_status,
        last_error,
        created_at: now,
    })
}

fn start_summary_job_on_writer(
    connection: &mut Connection,
    input: SummaryJobInput,
    parent_job_id: Option<&str>,
) -> Result<SummaryJobRecord, String> {
    let meeting_exists = connection
        .query_row(
            "SELECT 1 FROM mvp_meetings WHERE id=?1 AND deleted_at IS NULL",
            params![input.meeting_id],
            |_| Ok(()),
        )
        .optional()
        .map_err(|_| "MVP_STORAGE_MEETING_QUERY_FAILED".to_owned())?
        .is_some();
    if !meeting_exists {
        return Err("MVP_STORAGE_MEETING_NOT_FOUND".to_owned());
    }
    let attempt: i64 = if let Some(parent) = parent_job_id {
        connection
            .query_row(
                "SELECT attempt + 1 FROM mvp_summary_jobs WHERE job_id=?1 AND meeting_id=?2",
                params![parent, input.meeting_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| "MVP_STORAGE_SUMMARY_QUERY_FAILED".to_owned())?
            .ok_or_else(|| "MVP_STORAGE_SUMMARY_PARENT_NOT_FOUND".to_owned())?
    } else {
        1
    };
    let job_id = next_id("summary");
    let now = now_ms_string();
    connection
        .execute(
            "INSERT INTO mvp_summary_jobs (
                job_id, meeting_id, parent_job_id, attempt, status, provider_profile_id,
                prompt_version, request_schema_version, error_code, retryable,
                requested_at, completed_at, cancelled_at
             ) VALUES (?1, ?2, ?3, ?4, 'pending', ?5, ?6, ?7, NULL, 0, ?8, NULL, NULL)",
            params![
                job_id,
                input.meeting_id,
                parent_job_id,
                attempt,
                input.provider_profile_id,
                input.prompt_version,
                input.request_schema_version,
                now
            ],
        )
        .map_err(|_| "MVP_STORAGE_SUMMARY_START_FAILED".to_owned())?;
    summary_job_by_id(connection, &job_id)
}

fn append_summary_chunk_on_writer(
    connection: &mut Connection,
    input: SummaryChunkInput,
) -> Result<(), String> {
    ensure_summary_pending(connection, &input.job_id)?;
    connection
        .execute(
            "INSERT INTO mvp_summary_chunks(job_id, chunk_index, source_segment_ids, text, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                input.job_id,
                i64::from(input.chunk_index),
                encode_id_list(&input.source_segment_ids),
                input.text,
                now_ms_string()
            ],
        )
        .map_err(|_| "MVP_STORAGE_SUMMARY_APPEND_FAILED".to_owned())?;
    Ok(())
}

fn append_summary_result_on_writer(
    connection: &mut Connection,
    input: SummaryResultInput,
) -> Result<(), String> {
    ensure_summary_pending(connection, &input.job_id)?;
    connection
        .execute(
            "INSERT INTO mvp_summary_results (
                job_id, section_kind, section_index, heading, text, citation_segment_ids, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                input.job_id,
                input.section_kind,
                i64::from(input.section_index),
                input.heading,
                input.text,
                encode_id_list(&input.citation_segment_ids),
                now_ms_string()
            ],
        )
        .map_err(|_| "MVP_STORAGE_SUMMARY_APPEND_FAILED".to_owned())?;
    Ok(())
}

fn finish_summary_job_on_writer(
    connection: &mut Connection,
    job_id: &str,
    error_code: Option<&str>,
    retryable: bool,
    cancel: bool,
) -> Result<SummaryJobRecord, String> {
    let now = now_ms_string();
    let status = if cancel {
        "cancelled"
    } else if error_code.is_some() {
        "failed"
    } else {
        "completed"
    };
    let changed = connection
        .execute(
            "UPDATE mvp_summary_jobs
             SET status=?2, error_code=?3, retryable=?4,
                 completed_at=CASE WHEN ?5=0 THEN ?6 ELSE completed_at END,
                 cancelled_at=CASE WHEN ?5=1 THEN ?6 ELSE cancelled_at END
             WHERE job_id=?1 AND status='pending'",
            params![
                job_id,
                status,
                error_code,
                i64::from(retryable),
                i64::from(cancel),
                now
            ],
        )
        .map_err(|_| "MVP_STORAGE_SUMMARY_FINISH_FAILED".to_owned())?;
    if changed != 1 {
        return Err("MVP_STORAGE_SUMMARY_PENDING_MISSING".to_owned());
    }
    summary_job_by_id(connection, job_id)
}

fn soft_delete_meeting_on_writer(
    connection: &mut Connection,
    meeting_id: &str,
    file_manifest_json: &str,
) -> Result<DeleteTombstoneRecord, String> {
    let tx = connection
        .transaction()
        .map_err(|_| "MVP_STORAGE_TX_BEGIN_FAILED".to_owned())?;
    let now = now_ms_string();
    let tombstone_id = next_id("tombstone");
    let changed = tx
        .execute(
            "UPDATE mvp_meetings
             SET deleted_at=?2, delete_tombstone_id=?3
             WHERE id=?1 AND deleted_at IS NULL",
            params![meeting_id, now, tombstone_id],
        )
        .map_err(|_| "MVP_STORAGE_DELETE_FAILED".to_owned())?;
    if changed != 1 {
        return Err("MVP_STORAGE_MEETING_NOT_FOUND".to_owned());
    }
    tx.execute(
        "INSERT INTO mvp_meeting_delete_tombstones(
            tombstone_id, meeting_id, deleted_at, file_manifest_json, restored_at, purged_at
         ) VALUES (?1, ?2, ?3, ?4, NULL, NULL)",
        params![tombstone_id, meeting_id, now, file_manifest_json],
    )
    .map_err(|_| "MVP_STORAGE_DELETE_FAILED".to_owned())?;
    tx.commit()
        .map_err(|_| "MVP_STORAGE_COMMIT_FAILED".to_owned())?;
    delete_tombstone_by_meeting(connection, meeting_id)
}

fn restore_meeting_on_writer(
    connection: &mut Connection,
    meeting_id: &str,
) -> Result<DeleteTombstoneRecord, String> {
    let tx = connection
        .transaction()
        .map_err(|_| "MVP_STORAGE_TX_BEGIN_FAILED".to_owned())?;
    let tombstone_id: String = tx
        .query_row(
            "SELECT delete_tombstone_id FROM mvp_meetings WHERE id=?1 AND deleted_at IS NOT NULL",
            params![meeting_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| "MVP_STORAGE_DELETE_QUERY_FAILED".to_owned())?
        .ok_or_else(|| "MVP_STORAGE_DELETE_TOMBSTONE_NOT_FOUND".to_owned())?;
    let now = now_ms_string();
    tx.execute(
        "UPDATE mvp_meetings SET deleted_at=NULL, delete_tombstone_id=NULL WHERE id=?1",
        params![meeting_id],
    )
    .map_err(|_| "MVP_STORAGE_RESTORE_FAILED".to_owned())?;
    tx.execute(
        "UPDATE mvp_meeting_delete_tombstones SET restored_at=?2 WHERE tombstone_id=?1",
        params![tombstone_id, now],
    )
    .map_err(|_| "MVP_STORAGE_RESTORE_FAILED".to_owned())?;
    tx.commit()
        .map_err(|_| "MVP_STORAGE_COMMIT_FAILED".to_owned())?;
    delete_tombstone_by_id(connection, &tombstone_id)
}

fn purge_meeting_metadata_on_writer(
    connection: &mut Connection,
    meeting_id: &str,
) -> Result<DeleteTombstoneRecord, String> {
    let tx = connection
        .transaction()
        .map_err(|_| "MVP_STORAGE_TX_BEGIN_FAILED".to_owned())?;
    let mut tombstone: DeleteTombstoneRecord = tx
        .query_row(
            "SELECT t.tombstone_id, t.meeting_id, t.deleted_at, t.file_manifest_json,
                    t.restored_at, t.purged_at
             FROM mvp_meetings m
             JOIN mvp_meeting_delete_tombstones t ON t.tombstone_id=m.delete_tombstone_id
             WHERE m.id=?1 AND m.deleted_at IS NOT NULL",
            params![meeting_id],
            delete_tombstone_from_row,
        )
        .optional()
        .map_err(|_| "MVP_STORAGE_DELETE_QUERY_FAILED".to_owned())?
        .ok_or_else(|| "MVP_STORAGE_DELETE_TOMBSTONE_NOT_FOUND".to_owned())?;
    let purged_at = now_ms_string();
    tombstone.purged_at = Some(purged_at);
    tx.execute(
        "DELETE FROM mvp_search_fts WHERE meeting_id=?1",
        params![meeting_id],
    )
    .map_err(|_| "MVP_STORAGE_PURGE_FAILED".to_owned())?;
    let _ = tx.execute(
        "DELETE FROM mvp_search_trigram_fts WHERE meeting_id=?1",
        params![meeting_id],
    );
    tx.execute(
        "DELETE FROM mvp_exports
         WHERE snapshot_id IN (
             SELECT snapshot_id FROM mvp_export_snapshots WHERE meeting_id=?1
         )",
        params![meeting_id],
    )
    .map_err(|_| "MVP_STORAGE_PURGE_FAILED".to_owned())?;
    tx.execute(
        "DELETE FROM mvp_summary_results
         WHERE job_id IN (SELECT job_id FROM mvp_summary_jobs WHERE meeting_id=?1)",
        params![meeting_id],
    )
    .map_err(|_| "MVP_STORAGE_PURGE_FAILED".to_owned())?;
    tx.execute(
        "DELETE FROM mvp_summary_chunks
         WHERE job_id IN (SELECT job_id FROM mvp_summary_jobs WHERE meeting_id=?1)",
        params![meeting_id],
    )
    .map_err(|_| "MVP_STORAGE_PURGE_FAILED".to_owned())?;
    for sql in [
        "DELETE FROM mvp_summary_jobs WHERE meeting_id=?1",
        "DELETE FROM mvp_translation_attempts WHERE meeting_id=?1",
        "DELETE FROM mvp_translations WHERE meeting_id=?1",
        "DELETE FROM mvp_final_segments WHERE meeting_id=?1",
        "DELETE FROM mvp_recovery_actions WHERE meeting_id=?1",
        "DELETE FROM mvp_meeting_tags WHERE meeting_id=?1",
        "DELETE FROM mvp_events WHERE meeting_id=?1",
        "DELETE FROM mvp_export_snapshots WHERE meeting_id=?1",
        "DELETE FROM mvp_meeting_delete_tombstones WHERE meeting_id=?1",
        "DELETE FROM mvp_meetings WHERE id=?1",
    ] {
        tx.execute(sql, params![meeting_id])
            .map_err(|_| "MVP_STORAGE_PURGE_FAILED".to_owned())?;
    }
    tx.commit()
        .map_err(|_| "MVP_STORAGE_COMMIT_FAILED".to_owned())?;
    Ok(tombstone)
}

fn bounded_limit(limit: usize, max: usize) -> usize {
    if limit == 0 { max } else { limit.min(max) }
}

fn parse_library_cursor(cursor: Option<&str>) -> (&str, &str) {
    cursor
        .and_then(|value| value.split_once(':'))
        .unwrap_or(("", ""))
}

fn parse_search_cursor(cursor: Option<&str>) -> (&str, u64, &str) {
    let Some(cursor) = cursor else {
        return ("", 0, "");
    };
    let mut parts = cursor.splitn(3, ':');
    let meeting_id = parts.next().unwrap_or("");
    let sequence = parts
        .next()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0);
    let scope = parts.next().unwrap_or("");
    (meeting_id, sequence, scope)
}

fn validate_meeting_metadata(title: &str, language: &str) -> Result<(), String> {
    if title.len() > 256 || title.chars().any(char::is_control) {
        return Err("MVP_STORAGE_MEETING_METADATA_INVALID".to_owned());
    }
    if language.is_empty()
        || language.len() > 32
        || language.chars().any(char::is_control)
        || language.contains(' ')
    {
        return Err("MVP_STORAGE_MEETING_METADATA_INVALID".to_owned());
    }
    Ok(())
}

fn validate_tag(name: &str, color: Option<&str>) -> Result<(), String> {
    if name.is_empty() || name.len() > 64 || name.chars().any(char::is_control) {
        return Err("MVP_STORAGE_TAG_INVALID".to_owned());
    }
    if let Some(color) = color
        && (color.len() > 32 || color.chars().any(char::is_control))
    {
        return Err("MVP_STORAGE_TAG_INVALID".to_owned());
    }
    Ok(())
}

fn validate_provider_profile(input: &ProviderProfileInput) -> Result<(), String> {
    if input.label.is_empty()
        || input.label.len() > 128
        || !matches!(input.provider_class.as_str(), "local" | "lan" | "cloud")
        || input.endpoint_hash.len() > 128
        || input.data_flow.is_empty()
        || input.data_flow.len() > 512
        || input.model.len() > 256
        || input.secret_state.len() > 64
    {
        return Err("MVP_STORAGE_PROVIDER_INVALID".to_owned());
    }
    for value in [
        input.label.as_str(),
        input.provider_class.as_str(),
        input.endpoint_hash.as_str(),
        input.data_flow.as_str(),
        input.model.as_str(),
        input.secret_state.as_str(),
    ] {
        if value.chars().any(char::is_control) {
            return Err("MVP_STORAGE_PROVIDER_INVALID".to_owned());
        }
    }
    for value in [
        input.profile_id.as_deref(),
        input.base_url.as_deref(),
        input.policy_url.as_deref(),
        input.last_test_at.as_deref(),
        input.last_test_status.as_deref(),
        input.last_error.as_deref(),
    ]
    .into_iter()
    .flatten()
    {
        if value.len() > 256 || value.chars().any(char::is_control) || value.contains('@') {
            return Err("MVP_STORAGE_PROVIDER_INVALID".to_owned());
        }
    }
    Ok(())
}

fn validate_summary_job_input(input: &SummaryJobInput) -> Result<(), String> {
    if input.meeting_id.is_empty()
        || input.prompt_version.is_empty()
        || input.request_schema_version.is_empty()
        || input.meeting_id.len() > 128
        || input.prompt_version.len() > 128
        || input.request_schema_version.len() > 128
    {
        return Err("MVP_STORAGE_SUMMARY_INVALID".to_owned());
    }
    Ok(())
}

fn validate_summary_chunk(input: &SummaryChunkInput) -> Result<(), String> {
    if input.job_id.is_empty()
        || input.job_id.len() > 128
        || input.source_segment_ids.len() > 256
        || input.text.is_empty()
        || input.text.len() > 65_536
        || input.text.contains('\0')
    {
        return Err("MVP_STORAGE_SUMMARY_INVALID".to_owned());
    }
    Ok(())
}

fn validate_summary_result(input: &SummaryResultInput) -> Result<(), String> {
    if input.job_id.is_empty()
        || input.section_kind.is_empty()
        || input.heading.len() > 256
        || input.text.is_empty()
        || input.text.len() > 65_536
        || input.citation_segment_ids.len() > 256
        || input.text.contains('\0')
    {
        return Err("MVP_STORAGE_SUMMARY_INVALID".to_owned());
    }
    Ok(())
}

fn validate_manifest_json(value: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > 65_536 || value.contains('\0') {
        return Err("MVP_STORAGE_DELETE_MANIFEST_INVALID".to_owned());
    }
    Ok(())
}

fn validate_segment_search_query(query: &SegmentSearchQuery) -> Result<(), String> {
    if let Some(text) = query.text.as_deref()
        && (text.len() > 512 || text.chars().any(char::is_control))
    {
        return Err("MVP_STORAGE_SEARCH_INVALID".to_owned());
    }
    for scope in &query.scopes {
        if !matches!(
            scope.as_str(),
            "original" | "translation" | "summary" | "speaker"
        ) {
            return Err("MVP_STORAGE_SEARCH_INVALID".to_owned());
        }
    }
    if query.tag_ids.len() > 32 {
        return Err("MVP_STORAGE_SEARCH_INVALID".to_owned());
    }
    Ok(())
}

fn encode_id_list(ids: &[String]) -> String {
    ids.join("\n")
}

fn decode_id_list(value: &str) -> Vec<String> {
    value
        .lines()
        .filter(|line| !line.is_empty())
        .map(str::to_owned)
        .collect()
}

fn meeting_library_item_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<MeetingLibraryItem> {
    let started_at: String = row.get(3)?;
    let ended_at: Option<String> = row.get(4)?;
    let duration_ms = ended_at
        .as_deref()
        .and_then(|ended| ended.parse::<u64>().ok())
        .zip(started_at.parse::<u64>().ok())
        .map(|(ended, started)| ended.saturating_sub(started));
    let final_count: i64 = row.get(6)?;
    let translation_count: i64 = row.get(7)?;
    let export_count: i64 = row.get(8)?;
    let summary_job_count: i64 = row.get(9)?;
    let translation_failed_count: i64 = row.get(10)?;
    Ok(MeetingLibraryItem {
        meeting_id: row.get(0)?,
        title: row.get(1)?,
        state: row.get(2)?,
        started_at,
        ended_at,
        duration_ms,
        language: row.get(5)?,
        final_count: usize::try_from(final_count).unwrap_or(0),
        translation_count: usize::try_from(translation_count).unwrap_or(0),
        translation_failed_count: usize::try_from(translation_failed_count).unwrap_or(0),
        export_count: usize::try_from(export_count).unwrap_or(0),
        summary_job_count: usize::try_from(summary_job_count).unwrap_or(0),
        summary_status: row.get(11)?,
        tags: Vec::new(),
    })
}

fn tag_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<TagRecord> {
    Ok(TagRecord {
        tag_id: row.get(0)?,
        name: row.get(1)?,
        color: row.get(2)?,
        created_at: row.get(3)?,
    })
}

fn tags_for_meeting(connection: &Connection, meeting_id: &str) -> Result<Vec<TagRecord>, String> {
    let mut statement = connection
        .prepare(
            "SELECT t.tag_id, t.name, t.color, t.created_at
             FROM mvp_tags t
             JOIN mvp_meeting_tags mt ON mt.tag_id=t.tag_id
             WHERE mt.meeting_id=?1
             ORDER BY t.name ASC",
        )
        .map_err(|_| "MVP_STORAGE_TAG_QUERY_FAILED".to_owned())?;
    let rows = statement
        .query_map(params![meeting_id], tag_from_row)
        .map_err(|_| "MVP_STORAGE_TAG_QUERY_FAILED".to_owned())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|_| "MVP_STORAGE_TAG_QUERY_FAILED".to_owned())
}

fn provider_profile_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ProviderProfileRecord> {
    let version: i64 = row.get(1)?;
    let config_version: i64 = row.get(9)?;
    Ok(ProviderProfileRecord {
        profile_id: row.get(0)?,
        version: u32::try_from(version).unwrap_or(0),
        label: row.get(2)?,
        provider_class: row.get(3)?,
        base_url: row.get(4)?,
        model: row.get(5)?,
        endpoint_hash: row.get(6)?,
        data_flow: row.get(7)?,
        policy_url: row.get(8)?,
        config_version: u32::try_from(config_version).unwrap_or(1),
        secret_state: row.get(10)?,
        last_test_at: row.get(11)?,
        last_test_status: row.get(12)?,
        last_error: row.get(13)?,
        created_at: row.get(14)?,
    })
}

fn provider_kind_from_class(class: &str) -> &'static str {
    match class {
        "local" => "Local",
        "lan" => "LAN",
        _ => "Cloud",
    }
}

fn summary_job_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SummaryJobRecord> {
    let attempt: i64 = row.get(3)?;
    let retryable: i64 = row.get(9)?;
    Ok(SummaryJobRecord {
        job_id: row.get(0)?,
        meeting_id: row.get(1)?,
        parent_job_id: row.get(2)?,
        attempt: u32::try_from(attempt).unwrap_or(0),
        status: row.get(4)?,
        provider_profile_id: row.get(5)?,
        prompt_version: row.get(6)?,
        request_schema_version: row.get(7)?,
        error_code: row.get(8)?,
        retryable: retryable != 0,
        requested_at: row.get(10)?,
        completed_at: row.get(11)?,
        cancelled_at: row.get(12)?,
    })
}

fn summary_job_by_id(connection: &Connection, job_id: &str) -> Result<SummaryJobRecord, String> {
    summary_job_by_id_optional(connection, job_id)?
        .ok_or_else(|| "MVP_STORAGE_SUMMARY_QUERY_FAILED".to_owned())
}

fn summary_job_by_id_optional(
    connection: &Connection,
    job_id: &str,
) -> Result<Option<SummaryJobRecord>, String> {
    connection
        .query_row(
            "SELECT job_id, meeting_id, parent_job_id, attempt, status, provider_profile_id,
                    prompt_version, request_schema_version, error_code, retryable,
                    requested_at, completed_at, cancelled_at
             FROM mvp_summary_jobs WHERE job_id=?1",
            params![job_id],
            summary_job_from_row,
        )
        .optional()
        .map_err(|_| "MVP_STORAGE_SUMMARY_QUERY_FAILED".to_owned())
}

fn summary_results_on_connection(
    connection: &Connection,
    job_id: &str,
) -> Result<Vec<SummaryResultRecord>, String> {
    let mut statement = connection
        .prepare(
            "SELECT job_id, section_kind, section_index, heading, text, citation_segment_ids, created_at
             FROM mvp_summary_results
             WHERE job_id=?1
             ORDER BY section_index ASC, section_kind ASC",
        )
        .map_err(|_| "MVP_STORAGE_SUMMARY_QUERY_FAILED".to_owned())?;
    let rows = statement
        .query_map(params![job_id], |row| {
            let section_index: i64 = row.get(2)?;
            let encoded: String = row.get(5)?;
            Ok(SummaryResultRecord {
                job_id: row.get(0)?,
                section_kind: row.get(1)?,
                section_index: u32::try_from(section_index).unwrap_or(0),
                heading: row.get(3)?,
                text: row.get(4)?,
                citation_segment_ids: decode_id_list(&encoded),
                created_at: row.get(6)?,
            })
        })
        .map_err(|_| "MVP_STORAGE_SUMMARY_QUERY_FAILED".to_owned())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|_| "MVP_STORAGE_SUMMARY_QUERY_FAILED".to_owned())
}

fn latest_summary_job_for_meeting(
    connection: &Connection,
    meeting_id: &str,
) -> Result<Option<SummaryJobRecord>, String> {
    connection
        .query_row(
            "SELECT job_id, meeting_id, parent_job_id, attempt, status, provider_profile_id,
                    prompt_version, request_schema_version, error_code, retryable,
                    requested_at, completed_at, cancelled_at
             FROM mvp_summary_jobs
             WHERE meeting_id=?1
             ORDER BY CASE WHEN status='completed' THEN 0 ELSE 1 END,
                      CAST(requested_at AS INTEGER) DESC, job_id DESC
             LIMIT 1",
            params![meeting_id],
            summary_job_from_row,
        )
        .optional()
        .map_err(|_| "MVP_STORAGE_SUMMARY_QUERY_FAILED".to_owned())
}

#[allow(dead_code)]
fn summary_job_for_meeting_version(
    connection: &Connection,
    meeting_id: &str,
    attempt: u32,
) -> Result<Option<SummaryJobRecord>, String> {
    connection
        .query_row(
            "SELECT job_id, meeting_id, parent_job_id, attempt, status, provider_profile_id,
                    prompt_version, request_schema_version, error_code, retryable,
                    requested_at, completed_at, cancelled_at
             FROM mvp_summary_jobs
             WHERE meeting_id=?1 AND attempt=?2
             LIMIT 1",
            params![meeting_id, i64::from(attempt)],
            summary_job_from_row,
        )
        .optional()
        .map_err(|_| "MVP_STORAGE_SUMMARY_QUERY_FAILED".to_owned())
}

fn count_by_job(connection: &Connection, table: &str, job_id: &str) -> Result<usize, String> {
    let sql = match table {
        "mvp_summary_chunks" => "SELECT COUNT(*) FROM mvp_summary_chunks WHERE job_id=?1",
        "mvp_summary_results" => "SELECT COUNT(*) FROM mvp_summary_results WHERE job_id=?1",
        _ => return Err("MVP_STORAGE_SUMMARY_QUERY_FAILED".to_owned()),
    };
    let count: i64 = connection
        .query_row(sql, params![job_id], |row| row.get(0))
        .map_err(|_| "MVP_STORAGE_SUMMARY_QUERY_FAILED".to_owned())?;
    Ok(usize::try_from(count).unwrap_or(0))
}

fn ensure_summary_pending(connection: &Connection, job_id: &str) -> Result<(), String> {
    let pending = connection
        .query_row(
            "SELECT 1 FROM mvp_summary_jobs WHERE job_id=?1 AND status='pending'",
            params![job_id],
            |_| Ok(()),
        )
        .optional()
        .map_err(|_| "MVP_STORAGE_SUMMARY_QUERY_FAILED".to_owned())?
        .is_some();
    if !pending {
        return Err("MVP_STORAGE_SUMMARY_PENDING_MISSING".to_owned());
    }
    Ok(())
}

fn delete_preview_on_connection(
    connection: &Connection,
    meeting_id: &str,
) -> Result<DeletePreview, String> {
    connection
        .query_row(
            "SELECT m.id,
                    COUNT(DISTINCT f.segment_id),
                    COUNT(DISTINCT t.segment_id || ':' || t.source_revision),
                    COUNT(DISTINCT e.export_id),
                    COUNT(DISTINCT sj.job_id),
                    m.delete_tombstone_id,
                    m.deleted_at
             FROM mvp_meetings m
             LEFT JOIN mvp_final_segments f ON f.meeting_id=m.id
             LEFT JOIN mvp_translations t ON t.meeting_id=m.id
             LEFT JOIN mvp_export_snapshots es ON es.meeting_id=m.id
             LEFT JOIN mvp_exports e ON e.snapshot_id=es.snapshot_id
             LEFT JOIN mvp_summary_jobs sj ON sj.meeting_id=m.id
             WHERE m.id=?1
             GROUP BY m.id",
            params![meeting_id],
            |row| {
                let final_count: i64 = row.get(1)?;
                let translation_count: i64 = row.get(2)?;
                let export_count: i64 = row.get(3)?;
                let summary_job_count: i64 = row.get(4)?;
                Ok(DeletePreview {
                    meeting_id: row.get(0)?,
                    final_count: usize::try_from(final_count).unwrap_or(0),
                    translation_count: usize::try_from(translation_count).unwrap_or(0),
                    export_count: usize::try_from(export_count).unwrap_or(0),
                    summary_job_count: usize::try_from(summary_job_count).unwrap_or(0),
                    tombstone_id: row.get(5)?,
                    deleted_at: row.get(6)?,
                })
            },
        )
        .optional()
        .map_err(|_| "MVP_STORAGE_DELETE_QUERY_FAILED".to_owned())?
        .ok_or_else(|| "MVP_STORAGE_MEETING_NOT_FOUND".to_owned())
}

fn delete_tombstone_by_meeting(
    connection: &Connection,
    meeting_id: &str,
) -> Result<DeleteTombstoneRecord, String> {
    delete_tombstone_by_meeting_optional(connection, meeting_id)?
        .ok_or_else(|| "MVP_STORAGE_DELETE_QUERY_FAILED".to_owned())
}

fn delete_tombstone_by_meeting_optional(
    connection: &Connection,
    meeting_id: &str,
) -> Result<Option<DeleteTombstoneRecord>, String> {
    connection
        .query_row(
            "SELECT tombstone_id, meeting_id, deleted_at, file_manifest_json, restored_at, purged_at
             FROM mvp_meeting_delete_tombstones
             WHERE meeting_id=?1
             ORDER BY deleted_at DESC
             LIMIT 1",
            params![meeting_id],
            delete_tombstone_from_row,
        )
        .optional()
        .map_err(|_| "MVP_STORAGE_DELETE_QUERY_FAILED".to_owned())
}

fn delete_tombstone_by_id(
    connection: &Connection,
    tombstone_id: &str,
) -> Result<DeleteTombstoneRecord, String> {
    delete_tombstone_by_id_optional(connection, tombstone_id)?
        .ok_or_else(|| "MVP_STORAGE_DELETE_QUERY_FAILED".to_owned())
}

fn delete_tombstone_by_id_optional(
    connection: &Connection,
    tombstone_id: &str,
) -> Result<Option<DeleteTombstoneRecord>, String> {
    connection
        .query_row(
            "SELECT tombstone_id, meeting_id, deleted_at, file_manifest_json, restored_at, purged_at
             FROM mvp_meeting_delete_tombstones
             WHERE tombstone_id=?1",
            params![tombstone_id],
            delete_tombstone_from_row,
        )
        .optional()
        .map_err(|_| "MVP_STORAGE_DELETE_QUERY_FAILED".to_owned())
}

fn delete_tombstone_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<DeleteTombstoneRecord> {
    Ok(DeleteTombstoneRecord {
        tombstone_id: row.get(0)?,
        meeting_id: row.get(1)?,
        deleted_at: row.get(2)?,
        file_manifest_json: row.get(3)?,
        restored_at: row.get(4)?,
        purged_at: row.get(5)?,
    })
}

fn search_segments_on_connection(
    connection: &Connection,
    query: SegmentSearchQuery,
    limit: usize,
) -> Result<SegmentSearchPage, String> {
    let scopes = if query.scopes.is_empty() {
        vec![
            "original".to_owned(),
            "translation".to_owned(),
            "summary".to_owned(),
        ]
    } else {
        query.scopes.clone()
    };
    let mut values = Vec::<Value>::new();
    let source_sql = search_source_sql(connection, query.text.as_deref(), &mut values)?;
    let mut sql = format!(
        "SELECT f.meeting_id, f.segment_id, CAST(f.sequence AS INTEGER),
                CAST(f.source_revision AS INTEGER), f.scope, f.text
         FROM ({source_sql}) f
         JOIN mvp_meetings m ON m.id=f.meeting_id
         WHERE m.deleted_at IS NULL"
    );
    sql.push_str(" AND f.scope IN (");
    for (index, scope) in scopes.iter().enumerate() {
        if index > 0 {
            sql.push(',');
        }
        sql.push('?');
        values.push(Value::Text(scope.clone()));
    }
    sql.push(')');
    if let Some(meeting_id) = query.meeting_id.as_deref() {
        sql.push_str(" AND f.meeting_id=?");
        values.push(Value::Text(meeting_id.to_owned()));
    }
    for tag_id in &query.tag_ids {
        sql.push_str(
            " AND EXISTS (
                SELECT 1 FROM mvp_meeting_tags mt
                JOIN mvp_tags tg ON tg.tag_id=mt.tag_id
                WHERE mt.meeting_id=f.meeting_id AND (mt.tag_id=? OR tg.name=?)
            )",
        );
        values.push(Value::Text(tag_id.clone()));
        values.push(Value::Text(tag_id.clone()));
    }
    let (cursor_meeting_id, cursor_sequence, cursor_scope) =
        parse_search_cursor(query.cursor.as_deref());
    sql.push_str(
        " AND (?='' OR f.meeting_id > ?
                OR (f.meeting_id=? AND CAST(f.sequence AS INTEGER) > ?)
                OR (f.meeting_id=? AND CAST(f.sequence AS INTEGER)=? AND f.scope > ?))
         ORDER BY f.meeting_id ASC, CAST(f.sequence AS INTEGER) ASC, f.scope ASC
         LIMIT ?",
    );
    values.push(Value::Text(cursor_meeting_id.to_owned()));
    values.push(Value::Text(cursor_meeting_id.to_owned()));
    values.push(Value::Text(cursor_meeting_id.to_owned()));
    values.push(Value::Integer(
        i64::try_from(cursor_sequence).unwrap_or(i64::MAX),
    ));
    values.push(Value::Text(cursor_meeting_id.to_owned()));
    values.push(Value::Integer(
        i64::try_from(cursor_sequence).unwrap_or(i64::MAX),
    ));
    values.push(Value::Text(cursor_scope.to_owned()));
    values.push(Value::Integer(i64::try_from(limit + 1).unwrap_or(i64::MAX)));
    let mut statement = connection
        .prepare(&sql)
        .map_err(|_| "MVP_STORAGE_SEARCH_QUERY_FAILED".to_owned())?;
    let rows = statement
        .query_map(params_from_iter(values), |row| {
            let sequence: i64 = row.get(2)?;
            let source_revision: i64 = row.get(3)?;
            Ok(SegmentSearchHit {
                meeting_id: row.get(0)?,
                segment_id: row.get(1)?,
                sequence: u64::try_from(sequence).unwrap_or(0),
                source_revision: u32::try_from(source_revision).unwrap_or(0),
                scope: row.get(4)?,
                text: row.get(5)?,
            })
        })
        .map_err(|_| "MVP_STORAGE_SEARCH_QUERY_FAILED".to_owned())?;
    let mut hits = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "MVP_STORAGE_SEARCH_QUERY_FAILED".to_owned())?;
    let next_cursor = if hits.len() > limit {
        hits.pop();
        hits.last()
            .map(|hit| format!("{}:{}:{}", hit.meeting_id, hit.sequence, hit.scope))
    } else {
        None
    };
    Ok(SegmentSearchPage { hits, next_cursor })
}

fn search_source_sql(
    connection: &Connection,
    text: Option<&str>,
    values: &mut Vec<Value>,
) -> Result<String, String> {
    let Some(text) = text.map(str::trim).filter(|text| !text.is_empty()) else {
        return Ok(
            "SELECT meeting_id, segment_id, sequence, source_revision, scope, text FROM mvp_search_fts"
                .to_owned(),
        );
    };
    let mut branches = Vec::from(["
        SELECT meeting_id, segment_id, sequence, source_revision, scope, text
        FROM mvp_search_fts
        WHERE mvp_search_fts MATCH ?
    "]);
    values.push(Value::Text(fts_match_query(text)?));
    if search_table_exists(connection, "mvp_search_trigram_fts")? && text.chars().count() >= 3 {
        branches.push(
            "
            SELECT meeting_id, segment_id, sequence, source_revision, scope, text
            FROM mvp_search_trigram_fts
            WHERE mvp_search_trigram_fts MATCH ?
        ",
        );
        values.push(Value::Text(fts_literal_query(text)));
    }
    if should_use_substring_fallback(text) {
        branches.push(
            "
            SELECT meeting_id, segment_id, sequence, source_revision, scope, text
            FROM mvp_search_fts
            WHERE text LIKE ? ESCAPE '\\'
        ",
        );
        values.push(Value::Text(like_pattern(text)));
    }
    Ok(branches.join(" UNION "))
}

fn search_table_exists(connection: &Connection, table: &str) -> Result<bool, String> {
    connection
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1",
            params![table],
            |_| Ok(()),
        )
        .optional()
        .map(|value| value.is_some())
        .map_err(|_| "MVP_STORAGE_SEARCH_QUERY_FAILED".to_owned())
}

fn fts_match_query(value: &str) -> Result<String, String> {
    let terms = value
        .split_whitespace()
        .map(|term| format!("\"{}\"*", term.replace('"', "\"\"")))
        .collect::<Vec<_>>();
    if terms.is_empty() {
        return Err("MVP_STORAGE_SEARCH_INVALID".to_owned());
    }
    Ok(terms.join(" AND "))
}

fn fts_literal_query(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

fn should_use_substring_fallback(value: &str) -> bool {
    value.chars().count() < 3 || value.chars().any(is_cjk_character)
}

fn is_cjk_character(character: char) -> bool {
    matches!(
        character as u32,
        0x3040..=0x30ff
            | 0x3400..=0x4dbf
            | 0x4e00..=0x9fff
            | 0xf900..=0xfaff
            | 0x20000..=0x2ebef
    )
}

fn like_pattern(value: &str) -> String {
    let mut pattern = String::from("%");
    for character in value.chars() {
        match character {
            '%' | '_' | '\\' => {
                pattern.push('\\');
                pattern.push(character);
            }
            _ => pattern.push(character),
        }
    }
    pattern.push('%');
    pattern
}

fn meeting_on_connection(
    connection: &Connection,
    meeting_id: &str,
) -> Result<Option<MeetingRecord>, String> {
    connection
        .query_row(
            "SELECT id, state, started_at, ended_at, last_final_sequence,
                    (
                        SELECT causation_id
                        FROM mvp_events
                        WHERE meeting_id=mvp_meetings.id
                          AND event_type='meeting.incomplete'
                        ORDER BY event_sequence DESC
                        LIMIT 1
                    )
             FROM mvp_meetings WHERE id=?1 AND deleted_at IS NULL",
            params![meeting_id],
            meeting_from_row,
        )
        .optional()
        .map_err(|_| "MVP_STORAGE_MEETING_QUERY_FAILED".to_owned())
}

fn snapshot_from_connection(
    connection: &Connection,
    meeting_id: &str,
) -> Result<MeetingSnapshot, String> {
    let tx = connection
        .unchecked_transaction()
        .map_err(|_| "MVP_STORAGE_TX_BEGIN_FAILED".to_owned())?;
    let snapshot = snapshot_from_transaction(&tx, meeting_id)?;
    tx.commit()
        .map_err(|_| "MVP_STORAGE_COMMIT_FAILED".to_owned())?;
    Ok(snapshot)
}

fn snapshot_from_transaction(
    tx: &Transaction<'_>,
    meeting_id: &str,
) -> Result<MeetingSnapshot, String> {
    let meeting = tx
        .query_row(
            "SELECT id, state, started_at, ended_at, last_final_sequence,
                    (
                        SELECT causation_id
                        FROM mvp_events
                        WHERE meeting_id=mvp_meetings.id
                          AND event_type='meeting.incomplete'
                        ORDER BY event_sequence DESC
                        LIMIT 1
                    )
             FROM mvp_meetings WHERE id=?1 AND deleted_at IS NULL",
            params![meeting_id],
            meeting_from_row,
        )
        .optional()
        .map_err(|_| "MVP_STORAGE_MEETING_QUERY_FAILED".to_owned())?
        .ok_or_else(|| "MVP_STORAGE_MEETING_NOT_FOUND".to_owned())?;
    let finals = select_finals(tx, meeting_id)?;
    let semantic_sha256 = semantic_digest(&meeting, &finals);
    let snapshot_generation = snapshot_generation(tx, meeting_id)?.saturating_add(1);
    let snapshot_id = sha256_hex(
        format!(
            "{}\n{}\n{}\n{}",
            meeting.id, meeting.state, snapshot_generation, semantic_sha256
        )
        .as_bytes(),
    );
    Ok(MeetingSnapshot {
        meeting,
        finals,
        snapshot_id,
        snapshot_generation,
        semantic_sha256,
    })
}

fn insert_event(
    tx: &Transaction<'_>,
    meeting_id: Option<&str>,
    event_type: &str,
    causation_id: &str,
    occurred_at: &str,
) -> Result<(), String> {
    let event_sequence: i64 = match meeting_id {
        Some(id) => tx
            .query_row(
                "SELECT COALESCE(MAX(event_sequence), 0) + 1 FROM mvp_events WHERE meeting_id=?1",
                params![id],
                |row| row.get(0),
            )
            .map_err(|_| "MVP_STORAGE_EVENT_QUERY_FAILED".to_owned())?,
        None => tx
            .query_row(
                "SELECT COALESCE(MAX(event_sequence), 0) + 1 FROM mvp_events WHERE meeting_id IS NULL",
                [],
                |row| row.get(0),
            )
            .map_err(|_| "MVP_STORAGE_EVENT_QUERY_FAILED".to_owned())?,
    };
    tx.execute(
        "INSERT INTO mvp_events(meeting_id, event_sequence, event_type, causation_id, occurred_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            meeting_id,
            event_sequence,
            event_type,
            causation_id,
            occurred_at
        ],
    )
    .map_err(|_| "MVP_STORAGE_EVENT_INSERT_FAILED".to_owned())?;
    if let Some(id) = meeting_id {
        tx.execute(
            "UPDATE mvp_meetings SET last_event_sequence=?2 WHERE id=?1",
            params![id, event_sequence],
        )
        .map_err(|_| "MVP_STORAGE_EVENT_UPDATE_FAILED".to_owned())?;
    }
    Ok(())
}

fn select_final_by_key(
    tx: &Transaction<'_>,
    meeting_id: &str,
    segment_id: &str,
    transcript_generation: u32,
    source_revision: u32,
) -> Result<Option<DurableFinal>, String> {
    tx.query_row(
        "SELECT f.meeting_id, f.segment_id, f.sequence, f.revision, f.text,
                f.started_at_ms, f.ended_at_ms, f.content_sha256, f.committed_at, f.commit_id,
                f.meeting_sample_start, f.meeting_sample_end, f.timeline_revision,
                COALESCE(t.status, 'disabled'), t.target_language, t.translated_text, t.error_code
         FROM mvp_final_segments f
         LEFT JOIN mvp_translations t
           ON t.meeting_id=f.meeting_id AND t.segment_id=f.segment_id
          AND t.source_revision=f.source_revision
         WHERE f.meeting_id=?1 AND f.segment_id=?2
           AND f.transcript_generation=?3 AND f.source_revision=?4",
        params![
            meeting_id,
            segment_id,
            i64::from(transcript_generation),
            i64::from(source_revision)
        ],
        durable_final_from_row,
    )
    .optional()
    .map_err(|_| "MVP_STORAGE_FINAL_QUERY_FAILED".to_owned())
}

fn select_final_by_sequence(
    tx: &Transaction<'_>,
    meeting_id: &str,
    sequence: u64,
) -> Result<Option<DurableFinal>, String> {
    tx.query_row(
        "SELECT f.meeting_id, f.segment_id, f.sequence, f.revision, f.text,
                f.started_at_ms, f.ended_at_ms, f.content_sha256, f.committed_at, f.commit_id,
                f.meeting_sample_start, f.meeting_sample_end, f.timeline_revision,
                COALESCE(t.status, 'disabled'), t.target_language, t.translated_text, t.error_code
         FROM mvp_final_segments f
         LEFT JOIN mvp_translations t
           ON t.meeting_id=f.meeting_id AND t.segment_id=f.segment_id
          AND t.source_revision=f.source_revision
         WHERE f.meeting_id=?1 AND f.sequence=?2",
        params![
            meeting_id,
            i64::try_from(sequence).map_err(|_| "MVP_STORAGE_SEQUENCE_OVERFLOW".to_owned())?
        ],
        durable_final_from_row,
    )
    .optional()
    .map_err(|_| "MVP_STORAGE_FINAL_QUERY_FAILED".to_owned())
}

fn select_finals(tx: &Transaction<'_>, meeting_id: &str) -> Result<Vec<DurableFinal>, String> {
    let mut statement = tx
        .prepare(
            "SELECT f.meeting_id, f.segment_id, f.sequence, f.revision, f.text,
                    f.started_at_ms, f.ended_at_ms, f.content_sha256, f.committed_at, f.commit_id,
                    f.meeting_sample_start, f.meeting_sample_end, f.timeline_revision,
                    COALESCE(t.status, 'disabled'), t.target_language,
                    t.translated_text, t.error_code
             FROM mvp_final_segments f
             LEFT JOIN mvp_translations t
               ON t.meeting_id=f.meeting_id AND t.segment_id=f.segment_id
              AND t.source_revision=f.source_revision
             WHERE f.meeting_id=?1
             ORDER BY f.sequence ASC",
        )
        .map_err(|_| "MVP_STORAGE_FINAL_QUERY_FAILED".to_owned())?;
    let rows = statement
        .query_map(params![meeting_id], durable_final_from_row)
        .map_err(|_| "MVP_STORAGE_FINAL_QUERY_FAILED".to_owned())?;
    let mut finals = Vec::new();
    for row in rows {
        finals.push(row.map_err(|_| "MVP_STORAGE_FINAL_QUERY_FAILED".to_owned())?);
    }
    Ok(finals)
}

fn snapshot_generation(tx: &Transaction<'_>, meeting_id: &str) -> Result<u64, String> {
    let generation: i64 = tx
        .query_row(
            "SELECT COALESCE(MAX(snapshot_generation), 0)
             FROM mvp_export_snapshots WHERE meeting_id=?1",
            params![meeting_id],
            |row| row.get(0),
        )
        .map_err(|_| "MVP_STORAGE_EXPORT_SNAPSHOT_QUERY_FAILED".to_owned())?;
    Ok(u64::try_from(generation).unwrap_or(0))
}

fn meeting_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<MeetingRecord> {
    let last: i64 = row.get(4)?;
    Ok(MeetingRecord {
        id: row.get(0)?,
        state: row.get(1)?,
        started_at: row.get(2)?,
        ended_at: row.get(3)?,
        last_final_sequence: u64::try_from(last).unwrap_or(0),
        completion_error: row.get(5)?,
    })
}

fn durable_final_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<DurableFinal> {
    let sequence: i64 = row.get(2)?;
    let revision: i64 = row.get(3)?;
    let meeting_sample_start: i64 = row.get(10)?;
    let meeting_sample_end: i64 = row.get(11)?;
    let timeline_revision: i64 = row.get(12)?;
    Ok(DurableFinal {
        meeting_id: row.get(0)?,
        segment_id: row.get(1)?,
        sequence: u64::try_from(sequence).unwrap_or(0),
        revision: u32::try_from(revision).unwrap_or(0),
        text: row.get(4)?,
        started_at_ms: row.get(5)?,
        ended_at_ms: row.get(6)?,
        content_sha256: row.get(7)?,
        committed_at: row.get(8)?,
        commit_id: row.get(9)?,
        meeting_sample_start: u64::try_from(meeting_sample_start).unwrap_or(0),
        meeting_sample_end: u64::try_from(meeting_sample_end).unwrap_or(0),
        timeline_revision: u32::try_from(timeline_revision).unwrap_or(1),
        translation_status: row.get(13)?,
        translation_target: row.get(14)?,
        translation_text: row.get(15)?,
        translation_error: row.get(16)?,
    })
}

fn default_data_root() -> Result<PathBuf, String> {
    if let Some(root) = env::var_os("MEETINGRELAY_MVP_DATA_DIR").map(PathBuf::from) {
        return Ok(root);
    }
    #[cfg(windows)]
    if let Some(local_app_data) = env::var_os("LOCALAPPDATA").map(PathBuf::from) {
        return Ok(local_app_data.join("MeetingRelay").join("mvp"));
    }
    env::current_dir()
        .map(|root| root.join("target").join("meetingrelay-mvp-data"))
        .map_err(|_| "MVP_STORAGE_ROOT_UNAVAILABLE".to_owned())
}

fn next_id(prefix: &str) -> String {
    static NEXT_ID_SEQUENCE: AtomicU64 = AtomicU64::new(1);
    let sequence = NEXT_ID_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    format!("{prefix}-{}-{sequence}", now_ms_string())
}

pub fn now_ms_string() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .to_string()
}

pub(crate) fn sanitize_diagnostic_value(value: &str) -> String {
    if value_contains_sensitive_marker(value) {
        return "[redacted]".to_owned();
    }
    let mut sanitized = String::with_capacity(value.len().min(128));
    for character in value.chars().take(128) {
        if character.is_ascii_alphanumeric() || matches!(character, '_' | '-' | '.' | ':' | '/') {
            sanitized.push(character);
        } else {
            sanitized.push('_');
        }
    }
    sanitized
}

#[allow(dead_code)]
fn value_contains_sensitive_marker(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    lower.contains("authorization")
        || lower.contains("bearer")
        || lower.contains("api_key")
        || lower.contains("apikey")
        || lower.contains("token")
        || lower.contains("secret")
        || lower.contains('@')
        || lower.contains('?')
}

pub fn semantic_digest(meeting: &MeetingRecord, finals: &[DurableFinal]) -> String {
    let mut material = format!(
        "{}\n{}\n{}\n{}\n{}\n",
        meeting.id,
        meeting.state,
        meeting.started_at,
        meeting.ended_at.as_deref().unwrap_or(""),
        meeting.completion_error.as_deref().unwrap_or("")
    );
    for final_segment in finals {
        material.push_str(&format!(
            "{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n",
            final_segment.sequence,
            final_segment.segment_id,
            final_segment.revision,
            final_segment.started_at_ms,
            final_segment.content_sha256,
            final_segment.translation_status,
            final_segment.translation_target.as_deref().unwrap_or(""),
            final_segment
                .translation_text
                .as_deref()
                .map(|text| sha256_hex(text.as_bytes()))
                .unwrap_or_default(),
            final_segment.translation_error.as_deref().unwrap_or("")
        ));
    }
    sha256_hex(material.as_bytes())
}

pub fn sha256_hex(input: &[u8]) -> String {
    let digest = sha256(input);
    let mut output = String::with_capacity(64);
    for byte in digest {
        output.push(hex_nibble(byte >> 4));
        output.push(hex_nibble(byte & 0x0f));
    }
    output
}

fn hex_nibble(value: u8) -> char {
    match value {
        0..=9 => (b'0' + value) as char,
        _ => (b'a' + (value - 10)) as char,
    }
}

fn sha256(input: &[u8]) -> [u8; 32] {
    const H0: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
        0x5be0cd19,
    ];
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];
    let bit_len = (input.len() as u64) * 8;
    let mut data = input.to_vec();
    data.push(0x80);
    while (data.len() % 64) != 56 {
        data.push(0);
    }
    data.extend_from_slice(&bit_len.to_be_bytes());

    let mut h = H0;
    for chunk in data.chunks_exact(64) {
        let mut w = [0_u32; 64];
        for (index, word) in w.iter_mut().take(16).enumerate() {
            let base = index * 4;
            *word = u32::from_be_bytes([
                chunk[base],
                chunk[base + 1],
                chunk[base + 2],
                chunk[base + 3],
            ]);
        }
        for index in 16..64 {
            let s0 = w[index - 15].rotate_right(7)
                ^ w[index - 15].rotate_right(18)
                ^ (w[index - 15] >> 3);
            let s1 = w[index - 2].rotate_right(17)
                ^ w[index - 2].rotate_right(19)
                ^ (w[index - 2] >> 10);
            w[index] = w[index - 16]
                .wrapping_add(s0)
                .wrapping_add(w[index - 7])
                .wrapping_add(s1);
        }
        let mut a = h[0];
        let mut b = h[1];
        let mut c = h[2];
        let mut d = h[3];
        let mut e = h[4];
        let mut f = h[5];
        let mut g = h[6];
        let mut hh = h[7];
        for index in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let temp1 = hh
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K[index])
                .wrapping_add(w[index]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let temp2 = s0.wrapping_add(maj);
            hh = g;
            g = f;
            f = e;
            e = d.wrapping_add(temp1);
            d = c;
            c = b;
            b = a;
            a = temp1.wrapping_add(temp2);
        }
        h[0] = h[0].wrapping_add(a);
        h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c);
        h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e);
        h[5] = h[5].wrapping_add(f);
        h[6] = h[6].wrapping_add(g);
        h[7] = h[7].wrapping_add(hh);
    }
    let mut output = [0_u8; 32];
    for (index, word) in h.into_iter().enumerate() {
        output[index * 4..index * 4 + 4].copy_from_slice(&word.to_be_bytes());
    }
    output
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::*;

    fn temp_db(test_name: &str) -> PathBuf {
        let root = env::temp_dir().join(format!("meetingrelay-{test_name}-{}", now_ms_string()));
        fs::create_dir_all(&root).unwrap();
        root.join("mvp.sqlite3")
    }

    fn candidate(meeting_id: &str, sequence: u64, text: &str) -> FinalCandidate {
        FinalCandidate {
            meeting_id: meeting_id.to_owned(),
            segment_id: format!("segment-{sequence}"),
            sequence,
            revision: 1,
            text: text.to_owned(),
            started_at_ms: (sequence * 10).to_string(),
            ended_at_ms: (sequence * 10 + 8).to_string(),
            meeting_sample_start: sequence.saturating_mul(160),
            meeting_sample_end: sequence.saturating_mul(160).saturating_add(128),
            timeline_revision: 1,
        }
    }

    fn storage_and_writer(test_name: &str) -> (MvpStorage, MvpStorageWriter) {
        let storage = MvpStorage::open_at(temp_db(test_name)).unwrap();
        let writer = MvpStorageWriter::start(storage.clone()).unwrap();
        (storage, writer)
    }

    #[test]
    fn sha256_matches_known_vector() {
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn migration_enables_wal_foreign_keys_full_sync_and_version_record() {
        let db = temp_db("migration");
        let connection = open_writer_connection(&db).unwrap();
        let journal: String = connection
            .pragma_query_value(None, "journal_mode", |row| row.get(0))
            .unwrap();
        let foreign_keys: i64 = connection
            .pragma_query_value(None, "foreign_keys", |row| row.get(0))
            .unwrap();
        let synchronous: i64 = connection
            .pragma_query_value(None, "synchronous", |row| row.get(0))
            .unwrap();
        let checksum: String = connection
            .query_row(
                "SELECT checksum FROM mvp_schema_migrations WHERE version=?1",
                params![MVP_SCHEMA_VERSION],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(journal.to_lowercase(), "wal");
        assert_eq!(foreign_keys, 1);
        assert_eq!(synchronous, 2);
        assert_eq!(checksum, MVP_SCHEMA_CHECKSUM);
    }

    #[test]
    fn existing_v1_database_migrates_in_place_to_translation_schema_v4() {
        let db = temp_db("migration-v1");
        let connection = open_writer_connection(&db).unwrap();
        connection
            .execute_batch(
                "DROP TABLE mvp_translations;
                 DELETE FROM mvp_schema_migrations WHERE version IN (4,5);
                 PRAGMA user_version = 1;",
            )
            .unwrap();
        connection
            .execute(
                "INSERT OR REPLACE INTO mvp_schema_migrations(version, checksum, applied_at)
                 VALUES (1, ?1, ?2)",
                params![MVP_SCHEMA_V1_CHECKSUM, now_ms_string()],
            )
            .unwrap();
        drop(connection);

        let migrated = open_writer_connection(&db).unwrap();
        assert_eq!(user_version(&migrated).unwrap(), 5);
        let translation_table: String = migrated
            .query_row(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='mvp_translations'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(translation_table, "mvp_translations");
        validate_schema_checksum(&migrated).unwrap();
    }

    #[test]
    fn existing_v2_database_migrates_to_attempt_schema_without_data_loss() {
        let db = temp_db("migration-v2");
        let storage = MvpStorage::open_at(&db).unwrap();
        let writer = MvpStorageWriter::start(storage.clone()).unwrap();
        let meeting = writer.start_meeting(true, "test model").unwrap();
        writer
            .commit_final(candidate(&meeting.id, 1, "v2 original"))
            .unwrap();
        let attempt = writer
            .begin_translation(TranslationCandidate::legacy(
                meeting.id.clone(),
                "segment-1".to_owned(),
                1,
                "ja".to_owned(),
                "legacy-model".to_owned(),
            ))
            .unwrap();
        writer
            .finish_translation(TranslationCompletion {
                meeting_id: meeting.id.clone(),
                segment_id: "segment-1".to_owned(),
                source_revision: 1,
                target_language: "ja".to_owned(),
                attempt: attempt.attempt,
                translated_text: Some("v2 translation".to_owned()),
                error_code: None,
                retryable: false,
                skipped_same_language: false,
            })
            .unwrap();
        drop(writer);
        let connection = Connection::open(&db).unwrap();
        connection
            .execute_batch(
                "DROP TABLE mvp_translation_attempts;
                 DROP TABLE mvp_recovery_actions;
                 DELETE FROM mvp_schema_migrations WHERE version IN (4,5);
                 PRAGMA user_version = 2;",
            )
            .unwrap();
        connection
            .execute(
                "INSERT OR REPLACE INTO mvp_schema_migrations(version, checksum, applied_at)
                 VALUES (2, ?1, ?2)",
                params![MVP_SCHEMA_V2_CHECKSUM, now_ms_string()],
            )
            .unwrap();
        drop(connection);

        let migrated = open_writer_connection(&db).unwrap();
        assert_eq!(user_version(&migrated).unwrap(), 5);
        let text: String = migrated
            .query_row("SELECT text FROM mvp_final_segments", [], |row| row.get(0))
            .unwrap();
        let translation: String = migrated
            .query_row("SELECT translated_text FROM mvp_translations", [], |row| {
                row.get(0)
            })
            .unwrap();
        let attempt_count: i64 = migrated
            .query_row("SELECT COUNT(*) FROM mvp_translation_attempts", [], |row| {
                row.get(0)
            })
            .unwrap();
        let sample_start: i64 = migrated
            .query_row(
                "SELECT meeting_sample_start FROM mvp_final_segments",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(text, "v2 original");
        assert_eq!(translation, "v2 translation");
        assert_eq!(attempt_count, 1);
        assert_eq!(sample_start, 160);
    }

    #[test]
    fn existing_v3_database_backfills_attempts_and_recovery_schema() {
        let db = temp_db("migration-v3");
        let storage = MvpStorage::open_at(&db).unwrap();
        let writer = MvpStorageWriter::start(storage.clone()).unwrap();
        let meeting = writer.start_meeting(true, "test model").unwrap();
        writer
            .commit_final(candidate(&meeting.id, 1, "v3 original"))
            .unwrap();
        let attempt = writer
            .begin_translation(TranslationCandidate::legacy(
                meeting.id.clone(),
                "segment-1".to_owned(),
                1,
                "en".to_owned(),
                "legacy-model".to_owned(),
            ))
            .unwrap();
        writer
            .finish_translation(TranslationCompletion {
                meeting_id: meeting.id,
                segment_id: "segment-1".to_owned(),
                source_revision: 1,
                target_language: "en".to_owned(),
                attempt: attempt.attempt,
                translated_text: None,
                error_code: None,
                retryable: false,
                skipped_same_language: true,
            })
            .unwrap();
        drop(writer);
        let connection = Connection::open(&db).unwrap();
        connection
            .execute_batch(
                "DROP TABLE mvp_translation_attempts;
                 DROP TABLE mvp_recovery_actions;
                 DELETE FROM mvp_schema_migrations WHERE version IN (4,5);
                 PRAGMA user_version = 3;",
            )
            .unwrap();
        connection
            .execute(
                "INSERT OR REPLACE INTO mvp_schema_migrations(version, checksum, applied_at)
                 VALUES (3, ?1, ?2)",
                params![MVP_SCHEMA_V3_CHECKSUM, now_ms_string()],
            )
            .unwrap();
        drop(connection);

        let migrated = open_writer_connection(&db).unwrap();
        let status: String = migrated
            .query_row("SELECT status FROM mvp_translation_attempts", [], |row| {
                row.get(0)
            })
            .unwrap();
        let recovery_table: String = migrated
            .query_row(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='mvp_recovery_actions'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(user_version(&migrated).unwrap(), 5);
        assert_eq!(status, "skipped");
        assert_eq!(recovery_table, "mvp_recovery_actions");
    }

    #[test]
    fn checksum_tamper_fails_closed() {
        let db = temp_db("checksum-tamper");
        drop(open_writer_connection(&db).unwrap());
        let connection = Connection::open(&db).unwrap();
        connection
            .execute(
                "UPDATE mvp_schema_migrations SET checksum='tampered' WHERE version=?1",
                params![MVP_SCHEMA_VERSION],
            )
            .unwrap();
        assert_eq!(
            open_writer_connection(&db).unwrap_err(),
            "MVP_STORAGE_SCHEMA_CHECKSUM_MISMATCH"
        );
    }

    #[test]
    fn newer_schema_is_rejected_without_wal_or_user_version_mutation() {
        let db = temp_db("newer-schema");
        let connection = Connection::open(&db).unwrap();
        connection.pragma_update(None, "user_version", 99).unwrap();
        drop(connection);
        assert_eq!(
            open_writer_connection(&db).unwrap_err(),
            "MVP_STORAGE_SCHEMA_TOO_NEW"
        );
        let reopened = Connection::open(&db).unwrap();
        let user_version: i64 = reopened
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        let tables: i64 = reopened
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name LIKE 'mvp_%'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let journal: String = reopened
            .pragma_query_value(None, "journal_mode", |row| row.get(0))
            .unwrap();
        assert_eq!(user_version, 99);
        assert_eq!(tables, 0);
        assert_ne!(journal.to_lowercase(), "wal");
    }

    #[test]
    fn next_id_is_unique_within_process_even_in_same_millisecond_window() {
        let ids = (0..10_000)
            .map(|_| next_id("meeting"))
            .collect::<HashSet<_>>();
        assert_eq!(ids.len(), 10_000);
    }

    #[test]
    fn final_commit_ack_is_durable_and_interim_never_enters_storage() {
        let (storage, writer) = storage_and_writer("commit");
        let meeting = writer.start_meeting(true, "test model").unwrap();
        let ack = writer
            .commit_final(candidate(&meeting.id, 1, "saved final"))
            .unwrap();
        assert!(!ack.duplicate);
        assert_eq!(ack.final_segment.sequence, 1);
        assert_eq!(ack.final_segment.text, "saved final");
        let snapshot = storage.snapshot(&meeting.id).unwrap();
        assert_eq!(snapshot.finals.len(), 1);
        assert_eq!(snapshot.finals[0].commit_id, ack.final_segment.commit_id);
        let connection = Connection::open(storage.db_path).unwrap();
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM mvp_final_segments", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn translation_status_and_text_are_durable_without_replacing_the_original() {
        let (storage, writer) = storage_and_writer("translation");
        let meeting = writer.start_meeting(true, "test model").unwrap();
        writer
            .commit_final(candidate(&meeting.id, 1, "original text"))
            .unwrap();
        let attempt = writer
            .begin_translation(TranslationCandidate {
                meeting_id: meeting.id.clone(),
                segment_id: "segment-1".to_owned(),
                source_revision: 1,
                target_language: "ja".to_owned(),
                model: "local-translator".to_owned(),
                provider: "test-provider".to_owned(),
                config_version: "test-config-v1".to_owned(),
                endpoint_origin: Some("https://api.example.com".to_owned()),
                endpoint_hash: "a".repeat(64),
                prompt_version: "test-prompt-v1".to_owned(),
                request_schema_version: "test-request-v1".to_owned(),
            })
            .unwrap();
        assert_eq!(attempt.attempt, 1);
        let pending = storage.snapshot(&meeting.id).unwrap();
        assert_eq!(pending.finals[0].text, "original text");
        assert_eq!(pending.finals[0].translation_status, "pending");
        writer
            .finish_translation(TranslationCompletion {
                meeting_id: meeting.id.clone(),
                segment_id: "segment-1".to_owned(),
                source_revision: 1,
                target_language: "ja".to_owned(),
                attempt: attempt.attempt,
                translated_text: Some("翻訳済み".to_owned()),
                error_code: None,
                retryable: false,
                skipped_same_language: false,
            })
            .unwrap();
        let completed = storage.snapshot(&meeting.id).unwrap();
        assert_eq!(completed.finals[0].text, "original text");
        assert_eq!(completed.finals[0].translation_status, "completed");
        assert_eq!(
            completed.finals[0].translation_text.as_deref(),
            Some("翻訳済み")
        );
        assert_ne!(pending.semantic_sha256, completed.semantic_sha256);

        let skipped_attempt = writer
            .begin_translation(TranslationCandidate::legacy(
                meeting.id.clone(),
                "segment-1".to_owned(),
                1,
                "en".to_owned(),
                "same-language-pass-through".to_owned(),
            ))
            .unwrap();
        writer
            .finish_translation(TranslationCompletion {
                meeting_id: meeting.id.clone(),
                segment_id: "segment-1".to_owned(),
                source_revision: 1,
                target_language: "en".to_owned(),
                attempt: skipped_attempt.attempt,
                translated_text: None,
                error_code: None,
                retryable: false,
                skipped_same_language: true,
            })
            .unwrap();
        let skipped = storage.snapshot(&meeting.id).unwrap();
        assert_eq!(skipped.finals[0].translation_status, "skipped");
        assert_eq!(skipped.finals[0].translation_target.as_deref(), Some("en"));
        assert!(skipped.finals[0].translation_text.is_none());
    }

    #[test]
    fn translation_attempts_are_append_only_and_failed_retry_plan_is_gated() {
        let (storage, writer) = storage_and_writer("translation-attempts");
        let meeting = writer.start_meeting(true, "test model").unwrap();
        writer
            .commit_final(candidate(&meeting.id, 1, "retry original"))
            .unwrap();
        let first = writer
            .begin_translation(TranslationCandidate::legacy(
                meeting.id.clone(),
                "segment-1".to_owned(),
                1,
                "ja".to_owned(),
                "model-a".to_owned(),
            ))
            .unwrap();
        writer
            .finish_translation(TranslationCompletion {
                meeting_id: meeting.id.clone(),
                segment_id: "segment-1".to_owned(),
                source_revision: 1,
                target_language: "ja".to_owned(),
                attempt: first.attempt,
                translated_text: None,
                error_code: Some("TRANSLATION_HTTP_STATUS_429".to_owned()),
                retryable: true,
                skipped_same_language: false,
            })
            .unwrap();
        assert_eq!(
            storage
                .failed_translation_retry_plan(&meeting.id, false)
                .unwrap_err(),
            "TRANSLATION_RETRY_COST_CONFIRMATION_REQUIRED"
        );
        let plan = storage
            .failed_translation_retry_plan(&meeting.id, true)
            .unwrap();
        assert_eq!(plan.total, 1);
        assert_eq!(plan.retryable, 1);
        assert_eq!(plan.items[0].last_attempt, 1);

        let second = writer
            .begin_translation(TranslationCandidate::legacy(
                meeting.id.clone(),
                "segment-1".to_owned(),
                1,
                "ja".to_owned(),
                "model-a".to_owned(),
            ))
            .unwrap();
        assert_eq!(second.attempt, 2);
        writer
            .finish_translation(TranslationCompletion {
                meeting_id: meeting.id.clone(),
                segment_id: "segment-1".to_owned(),
                source_revision: 1,
                target_language: "ja".to_owned(),
                attempt: second.attempt,
                translated_text: Some("retried translation".to_owned()),
                error_code: None,
                retryable: false,
                skipped_same_language: false,
            })
            .unwrap();
        let snapshot = storage.snapshot(&meeting.id).unwrap();
        assert_eq!(snapshot.finals[0].text, "retry original");
        assert_eq!(
            snapshot.finals[0].translation_text.as_deref(),
            Some("retried translation")
        );
        let connection = Connection::open(storage.db_path).unwrap();
        let attempts: i64 = connection
            .query_row("SELECT COUNT(*) FROM mvp_translation_attempts", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(attempts, 2);
        let first_error: String = connection
            .query_row(
                "SELECT error_code FROM mvp_translation_attempts WHERE attempt=1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(first_error, "TRANSLATION_HTTP_STATUS_429");
    }

    #[test]
    fn disk_and_diagnostics_helpers_are_injectable_and_redacted() {
        let ok = disk_preflight_with(|| Ok(())).unwrap();
        assert_eq!(ok.code, "MVP_DISK_OK");
        assert!(!ok.interrupted_only);
        let full = disk_preflight_with(|| Err(io::Error::from_raw_os_error(112))).unwrap_err();
        assert_eq!(full.code, "MVP_DISK_FULL");
        assert!(full.interrupted_only);

        let bundle = sanitized_diagnostic_bundle(
            Some("SenseVoice local CPU"),
            &["openai-compatible:token=secret"],
            1,
            2,
            Some("MVP_DISK_FULL"),
            &["Authorization: Bearer abc"],
        );
        assert_eq!(bundle.provider_versions[0], "[redacted]");
        assert_eq!(bundle.error_codes[0], "[redacted]");
        assert_eq!(bundle.disk_code.as_deref(), Some("MVP_DISK_FULL"));
    }

    #[test]
    fn recovery_action_finalize_is_idempotent_and_writes_no_final() {
        let (storage, writer) = storage_and_writer("recovery-action");
        let meeting = writer.start_meeting(true, "test model").unwrap();
        writer.interrupt_meeting(&meeting.id).unwrap();
        let first = writer
            .record_recovery_action(&meeting.id, RecoveryActionKind::Finalize)
            .unwrap();
        let second = writer
            .record_recovery_action(&meeting.id, RecoveryActionKind::Finalize)
            .unwrap();
        assert_eq!(first.action_id, second.action_id);
        let snapshot = storage.snapshot(&meeting.id).unwrap();
        assert_eq!(snapshot.meeting.state, "completed");
        assert!(snapshot.finals.is_empty());
    }

    #[test]
    fn duplicate_final_is_idempotent_but_conflicting_duplicate_fails_closed() {
        let (storage, writer) = storage_and_writer("duplicate");
        let meeting = writer.start_meeting(true, "test model").unwrap();
        let first = candidate(&meeting.id, 1, "same");
        let ack = writer.commit_final(first.clone()).unwrap();
        let duplicate = writer.commit_final(first).unwrap();
        assert_eq!(
            ack.final_segment.commit_id,
            duplicate.final_segment.commit_id
        );
        assert!(duplicate.duplicate);

        let mut conflict = candidate(&meeting.id, 1, "different");
        conflict.segment_id = "segment-1".to_owned();
        assert_eq!(
            writer.commit_final(conflict).unwrap_err(),
            "MVP_STORAGE_DUPLICATE_FINAL_CONFLICT"
        );
        assert_eq!(storage.snapshot(&meeting.id).unwrap().finals.len(), 1);
    }

    #[test]
    fn reorder_or_gap_is_rejected_without_public_durable_row() {
        let (storage, writer) = storage_and_writer("reorder");
        let meeting = writer.start_meeting(true, "test model").unwrap();
        assert_eq!(
            writer
                .commit_final(candidate(&meeting.id, 2, "out of order"))
                .unwrap_err(),
            "MVP_STORAGE_FINAL_SEQUENCE_GAP_OR_REORDER"
        );
        assert!(storage.snapshot(&meeting.id).unwrap().finals.is_empty());
    }

    #[test]
    fn recovery_marks_recording_meetings_interrupted_and_reopens_exact_once() {
        let db = temp_db("recovery");
        let storage = MvpStorage::open_at(&db).unwrap();
        let writer = MvpStorageWriter::start(storage.clone()).unwrap();
        let meeting = writer.start_meeting(true, "test model").unwrap();
        writer
            .commit_final(candidate(&meeting.id, 1, "survives"))
            .unwrap();
        drop(writer);

        let reopened = MvpStorage::open_at(&db).unwrap();
        let reopened_writer = MvpStorageWriter::start(reopened.clone()).unwrap();
        assert_eq!(reopened_writer.recover_interrupted().unwrap(), 1);
        let snapshot = reopened_writer.open_meeting(&meeting.id).unwrap();
        assert_eq!(snapshot.meeting.state, "interrupted");
        assert_eq!(snapshot.finals.len(), 1);
        assert_eq!(snapshot.finals[0].text, "survives");
    }

    #[test]
    fn incomplete_meeting_persists_the_data_loss_reason() {
        let (storage, writer) = storage_and_writer("incomplete-meeting");
        let meeting = writer.start_meeting(true, "test model").unwrap();
        let incomplete = writer
            .incomplete_meeting(&meeting.id, "ASR_FINAL_OVERLOAD")
            .unwrap();
        assert_eq!(incomplete.state, "interrupted");
        assert_eq!(
            incomplete.completion_error.as_deref(),
            Some("ASR_FINAL_OVERLOAD")
        );
        drop(writer);

        let reopened = storage.snapshot(&meeting.id).unwrap();
        assert_eq!(reopened.meeting.state, "interrupted");
        assert_eq!(
            reopened.meeting.completion_error.as_deref(),
            Some("ASR_FINAL_OVERLOAD")
        );
        assert_eq!(
            storage
                .recent_meeting()
                .unwrap()
                .unwrap()
                .completion_error
                .as_deref(),
            Some("ASR_FINAL_OVERLOAD")
        );
    }

    #[test]
    fn visible_window_is_bounded_but_database_retains_all_finals() {
        let (storage, writer) = storage_and_writer("overflow");
        let meeting = writer.start_meeting(true, "test model").unwrap();
        for sequence in 1..=70 {
            writer
                .commit_final(candidate(
                    &meeting.id,
                    sequence,
                    &format!("final {sequence}"),
                ))
                .unwrap();
        }
        let snapshot = storage.snapshot(&meeting.id).unwrap();
        assert_eq!(snapshot.finals.len(), 70);
        let visible = snapshot
            .finals
            .iter()
            .rev()
            .take(MAX_FINAL_SEGMENTS)
            .map(segment_from_durable)
            .collect::<Vec<_>>();
        assert_eq!(visible.len(), MAX_FINAL_SEGMENTS);
        assert_eq!(visible_window_start_sequence(snapshot.finals.len()), "7");
    }

    #[test]
    fn writer_commits_through_bounded_single_owner_queue() {
        let (storage, writer) = storage_and_writer("writer");
        let meeting = writer.start_meeting(true, "test model").unwrap();
        let ack = writer
            .commit_final(candidate(&meeting.id, 1, "writer final"))
            .unwrap();
        assert_eq!(ack.final_segment.text, "writer final");
        assert_eq!(storage.snapshot(&meeting.id).unwrap().finals.len(), 1);
    }

    #[test]
    fn export_record_batch_failure_rolls_back_snapshot_and_exports() {
        let (storage, writer) = storage_and_writer("export-record-rollback");
        let meeting = writer.start_meeting(true, "test model").unwrap();
        writer
            .commit_final(candidate(&meeting.id, 1, "exported"))
            .unwrap();
        writer.complete_meeting(&meeting.id).unwrap();
        let snapshot = storage.snapshot(&meeting.id).unwrap();
        let export = CompletedExport {
            export_id: "duplicate-export-id".to_owned(),
            format: "json".to_owned(),
            target_path: PathBuf::from("export.json"),
            byte_length: 2,
            sha256: sha256_hex(b"{}"),
            completed_at: now_ms_string(),
            validation_manifest_json: "{}".to_owned(),
        };
        assert_eq!(
            writer
                .record_export_snapshot(snapshot.clone(), vec![export.clone(), export])
                .unwrap_err(),
            "MVP_STORAGE_EXPORT_RECORD_FAILED"
        );
        let connection = Connection::open(storage.db_path).unwrap();
        let snapshots: i64 = connection
            .query_row("SELECT COUNT(*) FROM mvp_export_snapshots", [], |row| {
                row.get(0)
            })
            .unwrap();
        let exports: i64 = connection
            .query_row("SELECT COUNT(*) FROM mvp_exports", [], |row| row.get(0))
            .unwrap();
        assert_eq!(snapshots, 0);
        assert_eq!(exports, 0);
    }

    #[test]
    fn full_queue_shutdown_is_bounded_and_never_requires_shutdown_enqueue() {
        let (_storage, mut writer) = storage_and_writer("full-queue-shutdown");
        let release = writer.block_for_test();
        for _ in 0..STORAGE_QUEUE_DEPTH {
            writer.try_enqueue_noop_for_test().unwrap();
        }
        assert_eq!(
            writer.try_enqueue_noop_for_test().unwrap_err(),
            "MVP_STORAGE_QUEUE_FULL"
        );
        assert_eq!(
            writer
                .shutdown_before(Duration::from_millis(25))
                .unwrap_err(),
            "MVP_STORAGE_WRITER_SHUTDOWN_TIMEOUT"
        );
        release.send(()).unwrap();
        assert_eq!(writer.shutdown_before(Duration::from_secs(1)), Ok(()));
    }

    #[test]
    fn synthetic_thousand_final_run_reports_exact_once_and_p95() {
        let (storage, writer) = storage_and_writer("synthetic");
        let meeting = writer.start_meeting(true, "test model").unwrap();
        let metrics = writer.synthetic_commit_metrics(&meeting.id, 1_000).unwrap();
        let snapshot = storage.snapshot(&meeting.id).unwrap();
        assert_eq!(metrics.committed, 1_000);
        assert_eq!(metrics.duplicate, 0);
        assert_eq!(metrics.rejected, 0);
        assert_eq!(snapshot.finals.len(), 1_000);
        assert!(metrics.p95_micros > 0);
    }

    fn provider_input(
        profile_id: Option<String>,
        label: &str,
        version: u32,
    ) -> ProviderProfileInput {
        ProviderProfileInput {
            profile_id,
            label: label.to_owned(),
            provider_class: "cloud".to_owned(),
            base_url: Some("https://api.example.com".to_owned()),
            model: "summary-model".to_owned(),
            endpoint_hash: "b".repeat(64),
            data_flow: "cloud summary processing".to_owned(),
            policy_url: Some("https://example.com/policy".to_owned()),
            config_version: version,
            secret_state: "configured".to_owned(),
            last_test_at: Some(now_ms_string()),
            last_test_status: Some("ok".to_owned()),
            last_error: None,
        }
    }

    #[test]
    fn bundled_sqlite_supports_fts5_for_meeting_search() {
        let connection = Connection::open_in_memory().unwrap();
        let enabled: i64 = connection
            .query_row(
                "SELECT sqlite_compileoption_used('ENABLE_FTS5')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(enabled, 1);
    }

    #[test]
    fn provider_profiles_seed_defaults_and_keep_version_history() {
        let (storage, writer) = storage_and_writer("provider-profile-history");
        let defaults = storage.provider_profiles_latest().unwrap();
        assert!(
            defaults
                .iter()
                .any(|profile| profile.profile_id == "provider-local-default")
        );
        assert!(
            defaults
                .iter()
                .any(|profile| profile.provider_class == "lan")
        );
        assert!(
            defaults
                .iter()
                .any(|profile| profile.provider_class == "cloud")
        );

        let first = writer
            .save_provider_profile(provider_input(None, "Cloud custom", 1))
            .unwrap();
        let second = writer
            .save_provider_profile(provider_input(
                Some(first.profile_id.clone()),
                "Cloud custom",
                2,
            ))
            .unwrap();
        assert_eq!(second.version, first.version + 1);
        assert_eq!(
            storage
                .provider_profile_latest(&first.profile_id)
                .unwrap()
                .unwrap()
                .config_version,
            2
        );
        assert_eq!(
            storage
                .provider_profile_history(&first.profile_id)
                .unwrap()
                .len(),
            2
        );
    }

    #[test]
    fn meeting_tags_replace_by_name_survives_restart() {
        let db = temp_db("tag-restart");
        let storage = MvpStorage::open_at(&db).unwrap();
        let writer = MvpStorageWriter::start(storage.clone()).unwrap();
        let meeting = writer.start_meeting(true, "test model").unwrap();
        let tags = writer
            .replace_meeting_tags(&meeting.id, vec!["urgent".to_owned(), "sales".to_owned()])
            .unwrap();
        assert_eq!(tags.len(), 2);
        drop(writer);

        let reopened = MvpStorage::open_at(&db).unwrap();
        let page = reopened.meeting_library_page(None, 10).unwrap();
        assert_eq!(page.items[0].tags.len(), 2);
        assert!(page.items[0].tags.iter().any(|tag| tag.name == "urgent"));
    }

    #[test]
    fn summary_jobs_are_append_only_and_cancelled_with_progress() {
        let (storage, writer) = storage_and_writer("summary-append-cancel");
        let meeting = writer.start_meeting(true, "test model").unwrap();
        writer
            .commit_final(candidate(&meeting.id, 1, "summary source"))
            .unwrap();
        let job = writer
            .start_summary_job(SummaryJobInput {
                meeting_id: meeting.id.clone(),
                provider_profile_id: None,
                prompt_version: "summary.prompt.v1".to_owned(),
                request_schema_version: "summary.request.v1".to_owned(),
            })
            .unwrap();
        writer
            .append_summary_chunk(SummaryChunkInput {
                job_id: job.job_id.clone(),
                chunk_index: 1,
                source_segment_ids: vec!["segment-1".to_owned()],
                text: "chunk text".to_owned(),
            })
            .unwrap();
        writer
            .append_summary_result(SummaryResultInput {
                job_id: job.job_id.clone(),
                section_kind: "overview".to_owned(),
                section_index: 1,
                heading: "Overview".to_owned(),
                text: "summary result".to_owned(),
                citation_segment_ids: vec!["segment-1".to_owned()],
            })
            .unwrap();
        let cancelled = writer.cancel_summary_job(&job.job_id).unwrap();
        assert_eq!(cancelled.status, "cancelled");
        assert!(
            writer
                .append_summary_chunk(SummaryChunkInput {
                    job_id: job.job_id.clone(),
                    chunk_index: 2,
                    source_segment_ids: vec!["segment-1".to_owned()],
                    text: "late chunk".to_owned(),
                })
                .is_err()
        );
        let progress = storage.summary_progress(&job.job_id).unwrap().unwrap();
        assert_eq!(progress.chunk_count, 1);
        assert_eq!(progress.result_count, 1);
        assert_eq!(
            storage.summary_results(&job.job_id).unwrap()[0].citation_segment_ids[0],
            "segment-1"
        );
    }

    #[test]
    fn summary_job_for_meeting_version_selects_exact_attempt() {
        let (storage, writer) = storage_and_writer("summary-version-read");
        let meeting = writer.start_meeting(true, "test model").unwrap();
        writer
            .commit_final(candidate(&meeting.id, 1, "summary source"))
            .unwrap();
        let first = writer
            .start_summary_job(SummaryJobInput {
                meeting_id: meeting.id.clone(),
                provider_profile_id: None,
                prompt_version: "summary.prompt.v1".to_owned(),
                request_schema_version: "summary.request.v1".to_owned(),
            })
            .unwrap();
        writer
            .fail_summary_job(&first.job_id, "MVP_SUMMARY_PROVIDER_FAILED", true)
            .unwrap();
        let second = writer
            .retry_summary_job(
                &first.job_id,
                SummaryJobInput {
                    meeting_id: meeting.id.clone(),
                    provider_profile_id: None,
                    prompt_version: "summary.prompt.v1".to_owned(),
                    request_schema_version: "summary.request.v1".to_owned(),
                },
            )
            .unwrap();

        assert_eq!(
            storage
                .summary_job_for_meeting_version(&meeting.id, 1)
                .unwrap()
                .unwrap()
                .job_id,
            first.job_id
        );
        assert_eq!(
            storage
                .summary_job_for_meeting_version(&meeting.id, 2)
                .unwrap()
                .unwrap()
                .job_id,
            second.job_id
        );
        assert!(
            storage
                .summary_job_for_meeting_version(&meeting.id, 3)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn delete_preview_soft_delete_restore_and_purge_metadata() {
        let (storage, writer) = storage_and_writer("delete-restore");
        let meeting = writer.start_meeting(true, "test model").unwrap();
        writer
            .commit_final(candidate(&meeting.id, 1, "delete me"))
            .unwrap();
        let preview = storage.delete_preview(&meeting.id).unwrap();
        assert_eq!(preview.final_count, 1);
        let tombstone = writer
            .soft_delete_meeting(&meeting.id, "{\"files\":[]}")
            .unwrap();
        assert!(storage.snapshot(&meeting.id).is_err());
        assert_eq!(
            storage
                .tombstone_by_id(&tombstone.tombstone_id)
                .unwrap()
                .unwrap()
                .meeting_id,
            meeting.id
        );
        let restored = writer.restore_meeting(&meeting.id).unwrap();
        assert!(restored.restored_at.is_some());
        assert!(storage.snapshot(&meeting.id).is_ok());
        writer
            .soft_delete_meeting(&meeting.id, "{\"files\":[]}")
            .unwrap();
        let purged = writer.purge_meeting_metadata(&meeting.id).unwrap();
        assert!(purged.purged_at.is_some());
    }

    #[test]
    fn purge_removes_meeting_and_sensitive_sqlite_content() {
        let db = temp_db("purge-content");
        let storage = MvpStorage::open_at(&db).unwrap();
        let writer = MvpStorageWriter::start(storage.clone()).unwrap();
        let meeting = writer.start_meeting(true, "test model").unwrap();
        writer
            .commit_final(candidate(&meeting.id, 1, "机密原文alpha"))
            .unwrap();
        let attempt = writer
            .begin_translation(TranslationCandidate::legacy(
                meeting.id.clone(),
                "segment-1".to_owned(),
                1,
                "ja".to_owned(),
                "translation-model".to_owned(),
            ))
            .unwrap();
        writer
            .finish_translation(TranslationCompletion {
                meeting_id: meeting.id.clone(),
                segment_id: "segment-1".to_owned(),
                source_revision: 1,
                target_language: "ja".to_owned(),
                attempt: attempt.attempt,
                translated_text: Some("機密翻訳beta".to_owned()),
                error_code: None,
                retryable: false,
                skipped_same_language: false,
            })
            .unwrap();
        let job = writer
            .start_summary_job(SummaryJobInput {
                meeting_id: meeting.id.clone(),
                provider_profile_id: None,
                prompt_version: "summary.prompt.v1".to_owned(),
                request_schema_version: "summary.request.v1".to_owned(),
            })
            .unwrap();
        writer
            .append_summary_chunk(SummaryChunkInput {
                job_id: job.job_id.clone(),
                chunk_index: 1,
                source_segment_ids: vec!["segment-1".to_owned()],
                text: "机密摘要chunk".to_owned(),
            })
            .unwrap();
        writer
            .append_summary_result(SummaryResultInput {
                job_id: job.job_id,
                section_kind: "overview".to_owned(),
                section_index: 1,
                heading: "Overview".to_owned(),
                text: "机密摘要gamma".to_owned(),
                citation_segment_ids: vec!["segment-1".to_owned()],
            })
            .unwrap();
        let snapshot = storage.snapshot(&meeting.id).unwrap();
        writer
            .record_export_snapshot(
                snapshot,
                vec![CompletedExport {
                    export_id: "export-purge".to_owned(),
                    format: "json".to_owned(),
                    target_path: PathBuf::from("purge.json"),
                    byte_length: 2,
                    sha256: sha256_hex(b"{}"),
                    completed_at: now_ms_string(),
                    validation_manifest_json: "{}".to_owned(),
                }],
            )
            .unwrap();
        writer
            .replace_meeting_tags(&meeting.id, vec!["purge-tag".to_owned()])
            .unwrap();
        writer
            .soft_delete_meeting(&meeting.id, "{\"files\":[]}")
            .unwrap();
        let purged = writer.purge_meeting_metadata(&meeting.id).unwrap();
        assert_eq!(purged.meeting_id, meeting.id);
        assert!(purged.purged_at.is_some());
        drop(writer);

        let connection = Connection::open(&db).unwrap();
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM mvp_meetings WHERE id=?1",
                    params![meeting.id],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
        for needle in [
            "机密原文alpha",
            "機密翻訳beta",
            "机密摘要chunk",
            "机密摘要gamma",
        ] {
            let leaked_tables = content_tables_containing(&connection, needle);
            assert!(
                leaked_tables.is_empty(),
                "{needle} still present in {leaked_tables:?}"
            );
        }
    }

    #[test]
    fn ten_thousand_meeting_library_and_search_stay_bounded() {
        let db = temp_db("library-10k");
        let mut connection = open_writer_connection(&db).unwrap();
        let tx = connection.transaction().unwrap();
        for index in 0..10_000 {
            let meeting_id = format!("meeting-{index:05}");
            let started_at = (1_000_000 + index).to_string();
            let text = if index == 9_876 {
                "bounded-search-needle exact target".to_owned()
            } else {
                format!("ordinary transcript {index}")
            };
            tx.execute(
                "INSERT INTO mvp_meetings (
                    id, schema_version, state, started_at, ended_at, last_opened_at,
                    state_version, last_final_sequence, last_event_sequence,
                    consent_accepted, model_label, app_contract_version, title, language
                 ) VALUES (?1, ?2, 'completed', ?3, ?3, ?3, 1, 1, 0, 1, 'model', ?4, ?5, 'en')",
                params![
                    meeting_id,
                    MVP_SCHEMA_VERSION,
                    started_at,
                    MVP_CONTRACT_VERSION,
                    format!("Meeting {index}")
                ],
            )
            .unwrap();
            tx.execute(
                "INSERT INTO mvp_final_segments (
                    meeting_id, segment_id, sequence, revision, transcript_generation,
                    source_revision, text, started_at_ms, ended_at_ms, content_sha256,
                    committed_at, commit_id, meeting_sample_start, meeting_sample_end,
                    timeline_revision
                 ) VALUES (?1, 'segment-1', 1, 1, 1, 1, ?2, '0', '1000', ?3, ?4, ?5, 0, 16000, 1)",
                params![
                    format!("meeting-{index:05}"),
                    text,
                    sha256_hex(text.as_bytes()),
                    (1_000_000 + index).to_string(),
                    format!("commit-{index:05}")
                ],
            )
            .unwrap();
        }
        tx.commit().unwrap();
        let storage = MvpStorage::open_at(&db).unwrap();
        let first = storage.meeting_library_page(None, 100).unwrap();
        assert_eq!(first.items.len(), 100);
        assert_eq!(first.total, 10_000);
        assert!(first.next_cursor.is_some());
        let second = storage
            .meeting_library_page(first.next_cursor.as_deref(), 100)
            .unwrap();
        assert_eq!(second.items.len(), 100);
        assert_ne!(first.items[0].meeting_id, second.items[0].meeting_id);
        let search_started = Instant::now();
        let search = storage
            .search_segments(SegmentSearchQuery {
                text: Some("bounded-search-needle".to_owned()),
                scopes: vec!["original".to_owned()],
                meeting_id: None,
                tag_ids: Vec::new(),
                limit: 10,
                cursor: None,
            })
            .unwrap();
        assert_eq!(search.hits.len(), 1);
        assert_eq!(search.hits[0].meeting_id, "meeting-09876");
        assert!(search.next_cursor.is_none());
        assert!(search_started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn segment_search_filters_scope_identity_and_tags() {
        let (storage, writer) = storage_and_writer("search-filter");
        let meeting = writer.start_meeting(true, "test model").unwrap();
        writer
            .commit_final(candidate(&meeting.id, 1, "alpha original"))
            .unwrap();
        writer
            .replace_meeting_tags(&meeting.id, vec!["alpha-tag".to_owned()])
            .unwrap();
        let page = storage
            .search_segments(SegmentSearchQuery {
                text: Some("alpha".to_owned()),
                scopes: vec!["original".to_owned()],
                meeting_id: Some(meeting.id.clone()),
                tag_ids: vec!["alpha-tag".to_owned()],
                limit: 10,
                cursor: None,
            })
            .unwrap();
        assert_eq!(page.hits.len(), 1);
        assert_eq!(page.hits[0].meeting_id, meeting.id);
        assert_eq!(page.hits[0].segment_id, "segment-1");
    }

    #[test]
    fn cjk_middle_substring_search_returns_exact_segment_identity() {
        let (storage, writer) = storage_and_writer("cjk-search");
        let zh = writer
            .start_meeting_with_metadata(true, "test model", "中文会议", "zh")
            .unwrap();
        writer
            .commit_final(candidate(&zh.id, 1, "今天讨论内部设计方案"))
            .unwrap();
        let ja = writer
            .start_meeting_with_metadata(true, "test model", "日本語会議", "ja")
            .unwrap();
        writer
            .commit_final(candidate(&ja.id, 1, "今日は詳細設計レビューです"))
            .unwrap();

        let zh_page = storage
            .search_segments(SegmentSearchQuery {
                text: Some("内部设计".to_owned()),
                scopes: vec!["original".to_owned()],
                meeting_id: Some(zh.id.clone()),
                tag_ids: Vec::new(),
                limit: 10,
                cursor: None,
            })
            .unwrap();
        assert_eq!(zh_page.hits.len(), 1);
        assert_eq!(zh_page.hits[0].meeting_id, zh.id);
        assert_eq!(zh_page.hits[0].segment_id, "segment-1");

        let ja_page = storage
            .search_segments(SegmentSearchQuery {
                text: Some("詳細設計".to_owned()),
                scopes: vec!["original".to_owned()],
                meeting_id: Some(ja.id.clone()),
                tag_ids: Vec::new(),
                limit: 10,
                cursor: None,
            })
            .unwrap();
        assert_eq!(ja_page.hits.len(), 1);
        assert_eq!(ja_page.hits[0].meeting_id, ja.id);
        assert_eq!(ja_page.hits[0].segment_id, "segment-1");

        let short_page = storage
            .search_segments(SegmentSearchQuery {
                text: Some("设计".to_owned()),
                scopes: vec!["original".to_owned()],
                meeting_id: Some(zh.id.clone()),
                tag_ids: Vec::new(),
                limit: 10,
                cursor: None,
            })
            .unwrap();
        assert_eq!(short_page.hits.len(), 1);
        assert_eq!(short_page.hits[0].segment_id, "segment-1");
    }

    fn content_tables_containing(connection: &Connection, needle: &str) -> Vec<String> {
        let mut statement = connection
            .prepare(
                "SELECT name FROM sqlite_master
                 WHERE type='table' AND name LIKE 'mvp_%'
                 ORDER BY name",
            )
            .unwrap();
        let tables = statement
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        tables
            .into_iter()
            .filter(|table| table_contains_text(connection, table, needle))
            .collect()
    }

    fn table_contains_text(connection: &Connection, table: &str, needle: &str) -> bool {
        let escaped_table = table.replace('"', "\"\"");
        let Ok(mut columns) =
            connection.prepare(&format!("PRAGMA table_info(\"{escaped_table}\")"))
        else {
            return false;
        };
        let text_columns = columns
            .query_map([], |row| {
                Ok((row.get::<_, String>(1)?, row.get::<_, String>(2)?))
            })
            .unwrap()
            .filter_map(Result::ok)
            .filter(|(_, kind)| kind.eq_ignore_ascii_case("TEXT"))
            .map(|(name, _)| name)
            .collect::<Vec<_>>();
        for column in text_columns {
            let escaped_column = column.replace('"', "\"\"");
            let Ok(count) = connection.query_row(
                &format!(
                    "SELECT COUNT(*) FROM \"{escaped_table}\" WHERE \"{escaped_column}\" LIKE ?1"
                ),
                params![format!("%{needle}%")],
                |row| row.get::<_, i64>(0),
            ) else {
                continue;
            };
            if count > 0 {
                return true;
            }
        }
        false
    }
}
