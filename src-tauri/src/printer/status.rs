use super::{resolve_address, spooler, PrinterDeviceConfig, TransportFailure};
use serde::{Deserialize, Serialize};
use serialport::{DataBits, FlowControl, Parity, StopBits};
use std::io::{self, Read, Write};
use std::net::TcpStream;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const STATUS_CONNECT_TIMEOUT: Duration = Duration::from_millis(1_500);
pub(super) const STATUS_IO_TIMEOUT: Duration = Duration::from_millis(700);
const MAX_STATUS_RESPONSE_BYTES: usize = 4 * 1024;
const MAX_STATUS_PREVIEW_BYTES: usize = 256;

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
    pub response_bytes: usize,
    pub response_preview: Option<String>,
    pub raw_response_hex: Option<String>,
    pub queried_at_ms: u64,
}

pub(super) fn query(config: &PrinterDeviceConfig) -> Result<PrinterStatusReport, String> {
    let observation = match config.connection.as_str() {
        "tcp" => query_tcp(config),
        "serial" => query_serial(config),
        "windows_driver" => query_spooler(config),
        other => Err(TransportFailure {
            message: format!("unsupported printer connection: {other}"),
            timed_out: false,
        }),
    }
    .map_err(|error| error.message)?;
    Ok(report(config, observation))
}

struct StatusObservation {
    reachable: bool,
    status: &'static str,
    details: Vec<String>,
    supports_bidirectional_status: bool,
    response: Vec<u8>,
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
    let mut port = serialport::new(path, config.baud_rate())
        .timeout(STATUS_IO_TIMEOUT)
        .data_bits(DataBits::Eight)
        .parity(Parity::None)
        .stop_bits(StopBits::One)
        .flow_control(FlowControl::None)
        .open()
        .map_err(|error| TransportFailure {
            message: format!(
                "serial printer status open {path}@{}: {error}",
                config.baud_rate()
            ),
            timed_out: false,
        })?;
    query_stream(config, &mut port)
}

fn query_stream<T: Read + Write>(
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
        });
    };
    stream
        .write_all(command)
        .and_then(|_| stream.flush())
        .map_err(|error| transport_error("printer status command write", error))?;
    let response = read_bounded_response(stream, &config.protocol)?;
    Ok(parse_protocol_response(&config.protocol, response))
}

/// Runs the protocol status handshake on an already-open stream (the print
/// worker's held serial port) and builds the full report.
pub(super) fn query_stream_report<T: Read + Write>(
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

fn read_bounded_response<T: Read>(
    stream: &mut T,
    protocol: &str,
) -> Result<Vec<u8>, TransportFailure> {
    let mut response = Vec::with_capacity(512);
    let mut buffer = [0_u8; 512];
    loop {
        let remaining = MAX_STATUS_RESPONSE_BYTES.saturating_sub(response.len());
        if remaining == 0 {
            break;
        }
        let read_limit = buffer.len().min(remaining);
        match stream.read(&mut buffer[..read_limit]) {
            Ok(0) => break,
            Ok(read) => {
                response.extend_from_slice(&buffer[..read]);
                if response_complete(protocol, &response) {
                    break;
                }
            }
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock
                ) =>
            {
                break;
            }
            Err(error) => return Err(transport_error("printer status response read", error)),
        }
    }
    Ok(response)
}

fn response_complete(protocol: &str, response: &[u8]) -> bool {
    match protocol {
        "tspl" => !response.is_empty(),
        "zpl" | "image" => {
            response.contains(&0x03)
                || response.iter().filter(|value| **value == b'\n').count() >= 3
        }
        _ => true,
    }
}

fn parse_protocol_response(protocol: &str, response: Vec<u8>) -> StatusObservation {
    if response.is_empty() {
        return StatusObservation {
            reachable: true,
            status: "reachable",
            details: vec!["status command sent; no response arrived before timeout".to_owned()],
            supports_bidirectional_status: false,
            response,
        };
    }
    match protocol {
        "tspl" => parse_tspl_response(response),
        "zpl" | "image" => parse_zpl_response(response),
        _ => parse_text_response(response),
    }
}

fn parse_zpl_response(response: Vec<u8>) -> StatusObservation {
    let text = String::from_utf8_lossy(&response);
    let frames = text
        .split('\u{2}')
        .filter_map(|part| part.split('\u{3}').next())
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();
    if frames.len() < 2 {
        return parse_text_response(response);
    }
    let first = frames[0].split(',').map(str::trim).collect::<Vec<_>>();
    let second = frames[1].split(',').map(str::trim).collect::<Vec<_>>();
    if first.len() < 12 || second.len() < 4 {
        return parse_text_response(response);
    }

    let mut details = Vec::new();
    let flags = [
        (first[1] == "1", "paper out"),
        (first[2] == "1", "paused"),
        (first[5] == "1", "receive buffer full"),
        (first[9] == "1", "corrupt RAM"),
        (first[10] == "1", "under temperature"),
        (first[11] == "1", "over temperature"),
        (second[2] == "1", "head open"),
        (second[3] == "1", "ribbon out"),
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
    } else if first[9] == "1" || first[10] == "1" || first[11] == "1" {
        "error"
    } else {
        "ready"
    };
    StatusObservation {
        reachable: true,
        status,
        details,
        supports_bidirectional_status: true,
        response,
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
        ("PRINTING", "printing"),
        ("ERROR", "error"),
    ];
    let status = candidates
        .iter()
        .find_map(|(token, status)| text.contains(token).then_some(*status))
        .unwrap_or("ready");
    let details = if status == "ready" {
        vec!["printer returned a bounded status response".to_owned()]
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
        supports_bidirectional_status: true,
        response,
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
        response_bytes: observation.response.len(),
        response_preview: preview,
        raw_response_hex,
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
    TransportFailure {
        message: format!("{context}: {error}"),
        timed_out: matches!(
            error.kind(),
            io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock
        ),
    }
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
            stream.write_all(b"\x02030,1,0,0250,000,0,0,0,000,0,0,0\x03\r\n\x02001,0,1,0,0,2,0,0,00000000,1,000\x03\r\n\x021234,0\x03\r\n").unwrap();
        });
        let report = query(&tcp_config(port, "zpl")).unwrap();
        server.join().unwrap();
        assert!(report.reachable);
        assert_eq!(report.status, "head-open");
        assert!(report.supports_bidirectional_status);
        assert!(report.response_bytes <= MAX_STATUS_RESPONSE_BYTES);
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
