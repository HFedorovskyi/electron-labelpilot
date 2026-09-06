use crate::persisted::PersistedState;
use reqwest::blocking::Client;
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::io::ErrorKind;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

const HTTP_TIMEOUT: Duration = Duration::from_secs(3);
const DISCOVERY_PORT: u16 = 5555;
const STATION_INGRESS_PORT: u16 = 5556;
const DISCOVERY_INTERVAL: Duration = Duration::from_secs(3);
const LOOP_TICK: Duration = Duration::from_millis(250);
const POLL_CONNECTED: Duration = Duration::from_secs(15);
const POLL_DISCONNECTED: Duration = Duration::from_secs(5);
const POLL_HIDDEN: Duration = Duration::from_secs(60);
const MAX_DISCOVERY_DATAGRAM: usize = 4 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DiscoveryMode {
    Server,
    Station,
}

impl DiscoveryMode {
    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "server" => Ok(Self::Server),
            "station" => Ok(Self::Station),
            _ => Err(format!("unsupported discovery mode: {value}")),
        }
    }

    fn announcement_type(self) -> &'static str {
        match self {
            Self::Server => "LABELPILOT_SERVER",
            Self::Station => "LABELPILOT_STATION",
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Server => "server",
            Self::Station => "station",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ConnectionStatus {
    Connected,
    Disconnected,
}

impl ConnectionStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Connected => "connected",
            Self::Disconnected => "disconnected",
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerInfo {
    pub online: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_client_version: Option<String>,
    pub compatible: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compatibility_reason: Option<String>,
}

impl ServerInfo {
    fn offline() -> Self {
        Self {
            online: false,
            server_version: None,
            min_client_version: None,
            compatible: true,
            compatibility_reason: None,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct LicenseFetchResult {
    pub online: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub license: Option<Value>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkSummary {
    pub status: &'static str,
    pub mode: &'static str,
    pub worker_running: bool,
    pub http_timeout_ms: u64,
    pub discovery_interval_ms: u64,
    pub discovery_datagram_limit: usize,
}

struct NetworkInner {
    client: Client,
    status: Mutex<ConnectionStatus>,
    mode: Mutex<DiscoveryMode>,
    stop: AtomicBool,
    force_check: AtomicBool,
    worker: Mutex<Option<JoinHandle<()>>>,
}

pub struct NetworkState {
    inner: Arc<NetworkInner>,
}

impl NetworkState {
    pub fn new() -> Result<Self, String> {
        // reqwest 0.13 leaves rustls provider selection to the application.
        // Re-installation is harmless when another NetworkState already set it.
        let _ = rustls::crypto::ring::default_provider().install_default();
        let client = Client::builder()
            .connect_timeout(HTTP_TIMEOUT)
            .timeout(HTTP_TIMEOUT)
            .pool_idle_timeout(Duration::from_secs(30))
            .pool_max_idle_per_host(1)
            .build()
            .map_err(|error| format!("failed to build HTTP client: {error}"))?;
        Ok(Self {
            inner: Arc::new(NetworkInner {
                client,
                status: Mutex::new(ConnectionStatus::Disconnected),
                mode: Mutex::new(DiscoveryMode::Station),
                stop: AtomicBool::new(false),
                force_check: AtomicBool::new(true),
                worker: Mutex::new(None),
            }),
        })
    }

    pub fn start(&self, app: AppHandle) -> Result<(), String> {
        let mut worker = self
            .inner
            .worker
            .lock()
            .map_err(|_| "network worker lock is poisoned".to_owned())?;
        if worker.is_some() {
            return Ok(());
        }
        self.inner.stop.store(false, Ordering::Release);
        let inner = Arc::clone(&self.inner);
        *worker = Some(
            thread::Builder::new()
                .name("labelpilot-network".to_owned())
                .spawn(move || run_network_worker(inner, app))
                .map_err(|error| format!("failed to start network worker: {error}"))?,
        );
        Ok(())
    }

    pub fn stop(&self) {
        self.inner.stop.store(true, Ordering::Release);
        if let Ok(mut worker) = self.inner.worker.lock() {
            if let Some(handle) = worker.take() {
                let _ = handle.join();
            }
        }
    }

    pub fn request_check(&self) {
        self.inner.force_check.store(true, Ordering::Release);
    }

    pub fn status(&self) -> ConnectionStatus {
        self.inner
            .status
            .lock()
            .map(|status| *status)
            .unwrap_or(ConnectionStatus::Disconnected)
    }

    pub fn set_mode(&self, mode: &str) -> Result<(), String> {
        let parsed = DiscoveryMode::parse(mode)?;
        *self
            .inner
            .mode
            .lock()
            .map_err(|_| "discovery mode lock is poisoned".to_owned())? = parsed;
        Ok(())
    }

    pub fn emit_current_status(&self, app: &AppHandle) -> Result<(), String> {
        emit_status(app, self.status())
    }

    pub fn client(&self) -> Client {
        self.inner.client.clone()
    }

    pub fn summary(&self) -> NetworkSummary {
        let mode = self
            .inner
            .mode
            .lock()
            .map(|mode| *mode)
            .unwrap_or(DiscoveryMode::Station);
        NetworkSummary {
            status: self.status().as_str(),
            mode: mode.as_str(),
            worker_running: self
                .inner
                .worker
                .lock()
                .map(|worker| worker.is_some())
                .unwrap_or(false),
            http_timeout_ms: HTTP_TIMEOUT.as_millis() as u64,
            discovery_interval_ms: DISCOVERY_INTERVAL.as_millis() as u64,
            discovery_datagram_limit: MAX_DISCOVERY_DATAGRAM,
        }
    }
}

impl Drop for NetworkState {
    fn drop(&mut self) {
        // Managed Tauri state is dropped on the event-loop thread. A network
        // worker may be waiting for that thread while querying window state, so
        // Drop must request cancellation without synchronously joining it.
        self.inner.stop.store(true, Ordering::Release);
        if let Ok(mut worker) = self.inner.worker.lock() {
            worker.take();
        }
    }
}

pub fn test_connection_full(
    client: &Client,
    server_ip: &str,
    station_uuid: Option<&str>,
    client_version: &str,
) -> ServerInfo {
    let server_ip = server_ip.trim();
    if server_ip.is_empty() || station_uuid.is_none() {
        return ServerInfo::offline();
    }
    let Some(base_url) = server_base_url(server_ip) else {
        return ServerInfo::offline();
    };
    let url = format!("{base_url}/stations/ping/");
    let response = match client
        .get(url)
        .query(&[("station_uuid", station_uuid.unwrap_or_default())])
        .send()
        .and_then(reqwest::blocking::Response::error_for_status)
    {
        Ok(response) => response,
        Err(_) => return ServerInfo::offline(),
    };
    let value: Value = match response.json() {
        Ok(value) => value,
        Err(_) => return ServerInfo::offline(),
    };
    let ping = match parse_ping_response(&value) {
        Ok(ping) => ping,
        Err(_) => return ServerInfo::offline(),
    };
    if ping.status != "online" {
        return ServerInfo::offline();
    }
    let compatibility = online_compatibility(client_version, ping.min_client_version.as_deref());
    ServerInfo {
        online: true,
        server_version: ping.server_version,
        min_client_version: ping.min_client_version,
        compatible: compatibility.0,
        compatibility_reason: compatibility.1,
    }
}

pub fn fetch_license_status(client: &Client, server_ip: &str) -> LicenseFetchResult {
    let Some(base_url) = server_base_url(server_ip.trim()) else {
        return LicenseFetchResult {
            online: false,
            license: None,
        };
    };
    let response = match client
        .get(format!("{base_url}/license/"))
        .send()
        .and_then(reqwest::blocking::Response::error_for_status)
    {
        Ok(response) => response,
        Err(_) => {
            return LicenseFetchResult {
                online: false,
                license: None,
            };
        }
    };
    match response.json::<Value>() {
        Ok(license) if license.is_object() => LicenseFetchResult {
            online: true,
            license: Some(license),
        },
        _ => LicenseFetchResult {
            online: false,
            license: None,
        },
    }
}

fn run_network_worker(inner: Arc<NetworkInner>, app: AppHandle) {
    let socket = discovery_socket().ok();
    let mut next_broadcast = Instant::now() + DISCOVERY_INTERVAL;
    let mut next_poll = Instant::now();
    let client_version = app.package_info().version.to_string();
    let mut buffer = vec![0_u8; MAX_DISCOVERY_DATAGRAM];

    while !inner.stop.load(Ordering::Acquire) {
        if let Some(socket) = socket.as_ref() {
            match socket.recv_from(&mut buffer) {
                Ok((length, source)) => {
                    let mode = current_mode(&inner);
                    if let Some(event) = parse_discovery_event(mode, &buffer[..length], source) {
                        let _ = app.emit("discovery-event", event);
                    }
                }
                Err(error)
                    if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {}
                Err(_) => {}
            }
        } else {
            thread::sleep(LOOP_TICK);
        }

        let now = Instant::now();
        if now >= next_broadcast {
            if let Some(socket) = socket.as_ref() {
                broadcast_announcement(socket, current_mode(&inner), &app);
            }
            next_broadcast = Instant::now() + DISCOVERY_INTERVAL;
        }

        let forced = inner.force_check.swap(false, Ordering::AcqRel);
        if forced || now >= next_poll {
            let (server_ip, station_uuid) = configured_endpoint(&app);
            let info = test_connection_full(
                &inner.client,
                &server_ip,
                station_uuid.as_deref(),
                &client_version,
            );
            let new_status = if info.online {
                ConnectionStatus::Connected
            } else {
                ConnectionStatus::Disconnected
            };
            update_status(&inner, &app, new_status);
            next_poll = Instant::now() + next_poll_delay(&app, new_status);
        }
    }
}

fn discovery_socket() -> Result<UdpSocket, String> {
    // Receive broadcasts on the protocol port. The ephemeral fallback keeps station
    // announcements alive if a co-located server already owns 5555.
    let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, DISCOVERY_PORT))
        .or_else(|_| UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)))
        .map_err(|error| format!("failed to bind discovery socket: {error}"))?;
    socket
        .set_broadcast(true)
        .map_err(|error| format!("failed to enable UDP broadcast: {error}"))?;
    socket
        .set_read_timeout(Some(LOOP_TICK))
        .map_err(|error| format!("failed to set discovery timeout: {error}"))?;
    Ok(socket)
}

fn broadcast_announcement(socket: &UdpSocket, mode: DiscoveryMode, app: &AppHandle) {
    let identity = app.state::<PersistedState>().load_identity();
    let uuid = identity
        .as_ref()
        .and_then(|identity| identity.get("station_uuid"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let message = json!({
        "type": mode.announcement_type(),
        "ip": local_ipv4().to_string(),
        "uuid": uuid,
        "port": STATION_INGRESS_PORT,
        "timestamp": unix_time_millis()
    });
    if let Ok(bytes) = serde_json::to_vec(&message) {
        let _ = socket.send_to(
            &bytes,
            SocketAddr::new(IpAddr::V4(Ipv4Addr::BROADCAST), DISCOVERY_PORT),
        );
        let _ = socket.send_to(
            &bytes,
            SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), DISCOVERY_PORT),
        );
    }
}

fn parse_discovery_event(
    mode: DiscoveryMode,
    datagram: &[u8],
    source: SocketAddr,
) -> Option<Value> {
    let message: Value = serde_json::from_slice(datagram).ok()?;
    let mut object = message.as_object()?.clone();
    let message_type = object.get("type")?.as_str()?;
    match (mode, message_type) {
        (DiscoveryMode::Station, "LABELPILOT_SERVER") => {
            let port = object.get("port").and_then(Value::as_u64).unwrap_or(8000);
            object.insert("type".to_owned(), json!("server-found"));
            object.insert("ip".to_owned(), json!(source.ip().to_string()));
            object.insert("port".to_owned(), json!(port));
            Some(Value::Object(object))
        }
        (DiscoveryMode::Server, "LABELPILOT_STATION") => {
            object.insert("type".to_owned(), json!("station-found"));
            object.insert("ip".to_owned(), json!(source.ip().to_string()));
            Some(Value::Object(object))
        }
        _ => None,
    }
}

fn current_mode(inner: &NetworkInner) -> DiscoveryMode {
    inner
        .mode
        .lock()
        .map(|mode| *mode)
        .unwrap_or(DiscoveryMode::Station)
}

fn configured_endpoint(app: &AppHandle) -> (String, Option<String>) {
    let persisted = app.state::<PersistedState>();
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
    (server_ip, station_uuid)
}

fn update_status(inner: &NetworkInner, app: &AppHandle, new_status: ConnectionStatus) {
    let changed = inner
        .status
        .lock()
        .map(|mut status| {
            let changed = *status != new_status;
            *status = new_status;
            changed
        })
        .unwrap_or(false);
    if changed {
        let _ = emit_status(app, new_status);
    }
}

fn emit_status(app: &AppHandle, status: ConnectionStatus) -> Result<(), String> {
    app.emit(
        "discovery-event",
        json!({ "type": "server-found", "status": status.as_str() }),
    )
    .map_err(|error| format!("failed to emit discovery-event: {error}"))?;
    app.emit(
        "server-status-updated",
        json!({ "status": status.as_str() }),
    )
    .map_err(|error| format!("failed to emit server-status-updated: {error}"))
}

fn next_poll_delay(app: &AppHandle, status: ConnectionStatus) -> Duration {
    let visible = app
        .get_webview_window("main")
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(false);
    if !visible {
        POLL_HIDDEN
    } else if status == ConnectionStatus::Connected {
        POLL_CONNECTED
    } else {
        POLL_DISCONNECTED
    }
}

pub(crate) fn server_base_url(server_ip: &str) -> Option<String> {
    if server_ip.is_empty() || server_ip.chars().any(char::is_whitespace) {
        return None;
    }
    let value = server_ip.trim_end_matches('/');
    let base = if value.starts_with("http://") || value.starts_with("https://") {
        value.to_owned()
    } else if has_explicit_port(value) {
        format!("http://{value}")
    } else {
        format!("http://{value}:8000")
    };
    reqwest::Url::parse(&base).ok()?;
    Some(format!("{base}/api/v1"))
}

fn has_explicit_port(value: &str) -> bool {
    if value.starts_with('[') {
        return value
            .rsplit_once("]:")
            .map(|(_, port)| port.parse::<u16>().is_ok())
            .unwrap_or(false);
    }
    value
        .rsplit_once(':')
        .map(|(_, port)| port.parse::<u16>().is_ok())
        .unwrap_or(false)
}

struct PingResponse {
    status: String,
    server_version: Option<String>,
    min_client_version: Option<String>,
}

fn parse_ping_response(value: &Value) -> Result<PingResponse, String> {
    let object = value
        .as_object()
        .ok_or_else(|| "ping response must be an object".to_owned())?;
    let status = required_string(object, "status")?.to_owned();
    let server_version = optional_string(object, "server_version")?;
    let min_client_version = optional_string(object, "min_client_version")?;
    Ok(PingResponse {
        status,
        server_version,
        min_client_version,
    })
}

fn required_string<'a>(object: &'a Map<String, Value>, key: &str) -> Result<&'a str, String> {
    object
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{key} must be a string"))
}

fn optional_string(object: &Map<String, Value>, key: &str) -> Result<Option<String>, String> {
    match object.get(key) {
        None => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.clone())),
        _ => Err(format!("{key} must be a string when present")),
    }
}

fn online_compatibility(
    client_version: &str,
    min_client_version: Option<&str>,
) -> (bool, Option<String>) {
    let Some(required) = min_client_version else {
        return (true, None);
    };
    match semver_lt(client_version, required) {
        Some(true) => (
            false,
            Some(format!(
                "Версия клиента {client_version} устарела. Минимальная совместимая версия: {required}. Обновите LabelPilot перед синхронизацией."
            )),
        ),
        _ => (true, None),
    }
}

fn semver_lt(left: &str, right: &str) -> Option<bool> {
    let parse = |value: &str| -> Option<[u64; 3]> {
        let mut parts = value.trim_start_matches('v').split('.');
        Some([
            parts.next()?.parse().ok()?,
            parts.next()?.parse().ok()?,
            parts.next()?.parse().ok()?,
        ])
    };
    Some(parse(left)? < parse(right)?)
}

fn local_ipv4() -> Ipv4Addr {
    UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0))
        .and_then(|socket| {
            socket.connect((Ipv4Addr::new(192, 0, 2, 1), 9))?;
            socket.local_addr()
        })
        .ok()
        .and_then(|address| match address.ip() {
            IpAddr::V4(ip) if !ip.is_unspecified() => Some(ip),
            _ => None,
        })
        .unwrap_or(Ipv4Addr::LOCALHOST)
}

fn unix_time_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    fn mock_http(response_status: &str, body: &'static str) -> (String, JoinHandle<String>) {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("bind mock server");
        let address = listener.local_addr().expect("mock address");
        let response_status = response_status.to_owned();
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept request");
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .expect("read timeout");
            let mut bytes = [0_u8; 4096];
            let length = stream.read(&mut bytes).expect("read request");
            let request = String::from_utf8_lossy(&bytes[..length]).into_owned();
            let reply = format!(
                "HTTP/1.1 {response_status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            stream.write_all(reply.as_bytes()).expect("write response");
            request
        });
        (address.to_string(), handle)
    }

    fn client() -> Client {
        let _ = rustls::crypto::ring::default_provider().install_default();
        Client::builder()
            .connect_timeout(Duration::from_secs(1))
            .timeout(Duration::from_secs(1))
            .build()
            .expect("test client")
    }

    #[test]
    fn ping_matches_the_server_contract_and_checks_minimum_version() {
        let (host, request) = mock_http(
            "200 OK",
            r#"{"status":"online","server_version":"1.1.23","min_client_version":"1.3.17","extra":true}"#,
        );
        let info = test_connection_full(&client(), &host, Some("station-fixture"), "1.3.16");
        assert!(info.online);
        assert!(!info.compatible);
        assert_eq!(
            info.compatibility_reason.as_deref(),
            Some("Версия клиента 1.3.16 устарела. Минимальная совместимая версия: 1.3.17. Обновите LabelPilot перед синхронизацией.")
        );
        assert_eq!(info.server_version.as_deref(), Some("1.1.23"));
        let request = request.join().expect("mock request");
        assert!(request.starts_with("GET /api/v1/stations/ping/?station_uuid=station-fixture"));
    }

    #[test]
    fn ping_skips_the_network_without_station_identity() {
        let info = test_connection_full(&client(), "127.0.0.1:9", None, "1.3.16");
        assert!(!info.online);
        assert!(info.compatible);
    }

    #[test]
    fn invalid_ping_shape_is_reported_as_offline() {
        let (host, request) = mock_http("200 OK", r#"{"status":42}"#);
        let info = test_connection_full(&client(), &host, Some("station-fixture"), "1.3.16");
        assert!(!info.online);
        request.join().expect("mock request");
    }

    #[test]
    fn license_result_preserves_the_complete_server_object() {
        let (host, request) = mock_http(
            "200 OK",
            r#"{"licensed":true,"mode":"licensed","features":["printing"],"future_field":17}"#,
        );
        let result = fetch_license_status(&client(), &host);
        assert!(result.online);
        assert_eq!(result.license.unwrap()["future_field"], 17);
        assert!(request
            .join()
            .expect("mock request")
            .starts_with("GET /api/v1/license/"));
    }

    #[test]
    fn discovery_parser_emits_the_renderer_contract_and_source_ip() {
        let source = SocketAddr::new(IpAddr::V4(Ipv4Addr::new(192, 0, 2, 10)), 5555);
        let event = parse_discovery_event(
            DiscoveryMode::Station,
            br#"{"type":"LABELPILOT_SERVER","ip":"198.51.100.5","port":8000,"timestamp":1}"#,
            source,
        )
        .expect("server event");
        assert_eq!(event["type"], "server-found");
        assert_eq!(event["ip"], "192.0.2.10");
        assert_eq!(event["port"], 8000);
        assert!(parse_discovery_event(DiscoveryMode::Server, b"{}", source).is_none());
    }

    #[test]
    fn endpoint_builder_keeps_the_existing_default_and_supports_test_ports() {
        assert_eq!(
            server_base_url("192.0.2.5").as_deref(),
            Some("http://192.0.2.5:8000/api/v1")
        );
        assert_eq!(
            server_base_url("127.0.0.1:3210").as_deref(),
            Some("http://127.0.0.1:3210/api/v1")
        );
        assert!(server_base_url("bad host").is_none());
    }
}
