use crate::diagnostic::{self as diagnostic_export, DiagnosticExportReceipt};
use crate::generator::{
    GenerationMetadata, GenerationPayload, GenerationPlan, GeneratorState, GeneratorSummary,
    NativeGenerationReceipt,
};
use crate::ingress::{IngressState, IngressSummary};
use crate::lifecycle::{self, UpdateRuntimeState};
use crate::network::{fetch_license_status, test_connection_full, NetworkState, NetworkSummary};
use crate::operational::{CloseBoxPayload, OperationalState, RecordPackPayload, RecordPackResult};
use crate::persisted::PersistedState;
use crate::printer::{
    list_system_printers, plan_backend, query_printer_status_routed, BackendPlanPayload,
    DriverBitmapPayload, DriverPagePayload, DurablePrintJobRecord, DurableQueueSummary,
    PrintReceipt, PrinterStatusReport, PrinterTransportState, PrinterTransportSummary,
    RawPrintPayload, SystemPrinterInfo, UniversalPrinterPlan,
};
use crate::runtime_events::RuntimeEventSink;
use crate::scale::{list_serial_ports, protocol_catalog, ScaleState, ScaleSummary, SerialPortInfo};
use crate::session::{CurrentOperator, SessionState};
use crate::telemetry::{TelemetryState, TelemetrySummary};
use crate::transfer;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs::{self, File, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;

const LOG_FILE_NAME: &str = "labelpilot-tauri.log";
const PREVIOUS_LOG_FILE_NAME: &str = "labelpilot-tauri.previous.log";
const MAX_LOG_BYTES: u64 = 2 * 1024 * 1024;

pub struct RuntimeState {
    logger: Mutex<RollingFileLogger>,
    shutdown_started: AtomicBool,
}

impl RuntimeState {
    pub fn new(log_dir: PathBuf) -> Result<Self, String> {
        Ok(Self {
            logger: Mutex::new(RollingFileLogger::open(log_dir)?),
            shutdown_started: AtomicBool::new(false),
        })
    }

    fn begin_shutdown(&self) -> bool {
        self.shutdown_started
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
    }

    fn cancel_shutdown(&self) {
        self.shutdown_started.store(false, Ordering::Release);
    }

    pub fn log_startup(&self) -> Result<(), String> {
        self.log("INFO", "Tauri runtime started")
    }

    pub fn log_data_directory(&self, path: &Path) -> Result<(), String> {
        self.log(
            "INFO",
            &format!("legacy-compatible data directory: {}", path.display()),
        )
    }

    pub(crate) fn log(&self, level: &str, message: &str) -> Result<(), String> {
        self.logger
            .lock()
            .map_err(|_| "runtime logger lock is poisoned".to_owned())?
            .write(level, message)
    }
}

struct RollingFileLogger {
    directory: PathBuf,
    writer: BufWriter<File>,
    bytes_written: u64,
}

impl RollingFileLogger {
    fn open(directory: PathBuf) -> Result<Self, String> {
        fs::create_dir_all(&directory).map_err(|error| {
            format!(
                "failed to create log directory {}: {error}",
                directory.display()
            )
        })?;
        let path = directory.join(LOG_FILE_NAME);
        let bytes_written = fs::metadata(&path)
            .map(|metadata| metadata.len())
            .unwrap_or(0);
        let writer = open_append(&path)?;
        Ok(Self {
            directory,
            writer,
            bytes_written,
        })
    }

    fn write(&mut self, level: &str, message: &str) -> Result<(), String> {
        let line = format_log_line(level, message);
        if self.bytes_written.saturating_add(line.len() as u64) > MAX_LOG_BYTES {
            self.rotate()?;
        }
        self.writer
            .write_all(line.as_bytes())
            .and_then(|_| self.writer.flush())
            .map_err(|error| format!("failed to write runtime log: {error}"))?;
        self.bytes_written += line.len() as u64;
        Ok(())
    }

    fn rotate(&mut self) -> Result<(), String> {
        self.writer
            .flush()
            .map_err(|error| format!("failed to flush runtime log: {error}"))?;
        let current = self.directory.join(LOG_FILE_NAME);
        let previous = self.directory.join(PREVIOUS_LOG_FILE_NAME);
        if previous.exists() {
            fs::remove_file(&previous).map_err(|error| {
                format!(
                    "failed to remove previous runtime log {}: {error}",
                    previous.display()
                )
            })?;
        }
        if current.exists() {
            fs::rename(&current, &previous).map_err(|error| {
                format!(
                    "failed to rotate runtime log {}: {error}",
                    current.display()
                )
            })?;
        }
        self.writer = open_append(&current)?;
        self.bytes_written = 0;
        Ok(())
    }
}

fn open_append(path: &Path) -> Result<BufWriter<File>, String> {
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map(BufWriter::new)
        .map_err(|error| format!("failed to open runtime log {}: {error}", path.display()))
}

fn format_log_line(level: &str, message: &str) -> String {
    let timestamp_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let level = sanitize_log_field(level, 12);
    let message = sanitize_log_field(message, 8 * 1024);
    format!("{timestamp_ms} [{level}] {message}\n")
}

fn sanitize_log_field(value: &str, max_chars: usize) -> String {
    value
        .chars()
        .filter(|character| !matches!(character, '\r' | '\n' | '\0'))
        .take(max_chars)
        .collect()
}

fn payload_message(payload: Option<Value>) -> String {
    match payload {
        Some(Value::Object(object)) => object
            .get("message")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| Value::Object(object).to_string()),
        Some(value) => value.to_string(),
        None => "renderer log event".to_owned(),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSummary {
    runtime: &'static str,
    invoke_channels: usize,
    send_channels: usize,
    event_channels: usize,
    migrated_commands: Vec<&'static str>,
}

#[tauri::command]
pub fn desktop_get_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

#[tauri::command]
pub async fn desktop_updater_check(
    app: AppHandle,
    updater: State<'_, UpdateRuntimeState>,
) -> Result<lifecycle::UpdateCheckResult, String> {
    lifecycle::check_for_update(app, &updater).await
}

#[tauri::command]
pub async fn desktop_updater_download(
    app: AppHandle,
    updater: State<'_, UpdateRuntimeState>,
) -> Result<Value, String> {
    lifecycle::download_update(app, &updater).await
}

#[tauri::command]
pub fn desktop_updater_install(
    app: AppHandle,
    updater: State<'_, UpdateRuntimeState>,
    persisted: State<'_, PersistedState>,
) -> Result<Value, String> {
    lifecycle::install_downloaded_update(&app, &updater, persisted.data_dir())
}

#[tauri::command]
pub fn desktop_updater_install_offline(
    app: AppHandle,
    persisted: State<'_, PersistedState>,
    payload: Option<Value>,
) -> Value {
    let path = match resolve_open_path(
        &app,
        payload.as_ref(),
        "Выберите установщик LabelPilot",
        "LabelPilot Installer",
        &["exe", "msi"],
    ) {
        Ok(Some(path)) => path,
        Ok(None) => return cancelled_result(),
        Err(message) => return failed_result(message),
    };
    ipc_value(lifecycle::install_offline_update(
        app,
        persisted.data_dir(),
        &path,
    ))
}

#[tauri::command]
pub fn desktop_updater_list_backups(
    persisted: State<'_, PersistedState>,
) -> Result<Vec<lifecycle::BackupInfo>, String> {
    lifecycle::list_backups(persisted.data_dir())
}

#[tauri::command]
pub fn desktop_updater_rollback(persisted: State<'_, PersistedState>, payload: String) -> Value {
    ipc_value(lifecycle::queue_rollback(persisted.data_dir(), &payload))
}

#[tauri::command]
pub async fn desktop_updater_refresh_server_version(
    app: AppHandle,
    network: State<'_, NetworkState>,
    persisted: State<'_, PersistedState>,
    updater: State<'_, UpdateRuntimeState>,
) -> Result<Value, String> {
    let server_ip = persisted
        .load_printer_config()
        .get("serverIp")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let station_uuid = persisted.load_identity().and_then(|identity| {
        identity
            .get("station_uuid")
            .and_then(Value::as_str)
            .map(str::to_owned)
    });
    let client = network.client();
    let client_version = app.package_info().version.to_string();
    let info = tauri::async_runtime::spawn_blocking(move || {
        test_connection_full(
            &client,
            &server_ip,
            station_uuid.as_deref(),
            &client_version,
        )
    })
    .await
    .map_err(|error| format!("server-version refresh task failed: {error}"))?;
    updater.set_server_version(info.server_version.clone())?;
    Ok(json!({
        "success": true,
        "online": info.online,
        "serverVersion": info.server_version,
    }))
}

#[tauri::command]
pub fn desktop_import_identity_file(
    app: AppHandle,
    persisted: State<'_, PersistedState>,
    payload: Option<Value>,
) -> Value {
    let path = match resolve_open_path(
        &app,
        payload.as_ref(),
        "Выберите файл идентификации станции",
        "LabelPilot Identity",
        &["lpi"],
    ) {
        Ok(Some(path)) => path,
        Ok(None) => return cancelled_result(),
        Err(message) => return failed_result(message),
    };
    let version = app.package_info().version.to_string();
    let result = transfer::import_identity_file(&persisted, &version, &path);
    if result.is_ok() {
        let _ = app.emit("data-updated", ());
    }
    ipc_value(result)
}

#[tauri::command]
pub fn desktop_offline_import(
    app: AppHandle,
    persisted: State<'_, PersistedState>,
    payload: Option<Value>,
) -> Value {
    let path = match resolve_open_path(
        &app,
        payload.as_ref(),
        "Выберите файл обновления данных",
        "LabelPilot Update",
        &["lps"],
    ) {
        Ok(Some(path)) => path,
        Ok(None) => return cancelled_result(),
        Err(message) => return failed_result(message),
    };
    let version = app.package_info().version.to_string();
    let result = transfer::import_offline_sync(&persisted, &version, &path);
    if result.is_ok() {
        let _ = app.emit("data-updated", ());
    }
    ipc_value(result)
}

#[tauri::command]
pub fn desktop_offline_export(
    app: AppHandle,
    persisted: State<'_, PersistedState>,
    payload: Option<Value>,
) -> Value {
    let path = if let Some(path) = transfer::selected_path(payload.as_ref()) {
        Some(path)
    } else {
        match resolve_save_path(
            &app,
            "Экспорт данных",
            &transfer::default_report_filename(&persisted),
            "LabelPilot Report",
            &["lpr"],
        ) {
            Ok(path) => path,
            Err(message) => return failed_result(message),
        }
    };
    let Some(path) = path else {
        return cancelled_result();
    };
    ipc_value(transfer::export_offline_report(&persisted, &path))
}

#[tauri::command]
pub fn desktop_import_print_job_file(
    app: AppHandle,
    persisted: State<'_, PersistedState>,
    payload: Option<Value>,
) -> Value {
    let path = match resolve_open_path(
        &app,
        payload.as_ref(),
        "Выберите файл задания",
        "LabelPilot Print Job",
        &["lpj"],
    ) {
        Ok(Some(path)) => path,
        Ok(None) => return cancelled_result(),
        Err(message) => return failed_result(message),
    };
    let result = transfer::import_print_job_file(&persisted, &path);
    if result.is_ok() {
        let _ = app.emit("print-jobs-updated", ());
    }
    ipc_value(result)
}

#[tauri::command]
pub fn desktop_usb_export(payload: Value) -> Value {
    let path = transfer::selected_path(Some(&payload));
    let data = payload.get("data").cloned();
    match (path, data) {
        (Some(path), Some(data)) => ipc_value(transfer::export_usb_payload(&path, data)),
        _ => failed_result("USB export requires path and data".to_owned()),
    }
}

#[tauri::command]
pub fn desktop_usb_import(payload: Value) -> Value {
    match transfer::selected_path(Some(&payload)) {
        Some(path) => ipc_value(transfer::import_usb_payload(&path)),
        None => failed_result("USB import requires a path".to_owned()),
    }
}

#[tauri::command]
pub fn desktop_demo_status(persisted: State<'_, PersistedState>) -> Value {
    json!({ "isDemo": transfer::is_demo_active(&persisted) })
}

#[tauri::command]
pub fn desktop_seed_demo_data(
    app: AppHandle,
    operational: State<'_, OperationalState>,
    persisted: State<'_, PersistedState>,
) -> Value {
    let result = operational.reset_database().and_then(|_| {
        transfer::seed_demo_data(&persisted, &app.package_info().version.to_string())
    });
    if result.is_ok() {
        let _ = app.emit("data-updated", ());
    }
    ipc_value(result)
}

#[tauri::command]
pub fn desktop_exit_demo(
    app: AppHandle,
    operational: State<'_, OperationalState>,
    persisted: State<'_, PersistedState>,
) -> Value {
    let result = operational.reset_database().and_then(|_| {
        transfer::exit_demo_data(&persisted, &app.package_info().version.to_string())
    });
    if result.is_ok() {
        let _ = app.emit("data-updated", ());
    }
    ipc_value(result)
}

#[tauri::command]
pub fn desktop_reset_database(
    app: AppHandle,
    operational: State<'_, OperationalState>,
    persisted: State<'_, PersistedState>,
) -> Value {
    let result = operational
        .reset_database()
        .and_then(|_| transfer::clear_identity_files(&persisted))
        .map(|_| json!({ "success": true, "message": "Database reset successfully" }));
    if result.is_ok() {
        let _ = app.emit("data-updated", ());
    }
    ipc_value(result)
}

fn resolve_open_path(
    app: &AppHandle,
    payload: Option<&Value>,
    title: &str,
    filter_name: &str,
    extensions: &[&str],
) -> Result<Option<PathBuf>, String> {
    if let Some(path) = transfer::selected_path(payload) {
        return Ok(Some(path));
    }
    app.dialog()
        .file()
        .set_title(title)
        .add_filter(filter_name, extensions)
        .blocking_pick_file()
        .map(|path| {
            path.into_path()
                .map_err(|error| format!("selected file is not a local path: {error}"))
        })
        .transpose()
}

fn resolve_save_path(
    app: &AppHandle,
    title: &str,
    file_name: &str,
    filter_name: &str,
    extensions: &[&str],
) -> Result<Option<PathBuf>, String> {
    app.dialog()
        .file()
        .set_title(title)
        .set_file_name(file_name)
        .add_filter(filter_name, extensions)
        .blocking_save_file()
        .map(|path| {
            path.into_path()
                .map_err(|error| format!("selected file is not a local path: {error}"))
        })
        .transpose()
}

fn ipc_value(result: Result<Value, String>) -> Value {
    result.unwrap_or_else(failed_result)
}

fn failed_result(message: String) -> Value {
    json!({ "success": false, "message": message })
}

fn cancelled_result() -> Value {
    json!({ "success": false, "message": "Отменено", "cancelled": true })
}

#[tauri::command]
pub fn desktop_contract_summary() -> RuntimeSummary {
    RuntimeSummary {
        runtime: "tauri",
        invoke_channels: labelpilot_contracts::DESKTOP_INVOKE_CHANNELS.len(),
        send_channels: labelpilot_contracts::DESKTOP_SEND_CHANNELS.len(),
        event_channels: labelpilot_contracts::DESKTOP_EVENT_CHANNELS.len(),
        migrated_commands: vec![
            "updater:get-version",
            "updater:check",
            "updater:download",
            "updater:install",
            "updater:install-offline",
            "updater:list-backups",
            "updater:rollback",
            "updater:refresh-server-version",
            "import-identity-file",
            "offline-import",
            "offline-export",
            "import-print-job-file",
            "usb-export",
            "usb-import",
            "seed-demo-data",
            "exit-demo",
            "reset-database",
            "open-logs-folder",
            "log-to-main",
            "quit-app",
            "get-scale-config",
            "save-scale-config",
            "connect-scale",
            "disconnect-scale",
            "get-scale-status",
            "get-serial-ports",
            "get-protocols",
            "get-numbering-config",
            "save-numbering-config",
            "get-printer-config",
            "save-printer-config",
            "get-identity",
            "get-next-sequence",
            "sync-data",
            "get-server-status",
            "get-license-status",
            "set-app-mode",
            "renderer-ready",
            "get-station-info",
            "get-products",
            "get-fixed-weight-products",
            "get-containers",
            "get-label",
            "get-all-labels",
            "get-barcode-template",
            "get-printers",
            "get-print-jobs",
            "update-print-job-progress",
            "complete-print-job",
            "delete-print-job",
            "record-pack",
            "record-and-print",
            "detect-printer-capabilities",
            "test-print",
            "printer:warmup",
            "printer:warmup-bg",
            "demo:status",
            "close-box",
            "get-latest-counters",
            "get-open-pallet-content",
            "get-pallet-render-data",
            "close-pallet",
            "delete-pack",
            "delete-box",
            "operators:list",
            "session:get",
            "session:set",
            "session:logout",
            "print-label",
        ],
    }
}

#[tauri::command]
pub fn desktop_get_scale_config(state: State<'_, PersistedState>) -> Value {
    state.load_scale_config()
}

#[tauri::command]
pub fn desktop_save_scale_config(
    app: AppHandle,
    state: State<'_, PersistedState>,
    runtime: State<'_, RuntimeState>,
    scale: State<'_, ScaleState>,
    payload: Value,
) -> Result<(), String> {
    state.save_scale_config(payload.clone())?;
    scale.connect(app, payload)?;
    let _ = runtime.log(
        "INFO",
        "scale config persisted and connected by Rust runtime",
    );
    Ok(())
}

#[tauri::command]
pub fn desktop_connect_scale(
    app: AppHandle,
    state: State<'_, PersistedState>,
    scale: State<'_, ScaleState>,
    payload: Value,
) -> Result<(), String> {
    state.save_scale_config(payload.clone())?;
    scale.connect(app, payload)
}

#[tauri::command]
pub fn desktop_disconnect_scale(app: AppHandle, scale: State<'_, ScaleState>) {
    scale.disconnect(&app);
}

#[tauri::command]
pub fn desktop_get_scale_status(scale: State<'_, ScaleState>) -> &'static str {
    scale.status()
}

#[tauri::command]
pub async fn desktop_get_serial_ports() -> Result<Vec<SerialPortInfo>, String> {
    tauri::async_runtime::spawn_blocking(list_serial_ports)
        .await
        .map_err(|error| format!("serial port enumeration task failed: {error}"))?
}

#[tauri::command]
pub fn desktop_get_protocols() -> Vec<crate::scale::ProtocolInfo> {
    protocol_catalog()
}

#[tauri::command]
pub fn desktop_scale_summary(scale: State<'_, ScaleState>) -> ScaleSummary {
    scale.summary()
}

#[tauri::command]
pub fn desktop_get_numbering_config(state: State<'_, PersistedState>) -> Value {
    state.load_numbering_config()
}

#[tauri::command]
pub fn desktop_save_numbering_config(
    state: State<'_, PersistedState>,
    runtime: State<'_, RuntimeState>,
    payload: Value,
) -> Result<(), String> {
    state.save_numbering_config(payload)?;
    let _ = runtime.log("INFO", "numbering config persisted by Rust runtime");
    Ok(())
}

#[tauri::command]
pub fn desktop_get_printer_config(state: State<'_, PersistedState>) -> Value {
    state.load_printer_config()
}

#[tauri::command]
pub fn desktop_save_printer_config(
    app: AppHandle,
    state: State<'_, PersistedState>,
    runtime: State<'_, RuntimeState>,
    printer: State<'_, PrinterTransportState>,
    payload: Value,
) -> Result<(), String> {
    state.save_printer_config(payload.clone())?;
    printer.reconfigure(&payload);
    app.state::<NetworkState>().request_check();
    app.emit("printer-config-updated", payload)
        .map_err(|error| format!("failed to emit printer-config-updated: {error}"))?;
    let _ = runtime.log("INFO", "printer config persisted by Rust runtime");
    Ok(())
}

#[tauri::command]
pub async fn desktop_printer_send_raw(
    app: AppHandle,
    printer: State<'_, PrinterTransportState>,
    payload: RawPrintPayload,
) -> Result<PrintReceipt, String> {
    let printer = (*printer).clone();
    tauri::async_runtime::spawn_blocking(move || printer.submit_raw(app, payload))
        .await
        .map_err(|error| format!("raw printer task failed: {error}"))?
}

#[tauri::command]
pub async fn desktop_printer_send_fallback_raw(
    app: AppHandle,
    printer: State<'_, PrinterTransportState>,
    payload: RawPrintPayload,
) -> Result<PrintReceipt, String> {
    let printer = (*printer).clone();
    tauri::async_runtime::spawn_blocking(move || {
        let receipt = printer.submit_raw(app.clone(), payload)?;
        app.state::<GeneratorState>()
            .record_renderer_fallback(receipt.bytes);
        Ok(receipt)
    })
    .await
    .map_err(|error| format!("bitmap fallback printer task failed: {error}"))?
}

#[tauri::command]
pub async fn desktop_printer_send_driver_bitmap(
    app: AppHandle,
    printer: State<'_, PrinterTransportState>,
    payload: DriverBitmapPayload,
) -> Result<PrintReceipt, String> {
    let printer = (*printer).clone();
    tauri::async_runtime::spawn_blocking(move || {
        let receipt = printer.submit_driver_bitmap(app.clone(), payload)?;
        app.state::<GeneratorState>()
            .record_renderer_fallback(receipt.bytes);
        Ok(receipt)
    })
    .await
    .map_err(|error| format!("driver bitmap printer task failed: {error}"))?
}

#[tauri::command]
pub async fn desktop_printer_send_driver_page(
    app: AppHandle,
    printer: State<'_, PrinterTransportState>,
    payload: DriverPagePayload,
) -> Result<PrintReceipt, String> {
    let printer = (*printer).clone();
    tauri::async_runtime::spawn_blocking(move || {
        let receipt = printer.submit_driver_page(app.clone(), payload)?;
        app.state::<GeneratorState>()
            .record_renderer_fallback(receipt.bytes);
        Ok(receipt)
    })
    .await
    .map_err(|error| format!("driver page printer task failed: {error}"))?
}

#[tauri::command]
pub fn desktop_printer_plan_backend(
    payload: BackendPlanPayload,
) -> Result<UniversalPrinterPlan, String> {
    plan_backend(&payload)
}

#[tauri::command]
pub async fn desktop_printer_warmup_raw(
    app: AppHandle,
    printer: State<'_, PrinterTransportState>,
    payload: Value,
) -> Result<PrintReceipt, String> {
    let printer = (*printer).clone();
    tauri::async_runtime::spawn_blocking(move || printer.warmup(app, payload))
        .await
        .map_err(|error| format!("raw printer warmup task failed: {error}"))?
}

#[tauri::command]
pub fn desktop_printer_transport_summary(
    printer: State<'_, PrinterTransportState>,
) -> PrinterTransportSummary {
    printer.summary()
}

#[tauri::command]
pub fn desktop_printer_disconnect_all(printer: State<'_, PrinterTransportState>) {
    printer.disconnect_all();
}
#[tauri::command]
pub async fn desktop_printer_query_status(
    app: AppHandle,
    printer: State<'_, PrinterTransportState>,
    payload: Value,
) -> Result<PrinterStatusReport, String> {
    let printer = (*printer).clone();
    tauri::async_runtime::spawn_blocking(move || {
        query_printer_status_routed(RuntimeEventSink::tauri(app), &printer, payload)
    })
    .await
    .map_err(|error| format!("printer status task failed: {error}"))?
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrinterDiagnosticExportPayload {
    pub report: Value,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub format: Option<String>,
}

#[tauri::command]
pub fn desktop_printer_export_diagnostic(
    app: AppHandle,
    payload: PrinterDiagnosticExportPayload,
) -> Result<Option<DiagnosticExportReceipt>, String> {
    let requested_format = payload
        .format
        .as_deref()
        .unwrap_or("zip")
        .trim()
        .to_ascii_lowercase();
    if !matches!(requested_format.as_str(), "zip" | "json") {
        return Err("diagnostic export format must be zip or json".to_owned());
    }
    let path = match payload
        .path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(path) => Some(PathBuf::from(path)),
        None => {
            let unix_ms = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis();
            let file_name = format!("labelpilot-printer-diagnostic-{unix_ms}.{requested_format}");
            resolve_save_path(
                &app,
                "Экспорт диагностики принтеров",
                &file_name,
                "LabelPilot Diagnostic",
                &[requested_format.as_str()],
            )?
        }
    };
    path.map(|path| diagnostic_export::export_report(&path, &payload.report))
        .transpose()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DurableJobsQuery {
    #[serde(default)]
    pub state: Option<String>,
    #[serde(default)]
    pub limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DurableJobPayload {
    pub job_id: String,
}

#[tauri::command]
pub fn desktop_printer_durable_jobs(
    printer: State<'_, PrinterTransportState>,
    payload: Option<DurableJobsQuery>,
) -> Result<Vec<DurablePrintJobRecord>, String> {
    let state = payload.as_ref().and_then(|value| value.state.as_deref());
    let limit = payload.as_ref().and_then(|value| value.limit);
    printer.durable_jobs(state, limit)
}

#[tauri::command]
pub fn desktop_printer_durable_summary(
    printer: State<'_, PrinterTransportState>,
) -> Result<DurableQueueSummary, String> {
    printer.durable_summary()
}

#[tauri::command]
pub async fn desktop_printer_retry_durable(
    app: AppHandle,
    printer: State<'_, PrinterTransportState>,
    payload: DurableJobPayload,
) -> Result<PrintReceipt, String> {
    let printer = (*printer).clone();
    tauri::async_runtime::spawn_blocking(move || printer.retry_durable(app, &payload.job_id))
        .await
        .map_err(|error| format!("durable printer retry task failed: {error}"))?
}

#[tauri::command]
pub fn desktop_printer_cancel_durable(
    app: AppHandle,
    printer: State<'_, PrinterTransportState>,
    payload: DurableJobPayload,
) -> Result<DurablePrintJobRecord, String> {
    printer.cancel_durable(&app, &payload.job_id)
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedPrintReceipt {
    pub generation: GenerationMetadata,
    pub transport: PrintReceipt,
}

#[tauri::command]
pub async fn desktop_printer_plan_generation(
    app: AppHandle,
    payload: GenerationPayload,
) -> Result<GenerationPlan, String> {
    tauri::async_runtime::spawn_blocking(move || app.state::<GeneratorState>().plan(&payload))
        .await
        .map_err(|error| format!("printer generation plan task failed: {error}"))?
}

#[tauri::command]
pub async fn desktop_printer_generate_native(
    app: AppHandle,
    payload: GenerationPayload,
) -> Result<NativeGenerationReceipt, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<GeneratorState>().generate_receipt(payload)
    })
    .await
    .map_err(|error| format!("native printer generation task failed: {error}"))?
}

#[tauri::command]
pub async fn desktop_printer_generate_and_send(
    app: AppHandle,
    printer: State<'_, PrinterTransportState>,
    payload: GenerationPayload,
) -> Result<GeneratedPrintReceipt, String> {
    let printer = (*printer).clone();
    tauri::async_runtime::spawn_blocking(move || {
        let config = payload.config.clone();
        let generated = app.state::<GeneratorState>().generate(payload)?;
        let transport = printer.submit_generated(app, config, generated.bytes)?;
        Ok(GeneratedPrintReceipt {
            generation: generated.metadata,
            transport,
        })
    })
    .await
    .map_err(|error| format!("native printer generate/send task failed: {error}"))?
}

#[tauri::command]
pub fn desktop_printer_generator_summary(generator: State<'_, GeneratorState>) -> GeneratorSummary {
    generator.summary()
}

#[tauri::command]
pub fn desktop_get_identity(state: State<'_, PersistedState>) -> Option<Value> {
    state.load_identity()
}

#[tauri::command]
pub fn desktop_get_next_sequence(state: State<'_, PersistedState>, payload: String) -> Value {
    match state.next_sequence(&payload) {
        Ok(number) => serde_json::json!({ "success": true, "number": number }),
        Err(message) => serde_json::json!({ "success": false, "message": message }),
    }
}

#[tauri::command]
pub async fn desktop_sync_data(
    app: AppHandle,
    network: State<'_, NetworkState>,
    persisted: State<'_, PersistedState>,
    payload: String,
) -> Result<bool, String> {
    let client = network.client();
    let station_uuid = persisted.load_identity().and_then(|identity| {
        identity
            .get("station_uuid")
            .and_then(Value::as_str)
            .map(str::to_owned)
    });
    let client_version = app.package_info().version.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        test_connection_full(&client, &payload, station_uuid.as_deref(), &client_version).online
    })
    .await
    .map_err(|error| format!("server ping task failed: {error}"))
}

#[tauri::command]
pub fn desktop_get_server_status(network: State<'_, NetworkState>) -> String {
    network.status().as_str().to_owned()
}

#[tauri::command]
pub async fn desktop_get_license_status(
    network: State<'_, NetworkState>,
    persisted: State<'_, PersistedState>,
    payload: Option<String>,
) -> Result<crate::network::LicenseFetchResult, String> {
    let server_ip = payload
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| {
            persisted
                .load_printer_config()
                .get("serverIp")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned()
        });
    let client = network.client();
    tauri::async_runtime::spawn_blocking(move || fetch_license_status(&client, &server_ip))
        .await
        .map_err(|error| format!("license request task failed: {error}"))
}

#[tauri::command]
pub fn desktop_set_app_mode(
    network: State<'_, NetworkState>,
    payload: String,
) -> Result<(), String> {
    network.set_mode(&payload)
}

#[tauri::command]
pub fn desktop_renderer_ready(
    app: AppHandle,
    network: State<'_, NetworkState>,
) -> Result<(), String> {
    network.emit_current_status(&app)
}

#[tauri::command]
pub fn desktop_network_summary(network: State<'_, NetworkState>) -> NetworkSummary {
    network.summary()
}

#[tauri::command]
pub fn desktop_ingress_summary(ingress: State<'_, IngressState>) -> IngressSummary {
    ingress.summary()
}

#[tauri::command]
pub fn desktop_telemetry_summary(
    app: AppHandle,
    telemetry: State<'_, TelemetryState>,
) -> TelemetrySummary {
    telemetry.summary(&app)
}

#[tauri::command]
pub async fn desktop_telemetry_flush(
    app: AppHandle,
    telemetry: State<'_, TelemetryState>,
) -> Result<TelemetrySummary, String> {
    let telemetry = (*telemetry).clone();
    tauri::async_runtime::spawn_blocking(move || telemetry.flush_now(&app, "manual"))
        .await
        .map_err(|error| format!("telemetry flush task failed: {error}"))?
}

#[tauri::command]
pub fn desktop_get_station_info(operational: State<'_, OperationalState>) -> Result<Value, String> {
    operational.station_info()
}

#[tauri::command]
pub fn desktop_get_products(
    operational: State<'_, OperationalState>,
    payload: Option<String>,
) -> Result<Vec<Value>, String> {
    operational.products(payload.as_deref(), false)
}

#[tauri::command]
pub fn desktop_get_fixed_weight_products(
    operational: State<'_, OperationalState>,
    payload: Option<String>,
) -> Result<Vec<Value>, String> {
    operational.products(payload.as_deref(), true)
}

#[tauri::command]
pub fn desktop_get_containers(
    operational: State<'_, OperationalState>,
) -> Result<Vec<Value>, String> {
    operational.containers()
}

#[tauri::command]
pub fn desktop_get_label(
    operational: State<'_, OperationalState>,
    payload: i64,
) -> Result<Option<Value>, String> {
    operational.label(payload)
}

#[tauri::command]
pub fn desktop_get_all_labels(
    operational: State<'_, OperationalState>,
) -> Result<Vec<Value>, String> {
    operational.all_labels()
}

#[tauri::command]
pub fn desktop_get_barcode_template(
    operational: State<'_, OperationalState>,
    payload: i64,
) -> Result<Option<Value>, String> {
    operational.barcode_template(payload)
}

#[tauri::command]
pub fn desktop_get_printers() -> Result<Vec<SystemPrinterInfo>, String> {
    list_system_printers()
}

#[tauri::command]
pub fn desktop_get_print_jobs(
    operational: State<'_, OperationalState>,
    payload: Option<String>,
) -> Result<Vec<Value>, String> {
    operational.print_jobs(payload.as_deref())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdatePrintJobProgressPayload {
    job_id: i64,
    printed_qty: f64,
}

#[tauri::command]
pub fn desktop_update_print_job_progress(
    app: AppHandle,
    operational: State<'_, OperationalState>,
    payload: UpdatePrintJobProgressPayload,
) -> Result<Value, String> {
    let result = operational.update_print_job_progress(payload.job_id, payload.printed_qty)?;
    let _ = app.emit("print-jobs-updated", Value::Null);
    Ok(result)
}

#[tauri::command]
pub fn desktop_complete_print_job(
    app: AppHandle,
    operational: State<'_, OperationalState>,
    payload: i64,
) -> Result<Value, String> {
    let result = operational.complete_print_job(payload)?;
    let _ = app.emit("print-jobs-updated", Value::Null);
    Ok(result)
}

#[tauri::command]
pub fn desktop_delete_print_job(
    app: AppHandle,
    operational: State<'_, OperationalState>,
    payload: i64,
) -> Result<Value, String> {
    let result = operational.delete_print_job(payload)?;
    let _ = app.emit("print-jobs-updated", Value::Null);
    Ok(result)
}
#[tauri::command]
pub fn desktop_record_pack(
    operational: State<'_, OperationalState>,
    session: State<'_, SessionState>,
    payload: RecordPackPayload,
) -> Result<RecordPackResult, String> {
    operational.record_pack(payload, session.attribution())
}

#[tauri::command]
pub fn desktop_close_box(
    operational: State<'_, OperationalState>,
    payload: CloseBoxPayload,
) -> Result<Value, String> {
    operational.close_box(payload)
}

#[tauri::command]
pub fn desktop_get_latest_counters(
    operational: State<'_, OperationalState>,
    payload: Option<i64>,
) -> Result<Value, String> {
    operational.latest_counters(payload)
}

#[tauri::command]
pub fn desktop_get_open_pallet_content(
    operational: State<'_, OperationalState>,
    payload: Option<i64>,
) -> Result<Value, String> {
    operational.open_pallet_content(payload)
}

#[tauri::command]
pub fn desktop_get_pallet_render_data(
    operational: State<'_, OperationalState>,
    payload: Option<Value>,
) -> Result<Value, String> {
    operational.pallet_render_data(payload.unwrap_or_else(|| serde_json::json!({})))
}

#[tauri::command]
pub fn desktop_close_pallet(app: AppHandle, operational: State<'_, OperationalState>) -> Value {
    match operational.close_current_pallet() {
        Ok(result) => {
            if result.get("success").and_then(Value::as_bool) == Some(true) {
                let _ = app.emit("data-updated", Value::Null);
            }
            result
        }
        Err(error) => serde_json::json!({ "success": false, "error": error }),
    }
}

#[tauri::command]
pub fn desktop_delete_pack(
    operational: State<'_, OperationalState>,
    payload: i64,
) -> Result<Value, String> {
    operational.delete_pack(payload)
}

#[tauri::command]
pub fn desktop_delete_box(
    operational: State<'_, OperationalState>,
    payload: i64,
) -> Result<Value, String> {
    operational.delete_box(payload)
}

#[tauri::command]
pub fn desktop_list_operators(
    operational: State<'_, OperationalState>,
    session: State<'_, SessionState>,
) -> Result<Value, String> {
    Ok(serde_json::json!({
        "operators": operational.list_operators()?,
        "lastOperatorUuid": session.last_operator_uuid(),
    }))
}

#[tauri::command]
pub fn desktop_session_get(session: State<'_, SessionState>) -> Option<CurrentOperator> {
    session.current()
}

#[derive(Deserialize)]
pub struct SetSessionPayload {
    uuid: String,
    #[serde(default)]
    pin: String,
}

#[tauri::command]
pub fn desktop_session_set(
    app: AppHandle,
    operational: State<'_, OperationalState>,
    session: State<'_, SessionState>,
    payload: SetSessionPayload,
) -> Result<Value, String> {
    let result = session.set(&operational, &payload.uuid, &payload.pin)?;
    if result.get("ok").and_then(Value::as_bool) == Some(true) {
        let _ = app.emit(
            "session-changed",
            result.get("operator").cloned().unwrap_or(Value::Null),
        );
    }
    Ok(result)
}

#[tauri::command]
pub fn desktop_session_logout(
    app: AppHandle,
    operational: State<'_, OperationalState>,
    persisted: State<'_, PersistedState>,
    session: State<'_, SessionState>,
) -> Result<Value, String> {
    let open = operational.open_entities_summary()?;
    let pallet_blocks =
        open.open_pallet_count > 0 && has_pallet_target(&persisted.load_printer_config());
    if open.open_box_count > 0 || pallet_blocks {
        return Ok(serde_json::json!({
            "ok": false,
            "reason": "open_entities",
            "openBoxCount": open.open_box_count,
            "openBoxNumber": open.open_box_number,
            "openPalletCount": if pallet_blocks { open.open_pallet_count } else { 0 },
        }));
    }
    session.clear()?;
    let _ = app.emit("session-changed", Value::Null);
    Ok(serde_json::json!({ "ok": true }))
}

fn has_pallet_target(config: &Value) -> bool {
    let Some(printer) = config.get("palletPrinter").and_then(Value::as_object) else {
        return false;
    };
    match printer.get("connection").and_then(Value::as_str) {
        Some("tcp") => printer
            .get("ip")
            .and_then(Value::as_str)
            .is_some_and(|value| !value.is_empty()),
        Some("serial") => printer
            .get("serialPort")
            .and_then(Value::as_str)
            .is_some_and(|value| !value.is_empty()),
        _ => printer
            .get("driverName")
            .and_then(Value::as_str)
            .is_some_and(|value| !value.is_empty()),
    }
}

#[tauri::command]
pub fn desktop_log(
    app: AppHandle,
    state: State<'_, RuntimeState>,
    telemetry: State<'_, TelemetryState>,
    payload: Option<Value>,
) -> Result<(), String> {
    let level = payload
        .as_ref()
        .and_then(Value::as_object)
        .and_then(|object| object.get("level"))
        .and_then(Value::as_str)
        .unwrap_or("INFO")
        .to_owned();
    let event = payload
        .as_ref()
        .and_then(Value::as_object)
        .and_then(|object| object.get("event"))
        .and_then(Value::as_str)
        .unwrap_or("renderer_log")
        .to_owned();
    let telemetry_message = payload
        .as_ref()
        .and_then(Value::as_object)
        .and_then(|object| object.get("message"))
        .and_then(Value::as_str)
        .unwrap_or("renderer log event")
        .chars()
        .take(2_000)
        .collect::<String>();
    state.log("RENDERER", &payload_message(payload))?;
    telemetry.record_event(
        &app,
        &level,
        "renderer",
        &event,
        json!({ "message": telemetry_message }),
    )
}

#[tauri::command]
pub fn desktop_open_logs_folder(
    app: AppHandle,
    state: State<'_, RuntimeState>,
) -> Result<String, String> {
    let directory = app
        .path()
        .app_log_dir()
        .map_err(|error| format!("failed to resolve log directory: {error}"))?;
    fs::create_dir_all(&directory).map_err(|error| {
        format!(
            "failed to create log directory {}: {error}",
            directory.display()
        )
    })?;
    state.log("INFO", "opening runtime log directory")?;
    open_directory(&directory)?;
    Ok(directory.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn desktop_quit_app(app: AppHandle, state: State<'_, RuntimeState>) -> Result<(), String> {
    if !state.begin_shutdown() {
        return Ok(());
    }
    let _ = state.log("INFO", "runtime exit requested by renderer");
    let shutdown_app = app.clone();
    match std::thread::Builder::new()
        .name("labelpilot-shutdown".to_owned())
        .spawn(move || {
            shutdown_app.state::<IngressState>().stop();
            let _ = shutdown_app
                .state::<RuntimeState>()
                .log("INFO", "shutdown stage complete: ingress");

            shutdown_app
                .state::<TelemetryState>()
                .shutdown(&shutdown_app);
            let _ = shutdown_app
                .state::<RuntimeState>()
                .log("INFO", "shutdown stage complete: telemetry");

            // The network worker queries window visibility on the Tauri main thread.
            // Joining it from an IPC command on that same thread deadlocks shutdown.
            shutdown_app.state::<NetworkState>().stop();
            let _ = shutdown_app
                .state::<RuntimeState>()
                .log("INFO", "shutdown stage complete: network");

            shutdown_app.state::<ScaleState>().disconnect(&shutdown_app);
            let _ = shutdown_app
                .state::<RuntimeState>()
                .log("INFO", "shutdown stage complete: scale");

            shutdown_app
                .state::<PrinterTransportState>()
                .disconnect_all();
            let _ = shutdown_app
                .state::<RuntimeState>()
                .log("INFO", "shutdown stage complete: printers");
            let _ = shutdown_app
                .state::<RuntimeState>()
                .log("INFO", "runtime shutdown complete");
            shutdown_app.exit(0);
        }) {
        Ok(_) => Ok(()),
        Err(error) => {
            state.cancel_shutdown();
            Err(format!("failed to start shutdown worker: {error}"))
        }
    }
}

#[cfg(target_os = "windows")]
fn open_directory(path: &Path) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    std::process::Command::new("explorer.exe")
        .arg(path)
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("failed to open log directory {}: {error}", path.display()))
}

#[cfg(target_os = "macos")]
fn open_directory(path: &Path) -> Result<(), String> {
    std::process::Command::new("open")
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("failed to open log directory {}: {error}", path.display()))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn open_directory(path: &Path) -> Result<(), String> {
    std::process::Command::new("xdg-open")
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("failed to open log directory {}: {error}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_control_characters_and_bounds_log_fields() {
        assert_eq!(sanitize_log_field("one\r\ntwo\0", 20), "onetwo");
        assert_eq!(sanitize_log_field("abcdef", 3), "abc");
    }

    #[test]
    fn shutdown_gate_is_idempotent_and_can_recover_after_spawn_failure() {
        let directory = std::env::temp_dir().join(format!(
            "labelpilot-shutdown-gate-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        let state = RuntimeState::new(directory.clone()).expect("create runtime state");
        assert!(state.begin_shutdown());
        assert!(!state.begin_shutdown());
        state.cancel_shutdown();
        assert!(state.begin_shutdown());
        drop(state);
        fs::remove_dir_all(directory).expect("remove runtime state directory");
    }

    #[test]
    fn exposes_the_fixed_desktop_contract_counts() {
        let summary = desktop_contract_summary();
        assert_eq!(summary.invoke_channels, 59);
        assert_eq!(summary.send_channels, 11);
        assert_eq!(summary.event_channels, 19);
    }
}
