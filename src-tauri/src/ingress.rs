use crate::crypto::decode_push_body;
#[cfg(feature = "desktop")]
use crate::network::NetworkState;
use crate::persisted::PersistedState;
use crate::processor::{export_full_snapshot, process_print_job, process_sync};
use crate::runtime_events::RuntimeEventSink;
use serde::Serialize;
use serde_json::{json, Value};
use std::io::{self, Read, Write};
use std::net::{IpAddr, SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;
#[cfg(feature = "desktop")]
use tauri::{AppHandle, Manager};

const INGRESS_ADDRESS: &str = "0.0.0.0:5556";
const WAKE_ADDRESS: &str = "127.0.0.1:5556";
const MAX_HEADER_BYTES: usize = 16 * 1024;
const MAX_BODY_SYNC: usize = 64 * 1024 * 1024;
const MAX_BODY_PRINT_JOB: usize = 1024 * 1024;
const MAX_REJECT_DRAIN_BYTES: usize = 2 * 1024 * 1024;
const REJECT_DRAIN_TIMEOUT: Duration = Duration::from_secs(2);
const HEADER_TIMEOUT: Duration = Duration::from_secs(30);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
const ACCEPT_POLL: Duration = Duration::from_millis(20);

#[derive(Debug)]
struct HttpRequest {
    method: String,
    path: String,
    body: Vec<u8>,
}

#[derive(Debug)]
struct HttpResponse {
    status: u16,
    content_type: Option<&'static str>,
    body: Vec<u8>,
}

impl HttpResponse {
    fn json(status: u16, value: Value) -> Self {
        Self {
            status,
            content_type: Some("application/json"),
            body: serde_json::to_vec(&value)
                .unwrap_or_else(|_| b"{\"error\":\"Serialization error\"}".to_vec()),
        }
    }

    fn text(status: u16, value: &str) -> Self {
        Self {
            status,
            content_type: None,
            body: value.as_bytes().to_vec(),
        }
    }

    fn empty(status: u16) -> Self {
        Self {
            status,
            content_type: None,
            body: Vec::new(),
        }
    }
}

#[derive(Debug)]
enum ReadRequestError {
    Io(String),
    HeaderTooLarge,
    Malformed(String),
    PayloadTooLarge,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IngressSummary {
    bind_address: &'static str,
    worker_running: bool,
    header_timeout_ms: u64,
    request_timeout_ms: u64,
    sync_body_limit: usize,
    print_job_body_limit: usize,
    accepted_requests: u64,
    completed_requests: u64,
    rejected_requests: u64,
}

struct IngressInner {
    stop: AtomicBool,
    worker: Mutex<Option<JoinHandle<()>>>,
    accepted: AtomicU64,
    completed: AtomicU64,
    rejected: AtomicU64,
}

#[derive(Clone)]
struct IngressRuntime {
    persisted: Arc<PersistedState>,
    events: RuntimeEventSink,
    client_version: String,
    request_check: Arc<dyn Fn() + Send + Sync + 'static>,
}

pub struct IngressState {
    inner: Arc<IngressInner>,
}

impl IngressState {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(IngressInner {
                stop: AtomicBool::new(false),
                worker: Mutex::new(None),
                accepted: AtomicU64::new(0),
                completed: AtomicU64::new(0),
                rejected: AtomicU64::new(0),
            }),
        }
    }

    #[cfg(feature = "desktop")]
    pub fn start(&self, app: AppHandle) -> Result<(), String> {
        let data_dir = app.state::<PersistedState>().data_dir().to_path_buf();
        let client_version = app.package_info().version.to_string();
        let request_app = app.clone();
        self.start_with_sink(
            Arc::new(PersistedState::for_data_dir(data_dir)),
            RuntimeEventSink::tauri(app),
            client_version,
            move || request_app.state::<NetworkState>().request_check(),
        )
    }

    pub(crate) fn start_with_sink<F>(
        &self,
        persisted: Arc<PersistedState>,
        events: RuntimeEventSink,
        client_version: String,
        request_check: F,
    ) -> Result<(), String>
    where
        F: Fn() + Send + Sync + 'static,
    {
        self.start_runtime(IngressRuntime {
            persisted,
            events,
            client_version,
            request_check: Arc::new(request_check),
        })
    }

    fn start_runtime(&self, runtime: IngressRuntime) -> Result<(), String> {
        let mut worker = self
            .inner
            .worker
            .lock()
            .map_err(|_| "ingress worker lock is poisoned".to_owned())?;
        if worker.is_some() {
            return Ok(());
        }

        let listener = TcpListener::bind(INGRESS_ADDRESS)
            .map_err(|error| format!("failed to bind sync ingress {INGRESS_ADDRESS}: {error}"))?;
        listener
            .set_nonblocking(true)
            .map_err(|error| format!("failed to configure sync ingress: {error}"))?;

        self.inner.stop.store(false, Ordering::Release);
        let inner = Arc::clone(&self.inner);
        *worker = Some(
            thread::Builder::new()
                .name("labelpilot-ingress".to_owned())
                .spawn(move || run_ingress(listener, inner, runtime))
                .map_err(|error| format!("failed to start sync ingress worker: {error}"))?,
        );
        Ok(())
    }

    pub fn stop(&self) {
        self.inner.stop.store(true, Ordering::Release);
        let _ = TcpStream::connect_timeout(
            &WAKE_ADDRESS.parse().expect("fixed wake address"),
            Duration::from_millis(100),
        );
        if let Ok(mut worker) = self.inner.worker.lock() {
            if let Some(handle) = worker.take() {
                let _ = handle.join();
            }
        }
    }

    pub fn summary(&self) -> IngressSummary {
        IngressSummary {
            bind_address: INGRESS_ADDRESS,
            worker_running: self
                .inner
                .worker
                .lock()
                .map(|worker| worker.as_ref().is_some_and(|handle| !handle.is_finished()))
                .unwrap_or(false),
            header_timeout_ms: HEADER_TIMEOUT.as_millis() as u64,
            request_timeout_ms: REQUEST_TIMEOUT.as_millis() as u64,
            sync_body_limit: MAX_BODY_SYNC,
            print_job_body_limit: MAX_BODY_PRINT_JOB,
            accepted_requests: self.inner.accepted.load(Ordering::Acquire),
            completed_requests: self.inner.completed.load(Ordering::Acquire),
            rejected_requests: self.inner.rejected.load(Ordering::Acquire),
        }
    }
}

impl Drop for IngressState {
    fn drop(&mut self) {
        self.stop();
    }
}

fn run_ingress(listener: TcpListener, inner: Arc<IngressInner>, runtime: IngressRuntime) {
    log(
        &runtime,
        "INFO",
        &format!("sync ingress listening on {INGRESS_ADDRESS}"),
    );
    while !inner.stop.load(Ordering::Acquire) {
        match listener.accept() {
            Ok((mut stream, peer)) => {
                if inner.stop.load(Ordering::Acquire) {
                    break;
                }
                if let Err(error) = stream.set_nonblocking(false) {
                    inner.rejected.fetch_add(1, Ordering::AcqRel);
                    log(
                        &runtime,
                        "ERROR",
                        &format!("failed to make accepted ingress socket blocking: {error}"),
                    );
                    continue;
                }
                inner.accepted.fetch_add(1, Ordering::AcqRel);
                let status = serve_connection(&mut stream, peer, &runtime);
                if status >= 400 {
                    inner.rejected.fetch_add(1, Ordering::AcqRel);
                }
                inner.completed.fetch_add(1, Ordering::AcqRel);
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                thread::sleep(ACCEPT_POLL);
            }
            Err(error) => {
                log(
                    &runtime,
                    "ERROR",
                    &format!("sync ingress accept failed: {error}"),
                );
                thread::sleep(Duration::from_millis(100));
            }
        }
    }
    log(&runtime, "INFO", "sync ingress stopped");
}

fn serve_connection(stream: &mut TcpStream, peer: SocketAddr, runtime: &IngressRuntime) -> u16 {
    let response = match read_request(stream) {
        Ok(request) => route_request(runtime, peer.ip(), request),
        Err(ReadRequestError::PayloadTooLarge) => {
            HttpResponse::json(413, json!({"error": "Payload too large"}))
        }
        Err(ReadRequestError::HeaderTooLarge) => {
            HttpResponse::json(431, json!({"error": "Request header too large"}))
        }
        Err(ReadRequestError::Malformed(message)) => {
            HttpResponse::json(400, json!({"error": message}))
        }
        Err(ReadRequestError::Io(message)) => {
            log(
                runtime,
                "WARN",
                &format!("sync ingress read failed: {message}"),
            );
            HttpResponse::json(400, json!({"error": "Invalid request"}))
        }
    };
    let status = response.status;
    if let Err(error) = write_response(stream, &response) {
        log(
            runtime,
            "WARN",
            &format!("sync ingress response failed: {error}"),
        );
    }
    status
}

fn read_request(stream: &mut TcpStream) -> Result<HttpRequest, ReadRequestError> {
    stream
        .set_read_timeout(Some(HEADER_TIMEOUT))
        .map_err(|error| ReadRequestError::Io(error.to_string()))?;
    stream
        .set_write_timeout(Some(REQUEST_TIMEOUT))
        .map_err(|error| ReadRequestError::Io(error.to_string()))?;

    let mut received = Vec::with_capacity(4096);
    let mut chunk = [0_u8; 4096];
    let header_end = loop {
        let count = stream
            .read(&mut chunk)
            .map_err(|error| ReadRequestError::Io(error.to_string()))?;
        if count == 0 {
            return Err(ReadRequestError::Malformed(
                "Connection closed before request headers".to_owned(),
            ));
        }
        received.extend_from_slice(&chunk[..count]);
        if let Some(position) = find_header_end(&received) {
            if position > MAX_HEADER_BYTES {
                return Err(ReadRequestError::HeaderTooLarge);
            }
            break position + 4;
        }
        if received.len() > MAX_HEADER_BYTES {
            return Err(ReadRequestError::HeaderTooLarge);
        }
    };

    let header = std::str::from_utf8(&received[..header_end - 4])
        .map_err(|_| ReadRequestError::Malformed("Request headers must be UTF-8".to_owned()))?;
    let mut lines = header.split("\r\n");
    let request_line = lines
        .next()
        .ok_or_else(|| ReadRequestError::Malformed("Missing request line".to_owned()))?;
    let mut parts = request_line.split_whitespace();
    let method = parts
        .next()
        .ok_or_else(|| ReadRequestError::Malformed("Missing HTTP method".to_owned()))?;
    let path = parts
        .next()
        .ok_or_else(|| ReadRequestError::Malformed("Missing request path".to_owned()))?;
    let version = parts
        .next()
        .ok_or_else(|| ReadRequestError::Malformed("Missing HTTP version".to_owned()))?;
    if parts.next().is_some() || !version.starts_with("HTTP/1.") {
        return Err(ReadRequestError::Malformed(
            "Malformed request line".to_owned(),
        ));
    }

    let mut content_length = 0_usize;
    let mut has_content_length = false;
    for line in lines {
        let (name, value) = line
            .split_once(':')
            .ok_or_else(|| ReadRequestError::Malformed("Malformed request header".to_owned()))?;
        if name.eq_ignore_ascii_case("content-length") {
            if has_content_length {
                return Err(ReadRequestError::Malformed(
                    "Duplicate Content-Length".to_owned(),
                ));
            }
            content_length = value
                .trim()
                .parse()
                .map_err(|_| ReadRequestError::Malformed("Invalid Content-Length".to_owned()))?;
            has_content_length = true;
        }
        if name.eq_ignore_ascii_case("transfer-encoding")
            && !value.trim().eq_ignore_ascii_case("identity")
        {
            return Err(ReadRequestError::Malformed(
                "Transfer-Encoding is not supported".to_owned(),
            ));
        }
    }

    let normalized = normalize_path(path);
    let content_length = match body_limit(method, normalized) {
        Some(limit) if content_length > limit => {
            let already_received = received
                .len()
                .saturating_sub(header_end)
                .min(content_length);
            drain_rejected_body(stream, already_received, content_length);
            return Err(ReadRequestError::PayloadTooLarge);
        }
        Some(_) => content_length,
        None => 0,
    };

    stream
        .set_read_timeout(Some(REQUEST_TIMEOUT))
        .map_err(|error| ReadRequestError::Io(error.to_string()))?;
    let available = received.len().saturating_sub(header_end);
    let mut body = Vec::with_capacity(content_length);
    body.extend_from_slice(&received[header_end..header_end + available.min(content_length)]);
    while body.len() < content_length {
        let remaining = content_length - body.len();
        let read_size = remaining.min(chunk.len());
        let count = stream
            .read(&mut chunk[..read_size])
            .map_err(|error| ReadRequestError::Io(error.to_string()))?;
        if count == 0 {
            return Err(ReadRequestError::Malformed(
                "Connection closed before request body".to_owned(),
            ));
        }
        body.extend_from_slice(&chunk[..count]);
    }

    Ok(HttpRequest {
        method: method.to_owned(),
        path: normalized.to_owned(),
        body,
    })
}

fn drain_rejected_body(stream: &mut TcpStream, already_received: usize, content_length: usize) {
    if content_length > MAX_REJECT_DRAIN_BYTES {
        return;
    }
    let _ = stream.set_read_timeout(Some(REJECT_DRAIN_TIMEOUT));
    let mut remaining = content_length.saturating_sub(already_received);
    let mut buffer = [0_u8; 8192];
    while remaining > 0 {
        let read_size = remaining.min(buffer.len());
        match stream.read(&mut buffer[..read_size]) {
            Ok(0) | Err(_) => break,
            Ok(count) => remaining -= count,
        }
    }
}

fn route_request(runtime: &IngressRuntime, peer: IpAddr, request: HttpRequest) -> HttpResponse {
    if request.method == "OPTIONS" {
        return HttpResponse::empty(200);
    }

    if request.method == "GET" && request.path == "/api/full_sync" {
        if !peer.is_loopback() {
            return HttpResponse::json(403, json!({"error": "Forbidden"}));
        }
        return match export_full_snapshot(runtime.persisted.as_ref()) {
            Ok(snapshot) => HttpResponse::json(200, snapshot),
            Err(error) => {
                log(
                    runtime,
                    "ERROR",
                    &format!("full snapshot export failed: {error}"),
                );
                HttpResponse::json(500, json!({"error": error}))
            }
        };
    }

    if request.method == "POST"
        && matches!(request.path.as_str(), "/api/sync_db" | "/api/full_sync")
    {
        return handle_sync(runtime, &request.body);
    }

    if request.method == "POST" && request.path == "/api/print_job" {
        return handle_print_job(runtime, &request.body);
    }

    HttpResponse::text(404, "Not Found")
}

fn handle_sync(runtime: &IngressRuntime, body: &[u8]) -> HttpResponse {
    let persisted = runtime.persisted.as_ref();
    let decoded = match decode_push_body(persisted, body) {
        Ok(decoded) => decoded,
        Err(error) if error.is_unauthorized() => {
            return HttpResponse::json(401, json!({"error": "Unauthorized"}));
        }
        Err(error) => {
            log(
                runtime,
                "WARN",
                &format!("sync body decode failed: {error}"),
            );
            return HttpResponse::json(500, json!({"error": error.to_string()}));
        }
    };

    let client_version = runtime.client_version.clone();
    let outcome = match process_sync(persisted, &client_version, &decoded.value) {
        Ok(outcome) => outcome,
        Err(error) => {
            log(runtime, "ERROR", &format!("sync import failed: {error}"));
            return HttpResponse::json(500, json!({"error": error}));
        }
    };
    if let Err(error) = decoded.persist_verified_token(persisted) {
        log(
            runtime,
            "ERROR",
            &format!("license token persistence failed: {error}"),
        );
        return HttpResponse::json(500, json!({"error": error}));
    }

    (runtime.request_check)();
    runtime
        .events
        .emit("printer-config-updated", outcome.printer_config.clone());
    runtime.events.emit(
        "sync-complete",
        json!({"success": true, "message": outcome.message}),
    );
    runtime.events.emit("data-updated", ());
    runtime.events.emit(
        "server-status-updated",
        json!({ "status": "connected", "source": "ingress" }),
    );
    log(
        runtime,
        "INFO",
        &format!(
            "{} sync completed: {} master rows",
            outcome.sync_type, outcome.imported_rows
        ),
    );
    HttpResponse::json(200, json!({"success": true, "message": "Sync completed"}))
}

fn handle_print_job(runtime: &IngressRuntime, body: &[u8]) -> HttpResponse {
    let persisted = runtime.persisted.as_ref();
    let decoded = match decode_push_body(persisted, body) {
        Ok(decoded) => decoded,
        Err(error) if error.is_unauthorized() => {
            return HttpResponse::json(401, json!({"error": "Unauthorized"}));
        }
        Err(error) => {
            log(
                runtime,
                "WARN",
                &format!("print job decode failed: {error}"),
            );
            return HttpResponse::json(400, json!({"error": error.to_string()}));
        }
    };

    let job = match process_print_job(persisted, &decoded.value) {
        Ok(job) => job,
        Err(error) => {
            log(runtime, "WARN", &format!("print job rejected: {error}"));
            return HttpResponse::json(400, json!({"error": error}));
        }
    };
    if let Err(error) = decoded.persist_verified_token(persisted) {
        log(
            runtime,
            "ERROR",
            &format!("license token persistence failed: {error}"),
        );
        return HttpResponse::json(400, json!({"error": error}));
    }

    let job_id = job.job_id;
    runtime.events.emit(
        "sync-complete",
        json!({"success": true, "type": "print_job", "job": job}),
    );
    runtime.events.emit("data-updated", ());
    runtime.events.emit("print-jobs-updated", ());
    log(runtime, "INFO", &format!("print job #{job_id} accepted"));
    HttpResponse::json(200, json!({"success": true, "job_id": job_id}))
}

fn write_response(stream: &mut TcpStream, response: &HttpResponse) -> Result<(), String> {
    let mut header = format!(
        "HTTP/1.1 {} {}\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\nAccess-Control-Allow-Headers: Content-Type\r\nConnection: close\r\nContent-Length: {}\r\n",
        response.status,
        status_reason(response.status),
        response.body.len()
    );
    if let Some(content_type) = response.content_type {
        header.push_str(&format!("Content-Type: {content_type}\r\n"));
    }
    header.push_str("\r\n");
    stream
        .write_all(header.as_bytes())
        .and_then(|_| stream.write_all(&response.body))
        .and_then(|_| stream.flush())
        .map_err(|error| error.to_string())
}

fn status_reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        413 => "Payload Too Large",
        431 => "Request Header Fields Too Large",
        500 => "Internal Server Error",
        _ => "Unknown",
    }
}

fn normalize_path(path: &str) -> &str {
    path.strip_suffix('/').unwrap_or(path)
}

fn body_limit(method: &str, path: &str) -> Option<usize> {
    match (method, path) {
        ("POST", "/api/sync_db" | "/api/full_sync") => Some(MAX_BODY_SYNC),
        ("POST", "/api/print_job") => Some(MAX_BODY_PRINT_JOB),
        _ => None,
    }
}

fn find_header_end(buffer: &[u8]) -> Option<usize> {
    buffer.windows(4).position(|window| window == b"\r\n\r\n")
}

fn log(runtime: &IngressRuntime, level: &str, message: &str) {
    runtime.events.log("ingress", level, message);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn route_limits_match_the_station_contract() {
        assert_eq!(body_limit("POST", "/api/sync_db"), Some(64 * 1024 * 1024));
        assert_eq!(body_limit("POST", "/api/full_sync"), Some(64 * 1024 * 1024));
        assert_eq!(body_limit("POST", "/api/print_job"), Some(1024 * 1024));
        assert_eq!(body_limit("GET", "/api/full_sync"), None);
    }

    #[test]
    fn normalizes_one_trailing_slash_and_detects_headers() {
        assert_eq!(normalize_path("/api/full_sync/"), "/api/full_sync");
        assert_eq!(normalize_path("/api/full_sync"), "/api/full_sync");
        assert_eq!(
            find_header_end(b"GET / HTTP/1.1\r\nHost: x\r\n\r\n"),
            Some(23)
        );
    }

    #[test]
    fn responses_are_connection_closed_and_cors_enabled() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let client = thread::spawn(move || {
            let mut stream = TcpStream::connect(address).unwrap();
            let mut bytes = Vec::new();
            stream.read_to_end(&mut bytes).unwrap();
            String::from_utf8(bytes).unwrap()
        });
        let (mut server, _) = listener.accept().unwrap();
        write_response(&mut server, &HttpResponse::json(413, json!({"error": "x"}))).unwrap();
        drop(server);
        let response = client.join().unwrap();
        assert!(response.starts_with("HTTP/1.1 413 Payload Too Large\r\n"));
        assert!(response.contains("Access-Control-Allow-Origin: *\r\n"));
        assert!(response.contains("Connection: close\r\n"));
    }

    #[cfg(feature = "native-ui")]
    #[test]
    fn committed_sync_and_print_job_emit_direct_native_events() {
        use crate::runtime_events::NativeRuntimeEvent;
        use std::sync::atomic::AtomicUsize;
        use std::time::{SystemTime, UNIX_EPOCH};

        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let data_dir = std::env::temp_dir().join(format!(
            "labelpilot-ingress-events-{}-{suffix}",
            std::process::id()
        ));
        std::fs::create_dir_all(&data_dir).unwrap();
        let persisted = Arc::new(PersistedState::for_data_dir(data_dir.clone()));
        let captured = Arc::new(Mutex::new(Vec::<NativeRuntimeEvent>::new()));
        let captured_events = Arc::clone(&captured);
        let checks = Arc::new(AtomicUsize::new(0));
        let request_checks = Arc::clone(&checks);
        let runtime = IngressRuntime {
            persisted: Arc::clone(&persisted),
            events: RuntimeEventSink::callback(move |event| {
                captured_events.lock().unwrap().push(event);
            }),
            client_version: "2.0.0".to_owned(),
            request_check: Arc::new(move || {
                request_checks.fetch_add(1, Ordering::AcqRel);
            }),
        };
        let sync = json!({
            "station": {
                "uuid": "event-station", "number": 7, "name": "Event station",
                "server_url": "http://127.0.0.1:8000/api/v1"
            },
            "payload": {
                "operators": [{"uuid": "operator-1", "full_name": "Operator", "is_active": true}],
                "barcodes": [{"id": 10, "name": "GS1", "structure": {"type": "code128"}}],
                "labels": [{"id": 20, "name": "Label", "structure": {"width": 80}}],
                "containers": [{"id": 30, "name": "Tray", "weight": 12.5}],
                "nomenclature": [{"id": 40, "name": "Product", "article": "A-40", "exp_date": 10}]
            },
            "meta": {
                "type": "FULL_SYNC", "generated_at": "2026-08-25T10:00:00Z",
                "min_client_version": "1.3.0"
            }
        });
        let response = handle_sync(&runtime, &serde_json::to_vec(&sync).unwrap());
        assert_eq!(response.status, 200);
        assert_eq!(checks.load(Ordering::Acquire), 1);
        let names = captured
            .lock()
            .unwrap()
            .iter()
            .filter_map(|event| match event {
                NativeRuntimeEvent::Event { name, .. } => Some(name.clone()),
                NativeRuntimeEvent::Log { .. } => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(
            names,
            vec![
                "printer-config-updated",
                "sync-complete",
                "data-updated",
                "server-status-updated"
            ]
        );

        captured.lock().unwrap().clear();
        let job = json!({
            "type": "PRINT_JOB", "job_id": 7001, "nomenclature_id": 40,
            "nomenclature_name": "Product", "nomenclature_article": "A-40",
            "quantity": 25, "quantity_unit": "pcs", "batch_number": "EVENT"
        });
        let response = handle_print_job(&runtime, &serde_json::to_vec(&job).unwrap());
        assert_eq!(response.status, 200);
        let names = captured
            .lock()
            .unwrap()
            .iter()
            .filter_map(|event| match event {
                NativeRuntimeEvent::Event { name, .. } => Some(name.clone()),
                NativeRuntimeEvent::Log { .. } => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(
            names,
            vec!["sync-complete", "data-updated", "print-jobs-updated"]
        );
        assert_eq!(process_print_job(&persisted, &job).unwrap().job_id, 7001);
        drop(runtime);
        drop(persisted);
        std::fs::remove_dir_all(data_dir).unwrap();
    }
}
