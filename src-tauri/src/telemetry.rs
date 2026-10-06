use crate::commands::RuntimeState;
use crate::crypto::encrypt_report;
use crate::generator::GeneratorState;
use crate::ingress::IngressState;
use crate::network::{server_base_url, ConnectionStatus, NetworkState};
use crate::persisted::PersistedState;
use crate::printer::PrinterTransportState;
use crate::processor::open_database;
use crate::scale::ScaleState;
use crate::station_report::{
    build_delta_report, load_cursor, now_rfc3339, outbox_files, outbox_usage, prune_reported_logs,
    read_bounded, save_cursor, spool_blob, upload_report, UploadResult, CURSOR_FILE, MAX_FLUSH_FILES,
    MAX_OUTBOX_BYTES, MAX_OUTBOX_FILES, MAX_REPORT_BYTES, OUTBOX_DIRECTORY,
};
#[cfg(test)]
use crate::station_report::ReportCursor;
use rusqlite::{params, Connection};
use serde::Serialize;
use serde_json::{json, Value};
use std::env;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender, TrySendError};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

const MAX_EVENT_MESSAGE_BYTES: usize = 16 * 1024;
const EVENT_QUEUE_CAPACITY: usize = 1_024;
const EVENT_BATCH_SIZE: usize = 64;
const EVENT_BATCH_DELAY: Duration = Duration::from_millis(20);
const EVENT_FLUSH_TIMEOUT: Duration = Duration::from_secs(10);
const DEFAULT_INTERVAL: Duration = Duration::from_secs(5 * 60);
const STARTUP_DELAY: Duration = Duration::from_secs(8);
const RECONNECT_POLL: Duration = Duration::from_secs(2);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetrySummary {
    pub worker_running: bool,
    pub auto_report_enabled: bool,
    pub interval_ms: u64,
    pub uptime_ms: u64,
    pub recorded_events: u64,
    pub pending_event_writes: u64,
    pub dropped_events: u64,
    pub event_write_failures: u64,
    pub event_queue_capacity: usize,
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
    pending_event_writes: AtomicU64,
    dropped_events: AtomicU64,
    event_write_failures: AtomicU64,
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
    event_sender: SyncSender<EventWriterMessage>,
    event_receiver: Mutex<Option<Receiver<EventWriterMessage>>>,
    event_worker: Mutex<Option<JoinHandle<()>>>,
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
struct TelemetryEvent {
    event_uid: String,
    level: String,
    message: String,
    created_at: String,
}

enum EventWriterMessage {
    Event(TelemetryEvent),
    Flush(SyncSender<Result<(), String>>),
    Shutdown(SyncSender<Result<(), String>>),
}

impl TelemetryState {
    pub fn new(data_dir: PathBuf) -> Self {
        let (event_sender, event_receiver) = mpsc::sync_channel(EVENT_QUEUE_CAPACITY);
        Self {
            inner: Arc::new(TelemetryInner {
                data_dir,
                started: Instant::now(),
                interval: configured_interval(),
                stop: AtomicBool::new(false),
                wake: (Mutex::new(false), Condvar::new()),
                worker: Mutex::new(None),
                event_sender,
                event_receiver: Mutex::new(Some(event_receiver)),
                event_worker: Mutex::new(None),
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
        self.start_event_writer()?;
        self.inner.stop.store(false, Ordering::Release);
        if let Err(error) = self.record_event(
            &app,
            "INFO",
            "runtime",
            "runtime_started",
            json!({ "version": app.package_info().version.to_string() }),
        ) {
            let _ = self.stop_event_writer();
            return Err(error);
        }
        let state = self.clone();
        let report_worker = thread::Builder::new()
            .name("labelpilot-telemetry".to_owned())
            .spawn(move || run_worker(state, app))
            .map_err(|error| format!("failed to start telemetry worker: {error}"));
        match report_worker {
            Ok(handle) => *worker = Some(handle),
            Err(error) => {
                let _ = self.stop_event_writer();
                return Err(error);
            }
        }
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
        if let Err(error) = self.stop_event_writer() {
            self.inner
                .stats
                .event_write_failures
                .fetch_add(1, Ordering::AcqRel);
            self.set_last_error(&error);
        }
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
            pending_event_writes: self
                .inner
                .stats
                .pending_event_writes
                .load(Ordering::Acquire),
            dropped_events: self.inner.stats.dropped_events.load(Ordering::Acquire),
            event_write_failures: self
                .inner
                .stats
                .event_write_failures
                .load(Ordering::Acquire),
            event_queue_capacity: EVENT_QUEUE_CAPACITY,
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
        self.inner
            .stats
            .pending_event_writes
            .fetch_add(1, Ordering::AcqRel);
        let message = EventWriterMessage::Event(TelemetryEvent {
            event_uid: Uuid::new_v4().to_string(),
            level: normalize_level(level).to_owned(),
            message: event_message(
                app.package_info().version.to_string(),
                component,
                event,
                fields,
            ),
            created_at: now_rfc3339(),
        });
        match self.inner.event_sender.try_send(message) {
            Ok(()) => Ok(()),
            Err(TrySendError::Full(_)) => {
                self.drop_queued_event();
                Err("telemetry event queue is full".to_owned())
            }
            Err(TrySendError::Disconnected(_)) => {
                self.drop_queued_event();
                Err("telemetry event writer is not running".to_owned())
            }
        }
    }

    fn start_event_writer(&self) -> Result<(), String> {
        let mut worker = self
            .inner
            .event_worker
            .lock()
            .map_err(|_| "telemetry event worker lock is poisoned".to_owned())?;
        if worker.is_some() {
            return Ok(());
        }
        let receiver = self
            .inner
            .event_receiver
            .lock()
            .map_err(|_| "telemetry event receiver lock is poisoned".to_owned())?
            .take()
            .ok_or_else(|| "telemetry event writer cannot be restarted".to_owned())?;
        let persisted = PersistedState::for_data_dir(self.inner.data_dir.clone());
        let connection = open_database(&persisted)?;
        let state = self.clone();
        *worker = Some(
            thread::Builder::new()
                .name("labelpilot-telemetry-db".to_owned())
                .spawn(move || run_event_writer(state, connection, receiver))
                .map_err(|error| format!("failed to start telemetry event writer: {error}"))?,
        );
        Ok(())
    }

    fn flush_event_queue(&self) -> Result<(), String> {
        let running = self
            .inner
            .event_worker
            .lock()
            .map(|worker| worker.as_ref().is_some_and(|handle| !handle.is_finished()))
            .unwrap_or(false);
        if !running {
            return Ok(());
        }
        let (response_sender, response_receiver) = mpsc::sync_channel(0);
        self.inner
            .event_sender
            .send(EventWriterMessage::Flush(response_sender))
            .map_err(|_| "telemetry event writer stopped before flush".to_owned())?;
        response_receiver
            .recv_timeout(EVENT_FLUSH_TIMEOUT)
            .map_err(|_| "timed out flushing telemetry event queue".to_owned())?
    }

    fn stop_event_writer(&self) -> Result<(), String> {
        let mut worker = self
            .inner
            .event_worker
            .lock()
            .map_err(|_| "telemetry event worker lock is poisoned".to_owned())?;
        let Some(handle) = worker.take() else {
            return Ok(());
        };
        let (response_sender, response_receiver) = mpsc::sync_channel(0);
        let send_result = self
            .inner
            .event_sender
            .send(EventWriterMessage::Shutdown(response_sender));
        let flush_result = if send_result.is_ok() {
            match response_receiver.recv_timeout(EVENT_FLUSH_TIMEOUT) {
                Ok(result) => result,
                Err(_) => Err("timed out stopping telemetry event writer".to_owned()),
            }
        } else {
            Err("telemetry event writer stopped unexpectedly".to_owned())
        };
        let join_result = handle
            .join()
            .map_err(|_| "telemetry event writer panicked".to_owned());
        match (flush_result, join_result) {
            (Err(error), _) => Err(error),
            (Ok(()), Err(error)) => Err(error),
            (Ok(()), Ok(())) => Ok(()),
        }
    }

    fn drop_queued_event(&self) {
        self.inner
            .stats
            .pending_event_writes
            .fetch_sub(1, Ordering::AcqRel);
        self.inner
            .stats
            .dropped_events
            .fetch_add(1, Ordering::AcqRel);
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
        self.flush_event_queue()?;

        if app.state::<NetworkState>().status() == ConnectionStatus::Connected {
            self.flush_outbox(app)?;
        }
        let report = build_delta_report(&persisted, &load_cursor(&self.cursor_path())?)?;
        if report.is_empty() {
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
        if report.is_empty() {
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

fn run_event_writer(
    state: TelemetryState,
    mut connection: Connection,
    receiver: Receiver<EventWriterMessage>,
) {
    enum WriterInput {
        Message(EventWriterMessage),
        FlushBatch,
        Disconnected,
    }

    let mut pending = Vec::with_capacity(EVENT_BATCH_SIZE);
    loop {
        let input = if pending.is_empty() {
            match receiver.recv() {
                Ok(message) => WriterInput::Message(message),
                Err(_) => WriterInput::Disconnected,
            }
        } else {
            match receiver.recv_timeout(EVENT_BATCH_DELAY) {
                Ok(message) => WriterInput::Message(message),
                Err(mpsc::RecvTimeoutError::Timeout) => WriterInput::FlushBatch,
                Err(mpsc::RecvTimeoutError::Disconnected) => WriterInput::Disconnected,
            }
        };

        match input {
            WriterInput::Message(EventWriterMessage::Event(event)) => {
                pending.push(event);
                if pending.len() >= EVENT_BATCH_SIZE {
                    let _ = flush_event_batch(&state, &mut connection, &mut pending);
                }
            }
            WriterInput::Message(EventWriterMessage::Flush(response)) => {
                let result = flush_event_batch(&state, &mut connection, &mut pending);
                let _ = response.send(result);
            }
            WriterInput::Message(EventWriterMessage::Shutdown(response)) => {
                let result = flush_event_batch(&state, &mut connection, &mut pending);
                let _ = response.send(result);
                break;
            }
            WriterInput::FlushBatch => {
                let _ = flush_event_batch(&state, &mut connection, &mut pending);
            }
            WriterInput::Disconnected => {
                let _ = flush_event_batch(&state, &mut connection, &mut pending);
                break;
            }
        }
    }
}

fn flush_event_batch(
    state: &TelemetryState,
    connection: &mut Connection,
    pending: &mut Vec<TelemetryEvent>,
) -> Result<(), String> {
    if pending.is_empty() {
        return Ok(());
    }
    let result = (|| -> Result<(), String> {
        let transaction = connection
            .transaction()
            .map_err(|error| format!("failed to begin telemetry event batch: {error}"))?;
        {
            let mut statement = transaction
                .prepare_cached(
                    "INSERT INTO print_errors (event_uid, level, message, created_at) VALUES (?1, ?2, ?3, ?4)",
                )
                .map_err(|error| format!("failed to prepare telemetry event batch: {error}"))?;
            for event in pending.iter() {
                statement
                    .execute(params![
                        &event.event_uid,
                        &event.level,
                        &event.message,
                        &event.created_at,
                    ])
                    .map_err(|error| format!("failed to persist telemetry event batch: {error}"))?;
            }
        }
        transaction
            .commit()
            .map_err(|error| format!("failed to commit telemetry event batch: {error}"))
    })();

    match result {
        Ok(()) => {
            let count = pending.len() as u64;
            pending.clear();
            state
                .inner
                .stats
                .pending_event_writes
                .fetch_sub(count, Ordering::AcqRel);
            state
                .inner
                .stats
                .recorded_events
                .fetch_add(count, Ordering::AcqRel);
            Ok(())
        }
        Err(error) => {
            state
                .inner
                .stats
                .event_write_failures
                .fetch_add(1, Ordering::AcqRel);
            state.set_last_error(&error);
            Err(error)
        }
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
    Ok(upload_report(&app.state::<NetworkState>().client(), &base, blob, language))
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
    fn telemetry_events_commit_as_one_batch() {
        let (root, persisted) = fixture();
        let state = TelemetryState::new(root.clone());
        let mut connection = open_database(&persisted).unwrap();
        let mut pending = vec![
            TelemetryEvent {
                event_uid: "event-1".to_owned(),
                level: "WARNING".to_owned(),
                message: "first".to_owned(),
                created_at: "2026-09-14T10:00:00Z".to_owned(),
            },
            TelemetryEvent {
                event_uid: "event-2".to_owned(),
                level: "ERROR".to_owned(),
                message: "second".to_owned(),
                created_at: "2026-09-14T10:00:01Z".to_owned(),
            },
        ];
        state
            .inner
            .stats
            .pending_event_writes
            .store(pending.len() as u64, Ordering::Release);

        flush_event_batch(&state, &mut connection, &mut pending).unwrap();

        assert!(pending.is_empty());
        assert_eq!(state.inner.stats.recorded_events.load(Ordering::Acquire), 2);
        assert_eq!(
            state
                .inner
                .stats
                .pending_event_writes
                .load(Ordering::Acquire),
            0
        );
        let rows: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM print_errors WHERE event_uid IN ('event-1', 'event-2')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(rows, 2);
        drop(connection);
        fs::remove_dir_all(root).unwrap();
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
