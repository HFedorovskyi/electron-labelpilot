use super::{DriverPageSpec, JobAction, PageMarginsMm, PrintReceipt, PrinterDeviceConfig};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

const MAX_RECOVERY_JOBS: usize = 512;
const MAX_LIST_JOBS: usize = 200;
const RETENTION_MS: i64 = 30 * 24 * 60 * 60 * 1_000;

const VALID_STATES: [&str; 7] = [
    "queued",
    "rendering",
    "sending",
    "accepted",
    "uncertain",
    "failed",
    "cancelled",
];

#[derive(Clone)]
pub(super) struct DurablePrintStore {
    inner: Arc<DurablePrintStoreInner>,
}

struct DurablePrintStoreInner {
    connection: Mutex<Connection>,
    startup_uncertain: u64,
}

#[derive(Debug)]
pub(super) enum PrepareOutcome {
    New(String),
    Cached(PrintReceipt),
}

#[derive(Debug)]
pub(super) struct StoredPrintJob {
    pub job_id: String,
    pub config: PrinterDeviceConfig,
    pub action: JobAction,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DurablePrintJobRecord {
    pub job_id: String,
    pub state: String,
    pub printer_id: String,
    pub printer_name: String,
    pub physical_key: String,
    pub protocol: String,
    pub connection: String,
    pub idempotency_key: Option<String>,
    pub fingerprint: String,
    pub action_kind: String,
    pub payload_bytes: usize,
    pub attempt_count: u64,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
    pub accepted_at_ms: Option<i64>,
    pub last_error: Option<String>,
    pub receipt: Option<PrintReceipt>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DurableQueueSummary {
    pub queued: u64,
    pub rendering: u64,
    pub sending: u64,
    pub accepted: u64,
    pub uncertain: u64,
    pub failed: u64,
    pub cancelled: u64,
    pub total: u64,
    pub startup_marked_uncertain: u64,
    pub max_recovery_jobs: usize,
    pub max_list_jobs: usize,
    pub retention_ms: i64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BitmapMetadata {
    width: u32,
    height: u32,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PageMetadata {
    width: u32,
    height: u32,
    page_width_mm: f64,
    page_height_mm: f64,
    margins_mm: PageMarginsMm,
    fit_mode: String,
    document_name: String,
}

impl DurablePrintStore {
    pub(super) fn in_memory() -> Result<Self, String> {
        Self::from_connection(
            Connection::open_in_memory().map_err(db_error("open memory database"))?,
        )
    }

    pub(super) fn open(path: &Path) -> Result<Self, String> {
        let connection = Connection::open(path).map_err(db_error("open durable print database"))?;
        connection
            .busy_timeout(std::time::Duration::from_secs(5))
            .map_err(db_error("set durable print busy timeout"))?;
        Self::from_connection(connection)
    }

    fn from_connection(mut connection: Connection) -> Result<Self, String> {
        connection
            .execute_batch("PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL;")
            .map_err(db_error("configure durable print database"))?;
        initialize_schema(&connection)?;
        let now = unix_ms();
        let startup_uncertain = connection
            .execute(
                "UPDATE printer_delivery_jobs \
                 SET state = 'uncertain', updated_at_ms = ?1, \
                     last_error = COALESCE(last_error, 'process stopped while delivery was in progress') \
                 WHERE state IN ('rendering', 'sending')",
                params![now],
            )
            .map_err(db_error("recover interrupted durable print jobs"))?
            as u64;
        prune(&mut connection, now)?;
        Ok(Self {
            inner: Arc::new(DurablePrintStoreInner {
                connection: Mutex::new(connection),
                startup_uncertain,
            }),
        })
    }

    pub(super) fn prepare(
        &self,
        config: &PrinterDeviceConfig,
        physical_key: &str,
        fingerprint: u64,
        action: &JobAction,
    ) -> Result<PrepareOutcome, String> {
        let connection = self.lock()?;
        let fingerprint = format!("{fingerprint:016X}");
        if let Some(key) = config.job_idempotency_key.as_deref() {
            let existing = connection
                .query_row(
                    "SELECT job_id, fingerprint, state, receipt_json, last_error \
                     FROM printer_delivery_jobs \
                     WHERE physical_key = ?1 AND idempotency_key = ?2 \
                     ORDER BY created_at_ms DESC LIMIT 1",
                    params![physical_key, key],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, Option<String>>(3)?,
                            row.get::<_, Option<String>>(4)?,
                        ))
                    },
                )
                .optional()
                .map_err(db_error("query durable idempotency record"))?;
            if let Some((job_id, existing_fingerprint, state, receipt_json, last_error)) = existing
            {
                if existing_fingerprint != fingerprint {
                    return Err(format!(
                        "DURABLE_IDEMPOTENCY_CONFLICT: key already belongs to another payload ({job_id})"
                    ));
                }
                match state.as_str() {
                    "accepted" => {
                        let mut receipt: PrintReceipt = serde_json::from_str(
                            receipt_json
                                .as_deref()
                                .ok_or("accepted durable job is missing its receipt")?,
                        )
                        .map_err(|error| format!("decode durable print receipt: {error}"))?;
                        receipt.deduplicated = true;
                        receipt.durable_job_id = Some(job_id);
                        receipt.durable_state = Some("accepted".to_owned());
                        return Ok(PrepareOutcome::Cached(receipt));
                    }
                    "queued" | "rendering" | "sending" => {
                        return Err(format!(
                            "DURABLE_JOB_IN_PROGRESS: existing job {job_id} is {state}"
                        ));
                    }
                    "uncertain" | "failed" => {
                        return Err(format!(
                            "DURABLE_RETRY_REQUIRED: existing job {job_id} is {state}: {}",
                            last_error.as_deref().unwrap_or("no error details")
                        ));
                    }
                    "cancelled" => {}
                    other => return Err(format!("invalid durable job state in database: {other}")),
                }
            }
        }

        let job_id = Uuid::new_v4().to_string();
        let (action_kind, payload, metadata_json) = encode_action(action)?;
        let config_json = serde_json::to_string(config)
            .map_err(|error| format!("encode durable printer config: {error}"))?;
        let now = unix_ms();
        connection
            .execute(
                "INSERT INTO printer_delivery_jobs (
                    job_id, state, printer_id, printer_name, physical_key, protocol, connection,
                    idempotency_key, fingerprint, config_json, action_kind, action_json, payload,
                    payload_bytes, attempt_count, created_at_ms, updated_at_ms
                 ) VALUES (?1, 'queued', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 0, ?14, ?14)",
                params![
                    job_id,
                    config.id,
                    config.name,
                    physical_key,
                    config.protocol,
                    config.connection,
                    config.job_idempotency_key,
                    fingerprint,
                    config_json,
                    action_kind,
                    metadata_json,
                    payload,
                    payload.len() as i64,
                    now,
                ],
            )
            .map_err(db_error("insert durable print job"))?;
        Ok(PrepareOutcome::New(job_id))
    }

    pub(super) fn queued_jobs(&self) -> Result<Vec<StoredPrintJob>, String> {
        let connection = self.lock()?;
        load_jobs_by_state(&connection, "queued", MAX_RECOVERY_JOBS)
    }

    pub(super) fn prepare_retry(&self, job_id: &str) -> Result<StoredPrintJob, String> {
        validate_job_id(job_id)?;
        let mut connection = self.lock()?;
        let transaction = connection
            .transaction()
            .map_err(db_error("begin durable retry"))?;
        let state = transaction
            .query_row(
                "SELECT state FROM printer_delivery_jobs WHERE job_id = ?1",
                params![job_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(db_error("query durable retry state"))?
            .ok_or_else(|| format!("durable print job not found: {job_id}"))?;
        if !matches!(state.as_str(), "failed" | "uncertain" | "cancelled") {
            return Err(format!(
                "durable print job {job_id} cannot be retried from state {state}"
            ));
        }
        transaction
            .execute(
                "UPDATE printer_delivery_jobs SET state = 'queued', updated_at_ms = ?1, \
                 accepted_at_ms = NULL, last_error = NULL, receipt_json = NULL WHERE job_id = ?2",
                params![unix_ms(), job_id],
            )
            .map_err(db_error("queue durable retry"))?;
        let job = load_stored_job(&transaction, job_id)?;
        transaction
            .commit()
            .map_err(db_error("commit durable retry"))?;
        Ok(job)
    }

    pub(super) fn cancel(&self, job_id: &str) -> Result<DurablePrintJobRecord, String> {
        validate_job_id(job_id)?;
        let connection = self.lock()?;
        let changed = connection
            .execute(
                "UPDATE printer_delivery_jobs SET state = 'cancelled', updated_at_ms = ?1, \
                 last_error = 'cancelled by operator' \
                 WHERE job_id = ?2 AND state IN ('queued', 'failed', 'uncertain')",
                params![unix_ms(), job_id],
            )
            .map_err(db_error("cancel durable print job"))?;
        if changed == 0 {
            let state = connection
                .query_row(
                    "SELECT state FROM printer_delivery_jobs WHERE job_id = ?1",
                    params![job_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(db_error("query durable cancellation state"))?;
            return Err(match state {
                Some(state) => {
                    format!("durable print job {job_id} cannot be cancelled from state {state}")
                }
                None => format!("durable print job not found: {job_id}"),
            });
        }
        load_record(&connection, job_id)
    }

    pub(super) fn mark_sending(&self, job_id: &str) -> Result<bool, String> {
        let connection = self.lock()?;
        let changed = connection
            .execute(
                "UPDATE printer_delivery_jobs SET state = 'sending', updated_at_ms = ?1, \
                 attempt_count = attempt_count + 1 WHERE job_id = ?2 AND state = 'queued'",
                params![unix_ms(), job_id],
            )
            .map_err(db_error("mark durable print job sending"))?;
        if changed == 1 {
            return Ok(true);
        }
        let state = connection
            .query_row(
                "SELECT state FROM printer_delivery_jobs WHERE job_id = ?1",
                params![job_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(db_error("query durable print start state"))?
            .ok_or_else(|| format!("durable print job not found: {job_id}"))?;
        if state == "cancelled" {
            Ok(false)
        } else {
            Err(format!(
                "durable print job {job_id} cannot start from state {state}"
            ))
        }
    }

    pub(super) fn mark_accepted(&self, job_id: &str, receipt: &PrintReceipt) -> Result<(), String> {
        let receipt_json = serde_json::to_string(receipt)
            .map_err(|error| format!("encode durable receipt: {error}"))?;
        let now = unix_ms();
        let changed = self
            .lock()?
            .execute(
                "UPDATE printer_delivery_jobs SET state = 'accepted', updated_at_ms = ?1, \
                 accepted_at_ms = ?1, last_error = NULL, receipt_json = ?2 \
                 WHERE job_id = ?3 AND state = 'sending'",
                params![now, receipt_json, job_id],
            )
            .map_err(db_error("mark durable print job accepted"))?;
        self.expect_one_transition(job_id, changed, "sending", "accepted")
    }

    pub(super) fn mark_uncertain(&self, job_id: &str, error: &str) -> Result<(), String> {
        self.mark_terminal_error(job_id, "uncertain", error, &["sending"])
    }

    pub(super) fn mark_failed(&self, job_id: &str, error: &str) -> Result<(), String> {
        self.mark_terminal_error(job_id, "failed", error, &["queued"])
    }

    fn mark_terminal_error(
        &self,
        job_id: &str,
        state: &str,
        error: &str,
        allowed: &[&str],
    ) -> Result<(), String> {
        if !VALID_STATES.contains(&state) {
            return Err(format!("invalid durable terminal state: {state}"));
        }
        let allowed_sql = allowed
            .iter()
            .map(|value| format!("'{value}'"))
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            "UPDATE printer_delivery_jobs SET state = ?1, updated_at_ms = ?2, last_error = ?3 \
             WHERE job_id = ?4 AND state IN ({allowed_sql})"
        );
        let changed = self
            .lock()?
            .execute(
                &sql,
                params![state, unix_ms(), bounded_error(error), job_id],
            )
            .map_err(db_error("mark durable print job failed"))?;
        self.expect_one_transition(job_id, changed, &allowed.join("/"), state)
    }

    fn expect_one_transition(
        &self,
        job_id: &str,
        changed: usize,
        from: &str,
        to: &str,
    ) -> Result<(), String> {
        if changed == 1 {
            Ok(())
        } else {
            Err(format!(
                "durable print job {job_id} did not transition from {from} to {to}"
            ))
        }
    }

    pub(super) fn list(
        &self,
        state: Option<&str>,
        limit: Option<usize>,
    ) -> Result<Vec<DurablePrintJobRecord>, String> {
        let state = state.map(str::trim).filter(|value| !value.is_empty());
        if state.is_some_and(|value| !VALID_STATES.contains(&value)) {
            return Err(format!(
                "invalid durable print state filter: {}",
                state.unwrap()
            ));
        }
        let limit = limit.unwrap_or(50).clamp(1, MAX_LIST_JOBS);
        let connection = self.lock()?;
        let sql = if state.is_some() {
            "SELECT job_id, state, printer_id, printer_name, physical_key, protocol, connection, \
             idempotency_key, fingerprint, action_kind, payload_bytes, attempt_count, created_at_ms, \
             updated_at_ms, accepted_at_ms, last_error, receipt_json \
             FROM printer_delivery_jobs WHERE state = ?1 ORDER BY created_at_ms DESC LIMIT ?2"
        } else {
            "SELECT job_id, state, printer_id, printer_name, physical_key, protocol, connection, \
             idempotency_key, fingerprint, action_kind, payload_bytes, attempt_count, created_at_ms, \
             updated_at_ms, accepted_at_ms, last_error, receipt_json \
             FROM printer_delivery_jobs ORDER BY created_at_ms DESC LIMIT ?1"
        };
        let mut statement = connection
            .prepare(sql)
            .map_err(db_error("prepare durable print job list"))?;
        let mapper = |row: &rusqlite::Row<'_>| row_to_record(row);
        let rows = if let Some(state) = state {
            statement
                .query_map(params![state, limit as i64], mapper)
                .map_err(db_error("query durable print jobs"))?
                .collect::<Result<Vec<_>, _>>()
        } else {
            statement
                .query_map(params![limit as i64], mapper)
                .map_err(db_error("query durable print jobs"))?
                .collect::<Result<Vec<_>, _>>()
        }
        .map_err(db_error("decode durable print jobs"))?;
        rows.into_iter().map(decode_record_receipt).collect()
    }

    pub(super) fn summary(&self) -> Result<DurableQueueSummary, String> {
        let connection = self.lock()?;
        let mut counts = std::collections::HashMap::new();
        let mut statement = connection
            .prepare("SELECT state, COUNT(*) FROM printer_delivery_jobs GROUP BY state")
            .map_err(db_error("prepare durable print summary"))?;
        for row in statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?.max(0) as u64,
                ))
            })
            .map_err(db_error("query durable print summary"))?
        {
            let (state, count) = row.map_err(db_error("decode durable print summary"))?;
            counts.insert(state, count);
        }
        let count = |state: &str| counts.get(state).copied().unwrap_or(0);
        Ok(DurableQueueSummary {
            queued: count("queued"),
            rendering: count("rendering"),
            sending: count("sending"),
            accepted: count("accepted"),
            uncertain: count("uncertain"),
            failed: count("failed"),
            cancelled: count("cancelled"),
            total: counts.values().sum(),
            startup_marked_uncertain: self.inner.startup_uncertain,
            max_recovery_jobs: MAX_RECOVERY_JOBS,
            max_list_jobs: MAX_LIST_JOBS,
            retention_ms: RETENTION_MS,
        })
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Connection>, String> {
        self.inner
            .connection
            .lock()
            .map_err(|_| "durable print database lock is poisoned".to_owned())
    }
}

fn initialize_schema(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS printer_delivery_jobs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                job_id TEXT NOT NULL UNIQUE,
                state TEXT NOT NULL CHECK(state IN ('queued','rendering','sending','accepted','uncertain','failed','cancelled')),
                printer_id TEXT NOT NULL,
                printer_name TEXT NOT NULL DEFAULT '',
                physical_key TEXT NOT NULL,
                protocol TEXT NOT NULL,
                connection TEXT NOT NULL,
                idempotency_key TEXT,
                fingerprint TEXT NOT NULL,
                config_json TEXT NOT NULL,
                action_kind TEXT NOT NULL,
                action_json TEXT NOT NULL,
                payload BLOB NOT NULL,
                payload_bytes INTEGER NOT NULL,
                attempt_count INTEGER NOT NULL DEFAULT 0,
                created_at_ms INTEGER NOT NULL,
                updated_at_ms INTEGER NOT NULL,
                accepted_at_ms INTEGER,
                last_error TEXT,
                receipt_json TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_printer_delivery_state_created
                ON printer_delivery_jobs(state, created_at_ms DESC);
            CREATE INDEX IF NOT EXISTS idx_printer_delivery_idempotency
                ON printer_delivery_jobs(physical_key, idempotency_key, created_at_ms DESC);
            "#,
        )
        .map_err(db_error("initialize durable print schema"))
}

fn prune(connection: &mut Connection, now: i64) -> Result<(), String> {
    connection
        .execute(
            "DELETE FROM printer_delivery_jobs WHERE updated_at_ms < ?1 \
             AND state IN ('accepted', 'failed', 'cancelled')",
            params![now.saturating_sub(RETENTION_MS)],
        )
        .map_err(db_error("prune durable print history"))?;
    Ok(())
}

fn encode_action(action: &JobAction) -> Result<(&'static str, &[u8], String), String> {
    match action {
        JobAction::Print(data) => Ok(("raw", data, "{}".to_owned())),
        JobAction::DriverBitmap {
            width,
            height,
            mono,
        } => Ok((
            "driver-bitmap",
            mono,
            serde_json::to_string(&BitmapMetadata {
                width: *width,
                height: *height,
            })
            .map_err(|error| format!("encode driver bitmap metadata: {error}"))?,
        )),
        JobAction::DriverPage {
            width,
            height,
            mono,
            page,
        } => Ok((
            "driver-page",
            mono,
            serde_json::to_string(&PageMetadata {
                width: *width,
                height: *height,
                page_width_mm: page.page_width_mm,
                page_height_mm: page.page_height_mm,
                margins_mm: page.margins_mm,
                fit_mode: page.fit_mode.clone(),
                document_name: page.document_name.clone(),
            })
            .map_err(|error| format!("encode driver page metadata: {error}"))?,
        )),
        JobAction::Probe => Err("probe jobs are not persisted".to_owned()),
        JobAction::Status => Err("status jobs are not persisted".to_owned()),
    }
}

fn decode_action(kind: &str, metadata: &str, payload: Vec<u8>) -> Result<JobAction, String> {
    match kind {
        "raw" => Ok(JobAction::Print(payload)),
        "driver-bitmap" => {
            let metadata: BitmapMetadata = serde_json::from_str(metadata)
                .map_err(|error| format!("decode driver bitmap metadata: {error}"))?;
            Ok(JobAction::DriverBitmap {
                width: metadata.width,
                height: metadata.height,
                mono: payload,
            })
        }
        "driver-page" => {
            let metadata: PageMetadata = serde_json::from_str(metadata)
                .map_err(|error| format!("decode driver page metadata: {error}"))?;
            Ok(JobAction::DriverPage {
                width: metadata.width,
                height: metadata.height,
                mono: payload,
                page: DriverPageSpec {
                    page_width_mm: metadata.page_width_mm,
                    page_height_mm: metadata.page_height_mm,
                    margins_mm: metadata.margins_mm,
                    fit_mode: metadata.fit_mode,
                    document_name: metadata.document_name,
                },
            })
        }
        other => Err(format!("unsupported durable action kind: {other}")),
    }
}

fn load_jobs_by_state(
    connection: &Connection,
    state: &str,
    limit: usize,
) -> Result<Vec<StoredPrintJob>, String> {
    let mut statement = connection
        .prepare(
            "SELECT job_id, config_json, action_kind, action_json, payload \
             FROM printer_delivery_jobs WHERE state = ?1 ORDER BY created_at_ms ASC LIMIT ?2",
        )
        .map_err(db_error("prepare durable recovery jobs"))?;
    let rows = statement
        .query_map(params![state, limit as i64], |row| {
            let job_id: String = row.get(0)?;
            let config_json: String = row.get(1)?;
            let action_kind: String = row.get(2)?;
            let action_json: String = row.get(3)?;
            let payload: Vec<u8> = row.get(4)?;
            Ok((job_id, config_json, action_kind, action_json, payload))
        })
        .map_err(db_error("query durable recovery jobs"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error("decode durable recovery rows"))?;
    rows.into_iter()
        .map(|(job_id, config_json, action_kind, action_json, payload)| {
            Ok(StoredPrintJob {
                job_id,
                config: serde_json::from_str(&config_json)
                    .map_err(|error| format!("decode durable printer config: {error}"))?,
                action: decode_action(&action_kind, &action_json, payload)?,
            })
        })
        .collect()
}

fn load_stored_job(connection: &Connection, job_id: &str) -> Result<StoredPrintJob, String> {
    connection
        .query_row(
            "SELECT config_json, action_kind, action_json, payload \
             FROM printer_delivery_jobs WHERE job_id = ?1",
            params![job_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Vec<u8>>(3)?,
                ))
            },
        )
        .map_err(db_error("load durable print job"))
        .and_then(|(config_json, kind, metadata, payload)| {
            Ok(StoredPrintJob {
                job_id: job_id.to_owned(),
                config: serde_json::from_str(&config_json)
                    .map_err(|error| format!("decode durable printer config: {error}"))?,
                action: decode_action(&kind, &metadata, payload)?,
            })
        })
}

fn load_record(connection: &Connection, job_id: &str) -> Result<DurablePrintJobRecord, String> {
    connection
        .query_row(
            "SELECT job_id, state, printer_id, printer_name, physical_key, protocol, connection, \
             idempotency_key, fingerprint, action_kind, payload_bytes, attempt_count, created_at_ms, \
             updated_at_ms, accepted_at_ms, last_error, receipt_json \
             FROM printer_delivery_jobs WHERE job_id = ?1",
            params![job_id],
            row_to_record,
        )
        .map_err(db_error("load durable print record"))
        .and_then(decode_record_receipt)
}

fn row_to_record(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<(DurablePrintJobRecord, Option<String>)> {
    Ok((
        DurablePrintJobRecord {
            job_id: row.get(0)?,
            state: row.get(1)?,
            printer_id: row.get(2)?,
            printer_name: row.get(3)?,
            physical_key: row.get(4)?,
            protocol: row.get(5)?,
            connection: row.get(6)?,
            idempotency_key: row.get(7)?,
            fingerprint: row.get(8)?,
            action_kind: row.get(9)?,
            payload_bytes: row.get::<_, i64>(10)?.max(0) as usize,
            attempt_count: row.get::<_, i64>(11)?.max(0) as u64,
            created_at_ms: row.get(12)?,
            updated_at_ms: row.get(13)?,
            accepted_at_ms: row.get(14)?,
            last_error: row.get(15)?,
            receipt: None,
        },
        row.get(16)?,
    ))
}

fn decode_record_receipt(
    (mut record, receipt_json): (DurablePrintJobRecord, Option<String>),
) -> Result<DurablePrintJobRecord, String> {
    record.receipt = receipt_json
        .map(|value| {
            serde_json::from_str(&value)
                .map_err(|error| format!("decode durable receipt for {}: {error}", record.job_id))
        })
        .transpose()?;
    Ok(record)
}

fn validate_job_id(job_id: &str) -> Result<(), String> {
    if Uuid::parse_str(job_id).is_err() {
        return Err("durable print job id must be a UUID".to_owned());
    }
    Ok(())
}

fn bounded_error(error: &str) -> String {
    error.chars().take(2_048).collect()
}

fn unix_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}

fn db_error(context: &'static str) -> impl FnOnce(rusqlite::Error) -> String {
    move |error| format!("{context}: {error}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(key: Option<&str>) -> PrinterDeviceConfig {
        PrinterDeviceConfig::from_value(serde_json::json!({
            "id": "durable-test",
            "name": "Durable test",
            "connection": "tcp",
            "protocol": "zpl",
            "ip": "127.0.0.1",
            "port": 9100,
            "jobIdempotencyKey": key,
        }))
        .unwrap()
    }

    #[test]
    fn persists_state_transitions_and_serves_accepted_duplicates() {
        let store = DurablePrintStore::in_memory().unwrap();
        let config = config(Some("pack-42"));
        let action = JobAction::Print(b"^XA^XZ".to_vec());
        let fingerprint = super::super::action_fingerprint(&action);
        let job_id = match store
            .prepare(&config, &config.physical_key(), fingerprint, &action)
            .unwrap()
        {
            PrepareOutcome::New(job_id) => job_id,
            _ => panic!("first durable job must be new"),
        };
        assert!(store.mark_sending(&job_id).unwrap());
        let receipt = PrintReceipt {
            printer_id: config.id.clone(),
            physical_key: config.physical_key(),
            bytes: 6,
            queue_ms: 1,
            send_ms: 2,
            attempts: 1,
            reused_connection: false,
            delivery_state: "transport-accepted".to_owned(),
            confirmation_mode: "transport-write".to_owned(),
            idempotency_key: config.job_idempotency_key.clone(),
            deduplicated: false,
            durable_job_id: Some(job_id.clone()),
            durable_state: Some("accepted".to_owned()),
            status_report: None,
        };
        store.mark_accepted(&job_id, &receipt).unwrap();
        let duplicate = store
            .prepare(&config, &config.physical_key(), fingerprint, &action)
            .unwrap();
        match duplicate {
            PrepareOutcome::Cached(receipt) => {
                assert!(receipt.deduplicated);
                assert_eq!(receipt.durable_job_id.as_deref(), Some(job_id.as_str()));
            }
            _ => panic!("accepted durable job must be cached"),
        }
        let summary = store.summary().unwrap();
        assert_eq!(summary.accepted, 1);
        assert_eq!(summary.total, 1);
    }

    #[test]
    fn reopening_marks_inflight_uncertain_and_keeps_accepted_idempotency() {
        let path =
            std::env::temp_dir().join(format!("labelpilot-durable-{}.sqlite3", Uuid::new_v4()));
        let config = config(Some("restart-key"));
        let action = JobAction::Print(b"RESTART".to_vec());
        let fingerprint = super::super::action_fingerprint(&action);
        let job_id;
        {
            let store = DurablePrintStore::open(&path).unwrap();
            job_id = match store
                .prepare(&config, &config.physical_key(), fingerprint, &action)
                .unwrap()
            {
                PrepareOutcome::New(job_id) => job_id,
                _ => unreachable!(),
            };
            assert!(store.mark_sending(&job_id).unwrap());
        }
        {
            let store = DurablePrintStore::open(&path).unwrap();
            let summary = store.summary().unwrap();
            assert_eq!(summary.startup_marked_uncertain, 1);
            assert_eq!(summary.uncertain, 1);
            assert!(store
                .prepare(&config, &config.physical_key(), fingerprint, &action)
                .unwrap_err()
                .contains("DURABLE_RETRY_REQUIRED"));
            let retry = store.prepare_retry(&job_id).unwrap();
            assert_eq!(retry.job_id, job_id);
            assert_eq!(store.queued_jobs().unwrap().len(), 1);
        }
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("sqlite3-wal"));
        let _ = std::fs::remove_file(path.with_extension("sqlite3-shm"));
    }
    #[test]
    fn cancellation_and_manual_retry_are_explicit() {
        let store = DurablePrintStore::in_memory().unwrap();
        let config = config(None);
        let action = JobAction::Print(b"LABEL".to_vec());
        let job_id = match store
            .prepare(
                &config,
                &config.physical_key(),
                super::super::action_fingerprint(&action),
                &action,
            )
            .unwrap()
        {
            PrepareOutcome::New(job_id) => job_id,
            _ => unreachable!(),
        };
        assert_eq!(store.cancel(&job_id).unwrap().state, "cancelled");
        let retried = store.prepare_retry(&job_id).unwrap();
        assert_eq!(retried.job_id, job_id);
        assert!(store.mark_sending(&job_id).unwrap());
        store.mark_uncertain(&job_id, "write timed out").unwrap();
        assert_eq!(store.summary().unwrap().uncertain, 1);
    }
}
