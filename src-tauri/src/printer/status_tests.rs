use super::*;

const READY: &[u8] = b"\x02030,0,0,0250,000,0,0,0,000,0,0,0\x03\r\n\x02001,0,0,0,0,2,0,0,00000000,1,000\x03\r\n\x021234,0\x03\r\n";
const HEAD_OPEN: &[u8] = b"\x02030,0,0,0250,000,0,0,0,000,0,0,0\x03\r\n\x02001,0,1,0,0,2,0,0,00000000,1,000\x03\r\n\x021234,0\x03\r\n";

#[test]
fn p1_zpl_partial_status_never_becomes_ready() {
    let first_end = READY.iter().position(|byte| *byte == 3).unwrap() + 1;
    assert!(!response_complete("zpl", &READY[..first_end]));
    assert_eq!(
        parse_protocol_response("zpl", READY[..first_end].to_vec()).status,
        "unknown"
    );
    let second_end = READY
        .iter()
        .enumerate()
        .filter(|(_, byte)| **byte == 3)
        .nth(1)
        .unwrap()
        .0
        + 1;
    assert!(!response_complete("zpl", &READY[..second_end]));
    assert_eq!(
        parse_protocol_response("image", READY[..second_end].to_vec()).status,
        "unknown"
    );
    assert!(response_complete("zpl", READY));
    assert_eq!(
        parse_protocol_response("zpl", READY.to_vec()).status,
        "ready"
    );
}

#[test]
fn p1_zpl_no_response_or_unknown_text_is_not_readiness() {
    for bytes in [
        b"".as_slice(),
        b"garbage",
        b"0,0,0\n0,0,0\n0,0\n",
        b"READY",
        b"\x03\x03\x03",
    ] {
        let status = parse_protocol_response("zpl", bytes.to_vec());
        assert!(status.reachable);
        assert_eq!(status.status, "unknown", "{bytes:?}");
    }
}

#[test]
fn p1_zpl_buffer_full_blocks_readiness() {
    let full = String::from_utf8(READY.to_vec())
        .unwrap()
        .replacen("0250,000,0", "0250,000,1", 1);
    let status = parse_protocol_response("zpl", full.into_bytes());
    assert_eq!(status.status, "buffer-full");
    assert!(status
        .details
        .iter()
        .any(|detail| detail == "receive buffer full"));
}

#[test]
fn p1_zpl_malformed_flags_and_missing_final_frame_are_unknown() {
    for bytes in [
        String::from_utf8(READY.to_vec())
            .unwrap()
            .replacen("030,0,0", "030,invalid,0", 1),
        String::from_utf8(READY.to_vec())
            .unwrap()
            .replace("\x021234,0\x03\r\n", "\x021234\x03\r\n"),
        String::from_utf8(READY.to_vec())
            .unwrap()
            .replace("030,0,0", "030,2,0"),
    ] {
        assert_eq!(
            parse_protocol_response("zpl", bytes.into_bytes()).status,
            "unknown"
        );
    }
    assert_eq!(
        parse_protocol_response("zpl", HEAD_OPEN.to_vec()).status,
        "head-open"
    );
}

use std::collections::VecDeque;

struct TestStream {
    fragments: VecDeque<Vec<u8>>,
    written: Vec<u8>,
    timeouts: Vec<Duration>,
    delay: Duration,
    read_error: Option<io::ErrorKind>,
    timeout_error: bool,
    write_error: bool,
}

impl TestStream {
    fn new(fragments: impl IntoIterator<Item = Vec<u8>>) -> Self {
        Self {
            fragments: fragments.into_iter().collect(),
            written: Vec::new(),
            timeouts: Vec::new(),
            delay: Duration::ZERO,
            read_error: None,
            timeout_error: false,
            write_error: false,
        }
    }
}
impl Read for TestStream {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if let Some(kind) = self.read_error.take() {
            return Err(io::Error::from(kind));
        }
        if !self.delay.is_zero() {
            let timeout = self.timeouts.last().copied().unwrap();
            std::thread::sleep(self.delay.min(timeout));
            if self.delay >= timeout {
                return Err(io::Error::from(io::ErrorKind::TimedOut));
            }
        }
        let Some(front) = self.fragments.front_mut() else {
            return Err(io::Error::from(io::ErrorKind::TimedOut));
        };
        let count = front.len().min(buffer.len());
        buffer[..count].copy_from_slice(&front[..count]);
        front.drain(..count);
        if front.is_empty() {
            self.fragments.pop_front();
        }
        Ok(count)
    }
}
impl Write for TestStream {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if self.write_error {
            return Err(io::Error::from(io::ErrorKind::BrokenPipe));
        }
        self.written.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
impl StatusStream for TestStream {
    fn set_status_read_timeout(&mut self, timeout: Duration) -> io::Result<()> {
        if self.timeout_error {
            return Err(io::Error::from(io::ErrorKind::InvalidInput));
        }
        self.timeouts.push(timeout);
        Ok(())
    }
}
fn config(protocol: &str) -> PrinterDeviceConfig {
    PrinterDeviceConfig::from_value(serde_json::json!({
        "id":"status-regression", "protocol":protocol, "connection":"tcp",
        "ip":"127.0.0.1", "port":9100,
    }))
    .unwrap()
}

#[test]
fn p1_status_reader_handles_each_byte_and_interrupted_reads() {
    let mut stream = TestStream::new(HEAD_OPEN.iter().map(|byte| vec![*byte]));
    stream.read_error = Some(io::ErrorKind::Interrupted);
    let report = query_stream_report(&config("zpl"), &mut stream).unwrap();
    assert_eq!(stream.written, b"~HS\r\n");
    assert_eq!(report.status, "head-open");
    assert!(report.supports_bidirectional_status);
    assert_eq!(report.response_bytes, HEAD_OPEN.len() - 2);
    assert!(stream.timeouts.windows(2).all(|pair| pair[1] <= pair[0]));
}

#[test]
fn p1_status_reader_keeps_partial_data_on_timeout_and_limits_bytes() {
    let first = READY.iter().position(|byte| *byte == 3).unwrap() + 1;
    let mut stream = TestStream::new([READY[..first].to_vec()]);
    let report = query_stream_report(&config("image"), &mut stream).unwrap();
    assert_eq!(report.status, "unknown");
    assert_eq!(report.response_bytes, first);
    assert!(!report.supports_bidirectional_status);
    let mut stream = TestStream::new([vec![b'x'; MAX_STATUS_RESPONSE_BYTES * 2]]);
    let report = query_stream_report(&config("zpl"), &mut stream).unwrap();
    assert_eq!(report.status, "unknown");
    assert_eq!(report.response_bytes, MAX_STATUS_RESPONSE_BYTES);
    assert_eq!(
        report.response_preview.unwrap().len(),
        MAX_STATUS_PREVIEW_BYTES
    );
}

#[test]
fn p1_status_reader_has_one_deadline_for_slow_fragments() {
    let mut stream = TestStream::new(READY.iter().map(|byte| vec![*byte]));
    stream.delay = Duration::from_millis(15);
    let started = Instant::now();
    let response =
        read_bounded_response_until(&mut stream, "zpl", started + Duration::from_millis(60))
            .unwrap();
    assert!(response.len() < READY.len());
    assert!(started.elapsed() < Duration::from_secs(1));
    assert!(stream.timeouts.windows(2).all(|pair| pair[1] < pair[0]));
    assert_eq!(parse_protocol_response("zpl", response).status, "unknown");
    let mut stream = TestStream::new([READY.to_vec()]);
    assert!(
        read_bounded_response_until(&mut stream, "zpl", Instant::now())
            .unwrap()
            .is_empty()
    );
    assert!(stream.timeouts.is_empty());
}

#[test]
fn p1_status_io_failures_are_reported_and_no_reply_is_unknown() {
    let mut stream = TestStream::new([]);
    let report = query_stream_report(&config("zpl"), &mut stream).unwrap();
    assert!(report.reachable);
    assert_eq!(report.status, "unknown");
    assert_eq!(report.response_bytes, 0);
    assert!(!report.supports_bidirectional_status);
    for (write_error, timeout_error, read_error, context) in [
        (true, false, None, "command write"),
        (false, true, None, "remaining read timeout"),
        (
            false,
            false,
            Some(io::ErrorKind::ConnectionReset),
            "response read",
        ),
    ] {
        let mut stream = TestStream::new([]);
        stream.write_error = write_error;
        stream.timeout_error = timeout_error;
        stream.read_error = read_error;
        let error = query_stream_report(&config("zpl"), &mut stream).unwrap_err();
        assert!(error.message.contains(context), "{}", error.message);
    }
    let mut stream = TestStream::new([]);
    let report = query_stream_report(&config("epl"), &mut stream).unwrap();
    assert_eq!(report.status, "reachable");
    assert!(stream.written.is_empty());
    assert!(stream.timeouts.is_empty());
}

#[test]
fn p1_zpl_all_truncations_and_invalid_framing_keep_readiness_unknown() {
    let final_etx = READY.iter().rposition(|byte| *byte == 3).unwrap();
    for length in 0..=final_etx {
        assert_eq!(
            parse_protocol_response("zpl", READY[..length].to_vec()).status,
            "unknown",
            "prefix {length}"
        );
    }
    let mut invalid_utf8 = READY.to_vec();
    invalid_utf8.push(0xff);
    assert_eq!(
        parse_protocol_response("zpl", invalid_utf8).status,
        "unknown"
    );
    for suffix in [b"EXTRA".as_slice(), b"\x020,0\x03", b"\0"] {
        let mut bytes = READY.to_vec();
        bytes.extend_from_slice(suffix);
        assert_eq!(parse_protocol_response("zpl", bytes).status, "unknown");
    }
    let mut nested = READY.to_vec();
    nested.insert(2, 2);
    assert_eq!(parse_protocol_response("zpl", nested).status, "unknown");
    assert_eq!(
        parse_protocol_response("zpl", b"HEAD OPEN".to_vec()).status,
        "head-open"
    );
    assert_eq!(
        parse_protocol_response("zpl", b"PRINTING".to_vec()).status,
        "unknown"
    );
}

#[test]
fn p1_zpl_fault_flags_and_documented_print_modes() {
    fn changed(frame: usize, index: usize, value: &str) -> Vec<u8> {
        let frames = zpl_frames(READY).unwrap();
        frames
            .iter()
            .enumerate()
            .map(|(number, body)| {
                let mut fields = body.split(',').collect::<Vec<_>>();
                if number == frame {
                    fields[index] = value;
                }
                format!("\x02{}\x03\r\n", fields.join(","))
            })
            .collect::<String>()
            .into_bytes()
    }
    for (frame, field, expected) in [
        (0, 1, "paper-out"),
        (0, 2, "paused"),
        (0, 5, "buffer-full"),
        (0, 6, "error"),
        (0, 7, "busy"),
        (0, 9, "error"),
        (0, 10, "error"),
        (0, 11, "error"),
        (1, 2, "head-open"),
        (1, 3, "ribbon-out"),
        (1, 7, "busy"),
        (0, 4, "printing"),
        (1, 8, "printing"),
    ] {
        assert_eq!(
            parse_protocol_response("zpl", changed(frame, field, "1")).status,
            expected,
            "frame {frame} field {field}"
        );
    }
    for mode in ["2", "K", "S", "A"] {
        assert_eq!(
            parse_protocol_response("zpl", changed(1, 5, mode)).status,
            "ready"
        );
    }
    for mode in ["?", "ready", "", "2A"] {
        assert_eq!(
            parse_protocol_response("zpl", changed(1, 5, mode)).status,
            "unknown"
        );
    }
}

#[test]
fn p1_tcp_three_separate_frames_report_the_hardware_fault() {
    use std::net::TcpListener;
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let mut command = [0_u8; 5];
        stream.read_exact(&mut command).unwrap();
        assert_eq!(&command, b"~HS\r\n");
        for frame in HEAD_OPEN.split_inclusive(|byte| *byte == b'\n') {
            stream.write_all(frame).unwrap();
            std::thread::sleep(Duration::from_millis(15));
        }
    });
    let mut config = config("zpl");
    config.port = Some(u64::from(port));
    let result = query(&config);
    server.join().unwrap();
    let report = result.unwrap();
    assert_eq!(report.status, "head-open");
    assert!(report.supports_bidirectional_status);
}
