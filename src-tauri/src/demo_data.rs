//! Demo data: lets a prospect try the station without a LabelPilot server.
//!
//! Loading the demo replaces this station's catalogue with three sample products,
//! a 58×40 label template, containers and an operator, under a "demo-" station
//! identity; the real identity is kept aside and restored on exit. Labels printed
//! without a vendor licence carry the DEMO mark (demo_mark.rs), and the scale
//! simulator is allowed only on stations without a licence (persisted.rs), so the
//! demo cannot pass for production.
use crate::persisted::{atomic_write_bytes, PersistedState};
use crate::processor::{open_database, process_sync};
use serde_json::{json, Value};
use std::fs;
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

const DEMO_FLAG: &str = "demo.flag";
const PRE_DEMO_IDENTITY: &str = "identity_pre_demo.json";
const MAX_IDENTITY_BYTES: u64 = 1024 * 1024;

pub fn is_demo_active(persisted: &PersistedState) -> bool {
    persisted.data_dir().join(DEMO_FLAG).is_file()
}

/// A real sync or import replaced the demo: nothing is left to restore.
pub fn forget_demo(persisted: &PersistedState) {
    let _ = fs::remove_file(persisted.data_dir().join(DEMO_FLAG));
    let _ = fs::remove_file(persisted.data_dir().join(PRE_DEMO_IDENTITY));
}

/// Forgets this station's identity locally (identity.json and the station row
/// the identity lock reads), so the demo can take a station identity and give it
/// back. A user action on this computer, never a server push.
fn release_station_identity(persisted: &PersistedState) -> Result<(), String> {
    let _ = fs::remove_file(persisted.data_dir().join("identity.json"));
    if persisted.database_path().is_file() {
        let connection = open_database(persisted)?;
        let exists: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'station')",
                [],
                |row| row.get(0),
            )
            .map_err(|error| format!("failed to inspect station table: {error}"))?;
        if exists {
            connection
                .execute("DELETE FROM station", [])
                .map_err(|error| format!("failed to release station identity: {error}"))?;
        }
    }
    Ok(())
}

fn now_rfc3339() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| OffsetDateTime::now_utc().unix_timestamp().to_string())
}

pub fn seed_demo_data(persisted: &PersistedState, client_version: &str) -> Result<Value, String> {
    let backup_path = persisted.data_dir().join(PRE_DEMO_IDENTITY);
    if let Some(identity) = persisted.load_identity() {
        let is_demo = identity
            .get("station_uuid")
            .and_then(Value::as_str)
            .is_some_and(|uuid| uuid.starts_with("demo-"));
        if !is_demo && !backup_path.is_file() {
            let bytes = serde_json::to_vec_pretty(&identity)
                .map_err(|error| format!("failed to serialize identity backup: {error}"))?;
            atomic_write_bytes(&backup_path, &bytes)?;
        }
    }
    release_station_identity(persisted)?;

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
            // Empty: the demo keeps whatever server address is configured.
            "server_url": ""
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
    atomic_write_bytes(&persisted.data_dir().join(DEMO_FLAG), b"1")?;
    Ok(json!({
        "success": true,
        "message": "Демо-данные загружены",
        "importedRows": outcome.imported_rows,
    }))
}

fn value_as_string(value: &Value) -> Option<String> {
    match value {
        Value::String(value) => Some(value.clone()),
        Value::Number(value) => Some(value.to_string()),
        _ => None,
    }
}

pub fn exit_demo_data(persisted: &PersistedState, client_version: &str) -> Result<Value, String> {
    let backup_path = persisted.data_dir().join(PRE_DEMO_IDENTITY);
    let backup = if backup_path.is_file() {
        let size = fs::metadata(&backup_path)
            .map_err(|error| format!("failed to inspect pre-demo identity: {error}"))?
            .len();
        if size > MAX_IDENTITY_BYTES {
            return Err("pre-demo identity is too large".to_owned());
        }
        let bytes = fs::read(&backup_path)
            .map_err(|error| format!("failed to read pre-demo identity: {error}"))?;
        Some(
            serde_json::from_slice::<Value>(&bytes)
                .map_err(|error| format!("failed to parse pre-demo identity: {error}"))?,
        )
    } else {
        None
    };
    release_station_identity(persisted)?;
    let _ = fs::remove_file(persisted.data_dir().join(DEMO_FLAG));

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
        // No identity to return to: just empty the demo catalogue.
        let fixture = json!({
            "station": { "uuid": "demo-exit", "number": 0, "name": "", "server_url": "" },
            "meta": { "type": "demo_exit", "generated_at": now_rfc3339(), "min_client_version": client_version },
            "payload": { "operators": [], "containers": [], "barcodes": [], "labels": [], "nomenclature": [] }
        });
        process_sync(persisted, client_version, &fixture)?;
        release_station_identity(persisted)?;
        false
    };
    let _ = fs::remove_file(&backup_path);
    Ok(json!({
        "success": true,
        "restored": restored,
        "message": if restored { "Реальная идентификация восстановлена" } else { "Демо-режим завершён" },
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn state(name: &str) -> (PersistedState, PathBuf) {
        let path = std::env::temp_dir().join(format!(
            "labelpilot-demo-{name}-{}-{}",
            std::process::id(),
            OffsetDateTime::now_utc().unix_timestamp_nanos()
        ));
        fs::create_dir_all(&path).unwrap();
        (PersistedState::for_data_dir(path.clone()), path)
    }

    fn product_count(persisted: &PersistedState) -> i64 {
        let connection = rusqlite::Connection::open(persisted.database_path()).unwrap();
        connection
            .query_row("SELECT COUNT(*) FROM nomenclature", [], |row| row.get(0))
            .unwrap()
    }

    #[test]
    fn the_demo_loads_a_catalogue_and_leaves_without_a_trace() {
        let (persisted, path) = state("roundtrip");
        let version = env!("CARGO_PKG_VERSION");
        assert!(!is_demo_active(&persisted));
        seed_demo_data(&persisted, version).unwrap();
        assert!(is_demo_active(&persisted));
        assert_eq!(product_count(&persisted), 3);
        let identity = persisted.load_identity().unwrap();
        assert_eq!(identity["station_uuid"], "demo-0000-0000-0000-000000000001");

        let result = exit_demo_data(&persisted, version).unwrap();
        assert_eq!(result["restored"], false);
        assert!(!is_demo_active(&persisted));
        assert_eq!(product_count(&persisted), 0);
        assert!(persisted.load_identity().is_none());
        fs::remove_dir_all(path).ok();
    }

    #[test]
    fn a_real_station_identity_comes_back_after_the_demo() {
        let (persisted, path) = state("restore");
        let version = env!("CARGO_PKG_VERSION");
        persisted
            .save_identity(&json!({
                "station_uuid": "8b3f2c1e-0000-4000-8000-000000000042",
                "station_number": "07",
                "station_name": "Линия 7",
                "server_url": "http://192.168.1.10:8000"
            }))
            .unwrap();
        seed_demo_data(&persisted, version).unwrap();
        // Loading the demo twice keeps the first (real) identity aside.
        seed_demo_data(&persisted, version).unwrap();
        let result = exit_demo_data(&persisted, version).unwrap();
        assert_eq!(result["restored"], true);
        let identity = persisted.load_identity().unwrap();
        assert_eq!(identity["station_uuid"], "8b3f2c1e-0000-4000-8000-000000000042");
        assert_eq!(identity["station_name"], "Линия 7");
        fs::remove_dir_all(path).ok();
    }

    #[test]
    fn a_real_sync_forgets_the_demo() {
        let (persisted, path) = state("forget");
        seed_demo_data(&persisted, env!("CARGO_PKG_VERSION")).unwrap();
        forget_demo(&persisted);
        assert!(!is_demo_active(&persisted));
        assert!(!persisted.data_dir().join(PRE_DEMO_IDENTITY).exists());
        fs::remove_dir_all(path).ok();
    }
}
