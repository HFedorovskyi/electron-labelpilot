use crate::barcode::generate_barcode;
use crate::generator::{GenerationPayload, GeneratorState};
use crate::native_raster::{self, RasterizedLabel};
use crate::operational::{BarcodeSpec, CloseBoxPayload, OperationalState, RecordPackPayload};
use crate::persisted::PersistedState;
use crate::printer::{PageMarginsMm, PreparedPrinterJob, PrintReceipt, PrinterTransportState};
use crate::runtime_events::RuntimeEventSink;
use crate::session::SessionState;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use time::{Date, Duration, Month, OffsetDateTime};
use uuid::Uuid;

const LAST_PRINT_FILE: &str = "native-last-print.json";

#[derive(Clone, Debug)]
pub struct PackPrintRequest {
    pub product_id: i64,
    pub gross_weight_kg: f64,
    pub batch_number: String,
    pub production_date: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativePrintOutcome {
    pub kind: String,
    pub number: String,
    pub box_number: Option<String>,
    pub pack_id: Option<i64>,
    pub auto_closed_box: bool,
    pub receipt: Option<PrintReceipt>,
    pub warnings: Vec<String>,
}

impl NativePrintOutcome {
    pub(crate) fn success_message(&self, message: &str) -> String {
        if self.warnings.is_empty() {
            message.to_owned()
        } else {
            format!("{message} · {}", self.warnings.join(" · "))
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredPrint {
    config: Value,
    doc: Value,
    data: Value,
    number: String,
    kind: String,
    pack_id: Option<i64>,
}

#[derive(Clone)]
pub struct NativePrintService {
    generator: Arc<GeneratorState>,
    last_print: Arc<Mutex<Option<StoredPrint>>>,
    last_print_path: PathBuf,
    station_number_cache: Arc<OnceLock<String>>,
}

impl NativePrintService {
    pub fn new(data_dir: PathBuf) -> Self {
        let last_print_path = data_dir.join(LAST_PRINT_FILE);
        let last_print = fs::read(&last_print_path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<StoredPrint>(&bytes).ok());
        Self {
            generator: Arc::new(GeneratorState::default()),
            last_print: Arc::new(Mutex::new(last_print)),
            last_print_path,
            station_number_cache: Arc::new(OnceLock::new()),
        }
    }

    pub fn test_printer(
        &self,
        printer: &PrinterTransportState,
        events: &RuntimeEventSink,
        config: Value,
        role: &str,
    ) -> Result<PrintReceipt, String> {
        let pallet = role == "palletPrinter";
        let width_mm = number(config.get("widthMm"))
            .filter(|value| *value > 0.0)
            .unwrap_or(if pallet { 210.0 } else { 58.0 });
        let height_mm = number(config.get("heightMm"))
            .filter(|value| *value > 0.0)
            .unwrap_or(if pallet { 297.0 } else { 40.0 });
        let (canvas_width, canvas_height) = if pallet { (840, 1188) } else { (580, 400) };
        let printer_name = string(config.get("name"))
            .filter(|value| !value.trim().is_empty())
            .unwrap_or("Printer");
        let protocol = string(config.get("protocol")).unwrap_or("image");
        let label_type = if pallet { "pallet" } else { "label" };
        let doc = json!({
            "id": "native-settings-test",
            "name": "LabelPilot test",
            "widthMm": width_mm,
            "heightMm": height_mm,
            "canvas": {
                "width": canvas_width,
                "height": canvas_height,
                "widthCm": width_mm / 10.0,
                "heightCm": height_mm / 10.0,
                "labelType": label_type
            },
            "elements": [
                {
                    "id": "title", "type": "text",
                    "x": 30, "y": 30, "w": canvas_width - 60, "h": if pallet { 100 } else { 70 },
                    "text": "LABELPILOT TEST", "fontFamily": "Inter",
                    "fontSize": if pallet { 40 } else { 28 }, "fontWeight": 700,
                    "textAlign": "center"
                },
                {
                    "id": "printer", "type": "text",
                    "x": 30, "y": if pallet { 160 } else { 115 }, "w": canvas_width - 60, "h": if pallet { 70 } else { 45 },
                    "text": printer_name, "fontFamily": "Inter",
                    "fontSize": if pallet { 28 } else { 18 }, "textAlign": "center"
                },
                {
                    "id": "protocol", "type": "text",
                    "x": 30, "y": if pallet { 245 } else { 165 }, "w": canvas_width - 60, "h": if pallet { 60 } else { 40 },
                    "text": format!("Protocol: {}", protocol.to_ascii_uppercase()),
                    "fontFamily": "Inter", "fontSize": if pallet { 24 } else { 16 },
                    "textAlign": "center"
                },
                {
                    "id": "barcode", "type": "barcode",
                    "x": if pallet { 170 } else { 100 }, "y": if pallet { 380 } else { 230 },
                    "w": if pallet { 500 } else { 380 }, "h": if pallet { 260 } else { 135 },
                    "barcodeType": "code128", "value": "LP-2026-000001", "showText": true
                }
            ]
        });
        let prepared = self.prepare(config, doc, json!({}))?;
        self.send_prepared(
            printer,
            events,
            prepared,
            &format!("native-settings-test:{}", Uuid::new_v4()),
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn record_and_print_pack(
        &self,
        persisted: &PersistedState,
        operational: &OperationalState,
        session: &SessionState,
        printer: &PrinterTransportState,
        events: &RuntimeEventSink,
        request: PackPrintRequest,
    ) -> Result<NativePrintOutcome, String> {
        if request.product_id <= 0 {
            return Err("выберите товар перед печатью".to_owned());
        }
        if !request.gross_weight_kg.is_finite() || request.gross_weight_kg <= 0.0 {
            return Err("вес брутто должен быть больше нуля".to_owned());
        }
        let product = self.product(operational, request.product_id)?;
        let label_id = integer(product.get("templates_pack_label"))
            .filter(|id| *id > 0)
            .ok_or_else(|| "для товара не назначен шаблон упаковки".to_owned())?;
        let doc = self.label_document(operational, label_id)?;
        let config = role_config(persisted, "packPrinter")?;
        ensure_active_printer(&config, "упаковки")?;
        let counters = operational.latest_counters(Some(request.product_id))?;
        let station_number = self.cached_station_number(persisted, operational)?;
        let numbering = persisted.load_numbering_config();
        let pack_number = formatted_counter(
            integer(counters.get("totalUnits")).unwrap_or(0) + 1,
            &station_number,
            &doc,
            "pack_number",
            &numbering,
            "unit",
        );
        let predicted_box = string(counters.get("currentBoxNumber"))
            .map(str::to_owned)
            .unwrap_or_else(|| {
                formatted_counter(
                    integer(counters.get("totalBoxes")).unwrap_or(0) + 1,
                    &station_number,
                    &doc,
                    "box_number",
                    &numbering,
                    "box",
                )
            });
        let production = parse_date(&request.production_date)?;
        let expiration = production + Duration::days(integer(product.get("exp_date")).unwrap_or(0));
        let portion_tare = number(product.get("portion_weight")).unwrap_or(0.0) / 1_000.0;
        let pack_net = (request.gross_weight_kg - portion_tare).max(0.0);
        let current_box_net = number(counters.get("boxNetWeight")).unwrap_or(0.0);
        let box_tare = self.product_box_tare_kg(operational, &product)?;
        let predicted_units_in_box = integer(counters.get("unitsInBox")).unwrap_or(0) + 1;
        let predicted_boxes_in_pallet = next_boxes_in_pallet(&counters);
        let current_operator = session.current();
        let mut data = build_label_data(LabelDataContext {
            product: &product,
            station_number: &station_number,
            operator_name: current_operator
                .as_ref()
                .map(|operator| operator.full_name.as_str())
                .unwrap_or_default(),
            operator_code: current_operator
                .as_ref()
                .map(|operator| operator.short_code.as_str())
                .unwrap_or_default(),
            production,
            expiration,
            batch_number: request.batch_number.trim(),
            pack_number: &pack_number,
            box_number: &predicted_box,
            pack_net,
            pack_gross: request.gross_weight_kg,
            box_net: current_box_net + pack_net,
            box_gross: current_box_net + pack_net + box_tare,
            units_in_box: predicted_units_in_box,
            boxes_in_pallet: predicted_boxes_in_pallet,
        })?;
        let barcode_fields = barcode_fields_for_doc(operational, &doc)?;
        let preliminary_barcode = resolve_barcode(&barcode_fields, &data, &product);
        data.insert(
            "barcode".to_owned(),
            Value::String(preliminary_barcode.clone()),
        );

        // Render before the DB mutation. Invalid templates and unsupported routes never create a pack row.
        let rendered = self.prepare(config.clone(), doc.clone(), Value::Object(data.clone()))?;
        let mut prepared = self.prepare_delivery(printer, rendered, "")?;
        let (result, (stored, job_id)) = operational.record_pack_with_outbox(
            RecordPackPayload {
                number: pack_number.clone(),
                box_number: predicted_box.clone(),
                nomenclature_id: request.product_id,
                weight_netto: pack_net,
                weight_brutto: request.gross_weight_kg,
                barcode_value: preliminary_barcode,
                station_number: Some(station_number),
                production_date: Some(iso_date(production)),
                expiration_date: Some(iso_date(expiration)),
                batch: Some(request.batch_number.trim().to_owned()),
                barcode_spec: (!barcode_fields.is_empty()).then_some(BarcodeSpec {
                    fields: barcode_fields.clone(),
                    data: data.clone(),
                }),
            },
            session.attribution(),
            |transaction, result| {
                let actual_barcode = if result.barcode_value.is_empty() {
                    resolve_barcode(&barcode_fields, &data, &product)
                } else {
                    result.barcode_value.clone()
                };
                if result.box_number != predicted_box
                    || actual_barcode != data.get("barcode").map(value_string).unwrap_or_default()
                {
                    data.insert(
                        "box_number".to_owned(),
                        Value::String(result.box_number.clone()),
                    );
                    data.insert("barcode".to_owned(), Value::String(actual_barcode));
                    let rendered = self.prepare(config.clone(), doc.clone(), Value::Object(data.clone()))?;
                    prepared = self.prepare_delivery(printer, rendered, "")?;
                }
                let job_id = prepared
                    .with_idempotency_key(&format!("native-pack:{}", result.pack_id))?
                    .persist(transaction)?;
                let stored = StoredPrint {
                    config,
                    doc,
                    data: Value::Object(data),
                    number: pack_number.clone(),
                    kind: "pack".to_owned(),
                    pack_id: Some(result.pack_id),
                };
                Ok((stored, job_id))
            },
        )?;
        let send_result = printer
            .submit_committed_with_sink(events.clone(), &job_id)
            .map_err(|error| {
                operational.record_print_error(
                    &format!("pack {} transport: {error}", result.pack_id),
                    "ERROR",
                );
                error
            });
        let receipt = match send_result {
            Ok(receipt) => receipt,
            Err(error) => {
                // The pack row is committed regardless of delivery, so the box
                // limit accounting must not stall until the printer returns.
                let after_pack = operational.latest_counters(Some(request.product_id))?;
                let limit = integer(product.get("close_box_counter")).unwrap_or(0);
                if limit > 0 && integer(after_pack.get("unitsInBox")).unwrap_or(0) >= limit {
                    if let Err(close_error) = self.close_box_internal(
                        persisted,
                        operational,
                        session,
                        printer,
                        events,
                        &product,
                        &request.batch_number,
                        production,
                    ) {
                        operational.record_print_error(
                            &format!("pack {} box auto-close: {close_error}", result.pack_id),
                            "ERROR",
                        );
                    }
                }
                return Err(error);
            }
        };
        let mut warnings = Vec::new();
        self.remember_accepted(stored, operational, events, &mut warnings);

        // Follow-up bookkeeping must not turn an accepted package into a failed print.
        let auto_close = (|| -> Result<bool, String> {
            let after_pack = operational.latest_counters(Some(request.product_id))?;
            let limit = integer(product.get("close_box_counter")).unwrap_or(0);
            if limit > 0 && integer(after_pack.get("unitsInBox")).unwrap_or(0) >= limit {
                let closed = self.close_box_internal(
                    persisted, operational, session, printer, events,
                    &product, &request.batch_number, production,
                )?;
                warnings.extend(closed.warnings);
                Ok(true)
            } else {
                Ok(false)
            }
        })();
        let auto_closed_box = match auto_close {
            Ok(closed) => closed,
            Err(error) => {
                Self::record_warning(operational, events, &mut warnings,
                    format!("Упаковка {} принята принтером; проверьте закрытие короба: {error}", result.pack_id));
                false
            }
        };
        Ok(NativePrintOutcome {
            kind: "pack".to_owned(),
            number: pack_number,
            box_number: Some(result.box_number),
            pack_id: Some(result.pack_id),
            auto_closed_box,
            receipt: Some(receipt),
            warnings,
        })
    }

    #[allow(clippy::too_many_arguments)]
    pub fn close_box(
        &self,
        persisted: &PersistedState,
        operational: &OperationalState,
        session: &SessionState,
        printer: &PrinterTransportState,
        events: &RuntimeEventSink,
        product_id: i64,
        batch_number: &str,
        production_date: &str,
    ) -> Result<NativePrintOutcome, String> {
        let product = self.product(operational, product_id)?;
        let production = parse_date(production_date)?;
        self.close_box_internal(
            persisted,
            operational,
            session,
            printer,
            events,
            &product,
            batch_number,
            production,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn close_box_internal(
        &self,
        persisted: &PersistedState,
        operational: &OperationalState,
        session: &SessionState,
        printer: &PrinterTransportState,
        events: &RuntimeEventSink,
        product: &Value,
        batch_number: &str,
        production: Date,
    ) -> Result<NativePrintOutcome, String> {
        let product_id = integer(product.get("id")).ok_or("product row has no id")?;
        let counters = operational.latest_counters(Some(product_id))?;
        let box_id = integer(counters.get("currentBoxId"))
            .ok_or_else(|| "в текущем коробе нет упаковок".to_owned())?;
        let units = integer(counters.get("unitsInBox")).unwrap_or(0);
        if units <= 0 {
            return Err("в текущем коробе нет упаковок".to_owned());
        }
        let box_number = string(counters.get("currentBoxNumber"))
            .unwrap_or("0")
            .to_owned();
        let box_net = number(counters.get("boxNetWeight")).unwrap_or(0.0);
        let box_tare = self.product_box_tare_kg(operational, product)?;
        let box_gross = box_net + box_tare;
        let expiration = production + Duration::days(integer(product.get("exp_date")).unwrap_or(0));

        let print_input = match integer(product.get("templates_box_label")).filter(|id| *id > 0) {
            Some(label_id) => {
                let doc = self.label_document(operational, label_id)?;
                let config = role_config(persisted, "boxPrinter")?;
                ensure_active_printer(&config, "короба")?;
                let station = self.cached_station_number(persisted, operational)?;
                let current_operator = session.current();
                let mut data = build_label_data(LabelDataContext {
                    product,
                    station_number: &station,
                    operator_name: current_operator
                        .as_ref()
                        .map(|operator| operator.full_name.as_str())
                        .unwrap_or_default(),
                    operator_code: current_operator
                        .as_ref()
                        .map(|operator| operator.short_code.as_str())
                        .unwrap_or_default(),
                    production,
                    expiration,
                    batch_number: batch_number.trim(),
                    pack_number: string(counters.get("lastPackNumber")).unwrap_or("0"),
                    box_number: &box_number,
                    pack_net: 0.0,
                    pack_gross: 0.0,
                    box_net,
                    box_gross,
                    units_in_box: units,
                    boxes_in_pallet: integer(counters.get("boxesInPallet")).unwrap_or(0),
                })?;
                let fields = barcode_fields_for_doc(operational, &doc)?;
                let barcode = resolve_barcode(&fields, &data, product);
                data.insert("barcode".to_owned(), Value::String(barcode));
                data.insert("is_box".to_owned(), Value::Bool(true));
                data.insert(
                    "count".to_owned(),
                    json!(integer(product.get("close_box_counter")).unwrap_or(0)),
                );
                let data = Value::Object(data);
                let rendered = self.prepare(config.clone(), doc.clone(), data.clone())?;
                let prepared = self.prepare_delivery(printer, rendered, &format!("native-box:{box_id}"))?;
                Some((config, doc, data, prepared))
            }
            None => None,
        };

        let committed = operational.close_box_with_outbox(
            CloseBoxPayload { box_id, weight_netto: box_net, weight_brutto: box_gross },
            |transaction| {
                print_input.map(|(config, doc, data, prepared)| {
                    let job_id = prepared.persist(transaction)?;
                    Ok((StoredPrint {
                        config, doc, data, number: box_number.clone(),
                        kind: "box".to_owned(), pack_id: None,
                    }, job_id))
                }).transpose()
            },
        )?.ok_or_else(|| format!("короб {box_number} уже закрыт или удалён"))?;
        let mut warnings = Vec::new();
        let receipt = if let Some((stored, job_id)) = committed {
            let receipt = printer.submit_committed_with_sink(events.clone(), &job_id)?;
            self.remember_accepted(stored, operational, events, &mut warnings);
            Some(receipt)
        } else {
            None
        };
        Ok(NativePrintOutcome {
            kind: "box".to_owned(),
            number: box_number.clone(),
            box_number: Some(box_number),
            pack_id: None,
            auto_closed_box: false,
            receipt,
            warnings,
        })
    }

    #[allow(clippy::too_many_arguments)]
    pub fn print_pallet(
        &self,
        persisted: &PersistedState,
        operational: &OperationalState,
        session: &SessionState,
        printer: &PrinterTransportState,
        events: &RuntimeEventSink,
        selected_product_id: Option<i64>,
    ) -> Result<NativePrintOutcome, String> {
        let operator_name = session
            .current()
            .map(|operator| operator.full_name)
            .unwrap_or_default();
        let data = operational.pallet_render_data(json!({ "operator_name": operator_name }))?;
        if data.is_null() {
            return Err("нет открытой паллеты".to_owned());
        }
        if data.get("hasOpenBox").and_then(Value::as_bool) == Some(true) {
            return Err("перед печатью паллетного листа закройте текущий короб".to_owned());
        }
        if data
            .get("items")
            .and_then(Value::as_array)
            .is_none_or(Vec::is_empty)
        {
            return Err("в открытой паллете нет продукции".to_owned());
        }
        let doc = self.pallet_document(operational, selected_product_id)?;
        let mut config = role_config(persisted, "palletPrinter")?;
        ensure_active_printer(&config, "паллеты")?;
        if string(config.get("connection")) == Some("windows_driver") {
            config["protocol"] = Value::String("browser".to_owned());
            config["printTarget"] = Value::String("page-sheet".to_owned());
            if config.get("pageFit").is_none() {
                config["pageFit"] = Value::String("fit-printable".to_owned());
            }
        }
        let pallet_number = string(data.get("pallet_number"))
            .filter(|value| !value.is_empty())
            .unwrap_or("pallet")
            .to_owned();
        config["documentName"] = Value::String(format!("LabelPilot pallet {pallet_number}"));
        let prepared = self.prepare(config.clone(), doc.clone(), data.clone())?;
        let receipt = self.send_prepared(
            printer,
            events,
            prepared,
            &format!("native-pallet:{pallet_number}"),
        )?;
        match operational.close_current_pallet() {
            Ok(value) if value.get("success").and_then(Value::as_bool) == Some(true) => {}
            Ok(_) => operational.record_print_error(
                &format!("pallet {pallet_number} printed but no pallet was closed"),
                "WARNING",
            ),
            Err(error) => operational.record_print_error(
                &format!("pallet {pallet_number} printed; close failed: {error}"),
                "ERROR",
            ),
        }
        let mut warnings = Vec::new();
        self.remember_accepted(StoredPrint {
            config,
            doc,
            data,
            number: pallet_number.clone(),
            kind: "pallet".to_owned(),
            pack_id: None,
        }, operational, events, &mut warnings);
        Ok(NativePrintOutcome {
            kind: "pallet".to_owned(),
            number: pallet_number,
            box_number: None,
            pack_id: None,
            auto_closed_box: false,
            receipt: Some(receipt),
            warnings,
        })
    }
    pub fn repeat_last(
        &self,
        printer: &PrinterTransportState,
        events: &RuntimeEventSink,
    ) -> Result<NativePrintOutcome, String> {
        let stored = self
            .last_print
            .lock()
            .map_err(|_| "last print lock is poisoned".to_owned())?
            .clone()
            .ok_or_else(|| "нет сохранённой этикетки для повтора".to_owned())?;
        let prepared = self.prepare(
            stored.config.clone(),
            stored.doc.clone(),
            stored.data.clone(),
        )?;
        let receipt = self.send_prepared(
            printer,
            events,
            prepared,
            &format!("native-repeat:{}", Uuid::new_v4()),
        )?;
        Ok(NativePrintOutcome {
            kind: "repeat".to_owned(),
            number: stored.number,
            box_number: None,
            pack_id: stored.pack_id,
            auto_closed_box: false,
            receipt: Some(receipt),
            warnings: Vec::new(),
        })
    }

    pub fn delete_latest_pack(
        &self,
        operational: &OperationalState,
        product_id: i64,
    ) -> Result<i64, String> {
        let pack_id = operational
            .latest_active_pack_id(product_id)?
            .ok_or_else(|| "в текущем коробе нет упаковок для удаления".to_owned())?;
        operational.delete_pack(pack_id)?;
        let mut last = self
            .last_print
            .lock()
            .map_err(|_| "last print lock is poisoned".to_owned())?;
        if last.as_ref().and_then(|stored| stored.pack_id) == Some(pack_id) {
            *last = None;
            let _ = fs::remove_file(&self.last_print_path);
        }
        Ok(pack_id)
    }

    fn product(&self, operational: &OperationalState, id: i64) -> Result<Value, String> {
        operational
            .product(id)?
            .ok_or_else(|| format!("товар #{id} не найден в локальной базе"))
    }

    fn pallet_document(
        &self,
        operational: &OperationalState,
        selected_product_id: Option<i64>,
    ) -> Result<Value, String> {
        if let Some(product_id) = selected_product_id.filter(|id| *id > 0) {
            if let Some(product) = operational.product(product_id)? {
                if let Some(label_id) =
                    integer(product.get("templates_pallet_label")).filter(|id| *id > 0)
                {
                    return self.label_document(operational, label_id);
                }
            }
        }
        for row in operational.all_labels()? {
            let Some(structure) = row.get("structure").and_then(Value::as_str) else {
                continue;
            };
            let Ok(doc) = serde_json::from_str::<Value>(structure) else {
                continue;
            };
            if string(doc.get("canvas").and_then(|canvas| canvas.get("labelType")))
                == Some("pallet")
            {
                return Ok(doc);
            }
        }
        Err("не назначен шаблон паллетного листа".to_owned())
    }
    fn label_document(&self, operational: &OperationalState, id: i64) -> Result<Value, String> {
        let row = operational
            .label(id)?
            .ok_or_else(|| format!("шаблон этикетки #{id} не найден"))?;
        let structure = row
            .get("structure")
            .and_then(Value::as_str)
            .ok_or_else(|| format!("шаблон этикетки #{id} не содержит structure"))?;
        serde_json::from_str(structure)
            .map_err(|error| format!("шаблон этикетки #{id} повреждён: {error}"))
    }

    fn cached_station_number(
        &self,
        persisted: &PersistedState,
        operational: &OperationalState,
    ) -> Result<String, String> {
        if let Some(station) = self.station_number_cache.get() {
            return Ok(station.clone());
        }
        let station = station_number(persisted, operational)?;
        let _ = self.station_number_cache.set(station.clone());
        Ok(station)
    }

    fn product_box_tare_kg(
        &self,
        operational: &OperationalState,
        product: &Value,
    ) -> Result<f64, String> {
        if let Some(weight_grams) = number(product.get("box_weight")) {
            return Ok(weight_grams / 1_000.0);
        }
        self.container_tare_kg(operational, integer(product.get("box_container_id")))
    }

    fn container_tare_kg(
        &self,
        operational: &OperationalState,
        id: Option<i64>,
    ) -> Result<f64, String> {
        let Some(id) = id.filter(|id| *id > 0) else {
            return Ok(0.0);
        };
        Ok(operational
            .containers()?
            .iter()
            .find(|container| integer(container.get("id")) == Some(id))
            .and_then(|container| number(container.get("weight")))
            .unwrap_or(0.0)
            / 1_000.0)
    }

    fn prepare(&self, config: Value, doc: Value, data: Value) -> Result<PreparedPrint, String> {
        let page_sheet = string(config.get("printTarget")) == Some("page-sheet")
            || string(doc.get("canvas").and_then(|canvas| canvas.get("labelType")))
                == Some("pallet");
        let payload = GenerationPayload {
            config: config.clone(),
            doc: doc.clone(),
            data: data.clone(),
        };
        let protocol = string(config.get("protocol"))
            .unwrap_or("zpl")
            .to_ascii_lowercase();
        let material = if raster_only_protocol(&protocol) {
            let bitmap = native_raster::render(&payload)?;
            self.generator.record_renderer_fallback(bitmap.mono.len());
            PreparedMaterial::Raster(bitmap)
        } else {
            match self.generator.generate_if_native(&payload)? {
                Some(generated) => PreparedMaterial::Raw(generated.bytes),
                None => {
                    let bitmap = native_raster::render(&payload)?;
                    self.generator.record_renderer_fallback(bitmap.mono.len());
                    PreparedMaterial::Raster(bitmap)
                }
            }
        };
        Ok(PreparedPrint {
            config,
            material,
            page_sheet,
        })
    }

    fn send_prepared(
        &self,
        printer: &PrinterTransportState,
        events: &RuntimeEventSink,
        prepared: PreparedPrint,
        idempotency_key: &str,
    ) -> Result<PrintReceipt, String> {
        let job = self.prepare_delivery(printer, prepared, idempotency_key)?;
        printer.submit_prepared_with_sink(events.clone(), job)
    }

    fn prepare_delivery(
        &self,
        printer: &PrinterTransportState,
        mut prepared: PreparedPrint,
        idempotency_key: &str,
    ) -> Result<PreparedPrinterJob, String> {
        let config = prepared
            .config
            .as_object_mut()
            .ok_or("printer config must be an object")?;
        config.insert(
            "jobIdempotencyKey".to_owned(),
            Value::String(idempotency_key.to_owned()),
        );
        let connection = string(config.get("connection"))
            .unwrap_or_default()
            .to_ascii_lowercase();
        match prepared.material {
            PreparedMaterial::Raw(bytes) => {
                printer.prepare_generated(prepared.config, bytes)
            }
            PreparedMaterial::Raster(bitmap)
                if connection == "windows_driver" && prepared.page_sheet =>
            {
                let margins = prepared
                    .config
                    .get("pageMarginsMm")
                    .cloned()
                    .and_then(|value| serde_json::from_value::<PageMarginsMm>(value).ok())
                    .unwrap_or_default();
                let fit_mode = string(prepared.config.get("pageFit"))
                    .unwrap_or("fit-printable")
                    .to_owned();
                let document_name = string(prepared.config.get("documentName"))
                    .unwrap_or("LabelPilot pallet sheet")
                    .to_owned();
                printer.prepare_driver_page(
                    prepared.config,
                    bitmap.width_dots as u32,
                    bitmap.height_dots as u32,
                    bitmap.mono,
                    bitmap.width_mm,
                    bitmap.height_mm,
                    margins,
                    fit_mode,
                    document_name,
                )
            }
            PreparedMaterial::Raster(bitmap) if connection == "windows_driver" => printer
                .prepare_driver_bitmap(
                    prepared.config,
                    bitmap.width_dots as u32,
                    bitmap.height_dots as u32,
                    bitmap.mono,
                ),
            PreparedMaterial::Raster(bitmap) => {
                let protocol = string(config.get("protocol")).unwrap_or("zpl").to_owned();
                let bytes = native_raster::encode(&protocol, &bitmap, &prepared.config)?;
                printer.prepare_generated(prepared.config, bytes)
            }
        }
    }

    fn record_warning(
        operational: &OperationalState,
        events: &RuntimeEventSink,
        warnings: &mut Vec<String>,
        message: String,
    ) {
        operational.record_print_error(&message, "WARN");
        events.log("printer", "WARN", &message);
        warnings.push(message);
    }

    fn remember_accepted(
        &self,
        stored: StoredPrint,
        operational: &OperationalState,
        events: &RuntimeEventSink,
        warnings: &mut Vec<String>,
    ) {
        if let Err(error) = self.remember(stored) {
            Self::record_warning(operational, events, warnings, format!(
                "Этикетка принята принтером; сохранение для повтора после перезапуска: {error}"
            ));
        }
    }

    fn remember(&self, stored: StoredPrint) -> Result<(), String> {
        // Serialize writers, and preserve the accepted label for repeat even when disk IO fails.
        let mut last_print = self.last_print.lock()
            .map_err(|_| "last print lock is poisoned".to_owned())?;
        *last_print = Some(stored);
        let bytes = serde_json::to_vec(last_print.as_ref().unwrap())
            .map_err(|error| format!("encode last print: {error}"))?;
        crate::persisted::atomic_write_bytes(&self.last_print_path, &bytes)
    }

}

enum PreparedMaterial {
    Raw(Vec<u8>),
    Raster(RasterizedLabel),
}
struct PreparedPrint {
    config: Value,
    material: PreparedMaterial,
    page_sheet: bool,
}

struct LabelDataContext<'a> {
    product: &'a Value,
    station_number: &'a str,
    operator_name: &'a str,
    operator_code: &'a str,
    production: Date,
    expiration: Date,
    batch_number: &'a str,
    pack_number: &'a str,
    box_number: &'a str,
    pack_net: f64,
    pack_gross: f64,
    box_net: f64,
    box_gross: f64,
    units_in_box: i64,
    boxes_in_pallet: i64,
}

fn build_label_data(context: LabelDataContext<'_>) -> Result<Map<String, Value>, String> {
    let product = context.product;
    let mut data = Map::new();
    data.insert(
        "name".to_owned(),
        product
            .get("name")
            .cloned()
            .unwrap_or(Value::String(String::new())),
    );
    data.insert(
        "article".to_owned(),
        product
            .get("article")
            .cloned()
            .unwrap_or(Value::String(String::new())),
    );
    data.insert(
        "exp_date".to_owned(),
        json!(integer(product.get("exp_date")).unwrap_or(0).to_string()),
    );
    data.insert(
        "weight".to_owned(),
        json!(format!("{:.3}", context.pack_net)),
    );
    data.insert(
        "weight_netto_pack".to_owned(),
        json!(format!("{:.3}", context.pack_net)),
    );
    data.insert(
        "weight_brutto_pack".to_owned(),
        json!(format!("{:.3}", context.pack_gross)),
    );
    data.insert(
        "weight_netto_box".to_owned(),
        json!(format!("{:.3}", context.box_net)),
    );
    data.insert(
        "weight_brutto_box".to_owned(),
        json!(format!("{:.3}", context.box_gross)),
    );
    data.insert("weight_netto_pallet".to_owned(), json!("0.000"));
    data.insert("weight_brutto_pallet".to_owned(), json!("0.000"));
    data.insert("weight_brutto_all".to_owned(), json!("0.000"));
    data.insert(
        "date".to_owned(),
        json!(format_short_date(context.production)),
    );
    data.insert(
        "production_date".to_owned(),
        json!(format_full_date(context.production)),
    );
    data.insert(
        "date_exp".to_owned(),
        json!(format_short_date(context.expiration)),
    );
    data.insert(
        "exp_date_full".to_owned(),
        json!(format_full_date(context.expiration)),
    );
    data.insert("pack_number".to_owned(), json!(context.pack_number));
    data.insert("box_number".to_owned(), json!(context.box_number));
    data.insert("batch_number".to_owned(), json!(context.batch_number));
    data.insert(
        "pack_count".to_owned(),
        json!(context.units_in_box.to_string()),
    );
    data.insert(
        "pack_counter".to_owned(),
        json!(context.units_in_box.to_string()),
    );
    data.insert(
        "close_box_counter".to_owned(),
        json!(context.units_in_box.to_string()),
    );
    data.insert(
        "box_limit".to_owned(),
        json!(integer(product.get("close_box_counter"))
            .unwrap_or(0)
            .to_string()),
    );
    data.insert(
        "box_count".to_owned(),
        json!(context.boxes_in_pallet.to_string()),
    );
    data.insert("station_number".to_owned(), json!(context.station_number));
    data.insert("operator".to_owned(), json!(context.operator_code));
    data.insert("operator_name".to_owned(), json!(context.operator_name));
    data.insert("_raw_weight_netto_pack".to_owned(), json!(context.pack_net));
    data.insert(
        "_raw_weight_brutto_pack".to_owned(),
        json!(context.pack_gross),
    );
    data.insert("_raw_weight_netto_box".to_owned(), json!(context.box_net));
    data.insert(
        "_raw_weight_brutto_box".to_owned(),
        json!(context.box_gross),
    );
    if let Some(extra) = product
        .get("extra_data")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
    {
        let extra: Value = serde_json::from_str(extra)
            .map_err(|error| format!("extra_data товара повреждён: {error}"))?;
        if let Some(extra) = extra.as_object() {
            data.extend(extra.clone());
        }
    }
    Ok(data)
}

fn barcode_fields_for_doc(
    operational: &OperationalState,
    doc: &Value,
) -> Result<Vec<Value>, String> {
    let template_id = doc
        .get("elements")
        .and_then(Value::as_array)
        .and_then(|elements| {
            elements
                .iter()
                .find(|element| string(element.get("type")) == Some("barcode"))
        })
        .and_then(|element| integer(element.get("templateId")));
    let Some(template_id) = template_id.filter(|id| *id > 0) else {
        return Ok(Vec::new());
    };
    let row = operational
        .barcode_template(template_id)?
        .ok_or_else(|| format!("шаблон штрихкода #{template_id} не найден"))?;
    let structure = row
        .get("structure")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("шаблон штрихкода #{template_id} не содержит structure"))?;
    let structure: Value = serde_json::from_str(structure)
        .map_err(|error| format!("шаблон штрихкода #{template_id} повреждён: {error}"))?;
    Ok(structure
        .get("fields")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default())
}

fn resolve_barcode(fields: &[Value], data: &Map<String, Value>, product: &Value) -> String {
    let generated = if fields.is_empty() {
        String::new()
    } else {
        generate_barcode(fields, data)
    };
    if !generated.is_empty() && !generated.chars().all(|character| character == '0') {
        return generated;
    }
    data.get("Код ШК")
        .map(value_string)
        .filter(|value| !value.is_empty())
        .or_else(|| {
            product
                .get("barcode")
                .map(value_string)
                .filter(|value| !value.is_empty())
        })
        .or_else(|| {
            product
                .get("article")
                .map(value_string)
                .filter(|value| !value.is_empty())
        })
        .unwrap_or_else(|| "0000000000000".to_owned())
}

fn formatted_counter(
    count: i64,
    station: &str,
    doc: &Value,
    placeholder: &str,
    numbering: &Value,
    role: &str,
) -> String {
    let min_length = doc
        .get("elements")
        .and_then(Value::as_array)
        .and_then(|elements| {
            elements.iter().find(|element| {
                string(element.get("text")).is_some_and(|text| {
                    text.to_ascii_lowercase()
                        .contains(&placeholder.to_ascii_lowercase())
                })
            })
        })
        .and_then(|element| {
            integer(element.get("minLength")).or_else(|| integer(element.get("minLeght")))
        })
        .unwrap_or(0);
    let count = count.max(0).to_string();
    if min_length > 0 {
        return format!(
            "{station}{}",
            pad_start(
                &count,
                (min_length as usize).saturating_sub(station.chars().count())
            )
        );
    }
    let config = numbering.get(role).and_then(Value::as_object);
    if config
        .and_then(|config| config.get("enabled"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        let prefix = config
            .and_then(|config| config.get("prefix"))
            .and_then(Value::as_str)
            .unwrap_or(station);
        let length = config
            .and_then(|config| integer(config.get("length")))
            .unwrap_or(0)
            .max(0) as usize;
        return format!("{prefix}{}", pad_start(&count, length));
    }
    format!("{station}{count}")
}

fn station_number(
    persisted: &PersistedState,
    operational: &OperationalState,
) -> Result<String, String> {
    Ok(persisted
        .load_identity()
        .as_ref()
        .and_then(|identity| string(identity.get("station_number")))
        .map(str::to_owned)
        .or_else(|| {
            operational
                .station_info()
                .ok()
                .as_ref()
                .and_then(|station| station.get("station_number"))
                .map(value_string)
        })
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "00".to_owned()))
}

fn log_printer_env_override(host: &str, port: u16) {
    static LOGGED: std::sync::OnceLock<()> = std::sync::OnceLock::new();
    if LOGGED.set(()).is_ok() {
        crate::runtime_selector::append_runtime_log(&format!(
            "LABELPILOT_PRINTER_HOST override active: pack/box printing redirected to {host}:{port}"
        ));
    }
}

fn role_config(persisted: &PersistedState, role: &str) -> Result<Value, String> {
    if matches!(role, "packPrinter" | "boxPrinter") {
        if let Some(host) = std::env::var("LABELPILOT_PRINTER_HOST")
            .ok()
            .filter(|host| !host.trim().is_empty())
        {
            let port = std::env::var("LABELPILOT_PRINTER_PORT")
                .ok()
                .and_then(|value| value.parse::<u16>().ok())
                .unwrap_or(9_100);
            log_printer_env_override(&host, port);
            return Ok(json!({
                "id": format!("slint-{}-override", role.trim_end_matches("Printer")),
                "active": true,
                "name": "Slint ZPL virtual printer",
                "connection": "tcp",
                "protocol": "image",
                "ip": host,
                "port": port,
                "dpi": std::env::var("LABELPILOT_PRINTER_DPI").ok().and_then(|value| value.parse::<u16>().ok()).unwrap_or(300)
            }));
        }
    }
    persisted
        .load_printer_config()
        .get(role)
        .cloned()
        .ok_or_else(|| format!("конфигурация {role} отсутствует"))
}
fn ensure_active_printer(config: &Value, role: &str) -> Result<(), String> {
    if config.get("active").and_then(Value::as_bool) == Some(false) {
        return Err(format!("принтер {role} выключен в настройках"));
    }
    if string(config.get("connection"))
        .unwrap_or_default()
        .is_empty()
    {
        return Err(format!("для принтера {role} не задано подключение"));
    }
    Ok(())
}
fn parse_date(value: &str) -> Result<Date, String> {
    let trimmed = value.trim();
    let parts: Vec<&str> = if trimmed.contains('.') {
        trimmed.split('.').collect()
    } else {
        trimmed.split('-').collect()
    };
    if parts.len() != 3 {
        return Err(format!("неверная дата маркировки: {trimmed}"));
    }
    let (year, month, day) = if trimmed.contains('.') {
        (parts[2], parts[1], parts[0])
    } else {
        (parts[0], parts[1], parts[2])
    };
    let year = year
        .parse::<i32>()
        .map_err(|_| format!("неверный год: {year}"))?;
    let month_number = month
        .parse::<u8>()
        .map_err(|_| format!("неверный месяц: {month}"))?;
    let day = day
        .parse::<u8>()
        .map_err(|_| format!("неверный день: {day}"))?;
    let month =
        Month::try_from(month_number).map_err(|_| format!("неверный месяц: {month_number}"))?;
    Date::from_calendar_date(year, month, day)
        .map_err(|error| format!("неверная дата маркировки: {error}"))
}
fn iso_date(date: Date) -> String {
    format!(
        "{:04}-{:02}-{:02}T00:00:00.000Z",
        date.year(),
        date.month() as u8,
        date.day()
    )
}
fn format_short_date(date: Date) -> String {
    format!(
        "{:02}.{:02}.{:02}",
        date.day(),
        date.month() as u8,
        date.year().rem_euclid(100)
    )
}
fn format_full_date(date: Date) -> String {
    format!(
        "{:02}.{:02}.{:04}",
        date.day(),
        date.month() as u8,
        date.year()
    )
}
fn pad_start(value: &str, length: usize) -> String {
    if value.chars().count() >= length {
        value.to_owned()
    } else {
        format!("{}{}", "0".repeat(length - value.chars().count()), value)
    }
}
fn raster_only_protocol(protocol: &str) -> bool {
    matches!(
        protocol,
        "image" | "browser" | "epl" | "cpcl" | "dpl" | "sbpl"
    )
}

fn next_boxes_in_pallet(counters: &Value) -> i64 {
    integer(counters.get("boxesInPallet")).unwrap_or(0)
        + i64::from(integer(counters.get("currentBoxId")).is_none())
}

fn integer(value: Option<&Value>) -> Option<i64> {
    match value? {
        Value::Number(value) => value
            .as_i64()
            .or_else(|| value.as_f64().map(|value| value as i64)),
        Value::String(value) => value.parse().ok(),
        _ => None,
    }
}
fn number(value: Option<&Value>) -> Option<f64> {
    match value? {
        Value::Number(value) => value.as_f64(),
        Value::String(value) => value.parse().ok(),
        _ => None,
    }
    .filter(|value| value.is_finite())
}
fn string(value: Option<&Value>) -> Option<&str> {
    value?.as_str()
}
fn value_string(value: &Value) -> String {
    match value {
        Value::String(value) => value.clone(),
        Value::Number(value) => value.to_string(),
        Value::Bool(value) => value.to_string(),
        _ => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn formatting_matches_template_total_length() {
        let doc = json!({"elements":[{"type":"text","text":"№ {{ pack_number }}","minLength":8}]});
        assert_eq!(
            formatted_counter(246, "02", &doc, "pack_number", &json!({}), "unit"),
            "02000246"
        );
    }
    #[test]
    fn skips_native_planning_for_raster_only_protocols() {
        for protocol in ["image", "browser", "epl", "cpcl", "dpl", "sbpl"] {
            assert!(raster_only_protocol(protocol), "{protocol}");
        }
        assert!(!raster_only_protocol("zpl"));
        assert!(!raster_only_protocol("tspl"));
    }

    #[test]
    #[ignore = "manual raster hot-path benchmark"]
    fn benchmark_direct_raster_vs_plan_then_render() {
        use std::hint::black_box;
        use std::time::Instant;

        let payload = GenerationPayload {
            config: json!({"connection":"windows_driver", "protocol":"image", "dpi":300}),
            doc: json!({
                "canvas":{"width":600,"height":300,"widthCm":5.08,"heightCm":2.54,"dpi":300},
                "elements":[
                    {"id":"name","type":"text","x":10,"y":10,"w":580,"h":100,"text":"Этикетка {{name}}","fontFamily":"Inter","fontSize":24,"fontWeight":600,"textAlign":"center"},
                    {"id":"barcode","type":"barcode","x":100,"y":140,"w":400,"h":120,"barcodeType":"ean13","value":"{{barcode}}","showText":true}
                ]
            }),
            data: json!({"name":"готова","barcode":"4870254930240"}),
        };
        let _ = native_raster::warmup_static_assets();
        black_box(native_raster::render(&payload).unwrap());
        let iterations = 2_000_u64;
        let generator = GeneratorState::default();

        let legacy_started = Instant::now();
        let mut legacy_bytes = 0_usize;
        for _ in 0..iterations {
            black_box(generator.plan(&payload).unwrap());
            legacy_bytes += black_box(native_raster::render(&payload).unwrap().mono.len());
        }
        let legacy_micros = legacy_started.elapsed().as_micros();

        let direct_started = Instant::now();
        let mut direct_bytes = 0_usize;
        for _ in 0..iterations {
            direct_bytes += black_box(native_raster::render(&payload).unwrap().mono.len());
        }
        let direct_micros = direct_started.elapsed().as_micros();

        assert_eq!(legacy_bytes, direct_bytes);
        println!(
            "PRINT_RASTER_ROUTE_BENCH iterations={iterations} legacy_us={legacy_micros} direct_us={direct_micros} speedup_x={:.2}",
            legacy_micros as f64 / direct_micros.max(1) as f64
        );
    }

    #[test]
    fn pallet_box_count_advances_only_when_opening_a_new_box() {
        assert_eq!(
            next_boxes_in_pallet(&json!({"boxesInPallet": 7, "currentBoxId": 42})),
            7
        );
        assert_eq!(
            next_boxes_in_pallet(&json!({"boxesInPallet": 7, "currentBoxId": null})),
            8
        );
    }

    #[test]
    fn parses_both_ui_and_iso_dates() {
        assert_eq!(
            format_full_date(parse_date("24.08.2026").unwrap()),
            "24.08.2026"
        );
        assert_eq!(
            format_full_date(parse_date("2026-08-24").unwrap()),
            "24.08.2026"
        );
    }

    #[test]
    fn production_lifecycle_records_repeats_deletes_and_closes_over_tcp() {
        production_lifecycle(false, false, false);
    }

    #[test]
    fn accepted_print_survives_last_print_disk_failure_and_still_auto_closes() {
        production_lifecycle(true, true, false);
    }

    #[test]
    fn accepted_pack_preserves_receipt_when_box_outbox_fails() {
        production_lifecycle(false, true, true);
    }

    fn production_lifecycle(fail_remember: bool, auto_close: bool, fail_box_outbox: bool) {
        use crate::runtime_events::RuntimeEventSink;
        use rusqlite::Connection;
        use std::io::Read;
        use std::net::TcpListener;
        use std::thread;
        use std::time::{SystemTime, UNIX_EPOCH};

        struct TestDir(PathBuf);
        impl Drop for TestDir {
            fn drop(&mut self) {
                let _ = fs::remove_dir_all(&self.0);
            }
        }
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let directory = TestDir(std::env::temp_dir().join(format!(
            "labelpilot-native-print-e2e-{}-{suffix}",
            std::process::id()
        )));
        fs::create_dir_all(&directory.0).unwrap();
        let persisted = PersistedState::for_data_dir(directory.0.clone());
        persisted
            .save_identity(&json!({
                "station_uuid":"station-e2e",
                "station_number":"07",
                "station_name":"E2E"
            }))
            .unwrap();

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        listener.set_nonblocking(true).unwrap();
        let server = thread::spawn(move || {
            let mut jobs: Vec<Vec<u8>> = Vec::new();
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
            while jobs.len() < 5 && std::time::Instant::now() < deadline {
                let (mut stream, _) = match listener.accept() {
                    Ok(value) => value,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(std::time::Duration::from_millis(10));
                        continue;
                    }
                    Err(error) => panic!("TCP accept failed: {error}"),
                };
                stream
                    .set_read_timeout(Some(std::time::Duration::from_millis(500)))
                    .unwrap();
                let connection_deadline =
                    std::time::Instant::now() + std::time::Duration::from_secs(8);
                let mut pending = Vec::new();
                let mut buffer = [0_u8; 8_192];
                while std::time::Instant::now() < connection_deadline {
                    let read = match stream.read(&mut buffer) {
                        Ok(0) => break,
                        Ok(read) => read,
                        Err(error)
                            if matches!(
                                error.kind(),
                                std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
                            ) =>
                        {
                            continue;
                        }
                        Err(error) => panic!("TCP read failed: {error}"),
                    };
                    pending.extend_from_slice(&buffer[..read]);
                    while let Some(end) = pending.windows(3).position(|window| window == b"^XZ") {
                        jobs.push(pending.drain(..end + 3).collect());
                        if jobs.len() == 5 {
                            return jobs;
                        }
                    }
                }
                assert!(pending.is_empty(), "received an incomplete ZPL print job");
            }
            jobs
        });
        let device = json!({
            "id":"e2e-zpl",
            "active":true,
            "name":"E2E virtual ZPL",
            "connection":"tcp",
            "protocol":"image",
            "ip":"127.0.0.1",
            "port":port,
            "dpi":300,
            "persistentConnection":true
        });
        persisted
            .save_printer_config(json!({
                "packPrinter":device,
                "boxPrinter":device,
                "palletPrinter":device,
                "autoPrintOnStable":false,
                "serverIp":"",
                "language":"ru"
            }))
            .unwrap();
        let connection = crate::processor::open_database(&persisted).unwrap();
        let embedded_logo = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=".to_owned();
        let pack_doc = json!({
            "canvas":{"width":600,"height":300,"widthCm":5.08,"heightCm":2.54,"dpi":300},
            "elements":[
                {"id":"name","type":"text","x":10,"y":10,"w":580,"h":80,"text":"Товар {{ name }}","fontFamily":"Inter","fontSize":24,"fontWeight":600,"textAlign":"center"},
                {"id":"number","type":"text","x":10,"y":90,"w":580,"h":45,"text":"№ {{ pack_number }}","minLength":8,"fontFamily":"Inter","fontSize":18},
                {"id":"logo","type":"image","x":10,"y":155,"w":40,"h":40,"imageData":embedded_logo.clone()},
                {"id":"barcode","type":"barcode","x":60,"y":145,"w":330,"h":130,"barcodeType":"ean13","templateId":1,"value":"{{ barcode }}","showText":true},
                {"id":"qr","type":"barcode","x":420,"y":145,"w":130,"h":130,"barcodeType":"qrcode","value":"https://labelpilot.local/pack/{{ pack_number }}"}
            ]
        });
        let box_doc = json!({
            "canvas":{"width":600,"height":300,"widthCm":5.08,"heightCm":2.54,"dpi":300},
            "elements":[
                {"id":"box","type":"text","x":10,"y":10,"w":580,"h":100,"text":"Короб {{ box_number }} · {{ weight_netto_box }} кг","fontFamily":"Inter","fontSize":22,"fontWeight":600,"textAlign":"center"},
                {"id":"barcode","type":"barcode","x":60,"y":145,"w":330,"h":130,"barcodeType":"ean13","templateId":1,"value":"{{ barcode }}","showText":true},
                {"id":"gs1dm","type":"barcode","x":420,"y":145,"w":130,"h":130,"barcodeType":"gs1datamatrix","value":"(01)04870254930240(10){{ batch_number }}"}
            ]
        });
        let pallet_doc = json!({
            "canvas":{"width":840,"height":1188,"widthCm":21.0,"heightCm":29.7,"dpi":300,"labelType":"pallet"},
            "elements":[
                {"id":"logo","type":"image","x":20,"y":20,"w":60,"h":60,"imageData":embedded_logo},
                {"id":"title","type":"text","x":90,"y":20,"w":730,"h":70,"text":"Паллетный лист {{ pallet_number }}","fontFamily":"Inter","fontSize":28,"fontWeight":700,"textAlign":"center"},
                {"id":"table","type":"table","x":20,"y":110,"w":800,"h":900,"fontFamily":"Inter","fontSize":14,"showHeaders":true,"showBorders":true,"columns":[
                    {"key":"name","title":"Товар","widthRatio":45},
                    {"key":"quantity","title":"Количество","widthRatio":15},
                    {"key":"weight_netto_pack","title":"Нетто","widthRatio":20},
                    {"key":"batch_number","title":"Партия","widthRatio":20}
                ]},
                {"id":"total","type":"text","x":20,"y":1030,"w":800,"h":80,"text":"Всего: {{ total_count }} · {{ weight_netto_pallet }} кг","fontFamily":"Inter","fontSize":22,"fontWeight":600}
            ]
        });
        connection
            .execute(
                "INSERT INTO barcodes(id,name,structure) VALUES(1,'EAN13',?1)",
                [
                    json!({"fields":[{"field_type":"extra_data","value":"Код ШК","length":13}]})
                        .to_string(),
                ],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO labels(id,name,structure) VALUES(1,'Pack',?1),(2,'Box',?2),(3,'Pallet',?3)",
                [pack_doc.to_string(), box_doc.to_string(), pallet_doc.to_string()],
            )
            .unwrap();
        connection
            .execute_batch(
                r#"
            INSERT INTO station(uuid,number,name) VALUES('station-e2e',7,'E2E');
            INSERT INTO container(id,name,weight) VALUES(1,'Tray',100),(2,'Box',500);
            INSERT INTO nomenclature(
                id,name,article,exp_date,portion_container_id,box_container_id,
                templates_pack_label,templates_box_label,templates_pallet_label,close_box_counter,extra_data
            ) VALUES(1,'Колбаса','3002',10,1,2,1,2,3,10,'{"Код ШК":"4870254930240"}');
            "#,
            )
            .unwrap();
        drop(connection);

        let operational = OperationalState::new(&persisted).unwrap();
        let session = SessionState::new(directory.0.clone());
        let mut printer = PrinterTransportState::with_database(&persisted.database_path()).unwrap();
        let events = RuntimeEventSink::callback(|_| {});
        let service = NativePrintService::new(directory.0.clone());
        if fail_remember {
            // A directory at the destination forces atomic file replacement to fail.
            fs::create_dir(&service.last_print_path).unwrap();
        }
        let request = PackPrintRequest {
            product_id: 1,
            gross_weight_kg: 1.1,
            batch_number: "B-1".to_owned(),
            production_date: "24.08.2026".to_owned(),
        };
        if fail_remember {
            let connection = Connection::open(persisted.database_path()).unwrap();
            connection.execute_batch("CREATE TRIGGER reject_native_outbox BEFORE INSERT ON printer_delivery_jobs
                BEGIN SELECT RAISE(ABORT, 'injected native outbox failure'); END;").unwrap();
            let error = service.record_and_print_pack(&persisted, &operational, &session, &printer, &events, request.clone()).unwrap_err();
            assert!(error.contains("injected native outbox failure"));
            assert_eq!(operational.latest_counters(Some(1)).unwrap()["totalUnits"], 0);
            assert_eq!(connection.query_row("SELECT COUNT(*) FROM printer_delivery_jobs", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
            connection.execute_batch("DROP TRIGGER reject_native_outbox").unwrap();
        }
        let first = service
            .record_and_print_pack(
                &persisted,
                &operational,
                &session,
                &printer,
                &events,
                request.clone(),
            )
            .unwrap();
        assert_eq!(first.number, "07000001");
        assert_eq!(first.warnings.is_empty(), !fail_remember);
        assert_eq!(first.receipt.as_ref().unwrap().durable_state.as_deref(), Some("accepted"));
        if !fail_remember {
            let restarted = NativePrintService::new(directory.0.clone());
            assert_eq!(restarted.last_print.lock().unwrap().as_ref().unwrap().pack_id, first.pack_id);
        }
        assert_eq!(
            operational.latest_counters(Some(1)).unwrap()["totalUnits"],
            1
        );
        printer.disconnect_all();
        printer = PrinterTransportState::with_database(&persisted.database_path()).unwrap();
        service.repeat_last(&printer, &events).unwrap();
        printer.disconnect_all();
        let deleted = service.delete_latest_pack(&operational, 1).unwrap();
        assert_eq!(deleted, first.pack_id.unwrap());
        assert_eq!(
            operational.latest_counters(Some(1)).unwrap()["totalUnits"],
            0
        );

        printer = PrinterTransportState::with_database(&persisted.database_path()).unwrap();
        if auto_close {
            Connection::open(persisted.database_path()).unwrap().execute(
                "UPDATE nomenclature SET close_box_counter=1 WHERE id=1", []).unwrap();
        }
        if fail_box_outbox {
            Connection::open(persisted.database_path()).unwrap().execute_batch(
                "CREATE TRIGGER reject_box_outbox BEFORE INSERT ON printer_delivery_jobs
                 WHEN NEW.idempotency_key LIKE 'native-box:%'
                 BEGIN SELECT RAISE(ABORT, 'injected auto-close outbox failure'); END;"
            ).unwrap();
        }
        let second = service
            .record_and_print_pack(
                &persisted,
                &operational,
                &session,
                &printer,
                &events,
                request,
            )
            .unwrap();
        assert_eq!(second.number, "07000001");
        printer.disconnect_all();
        printer = PrinterTransportState::with_database(&persisted.database_path()).unwrap();
        assert_eq!(second.auto_closed_box, auto_close && !fail_box_outbox);
        assert_eq!(second.warnings.is_empty(), !fail_remember && !fail_box_outbox);
        if fail_box_outbox {
            assert_eq!(second.receipt.as_ref().unwrap().durable_state.as_deref(), Some("accepted"));
            assert!(second.warnings.iter().any(|warning| warning.contains("injected auto-close outbox failure")));
            assert_ne!(operational.latest_counters(Some(1)).unwrap()["currentBoxId"], Value::Null);
            Connection::open(persisted.database_path()).unwrap().execute_batch("DROP TRIGGER reject_box_outbox").unwrap();
        }
        if !auto_close || fail_box_outbox {
            let closed = service
                .close_box(
                    &persisted,
                    &operational,
                    &session,
                    &printer,
                    &events,
                    1,
                    "B-1",
                    "24.08.2026",
                )
                .unwrap();
            assert_eq!(closed.kind, "box");
        } else {
            assert_eq!(operational.latest_counters(Some(1)).unwrap()["currentBoxId"], Value::Null);
            assert_eq!(service.last_print.lock().unwrap().as_ref().unwrap().kind, "box");
        }
        printer.disconnect_all();
        printer = PrinterTransportState::with_database(&persisted.database_path()).unwrap();
        let pallet = service
            .print_pallet(
                &persisted,
                &operational,
                &session,
                &printer,
                &events,
                Some(1),
            )
            .unwrap();
        assert_eq!(pallet.kind, "pallet");
        assert_eq!(pallet.warnings.is_empty(), !fail_remember);
        assert_eq!(
            operational.latest_counters(Some(1)).unwrap()["currentBoxId"],
            Value::Null
        );
        printer.disconnect_all();
        let jobs = server.join().unwrap();
        assert_eq!(jobs.len(), 5);
        assert_eq!(jobs[0], jobs[1], "repeat must resend the accepted label exactly");
        assert!(jobs
            .iter()
            .all(|job| job.starts_with(b"^XA") && job.ends_with(b"^XZ")));
        assert!(jobs
            .iter()
            .all(|job| job.windows(4).any(|window| window == b"^GFA")));
        assert!(jobs[..4]
            .iter()
            .all(|job| job.windows(4).any(|window| window == b"^BEN")));
        assert!(jobs
            .iter()
            .all(|job| !job.windows(3).any(|window| window == b"^BQ")));
        assert!(jobs
            .iter()
            .all(|job| !job.windows(3).any(|window| window == b"^BX")));
        printer.disconnect_all();
        let connection = Connection::open(persisted.database_path()).unwrap();
        let accepted: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM printer_delivery_jobs WHERE state='accepted'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(accepted, 5);
    }
}
