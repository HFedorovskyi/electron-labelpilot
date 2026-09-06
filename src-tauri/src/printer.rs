mod backend;
mod durable;
mod serial;
mod spooler;
mod status;
mod write;
use self::write::write_job_once;
#[cfg(test)]
mod regression_tests;

pub use backend::{plan_backend, BackendPlanPayload, UniversalPrinterPlan};
pub use durable::{DurablePrintJobRecord, DurableQueueSummary};
pub use status::PrinterStatusReport;

use crate::runtime_events::RuntimeEventSink;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use serial::SerialConnection;
use std::collections::{HashMap, HashSet};
use std::io;
use std::net::{IpAddr, Shutdown, SocketAddr, TcpStream, ToSocketAddrs};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender, TrySendError};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
#[cfg(feature = "desktop")]
use tauri::AppHandle;

const DEFAULT_TCP_PORT: u16 = 9100;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
const WRITE_TIMEOUT: Duration = Duration::from_secs(3);
const IDLE_CLOSE: Duration = Duration::from_millis(400);
const BREAKER_DURATION: Duration = Duration::from_secs(5);
const WORKER_POLL: Duration = Duration::from_millis(50);
const COMPLETION_TIMEOUT: Duration = Duration::from_secs(60);
const IDEMPOTENCY_TTL: Duration = Duration::from_secs(10 * 60);
const MAX_IDEMPOTENCY_ENTRIES: usize = 2_048;
pub const PRINTER_QUEUE_CAPACITY: usize = 16;
pub const MAX_PRINTER_WORKERS: usize = 12;
pub const MAX_RAW_JOB_BYTES: usize = 16 * 1024 * 1024;

fn default_active() -> bool {
    true
}

fn default_protocol() -> String {
    "zpl".to_owned()
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemPrinterInfo {
    pub name: String,
    pub display_name: String,
    pub description: String,
    pub status: u32,
    pub is_default: bool,
}

#[cfg(windows)]
pub fn list_system_printers() -> Result<Vec<SystemPrinterInfo>, String> {
    use std::io;
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::Graphics::Printing::{
        EnumPrintersW, GetDefaultPrinterW, PRINTER_ENUM_CONNECTIONS, PRINTER_ENUM_LOCAL,
        PRINTER_INFO_4W,
    };

    fn wide_string(pointer: *const u16) -> String {
        if pointer.is_null() {
            return String::new();
        }
        let mut length = 0_usize;
        while length < 32_768 && unsafe { *pointer.add(length) } != 0 {
            length += 1;
        }
        String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(pointer, length) })
    }

    fn default_printer_name() -> Option<String> {
        let mut length = 0_u32;
        unsafe { GetDefaultPrinterW(null_mut(), &mut length) };
        if length <= 1 {
            return None;
        }
        let mut buffer = vec![0_u16; length as usize];
        if unsafe { GetDefaultPrinterW(buffer.as_mut_ptr(), &mut length) } == 0 {
            return None;
        }
        let end = buffer
            .iter()
            .position(|value| *value == 0)
            .unwrap_or(buffer.len());
        Some(String::from_utf16_lossy(&buffer[..end]))
    }

    let flags = PRINTER_ENUM_LOCAL | PRINTER_ENUM_CONNECTIONS;
    let mut needed = 0_u32;
    let mut returned = 0_u32;
    unsafe { EnumPrintersW(flags, null(), 4, null_mut(), 0, &mut needed, &mut returned) };
    if needed == 0 {
        return Ok(Vec::new());
    }

    let word_size = std::mem::size_of::<usize>();
    let mut buffer = vec![0_usize; (needed as usize).div_ceil(word_size)];
    let ok = unsafe {
        EnumPrintersW(
            flags,
            null(),
            4,
            buffer.as_mut_ptr().cast::<u8>(),
            buffer.len().saturating_mul(word_size) as u32,
            &mut needed,
            &mut returned,
        )
    };
    if ok == 0 {
        return Err(format!(
            "Windows spooler EnumPrintersW: {}",
            io::Error::last_os_error()
        ));
    }

    let default_name = default_printer_name();
    let entries = unsafe {
        std::slice::from_raw_parts(buffer.as_ptr().cast::<PRINTER_INFO_4W>(), returned as usize)
    };
    let mut printers: Vec<SystemPrinterInfo> = entries
        .iter()
        .filter_map(|entry| {
            let name = wide_string(entry.pPrinterName);
            if name.is_empty() {
                return None;
            }
            Some(SystemPrinterInfo {
                display_name: name.clone(),
                is_default: default_name.as_deref() == Some(name.as_str()),
                name,
                description: String::new(),
                status: 0,
            })
        })
        .collect();
    printers.sort_by(|left, right| {
        right.is_default.cmp(&left.is_default).then_with(|| {
            left.display_name
                .to_lowercase()
                .cmp(&right.display_name.to_lowercase())
        })
    });
    Ok(printers)
}

#[cfg(not(windows))]
pub fn list_system_printers() -> Result<Vec<SystemPrinterInfo>, String> {
    Ok(Vec::new())
}
/// Status probe that routes through an active serial print worker when one
/// holds the port (see [`PrinterTransportState::query_printer_status_with_sink`]).
pub fn query_printer_status_routed(
    app: RuntimeEventSink,
    transport: &PrinterTransportState,
    config: Value,
) -> Result<PrinterStatusReport, String> {
    let config = PrinterDeviceConfig::from_value(config)?;
    transport.query_printer_status_with_sink(app, &config)
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrinterDeviceConfig {
    pub id: String,
    #[serde(default = "default_active")]
    pub active: bool,
    #[serde(default)]
    pub name: String,
    pub connection: String,
    #[serde(default = "default_protocol")]
    pub protocol: String,
    #[serde(default)]
    pub ip: Option<String>,
    #[serde(default)]
    pub port: Option<u64>,
    #[serde(default)]
    tcp_job_boundary: Option<String>,
    #[serde(default)]
    pub serial_port: Option<String>,
    #[serde(default)]
    pub baud_rate: Option<u64>,
    #[serde(default)]
    pub driver_name: Option<String>,
    #[serde(default)]
    pub job_idempotency_key: Option<String>,
}

impl PrinterDeviceConfig {
    pub fn from_value(value: Value) -> Result<Self, String> {
        let mut config: Self = serde_json::from_value(value)
            .map_err(|error| format!("invalid printer config: {error}"))?;
        config.id = config.id.trim().to_owned();
        config.name = config.name.trim().to_owned();
        config.connection = config.connection.trim().to_ascii_lowercase();
        config.protocol = config.protocol.trim().to_ascii_lowercase();
        config.ip = config.ip.map(|value| value.trim().to_owned());
        config.tcp_job_boundary = config
            .tcp_job_boundary
            .map(|value| value.trim().to_ascii_lowercase())
            .filter(|value| !value.is_empty());
        config.serial_port = config.serial_port.map(|value| value.trim().to_owned());
        config.driver_name = config.driver_name.map(|value| value.trim().to_owned());
        config.job_idempotency_key = config
            .job_idempotency_key
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty());
        if config
            .job_idempotency_key
            .as_deref()
            .is_some_and(|value| value.len() > 128 || value.chars().any(char::is_control))
        {
            return Err("job idempotency key must contain 1..128 printable bytes".to_owned());
        }
        if config.id.is_empty() || config.id.len() > 128 {
            return Err("printer id must contain 1..128 bytes".to_owned());
        }
        if config.name.len() > 256 {
            return Err("printer name exceeds 256 bytes".to_owned());
        }
        match config.connection.as_str() {
            "tcp" => {
                let host = config.ip.as_deref().unwrap_or_default();
                if host.is_empty() || host.len() > 253 {
                    return Err("TCP printer IP/host must contain 1..253 bytes".to_owned());
                }
                let port = config.port.unwrap_or(DEFAULT_TCP_PORT as u64);
                if !(1..=u16::MAX as u64).contains(&port) {
                    return Err("TCP printer port must be in 1..65535".to_owned());
                }
                if config
                    .tcp_job_boundary
                    .as_deref()
                    .is_some_and(|value| !matches!(value, "stream" | "eof"))
                {
                    return Err("TCP job boundary must be stream or eof".to_owned());
                }
            }
            "serial" => {
                let path = config.serial_port.as_deref().unwrap_or_default();
                if path.is_empty() || path.len() > 260 {
                    return Err("serial printer port must contain 1..260 bytes".to_owned());
                }
                let baud = config.baud_rate.unwrap_or(9_600);
                if !(300..=4_000_000).contains(&baud) {
                    return Err("serial printer baud rate must be in 300..4000000".to_owned());
                }
            }
            "windows_driver" => {
                let driver = config.driver_name.as_deref().unwrap_or_default();
                if driver.len() > 512 {
                    return Err("Windows printer name exceeds 512 bytes".to_owned());
                }
            }
            other => return Err(format!("unsupported printer connection: {other}")),
        }
        Ok(config)
    }

    fn port(&self) -> u16 {
        self.port.unwrap_or(DEFAULT_TCP_PORT as u64) as u16
    }

    fn baud_rate(&self) -> u32 {
        self.baud_rate.unwrap_or(9_600) as u32
    }

    pub fn physical_key(&self) -> String {
        match self.connection.as_str() {
            "tcp" => format!(
                "tcp:{}:{}",
                self.ip.as_deref().unwrap_or_default().to_ascii_lowercase(),
                self.port()
            ),
            "serial" => format!(
                "serial:{}:{}",
                self.serial_port
                    .as_deref()
                    .unwrap_or_default()
                    .to_ascii_uppercase(),
                self.baud_rate()
            ),
            "windows_driver" => {
                let name = self.driver_name.as_deref().unwrap_or_default();
                format!(
                    "spooler:{}",
                    if name.is_empty() {
                        "<default>".to_owned()
                    } else {
                        name.to_ascii_lowercase()
                    }
                )
            }
            _ => format!("unsupported:{}", self.connection),
        }
    }

    fn tcp_job_boundary(&self) -> TcpJobBoundary {
        match self.tcp_job_boundary.as_deref() {
            Some("stream") => TcpJobBoundary::Protocol,
            Some("eof") => TcpJobBoundary::Eof,
            _ => automatic_tcp_job_boundary(self.ip.as_deref().unwrap_or_default(), &self.protocol),
        }
    }

    fn keep_tcp_connection_open(&self) -> bool {
        self.connection == "tcp" && self.tcp_job_boundary() == TcpJobBoundary::Protocol
    }

    fn display_name(&self) -> &str {
        if self.name.is_empty() {
            &self.id
        } else {
            &self.name
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TcpJobBoundary {
    /// The printer language carries its own end-of-job marker (`^XZ`, `PRINT`, and so on).
    Protocol,
    /// A bridge consumes one job only after the sender closes the socket.
    Eof,
}

fn automatic_tcp_job_boundary(host: &str, protocol: &str) -> TcpJobBoundary {
    // Local virtual-printer bridges commonly buffer until EOF. Physical printers on
    // port 9100 consume the language's explicit end marker and benefit from reuse.
    if is_loopback_printer_host(host) {
        return TcpJobBoundary::Eof;
    }
    if matches!(
        protocol,
        "zpl" | "image" | "tspl" | "epl" | "cpcl" | "dpl" | "sbpl"
    ) {
        TcpJobBoundary::Protocol
    } else {
        TcpJobBoundary::Eof
    }
}

fn is_loopback_printer_host(host: &str) -> bool {
    let host = host
        .trim()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .trim_end_matches('.');
    host.eq_ignore_ascii_case("localhost")
        || host
            .parse::<IpAddr>()
            .map(|address| address.is_loopback())
            .unwrap_or(false)
}

/// Validated, fully encoded material. Constructed without any transport side effects.
#[cfg(feature = "slint-ui")]
pub(crate) struct PreparedPrinterJob {
    config: PrinterDeviceConfig,
    action: JobAction,
}

#[cfg(feature = "slint-ui")]
impl PreparedPrinterJob {
    pub(crate) fn with_idempotency_key(mut self, key: &str) -> Result<Self, String> {
        let key = key.trim();
        if key.is_empty() || key.len() > 128 || key.chars().any(char::is_control) {
            return Err("job idempotency key must contain 1..128 printable bytes".to_owned());
        }
        self.config.job_idempotency_key = Some(key.to_owned());
        Ok(self)
    }

    pub(crate) fn persist(self, transaction: &rusqlite::Transaction<'_>) -> Result<String, String> {
        let physical_key = self.config.physical_key();
        let fingerprint = action_fingerprint(&self.action);
        match durable::DurablePrintStore::prepare_on_connection(
            transaction, &self.config, &physical_key, fingerprint, &self.action,
        )? {
            durable::PrepareOutcome::New(job_id) => Ok(job_id),
            durable::PrepareOutcome::Cached(_) => Err("business print job already accepted".to_owned()),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawPrintPayload {
    pub config: Value,
    pub data_base64: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DriverBitmapPayload {
    pub config: Value,
    pub width_dots: u32,
    pub height_dots: u32,
    pub data_base64: String,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageMarginsMm {
    #[serde(default)]
    pub top: f64,
    #[serde(default)]
    pub right: f64,
    #[serde(default)]
    pub bottom: f64,
    #[serde(default)]
    pub left: f64,
}

fn default_page_fit() -> String {
    "fit-printable".to_owned()
}

fn default_page_document_name() -> String {
    "LabelPilot pallet sheet".to_owned()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DriverPagePayload {
    pub config: Value,
    pub width_dots: u32,
    pub height_dots: u32,
    pub data_base64: String,
    pub page_width_mm: f64,
    pub page_height_mm: f64,
    #[serde(default)]
    pub margins_mm: PageMarginsMm,
    #[serde(default = "default_page_fit")]
    pub fit_mode: String,
    #[serde(default = "default_page_document_name")]
    pub document_name: String,
}

#[derive(Clone, Debug)]
pub(super) struct DriverPageSpec {
    page_width_mm: f64,
    page_height_mm: f64,
    margins_mm: PageMarginsMm,
    fit_mode: String,
    document_name: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrintReceipt {
    pub printer_id: String,
    pub physical_key: String,
    pub bytes: usize,
    pub queue_ms: u64,
    pub send_ms: u64,
    pub attempts: u8,
    pub reused_connection: bool,
    pub delivery_state: String,
    pub confirmation_mode: String,
    pub idempotency_key: Option<String>,
    pub deduplicated: bool,
    #[serde(default)]
    pub durable_job_id: Option<String>,
    #[serde(default)]
    pub durable_state: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status_report: Option<Box<PrinterStatusReport>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrinterTransportSummary {
    pub worker_count: usize,
    pub queued_now: usize,
    pub active_now: usize,
    pub submitted_jobs: u64,
    pub completed_jobs: u64,
    pub failed_jobs: u64,
    pub rejected_jobs: u64,
    pub bytes_sent: u64,
    pub reconnects: u64,
    pub queue_capacity_per_printer: usize,
    pub max_workers: usize,
    pub max_job_bytes: usize,
    pub connect_timeout_ms: u64,
    pub write_timeout_ms: u64,
    pub idle_close_ms: u64,
    pub breaker_ms: u64,
    pub tcp_jobs: u64,
    pub serial_jobs: u64,
    pub spooler_jobs: u64,
    pub driver_bitmap_jobs: u64,
    pub driver_page_jobs: u64,
    pub deduplicated_jobs: u64,
    pub idempotency_conflicts: u64,
    pub uncertain_jobs: u64,
    pub idempotency_ttl_ms: u64,
    pub max_idempotency_entries: usize,
    pub supported_connections: [&'static str; 3],
    pub supported_print_targets: [&'static str; 2],
    pub available_backends: [&'static str; 9],
}

#[derive(Default)]
struct PrinterStats {
    queued_now: AtomicUsize,
    active_now: AtomicUsize,
    submitted_jobs: AtomicU64,
    completed_jobs: AtomicU64,
    failed_jobs: AtomicU64,
    rejected_jobs: AtomicU64,
    bytes_sent: AtomicU64,
    reconnects: AtomicU64,
    tcp_jobs: AtomicU64,
    serial_jobs: AtomicU64,
    spooler_jobs: AtomicU64,
    driver_bitmap_jobs: AtomicU64,
    driver_page_jobs: AtomicU64,
    deduplicated_jobs: AtomicU64,
    idempotency_conflicts: AtomicU64,
    uncertain_jobs: AtomicU64,
}

#[derive(Clone)]
enum IdempotencyOutcome {
    Pending,
    Completed(PrintReceipt),
    Failed(String),
}

struct IdempotencyEntry {
    fingerprint: u64,
    created_at: Instant,
    last_used_at: Instant,
    outcome: IdempotencyOutcome,
}

#[derive(Default)]
struct IdempotencyCache {
    entries: HashMap<String, IdempotencyEntry>,
}

#[derive(Debug)]
enum IdempotencyReservation {
    Bypass,
    Leader(String),
    Cached(PrintReceipt),
}

struct PrinterInner {
    workers: Mutex<HashMap<String, Arc<DeviceQueue>>>,
    stats: Arc<PrinterStats>,
    idempotency: Mutex<IdempotencyCache>,
    idempotency_changed: Condvar,
    durable: durable::DurablePrintStore,
}

#[derive(Clone)]
pub struct PrinterTransportState {
    inner: Arc<PrinterInner>,
}

impl PrinterTransportState {
    pub fn new() -> Self {
        Self::with_store(
            durable::DurablePrintStore::in_memory()
                .expect("initialize in-memory durable printer queue"),
        )
    }

    pub fn with_database(path: &Path) -> Result<Self, String> {
        Ok(Self::with_store(durable::DurablePrintStore::open(path)?))
    }

    fn with_store(durable: durable::DurablePrintStore) -> Self {
        Self {
            inner: Arc::new(PrinterInner {
                workers: Mutex::new(HashMap::new()),
                stats: Arc::new(PrinterStats::default()),
                idempotency: Mutex::new(IdempotencyCache::default()),
                idempotency_changed: Condvar::new(),
                durable,
            }),
        }
    }

    #[cfg(feature = "desktop")]
    pub fn submit_raw(
        &self,
        app: AppHandle,
        payload: RawPrintPayload,
    ) -> Result<PrintReceipt, String> {
        let app = RuntimeEventSink::tauri(app);
        let config = PrinterDeviceConfig::from_value(payload.config)?;
        let max_encoded = MAX_RAW_JOB_BYTES.div_ceil(3) * 4 + 8;
        if payload.data_base64.len() > max_encoded {
            self.inner
                .stats
                .rejected_jobs
                .fetch_add(1, Ordering::AcqRel);
            return Err(format!(
                "raw print base64 exceeds {} encoded bytes",
                max_encoded
            ));
        }
        let data = BASE64_STANDARD
            .decode(payload.data_base64.as_bytes())
            .map_err(|error| format!("invalid raw print base64: {error}"))?;
        self.submit_bytes_with_config(app, config, data)
    }

    #[cfg(feature = "desktop")]
    pub fn submit_generated(
        &self,
        app: AppHandle,
        config: Value,
        data: Vec<u8>,
    ) -> Result<PrintReceipt, String> {
        self.submit_generated_with_sink(RuntimeEventSink::tauri(app), config, data)
    }

    pub(crate) fn submit_generated_with_sink(
        &self,
        app: RuntimeEventSink,
        config: Value,
        data: Vec<u8>,
    ) -> Result<PrintReceipt, String> {
        let config = PrinterDeviceConfig::from_value(config)?;
        self.submit_bytes_with_config(app, config, data)
    }

    fn submit_bytes_with_config(
        &self,
        app: RuntimeEventSink,
        config: PrinterDeviceConfig,
        data: Vec<u8>,
    ) -> Result<PrintReceipt, String> {
        if data.is_empty() {
            self.inner
                .stats
                .rejected_jobs
                .fetch_add(1, Ordering::AcqRel);
            return Err("raw print data is empty".to_owned());
        }
        if data.len() > MAX_RAW_JOB_BYTES {
            self.inner
                .stats
                .rejected_jobs
                .fetch_add(1, Ordering::AcqRel);
            return Err(format!("raw print job exceeds {} bytes", MAX_RAW_JOB_BYTES));
        }
        self.submit(app, config, JobAction::Print(data))
    }

    #[cfg(feature = "slint-ui")]
    pub(crate) fn prepare_generated(
        &self,
        config: Value,
        data: Vec<u8>,
    ) -> Result<PreparedPrinterJob, String> {
        let config = PrinterDeviceConfig::from_value(config)?;
        if data.is_empty() || data.len() > MAX_RAW_JOB_BYTES {
            return Err(format!("raw print job must contain 1..{MAX_RAW_JOB_BYTES} bytes"));
        }
        Ok(PreparedPrinterJob { config, action: JobAction::Print(data) })
    }

    #[cfg(feature = "slint-ui")]
    pub(crate) fn submit_prepared_with_sink(
        &self,
        app: RuntimeEventSink,
        job: PreparedPrinterJob,
    ) -> Result<PrintReceipt, String> {
        self.submit(app, job.config, job.action)
    }

    #[cfg(feature = "slint-ui")]
    pub(crate) fn submit_committed_with_sink(
        &self,
        app: RuntimeEventSink,
        job_id: &str,
    ) -> Result<PrintReceipt, String> {
        // Reload through a different connection: uncommitted jobs are never dispatchable.
        let job = self.inner.durable.committed_job(job_id)?;
        emit_durable_status(&app, Some(job_id), "queued", None);
        self.submit_stored(app, job)
    }

    #[cfg(feature = "slint-ui")]
    pub(crate) fn prepare_driver_bitmap(
        &self,
        config: Value,
        width: u32,
        height: u32,
        mono: Vec<u8>,
    ) -> Result<PreparedPrinterJob, String> {
        let config = PrinterDeviceConfig::from_value(config)?;
        if config.connection != "windows_driver" {
            return Err("driver bitmap printing requires windows_driver connection".to_owned());
        }
        if width == 0 || height == 0 || width > 10_000 || height > 10_000 {
            return Err("driver bitmap dimensions must be in 1..10000 dots".to_owned());
        }
        let expected = width.div_ceil(8) as usize * height as usize;
        if mono.len() != expected || mono.len() > MAX_RAW_JOB_BYTES {
            return Err(format!(
                "driver bitmap requires exactly {expected} bytes, got {}",
                mono.len()
            ));
        }
        Ok(PreparedPrinterJob {
            config,
            action: JobAction::DriverBitmap {
                width,
                height,
                mono,
            },
        })
    }
    #[cfg(feature = "slint-ui")]
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn prepare_driver_page(
        &self,
        config: Value,
        width: u32,
        height: u32,
        mono: Vec<u8>,
        page_width_mm: f64,
        page_height_mm: f64,
        margins_mm: PageMarginsMm,
        fit_mode: String,
        document_name: String,
    ) -> Result<PreparedPrinterJob, String> {
        let config = PrinterDeviceConfig::from_value(config)?;
        if config.connection != "windows_driver" {
            return Err("page-sheet printing requires windows_driver connection".to_owned());
        }
        if width == 0 || height == 0 || width > 10_000 || height > 10_000 {
            return Err("driver page bitmap dimensions must be in 1..10000 dots".to_owned());
        }
        if !page_width_mm.is_finite()
            || !page_height_mm.is_finite()
            || !(25.0..=2_000.0).contains(&page_width_mm)
            || !(25.0..=2_000.0).contains(&page_height_mm)
        {
            return Err("driver page size must be in 25..2000 mm".to_owned());
        }
        if [
            margins_mm.top,
            margins_mm.right,
            margins_mm.bottom,
            margins_mm.left,
        ]
        .into_iter()
        .any(|value| !value.is_finite() || !(0.0..=100.0).contains(&value))
            || margins_mm.left + margins_mm.right >= page_width_mm
            || margins_mm.top + margins_mm.bottom >= page_height_mm
        {
            return Err("driver page margins are invalid for the selected page".to_owned());
        }
        let fit_mode = fit_mode.trim().to_ascii_lowercase();
        if !["fit-printable", "actual-size"].contains(&fit_mode.as_str()) {
            return Err(format!("unsupported driver page fit mode: {fit_mode}"));
        }
        let document_name = document_name.trim().to_owned();
        if document_name.is_empty() || document_name.len() > 256 {
            return Err("driver page document name must contain 1..256 bytes".to_owned());
        }
        let expected = width.div_ceil(8) as usize * height as usize;
        if mono.len() != expected || mono.len() > MAX_RAW_JOB_BYTES {
            return Err(format!(
                "driver page requires exactly {expected} bytes, got {}",
                mono.len()
            ));
        }
        Ok(PreparedPrinterJob {
            config,
            action: JobAction::DriverPage {
                width,
                height,
                mono,
                page: DriverPageSpec {
                    page_width_mm,
                    page_height_mm,
                    margins_mm,
                    fit_mode,
                    document_name,
                },
            },
        })
    }
    #[cfg(feature = "desktop")]
    pub fn submit_driver_bitmap(
        &self,
        app: AppHandle,
        payload: DriverBitmapPayload,
    ) -> Result<PrintReceipt, String> {
        let app = RuntimeEventSink::tauri(app);
        let config = PrinterDeviceConfig::from_value(payload.config)?;
        if config.connection != "windows_driver" {
            return Err("driver bitmap printing requires windows_driver connection".to_owned());
        }
        if payload.width_dots == 0
            || payload.height_dots == 0
            || payload.width_dots > 10_000
            || payload.height_dots > 10_000
        {
            return Err("driver bitmap dimensions must be in 1..10000 dots".to_owned());
        }
        let max_encoded = MAX_RAW_JOB_BYTES.div_ceil(3) * 4 + 8;
        if payload.data_base64.len() > max_encoded {
            return Err(format!(
                "driver bitmap base64 exceeds {max_encoded} encoded bytes"
            ));
        }
        let mono = BASE64_STANDARD
            .decode(payload.data_base64.as_bytes())
            .map_err(|error| format!("invalid driver bitmap base64: {error}"))?;
        let expected = payload.width_dots.div_ceil(8) as usize * payload.height_dots as usize;
        if mono.len() != expected || mono.len() > MAX_RAW_JOB_BYTES {
            return Err(format!(
                "driver bitmap requires exactly {expected} bytes, got {}",
                mono.len()
            ));
        }
        self.submit(
            app,
            config,
            JobAction::DriverBitmap {
                width: payload.width_dots,
                height: payload.height_dots,
                mono,
            },
        )
    }

    #[cfg(feature = "desktop")]
    pub fn submit_driver_page(
        &self,
        app: AppHandle,
        payload: DriverPagePayload,
    ) -> Result<PrintReceipt, String> {
        let app = RuntimeEventSink::tauri(app);
        let config = PrinterDeviceConfig::from_value(payload.config)?;
        if config.connection != "windows_driver" {
            return Err("page-sheet printing requires windows_driver connection".to_owned());
        }
        if payload.width_dots == 0
            || payload.height_dots == 0
            || payload.width_dots > 10_000
            || payload.height_dots > 10_000
        {
            return Err("driver page bitmap dimensions must be in 1..10000 dots".to_owned());
        }
        if !payload.page_width_mm.is_finite()
            || !payload.page_height_mm.is_finite()
            || !(25.0..=2_000.0).contains(&payload.page_width_mm)
            || !(25.0..=2_000.0).contains(&payload.page_height_mm)
        {
            return Err("driver page size must be in 25..2000 mm".to_owned());
        }
        let margins = payload.margins_mm;
        if [margins.top, margins.right, margins.bottom, margins.left]
            .into_iter()
            .any(|value| !value.is_finite() || !(0.0..=100.0).contains(&value))
        {
            return Err("driver page margins must be in 0..100 mm".to_owned());
        }
        if margins.left + margins.right >= payload.page_width_mm
            || margins.top + margins.bottom >= payload.page_height_mm
        {
            return Err("driver page margins consume the entire page".to_owned());
        }
        let fit_mode = payload.fit_mode.trim().to_ascii_lowercase();
        if !["fit-printable", "actual-size"].contains(&fit_mode.as_str()) {
            return Err(format!("unsupported driver page fit mode: {fit_mode}"));
        }
        let document_name = payload.document_name.trim();
        if document_name.is_empty() || document_name.len() > 256 {
            return Err("driver page document name must contain 1..256 bytes".to_owned());
        }
        let max_encoded = MAX_RAW_JOB_BYTES.div_ceil(3) * 4 + 8;
        if payload.data_base64.len() > max_encoded {
            return Err(format!(
                "driver page base64 exceeds {max_encoded} encoded bytes"
            ));
        }
        let mono = BASE64_STANDARD
            .decode(payload.data_base64.as_bytes())
            .map_err(|error| format!("invalid driver page base64: {error}"))?;
        let expected = payload.width_dots.div_ceil(8) as usize * payload.height_dots as usize;
        if mono.len() != expected || mono.len() > MAX_RAW_JOB_BYTES {
            return Err(format!(
                "driver page requires exactly {expected} bytes, got {}",
                mono.len()
            ));
        }
        let page = DriverPageSpec {
            page_width_mm: payload.page_width_mm,
            page_height_mm: payload.page_height_mm,
            margins_mm: margins,
            fit_mode,
            document_name: document_name.to_owned(),
        };
        self.submit(
            app,
            config,
            JobAction::DriverPage {
                width: payload.width_dots,
                height: payload.height_dots,
                mono,
                page,
            },
        )
    }

    #[cfg(feature = "desktop")]
    pub fn warmup(&self, app: AppHandle, config: Value) -> Result<PrintReceipt, String> {
        self.warmup_with_sink(RuntimeEventSink::tauri(app), config)
    }

    pub(crate) fn warmup_with_sink(
        &self,
        app: RuntimeEventSink,
        config: Value,
    ) -> Result<PrintReceipt, String> {
        let config = PrinterDeviceConfig::from_value(config)?;
        self.submit(app, config, JobAction::Probe)
    }

    fn reserve_idempotency(
        &self,
        config: &PrinterDeviceConfig,
        physical_key: &str,
        fingerprint: u64,
    ) -> Result<IdempotencyReservation, String> {
        let Some(key) = config.job_idempotency_key.as_deref() else {
            return Ok(IdempotencyReservation::Bypass);
        };
        let scope = format!("{physical_key}|{key}");
        let deadline = Instant::now() + COMPLETION_TIMEOUT;
        let mut cache = self
            .inner
            .idempotency
            .lock()
            .map_err(|_| "printer idempotency cache lock is poisoned")?;
        cache.entries.retain(|_, entry| {
            matches!(&entry.outcome, IdempotencyOutcome::Pending)
                || entry.created_at.elapsed() <= IDEMPOTENCY_TTL
        });
        loop {
            if let Some(entry) = cache.entries.get_mut(&scope) {
                entry.last_used_at = Instant::now();
                let existing_fingerprint = entry.fingerprint;
                let existing_outcome = entry.outcome.clone();
                if existing_fingerprint != fingerprint {
                    self.inner
                        .stats
                        .idempotency_conflicts
                        .fetch_add(1, Ordering::AcqRel);
                    return Err(format!(
                        "idempotency key conflict for printer {}",
                        config.display_name()
                    ));
                }
                match existing_outcome {
                    IdempotencyOutcome::Completed(mut receipt) => {
                        receipt.deduplicated = true;
                        self.inner
                            .stats
                            .deduplicated_jobs
                            .fetch_add(1, Ordering::AcqRel);
                        return Ok(IdempotencyReservation::Cached(receipt));
                    }
                    IdempotencyOutcome::Failed(error) => {
                        self.inner
                            .stats
                            .uncertain_jobs
                            .fetch_add(1, Ordering::AcqRel);
                        return Err(format!(
                            "IDEMPOTENCY_OUTCOME_UNCERTAIN: previous attempt with this key failed: {error}"
                        ));
                    }
                    IdempotencyOutcome::Pending => {
                        let remaining = deadline.saturating_duration_since(Instant::now());
                        if remaining.is_zero() {
                            return Err("timed out waiting for the first idempotent print attempt"
                                .to_owned());
                        }
                        let (next_cache, wait) = self
                            .inner
                            .idempotency_changed
                            .wait_timeout(cache, remaining)
                            .map_err(|_| "printer idempotency wait lock is poisoned")?;
                        cache = next_cache;
                        if wait.timed_out() {
                            return Err("timed out waiting for the first idempotent print attempt"
                                .to_owned());
                        }
                    }
                }
                continue;
            }
            if cache.entries.len() >= MAX_IDEMPOTENCY_ENTRIES {
                // Terminal outcomes are also in SQLite. Evict only those: a
                // cache miss must still pass durable.prepare before sending.
                let oldest = cache
                    .entries
                    .iter()
                    .filter(|(_, entry)| !matches!(entry.outcome, IdempotencyOutcome::Pending))
                    .min_by_key(|(_, entry)| entry.last_used_at)
                    .map(|(scope, _)| scope.clone());
                if let Some(oldest) = oldest {
                    cache.entries.remove(&oldest);
                } else {
                    return Err(format!(
                        "printer idempotency cache reached {MAX_IDEMPOTENCY_ENTRIES} in-flight entries"
                    ));
                }
            }
            cache.entries.insert(
                scope.clone(),
                IdempotencyEntry {
                    fingerprint,
                    created_at: Instant::now(),
                    last_used_at: Instant::now(),
                    outcome: IdempotencyOutcome::Pending,
                },
            );
            return Ok(IdempotencyReservation::Leader(scope));
        }
    }

    fn finish_idempotency(
        &self,
        scope: &str,
        fingerprint: u64,
        outcome: &Result<PrintReceipt, String>,
    ) {
        if let Ok(mut cache) = self.inner.idempotency.lock() {
            if let Some(entry) = cache.entries.get_mut(scope) {
                if entry.fingerprint == fingerprint {
                    entry.outcome = match outcome {
                        Ok(receipt) => IdempotencyOutcome::Completed(receipt.clone()),
                        Err(error) => IdempotencyOutcome::Failed(error.clone()),
                    };
                }
            }
            self.inner.idempotency_changed.notify_all();
        }
    }

    fn release_idempotency(&self, scope: &str, fingerprint: u64) {
        if let Ok(mut cache) = self.inner.idempotency.lock() {
            if cache
                .entries
                .get(scope)
                .is_some_and(|entry| entry.fingerprint == fingerprint)
            {
                cache.entries.remove(scope);
            }
            self.inner.idempotency_changed.notify_all();
        }
    }

    fn submit(
        &self,
        app: RuntimeEventSink,
        config: PrinterDeviceConfig,
        action: JobAction,
    ) -> Result<PrintReceipt, String> {
        let physical_key = config.physical_key();
        if matches!(&action, JobAction::Probe) {
            return self.submit_once(app, config, action, &physical_key, None);
        }

        let fingerprint = action_fingerprint(&action);
        let reservation = self.reserve_idempotency(&config, &physical_key, fingerprint)?;
        if let IdempotencyReservation::Cached(receipt) = reservation {
            emit_delivery_status(&app, &config.id, "connected", Some(&receipt));
            log_duplicate(&app, &config, &physical_key, &receipt);
            return Ok(receipt);
        }
        let leader_scope = match reservation {
            IdempotencyReservation::Leader(scope) => Some(scope),
            IdempotencyReservation::Bypass => None,
            IdempotencyReservation::Cached(_) => unreachable!(),
        };

        let durable = match self
            .inner
            .durable
            .prepare(&config, &physical_key, fingerprint, &action)
        {
            Ok(value) => value,
            Err(error) => {
                if let Some(scope) = leader_scope.as_deref() {
                    self.release_idempotency(scope, fingerprint);
                }
                return Err(error);
            }
        };
        if let durable::PrepareOutcome::Cached(receipt) = durable {
            self.inner
                .stats
                .deduplicated_jobs
                .fetch_add(1, Ordering::AcqRel);
            let outcome = Ok(receipt.clone());
            if let Some(scope) = leader_scope.as_deref() {
                self.finish_idempotency(scope, fingerprint, &outcome);
            }
            emit_delivery_status(&app, &config.id, "connected", Some(&receipt));
            emit_durable_status(&app, receipt.durable_job_id.as_deref(), "accepted", None);
            log_duplicate(&app, &config, &physical_key, &receipt);
            return Ok(receipt);
        }
        let durable_job_id = match durable {
            durable::PrepareOutcome::New(job_id) => job_id,
            durable::PrepareOutcome::Cached(_) => unreachable!(),
        };
        emit_durable_status(&app, Some(&durable_job_id), "queued", None);
        let outcome = self.submit_once(app, config, action, &physical_key, Some(durable_job_id));
        if let Some(scope) = leader_scope.as_deref() {
            self.finish_idempotency(scope, fingerprint, &outcome);
        }
        outcome
    }
    fn submit_once(
        &self,
        app: RuntimeEventSink,
        config: PrinterDeviceConfig,
        action: JobAction,
        physical_key: &str,
        durable_job_id: Option<String>,
    ) -> Result<PrintReceipt, String> {
        let printer_id = config.id.clone();
        let queue = match self.queue_for(physical_key) {
            Ok(queue) => queue,
            Err(error) => {
                if let Some(job_id) = durable_job_id.as_deref() {
                    let _ = self.inner.durable.mark_failed(job_id, &error);
                    emit_durable_status(&app, Some(job_id), "failed", Some(&error));
                }
                return Err(error);
            }
        };
        let (completion, result) = mpsc::sync_channel(1);
        let job = PrintJob {
            app: app.clone(),
            config,
            action,
            durable_job_id,
            submitted_at: Instant::now(),
            completion,
        };
        queue.depth.fetch_add(1, Ordering::AcqRel);
        self.inner.stats.queued_now.fetch_add(1, Ordering::AcqRel);
        let enqueue = match queue.sender.try_send(job) {
            Ok(()) => {
                self.inner
                    .stats
                    .submitted_jobs
                    .fetch_add(1, Ordering::AcqRel);
                Ok(())
            }
            Err(TrySendError::Full(job)) => {
                let error = format!(
                    "printer queue is full (capacity {})",
                    PRINTER_QUEUE_CAPACITY
                );
                if let Some(job_id) = job.durable_job_id.as_deref() {
                    let _ = self.inner.durable.mark_failed(job_id, &error);
                    emit_durable_status(&app, Some(job_id), "failed", Some(&error));
                }
                queue.depth.fetch_sub(1, Ordering::AcqRel);
                self.inner.stats.queued_now.fetch_sub(1, Ordering::AcqRel);
                self.inner
                    .stats
                    .rejected_jobs
                    .fetch_add(1, Ordering::AcqRel);
                Err(error)
            }
            Err(TrySendError::Disconnected(job)) => {
                let error = "printer worker is disconnected".to_owned();
                if let Some(job_id) = job.durable_job_id.as_deref() {
                    let _ = self.inner.durable.mark_failed(job_id, &error);
                    emit_durable_status(&app, Some(job_id), "failed", Some(&error));
                }
                queue.depth.fetch_sub(1, Ordering::AcqRel);
                self.inner.stats.queued_now.fetch_sub(1, Ordering::AcqRel);
                self.inner
                    .stats
                    .rejected_jobs
                    .fetch_add(1, Ordering::AcqRel);
                Err(error)
            }
        };
        let outcome = match enqueue {
            Ok(()) => result
                .recv_timeout(COMPLETION_TIMEOUT)
                .map_err(|_| "printer job completion timed out".to_owned())?,
            Err(error) => Err(error),
        };
        match &outcome {
            Ok(receipt) => {
                emit_delivery_status(&app, &printer_id, "connected", Some(receipt));
                log_printer(
                    &app,
                    "INFO",
                    &format!(
                        "Rust raw printer sent: id={} key={} bytes={} attempts={} reused={} delivery={}",
                        printer_id,
                        physical_key,
                        receipt.bytes,
                        receipt.attempts,
                        receipt.reused_connection,
                        receipt.delivery_state
                    ),
                );
            }
            Err(error) => {
                emit_delivery_status(&app, &printer_id, "error", None);
                log_printer(
                    &app,
                    "WARN",
                    &format!(
                        "Rust raw printer failed: id={} key={} error={}",
                        printer_id, physical_key, error
                    ),
                );
            }
        }
        outcome
    }
    fn queue_for(&self, key: &str) -> Result<Arc<DeviceQueue>, String> {
        let mut workers = self
            .inner
            .workers
            .lock()
            .map_err(|_| "printer worker map lock is poisoned")?;
        if let Some(worker) = workers.get(key) {
            return Ok(Arc::clone(worker));
        }
        if workers.len() >= MAX_PRINTER_WORKERS {
            self.inner
                .stats
                .rejected_jobs
                .fetch_add(1, Ordering::AcqRel);
            return Err(format!(
                "printer worker limit reached ({MAX_PRINTER_WORKERS})"
            ));
        }
        let worker = DeviceQueue::spawn(
            key.to_owned(),
            Arc::clone(&self.inner.stats),
            self.inner.durable.clone(),
        )?;
        workers.insert(key.to_owned(), Arc::clone(&worker));
        Ok(worker)
    }

    pub fn reconfigure(&self, config: &Value) {
        let mut retained = HashSet::new();
        if let Some(entries) = config.as_object() {
            // Any parseable device role keeps its worker; the role catalog is
            // owned by the config, not by this list.
            for value in entries.values() {
                if let Ok(device) = PrinterDeviceConfig::from_value(value.clone()) {
                    retained.insert(device.physical_key());
                }
            }
        }
        let removed = match self.inner.workers.lock() {
            Ok(mut workers) => {
                let keys: Vec<String> = workers
                    .keys()
                    .filter(|key| !retained.contains(*key))
                    .cloned()
                    .collect();
                keys.into_iter()
                    .filter_map(|key| workers.remove(&key))
                    .collect::<Vec<_>>()
            }
            Err(_) => Vec::new(),
        };
        for worker in removed {
            worker.stop();
        }
    }

    pub fn disconnect_all(&self) {
        let removed = match self.inner.workers.lock() {
            Ok(mut workers) => workers
                .drain()
                .map(|(_, worker)| worker)
                .collect::<Vec<_>>(),
            Err(_) => Vec::new(),
        };
        for worker in removed {
            worker.stop();
        }
    }

    pub fn durable_jobs(
        &self,
        state: Option<&str>,
        limit: Option<usize>,
    ) -> Result<Vec<DurablePrintJobRecord>, String> {
        self.inner.durable.list(state, limit)
    }

    pub fn durable_summary(&self) -> Result<DurableQueueSummary, String> {
        self.inner.durable.summary()
    }

    /// Queries printer status. When an active print worker holds the device
    /// (persistent serial ports), the handshake is executed on that worker's
    /// connection instead of opening a second one, which Windows would refuse.
    pub fn query_printer_status_with_sink(
        &self,
        app: RuntimeEventSink,
        config: &PrinterDeviceConfig,
    ) -> Result<PrinterStatusReport, String> {
        let physical_key = config.physical_key();
        let worker_holds_serial = config.connection == "serial"
            && self
                .inner
                .workers
                .lock()
                .map(|workers| workers.contains_key(&physical_key))
                .unwrap_or(false);
        if !worker_holds_serial {
            return status::query(config);
        }
        let queue = self.queue_for(&physical_key)?;
        let (completion, result) = mpsc::sync_channel(1);
        let job = PrintJob {
            app,
            config: config.clone(),
            action: JobAction::Status,
            durable_job_id: None,
            submitted_at: Instant::now(),
            completion,
        };
        queue.depth.fetch_add(1, Ordering::AcqRel);
        self.inner.stats.queued_now.fetch_add(1, Ordering::AcqRel);
        if let Err(error) = queue.sender.try_send(job) {
            queue.depth.fetch_sub(1, Ordering::AcqRel);
            self.inner.stats.queued_now.fetch_sub(1, Ordering::AcqRel);
            return Err(match error {
                TrySendError::Full(_) => {
                    format!("printer queue is full (capacity {PRINTER_QUEUE_CAPACITY})")
                }
                TrySendError::Disconnected(_) => "printer worker is disconnected".to_owned(),
            });
        }
        let outcome = result
            .recv_timeout(COMPLETION_TIMEOUT)
            .map_err(|_| "printer job completion timed out".to_owned())??;
        outcome
            .status_report
            .map(|report| *report)
            .ok_or_else(|| "printer status report missing from transport response".to_owned())
    }

    #[cfg(feature = "desktop")]
    pub fn cancel_durable(
        &self,
        app: &AppHandle,
        job_id: &str,
    ) -> Result<DurablePrintJobRecord, String> {
        self.cancel_durable_with_sink(RuntimeEventSink::tauri(app.clone()), job_id)
    }

    pub(crate) fn cancel_durable_with_sink(
        &self,
        app: RuntimeEventSink,
        job_id: &str,
    ) -> Result<DurablePrintJobRecord, String> {
        let record = self.inner.durable.cancel(job_id)?;
        emit_durable_status(
            &app,
            Some(job_id),
            "cancelled",
            record.last_error.as_deref(),
        );
        Ok(record)
    }

    #[cfg(feature = "desktop")]
    pub fn retry_durable(&self, app: AppHandle, job_id: &str) -> Result<PrintReceipt, String> {
        self.retry_durable_with_sink(RuntimeEventSink::tauri(app), job_id)
    }

    pub(crate) fn retry_durable_with_sink(
        &self,
        app: RuntimeEventSink,
        job_id: &str,
    ) -> Result<PrintReceipt, String> {
        let job = self.inner.durable.prepare_retry(job_id)?;
        emit_durable_status(&app, Some(&job.job_id), "queued", None);
        self.submit_stored(app, job)
    }

    #[cfg(feature = "desktop")]
    pub fn recover_pending(&self, app: AppHandle) -> Result<usize, String> {
        self.recover_pending_with_sink(RuntimeEventSink::tauri(app))
    }

    pub(crate) fn recover_pending_with_sink(&self, app: RuntimeEventSink) -> Result<usize, String> {
        let jobs = self.inner.durable.queued_jobs()?;
        let count = jobs.len();
        if jobs.is_empty() {
            return Ok(0);
        }
        let state = self.clone();
        thread::Builder::new()
            .name("labelpilot-durable-recovery".to_owned())
            .spawn(move || {
                for job in jobs {
                    let job_id = job.job_id.clone();
                    emit_durable_status(&app, Some(&job_id), "queued", None);
                    if let Err(error) = state.submit_stored(app.clone(), job) {
                        log_printer(
                            &app,
                            "WARN",
                            &format!("durable print recovery failed: job={job_id} error={error}"),
                        );
                    }
                }
            })
            .map_err(|error| format!("failed to start durable print recovery: {error}"))?;
        Ok(count)
    }

    fn submit_stored(
        &self,
        app: RuntimeEventSink,
        job: durable::StoredPrintJob,
    ) -> Result<PrintReceipt, String> {
        let physical_key = job.config.physical_key();
        self.submit_once(app, job.config, job.action, &physical_key, Some(job.job_id))
    }
    pub fn summary(&self) -> PrinterTransportSummary {
        let worker_count = self
            .inner
            .workers
            .lock()
            .map(|workers| workers.len())
            .unwrap_or(0);
        let stats = &self.inner.stats;
        PrinterTransportSummary {
            worker_count,
            queued_now: stats.queued_now.load(Ordering::Acquire),
            active_now: stats.active_now.load(Ordering::Acquire),
            submitted_jobs: stats.submitted_jobs.load(Ordering::Acquire),
            completed_jobs: stats.completed_jobs.load(Ordering::Acquire),
            failed_jobs: stats.failed_jobs.load(Ordering::Acquire),
            rejected_jobs: stats.rejected_jobs.load(Ordering::Acquire),
            bytes_sent: stats.bytes_sent.load(Ordering::Acquire),
            reconnects: stats.reconnects.load(Ordering::Acquire),
            queue_capacity_per_printer: PRINTER_QUEUE_CAPACITY,
            max_workers: MAX_PRINTER_WORKERS,
            max_job_bytes: MAX_RAW_JOB_BYTES,
            connect_timeout_ms: CONNECT_TIMEOUT.as_millis() as u64,
            write_timeout_ms: WRITE_TIMEOUT.as_millis() as u64,
            idle_close_ms: IDLE_CLOSE.as_millis() as u64,
            breaker_ms: BREAKER_DURATION.as_millis() as u64,
            tcp_jobs: stats.tcp_jobs.load(Ordering::Acquire),
            serial_jobs: stats.serial_jobs.load(Ordering::Acquire),
            spooler_jobs: stats.spooler_jobs.load(Ordering::Acquire),
            driver_bitmap_jobs: stats.driver_bitmap_jobs.load(Ordering::Acquire),
            driver_page_jobs: stats.driver_page_jobs.load(Ordering::Acquire),
            deduplicated_jobs: stats.deduplicated_jobs.load(Ordering::Acquire),
            idempotency_conflicts: stats.idempotency_conflicts.load(Ordering::Acquire),
            uncertain_jobs: stats.uncertain_jobs.load(Ordering::Acquire),
            idempotency_ttl_ms: IDEMPOTENCY_TTL.as_millis() as u64,
            max_idempotency_entries: MAX_IDEMPOTENCY_ENTRIES,
            supported_connections: ["tcp", "serial", "windows_driver"],
            supported_print_targets: backend::SUPPORTED_PRINT_TARGETS,
            available_backends: backend::AVAILABLE_BACKENDS,
        }
    }
}

impl Default for PrinterTransportState {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for PrinterTransportState {
    fn drop(&mut self) {
        if Arc::strong_count(&self.inner) == 1 {
            self.disconnect_all();
        }
    }
}

#[derive(Debug)]
enum JobAction {
    Print(Vec<u8>),
    DriverBitmap {
        width: u32,
        height: u32,
        mono: Vec<u8>,
    },
    DriverPage {
        width: u32,
        height: u32,
        mono: Vec<u8>,
        page: DriverPageSpec,
    },
    Probe,
    Status,
}

fn fingerprint_bytes(mut hash: u64, bytes: &[u8]) -> u64 {
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(1_099_511_628_211);
    }
    hash
}

fn action_fingerprint(action: &JobAction) -> u64 {
    let mut hash = 14_695_981_039_346_656_037_u64;
    match action {
        JobAction::Print(data) => {
            hash = fingerprint_bytes(hash, b"raw");
            fingerprint_bytes(hash, data)
        }
        JobAction::DriverBitmap {
            width,
            height,
            mono,
        } => {
            hash = fingerprint_bytes(hash, b"driver-bitmap");
            hash = fingerprint_bytes(hash, &width.to_le_bytes());
            hash = fingerprint_bytes(hash, &height.to_le_bytes());
            fingerprint_bytes(hash, mono)
        }
        JobAction::DriverPage {
            width,
            height,
            mono,
            page,
        } => {
            hash = fingerprint_bytes(hash, b"driver-page");
            hash = fingerprint_bytes(hash, &width.to_le_bytes());
            hash = fingerprint_bytes(hash, &height.to_le_bytes());
            hash = fingerprint_bytes(hash, &page.page_width_mm.to_bits().to_le_bytes());
            hash = fingerprint_bytes(hash, &page.page_height_mm.to_bits().to_le_bytes());
            for margin in [
                page.margins_mm.top,
                page.margins_mm.right,
                page.margins_mm.bottom,
                page.margins_mm.left,
            ] {
                hash = fingerprint_bytes(hash, &margin.to_bits().to_le_bytes());
            }
            hash = fingerprint_bytes(hash, page.fit_mode.as_bytes());
            hash = fingerprint_bytes(hash, page.document_name.as_bytes());
            fingerprint_bytes(hash, mono)
        }
        JobAction::Probe => fingerprint_bytes(hash, b"probe"),
        JobAction::Status => fingerprint_bytes(hash, b"status"),
    }
}

struct PrintJob {
    app: RuntimeEventSink,
    config: PrinterDeviceConfig,
    action: JobAction,
    durable_job_id: Option<String>,
    submitted_at: Instant,
    completion: SyncSender<Result<PrintReceipt, String>>,
}

struct DeviceQueue {
    sender: SyncSender<PrintJob>,
    stop_flag: Arc<AtomicBool>,
    depth: Arc<AtomicUsize>,
    handle: Mutex<Option<JoinHandle<()>>>,
}

impl DeviceQueue {
    fn spawn(
        key: String,
        stats: Arc<PrinterStats>,
        durable: durable::DurablePrintStore,
    ) -> Result<Arc<Self>, String> {
        let (sender, receiver) = mpsc::sync_channel(PRINTER_QUEUE_CAPACITY);
        let stop_flag = Arc::new(AtomicBool::new(false));
        let depth = Arc::new(AtomicUsize::new(0));
        let worker_stop = Arc::clone(&stop_flag);
        let worker_depth = Arc::clone(&depth);
        let thread_name = format!("labelpilot-printer-{:08x}", stable_key_hash(&key));
        let handle = thread::Builder::new()
            .name(thread_name)
            .spawn(move || {
                run_device_worker(key, receiver, worker_stop, worker_depth, stats, durable)
            })
            .map_err(|error| format!("failed to start printer worker: {error}"))?;
        Ok(Arc::new(Self {
            sender,
            stop_flag,
            depth,
            handle: Mutex::new(Some(handle)),
        }))
    }

    fn stop(&self) {
        self.stop_flag.store(true, Ordering::Release);
        if let Ok(mut handle) = self.handle.lock() {
            if let Some(handle) = handle.take() {
                let _ = handle.join();
            }
        }
    }
}

impl Drop for DeviceQueue {
    fn drop(&mut self) {
        self.stop();
    }
}

fn stable_key_hash(value: &str) -> u32 {
    value.bytes().fold(2_166_136_261_u32, |hash, byte| {
        (hash ^ byte as u32).wrapping_mul(16_777_619)
    })
}

fn run_device_worker(
    key: String,
    receiver: Receiver<PrintJob>,
    stop: Arc<AtomicBool>,
    depth: Arc<AtomicUsize>,
    stats: Arc<PrinterStats>,
    durable: durable::DurablePrintStore,
) {
    let mut connection = DeviceConnection::default();
    let mut breaker_until: Option<Instant> = None;
    while !stop.load(Ordering::Acquire) {
        match receiver.recv_timeout(WORKER_POLL) {
            Ok(job) => {
                depth.fetch_sub(1, Ordering::AcqRel);
                stats.queued_now.fetch_sub(1, Ordering::AcqRel);
                stats.active_now.fetch_add(1, Ordering::AcqRel);

                let started = match job.durable_job_id.as_deref() {
                    Some(job_id) => match durable.mark_sending(job_id) {
                        Ok(true) => {
                            emit_durable_status(&job.app, Some(job_id), "sending", None);
                            Ok(true)
                        }
                        Ok(false) => {
                            Err("durable print job was cancelled before sending".to_owned())
                        }
                        Err(error) => Err(error),
                    },
                    None => Ok(true),
                };
                let transport_started = matches!(started, Ok(true));
                let mut result = match started {
                    Ok(true) => {
                        process_job(&key, &job, &mut connection, &mut breaker_until, &stats)
                    }
                    Ok(false) => unreachable!(),
                    Err(error) => Err(error),
                };

                if let (Some(job_id), Ok(receipt)) =
                    (job.durable_job_id.as_deref(), result.as_mut())
                {
                    receipt.durable_job_id = Some(job_id.to_owned());
                    receipt.durable_state = Some("accepted".to_owned());
                    if let Err(error) = durable.mark_accepted(job_id, receipt) {
                        result = Err(format!(
                            "DURABLE_RECEIPT_PERSISTENCE_UNCERTAIN: transport accepted but receipt update failed: {error}"
                        ));
                    } else {
                        emit_durable_status(&job.app, Some(job_id), "accepted", None);
                    }
                }
                if let (Some(job_id), Err(error)) = (job.durable_job_id.as_deref(), result.as_ref())
                {
                    if transport_started {
                        let _ = durable.mark_uncertain(job_id, error);
                        emit_durable_status(&job.app, Some(job_id), "uncertain", Some(error));
                    } else {
                        emit_durable_status(&job.app, Some(job_id), "cancelled", Some(error));
                    }
                }

                stats.active_now.fetch_sub(1, Ordering::AcqRel);
                // Status probes are transport diagnostics, not print jobs.
                if !matches!(job.action, JobAction::Status) {
                    match &result {
                        Ok(receipt) => {
                            stats.completed_jobs.fetch_add(1, Ordering::AcqRel);
                            stats
                                .bytes_sent
                                .fetch_add(receipt.bytes as u64, Ordering::AcqRel);
                            match job.config.connection.as_str() {
                                "tcp" => {
                                    stats.tcp_jobs.fetch_add(1, Ordering::AcqRel);
                                }
                                "serial" => {
                                    stats.serial_jobs.fetch_add(1, Ordering::AcqRel);
                                }
                                "windows_driver" => {
                                    stats.spooler_jobs.fetch_add(1, Ordering::AcqRel);
                                }
                                _ => {}
                            }
                            if matches!(&job.action, JobAction::DriverBitmap { .. }) {
                                stats.driver_bitmap_jobs.fetch_add(1, Ordering::AcqRel);
                            }
                            if matches!(&job.action, JobAction::DriverPage { .. }) {
                                stats.driver_page_jobs.fetch_add(1, Ordering::AcqRel);
                            }
                        }
                        Err(_) => {
                            stats.failed_jobs.fetch_add(1, Ordering::AcqRel);
                        }
                    }
                }
                let _ = job.completion.send(result);
            }
            Err(mpsc::RecvTimeoutError::Timeout) => connection.close_if_idle(),
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    connection.close();
    while let Ok(job) = receiver.try_recv() {
        depth.fetch_sub(1, Ordering::AcqRel);
        stats.queued_now.fetch_sub(1, Ordering::AcqRel);
        stats.failed_jobs.fetch_add(1, Ordering::AcqRel);
        let error = "printer worker stopped during reconfiguration".to_owned();
        if let Some(job_id) = job.durable_job_id.as_deref() {
            let _ = durable.mark_failed(job_id, &error);
            emit_durable_status(&job.app, Some(job_id), "failed", Some(&error));
        }
        let _ = job.completion.send(Err(error));
    }
}
fn process_job(
    key: &str,
    job: &PrintJob,
    connection: &mut DeviceConnection,
    breaker_until: &mut Option<Instant>,
    stats: &PrinterStats,
) -> Result<PrintReceipt, String> {
    if matches!(job.action, JobAction::Status) {
        let send_started = Instant::now();
        // Status probes bypass the circuit breaker: a printer that ignores a
        // status command must not fail-fast the label queue behind it.
        return match connection.query_status(&job.config) {
            Ok(report) => Ok(PrintReceipt {
                printer_id: job.config.id.clone(),
                physical_key: key.to_owned(),
                bytes: 0,
                queue_ms: elapsed_ms(job.submitted_at),
                send_ms: elapsed_ms(send_started),
                attempts: 1,
                reused_connection: true,
                delivery_state: "status-queried".to_owned(),
                confirmation_mode: "protocol-status".to_owned(),
                idempotency_key: job.config.job_idempotency_key.clone(),
                deduplicated: false,
                durable_job_id: None,
                durable_state: None,
                status_report: Some(Box::new(report)),
            }),
            Err(error) => Err(error.message),
        };
    }
    if breaker_until.is_some_and(|until| Instant::now() < until) {
        let remaining = breaker_until
            .map(|until| until.saturating_duration_since(Instant::now()).as_millis())
            .unwrap_or_default();
        return Err(format!(
            "printer \"{}\" unreachable (failing fast for {remaining}ms)",
            job.config.display_name()
        ));
    }
    *breaker_until = None;
    let queue_ms = elapsed_ms(job.submitted_at);
    let send_started = Instant::now();
    let send_result = match &job.action {
        JobAction::Print(data) => connection.send(&job.config, data, stats),
        JobAction::DriverBitmap {
            width,
            height,
            mono,
        } => connection.send_driver_bitmap(&job.config, *width, *height, mono),
        JobAction::DriverPage {
            width,
            height,
            mono,
            page,
        } => connection.send_driver_page(&job.config, *width, *height, mono, page),
        JobAction::Probe => connection.probe(&job.config),
        JobAction::Status => unreachable!("status jobs are handled before transport dispatch"),
    };
    let (delivery_state, confirmation_mode) = match &job.action {
        JobAction::Probe => ("reachable", "connect-probe"),
        _ if job.config.connection == "windows_driver" => ("spooler-accepted", "windows-spooler"),
        _ => ("transport-accepted", "transport-write"),
    };
    match send_result {
        Ok(outcome) => Ok(PrintReceipt {
            printer_id: job.config.id.clone(),
            physical_key: key.to_owned(),
            bytes: outcome.bytes,
            queue_ms,
            send_ms: elapsed_ms(send_started),
            attempts: outcome.attempts,
            reused_connection: outcome.reused_connection,
            delivery_state: delivery_state.to_owned(),
            confirmation_mode: confirmation_mode.to_owned(),
            idempotency_key: job.config.job_idempotency_key.clone(),
            deduplicated: false,
            durable_job_id: None,
            durable_state: None,
            status_report: None,
        }),
        Err(error) => {
            *breaker_until = Some(Instant::now() + BREAKER_DURATION);
            Err(error.message)
        }
    }
}
fn elapsed_ms(start: Instant) -> u64 {
    start.elapsed().as_millis().min(u64::MAX as u128) as u64
}

#[derive(Default)]
struct DeviceConnection {
    tcp: TcpConnection,
    serial: SerialConnection,
}

impl DeviceConnection {
    fn probe(&mut self, config: &PrinterDeviceConfig) -> Result<SendOutcome, TransportFailure> {
        match config.connection.as_str() {
            "tcp" => self.tcp.probe(config),
            "serial" => self.serial.probe(config),
            "windows_driver" => spooler::probe(config),
            other => Err(TransportFailure {
                message: format!("unsupported printer connection: {other}"),
                timed_out: false,
            }),
        }
    }

    fn query_status(
        &mut self,
        config: &PrinterDeviceConfig,
    ) -> Result<status::PrinterStatusReport, TransportFailure> {
        match config.connection.as_str() {
            // Serial is probed on the worker's held port; other connections
            // open their own short-lived status connection.
            "serial" => self.serial.query_status(config),
            _ => status::query(config).map_err(|message| TransportFailure {
                message,
                timed_out: false,
            }),
        }
    }

    fn send(
        &mut self,
        config: &PrinterDeviceConfig,
        data: &[u8],
        stats: &PrinterStats,
    ) -> Result<SendOutcome, TransportFailure> {
        match config.connection.as_str() {
            "tcp" => self.tcp.send(config, data, stats),
            "serial" => self.serial.send(config, data, stats),
            "windows_driver" => spooler::send_raw(config, data),
            other => Err(TransportFailure {
                message: format!("unsupported printer connection: {other}"),
                timed_out: false,
            }),
        }
    }

    fn send_driver_bitmap(
        &mut self,
        config: &PrinterDeviceConfig,
        width: u32,
        height: u32,
        mono: &[u8],
    ) -> Result<SendOutcome, TransportFailure> {
        spooler::send_bitmap(config, width, height, mono)
    }

    fn send_driver_page(
        &mut self,
        config: &PrinterDeviceConfig,
        width: u32,
        height: u32,
        mono: &[u8],
        page: &DriverPageSpec,
    ) -> Result<SendOutcome, TransportFailure> {
        spooler::send_page_bitmap(config, width, height, mono, page)
    }

    fn close_if_idle(&mut self) {
        self.tcp.close_if_idle();
        self.serial.close_if_idle();
    }

    fn close(&mut self) {
        self.tcp.close();
        self.serial.close();
    }
}

#[derive(Default)]
struct TcpConnection {
    stream: Option<TcpStream>,
    endpoint: Option<String>,
    keep_open: bool,
    last_write: Option<Instant>,
}

#[derive(Debug)]
struct SendOutcome {
    bytes: usize,
    attempts: u8,
    reused_connection: bool,
}

#[derive(Debug)]
struct TransportFailure {
    message: String,
    timed_out: bool,
}

impl TcpConnection {
    fn probe(&mut self, config: &PrinterDeviceConfig) -> Result<SendOutcome, TransportFailure> {
        let endpoint = config.physical_key();
        let reused = self.stream.is_some() && self.endpoint.as_deref() == Some(&endpoint);
        self.ensure_connected(config)?;
        let keep_open = config.keep_tcp_connection_open();
        self.keep_open = keep_open;
        self.last_write = Some(Instant::now());
        let outcome = SendOutcome {
            bytes: 0,
            attempts: 1,
            reused_connection: reused,
        };
        if !keep_open {
            self.close();
        }
        Ok(outcome)
    }

    fn send(
        &mut self,
        config: &PrinterDeviceConfig,
        data: &[u8],
        stats: &PrinterStats,
    ) -> Result<SendOutcome, TransportFailure> {
        let endpoint = config.physical_key();
        let reused = self.stream.is_some() && self.endpoint.as_deref() == Some(&endpoint);
        let mut attempts = 0_u8;
        loop {
            attempts += 1;
            if let Err(error) = self.ensure_connected(config) {
                if error.timed_out || attempts >= 2 {
                    return Err(error);
                }
                stats.reconnects.fetch_add(1, Ordering::AcqRel);
                self.close();
                continue;
            }
            let write_result =
                write_job_once(self.stream.as_mut().expect("connected stream"), data);
            match write_result {
                Ok(()) => {
                    let keep_open = config.keep_tcp_connection_open();
                    self.keep_open = keep_open;
                    self.last_write = Some(Instant::now());
                    let outcome = SendOutcome {
                        bytes: data.len(),
                        attempts,
                        reused_connection: reused && attempts == 1,
                    };
                    if !keep_open {
                        // EOF is the automatically selected boundary for virtual bridges.
                        self.close();
                    }
                    return Ok(outcome);
                }
                Err(error) => {
                    let retryable = error.can_retry(attempts);
                    let failure = error.into_transport_failure("TCP printer write");
                    self.close();
                    if !retryable {
                        return Err(failure);
                    }
                    stats.reconnects.fetch_add(1, Ordering::AcqRel);
                }
            }
        }
    }

    fn ensure_connected(&mut self, config: &PrinterDeviceConfig) -> Result<(), TransportFailure> {
        let endpoint = config.physical_key();
        if self.endpoint.as_deref() != Some(&endpoint) {
            self.close();
        }
        if self.stream.is_some() {
            return Ok(());
        }
        let address = resolve_address(config)?;
        let stream = TcpStream::connect_timeout(&address, CONNECT_TIMEOUT)
            .map_err(|error| io_failure(&format!("TCP printer connect {address}"), error))?;
        stream
            .set_write_timeout(Some(WRITE_TIMEOUT))
            .map_err(|error| io_failure("TCP printer write timeout", error))?;
        stream
            .set_nodelay(true)
            .map_err(|error| io_failure("TCP printer TCP_NODELAY", error))?;
        self.stream = Some(stream);
        self.endpoint = Some(endpoint);
        Ok(())
    }

    fn close_if_idle(&mut self) {
        if self.keep_open {
            return;
        }
        if self
            .last_write
            .is_some_and(|last_write| last_write.elapsed() >= IDLE_CLOSE)
        {
            self.close();
        }
    }

    fn close(&mut self) {
        if let Some(stream) = self.stream.take() {
            let _ = stream.shutdown(Shutdown::Both);
        }
        self.endpoint = None;
        self.last_write = None;
        self.keep_open = false;
    }
}

fn resolve_address(config: &PrinterDeviceConfig) -> Result<SocketAddr, TransportFailure> {
    let host = config.ip.as_deref().unwrap_or_default();
    (host, config.port())
        .to_socket_addrs()
        .map_err(|error| io_failure("TCP printer resolve", error))?
        .next()
        .ok_or_else(|| TransportFailure {
            message: format!(
                "TCP printer address did not resolve: {host}:{}",
                config.port()
            ),
            timed_out: false,
        })
}

fn io_failure(context: &str, error: io::Error) -> TransportFailure {
    TransportFailure {
        message: format!("{context}: {error}"),
        timed_out: matches!(
            error.kind(),
            io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock
        ),
    }
}

fn log_duplicate(
    app: &RuntimeEventSink,
    config: &PrinterDeviceConfig,
    physical_key: &str,
    receipt: &PrintReceipt,
) {
    log_printer(
        app,
        "INFO",
        &format!(
            "Rust printer duplicate suppressed: id={} key={} idempotency={} durable={}",
            config.id,
            physical_key,
            receipt.idempotency_key.as_deref().unwrap_or(""),
            receipt.durable_job_id.as_deref().unwrap_or("")
        ),
    );
}
fn emit_durable_status(
    app: &RuntimeEventSink,
    job_id: Option<&str>,
    state: &str,
    error: Option<&str>,
) {
    let Some(job_id) = job_id else {
        return;
    };
    let updated_at_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64;
    app.emit(
        "printer-durable-job-update",
        serde_json::json!({
            "jobId": job_id,
            "state": state,
            "error": error,
            "updatedAtMs": updated_at_ms,
        }),
    );
}

fn emit_delivery_status(
    app: &RuntimeEventSink,
    id: &str,
    status: &str,
    receipt: Option<&PrintReceipt>,
) {
    let payload = match receipt {
        Some(receipt) => serde_json::json!({
            "id": id,
            "status": status,
            "deliveryState": receipt.delivery_state,
            "confirmationMode": receipt.confirmation_mode,
            "idempotencyKey": receipt.idempotency_key,
            "deduplicated": receipt.deduplicated,
        }),
        None => serde_json::json!({ "id": id, "status": status }),
    };
    app.emit("printer-status-update", payload);
}

fn log_printer(app: &RuntimeEventSink, level: &str, message: &str) {
    app.log("printer", level, message);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use std::net::TcpListener;

    fn config(port: u16, id: &str, boundary: Option<&str>) -> PrinterDeviceConfig {
        let mut value = serde_json::json!({
            "id": id,
            "active": true,
            "name": "Loopback printer",
            "connection": "tcp",
            "protocol": "zpl",
            "ip": "127.0.0.1",
            "port": port
        });
        if let Some(boundary) = boundary {
            value["tcpJobBoundary"] = serde_json::json!(boundary);
        }
        PrinterDeviceConfig::from_value(value).unwrap()
    }

    #[test]
    fn validates_all_transport_configs_and_physical_queue_keys() {
        let a = config(9100, "pack", None);
        let b = config(9100, "box", None);
        let pallet = config(9100, "pallet", None);
        assert_eq!(a.physical_key(), "tcp:127.0.0.1:9100");
        assert_eq!(a.physical_key(), b.physical_key());
        assert_eq!(a.physical_key(), pallet.physical_key());

        let other = PrinterDeviceConfig::from_value(serde_json::json!({
            "id": "other", "connection": "tcp", "protocol": "zpl",
            "ip": "192.0.2.20", "port": 9100
        }))
        .unwrap();
        assert_ne!(a.physical_key(), other.physical_key());
        let state = PrinterTransportState::new();
        let pack_queue = state.queue_for(&a.physical_key()).unwrap();
        let box_queue = state.queue_for(&b.physical_key()).unwrap();
        let other_queue = state.queue_for(&other.physical_key()).unwrap();
        assert!(Arc::ptr_eq(&pack_queue, &box_queue));
        assert!(!Arc::ptr_eq(&pack_queue, &other_queue));
        assert_eq!(state.summary().worker_count, 2);

        let serial = PrinterDeviceConfig::from_value(serde_json::json!({
            "id": "serial", "connection": "serial", "serialPort": "COM1", "baudRate": 9600
        }))
        .unwrap();
        assert_eq!(serial.physical_key(), "serial:COM1:9600");

        let spooler = PrinterDeviceConfig::from_value(serde_json::json!({
            "id": "driver", "connection": "windows_driver", "driverName": "Zebra Queue"
        }))
        .unwrap();
        assert_eq!(spooler.physical_key(), "spooler:zebra queue");
        let default_spooler = PrinterDeviceConfig::from_value(serde_json::json!({
            "id": "default-driver", "connection": "windows_driver"
        }))
        .unwrap();
        assert_eq!(default_spooler.physical_key(), "spooler:<default>");

        for invalid in [
            serde_json::json!({"id":"bad", "connection":"serial", "serialPort":""}),
            serde_json::json!({"id":"bad", "connection":"serial", "serialPort":"COM1", "baudRate":42}),
            serde_json::json!({"id":"bad", "connection":"tcp", "ip":"", "port":70000}),
        ] {
            assert!(PrinterDeviceConfig::from_value(invalid).is_err());
        }
    }

    #[test]
    fn automatic_tcp_job_boundaries_ignore_the_legacy_operator_switch() {
        let legacy_on = PrinterDeviceConfig::from_value(serde_json::json!({
            "id": "legacy-on", "connection": "tcp", "protocol": "zpl",
            "ip": "127.0.0.1", "port": 9100, "persistentConnection": true
        }))
        .unwrap();
        let legacy_off = PrinterDeviceConfig::from_value(serde_json::json!({
            "id": "legacy-off", "connection": "tcp", "protocol": "zpl",
            "ip": "127.0.0.1", "port": 9100, "persistentConnection": false
        }))
        .unwrap();
        assert_eq!(legacy_on.tcp_job_boundary(), TcpJobBoundary::Eof);
        assert_eq!(legacy_off.tcp_job_boundary(), TcpJobBoundary::Eof);

        let network = PrinterDeviceConfig::from_value(serde_json::json!({
            "id": "network", "connection": "tcp", "protocol": "image",
            "ip": "192.0.2.21", "port": 9100
        }))
        .unwrap();
        assert_eq!(network.tcp_job_boundary(), TcpJobBoundary::Protocol);

        let detected_bridge = PrinterDeviceConfig::from_value(serde_json::json!({
            "id": "bridge", "connection": "tcp", "protocol": "image",
            "ip": "192.0.2.22", "port": 9100, "tcpJobBoundary": "eof"
        }))
        .unwrap();
        assert_eq!(detected_bridge.tcp_job_boundary(), TcpJobBoundary::Eof);
    }

    #[cfg(windows)]
    #[test]
    fn missing_windows_spooler_queue_fails_during_probe_without_printing() {
        let config = PrinterDeviceConfig::from_value(serde_json::json!({
            "id": "missing-driver",
            "connection": "windows_driver",
            "protocol": "browser",
            "driverName": "LabelPilot Phase 5.3 Deliberately Missing Queue"
        }))
        .unwrap();
        let error = spooler::probe(&config).unwrap_err();
        assert!(error.message.contains("OpenPrinterW"));
        assert!(!error.timed_out);
    }

    #[test]
    fn protocol_boundary_preserves_order_and_reuses_the_connection() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut bytes = [0_u8; 6];
            socket.read_exact(&mut bytes).unwrap();
            bytes
        });
        let stats = PrinterStats::default();
        let mut connection = DeviceConnection::default();
        let config = config(port, "pack", Some("stream"));
        let first = connection.send(&config, b"AAA", &stats).unwrap();
        let second = connection.send(&config, b"BBB", &stats).unwrap();
        assert!(!first.reused_connection);
        assert!(second.reused_connection);
        assert_eq!(first.attempts, 1);
        assert_eq!(second.attempts, 1);
        assert_eq!(server.join().unwrap(), *b"AAABBB");
    }

    #[test]
    fn eof_boundary_closes_immediately_after_each_job() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut byte = [0_u8; 1];
            socket.read_exact(&mut byte).unwrap();
            let mut eof = [0_u8; 1];
            assert_eq!(socket.read(&mut eof).unwrap(), 0);
            byte[0]
        });
        let stats = PrinterStats::default();
        let mut connection = DeviceConnection::default();
        let config = config(port, "pack", None);
        let receipt = connection.send(&config, b"Z", &stats).unwrap();
        assert!(!receipt.reused_connection);
        assert!(connection.tcp.stream.is_none());
        assert_eq!(server.join().unwrap(), b'Z');
    }

    #[test]
    fn pack_box_and_pallet_roles_share_one_ordered_physical_queue() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = thread::spawn(move || {
            let mut jobs = Vec::new();
            for _ in 0..3 {
                let (mut socket, _) = listener.accept().unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut bytes = Vec::new();
                socket.read_to_end(&mut bytes).unwrap();
                jobs.push(bytes);
            }
            jobs
        });
        let state = PrinterTransportState::new();
        let sink = RuntimeEventSink::detached();
        let payloads = [
            ("pack", "image", b"^XA^FDpack^FS^XZ".as_slice()),
            ("box", "zpl", b"^XA^FDbox^FS^XZ".as_slice()),
            ("pallet", "zpl", b"^XA^FDpallet^FS^XZ".as_slice()),
        ];
        for (role, protocol, payload) in payloads {
            let config = serde_json::json!({
                "id": role,
                "active": true,
                "name": role,
                "connection": "tcp",
                "protocol": protocol,
                "ip": "127.0.0.1",
                "port": port
            });
            state
                .submit_generated_with_sink(sink.clone(), config, payload.to_vec())
                .unwrap();
        }
        assert_eq!(
            server.join().unwrap(),
            vec![
                b"^XA^FDpack^FS^XZ".to_vec(),
                b"^XA^FDbox^FS^XZ".to_vec(),
                b"^XA^FDpallet^FS^XZ".to_vec(),
            ]
        );
        let summary = state.summary();
        assert_eq!(summary.worker_count, 1);
        assert_eq!(summary.completed_jobs, 3);
        assert_eq!(summary.tcp_jobs, 3);
    }

    #[test]
    fn refused_endpoint_trips_bounded_failure_without_payload_loss() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let stats = PrinterStats::default();
        let mut connection = DeviceConnection::default();
        let error = connection
            .send(&config(port, "pack", None), b"^XA^XZ", &stats)
            .unwrap_err();
        assert!(error.message.contains("connect"));
        assert!(!error.timed_out);
        assert_eq!(stats.reconnects.load(Ordering::Acquire), 1);
    }

    #[test]
    fn queue_and_payload_limits_are_explicit() {
        assert_eq!(PRINTER_QUEUE_CAPACITY, 16);
        assert_eq!(MAX_PRINTER_WORKERS, 12);
        assert_eq!(MAX_RAW_JOB_BYTES, 16 * 1024 * 1024);
        let (sender, _receiver) = mpsc::sync_channel(1);
        sender.try_send(1_u8).unwrap();
        assert!(matches!(sender.try_send(2_u8), Err(TrySendError::Full(2))));
    }

    fn serial_device(port_name: &str) -> PrinterDeviceConfig {
        serde_json::from_value(serde_json::json!({
            "id": "pack",
            "connection": "serial",
            "protocol": "zpl",
            "serialPort": port_name,
            "baudRate": 9600
        }))
        .unwrap()
    }

    #[test]
    fn serial_status_routes_through_the_holding_worker() {
        let state = PrinterTransportState::new();
        let device = serial_device("LABELPILOT-NONE-1");
        let key = device.physical_key();
        // A printer that already printed has a live worker holding the port.
        let _queue = state.queue_for(&key).unwrap();
        let error = state
            .query_printer_status_with_sink(RuntimeEventSink::detached(), &device)
            .unwrap_err();
        // The handshake failed inside the worker's held-port connection.
        assert!(error.contains("serial printer open"), "{error}");
    }

    #[test]
    fn serial_status_falls_back_to_direct_probe_without_worker() {
        let state = PrinterTransportState::new();
        let device = serial_device("LABELPILOT-NONE-2");
        let error = state
            .query_printer_status_with_sink(RuntimeEventSink::detached(), &device)
            .unwrap_err();
        // No worker for this key: the status path opened its own port.
        assert!(error.contains("serial printer status open"), "{error}");
    }

    #[test]
    fn summary_reports_weak_device_bounds() {
        let state = PrinterTransportState::new();
        let summary = state.summary();
        assert_eq!(summary.worker_count, 0);
        assert_eq!(summary.queue_capacity_per_printer, 16);
        assert_eq!(summary.max_workers, 12);
        assert_eq!(summary.connect_timeout_ms, 3000);
        assert_eq!(summary.write_timeout_ms, 3000);
        assert_eq!(summary.idle_close_ms, 400);
        assert_eq!(summary.breaker_ms, 5000);
        assert_eq!(summary.tcp_jobs, 0);
        assert_eq!(summary.serial_jobs, 0);
        assert_eq!(summary.spooler_jobs, 0);
        assert_eq!(summary.driver_bitmap_jobs, 0);
        assert_eq!(
            summary.supported_connections,
            ["tcp", "serial", "windows_driver"]
        );
    }
    #[test]
    fn idempotency_cache_suppresses_duplicates_conflicts_and_uncertain_retries() {
        let state = PrinterTransportState::new();
        let mut device = config(9100, "dedup", None);
        device.job_idempotency_key = Some("job-42".to_owned());
        let key = device.physical_key();
        let action = JobAction::Print(b"LABEL".to_vec());
        let fingerprint = action_fingerprint(&action);
        let scope = match state
            .reserve_idempotency(&device, &key, fingerprint)
            .unwrap()
        {
            IdempotencyReservation::Leader(scope) => scope,
            _ => panic!("first reservation must lead"),
        };
        let receipt = PrintReceipt {
            printer_id: device.id.clone(),
            physical_key: key.clone(),
            bytes: 5,
            queue_ms: 1,
            send_ms: 2,
            attempts: 1,
            reused_connection: false,
            delivery_state: "transport-accepted".to_owned(),
            confirmation_mode: "transport-write".to_owned(),
            idempotency_key: device.job_idempotency_key.clone(),
            deduplicated: false,
            durable_job_id: None,
            durable_state: None,
            status_report: None,
        };
        state.finish_idempotency(&scope, fingerprint, &Ok(receipt));
        let cached = match state
            .reserve_idempotency(&device, &key, fingerprint)
            .unwrap()
        {
            IdempotencyReservation::Cached(receipt) => receipt,
            _ => panic!("second reservation must be cached"),
        };
        assert!(cached.deduplicated);
        assert_eq!(cached.bytes, 5);
        assert!(state
            .reserve_idempotency(
                &device,
                &key,
                action_fingerprint(&JobAction::Print(b"OTHER".to_vec()))
            )
            .unwrap_err()
            .contains("conflict"));

        device.job_idempotency_key = Some("job-uncertain".to_owned());
        let uncertain_scope = match state
            .reserve_idempotency(&device, &key, fingerprint)
            .unwrap()
        {
            IdempotencyReservation::Leader(scope) => scope,
            _ => panic!("uncertain reservation must lead"),
        };
        state.finish_idempotency(
            &uncertain_scope,
            fingerprint,
            &Err("write timeout".to_owned()),
        );
        assert!(state
            .reserve_idempotency(&device, &key, fingerprint)
            .unwrap_err()
            .contains("IDEMPOTENCY_OUTCOME_UNCERTAIN"));
        let summary = state.summary();
        assert_eq!(summary.deduplicated_jobs, 1);
        assert_eq!(summary.idempotency_conflicts, 1);
        assert_eq!(summary.uncertain_jobs, 1);
        assert_eq!(summary.idempotency_ttl_ms, 600_000);
    }
}

#[cfg(all(test, feature = "slint-ui"))]
mod outbox_tests;
