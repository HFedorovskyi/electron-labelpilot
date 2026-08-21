use crate::commands::RuntimeState;
use crate::telemetry;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use serialport::{DataBits, FlowControl, Parity, SerialPortType, StopBits};
use std::collections::VecDeque;
use std::io::{self, Read, Write};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(2);
const IO_TIMEOUT: Duration = Duration::from_millis(100);
const WATCHDOG_TIMEOUT: Duration = Duration::from_secs(3);
const FRAME_IDLE_TIMEOUT: Duration = Duration::from_millis(25);
const MAX_FRAME_BUFFER: usize = 64 * 1024;
const READING_THROTTLE: Duration = Duration::from_millis(120);
const WEIGHT_EPSILON: f64 = 0.0005;
const STABILITY_THRESHOLD: f64 = 0.005;
const ERROR_REPEAT_INTERVAL: Duration = Duration::from_secs(10);
const RECONNECT_MIN: Duration = Duration::from_millis(250);
const RECONNECT_MAX: Duration = Duration::from_secs(2);

fn default_scale_type() -> String {
    "simulator".to_owned()
}
fn default_protocol_id() -> String {
    "simulator".to_owned()
}
fn default_polling_interval() -> u64 {
    250
}
fn default_stability_count() -> usize {
    4
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScaleConfig {
    #[serde(rename = "type", default = "default_scale_type")]
    pub connection_type: String,
    #[serde(default = "default_protocol_id")]
    pub protocol_id: String,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub baud_rate: Option<u32>,
    #[serde(default)]
    pub host: Option<String>,
    #[serde(default)]
    pub port: Option<u16>,
    #[serde(default = "default_polling_interval")]
    pub polling_interval: u64,
    #[serde(default = "default_stability_count")]
    pub stability_count: usize,
}

impl ScaleConfig {
    pub fn from_value(value: Value) -> Result<Self, String> {
        let mut config: Self = serde_json::from_value(value)
            .map_err(|error| format!("invalid scale config: {error}"))?;
        if !matches!(
            config.connection_type.as_str(),
            "serial" | "tcp" | "simulator"
        ) {
            return Err(format!(
                "unsupported scale connection type: {}",
                config.connection_type
            ));
        }
        if config.protocol_id.trim().is_empty() {
            return Err("scale protocolId must not be empty".to_owned());
        }
        if config.connection_type == "serial"
            && config
                .path
                .as_deref()
                .map(str::trim)
                .unwrap_or_default()
                .is_empty()
        {
            return Err("serial scale path must not be empty".to_owned());
        }
        if config.connection_type == "tcp" {
            if config
                .host
                .as_deref()
                .map(str::trim)
                .unwrap_or_default()
                .is_empty()
            {
                return Err("TCP scale host must not be empty".to_owned());
            }
            if config.port.unwrap_or_default() == 0 {
                return Err("TCP scale port must be in 1..65535".to_owned());
            }
        }
        if let Some(baud_rate) = config.baud_rate {
            if !(300..=3_000_000).contains(&baud_rate) {
                return Err("scale baudRate must be in 300..3000000".to_owned());
            }
        }
        config.polling_interval = config.polling_interval.clamp(50, 60_000);
        config.stability_count = config.stability_count.clamp(2, 32);
        Ok(config)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ScaleStatus {
    Disconnected,
    Reconnecting,
    Connecting,
    Connected,
}

impl ScaleStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Disconnected => "disconnected",
            Self::Reconnecting => "reconnecting",
            Self::Connecting => "connecting",
            Self::Connected => "connected",
        }
    }
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ScaleReading {
    pub weight: f64,
    pub unit: &'static str,
    pub stable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tare: Option<f64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtocolInfo {
    pub id: &'static str,
    pub name: &'static str,
    pub description: &'static str,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SerialPortInfo {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub manufacturer: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub product: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub serial_number: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pnp_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vendor_id: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub product_id: Option<u16>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScaleSummary {
    status: &'static str,
    worker_running: bool,
    connection_type: Option<String>,
    protocol_id: Option<String>,
    received_frames: u64,
    emitted_readings: u64,
    dropped_readings: u64,
    reconnect_attempts: u64,
    max_frame_buffer: usize,
    reading_throttle_ms: u64,
}

#[derive(Default)]
struct ScaleStats {
    received_frames: AtomicU64,
    emitted_readings: AtomicU64,
    dropped_readings: AtomicU64,
    reconnect_attempts: AtomicU64,
}

struct ScaleRuntime {
    status: ScaleStatus,
    config: Option<ScaleConfig>,
    stop: Option<Arc<AtomicBool>>,
    worker: Option<JoinHandle<()>>,
}

struct ScaleInner {
    runtime: Mutex<ScaleRuntime>,
    generation: AtomicU64,
    stats: ScaleStats,
}

pub struct ScaleState {
    inner: Arc<ScaleInner>,
}

impl ScaleState {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(ScaleInner {
                runtime: Mutex::new(ScaleRuntime {
                    status: ScaleStatus::Disconnected,
                    config: None,
                    stop: None,
                    worker: None,
                }),
                generation: AtomicU64::new(0),
                stats: ScaleStats::default(),
            }),
        }
    }

    pub fn connect(&self, app: AppHandle, payload: Value) -> Result<(), String> {
        let config = ScaleConfig::from_value(payload)?;
        self.stop_worker();
        reset_stats(&self.inner.stats);
        let generation = self.inner.generation.fetch_add(1, Ordering::AcqRel) + 1;
        let stop = Arc::new(AtomicBool::new(false));
        {
            let mut runtime = self
                .inner
                .runtime
                .lock()
                .map_err(|_| "scale runtime lock is poisoned")?;
            runtime.config = Some(config.clone());
            runtime.stop = Some(Arc::clone(&stop));
            runtime.status = ScaleStatus::Reconnecting;
        }
        let _ = app.emit("scale-status", ScaleStatus::Reconnecting.as_str());
        let inner = Arc::clone(&self.inner);
        let worker_app = app.clone();
        let worker = match thread::Builder::new()
            .name("labelpilot-scale".to_owned())
            .spawn(move || run_scale_worker(inner, worker_app, config, generation, stop))
        {
            Ok(worker) => worker,
            Err(error) => {
                if let Ok(mut runtime) = self.inner.runtime.lock() {
                    runtime.stop.take();
                    runtime.status = ScaleStatus::Disconnected;
                }
                let _ = app.emit("scale-status", ScaleStatus::Disconnected.as_str());
                return Err(format!("failed to start scale worker: {error}"));
            }
        };
        self.inner
            .runtime
            .lock()
            .map_err(|_| "scale runtime lock is poisoned")?
            .worker = Some(worker);
        log_scale(&app, "INFO", "Rust scale worker started");
        Ok(())
    }

    pub fn disconnect(&self, app: &AppHandle) {
        self.stop_worker();
        set_status(
            &self.inner,
            app,
            self.inner.generation.load(Ordering::Acquire),
            ScaleStatus::Disconnected,
        );
        log_scale(app, "INFO", "Rust scale worker disconnected");
    }

    pub fn status(&self) -> &'static str {
        self.inner
            .runtime
            .lock()
            .map(|runtime| runtime.status.as_str())
            .unwrap_or("disconnected")
    }

    pub fn summary(&self) -> ScaleSummary {
        let runtime = self.inner.runtime.lock().ok();
        ScaleSummary {
            status: runtime
                .as_ref()
                .map(|value| value.status.as_str())
                .unwrap_or("disconnected"),
            worker_running: runtime
                .as_ref()
                .and_then(|value| value.worker.as_ref())
                .is_some_and(|worker| !worker.is_finished()),
            connection_type: runtime
                .as_ref()
                .and_then(|value| value.config.as_ref())
                .map(|config| config.connection_type.clone()),
            protocol_id: runtime
                .as_ref()
                .and_then(|value| value.config.as_ref())
                .map(|config| config.protocol_id.clone()),
            received_frames: self.inner.stats.received_frames.load(Ordering::Acquire),
            emitted_readings: self.inner.stats.emitted_readings.load(Ordering::Acquire),
            dropped_readings: self.inner.stats.dropped_readings.load(Ordering::Acquire),
            reconnect_attempts: self.inner.stats.reconnect_attempts.load(Ordering::Acquire),
            max_frame_buffer: MAX_FRAME_BUFFER,
            reading_throttle_ms: READING_THROTTLE.as_millis() as u64,
        }
    }

    fn stop_worker(&self) {
        self.inner.generation.fetch_add(1, Ordering::AcqRel);
        let (stop, worker) = match self.inner.runtime.lock() {
            Ok(mut runtime) => (runtime.stop.take(), runtime.worker.take()),
            Err(_) => return,
        };
        if let Some(stop) = stop {
            stop.store(true, Ordering::Release);
        }
        if let Some(worker) = worker {
            let _ = worker.join();
        }
    }
}

impl Default for ScaleState {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for ScaleState {
    fn drop(&mut self) {
        self.stop_worker();
    }
}

pub fn list_serial_ports() -> Result<Vec<SerialPortInfo>, String> {
    let ports = serialport::available_ports()
        .map_err(|error| format!("failed to enumerate serial ports: {error}"))?;
    Ok(ports
        .into_iter()
        .map(|port| {
            let mut info = SerialPortInfo {
                path: port.port_name,
                manufacturer: None,
                product: None,
                serial_number: None,
                pnp_id: None,
                vendor_id: None,
                product_id: None,
            };
            match port.port_type {
                SerialPortType::UsbPort(usb) => {
                    info.manufacturer = usb.manufacturer;
                    info.product = usb.product;
                    info.serial_number = usb.serial_number;
                    info.pnp_id = Some(format!("USB\\VID_{:04X}&PID_{:04X}", usb.vid, usb.pid));
                    info.vendor_id = Some(usb.vid);
                    info.product_id = Some(usb.pid);
                }
                SerialPortType::BluetoothPort => {
                    info.manufacturer = Some("Bluetooth".to_owned());
                }
                SerialPortType::PciPort => {
                    info.manufacturer = Some("PCI".to_owned());
                }
                SerialPortType::Unknown => {}
            }
            info
        })
        .collect())
}

pub fn protocol_catalog() -> Vec<ProtocolInfo> {
    PROTOCOLS
        .iter()
        .map(|protocol| ProtocolInfo {
            id: protocol.id,
            name: protocol.name,
            description: protocol.description,
        })
        .collect()
}

#[derive(Clone, Copy, Debug)]
enum ParserKind {
    Cas,
    Mettler,
    Massa100,
    MassaP1,
    MassaLite,
    MassaAstb,
    MassaContinuous,
    MassaAstbP,
    MassaJ,
    Shtrih,
    Mertech,
    AndStandard,
    Dibal,
    CommonAscii,
    DiniArgeo,
    Simulator,
    Generic,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Framing {
    Lines,
    Massa100,
    MassaJ,
}

#[derive(Clone, Copy, Debug)]
enum ProtocolParity {
    None,
    Even,
    Odd,
}

#[derive(Clone, Copy, Debug)]
struct Protocol {
    id: &'static str,
    name: &'static str,
    description: &'static str,
    polling_required: bool,
    default_baud_rate: u32,
    parity: ProtocolParity,
    data_bits: u8,
    stop_bits: u8,
    parser: ParserKind,
    framing: Framing,
}

const PROTOCOLS: [Protocol; 20] = [
    Protocol {
        id: "cas_simple",
        name: "CAS (Simple/PDS)",
        description: "Standard CAS protocol (AD-1, ER, SW models)",
        polling_required: true,
        default_baud_rate: 9600,
        parity: ProtocolParity::None,
        data_bits: 8,
        stop_bits: 1,
        parser: ParserKind::Cas,
        framing: Framing::Lines,
    },
    Protocol {
        id: "mettler_sics",
        name: "Mettler Toledo (SICS)",
        description: "Standard Interface Command Set",
        polling_required: true,
        default_baud_rate: 9600,
        parity: ProtocolParity::None,
        data_bits: 8,
        stop_bits: 1,
        parser: ParserKind::Mettler,
        framing: Framing::Lines,
    },
    Protocol {
        id: "massak_100",
        name: "Massa-K (Protocol 2 / 100)",
        description: "Binary protocol (100) for Massa-K terminals",
        polling_required: true,
        default_baud_rate: 19200,
        parity: ProtocolParity::Even,
        data_bits: 8,
        stop_bits: 1,
        parser: ParserKind::Massa100,
        framing: Framing::Massa100,
    },
    Protocol {
        id: "massak_p1",
        name: "Massa-K (Protocol 1)",
        description: "ASCII protocol for Massa-K terminals",
        polling_required: true,
        default_baud_rate: 9600,
        parity: ProtocolParity::None,
        data_bits: 8,
        stop_bits: 1,
        parser: ParserKind::MassaP1,
        framing: Framing::Lines,
    },
    Protocol {
        id: "massak_astb",
        name: "Massa-K A/TB (Simple)",
        description: "Protocol 3 (Request 0x05) for AB/AB-series scales",
        polling_required: true,
        default_baud_rate: 9600,
        parity: ProtocolParity::None,
        data_bits: 8,
        stop_bits: 1,
        parser: ParserKind::MassaAstb,
        framing: Framing::Lines,
    },
    Protocol {
        id: "massak_astbp",
        name: "Massa-K A/TB (Text P)",
        description: "Protocol using P command, common in A/TB series",
        polling_required: true,
        default_baud_rate: 4800,
        parity: ProtocolParity::None,
        data_bits: 8,
        stop_bits: 1,
        parser: ParserKind::MassaAstbP,
        framing: Framing::Lines,
    },
    Protocol {
        id: "massak_j",
        name: "Massa-K (Binary Protocol J)",
        description: "Бинарный протокол Massa-K: запрос J, 4800 бод, чётность Even",
        polling_required: true,
        default_baud_rate: 4800,
        parity: ProtocolParity::Even,
        data_bits: 8,
        stop_bits: 1,
        parser: ParserKind::MassaJ,
        framing: Framing::MassaJ,
    },
    Protocol {
        id: "massak_cont",
        name: "Massa-K (Непрерывный)",
        description: "Для весов, настроенных на постоянную передачу данных",
        polling_required: false,
        default_baud_rate: 9600,
        parity: ProtocolParity::None,
        data_bits: 8,
        stop_bits: 1,
        parser: ParserKind::MassaContinuous,
        framing: Framing::Lines,
    },
    Protocol {
        id: "massak_lite",
        name: "Massa-K (Lite)",
        description: "Simple text protocol",
        polling_required: true,
        default_baud_rate: 9600,
        parity: ProtocolParity::None,
        data_bits: 8,
        stop_bits: 1,
        parser: ParserKind::MassaLite,
        framing: Framing::Lines,
    },
    Protocol {
        id: "shtrih_m",
        name: "Shtrih-M (POS2)",
        description: "Standard POS2 protocol",
        polling_required: true,
        default_baud_rate: 9600,
        parity: ProtocolParity::None,
        data_bits: 8,
        stop_bits: 1,
        parser: ParserKind::Shtrih,
        framing: Framing::Lines,
    },
    Protocol {
        id: "mertech",
        name: "Mertech",
        description: "Universal Mertech Protocol",
        polling_required: true,
        default_baud_rate: 115200,
        parity: ProtocolParity::None,
        data_bits: 8,
        stop_bits: 1,
        parser: ParserKind::Mertech,
        framing: Framing::Lines,
    },
    Protocol {
        id: "and_standard",
        name: "A&D / Standard (ST/US)",
        description: "Стандартный ASCII-формат A&D (ST/US/OL) — A&D, Tscale и совместимые",
        polling_required: true,
        default_baud_rate: 2400,
        parity: ProtocolParity::None,
        data_bits: 7,
        stop_bits: 1,
        parser: ParserKind::AndStandard,
        framing: Framing::Lines,
    },
    Protocol {
        id: "dibal_delta",
        name: "Dibal (Delta)",
        description: "Dibal Delta: запрос D, ASCII-вес со знаком (кг)",
        polling_required: true,
        default_baud_rate: 9600,
        parity: ProtocolParity::None,
        data_bits: 8,
        stop_bits: 1,
        parser: ParserKind::Dibal,
        framing: Framing::Lines,
    },
    Protocol {
        id: "ohaus",
        name: "OHAUS (ASCII)",
        description: "OHAUS Defender/Ranger/Scout/Valor — ASCII-печать, команда IP",
        polling_required: true,
        default_baud_rate: 9600,
        parity: ProtocolParity::None,
        data_bits: 8,
        stop_bits: 1,
        parser: ParserKind::CommonAscii,
        framing: Framing::Lines,
    },
    Protocol {
        id: "sartorius_sbi",
        name: "Sartorius / Minebea (SBI)",
        description: "Sartorius SBI: печать по ESC P, ASCII со знаком и единицей",
        polling_required: true,
        default_baud_rate: 9600,
        parity: ProtocolParity::Odd,
        data_bits: 7,
        stop_bits: 1,
        parser: ParserKind::CommonAscii,
        framing: Framing::Lines,
    },
    Protocol {
        id: "radwag",
        name: "RADWAG (ASCII)",
        description: "RADWAG: команда SI, ASCII-масса со знаком и единицей",
        polling_required: true,
        default_baud_rate: 9600,
        parity: ProtocolParity::None,
        data_bits: 8,
        stop_bits: 1,
        parser: ParserKind::CommonAscii,
        framing: Framing::Lines,
    },
    Protocol {
        id: "kern",
        name: "KERN (KCP/ASCII)",
        description: "KERN & Sohn: команда w, ASCII-масса с единицей",
        polling_required: true,
        default_baud_rate: 9600,
        parity: ProtocolParity::None,
        data_bits: 8,
        stop_bits: 1,
        parser: ParserKind::CommonAscii,
        framing: Framing::Lines,
    },
    Protocol {
        id: "dini_argeo",
        name: "Dini Argeo (DFW/DGT/3590)",
        description: "Dini Argeo: запрос READ, строка ST,GS,вес,ед",
        polling_required: true,
        default_baud_rate: 9600,
        parity: ProtocolParity::None,
        data_bits: 8,
        stop_bits: 1,
        parser: ParserKind::DiniArgeo,
        framing: Framing::Lines,
    },
    Protocol {
        id: "simulator",
        name: "Simulator (Virtual Scale)",
        description: "Generates random weight and toggles stability",
        polling_required: true,
        default_baud_rate: 9600,
        parity: ProtocolParity::None,
        data_bits: 8,
        stop_bits: 1,
        parser: ParserKind::Simulator,
        framing: Framing::Lines,
    },
    Protocol {
        id: "generic",
        name: "Generic Text",
        description: "Parses first number found in output",
        polling_required: false,
        default_baud_rate: 9600,
        parity: ProtocolParity::None,
        data_bits: 8,
        stop_bits: 1,
        parser: ParserKind::Generic,
        framing: Framing::Lines,
    },
];

fn protocol_by_id(id: &str) -> &'static Protocol {
    PROTOCOLS
        .iter()
        .find(|protocol| protocol.id == id)
        .unwrap_or_else(|| PROTOCOLS.last().expect("generic scale protocol"))
}

impl Protocol {
    fn weight_command(self) -> Option<Vec<u8>> {
        match self.parser {
            ParserKind::Cas => Some(b"W".to_vec()),
            ParserKind::Mettler => Some(b"S\r\n".to_vec()),
            ParserKind::Massa100 => {
                let data = [0x01, 0x00, 0xA0];
                let crc = crc16(&data).to_le_bytes();
                Some(vec![
                    0xF8, 0x55, 0xCE, data[0], data[1], data[2], crc[0], crc[1],
                ])
            }
            ParserKind::MassaP1 => Some(b"W\r\n".to_vec()),
            ParserKind::MassaLite => Some(vec![0x45]),
            ParserKind::MassaAstb => Some(vec![0x05]),
            ParserKind::MassaAstbP => Some(b"P\r\n".to_vec()),
            ParserKind::MassaJ => Some(b"J".to_vec()),
            ParserKind::Shtrih => Some(vec![0x02, 0x05, 0x39, 0x3E]),
            ParserKind::Mertech => Some(b"W".to_vec()),
            ParserKind::AndStandard => Some(b"Q\r\n".to_vec()),
            ParserKind::Dibal => Some(vec![0x44, 0x0D, 0x0A]),
            ParserKind::CommonAscii if self.id == "ohaus" => Some(b"IP\r\n".to_vec()),
            ParserKind::CommonAscii if self.id == "sartorius_sbi" => {
                Some(vec![0x1B, 0x50, 0x0D, 0x0A])
            }
            ParserKind::CommonAscii if self.id == "radwag" => Some(b"SI\r\n".to_vec()),
            ParserKind::CommonAscii if self.id == "kern" => Some(b"w\r\n".to_vec()),
            ParserKind::DiniArgeo => Some(b"READ\r\n".to_vec()),
            ParserKind::Simulator => Some(b"SIM".to_vec()),
            _ => None,
        }
    }
}

fn crc16(data: &[u8]) -> u16 {
    let mut crc = 0xFFFF_u16;
    for byte in data {
        crc ^= u16::from(*byte);
        for _ in 0..8 {
            crc = if crc & 1 != 0 {
                (crc >> 1) ^ 0xA001
            } else {
                crc >> 1
            };
        }
    }
    crc
}

fn parse_protocol(protocol: &Protocol, data: &[u8]) -> Option<ScaleReading> {
    match protocol.parser {
        ParserKind::Cas => parse_cas(data),
        ParserKind::Mettler => parse_mettler(data),
        ParserKind::Massa100 => parse_massa_100(data),
        ParserKind::MassaP1 => parse_massa_p1(data),
        ParserKind::MassaLite => parse_first_decimal(data, false, false),
        ParserKind::MassaAstb => parse_massa_astb(data),
        ParserKind::MassaContinuous | ParserKind::MassaAstbP => {
            parse_first_decimal(data, text(data).contains('S'), true)
        }
        ParserKind::MassaJ => parse_massa_j(data),
        ParserKind::Shtrih => parse_first_decimal(data, false, false),
        ParserKind::Mertech => parse_first_decimal(data, text(data).contains('S'), false),
        ParserKind::AndStandard => parse_and_standard(data),
        ParserKind::Dibal => parse_dibal(data),
        ParserKind::CommonAscii => parse_common_ascii(data),
        ParserKind::DiniArgeo => parse_dini_argeo(data),
        ParserKind::Generic => parse_first_decimal(data, false, false),
        ParserKind::Simulator => None,
    }
}

fn text(data: &[u8]) -> String {
    String::from_utf8_lossy(data).into_owned()
}

fn decimal_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| Regex::new(r"([+-]?)\s*(\d+\.\d+)").expect("decimal regex"))
}

fn parse_number(sign: &str, digits: &str) -> Option<f64> {
    let value = format!("{}{}", if sign == "-" { "-" } else { "" }, digits)
        .parse::<f64>()
        .ok()?;
    value.is_finite().then_some(value)
}

fn parse_first_decimal(data: &[u8], stable: bool, signed: bool) -> Option<ScaleReading> {
    let value = text(data);
    let capture = decimal_regex().captures(&value)?;
    let sign = if signed {
        capture.get(1).map_or("", |value| value.as_str())
    } else {
        ""
    };
    Some(ScaleReading {
        weight: parse_number(sign, capture.get(2)?.as_str())?,
        unit: "kg",
        stable,
        tare: None,
    })
}

fn cas_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(r"([A-Z]{2}),.*?,([+|-]?)\s*(\d+\.\d+)([A-Za-z]+)").expect("CAS regex")
    })
}

fn parse_cas(data: &[u8]) -> Option<ScaleReading> {
    let value = text(data);
    let capture = cas_regex().captures(&value)?;
    let unit = match capture.get(4)?.as_str().to_ascii_lowercase().as_str() {
        "g" => "g",
        "lb" => "lb",
        _ => "kg",
    };
    Some(ScaleReading {
        weight: parse_number(capture.get(2)?.as_str(), capture.get(3)?.as_str())?,
        unit,
        stable: capture.get(1)?.as_str() == "ST",
        tare: None,
    })
}

fn parse_mettler(data: &[u8]) -> Option<ScaleReading> {
    let value = text(data);
    let parts: Vec<&str> = value.split_whitespace().collect();
    if parts.len() < 3 || parts[0] != "S" || parts[1] == "I" {
        return None;
    }
    let weight = parts[2].parse::<f64>().ok()?;
    if !weight.is_finite() {
        return None;
    }
    let unit = match parts.get(3).map(|unit| unit.to_ascii_lowercase()) {
        Some(unit) if unit == "g" => "g",
        Some(unit) if unit == "lb" => "lb",
        _ => "kg",
    };
    Some(ScaleReading {
        weight,
        unit,
        stable: parts[1] == "S",
        tare: None,
    })
}

fn parse_massa_100(data: &[u8]) -> Option<ScaleReading> {
    let header = data
        .windows(3)
        .position(|window| window == [0xF8, 0x55, 0xCE])?;
    let packet = data.get(header..)?;
    if packet.len() < 14 {
        return None;
    }
    let raw = i32::from_le_bytes(packet.get(6..10)?.try_into().ok()?);
    Some(ScaleReading {
        weight: f64::from(raw) / 1000.0,
        unit: "kg",
        stable: *packet.get(11)? == 1,
        tare: None,
    })
}

fn parse_massa_p1(data: &[u8]) -> Option<ScaleReading> {
    let value = text(data);
    static REGEX: OnceLock<Regex> = OnceLock::new();
    let regex = REGEX.get_or_init(|| {
        Regex::new(r"([SU?])\s*([+-]?)\s*(\d+\.\d+)\s*(\w+)?").expect("Massa P1 regex")
    });
    if let Some(capture) = regex.captures(&value) {
        let unit = match capture
            .get(5)
            .map(|unit| unit.as_str().to_ascii_lowercase())
        {
            Some(unit) if unit == "g" => "g",
            Some(unit) if unit == "lb" => "lb",
            _ => "kg",
        };
        return Some(ScaleReading {
            weight: parse_number(
                capture.get(2).map_or("", |value| value.as_str()),
                capture.get(3)?.as_str(),
            )?,
            unit,
            stable: capture.get(1)?.as_str() == "S",
            tare: None,
        });
    }
    parse_first_decimal(data, value.contains('S'), true)
}

fn parse_massa_astb(data: &[u8]) -> Option<ScaleReading> {
    let value = text(data);
    static REGEX: OnceLock<Regex> = OnceLock::new();
    let regex = REGEX
        .get_or_init(|| Regex::new(r"([+-]?)\s*(\d+\.\d+)\s*(kg|g)?").expect("Massa A/TB regex"));
    let capture = regex.captures(&value)?;
    let unit = if capture
        .get(3)
        .is_some_and(|unit| unit.as_str().eq_ignore_ascii_case("g"))
    {
        "g"
    } else {
        "kg"
    };
    Some(ScaleReading {
        weight: parse_number(
            capture.get(1).map_or("", |value| value.as_str()),
            capture.get(2)?.as_str(),
        )?,
        unit,
        stable: value.contains('S'),
        tare: None,
    })
}

fn parse_massa_j(data: &[u8]) -> Option<ScaleReading> {
    let packet = data.get(..5)?;
    let status = packet[0];
    let grams = i16::from_le_bytes(packet.get(2..4)?.try_into().ok()?);
    let mut weight = f64::from(grams) / 1000.0;
    if status & 0x40 != 0 && weight > 0.0 {
        weight = -weight;
    }
    Some(ScaleReading {
        weight,
        unit: "kg",
        stable: status & 0x80 != 0,
        tare: None,
    })
}

fn and_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(r"\b(ST|US|QT|WT|NT|OL)\s*,\s*([+-]?)\s*(\d+\.\d+)\s*([A-Za-z]+)?")
            .expect("A&D regex")
    })
}

fn parse_and_standard(data: &[u8]) -> Option<ScaleReading> {
    let value = text(data);
    let capture = and_regex().captures(&value)?;
    let status = capture.get(1)?.as_str();
    if status == "OL" {
        return None;
    }
    let mut weight = parse_number(
        capture.get(2).map_or("", |value| value.as_str()),
        capture.get(3)?.as_str(),
    )?;
    let mut unit = match capture
        .get(4)
        .map(|unit| unit.as_str().to_ascii_lowercase())
    {
        Some(unit) if unit == "g" => "g",
        Some(unit) if unit == "lb" => "lb",
        _ => "kg",
    };
    if unit == "g" {
        weight /= 1000.0;
        unit = "kg";
    }
    Some(ScaleReading {
        weight,
        unit,
        stable: status == "ST",
        tare: None,
    })
}

fn parse_dibal(data: &[u8]) -> Option<ScaleReading> {
    let value = text(data);
    let capture = decimal_regex().captures(&value)?;
    if capture.get(1).map_or("", |value| value.as_str()).is_empty() {
        return None;
    }
    Some(ScaleReading {
        weight: parse_number(capture.get(1)?.as_str(), capture.get(2)?.as_str())?,
        unit: "kg",
        stable: true,
        tare: None,
    })
}

fn common_ascii_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(r"([+-]?)\s*(\d+\.\d+)\s*(kg|g|lb|oz|ct)?").expect("common ASCII regex")
    })
}

fn parse_common_ascii(data: &[u8]) -> Option<ScaleReading> {
    let value = text(data);
    let capture = common_ascii_regex().captures(&value)?;
    let mut weight = parse_number(
        capture.get(1).map_or("", |value| value.as_str()),
        capture.get(2)?.as_str(),
    )?;
    let mut unit = match capture
        .get(3)
        .map(|unit| unit.as_str().to_ascii_lowercase())
    {
        Some(unit) if unit == "g" => "g",
        Some(unit) if unit == "lb" => "lb",
        _ => "kg",
    };
    if unit == "g" {
        weight /= 1000.0;
        unit = "kg";
    }
    Some(ScaleReading {
        weight,
        unit,
        stable: false,
        tare: None,
    })
}

fn dini_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(
            r"(ST|US|OL|UL|TL)\s*,\s*[A-Za-z]{2}\s*,\s*([+-]?\d+(?:\.\d+)?)\s*,?\s*(kg|g|lb)?",
        )
        .expect("Dini Argeo regex")
    })
}

fn parse_dini_argeo(data: &[u8]) -> Option<ScaleReading> {
    let value = text(data);
    let capture = dini_regex().captures(&value)?;
    let status = capture.get(1)?.as_str();
    if !matches!(status, "ST" | "US") {
        return None;
    }
    let mut weight = capture.get(2)?.as_str().parse::<f64>().ok()?;
    let mut unit = match capture
        .get(3)
        .map(|unit| unit.as_str().to_ascii_lowercase())
    {
        Some(unit) if unit == "g" => "g",
        Some(unit) if unit == "lb" => "lb",
        _ => "kg",
    };
    if unit == "g" {
        weight /= 1000.0;
        unit = "kg";
    }
    Some(ScaleReading {
        weight,
        unit,
        stable: status == "ST",
        tare: None,
    })
}
struct FrameDecoder {
    framing: Framing,
    buffer: Vec<u8>,
    last_append: Option<Instant>,
}

impl FrameDecoder {
    fn new(framing: Framing) -> Self {
        Self {
            framing,
            buffer: Vec::with_capacity(4096),
            last_append: None,
        }
    }

    fn push(&mut self, bytes: &[u8]) -> Vec<Vec<u8>> {
        if bytes.is_empty() {
            return Vec::new();
        }
        if bytes.len() >= MAX_FRAME_BUFFER {
            self.buffer.clear();
            self.buffer
                .extend_from_slice(&bytes[bytes.len() - MAX_FRAME_BUFFER..]);
        } else {
            let overflow = self
                .buffer
                .len()
                .saturating_add(bytes.len())
                .saturating_sub(MAX_FRAME_BUFFER);
            if overflow > 0 {
                self.buffer.drain(..overflow.min(self.buffer.len()));
            }
            self.buffer.extend_from_slice(bytes);
        }
        self.last_append = Some(Instant::now());
        self.drain_ready()
    }

    fn flush_idle(&mut self) -> Vec<Vec<u8>> {
        if self.framing != Framing::Lines
            || self.buffer.is_empty()
            || self
                .last_append
                .is_none_or(|instant| instant.elapsed() < FRAME_IDLE_TIMEOUT)
        {
            return Vec::new();
        }
        vec![std::mem::take(&mut self.buffer)]
    }

    #[cfg(test)]
    fn flush_now(&mut self) -> Vec<Vec<u8>> {
        if self.buffer.is_empty() {
            Vec::new()
        } else {
            vec![std::mem::take(&mut self.buffer)]
        }
    }

    fn drain_ready(&mut self) -> Vec<Vec<u8>> {
        match self.framing {
            Framing::Lines => self.drain_lines(),
            Framing::Massa100 => self.drain_massa_100(),
            Framing::MassaJ => self.drain_fixed(5),
        }
    }

    fn drain_lines(&mut self) -> Vec<Vec<u8>> {
        let mut frames = Vec::new();
        while let Some(position) = self
            .buffer
            .iter()
            .position(|byte| matches!(*byte, b'\r' | b'\n'))
        {
            let mut frame: Vec<u8> = self.buffer.drain(..=position).collect();
            while matches!(frame.last(), Some(b'\r' | b'\n')) {
                frame.pop();
            }
            while matches!(self.buffer.first(), Some(b'\r' | b'\n')) {
                self.buffer.remove(0);
            }
            if !frame.is_empty() {
                frames.push(frame);
            }
        }
        frames
    }

    fn drain_massa_100(&mut self) -> Vec<Vec<u8>> {
        const HEADER: [u8; 3] = [0xF8, 0x55, 0xCE];
        let mut frames = Vec::new();
        loop {
            let Some(header) = self.buffer.windows(3).position(|window| window == HEADER) else {
                if self.buffer.len() > 2 {
                    let tail = self.buffer.split_off(self.buffer.len() - 2);
                    self.buffer = tail;
                }
                break;
            };
            if header > 0 {
                self.buffer.drain(..header);
            }
            if self.buffer.len() < 5 {
                break;
            }
            let payload = usize::from(u16::from_le_bytes([self.buffer[3], self.buffer[4]]));
            let total = 3 + 2 + payload + 2;
            if payload == 0 || total > MAX_FRAME_BUFFER {
                self.buffer.remove(0);
                continue;
            }
            if self.buffer.len() < total {
                break;
            }
            frames.push(self.buffer.drain(..total).collect());
        }
        frames
    }

    fn drain_fixed(&mut self, length: usize) -> Vec<Vec<u8>> {
        let mut frames = Vec::new();
        while self.buffer.len() >= length {
            frames.push(self.buffer.drain(..length).collect());
        }
        frames
    }
}

struct ReadingFilter {
    recent: VecDeque<f64>,
    stability_count: usize,
    last_weight: Option<f64>,
    last_stable: Option<bool>,
    last_sent: Option<Instant>,
}

impl ReadingFilter {
    fn new(stability_count: usize) -> Self {
        Self {
            recent: VecDeque::with_capacity(stability_count),
            stability_count,
            last_weight: None,
            last_stable: None,
            last_sent: None,
        }
    }

    fn filter(&mut self, mut reading: ScaleReading) -> Option<ScaleReading> {
        self.recent.push_back(reading.weight);
        while self.recent.len() > self.stability_count {
            self.recent.pop_front();
        }
        if self.recent.len() >= self.stability_count {
            let minimum = self.recent.iter().copied().fold(f64::INFINITY, f64::min);
            let maximum = self
                .recent
                .iter()
                .copied()
                .fold(f64::NEG_INFINITY, f64::max);
            reading.stable |= maximum - minimum <= STABILITY_THRESHOLD;
        }
        let weight_changed = self
            .last_weight
            .is_none_or(|weight| (reading.weight - weight).abs() > WEIGHT_EPSILON);
        let stable_changed = self.last_stable != Some(reading.stable);
        if !weight_changed && !stable_changed {
            return None;
        }
        let now = Instant::now();
        if !stable_changed
            && self
                .last_sent
                .is_some_and(|sent| now.duration_since(sent) < READING_THROTTLE)
        {
            return None;
        }
        self.last_weight = Some(reading.weight);
        self.last_stable = Some(reading.stable);
        self.last_sent = Some(now);
        Some(reading)
    }
}

struct ReconnectBackoff {
    next: Duration,
}

impl ReconnectBackoff {
    fn new() -> Self {
        Self {
            next: RECONNECT_MIN,
        }
    }

    fn take(&mut self) -> Duration {
        let current = self.next;
        self.next = (self.next * 2).min(RECONNECT_MAX);
        current
    }

    fn reset(&mut self) {
        self.next = RECONNECT_MIN;
    }
}

struct ErrorThrottle {
    last: Option<(String, Instant)>,
}

impl ErrorThrottle {
    fn new() -> Self {
        Self { last: None }
    }

    fn should_emit(&mut self, message: &str) -> bool {
        let emit = self.last.as_ref().is_none_or(|(previous, instant)| {
            previous != message || instant.elapsed() >= ERROR_REPEAT_INTERVAL
        });
        if emit {
            self.last = Some((message.to_owned(), Instant::now()));
        }
        emit
    }
}

fn reset_stats(stats: &ScaleStats) {
    stats.received_frames.store(0, Ordering::Release);
    stats.emitted_readings.store(0, Ordering::Release);
    stats.dropped_readings.store(0, Ordering::Release);
    stats.reconnect_attempts.store(0, Ordering::Release);
}

fn run_scale_worker(
    inner: Arc<ScaleInner>,
    app: AppHandle,
    config: ScaleConfig,
    generation: u64,
    stop: Arc<AtomicBool>,
) {
    let protocol = *protocol_by_id(&config.protocol_id);
    if protocol.id != config.protocol_id {
        log_scale(
            &app,
            "WARN",
            &format!(
                "unknown scale protocol '{}'; generic parser selected",
                config.protocol_id
            ),
        );
    }
    if config.connection_type == "simulator" {
        run_simulator(&inner, &app, &config, generation, &stop);
        set_status(&inner, &app, generation, ScaleStatus::Disconnected);
        return;
    }

    let mut backoff = ReconnectBackoff::new();
    let mut errors = ErrorThrottle::new();
    while active(&inner, generation, &stop) {
        inner
            .stats
            .reconnect_attempts
            .fetch_add(1, Ordering::AcqRel);
        set_status(&inner, &app, generation, ScaleStatus::Reconnecting);
        let result = if config.connection_type == "tcp" {
            run_tcp_once(&inner, &app, &config, &protocol, generation, &stop)
        } else {
            run_serial_once(&inner, &app, &config, &protocol, generation, &stop)
        };
        if !active(&inner, generation, &stop) {
            break;
        }
        set_status(&inner, &app, generation, ScaleStatus::Disconnected);
        match result {
            Ok(()) => backoff.reset(),
            Err(error) => {
                let message = map_scale_error(&config, &error);
                log_scale(&app, "WARN", &format!("scale transport: {message}"));
                if errors.should_emit(&message) {
                    emit_error(&inner, &app, generation, &message);
                }
            }
        }
        if wait_interruptible(&stop, backoff.take()) {
            break;
        }
    }
    set_status(&inner, &app, generation, ScaleStatus::Disconnected);
}

fn run_tcp_once(
    inner: &Arc<ScaleInner>,
    app: &AppHandle,
    config: &ScaleConfig,
    protocol: &Protocol,
    generation: u64,
    stop: &Arc<AtomicBool>,
) -> Result<(), String> {
    let host = config.host.as_deref().unwrap_or_default();
    let port = config.port.unwrap_or_default();
    let address = resolve_address(host, port)?;
    let mut stream = TcpStream::connect_timeout(&address, CONNECT_TIMEOUT)
        .map_err(|error| format!("TCP connect {address}: {error}"))?;
    stream
        .set_read_timeout(Some(IO_TIMEOUT))
        .map_err(|error| format!("TCP read timeout: {error}"))?;
    stream
        .set_write_timeout(Some(IO_TIMEOUT))
        .map_err(|error| format!("TCP write timeout: {error}"))?;
    let _ = stream.set_nodelay(true);
    set_status(inner, app, generation, ScaleStatus::Connecting);
    log_scale(app, "INFO", &format!("TCP scale connected to {address}"));
    run_transport(
        inner,
        app,
        config,
        protocol,
        generation,
        stop,
        &mut stream,
        true,
    )
}

fn run_serial_once(
    inner: &Arc<ScaleInner>,
    app: &AppHandle,
    config: &ScaleConfig,
    protocol: &Protocol,
    generation: u64,
    stop: &Arc<AtomicBool>,
) -> Result<(), String> {
    let path = config.path.as_deref().unwrap_or_default();
    let baud_rate = config.baud_rate.unwrap_or(protocol.default_baud_rate);
    let builder = serialport::new(path, baud_rate)
        .timeout(IO_TIMEOUT)
        .flow_control(FlowControl::None)
        .parity(match protocol.parity {
            ProtocolParity::None => Parity::None,
            ProtocolParity::Even => Parity::Even,
            ProtocolParity::Odd => Parity::Odd,
        })
        .data_bits(match protocol.data_bits {
            5 => DataBits::Five,
            6 => DataBits::Six,
            7 => DataBits::Seven,
            _ => DataBits::Eight,
        })
        .stop_bits(if protocol.stop_bits == 2 {
            StopBits::Two
        } else {
            StopBits::One
        });
    let mut port = builder
        .open()
        .map_err(|error| format!("serial open {path}: {error}"))?;
    let _ = port.write_data_terminal_ready(true);
    let _ = port.write_request_to_send(true);
    set_status(inner, app, generation, ScaleStatus::Connecting);
    log_scale(
        app,
        "INFO",
        &format!("serial scale opened {path} at {baud_rate}"),
    );
    run_transport(
        inner, app, config, protocol, generation, stop, &mut *port, false,
    )
}

fn run_transport<T: Read + Write + ?Sized>(
    inner: &Arc<ScaleInner>,
    app: &AppHandle,
    config: &ScaleConfig,
    protocol: &Protocol,
    generation: u64,
    stop: &Arc<AtomicBool>,
    transport: &mut T,
    zero_means_closed: bool,
) -> Result<(), String> {
    let mut decoder = FrameDecoder::new(protocol.framing);
    let mut filter = ReadingFilter::new(config.stability_count);
    let interval = Duration::from_millis(config.polling_interval);
    let command = protocol.weight_command();
    let mut next_poll = Instant::now();
    let mut last_valid = Instant::now();
    let mut first_valid_logged = false;
    let mut read_buffer = [0_u8; 4096];
    while active(inner, generation, stop) {
        let now = Instant::now();
        if protocol.polling_required && now >= next_poll {
            if let Some(command) = command.as_deref() {
                transport
                    .write_all(command)
                    .map_err(|error| format!("scale poll write: {error}"))?;
                transport
                    .flush()
                    .map_err(|error| format!("scale poll flush: {error}"))?;
            }
            next_poll = now + interval;
        }
        match transport.read(&mut read_buffer) {
            Ok(0) if zero_means_closed => return Err("TCP scale closed the connection".to_owned()),
            Ok(0) => thread::sleep(Duration::from_millis(5)),
            Ok(count) => {
                let frames = decoder.push(&read_buffer[..count]);
                if process_frames(inner, app, protocol, generation, &mut filter, frames) {
                    last_valid = Instant::now();
                    if !first_valid_logged {
                        log_scale(
                            app,
                            "INFO",
                            &format!("scale first valid frame: protocol={}", protocol.id),
                        );
                        first_valid_logged = true;
                    }
                }
            }
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock
                ) =>
            {
                let frames = decoder.flush_idle();
                if process_frames(inner, app, protocol, generation, &mut filter, frames) {
                    last_valid = Instant::now();
                    if !first_valid_logged {
                        log_scale(
                            app,
                            "INFO",
                            &format!("scale first valid frame: protocol={}", protocol.id),
                        );
                        first_valid_logged = true;
                    }
                }
            }
            Err(error) => return Err(format!("scale read: {error}")),
        }
        if status_of(inner) == ScaleStatus::Connected && last_valid.elapsed() > WATCHDOG_TIMEOUT {
            set_status(inner, app, generation, ScaleStatus::Connecting);
        }
    }
    Ok(())
}

fn process_frames(
    inner: &Arc<ScaleInner>,
    app: &AppHandle,
    protocol: &Protocol,
    generation: u64,
    filter: &mut ReadingFilter,
    frames: Vec<Vec<u8>>,
) -> bool {
    let mut parsed = false;
    for frame in frames {
        inner.stats.received_frames.fetch_add(1, Ordering::AcqRel);
        if let Some(reading) = parse_protocol(protocol, &frame) {
            parsed = true;
            set_status(inner, app, generation, ScaleStatus::Connected);
            if let Some(reading) = filter.filter(reading) {
                emit_reading(inner, app, generation, reading);
            } else {
                inner.stats.dropped_readings.fetch_add(1, Ordering::AcqRel);
            }
        }
    }
    parsed
}

fn run_simulator(
    inner: &Arc<ScaleInner>,
    app: &AppHandle,
    config: &ScaleConfig,
    generation: u64,
    stop: &Arc<AtomicBool>,
) {
    let interval = Duration::from_millis(config.polling_interval.max(700));
    let seed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos() as u64)
        .unwrap_or(1);
    let mut random = Lcg::new(seed);
    let mut filter = ReadingFilter::new(config.stability_count);
    set_status(inner, app, generation, ScaleStatus::Connected);
    while active(inner, generation, stop) {
        let zero = random.next_f64() > 0.8;
        let weight = if zero {
            0.0
        } else {
            0.5 + random.next_f64() * 5.0
        };
        let reading = ScaleReading {
            weight: (weight * 1000.0).round() / 1000.0,
            unit: "kg",
            stable: random.next_f64() > 0.2,
            tare: None,
        };
        inner.stats.received_frames.fetch_add(1, Ordering::AcqRel);
        if let Some(reading) = filter.filter(reading) {
            emit_reading(inner, app, generation, reading);
        } else {
            inner.stats.dropped_readings.fetch_add(1, Ordering::AcqRel);
        }
        if wait_interruptible(stop, interval) {
            break;
        }
    }
}

struct Lcg(u64);
impl Lcg {
    fn new(seed: u64) -> Self {
        Self(seed.max(1))
    }
    fn next_f64(&mut self) -> f64 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1);
        (self.0 >> 11) as f64 / (1_u64 << 53) as f64
    }
}

fn resolve_address(host: &str, port: u16) -> Result<SocketAddr, String> {
    (host, port)
        .to_socket_addrs()
        .map_err(|error| format!("failed to resolve TCP scale {host}:{port}: {error}"))?
        .next()
        .ok_or_else(|| format!("TCP scale address {host}:{port} resolved to no endpoints"))
}

fn active(inner: &Arc<ScaleInner>, generation: u64, stop: &AtomicBool) -> bool {
    !stop.load(Ordering::Acquire) && inner.generation.load(Ordering::Acquire) == generation
}

fn wait_interruptible(stop: &AtomicBool, duration: Duration) -> bool {
    let deadline = Instant::now() + duration;
    while Instant::now() < deadline {
        if stop.load(Ordering::Acquire) {
            return true;
        }
        thread::sleep(
            Duration::from_millis(25).min(deadline.saturating_duration_since(Instant::now())),
        );
    }
    stop.load(Ordering::Acquire)
}

fn status_of(inner: &Arc<ScaleInner>) -> ScaleStatus {
    inner
        .runtime
        .lock()
        .map(|runtime| runtime.status)
        .unwrap_or(ScaleStatus::Disconnected)
}

fn set_status(inner: &Arc<ScaleInner>, app: &AppHandle, generation: u64, status: ScaleStatus) {
    if inner.generation.load(Ordering::Acquire) != generation {
        return;
    }
    let changed = inner
        .runtime
        .lock()
        .map(|mut runtime| {
            if runtime.status == status {
                false
            } else {
                runtime.status = status;
                true
            }
        })
        .unwrap_or(false);
    if changed {
        let _ = app.emit("scale-status", status.as_str());
    }
}

fn emit_reading(inner: &Arc<ScaleInner>, app: &AppHandle, generation: u64, reading: ScaleReading) {
    if inner.generation.load(Ordering::Acquire) != generation {
        return;
    }
    inner.stats.emitted_readings.fetch_add(1, Ordering::AcqRel);
    let _ = app.emit("scale-reading", reading);
}

fn emit_error(inner: &Arc<ScaleInner>, app: &AppHandle, generation: u64, message: &str) {
    if inner.generation.load(Ordering::Acquire) == generation {
        let _ = app.emit("scale-error", message);
    }
}

fn map_scale_error(config: &ScaleConfig, error: &str) -> String {
    if config.connection_type != "serial" {
        return error.to_owned();
    }
    let lower = error.to_ascii_lowercase();
    let path = config.path.as_deref().unwrap_or_default();
    if lower.contains("access denied")
        || lower.contains("permission denied")
        || lower.contains("in use")
    {
        format!("serial_access_denied|{path}")
    } else if lower.contains("not found")
        || lower.contains("no such file")
        || lower.contains("cannot find")
    {
        format!("serial_not_found|{path}")
    } else {
        error.to_owned()
    }
}

fn log_scale(app: &AppHandle, level: &str, message: &str) {
    let _ = app.state::<RuntimeState>().log(level, message);
    telemetry::record_subsystem_log(app, "scale", level, message);
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;
    use std::collections::HashSet;
    use std::net::{TcpListener, TcpStream};

    #[derive(Deserialize)]
    struct FixtureRoot {
        protocols: Vec<Fixture>,
    }

    #[derive(Deserialize)]
    struct Fixture {
        id: String,
        encoding: String,
        data: String,
        expected: Option<ExpectedReading>,
    }

    #[derive(Deserialize)]
    struct ExpectedReading {
        weight: f64,
        unit: String,
        stable: bool,
    }

    fn fixture() -> FixtureRoot {
        serde_json::from_str(include_str!("../../tests/fixtures/scale-protocols.json"))
            .expect("scale protocol fixture")
    }

    fn hex(input: &str) -> Vec<u8> {
        assert_eq!(input.len() % 2, 0);
        (0..input.len())
            .step_by(2)
            .map(|index| u8::from_str_radix(&input[index..index + 2], 16).unwrap())
            .collect()
    }

    #[test]
    fn replays_every_shared_protocol_fixture() {
        let fixture = fixture();
        assert_eq!(fixture.protocols.len(), PROTOCOLS.len());
        for item in fixture.protocols {
            let protocol = protocol_by_id(&item.id);
            assert_eq!(protocol.id, item.id, "fixture selected generic fallback");
            let data = if item.encoding == "hex" {
                hex(&item.data)
            } else {
                item.data.into_bytes()
            };
            let actual = parse_protocol(protocol, &data);
            match (actual, item.expected) {
                (None, None) => {}
                (Some(actual), Some(expected)) => {
                    assert!(
                        (actual.weight - expected.weight).abs() < 1e-9,
                        "{} weight",
                        item.id
                    );
                    assert_eq!(actual.unit, expected.unit, "{} unit", item.id);
                    assert_eq!(actual.stable, expected.stable, "{} stable", item.id);
                }
                _ => panic!("{} reading presence mismatch", item.id),
            }
        }
    }

    #[test]
    fn catalog_contains_twenty_unique_current_protocols() {
        let ids: HashSet<&str> = PROTOCOLS.iter().map(|protocol| protocol.id).collect();
        assert_eq!(ids.len(), 20);
        assert_eq!(protocol_catalog().len(), 20);
        assert_eq!(protocol_by_id("missing").id, "generic");
        assert!(!protocol_by_id("massak_cont").polling_required);
        assert!(protocol_by_id("massak_100").polling_required);
    }

    #[test]
    fn line_decoder_reassembles_partial_and_coalesced_frames() {
        let mut decoder = FrameDecoder::new(Framing::Lines);
        assert!(decoder.push(b"ST,+001").is_empty());
        let frames = decoder.push(b"23.45 g\r\nUS,+00001.00 kg\n");
        assert_eq!(frames.len(), 2);
        assert_eq!(text(&frames[0]), "ST,+00123.45 g");
        assert_eq!(text(&frames[1]), "US,+00001.00 kg");

        assert!(decoder.push(b"net 7.875 kg").is_empty());
        assert_eq!(decoder.flush_now(), vec![b"net 7.875 kg".to_vec()]);
    }

    #[test]
    fn binary_decoders_reassemble_packets_and_discard_prefix_noise() {
        let mut decoder = FrameDecoder::new(Framing::Massa100);
        assert!(decoder.push(&hex("0011f855ce07")).is_empty());
        let frames = decoder.push(&hex("0010d204000000010000"));
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0], hex("f855ce070010d204000000010000"));

        let mut decoder = FrameDecoder::new(Framing::MassaJ);
        assert!(decoder.push(&hex("8000")).is_empty());
        let frames = decoder.push(&hex("d007008000e80300"));
        assert_eq!(frames.len(), 2);
        assert_eq!(parse_massa_j(&frames[0]).unwrap().weight, 2.0);
        assert_eq!(parse_massa_j(&frames[1]).unwrap().weight, 1.0);
    }

    #[test]
    fn stability_transition_bypasses_weight_throttle() {
        let mut filter = ReadingFilter::new(4);
        let reading = |weight| ScaleReading {
            weight,
            unit: "kg",
            stable: false,
            tare: None,
        };
        assert!(filter.filter(reading(1.000)).is_some());
        assert!(filter.filter(reading(1.001)).is_none());
        assert!(filter.filter(reading(1.002)).is_none());
        let stable = filter
            .filter(reading(1.003))
            .expect("stable transition must emit");
        assert!(stable.stable);
        assert!(stable.weight > 1.0);
    }

    #[test]
    fn reconnect_backoff_is_bounded_and_resettable() {
        let mut backoff = ReconnectBackoff::new();
        assert_eq!(backoff.take(), Duration::from_millis(250));
        assert_eq!(backoff.take(), Duration::from_millis(500));
        assert_eq!(backoff.take(), Duration::from_secs(1));
        assert_eq!(backoff.take(), Duration::from_secs(2));
        assert_eq!(backoff.take(), Duration::from_secs(2));
        backoff.reset();
        assert_eq!(backoff.take(), Duration::from_millis(250));
    }

    #[test]
    fn validates_and_bounds_runtime_configuration() {
        let config = ScaleConfig::from_value(serde_json::json!({
            "type": "tcp",
            "protocolId": "and_standard",
            "host": "127.0.0.1",
            "port": 9000,
            "pollingInterval": 1,
            "stabilityCount": 100
        }))
        .unwrap();
        assert_eq!(config.polling_interval, 50);
        assert_eq!(config.stability_count, 32);
        assert!(ScaleConfig::from_value(serde_json::json!({
            "type": "serial", "protocolId": "generic", "path": ""
        }))
        .unwrap_err()
        .contains("path"));
    }

    #[test]
    fn maps_serial_errors_to_existing_renderer_codes() {
        let config = ScaleConfig {
            connection_type: "serial".to_owned(),
            protocol_id: "generic".to_owned(),
            path: Some("COM9".to_owned()),
            baud_rate: None,
            host: None,
            port: None,
            polling_interval: 250,
            stability_count: 4,
        };
        assert_eq!(
            map_scale_error(&config, "Access denied"),
            "serial_access_denied|COM9"
        );
        assert_eq!(
            map_scale_error(&config, "File not found"),
            "serial_not_found|COM9"
        );
    }

    #[test]
    fn polling_commands_match_current_device_contracts() {
        assert_eq!(
            protocol_by_id("and_standard").weight_command().unwrap(),
            b"Q\r\n"
        );
        assert_eq!(protocol_by_id("massak_j").weight_command().unwrap(), b"J");
        assert_eq!(
            protocol_by_id("dibal_delta").weight_command().unwrap(),
            [0x44, 0x0D, 0x0A]
        );
        let command = protocol_by_id("massak_100").weight_command().unwrap();
        assert_eq!(&command[..6], &[0xF8, 0x55, 0xCE, 0x01, 0x00, 0xA0]);
        assert_eq!(
            u16::from_le_bytes([command[6], command[7]]),
            crc16(&[0x01, 0x00, 0xA0])
        );
    }

    #[test]
    fn tcp_loopback_reassembles_fragmented_frame_and_observes_disconnect() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback scale");
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut socket, _) = listener.accept().expect("accept scale client");
            let mut command = [0_u8; 3];
            socket.read_exact(&mut command).expect("read poll command");
            assert_eq!(&command, b"Q\r\n");
            socket.write_all(b"ST,+001").unwrap();
            thread::sleep(Duration::from_millis(10));
            socket.write_all(b"23.45 g\r\n").unwrap();
        });

        let mut client = TcpStream::connect(address).expect("connect loopback scale");
        client
            .set_read_timeout(Some(Duration::from_secs(1)))
            .unwrap();
        client.write_all(b"Q\r\n").unwrap();
        let mut decoder = FrameDecoder::new(Framing::Lines);
        let mut parsed = None;
        let mut buffer = [0_u8; 8];
        loop {
            match client.read(&mut buffer) {
                Ok(0) => break,
                Ok(count) => {
                    for frame in decoder.push(&buffer[..count]) {
                        parsed = parse_protocol(protocol_by_id("and_standard"), &frame);
                    }
                }
                Err(error) => panic!("loopback read failed: {error}"),
            }
        }
        server.join().unwrap();
        let reading = parsed.expect("fragmented frame parsed before disconnect");
        assert_eq!(reading.weight, 0.12345);
        assert_eq!(reading.unit, "kg");
        assert!(reading.stable);
    }

    #[test]
    fn decoder_soak_keeps_buffer_bounded() {
        let mut decoder = FrameDecoder::new(Framing::Lines);
        let mut parsed = 0_u64;
        for _ in 0..20_000 {
            let frames = decoder.push(b"ST,+00123.45 g\r\n");
            assert_eq!(frames.len(), 1);
            parsed += parse_protocol(protocol_by_id("and_standard"), &frames[0]).is_some() as u64;
            assert!(decoder.buffer.len() <= MAX_FRAME_BUFFER);
        }
        assert_eq!(parsed, 20_000);
        assert!(decoder.buffer.is_empty());
    }
}
