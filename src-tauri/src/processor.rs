use crate::persisted::PersistedState;
use rusqlite::types::{Value as SqlValue, ValueRef};
use rusqlite::{params, Connection, Transaction};
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::fs;
use std::time::Duration;

const ARRAY_FIELDS: [&str; 12] = [
    "operators",
    "barcodes",
    "barcode_templates",
    "labels",
    "label_templates",
    "containers",
    "container",
    "nomenclature",
    "nomenclatures",
    "global_attributes",
    "product_pack_links",
    "packs",
];

#[derive(Debug)]
struct SyncEnvelope<'a> {
    station_uuid: &'a str,
    station_number: i64,
    station_name: &'a str,
    server_url: &'a str,
    payload: &'a Map<String, Value>,
    sync_type: &'a str,
    generated_at: &'a str,
    min_client_version: Option<&'a str>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncOutcome {
    pub sync_type: String,
    pub message: String,
    pub printer_config: Value,
    pub imported_rows: usize,
}

#[derive(Clone, Debug, Serialize)]
pub struct PrintJob {
    pub job_id: i64,
    pub nomenclature_id: i64,
    pub nomenclature_name: String,
    pub nomenclature_article: String,
    pub quantity: f64,
    pub quantity_unit: String,
    pub batch_number: String,
    pub marking_date: Option<String>,
}

pub fn process_sync(
    persisted: &PersistedState,
    client_version: &str,
    value: &Value,
) -> Result<SyncOutcome, String> {
    let envelope = validate_sync_envelope(value)?;
    check_compatibility(client_version, envelope.min_client_version)?;

    let padded_number = format!("{:02}", envelope.station_number);
    if let Some(identity) = persisted.load_identity() {
        if let Some(current_uuid) = identity.get("station_uuid").and_then(Value::as_str) {
            let current_number = identity
                .get("station_number")
                .and_then(value_as_string)
                .unwrap_or_default();
            if current_uuid != envelope.station_uuid || current_number != padded_number {
                return Err(format!(
                    "Идентификация станции заблокирована: текущая {} / {}, новая {} / {}.",
                    current_uuid, current_number, envelope.station_uuid, envelope.station_number
                ));
            }
        }
    }

    let mut connection = open_database(persisted)?;
    connection
        .execute_batch("PRAGMA foreign_keys = OFF;")
        .map_err(|error| format!("failed to suspend foreign key checks: {error}"))?;
    let import_result = (|| -> Result<usize, String> {
        let transaction = connection
            .transaction()
            .map_err(|error| format!("failed to begin sync transaction: {error}"))?;
        let count = import_master_data(&transaction, &envelope)?;
        transaction
            .commit()
            .map_err(|error| format!("failed to commit sync transaction: {error}"))?;
        Ok(count)
    })();
    let restore_result = connection
        .execute_batch("PRAGMA foreign_keys = ON;")
        .map_err(|error| format!("failed to restore foreign key checks: {error}"));
    let imported_rows = match (import_result, restore_result) {
        (Ok(count), Ok(())) => count,
        (Err(error), _) => return Err(error),
        (Ok(_), Err(error)) => return Err(error),
    };

    let identity = json!({
        "station_uuid": envelope.station_uuid,
        "station_number": padded_number,
        "station_name": envelope.station_name,
        "server_url": envelope.server_url,
        "last_sync_time": envelope.generated_at,
    });
    persisted.save_identity(&identity)?;

    let server_ip = extract_host(envelope.server_url);
    let printer_config = if server_ip.is_empty() {
        persisted.load_printer_config()
    } else {
        persisted.update_server_ip(&server_ip)?
    };

    Ok(SyncOutcome {
        sync_type: envelope.sync_type.to_owned(),
        message: format!("{} processed successfully.", envelope.sync_type),
        printer_config,
        imported_rows,
    })
}

pub fn process_print_job(persisted: &PersistedState, value: &Value) -> Result<PrintJob, String> {
    let object = value
        .as_object()
        .ok_or_else(|| "Invalid print job format: root must be an object".to_owned())?;
    if object.get("type").and_then(Value::as_str) != Some("PRINT_JOB") {
        return Err("Invalid print job format: expected type PRINT_JOB".to_owned());
    }

    let job = PrintJob {
        job_id: required_nonzero_integer(object, "job_id", "Job missing job_id")?,
        nomenclature_id: required_nonzero_integer(
            object,
            "nomenclature_id",
            "Job missing nomenclature_id",
        )?,
        nomenclature_name: optional_string(object.get("nomenclature_name")),
        nomenclature_article: optional_string(object.get("nomenclature_article")),
        quantity: object
            .get("quantity")
            .and_then(number_value)
            .ok_or_else(|| "Job quantity must be a number".to_owned())?,
        quantity_unit: if object.get("quantity_unit").and_then(Value::as_str) == Some("kg") {
            "kg".to_owned()
        } else {
            "pcs".to_owned()
        },
        batch_number: optional_string(object.get("batch_number")),
        marking_date: object
            .get("marking_date")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_owned),
    };
    if job.quantity <= 0.0 || !job.quantity.is_finite() {
        return Err("Job quantity must be positive".to_owned());
    }

    let connection = open_database(persisted)?;
    connection
        .execute(
            r#"
            INSERT OR REPLACE INTO print_jobs (
                job_id, nomenclature_id, nomenclature_name, nomenclature_article,
                quantity, quantity_unit, batch_number, marking_date, printed_qty, status
            )
            VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8,
                COALESCE((SELECT printed_qty FROM print_jobs WHERE job_id = ?1), 0),
                COALESCE((SELECT status FROM print_jobs WHERE job_id = ?1 AND status = 'completed'), 'pending')
            )
            "#,
            params![
                job.job_id,
                job.nomenclature_id,
                job.nomenclature_name,
                nullable_text(&job.nomenclature_article),
                job.quantity,
                job.quantity_unit,
                nullable_text(&job.batch_number),
                job.marking_date,
            ],
        )
        .map_err(|error| format!("failed to persist print job #{}: {error}", job.job_id))?;
    Ok(job)
}

pub fn export_full_snapshot(persisted: &PersistedState) -> Result<Value, String> {
    let connection = open_database(persisted)?;
    Ok(json!({
        "barcodes": query_table(&connection, "barcodes")?,
        "labels": query_table(&connection, "labels")?,
        "containers": query_table(&connection, "container")?,
        "nomenclature": query_table(&connection, "nomenclature")?,
        "packs": query_table(&connection, "pack")?,
    }))
}

fn validate_sync_envelope(value: &Value) -> Result<SyncEnvelope<'_>, String> {
    let root = value
        .as_object()
        .ok_or_else(|| "Invalid unified data format: root must be an object.".to_owned())?;
    let station = required_object(root, "station")?;
    let payload = required_object(root, "payload")?;
    let meta = required_object(root, "meta")?;

    let station_uuid = required_string(station, "uuid")?;
    let station_number = station
        .get("number")
        .and_then(integer_value)
        .ok_or_else(|| {
            "Invalid unified data format: 'station.number' must be an integer or numeric string."
                .to_owned()
        })?;
    let station_name = required_string(station, "name")?;
    let server_url = required_string(station, "server_url")?;
    let sync_type = required_string(meta, "type")?;
    let generated_at = required_string(meta, "generated_at")?;

    for field in ARRAY_FIELDS {
        if let Some(rows) = payload.get(field) {
            if !rows.is_array() {
                return Err(format!(
                    "Invalid unified data format: 'payload.{field}' must be an array when present."
                ));
            }
        }
    }
    for field in ["format_version", "server_version", "min_client_version"] {
        if let Some(item) = meta.get(field) {
            if !item.is_string() {
                return Err(format!(
                    "Invalid unified data format: 'meta.{field}' must be a string when present."
                ));
            }
        }
    }

    Ok(SyncEnvelope {
        station_uuid,
        station_number,
        station_name,
        server_url,
        payload,
        sync_type,
        generated_at,
        min_client_version: meta.get("min_client_version").and_then(Value::as_str),
    })
}

fn required_object<'a>(
    parent: &'a Map<String, Value>,
    key: &str,
) -> Result<&'a Map<String, Value>, String> {
    parent
        .get(key)
        .and_then(Value::as_object)
        .ok_or_else(|| format!("Invalid unified data format: '{key}' must be an object."))
}

fn required_string<'a>(parent: &'a Map<String, Value>, key: &str) -> Result<&'a str, String> {
    parent
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("Invalid unified data format: '{key}' must be a string."))
}

fn check_compatibility(client_version: &str, minimum: Option<&str>) -> Result<(), String> {
    let Some(minimum) = minimum.filter(|value| !value.is_empty()) else {
        return Ok(());
    };
    if semver_lt(client_version, minimum) {
        return Err(format!(
            "Версия клиента {client_version} устарела. Минимальная совместимая версия: {minimum}. Обновите LabelPilot перед синхронизацией."
        ));
    }
    Ok(())
}

fn semver_lt(left: &str, right: &str) -> bool {
    let parse = |value: &str| {
        let mut parts = value.trim_start_matches('v').split('.');
        [
            parts.next().and_then(|part| part.parse().ok()).unwrap_or(0),
            parts.next().and_then(|part| part.parse().ok()).unwrap_or(0),
            parts
                .next()
                .and_then(|part| part.split(['-', '+']).next())
                .and_then(|part| part.parse().ok())
                .unwrap_or(0),
        ]
    };
    parse(left) < parse(right)
}

pub(crate) fn open_database(persisted: &PersistedState) -> Result<Connection, String> {
    let path = persisted.database_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "failed to create database directory {}: {error}",
                parent.display()
            )
        })?;
    }
    let connection = Connection::open(&path)
        .map_err(|error| format!("failed to open database {}: {error}", path.display()))?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(|error| format!("failed to set SQLite busy timeout: {error}"))?;
    connection
        .execute_batch(
            r#"
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = NORMAL;
            PRAGMA temp_store = MEMORY;
            PRAGMA foreign_keys = ON;

            CREATE TABLE IF NOT EXISTS station (
                uuid TEXT PRIMARY KEY NOT NULL, number INTEGER, name TEXT,
                server_url TEXT, last_sync_time DATETIME
            );
            CREATE TABLE IF NOT EXISTS nomenclature (
                id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, article TEXT,
                exp_date INTEGER NOT NULL, portion_container_id INTEGER,
                box_container_id INTEGER, templates_pack_label INTEGER,
                templates_box_label INTEGER, templates_pallet_label INTEGER,
                close_box_counter INTEGER, extra_data TEXT,
                is_fixed_weight INTEGER DEFAULT 0, fixed_weight_grams REAL DEFAULT 0,
                min_weight_grams REAL DEFAULT 0, max_weight_grams REAL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS container (
                id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, weight REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS operators (
                uuid TEXT PRIMARY KEY NOT NULL, full_name TEXT NOT NULL DEFAULT '',
                short_code TEXT, pin_hash TEXT, is_active INTEGER NOT NULL DEFAULT 1
            );
            CREATE TABLE IF NOT EXISTS barcodes (
                id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
                structure TEXT NOT NULL UNIQUE
            );
            CREATE TABLE IF NOT EXISTS labels (
                id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
                structure TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME
            );
            CREATE TABLE IF NOT EXISTS pallet (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                number TEXT NOT NULL UNIQUE,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME,
                status TEXT NOT NULL DEFAULT 'Open',
                weight REAL,
                weight_netto REAL,
                weight_brutto REAL
            );
            CREATE TABLE IF NOT EXISTS boxes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                pallete_id INTEGER NOT NULL REFERENCES pallet(id),
                number TEXT NOT NULL UNIQUE,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME,
                status TEXT NOT NULL DEFAULT 'Open',
                weight_netto REAL,
                weight_brutto REAL,
                nomenclature_id INTEGER REFERENCES nomenclature(id)
            );
            CREATE TABLE IF NOT EXISTS pack (
                id INTEGER PRIMARY KEY AUTOINCREMENT, number TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                box_id INTEGER NOT NULL REFERENCES boxes(id),
                nomenclature_id INTEGER NOT NULL REFERENCES nomenclature(id),
                weight_netto REAL NOT NULL,
                weight_brutto REAL NOT NULL, barcode_value TEXT, station_number TEXT,
                status TEXT NOT NULL, production_date TEXT, expiration_date TEXT,
                batch TEXT, operator_uuid TEXT, operator_name TEXT, deleted_at TEXT
            );
            CREATE TABLE IF NOT EXISTS print_errors (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                event_uid TEXT NOT NULL,
                level TEXT NOT NULL DEFAULT 'ERROR',
                message TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS print_jobs (
                id INTEGER PRIMARY KEY AUTOINCREMENT, job_id INTEGER NOT NULL UNIQUE,
                nomenclature_id INTEGER NOT NULL, nomenclature_name TEXT NOT NULL,
                nomenclature_article TEXT, quantity REAL NOT NULL,
                quantity_unit TEXT NOT NULL DEFAULT 'pcs', batch_number TEXT,
                printed_qty REAL NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP, completed_at DATETIME,
                marking_date TEXT
            );

            CREATE TABLE IF NOT EXISTS printer_delivery_jobs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                job_id TEXT NOT NULL UNIQUE,
                state TEXT NOT NULL CHECK(state IN ('queued','rendering','sending','accepted','uncertain','failed','cancelled')),
                printer_id TEXT NOT NULL,
                printer_name TEXT NOT NULL DEFAULT '',
                physical_key TEXT NOT NULL,
                protocol TEXT NOT NULL,
                connection TEXT NOT NULL,
                idempotency_key TEXT,
                fingerprint TEXT NOT NULL,
                config_json TEXT NOT NULL,
                action_kind TEXT NOT NULL,
                action_json TEXT NOT NULL,
                payload BLOB NOT NULL,
                payload_bytes INTEGER NOT NULL,
                attempt_count INTEGER NOT NULL DEFAULT 0,
                created_at_ms INTEGER NOT NULL,
                updated_at_ms INTEGER NOT NULL,
                accepted_at_ms INTEGER,
                last_error TEXT,
                receipt_json TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_printer_delivery_state_created
                ON printer_delivery_jobs(state, created_at_ms DESC);
            CREATE INDEX IF NOT EXISTS idx_printer_delivery_idempotency
                ON printer_delivery_jobs(physical_key, idempotency_key, created_at_ms DESC);
            CREATE INDEX IF NOT EXISTS idx_pack_box_status ON pack(box_id, status);
            CREATE INDEX IF NOT EXISTS idx_boxes_nom_status ON boxes(nomenclature_id, status);
            CREATE INDEX IF NOT EXISTS idx_boxes_pallet_status ON boxes(pallete_id, status);
            CREATE INDEX IF NOT EXISTS idx_nomenclature_name ON nomenclature(name);
            "#,
        )
        .map_err(|error| format!("failed to initialize sync schema: {error}"))?;

    ensure_column(
        &connection,
        "nomenclature",
        "templates_pallet_label",
        "INTEGER",
    )?;
    ensure_column(
        &connection,
        "nomenclature",
        "is_fixed_weight",
        "INTEGER DEFAULT 0",
    )?;
    ensure_column(
        &connection,
        "nomenclature",
        "fixed_weight_grams",
        "REAL DEFAULT 0",
    )?;
    ensure_column(
        &connection,
        "nomenclature",
        "min_weight_grams",
        "REAL DEFAULT 0",
    )?;
    ensure_column(
        &connection,
        "nomenclature",
        "max_weight_grams",
        "REAL DEFAULT 0",
    )?;
    ensure_column(&connection, "print_jobs", "marking_date", "TEXT")?;
    ensure_column(&connection, "pack", "operator_uuid", "TEXT")?;
    ensure_column(&connection, "pack", "operator_name", "TEXT")?;
    ensure_column(&connection, "pack", "deleted_at", "TEXT")?;
    connection
        .execute_batch(include_str!("operational_counters.sql"))
        .map_err(|error| format!("failed to initialize operational counters: {error}"))?;
    Ok(connection)
}

fn ensure_column(
    connection: &Connection,
    table: &str,
    column: &str,
    declaration: &str,
) -> Result<(), String> {
    let pragma = format!("PRAGMA table_info({table})");
    let mut statement = connection
        .prepare(&pragma)
        .map_err(|error| format!("failed to inspect {table}: {error}"))?;
    let exists = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| format!("failed to read {table} columns: {error}"))?
        .filter_map(Result::ok)
        .any(|name| name == column);
    drop(statement);
    if !exists {
        connection
            .execute_batch(&format!(
                "ALTER TABLE {table} ADD COLUMN {column} {declaration}"
            ))
            .map_err(|error| format!("failed to add {table}.{column}: {error}"))?;
    }
    Ok(())
}

fn import_master_data(
    transaction: &Transaction<'_>,
    envelope: &SyncEnvelope<'_>,
) -> Result<usize, String> {
    transaction
        .execute_batch(
            r#"
            DELETE FROM nomenclature;
            DELETE FROM container;
            DELETE FROM barcodes;
            DELETE FROM labels;
            DELETE FROM operators;
            DELETE FROM station;
            "#,
        )
        .map_err(|error| format!("failed to clear server-owned tables: {error}"))?;

    transaction
        .execute(
            "INSERT INTO station (uuid, number, name, server_url, last_sync_time) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                envelope.station_uuid, envelope.station_number, envelope.station_name,
                envelope.server_url, envelope.generated_at
            ],
        )
        .map_err(|error| format!("failed to update station identity: {error}"))?;

    let mut inserted = 0;
    inserted += import_nomenclature(transaction, envelope.payload.get("nomenclature"))?;
    inserted += import_containers(
        transaction,
        envelope
            .payload
            .get("containers")
            .or_else(|| envelope.payload.get("container")),
    )?;
    inserted += import_barcodes(transaction, envelope.payload.get("barcodes"))?;
    inserted += import_labels(transaction, envelope.payload.get("labels"))?;
    inserted += import_operators(transaction, envelope.payload.get("operators"))?;

    if let Some(station_number) = envelope.payload.get("station_number") {
        transaction
            .execute(
                "UPDATE station SET number = ?1",
                params![primitive(station_number)],
            )
            .map_err(|error| format!("failed to update payload station_number: {error}"))?;
    }
    Ok(inserted)
}

fn import_nomenclature(
    transaction: &Transaction<'_>,
    rows: Option<&Value>,
) -> Result<usize, String> {
    let Some(rows) = rows.and_then(Value::as_array) else {
        return Ok(0);
    };
    let mut statement = transaction
        .prepare_cached(
            r#"
            INSERT INTO nomenclature (
                id, name, article, exp_date, portion_container_id, box_container_id,
                templates_pack_label, templates_box_label, templates_pallet_label,
                close_box_counter, extra_data, is_fixed_weight, fixed_weight_grams,
                min_weight_grams, max_weight_grams
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
            "#,
        )
        .map_err(|error| format!("failed to prepare nomenclature import: {error}"))?;
    let mut inserted = 0;
    for row in rows {
        let Some(item) = row.as_object() else {
            continue;
        };
        let extra_data = match item.get("extra_data") {
            Some(Value::String(value)) => value.clone(),
            Some(value) => serde_json::to_string(value).unwrap_or_else(|_| "{}".to_owned()),
            None => "{}".to_owned(),
        };
        let result = statement.execute(params![
            primitive_field(item, "id"),
            primitive_field(item, "name"),
            primitive_field(item, "article"),
            primitive_or_integer(item.get("exp_date"), 0),
            primitive_alias(item, "portion_container_id", "portion_container"),
            primitive_alias(item, "box_container_id", "box_container"),
            primitive_field(item, "templates_pack_label"),
            primitive_field(item, "templates_box_label"),
            primitive_field(item, "templates_pallet_label"),
            primitive_or_integer(item.get("close_box_counter"), 0),
            extra_data,
            bool_integer(item.get("is_fixed_weight"), false),
            primitive_or_integer(item.get("fixed_weight_grams"), 0),
            primitive_or_integer(item.get("min_weight_grams"), 0),
            primitive_or_integer(item.get("max_weight_grams"), 0),
        ]);
        if result.is_ok() {
            inserted += 1;
        }
    }
    Ok(inserted)
}

fn import_containers(transaction: &Transaction<'_>, rows: Option<&Value>) -> Result<usize, String> {
    let Some(rows) = rows.and_then(Value::as_array) else {
        return Ok(0);
    };
    let mut statement = transaction
        .prepare_cached("INSERT INTO container (id, name, weight) VALUES (?1, ?2, ?3)")
        .map_err(|error| format!("failed to prepare container import: {error}"))?;
    let mut inserted = 0;
    for row in rows {
        let Some(item) = row.as_object() else {
            continue;
        };
        if statement
            .execute(params![
                primitive_field(item, "id"),
                primitive_field(item, "name"),
                primitive_or_integer(item.get("weight"), 0),
            ])
            .is_ok()
        {
            inserted += 1;
        }
    }
    Ok(inserted)
}

fn import_barcodes(transaction: &Transaction<'_>, rows: Option<&Value>) -> Result<usize, String> {
    let Some(rows) = rows.and_then(Value::as_array) else {
        return Ok(0);
    };
    let mut statement = transaction
        .prepare_cached("INSERT OR REPLACE INTO barcodes (id, name, structure) VALUES (?1, ?2, ?3)")
        .map_err(|error| format!("failed to prepare barcode import: {error}"))?;
    let mut inserted = 0;
    for row in rows {
        let Some(item) = row.as_object() else {
            continue;
        };
        let Some(structure) = structure_text(item.get("structure")) else {
            continue;
        };
        if statement
            .execute(params![
                primitive_field(item, "id"),
                primitive_field(item, "name"),
                structure
            ])
            .is_ok()
        {
            inserted += 1;
        }
    }
    Ok(inserted)
}

fn import_labels(transaction: &Transaction<'_>, rows: Option<&Value>) -> Result<usize, String> {
    let Some(rows) = rows.and_then(Value::as_array) else {
        return Ok(0);
    };
    let mut statement = transaction
        .prepare_cached(
            "INSERT OR REPLACE INTO labels (id, name, structure, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        )
        .map_err(|error| format!("failed to prepare label import: {error}"))?;
    let mut inserted = 0;
    for row in rows {
        let Some(item) = row.as_object() else {
            continue;
        };
        let Some(structure) = structure_text(item.get("structure")) else {
            continue;
        };
        if statement
            .execute(params![
                primitive_field(item, "id"),
                primitive_field(item, "name"),
                structure,
                primitive_field(item, "created_at"),
                primitive_field(item, "updated_at"),
            ])
            .is_ok()
        {
            inserted += 1;
        }
    }
    Ok(inserted)
}

fn import_operators(transaction: &Transaction<'_>, rows: Option<&Value>) -> Result<usize, String> {
    let Some(rows) = rows.and_then(Value::as_array) else {
        return Ok(0);
    };
    let mut statement = transaction
        .prepare_cached(
            "INSERT OR REPLACE INTO operators (uuid, full_name, short_code, pin_hash, is_active) VALUES (?1, ?2, ?3, ?4, ?5)",
        )
        .map_err(|error| format!("failed to prepare operator import: {error}"))?;
    let mut inserted = 0;
    for row in rows {
        let Some(item) = row.as_object() else {
            continue;
        };
        let uuid = primitive_field(item, "uuid");
        if matches!(uuid, SqlValue::Null) {
            continue;
        }
        if statement
            .execute(params![
                uuid,
                primitive_field(item, "full_name"),
                primitive_field(item, "short_code"),
                primitive_field(item, "pin_hash"),
                bool_integer(item.get("is_active"), true),
            ])
            .is_ok()
        {
            inserted += 1;
        }
    }
    Ok(inserted)
}

fn query_table(connection: &Connection, table: &str) -> Result<Vec<Value>, String> {
    let mut statement = connection
        .prepare(&format!("SELECT * FROM {table}"))
        .map_err(|error| format!("failed to prepare {table} export: {error}"))?;
    let names: Vec<String> = statement
        .column_names()
        .into_iter()
        .map(str::to_owned)
        .collect();
    let rows = statement
        .query_map([], |row| {
            let mut object = Map::with_capacity(names.len());
            for (index, name) in names.iter().enumerate() {
                object.insert(name.clone(), sql_json(row.get_ref(index)?));
            }
            Ok(Value::Object(object))
        })
        .map_err(|error| format!("failed to query {table}: {error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("failed to export {table}: {error}"))
}

fn sql_json(value: ValueRef<'_>) -> Value {
    match value {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(value) => Value::from(value),
        ValueRef::Real(value) => Value::from(value),
        ValueRef::Text(value) => Value::String(String::from_utf8_lossy(value).into_owned()),
        ValueRef::Blob(value) => Value::Array(value.iter().copied().map(Value::from).collect()),
    }
}

fn primitive_field(object: &Map<String, Value>, key: &str) -> SqlValue {
    object.get(key).map(primitive).unwrap_or(SqlValue::Null)
}

fn primitive_alias(object: &Map<String, Value>, primary: &str, fallback: &str) -> SqlValue {
    let first = object.get(primary).map(primitive).unwrap_or(SqlValue::Null);
    if matches!(first, SqlValue::Null) {
        object
            .get(fallback)
            .map(primitive)
            .unwrap_or(SqlValue::Null)
    } else {
        first
    }
}

fn primitive(value: &Value) -> SqlValue {
    match value {
        Value::Null => SqlValue::Null,
        Value::Bool(value) => SqlValue::Integer(i64::from(*value)),
        Value::Number(value) => value
            .as_i64()
            .map(SqlValue::Integer)
            .or_else(|| value.as_f64().map(SqlValue::Real))
            .unwrap_or(SqlValue::Null),
        Value::String(value) => SqlValue::Text(value.clone()),
        Value::Object(object) => object.get("id").map(primitive).unwrap_or(SqlValue::Null),
        Value::Array(_) => SqlValue::Null,
    }
}

fn primitive_or_integer(value: Option<&Value>, fallback: i64) -> SqlValue {
    match value.map(primitive) {
        Some(SqlValue::Null) | None => SqlValue::Integer(fallback),
        Some(value) => value,
    }
}

fn bool_integer(value: Option<&Value>, fallback: bool) -> i64 {
    i64::from(value.and_then(Value::as_bool).unwrap_or(fallback))
}

fn structure_text(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::String(value)) if !value.is_empty() => Some(value.clone()),
        Some(value) => serde_json::to_string(value).ok(),
        None => None,
    }
}

fn integer_value(value: &Value) -> Option<i64> {
    match value {
        Value::Number(number) => number
            .as_i64()
            .or_else(|| number.as_u64().and_then(|value| i64::try_from(value).ok())),
        Value::String(value)
            if !value.trim().is_empty()
                && value.trim().bytes().all(|byte| byte.is_ascii_digit()) =>
        {
            value.trim().parse().ok()
        }
        _ => None,
    }
}

fn number_value(value: &Value) -> Option<f64> {
    match value {
        Value::Number(number) => number.as_f64(),
        Value::String(value) => value.parse().ok(),
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

fn required_nonzero_integer(
    object: &Map<String, Value>,
    field: &str,
    error: &str,
) -> Result<i64, String> {
    object
        .get(field)
        .and_then(integer_value)
        .filter(|value| *value != 0)
        .ok_or_else(|| error.to_owned())
}

fn optional_string(value: Option<&Value>) -> String {
    value.and_then(Value::as_str).unwrap_or_default().to_owned()
}

fn nullable_text(value: &str) -> Option<&str> {
    (!value.is_empty()).then_some(value)
}

fn extract_host(value: &str) -> String {
    let without_scheme = value
        .strip_prefix("http://")
        .or_else(|| value.strip_prefix("https://"))
        .unwrap_or(value);
    let authority = without_scheme.split('/').next().unwrap_or_default();
    if let Some(ipv6) = authority.strip_prefix('[') {
        return ipv6.split(']').next().unwrap_or_default().trim().to_owned();
    }
    authority
        .split(':')
        .next()
        .unwrap_or_default()
        .trim()
        .to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;
    use std::env;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new(name: &str) -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos();
            let path = env::temp_dir().join(format!(
                "labelpilot-processor-{name}-{}-{nonce}",
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

    fn sync_data(uuid: &str, number: Value) -> Value {
        json!({
            "station": {
                "uuid": uuid, "number": number, "name": "Test station",
                "server_url": "http://192.0.2.9:8000/api/v1"
            },
            "payload": {
                "operators": [{"uuid": "operator-1", "full_name": "Operator", "is_active": true}],
                "barcodes": [{"id": 10, "name": "GS1", "structure": {"type": "code128"}}],
                "labels": [{"id": 20, "name": "Label", "structure": {"width": 80}}],
                "containers": [{"id": 30, "name": "Tray", "weight": 12.5}],
                "nomenclature": [{
                    "id": 40, "name": "Product", "article": "A-40",
                    "exp_date": 10, "extra_data": {"origin": "test"}
                }]
            },
            "meta": {
                "type": "FULL_SYNC", "generated_at": "2026-08-13T10:00:00Z",
                "min_client_version": "1.3.0"
            }
        })
    }

    #[test]
    fn imports_sync_transactionally_and_locks_identity() {
        let directory = TestDirectory::new("sync");
        let persisted = PersistedState::for_data_dir(directory.0.clone());
        let outcome = process_sync(&persisted, "1.3.16", &sync_data("station-a", json!("7")))
            .expect("sync import");
        assert_eq!(outcome.imported_rows, 5);
        assert_eq!(
            persisted.load_identity().unwrap()["station_number"],
            json!("07")
        );
        assert_eq!(
            persisted.load_printer_config()["serverIp"],
            json!("192.0.2.9")
        );

        let connection = Connection::open(persisted.database_path()).expect("open database");
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM nomenclature", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1);
        connection.execute_batch(
            "PRAGMA foreign_keys = ON;
             CREATE TABLE sync_reference (id INTEGER PRIMARY KEY, nomenclature_id INTEGER REFERENCES nomenclature(id));
             INSERT INTO sync_reference (id, nomenclature_id) VALUES (1, 40);"
        ).unwrap();
        drop(connection);
        process_sync(&persisted, "1.3.16", &sync_data("station-a", json!(7)))
            .expect("reimport with operational foreign-key references");

        let error = process_sync(
            &persisted,
            "1.3.16",
            &sync_data("different-station", json!(7)),
        )
        .unwrap_err();
        assert!(error.contains("заблокирована"));
    }

    #[test]
    fn preserves_completed_print_job_progress_on_replacement() {
        let directory = TestDirectory::new("jobs");
        let persisted = PersistedState::for_data_dir(directory.0.clone());
        let first = json!({
            "type": "PRINT_JOB", "job_id": 500, "nomenclature_id": 40,
            "nomenclature_name": "Product", "quantity": 20, "quantity_unit": "kg"
        });
        process_print_job(&persisted, &first).expect("first job");
        let connection = Connection::open(persisted.database_path()).expect("open database");
        connection
            .execute(
                "UPDATE print_jobs SET printed_qty = ?1, status = 'completed' WHERE job_id = 500",
                params![20.0],
            )
            .unwrap();
        drop(connection);

        let replacement = json!({
            "type": "PRINT_JOB", "job_id": 500, "nomenclature_id": 40,
            "nomenclature_name": "Product updated", "quantity": 25, "quantity_unit": "pcs"
        });
        let job = process_print_job(&persisted, &replacement).expect("replacement");
        assert_eq!(job.quantity_unit, "pcs");

        let connection = Connection::open(persisted.database_path()).expect("open database");
        let state: (f64, String, f64) = connection
            .query_row(
                "SELECT printed_qty, status, quantity FROM print_jobs WHERE job_id = 500",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(state, (20.0, "completed".to_owned(), 25.0));
    }

    #[test]
    fn rejects_incompatible_or_malformed_sync_before_import() {
        let directory = TestDirectory::new("validation");
        let persisted = PersistedState::for_data_dir(directory.0.clone());
        let mut data = sync_data("station-a", json!(1));
        data["meta"]["min_client_version"] = json!("9.0.0");
        assert!(process_sync(&persisted, "1.3.16", &data)
            .unwrap_err()
            .contains("устарела"));
        assert!(!persisted.database_path().exists());

        let malformed = json!({"station": {}, "payload": [], "meta": {}});
        assert!(validate_sync_envelope(&malformed).is_err());
    }
}
