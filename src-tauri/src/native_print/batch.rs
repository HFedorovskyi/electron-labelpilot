use super::pack::PreparedPack;
use super::*;
use crate::printer::MAX_RAW_JOB_BYTES;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeBatchFailure {
    pub stage: String,
    pub message: String,
    pub job_id: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeBatchStats {
    pub snapshot_us: u64,
    pub elapsed_us: u64,
    pub prepared: usize,
    pub prefetched: usize,
    pub discarded: usize,
    pub stale_retries: usize,
    pub box_barriers: usize,
    pub peak_prepared_jobs: usize,
    pub peak_prepared_bytes: usize,
    pub prefetch_capacity: usize,
    pub prefetch_byte_limit: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeFixedBatchOutcome {
    pub requested: i64,
    /// Transport-accepted packs, not proof of physical label production.
    pub completed: i64,
    /// Committed business rows; may exceed completed after delivery failure.
    pub committed: i64,
    pub cancelled: bool,
    pub last_print: Option<NativePrintOutcome>,
    pub failure: Option<NativeBatchFailure>,
    pub stats: NativeBatchStats,
}

impl NativeFixedBatchOutcome {
    pub(crate) fn status_message(&self) -> String {
        let status = if self.failure.is_some() {
            "Тираж остановлен с ошибкой"
        } else if self.cancelled {
            "Тираж остановлен"
        } else {
            "Тираж завершён"
        };
        let message = format!(
            "{status} · принято {} из {} · учтено {}",
            self.completed, self.requested, self.committed
        );
        if let Some(failure) = &self.failure {
            format!("{message} · {}", failure.message)
        } else {
            self.last_print
                .as_ref()
                .map(|last| last.success_message(&message))
                .unwrap_or(message)
        }
    }

    fn fail(&mut self, stage: &str, message: String, job_id: Option<String>) {
        self.failure = Some(NativeBatchFailure {
            stage: stage.to_owned(),
            message,
            job_id,
        });
    }
}

impl NativePrintService {
    /// One committed job in flight and at most one uncommitted prepared successor.
    /// No number reservation, bulk copies, or per-label producer threads.
    #[allow(clippy::too_many_arguments)]
    pub fn print_fixed_weight_batch(
        &self,
        persisted: &PersistedState,
        operational: &OperationalState,
        session: &SessionState,
        printer: &PrinterTransportState,
        events: &RuntimeEventSink,
        product_id: i64,
        copies: i64,
        batch_number: String,
        production_date: String,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<NativeFixedBatchOutcome, String> {
        let _operation = self.lock_production()?;
        let started = Instant::now();
        if !(1..=5_000).contains(&copies) {
            return Err("количество этикеток должно быть от 1 до 5000".to_owned());
        }
        let product = self.product(operational, product_id)?;
        let fixed = product.get("is_fixed_weight");
        if fixed.and_then(Value::as_bool) != Some(true) && integer(fixed) != Some(1) {
            return Err("выбранный товар не относится к фиксированному весу".to_owned());
        }
        let grams = number(product.get("fixed_weight_grams")).unwrap_or(0.0);
        if !grams.is_finite() || grams <= 0.0 {
            return Err("для товара не задан корректный фиксированный вес".to_owned());
        }
        let mut snapshot = self.capture_pack_inputs(
            persisted,
            operational,
            session,
            PackPrintRequest {
                product_id,
                gross_weight_kg: grams / 1_000.0,
                batch_number,
                production_date,
            },
            product,
        )?;
        // A disabled automatic box limit never uses box-printer assets.
        // Otherwise validate them before recording the first pack in the batch.
        if integer(snapshot.product.get("close_box_counter")).unwrap_or(0) > 0 {
            snapshot.box_assets.as_ref().map_err(Clone::clone)?;
        }
        snapshot.snapshot_us = elapsed_us(started);
        let mut outcome = NativeFixedBatchOutcome {
            requested: copies,
            completed: 0,
            committed: 0,
            cancelled: false,
            last_print: None,
            failure: None,
            stats: NativeBatchStats {
                snapshot_us: snapshot.snapshot_us,
                prefetch_capacity: 1,
                prefetch_byte_limit: MAX_RAW_JOB_BYTES,
                ..NativeBatchStats::default()
            },
        };
        let mut ready = None;
        while outcome.completed < copies {
            if cancelled() {
                break;
            }
            let prepared = match ready.take() {
                Some(prepared) => prepared,
                None => match self.prepare_batch_pack(
                    &snapshot,
                    operational,
                    printer,
                    events,
                    outcome.completed,
                    false,
                    &mut outcome.stats,
                ) {
                    Ok(mut prepared) => {
                        if outcome.completed == 0 {
                            prepared.started = started;
                            prepared.timings.snapshot_us = snapshot.snapshot_us;
                        }
                        prepared
                    }
                    Err(error) => {
                        outcome.fail("prepare", error, None);
                        break;
                    }
                },
            };
            let mut committed =
                match self.commit_pack(&snapshot, operational, printer, prepared, cancelled) {
                    Ok(Some(committed)) => committed,
                    Ok(None) => {
                        outcome.stats.discarded += 1;
                        break;
                    }
                    Err(error) => {
                        outcome.stats.discarded += 1;
                        outcome.fail("commit", error, None);
                        break;
                    }
                };
            outcome.committed += 1;
            outcome.stats.stale_retries += committed.stale_retries;
            outcome.stats.prepared += committed.stale_retries;
            outcome.stats.discarded += committed.stale_retries;
            let must_close_box = committed.must_close_box;
            let job_id = committed.job_id.clone();
            let pending = self.dispatch_pack(printer, events, &mut committed);
            // Everything between enqueue and finish is captured as a value: neither
            // a preparation error nor cancellation may skip the current receipt.
            let future =
                if pending.is_ok() && outcome.committed < copies && !must_close_box && !cancelled()
                {
                    Some(self.prepare_batch_pack(
                        &snapshot,
                        operational,
                        printer,
                        events,
                        outcome.completed + 1,
                        true,
                        &mut outcome.stats,
                    ))
                } else {
                    None
                };
            if must_close_box {
                outcome.stats.box_barriers += 1;
            }
            let finished = self.finish_pack(
                persisted,
                operational,
                session,
                printer,
                events,
                &snapshot,
                committed,
                pending,
            );
            let (printed, close_error) = match finished {
                Ok(finished) => (finished.outcome, finished.box_close_error),
                Err(error) => {
                    if matches!(future, Some(Ok(_))) {
                        outcome.stats.discarded += 1;
                    }
                    outcome.fail("transport", error, Some(job_id));
                    break;
                }
            };
            outcome.completed += 1;
            let closed = printed.auto_closed_box;
            outcome.last_print = Some(printed);
            events.emit(
                "fixed-batch-progress",
                json!({"productId":product_id,
                "completed":outcome.completed,"committed":outcome.committed,"requested":copies,
                "remaining":copies-outcome.completed,"index":outcome.completed-1}),
            );
            if let Some(error) = close_error.or_else(|| {
                (must_close_box && !closed)
                    .then(|| "проверьте закрытие короба перед продолжением тиража".to_owned())
            }) {
                if matches!(future, Some(Ok(_))) {
                    outcome.stats.discarded += 1;
                }
                outcome.fail("box-close", error, None);
                break;
            }
            match future {
                Some(Ok(prepared)) if !cancelled() && !closed => ready = Some(prepared),
                Some(Ok(_)) => outcome.stats.discarded += 1,
                Some(Err(error)) => {
                    outcome.fail("prepare", error, None);
                    break;
                }
                None => {}
            }
        }
        if ready.is_some() {
            outcome.stats.discarded += 1;
        }
        outcome.cancelled = outcome.failure.is_none() && outcome.completed < copies && cancelled();
        outcome.stats.elapsed_us = elapsed_us(started);
        Ok(outcome)
    }

    #[allow(clippy::too_many_arguments)]
    fn prepare_batch_pack(
        &self,
        snapshot: &PackSnapshot,
        operational: &OperationalState,
        printer: &PrinterTransportState,
        events: &RuntimeEventSink,
        index: i64,
        ahead: bool,
        stats: &mut NativeBatchStats,
    ) -> Result<PreparedPack, String> {
        events.emit(
            "native-pack-preparing",
            json!({"index":index,"preparedAhead":ahead}),
        );
        let preparation = (|| {
            let counters_started = Instant::now();
            let counters = operational.latest_counters(Some(snapshot.request.product_id))?;
            let counter_us = elapsed_us(counters_started);
            let mut prepared = self.prepare_pack(snapshot, printer, counters)?;
            prepared.started = counters_started;
            prepared.timings.data_us = prepared.timings.data_us.saturating_add(counter_us);
            // PreparedPrinterJob validates this limit for raw, bitmap and page routes.
            if prepared.timings.bytes > MAX_RAW_JOB_BYTES {
                return Err(format!(
                    "подготовленная этикетка превышает {MAX_RAW_JOB_BYTES} байт"
                ));
            }
            prepared.prepared_ahead = ahead;
            stats.prepared += 1;
            stats.prefetched += usize::from(ahead);
            stats.peak_prepared_jobs = 1;
            stats.peak_prepared_bytes = stats.peak_prepared_bytes.max(prepared.timings.bytes);
            events.emit(
                "native-pack-prepared",
                json!({"index":index,"preparedAhead":ahead,"bytes":prepared.timings.bytes}),
            );
            Ok(prepared)
        })();
        if let Err(error) = &preparation {
            events.emit(
                "native-pack-preparation-failed",
                json!({"index":index,"preparedAhead":ahead,"message":error}),
            );
        }
        preparation
    }
}
