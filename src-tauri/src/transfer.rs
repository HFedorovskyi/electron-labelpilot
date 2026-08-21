use crate::crypto::{decode_push_body, encrypt_report};
use crate::persisted::PersistedState;
use crate::processor::{open_database, process_print_job, process_sync};
use hmac::{Hmac, Mac};
use rusqlite::types::ValueRef;
use serde_json::{json, Map, Value};
use sha2::Sha256;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use time::{format_description::well_known::Rfc3339, OffsetDateTime};
use uuid::Uuid;

const MAX_IDENTITY_BYTES: u64 = 64 * 1024 * 1024;
const MAX_SYNC_BYTES: u64 = 64 * 1024 * 1024;
const MAX_PRINT_JOB_BYTES: u64 = 8 * 1024 * 1024;
const MAX_USB_BYTES: u64 = 64 * 1024 * 1024;
const USB_SYNC_KEY: &[u8] = b"labelpilot-offline-sync-secret";

type HmacSha256 = Hmac<Sha256>;

pub fn import_identity_file(
    persisted: &PersistedState,
    client_version: &str,
    path: &Path,
) -> Result<Value, String> {
    validate_extension(path, &["lpi"])?;
    let body = read_bounded(path, MAX_IDENTITY_BYTES)?;
    let decoded = decode_push_body(persisted, &body).map_err(|error| error.to_string())?;
    let outcome = process_sync(persisted, client_version, &decoded.value)?;
    decoded.persist_verified_token(persisted)?;
    clear_demo_flag(persisted);
    let identity = persisted
        .load_identity()
        .ok_or_else(|| "Failed to load identity after import".to_owned())?;
    Ok(json!({
        "success": true,
        "identity": identity,
        "message": outcome.message,
        "importedRows": outcome.imported_rows,
    }))
}

pub fn import_offline_sync(
    persisted: &PersistedState,
    client_version: &str,
    path: &Path,
) -> Result<Value, String> {
    validate_extension(path, &["lps", "lpi"])?;
    let body = read_bounded(path, MAX_SYNC_BYTES)?;
    let decoded = decode_push_body(persisted, &body).map_err(|error| error.to_string())?;
    let outcome = process_sync(persisted, client_version, &decoded.value)?;
    decoded.persist_verified_token(persisted)?;
    clear_demo_flag(persisted);
    Ok(json!({
        "success": true,
        "message": outcome.message,
        "type": outcome.sync_type,
        "importedRows": outcome.imported_rows,
        "printerConfig": outcome.printer_config,
    }))
}

pub fn import_print_job_file(persisted: &PersistedState, path: &Path) -> Result<Value, String> {
    validate_extension(path, &["lpj"])?;
    let body = read_bounded(path, MAX_PRINT_JOB_BYTES)?;
    let decoded = decode_push_body(persisted, &body).map_err(|error| error.to_string())?;
    let jobs = jobs_for_station(persisted, &decoded.value)?;
    let count = jobs.len();
    for job in jobs {
        process_print_job(persisted, &job)?;
    }
    decoded.persist_verified_token(persisted)?;
    Ok(json!({
        "success": true,
        "message": format!("Imported {count} job(s)"),
        "count": count,
    }))
}

fn jobs_for_station(persisted: &PersistedState, value: &Value) -> Result<Vec<Value>, String> {
    let station_uuid = persisted
        .load_identity()
        .and_then(|identity| {
            identity
                .get("station_uuid")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .ok_or_else(|| "Station identity not configured. Import identity file first.".to_owned())?;
    let root = value
        .as_object()
        .ok_or_else(|| "Invalid print job file: root must be an object".to_owned())?;
    match root.get("type").and_then(Value::as_str) {
        Some("PRINT_JOB") => {
            if let Some(station) = root.get("station").and_then(Value::as_object) {
                if let Some(file_uuid) = station.get("uuid").and_then(Value::as_str) {
                    if file_uuid != station_uuid {
                        let station_name = station
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or("unknown");
                        return Err(format!(
                            "Job file is for station \"{station_name}\" ({file_uuid}), not this station."
                        ));
                    }
                }
            }
            normalize_jobs(root.get("jobs"))
        }
        Some("PRINT_JOB_BUNDLE") => {
            let stations = root
                .get("stations")
                .and_then(Value::as_array)
                .ok_or_else(|| "Invalid PRINT_JOB_BUNDLE: missing stations array".to_owned())?;
            let station = stations
                .iter()
                .find(|entry| {
                    entry
                        .get("station")
                        .and_then(|station| station.get("uuid"))
                        .and_then(Value::as_str)
                        == Some(station_uuid.as_str())
                })
                .ok_or_else(|| {
                    format!("No jobs found for this station (UUID: {station_uuid}) in the bundle.")
                })?;
            normalize_jobs(station.get("jobs"))
        }
        Some(other) => Err(format!("Unknown print job file type: {other}")),
        None => Err("Unknown print job file type: missing type".to_owned()),
    }
}

fn normalize_jobs(value: Option<&Value>) -> Result<Vec<Value>, String> {
    let rows = value
        .and_then(Value::as_array)
        .ok_or_else(|| "Print job file has no jobs array".to_owned())?;
    let mut result = Vec::with_capacity(rows.len());
    for row in rows {
        let mut object = row
            .as_object()
            .cloned()
            .ok_or_else(|| "Print job entry must be an object".to_owned())?;
        object.insert("type".to_owned(), Value::String("PRINT_JOB".to_owned()));
        result.push(Value::Object(object));
    }
    Ok(result)
}

pub fn export_offline_report(persisted: &PersistedState, path: &Path) -> Result<Value, String> {
    validate_extension(path, &["lpr"])?;
    let report = build_report_payload(persisted)?;
    let blob = encrypt_report(persisted, &report)?;
    write_bytes_atomic(path, &blob)?;
    let printed = report
        .get("printed_labels")
        .and_then(Value::as_array)
        .map_or(0, Vec::len);
    let deleted = report
        .get("deleted_labels")
        .and_then(Value::as_array)
        .map_or(0, Vec::len);
    Ok(json!({
        "success": true,
        "message": "Data exported successfully",
        "path": path.display().to_string(),
        "printedCount": printed,
        "deletedCount": deleted,
    }))
}

pub fn default_report_filename(persisted: &PersistedState) -> String {
    let station = persisted
        .load_identity()
        .and_then(|identity| identity.get("station_number").and_then(value_as_string))
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "00".to_owned());
    let date = OffsetDateTime::now_utc()
        .date()
        .to_string()
        .replace('-', "");
    format!("report_{station}_{date}.lpr")
}

pub fn build_report_payload(persisted: &PersistedState) -> Result<Value, String> {
    let connection = open_database(persisted)?;
    let packs = query_rows(&connection, "SELECT * FROM pack ORDER BY id")?;
    let errors = query_rows(&connection, "SELECT * FROM print_errors ORDER BY id")?;
    let identity = persisted.load_identity().unwrap_or(Value::Null);
    let station_uuid = identity
        .get("station_uuid")
        .and_then(Value::as_str)
        .unwrap_or("nostation");

    let mut printed_labels = Vec::new();
    let mut deleted_labels = Vec::new();
    for pack in packs {
        let label = pack_to_report_label(station_uuid, &pack);
        let deleted = pack
            .get("status")
            .and_then(Value::as_str)
            .is_some_and(|status| status.eq_ignore_ascii_case("Deleted"))
            || pack.get("deleted_at").is_some_and(|value| !value.is_null());
        if deleted {
            deleted_labels.push(label);
        } else {
            printed_labels.push(label);
        }
    }

    let logs = errors
        .into_iter()
        .map(|error| {
            json!({
                "event_uid": error.get("event_uid").cloned().unwrap_or(Value::Null),
                "level": error.get("level").cloned().unwrap_or(Value::Null),
                "message": error.get("message").cloned().unwrap_or(Value::Null),
                "timestamp": error.get("created_at").cloned().unwrap_or(Value::Null),
            })
        })
        .collect::<Vec<_>>();

    Ok(json!({
        "station_uuid": identity.get("station_uuid").cloned().unwrap_or(Value::Null),
        "station_identity": identity,
        "printed_labels": printed_labels,
        "deleted_labels": deleted_labels,
        "logs": logs,
        "report_id": Uuid::new_v4().to_string(),
        "generated_at": now_rfc3339(),
    }))
}

fn pack_to_report_label(station_uuid: &str, pack: &Value) -> Value {
    let id = pack.get("id").and_then(Value::as_i64).unwrap_or_default();
    json!({
        "unique_id": format!("{station_uuid}-pack-{id}"),
        "pack_id": id,
        "product_id": pack.get("nomenclature_id").cloned().unwrap_or(Value::Null),
        "user_name": pack.get("operator_name").cloned().unwrap_or_else(|| Value::String(String::new())),
        "pack_name": pack.get("number").cloned().unwrap_or(Value::Null),
        "printed_at": pack.get("created_at").cloned().unwrap_or(Value::Null),
        "weight_netto_grams": kilograms_to_grams(pack.get("weight_netto")),
        "weight_brutto_grams": kilograms_to_grams(pack.get("weight_brutto")),
        "batch": pack.get("batch").cloned().unwrap_or(Value::Null),
        "production_date": pack.get("production_date").cloned().unwrap_or(Value::Null),
        "expiration_date": pack.get("expiration_date").cloned().unwrap_or(Value::Null),
        "barcode": pack.get("barcode_value").cloned().unwrap_or(Value::Null),
        "deleted_at": pack.get("deleted_at").cloned().unwrap_or(Value::Null),
    })
}

fn kilograms_to_grams(value: Option<&Value>) -> Value {
    value
        .and_then(value_as_f64)
        .map(|kilograms| Value::from((kilograms * 1000.0).round() as i64))
        .unwrap_or(Value::Null)
}

fn query_rows(connection: &rusqlite::Connection, sql: &str) -> Result<Vec<Value>, String> {
    let mut statement = connection
        .prepare(sql)
        .map_err(|error| format!("failed to prepare report query: {error}"))?;
    let column_names = statement
        .column_names()
        .into_iter()
        .map(str::to_owned)
        .collect::<Vec<_>>();
    let rows = statement
        .query_map([], |row| {
            let mut object = Map::new();
            for (index, name) in column_names.iter().enumerate() {
                object.insert(name.clone(), sqlite_value(row.get_ref(index)?));
            }
            Ok(Value::Object(object))
        })
        .map_err(|error| format!("failed to execute report query: {error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("failed to read report rows: {error}"))
}

fn sqlite_value(value: ValueRef<'_>) -> Value {
    match value {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(value) => Value::from(value),
        ValueRef::Real(value) => Value::from(value),
        ValueRef::Text(value) => Value::String(String::from_utf8_lossy(value).into_owned()),
        ValueRef::Blob(value) => Value::String(base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            value,
        )),
    }
}

pub fn export_usb_payload(path: &Path, data: Value) -> Result<Value, String> {
    let serialized = serde_json::to_vec(&data)
        .map_err(|error| format!("failed to serialize USB payload: {error}"))?;
    let checksum = hmac_hex(&serialized)?;
    let payload = json!({ "data": data, "checksum": checksum });
    let bytes = serde_json::to_vec_pretty(&payload)
        .map_err(|error| format!("failed to serialize USB envelope: {error}"))?;
    if bytes.len() as u64 > MAX_USB_BYTES {
        return Err("USB export exceeds the 64 MiB limit".to_owned());
    }
    write_bytes_atomic(path, &bytes)?;
    Ok(json!({ "success": true, "path": path.display().to_string() }))
}

pub fn import_usb_payload(path: &Path) -> Result<Value, String> {
    let bytes = read_bounded(path, MAX_USB_BYTES)?;
    let payload: Value =
        serde_json::from_slice(&bytes).map_err(|error| format!("Invalid USB JSON: {error}"))?;
    let data = payload
        .get("data")
        .cloned()
        .ok_or_else(|| "USB payload has no data field".to_owned())?;
    let checksum = payload
        .get("checksum")
        .and_then(Value::as_str)
        .ok_or_else(|| "USB payload has no checksum".to_owned())?;
    let serialized = serde_json::to_vec(&data)
        .map_err(|error| format!("failed to serialize USB payload: {error}"))?;
    let expected = hmac_hex(&serialized)?;
    if !constant_time_equal(checksum.as_bytes(), expected.as_bytes()) {
        return Err("Security check failed: File might be tampered".to_owned());
    }
    Ok(json!({ "success": true, "data": data }))
}

fn hmac_hex(bytes: &[u8]) -> Result<String, String> {
    let mut mac = HmacSha256::new_from_slice(USB_SYNC_KEY)
        .map_err(|_| "failed to initialize USB checksum".to_owned())?;
    mac.update(bytes);
    Ok(mac
        .finalize()
        .into_bytes()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

fn constant_time_equal(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        })
        == 0
}

fn read_bounded(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    let metadata = fs::metadata(path)
        .map_err(|error| format!("failed to inspect {}: {error}", path.display()))?;
    if !metadata.is_file() {
        return Err(format!("Not a file: {}", path.display()));
    }
    if metadata.len() > limit {
        return Err(format!(
            "File is too large: {} bytes (limit {limit})",
            metadata.len()
        ));
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    File::open(path)
        .and_then(|file| file.take(limit + 1).read_to_end(&mut bytes))
        .map_err(|error| format!("failed to read {}: {error}", path.display()))?;
    if bytes.len() as u64 > limit {
        return Err(format!("File exceeds the {limit}-byte limit"));
    }
    Ok(bytes)
}

fn write_bytes_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create {}: {error}", parent.display()))?;
    }
    let temporary = path.with_extension(format!(
        "{}.tmp",
        OffsetDateTime::now_utc().unix_timestamp_nanos()
    ));
    let mut file = File::create(&temporary)
        .map_err(|error| format!("failed to create {}: {error}", temporary.display()))?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("failed to write {}: {error}", temporary.display()))?;
    if path.exists() {
        fs::remove_file(path)
            .map_err(|error| format!("failed to replace {}: {error}", path.display()))?;
    }
    fs::rename(&temporary, path)
        .map_err(|error| format!("failed to publish {}: {error}", path.display()))
}

fn validate_extension(path: &Path, expected: &[&str]) -> Result<(), String> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if expected.iter().any(|candidate| *candidate == extension) {
        return Ok(());
    }
    Err(format!(
        "Unexpected file extension. Expected: {}",
        expected
            .iter()
            .map(|value| format!(".{value}"))
            .collect::<Vec<_>>()
            .join(", ")
    ))
}

fn clear_demo_flag(persisted: &PersistedState) {
    let _ = fs::remove_file(persisted.data_dir().join("demo.flag"));
}

pub fn is_demo_active(persisted: &PersistedState) -> bool {
    persisted.data_dir().join("demo.flag").is_file()
}

pub fn selected_path(payload: Option<&Value>) -> Option<PathBuf> {
    match payload {
        Some(Value::String(path)) if !path.trim().is_empty() => Some(PathBuf::from(path)),
        Some(Value::Object(object)) => object
            .get("path")
            .and_then(Value::as_str)
            .filter(|path| !path.trim().is_empty())
            .map(PathBuf::from),
        _ => None,
    }
}

fn value_as_string(value: &Value) -> Option<String> {
    match value {
        Value::String(value) => Some(value.clone()),
        Value::Number(value) => Some(value.to_string()),
        _ => None,
    }
}

fn value_as_f64(value: &Value) -> Option<f64> {
    match value {
        Value::Number(number) => number.as_f64(),
        Value::String(value) => value.parse().ok(),
        _ => None,
    }
}

fn now_rfc3339() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| OffsetDateTime::now_utc().unix_timestamp().to_string())
}

pub fn seed_demo_data(persisted: &PersistedState, client_version: &str) -> Result<Value, String> {
    let backup_path = persisted.data_dir().join("identity_pre_demo.json");
    if let Some(identity) = persisted.load_identity() {
        let is_demo = identity
            .get("station_uuid")
            .and_then(Value::as_str)
            .is_some_and(|uuid| uuid.starts_with("demo-"));
        if !is_demo && !backup_path.is_file() {
            let bytes = serde_json::to_vec_pretty(&identity)
                .map_err(|error| format!("failed to serialize identity backup: {error}"))?;
            write_bytes_atomic(&backup_path, &bytes)?;
        }
    }
    let _ = fs::remove_file(persisted.data_dir().join("identity.json"));

    let label_structure = json!({
        "version": 1,
        "canvas": { "width": 58, "height": 40, "labelType": "pack" },
        "elements": [
            { "type": "text", "x": 3, "y": 3, "width": 52, "height": 7, "text": "{{name}}", "fontSize": 4 },
            { "type": "text", "x": 3, "y": 12, "width": 30, "height": 5, "text": "Вес: {{weight}} кг", "fontSize": 3 },
            { "type": "barcode", "x": 4, "y": 20, "width": 50, "height": 15, "format": "code128", "value": "{{barcode}}" }
        ]
    });
    let fixture = json!({
        "station": {
            "uuid": "demo-0000-0000-0000-000000000001",
            "number": 0,
            "name": "Демо-станция",
            "server_url": "http://127.0.0.1:8000"
        },
        "meta": {
            "type": "demo",
            "generated_at": now_rfc3339(),
            "min_client_version": client_version
        },
        "payload": {
            "operators": [{
                "uuid": "demo-operator",
                "full_name": "Демо оператор",
                "short_code": "00",
                "pin_hash": null,
                "is_active": true
            }],
            "containers": [
                { "id": 1, "name": "Лоток", "weight": 0.015 },
                { "id": 2, "name": "Короб", "weight": 0.240 }
            ],
            "barcodes": [{
                "id": 1,
                "name": "Демо Code 128",
                "structure": { "type": "code128", "value": "{{article}}{{weight}}" }
            }],
            "labels": [{
                "id": 1,
                "name": "Демо этикетка 58×40",
                "structure": label_structure,
                "created_at": now_rfc3339(),
                "updated_at": now_rfc3339()
            }],
            "nomenclature": [
                { "id": 1, "name": "Сыр Российский 45%", "article": "460001", "exp_date": 30, "portion_container_id": 1, "box_container_id": 2, "templates_pack_label": 1, "close_box_counter": 8, "extra_data": {"price": 899}, "is_fixed_weight": false, "min_weight_grams": 50, "max_weight_grams": 5000 },
                { "id": 2, "name": "Колбаса Докторская", "article": "460002", "exp_date": 20, "portion_container_id": 1, "box_container_id": 2, "templates_pack_label": 1, "close_box_counter": 6, "extra_data": {"price": 549}, "is_fixed_weight": false, "min_weight_grams": 50, "max_weight_grams": 5000 },
                { "id": 3, "name": "Молоко 3,2%", "article": "460003", "exp_date": 7, "portion_container_id": 1, "box_container_id": 2, "templates_pack_label": 1, "close_box_counter": 12, "extra_data": {"price": 89}, "is_fixed_weight": true, "fixed_weight_grams": 1000 }
            ]
        }
    });
    let outcome = process_sync(persisted, client_version, &fixture)?;
    write_bytes_atomic(&persisted.data_dir().join("demo.flag"), b"1")?;
    Ok(json!({
        "success": true,
        "message": "Демо-данные загружены",
        "importedRows": outcome.imported_rows,
    }))
}

pub fn exit_demo_data(persisted: &PersistedState, client_version: &str) -> Result<Value, String> {
    let backup_path = persisted.data_dir().join("identity_pre_demo.json");
    let backup = if backup_path.is_file() {
        Some(
            serde_json::from_slice::<Value>(&read_bounded(&backup_path, 1024 * 1024)?)
                .map_err(|error| format!("failed to parse pre-demo identity: {error}"))?,
        )
    } else {
        None
    };
    let _ = fs::remove_file(persisted.data_dir().join("identity.json"));
    let _ = fs::remove_file(persisted.data_dir().join("demo.flag"));

    let restored = if let Some(identity) = backup {
        let station_uuid = identity
            .get("station_uuid")
            .and_then(Value::as_str)
            .ok_or_else(|| "pre-demo identity has no station_uuid".to_owned())?;
        let station_number = identity
            .get("station_number")
            .and_then(value_as_string)
            .unwrap_or_else(|| "00".to_owned());
        let fixture = json!({
            "station": {
                "uuid": station_uuid,
                "number": station_number,
                "name": identity.get("station_name").and_then(Value::as_str).unwrap_or(""),
                "server_url": identity.get("server_url").and_then(Value::as_str).unwrap_or("")
            },
            "meta": {
                "type": "demo_exit",
                "generated_at": now_rfc3339(),
                "min_client_version": client_version
            },
            "payload": {
                "operators": [], "containers": [], "barcodes": [], "labels": [], "nomenclature": []
            }
        });
        process_sync(persisted, client_version, &fixture)?;
        true
    } else {
        false
    };
    let _ = fs::remove_file(&backup_path);
    Ok(json!({
        "success": true,
        "restored": restored,
        "message": if restored { "Реальная идентификация восстановлена" } else { "Демо-режим завершён" },
    }))
}

pub fn clear_identity_files(persisted: &PersistedState) -> Result<(), String> {
    for name in [
        "identity.json",
        "license.token",
        "demo.flag",
        "identity_pre_demo.json",
        "report_state.json",
    ] {
        let path = persisted.data_dir().join(name);
        if path.is_file() {
            fs::remove_file(&path)
                .map_err(|error| format!("failed to remove {}: {error}", path.display()))?;
        }
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new(name: &str) -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos();
            let path = env::temp_dir().join(format!(
                "labelpilot-transfer-{name}-{}-{nonce}",
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

    fn sync_fixture(uuid: &str) -> Value {
        json!({
            "station": { "uuid": uuid, "number": 7, "name": "Fixture", "server_url": "http://127.0.0.1:8000" },
            "meta": { "type": "full_sync", "generated_at": "2026-08-14T00:00:00Z", "min_client_version": "1.3.16" },
            "payload": {
                "operators": [], "barcodes": [], "labels": [], "containers": [], "nomenclature": []
            }
        })
    }

    #[test]
    fn plain_identity_import_uses_the_transactional_processor() {
        let directory = TestDirectory::new("identity");
        let persisted = PersistedState::for_data_dir(directory.0.clone());
        let path = directory.0.join("station.lpi");
        fs::write(
            &path,
            serde_json::to_vec(&sync_fixture("station-a")).unwrap(),
        )
        .unwrap();
        let result = import_identity_file(&persisted, "1.3.16", &path).unwrap();
        assert_eq!(result["success"], true);
        assert_eq!(result["identity"]["station_uuid"], "station-a");
    }

    #[test]
    fn print_job_bundle_selects_only_the_current_station() {
        let directory = TestDirectory::new("print-job");
        let persisted = PersistedState::for_data_dir(directory.0.clone());
        let identity_path = directory.0.join("station.lpi");
        fs::write(
            &identity_path,
            serde_json::to_vec(&sync_fixture("station-a")).unwrap(),
        )
        .unwrap();
        import_identity_file(&persisted, "1.3.16", &identity_path).unwrap();
        let path = directory.0.join("jobs.lpj");
        fs::write(
            &path,
            serde_json::to_vec(&json!({
                "type": "PRINT_JOB_BUNDLE",
                "stations": [
                    { "station": { "uuid": "station-b" }, "jobs": [] },
                    { "station": { "uuid": "station-a" }, "jobs": [
                        { "job_id": 41, "nomenclature_id": 9, "nomenclature_name": "Product", "quantity": 2, "quantity_unit": "pcs" }
                    ] }
                ]
            }))
            .unwrap(),
        )
        .unwrap();
        let result = import_print_job_file(&persisted, &path).unwrap();
        assert_eq!(result["count"], 1);
    }

    #[test]
    fn usb_payload_round_trips_and_rejects_tampering() {
        let directory = TestDirectory::new("usb");
        let path = directory.0.join("transfer.json");
        let data = json!({ "products": [{"id": 1}], "templates": [], "timestamp": "now" });
        export_usb_payload(&path, data.clone()).unwrap();
        assert_eq!(import_usb_payload(&path).unwrap()["data"], data);

        let mut tampered: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        tampered["data"]["products"][0]["id"] = Value::from(2);
        fs::write(&path, serde_json::to_vec(&tampered).unwrap()).unwrap();
        assert!(import_usb_payload(&path).is_err());
    }

    #[test]
    fn extension_and_size_guards_are_explicit() {
        let directory = TestDirectory::new("guards");
        let path = directory.0.join("bad.txt");
        fs::write(&path, b"{}").unwrap();
        assert!(validate_extension(&path, &["lpi"]).is_err());
        assert_eq!(read_bounded(&path, 2).unwrap(), b"{}");
        assert!(read_bounded(&path, 1).is_err());
    }
}
