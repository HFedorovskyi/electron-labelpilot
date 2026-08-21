use crate::commands::RuntimeState;
use crate::crypto::encrypt_report;
use crate::generator::GeneratorState;
use crate::ingress::IngressState;
use crate::network::{server_base_url, ConnectionStatus, NetworkState};
use crate::persisted::PersistedState;
use crate::printer::PrinterTransportState;
use crate::processor::open_database;
use crate::scale::ScaleState;
use reqwest::blocking::multipart::{Form, Part};
use rusqlite::{params, Connection, Row};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::env;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};
use time::{format_description::well_known::Rfc3339, OffsetDateTime};
use uuid::Uuid;

const OUTBOX_DIRECTORY: &str = "outbox";
const CURSOR_FILE: &str = "report_state.json";
const MAX_OUTBOX_FILES: usize = 256;
const MAX_OUTBOX_BYTES: u64 = 256 * 1024 * 1024;
const MAX_REPORT_BYTES: u64 = 64 * 1024 * 1024;
const MAX_REPORT_PACKS: usize = 2_000;
const MAX_REPORT_DELETIONS: usize = 2_000;
const MAX_REPORT_LOGS: usize = 500;
const MAX_FLUSH_FILES: usize = 32;
const MAX_EVENT_MESSAGE_BYTES: usize = 16 * 1024;
const RETAIN_REPORTED_LOG_ROWS: i64 = 10_000;
const DEFAULT_INTERVAL: Duration = Duration::from_secs(5 * 60);
const STARTUP_DELAY: Duration = Duration::from_secs(8);
const RECONNECT_POLL: Duration = Duration::from_secs(2);

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReportCursor {
    last_pack_id: i64,
    last_error_id: i64,
    last_deleted_at: String,
    last_deleted_id: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetrySummary {
    pub worker_running: bool,
    pub auto_report_enabled: bool,
    pub interval_ms: u64,
    pub uptime_ms: u64,
    pub recorded_events: u64,
    pub report_cycles: u64,
    pub sent_reports: u64,
    pub spooled_reports: u64,
    pub retried_reports: u64,
    pub failed_reports: u64,
    pub deferred_without_identity: u64,
    pub pending_files: usize,
    pub pending_bytes: u64,
    pub outbox_file_limit: usize,
    pub outbox_byte_limit: u64,
    pub last_success_at: Option<String>,
    pub last_error: Option<String>,
}

#[derive(Default)]
struct TelemetryStats {
    recorded_events: AtomicU64,
    report_cycles: AtomicU64,
    sent_reports: AtomicU64,
    spooled_reports: AtomicU64,
    retried_reports: AtomicU64,
    failed_reports: AtomicU64,
    deferred_without_identity: AtomicU64,
}

struct TelemetryInner {
    data_dir: PathBuf,
    started: Instant,
    interval: Duration,
    stop: AtomicBool,
    wake: (Mutex<bool>, Condvar),
    worker: Mutex<Option<JoinHandle<()>>>,
    cycle_guard: Mutex<()>,
    stats: TelemetryStats,
    last_success_at: Mutex<Option<String>>,
    last_error: Mutex<Option<String>>,
}

#[derive(Clone)]
pub struct TelemetryState {
    inner: Arc<TelemetryInner>,
}

#[derive(Debug)]
struct DeltaReport {
    payload: Value,
    cursor: ReportCursor,
    label_count: usize,
    deleted_count: usize,
    log_count: usize,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum UploadResult {
    Sent,
    Retryable,
    Rejected(u16),
}

impl TelemetryState {
    pub fn new(data_dir: PathBuf) -> Self {
        Self {
            inner: Arc::new(TelemetryInner {
                data_dir,
                started: Instant::now(),
                interval: configured_interval(),
                stop: AtomicBool::new(false),
                wake: (Mutex::new(false), Condvar::new()),
                worker: Mutex::new(None),
                cycle_guard: Mutex::new(()),
                stats: TelemetryStats::default(),
                last_success_at: Mutex::new(None),
                last_error: Mutex::new(None),
            }),
        }
    }

    pub fn start(&self, app: AppHandle) -> Result<(), String> {
        let mut worker = self
            .inner
            .worker
            .lock()
            .map_err(|_| "telemetry worker lock is poisoned".to_owned())?;
        if worker.is_some() {
            return Ok(());
        }
        self.inner.stop.store(false, Ordering::Release);
        self.record_event(
            &app,
            "INFO",
            "runtime",
            "runtime_started",
            json!({ "version": app.package_info().version.to_string() }),
        )?;
        let state = self.clone();
        *worker = Some(
            thread::Builder::new()
                .name("labelpilot-telemetry".to_owned())
                .spawn(move || run_worker(state, app))
                .map_err(|error| format!("failed to start telemetry worker: {error}"))?,
        );
        Ok(())
    }

    pub fn shutdown(&self, app: &AppHandle) {
        self.inner.stop.store(true, Ordering::Release);
        self.request_flush();
        if let Ok(mut worker) = self.inner.worker.lock() {
            if let Some(handle) = worker.take() {
                let _ = handle.join();
            }
        }
        let _ = self.record_event(
            app,
            "INFO",
            "runtime",
            "runtime_stopped",
            json!({ "uptimeMs": self.inner.started.elapsed().as_millis() }),
        );
        if auto_report_enabled(app.state::<PersistedState>().load_printer_config()) {
            if let Err(error) = self.spool_pending(app, "shutdown") {
                self.note_failure(app, &error);
            }
        }
    }

    pub fn request_flush(&self) {
        let (flag, condition) = &self.inner.wake;
        if let Ok(mut wake) = flag.lock() {
            *wake = true;
            condition.notify_all();
        }
    }

    pub fn flush_now(&self, app: &AppHandle, reason: &str) -> Result<TelemetrySummary, String> {
        self.run_cycle(app, reason)?;
        Ok(self.summary(app))
    }

    pub fn summary(&self, app: &AppHandle) -> TelemetrySummary {
        let (pending_files, pending_bytes) = outbox_usage(&self.outbox_dir()).unwrap_or((0, 0));
        let printer_config = app.state::<PersistedState>().load_printer_config();
        TelemetrySummary {
            worker_running: self
                .inner
                .worker
                .lock()
                .map(|worker| worker.as_ref().is_some_and(|handle| !handle.is_finished()))
                .unwrap_or(false),
            auto_report_enabled: auto_report_enabled(printer_config),
            interval_ms: self.inner.interval.as_millis().min(u64::MAX as u128) as u64,
            uptime_ms: self
                .inner
                .started
                .elapsed()
                .as_millis()
                .min(u64::MAX as u128) as u64,
            recorded_events: self.inner.stats.recorded_events.load(Ordering::Acquire),
            report_cycles: self.inner.stats.report_cycles.load(Ordering::Acquire),
            sent_reports: self.inner.stats.sent_reports.load(Ordering::Acquire),
            spooled_reports: self.inner.stats.spooled_reports.load(Ordering::Acquire),
            retried_reports: self.inner.stats.retried_reports.load(Ordering::Acquire),
            failed_reports: self.inner.stats.failed_reports.load(Ordering::Acquire),
            deferred_without_identity: self
                .inner
                .stats
                .deferred_without_identity
                .load(Ordering::Acquire),
            pending_files,
            pending_bytes,
            outbox_file_limit: MAX_OUTBOX_FILES,
            outbox_byte_limit: MAX_OUTBOX_BYTES,
            last_success_at: self
                .inner
                .last_success_at
                .lock()
                .ok()
                .and_then(|value| value.clone()),
            last_error: self
                .inner
                .last_error
                .lock()
                .ok()
                .and_then(|value| value.clone()),
        }
    }

    pub fn record_event(
        &self,
        app: &AppHandle,
        level: &str,
        component: &str,
        event: &str,
        fields: Value,
    ) -> Result<(), String> {
        let persisted = app.state::<PersistedState>();
        let connection = open_database(&persisted)?;
        let message = event_message(
            app.package_info().version.to_string(),
            component,
            event,
            fields,
        );
        connection
            .execute(
                "INSERT INTO print_errors (event_uid, level, message, created_at) VALUES (?1, ?2, ?3, ?4)",
                params![
                    Uuid::new_v4().to_string(),
                    normalize_level(level),
                    message,
                    now_rfc3339(),
                ],
            )
            .map_err(|error| format!("failed to persist telemetry event: {error}"))?;
        self.inner
            .stats
            .recorded_events
            .fetch_add(1, Ordering::AcqRel);
        Ok(())
    }

    fn run_cycle(&self, app: &AppHandle, reason: &str) -> Result<(), String> {
        let _guard = self
            .inner
            .cycle_guard
            .lock()
            .map_err(|_| "telemetry cycle lock is poisoned".to_owned())?;
        let persisted = app.state::<PersistedState>();
        if !auto_report_enabled(persisted.load_printer_config()) {
            return Ok(());
        }
        self.inner
            .stats
            .report_cycles
            .fetch_add(1, Ordering::AcqRel);
        self.record_heartbeat(app, reason)?;

        if app.state::<NetworkState>().status() == ConnectionStatus::Connected {
            self.flush_outbox(app)?;
        }
        let report = build_delta_report(&persisted, &load_cursor(&self.cursor_path())?)?;
        if report.label_count == 0 && report.deleted_count == 0 && report.log_count == 0 {
            return Ok(());
        }
        if persisted.load_license_token().is_none() || persisted.load_identity().is_none() {
            self.inner
                .stats
                .deferred_without_identity
                .fetch_add(1, Ordering::AcqRel);
            let message =
                "production report deferred: station identity or license token is missing";
            let _ = app.state::<RuntimeState>().log("WARN", message);
            self.set_last_error(message);
            return Ok(());
        }

        let blob = encrypt_report(&persisted, &report.payload)?;
        if blob.len() as u64 > MAX_REPORT_BYTES {
            return Err(format!(
                "encrypted telemetry report is {} bytes (limit {MAX_REPORT_BYTES})",
                blob.len()
            ));
        }
        let config = persisted.load_printer_config();
        let sent = if app.state::<NetworkState>().status() == ConnectionStatus::Connected {
            match upload_blob(app, &blob, &config)? {
                UploadResult::Sent => true,
                UploadResult::Retryable => false,
                UploadResult::Rejected(status) => {
                    return Err(format!(
                        "server rejected telemetry report with HTTP {status}"
                    ));
                }
            }
        } else {
            false
        };
        if sent {
            save_cursor(&self.cursor_path(), &report.cursor)?;
            self.inner.stats.sent_reports.fetch_add(1, Ordering::AcqRel);
            self.note_success();
        } else {
            let path = spool_blob(&self.outbox_dir(), &blob)?;
            if let Err(error) = save_cursor(&self.cursor_path(), &report.cursor) {
                let _ = fs::remove_file(&path);
                return Err(error);
            }
            self.inner
                .stats
                .spooled_reports
                .fetch_add(1, Ordering::AcqRel);
        }
        prune_reported_logs(&persisted, report.cursor.last_error_id)?;
        let _ = app.state::<RuntimeState>().log(
            "INFO",
            &format!(
                "telemetry report({reason}): {} labels, {} deleted, {} logs -> {}",
                report.label_count,
                report.deleted_count,
                report.log_count,
                if sent { "sent" } else { "spooled" }
            ),
        );
        Ok(())
    }

    fn spool_pending(&self, app: &AppHandle, reason: &str) -> Result<(), String> {
        let _guard = self
            .inner
            .cycle_guard
            .lock()
            .map_err(|_| "telemetry cycle lock is poisoned".to_owned())?;
        let persisted = app.state::<PersistedState>();
        let cursor_path = self.cursor_path();
        let report = build_delta_report(&persisted, &load_cursor(&cursor_path)?)?;
        if report.label_count == 0 && report.deleted_count == 0 && report.log_count == 0 {
            return Ok(());
        }
        if persisted.load_license_token().is_none() || persisted.load_identity().is_none() {
            self.inner
                .stats
                .deferred_without_identity
                .fetch_add(1, Ordering::AcqRel);
            return Ok(());
        }
        let blob = encrypt_report(&persisted, &report.payload)?;
        let path = spool_blob(&self.outbox_dir(), &blob)?;
        if let Err(error) = save_cursor(&cursor_path, &report.cursor) {
            let _ = fs::remove_file(&path);
            return Err(error);
        }
        self.inner
            .stats
            .spooled_reports
            .fetch_add(1, Ordering::AcqRel);
        prune_reported_logs(&persisted, report.cursor.last_error_id)?;
        let _ = app.state::<RuntimeState>().log(
            "INFO",
            &format!("telemetry report({reason}) spooled during shutdown"),
        );
        Ok(())
    }

    fn flush_outbox(&self, app: &AppHandle) -> Result<(), String> {
        let config = app.state::<PersistedState>().load_printer_config();
        let mut files = outbox_files(&self.outbox_dir())?;
        files.truncate(MAX_FLUSH_FILES);
        for path in files {
            let blob = read_bounded(&path, MAX_REPORT_BYTES)?;
            match upload_blob(app, &blob, &config)? {
                UploadResult::Sent => {
                    fs::remove_file(&path).map_err(|error| {
                        format!(
                            "failed to remove delivered report {}: {error}",
                            path.display()
                        )
                    })?;
                    self.inner
                        .stats
                        .retried_reports
                        .fetch_add(1, Ordering::AcqRel);
                    self.note_success();
                }
                UploadResult::Retryable => break,
                UploadResult::Rejected(status) => {
                    return Err(format!(
                        "server rejected queued telemetry report {} with HTTP {status}",
                        path.display()
                    ));
                }
            }
        }
        Ok(())
    }

    fn record_heartbeat(&self, app: &AppHandle, reason: &str) -> Result<(), String> {
        let durable = app
            .state::<PrinterTransportState>()
            .durable_summary()
            .map(|value| serde_json::to_value(value).unwrap_or(Value::Null))
            .unwrap_or_else(|error| json!({ "error": bounded(&error, 512) }));
        let fields = json!({
            "reason": bounded(reason, 64),
            "uptimeMs": self.inner.started.elapsed().as_millis(),
            "network": app.state::<NetworkState>().summary(),
            "ingress": app.state::<IngressState>().summary(),
            "scale": app.state::<ScaleState>().summary(),
            "printerTransport": app.state::<PrinterTransportState>().summary(),
            "durablePrintQueue": durable,
            "generator": app.state::<GeneratorState>().summary(),
            "delivery": self.summary(app),
        });
        self.record_event(app, "INFO", "runtime", "heartbeat", fields)
    }

    fn note_success(&self) {
        if let Ok(mut value) = self.inner.last_success_at.lock() {
            *value = Some(now_rfc3339());
        }
        if let Ok(mut value) = self.inner.last_error.lock() {
            *value = None;
        }
    }

    fn note_failure(&self, app: &AppHandle, error: &str) {
        self.inner
            .stats
            .failed_reports
            .fetch_add(1, Ordering::AcqRel);
        self.set_last_error(error);
        let _ = app
            .state::<RuntimeState>()
            .log("ERROR", &format!("production telemetry: {error}"));
    }

    fn set_last_error(&self, error: &str) {
        if let Ok(mut value) = self.inner.last_error.lock() {
            *value = Some(bounded(error, 1_024));
        }
    }

    fn outbox_dir(&self) -> PathBuf {
        self.inner.data_dir.join(OUTBOX_DIRECTORY)
    }

    fn cursor_path(&self) -> PathBuf {
        self.inner.data_dir.join(CURSOR_FILE)
    }
}

pub fn record_subsystem_log(app: &AppHandle, component: &str, level: &str, message: &str) {
    if !matches!(normalize_level(level), "WARNING" | "ERROR") {
        return;
    }
    if let Some(telemetry) = app.try_state::<TelemetryState>() {
        let event = if normalize_level(level) == "ERROR" {
            "subsystem_error"
        } else {
            "subsystem_warning"
        };
        let _ = telemetry.record_event(
            app,
            level,
            component,
            event,
            json!({ "message": bounded(message, 2_000) }),
        );
    }
}

fn run_worker(state: TelemetryState, app: AppHandle) {
    let mut next_cycle = Instant::now() + STARTUP_DELAY;
    let mut connected = false;
    while !state.inner.stop.load(Ordering::Acquire) {
        let now = Instant::now();
        let wait_for = next_cycle
            .saturating_duration_since(now)
            .min(RECONNECT_POLL);
        let forced = wait_for_signal(&state.inner, wait_for);
        if state.inner.stop.load(Ordering::Acquire) {
            break;
        }
        let online = app.state::<NetworkState>().status() == ConnectionStatus::Connected;
        let reconnect = online && !connected;
        connected = online;
        if forced || reconnect || Instant::now() >= next_cycle {
            let reason = if forced {
                "manual"
            } else if reconnect {
                "reconnect"
            } else {
                "periodic"
            };
            if let Err(error) = state.run_cycle(&app, reason) {
                state.note_failure(&app, &error);
            }
            next_cycle = Instant::now() + state.inner.interval;
        }
    }
}

fn wait_for_signal(inner: &TelemetryInner, duration: Duration) -> bool {
    let (flag, condition) = &inner.wake;
    let Ok(wake) = flag.lock() else {
        thread::sleep(duration);
        return false;
    };
    let Ok((mut wake, _)) = condition.wait_timeout_while(wake, duration, |value| !*value) else {
        return false;
    };
    let forced = *wake;
    *wake = false;
    forced
}

fn build_delta_report(
    persisted: &PersistedState,
    cursor: &ReportCursor,
) -> Result<DeltaReport, String> {
    let connection = open_database(persisted)?;
    let packs = query_pack_rows(
        &connection,
        "SELECT id, number, created_at, nomenclature_id, weight_netto, weight_brutto, barcode_value, status, production_date, expiration_date, batch, operator_name, deleted_at FROM pack WHERE id > ?1 ORDER BY id LIMIT ?2",
        params![cursor.last_pack_id, MAX_REPORT_PACKS as i64],
    )?;
    let deletions = query_pack_rows(
        &connection,
        "SELECT id, number, created_at, nomenclature_id, weight_netto, weight_brutto, barcode_value, status, production_date, expiration_date, batch, operator_name, deleted_at FROM pack WHERE deleted_at IS NOT NULL AND (deleted_at > ?1 OR (deleted_at = ?1 AND id > ?2)) ORDER BY deleted_at, id LIMIT ?3",
        params![cursor.last_deleted_at, cursor.last_deleted_id, MAX_REPORT_DELETIONS as i64],
    )?;
    let logs = query_log_rows(&connection, cursor.last_error_id)?;
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
    let log_values = logs
        .iter()
        .map(|entry| {
            json!({
                "event_uid": entry.event_uid,
                "level": entry.level,
                "message": entry.message,
                "timestamp": entry.created_at,
            })
        })
        .collect::<Vec<_>>();
    let label_count = printed_labels.len();
    let deleted_count = deleted_labels.len();
    let log_count = log_values.len();
    Ok(DeltaReport {
        payload: json!({
            "station_uuid": identity.get("station_uuid").cloned().unwrap_or(Value::Null),
            "station_identity": identity,
            "printed_labels": printed_labels,
            "deleted_labels": deleted_labels,
            "logs": log_values,
            "report_id": Uuid::new_v4().to_string(),
            "generated_at": now_rfc3339(),
        }),
        cursor: next,
        label_count,
        deleted_count,
        log_count,
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
        })
    }

    fn as_report_value(&self, station_uuid: &str) -> Value {
        json!({
            "unique_id": format!("{station_uuid}-pack-{}", self.id),
            "pack_id": self.id,
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
            "deleted_at": self.deleted_at,
        })
    }
}

#[derive(Debug)]
struct LogRow {
    id: i64,
    event_uid: String,
    level: String,
    message: String,
    created_at: String,
}

fn query_pack_rows<P>(
    connection: &Connection,
    sql: &str,
    parameters: P,
) -> Result<Vec<PackRow>, String>
where
    P: rusqlite::Params,
{
    let mut statement = connection
        .prepare(sql)
        .map_err(|error| format!("failed to prepare telemetry pack query: {error}"))?;
    let rows = statement
        .query_map(parameters, PackRow::from_row)
        .map_err(|error| format!("failed to query telemetry packs: {error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("failed to read telemetry packs: {error}"))
}

fn query_log_rows(connection: &Connection, last_error_id: i64) -> Result<Vec<LogRow>, String> {
    let mut statement = connection
        .prepare(
            "SELECT id, event_uid, level, message, created_at FROM print_errors WHERE id > ?1 ORDER BY id LIMIT ?2",
        )
        .map_err(|error| format!("failed to prepare telemetry log query: {error}"))?;
    let rows = statement
        .query_map(params![last_error_id, MAX_REPORT_LOGS as i64], |row| {
            Ok(LogRow {
                id: row.get(0)?,
                event_uid: row.get(1)?,
                level: row.get(2)?,
                message: row.get(3)?,
                created_at: row.get(4)?,
            })
        })
        .map_err(|error| format!("failed to query telemetry logs: {error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("failed to read telemetry logs: {error}"))
}

fn upload_blob(app: &AppHandle, blob: &[u8], config: &Value) -> Result<UploadResult, String> {
    let server_ip = config
        .get("serverIp")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let Some(base) = server_base_url(server_ip) else {
        return Ok(UploadResult::Retryable);
    };
    let language = config
        .get("language")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .unwrap_or("ru");
    let part = Part::bytes(blob.to_vec())
        .file_name("report.lpr")
        .mime_str("application/octet-stream")
        .map_err(|error| format!("failed to build telemetry upload: {error}"))?;
    let response = app
        .state::<NetworkState>()
        .client()
        .post(format!("{base}/stations/upload_report/"))
        .header("X-Lang", language)
        .multipart(Form::new().part("file", part))
        .send();
    match response {
        Ok(response) if response.status().is_success() => Ok(UploadResult::Sent),
        Ok(response) if response.status().is_server_error() => Ok(UploadResult::Retryable),
        Ok(response) => Ok(UploadResult::Rejected(response.status().as_u16())),
        Err(_) => Ok(UploadResult::Retryable),
    }
}

fn spool_blob(outbox: &Path, blob: &[u8]) -> Result<PathBuf, String> {
    if blob.len() as u64 > MAX_REPORT_BYTES {
        return Err(format!(
            "report exceeds the {MAX_REPORT_BYTES}-byte spool limit"
        ));
    }
    fs::create_dir_all(outbox).map_err(|error| {
        format!(
            "failed to create telemetry outbox {}: {error}",
            outbox.display()
        )
    })?;
    let (files, bytes) = outbox_usage(outbox)?;
    if files >= MAX_OUTBOX_FILES || bytes.saturating_add(blob.len() as u64) > MAX_OUTBOX_BYTES {
        return Err(format!(
            "telemetry outbox limit reached: {files} files, {bytes} bytes"
        ));
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

fn outbox_files(outbox: &Path) -> Result<Vec<PathBuf>, String> {
    if !outbox.exists() {
        return Ok(Vec::new());
    }
    let mut files = fs::read_dir(outbox)
        .map_err(|error| {
            format!(
                "failed to list telemetry outbox {}: {error}",
                outbox.display()
            )
        })?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("lpr"))
        .collect::<Vec<_>>();
    files.sort();
    Ok(files)
}

fn outbox_usage(outbox: &Path) -> Result<(usize, u64), String> {
    let files = outbox_files(outbox)?;
    let bytes = files.iter().try_fold(0_u64, |sum, path| {
        fs::metadata(path)
            .map(|metadata| sum.saturating_add(metadata.len()))
            .map_err(|error| {
                format!(
                    "failed to inspect queued report {}: {error}",
                    path.display()
                )
            })
    })?;
    Ok((files.len(), bytes))
}

fn load_cursor(path: &Path) -> Result<ReportCursor, String> {
    if !path.exists() {
        return Ok(ReportCursor::default());
    }
    let bytes = read_bounded(&path, 64 * 1024)?;
    serde_json::from_slice(&bytes)
        .map_err(|error| format!("failed to parse report cursor {}: {error}", path.display()))
}

fn save_cursor(path: &Path, cursor: &ReportCursor) -> Result<(), String> {
    let bytes = serde_json::to_vec(cursor)
        .map_err(|error| format!("failed to serialize report cursor: {error}"))?;
    atomic_write(&path, &bytes)
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create {}: {error}", parent.display()))?;
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
        fs::remove_file(path)
            .map_err(|error| format!("failed to replace {}: {error}", path.display()))?;
    }
    fs::rename(&temporary, path)
        .map_err(|error| format!("failed to publish {}: {error}", path.display()))
}

fn read_bounded(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    let metadata = fs::metadata(path)
        .map_err(|error| format!("failed to inspect {}: {error}", path.display()))?;
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

fn prune_reported_logs(persisted: &PersistedState, reported_id: i64) -> Result<(), String> {
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
        .map_err(|error| format!("failed to prune reported telemetry logs: {error}"))
}

fn configured_interval() -> Duration {
    env::var("LABELPILOT_TELEMETRY_INTERVAL_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .map(|value| Duration::from_millis(value.clamp(60_000, 60 * 60_000)))
        .unwrap_or(DEFAULT_INTERVAL)
}

fn auto_report_enabled(config: Value) -> bool {
    config
        .get("autoReport")
        .and_then(Value::as_bool)
        .unwrap_or(true)
}

fn event_message(version: String, component: &str, event: &str, fields: Value) -> String {
    let value = json!({
        "schema": "labelpilot.telemetry.v1",
        "version": bounded(&version, 32),
        "component": bounded(component, 64),
        "event": bounded(event, 96),
        "fields": fields,
    });
    let serialized = serde_json::to_string(&value).unwrap_or_else(|_| "{}".to_owned());
    if serialized.len() <= MAX_EVENT_MESSAGE_BYTES {
        return serialized;
    }
    json!({
        "schema": "labelpilot.telemetry.v1",
        "version": bounded(&version, 32),
        "component": bounded(component, 64),
        "event": bounded(event, 96),
        "fields": { "truncated": true, "originalBytes": serialized.len() },
    })
    .to_string()
}

fn normalize_level(level: &str) -> &'static str {
    match level.trim().to_ascii_uppercase().as_str() {
        "ERROR" => "ERROR",
        "WARN" | "WARNING" => "WARNING",
        _ => "INFO",
    }
}

fn bounded(value: &str, limit: usize) -> String {
    value
        .chars()
        .filter(|character| !matches!(character, '\r' | '\n' | '\0'))
        .take(limit)
        .collect()
}

fn kilograms_to_grams(value: f64) -> i64 {
    (value * 1_000.0).round() as i64
}

fn now_rfc3339() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| OffsetDateTime::now_utc().unix_timestamp().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (PathBuf, PersistedState) {
        let root = env::temp_dir().join(format!("labelpilot-telemetry-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let persisted = PersistedState::for_data_dir(root.clone());
        open_database(&persisted).unwrap();
        (root, persisted)
    }

    fn seed_pack(connection: &Connection, status: &str, deleted_at: Option<&str>) {
        connection
            .execute(
                "INSERT INTO pallet(number, status) VALUES ('P1', 'Open')",
                [],
            )
            .ok();
        connection
            .execute(
                "INSERT INTO nomenclature(id, name, article, exp_date) VALUES (1, 'Product', 'A1', 10)",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO boxes(id, pallete_id, number, status, nomenclature_id) VALUES (1, 1, 'B1', 'Open', 1)",
                [],
            )
            .ok();
        connection
            .execute(
                "INSERT INTO pack(number, box_id, nomenclature_id, weight_netto, weight_brutto, status, deleted_at) VALUES (?1, 1, 1, 1.25, 1.30, ?2, ?3)",
                params![format!("U{}", Uuid::new_v4()), status, deleted_at],
            )
            .unwrap();
    }

    #[test]
    fn delta_cursor_reports_late_deletions_without_replaying_prints() {
        let (root, persisted) = fixture();
        let connection = open_database(&persisted).unwrap();
        seed_pack(&connection, "Printed", None);
        drop(connection);
        let first = build_delta_report(&persisted, &ReportCursor::default()).unwrap();
        assert_eq!(first.label_count, 1);
        assert_eq!(first.deleted_count, 0);
        let connection = open_database(&persisted).unwrap();
        connection
            .execute(
                "UPDATE pack SET status='Deleted', deleted_at='2026-08-21T10:00:00Z' WHERE id=1",
                [],
            )
            .unwrap();
        drop(connection);
        let second = build_delta_report(&persisted, &first.cursor).unwrap();
        assert_eq!(second.label_count, 0);
        assert_eq!(second.deleted_count, 1);
        assert_eq!(second.cursor.last_pack_id, first.cursor.last_pack_id);
        assert_eq!(second.cursor.last_deleted_id, 1);
        let third = build_delta_report(&persisted, &second.cursor).unwrap();
        assert_eq!(third.deleted_count, 0);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn event_message_is_structured_and_bounded() {
        let message = event_message(
            "2.0.0".to_owned(),
            "renderer",
            "unhandled_rejection",
            json!({ "message": "x".repeat(MAX_EVENT_MESSAGE_BYTES * 2) }),
        );
        assert!(message.len() <= MAX_EVENT_MESSAGE_BYTES);
        let parsed: Value = serde_json::from_str(&message).unwrap();
        assert_eq!(parsed["schema"], "labelpilot.telemetry.v1");
        assert_eq!(parsed["fields"]["truncated"], true);
    }

    #[test]
    fn outbox_is_atomic_and_accounted() {
        let root = env::temp_dir().join(format!("labelpilot-outbox-{}", Uuid::new_v4()));
        let path = spool_blob(&root, b"encrypted-report").unwrap();
        assert!(path.exists());
        assert_eq!(outbox_usage(&root).unwrap(), (1, 16));
        assert!(fs::read_dir(&root).unwrap().all(|entry| !entry
            .unwrap()
            .path()
            .to_string_lossy()
            .ends_with(".tmp")));
        fs::remove_dir_all(root).unwrap();
    }
}
