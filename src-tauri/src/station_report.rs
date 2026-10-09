//! Station -> server production report: what was printed and deleted, the boxes and
//! pallets that changed, every station error and the print-job progress since the last
//! delivery, encrypted for the server.
//! Delivered online right away, or queued in the outbox until the server is reachable
//! (and exportable to USB as .lpr). Tauri-free: shared by the Slint reporter and the
//! Tauri telemetry worker. The server dedupes labels and logs, so a replay is harmless.

use crate::crypto::encrypt_report;
use crate::operational::OperationalState;
use crate::persisted::PersistedState;
use crate::processor::open_database;
use reqwest::blocking::multipart::{Form, Part};
use reqwest::blocking::Client;
use rusqlite::{params, Connection, Row};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use time::{format_description::well_known::Rfc3339, OffsetDateTime};
use uuid::Uuid;

pub const OUTBOX_DIRECTORY: &str = "outbox";
pub const REJECTED_DIRECTORY: &str = "rejected";
pub const CURSOR_FILE: &str = "report_state.json";
pub const MAX_OUTBOX_FILES: usize = 256;
pub const MAX_OUTBOX_BYTES: u64 = 256 * 1024 * 1024;
pub const MAX_REPORT_BYTES: u64 = 64 * 1024 * 1024;
pub const MAX_FLUSH_FILES: usize = 32;
const MAX_REPORT_PACKS: usize = 2_000;
const MAX_REPORT_DELETIONS: usize = 2_000;
const MAX_REPORT_LOGS: usize = 500;
const MAX_REPORT_JOBS: usize = 200;
const MAX_REPORT_CONTAINERS: usize = 500;
const RETAIN_REPORTED_LOG_ROWS: i64 = 10_000;

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportCursor {
    pub last_pack_id: i64,
    pub last_error_id: i64,
    pub last_deleted_at: String,
    pub last_deleted_id: i64,
    /// Digest of the job progress last delivered: jobs are re-sent only when it changes.
    #[serde(default)]
    pub last_jobs_digest: String,
    /// Boxes and pallets: the latest change delivered, and a digest of the rows changed at
    /// that moment (SQLite keeps whole seconds), so they are re-checked but not re-sent.
    #[serde(default)]
    pub last_container_at: String,
    #[serde(default)]
    pub last_containers_digest: String,
}

#[derive(Debug)]
pub struct DeltaReport {
    pub payload: Value,
    pub cursor: ReportCursor,
    pub label_count: usize,
    pub deleted_count: usize,
    pub log_count: usize,
    pub job_count: usize,
    pub container_count: usize,
}

impl DeltaReport {
    pub fn is_empty(&self) -> bool {
        self.label_count == 0
            && self.deleted_count == 0
            && self.log_count == 0
            && self.job_count == 0
            && self.container_count == 0
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum UploadResult {
    Sent,
    Retryable,
    Rejected(u16),
}

pub fn build_delta_report(
    persisted: &PersistedState,
    cursor: &ReportCursor,
) -> Result<DeltaReport, String> {
    let connection = open_database(persisted)?;
    let packs = query_pack_rows(
        &connection,
        "SELECT id, number, created_at, nomenclature_id, weight_netto, weight_brutto, barcode_value, status, production_date, expiration_date, batch, operator_name, deleted_at, box_id, (SELECT number FROM boxes WHERE boxes.id = pack.box_id) FROM pack WHERE id > ?1 ORDER BY id LIMIT ?2",
        params![cursor.last_pack_id, MAX_REPORT_PACKS as i64],
    )?;
    let deletions = query_pack_rows(
        &connection,
        "SELECT id, number, created_at, nomenclature_id, weight_netto, weight_brutto, barcode_value, status, production_date, expiration_date, batch, operator_name, deleted_at, box_id, (SELECT number FROM boxes WHERE boxes.id = pack.box_id) FROM pack WHERE deleted_at IS NOT NULL AND (deleted_at > ?1 OR (deleted_at = ?1 AND id > ?2)) ORDER BY deleted_at, id LIMIT ?3",
        params![cursor.last_deleted_at, cursor.last_deleted_id, MAX_REPORT_DELETIONS as i64],
    )?;
    let logs = query_log_rows(&connection, cursor.last_error_id)?;
    let jobs = query_job_rows(&connection)?;
    let jobs_digest = digest_jobs(&jobs);
    let jobs_changed = !jobs.is_empty() && jobs_digest != cursor.last_jobs_digest;
    // A new or deleted pack changes its box (and pallet) without touching their rows.
    let touched_boxes = packs.iter().chain(&deletions).map(|pack| pack.box_id).collect::<Vec<_>>();
    let containers = query_containers(&connection, &cursor.last_container_at, &touched_boxes)?;
    let containers_changed = containers.digest_all != cursor.last_containers_digest
        && !(containers.boxes.is_empty() && containers.pallets.is_empty());

    let identity = persisted.load_identity().unwrap_or(Value::Null);
    let station_uuid = identity
        .get("station_uuid")
        .and_then(Value::as_str)
        .unwrap_or("nostation");
    let printed_labels = packs
        .iter()
        .filter(|pack| pack.status != "Deleted")
        .map(|pack| pack.as_report_value(station_uuid))
        .collect::<Vec<_>>();
    let deleted_labels = deletions
        .iter()
        .map(|pack| pack.as_report_value(station_uuid))
        .collect::<Vec<_>>();
    let mut next = cursor.clone();
    if let Some(pack) = packs.last() {
        next.last_pack_id = pack.id;
    }
    if let Some(log) = logs.last() {
        next.last_error_id = log.id;
    }
    if let Some(pack) = deletions.last() {
        next.last_deleted_at = pack.deleted_at.clone().unwrap_or_default();
        next.last_deleted_id = pack.id;
    }
    next.last_jobs_digest = jobs_digest;
    next.last_container_at = containers.changed_at.clone();
    next.last_containers_digest = containers.digest_at_cursor.clone();
    let log_values = logs
        .iter()
        .map(|entry| {
            json!({
                "event_uid": entry.event_uid,
                "level": entry.level,
                "component": entry.component,
                "message": entry.message,
                "timestamp": entry.created_at,
            })
        })
        .collect::<Vec<_>>();
    let job_values = if jobs_changed {
        jobs.iter().map(JobRow::as_report_value).collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    let (box_values, pallet_values) = if containers_changed {
        (
            containers.boxes.iter().map(|row| row.as_report_value(station_uuid, "box")).collect::<Vec<_>>(),
            containers.pallets.iter().map(|row| row.as_report_value(station_uuid, "pallet")).collect::<Vec<_>>(),
        )
    } else {
        (Vec::new(), Vec::new())
    };
    let label_count = printed_labels.len();
    let deleted_count = deleted_labels.len();
    let log_count = log_values.len();
    let job_count = job_values.len();
    let container_count = box_values.len() + pallet_values.len();
    Ok(DeltaReport {
        payload: json!({
            "station_uuid": identity.get("station_uuid").cloned().unwrap_or(Value::Null),
            "station_fingerprint": crate::station_fingerprint::station_fingerprint(),
            "station_identity": identity,
            "client_version": env!("CARGO_PKG_VERSION"),
            "printed_labels": printed_labels,
            "deleted_labels": deleted_labels,
            "logs": log_values,
            "print_jobs": job_values,
            "boxes": box_values,
            "pallets": pallet_values,
            "report_id": Uuid::new_v4().to_string(),
            "generated_at": now_rfc3339(),
        }),
        cursor: next,
        label_count,
        deleted_count,
        log_count,
        job_count,
        container_count,
    })
}

#[derive(Debug)]
struct PackRow {
    id: i64,
    number: String,
    created_at: Option<String>,
    nomenclature_id: i64,
    weight_netto: Option<f64>,
    weight_brutto: Option<f64>,
    barcode_value: Option<String>,
    status: String,
    production_date: Option<String>,
    expiration_date: Option<String>,
    batch: Option<String>,
    operator_name: Option<String>,
    deleted_at: Option<String>,
    box_id: i64,
    box_number: Option<String>,
}

impl PackRow {
    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get(0)?,
            number: row.get(1)?,
            created_at: row.get(2)?,
            nomenclature_id: row.get(3)?,
            weight_netto: row.get(4)?,
            weight_brutto: row.get(5)?,
            barcode_value: row.get(6)?,
            status: row.get(7)?,
            production_date: row.get(8)?,
            expiration_date: row.get(9)?,
            batch: row.get(10)?,
            operator_name: row.get(11)?,
            deleted_at: row.get(12)?,
            box_id: row.get(13)?,
            box_number: row.get(14)?,
        })
    }

    fn as_report_value(&self, station_uuid: &str) -> Value {
        json!({
            "unique_id": format!("{station_uuid}-pack-{}", self.id),
            // The station's own pack row, not the server's tare (Pack): sent as "pack_id" the
            // server linked the label to whichever tare had that number.
            "station_pack_id": self.id,
            "product_id": self.nomenclature_id,
            "user_name": self.operator_name.as_deref().unwrap_or(""),
            "pack_name": self.number,
            "printed_at": self.created_at,
            "weight_netto_grams": self.weight_netto.map(kilograms_to_grams),
            "weight_brutto_grams": self.weight_brutto.map(kilograms_to_grams),
            "batch": self.batch,
            "production_date": self.production_date,
            "expiration_date": self.expiration_date,
            "barcode": self.barcode_value,
            "box_number": self.box_number,
            "deleted_at": self.deleted_at,
        })
    }
}

#[derive(Debug)]
struct LogRow {
    id: i64,
    event_uid: String,
    level: String,
    component: String,
    message: String,
    created_at: String,
}

#[derive(Debug)]
struct JobRow {
    job_id: i64,
    printed_qty: f64,
    status: String,
    completed_at: Option<String>,
}

impl JobRow {
    fn as_report_value(&self) -> Value {
        json!({
            "job_id": self.job_id,
            "printed_qty": self.printed_qty,
            "status": self.status,
            "completed_at": self.completed_at,
        })
    }
}

fn query_pack_rows<P>(connection: &Connection, sql: &str, parameters: P) -> Result<Vec<PackRow>, String>
where
    P: rusqlite::Params,
{
    let mut statement = connection
        .prepare(sql)
        .map_err(|error| format!("failed to prepare report pack query: {error}"))?;
    let rows = statement
        .query_map(parameters, PackRow::from_row)
        .map_err(|error| format!("failed to query report packs: {error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("failed to read report packs: {error}"))
}

fn query_log_rows(connection: &Connection, last_error_id: i64) -> Result<Vec<LogRow>, String> {
    let mut statement = connection
        .prepare(
            "SELECT id, event_uid, level, COALESCE(component, ''), message, created_at FROM print_errors WHERE id > ?1 ORDER BY id LIMIT ?2",
        )
        .map_err(|error| format!("failed to prepare report log query: {error}"))?;
    let rows = statement
        .query_map(params![last_error_id, MAX_REPORT_LOGS as i64], |row| {
            Ok(LogRow {
                id: row.get(0)?,
                event_uid: row.get(1)?,
                level: row.get(2)?,
                component: row.get(3)?,
                message: row.get(4)?,
                created_at: row.get(5)?,
            })
        })
        .map_err(|error| format!("failed to query report logs: {error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("failed to read report logs: {error}"))
}

fn query_job_rows(connection: &Connection) -> Result<Vec<JobRow>, String> {
    let mut statement = connection
        .prepare(
            "SELECT job_id, printed_qty, status, completed_at FROM print_jobs WHERE status IN ('in_progress', 'completed') ORDER BY job_id DESC LIMIT ?1",
        )
        .map_err(|error| format!("failed to prepare report job query: {error}"))?;
    let rows = statement
        .query_map(params![MAX_REPORT_JOBS as i64], |row| {
            Ok(JobRow {
                job_id: row.get(0)?,
                printed_qty: row.get(1)?,
                status: row.get(2)?,
                completed_at: row.get(3)?,
            })
        })
        .map_err(|error| format!("failed to query report jobs: {error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("failed to read report jobs: {error}"))
}

fn digest_jobs(jobs: &[JobRow]) -> String {
    short_digest(
        &jobs
            .iter()
            .map(|job| format!("{}|{}|{};", job.job_id, job.printed_qty, job.status))
            .collect::<String>(),
    )
}

fn short_digest(text: &str) -> String {
    Sha256::digest(text.as_bytes())
        .iter()
        .take(12)
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// One box or pallet as the server keeps it (stations from 2.0.9). An open box counts its
/// packs live; a closed one carries the weights it was closed with; a deleted one, what it
/// held.
#[derive(Debug)]
struct ContainerRow {
    id: i64,
    number: String,
    created_at: String,
    changed_at: String,
    status: String,
    product_id: Option<i64>,
    product_name: Option<String>,
    capacity: Option<i64>,
    parent_id: Option<i64>,
    parent_number: Option<String>,
    packs: i64,
    boxes: i64,
    net: f64,
    gross: f64,
}

impl ContainerRow {
    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get(0)?,
            number: row.get(1)?,
            created_at: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
            changed_at: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
            status: row.get(4)?,
            product_id: row.get(5)?,
            product_name: row.get(6)?,
            capacity: row.get(7)?,
            parent_id: row.get(8)?,
            parent_number: row.get(9)?,
            packs: row.get(10)?,
            boxes: row.get(11)?,
            net: row.get(12)?,
            gross: row.get(13)?,
        })
    }

    fn as_report_value(&self, station_uuid: &str, level: &str) -> Value {
        // The creation time keeps the id unique after the station's database is reset.
        let stamp = self.created_at.chars().filter(char::is_ascii_digit).collect::<String>();
        json!({
            "unique_id": format!("{station_uuid}-{level}-{}-{stamp}", self.id),
            "number": self.number,
            "product_id": self.product_id,
            "product_name": self.product_name,
            "pallet_number": self.parent_number,
            "packs": self.packs,
            "boxes": self.boxes,
            "capacity": self.capacity.filter(|value| *value > 0),
            "weight_netto_grams": kilograms_to_grams(self.net),
            "weight_brutto_grams": kilograms_to_grams(self.gross),
            "opened_at": sqlite_utc(&self.created_at),
            "closed_at": (self.status == "Closed").then(|| sqlite_utc(&self.changed_at)),
            "deleted_at": (self.status == "Deleted").then(|| sqlite_utc(&self.changed_at)),
        })
    }

    fn digest_line(&self) -> String {
        format!(
            "{}|{}|{}|{}|{}|{}|{};",
            self.id, self.status, self.packs, self.boxes, self.net, self.gross, self.changed_at
        )
    }
}

struct Containers {
    boxes: Vec<ContainerRow>,
    pallets: Vec<ContainerRow>,
    /// The next cursor: the latest change among the rows read (the old cursor when none).
    changed_at: String,
    /// Everything read this time; and only the rows the next read sees again unchanged.
    digest_all: String,
    digest_at_cursor: String,
}

// Columns shared by both reads: id, number, created_at, changed_at, status, product id and
// name, capacity, parent id and number, packs, boxes, net kg, gross kg. A station that has
// never reported containers starts with the last 30 days.
const BOX_QUERY: &str = r#"
    SELECT b.id, b.number, b.created_at, COALESCE(b.updated_at, b.created_at), b.status,
           b.nomenclature_id, n.name, n.close_box_counter, b.pallete_id, p.number,
           (SELECT COUNT(*) FROM pack k WHERE k.box_id = b.id AND (k.status != 'Deleted' OR b.status = 'Deleted')),
           0,
           CASE WHEN b.status = 'Closed' AND b.weight_netto IS NOT NULL THEN b.weight_netto
                ELSE (SELECT COALESCE(SUM(k.weight_netto), 0) FROM pack k
                      WHERE k.box_id = b.id AND (k.status != 'Deleted' OR b.status = 'Deleted')) END,
           CASE WHEN b.status = 'Closed' AND b.weight_brutto IS NOT NULL THEN b.weight_brutto
                ELSE (SELECT COALESCE(SUM(k.weight_brutto), 0) FROM pack k
                      WHERE k.box_id = b.id AND (k.status != 'Deleted' OR b.status = 'Deleted')) END
    FROM boxes b
    LEFT JOIN pallet p ON p.id = b.pallete_id
    LEFT JOIN nomenclature n ON n.id = b.nomenclature_id
    WHERE COALESCE(b.updated_at, b.created_at) >= COALESCE(NULLIF(?1, ''), datetime('now', '-30 days'))
       OR b.id IN (SELECT value FROM json_each(?2))
    ORDER BY COALESCE(b.updated_at, b.created_at), b.id
    LIMIT ?3
"#;

const PALLET_QUERY: &str = r#"
    WITH chosen AS (
        SELECT pl.id, pl.number, pl.created_at, COALESCE(pl.updated_at, pl.created_at) AS changed_at, pl.status,
               (SELECT CASE WHEN COUNT(DISTINCT b.nomenclature_id) = 1 THEN MIN(b.nomenclature_id) END
                  FROM boxes b WHERE b.pallete_id = pl.id AND b.status != 'Deleted') AS product_id
        FROM pallet pl
        WHERE COALESCE(pl.updated_at, pl.created_at) >= COALESCE(NULLIF(?1, ''), datetime('now', '-30 days'))
           OR pl.id IN (SELECT value FROM json_each(?2))
        ORDER BY changed_at, pl.id
        LIMIT ?3
    )
    SELECT c.id, c.number, c.created_at, c.changed_at, c.status, c.product_id, n.name, NULL, NULL, NULL,
           (SELECT COUNT(*) FROM pack k JOIN boxes b ON b.id = k.box_id
             WHERE b.pallete_id = c.id AND b.status != 'Deleted' AND k.status != 'Deleted'),
           (SELECT COUNT(*) FROM boxes b WHERE b.pallete_id = c.id AND b.status != 'Deleted'
               AND EXISTS (SELECT 1 FROM pack k WHERE k.box_id = b.id AND k.status != 'Deleted')),
           (SELECT COALESCE(SUM(k.weight_netto), 0) FROM pack k JOIN boxes b ON b.id = k.box_id
             WHERE b.pallete_id = c.id AND b.status != 'Deleted' AND k.status != 'Deleted'),
           (SELECT COALESCE(SUM(k.weight_brutto), 0) FROM pack k JOIN boxes b ON b.id = k.box_id
             WHERE b.pallete_id = c.id AND b.status != 'Deleted' AND k.status != 'Deleted')
    FROM chosen c
    LEFT JOIN nomenclature n ON n.id = c.product_id
    ORDER BY c.changed_at, c.id
"#;

fn query_container_rows(
    connection: &Connection,
    sql: &str,
    since: &str,
    ids: &[i64],
) -> Result<Vec<ContainerRow>, String> {
    let ids = serde_json::to_string(ids).unwrap_or_else(|_| "[]".to_owned());
    let mut statement = connection
        .prepare(sql)
        .map_err(|error| format!("failed to prepare report container query: {error}"))?;
    let rows = statement
        .query_map(params![since, ids, MAX_REPORT_CONTAINERS as i64], ContainerRow::from_row)
        .map_err(|error| format!("failed to query report containers: {error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("failed to read report containers: {error}"))
}

/// The boxes and pallets changed since `since`, plus the boxes of the packs in this report
/// and the pallets of those boxes. Empty open ones are left out: the station discards them.
fn query_containers(connection: &Connection, since: &str, touched_boxes: &[i64]) -> Result<Containers, String> {
    let mut boxes = query_container_rows(connection, BOX_QUERY, since, touched_boxes)?;
    let pallet_ids = boxes.iter().filter_map(|row| row.parent_id).collect::<Vec<_>>();
    let mut pallets = query_container_rows(connection, PALLET_QUERY, since, &pallet_ids)?;
    let changed_at = boxes
        .iter()
        .chain(&pallets)
        .map(|row| row.changed_at.as_str())
        .chain([since])
        .max()
        .unwrap_or(since)
        .to_owned();
    boxes.retain(|row| row.packs > 0);
    pallets.retain(|row| row.packs > 0);
    let digest_all = short_digest(&boxes.iter().chain(&pallets).map(ContainerRow::digest_line).collect::<String>());
    // What the next read returns when nothing changes: the rows changed at the cursor and
    // the pallets of those boxes.
    let again = boxes.iter().filter(|row| row.changed_at >= changed_at).collect::<Vec<_>>();
    let parents = again.iter().filter_map(|row| row.parent_id).collect::<Vec<_>>();
    let digest_at_cursor = short_digest(
        &again
            .iter()
            .copied()
            .chain(pallets.iter().filter(|row| row.changed_at >= changed_at || parents.contains(&row.id)))
            .map(ContainerRow::digest_line)
            .collect::<String>(),
    );
    Ok(Containers { boxes, pallets, changed_at, digest_all, digest_at_cursor })
}

/// SQLite's CURRENT_TIMESTAMP ("2026-10-09 18:00:00", UTC) as RFC 3339.
fn sqlite_utc(value: &str) -> String {
    if value.is_empty() || value.contains('T') {
        return value.to_owned();
    }
    format!("{}Z", value.replacen(' ', "T", 1))
}

pub fn upload_report(client: &Client, base_url: &str, blob: &[u8], language: &str) -> UploadResult {
    let part = match Part::bytes(blob.to_vec())
        .file_name("report.lpr")
        .mime_str("application/octet-stream")
    {
        Ok(part) => part,
        Err(_) => return UploadResult::Retryable,
    };
    let response = client
        .post(format!("{base_url}/stations/upload_report/"))
        .header("X-Lang", language)
        .multipart(Form::new().part("file", part))
        .send();
    match response {
        Ok(response) if response.status().is_success() => UploadResult::Sent,
        Ok(response) if response.status().is_server_error() => UploadResult::Retryable,
        Ok(response) => UploadResult::Rejected(response.status().as_u16()),
        Err(_) => UploadResult::Retryable,
    }
}

/// What one delivery cycle did (for the station's log line and tests).
#[derive(Debug, Default, Eq, PartialEq)]
pub struct Delivery {
    pub labels: usize,
    pub deleted: usize,
    pub logs: usize,
    pub jobs: usize,
    pub containers: usize,
    pub sent: bool,
    pub queued_sent: usize,
}

/// One delivery cycle: flush queued reports, then build the next delta and send it
/// online (or queue it when the server is unreachable). `base_url` is None while no
/// server is configured — the report is then only queued (for later or for USB).
pub fn deliver(
    persisted: &PersistedState,
    client: Option<&Client>,
    base_url: Option<&str>,
    language: &str,
) -> Result<Delivery, String> {
    let data_dir = persisted.data_dir().to_path_buf();
    let outbox = data_dir.join(OUTBOX_DIRECTORY);
    let cursor_path = data_dir.join(CURSOR_FILE);
    let mut delivery = Delivery::default();
    let online = match (client, base_url) {
        (Some(client), Some(base)) => Some((client, base)),
        _ => None,
    };

    let mut server_reachable = online.is_some();
    if let Some((client, base)) = online {
        let (sent, reachable) = flush_outbox(client, base, &outbox, language)?;
        delivery.queued_sent = sent;
        server_reachable = reachable;
    }

    let report = build_delta_report(persisted, &load_cursor(&cursor_path)?)?;
    if report.is_empty() {
        return Ok(delivery);
    }
    if persisted.load_license_token().is_none() || persisted.load_identity().is_none() {
        // Not activated yet: keep the rows in the station DB until it is.
        return Ok(delivery);
    }
    delivery.labels = report.label_count;
    delivery.deleted = report.deleted_count;
    delivery.logs = report.log_count;
    delivery.jobs = report.job_count;
    delivery.containers = report.container_count;

    let blob = encrypt_report(persisted, &report.payload)?;
    if blob.len() as u64 > MAX_REPORT_BYTES {
        return Err(format!("encrypted report is {} bytes (limit {MAX_REPORT_BYTES})", blob.len()));
    }
    let result = match online {
        Some((client, base)) if server_reachable => upload_report(client, base, &blob, language),
        _ => UploadResult::Retryable,
    };
    match result {
        UploadResult::Sent => {
            save_cursor(&cursor_path, &report.cursor)?;
            delivery.sent = true;
        }
        UploadResult::Retryable => {
            let path = spool_blob(&outbox, &blob)?;
            if let Err(error) = save_cursor(&cursor_path, &report.cursor) {
                let _ = fs::remove_file(&path);
                return Err(error);
            }
        }
        UploadResult::Rejected(status) => {
            // Kept aside (USB upload or support can still use it); the queue moves on.
            spool_blob(&outbox.join(REJECTED_DIRECTORY), &blob)?;
            save_cursor(&cursor_path, &report.cursor)?;
            prune_reported_logs(persisted, report.cursor.last_error_id)?;
            return Err(format!("server rejected the production report with HTTP {status}"));
        }
    }
    prune_reported_logs(persisted, report.cursor.last_error_id)?;
    Ok(delivery)
}

/// Sends queued reports oldest first. Returns (delivered, server reachable).
pub fn flush_outbox(client: &Client, base_url: &str, outbox: &Path, language: &str) -> Result<(usize, bool), String> {
    let mut files = outbox_files(outbox)?;
    files.truncate(MAX_FLUSH_FILES);
    let mut sent = 0;
    for path in files {
        let blob = read_bounded(&path, MAX_REPORT_BYTES)?;
        match upload_report(client, base_url, &blob, language) {
            UploadResult::Sent => {
                fs::remove_file(&path)
                    .map_err(|error| format!("failed to remove delivered report {}: {error}", path.display()))?;
                sent += 1;
            }
            UploadResult::Retryable => return Ok((sent, false)),
            UploadResult::Rejected(_) => {
                let rejected = outbox.join(REJECTED_DIRECTORY);
                fs::create_dir_all(&rejected)
                    .map_err(|error| format!("failed to create {}: {error}", rejected.display()))?;
                let target = rejected.join(path.file_name().unwrap_or_default());
                fs::rename(&path, &target)
                    .map_err(|error| format!("failed to set aside rejected report {}: {error}", path.display()))?;
            }
        }
    }
    Ok((sent, true))
}

pub fn spool_blob(outbox: &Path, blob: &[u8]) -> Result<PathBuf, String> {
    if blob.len() as u64 > MAX_REPORT_BYTES {
        return Err(format!("report exceeds the {MAX_REPORT_BYTES}-byte spool limit"));
    }
    fs::create_dir_all(outbox)
        .map_err(|error| format!("failed to create report outbox {}: {error}", outbox.display()))?;
    let (files, bytes) = outbox_usage(outbox)?;
    if files >= MAX_OUTBOX_FILES || bytes.saturating_add(blob.len() as u64) > MAX_OUTBOX_BYTES {
        return Err(format!("report outbox limit reached: {files} files, {bytes} bytes"));
    }
    let name = format!(
        "report_{}_{}.lpr",
        OffsetDateTime::now_utc().unix_timestamp_nanos(),
        Uuid::new_v4()
    );
    let path = outbox.join(name);
    atomic_write(&path, blob)?;
    Ok(path)
}

pub fn outbox_files(outbox: &Path) -> Result<Vec<PathBuf>, String> {
    if !outbox.exists() {
        return Ok(Vec::new());
    }
    let mut files = fs::read_dir(outbox)
        .map_err(|error| format!("failed to list report outbox {}: {error}", outbox.display()))?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("lpr"))
        .collect::<Vec<_>>();
    files.sort();
    Ok(files)
}

pub fn outbox_usage(outbox: &Path) -> Result<(usize, u64), String> {
    let files = outbox_files(outbox)?;
    let bytes = files.iter().try_fold(0_u64, |sum, path| {
        fs::metadata(path)
            .map(|metadata| sum.saturating_add(metadata.len()))
            .map_err(|error| format!("failed to inspect queued report {}: {error}", path.display()))
    })?;
    Ok((files.len(), bytes))
}

pub fn load_cursor(path: &Path) -> Result<ReportCursor, String> {
    if !path.exists() {
        return Ok(ReportCursor::default());
    }
    let bytes = read_bounded(path, 64 * 1024)?;
    serde_json::from_slice(&bytes)
        .map_err(|error| format!("failed to parse report cursor {}: {error}", path.display()))
}

pub fn save_cursor(path: &Path, cursor: &ReportCursor) -> Result<(), String> {
    let bytes = serde_json::to_vec(cursor).map_err(|error| format!("failed to serialize report cursor: {error}"))?;
    atomic_write(path, &bytes)
}

pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("failed to create {}: {error}", parent.display()))?;
    }
    let temporary = path.with_extension(format!("{}.tmp", Uuid::new_v4()));
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)
        .map_err(|error| format!("failed to create {}: {error}", temporary.display()))?;
    if let Err(error) = file.write_all(bytes).and_then(|_| file.sync_all()) {
        let _ = fs::remove_file(&temporary);
        return Err(format!("failed to write {}: {error}", temporary.display()));
    }
    if path.exists() {
        fs::remove_file(path).map_err(|error| format!("failed to replace {}: {error}", path.display()))?;
    }
    fs::rename(&temporary, path).map_err(|error| format!("failed to publish {}: {error}", path.display()))
}

pub fn read_bounded(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    let metadata = fs::metadata(path).map_err(|error| format!("failed to inspect {}: {error}", path.display()))?;
    if metadata.len() > limit {
        return Err(format!("{} exceeds the {limit}-byte limit", path.display()));
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    File::open(path)
        .and_then(|file| file.take(limit + 1).read_to_end(&mut bytes))
        .map_err(|error| format!("failed to read {}: {error}", path.display()))?;
    if bytes.len() as u64 > limit {
        return Err(format!("{} exceeds the {limit}-byte limit", path.display()));
    }
    Ok(bytes)
}

pub fn prune_reported_logs(persisted: &PersistedState, reported_id: i64) -> Result<(), String> {
    if reported_id <= RETAIN_REPORTED_LOG_ROWS {
        return Ok(());
    }
    let connection = open_database(persisted)?;
    connection
        .execute(
            "DELETE FROM print_errors WHERE id <= ?1 AND id < (SELECT COALESCE(MAX(id), 0) - ?2 FROM print_errors)",
            params![reported_id, RETAIN_REPORTED_LOG_ROWS],
        )
        .map(|_| ())
        .map_err(|error| format!("failed to prune reported logs: {error}"))
}

// ─── Hooks for the rest of the station ───────────────────────────────────────
// Code that records labels, job steps or errors calls these without knowing whether a
// reporter runs: the Slint reporter installs the wake hook and the error journal.

/// Called with `true` for news to send in a moment, `false` for news to batch.
static WAKE_HOOK: OnceLock<Box<dyn Fn(bool) + Send + Sync>> = OnceLock::new();
static ERROR_JOURNAL: OnceLock<OperationalState> = OnceLock::new();
static OPEN_FAULTS: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();

pub fn set_wake_hook(hook: impl Fn(bool) + Send + Sync + 'static) {
    let _ = WAKE_HOOK.set(Box::new(hook));
}

pub fn set_error_journal(operational: OperationalState) {
    let _ = ERROR_JOURNAL.set(operational);
}

/// Something the server should know soon (an error, a finished job): sent in a moment.
pub fn poke() {
    if let Some(hook) = WAKE_HOOK.get() {
        hook(true);
    }
}

/// New labels or job steps: sent together a little later. A busy line prints a pack every
/// few seconds, and one report per pack would flood the server and its event list.
pub fn poke_labels() {
    if let Some(hook) = WAKE_HOOK.get() {
        hook(false);
    }
}

/// Journal an error of a station subsystem and send it to the server soon.
pub fn record_error(component: &str, message: &str) {
    record(component, "ERROR", message);
}

pub fn record_warning(component: &str, message: &str) {
    record(component, "WARNING", message);
}

fn record(component: &str, level: &str, message: &str) {
    if let Some(journal) = ERROR_JOURNAL.get() {
        if journal.record_station_error(component, level, message) {
            poke();
        }
    }
}

/// A lasting fault of a subsystem (printer out of paper, update failing): journaled once
/// when it starts or changes, not on every status poll; `None` ends it, journaled as INFO.
pub fn report_fault(component: &str, fault: Option<&str>) {
    let faults = OPEN_FAULTS.get_or_init(|| Mutex::new(HashMap::new()));
    let Ok(mut open) = faults.lock() else { return };
    match fault {
        Some(message) if open.get(component).map(String::as_str) != Some(message) => {
            open.insert(component.to_owned(), message.to_owned());
            drop(open);
            record_error(component, message);
        }
        Some(_) => {}
        None => {
            if open.remove(component).is_some() {
                drop(open);
                record(component, "INFO", &fault_cleared_message(component));
            }
        }
    }
}

fn fault_cleared_message(component: &str) -> String {
    match component {
        "printer" => "Принтер: снова готов к печати".to_owned(),
        "scale" => "Весы: снова в работе".to_owned(),
        "update" => "Обновление: ошибка устранена".to_owned(),
        other => format!("{other}: снова в работе"),
    }
}

/// Which subsystem an on-screen station alert belongs to, from its "Area: detail"
/// prefix. Plain operator hints ("Выберите товар перед печатью") have no prefix and are
/// not station errors, so they are not reported.
pub fn alert_component(message: &str) -> Option<&'static str> {
    if message.starts_with("Нативный runtime") {
        return Some("app");
    }
    let (area, detail) = message.split_once(": ")?;
    if detail.trim().is_empty() {
        return None;
    }
    let component = match area {
        "Настройки принтера" | "Определение принтера" | "Тестовая печать" | "Настройки принтеров"
        | "Очередь печати" => "printer",
        "Настройки весов" | "Проверка весов" | "Фиксированный вес" => "scale",
        "Обновление данных" => "sync",
        "Пакетная печать" | "Задания печати" | "Задание печати" | "Операция с заданием" => "print",
        "Сервер и лицензия" | "Адрес сервера" => "license",
        "Каталог товаров" | "Поиск товаров" | "Удаление" | "Диагностика" | "Демо-режим"
        | "Смена оператора" | "Сессия оператора" => "app",
        _ if area.starts_with("Операция ") => "app",
        _ => return None,
    };
    Some(component)
}

pub fn kilograms_to_grams(value: f64) -> i64 {
    (value * 1_000.0).round() as i64
}

pub fn now_rfc3339() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| OffsetDateTime::now_utc().unix_timestamp().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    fn fixture() -> (PathBuf, PersistedState) {
        let root = env::temp_dir().join(format!("labelpilot-report-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let persisted = PersistedState::for_data_dir(root.clone());
        open_database(&persisted).unwrap();
        (root, persisted)
    }

    fn seed_job(connection: &Connection, job_id: i64, printed: f64, status: &str) {
        connection
            .execute(
                "INSERT INTO print_jobs (job_id, nomenclature_id, nomenclature_name, quantity, printed_qty, status) VALUES (?1, 1, 'Ham', 10, ?2, ?3)",
                params![job_id, printed, status],
            )
            .unwrap();
    }

    #[test]
    fn job_progress_is_reported_only_when_it_changes() {
        let (root, persisted) = fixture();
        let connection = open_database(&persisted).unwrap();
        seed_job(&connection, 7, 4.0, "in_progress");
        seed_job(&connection, 8, 0.0, "pending");

        let first = build_delta_report(&persisted, &ReportCursor::default()).unwrap();
        assert_eq!(first.job_count, 1);
        assert_eq!(first.payload["print_jobs"][0]["job_id"], 7);
        assert_eq!(first.payload["client_version"], env!("CARGO_PKG_VERSION"));

        let again = build_delta_report(&persisted, &first.cursor).unwrap();
        assert!(again.is_empty());

        connection
            .execute("UPDATE print_jobs SET printed_qty = 10, status = 'completed' WHERE job_id = 7", [])
            .unwrap();
        let changed = build_delta_report(&persisted, &again.cursor).unwrap();
        assert_eq!(changed.payload["print_jobs"][0]["status"], "completed");
        let _ = fs::remove_dir_all(root);
    }

    fn seed_box(connection: &Connection, packs: usize) {
        connection
            .execute_batch(
                "INSERT INTO nomenclature(id, name, article, exp_date, close_box_counter) VALUES (1, 'Ham', 'A1', 10, 6);
                 INSERT INTO pallet(id, number, status) VALUES (1, 'P1', 'Open');
                 INSERT INTO boxes(id, pallete_id, number, status, nomenclature_id) VALUES (1, 1, 'B-0288', 'Open', 1);",
            )
            .unwrap();
        for index in 0..packs {
            connection
                .execute(
                    "INSERT INTO pack(number, box_id, nomenclature_id, weight_netto, weight_brutto, status) VALUES (?1, 1, 1, 0.4, 0.42, 'Printed')",
                    params![format!("U{index}")],
                )
                .unwrap();
        }
    }

    #[test]
    fn boxes_and_pallets_are_reported_when_they_change() {
        let (root, persisted) = fixture();
        let connection = open_database(&persisted).unwrap();
        seed_box(&connection, 2);

        let first = build_delta_report(&persisted, &ReportCursor::default()).unwrap();
        assert_eq!(first.payload["printed_labels"][0]["box_number"], "B-0288");
        let open = &first.payload["boxes"][0];
        assert_eq!(open["number"], "B-0288");
        assert_eq!((open["packs"].as_i64(), open["capacity"].as_i64()), (Some(2), Some(6)));
        assert_eq!((open["weight_netto_grams"].as_i64(), open["pallet_number"].as_str()), (Some(800), Some("P1")));
        assert!(open["closed_at"].is_null());
        assert!(open["opened_at"].as_str().unwrap().ends_with('Z'));
        let pallet = &first.payload["pallets"][0];
        assert_eq!((pallet["boxes"].as_i64(), pallet["packs"].as_i64(), pallet["product_name"].as_str()), (Some(1), Some(2), Some("Ham")));

        let quiet = build_delta_report(&persisted, &first.cursor).unwrap();
        assert!(quiet.is_empty(), "nothing changed, nothing re-sent: {}", quiet.payload);

        // A new pack changes its box without touching the box row.
        connection
            .execute(
                "INSERT INTO pack(number, box_id, nomenclature_id, weight_netto, weight_brutto, status) VALUES ('U9', 1, 1, 0.4, 0.42, 'Printed')",
                [],
            )
            .unwrap();
        let grown = build_delta_report(&persisted, &quiet.cursor).unwrap();
        assert_eq!(grown.payload["boxes"][0]["packs"].as_i64(), Some(3));

        connection
            .execute(
                "UPDATE boxes SET status = 'Closed', weight_netto = 1.2, weight_brutto = 1.6, updated_at = datetime('now', '+1 second') WHERE id = 1",
                [],
            )
            .unwrap();
        let closed = build_delta_report(&persisted, &grown.cursor).unwrap();
        let closed_box = &closed.payload["boxes"][0];
        assert_eq!(closed_box["weight_brutto_grams"].as_i64(), Some(1600));
        assert!(closed_box["closed_at"].as_str().unwrap().ends_with('Z'));
        assert_eq!(closed_box["unique_id"], first.payload["boxes"][0]["unique_id"]);
        assert!(build_delta_report(&persisted, &closed.cursor).unwrap().is_empty());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn an_empty_open_box_is_not_reported_but_a_deleted_one_is() {
        let (root, persisted) = fixture();
        let connection = open_database(&persisted).unwrap();
        seed_box(&connection, 0);
        let empty = build_delta_report(&persisted, &ReportCursor::default()).unwrap();
        assert!(empty.is_empty(), "{}", empty.payload);

        connection
            .execute(
                "INSERT INTO pack(number, box_id, nomenclature_id, weight_netto, weight_brutto, status, deleted_at) VALUES ('U1', 1, 1, 0.4, 0.42, 'Deleted', '2026-10-09 10:00:00.000')",
                [],
            )
            .unwrap();
        connection
            .execute("UPDATE boxes SET status = 'Deleted', updated_at = datetime('now', '+1 second') WHERE id = 1", [])
            .unwrap();
        let deleted = build_delta_report(&persisted, &empty.cursor).unwrap();
        let gone = &deleted.payload["boxes"][0];
        assert_eq!((gone["packs"].as_i64(), gone["weight_netto_grams"].as_i64()), (Some(1), Some(400)));
        assert!(gone["deleted_at"].as_str().is_some());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn logs_carry_their_component() {
        let (root, persisted) = fixture();
        let connection = open_database(&persisted).unwrap();
        connection
            .execute(
                "INSERT INTO print_errors (event_uid, level, component, message, created_at) VALUES ('e1', 'ERROR', 'scale', 'нет ответа', '2026-10-05T10:00:00Z')",
                [],
            )
            .unwrap();
        let report = build_delta_report(&persisted, &ReportCursor::default()).unwrap();
        assert_eq!(report.payload["logs"][0]["component"], "scale");
        assert_eq!(report.cursor.last_error_id, 1);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn alerts_map_to_subsystems_and_hints_stay_local() {
        assert_eq!(alert_component("Настройки принтера: timeout"), Some("printer"));
        assert_eq!(alert_component("Проверка весов: нет ответа"), Some("scale"));
        assert_eq!(alert_component("Обновление данных: ошибка"), Some("sync"));
        assert_eq!(alert_component("Операция закрыть короб: занято"), Some("app"));
        assert_eq!(alert_component("Выберите товар перед печатью"), None);
        assert_eq!(alert_component("Дождитесь стабильного допустимого веса"), None);
    }

    #[test]
    fn repeated_errors_are_journaled_once_per_window() {
        let (root, persisted) = fixture();
        let operational = OperationalState::new(&persisted).unwrap();
        assert!(operational.record_station_error("scale", "ERROR", "нет ответа"));
        assert!(!operational.record_station_error("scale", "ERROR", "нет ответа"));
        assert!(operational.record_station_error("printer", "ERROR", "нет ответа"));
        let report = build_delta_report(&persisted, &ReportCursor::default()).unwrap();
        assert_eq!(report.log_count, 2);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn outbox_is_atomic_and_accounted() {
        let root = env::temp_dir().join(format!("labelpilot-outbox-{}", Uuid::new_v4()));
        let path = spool_blob(&root, b"encrypted-report").unwrap();
        assert!(path.exists());
        assert_eq!(outbox_usage(&root).unwrap(), (1, 16));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn without_a_server_nothing_is_sent_and_nothing_is_lost() {
        let (root, persisted) = fixture();
        let delivery = deliver(&persisted, None, None, "ru").unwrap();
        assert_eq!(delivery, Delivery::default());
        let _ = fs::remove_dir_all(root);
    }
}
