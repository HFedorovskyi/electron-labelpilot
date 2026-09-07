use super::metrics::PrintTimingRecord;
use super::*;
use crate::operational::{OperatorAttribution, RecordPackResult};
use crate::printer::PendingPrintReceipt;
use crate::session::CurrentOperator;

const MAX_PREPARATION_ATTEMPTS: usize = 3;

#[derive(Clone)]
pub(super) struct BoxAssets {
    pub doc: Value,
    pub config: Value,
    pub barcode_fields: Vec<Value>,
}

/// Immutable inputs for a batch; counters are always read separately.
pub(super) struct PackSnapshot {
    pub request: PackPrintRequest,
    pub product: Value,
    pub doc: Value,
    pub config: Value,
    pub numbering: Value,
    pub station_number: String,
    pub operator: Option<CurrentOperator>,
    pub box_tare: f64,
    pub box_assets: Result<Option<BoxAssets>, String>,
    pub snapshot_us: u64,
    production: Date,
    expiration: Date,
    pack_net: f64,
    barcode_fields: Vec<Value>,
}

pub(super) struct PreparedPack {
    pub started: Instant,
    pub timings: PrintStageTimings,
    pub prepared_ahead: bool,
    pub must_close_box: bool,
    counters: Value,
    number: String,
    predicted_box: String,
    data: Map<String, Value>,
    job: PreparedPrinterJob,
}

pub(super) struct CommittedPack {
    pub result: RecordPackResult,
    pub job_id: String,
    pub must_close_box: bool,
    pub stale_retries: usize,
    started: Instant,
    timings: PrintStageTimings,
    prepared_ahead: bool,
    number: String,
    stored: StoredPrint,
}

pub(super) struct FinishedPack {
    pub outcome: NativePrintOutcome,
    pub box_close_error: Option<String>,
}

impl NativePrintService {
    pub(super) fn capture_box_assets(
        &self,
        persisted: &PersistedState,
        operational: &OperationalState,
        product: &Value,
    ) -> Result<Option<BoxAssets>, String> {
        let Some(label_id) = integer(product.get("templates_box_label")).filter(|id| *id > 0)
        else {
            return Ok(None);
        };
        let doc = self.label_document(operational, label_id)?;
        let config = role_config(persisted, "boxPrinter")?;
        ensure_active_printer(&config, "короба")?;
        let barcode_fields = barcode_fields_for_doc(operational, &doc)?;
        Ok(Some(BoxAssets {
            doc,
            config,
            barcode_fields,
        }))
    }

    pub(super) fn capture_pack_snapshot(
        &self,
        persisted: &PersistedState,
        operational: &OperationalState,
        session: &SessionState,
        request: PackPrintRequest,
    ) -> Result<PackSnapshot, String> {
        let started = Instant::now();
        let product = self.product(operational, request.product_id)?;
        let mut snapshot =
            self.capture_pack_inputs(persisted, operational, session, request, product)?;
        snapshot.snapshot_us = elapsed_us(started);
        Ok(snapshot)
    }

    pub(super) fn capture_pack_inputs(
        &self,
        persisted: &PersistedState,
        operational: &OperationalState,
        session: &SessionState,
        request: PackPrintRequest,
        product: Value,
    ) -> Result<PackSnapshot, String> {
        let started = Instant::now();
        if request.product_id <= 0 {
            return Err("выберите товар перед печатью".to_owned());
        }
        if !request.gross_weight_kg.is_finite() || request.gross_weight_kg <= 0.0 {
            return Err("вес брутто должен быть больше нуля".to_owned());
        }
        let label_id = integer(product.get("templates_pack_label"))
            .filter(|id| *id > 0)
            .ok_or_else(|| "для товара не назначен шаблон упаковки".to_owned())?;
        let doc = self.label_document(operational, label_id)?;
        let config = role_config(persisted, "packPrinter")?;
        ensure_active_printer(&config, "упаковки")?;
        let station_number = self.cached_station_number(persisted, operational)?;
        let numbering = persisted.load_numbering_config();
        let production = parse_date(&request.production_date)?;
        let expiration = production + Duration::days(integer(product.get("exp_date")).unwrap_or(0));
        let portion_tare = number(product.get("portion_weight")).unwrap_or(0.0) / 1_000.0;
        let pack_net = (request.gross_weight_kg - portion_tare).max(0.0);
        let box_tare = self.product_box_tare_kg(operational, &product)?;
        let operator = session.current();
        let barcode_fields = barcode_fields_for_doc(operational, &doc)?;
        // A single accepted pack retains box follow-up errors as warnings.
        // Batches can validate these captured assets before their first mutation.
        let box_assets = self.capture_box_assets(persisted, operational, &product);
        Ok(PackSnapshot {
            request,
            product,
            doc,
            config,
            numbering,
            station_number,
            operator,
            box_tare,
            box_assets,
            production,
            expiration,
            pack_net,
            barcode_fields,
            snapshot_us: elapsed_us(started),
        })
    }

    pub(super) fn prepare_pack(
        &self,
        snapshot: &PackSnapshot,
        printer: &PrinterTransportState,
        counters: Value,
    ) -> Result<PreparedPack, String> {
        let started = Instant::now();
        let number = formatted_counter(
            integer(counters.get("totalUnits")).unwrap_or(0) + 1,
            &snapshot.station_number,
            &snapshot.doc,
            "pack_number",
            &snapshot.numbering,
            "unit",
        );
        let predicted_box = string(counters.get("currentBoxNumber"))
            .map(str::to_owned)
            .unwrap_or_else(|| {
                formatted_counter(
                    integer(counters.get("totalBoxes")).unwrap_or(0) + 1,
                    &snapshot.station_number,
                    &snapshot.doc,
                    "box_number",
                    &snapshot.numbering,
                    "box",
                )
            });
        let box_net = number_value(counters.get("boxNetWeight")) + snapshot.pack_net;
        let units_in_box = integer(counters.get("unitsInBox")).unwrap_or(0) + 1;
        let mut data = build_label_data(LabelDataContext {
            product: &snapshot.product,
            station_number: &snapshot.station_number,
            operator_name: snapshot
                .operator
                .as_ref()
                .map(|value| value.full_name.as_str())
                .unwrap_or_default(),
            operator_code: snapshot
                .operator
                .as_ref()
                .map(|value| value.short_code.as_str())
                .unwrap_or_default(),
            production: snapshot.production,
            expiration: snapshot.expiration,
            batch_number: snapshot.request.batch_number.trim(),
            pack_number: &number,
            box_number: &predicted_box,
            pack_net: snapshot.pack_net,
            pack_gross: snapshot.request.gross_weight_kg,
            box_net,
            box_gross: box_net + snapshot.box_tare,
            units_in_box,
            boxes_in_pallet: next_boxes_in_pallet(&counters),
        })?;
        let barcode = resolve_barcode(&snapshot.barcode_fields, &data, &snapshot.product);
        data.insert("barcode".to_owned(), Value::String(barcode));
        let mut timings = PrintStageTimings {
            data_us: elapsed_us(started),
            ..PrintStageTimings::default()
        };
        let render_started = Instant::now();
        let rendered = self.prepare(
            snapshot.config.clone(),
            snapshot.doc.clone(),
            Value::Object(data.clone()),
        )?;
        timings.render_us = elapsed_us(render_started);
        let encode_started = Instant::now();
        let job = self.prepare_delivery(printer, rendered, "")?;
        timings.encode_us = elapsed_us(encode_started);
        timings.bytes = job.byte_len();
        let box_limit = integer(snapshot.product.get("close_box_counter")).unwrap_or(0);
        Ok(PreparedPack {
            started,
            timings,
            prepared_ahead: false,
            must_close_box: box_limit > 0 && units_in_box >= box_limit,
            counters,
            number,
            predicted_box,
            data,
            job,
        })
    }

    pub(super) fn commit_pack(
        &self,
        snapshot: &PackSnapshot,
        operational: &OperationalState,
        printer: &PrinterTransportState,
        mut prepared: PreparedPack,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<Option<CommittedPack>, String> {
        let started = prepared.started;
        for retry in 0..MAX_PREPARATION_ATTEMPTS {
            // Recheck after each stale re-render, not just before the first attempt.
            if cancelled() {
                return Ok(None);
            }
            let PreparedPack {
                mut timings,
                prepared_ahead,
                must_close_box,
                counters,
                number,
                predicted_box,
                mut data,
                mut job,
                ..
            } = prepared;
            let outbox_started = Instant::now();
            let result = operational.record_pack_with_outbox_checked(
                Some(&counters),
                RecordPackPayload {
                    number: number.clone(),
                    box_number: predicted_box.clone(),
                    nomenclature_id: snapshot.request.product_id,
                    weight_netto: snapshot.pack_net,
                    weight_brutto: snapshot.request.gross_weight_kg,
                    barcode_value: data.get("barcode").map(value_string).unwrap_or_default(),
                    station_number: Some(snapshot.station_number.clone()),
                    production_date: Some(iso_date(snapshot.production)),
                    expiration_date: Some(iso_date(snapshot.expiration)),
                    batch: Some(snapshot.request.batch_number.trim().to_owned()),
                    barcode_spec: (!snapshot.barcode_fields.is_empty()).then_some(BarcodeSpec {
                        fields: snapshot.barcode_fields.clone(),
                        data: data.clone(),
                    }),
                },
                snapshot
                    .operator
                    .as_ref()
                    .map(|operator| OperatorAttribution {
                        uuid: operator.uuid.clone(),
                        full_name: operator.full_name.clone(),
                    }),
                |transaction, result| {
                    let actual_barcode = if result.barcode_value.is_empty() {
                        resolve_barcode(&snapshot.barcode_fields, &data, &snapshot.product)
                    } else {
                        result.barcode_value.clone()
                    };
                    if result.box_number != predicted_box
                        || actual_barcode
                            != data.get("barcode").map(value_string).unwrap_or_default()
                    {
                        data.insert(
                            "box_number".to_owned(),
                            Value::String(result.box_number.clone()),
                        );
                        data.insert("barcode".to_owned(), Value::String(actual_barcode));
                        let render_started = Instant::now();
                        let rendered = self.prepare(
                            snapshot.config.clone(),
                            snapshot.doc.clone(),
                            Value::Object(data.clone()),
                        )?;
                        timings.render_us =
                            timings.render_us.saturating_add(elapsed_us(render_started));
                        let encode_started = Instant::now();
                        job = self.prepare_delivery(printer, rendered, "")?;
                        timings.encode_us =
                            timings.encode_us.saturating_add(elapsed_us(encode_started));
                        timings.bytes = job.byte_len();
                    }
                    let job_id = job
                        .with_idempotency_key(&format!("native-pack:{}", result.pack_id))?
                        .persist(transaction)?;
                    let stored = StoredPrint {
                        config: snapshot.config.clone(),
                        doc: snapshot.doc.clone(),
                        data: Value::Object(data),
                        number: number.clone(),
                        kind: "pack".to_owned(),
                        pack_id: Some(result.pack_id),
                    };
                    Ok((stored, job_id))
                },
            )?;
            timings.outbox_us = timings.outbox_us.saturating_add(elapsed_us(outbox_started));
            if let Some((result, (stored, job_id))) = result {
                return Ok(Some(CommittedPack {
                    result,
                    stored,
                    job_id,
                    number,
                    started,
                    timings,
                    prepared_ahead,
                    must_close_box,
                    stale_retries: retry,
                }));
            }
            if retry + 1 == MAX_PREPARATION_ATTEMPTS {
                return Err("счётчики изменились во время подготовки; печать не записана, повторите операцию".to_owned());
            }
            if cancelled() {
                return Ok(None);
            }
            prepared = self.prepare_pack(
                snapshot,
                printer,
                operational.latest_counters(Some(snapshot.request.product_id))?,
            )?;
            prepared.timings.add_preparation(&timings);
            prepared.started = started;
            prepared.prepared_ahead = prepared_ahead;
        }
        unreachable!("bounded preparation loop returns on its final attempt")
    }

    pub(super) fn dispatch_pack(
        &self,
        printer: &PrinterTransportState,
        events: &RuntimeEventSink,
        committed: &mut CommittedPack,
    ) -> Result<PendingPrintReceipt, String> {
        let started = Instant::now();
        let result = printer.enqueue_committed_with_sink(events.clone(), &committed.job_id);
        committed.timings.dispatch_us = elapsed_us(started);
        result
    }

    #[allow(clippy::too_many_arguments)]
    fn auto_close_pack(
        &self,
        persisted: &PersistedState,
        operational: &OperationalState,
        session: &SessionState,
        printer: &PrinterTransportState,
        events: &RuntimeEventSink,
        snapshot: &PackSnapshot,
    ) -> Result<(bool, Vec<String>), String> {
        let after = operational.latest_counters(Some(snapshot.request.product_id))?;
        let limit = integer(snapshot.product.get("close_box_counter")).unwrap_or(0);
        if limit > 0 && integer(after.get("unitsInBox")).unwrap_or(0) >= limit {
            let closed = self.close_box_internal(
                persisted,
                operational,
                session,
                printer,
                events,
                &snapshot.product,
                &snapshot.request.batch_number,
                snapshot.production,
                Some(snapshot),
            )?;
            Ok((true, closed.warnings))
        } else {
            Ok((false, Vec::new()))
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub(super) fn finish_pack(
        &self,
        persisted: &PersistedState,
        operational: &OperationalState,
        session: &SessionState,
        printer: &PrinterTransportState,
        events: &RuntimeEventSink,
        snapshot: &PackSnapshot,
        mut committed: CommittedPack,
        pending: Result<PendingPrintReceipt, String>,
    ) -> Result<FinishedPack, String> {
        let wait_started = Instant::now();
        let sent = pending.and_then(PendingPrintReceipt::wait);
        committed.timings.completion_wait_us = elapsed_us(wait_started);
        let receipt = match sent {
            Ok(receipt) => receipt,
            Err(error) => {
                operational.record_print_error(
                    &format!("pack {} transport: {error}", committed.result.pack_id),
                    "ERROR",
                );
                // Business accounting stays committed even if delivery fails.
                let close_started = Instant::now();
                if let Err(close_error) =
                    self.auto_close_pack(persisted, operational, session, printer, events, snapshot)
                {
                    operational.record_print_error(
                        &format!(
                            "pack {} box auto-close: {close_error}",
                            committed.result.pack_id
                        ),
                        "ERROR",
                    );
                }
                committed.timings.box_close_us = elapsed_us(close_started);
                committed.timings.total_us = elapsed_us(committed.started);
                self.record_pack_timing(events, &committed, "failed");
                return Err(error);
            }
        };
        committed.timings.queue_ms = receipt.queue_ms;
        committed.timings.send_ms = receipt.send_ms;
        let mut warnings = Vec::new();
        let finalize_started = Instant::now();
        self.remember_accepted(committed.stored.clone(), operational, events, &mut warnings);
        committed.timings.finalize_us = elapsed_us(finalize_started);
        let close_started = Instant::now();
        let mut box_close_error = None;
        let auto_closed_box = match self.auto_close_pack(
            persisted,
            operational,
            session,
            printer,
            events,
            snapshot,
        ) {
            Ok((closed, box_warnings)) => {
                warnings.extend(box_warnings);
                closed
            }
            Err(error) => {
                box_close_error = Some(error.clone());
                Self::record_warning(
                    operational,
                    events,
                    &mut warnings,
                    format!(
                        "Упаковка {} принята принтером; проверьте закрытие короба: {error}",
                        committed.result.pack_id
                    ),
                );
                false
            }
        };
        committed.timings.box_close_us = elapsed_us(close_started);
        committed.timings.total_us = elapsed_us(committed.started);
        self.record_pack_timing(events, &committed, "accepted");
        Ok(FinishedPack {
            box_close_error,
            outcome: NativePrintOutcome {
                kind: "pack".to_owned(),
                number: committed.number,
                box_number: Some(committed.result.box_number),
                pack_id: Some(committed.result.pack_id),
                auto_closed_box,
                receipt: Some(receipt),
                warnings,
            },
        })
    }

    fn record_pack_timing(
        &self,
        events: &RuntimeEventSink,
        committed: &CommittedPack,
        status: &'static str,
    ) {
        let record = PrintTimingRecord {
            job_id: committed.job_id.clone(),
            status,
            prepared_ahead: committed.prepared_ahead,
            timings: committed.timings.clone(),
        };
        self.metrics.record(&record);
        events.emit("native-print-timing", record);
    }
}

fn number_value(value: Option<&Value>) -> f64 {
    number(value).unwrap_or(0.0)
}
