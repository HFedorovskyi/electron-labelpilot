use super::{resolve_address, spooler, PrinterDeviceConfig, TransportFailure};
use serde::{Deserialize, Serialize};
use std::io::{self, Read, Write};
use std::net::TcpStream;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const STATUS_CONNECT_TIMEOUT: Duration = Duration::from_millis(1_500);
pub(super) const STATUS_IO_TIMEOUT: Duration = Duration::from_millis(700);
const MAX_STATUS_RESPONSE_BYTES: usize = 4 * 1024;
const MAX_STATUS_PREVIEW_BYTES: usize = 256;

/// Each read gets the remaining deadline, rather than another full I/O timeout.
/// This also applies to the worker's already-open serial port.
pub(super) trait StatusStream: Read + Write {
    fn set_status_read_timeout(&mut self, timeout: Duration) -> io::Result<()>;
}

impl StatusStream for TcpStream {
    fn set_status_read_timeout(&mut self, timeout: Duration) -> io::Result<()> {
        self.set_read_timeout(Some(timeout))
    }
}

impl StatusStream for Box<dyn serialport::SerialPort> {
    fn set_status_read_timeout(&mut self, timeout: Duration) -> io::Result<()> {
        self.set_timeout(timeout).map_err(io::Error::other)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrinterStatusReport {
    pub printer_id: String,
    pub printer_name: String,
    pub physical_key: String,
    pub protocol: String,
    pub connection: String,
    pub reachable: bool,
    pub status: String,
    pub details: Vec<String>,
    pub supports_bidirectional_status: bool,
    pub queued_formats: Option<u32>,
    pub response_bytes: usize,
    pub response_preview: Option<String>,
    pub raw_response_hex: Option<String>,
    pub manufacturer: Option<String>,
    pub model: Option<String>,
    pub firmware: Option<String>,
    pub link_os_version: Option<String>,
    pub detected_dpi: Option<u16>,
    pub supports_utf8_text: bool,
    pub supports_z64: bool,
    pub capability_evidence: Vec<String>,
    pub queried_at_ms: u64,
}

pub(super) fn query(config: &PrinterDeviceConfig) -> Result<PrinterStatusReport, String> {
    let observation = match config.connection.as_str() {
        "tcp" => query_tcp(config),
        "serial" => query_serial(config),
        "windows_driver" => query_spooler(config),
        other => Err(TransportFailure::not_started(
            format!("unsupported printer connection: {other}"),
            false,
        )),
    }
    .map_err(|error| error.message)?;
    Ok(report(config, observation))
}

#[derive(Default)]
struct StatusObservation {
    reachable: bool,
    status: &'static str,
    details: Vec<String>,
    supports_bidirectional_status: bool,
    queued_formats: Option<u32>,
    response: Vec<u8>,
    manufacturer: Option<String>,
    model: Option<String>,
    firmware: Option<String>,
    link_os_version: Option<String>,
    detected_dpi: Option<u16>,
    supports_utf8_text: bool,
    supports_z64: bool,
    capability_evidence: Vec<String>,
}

fn query_tcp(config: &PrinterDeviceConfig) -> Result<StatusObservation, TransportFailure> {
    let address = resolve_address(config)?;
    let mut stream =
        TcpStream::connect_timeout(&address, STATUS_CONNECT_TIMEOUT).map_err(|error| {
            transport_error(&format!("TCP printer status connect {address}"), error)
        })?;
    stream
        .set_read_timeout(Some(STATUS_IO_TIMEOUT))
        .map_err(|error| transport_error("TCP printer status read timeout", error))?;
    stream
        .set_write_timeout(Some(STATUS_IO_TIMEOUT))
        .map_err(|error| transport_error("TCP printer status write timeout", error))?;
    stream
        .set_nodelay(true)
        .map_err(|error| transport_error("TCP printer status TCP_NODELAY", error))?;
    query_stream(config, &mut stream)
}

fn query_serial(config: &PrinterDeviceConfig) -> Result<StatusObservation, TransportFailure> {
    let path = config.serial_port.as_deref().unwrap_or_default();
    let mut port = super::serial::open_configured(config, STATUS_IO_TIMEOUT).map_err(|error| {
        TransportFailure::not_started(
            format!(
                "serial printer status open {path}@{}: {error}",
                config.baud_rate()
            ),
            false,
        )
    })?;
    query_stream(config, &mut port)
}

fn query_stream<T: StatusStream>(
    config: &PrinterDeviceConfig,
    stream: &mut T,
) -> Result<StatusObservation, TransportFailure> {
    let Some(command) = status_command(&config.protocol) else {
        return Ok(StatusObservation {
            reachable: true,
            status: "reachable",
            details: vec![format!(
                "{} transport is reachable; {} has no generic status command",
                config.connection, config.protocol
            )],
            supports_bidirectional_status: false,
            response: Vec::new(),
            ..StatusObservation::default()
        });
    };
    stream
        .write_all(command)
        .and_then(|_| stream.flush())
        .map_err(|error| transport_error("printer status command write", error))?;
    let response = read_bounded_response(stream, &config.protocol)?;
    let mut observation = parse_protocol_response(&config.protocol, response);
    if config.capability_probe && matches!(config.protocol.as_str(), "zpl" | "image") {
        enrich_zpl_capabilities(stream, &mut observation);
    }
    Ok(observation)
}

/// Runs the protocol status handshake on an already-open stream (the print
/// worker's held serial port) and builds the full report.
pub(super) fn query_stream_report<T: StatusStream>(
    config: &PrinterDeviceConfig,
    stream: &mut T,
) -> Result<PrinterStatusReport, TransportFailure> {
    query_stream(config, stream).map(|observation| report(config, observation))
}

fn status_command(protocol: &str) -> Option<&'static [u8]> {
    match protocol {
        "zpl" | "image" => Some(b"~HS\r\n"),
        "tspl" => Some(b"\x1b!?"),
        "epl" | "cpcl" | "dpl" | "sbpl" => None,
        _ => None,
    }
}

fn read_bounded_response<T: StatusStream>(
    stream: &mut T,
    protocol: &str,
) -> Result<Vec<u8>, TransportFailure> {
    read_bounded_response_until(stream, protocol, Instant::now() + STATUS_IO_TIMEOUT)
}

fn read_bounded_response_until<T: StatusStream>(
    stream: &mut T,
    protocol: &str,
    deadline: Instant,
) -> Result<Vec<u8>, TransportFailure> {
    let mut response = Vec::with_capacity(512);
    let mut buffer = [0_u8; 512];
    loop {
        let remaining = MAX_STATUS_RESPONSE_BYTES.saturating_sub(response.len());
        let remaining_time = deadline.saturating_duration_since(Instant::now());
        if remaining == 0 || remaining_time.is_zero() {
            break;
        }
        stream
            .set_status_read_timeout(remaining_time)
            .map_err(|error| transport_error("printer status remaining read timeout", error))?;
        let read_limit = buffer.len().min(remaining);
        match stream.read(&mut buffer[..read_limit]) {
            Ok(0) => break,
            Ok(read) => {
                response.extend_from_slice(&buffer[..read]);
                if response_complete(protocol, &response) {
                    break;
                }
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock
                ) =>
            {
                break
            }
            Err(error) => return Err(transport_error("printer status response read", error)),
        }
    }
    Ok(response)
}

fn enrich_zpl_capabilities<T: StatusStream>(stream: &mut T, observation: &mut StatusObservation) {
    if let Ok(response) = query_capability_value(stream, b"~HI\r\n") {
        if let Some((model, firmware, dpi)) = parse_host_identification(&response) {
            observation.model = Some(model.clone());
            observation.firmware = Some(firmware.clone());
            observation.detected_dpi = dpi;
            observation
                .capability_evidence
                .push("zpl-host-identification".to_owned());
            if is_zebra_model(&model) {
                observation.manufacturer = Some("Zebra Technologies".to_owned());
                observation
                    .details
                    .push(format!("Zebra {model}, firmware {firmware}"));
                if supports_zpl_unicode_firmware(&firmware) {
                    observation.supports_utf8_text = true;
                    observation.supports_z64 = true;
                    observation
                        .capability_evidence
                        .push("zebra-firmware-unicode".to_owned());
                    observation.details.push(format!(
                        "Zebra firmware {firmware}: ^CI28/Z64 capability detected"
                    ));
                }
            } else {
                observation.details.push(format!(
                    "ZPL-compatible device {model}, firmware {firmware}; conservative profile retained"
                ));
                observation
                    .capability_evidence
                    .push("zpl-compatible-emulator".to_owned());
            }
        }
    }
    if observation.manufacturer.is_some() {
        if let Ok(response) =
            query_capability_value(stream, b"! U1 getvar \"appl.link_os_version\"\r\n")
        {
            if let Some(version) = parse_link_os_version(&response) {
                observation.link_os_version = Some(version.clone());
                observation.supports_utf8_text = true;
                observation.supports_z64 = true;
                observation
                    .details
                    .push(format!("Link-OS {version}: UTF-8/Z64 capability detected"));
                observation
                    .capability_evidence
                    .push("sgd-appl.link_os_version".to_owned());
            }
        }
    }
}

fn is_zebra_model(model: &str) -> bool {
    let model = model.trim().to_ascii_uppercase();
    model.contains("ZEBRA")
        || [
            "ZD", "ZT", "ZQ", "ZE", "ZR", "GK", "GX", "GC", "GT", "QL", "RW", "P4T", "S4M", "ZM",
            "XI", "105SL", "110XI", "140XI", "170XI", "220XI", "LP ", "TLP ",
        ]
        .iter()
        .any(|prefix| model.starts_with(prefix))
}

/// Zebra documents ^CI28 support from V50.14.x/V60.14.x onward. Later
/// firmware families inherit it; older or nonstandard version strings stay safe.
fn supports_zpl_unicode_firmware(firmware: &str) -> bool {
    let version = firmware
        .trim()
        .trim_start_matches(|character: char| !character.is_ascii_digit());
    let mut parts = version.split('.');
    let Some(major) = parts.next().and_then(|value| value.parse::<u16>().ok()) else {
        return false;
    };
    let minor = parts
        .next()
        .and_then(|value| {
            value
                .chars()
                .take_while(|character| character.is_ascii_digit())
                .collect::<String>()
                .parse::<u16>()
                .ok()
        })
        .unwrap_or(0);
    major > 60 || matches!(major, 50 | 60) && minor >= 14
}

fn query_capability_value<T: StatusStream>(
    stream: &mut T,
    command: &[u8],
) -> Result<Vec<u8>, TransportFailure> {
    stream
        .write_all(command)
        .and_then(|_| stream.flush())
        .map_err(|error| transport_error("printer capability command write", error))?;
    let deadline = Instant::now() + STATUS_IO_TIMEOUT;
    let mut response = Vec::with_capacity(128);
    let mut buffer = [0_u8; 256];
    loop {
        let remaining = 1024_usize.saturating_sub(response.len());
        let remaining_time = deadline.saturating_duration_since(Instant::now());
        if remaining == 0 || remaining_time.is_zero() {
            break;
        }
        stream
            .set_status_read_timeout(remaining_time)
            .map_err(|error| transport_error("printer capability read timeout", error))?;
        let read_limit = buffer.len().min(remaining);
        match stream.read(&mut buffer[..read_limit]) {
            Ok(0) => break,
            Ok(read) => {
                response.extend_from_slice(&buffer[..read]);
                if response.contains(&b'\n') {
                    break;
                }
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock
                ) =>
            {
                break
            }
            Err(error) => return Err(transport_error("printer capability response read", error)),
        }
    }
    Ok(response)
}

fn parse_host_identification(response: &[u8]) -> Option<(String, String, Option<u16>)> {
    let text = String::from_utf8_lossy(response);
    let fields = text
        .trim_matches(|character: char| character.is_ascii_whitespace() || character.is_control())
        .split(',')
        .map(str::trim)
        .collect::<Vec<_>>();
    if fields.len() < 4
        || fields[0].is_empty()
        || fields[1].is_empty()
        || fields[0].len() > 64
        || fields[1].len() > 64
    {
        return None;
    }
    let dots_per_mm = fields[2]
        .trim_end_matches(|character: char| character.is_ascii_alphabetic())
        .parse::<u16>()
        .ok();
    let dpi = match dots_per_mm {
        Some(8) => Some(203),
        Some(12) => Some(300),
        Some(24) => Some(600),
        _ => None,
    };
    Some((fields[0].to_owned(), fields[1].to_owned(), dpi))
}

fn parse_link_os_version(response: &[u8]) -> Option<String> {
    let value = String::from_utf8_lossy(response)
        .trim_matches(|character: char| {
            character.is_ascii_whitespace() || character.is_control() || character == '"'
        })
        .to_owned();
    (!value.is_empty()
        && value.len() <= 32
        && value.bytes().any(|byte| byte.is_ascii_digit())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
        && !value.eq_ignore_ascii_case("unknown"))
    .then_some(value)
}

fn response_complete(protocol: &str, response: &[u8]) -> bool {
    match protocol {
        "tspl" => !response.is_empty(),
        "zpl" | "image" => zpl_frames(response).is_some(),
        _ => true,
    }
}

/// A host-status reply is three STX/ETX records. A newline or a single ETX
/// cannot finish it. Only whitespace may separate or follow the records.
fn zpl_frames(response: &[u8]) -> Option<[&str; 3]> {
    let mut remaining = std::str::from_utf8(response).ok()?;
    let mut frames = [""; 3];
    for frame in &mut frames {
        remaining = remaining.trim_start_matches(|ch: char| ch.is_ascii_whitespace());
        remaining = remaining.strip_prefix('\u{2}')?;
        let (body, tail) = remaining.split_once('\u{3}')?;
        if body.is_empty() || body.contains('\u{2}') {
            return None;
        }
        *frame = body;
        remaining = tail;
    }
    remaining
        .trim_matches(|ch: char| ch.is_ascii_whitespace())
        .is_empty()
        .then_some(frames)
}

fn unknown_status(response: Vec<u8>, reason: &str) -> StatusObservation {
    StatusObservation {
        reachable: true,
        status: "unknown",
        details: vec![reason.to_owned()],
        supports_bidirectional_status: false,
        response,
        ..StatusObservation::default()
    }
}

fn parse_protocol_response(protocol: &str, response: Vec<u8>) -> StatusObservation {
    if response.is_empty() {
        return unknown_status(
            response,
            "status command sent; readiness is unknown because no response arrived",
        );
    }
    match protocol {
        "tspl" => parse_tspl_response(response),
        "zpl" | "image" => parse_zpl_response(response),
        _ => parse_text_response(response),
    }
}

fn parse_zpl_response(response: Vec<u8>) -> StatusObservation {
    let Some(frames) = zpl_frames(&response) else {
        if response.iter().any(|byte| matches!(byte, 0x02 | 0x03)) {
            return unknown_status(response, "incomplete or malformed ZPL host-status frames");
        }
        return parse_text_response(response);
    };
    let first = frames[0].split(',').map(str::trim).collect::<Vec<_>>();
    let second = frames[1].split(',').map(str::trim).collect::<Vec<_>>();
    let third = frames[2].split(',').map(str::trim).collect::<Vec<_>>();
    let number = |value: &&str| {
        !value.is_empty() && value.len() <= 10 && value.bytes().all(|byte| byte.is_ascii_digit())
    };
    let flag = |value: &str| matches!(value, "0" | "1");
    if first.len() != 12
        || second.len() != 11
        || third.len() != 2
        || !first.iter().all(number)
        || !second.iter().enumerate().all(|(index, value)| {
            number(value)
                || (index == 5 && value.len() == 1 && value.as_bytes()[0].is_ascii_uppercase())
        })
        || !third.iter().all(number)
        || ![1, 2, 5, 6, 7, 9, 10, 11]
            .iter()
            .all(|index| flag(first[*index]))
        || ![2, 3, 4, 7, 9].iter().all(|index| flag(second[*index]))
        || !flag(third[1])
    {
        return unknown_status(response, "invalid ZPL host-status fields");
    }
    let mut details = Vec::new();
    let flags = [
        (first[1] == "1", "paper out"),
        (first[2] == "1", "paused"),
        (first[5] == "1", "receive buffer full"),
        (first[6] == "1", "communications diagnostic mode"),
        (first[7] == "1", "partial format in progress"),
        (first[9] == "1", "corrupt RAM"),
        (first[10] == "1", "under temperature"),
        (first[11] == "1", "over temperature"),
        (second[2] == "1", "head open"),
        (second[3] == "1", "ribbon out"),
        (second[7] == "1", "label waiting to be removed"),
    ];
    for (active, detail) in flags {
        if active {
            details.push(detail.to_owned());
        }
    }
    let status = if second[2] == "1" {
        "head-open"
    } else if first[1] == "1" {
        "paper-out"
    } else if second[3] == "1" {
        "ribbon-out"
    } else if first[2] == "1" {
        "paused"
    } else if first[6] == "1" || first[9] == "1" || first[10] == "1" || first[11] == "1" {
        "error"
    } else if first[5] == "1" {
        "buffer-full"
    } else if first[7] == "1" || second[7] == "1" {
        "busy"
    } else if first[4].bytes().any(|byte| byte != b'0')
        || second[8].bytes().any(|byte| byte != b'0')
    {
        "printing"
    } else {
        "ready"
    };
    if details.is_empty() {
        details.push(format!(
            "complete ZPL host-status response reports {status}"
        ));
    }
    StatusObservation {
        reachable: true,
        status,
        details,
        supports_bidirectional_status: true,
        queued_formats: first[4].parse().ok(),
        response,
        ..StatusObservation::default()
    }
}

fn parse_tspl_response(response: Vec<u8>) -> StatusObservation {
    let status_byte = response[0];
    let mut details = Vec::new();
    let mut status = "ready";
    let flags = [
        (0x01, "head open", "head-open"),
        (0x02, "paper jam", "paper-jam"),
        (0x04, "paper out", "paper-out"),
        (0x08, "ribbon out", "ribbon-out"),
        (0x10, "paused", "paused"),
        (0x20, "printing", "printing"),
        (0x40, "other printer error", "error"),
    ];
    for (mask, detail, candidate) in flags {
        if status_byte & mask != 0 {
            details.push(detail.to_owned());
            if status == "ready" || candidate != "printing" {
                status = candidate;
            }
        }
    }
    if details.is_empty() {
        details.push("TSC real-time status reports ready".to_owned());
    }
    StatusObservation {
        reachable: true,
        status,
        details,
        supports_bidirectional_status: true,
        response,
        ..StatusObservation::default()
    }
}

fn parse_text_response(response: Vec<u8>) -> StatusObservation {
    let text = String::from_utf8_lossy(&response).to_ascii_uppercase();
    let candidates = [
        ("HEAD OPEN", "head-open"),
        ("PAPER JAM", "paper-jam"),
        ("PAPER OUT", "paper-out"),
        ("RIBBON OUT", "ribbon-out"),
        ("PAUSED", "paused"),
        ("ERROR", "error"),
    ];
    let status = candidates
        .iter()
        .find_map(|(token, status)| text.contains(token).then_some(*status))
        .unwrap_or("unknown");
    let details = if status == "unknown" {
        vec!["unrecognized status response; readiness is unknown".to_owned()]
    } else {
        vec![format!(
            "printer response contains {}",
            status.replace('-', " ")
        )]
    };
    StatusObservation {
        reachable: true,
        status,
        details,
        supports_bidirectional_status: status != "unknown",
        response,
        ..StatusObservation::default()
    }
}

fn query_spooler(config: &PrinterDeviceConfig) -> Result<StatusObservation, TransportFailure> {
    let (name, flags) = spooler::query_status(config)?;
    let (status, mut details) = spooler_status(flags);
    if details.is_empty() {
        details.push(format!("Windows print queue {name} is ready"));
    }
    // Label-roll GDI prints the raster 1:1, so a driver DPI other than the
    // template DPI changes the physical label size.
    if let Ok((driver_dpi_x, _)) = spooler::driver_dpi(config) {
        if driver_dpi_x > 0 {
            details.push(format!("Windows driver DPI: {driver_dpi_x}"));
        }
    }
    Ok(StatusObservation {
        reachable: true,
        status,
        details,
        supports_bidirectional_status: true,
        response: flags.to_le_bytes().to_vec(),
        ..StatusObservation::default()
    })
}

fn spooler_status(flags: u32) -> (&'static str, Vec<String>) {
    const PAUSED: u32 = 0x0000_0001;
    const ERROR: u32 = 0x0000_0002;
    const PAPER_JAM: u32 = 0x0000_0008;
    const PAPER_OUT: u32 = 0x0000_0010;
    const OFFLINE: u32 = 0x0000_0080;
    const BUSY: u32 = 0x0000_0200;
    const PRINTING: u32 = 0x0000_0400;
    const USER_INTERVENTION: u32 = 0x0010_0000;
    const DOOR_OPEN: u32 = 0x0040_0000;
    let definitions = [
        (OFFLINE, "offline"),
        (DOOR_OPEN, "door open"),
        (PAPER_JAM, "paper jam"),
        (PAPER_OUT, "paper out"),
        (PAUSED, "paused"),
        (ERROR, "spooler error"),
        (USER_INTERVENTION, "user intervention required"),
        (PRINTING, "printing"),
        (BUSY, "busy"),
    ];
    let details = definitions
        .iter()
        .filter_map(|(mask, text)| (flags & mask != 0).then_some((*text).to_owned()))
        .collect::<Vec<_>>();
    let status = if flags & OFFLINE != 0 {
        "offline"
    } else if flags & DOOR_OPEN != 0 {
        "head-open"
    } else if flags & PAPER_JAM != 0 {
        "paper-jam"
    } else if flags & PAPER_OUT != 0 {
        "paper-out"
    } else if flags & PAUSED != 0 {
        "paused"
    } else if flags & (ERROR | USER_INTERVENTION) != 0 {
        "error"
    } else if flags & (PRINTING | BUSY) != 0 {
        "printing"
    } else {
        "ready"
    };
    (status, details)
}

fn report(config: &PrinterDeviceConfig, observation: StatusObservation) -> PrinterStatusReport {
    let preview = response_preview(&observation.response);
    let raw_response_hex = (!observation.response.is_empty()).then(|| {
        observation
            .response
            .iter()
            .take(128)
            .map(|byte| format!("{byte:02X}"))
            .collect::<Vec<_>>()
            .join(" ")
    });
    PrinterStatusReport {
        printer_id: config.id.clone(),
        printer_name: config.display_name().to_owned(),
        physical_key: config.physical_key(),
        protocol: config.protocol.clone(),
        connection: config.connection.clone(),
        reachable: observation.reachable,
        status: observation.status.to_owned(),
        details: observation.details,
        supports_bidirectional_status: observation.supports_bidirectional_status,
        queued_formats: observation.queued_formats,
        response_bytes: observation.response.len(),
        response_preview: preview,
        raw_response_hex,
        manufacturer: observation.manufacturer,
        model: observation.model,
        firmware: observation.firmware,
        link_os_version: observation.link_os_version,
        detected_dpi: observation.detected_dpi,
        supports_utf8_text: observation.supports_utf8_text,
        supports_z64: observation.supports_z64,
        capability_evidence: observation.capability_evidence,
        queried_at_ms: unix_ms(),
    }
}

fn response_preview(response: &[u8]) -> Option<String> {
    if response.is_empty() {
        return None;
    }
    Some(
        response
            .iter()
            .take(MAX_STATUS_PREVIEW_BYTES)
            .map(|byte| match byte {
                0x20..=0x7e => char::from(*byte),
                b'\r' => '↵',
                b'\n' => '⏎',
                _ => '·',
            })
            .collect(),
    )
}

fn transport_error(context: &str, error: io::Error) -> TransportFailure {
    let timed_out = matches!(
        error.kind(),
        io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock
    );
    TransportFailure::not_started(format!("{context}: {error}"), timed_out)
}

fn unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::thread;

    fn tcp_config(port: u16, protocol: &str) -> PrinterDeviceConfig {
        PrinterDeviceConfig::from_value(serde_json::json!({
            "id": "status-test",
            "name": "Status test",
            "connection": "tcp",
            "protocol": protocol,
            "ip": "127.0.0.1",
            "port": port,
        }))
        .unwrap()
    }

    #[test]
    fn zpl_query_is_bounded_and_parses_named_fault() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut command = [0_u8; 16];
            let read = stream.read(&mut command).unwrap();
            assert_eq!(&command[..read], b"~HS\r\n");
            stream.write_all(b"\x02030,1,0,0250,007,0,0,0,000,0,0,0\x03\r\n\x02001,0,1,0,0,2,0,0,00000000,1,000\x03\r\n\x021234,0\x03\r\n").unwrap();
        });
        let report = query(&tcp_config(port, "zpl")).unwrap();
        server.join().unwrap();
        assert!(report.reachable);
        assert_eq!(report.status, "head-open");
        assert_eq!(report.queued_formats, Some(7));
        assert!(report.supports_bidirectional_status);
        assert!(report.response_bytes <= MAX_STATUS_RESPONSE_BYTES);
    }

    #[test]
    fn capability_probe_identifies_link_os_zebra_and_dpi() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut status_command = [0_u8; 5];
            stream.read_exact(&mut status_command).unwrap();
            assert_eq!(&status_command, b"~HS\r\n");
            stream.write_all(b"\x02030,0,0,0250,000,0,0,0,000,0,0,0\x03\r\n\x02001,0,0,0,0,2,0,0,00000000,0,000\x03\r\n\x021234,0\x03\r\n").unwrap();

            let mut identity_command = [0_u8; 5];
            stream.read_exact(&mut identity_command).unwrap();
            assert_eq!(&identity_command, b"~HI\r\n");
            stream
                .write_all(b"ZD421-203dpi ZPL,V99.20.17Z,8,65536KB,\r\n")
                .unwrap();

            let command = b"! U1 getvar \"appl.link_os_version\"\r\n";
            let mut link_os_command = vec![0_u8; command.len()];
            stream.read_exact(&mut link_os_command).unwrap();
            assert_eq!(link_os_command, command);
            stream.write_all(b"\"6.8.1\"\r\n").unwrap();
        });
        let mut config = tcp_config(port, "zpl");
        config.capability_probe = true;
        let report = query(&config).unwrap();
        server.join().unwrap();
        assert_eq!(report.manufacturer.as_deref(), Some("Zebra Technologies"));
        assert_eq!(report.model.as_deref(), Some("ZD421-203dpi ZPL"));
        assert_eq!(report.firmware.as_deref(), Some("V99.20.17Z"));
        assert_eq!(report.link_os_version.as_deref(), Some("6.8.1"));
        assert_eq!(report.detected_dpi, Some(203));
        assert!(report.supports_utf8_text);
        assert!(report.supports_z64);
        assert!(parse_link_os_version(b"unknown SGD 123").is_none());
        assert!(parse_link_os_version(b"?").is_none());
    }

    #[test]
    fn zebra_firmware_detection_is_conservative_for_zpl_emulators() {
        assert!(is_zebra_model("ZD421-203dpi ZPL"));
        assert!(is_zebra_model("Zebra ZT411"));
        assert!(!is_zebra_model("Xprinter XP-420B"));
        assert!(!is_zebra_model("Godex G500"));
        assert!(supports_zpl_unicode_firmware("V50.14.3Z"));
        assert!(supports_zpl_unicode_firmware("V60.14.0Z"));
        assert!(supports_zpl_unicode_firmware("V99.20.17Z"));
        assert!(!supports_zpl_unicode_firmware("V50.13.9Z"));
        assert!(!supports_zpl_unicode_firmware("V60.13.9Z"));
        assert!(!supports_zpl_unicode_firmware("1.2.3"));
    }

    #[test]
    fn tspl_realtime_byte_reports_paper_out() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut command = [0_u8; 3];
            stream.read_exact(&mut command).unwrap();
            assert_eq!(command, [0x1b, b'!', b'?']);
            stream.write_all(&[0x04]).unwrap();
        });
        let report = query(&tcp_config(port, "tspl")).unwrap();
        server.join().unwrap();
        assert_eq!(report.status, "paper-out");
        assert_eq!(report.raw_response_hex.as_deref(), Some("04"));
    }

    #[test]
    fn unsupported_language_uses_connect_only_probe() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = thread::spawn(move || {
            let (_stream, _) = listener.accept().unwrap();
        });
        let report = query(&tcp_config(port, "epl")).unwrap();
        server.join().unwrap();
        assert_eq!(report.status, "reachable");
        assert!(!report.supports_bidirectional_status);
        assert_eq!(report.response_bytes, 0);
    }

    #[test]
    fn windows_spooler_flags_have_deterministic_priority() {
        let (status, details) = spooler_status(0x10 | 0x400);
        assert_eq!(status, "paper-out");
        assert_eq!(details, vec!["paper out", "printing"]);
    }
}

#[cfg(test)]
#[path = "status_tests.rs"]
mod regression_tests;
