use std::{
    env, fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc::{Receiver, SyncSender, TrySendError, sync_channel},
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use rusqlite::{Connection, OptionalExtension, Transaction, params};

use super::contract::{MAX_FINAL_SEGMENTS, MVP_CONTRACT_VERSION, TranscriptSegment};

pub const MVP_SCHEMA_VERSION: i64 = 1;
pub const MVP_SCHEMA_CHECKSUM: &str =
    "meetingrelay.mvp.sqlite.v1:meetings/finals/events/export-snapshots/exports";
pub const STORAGE_QUEUE_DEPTH: usize = 8;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MvpStorage {
    db_path: PathBuf,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MeetingRecord {
    pub id: String,
    pub state: String,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub last_final_sequence: u64,
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
                    "SELECT id, state, started_at, ended_at, last_final_sequence
                     FROM mvp_meetings
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

    pub fn complete_meeting(&self, meeting_id: &str) -> Result<MeetingRecord, String> {
        self.finish_meeting(meeting_id, "completed")
    }

    pub fn interrupt_meeting(&self, meeting_id: &str) -> Result<MeetingRecord, String> {
        self.finish_meeting(meeting_id, "interrupted")
    }

    fn finish_meeting(&self, meeting_id: &str, state: &str) -> Result<MeetingRecord, String> {
        self.request(|reply| StorageRequest::FinishMeeting {
            meeting_id: meeting_id.to_owned(),
            state: state.to_owned(),
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
    StartMeeting {
        consent_accepted: bool,
        model_label: String,
        reply: SyncSender<Result<MeetingRecord, String>>,
    },
    FinishMeeting {
        meeting_id: String,
        state: String,
        reply: SyncSender<Result<MeetingRecord, String>>,
    },
    OpenMeeting {
        meeting_id: String,
        reply: SyncSender<Result<MeetingSnapshot, String>>,
    },
    CommitFinal(FinalCandidate, SyncSender<Result<CommitAck, String>>),
    RecordExportSnapshot {
        snapshot: MeetingSnapshot,
        exports: Vec<CompletedExport>,
        reply: SyncSender<Result<(), String>>,
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
            StorageRequest::FinishMeeting {
                meeting_id,
                state,
                reply,
            } => {
                let _ = reply.send(finish_meeting_on_writer(
                    &mut connection,
                    &meeting_id,
                    &state,
                ));
            }
            StorageRequest::OpenMeeting { meeting_id, reply } => {
                let _ = reply.send(open_meeting_on_writer(&mut connection, &meeting_id));
            }
            StorageRequest::CommitFinal(candidate, reply) => {
                let _ = reply.send(commit_final_on_writer(&mut connection, candidate));
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
    }
}

pub fn visible_window_start_sequence(total_final_count: usize) -> String {
    if total_final_count <= MAX_FINAL_SEGMENTS {
        "1".to_owned()
    } else {
        (total_final_count - MAX_FINAL_SEGMENTS + 1).to_string()
    }
}

fn open_writer_connection(db_path: &PathBuf) -> Result<Connection, String> {
    let mut connection =
        Connection::open(db_path).map_err(|_| "MVP_STORAGE_OPEN_FAILED".to_owned())?;
    validate_user_version_not_newer(&connection)?;
    configure_writer_connection(&mut connection)?;
    migrate(&mut connection)?;
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
                app_contract_version TEXT NOT NULL
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
                PRIMARY KEY (meeting_id, segment_id, transcript_generation, source_revision),
                UNIQUE (meeting_id, sequence),
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
            PRAGMA user_version = 1;
            ",
        )
        .map_err(|_| "MVP_STORAGE_MIGRATION_FAILED".to_owned())?;
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
    let checksum = connection
        .query_row(
            "SELECT checksum FROM mvp_schema_migrations WHERE version=?1",
            params![MVP_SCHEMA_VERSION],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|_| "MVP_STORAGE_SCHEMA_QUERY_FAILED".to_owned())?
        .ok_or_else(|| "MVP_STORAGE_SCHEMA_CHECKSUM_MISSING".to_owned())?;
    if checksum != MVP_SCHEMA_CHECKSUM {
        return Err("MVP_STORAGE_SCHEMA_CHECKSUM_MISMATCH".to_owned());
    }
    Ok(())
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
) -> Result<MeetingRecord, String> {
    if !matches!(state, "completed" | "interrupted") {
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
            content_sha256, committed_at, commit_id
        ) VALUES (?1, ?2, ?3, ?4, 1, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
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
            commit_id
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

fn meeting_on_connection(
    connection: &Connection,
    meeting_id: &str,
) -> Result<Option<MeetingRecord>, String> {
    connection
        .query_row(
            "SELECT id, state, started_at, ended_at, last_final_sequence
             FROM mvp_meetings WHERE id=?1",
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
            "SELECT id, state, started_at, ended_at, last_final_sequence
             FROM mvp_meetings WHERE id=?1",
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
        "SELECT meeting_id, segment_id, sequence, revision, text, started_at_ms, ended_at_ms,
                content_sha256, committed_at, commit_id
         FROM mvp_final_segments
         WHERE meeting_id=?1 AND segment_id=?2 AND transcript_generation=?3 AND source_revision=?4",
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
        "SELECT meeting_id, segment_id, sequence, revision, text, started_at_ms, ended_at_ms,
                content_sha256, committed_at, commit_id
         FROM mvp_final_segments
         WHERE meeting_id=?1 AND sequence=?2",
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
            "SELECT meeting_id, segment_id, sequence, revision, text, started_at_ms, ended_at_ms,
                    content_sha256, committed_at, commit_id
             FROM mvp_final_segments
             WHERE meeting_id=?1
             ORDER BY sequence ASC",
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
    })
}

fn durable_final_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<DurableFinal> {
    let sequence: i64 = row.get(2)?;
    let revision: i64 = row.get(3)?;
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

pub fn semantic_digest(meeting: &MeetingRecord, finals: &[DurableFinal]) -> String {
    let mut material = format!(
        "{}\n{}\n{}\n{}\n",
        meeting.id,
        meeting.state,
        meeting.started_at,
        meeting.ended_at.as_deref().unwrap_or("")
    );
    for final_segment in finals {
        material.push_str(&format!(
            "{}\n{}\n{}\n{}\n{}\n",
            final_segment.sequence,
            final_segment.segment_id,
            final_segment.revision,
            final_segment.started_at_ms,
            final_segment.content_sha256
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
                "SELECT checksum FROM mvp_schema_migrations WHERE version=1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(journal.to_lowercase(), "wal");
        assert_eq!(foreign_keys, 1);
        assert_eq!(synchronous, 2);
        assert_eq!(checksum, MVP_SCHEMA_CHECKSUM);
    }

    #[test]
    fn checksum_tamper_fails_closed() {
        let db = temp_db("checksum-tamper");
        drop(open_writer_connection(&db).unwrap());
        let connection = Connection::open(&db).unwrap();
        connection
            .execute(
                "UPDATE mvp_schema_migrations SET checksum='tampered' WHERE version=1",
                [],
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
}
