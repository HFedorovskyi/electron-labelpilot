use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde_json::{json, Map, Value};
use std::env;
use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, RwLock};

// Immutable deployed data path; renaming it would orphan station state during the 2.0 upgrade.
const LEGACY_APP_DIRECTORY: &str = "electron-labelpilot";
const SCALE_FILE: &str = "scale-config.json";
const NUMBERING_FILE: &str = "numbering-config.json";
const PRINTER_FILE: &str = "printer-config.json";
const IDENTITY_FILE: &str = "identity.json";
const DATABASE_FILE: &str = "client_data.db";
const SEQUENCE_FILE: &str = "sequence-store.json";
const LICENSE_TOKEN_FILE: &str = "license.token";
const MAX_SEQUENCE_LENGTH: i64 = 4096;
static TEMP_FILE_COUNTER: AtomicU64 = AtomicU64::new(0);

pub struct PersistedState {
    data_dir: PathBuf,
    sequence_guard: Mutex<()>,
    numbering_cache: RwLock<Option<Value>>,
    printer_cache: RwLock<Option<Value>>,
}

impl PersistedState {
    pub fn resolve() -> Result<Self, String> {
        if let Some(override_path) = env::var_os("LABELPILOT_DATA_DIR") {
            if !override_path.is_empty() {
                return Ok(Self::for_data_dir(PathBuf::from(override_path)));
            }
        }

        #[cfg(target_os = "windows")]
        let root = env::var_os("APPDATA").map(PathBuf::from).ok_or_else(|| {
            "APPDATA is not available; legacy LabelPilot data path is unknown".to_owned()
        })?;

        #[cfg(not(target_os = "windows"))]
        let root = env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .or_else(|| env::var_os("HOME").map(|home| PathBuf::from(home).join(".config")))
            .ok_or_else(|| "user configuration directory is not available".to_owned())?;

        Ok(Self::for_data_dir(root.join(LEGACY_APP_DIRECTORY)))
    }

    pub fn for_data_dir(data_dir: PathBuf) -> Self {
        Self {
            data_dir,
            sequence_guard: Mutex::new(()),
            numbering_cache: RwLock::new(None),
            printer_cache: RwLock::new(None),
        }
    }

    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }

    pub fn database_path(&self) -> PathBuf {
        self.data_dir.join(DATABASE_FILE)
    }

    pub fn load_license_token(&self) -> Option<String> {
        fs::read_to_string(self.data_dir.join(LICENSE_TOKEN_FILE))
            .ok()
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty())
    }

    pub fn save_license_token(&self, token: &str) -> Result<(), String> {
        atomic_write_bytes(&self.data_dir.join(LICENSE_TOKEN_FILE), token.as_bytes())
    }

    pub fn save_identity(&self, identity: &Value) -> Result<(), String> {
        if !identity.is_object() {
            return Err("identity must be a JSON object".to_owned());
        }
        atomic_write_json(&self.data_dir.join(IDENTITY_FILE), identity)
    }

    pub fn update_server_ip(&self, server_ip: &str) -> Result<Value, String> {
        let mut config = self.load_printer_config();
        config["serverIp"] = Value::String(server_ip.to_owned());
        self.save_printer_config(config.clone())?;
        Ok(config)
    }
    pub fn load_scale_config(&self) -> Value {
        normalize_scale(read_json(&self.data_dir.join(SCALE_FILE)).ok().flatten())
    }

    pub fn save_scale_config(&self, value: Value) -> Result<(), String> {
        validate_scale(&value)?;
        atomic_write_json(&self.data_dir.join(SCALE_FILE), &value)
    }

    pub fn load_numbering_config(&self) -> Value {
        if let Some(value) = self.load_cached(&self.numbering_cache) {
            return value;
        }
        let value = normalize_numbering(
            read_json(&self.data_dir.join(NUMBERING_FILE))
                .ok()
                .flatten(),
        );
        self.store_cached(&self.numbering_cache, value.clone());
        value
    }

    pub fn save_numbering_config(&self, value: Value) -> Result<(), String> {
        validate_numbering(&value)?;
        atomic_write_json(&self.data_dir.join(NUMBERING_FILE), &value)?;
        self.store_cached(&self.numbering_cache, value);
        Ok(())
    }

    pub fn load_printer_config(&self) -> Value {
        if let Some(value) = self.load_cached(&self.printer_cache) {
            return value;
        }
        let value = normalize_printer(read_json(&self.data_dir.join(PRINTER_FILE)).ok().flatten());
        self.store_cached(&self.printer_cache, value.clone());
        value
    }

    pub fn save_printer_config(&self, value: Value) -> Result<(), String> {
        let value = normalize_printer(Some(value));
        validate_printer(&value)?;
        atomic_write_json(&self.data_dir.join(PRINTER_FILE), &value)?;
        self.store_cached(&self.printer_cache, value);
        Ok(())
    }

    pub fn load_identity(&self) -> Option<Value> {
        if let Ok(Some(identity)) = read_database_identity(&self.data_dir.join(DATABASE_FILE)) {
            return Some(identity);
        }
        read_json(&self.data_dir.join(IDENTITY_FILE))
            .ok()
            .flatten()
            .filter(Value::is_object)
    }

    fn load_cached(&self, cache: &RwLock<Option<Value>>) -> Option<Value> {
        cache.read().ok().and_then(|value| value.clone())
    }

    fn store_cached(&self, cache: &RwLock<Option<Value>>, value: Value) {
        if let Ok(mut cached) = cache.write() {
            *cached = Some(value);
        }
    }

    pub fn next_sequence(&self, sequence_type: &str) -> Result<String, String> {
        if !matches!(sequence_type, "unit" | "box" | "pallet") {
            return Err(format!("unsupported sequence type: {sequence_type}"));
        }

        let _guard = self
            .sequence_guard
            .lock()
            .map_err(|_| "sequence store lock is poisoned".to_owned())?;
        let identity = self
            .load_identity()
            .ok_or_else(|| "Station identity not loaded".to_owned())?;
        let station_number = identity
            .get("station_number")
            .and_then(Value::as_str)
            .ok_or_else(|| "station identity has no string station_number".to_owned())?;

        let numbering = self.load_numbering_config();
        let configured_length = numbering
            .get(sequence_type)
            .and_then(Value::as_object)
            .and_then(|config| config.get("length"))
            .and_then(Value::as_i64)
            .unwrap_or(13);
        let target_length = if configured_length == 0 {
            13
        } else {
            configured_length
        };
        if target_length > MAX_SEQUENCE_LENGTH {
            return Err(format!(
                "sequence length {target_length} exceeds {MAX_SEQUENCE_LENGTH}"
            ));
        }

        let sequence_path = self.data_dir.join(SEQUENCE_FILE);
        let mut store = normalize_sequence(read_json(&sequence_path).ok().flatten());
        let counter = store
            .get(sequence_type)
            .and_then(Value::as_i64)
            .unwrap_or(0)
            .checked_add(1)
            .ok_or_else(|| format!("{sequence_type} sequence counter overflow"))?;
        store[sequence_type] = json!(counter);
        atomic_write_json(&sequence_path, &store)?;

        let station_prefix = pad_left(station_number, 2, '0');
        let sequence_part = pad_left(&counter.to_string(), 5, '0');
        let core = format!("{station_prefix}{sequence_part}");
        let required_padding = target_length - core.chars().count() as i64 - 1;
        if required_padding >= 0 {
            Ok(format!("{core}{}1", "0".repeat(required_padding as usize)))
        } else {
            Ok(format!("{core}1"))
        }
    }
}

fn default_scale() -> Value {
    json!({
        "type": "simulator",
        "protocolId": "simulator",
        "pollingInterval": 250,
        "stabilityCount": 4
    })
}

fn default_numbering() -> Value {
    json!({
        "unit": { "enabled": false, "length": 3, "prefix": "" },
        "box": { "enabled": false, "length": 3, "prefix": "" },
        "pallet": { "enabled": false, "length": 3, "prefix": "" }
    })
}

fn default_device(id: &str, name: &str) -> Value {
    json!({
        "id": id,
        "active": false,
        "name": name,
        "connection": "windows_driver",
        "protocol": "image",
        "compatibilityMode": "auto",
        "port": 9100,
        "baudRate": 9600,
        "dpi": 203
    })
}

fn default_printer() -> Value {
    json!({
        "packPrinter": default_device("pack_default", "Pack Printer"),
        "boxPrinter": default_device("box_default", "Box Printer"),
        "palletPrinter": default_device("pallet_default", "Pallet Printer"),
        "autoPrintOnStable": true,
        "serverIp": "",
        "language": "ru"
    })
}

fn default_sequence() -> Value {
    json!({ "unit": 0, "box": 0, "pallet": 0 })
}

fn normalize_scale(value: Option<Value>) -> Value {
    merge_root(default_scale(), value)
}

fn normalize_numbering(value: Option<Value>) -> Value {
    merge_root(default_numbering(), value)
}

fn normalize_printer(value: Option<Value>) -> Value {
    let mut result = merge_root(default_printer(), value);
    for role in ["packPrinter", "boxPrinter", "palletPrinter"] {
        let Some(device) = result.get_mut(role).and_then(Value::as_object_mut) else {
            continue;
        };
        let has_legacy_size = device.get("widthMm").and_then(Value::as_f64) == Some(58.0)
            && device.get("heightMm").and_then(Value::as_f64) == Some(40.0);
        if has_legacy_size {
            device.remove("widthMm");
            device.remove("heightMm");
        }
        // Connection framing is selected by the transport. This legacy operator
        // switch caused EOF-driven bridges to release many labels at box close.
        device.remove("persistentConnection");
        if let Some(boundary) = device
            .get("tcpJobBoundary")
            .and_then(Value::as_str)
            .map(|value| value.trim().to_ascii_lowercase())
        {
            if matches!(boundary.as_str(), "stream" | "eof") {
                device.insert("tcpJobBoundary".to_owned(), Value::String(boundary));
            } else {
                device.remove("tcpJobBoundary");
            }
        }
    }
    result
}

fn normalize_sequence(value: Option<Value>) -> Value {
    let mut result = merge_root(default_sequence(), value);
    for role in ["unit", "box", "pallet"] {
        let valid = result
            .get(role)
            .and_then(Value::as_i64)
            .filter(|counter| *counter >= 0)
            .unwrap_or(0);
        result[role] = json!(valid);
    }
    result
}

fn merge_root(mut defaults: Value, incoming: Option<Value>) -> Value {
    let Some(default_object) = defaults.as_object_mut() else {
        return defaults;
    };
    if let Some(Value::Object(incoming_object)) = incoming {
        default_object.extend(incoming_object);
    }
    defaults
}

fn validate_scale(value: &Value) -> Result<(), String> {
    let object = expect_object(value, "scale config")?;
    expect_enum(object, "type", &["serial", "tcp", "simulator"])?;
    expect_string(object, "protocolId")?;
    optional_string(object, "path")?;
    optional_string(object, "host")?;
    for field in ["baudRate", "port", "pollingInterval", "stabilityCount"] {
        optional_integer(object, field)?;
    }
    Ok(())
}

fn validate_numbering(value: &Value) -> Result<(), String> {
    let object = expect_object(value, "numbering config")?;
    for role in ["unit", "box", "pallet"] {
        let role_object = object
            .get(role)
            .ok_or_else(|| format!("numbering config is missing {role}"))
            .and_then(|value| expect_object(value, role))?;
        expect_boolean(role_object, "enabled")?;
        expect_integer(role_object, "length")?;
        optional_string(role_object, "prefix")?;
    }
    Ok(())
}

fn validate_printer(value: &Value) -> Result<(), String> {
    let object = expect_object(value, "printer config")?;
    for role in ["packPrinter", "boxPrinter", "palletPrinter"] {
        let device = object
            .get(role)
            .ok_or_else(|| format!("printer config is missing {role}"))
            .and_then(|value| expect_object(value, role))?;
        expect_string(device, "id")?;
        expect_boolean(device, "active")?;
        expect_string(device, "name")?;
        expect_enum(device, "connection", &["tcp", "serial", "windows_driver"])?;
        expect_enum(
            device,
            "protocol",
            &[
                "zpl", "tspl", "epl", "cpcl", "dpl", "sbpl", "image", "browser",
            ],
        )?;
        optional_enum(
            device,
            "compatibilityMode",
            &["auto", "compatible", "advanced"],
        )?;
        for field in [
            "detectedProfileId",
            "detectedEndpointKey",
            "ip",
            "serialPort",
            "driverName",
        ] {
            optional_string(device, field)?;
        }
        for field in [
            "detectedProfileAt",
            "port",
            "baudRate",
            "dpi",
            "widthMm",
            "heightMm",
            "darkness",
            "printSpeed",
            "gapMm",
        ] {
            optional_number(device, field)?;
        }
        optional_enum(device, "ramCache", &["auto", "on", "off"])?;
        optional_boolean(device, "z64")?;
        optional_enum(device, "tcpJobBoundary", &["stream", "eof"])?;
    }
    expect_boolean(object, "autoPrintOnStable")?;
    expect_string(object, "serverIp")?;
    expect_string(object, "language")?;
    Ok(())
}

fn expect_object<'a>(value: &'a Value, name: &str) -> Result<&'a Map<String, Value>, String> {
    value
        .as_object()
        .ok_or_else(|| format!("{name} must be a JSON object"))
}

fn expect_string(object: &Map<String, Value>, field: &str) -> Result<(), String> {
    match object.get(field) {
        Some(Value::String(_)) => Ok(()),
        _ => Err(format!("{field} must be a string")),
    }
}

fn expect_boolean(object: &Map<String, Value>, field: &str) -> Result<(), String> {
    match object.get(field) {
        Some(Value::Bool(_)) => Ok(()),
        _ => Err(format!("{field} must be a boolean")),
    }
}

fn expect_integer(object: &Map<String, Value>, field: &str) -> Result<(), String> {
    match object.get(field) {
        Some(value) if value.as_i64().is_some() || value.as_u64().is_some() => Ok(()),
        _ => Err(format!("{field} must be an integer")),
    }
}

fn expect_enum(object: &Map<String, Value>, field: &str, values: &[&str]) -> Result<(), String> {
    let value = object
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{field} must be a string"))?;
    if values.contains(&value) {
        Ok(())
    } else {
        Err(format!("{field} has unsupported value {value}"))
    }
}

fn optional_string(object: &Map<String, Value>, field: &str) -> Result<(), String> {
    match object.get(field) {
        None | Some(Value::Null) | Some(Value::String(_)) => Ok(()),
        _ => Err(format!("{field} must be a string when present")),
    }
}

fn optional_boolean(object: &Map<String, Value>, field: &str) -> Result<(), String> {
    match object.get(field) {
        None | Some(Value::Null) | Some(Value::Bool(_)) => Ok(()),
        _ => Err(format!("{field} must be a boolean when present")),
    }
}

fn optional_number(object: &Map<String, Value>, field: &str) -> Result<(), String> {
    match object.get(field) {
        None | Some(Value::Null) => Ok(()),
        Some(value) if value.is_number() => Ok(()),
        _ => Err(format!("{field} must be a number when present")),
    }
}

fn optional_integer(object: &Map<String, Value>, field: &str) -> Result<(), String> {
    match object.get(field) {
        None | Some(Value::Null) => Ok(()),
        Some(value) if value.as_i64().is_some() || value.as_u64().is_some() => Ok(()),
        _ => Err(format!("{field} must be an integer when present")),
    }
}

fn optional_enum(object: &Map<String, Value>, field: &str, values: &[&str]) -> Result<(), String> {
    match object.get(field) {
        None | Some(Value::Null) => Ok(()),
        Some(Value::String(value)) if values.contains(&value.as_str()) => Ok(()),
        _ => Err(format!("{field} has an unsupported value")),
    }
}

fn read_json(path: &Path) -> Result<Option<Value>, String> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|error| format!("failed to parse {}: {error}", path.display())),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("failed to read {}: {error}", path.display())),
    }
}

pub(crate) fn atomic_write_bytes(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("{} has no parent directory", path.display()))?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("failed to create {}: {error}", parent.display()))?;
    let temp_path = temporary_path(path);
    let write_result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)
            .map_err(|error| format!("failed to create {}: {error}", temp_path.display()))?;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|error| format!("failed to flush {}: {error}", temp_path.display()))?;
        replace_file(&temp_path, path)
    })();
    if write_result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    write_result
}
fn atomic_write_json(path: &Path, value: &Value) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("{} has no parent directory", path.display()))?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("failed to create {}: {error}", parent.display()))?;
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|error| format!("failed to serialize {}: {error}", path.display()))?;
    let temp_path = temporary_path(path);
    let write_result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)
            .map_err(|error| format!("failed to create {}: {error}", temp_path.display()))?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|error| format!("failed to flush {}: {error}", temp_path.display()))?;
        replace_file(&temp_path, path)
    })();
    if write_result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    write_result
}

fn temporary_path(path: &Path) -> PathBuf {
    let counter = TEMP_FILE_COUNTER.fetch_add(1, Ordering::Relaxed);
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("config.json");
    path.with_file_name(format!(".{name}.{}.{}.tmp", std::process::id(), counter))
}

#[cfg(target_os = "windows")]
fn replace_file(source: &Path, destination: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let source_wide: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination_wide: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let flags = MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH;
    let result = unsafe { MoveFileExW(source_wide.as_ptr(), destination_wide.as_ptr(), flags) };
    if result == 0 {
        Err(format!(
            "failed to replace {} atomically: {}",
            destination.display(),
            std::io::Error::last_os_error()
        ))
    } else {
        Ok(())
    }
}

#[cfg(not(target_os = "windows"))]
fn replace_file(source: &Path, destination: &Path) -> Result<(), String> {
    fs::rename(source, destination).map_err(|error| {
        format!(
            "failed to replace {} atomically from {}: {error}",
            destination.display(),
            source.display()
        )
    })
}

fn read_database_identity(path: &Path) -> Result<Option<Value>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| format!("failed to open {}: {error}", path.display()))?;
    let row = connection
        .query_row(
            "SELECT uuid, number, name, server_url, last_sync_time FROM station LIMIT 1",
            [],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<i64>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                ))
            },
        )
        .optional()
        .map_err(|error| format!("failed to read station identity: {error}"))?;

    Ok(row.map(|(uuid, number, name, server_url, last_sync_time)| {
        json!({
            "station_uuid": uuid,
            "station_number": pad_left(&number.unwrap_or(0).to_string(), 2, '0'),
            "station_name": name.unwrap_or_default(),
            "server_url": server_url.unwrap_or_default(),
            "last_sync_time": last_sync_time.unwrap_or_default()
        })
    }))
}

fn pad_left(value: &str, length: usize, fill: char) -> String {
    let current = value.chars().count();
    if current >= length {
        return value.to_owned();
    }
    format!("{}{}", fill.to_string().repeat(length - current), value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    use std::sync::Arc;
    use std::thread;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new(name: &str) -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos();
            let path = env::temp_dir().join(format!(
                "labelpilot-persisted-{name}-{}-{nonce}",
                std::process::id()
            ));
            fs::create_dir_all(&path).expect("create test directory");
            Self(path)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn fixture() -> Value {
        serde_json::from_str(include_str!(
            "../../tests/fixtures/persisted-contracts.json"
        ))
        .expect("valid persisted fixture")
    }

    #[test]
    fn normalizers_match_the_persisted_contract_fixtures() {
        let fixture = fixture();
        assert_eq!(
            normalize_scale(Some(fixture["scale"]["input"].clone())),
            fixture["scale"]["expected"]
        );
        assert_eq!(
            normalize_numbering(Some(fixture["numbering"]["input"].clone())),
            fixture["numbering"]["expected"]
        );
        assert_eq!(
            normalize_printer(Some(fixture["printer"]["input"].clone())),
            fixture["printer"]["expected"]
        );
    }

    #[test]
    fn identity_prefers_sqlite_and_falls_back_to_json() {
        let directory = TestDirectory::new("identity");
        let state = PersistedState::for_data_dir(directory.0.clone());
        atomic_write_json(
            &directory.0.join(IDENTITY_FILE),
            &json!({
                "station_uuid": "json-station",
                "station_number": "03",
                "station_name": "JSON"
            }),
        )
        .expect("write JSON identity");
        assert_eq!(
            state.load_identity().unwrap()["station_uuid"],
            "json-station"
        );

        let connection = Connection::open(directory.0.join(DATABASE_FILE)).expect("open SQLite");
        connection
            .execute_batch(
                "CREATE TABLE station(\
                   uuid TEXT PRIMARY KEY NOT NULL,\
                   number INTEGER, name TEXT, server_url TEXT, last_sync_time DATETIME\
                 );\
                 INSERT INTO station VALUES(\
                   'database-station', 7, 'Database', 'http://127.0.0.1', '2026-01-01'\
                 );",
            )
            .expect("seed SQLite identity");
        drop(connection);

        let identity = state.load_identity().expect("database identity");
        assert_eq!(identity["station_uuid"], "database-station");
        assert_eq!(identity["station_number"], "07");
        assert_eq!(identity["station_name"], "Database");
    }

    #[test]
    fn writes_json_atomically_and_preserves_unknown_fields() {
        let directory = TestDirectory::new("atomic");
        let state = PersistedState::for_data_dir(directory.0.clone());
        let mut scale = default_scale();
        scale["customDriverOption"] = json!("keep-me");
        state.save_scale_config(scale.clone()).expect("save scale");
        assert_eq!(state.load_scale_config(), scale);
        let leftovers: Vec<_> = fs::read_dir(&directory.0)
            .expect("list data directory")
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "temporary file was not cleaned up");
    }

    #[test]
    fn printer_config_removes_the_legacy_connection_switch() {
        let directory = TestDirectory::new("printer-framing-migration");
        let state = PersistedState::for_data_dir(directory.0.clone());
        let mut printer = default_printer();
        printer["packPrinter"]["persistentConnection"] = json!(true);
        printer["boxPrinter"]["persistentConnection"] = json!(false);
        printer["packPrinter"]["tcpJobBoundary"] = json!("EOF");
        state.save_printer_config(printer).unwrap();

        let saved = state.load_printer_config();
        assert!(saved["packPrinter"].get("persistentConnection").is_none());
        assert!(saved["boxPrinter"].get("persistentConnection").is_none());
        assert_eq!(saved["packPrinter"]["tcpJobBoundary"], "eof");
    }

    #[test]
    fn config_caches_follow_successful_atomic_saves() {
        let directory = TestDirectory::new("config-cache");
        let state = PersistedState::for_data_dir(directory.0.clone());

        let mut printer = default_printer();
        printer["packPrinter"]["name"] = json!("Line A");
        state
            .save_printer_config(printer.clone())
            .expect("save printer config");
        assert_eq!(state.load_printer_config(), printer);
        printer["packPrinter"]["name"] = json!("Line B");
        state
            .save_printer_config(printer.clone())
            .expect("replace printer config");
        assert_eq!(state.load_printer_config(), printer);

        let mut numbering = default_numbering();
        numbering["unit"]["prefix"] = json!("PK");
        state
            .save_numbering_config(numbering.clone())
            .expect("save numbering config");
        assert_eq!(state.load_numbering_config(), numbering);
    }

    #[test]
    #[ignore = "manual persisted print-config cache benchmark"]
    fn benchmark_cached_print_configuration_reads() {
        use std::hint::black_box;
        use std::time::Instant;

        let directory = TestDirectory::new("config-cache-benchmark");
        let state = PersistedState::for_data_dir(directory.0.clone());
        state
            .save_printer_config(default_printer())
            .expect("save printer config");
        state
            .save_numbering_config(default_numbering())
            .expect("save numbering config");
        let iterations = 10_000_u64;

        let uncached_started = Instant::now();
        for _ in 0..iterations {
            black_box(normalize_printer(
                read_json(&directory.0.join(PRINTER_FILE)).unwrap(),
            ));
            black_box(normalize_numbering(
                read_json(&directory.0.join(NUMBERING_FILE)).unwrap(),
            ));
        }
        let uncached_micros = uncached_started.elapsed().as_micros();

        let cached_started = Instant::now();
        for _ in 0..iterations {
            black_box(state.load_printer_config());
            black_box(state.load_numbering_config());
        }
        let cached_micros = cached_started.elapsed().as_micros();
        println!(
            "PRINT_CONFIG_CACHE_BENCH iterations={iterations} uncached_us={uncached_micros} cached_us={cached_micros} speedup_x={:.2}",
            uncached_micros as f64 / cached_micros.max(1) as f64
        );
    }

    #[test]
    fn sequence_updates_are_unique_and_persisted_under_concurrency() {
        let directory = TestDirectory::new("sequence");
        let state = Arc::new(PersistedState::for_data_dir(directory.0.clone()));
        atomic_write_json(
            &directory.0.join(IDENTITY_FILE),
            &json!({
                "station_uuid": "fixture-station",
                "station_number": "07",
                "station_name": "Fixture"
            }),
        )
        .expect("write identity");
        atomic_write_json(
            &directory.0.join(NUMBERING_FILE),
            &json!({
                "unit": { "enabled": true, "length": 13, "prefix": "" },
                "box": { "enabled": false, "length": 3, "prefix": "" },
                "pallet": { "enabled": false, "length": 3, "prefix": "" }
            }),
        )
        .expect("write numbering");

        let handles: Vec<_> = (0..32)
            .map(|_| {
                let state = Arc::clone(&state);
                thread::spawn(move || state.next_sequence("unit").expect("next sequence"))
            })
            .collect();
        let values: HashSet<_> = handles
            .into_iter()
            .map(|handle| handle.join().expect("sequence thread"))
            .collect();
        assert_eq!(values.len(), 32);
        assert!(values.contains("0700001000001"));
        assert!(values.contains("0700032000001"));
        let store = read_json(&directory.0.join(SEQUENCE_FILE))
            .expect("read sequence store")
            .expect("sequence store exists");
        assert_eq!(store["unit"], 32);
    }

    #[test]
    fn rejects_invalid_persisted_payloads_before_writing() {
        let directory = TestDirectory::new("validation");
        let state = PersistedState::for_data_dir(directory.0.clone());
        assert!(state
            .save_scale_config(json!({ "type": "tcp", "protocolId": 42 }))
            .is_err());
        assert!(!directory.0.join(SCALE_FILE).exists());
        assert!(state.next_sequence("invalid").is_err());
    }
}
