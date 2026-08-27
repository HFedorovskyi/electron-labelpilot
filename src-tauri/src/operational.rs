use crate::barcode::generate_barcode;
use crate::persisted::PersistedState;
use rusqlite::types::{Value as SqlValue, ValueRef};
use rusqlite::{params, params_from_iter, Connection, ErrorCode, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

#[derive(Clone)]
pub struct OperationalState {
    connection: Arc<Mutex<Connection>>,
}

impl OperationalState {
    pub fn new(persisted: &PersistedState) -> Result<Self, String> {
        Ok(Self {
            connection: Arc::new(Mutex::new(crate::processor::open_database(persisted)?)),
        })
    }

    pub fn reset_database(&self) -> Result<(), String> {
        self.with_connection(|connection| {
            connection
                .execute_batch(
                    r#"
                    PRAGMA foreign_keys = OFF;
                    BEGIN IMMEDIATE;
                    DELETE FROM pack;
                    DELETE FROM boxes;
                    DELETE FROM pallet;
                    DELETE FROM print_jobs;
                    DELETE FROM printer_delivery_jobs;
                    DELETE FROM print_errors;
                    DELETE FROM operators;
                    DELETE FROM nomenclature;
                    DELETE FROM container;
                    DELETE FROM barcodes;
                    DELETE FROM labels;
                    DELETE FROM station;
                    DELETE FROM sqlite_sequence;
                    COMMIT;
                    PRAGMA foreign_keys = ON;
                    PRAGMA wal_checkpoint(TRUNCATE);
                    "#,
                )
                .map_err(|error| format!("failed to reset operational database: {error}"))?;
            Ok(())
        })
    }

    fn with_connection<T>(
        &self,
        operation: impl FnOnce(&mut Connection) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| "operational database lock is poisoned".to_owned())?;
        operation(&mut connection)
    }

    pub fn products(
        &self,
        search: Option<&str>,
        fixed_weight_only: bool,
    ) -> Result<Vec<Value>, String> {
        let search = search.unwrap_or_default().trim();
        let search: String = search.chars().take(256).collect();
        self.with_connection(|connection| {
            let fixed_clause = if fixed_weight_only {
                "WHERE n.is_fixed_weight = 1"
            } else {
                ""
            };
            let joins = "LEFT JOIN container pc ON n.portion_container_id = pc.id \
                         LEFT JOIN container bc ON n.box_container_id = bc.id \
                         LEFT JOIN labels pack_label ON n.templates_pack_label = pack_label.id \
                         LEFT JOIN labels box_label ON n.templates_box_label = box_label.id \
                         LEFT JOIN labels pallet_label ON n.templates_pallet_label = pallet_label.id";
            let columns = "n.*, \
                           pc.weight AS portion_weight, pc.name AS portion_container_name, \
                           bc.weight AS box_weight, bc.name AS box_container_name, \
                           pack_label.name AS pack_label_name, \
                           box_label.name AS box_label_name, \
                           pallet_label.name AS pallet_label_name";
            if search.is_empty() {
                query_all_json(
                    connection,
                    &format!(
                        "SELECT {columns} FROM nomenclature n {joins} \
                         {fixed_clause} ORDER BY n.name COLLATE NOCASE ASC LIMIT 50"
                    ),
                    &[],
                )
            } else {
                let search_clause = if fixed_weight_only { "AND" } else { "WHERE" };
                query_all_json(
                    connection,
                    &format!(
                        "SELECT {columns} FROM nomenclature n {joins} \
                         {fixed_clause} {search_clause} (n.name LIKE ?1 OR n.article LIKE ?1) \
                         ORDER BY n.name COLLATE NOCASE ASC LIMIT 50"
                    ),
                    &[SqlValue::Text(format!("%{search}%"))],
                )
            }
        })
    }

    #[cfg(feature = "slint-ui")]
    pub fn product_count(
        &self,
        search: Option<&str>,
        fixed_weight_only: bool,
    ) -> Result<i64, String> {
        let search = search.unwrap_or_default().trim();
        let search: String = search.chars().take(256).collect();
        self.with_connection(|connection| {
            let fixed_clause = if fixed_weight_only {
                "WHERE is_fixed_weight = 1"
            } else {
                ""
            };
            if search.is_empty() {
                connection
                    .query_row(
                        &format!("SELECT COUNT(*) FROM nomenclature {fixed_clause}"),
                        [],
                        |row| row.get(0),
                    )
                    .map_err(db_error("count products"))
            } else {
                let search_clause = if fixed_weight_only { "AND" } else { "WHERE" };
                connection
                    .query_row(
                        &format!(
                            "SELECT COUNT(*) FROM nomenclature {fixed_clause} {search_clause} \
                             (name LIKE ?1 OR article LIKE ?1)"
                        ),
                        params![format!("%{search}%")],
                        |row| row.get(0),
                    )
                    .map_err(db_error("count filtered products"))
            }
        })
    }

    #[cfg(feature = "slint-ui")]
    pub fn product(&self, id: i64) -> Result<Option<Value>, String> {
        require_positive_id(id, "productId")?;
        self.with_connection(|connection| {
            query_one_json(
                connection,
                "SELECT n.*, \
                        pc.weight AS portion_weight, pc.name AS portion_container_name, \
                        bc.weight AS box_weight, bc.name AS box_container_name, \
                        pack_label.name AS pack_label_name, \
                        box_label.name AS box_label_name, \
                        pallet_label.name AS pallet_label_name \
                 FROM nomenclature n \
                 LEFT JOIN container pc ON n.portion_container_id = pc.id \
                 LEFT JOIN container bc ON n.box_container_id = bc.id \
                 LEFT JOIN labels pack_label ON n.templates_pack_label = pack_label.id \
                 LEFT JOIN labels box_label ON n.templates_box_label = box_label.id \
                 LEFT JOIN labels pallet_label ON n.templates_pallet_label = pallet_label.id \
                 WHERE n.id = ?1",
                &[SqlValue::Integer(id)],
            )
        })
    }
    #[cfg(feature = "slint-ui")]
    pub fn latest_active_pack_id(&self, nomenclature_id: i64) -> Result<Option<i64>, String> {
        require_positive_id(nomenclature_id, "nomenclatureId")?;
        self.with_connection(|connection| {
            connection
                .query_row(
                    "SELECT p.id FROM pack p JOIN boxes b ON b.id = p.box_id WHERE p.nomenclature_id = ?1 AND p.status != 'Deleted' AND b.status = 'Open' ORDER BY p.id DESC LIMIT 1",
                    params![nomenclature_id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(db_error("read latest active pack"))
        })
    }
    pub fn containers(&self) -> Result<Vec<Value>, String> {
        self.with_connection(|connection| {
            query_all_json(
                connection,
                "SELECT * FROM container ORDER BY name COLLATE NOCASE",
                &[],
            )
        })
    }

    pub fn label(&self, id: i64) -> Result<Option<Value>, String> {
        require_positive_id(id, "labelId")?;
        self.with_connection(|connection| {
            query_one_json(
                connection,
                "SELECT * FROM labels WHERE id = ?1",
                &[SqlValue::Integer(id)],
            )
        })
    }

    pub fn all_labels(&self) -> Result<Vec<Value>, String> {
        self.with_connection(|connection| {
            query_all_json(
                connection,
                "SELECT * FROM labels ORDER BY name COLLATE NOCASE",
                &[],
            )
        })
    }

    pub fn barcode_template(&self, id: i64) -> Result<Option<Value>, String> {
        require_positive_id(id, "barcodeTemplateId")?;
        self.with_connection(|connection| {
            query_one_json(
                connection,
                "SELECT * FROM barcodes WHERE id = ?1",
                &[SqlValue::Integer(id)],
            )
        })
    }

    pub fn station_info(&self) -> Result<Value, String> {
        self.with_connection(|connection| {
            let row = connection
                .query_row(
                    "SELECT uuid, number, name FROM station LIMIT 1",
                    [],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, Option<i64>>(1)?,
                            row.get::<_, Option<String>>(2)?,
                        ))
                    },
                )
                .optional()
                .map_err(db_error("read station info"))?;
            Ok(match row {
                Some((uuid, number, name)) => json!({
                    "uuid_client": uuid,
                    "station_name": name,
                    "station_number": number
                        .filter(|value| *value != 0)
                        .map(|value| format!("{value:02}")),
                }),
                None => json!({ "uuid_client": null, "station_number": null }),
            })
        })
    }

    pub fn print_jobs(&self, status: Option<&str>) -> Result<Vec<Value>, String> {
        let status = status.map(str::trim).filter(|value| !value.is_empty());
        self.with_connection(|connection| match status {
            Some(status) => query_all_json(
                connection,
                "SELECT * FROM print_jobs WHERE status = ?1 ORDER BY created_at DESC",
                &[SqlValue::Text(status.chars().take(32).collect())],
            ),
            None => query_all_json(
                connection,
                "SELECT * FROM print_jobs ORDER BY CASE status WHEN 'in_progress' THEN 0 WHEN 'pending' THEN 1 WHEN 'completed' THEN 2 END, created_at DESC",
                &[],
            ),
        })
    }

    pub fn update_print_job_progress(
        &self,
        job_id: i64,
        printed_qty: f64,
    ) -> Result<Value, String> {
        require_positive_id(job_id, "jobId")?;
        validate_weight(printed_qty, "printedQty")?;
        self.with_connection(|connection| {
            let quantity = connection
                .query_row(
                    "SELECT quantity FROM print_jobs WHERE job_id = ?1",
                    params![job_id],
                    |row| row.get::<_, f64>(0),
                )
                .optional()
                .map_err(db_error("find print job"))?
                .ok_or_else(|| format!("Print job #{job_id} not found"))?;
            let status = if printed_qty >= quantity {
                "completed"
            } else {
                "in_progress"
            };
            connection
                .execute(
                    "UPDATE print_jobs SET printed_qty = ?1, status = ?2, completed_at = CASE WHEN ?2 = 'completed' THEN CURRENT_TIMESTAMP ELSE completed_at END WHERE job_id = ?3",
                    params![printed_qty, status, job_id],
                )
                .map_err(db_error("update print job progress"))?;
            Ok(json!({
                "success": true,
                "status": status,
                "printed_qty": printed_qty,
                "quantity": quantity,
            }))
        })
    }

    pub fn complete_print_job(&self, job_id: i64) -> Result<Value, String> {
        require_positive_id(job_id, "jobId")?;
        self.with_connection(|connection| {
            connection
                .execute(
                    "UPDATE print_jobs SET status = 'completed', completed_at = CURRENT_TIMESTAMP WHERE job_id = ?1",
                    params![job_id],
                )
                .map_err(db_error("complete print job"))?;
            Ok(json!({ "success": true }))
        })
    }

    pub fn delete_print_job(&self, job_id: i64) -> Result<Value, String> {
        require_positive_id(job_id, "jobId")?;
        self.with_connection(|connection| {
            connection
                .execute("DELETE FROM print_jobs WHERE job_id = ?1", params![job_id])
                .map_err(db_error("delete print job"))?;
            Ok(json!({ "success": true }))
        })
    }
    pub fn record_pack(
        &self,
        payload: RecordPackPayload,
        operator: Option<OperatorAttribution>,
    ) -> Result<RecordPackResult, String> {
        payload.validate()?;
        self.with_connection(|connection| {
            let transaction = connection
                .transaction()
                .map_err(|error| format!("failed to begin record-pack transaction: {error}"))?;
            let result = record_pack_transaction(&transaction, payload, operator)?;
            transaction
                .commit()
                .map_err(|error| format!("failed to commit record-pack transaction: {error}"))?;
            Ok(result)
        })
    }

    pub fn close_box(&self, payload: CloseBoxPayload) -> Result<Value, String> {
        payload.validate()?;
        self.with_connection(|connection| {
            let changes = connection
                .execute(
                    "UPDATE boxes SET status = 'Closed', weight_netto = ?1, weight_brutto = ?2, updated_at = CURRENT_TIMESTAMP WHERE id = ?3 AND status = 'Open'",
                    params![payload.weight_netto, payload.weight_brutto, payload.box_id],
                )
                .map_err(|error| format!("failed to close box {}: {error}", payload.box_id))?;
            Ok(json!({ "success": changes > 0 }))
        })
    }

    pub fn latest_counters(&self, nomenclature_id: Option<i64>) -> Result<Value, String> {
        self.with_connection(|connection| latest_counters(connection, nomenclature_id))
    }

    pub fn open_pallet_content(&self, nomenclature_id: Option<i64>) -> Result<Value, String> {
        self.with_connection(|connection| open_pallet_content(connection, nomenclature_id))
    }

    pub fn pallet_render_data(&self, context: Value) -> Result<Value, String> {
        self.with_connection(|connection| pallet_render_data(connection, &context))
    }

    pub fn close_current_pallet(&self) -> Result<Value, String> {
        self.with_connection(|connection| {
            let transaction = connection
                .transaction()
                .map_err(|error| format!("failed to begin close-pallet transaction: {error}"))?;
            let result = close_current_pallet_transaction(&transaction)?;
            transaction
                .commit()
                .map_err(|error| format!("failed to commit close-pallet transaction: {error}"))?;
            Ok(result)
        })
    }

    pub fn delete_pack(&self, pack_id: i64) -> Result<Value, String> {
        require_positive_id(pack_id, "packId")?;
        self.with_connection(|connection| {
            let transaction = connection
                .transaction()
                .map_err(|error| format!("failed to begin delete-pack transaction: {error}"))?;
            let result = delete_pack_transaction(&transaction, pack_id)?;
            transaction
                .commit()
                .map_err(|error| format!("failed to commit delete-pack transaction: {error}"))?;
            Ok(result)
        })
    }

    pub fn delete_box(&self, box_id: i64) -> Result<Value, String> {
        require_positive_id(box_id, "boxId")?;
        self.with_connection(|connection| {
            let transaction = connection
                .transaction()
                .map_err(|error| format!("failed to begin delete-box transaction: {error}"))?;
            let result = delete_box_transaction(&transaction, box_id)?;
            transaction
                .commit()
                .map_err(|error| format!("failed to commit delete-box transaction: {error}"))?;
            Ok(result)
        })
    }

    pub fn list_operators(&self) -> Result<Vec<OperatorListItem>, String> {
        self.with_connection(|connection| {
            let mut statement = connection
                .prepare_cached(
                    "SELECT uuid, full_name, COALESCE(short_code, ''), pin_hash FROM operators WHERE is_active = 1 ORDER BY full_name COLLATE NOCASE",
                )
                .map_err(db_error("prepare operator list"))?;
            let rows = statement
                .query_map([], |row| {
                    let pin_hash: Option<String> = row.get(3)?;
                    Ok(OperatorListItem {
                        uuid: row.get(0)?,
                        full_name: row.get(1)?,
                        short_code: row.get(2)?,
                        has_pin: pin_hash.as_deref().is_some_and(|value| !value.trim().is_empty()),
                    })
                })
                .map_err(db_error("query operator list"))?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(db_error("read operator list"))
        })
    }

    pub fn operator_credentials(&self, uuid: &str) -> Result<Option<OperatorCredentials>, String> {
        self.with_connection(|connection| {
            connection
                .query_row(
                    "SELECT uuid, full_name, COALESCE(short_code, ''), pin_hash FROM operators WHERE uuid = ?1 AND is_active = 1",
                    params![uuid],
                    |row| {
                        Ok(OperatorCredentials {
                            uuid: row.get(0)?,
                            full_name: row.get(1)?,
                            short_code: row.get(2)?,
                            pin_hash: row.get(3)?,
                        })
                    },
                )
                .optional()
                .map_err(db_error("query operator credentials"))
        })
    }

    pub fn open_entities_summary(&self) -> Result<OpenEntitiesSummary, String> {
        self.with_connection(|connection| {
            let open_box_count = connection
                .query_row("SELECT COUNT(*) FROM boxes WHERE status = 'Open'", [], |row| row.get(0))
                .map_err(db_error("count open boxes"))?;
            let open_box_number = connection
                .query_row(
                    "SELECT number FROM boxes WHERE status = 'Open' ORDER BY id DESC LIMIT 1",
                    [],
                    |row| row.get(0),
                )
                .optional()
                .map_err(db_error("read latest open box"))?;
            let open_pallet_count = connection
                .query_row(
                    "SELECT COUNT(*) FROM pallet p WHERE p.status = 'Open' AND EXISTS (SELECT 1 FROM boxes b WHERE b.pallete_id = p.id AND b.status != 'Deleted')",
                    [],
                    |row| row.get(0),
                )
                .map_err(db_error("count open pallets"))?;
            Ok(OpenEntitiesSummary {
                open_box_count,
                open_box_number,
                open_pallet_count,
            })
        })
    }

    #[allow(dead_code)]
    pub fn record_print_error(&self, message: &str, level: &str) {
        let level = match level {
            "WARNING" | "INFO" => level,
            _ => "ERROR",
        };
        let message: String = message.chars().take(2000).collect();
        let _ = self.with_connection(|connection| {
            connection
                .execute(
                    "INSERT INTO print_errors (event_uid, level, message, created_at) VALUES (?1, ?2, ?3, strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
                    params![Uuid::new_v4().to_string(), level, message],
                )
                .map(|_| ())
                .map_err(db_error("record print error"))
        });
    }

    #[allow(dead_code)]
    pub(crate) fn with_report_connection<T>(
        &self,
        operation: impl FnOnce(&Connection) -> Result<T, String>,
    ) -> Result<T, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "operational database lock is poisoned".to_owned())?;
        operation(&connection)
    }

    #[cfg(test)]
    fn query_value(&self, sql: &str) -> Value {
        self.with_connection(|connection| query_one_json(connection, sql, &[]))
            .unwrap()
            .unwrap()
    }
}

#[derive(Clone, Debug)]
pub struct OperatorAttribution {
    pub uuid: String,
    pub full_name: String,
}

#[derive(Clone, Debug)]
pub struct OperatorCredentials {
    pub uuid: String,
    pub full_name: String,
    pub short_code: String,
    pub pin_hash: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct OperatorListItem {
    pub uuid: String,
    pub full_name: String,
    pub short_code: String,
    pub has_pin: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenEntitiesSummary {
    pub open_box_count: i64,
    pub open_box_number: Option<String>,
    pub open_pallet_count: i64,
}

#[derive(Clone, Debug, Deserialize)]
pub struct BarcodeSpec {
    #[serde(default)]
    pub fields: Vec<Value>,
    #[serde(default)]
    pub data: Map<String, Value>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct RecordPackPayload {
    pub number: String,
    pub box_number: String,
    pub nomenclature_id: i64,
    pub weight_netto: f64,
    pub weight_brutto: f64,
    #[serde(default)]
    pub barcode_value: String,
    #[serde(default)]
    pub station_number: Option<String>,
    #[serde(default)]
    pub production_date: Option<String>,
    #[serde(default)]
    pub expiration_date: Option<String>,
    #[serde(default)]
    pub batch: Option<String>,
    #[serde(default)]
    pub barcode_spec: Option<BarcodeSpec>,
}

impl RecordPackPayload {
    fn validate(&self) -> Result<(), String> {
        if self.number.is_empty() || self.number.chars().count() > 512 {
            return Err("number must contain 1..512 characters".to_owned());
        }
        if self.box_number.is_empty() || self.box_number.chars().count() > 512 {
            return Err("box_number must contain 1..512 characters".to_owned());
        }
        require_positive_id(self.nomenclature_id, "nomenclature_id")?;
        validate_weight(self.weight_netto, "weight_netto")?;
        validate_weight(self.weight_brutto, "weight_brutto")
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordPackResult {
    pub success: bool,
    pub pack_id: i64,
    pub box_id: i64,
    pub box_number: String,
    pub new_box_created: bool,
    pub barcode_value: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloseBoxPayload {
    pub box_id: i64,
    pub weight_netto: f64,
    pub weight_brutto: f64,
}

impl CloseBoxPayload {
    fn validate(&self) -> Result<(), String> {
        require_positive_id(self.box_id, "boxId")?;
        validate_weight(self.weight_netto, "weightNetto")?;
        validate_weight(self.weight_brutto, "weightBrutto")
    }
}

fn record_pack_transaction(
    transaction: &Transaction<'_>,
    payload: RecordPackPayload,
    operator: Option<OperatorAttribution>,
) -> Result<RecordPackResult, String> {
    let mut box_row = transaction
        .query_row(
            "SELECT id, number FROM boxes WHERE status = 'Open' AND nomenclature_id = ?1 ORDER BY id DESC LIMIT 1",
            params![payload.nomenclature_id],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(db_error("find open box"))?;
    let mut new_box_created = false;

    if box_row.is_none() {
        let pallet_id = match transaction
            .query_row(
                "SELECT id FROM pallet WHERE status = 'Open' ORDER BY id DESC LIMIT 1",
                [],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map_err(db_error("find open pallet"))?
        {
            Some(id) => id,
            None => insert_unique_pallet(transaction)?,
        };

        let base_number = payload.box_number.clone();
        let mut actual_number = base_number.clone();
        for attempts in 0..50 {
            match transaction.execute(
                "INSERT INTO boxes (pallete_id, number, status, nomenclature_id) VALUES (?1, ?2, 'Open', ?3)",
                params![pallet_id, actual_number, payload.nomenclature_id],
            ) {
                Ok(_) => {
                    box_row = Some((transaction.last_insert_rowid(), actual_number));
                    new_box_created = true;
                    break;
                }
                Err(error) if is_unique_constraint(&error) => {
                    let next_attempt = attempts + 1;
                    let count: i64 = transaction
                        .query_row("SELECT COUNT(*) FROM boxes WHERE status != 'Deleted'", [], |row| row.get(0))
                        .map_err(db_error("count boxes after number collision"))?;
                    actual_number = if actual_number.chars().all(|character| character.is_ascii_digit()) {
                        (count + 1).to_string()
                    } else {
                        format!("{base_number}_{next_attempt}")
                    };
                }
                Err(error) => return Err(format!("failed to create box: {error}")),
            }
        }
    }

    let (box_id, box_number) =
        box_row.ok_or_else(|| "Could not find a unique box number after 50 attempts".to_owned())?;
    let mut barcode_value = payload.barcode_value;
    if let Some(mut spec) = payload.barcode_spec {
        if !spec.fields.is_empty() {
            spec.data
                .insert("box_number".to_owned(), Value::String(box_number.clone()));
            barcode_value = generate_barcode(&spec.fields, &spec.data);
        }
    }
    let (operator_uuid, operator_name) = operator
        .map(|operator| (Some(operator.uuid), Some(operator.full_name)))
        .unwrap_or((None, None));

    transaction
        .execute(
            r#"
            INSERT INTO pack (
                number, box_id, nomenclature_id, weight_netto, weight_brutto,
                barcode_value, station_number, status, production_date,
                expiration_date, batch, operator_uuid, operator_name
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'Printed', ?8, ?9, ?10, ?11, ?12)
            "#,
            params![
                payload.number,
                box_id,
                payload.nomenclature_id,
                payload.weight_netto,
                payload.weight_brutto,
                barcode_value,
                nonempty(payload.station_number),
                nonempty(payload.production_date),
                nonempty(payload.expiration_date),
                nonempty(payload.batch),
                operator_uuid,
                operator_name,
            ],
        )
        .map_err(db_error("insert pack"))?;
    let pack_id = transaction.last_insert_rowid();

    Ok(RecordPackResult {
        success: true,
        pack_id,
        box_id,
        box_number,
        new_box_created,
        barcode_value,
    })
}

fn insert_unique_pallet(transaction: &Transaction<'_>) -> Result<i64, String> {
    let base = format!("P{}", unix_millis());
    for attempt in 0..50 {
        let number = if attempt == 0 {
            base.clone()
        } else {
            format!("{base}_{attempt}")
        };
        match transaction.execute(
            "INSERT INTO pallet (number, status) VALUES (?1, 'Open')",
            params![number],
        ) {
            Ok(_) => return Ok(transaction.last_insert_rowid()),
            Err(error) if is_unique_constraint(&error) => {}
            Err(error) => return Err(format!("failed to create pallet: {error}")),
        }
    }
    Err("failed to allocate a unique pallet number after 50 attempts".to_owned())
}

fn latest_counters(connection: &Connection, nomenclature_id: Option<i64>) -> Result<Value, String> {
    let last_pack: Option<String> = connection
        .query_row(
            "SELECT number FROM pack WHERE status != 'Deleted' ORDER BY id DESC LIMIT 1",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(db_error("read latest pack number"))?;
    let last_box: Option<String> = connection
        .query_row(
            "SELECT number FROM boxes WHERE status != 'Deleted' ORDER BY id DESC LIMIT 1",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(db_error("read latest box number"))?;
    let total_units: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM pack WHERE status != 'Deleted'",
            [],
            |row| row.get(0),
        )
        .map_err(db_error("count packs"))?;
    let total_boxes: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM boxes WHERE status != 'Deleted'",
            [],
            |row| row.get(0),
        )
        .map_err(db_error("count boxes"))?;
    let open_pallet: Option<i64> = connection
        .query_row(
            "SELECT id FROM pallet WHERE status = 'Open' ORDER BY id DESC LIMIT 1",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(db_error("read open pallet"))?;
    let boxes_in_pallet = match open_pallet {
        Some(id) => connection
            .query_row(
                "SELECT COUNT(*) FROM boxes WHERE pallete_id = ?1 AND status != 'Deleted'",
                params![id],
                |row| row.get::<_, i64>(0),
            )
            .map_err(db_error("count boxes in pallet"))?,
        None => 0,
    };
    let open_box: Option<(i64, String)> = match nomenclature_id {
        Some(id) if id != 0 => connection
            .query_row(
                "SELECT id, number FROM boxes WHERE status = 'Open' AND nomenclature_id = ?1 ORDER BY id DESC LIMIT 1",
                params![id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional(),
        _ => connection
            .query_row(
                "SELECT id, number FROM boxes WHERE status = 'Open' ORDER BY id DESC LIMIT 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional(),
    }
    .map_err(db_error("read open box"))?;
    let (units_in_box, box_net_weight) = match open_box.as_ref() {
        Some((id, _)) => connection
            .query_row(
                "SELECT COUNT(*), COALESCE(SUM(weight_netto), 0) FROM pack WHERE box_id = ?1 AND status != 'Deleted'",
                params![id],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, f64>(1)?)),
            )
            .map_err(db_error("calculate current box counters"))?,
        None => (0, 0.0),
    };
    Ok(json!({
        "lastPackNumber": last_pack.unwrap_or_else(|| "0".to_owned()),
        "lastBoxNumber": last_box.unwrap_or_else(|| "0".to_owned()),
        "totalUnits": total_units,
        "totalBoxes": total_boxes,
        "boxesInPallet": boxes_in_pallet,
        "unitsInBox": units_in_box,
        "boxNetWeight": box_net_weight,
        "currentBoxId": open_box.as_ref().map(|row| row.0),
        "currentBoxNumber": open_box.map(|row| row.1),
    }))
}

fn open_pallet_content(
    connection: &Connection,
    nomenclature_id: Option<i64>,
) -> Result<Value, String> {
    let Some(pallet) = query_one_json(
        connection,
        "SELECT * FROM pallet WHERE status = 'Open' ORDER BY id DESC LIMIT 1",
        &[],
    )?
    else {
        return Ok(Value::Null);
    };
    let pallet_id = pallet.get("id").and_then(Value::as_i64).unwrap_or_default();
    let open_box = match nomenclature_id {
        Some(id) => query_one_json(
            connection,
            "SELECT * FROM boxes WHERE pallete_id = ?1 AND status = 'Open' AND nomenclature_id = ?2 ORDER BY id DESC LIMIT 1",
            &[SqlValue::Integer(pallet_id), SqlValue::Integer(id)],
        )?,
        None => query_one_json(
            connection,
            "SELECT * FROM boxes WHERE pallete_id = ?1 AND status = 'Open' ORDER BY id DESC LIMIT 1",
            &[SqlValue::Integer(pallet_id)],
        )?,
    };
    let boxes = query_all_json(
        connection,
        "SELECT * FROM boxes WHERE pallete_id = ?1 ORDER BY id DESC",
        &[SqlValue::Integer(pallet_id)],
    )?;
    let packs = match open_box
        .as_ref()
        .and_then(|box_row| box_row.get("id"))
        .and_then(Value::as_i64)
    {
        Some(id) => query_all_json(
            connection,
            "SELECT * FROM pack WHERE box_id = ?1 ORDER BY id DESC",
            &[SqlValue::Integer(id)],
        )?,
        None => Vec::new(),
    };
    Ok(json!({
        "pallet": pallet,
        "openBox": open_box,
        "boxesInPallet": boxes,
        "packsInCurrentBox": packs,
    }))
}

#[derive(Clone)]
struct PalletRow {
    box_id: i64,
    nomenclature_id: i64,
    weight_netto: f64,
    weight_brutto: f64,
    production_date: String,
    expiration_date: String,
    batch: String,
    name: String,
    article: String,
    exp_date_days: i64,
}

#[derive(Default)]
struct Totals {
    net: f64,
    brut: f64,
}

struct Group {
    nomenclature_id: i64,
    name: String,
    article: String,
    batch: String,
    production_date: String,
    expiration_date: String,
    exp_date_days: i64,
    qty: usize,
    net: f64,
    brut: f64,
}

fn pallet_render_data(connection: &Connection, context: &Value) -> Result<Value, String> {
    let Some(pallet) = query_one_json(
        connection,
        "SELECT * FROM pallet WHERE status = 'Open' ORDER BY id DESC LIMIT 1",
        &[],
    )?
    else {
        return Ok(Value::Null);
    };
    let pallet_id = pallet.get("id").and_then(Value::as_i64).unwrap_or_default();
    let has_open_box = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM boxes b WHERE b.pallete_id = ?1 AND b.status = 'Open' AND EXISTS (SELECT 1 FROM pack p WHERE p.box_id = b.id AND p.status != 'Deleted'))",
            params![pallet_id],
            |row| row.get::<_, bool>(0),
        )
        .map_err(db_error("check pallet open box"))?;
    let mut statement = connection
        .prepare_cached(
            r#"
            SELECT p.box_id, p.nomenclature_id, COALESCE(p.weight_netto, 0),
                   COALESCE(p.weight_brutto, 0), COALESCE(p.production_date, ''),
                   COALESCE(p.expiration_date, ''), COALESCE(p.batch, ''),
                   COALESCE(n.name, ''), COALESCE(n.article, ''), COALESCE(n.exp_date, 0)
            FROM pack p
            JOIN boxes b ON b.id = p.box_id
            LEFT JOIN nomenclature n ON n.id = p.nomenclature_id
            WHERE b.pallete_id = ?1 AND p.status != 'Deleted' AND b.status != 'Deleted'
            ORDER BY n.name COLLATE NOCASE, p.batch, p.id
            "#,
        )
        .map_err(db_error("prepare pallet render rows"))?;
    let rows = statement
        .query_map(params![pallet_id], |row| {
            Ok(PalletRow {
                box_id: row.get(0)?,
                nomenclature_id: row.get(1)?,
                weight_netto: row.get(2)?,
                weight_brutto: row.get(3)?,
                production_date: row.get(4)?,
                expiration_date: row.get(5)?,
                batch: row.get(6)?,
                name: row.get(7)?,
                article: row.get(8)?,
                exp_date_days: row.get(9)?,
            })
        })
        .map_err(db_error("query pallet render rows"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error("read pallet render rows"))?;
    drop(statement);

    let operator_name = context
        .get("operator_name")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let mut result = build_pallet_render_data(&rows, &pallet, operator_name);
    result["hasOpenBox"] = Value::Bool(has_open_box);
    Ok(result)
}

fn build_pallet_render_data(rows: &[PalletRow], pallet: &Value, operator_name: &str) -> Value {
    let mut groups: HashMap<String, Group> = HashMap::new();
    let mut order = Vec::new();
    let mut nomenclature_totals: HashMap<i64, Totals> = HashMap::new();
    let mut batch_totals: HashMap<String, Totals> = HashMap::new();
    let mut box_ids = HashSet::new();
    let mut total_net = 0.0;
    let mut total_brut = 0.0;

    for row in rows {
        let key = format!("{}::{}", row.nomenclature_id, row.batch);
        if !groups.contains_key(&key) {
            order.push(key.clone());
            groups.insert(
                key.clone(),
                Group {
                    nomenclature_id: row.nomenclature_id,
                    name: row.name.clone(),
                    article: row.article.clone(),
                    batch: row.batch.clone(),
                    production_date: row.production_date.clone(),
                    expiration_date: row.expiration_date.clone(),
                    exp_date_days: row.exp_date_days,
                    qty: 0,
                    net: 0.0,
                    brut: 0.0,
                },
            );
        }
        let group = groups.get_mut(&key).expect("group inserted");
        group.qty += 1;
        group.net += row.weight_netto;
        group.brut += row.weight_brutto;
        if group.production_date.is_empty() && !row.production_date.is_empty() {
            group.production_date.clone_from(&row.production_date);
        }
        if group.expiration_date.is_empty() && !row.expiration_date.is_empty() {
            group.expiration_date.clone_from(&row.expiration_date);
        }
        box_ids.insert(row.box_id);
        total_net += row.weight_netto;
        total_brut += row.weight_brutto;
        let nominal = nomenclature_totals.entry(row.nomenclature_id).or_default();
        nominal.net += row.weight_netto;
        nominal.brut += row.weight_brutto;
        let batch = batch_totals.entry(row.batch.clone()).or_default();
        batch.net += row.weight_netto;
        batch.brut += row.weight_brutto;
    }

    let items: Vec<Value> = order
        .iter()
        .map(|key| {
            let group = &groups[key];
            let nominal = &nomenclature_totals[&group.nomenclature_id];
            let batch = &batch_totals[&group.batch];
            let production = format_pallet_date(&group.production_date);
            let expiration = if group.expiration_date.is_empty() && group.exp_date_days != 0 {
                add_days(&group.production_date, group.exp_date_days)
                    .map(|date| format_pallet_date(&date))
                    .unwrap_or_default()
            } else {
                format_pallet_date(&group.expiration_date)
            };
            json!({
                "name": group.name,
                "article": group.article,
                "quantity": group.qty.to_string(),
                "batch_number": group.batch,
                "production_date_batch": production,
                "exp_date_full": expiration,
                "weight_netto_pack": fixed3(group.net),
                "weight_brutto_pack": fixed3(group.brut),
                "weight_netto_batch": fixed3(batch.net),
                "weight_brutto_batch": fixed3(batch.brut),
                "weight_netto_nomenclature": fixed3(nominal.net),
                "weight_brutto_nomenclature": fixed3(nominal.brut),
            })
        })
        .collect();
    let production_date = items
        .first()
        .and_then(|item| item.get("production_date_batch"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    json!({
        "pallet_number": pallet.get("number").and_then(Value::as_str).unwrap_or_default(),
        "shipping_date": "",
        "production_date": production_date,
        "operator_name": operator_name,
        "total_count": rows.len().to_string(),
        "total_places": order.len().to_string(),
        "total_boxes": box_ids.len().to_string(),
        "weight_total": fixed3(total_brut),
        "weight_netto_pallet": fixed3(total_net),
        "weight_brutto_pallet": fixed3(total_brut),
        "items": items,
    })
}

fn close_current_pallet_transaction(transaction: &Transaction<'_>) -> Result<Value, String> {
    let Some(pallet_id) = transaction
        .query_row(
            "SELECT id FROM pallet WHERE status = 'Open' ORDER BY id DESC LIMIT 1",
            [],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(db_error("find current pallet"))?
    else {
        return Ok(json!({ "success": false }));
    };
    transaction
        .execute(
            "UPDATE boxes SET status = 'Closed', updated_at = CURRENT_TIMESTAMP WHERE pallete_id = ?1 AND status = 'Open' AND NOT EXISTS (SELECT 1 FROM pack p WHERE p.box_id = boxes.id AND p.status != 'Deleted')",
            params![pallet_id],
        )
        .map_err(db_error("close empty pallet boxes"))?;
    let mut statement = transaction
        .prepare("SELECT id FROM boxes WHERE pallete_id = ?1 AND status = 'Open'")
        .map_err(db_error("prepare stray box query"))?;
    let strays = statement
        .query_map(params![pallet_id], |row| row.get::<_, i64>(0))
        .map_err(db_error("query stray boxes"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error("read stray boxes"))?;
    drop(statement);
    if !strays.is_empty() {
        let new_pallet_id = insert_unique_pallet(transaction)?;
        for box_id in strays {
            transaction
                .execute(
                    "UPDATE boxes SET pallete_id = ?1, updated_at = CURRENT_TIMESTAMP WHERE id = ?2",
                    params![new_pallet_id, box_id],
                )
                .map_err(db_error("re-home in-progress box"))?;
        }
    }
    transaction
        .execute(
            "UPDATE pallet SET status = 'Closed', updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
            params![pallet_id],
        )
        .map_err(db_error("close pallet"))?;
    Ok(json!({ "success": true, "palletId": pallet_id }))
}

fn delete_pack_transaction(transaction: &Transaction<'_>, pack_id: i64) -> Result<Value, String> {
    let pack: Option<(i64, String, f64, f64)> = transaction
        .query_row(
            "SELECT box_id, status, weight_netto, weight_brutto FROM pack WHERE id = ?1",
            params![pack_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()
        .map_err(db_error("find pack"))?;
    let Some((box_id, status, pack_net, pack_brut)) = pack else {
        return Err("Pack not found".to_owned());
    };
    if status == "Deleted" {
        return Err("Pack already deleted".to_owned());
    }
    let box_row: Option<(i64, String, f64, f64)> = transaction
        .query_row(
            "SELECT pallete_id, status, COALESCE(weight_netto, 0), COALESCE(weight_brutto, 0) FROM boxes WHERE id = ?1",
            params![box_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()
        .map_err(db_error("find pack box"))?;
    let Some((pallet_id, box_status, box_net, box_brut)) = box_row else {
        return Err("Box not found".to_owned());
    };
    if box_status != "Open" {
        return Err("Cannot delete pack from a closed box".to_owned());
    }
    transaction
        .execute(
            "UPDATE pack SET status = 'Deleted', deleted_at = strftime('%Y-%m-%d %H:%M:%f','now') WHERE id = ?1",
            params![pack_id],
        )
        .map_err(db_error("mark pack deleted"))?;
    transaction
        .execute(
            "UPDATE boxes SET weight_netto = ?1, weight_brutto = ?2, updated_at = CURRENT_TIMESTAMP WHERE id = ?3",
            params![(box_net - pack_net).max(0.0), (box_brut - pack_brut).max(0.0), box_id],
        )
        .map_err(db_error("update box weights after pack deletion"))?;
    if let Some((pallet_net, pallet_brut)) = transaction
        .query_row(
            "SELECT COALESCE(weight_netto, 0), COALESCE(weight_brutto, 0) FROM pallet WHERE id = ?1",
            params![pallet_id],
            |row| Ok((row.get::<_, f64>(0)?, row.get::<_, f64>(1)?)),
        )
        .optional()
        .map_err(db_error("find pack pallet"))?
    {
        transaction
            .execute(
                "UPDATE pallet SET weight_netto = ?1, weight_brutto = ?2, updated_at = CURRENT_TIMESTAMP WHERE id = ?3",
                params![(pallet_net - pack_net).max(0.0), (pallet_brut - pack_brut).max(0.0), pallet_id],
            )
            .map_err(db_error("update pallet weights after pack deletion"))?;
    }
    Ok(json!({ "success": true, "boxId": box_id }))
}

fn delete_box_transaction(transaction: &Transaction<'_>, box_id: i64) -> Result<Value, String> {
    let box_row: Option<(i64, String, f64, f64)> = transaction
        .query_row(
            "SELECT pallete_id, status, COALESCE(weight_netto, 0), COALESCE(weight_brutto, 0) FROM boxes WHERE id = ?1",
            params![box_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()
        .map_err(db_error("find box"))?;
    let Some((pallet_id, status, box_net, box_brut)) = box_row else {
        return Err("Box not found".to_owned());
    };
    if status == "Deleted" {
        return Err("Box already deleted".to_owned());
    }
    let pallet: Option<(String, f64, f64)> = transaction
        .query_row(
            "SELECT status, COALESCE(weight_netto, 0), COALESCE(weight_brutto, 0) FROM pallet WHERE id = ?1",
            params![pallet_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(db_error("find box pallet"))?;
    let Some((pallet_status, pallet_net, pallet_brut)) = pallet else {
        return Err("Pallet not found".to_owned());
    };
    if pallet_status != "Open" {
        return Err("Cannot delete box from a closed pallet".to_owned());
    }
    transaction
        .execute(
            "UPDATE boxes SET status = 'Deleted', updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
            params![box_id],
        )
        .map_err(db_error("mark box deleted"))?;
    transaction
        .execute(
            "UPDATE pack SET status = 'Deleted', deleted_at = strftime('%Y-%m-%d %H:%M:%f','now') WHERE box_id = ?1 AND status != 'Deleted'",
            params![box_id],
        )
        .map_err(db_error("mark box packs deleted"))?;
    transaction
        .execute(
            "UPDATE pallet SET weight_netto = ?1, weight_brutto = ?2, updated_at = CURRENT_TIMESTAMP WHERE id = ?3",
            params![(pallet_net - box_net).max(0.0), (pallet_brut - box_brut).max(0.0), pallet_id],
        )
        .map_err(db_error("update pallet weights after box deletion"))?;
    Ok(json!({ "success": true, "palletId": pallet_id }))
}

fn query_one_json(
    connection: &Connection,
    sql: &str,
    values: &[SqlValue],
) -> Result<Option<Value>, String> {
    let mut rows = query_json_rows(connection, sql, values)?;
    Ok(rows.pop())
}

fn query_all_json(
    connection: &Connection,
    sql: &str,
    values: &[SqlValue],
) -> Result<Vec<Value>, String> {
    query_json_rows(connection, sql, values)
}

fn query_json_rows(
    connection: &Connection,
    sql: &str,
    values: &[SqlValue],
) -> Result<Vec<Value>, String> {
    let mut statement = connection
        .prepare(sql)
        .map_err(db_error("prepare JSON query"))?;
    let columns: Vec<String> = statement
        .column_names()
        .iter()
        .map(|name| (*name).to_owned())
        .collect();
    let mut rows = statement
        .query(params_from_iter(values.iter()))
        .map_err(db_error("execute JSON query"))?;
    let mut output = Vec::new();
    while let Some(row) = rows.next().map_err(db_error("advance JSON query"))? {
        let mut object = Map::with_capacity(columns.len());
        for (index, name) in columns.iter().enumerate() {
            let value = match row.get_ref(index).map_err(db_error("read JSON column"))? {
                ValueRef::Null => Value::Null,
                ValueRef::Integer(value) => json!(value),
                ValueRef::Real(value) => json!(value),
                ValueRef::Text(value) => Value::String(String::from_utf8_lossy(value).into_owned()),
                ValueRef::Blob(value) => {
                    Value::Array(value.iter().map(|byte| json!(byte)).collect())
                }
            };
            object.insert(name.clone(), value);
        }
        output.push(Value::Object(object));
    }
    Ok(output)
}

fn format_pallet_date(value: &str) -> String {
    parse_date(value)
        .map(|(year, month, day)| format!("{day:02}.{month:02}.{year:04}"))
        .unwrap_or_else(|| value.to_owned())
}

fn add_days(value: &str, delta: i64) -> Option<String> {
    let (year, month, day) = parse_date(value)?;
    let days = days_from_civil(year, month, day).checked_add(delta)?;
    let (year, month, day) = civil_from_days(days);
    Some(format!("{year:04}-{month:02}-{day:02}"))
}

fn parse_date(value: &str) -> Option<(i64, i64, i64)> {
    let date = value.get(..10)?;
    if date.as_bytes().get(4) != Some(&b'-') || date.as_bytes().get(7) != Some(&b'-') {
        return None;
    }
    let year = date[0..4].parse().ok()?;
    let month = date[5..7].parse().ok()?;
    let day = date[8..10].parse().ok()?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    Some((year, month, day))
}

fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = year - i64::from(month <= 2);
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let yoe = year - era * 400;
    let adjusted_month = month + if month > 2 { -3 } else { 9 };
    let day_of_year = (153 * adjusted_month + 2) / 5 + day - 1;
    let day_of_era = yoe * 365 + yoe / 4 - yoe / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let days = days + 719_468;
    let era = if days >= 0 { days } else { days - 146_096 } / 146_097;
    let day_of_era = days - era * 146_097;
    let yoe = (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let mut year = yoe + era * 400;
    let day_of_year = day_of_era - (365 * yoe + yoe / 4 - yoe / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    (year, month, day)
}

fn fixed3(value: f64) -> String {
    format!("{value:.3}")
}

fn validate_weight(value: f64, name: &str) -> Result<(), String> {
    if value.is_finite() && value >= 0.0 {
        Ok(())
    } else {
        Err(format!("{name} must be a finite non-negative number"))
    }
}

fn require_positive_id(value: i64, name: &str) -> Result<(), String> {
    if value > 0 {
        Ok(())
    } else {
        Err(format!("{name} must be a positive integer"))
    }
}

fn nonempty(value: Option<String>) -> Option<String> {
    value.filter(|value| !value.is_empty())
}

fn is_unique_constraint(error: &rusqlite::Error) -> bool {
    matches!(
        error,
        rusqlite::Error::SqliteFailure(failure, _)
            if failure.code == ErrorCode::ConstraintViolation
    )
}

fn db_error(context: &'static str) -> impl FnOnce(rusqlite::Error) -> String {
    move |error| format!("{context}: {error}")
}

fn unix_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new(name: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "labelpilot-operational-{name}-{}-{}",
                std::process::id(),
                unix_millis()
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn fixture(name: &str) -> (TestDirectory, PersistedState, OperationalState) {
        let directory = TestDirectory::new(name);
        let persisted = PersistedState::for_data_dir(directory.0.clone());
        let state = OperationalState::new(&persisted).unwrap();
        state
            .with_connection(|connection| {
                connection
                    .execute(
                        "INSERT INTO nomenclature (id, name, article, exp_date) VALUES (1, 'Milk', '460123456789', 10)",
                        [],
                    )
                    .map(|_| ())
                    .map_err(db_error("seed nomenclature"))
            })
            .unwrap();
        (directory, persisted, state)
    }

    fn pack(number: &str, box_number: &str) -> RecordPackPayload {
        RecordPackPayload {
            number: number.to_owned(),
            box_number: box_number.to_owned(),
            nomenclature_id: 1,
            weight_netto: 1.2,
            weight_brutto: 1.3,
            barcode_value: format!("stale-{box_number}"),
            station_number: Some("07".to_owned()),
            production_date: Some("2026-08-14".to_owned()),
            expiration_date: None,
            batch: Some("B1".to_owned()),
            barcode_spec: Some(BarcodeSpec {
                fields: json!([
                    {"field_type":"constant","value":"BOX-"},
                    {"field_type":"box_number","length":3}
                ])
                .as_array()
                .unwrap()
                .clone(),
                data: Map::new(),
            }),
        }
    }

    #[test]
    fn exposes_catalog_station_templates_and_print_jobs_for_full_ui() {
        let (_directory, _persisted, state) = fixture("full-ui-queries");
        state
            .with_connection(|connection| {
                connection
                    .execute_batch(
                        r#"
                        INSERT INTO container (id, name, weight) VALUES (5, 'Tray', 0.025);
                        UPDATE nomenclature
                           SET portion_container_id = 5, is_fixed_weight = 1
                         WHERE id = 1;
                        INSERT INTO station (uuid, number, name) VALUES ('station-ui', 7, 'Line 7');
                        INSERT INTO labels (id, name, structure)
                        VALUES (11, 'Pack label', '{"canvas":{"width":400}}');
                        INSERT INTO barcodes (id, name, structure)
                        VALUES (12, 'GS1', '{"fields":[]}');
                        INSERT INTO print_jobs (
                            job_id, nomenclature_id, nomenclature_name, quantity, quantity_unit
                        ) VALUES (900, 1, 'Milk', 10, 'pcs');
                        "#,
                    )
                    .map_err(db_error("seed full UI queries"))
            })
            .unwrap();

        let products = state.products(Some("460123"), false).unwrap();
        assert_eq!(products.len(), 1);
        assert_eq!(products[0]["portion_weight"], 0.025);
        assert_eq!(state.products(None, true).unwrap().len(), 1);
        assert!(state.products(Some("absent"), false).unwrap().is_empty());

        assert_eq!(state.containers().unwrap()[0]["name"], "Tray");
        assert_eq!(state.station_info().unwrap()["station_number"], "07");
        assert_eq!(
            state.label(11).unwrap().unwrap()["structure"],
            r#"{"canvas":{"width":400}}"#
        );
        assert_eq!(
            state.barcode_template(12).unwrap().unwrap()["structure"],
            r#"{"fields":[]}"#
        );
        assert_eq!(state.all_labels().unwrap().len(), 1);

        assert_eq!(state.print_jobs(None).unwrap()[0]["status"], "pending");
        let progress = state.update_print_job_progress(900, 4.0).unwrap();
        assert_eq!(progress["status"], "in_progress");
        let completed = state.update_print_job_progress(900, 10.0).unwrap();
        assert_eq!(completed["status"], "completed");
        assert_eq!(state.print_jobs(Some("completed")).unwrap().len(), 1);
        assert_eq!(state.complete_print_job(900).unwrap()["success"], true);
        assert_eq!(state.delete_print_job(900).unwrap()["success"], true);
        assert!(state.print_jobs(None).unwrap().is_empty());
    }
    #[test]
    fn records_packs_reuses_open_box_and_preserves_operator() {
        let (_directory, _persisted, state) = fixture("record");
        let operator = OperatorAttribution {
            uuid: "operator-1".to_owned(),
            full_name: "Operator One".to_owned(),
        };
        let first = state
            .record_pack(pack("1", "42"), Some(operator.clone()))
            .unwrap();
        let second = state.record_pack(pack("2", "99"), Some(operator)).unwrap();
        assert!(first.new_box_created);
        assert!(!second.new_box_created);
        assert_eq!(first.box_id, second.box_id);
        assert_eq!(first.barcode_value, "BOX-042");
        assert_eq!(second.barcode_value, "BOX-042");
        let row = state
            .query_value("SELECT COUNT(*) AS count, MIN(operator_name) AS operator_name FROM pack");
        assert_eq!(row["count"], 2);
        assert_eq!(row["operator_name"], "Operator One");
        let counters = state.latest_counters(Some(1)).unwrap();
        assert_eq!(counters["unitsInBox"], 2);
        assert_eq!(counters["boxNetWeight"], 2.4);
    }

    #[test]
    fn records_one_thousand_packs_through_one_persistent_connection() {
        let (_directory, _persisted, state) = fixture("bulk-record");
        for number in 1..=1_000 {
            state
                .record_pack(pack(&number.to_string(), "500"), None)
                .expect("record bulk pack");
        }

        let counters = state.latest_counters(Some(1)).unwrap();
        assert_eq!(counters["totalUnits"], 1_000);
        assert_eq!(counters["unitsInBox"], 1_000);
        assert_eq!(
            state.query_value("SELECT COUNT(*) AS count FROM boxes")["count"],
            1
        );
    }

    #[test]
    fn resolves_box_number_collisions_and_regenerates_barcode() {
        let (_directory, _persisted, state) = fixture("collision");
        let first = state.record_pack(pack("1", "1"), None).unwrap();
        state
            .close_box(CloseBoxPayload {
                box_id: first.box_id,
                weight_netto: 1.2,
                weight_brutto: 1.3,
            })
            .unwrap();
        let second = state.record_pack(pack("2", "1"), None).unwrap();
        assert_eq!(second.box_number, "2");
        assert_eq!(second.barcode_value, "BOX-002");
    }

    #[test]
    fn deletion_guards_and_compound_timestamp_are_transactional() {
        let (_directory, _persisted, state) = fixture("deletion");
        let recorded = state.record_pack(pack("1", "10"), None).unwrap();
        state
            .with_connection(|connection| {
                connection
                    .execute(
                        "UPDATE boxes SET weight_netto=1.2, weight_brutto=1.3 WHERE id=?1",
                        params![recorded.box_id],
                    )
                    .unwrap();
                connection
                    .execute("UPDATE pallet SET weight_netto=1.2, weight_brutto=1.3", [])
                    .unwrap();
                Ok(())
            })
            .unwrap();
        assert_eq!(state.delete_pack(1).unwrap()["boxId"], recorded.box_id);
        assert!(state
            .delete_pack(1)
            .unwrap_err()
            .contains("already deleted"));
        let deleted = state.query_value("SELECT status, deleted_at FROM pack WHERE id=1");
        assert_eq!(deleted["status"], "Deleted");
        assert!(deleted["deleted_at"].as_str().unwrap().contains('.'));
        let weights = state.query_value("SELECT weight_netto, weight_brutto FROM boxes WHERE id=1");
        assert_eq!(weights["weight_netto"], 0.0);
        assert_eq!(weights["weight_brutto"], 0.0);
    }

    #[test]
    fn closes_empty_boxes_and_rehomes_nonempty_strays() {
        let (_directory, _persisted, state) = fixture("pallet-close");
        let recorded = state.record_pack(pack("1", "10"), None).unwrap();
        let old_pallet = state.query_value("SELECT id FROM pallet WHERE status='Open'")["id"]
            .as_i64()
            .unwrap();
        let closed = state.close_current_pallet().unwrap();
        assert_eq!(closed["palletId"], old_pallet);
        let box_row = state.query_value(&format!(
            "SELECT pallete_id, status FROM boxes WHERE id={}",
            recorded.box_id
        ));
        assert_eq!(box_row["status"], "Open");
        assert_ne!(box_row["pallete_id"], old_pallet);
        let old = state.query_value(&format!("SELECT status FROM pallet WHERE id={old_pallet}"));
        assert_eq!(old["status"], "Closed");
    }

    #[test]
    fn pallet_render_matches_group_and_weight_contract() {
        let (_directory, _persisted, state) = fixture("render");
        state.record_pack(pack("1", "10"), None).unwrap();
        state.record_pack(pack("2", "10"), None).unwrap();
        let rendered = state
            .pallet_render_data(json!({"operator_name":"Operator"}))
            .unwrap();
        assert_eq!(rendered["operator_name"], "Operator");
        assert_eq!(rendered["total_count"], "2");
        assert_eq!(rendered["total_places"], "1");
        assert_eq!(rendered["total_boxes"], "1");
        assert_eq!(rendered["weight_netto_pallet"], "2.400");
        assert_eq!(rendered["items"][0]["exp_date_full"], "24.08.2026");
        assert_eq!(rendered["hasOpenBox"], true);
    }

    #[test]
    fn failed_delete_rolls_back_every_write() {
        let (_directory, _persisted, state) = fixture("rollback");
        let recorded = state.record_pack(pack("1", "10"), None).unwrap();
        state
            .close_box(CloseBoxPayload {
                box_id: recorded.box_id,
                weight_netto: 1.2,
                weight_brutto: 1.3,
            })
            .unwrap();
        assert!(state.delete_pack(1).unwrap_err().contains("closed box"));
        let pack_row = state.query_value("SELECT status, deleted_at FROM pack WHERE id=1");
        assert_eq!(pack_row["status"], "Printed");
        assert_eq!(pack_row["deleted_at"], Value::Null);
    }

    #[test]
    fn exercises_an_external_legacy_database_copy_when_configured() {
        let Some(database_path) = std::env::var_os("LABELPILOT_TEST_DB_COPY").map(PathBuf::from)
        else {
            return;
        };
        assert_eq!(
            database_path.file_name().and_then(|value| value.to_str()),
            Some("client_data.db")
        );
        let data_dir = database_path
            .parent()
            .expect("database parent")
            .to_path_buf();
        let persisted = PersistedState::for_data_dir(data_dir);
        let state = OperationalState::new(&persisted).expect("open legacy database copy");
        let before = state.latest_counters(None).expect("read copied counters");
        let nomenclature_id = state
            .with_connection(|connection| {
                let existing = connection
                    .query_row(
                        "SELECT id FROM nomenclature ORDER BY id LIMIT 1",
                        [],
                        |row| row.get::<_, i64>(0),
                    )
                    .optional()
                    .map_err(db_error("find copied nomenclature"))?;
                if let Some(id) = existing {
                    return Ok(id);
                }
                connection
                    .execute(
                        "INSERT INTO nomenclature (name, article, exp_date) VALUES ('Phase 3 copy fixture', 'fixture', 1)",
                        [],
                    )
                    .map_err(db_error("seed copied nomenclature"))?;
                Ok(connection.last_insert_rowid())
            })
            .expect("resolve nomenclature on copy");
        let suffix = unix_millis();
        let recorded = state
            .record_pack(
                RecordPackPayload {
                    number: format!("phase3-pack-{suffix}"),
                    box_number: format!("phase3-box-{suffix}"),
                    nomenclature_id,
                    weight_netto: 0.5,
                    weight_brutto: 0.55,
                    barcode_value: "phase3-copy".to_owned(),
                    station_number: None,
                    production_date: None,
                    expiration_date: None,
                    batch: None,
                    barcode_spec: None,
                },
                None,
            )
            .expect("record on legacy database copy");
        let after = state
            .latest_counters(Some(nomenclature_id))
            .expect("read counters after copied write");
        assert_eq!(
            after["totalUnits"].as_i64(),
            before["totalUnits"].as_i64().map(|value| value + 1)
        );
        assert_eq!(after["currentBoxId"], recorded.box_id);
        let pack_id = state.query_value("SELECT id FROM pack ORDER BY id DESC LIMIT 1")["id"]
            .as_i64()
            .expect("latest pack id");
        state.delete_pack(pack_id).expect("delete pack on copy");
        assert_eq!(
            state.query_value(&format!("SELECT status FROM pack WHERE id={pack_id}"))["status"],
            "Deleted"
        );
    }
}
